'use strict';

const db = require('../core/db');
const { Errors } = require('../core/errors');
const { toYuan, toCents, now, today } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const { auditLog, sendRaw } = require('../core/http');
const v = require('../core/validate');
const config = require('../core/config');
const paymentSvc = require('../services/payment-service');
const refundSvc = require('../services/refund-service');
const settlementSvc = require('../services/settlement-service');

/**
 * 平台后台 · 财务域（API-134 ~ API-140）
 * 对应《需求文档》9.4.4 财务（FR-FIN-001 ~ FR-FIN-016）、《测试文档》TC-FIN-001/002/003。
 *
 * 口径约定（与 9.4.4 / 11.4 金额口径一致）：
 *  - 成交额 = payments.status IN (1,3)（支付成功或被全额退款前已支付）的 SUM(amount)；
 *  - 退款额 = refund_orders.status = 2（已退款）的 SUM(amount)；
 *  - 佣金收入 = (实付 − 退款) × commission_rate（平台可配，默认 5%，Q-016）；
 *  - 商家应结 = 实付 − 退款 − 佣金；
 *  - 对账长款 = 渠道账单金额 − 系统实付（正数长款 / 负数短款）。
 */

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  // UTF-8 BOM：保证 Excel 正确识别中文
  return `\uFEFF${lines.join('\r\n')}`;
}

function sendCsv(ctx, filename, headers, rows) {
  const buf = Buffer.from(buildCsv(headers, rows), 'utf8');
  return sendRaw(ctx, 200, 'text/csv; charset=utf-8', buf, filename);
}

