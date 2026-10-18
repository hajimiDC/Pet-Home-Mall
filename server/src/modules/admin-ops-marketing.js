'use strict';

const db = require('../core/db');
const { get, all, run, transaction, parseJson } = db;
const { now, toYuan, today, parseTime } = require('../core/money');
const { Errors } = require('../core/errors');
const v = require('../core/validate');
const config = require('../core/config');
const svc = require('../services/admin-ops-service');
const activityService = require('../services/activity-service');

/**
 * 平台后台 · 运营域：活动审核、平台券、拼团规则与拼团活动、到店服务审核与核销统计
 * 覆盖 API-114 ~ API-122（FR-OPS-029 ~ FR-OPS-043）
 *
 * 权限码：
 *  - menu.ops.activity-audit：活动审核（114 / 115）
 *  - menu.ops.coupon：平台券（116 / 117 / 118）
 *  - menu.ops.group-buy：拼团规则与拼团活动（119 / 120）
 *  - menu.ops.store-service：到店服务审核、核销查询、到店总览（121 / 122）
 */

const PERM_ACTIVITY = 'menu.ops.activity-audit';
const PERM_COUPON = 'menu.ops.coupon';
const PERM_GROUP_BUY = 'menu.ops.group-buy';
const PERM_STORE = 'menu.ops.store-service';

const COUPON_TYPE_NAMES = { 1: '满减券', 2: '折扣券' };
const COUPON_SCOPE_NAMES = { 1: '全场通用', 2: '指定类目', 3: '指定商品', 4: '指定店铺' };
const VERIFY_STATUS = { 1: '待到店', 2: '已核销', 3: '已取消', 4: '已过期' };

// ==================== API-114 活动审核列表 ====================

/**
 * GET /api/admin/activity-audits
 * ?status=0|1|2|3|4|all（默认全部）&shopId=&keyword=&startAt=&endAt=&page=&pageSize=
 * 时间筛选维度：活动提交时间 created_at。
 */
function listActivityAudits(ctx) {
  const params = [];
  let where = 'WHERE 1 = 1';
  const rawStatus = ctx.query.status;
  if (rawStatus !== undefined && rawStatus !== '' && rawStatus !== null && String(rawStatus).toLowerCase() !== 'all') {
    where += ' AND a.status = ?';
    params.push(Number(v.oneOf(rawStatus, ['0', '1', '2', '3', '4'], 'status')));
  }
  if (ctx.query.shopId) { where += ' AND a.shop_id = ?'; params.push(v.int(ctx.query.shopId, 'shopId', { min: 1 })); }
  if (ctx.query.keyword) {
    where += ' AND (a.title LIKE ? OR s.name LIKE ?)';
    const kw = `%${String(ctx.query.keyword).trim()}%`;
    params.push(kw, kw);
  }
  const startAt = svc.normTime(ctx.query.startAt, { field: 'startAt' });
  const endAt = svc.normTime(ctx.query.endAt, { field: 'endAt', endOfDay: true });
  if (startAt) { where += ' AND a.created_at >= ?'; params.push(startAt); }
  if (endAt) { where += ' AND a.created_at <= ?'; params.push(endAt); }

  const { page, pageSize, offset } = db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
  const total = Number(get(`SELECT COUNT(*) AS c FROM activities a LEFT JOIN shops s ON s.id = a.shop_id ${where}`, ...params).c);
  const rows = all(
    `SELECT a.*, s.name AS shop_name, s.logo AS shop_logo
       FROM activities a LEFT JOIN shops s ON s.id = a.shop_id
       ${where} ORDER BY a.status ASC, a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset,
  ).map(activityOut);

  const counts = all('SELECT status, COUNT(*) AS c FROM activities GROUP BY status');
  const byStatus = {};
  for (const row of counts) byStatus[row.status] = Number(row.c);

  return {
    total,
    rows,
    page,
    pageSize,
    pendingCount: byStatus[0] || 0,
    statusCounts: byStatus,
    statusOptions: [
      { value: 0, name: '待审核' }, { value: 1, name: '已通过' },
      { value: 2, name: '已驳回' }, { value: 3, name: '已结束' }, { value: 4, name: '强制下线' },
    ],
  };
}

function activityOut(a) {
  const base = activityService.toApi(a);
  return { ...base, auditReason: a.audit_reason || '', submittedAt: a.created_at };
}

// ==================== API-115 活动审核操作 ====================

/**
 * POST /api/admin/activity-audits/:id/audit
 * { action: 'approve' | 'reject' | 'offline', rejectReason? }
 *  - approve → status=1（已通过 / 进行中）
 *  - reject  → 必填原因（缺失 → 400「请填写驳回原因」），status=2
 *  - offline → 强制下线 status=4，原因缺省记录「平台强制下线」
 * 审核结果通知商家并记审计日志（FR-OPS-030 ~ 032）。
 */
function auditActivity(ctx) {
  const id = v.int(ctx.params.id, 'id', { min: 1 });
  const activity = get(
    'SELECT a.*, s.name AS shop_name FROM activities a LEFT JOIN shops s ON s.id = a.shop_id WHERE a.id = ?',
    id,
  );
  if (!activity) throw Errors.notFound('活动不存在');

  const body = ctx.body || {};
  const action = v.oneOf(body.action, ['approve', 'reject', 'offline'], 'action');
  const reason = String(body.rejectReason ?? body.reason ?? '').trim();
  if (action === 'reject' && !reason) throw Errors.badRequest('请填写驳回原因');

  const nextStatus = { approve: 1, reject: 2, offline: 4 }[action];
  const auditReason = action === 'approve' ? null : (reason || '平台强制下线');

  run('UPDATE activities SET status = ?, audit_reason = ?, updated_at = ? WHERE id = ?',
    nextStatus, auditReason, now(), id);

  const title = { approve: '活动审核通过', reject: '活动审核未通过', offline: '活动已被强制下线' }[action];
  const content = action === 'approve'
    ? `您提交的活动「${activity.title}」已通过平台审核，现已在活动列表中展示。`
    : (action === 'reject'
      ? `您提交的活动「${activity.title}」未通过平台审核，原因：${reason}。请修改后重新提交。`
      : `您的活动「${activity.title}」已被平台强制下线，原因：${auditReason}。已产生的订单继续履约（FR-OPS-031）。`);
  svc.notifySeller(activity.shop_id, title, content);

  svc.writeLog(ctx, {
    module: '营销审核', action: title, targetType: 'activity', targetId: id,
    detail: { title: activity.title, shopId: activity.shop_id, fromStatus: activity.status, toStatus: nextStatus, reason: auditReason || '' },
  });

  const updated = get('SELECT a.*, s.name AS shop_name FROM activities a LEFT JOIN shops s ON s.id = a.shop_id WHERE a.id = ?', id);
  return {
    id,
    action,
    status: nextStatus,
    statusName: svc.ACTIVITY_STATUS[nextStatus] || '',
    auditReason: auditReason || '',
    activity: activityOut(updated),
  };
}

// ==================== API-116 平台券列表 ====================

/**
 * GET /api/admin/coupons
 * 平台券（shop_id = 0），?status=&type=&keyword=&page=&pageSize=
 */
function listCoupons(ctx) {
  const params = [];
  let where = 'WHERE c.shop_id = 0';
  if (ctx.query.status !== undefined && ctx.query.status !== '' && String(ctx.query.status).toLowerCase() !== 'all') {
    where += ' AND c.status = ?';
    params.push(Number(v.oneOf(ctx.query.status, ['0', '1'], 'status')));
  }
  if (ctx.query.type) {
    where += ' AND c.type = ?';
    params.push(Number(v.oneOf(ctx.query.type, ['1', '2'], 'type')));
  }
  if (ctx.query.keyword) {
    where += ' AND c.name LIKE ?';
    params.push(`%${String(ctx.query.keyword).trim()}%`);
  }
  const { page, pageSize, offset } = db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
  const total = Number(get(`SELECT COUNT(*) AS c FROM coupons c ${where}`, ...params).c);
  const rows = all(
    `SELECT c.*, (SELECT COUNT(*) FROM user_coupons uc WHERE uc.coupon_id = c.id) AS received_count,
            (SELECT COUNT(*) FROM user_coupons uc WHERE uc.coupon_id = c.id AND uc.status = 1) AS used_count
       FROM coupons c ${where} ORDER BY c.status DESC, c.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset,
  ).map(couponOut);
  return {
    total,
    rows,
    page,
    pageSize,
    scopeOptions: Object.entries(COUPON_SCOPE_NAMES).map(([value, name]) => ({ value: Number(value), name })),
    typeOptions: Object.entries(COUPON_TYPE_NAMES).map(([value, name]) => ({ value: Number(value), name })),
  };
}

