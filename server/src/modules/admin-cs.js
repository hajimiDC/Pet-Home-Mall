'use strict';

const { get, all, run, transaction, pagination, parseJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now } = require('../core/money');
const { auditLog } = require('../core/http');
const { maskPhone } = require('../core/privacy');
const aftersaleSvc = require('../services/aftersale-service');

/**
 * 平台后台 · 客服域（API-129 ~ API-133、FR-CS-001 ~ FR-CS-009、9.4.3）
 *
 * 职责：
 *  - 咨询工单：列表 / 受理 / 转派 / 追加回复（含内部备注）/ 关闭，状态机 1→2→3/4；
 *  - 售后处理：全平台售后单列表（复用 aftersale-service.listAll）、客服介入（复用 intervene）；
 *  - 评价申诉审核：通过则隐藏评价并重算店铺评分（平均分 ×10），驳回必填原因。
 * 售后与退款的资金动作全部由 service 层完成，本模块不重复实现金额校验（FR-CS-005）。
 */

const WORK_STATUS_NAME = { 1: '待受理', 2: '处理中', 3: '已解决', 4: '已关闭' };
const APPEAL_STATUS_NAME = { 0: '待审核', 1: '已通过', 2: '已驳回' };
const MAX_REPLY_LEN = 1000;