/** 归一化日期参数为 YYYY-MM-DD；非法值抛 400 */
function normDate(value, field = 'date') {
  const s = String(value || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) throw Errors.badRequest('日期格式应为 YYYY-MM-DD', { field });
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function isExport(ctx) {
  return String(ctx.query.export || '').toLowerCase() === 'csv';
}

function pagingOf(ctx) {
  return db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
}

/* ------------------------------------------------------------------ *
 * API-134 订单对账（列表 / 按日生成 / 锁定）
 * ------------------------------------------------------------------ */

function toReconApi(row) {
  const detail = db.parseJson(row.diff_detail, null);
  return {
    id: row.id,
    bizDate: row.biz_date,
    channel: row.channel,
    channelName: paymentSvc.channelName(row.channel),
    totalAmount: toYuan(row.total_amount),
    paidAmount: toYuan(row.paid_amount),
    refundAmount: toYuan(row.refund_amount),
    diffAmount: toYuan(row.diff_amount),
    diffDetail: detail,
    longAmount: detail ? toYuan(detail.longAmount || 0) : 0,
    shortAmount: detail ? toYuan(detail.shortAmount || 0) : 0,
    status: row.status,
    statusName: row.status === 1 ? '已锁定' : '待核对',
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    createdAt: row.created_at,
  };
}

/** 订单级对账列表（默认） */
function listOrderReconciliations(ctx) {
  const { pageSize, limit, offset } = pagingOf(ctx);
  const q = ctx.query;
  const params = [];
  let where = 'WHERE p.paid_at IS NOT NULL AND p.status IN (1, 3)';
  if (q.channel) { where += ' AND p.channel = ?'; params.push(q.channel); }
  if (q.keyword) {
    where += ' AND (p.pay_no LIKE ? OR o.order_no LIKE ?)';
    params.push(`%${q.keyword}%`, `%${q.keyword}%`);
  }
  if (q.orderNo) { where += ' AND o.order_no = ?'; params.push(q.orderNo); }
  if (q.shopId) { where += ' AND o.shop_id = ?'; params.push(Number(q.shopId)); }
  if (q.dateFrom) { where += ' AND substr(p.paid_at, 1, 10) >= ?'; params.push(normDate(q.dateFrom, 'dateFrom')); }
  if (q.dateTo) { where += ' AND substr(p.paid_at, 1, 10) <= ?'; params.push(normDate(q.dateTo, 'dateTo')); }
  if (q.reconStatus !== undefined && q.reconStatus !== '') {
    where += ' AND COALESCE(rc.status, 0) = ?';
    params.push(Number(q.reconStatus));
  }
  const from = `FROM payments p
      JOIN orders o ON o.id = p.order_id
      JOIN shops s ON s.id = o.shop_id
      JOIN users u ON u.id = o.user_id
      LEFT JOIN reconciliations rc ON rc.biz_date = substr(p.paid_at, 1, 10) AND rc.channel = p.channel`;

  const total = db.get(`SELECT COUNT(*) AS c ${from} ${where}`, ...params).c;
  const sum = db.get(`SELECT COALESCE(SUM(p.amount), 0) AS paid, COUNT(*) AS c ${from} ${where}`, ...params);
  const rows = db.all(
    `SELECT p.id, p.pay_no, p.channel, p.amount, p.status, p.paid_at,
            o.id AS order_id, o.order_no, o.shop_id, o.pay_amount,
            s.name AS shop_name, u.username, u.phone,
            COALESCE(rc.status, 0) AS recon_status, rc.id AS recon_id
       ${from} ${where} ORDER BY p.paid_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );

  const rate = config.getNumber('commission_rate');
  const orderIds = rows.map((r) => r.order_id);
  const refundMap = new Map();
  if (orderIds.length) {
    const marks = orderIds.map(() => '?').join(',');
    for (const r of db.all(
      `SELECT order_id, COALESCE(SUM(amount), 0) AS s FROM refund_orders
        WHERE status = 2 AND order_id IN (${marks}) GROUP BY order_id`, ...orderIds,
    )) refundMap.set(r.order_id, r.s);
  }

  const list = rows.map((r) => {
    const refund = refundMap.get(r.order_id) || 0;
    const net = r.amount - refund;
    const commission = Math.max(0, Math.round(net * rate));
    return {
      id: r.id,
      orderId: r.order_id,
      orderNo: r.order_no,
      paidAt: r.paid_at,
      channel: r.channel,
      channelName: paymentSvc.channelName(r.channel),
      payNo: r.pay_no,
      payAmount: toYuan(r.amount),
      refundAmount: toYuan(refund),
      commission: toYuan(commission),
      payableAmount: toYuan(Math.max(0, net - commission)),
      reconId: r.recon_id || null,
      reconStatus: r.recon_status,
      reconStatusName: r.recon_status === 1 ? '已锁定' : '待核对',
      shop: { id: r.shop_id, name: r.shop_name },
      buyer: { username: r.username, phoneMask: maskPhone(r.phone) },
    };
  });

  return {
    total,
    rows: list,
    scope: 'order',
    page: Number(ctx.query.page) || 1,
    pageSize,
    summary: { paidAmount: toYuan(sum.paid), orderCount: sum.c, commissionRate: rate },
  };
}

/** 按日 + 渠道的对账批次列表 */
function listBatchReconciliations(ctx) {
  const { limit, offset } = pagingOf(ctx);
  const q = ctx.query;
  const params = [];
  let where = 'WHERE 1 = 1';
  if (q.channel) { where += ' AND channel = ?'; params.push(q.channel); }
  if (q.dateFrom) { where += ' AND biz_date >= ?'; params.push(normDate(q.dateFrom, 'dateFrom')); }
  if (q.dateTo) { where += ' AND biz_date <= ?'; params.push(normDate(q.dateTo, 'dateTo')); }
  if (q.reconStatus !== undefined && q.reconStatus !== '') { where += ' AND status = ?'; params.push(Number(q.reconStatus)); }
  const total = db.get(`SELECT COUNT(*) AS c FROM reconciliations ${where}`, ...params).c;
  const rows = db.all(`SELECT * FROM reconciliations ${where} ORDER BY biz_date DESC, channel ASC LIMIT ? OFFSET ?`,
    ...params, limit, offset);
  return { total, rows: rows.map(toReconApi), scope: 'batch' };
}

function listReconciliations(ctx) {
  const scope = String(ctx.query.scope || 'order');
  return scope === 'batch' || scope === 'day' ? listBatchReconciliations(ctx) : listOrderReconciliations(ctx);
}

/** 汇总某日某渠道的支付与退款流水 */
function summaryOf(bizDate, channel) {
  const paid = db.get(
    `SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c FROM payments
      WHERE channel = ? AND status IN (1, 3) AND paid_at IS NOT NULL AND substr(paid_at, 1, 10) = ?`,
    channel, bizDate,
  );
  const refund = db.get(
    `SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c FROM refund_orders
      WHERE channel = ? AND status = 2 AND refunded_at IS NOT NULL AND substr(refunded_at, 1, 10) = ?`,
    channel, bizDate,
  );
  return { paidAmount: paid.s, orderCount: paid.c, refundAmount: refund.s, refundCount: refund.c };
}

function channelsOnDate(bizDate) {
  const fromPay = db.all(
    `SELECT channel FROM payments WHERE status IN (1, 3) AND paid_at IS NOT NULL AND substr(paid_at, 1, 10) = ? GROUP BY channel`,
    bizDate,
  ).map((r) => r.channel);
  const fromRefund = db.all(
    `SELECT channel FROM refund_orders WHERE status = 2 AND refunded_at IS NOT NULL AND substr(refunded_at, 1, 10) = ? GROUP BY channel`,
    bizDate,
  ).map((r) => r.channel);
  return [...new Set([...fromPay, ...fromRefund])].sort();
}

/**
 * 按日生成对账（POST /api/admin/reconciliations/sync）
 * body: { date?, channel?, channelAmount?, channelTotals? }
 *  - channelAmount（元）或 channelTotals（{alipay: 元}）用于模拟渠道账单金额，
 *    未传则视为「渠道账单 = 系统实付」，长短款为 0；
 *  - 已锁定的对账批次不可再次生成（400 对账结果已锁定）。
 */
function syncReconciliations(ctx) {
  const body = ctx.body || {};
  const bizDate = body.date || body.bizDate ? normDate(body.date || body.bizDate, 'date') : today();
  const explicitChannel = body.channel ? String(body.channel) : '';
  const channels = explicitChannel ? [explicitChannel] : channelsOnDate(bizDate);
  if (!channels.length) {
    return { bizDate, generated: 0, reconciliations: [], message: '该日期暂无支付或退款流水，未生成对账批次' };
  }

  const totalsMap = body.channelTotals && typeof body.channelTotals === 'object' ? body.channelTotals : {};
  const results = [];
  db.transaction(() => {
    for (const channel of channels) {
      const s = summaryOf(bizDate, channel);
      let channelTotal = s.paidAmount;
      const raw = totalsMap[channel] !== undefined ? totalsMap[channel] : (explicitChannel ? body.channelAmount : undefined);
      if (raw !== undefined && raw !== null && raw !== '') {
        const cents = toCents(raw);
        if (!Number.isInteger(cents) || cents < 0) throw Errors.badRequest('渠道账单金额不合法（最多两位小数）', { field: 'channelAmount' });
        channelTotal = cents;
      }
      const diff = channelTotal - s.paidAmount;
      const detail = {
        bizDate,
        channel,
        channelTotal,
        systemPaid: s.paidAmount,
        refundAmount: s.refundAmount,
        orderCount: s.orderCount,
        refundCount: s.refundCount,
        diff,
        longAmount: diff > 0 ? diff : 0,
        shortAmount: diff < 0 ? -diff : 0,
        result: diff > 0 ? '长款' : (diff < 0 ? '短款' : '账实相符'),
      };

      const exist = db.get('SELECT * FROM reconciliations WHERE biz_date = ? AND channel = ?', bizDate, channel);
      if (exist) {
        if (exist.status === 1) throw Errors.badRequest('对账结果已锁定');
        db.run(
          `UPDATE reconciliations SET total_amount = ?, paid_amount = ?, refund_amount = ?, diff_amount = ?, diff_detail = ?
            WHERE id = ?`,
          channelTotal, s.paidAmount, s.refundAmount, diff, JSON.stringify(detail), exist.id,
        );
      } else {
        db.run(
          `INSERT INTO reconciliations (biz_date, channel, total_amount, paid_amount, refund_amount, diff_amount, diff_detail, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          bizDate, channel, channelTotal, s.paidAmount, s.refundAmount, diff, JSON.stringify(detail), now(),
        );
      }
      results.push(toReconApi(db.get('SELECT * FROM reconciliations WHERE biz_date = ? AND channel = ?', bizDate, channel)));
    }
  });

  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '财务-订单对账', action: '按日生成对账', targetType: 'reconciliation', targetId: bizDate,
    detail: { bizDate, channels, diff: results.map((r) => ({ channel: r.channel, diffAmount: r.diffAmount })) }, ip: ctx.ip,
  });
  return { bizDate, generated: results.length, reconciliations: results };
}

