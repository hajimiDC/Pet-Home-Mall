'use strict';

const { get, all, run, bizNo, parseJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, addDays, addMinutes, parseTime } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const config = require('../core/config');
const db = require('../core/db');
const stock = require('./stock-service');
const orderSvc = require('./order-service');
const refundSvc = require('./refund-service');

/**
 * 售后服务（FR-SLR-060 ~ 066、BR-SLR-018/019/020、Q-013、9.4.3.2）
 * 状态机：1 待处理 → (同意·仅退款) 2 已同意 → 退款单待财务审核 → 5 已完成
 *                  → (同意·退货退款) 3 待买家寄回 → 4 已收货待退款 → 退款单 → 5
 *                  → (驳回) 6 已驳回（须填原因）→ (客服介入) 7
 */

const STATUS = { 1: '待处理', 2: '商家同意', 3: '待买家寄回', 4: '已收货待退款', 5: '已完成', 6: '已驳回', 7: '客服介入中' };
const CLOSED = [5, 6];

function toApi(a, { withOrder = false } = {}) {
  const item = get('SELECT * FROM order_items WHERE id = ?', a.order_item_id);
  const order = get('SELECT * FROM orders WHERE id = ?', a.order_id);
  const user = get('SELECT id, username, nickname, phone FROM users WHERE id = ?', a.user_id);
  const refund = get('SELECT * FROM refund_orders WHERE aftersale_id = ? ORDER BY id DESC LIMIT 1', a.id);
  const base = {
    id: a.id,
    aftersaleNo: a.aftersale_no,
    orderId: a.order_id,
    orderNo: order?.order_no,
    orderItemId: a.order_item_id,
    shopId: a.shop_id,
    type: a.type,
    typeName: a.type === 2 ? '退货退款' : '仅退款',
    refundAmount: toYuan(a.refund_amount),
    reason: a.reason,
    evidence: parseJson(a.evidence, []),
    status: a.status,
    statusName: STATUS[a.status],
    rejectReason: a.reject_reason,
    returnLogistics: parseJson(a.return_logistics, null),
    respondDeadline: a.respond_deadline,
    handledAt: a.handled_at,
    createdAt: a.created_at,
    product: item ? {
      productId: item.product_id, productName: item.product_name, specName: item.spec_name,
      image: item.image, price: toYuan(item.price), quantity: item.quantity, subtotal: toYuan(item.subtotal),
    } : null,
    refund: refund ? { refundNo: refund.refund_no, amount: toYuan(refund.amount), status: refund.status, statusName: refundSvc.STATUS[refund.status] } : null,
    buyer: user ? { nickname: user.nickname || user.username, phoneMask: maskPhone(user.phone) } : null,
  };
  if (withOrder && order) base.order = orderSvc.toApi(order);
  return base;
}

