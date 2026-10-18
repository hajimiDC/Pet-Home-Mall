'use strict';

const crypto = require('node:crypto');
const { get, run, bizNo } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, parseTime } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const config = require('../core/config');
const db = require('../core/db');
const orderSvc = require('./order-service');

/**
 * 支付服务（8.18、NFR-SEC-004、NFR-CONS-002、NFR-AVAIL-003）
 * - 渠道仅支付宝 / 微信支付（Q-005）
 * - 支付沙箱：pay_no 唯一，回调必须验签（HMAC-SHA256），重复回调只产生一次业务效果
 * - 金额与订单号以服务端数据为准，不信任前端传值
 */

const CHANNELS = {
  alipay: '支付宝',
  wechat: '微信支付',
};

function channelName(code) { return CHANNELS[code] || code; }

function signPayload({ payNo, status, amount, timestamp }) {
  const secret = config.getString('payment_notify_secret');
  return crypto.createHmac('sha256', secret).update(`${payNo}|${status}|${amount}|${timestamp}`).digest('hex');
}

/** 发起支付（API-042） */
function createPayment(userId, { orderId, channel }) {
  const order = get('SELECT * FROM orders WHERE id = ? AND user_id = ?', Number(orderId), userId);
  if (!order) throw Errors.notFound('订单不存在');
  if (!CHANNELS[channel]) throw Errors.badRequest('请选择支付方式', { field: 'channel' });
  if (order.status === 5) throw Errors.badRequest('订单已退款');
  if (order.status !== 0) throw Errors.badRequest('订单已支付');
  if (parseTime(order.expire_at) <= new Date()) {
    orderSvc.closeExpiredOrders();
    throw Errors.badRequest('订单已超时，请重新下单');
  }
  const pending = get("SELECT * FROM payments WHERE order_id = ? AND status = 0 AND channel = ? ORDER BY id DESC LIMIT 1", order.id, channel);
  if (pending) {
    return {
      payNo: pending.pay_no, orderId: order.id, orderNo: order.order_no,
      channel: pending.channel, channelName: channelName(pending.channel),
      amount: toYuan(pending.amount), status: pending.status, statusName: '待支付',
      expireAt: order.expire_at, remainSeconds: Math.max(0, Math.floor((parseTime(order.expire_at) - Date.now()) / 1000)),
      payUrl: `sandbox://${pending.channel}/${pending.pay_no}`,
    };
  }
  const payNo = bizNo('PAY');
  run(`INSERT INTO payments (order_id, pay_no, channel, amount, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`, order.id, payNo, channel, order.pay_amount, now(), now());
  return {
    payNo, orderId: order.id, orderNo: order.order_no, channel, channelName: channelName(channel),
    amount: toYuan(order.pay_amount), status: 0, statusName: '待支付',
    expireAt: order.expire_at,
    remainSeconds: Math.max(0, Math.floor((parseTime(order.expire_at) - Date.now()) / 1000)),
    payUrl: `sandbox://${channel}/${payNo}`,
    signRule: 'sign = HMAC-SHA256(payment_notify_secret, `${payNo}|${status}|${amount}|${timestamp}`)',
  };
}

/** 查询支付状态（API-043） */
function queryPayment(userId, payNo) {
  const pay = get('SELECT * FROM payments WHERE pay_no = ?', payNo);
  if (!pay) throw Errors.notFound('支付单不存在');
  const order = get('SELECT * FROM orders WHERE id = ?', pay.order_id);
  if (!order || order.user_id !== userId) throw Errors.notFound('支付单不存在');
  return {
    payNo: pay.pay_no, orderId: pay.order_id, orderNo: order.order_no,
    channel: pay.channel, channelName: channelName(pay.channel),
    amount: toYuan(pay.amount), status: pay.status,
    statusName: ['待支付', '支付成功', '支付失败', '已退款'][pay.status],
    paidAt: pay.paid_at, createdAt: pay.created_at,
    orderStatus: order.status, orderStatusName: orderSvc.STATUS[order.status],
  };
}

/**
 * 支付结果回调（API-044）
 * 验签 → 幂等 → 更新支付单 → 推进订单状态（扣库存）
 */