function lockReconciliation(ctx) {
  const id = Number(ctx.params.id);
  const row = db.get('SELECT * FROM reconciliations WHERE id = ?', id);
  if (!row) throw Errors.notFound('对账记录不存在');
  if (row.status === 1) throw Errors.badRequest('对账结果已锁定');
  db.run('UPDATE reconciliations SET status = 1, locked_by = ?, locked_at = ? WHERE id = ? AND status = 0',
    ctx.admin.id, now(), id);
  const fresh = db.get('SELECT * FROM reconciliations WHERE id = ?', id);
  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '财务-订单对账', action: '锁定对账结果', targetType: 'reconciliation', targetId: id,
    detail: { bizDate: fresh.biz_date, channel: fresh.channel, diffAmount: toYuan(fresh.diff_amount) }, ip: ctx.ip,
  });
  return toReconApi(fresh);
}

/* ------------------------------------------------------------------ *
 * API-135 支付流水
 * ------------------------------------------------------------------ */

function listPayments(ctx) {
  const { page, pageSize } = pagingOf(ctx);
  const q = ctx.query;
  const data = paymentSvc.listPayments({
    page, pageSize,
    channel: q.channel,
    status: q.status,
    keyword: q.keyword,
    dateFrom: q.dateFrom ? normDate(q.dateFrom, 'dateFrom') : undefined,
    dateTo: q.dateTo ? normDate(q.dateTo, 'dateTo') : undefined,
  });

  if (!isExport(ctx)) return { total: data.total, rows: data.rows, page, pageSize };

  sendCsv(ctx, `payments-${today()}.csv`,
    ['支付单号', '订单号', '支付渠道', '金额(元)', '状态', '用户', '手机号', '支付时间', '创建时间'],
    data.rows.map((r) => [
      r.payNo, r.orderNo, r.channelName, Number(r.amount || 0).toFixed(2),
      r.statusName, r.user?.username || '', r.user?.phoneMask || '', r.paidAt || '', r.createdAt,
    ]));
  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '财务-支付流水', action: '导出支付流水', targetType: 'payment', targetId: 'csv',
    detail: { total: data.total, channel: q.channel || '全部' }, ip: ctx.ip,
  });
  return undefined;
}