function couponOut(c) {
  const scopeIds = parseJson(c.scope_ids, []) || [];
  const remain = Math.max(0, Number(c.stock || 0) - Number(c.received || 0));
  const nowStr = now();
  let claimState = '可领取';
  if (Number(c.status) !== 1) claimState = '已下架';
  else if (c.start_at && parseTime(c.start_at) > parseTime(nowStr)) claimState = '未开始';
  else if (c.end_at && parseTime(c.end_at) <= parseTime(nowStr)) claimState = '已过期';
  else if (remain <= 0) claimState = '已领完';

  return {
    id: Number(c.id),
    shopId: Number(c.shop_id),
    source: Number(c.shop_id) === 0 ? '平台券' : '店铺券',
    name: c.name,
    type: Number(c.type),
    typeName: COUPON_TYPE_NAMES[c.type] || '',
    threshold: toYuan(c.threshold),
    amount: toYuan(c.amount),
    discountRate: c.discount_rate,
    scopeType: Number(c.scope_type),
    scopeName: COUPON_SCOPE_NAMES[c.scope_type] || '',
    scopeIds,
    scopeNames: scopeNamesOf(c.scope_type, scopeIds),
    startAt: c.start_at,
    endAt: c.end_at,
    validDays: c.valid_days,
    stock: Number(c.stock),
    received: Number(c.received),
    receivedCount: Number(c.received_count ?? 0),
    usedCount: Number(c.used_count ?? 0),
    remain,
    limitPerUser: Number(c.limit_per_user),
    claimType: c.claim_type,
    status: Number(c.status),
    statusName: Number(c.status) === 1 ? '上架' : '下架',
    claimState,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

/** 适用范围 id → 名称 */
function scopeNamesOf(scopeType, ids) {
  if (!ids.length) return [];
  if (Number(scopeType) === 2) return ids.map((id) => get('SELECT name FROM categories WHERE id = ?', id)?.name).filter(Boolean);
  if (Number(scopeType) === 3) return ids.map((id) => get('SELECT name FROM products WHERE id = ?', id)?.name).filter(Boolean);
  if (Number(scopeType) === 4) return ids.map((id) => get('SELECT name FROM shops WHERE id = ?', id)?.name).filter(Boolean);
  return [];
}

// ==================== API-117 平台券保存 ====================

/**
 * POST /api/admin/coupons
 * { id?, name, type(1 满减 / 2 折扣), threshold, amount, discountRate, scopeType, scopeIds,
 *   startAt, endAt, validDays, stock, limitPerUser, claimType, status }
 * 校验：满减券面额 ≥ 使用门槛 → 400「券面额须小于使用门槛」；
 *       折扣券折扣率须落在 (0,1)；
 *       写 coupons(shop_id = 0)（FR-OPS-033 / 034）。
 */
function saveCoupon(ctx) {
  const body = ctx.body || {};
  const id = body.id === undefined || body.id === null || body.id === '' ? null : v.int(body.id, 'id', { min: 1 });
  const existing = id ? get('SELECT * FROM coupons WHERE id = ?', id) : null;
  if (id && !existing) throw Errors.notFound('优惠券不存在');
  if (id && Number(existing.shop_id) !== 0) throw Errors.badRequest('该券为店铺券，请在商家端维护（平台券 shop_id=0）');

  const name = v.str(body.name !== undefined ? body.name : existing?.name, 'name', { min: 1, max: 50 });
  const type = body.type !== undefined
    ? Number(v.oneOf(body.type, ['1', '2'], 'type'))
    : Number(existing?.type || 1);

  let threshold = body.threshold !== undefined
    ? svc.cents(body.threshold, 'threshold', { allowZero: true })
    : Number(existing?.threshold || 0);
  let amount = body.amount !== undefined
    ? svc.cents(body.amount, 'amount', { allowZero: true })
    : Number(existing?.amount || 0);
  let discountRate = body.discountRate !== undefined
    ? Number(body.discountRate)
    : (existing?.discount_rate ?? null);

  if (type === 1) {
    // 满减券：面额必须大于 0 且小于门槛（「券面额 ≥ 门槛」拦截）
    if (!(amount > 0)) throw Errors.badRequest('满减券面额须大于 0');
    if (threshold > 0 && amount >= threshold) throw Errors.badRequest('券面额须小于使用门槛（券面额 ≥ 门槛不允许保存）');
    discountRate = null;
  } else {
    if (!(discountRate > 0 && discountRate < 1)) throw Errors.badRequest('折扣券折扣率须大于 0 且小于 1（如 0.9 表示 9 折）');
    amount = 0;
    if (!(threshold >= 0)) threshold = 0;
  }

  const scopeType = body.scopeType !== undefined
    ? Number(v.oneOf(body.scopeType, ['1', '2', '3', '4'], 'scopeType'))
    : Number(existing?.scope_type || 1);
  let scopeIds = Array.isArray(body.scopeIds)
    ? body.scopeIds.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
    : (body.scopeType !== undefined ? [] : (parseJson(existing?.scope_ids, []) || []));
  scopeIds = [...new Set(scopeIds)];
  if (scopeType !== 1 && scopeIds.length === 0) throw Errors.badRequest('指定范围的券须选择生效对象（scopeIds 不能为空）');

  const startAt = body.startAt !== undefined
    ? svc.normTime(body.startAt, { field: 'startAt', required: true })
    : existing?.start_at;
  const endAt = body.endAt !== undefined
    ? svc.normTime(body.endAt, { field: 'endAt', endOfDay: true, required: true })
    : existing?.end_at;
  if (!startAt) throw Errors.badRequest('生效开始时间不能为空');
  if (!endAt) throw Errors.badRequest('生效结束时间不能为空');
  if (startAt >= endAt) throw Errors.badRequest('生效结束时间须晚于开始时间');

  const validDays = body.validDays !== undefined
    ? (body.validDays === null || body.validDays === '' ? null : svc.uintOr(body.validDays, 'validDays', null))
    : (existing?.valid_days ?? null);
  const stock = body.stock !== undefined ? svc.uintOr(body.stock, 'stock', 0) : Number(existing?.stock || 0);
  const limitPerUser = body.limitPerUser !== undefined
    ? svc.uintOr(body.limitPerUser, 'limitPerUser', 1)
    : Number(existing?.limit_per_user || 1);
  if (!(limitPerUser > 0)) throw Errors.badRequest('每人限领数须大于 0');
  const claimType = body.claimType !== undefined
    ? v.str(body.claimType, 'claimType', { min: 1, max: 20 })
    : (existing?.claim_type || '主动领取');
  const status = body.status !== undefined
    ? Number(v.oneOf(body.status, ['0', '1'], 'status'))
    : Number(existing?.status ?? 1);

  let couponId;
  let created = false;
  if (id) {
    run(
      `UPDATE coupons SET name = ?, type = ?, threshold = ?, amount = ?, discount_rate = ?, scope_type = ?, scope_ids = ?,
              start_at = ?, end_at = ?, valid_days = ?, stock = ?, limit_per_user = ?, claim_type = ?, status = ?, updated_at = ?
        WHERE id = ? AND shop_id = 0`,
      name, type, threshold, amount, discountRate, scopeType, JSON.stringify(scopeIds),
      startAt, endAt, validDays, stock, limitPerUser, claimType, status, now(), id,
    );
    couponId = id;
  } else {
    couponId = Number(run(
      `INSERT INTO coupons (shop_id, name, type, threshold, amount, discount_rate, scope_type, scope_ids, start_at, end_at,
              valid_days, stock, received, limit_per_user, claim_type, status, created_at, updated_at)
       VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      name, type, threshold, amount, discountRate, scopeType, JSON.stringify(scopeIds),
      startAt, endAt, validDays, stock, limitPerUser, claimType, status, now(), now(),
    ).lastInsertRowid);
    created = true;
  }

  svc.writeLog(ctx, {
    module: '平台优惠券', action: created ? '新增平台券' : '更新平台券', targetType: 'coupon', targetId: couponId,
    detail: { name, type, threshold, amount, discountRate, scopeType, scopeIds, stock, status },
  });

  return {
    created,
    row: couponOut(get(
      `SELECT c.*, (SELECT COUNT(*) FROM user_coupons uc WHERE uc.coupon_id = c.id) AS received_count,
              (SELECT COUNT(*) FROM user_coupons uc WHERE uc.coupon_id = c.id AND uc.status = 1) AS used_count
         FROM coupons c WHERE c.id = ?`, couponId,
    )),
  };
}

// ==================== API-118 平台券统计 ====================

/**
 * GET /api/admin/coupons/stat
 * 发放量 / 领取量 / 使用量 / 核销量 / 带动成交额（FR-OPS-035）。
 * 口径：
 *  - 发放量 = 平台券库存总量 Σ stock
 *  - 领取量 = user_coupons 中平台券记录数
 *  - 使用量 = 已使用（uc.status=1）
 *  - 核销量 = 订单已完成（orders.status=3）且使用平台券的订单数
 *  - 带动成交额 = 使用平台券且已支付（status in 1/2/3）的订单实付金额合计（元）
 * 返回总览 + 按券明细。
 */
function couponStat(ctx) {
  const platformIds = all('SELECT id FROM coupons WHERE shop_id = 0').map((r) => Number(r.id));
  const issued = Number(get('SELECT COALESCE(SUM(stock), 0) AS s FROM coupons WHERE shop_id = 0').s);
  const received = Number(get(
    `SELECT COUNT(*) AS c FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE c.shop_id = 0`,
  ).c);
  const used = Number(get(
    `SELECT COUNT(*) AS c FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE c.shop_id = 0 AND uc.status = 1`,
  ).c);
  const verified = Number(get(
    `SELECT COUNT(*) AS c FROM orders o
       JOIN user_coupons uc ON uc.id = o.user_coupon_id
       JOIN coupons c ON c.id = uc.coupon_id
      WHERE c.shop_id = 0 AND o.status = 3`,
  ).c);
  const dealAmount = Number(get(
    `SELECT COALESCE(SUM(o.pay_amount), 0) AS s FROM orders o
       JOIN user_coupons uc ON uc.id = o.user_coupon_id
       JOIN coupons c ON c.id = uc.coupon_id
      WHERE c.shop_id = 0 AND o.status IN (1, 2, 3)`,
  ).s);

  const rows = all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM user_coupons uc WHERE uc.coupon_id = c.id) AS received_count,
            (SELECT COUNT(*) FROM user_coupons uc WHERE uc.coupon_id = c.id AND uc.status = 1) AS used_count,
            (SELECT COUNT(*) FROM orders o JOIN user_coupons uc ON uc.id = o.user_coupon_id WHERE uc.coupon_id = c.id AND o.status = 3) AS verified_count,
            (SELECT COALESCE(SUM(o.pay_amount), 0) FROM orders o JOIN user_coupons uc ON uc.id = o.user_coupon_id
              WHERE uc.coupon_id = c.id AND o.status IN (1, 2, 3)) AS deal_amount
       FROM coupons c WHERE c.shop_id = 0 ORDER BY c.id DESC`,
  ).map((c) => ({
    couponId: Number(c.id),
    name: c.name,
    type: Number(c.type),
    typeName: COUPON_TYPE_NAMES[c.type] || '',
    stock: Number(c.stock),
    received: Number(c.received_count || 0),
    used: Number(c.used_count || 0),
    verified: Number(c.verified_count || 0),
    dealAmount: toYuan(c.deal_amount || 0),
    verifyRate: Number(c.received_count) > 0 ? Number((Number(c.used_count) / Number(c.received_count)).toFixed(4)) : 0,
    status: Number(c.status),
    statusName: Number(c.status) === 1 ? '上架' : '下架',
  }));

  return {
    issued,
    received,
    used,
    verified,
    dealAmount: toYuan(dealAmount),
    receiveRate: issued > 0 ? Number((received / issued).toFixed(4)) : 0,
    useRate: received > 0 ? Number((used / received).toFixed(4)) : 0,
    couponCount: platformIds.length,
    rows,
    note: '统计范围为平台券（coupons.shop_id = 0）；核销量按已完成订单口径，带动成交额为使用平台券的已支付订单实付金额合计',
  };
}

// ==================== API-119 拼团规则 ====================

const DEFAULT_UNFULL_ACTION = '全额退款 + 库存回滚';

/** 读取拼团规则（system_configs，缺省取 config.DEFAULTS） */
function readGroupBuyRule() {
  const minQty = config.getNumber('group_buy_min_qty');
  const maxQty = config.getNumber('group_buy_max_qty');
  const validDays = config.getNumber('group_buy_valid_days');
  return {
    minQty,
    maxQty,
    validDays,
    allowRepeatJoin: config.getBool('group_buy_allow_repeat_join'),
    allowRepeatJoinText: config.getBool('group_buy_allow_repeat_join') ? '允许同一用户重复参团' : '同一团仅允许 1 单（默认）',
    unfullAction: config.getString('group_buy_unfull_action') || DEFAULT_UNFULL_ACTION,
    rangeText: '10~99',
    validDaysFixed: 3,
    note: 'Q-001：成团人数 10~99、拼团有效期 3 天、未成团全额退款（含运费）并回滚库存',
  };
}

/** GET /api/admin/group-buy-rule（API-119 查询面） */
function getGroupBuyRule(ctx) {
  return readGroupBuyRule();
}

/**
 * PUT /api/admin/group-buy-rule
 * { minQty, maxQty, validDays, allowRepeatJoin, unfullAction }
 * 写 system_configs：group_buy_min_qty / group_buy_max_qty / group_buy_valid_days /
 *                   group_buy_allow_repeat_join / group_buy_unfull_action（FR-OPS-037）。
 * 越界 → 400「成团人数须落在 10~99 区间」。
 */
function updateGroupBuyRule(ctx) {
  const body = ctx.body || {};
  const current = readGroupBuyRule();
  const minQty = body.minQty !== undefined ? svc.intOr(body.minQty, 'minQty', current.minQty)
    : (body.group_buy_min_qty !== undefined ? svc.intOr(body.group_buy_min_qty, 'minQty', current.minQty) : current.minQty);
  const maxQty = body.maxQty !== undefined ? svc.intOr(body.maxQty, 'maxQty', current.maxQty)
    : (body.group_buy_max_qty !== undefined ? svc.intOr(body.group_buy_max_qty, 'maxQty', current.maxQty) : current.maxQty);

  if (!(minQty >= 10 && minQty <= 99) || !(maxQty >= 10 && maxQty <= 99)) {
    throw Errors.badRequest('成团人数须落在 10~99 区间');
  }
  if (minQty > maxQty) throw Errors.badRequest('成团人数下限不能大于上限');

  const rawValidDays = body.validDays !== undefined ? body.validDays : body.group_buy_valid_days;
  if (rawValidDays !== undefined && rawValidDays !== null && rawValidDays !== '' && Number(rawValidDays) !== 3) {
    throw Errors.badRequest('拼团有效期固定为 3 天（Q-001），不支持自定义');
  }
  const validDays = 3;
  const allowRepeatJoin = body.allowRepeatJoin !== undefined
    ? svc.boolOf(body.allowRepeatJoin, false)
    : (body.group_buy_allow_repeat_join !== undefined ? svc.boolOf(body.group_buy_allow_repeat_join, false) : current.allowRepeatJoin);
  const unfullAction = body.unfullAction !== undefined
    ? v.str(body.unfullAction, 'unfullAction', { min: 1, max: 60 })
    : current.unfullAction;

  config.set('group_buy_min_qty', String(minQty), '拼团成团人数下限（Q-001：10~99）', ctx.admin.id);
  config.set('group_buy_max_qty', String(maxQty), '拼团成团人数上限（Q-001：10~99）', ctx.admin.id);
  config.set('group_buy_valid_days', String(validDays), '拼团有效期天数（Q-001：固定 3 天）', ctx.admin.id);
  config.set('group_buy_allow_repeat_join', allowRepeatJoin ? '1' : '0', '是否允许同一用户重复参团', ctx.admin.id);
  config.set('group_buy_unfull_action', unfullAction, '未成团处理方式（默认全额退款 + 库存回滚）', ctx.admin.id);

  svc.writeLog(ctx, {
    module: '拼团规则', action: '更新拼团规则', targetType: 'system_config', targetId: 'group_buy',
    detail: { minQty, maxQty, validDays, allowRepeatJoin, unfullAction },
  });

  return { ...readGroupBuyRule(), updated: true };
}

// ==================== API-120 拼团活动管理 ====================

/**
 * GET /api/admin/group-buys
 * ?status=0|1|2|3|4|5|all &state=ongoing|formed|unformed &shopId= &page=&pageSize=
 * 列表含成团监控信息（进行中 / 已成团 / 未成团，FR-OPS-039）。
 */
function listGroupBuys(ctx) {
  const params = [];
  let where = 'WHERE 1 = 1';
  const stateMap = { ongoing: 1, formed: 2, unformed: 3 };
  if (ctx.query.state) {
    const state = String(ctx.query.state).toLowerCase();
    if (!stateMap[state]) throw Errors.badRequest('state 取值不合法（ongoing / formed / unformed）');
    where += ' AND g.status = ?';
    params.push(stateMap[state]);
  } else if (ctx.query.status !== undefined && ctx.query.status !== '' && String(ctx.query.status).toLowerCase() !== 'all') {
    where += ' AND g.status = ?';
    params.push(Number(v.oneOf(ctx.query.status, ['0', '1', '2', '3', '4', '5'], 'status')));
  }
  if (ctx.query.shopId) { where += ' AND g.shop_id = ?'; params.push(v.int(ctx.query.shopId, 'shopId', { min: 1 })); }
  if (ctx.query.keyword) {
    where += ' AND (g.title LIKE ? OR p.name LIKE ? OR s.name LIKE ?)';
    const kw = `%${String(ctx.query.keyword).trim()}%`;
    params.push(kw, kw, kw);
  }

  const { page, pageSize, offset } = db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
  const total = Number(get(
    `SELECT COUNT(*) AS c FROM group_buys g LEFT JOIN products p ON p.id = g.product_id LEFT JOIN shops s ON s.id = g.shop_id ${where}`,
    ...params,
  ).c);
  const rows = all(
    `SELECT g.*, p.name AS product_name, p.main_image, s.name AS shop_name,
            sku.spec_name, sku.price AS sku_price
       FROM group_buys g
       LEFT JOIN products p ON p.id = g.product_id
       LEFT JOIN shops s ON s.id = g.shop_id
       LEFT JOIN skus sku ON sku.id = g.sku_id
       ${where} ORDER BY g.status ASC, g.start_at DESC, g.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset,
  ).map(groupBuyOut);

  const counts = {};
  for (const row of all('SELECT status, COUNT(*) AS c FROM group_buys GROUP BY status')) counts[row.status] = Number(row.c);

  return {
    total,
    rows,
    page,
    pageSize,
    statusCounts: counts,
    monitoring: {
      ongoing: counts[1] || 0,
      formed: counts[2] || 0,
      unformed: counts[3] || 0,
    },
  };
}

function groupBuyOut(g) {
  const teams = all('SELECT status, COUNT(*) AS c FROM group_teams WHERE group_buy_id = ? GROUP BY status', g.id);
  const teamMap = {};
  for (const t of teams) teamMap[t.status] = Number(t.c);
  const required = Number(g.required_count || 0);
  const joined = Number(g.joined_count || 0);
  return {
    id: Number(g.id),
    shopId: Number(g.shop_id),
    shopName: g.shop_name || '',
    productId: Number(g.product_id),
    productName: g.product_name || '',
    mainImage: g.main_image || '',
    skuId: Number(g.sku_id),
    specName: g.spec_name || '',
    skuPrice: toYuan(g.sku_price || 0),
    title: g.title,
    groupPrice: toYuan(g.group_price),
    requiredCount: required,
    joinedCount: joined,
    progress: required > 0 ? Number((joined / required).toFixed(4)) : 0,
    startAt: g.start_at,
    endAt: g.end_at,
    validDays: Number(g.valid_days || 3),
    status: Number(g.status),
    statusName: svc.GROUP_BUY_STATUS[g.status] || '',
    auditReason: g.audit_reason || '',
    teams: { total: Object.values(teamMap).reduce((s, n) => s + n, 0), ongoing: teamMap[1] || 0, formed: teamMap[2] || 0, unformed: teamMap[3] || 0 },
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

/**
 * POST /api/admin/group-buys
 * 两种载荷：
 *  1) 审核商家报名：{ id, action: 'approve' | 'reject', rejectReason? }
 *     - 通过：校验拼团价 ≤ SKU 商城价、成团人数落在配置区间，status=1（进行中）
 *     - 驳回：必填原因，status=4
 *  2) 平台新建活动：{ productId, skuId, groupPrice, requiredCount, startAt, endAt, title? }
 *     - 拼团价 > SKU 商城价 → 400「拼团价不得高于该 SKU 商城价」
 *     - 成团人数不在 10~99 → 400「成团人数须落在 10~99 区间」
 * 均写通知与审计日志（FR-OPS-038 / 039）。
 */
function saveGroupBuy(ctx) {
  const body = ctx.body || {};
  if (body.id !== undefined && body.id !== null && body.id !== '' && body.action !== undefined) {
    return auditGroupBuy(ctx, body);
  }
  return createGroupBuy(ctx, body);
}

function auditGroupBuy(ctx, body) {
  const id = v.int(body.id, 'id', { min: 1 });
  const action = v.oneOf(body.action, ['approve', 'reject'], 'action');
  const reason = String(body.rejectReason ?? body.reason ?? '').trim();
  const groupBuy = get(
    `SELECT g.*, p.name AS product_name, s.name AS shop_name, sku.price AS sku_price
       FROM group_buys g LEFT JOIN products p ON p.id = g.product_id
       LEFT JOIN shops s ON s.id = g.shop_id LEFT JOIN skus sku ON sku.id = g.sku_id
      WHERE g.id = ?`, id,
  );
  if (!groupBuy) throw Errors.notFound('拼团活动不存在');
  if (action === 'reject' && !reason) throw Errors.badRequest('请填写驳回原因');

  if (action === 'approve') {
    if (Number(groupBuy.sku_price) > 0 && Number(groupBuy.group_price) > Number(groupBuy.sku_price)) {
      throw Errors.badRequest('拼团价不得高于该 SKU 商城价');
    }
    assertRequiredCount(Number(groupBuy.required_count));
  }

  const nextStatus = action === 'approve' ? 1 : 4;
  run('UPDATE group_buys SET status = ?, audit_reason = ?, updated_at = ? WHERE id = ?',
    nextStatus, action === 'approve' ? null : reason, now(), id);

  if (action === 'approve') {
    svc.notifySeller(groupBuy.shop_id, '拼团报名审核通过', `您报名的拼团活动「${groupBuy.title}」已通过平台审核，现已开始成团。成团人数 ${groupBuy.required_count} 人，有效期 ${groupBuy.valid_days} 天。`);
  } else {
    svc.notifySeller(groupBuy.shop_id, '拼团报名审核未通过', `您报名的拼团活动「${groupBuy.title}」未通过审核，原因：${reason}。`);
  }

  svc.writeLog(ctx, {
    module: '拼团规则', action: action === 'approve' ? '拼团报名通过' : '拼团报名驳回', targetType: 'group_buy', targetId: id,
    detail: { shopId: groupBuy.shop_id, title: groupBuy.title, fromStatus: groupBuy.status, toStatus: nextStatus, reason: action === 'reject' ? reason : '' },
  });

  return {
    mode: 'audit',
    id,
    action,
    status: nextStatus,
    statusName: svc.GROUP_BUY_STATUS[nextStatus] || '',
    auditReason: action === 'approve' ? '' : reason,
    row: groupBuyOut(get(
      `SELECT g.*, p.name AS product_name, p.main_image, s.name AS shop_name, sku.spec_name, sku.price AS sku_price
         FROM group_buys g LEFT JOIN products p ON p.id = g.product_id LEFT JOIN shops s ON s.id = g.shop_id
         LEFT JOIN skus sku ON sku.id = g.sku_id WHERE g.id = ?`, id,
    )),
  };
}

function assertRequiredCount(requiredCount) {
  const rule = readGroupBuyRule();
  if (!(requiredCount >= rule.minQty && requiredCount <= rule.maxQty)) {
    throw Errors.badRequest('成团人数须落在 10~99 区间');
  }
}

function createGroupBuy(ctx, body) {
  const productId = v.int(body.productId, 'productId', { min: 1 });
  const skuId = v.int(body.skuId, 'skuId', { min: 1 });
  const product = get('SELECT * FROM products WHERE id = ?', productId);
  if (!product || Number(product.is_deleted) === 1) throw Errors.badRequest('商品不存在或已删除');
  const sku = get('SELECT * FROM skus WHERE id = ?', skuId);
  if (!sku) throw Errors.badRequest('SKU 不存在');
  if (Number(sku.product_id) !== productId) throw Errors.badRequest('SKU 不属于所选商品');

  const groupPrice = svc.cents(body.groupPrice, 'groupPrice', { allowZero: false });
  if (groupPrice > Number(sku.price)) throw Errors.badRequest('拼团价不得高于该 SKU 商城价');

  const requiredCount = v.int(body.requiredCount !== undefined ? body.requiredCount : body.required_count, 'requiredCount', { min: 1 });
  assertRequiredCount(requiredCount);

  const startAt = svc.normTime(body.startAt, { field: 'startAt', required: true });
  const endAt = svc.normTime(body.endAt, { field: 'endAt', endOfDay: true, required: true });
  if (startAt >= endAt) throw Errors.badRequest('拼团结束时间须晚于开始时间');
  const rule = readGroupBuyRule();
  const title = v.str(body.title !== undefined ? body.title : `${product.name} 拼团`, 'title', { min: 1, max: 60 });
  const skuStatus = Number(sku.status);
  if (skuStatus !== 1) throw Errors.badRequest('该 SKU 已停用，无法创建拼团');

  const groupBuyId = Number(run(
    `INSERT INTO group_buys (shop_id, product_id, sku_id, title, group_price, required_count, joined_count,
        start_at, end_at, valid_days, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)`,
    product.shop_id, productId, skuId, title, groupPrice, requiredCount, startAt, endAt, rule.validDays, now(), now(),
  ).lastInsertRowid);

  svc.writeLog(ctx, {
    module: '拼团规则', action: '新建拼团活动', targetType: 'group_buy', targetId: groupBuyId,
    detail: { productId, skuId, groupPrice, requiredCount, startAt, endAt, shopId: product.shop_id },
  });

  return {
    mode: 'create',
    row: groupBuyOut(get(
      `SELECT g.*, p.name AS product_name, p.main_image, s.name AS shop_name, sku.spec_name, sku.price AS sku_price
         FROM group_buys g LEFT JOIN products p ON p.id = g.product_id LEFT JOIN shops s ON s.id = g.shop_id
         LEFT JOIN skus sku ON sku.id = g.sku_id WHERE g.id = ?`, groupBuyId,
    )),
    note: '平台新建拼团活动直接进入「进行中」；商家报名须经审核（action=approve / reject）',
  };
}

// ==================== API-121 到店服务审核 ====================

/**
 * POST /api/admin/store-services/:id/audit
 * { action: 'approve' | 'reject', rejectReason? }
 * 到店服务状态：0 待审核 / 1 已通过 / 2 已驳回 / 3 已下线（FR-OPS-040）。
 * 驳回必填原因；结果通知商家并记审计日志。
 */
function auditStoreService(ctx) {
  const id = v.int(ctx.params.id, 'id', { min: 1 });
  const service = get(
    'SELECT ss.*, s.name AS shop_name FROM store_services ss LEFT JOIN shops s ON s.id = ss.shop_id WHERE ss.id = ?',
    id,
  );
  if (!service) throw Errors.notFound('到店服务不存在');

  const body = ctx.body || {};
  const action = v.oneOf(body.action, ['approve', 'reject', 'offline'], 'action');
  const reason = String(body.rejectReason ?? body.reason ?? '').trim();
  if (action === 'reject' && !reason) throw Errors.badRequest('请填写驳回原因');

  const nextStatus = { approve: 1, reject: 2, offline: 3 }[action];
  const auditReason = action === 'approve' ? null : (reason || '平台下线');
  run('UPDATE store_services SET status = ?, audit_reason = ?, updated_at = ? WHERE id = ?',
    nextStatus, auditReason, now(), id);

  const title = { approve: '到店服务审核通过', reject: '到店服务审核未通过', offline: '到店服务已下线' }[action];
  const content = action === 'approve'
    ? `您的到店服务「${service.name}」（到店价 ${toYuan(service.store_price)} 元）已通过平台审核，已在前台「到店」展示。`
    : (action === 'reject'
      ? `您的到店服务「${service.name}」未通过平台审核，原因：${reason}。请修改后重新提交。`
      : `您的到店服务「${service.name}」已被平台下线，原因：${auditReason}。`);
  svc.notifySeller(service.shop_id, title, content);

  svc.writeLog(ctx, {
    module: '到店服务', action: title, targetType: 'store_service', targetId: id,
    detail: {
      serviceName: service.name, shopId: service.shop_id, fromStatus: service.status,
      toStatus: nextStatus, reason: auditReason || '',
    },
  });

  const updated = get('SELECT * FROM store_services WHERE id = ?', id);
  return {
    id,
    action,
    status: nextStatus,
    statusName: ['待审核', '已通过', '已驳回', '已下线'][nextStatus] || '',
    auditReason: auditReason || '',
    service: {
      id: Number(updated.id),
      shopId: Number(updated.shop_id),
      shopName: service.shop_name || '',
      name: updated.name,
      originPrice: toYuan(updated.origin_price),
      storePrice: toYuan(updated.store_price),
      validStart: updated.valid_start,
      validEnd: updated.valid_end,
      bookingSlots: parseJson(updated.booking_slots, []) || [],
      slotCapacity: Number(updated.slot_capacity),
      status: Number(updated.status),
      statusName: ['待审核', '已通过', '已驳回', '已下线'][updated.status] || '',
    },
  };
}

// ==================== API-122 到店核销记录查询 ====================

/**
 * GET /api/admin/store-verifications
 * ?verifyCode=&storeId=&shopId=&bookingNo=&startAt=&endAt=&bookingDate=&page=&pageSize=
 * 返回核销码 / 门店 / 时间 / 核销人 / 收款金额（元）/ 付款方式（FR-OPS-041）。
 * 核销本身幂等由核销方保证（store_bookings.status=2 + store_verifications 唯一记录），后台仅查询。
 */
function listStoreVerifications(ctx) {
  const params = [];
  let where = 'WHERE 1 = 1';
  if (ctx.query.verifyCode) { where += ' AND v.verify_code = ?'; params.push(String(ctx.query.verifyCode).trim()); }
  if (ctx.query.storeId) { where += ' AND v.store_id = ?'; params.push(v.int(ctx.query.storeId, 'storeId', { min: 1 })); }
  if (ctx.query.shopId) { where += ' AND v.shop_id = ?'; params.push(v.int(ctx.query.shopId, 'shopId', { min: 1 })); }
  if (ctx.query.bookingNo) { where += ' AND b.booking_no = ?'; params.push(String(ctx.query.bookingNo).trim()); }
  if (ctx.query.bookingDate) {
    const bookingDate = String(ctx.query.bookingDate).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) throw Errors.badRequest('预约日期格式不正确（YYYY-MM-DD）');
    where += ' AND b.booking_date = ?';
    params.push(bookingDate);
  }
  const startAt = svc.normTime(ctx.query.startAt, { field: 'startAt' });
  const endAt = svc.normTime(ctx.query.endAt, { field: 'endAt', endOfDay: true });
  if (startAt) { where += ' AND v.created_at >= ?'; params.push(startAt); }
  if (endAt) { where += ' AND v.created_at <= ?'; params.push(endAt); }

  const { page, pageSize, offset } = db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
  const from = `FROM store_verifications v
      LEFT JOIN store_bookings b ON b.id = v.booking_id
      LEFT JOIN stores st ON st.id = v.store_id
      LEFT JOIN shops sh ON sh.id = v.shop_id
      LEFT JOIN admin_users au ON au.id = v.verified_by`;
  const total = Number(get(`SELECT COUNT(*) AS c ${from} ${where}`, ...params).c);
  const rows = all(
    `SELECT v.*, b.booking_no, b.booking_date, b.slot, b.contact, b.phone, b.status AS booking_status,
            st.name AS store_name, st.address AS store_address,
            sh.name AS shop_name,
            au.name AS verifier_name, au.account AS verifier_account
       ${from} ${where} ORDER BY v.created_at DESC, v.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset,
  ).map((r) => ({
    id: Number(r.id),
    verifyCode: r.verify_code,
    bookingId: Number(r.booking_id),
    bookingNo: r.booking_no || '',
    bookingDate: r.booking_date || '',
    slot: r.slot || '',
    contact: r.contact || '',
    phoneMasked: require('../core/privacy').maskPhone(r.phone),
    storeId: Number(r.store_id),
    storeName: r.store_name || '',
    storeAddress: r.store_address || '',
    shopId: Number(r.shop_id),
    shopName: r.shop_name || '',
    verifiedBy: Number(r.verified_by),
    verifierName: r.verifier_name || r.verifier_account || '',
    paidAmount: toYuan(r.paid_amount),
    payMethod: r.pay_method,
    verifiedAt: r.created_at,
    bookingStatus: Number(r.booking_status),
    bookingStatusName: VERIFY_STATUS[r.booking_status] || '',
  }));

  const sum = get(
    `SELECT COALESCE(SUM(v.paid_amount), 0) AS amount, COUNT(*) AS c ${from} ${where}`,
    ...params,
  );

  return {
    total,
    rows,
    page,
    pageSize,
    summary: { verificationCount: Number(sum.c || 0), paidAmount: toYuan(sum.amount || 0) },
    note: '核销须幂等：同一预约重复核销由核销接口拒绝（FR-OPS-041），后台仅提供记录查询',
  };
}

// ==================== 到店业务总览 ====================

/**
 * GET /api/admin/store-overview
 * ?startDate=&endDate=&shopId=&storeId=&groupBy=shop|store|date
 * 按店铺 / 门店 / 日期统计预约量、到店率、核销率与到店收款金额（FR-OPS-043）。
 * 口径：
 *  - 预约量 = store_bookings 数量（按 booking_date 归日）
 *  - 到店率 = 已核销预约数 / 预约总数
 *  - 核销率 = 已核销预约数 / 应到店预约数（预约总数 − 已取消）
 *  - 到店收款金额 = 已核销预约的核销收款金额合计（store_verifications.paid_amount，缺省回退 store_bookings.paid_amount）
 */
function storeOverview(ctx) {
  const startDate = ctx.query.startDate ? parseDateOnly(ctx.query.startDate, 'startDate') : today(-29);
  const endDate = ctx.query.endDate ? parseDateOnly(ctx.query.endDate, 'endDate') : today();
  if (startDate > endDate) throw Errors.badRequest('开始日期不能晚于结束日期');

  const params = [startDate, endDate];
  let where = 'WHERE b.booking_date >= ? AND b.booking_date <= ?';
  if (ctx.query.shopId) { where += ' AND st.shop_id = ?'; params.push(v.int(ctx.query.shopId, 'shopId', { min: 1 })); }
  if (ctx.query.storeId) { where += ' AND b.store_id = ?'; params.push(v.int(ctx.query.storeId, 'storeId', { min: 1 })); }

  const groupBy = ctx.query.groupBy ? v.oneOf(ctx.query.groupBy, ['shop', 'store', 'date'], 'groupBy') : 'shop';

  const raw = all(
    `SELECT b.store_id, b.booking_date AS date, st.shop_id, st.name AS store_name, sh.name AS shop_name,
            COUNT(*) AS bookings,
            SUM(CASE WHEN b.status = 2 THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN b.status = 3 THEN 1 ELSE 0 END) AS canceled,
            COALESCE(SUM(CASE WHEN b.status = 2 THEN COALESCE(v.amount, b.paid_amount) ELSE 0 END), 0) AS amount,
            COUNT(v.booking_id) AS verify_records
       FROM store_bookings b
       JOIN stores st ON st.id = b.store_id
       LEFT JOIN shops sh ON sh.id = st.shop_id
       LEFT JOIN (SELECT booking_id, SUM(paid_amount) AS amount FROM store_verifications GROUP BY booking_id) v
              ON v.booking_id = b.id
       ${where}
      GROUP BY b.store_id, b.booking_date
      ORDER BY b.booking_date ASC, b.store_id ASC`,
    ...params,
  );

  const buckets = new Map();
  for (const r of raw) {
    const key = groupBy === 'shop' ? `shop:${r.shop_id}`
      : (groupBy === 'store' ? `store:${r.store_id}` : `date:${r.date}`);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        groupBy,
        shopId: groupBy === 'shop' || groupBy === 'store' ? Number(r.shop_id) : null,
        shopName: groupBy === 'shop' || groupBy === 'store' ? (r.shop_name || '') : '',
        storeId: groupBy === 'store' ? Number(r.store_id) : null,
        storeName: groupBy === 'store' ? (r.store_name || '') : '',
        date: groupBy === 'date' ? r.date : null,
        bookings: 0,
        verified: 0,
        canceled: 0,
        verifyRecords: 0,
        amountCents: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.bookings += Number(r.bookings || 0);
    bucket.verified += Number(r.verified || 0);
    bucket.canceled += Number(r.canceled || 0);
    bucket.verifyRecords += Number(r.verify_records || 0);
    bucket.amountCents += Number(r.amount || 0);
  }

  const rows = [...buckets.values()].map((b) => {
    const shouldArrive = Math.max(0, b.bookings - b.canceled);
    return {
      key: b.key,
      groupBy: b.groupBy,
      shopId: b.shopId,
      shopName: b.shopName,
      storeId: b.storeId,
      storeName: b.storeName,
      date: b.date,
      bookings: b.bookings,
      verified: b.verified,
      canceled: b.canceled,
      verifyRecords: b.verifyRecords,
      arriveRate: b.bookings > 0 ? Number((b.verified / b.bookings).toFixed(4)) : 0,
      verifyRate: shouldArrive > 0 ? Number((b.verified / shouldArrive).toFixed(4)) : 0,
      amount: toYuan(b.amountCents),
    };
  }).sort((a, b) => (b.bookings - a.bookings) || String(a.key).localeCompare(String(b.key)));

  const totals = rows.reduce((acc, r) => {
    acc.bookings += r.bookings;
    acc.verified += r.verified;
    acc.canceled += r.canceled;
    acc.verifyRecords += r.verifyRecords;
    acc.amountCents += Math.round(r.amount * 100);
    return acc;
  }, { bookings: 0, verified: 0, canceled: 0, verifyRecords: 0, amountCents: 0 });

  const shouldArrive = Math.max(0, totals.bookings - totals.canceled);
  return {
    startDate,
    endDate,
    groupBy,
    rows,
    summary: {
      bookings: totals.bookings,
      verified: totals.verified,
      canceled: totals.canceled,
      verifyRecords: totals.verifyRecords,
      arriveRate: totals.bookings > 0 ? Number((totals.verified / totals.bookings).toFixed(4)) : 0,
      verifyRate: shouldArrive > 0 ? Number((totals.verified / shouldArrive).toFixed(4)) : 0,
      amount: toYuan(totals.amountCents),
      storeCount: new Set(raw.map((r) => r.store_id)).size,
      shopCount: new Set(raw.map((r) => r.shop_id)).size,
    },
    note: '到店率 = 已核销 / 预约总数；核销率 = 已核销 / 应到店（预约总数 − 已取消）；收款金额取核销记录中的到店付款金额',
  };
}

/** 日期归一为 YYYY-MM-DD */
function parseDateOnly(value, field) {
  const s = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw Errors.badRequest(`${v.labelOf(field)}格式不正确（YYYY-MM-DD）`);
  return s;
}

module.exports = function register(api) {
  // API-114 / 115 活动审核（FR-OPS-029 ~ 032）
  api.get('/api/admin/activity-audits', { auth: 'admin', perm: PERM_ACTIVITY }, listActivityAudits);
  api.post('/api/admin/activity-audits/:id/audit', { auth: 'admin', perm: PERM_ACTIVITY }, auditActivity);

  // API-116 / 117 / 118 平台券（FR-OPS-033 ~ 036）
  api.get('/api/admin/coupons', { auth: 'admin', perm: PERM_COUPON }, listCoupons);
  api.post('/api/admin/coupons', { auth: 'admin', perm: PERM_COUPON }, saveCoupon);
  api.get('/api/admin/coupons/stat', { auth: 'admin', perm: PERM_COUPON }, couponStat);

  // API-119 / 120 拼团规则与拼团活动（FR-OPS-037 ~ 039）
  api.get('/api/admin/group-buy-rule', { auth: 'admin', perm: PERM_GROUP_BUY }, getGroupBuyRule);
  api.put('/api/admin/group-buy-rule', { auth: 'admin', perm: PERM_GROUP_BUY }, updateGroupBuyRule);
  api.get('/api/admin/group-buys', { auth: 'admin', perm: PERM_GROUP_BUY }, listGroupBuys);
  api.post('/api/admin/group-buys', { auth: 'admin', perm: PERM_GROUP_BUY }, saveGroupBuy);

  // API-121 / 122 到店服务审核、核销记录、到店总览（FR-OPS-040 ~ 043）
  api.post('/api/admin/store-services/:id/audit', { auth: 'admin', perm: PERM_STORE }, auditStoreService);
  api.get('/api/admin/store-verifications', { auth: 'admin', perm: PERM_STORE }, listStoreVerifications);
  api.get('/api/admin/store-overview', { auth: 'admin', perm: PERM_STORE }, storeOverview);
};