function handleNotify(payload = {}) {
  const { payNo, status, amount, timestamp, sign } = payload;
  if (!payNo || status === undefined || amount === undefined || !timestamp || !sign) {
    throw Errors.badRequest('回调参数不完整');
  }
  const expect = signPayload({ payNo, status, amount, timestamp });
  if (String(sign).toLowerCase() !== expect.toLowerCase()) throw Errors.forbidden('回调验签失败');
  const pay = get('SELECT * FROM payments WHERE pay_no = ?', payNo);
  if (!pay) throw Errors.notFound('支付单不存在');
  const order = get('SELECT * FROM orders WHERE id = ?', pay.order_id);
  const cents = require('../core/money').toCents(amount);
  if (cents !== pay.amount) throw Errors.badRequest('回调金额与支付单不一致');
  if (pay.status === 1) return { payNo, duplicated: true, orderStatus: order.status };

  if (Number(status) === 1) {
    db.transaction(() => {
      const updated = run("UPDATE payments SET status = 1, paid_at = ?, channel_no = ?, notify_payload = ?, updated_at = ? WHERE id = ? AND status = 0",
        now(), `SANDBOX-${payNo}`, JSON.stringify(payload), now(), pay.id);
      if (updated.changes === 0) return;
      orderSvc.markPaid(order, { channel: pay.channel });
    });
  } else {
    run('UPDATE payments SET status = 2, notify_payload = ?, updated_at = ? WHERE id = ?', JSON.stringify(payload), now(), pay.id);
  }
  const freshOrder = get('SELECT * FROM orders WHERE id = ?', order.id);
  return {
    payNo, duplicated: false, status: Number(status),
    orderStatus: freshOrder.status, orderStatusName: orderSvc.STATUS[freshOrder.status],
  };
}

/** 沙箱模拟支付成功（补充接口 API-165：便于前端联调与演示，等价于渠道回调） */
function sandboxPay(userId, payNo, channel) {
  const pay = get('SELECT * FROM payments WHERE pay_no = ?', payNo);
  if (!pay) throw Errors.notFound('支付单不存在');
  const order = get('SELECT * FROM orders WHERE id = ?', pay.order_id);
  if (!order || order.user_id !== userId) throw Errors.notFound('支付单不存在');
  if (channel && channel !== pay.channel) throw Errors.badRequest('支付渠道与支付单不一致');
  const timestamp = Date.now();
  const amount = (pay.amount / 100).toFixed(2);
  const sign = signPayload({ payNo, status: 1, amount, timestamp });
  const result = handleNotify({ payNo, status: 1, amount, timestamp, sign });
  return { ...result, amount: toYuan(pay.amount), paidAt: now() };
}

function listPayments({ page = 1, pageSize = 20, channel, status, keyword, dateFrom, dateTo } = {}) {
  const params = [];
  let where = 'WHERE 1 = 1';
  if (channel) { where += ' AND p.channel = ?'; params.push(channel); }
  if (status !== undefined && status !== '') { where += ' AND p.status = ?'; params.push(Number(status)); }
  if (keyword) { where += ' AND (p.pay_no LIKE ? OR o.order_no LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  if (dateFrom) { where += ' AND p.created_at >= ?'; params.push(`${dateFrom} 00:00:00`); }
  if (dateTo) { where += ' AND p.created_at <= ?'; params.push(`${dateTo} 23:59:59`); }
  const total = get(`SELECT COUNT(*) AS c FROM payments p JOIN orders o ON o.id = p.order_id ${where}`, ...params).c;
  const rows = db.all(
    `SELECT p.*, o.order_no, o.user_id, u.username, u.phone FROM payments p
       JOIN orders o ON o.id = p.order_id JOIN users u ON u.id = o.user_id
       ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize,
  );
  return {
    total,
    rows: rows.map((r) => ({
      payNo: r.pay_no, orderId: r.order_id, orderNo: r.order_no, channel: r.channel,
      channelName: channelName(r.channel), amount: toYuan(r.amount), status: r.status,
      statusName: ['待支付', '支付成功', '支付失败', '已退款'][r.status],
      user: { username: r.username, phoneMask: maskPhone(r.phone) },
      paidAt: r.paid_at, createdAt: r.created_at,
    })),
  };
}

module.exports = { createPayment, queryPayment, handleNotify, sandboxPay, listPayments, signPayload, CHANNELS, channelName };