/* ------------------------------------------------------------------ *
 * API-136 / 137 退款单
 * ------------------------------------------------------------------ */

function listRefunds(ctx) {
  const { page, pageSize } = pagingOf(ctx);
  const q = ctx.query;
  const data = refundSvc.listAll({
    status: q.status,
    channel: q.channel,
    keyword: q.keyword,
    page,
    pageSize,
  });
  return { total: data.total, rows: data.rows, page, pageSize };
}

function auditRefund(ctx) {
  const id = Number(ctx.params.id);
  const body = ctx.body || {};
  const approve = body.approve === true || body.approve === 1 || String(body.approve) === '1' || String(body.approve) === 'true';
  const rejectReason = String(body.rejectReason || '').trim();
  if (!approve && !rejectReason) throw Errors.badRequest('驳回原因必填', { field: 'rejectReason' });

  const before = db.get('SELECT * FROM refund_orders WHERE id = ?', id);
  if (!before) throw Errors.notFound('退款单不存在');

  // 复用 refund-service.audit：内部完成退款执行、订单/售后状态回写，重复审核抛「退款单已退款，请勿重复操作」
  const result = refundSvc.audit(id, { approve, rejectReason: rejectReason || null, auditorId: ctx.admin.id });

  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '财务-退款管理', action: approve ? '退款审核通过' : '退款审核驳回',
    targetType: 'refund_order', targetId: id,
    detail: { refundNo: result.refundNo, orderNo: result.orderNo, amount: result.amount, rejectReason: rejectReason || null },
    ip: ctx.ip,
  });
  return result;
}