/** 用户发起售后（补充接口 API-158；BR-SLR-018 / 020） */
function create(userId, payload = {}) {
  const orderItemId = Number(payload.orderItemId);
  const item = get('SELECT * FROM order_items WHERE id = ?', orderItemId);
  if (!item) throw Errors.notFound('订单明细不存在');
  const order = get('SELECT * FROM orders WHERE id = ? AND user_id = ?', item.order_id, userId);
  if (!order) throw Errors.notFound('订单不存在');
  if (![1, 2, 3].includes(order.status)) throw Errors.badRequest('当前订单状态不支持售后');
  const days = config.getNumber('aftersale_days');
  if (order.status === 3 && order.finished_at && parseTime(order.finished_at) < new Date(Date.now() - days * 86400000)) {
    throw Errors.badRequest(`售后有效期为交易完成后 ${days} 天，该订单已超出有效期`);
  }
  const running = get('SELECT * FROM aftersales WHERE order_item_id = ? AND status NOT IN (5, 6)', orderItemId);
  if (running) throw Errors.badRequest('该订单明细已有未关闭的售后单，不允许重复发起');
  const type = Number(payload.type) === 2 ? 2 : 1;
  const amount = payload.amount ? require('../core/money').toCents(payload.amount) : item.subtotal;
  if (!Number.isInteger(amount) || amount <= 0) throw Errors.badRequest('退款金额不合法', { field: 'amount' });
  if (amount > item.subtotal) throw Errors.badRequest('退款金额不得超过该明细实付金额');
  const totalRefund = get("SELECT COALESCE(SUM(amount),0) AS s FROM refund_orders WHERE order_id = ? AND status IN (1,2)", order.id).s;
  if (totalRefund + amount > order.pay_amount) throw Errors.badRequest('退款金额不得超过订单实付金额');
  if (!payload.reason) throw Errors.badRequest('请填写申请原因', { field: 'reason' });
  const id = db.transaction(() => {
    const res = run(`INSERT INTO aftersales (aftersale_no, order_id, order_item_id, user_id, shop_id, type, refund_amount,
        reason, evidence, status, respond_deadline, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      bizNo('AS'), order.id, orderItemId, userId, order.shop_id, type, amount, String(payload.reason).slice(0, 200),
      JSON.stringify(payload.evidence || []), addMinutes(config.getNumber('aftersale_respond_hours') * 60), now(), now()).lastInsertRowid;
    run('UPDATE order_items SET aftersale_id = ? WHERE id = ?', res, orderItemId);
    return res;
  });
  return toApi(get('SELECT * FROM aftersales WHERE id = ?', id));
}

function listMine(userId, { status, page = 1, pageSize = 20 } = {}) {
  const params = [userId];
  let where = 'WHERE a.user_id = ?';
  if (status) { where += ' AND a.status = ?'; params.push(Number(status)); }
  const total = get(`SELECT COUNT(*) AS c FROM aftersales a ${where}`, ...params).c;
  const rows = all(`SELECT a.* FROM aftersales a ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
  return { total, rows: rows.map((a) => toApi(a)) };
}

function detail(userId, id, { sellerShopId = null, admin = false } = {}) {
  const a = get('SELECT * FROM aftersales WHERE id = ?', Number(id));
  if (!a) throw Errors.notFound('售后单不存在');
  if (sellerShopId && a.shop_id !== sellerShopId) throw Errors.notFound('售后单不存在');
  if (!sellerShopId && !admin && a.user_id !== userId) throw Errors.notFound('售后单不存在');
  return toApi(a, { withOrder: true });
}

/** 商家处理（API-077）：同意 / 驳回 / 修改退款金额 */
function handleSeller(shopId, id, payload = {}, operator = {}) {
  const a = get('SELECT * FROM aftersales WHERE id = ? AND shop_id = ?', Number(id), shopId);
  if (!a) throw Errors.notFound('售后单不存在');
  if (CLOSED.includes(a.status) || a.status === 2 || a.status === 4) throw Errors.badRequest('售后单已被处理');
  const action = payload.action;
  if (action === 'reject') {
    if (!payload.rejectReason || !String(payload.rejectReason).trim()) throw Errors.badRequest('驳回原因必填', { field: 'rejectReason' });
    run('UPDATE aftersales SET status = 6, reject_reason = ?, handled_by = ?, handled_at = ?, updated_at = ? WHERE id = ?',
      String(payload.rejectReason).slice(0, 200), operator.id || null, now(), now(), a.id);
    return toApi(get('SELECT * FROM aftersales WHERE id = ?', a.id));
  }
  if (action !== 'approve') throw Errors.badRequest('处理动作不合法');
  let amount = a.refund_amount;
  if (payload.refundAmount !== undefined) {
    amount = require('../core/money').toCents(payload.refundAmount);
    if (!Number.isInteger(amount) || amount <= 0) throw Errors.badRequest('退款金额不合法');
    const item = get('SELECT * FROM order_items WHERE id = ?', a.order_item_id);
    if (amount > item.subtotal) throw Errors.badRequest('退款金额不得超过该明细实付金额');
  }
  const order = get('SELECT * FROM orders WHERE id = ?', a.order_id);
  db.transaction(() => {
    if (a.type === 2) {
      run('UPDATE aftersales SET status = 3, refund_amount = ?, handled_by = ?, handled_at = ?, updated_at = ? WHERE id = ?',
        amount, operator.id || null, now(), now(), a.id);
    } else {
      run('UPDATE aftersales SET status = 2, refund_amount = ?, handled_by = ?, handled_at = ?, updated_at = ? WHERE id = ?',
        amount, operator.id || null, now(), now(), a.id);
      refundSvc.createForAftersale(a.id, { order, amount, operatorId: operator.id || null });
    }
  });
  return toApi(get('SELECT * FROM aftersales WHERE id = ?', a.id));
}

/** 买家寄回（补充接口 API-160） */
function buyerReturn(userId, id, payload = {}) {
  const a = get('SELECT * FROM aftersales WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!a) throw Errors.notFound('售后单不存在');
  if (a.status !== 3) throw Errors.badRequest('当前状态不可填写寄回单号');
  if (!payload.trackingNo) throw Errors.badRequest('请填写物流单号', { field: 'trackingNo' });
  run('UPDATE aftersales SET return_logistics = ?, updated_at = ? WHERE id = ?',
    JSON.stringify({ company: payload.company || '', trackingNo: payload.trackingNo }), now(), a.id);
  return toApi(get('SELECT * FROM aftersales WHERE id = ?', a.id));
}

/** 商家确认收货 → 发起退款（待财务审核） */
function confirmReturn(shopId, id, operator = {}) {
  const a = get('SELECT * FROM aftersales WHERE id = ? AND shop_id = ?', Number(id), shopId);
  if (!a) throw Errors.notFound('售后单不存在');
  if (a.status !== 3) throw Errors.badRequest('当前状态不可确认收货');
  const order = get('SELECT * FROM orders WHERE id = ?', a.order_id);
  db.transaction(() => {
    run('UPDATE aftersales SET status = 4, updated_at = ? WHERE id = ?', now(), a.id);
    refundSvc.createForAftersale(a.id, { order, amount: a.refund_amount, operatorId: operator.id || null });
  });
  return toApi(get('SELECT * FROM aftersales WHERE id = ?', a.id));
}

/** 客服介入（API-132） */
function intervene(id, payload = {}, operator = {}) {
  const a = get('SELECT * FROM aftersales WHERE id = ?', Number(id));
  if (!a) throw Errors.notFound('售后单不存在');
  if (CLOSED.includes(a.status)) throw Errors.badRequest('售后单已完成，无法介入');
  const conclusion = payload.conclusion || payload.action;
  if (conclusion === 'reject') {
    if (!payload.rejectReason) throw Errors.badRequest('驳回原因必填', { field: 'rejectReason' });
    run('UPDATE aftersales SET status = 6, reject_reason = ?, handled_by = ?, handled_at = ?, updated_at = ? WHERE id = ?',
      payload.rejectReason, operator.id || null, now(), now(), a.id);
  } else {
    const order = get('SELECT * FROM orders WHERE id = ?', a.order_id);
    db.transaction(() => {
      run('UPDATE aftersales SET status = 2, handled_by = ?, handled_at = ?, updated_at = ? WHERE id = ?',
        operator.id || null, now(), now(), a.id);
      refundSvc.createForAftersale(a.id, { order, amount: a.refund_amount, operatorId: operator.id || null });
    });
  }
  return toApi(get('SELECT * FROM aftersales WHERE id = ?', a.id));
}

/** 售后完成后回写（由退款服务调用） */
function markCompleted(aftersaleId) {
  const a = get('SELECT * FROM aftersales WHERE id = ?', aftersaleId);
  if (!a) return;
  db.transaction(() => {
    run('UPDATE aftersales SET status = 5, updated_at = ? WHERE id = ?', now(), a.id);
    if (a.type === 2) {
      const item = get('SELECT * FROM order_items WHERE id = ?', a.order_item_id);
      const order = get('SELECT * FROM orders WHERE id = ?', a.order_id);
      stock.changeStock(item.sku_id, item.quantity, {
        source: '退货入库', refNo: order.order_no, remark: `售后退货入库（${a.aftersale_no}）`,
      });
    }
  });
}

/** 商家售后列表 */
function listForSeller(shopId, { status, keyword, page = 1, pageSize = 20 } = {}) {
  const params = [shopId];
  let where = 'WHERE a.shop_id = ?';
  if (status) { where += ' AND a.status = ?'; params.push(Number(status)); }
  if (keyword) { where += ' AND (a.aftersale_no LIKE ? OR o.order_no LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  const total = get(`SELECT COUNT(*) AS c FROM aftersales a JOIN orders o ON o.id = a.order_id ${where}`, ...params).c;
  const rows = all(`SELECT a.* FROM aftersales a JOIN orders o ON o.id = a.order_id ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize);
  return { total, rows: rows.map((a) => toApi(a)) };
}

function listAll({ status, keyword, page = 1, pageSize = 20 } = {}) {
  const params = [];
  let where = 'WHERE 1 = 1';
  if (status) { where += ' AND a.status = ?'; params.push(Number(status)); }
  if (keyword) { where += ' AND (a.aftersale_no LIKE ? OR o.order_no LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  const total = get(`SELECT COUNT(*) AS c FROM aftersales a JOIN orders o ON o.id = a.order_id ${where}`, ...params).c;
  const rows = all(`SELECT a.* FROM aftersales a JOIN orders o ON o.id = a.order_id ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize);
  return { total, rows: rows.map((a) => toApi(a)) };
}

module.exports = {
  STATUS, create, listMine, detail, handleSeller, buyerReturn, confirmReturn, intervene, markCompleted,
  listForSeller, listAll, toApi,
};
