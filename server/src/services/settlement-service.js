'use strict';

const { get, all, run, bizNo } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, parseTime } = require('../core/money');
const { maskAccount } = require('../core/crypto');
const config = require('../core/config');
const db = require('../core/db');

/**
 * 结算与提现（FR-FIN-011 ~ 014、FR-SLR-090 ~ 095、BR-SLR-026/027/028、Q-016）
 * 结算口径：确认收货 且 已过售后保护期（15 天）→ 纳入结算；
 *   佣金 = 实付 × 5%（后台可配）；应结 = 实付 − 佣金 − 服务费 − 同周期退款冲减
 * 结算周期 T+7；退款跨周期在下一周期冲减
 */

const SETTLE_STATUS = { 1: '待确认', 2: '已结算', 3: '已打款' };
const WITHDRAW_STATUS = { 0: '待审核', 1: '已打款', 2: '已驳回' };

function eligibleOrders(shopId = null) {
  const guardDays = config.getNumber('aftersale_days');
  const cutoff = now(-guardDays * 86400000);
  const params = [cutoff];
  let where = `WHERE o.status = 3 AND o.settled = 0 AND o.finished_at IS NOT NULL AND o.finished_at <= ?
    AND NOT EXISTS (SELECT 1 FROM aftersales a WHERE a.order_id = o.id AND a.status NOT IN (5, 6))`;
  if (shopId) { where += ' AND o.shop_id = ?'; params.push(shopId); }
  return all(`SELECT o.* FROM orders o ${where}`, ...params);
}

/** 生成结算单（API-138 / 定时任务） */
function generate({ period, operatorId = null, shopId = null } = {}) {
  const rate = config.getNumber('commission_rate');
  const orders = eligibleOrders(shopId);
  if (!orders.length) return { generated: 0, settlements: [] };
  const byShop = new Map();
  for (const o of orders) {
    if (!byShop.has(o.shop_id)) byShop.set(o.shop_id, []);
    byShop.get(o.shop_id).push(o);
  }
  const created = [];
  db.transaction(() => {
    for (const [sid, list] of byShop) {
      const settlementPeriod = period || now().slice(0, 7);
      const exist = get('SELECT * FROM settlements WHERE shop_id = ? AND period = ?', sid, settlementPeriod);
      let deal = 0; let commission = 0; let refundSum = 0;
      const items = [];
      for (const o of list) {
        const refunded = get('SELECT COALESCE(SUM(amount),0) AS s FROM refund_orders WHERE order_id = ? AND status = 2', o.id).s;
        const pay = o.pay_amount - refunded;
        const comm = Math.round(pay * rate);
        const payable = Math.max(0, pay - comm);
        deal += o.pay_amount;
        commission += comm;
        refundSum += refunded;
        items.push({ orderId: o.id, dealAmount: o.pay_amount, commission: comm, refundAmount: refunded, payableAmount: payable });
      }
      if (exist) {
        // 同一周期已生成且仍为「待确认」：把新增可结算订单并入，保持幂等（不重复计入已有订单）
        if (exist.status !== 1) continue;
        for (const it of items) {
          const dup = get('SELECT id FROM settlement_items WHERE settlement_id = ? AND order_id = ?', exist.id, it.orderId);
          if (dup) continue;
          run(`INSERT INTO settlement_items (settlement_id, order_id, deal_amount, commission, payable_amount)
               VALUES (?, ?, ?, ?, ?)`, exist.id, it.orderId, it.dealAmount, it.commission, it.payableAmount);
          run('UPDATE orders SET settled = 1, updated_at = ? WHERE id = ?', now(), it.orderId);
        }
        const agg = get(`SELECT COALESCE(SUM(deal_amount),0) AS d, COALESCE(SUM(commission),0) AS c,
                               COALESCE(SUM(payable_amount),0) AS p FROM settlement_items WHERE settlement_id = ?`, exist.id);
        run('UPDATE settlements SET deal_amount = ?, commission = ?, payable_amount = ? WHERE id = ?', agg.d, agg.c, agg.p, exist.id);
        created.push(toApi(get('SELECT * FROM settlements WHERE id = ?', exist.id)));
        continue;
      }
      const payableTotal = Math.max(0, deal - commission - refundSum);
      const res = run(`INSERT INTO settlements (shop_id, period, deal_amount, commission, payable_amount, status, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)`, sid, settlementPeriod, deal, commission, payableTotal, now());
      const settlementId = res.lastInsertRowid;
      for (const it of items) {
        run(`INSERT INTO settlement_items (settlement_id, order_id, deal_amount, commission, payable_amount)
             VALUES (?, ?, ?, ?, ?)`, settlementId, it.orderId, it.dealAmount, it.commission, it.payableAmount);
        run('UPDATE orders SET settled = 1, updated_at = ? WHERE id = ?', now(), it.orderId);
      }
      created.push(toApi(get('SELECT * FROM settlements WHERE id = ?', settlementId)));
    }
  });
  return { generated: created.length, settlements: created };
}