/* ------------------------------------------------------------------ *
 * API-138 结算单
 * ------------------------------------------------------------------ */

function createSettlements(ctx) {
  const body = ctx.body || {};
  const period = body.period ? String(body.period).trim() : undefined;
  if (period && !/^\d{4}-\d{2}$/.test(period)) throw Errors.badRequest('结算周期格式应为 YYYY-MM', { field: 'period' });
  const shopId = body.shopId !== undefined && body.shopId !== null && body.shopId !== ''
    ? v.int(body.shopId, 'shopId', { min: 1 }) : null;

  const result = settlementSvc.generate({ period, shopId, operatorId: ctx.admin.id });
  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '财务-商家结算', action: '生成结算单', targetType: 'settlement', targetId: period || now().slice(0, 7),
    detail: { period: period || now().slice(0, 7), shopId, generated: result.generated }, ip: ctx.ip,
  });
  return result;
}

function listSettlements(ctx) {
  const { page, pageSize } = pagingOf(ctx);
  const q = ctx.query;
  const data = settlementSvc.list({
    shopId: q.shopId ? Number(q.shopId) : null,
    period: q.period,
    status: q.status,
    page,
    pageSize,
  });
  return { total: data.total, rows: data.rows, page, pageSize };
}

function settlementItems(ctx) {
  const id = Number(ctx.params.id);
  const rows = settlementSvc.itemsOf(id);
  return { settlementId: id, total: rows.length, rows };
}

/* ------------------------------------------------------------------ *
 * API-139 提现
 * ------------------------------------------------------------------ */

function listWithdrawals(ctx) {
  const { page, pageSize } = pagingOf(ctx);
  const q = ctx.query;
  const data = settlementSvc.listWithdrawals({
    shopId: q.shopId ? Number(q.shopId) : null,
    status: q.status,
    page,
    pageSize,
  });
  return { total: data.total, rows: data.rows, page, pageSize };
}

function auditWithdrawal(ctx) {
  const id = Number(ctx.params.id);
  const body = ctx.body || {};
  const approve = body.approve === true || body.approve === 1 || String(body.approve) === '1' || String(body.approve) === 'true';
  const rejectReason = String(body.rejectReason || '').trim();
  if (!approve && !rejectReason) throw Errors.badRequest('驳回原因必填', { field: 'rejectReason' });

  // 复用 settlement-service.auditWithdrawal：通过时记录审计人、审计时间与打款时间
  const result = settlementSvc.auditWithdrawal(id, { approve, rejectReason: rejectReason || null, auditorId: ctx.admin.id });
  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '财务-商家结算', action: approve ? '提现审核通过（已打款）' : '提现审核驳回',
    targetType: 'withdrawal', targetId: id,
    detail: { withdrawalNo: result.withdrawalNo, shopId: result.shopId, amount: result.amount, paidAt: result.paidAt, rejectReason: rejectReason || null },
    ip: ctx.ip,
  });
  return result;
}

/* ------------------------------------------------------------------ *
 * API-140 财务报表
 * ------------------------------------------------------------------ */

