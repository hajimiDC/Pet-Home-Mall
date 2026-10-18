'use strict';

const { get, all, run, bizNo, parseJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const db = require('../core/db');
const stock = require('./stock-service');

/**
 * 退款服务（FR-FIN-007 ~ 010、FR-SLR-065、BR-SLR-019、NFR-CONS-002）
 * - 退款单幂等：同一退款单只产生一次退款（状态机 0 待审核 → 1 退款中 → 2 已退款）
 * - 退款金额 ≤ 订单实付；部分退款按订单明细行计算
 * - 退款结果回写订单与售后单状态；退货退款回滚库存（stock_log 记录「退货入库」）
 */

const STATUS = { 0: '待审核', 1: '退款中', 2: '已退款', 3: '已驳回' };

function toApi(r) {
  const order = get('SELECT * FROM orders WHERE id = ?', r.order_id);
  const aftersale = r.aftersale_id ? get('SELECT * FROM aftersales WHERE id = ?', r.aftersale_id) : null;
  const shop = get('SELECT id, name FROM shops WHERE id = ?', r.shop_id);
  return {
    id: r.id,
    refundNo: r.refund_no,
    aftersaleId: r.aftersale_id,
    aftersaleNo: aftersale?.aftersale_no || null,
    orderId: r.order_id,
    orderNo: order?.order_no,
    shopId: r.shop_id,
    shopName: shop?.name,
    channel: r.channel,
    channelName: r.channel === 'wechat' ? '微信支付' : '支付宝',
    amount: toYuan(r.amount),
    status: r.status,
    statusName: STATUS[r.status],
    rejectReason: r.reject_reason,
    auditedAt: r.audited_at,
    refundedAt: r.refunded_at,
    retryCount: r.retry_count,
    createdAt: r.created_at,
  };
}

function createForAftersale(aftersaleId, { order, amount, operatorId = null }) {
  const exist = get('SELECT * FROM refund_orders WHERE aftersale_id = ?', aftersaleId);
  if (exist) return exist; // 幂等：同一售后单只生成一张退款单
  const pay = get('SELECT * FROM payments WHERE order_id = ? AND status = 1 ORDER BY id DESC LIMIT 1', order.id);
  const id = run(`INSERT INTO refund_orders (refund_no, aftersale_id, order_id, shop_id, channel, amount, status, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    bizNo('RF'), aftersaleId, order.id, order.shop_id, pay?.channel || order.pay_channel || 'alipay',
    amount, `AS-${aftersaleId}`, now(), now()).lastInsertRowid;
  return get('SELECT * FROM refund_orders WHERE id = ?', id);
}

/** 未成团全额退款（BR-GRP-003）：直接生成待审核退款单 */
function createUnformedRefund(order, amount) {
  const exist = get('SELECT * FROM refund_orders WHERE order_id = ? AND aftersale_id IS NULL', order.id);
  if (exist) return exist;
  const pay = get('SELECT * FROM payments WHERE order_id = ? AND status = 1 ORDER BY id DESC LIMIT 1', order.id);
  const id = run(`INSERT INTO refund_orders (refund_no, aftersale_id, order_id, shop_id, channel, amount, status, idempotency_key, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?, ?, 0, ?, ?, ?)`,
    bizNo('RF'), order.id, order.shop_id, pay?.channel || order.pay_channel || 'alipay',
    amount, `GRP-${order.id}`, now(), now()).lastInsertRowid;
  return get('SELECT * FROM refund_orders WHERE id = ?', id);
}

/** 财务审核（API-137）：通过后调用渠道退款（沙箱内同步完成） */
function audit(id, { approve, rejectReason, auditorId = null } = {}) {
  const refund = get('SELECT * FROM refund_orders WHERE id = ?', Number(id));
  if (!refund) throw Errors.notFound('退款单不存在');
  if (refund.status === 2) throw Errors.badRequest('退款单已退款，请勿重复操作');
  if (refund.status === 3) throw Errors.badRequest('退款单已驳回');
  if (refund.status !== 0) throw Errors.badRequest('退款单当前状态不可审核');
  if (!approve) {
    if (!rejectReason) throw Errors.badRequest('驳回原因必填', { field: 'rejectReason' });
    run('UPDATE refund_orders SET status = 3, reject_reason = ?, auditor_id = ?, audited_at = ?, updated_at = ? WHERE id = ?',
      rejectReason, auditorId, now(), now(), refund.id);
    const aftersale = refund.aftersale_id ? get('SELECT * FROM aftersales WHERE id = ?', refund.aftersale_id) : null;
    if (aftersale) run('UPDATE aftersales SET status = 6, reject_reason = ?, updated_at = ? WHERE id = ?', rejectReason, now(), aftersale.id);
    return toApi(get('SELECT * FROM refund_orders WHERE id = ?', refund.id));
  }
  run('UPDATE refund_orders SET status = 1, auditor_id = ?, audited_at = ?, updated_at = ? WHERE id = ? AND status = 0',
    auditorId, now(), now(), refund.id);
  execute(refund.id);
  return toApi(get('SELECT * FROM refund_orders WHERE id = ?', refund.id));
}

/** 执行退款（幂等） */
function execute(id) {
  const refund = get('SELECT * FROM refund_orders WHERE id = ?', Number(id));
  if (!refund) throw Errors.notFound('退款单不存在');
  if (refund.status === 2) return { refunded: false, duplicated: true };
  if (refund.status !== 1) throw Errors.badRequest('退款单当前状态不可执行退款');
  return db.transaction(() => {
    const res = run("UPDATE refund_orders SET status = 2, refunded_at = ?, updated_at = ? WHERE id = ? AND status = 1",
      now(), now(), refund.id);
    if (res.changes === 0) return { refunded: false, duplicated: true };
    const order = get('SELECT * FROM orders WHERE id = ?', refund.order_id);
    const refundedTotal = get('SELECT COALESCE(SUM(amount),0) AS s FROM refund_orders WHERE order_id = ? AND status = 2', order.id).s;
    if (refundedTotal >= order.pay_amount) {
      run('UPDATE orders SET status = 5, updated_at = ? WHERE id = ?', now(), order.id);
      run("UPDATE payments SET status = 3, updated_at = ? WHERE order_id = ? AND status = 1", now(), order.id);
    }
    if (refund.aftersale_id) {
      const aftersale = get('SELECT * FROM aftersales WHERE id = ?', refund.aftersale_id);
      run('UPDATE aftersales SET status = 5, updated_at = ? WHERE id = ?', now(), aftersale.id);
      if (aftersale.type === 2) {
        const item = get('SELECT * FROM order_items WHERE id = ?', aftersale.order_item_id);
        stock.changeStock(item.sku_id, item.quantity, { source: '退货入库', refNo: order.order_no, remark: `售后退货入库（${aftersale.aftersale_no}）` });
      }
    } else if (order.group_team_id) {
      run('UPDATE group_members SET status = 3 WHERE order_id = ?', order.id);
      const item = get('SELECT * FROM order_items WHERE order_id = ? LIMIT 1', order.id);
      if (item) stock.changeStock(item.sku_id, item.quantity, { source: '退货入库', refNo: order.order_no, remark: '拼团未成团库存回滚' });
    }
    return { refunded: true, refundNo: refund.refund_no };
  });
}

function listAll({ status, channel, keyword, page = 1, pageSize = 20 } = {}) {
  const params = [];
  let where = 'WHERE 1 = 1';
  if (status !== undefined && status !== '') { where += ' AND r.status = ?'; params.push(Number(status)); }
  if (channel) { where += ' AND r.channel = ?'; params.push(channel); }
  if (keyword) { where += ' AND (r.refund_no LIKE ? OR o.order_no LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  const total = get(`SELECT COUNT(*) AS c FROM refund_orders r JOIN orders o ON o.id = r.order_id ${where}`, ...params).c;
  const rows = all(`SELECT r.* FROM refund_orders r JOIN orders o ON o.id = r.order_id ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize);
  return { total, rows: rows.map(toApi) };
}

function listForShop(shopId, { status, page = 1, pageSize = 20 } = {}) {
  const params = [shopId];
  let where = 'WHERE r.shop_id = ?';
  if (status !== undefined && status !== '') { where += ' AND r.status = ?'; params.push(Number(status)); }
  const total = get(`SELECT COUNT(*) AS c FROM refund_orders r ${where}`, ...params).c;
  const rows = all(`SELECT r.* FROM refund_orders r ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
  return { total, rows: rows.map(toApi) };
}

module.exports = { STATUS, createForAftersale, createUnformedRefund, audit, execute, listAll, listForShop, toApi };