function toApi(s) {
  const shop = get('SELECT id, name FROM shops WHERE id = ?', s.shop_id);
  const itemCount = get('SELECT COUNT(*) AS c FROM settlement_items WHERE settlement_id = ?', s.id).c;
  return {
    id: s.id,
    settlementNo: `ST${String(s.id).padStart(8, '0')}`,
    shopId: s.shop_id,
    shopName: shop?.name,
    period: s.period,
    orderCount: itemCount,
    dealAmount: toYuan(s.deal_amount),
    commission: toYuan(s.commission),
    payableAmount: toYuan(s.payable_amount),
    status: s.status,
    statusName: SETTLE_STATUS[s.status],
    createdAt: s.created_at,
  };
}

function list({ shopId = null, period, status, page = 1, pageSize = 20 } = {}) {
  const params = [];
  let where = 'WHERE 1 = 1';
  if (shopId) { where += ' AND shop_id = ?'; params.push(shopId); }
  if (period) { where += ' AND period = ?'; params.push(period); }
  if (status) { where += ' AND status = ?'; params.push(Number(status)); }
  const total = get(`SELECT COUNT(*) AS c FROM settlements ${where}`, ...params).c;
  const rows = all(`SELECT * FROM settlements ${where} ORDER BY period DESC, id DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
  return { total, rows: rows.map(toApi) };
}

function itemsOf(settlementId, shopId = null) {
  const s = get('SELECT * FROM settlements WHERE id = ?', Number(settlementId));
  if (!s) throw Errors.notFound('结算单不存在');
  if (shopId && s.shop_id !== shopId) throw Errors.notFound('结算单不存在');
  return all('SELECT si.*, o.order_no, o.paid_at FROM settlement_items si JOIN orders o ON o.id = si.order_id WHERE si.settlement_id = ?', s.id)
    .map((r) => ({
      orderId: r.order_id, orderNo: r.order_no, paidAt: r.paid_at,
      dealAmount: toYuan(r.deal_amount), commission: toYuan(r.commission),
      refundAmount: toYuan(r.refund_amount || 0), payableAmount: toYuan(r.payable_amount),
    }));
}

function balanceOf(shopId) {
  const settled = get("SELECT COALESCE(SUM(payable_amount),0) AS s FROM settlements WHERE shop_id = ? AND status IN (2, 3)", shopId).s;
  const withdrawn = get("SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE shop_id = ? AND status IN (0, 1)", shopId).s;
  return { settled, withdrawn, available: Math.max(0, settled - withdrawn) };
}

/** 商家提现申请（API-089） */
function applyWithdrawal(shopId, payload = {}, operator = {}) {
  const amount = require('../core/money').toCents(payload.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw Errors.badRequest('提现金额不合法', { field: 'amount' });
  const min = config.getNumber('withdraw_min_amount');
  if (amount < min) throw Errors.badRequest(`单笔提现金额不得低于 ${toYuan(min)} 元`, { field: 'amount' });
  const balance = balanceOf(shopId);
  if (amount > balance.available) throw Errors.badRequest('提现金额不得超过当前可提现余额', { field: 'amount' });
  const account = get("SELECT * FROM shop_accounts WHERE shop_id = ? AND status = 1 AND verified = 1 ORDER BY id DESC LIMIT 1", shopId);
  if (!account) throw Errors.badRequest('请先绑定并通过验证的收款账户');
  const today = now().slice(0, 10);
  const count = get("SELECT COUNT(*) AS c FROM withdrawals WHERE shop_id = ? AND substr(created_at,1,10) = ?", shopId, today).c;
  const limit = config.getNumber('withdraw_daily_limit');
  if (count >= limit) throw Errors.badRequest(`同一店铺 24 小时内提现申请不得超过 ${limit} 次`);
  const id = run(`INSERT INTO withdrawals (shop_id, settlement_id, amount, account_info, status, created_at)
    VALUES (?, ?, ?, ?, 0, ?)`, shopId, payload.settlementId || null, amount, account.id, now()).lastInsertRowid;
  return toWithdrawApi(get('SELECT * FROM withdrawals WHERE id = ?', id));
}

function toWithdrawApi(w) {
  const shop = get('SELECT id, name FROM shops WHERE id = ?', w.shop_id);
  const acc = w.account_info ? get('SELECT * FROM shop_accounts WHERE id = ?', w.account_info) : null;
  return {
    id: w.id,
    withdrawalNo: `WD${String(w.id).padStart(8, '0')}`,
    shopId: w.shop_id,
    shopName: shop?.name,
    settlementId: w.settlement_id,
    amount: toYuan(w.amount),
    status: w.status,
    statusName: WITHDRAW_STATUS[w.status],
    account: acc ? { type: acc.account_type, name: acc.account_name, accountMask: maskAccount(acc.account_no) } : null,
    rejectReason: w.reject_reason,
    auditedAt: w.audited_at,
    paidAt: w.paid_at,
    createdAt: w.created_at,
  };
}

function listWithdrawals({ shopId = null, status, page = 1, pageSize = 20 } = {}) {
  const params = [];
  let where = 'WHERE 1 = 1';
  if (shopId) { where += ' AND shop_id = ?'; params.push(shopId); }
  if (status) { where += ' AND status = ?'; params.push(Number(status)); }
  const total = get(`SELECT COUNT(*) AS c FROM withdrawals ${where}`, ...params).c;
  const rows = all(`SELECT * FROM withdrawals ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
  return { total, rows: rows.map(toWithdrawApi) };
}

/** 财务提现审核（API-139） */
function auditWithdrawal(id, { approve, rejectReason, auditorId = null } = {}) {
  const w = get('SELECT * FROM withdrawals WHERE id = ?', Number(id));
  if (!w) throw Errors.notFound('提现申请不存在');
  if (w.status !== 0) throw Errors.badRequest('提现申请已处理');
  if (!approve) {
    if (!rejectReason) throw Errors.badRequest('驳回原因必填', { field: 'rejectReason' });
    run('UPDATE withdrawals SET status = 2, reject_reason = ?, auditor_id = ?, audited_at = ? WHERE id = ?', rejectReason, auditorId, now(), w.id);
  } else {
    run('UPDATE withdrawals SET status = 1, auditor_id = ?, audited_at = ?, paid_at = ? WHERE id = ?', auditorId, now(), now(), w.id);
  }
  return toWithdrawApi(get('SELECT * FROM withdrawals WHERE id = ?', w.id));
}

module.exports = {
  generate, list, itemsOf, toApi, balanceOf, applyWithdrawal, listWithdrawals, auditWithdrawal, eligibleOrders,
  toWithdrawApi, SETTLE_STATUS, WITHDRAW_STATUS,
};