function isTrue(value) {
  if (value === true || value === 1) return true;
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function toInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function rangeFilter(query, where, params, column) {
  const start = String(query.startTime || query.startDate || '').trim();
  const end = String(query.endTime || query.endDate || '').trim();
  if (start) { where.push(`${column} >= ?`); params.push(start); }
  if (end) { where.push(`${column} <= ?`); params.push(end); }
}

/** 后台受理人（客服）校验：须为启用中的平台账号 */
function assigneeOf(value) {
  const id = toInt(value);
  if (!id) throw Errors.badRequest('请选择受理人（assigneeId）', { field: 'assigneeId' });
  const admin = get("SELECT * FROM admin_users WHERE id = ? AND type = 'admin'", id);
  if (!admin) throw Errors.notFound('受理人账号不存在');
  if (admin.status !== 1) throw Errors.badRequest('受理人账号已被禁用');
  return admin;
}

function toWorkOrder(w) {
  const user = get('SELECT id, username, nickname, phone FROM users WHERE id = ?', w.user_id);
  const assignee = w.assignee_id ? get('SELECT id, name FROM admin_users WHERE id = ?', w.assignee_id) : null;
  const replies = parseJson(w.replies, []) || [];
  const last = replies.length ? replies[replies.length - 1] : null;
  const order = w.order_id ? get('SELECT id, order_no FROM orders WHERE id = ?', w.order_id) : null;
  return {
    id: w.id,
    workNo: w.work_no,
    userId: w.user_id,
    userName: user ? (user.nickname || user.username) : '',
    username: user ? user.username : '',
    phoneMask: user ? maskPhone(user.phone) : '',
    orderId: w.order_id,
    orderNo: order ? order.order_no : null,
    source: w.source,
    type: w.type,
    content: w.content,
    status: w.status,
    statusName: WORK_STATUS_NAME[w.status] || '未知',
    assigneeId: w.assignee_id,
    assigneeName: assignee ? assignee.name : '',
    replies,
    replyCount: replies.length,
    lastReplyAt: last ? last.createdAt : null,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
    closedAt: w.closed_at,
  };
}

/** 追加工单记录（沟通与处理全程留痕，FR-CS-003） */
function appendReply(workOrder, entry) {
  const list = parseJson(workOrder.replies, []) || [];
  list.push({ ...entry, createdAt: now() });
  run('UPDATE work_orders SET replies = ?, updated_at = ? WHERE id = ?', JSON.stringify(list), now(), workOrder.id);
  return list;
}

/** 店铺评分重算：该店铺未隐藏评价的平均分 ×10（FR-SLR-014 / FR-CS-008） */
function recalcShopScore(shopId) {
  const agg = get(
    'SELECT AVG(score) AS avg_score, COUNT(*) AS c FROM shop_reviews WHERE shop_id = ? AND hidden = 0',
    shopId,
  );
  const score = agg && agg.c && agg.avg_score !== null ? Math.round(Number(agg.avg_score) * 10) : 50;
  run('UPDATE shops SET score = ?, updated_at = ? WHERE id = ?', score, now(), shopId);
  return score;
}

function appealView(a) {
  const review = get('SELECT * FROM shop_reviews WHERE id = ?', a.review_id);
  const shop = get('SELECT id, name, score FROM shops WHERE id = ?', a.shop_id);
  const product = review ? get('SELECT id, name FROM products WHERE id = ?', review.product_id) : null;
  return {
    id: a.id,
    reviewId: a.review_id,
    shopId: a.shop_id,
    shopName: shop ? shop.name : '',
    shopScore: shop ? shop.score : null,
    productId: review ? review.product_id : null,
    productName: product ? product.name : '',
    reason: a.reason,
    evidence: parseJson(a.evidence, []),
    status: a.status,
    statusName: APPEAL_STATUS_NAME[a.status] || '未知',
    rejectReason: a.reject_reason,
    auditorId: a.auditor_id,
    auditedAt: a.audited_at,
    createdAt: a.created_at,
    review: review ? {
      id: review.id,
      score: review.score,
      content: review.content,
      images: parseJson(review.images, []),
      hidden: review.hidden,
      userId: review.user_id,
      createdAt: review.created_at,
    } : null,
  };
}

module.exports = function register(api) {
  /* ========================= API-129 工单列表 ========================= */
  api.get('/api/admin/work-orders', { auth: 'admin', perm: 'menu.cs.work-order' }, (ctx) => {
    const { pageSize, offset } = pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
    const where = ['1 = 1'];
    const params = [];

    const keyword = String(ctx.query.keyword || '').trim();
    if (keyword) {
      where.push(`(w.work_no LIKE ? OR w.content LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?
        OR EXISTS (SELECT 1 FROM users u2 WHERE u2.id = w.user_id AND u2.phone LIKE ?))`);
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    const status = toInt(ctx.query.status);
    if (status !== null) { where.push('w.status = ?'); params.push(status); }
    const type = String(ctx.query.type || '').trim();
    if (type) { where.push('w.type = ?'); params.push(type); }
    const source = String(ctx.query.source || '').trim();
    if (source) { where.push('w.source = ?'); params.push(source); }
    const assigneeId = toInt(ctx.query.assigneeId);
    if (assigneeId !== null) { where.push('w.assignee_id = ?'); params.push(assigneeId); }
    const userId = toInt(ctx.query.userId);
    if (userId !== null) { where.push('w.user_id = ?'); params.push(userId); }
    rangeFilter(ctx.query, where, params, 'w.created_at');

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = get(
      `SELECT COUNT(*) AS c FROM work_orders w LEFT JOIN users u ON u.id = w.user_id ${whereSql}`,
      ...params,
    ).c;
    const rows = all(
      `SELECT w.* FROM work_orders w LEFT JOIN users u ON u.id = w.user_id
        ${whereSql} ORDER BY w.created_at DESC, w.id DESC LIMIT ? OFFSET ?`,
      ...params, pageSize, offset,
    );
    return { total, rows: rows.map(toWorkOrder) };
  });

  /* ==================== API-130 工单处理：受理 / 转派 / 回复 / 关闭 ==================== */
  api.post('/api/admin/work-orders/:id/handle', { auth: 'admin', perm: 'menu.cs.work-order' }, (ctx) => {
    const workOrder = get('SELECT * FROM work_orders WHERE id = ?', Number(ctx.params.id));
    if (!workOrder) throw Errors.notFound('工单不存在');

    const body = ctx.body || {};
    const action = String(body.action || '').trim();
    const content = String(body.content || '').trim();
    const internal = isTrue(body.internalNote);
    const operator = { id: ctx.admin.id, name: ctx.admin.name };

    if (!['accept', 'transfer', 'reply', 'resolve', 'close'].includes(action)) {
      throw Errors.badRequest('处理动作不合法（accept / transfer / reply / resolve / close）', { field: 'action' });
    }
    if (workOrder.status === 4) throw Errors.badRequest('工单已关闭，不可再处理');

    let statusPatch = null;

    // 状态流转与沟通记录在同一事务内完成（FR-CS-003 全程留痕）
    transaction(() => {
      if (action === 'accept') {
        if (workOrder.status !== 1) throw Errors.badRequest('仅待受理工单可受理');
        const assignee = body.assigneeId ? assigneeOf(body.assigneeId) : ctx.admin;
        statusPatch = { status: 2, assigneeId: assignee.id };
        appendReply(workOrder, {
          action: 'accept', operatorId: operator.id, operatorName: operator.name,
          content: content || '受理工单', internal: false,
        });
      } else if (action === 'transfer') {
        const assignee = assigneeOf(body.assigneeId);
        const previous = workOrder.assignee_id;
        if (previous === assignee.id) throw Errors.badRequest('转派受理人与当前受理人相同');
        statusPatch = { status: workOrder.status === 1 ? 2 : workOrder.status, assigneeId: assignee.id };
        appendReply(workOrder, {
          action: 'transfer', operatorId: operator.id, operatorName: operator.name,
          content: content || `工单转派给 ${assignee.name}`, internal: true,
          previousAssigneeId: previous, assigneeId: assignee.id, assigneeName: assignee.name,
        });
      } else if (action === 'reply') {
        if (!content) throw Errors.badRequest('回复内容不能为空', { field: 'content' });
        if (content.length > MAX_REPLY_LEN) {
          throw Errors.badRequest(`回复内容不能超过 ${MAX_REPLY_LEN} 个字符`, { field: 'content' });
        }
        // 待受理或已解决状态下回复，工单回到「处理中」
        const nextStatus = (workOrder.status === 1 || workOrder.status === 3) ? 2 : workOrder.status;
        statusPatch = { status: nextStatus, assigneeId: workOrder.assignee_id || operator.id };
        appendReply(workOrder, {
          action: 'reply', operatorId: operator.id, operatorName: operator.name,
          content, internal,
        });
      } else if (action === 'resolve') {
        // 待受理 / 处理中 → 已解决（FR-CS-002 状态机 1→2→3→4）
        statusPatch = { status: 3, assigneeId: workOrder.assignee_id || operator.id };
        appendReply(workOrder, {
          action: 'resolve', operatorId: operator.id, operatorName: operator.name,
          content: content || '问题已解决', internal: false,
        });
      } else if (action === 'close') {
        statusPatch = { status: 4, assigneeId: workOrder.assignee_id || operator.id };
        appendReply(workOrder, {
          action: 'close', operatorId: operator.id, operatorName: operator.name,
          content: content || '关闭工单', internal: true,
        });
      }

      run(
        'UPDATE work_orders SET status = ?, assignee_id = ?, updated_at = ?, closed_at = ? WHERE id = ?',
        statusPatch.status, statusPatch.assigneeId ?? workOrder.assignee_id ?? operator.id, now(),
        statusPatch.status === 4 ? now() : workOrder.closed_at, workOrder.id,
      );
    });

    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '客服', action: `工单${({ accept: '受理', transfer: '转派', reply: '回复', resolve: '解决', close: '关闭' })[action]}`,
      targetType: 'work_order', targetId: workOrder.work_no,
      detail: {
        workNo: workOrder.work_no, action, status: statusPatch.status,
        assigneeId: statusPatch.assigneeId, internal, hasContent: !!content,
      },
      ip: ctx.ip,
    });

    const fresh = get('SELECT * FROM work_orders WHERE id = ?', workOrder.id);
    return { ...toWorkOrder(fresh), handledAction: action };
  });

  /* ==================== API-131 平台售后单列表（复用 service） ==================== */
  api.get('/api/admin/aftersales', { auth: 'admin', perm: 'menu.cs.aftersale' }, (ctx) => {
    const { page, pageSize } = pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
    const data = aftersaleSvc.listAll({
      status: ctx.query.status,
      keyword: String(ctx.query.keyword || '').trim(),
      page,
      pageSize,
    });
    return { total: data.total, rows: data.rows };
  });

  /* ==================== API-132 客服介入 ==================== */
  api.post('/api/admin/aftersales/:id/intervene', { auth: 'admin', perm: 'action.aftersale.intervene' }, (ctx) => {
    const body = ctx.body || {};
    const action = String(body.action || '').trim();
    if (!['approve', 'reject'].includes(action)) {
      throw Errors.badRequest('介入动作不合法（approve / reject）', { field: 'action' });
    }
    const rejectReason = String(body.rejectReason || '').trim();
    if (action === 'reject' && !rejectReason) {
      throw Errors.badRequest('驳回原因必填', { field: 'rejectReason' });
    }
    const conclusion = String(body.conclusion || '').trim();

    const operator = { id: ctx.admin.id, name: ctx.admin.name };
    // 金额校验、退款单生成（待财务审核）均由 aftersale-service 完成（FR-CS-005）
    const data = aftersaleSvc.intervene(Number(ctx.params.id), {
      action,
      rejectReason: action === 'reject' ? rejectReason : undefined,
      conclusion: action === 'reject' ? 'reject' : 'approve',
    }, operator);

    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '客服', action: action === 'reject' ? '售后介入-驳回' : '售后介入-同意',
      targetType: 'aftersale', targetId: data.aftersaleNo,
      detail: {
        aftersaleNo: data.aftersaleNo, orderNo: data.orderNo, action,
        rejectReason: action === 'reject' ? rejectReason : '', conclusion,
        refundAmount: data.refundAmount, refundNo: data.refund ? data.refund.refundNo : null,
      },
      ip: ctx.ip,
    });

    return { ...data, intervenedBy: operator.name };
  });

  /* ==================== API-133 评价申诉列表 / 审核 ==================== */
  api.get('/api/admin/review-appeals', { auth: 'admin', perm: 'menu.cs.review-appeal' }, (ctx) => {
    const { pageSize, offset } = pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
    const where = ['1 = 1'];
    const params = [];

    const status = toInt(ctx.query.status);
    if (status !== null) { where.push('a.status = ?'); params.push(status); }
    const shopId = toInt(ctx.query.shopId);
    if (shopId) { where.push('a.shop_id = ?'); params.push(shopId); }
    const keyword = String(ctx.query.keyword || '').trim();
    if (keyword) {
      where.push('(a.reason LIKE ? OR sh.name LIKE ? OR p.name LIKE ? OR r.content LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    rangeFilter(ctx.query, where, params, 'a.created_at');

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = get(
      `SELECT COUNT(*) AS c FROM review_appeals a
         LEFT JOIN shop_reviews r ON r.id = a.review_id
         LEFT JOIN products p ON p.id = r.product_id
         JOIN shops sh ON sh.id = a.shop_id
        ${whereSql}`,
      ...params,
    ).c;
    const rows = all(
      `SELECT a.* FROM review_appeals a
         LEFT JOIN shop_reviews r ON r.id = a.review_id
         LEFT JOIN products p ON p.id = r.product_id
         JOIN shops sh ON sh.id = a.shop_id
        ${whereSql} ORDER BY a.status ASC, a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      ...params, pageSize, offset,
    );
    return { total, rows: rows.map(appealView) };
  });

  api.post('/api/admin/review-appeals/:id/audit', { auth: 'admin', perm: 'menu.cs.review-appeal' }, (ctx) => {
    const appeal = get('SELECT * FROM review_appeals WHERE id = ?', Number(ctx.params.id));
    if (!appeal) throw Errors.notFound('评价申诉不存在');
    if (appeal.status !== 0) {
      throw Errors.badRequest(appeal.status === 1 ? '该申诉已通过，请勿重复审核' : '该申诉已驳回，请勿重复审核');
    }

    const body = ctx.body || {};
    const approve = isTrue(body.approve);
    const rejectReason = String(body.rejectReason || '').trim();
    if (!approve && !rejectReason) throw Errors.badRequest('驳回原因必填', { field: 'rejectReason' });

    let shopScore = null;
    if (approve) {
      transaction(() => {
        run(
          'UPDATE review_appeals SET status = 1, auditor_id = ?, audited_at = ?, updated_at = ? WHERE id = ? AND status = 0',
          ctx.admin.id, now(), now(), appeal.id,
        );
        // 通过：隐藏评价（前台不展示、不计入评分）
        run('UPDATE shop_reviews SET hidden = 1, updated_at = ? WHERE id = ?', now(), appeal.review_id);
        shopScore = recalcShopScore(appeal.shop_id); // FR-CS-008
      });
    } else {
      run(
        `UPDATE review_appeals SET status = 2, reject_reason = ?, auditor_id = ?, audited_at = ?, updated_at = ?
          WHERE id = ? AND status = 0`,
        rejectReason.slice(0, 200), ctx.admin.id, now(), now(), appeal.id,
      );
      const shop = get('SELECT score FROM shops WHERE id = ?', appeal.shop_id);
      shopScore = shop ? shop.score : null;
    }

    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '客服', action: approve ? '评价申诉通过' : '评价申诉驳回',
      targetType: 'review_appeal', targetId: appeal.id,
      detail: {
        appealId: appeal.id, reviewId: appeal.review_id, shopId: appeal.shop_id,
        approve, rejectReason: approve ? '' : rejectReason, shopScore,
      },
      ip: ctx.ip,
    });

    const fresh = get('SELECT * FROM review_appeals WHERE id = ?', appeal.id);
    return { ...appealView(fresh), shopScore, reviewHidden: approve };
  });
};