const RANGE_SPAN = { day: 1, week: 7, month: 30 };

function resolveRange(query) {
  const range = ['day', 'week', 'month'].includes(String(query.range)) ? String(query.range) : (query.range ? 'day' : 'month');
  const span = RANGE_SPAN[range] || 30;
  const from = query.dateFrom ? normDate(query.dateFrom, 'dateFrom') : today(-(span - 1));
  const to = query.dateTo ? normDate(query.dateTo, 'dateTo') : today();
  if (from > to) throw Errors.badRequest('开始日期不能晚于结束日期');
  return { range, from, to };
}

function weekBucket(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // 周一为一周起点
  const start = new Date(d.getTime() - offset * 86400000);
  const end = new Date(start.getTime() + 6 * 86400000);
  return `${start.toISOString().slice(0, 10)}~${end.toISOString().slice(0, 10)}`;
}

function bucketOf(dateStr, range) {
  if (range === 'month') return dateStr.slice(0, 7);
  if (range === 'week') return weekBucket(dateStr);
  return dateStr;
}

function financeReport(ctx) {
  const { range, from, to } = resolveRange(ctx.query);
  const rate = config.getNumber('commission_rate');

  const paidRows = db.all(
    `SELECT substr(p.paid_at, 1, 10) AS d, o.shop_id AS shop_id,
            SUM(p.amount) AS deal_amount, COUNT(DISTINCT o.id) AS order_count
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.status IN (1, 3) AND p.paid_at IS NOT NULL AND substr(p.paid_at, 1, 10) BETWEEN ? AND ?
      GROUP BY d, o.shop_id`,
    from, to,
  );
  const refundRows = db.all(
    `SELECT substr(refunded_at, 1, 10) AS d, shop_id,
            SUM(amount) AS refund_amount, COUNT(*) AS refund_count
       FROM refund_orders
      WHERE status = 2 AND refunded_at IS NOT NULL AND substr(refunded_at, 1, 10) BETWEEN ? AND ?
      GROUP BY d, shop_id`,
    from, to,
  );

  const shopName = new Map(db.all('SELECT id, name FROM shops').map((r) => [r.id, r.name]));
  const buckets = new Map();
  const touch = (key, shopId) => {
    if (!buckets.has(key)) buckets.set(key, new Map());
    const m = buckets.get(key);
    if (!m.has(shopId)) m.set(shopId, { dealAmount: 0, orderCount: 0, refundAmount: 0, refundCount: 0 });
    return m.get(shopId);
  };

  for (const r of paidRows) {
    const cell = touch(bucketOf(r.d, range), r.shop_id);
    cell.dealAmount += r.deal_amount;
    cell.orderCount += r.order_count;
  }
  for (const r of refundRows) {
    const cell = touch(bucketOf(r.d, range), r.shop_id);
    cell.refundAmount += r.refund_amount;
    cell.refundCount += r.refund_count;
  }

  const totals = { dealAmount: 0, orderCount: 0, refundAmount: 0, refundCount: 0, commission: 0, netAmount: 0 };
  const rows = [];
  for (const [bucket, m] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    for (const [shopId, c] of [...m.entries()].sort((a, b) => b[1].dealAmount - a[1].dealAmount)) {
      const net = c.dealAmount - c.refundAmount;
      const commission = Math.max(0, Math.round(net * rate));
      rows.push({
        period: bucket,
        shopId,
        shopName: shopName.get(shopId) || '',
        dealAmount: toYuan(c.dealAmount),
        orderCount: c.orderCount,
        refundAmount: toYuan(c.refundAmount),
        refundCount: c.refundCount,
        netAmount: toYuan(net),
        commission: toYuan(commission),
      });
      totals.dealAmount += c.dealAmount;
      totals.orderCount += c.orderCount;
      totals.refundAmount += c.refundAmount;
      totals.refundCount += c.refundCount;
    }
  }
  totals.netAmount = toYuan(totals.dealAmount - totals.refundAmount);
  totals.commission = toYuan(Math.max(0, Math.round((totals.dealAmount - totals.refundAmount) * rate)));
  totals.dealAmount = toYuan(totals.dealAmount);
  totals.refundAmount = toYuan(totals.refundAmount);

  const caliber = {
    range,
    dateFrom: from,
    dateTo: to,
    commissionRate: rate,
    dealAmount: '成交额：payments 状态为支付成功（含已全额退款前已支付）的实付金额之和，与订单对账口径一致',
    orderCount: '订单量：统计期内产生成功支付流水的订单去重数',
    refundAmount: '退款额：统计期内退款成功的退款单金额之和（refund_orders.status=2）',
    commission: `佣金收入：(成交额 − 退款额) × 佣金费率 ${(rate * 100).toFixed(2)}%，四舍五入到分`,
    dimension: '店铺维度明细；报表按周期与店铺两个维度汇总',
  };

  if (isExport(ctx)) {
    sendCsv(ctx, `finance-report-${from}_${to}.csv`,
      ['周期', '店铺ID', '店铺名称', '成交额(元)', '订单量', '退款额(元)', '退款单数', '净成交额(元)', '佣金收入(元)'],
      rows.map((r) => [r.period, r.shopId, r.shopName, r.dealAmount.toFixed(2), r.orderCount,
        r.refundAmount.toFixed(2), r.refundCount, r.netAmount.toFixed(2), r.commission.toFixed(2)]));
    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '财务-财务报表', action: '导出财务报表', targetType: 'finance_report', targetId: `${from}~${to}`,
      detail: { range, from, to, rows: rows.length }, ip: ctx.ip,
    });
    return undefined;
  }

  return { range, dateFrom: from, dateTo: to, total: rows.length, rows, totals, caliber };
}

/* ------------------------------------------------------------------ *
 * 路由注册
 * ------------------------------------------------------------------ */

module.exports = function register(api) {
  /* 说明：settlements / settlement_items / withdrawals 由 schema.sqlite.sql 统一建表（启动时 ensureSchema）。 */

  /* ---------- API-134 订单对账 ---------- */
  api.get('/api/admin/reconciliations', { auth: 'admin', perm: 'menu.fin.reconcile' }, listReconciliations);
  api.post('/api/admin/reconciliations/sync', { auth: 'admin', perm: 'menu.fin.reconcile' }, syncReconciliations);
  api.post('/api/admin/reconciliations/:id/lock', { auth: 'admin', perm: 'menu.fin.reconcile' }, lockReconciliation);

  /* ---------- API-135 支付流水 ---------- */
  api.get('/api/admin/payments', { auth: 'admin', perm: 'menu.fin.payment' }, listPayments);

  /* ---------- API-136 / 137 退款管理 ---------- */
  api.get('/api/admin/refunds', { auth: 'admin', perm: 'menu.fin.refund' }, listRefunds);
  api.post('/api/admin/refunds/:id/audit', { auth: 'admin', perm: 'action.refund.audit' }, auditRefund);

  /* ---------- API-138 商家结算 ---------- */
  api.get('/api/admin/settlements', { auth: 'admin', perm: 'menu.fin.settlement' }, listSettlements);
  api.post('/api/admin/settlements', { auth: 'admin', perm: 'action.settlement.generate' }, createSettlements);
  api.get('/api/admin/settlements/:id/items', { auth: 'admin', perm: 'menu.fin.settlement' }, settlementItems);

  /* ---------- API-139 提现审核 ---------- */
  api.get('/api/admin/withdrawals', { auth: 'admin', perm: 'menu.fin.settlement' }, listWithdrawals);
  api.post('/api/admin/withdrawals/:id/audit', { auth: 'admin', perm: 'action.withdrawal.audit' }, auditWithdrawal);

  /* ---------- API-140 财务报表 ---------- */
  api.get('/api/admin/reports/finance', { auth: 'admin', perm: ['menu.fin.reconcile', 'menu.fin.settlement'] }, financeReport);
};
