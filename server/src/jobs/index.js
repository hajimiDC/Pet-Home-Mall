'use strict';

const { Logger } = require('../core/logger');
const orderSvc = require('../services/order-service');
const couponSvc = require('../services/coupon-service');
const { all, run } = require('../core/db');
const { now, toYuan } = require('../core/money');
const refundSvc = require('../services/refund-service');

/**
 * 定时任务（NFR-CONS-003 超时回收、BR-GRP-002 未成团退款）
 * 单实例部署：setInterval 驱动；生产可替换为消息队列延迟消息。
 */

async function closeExpiredOrders() {
  const closed = orderSvc.closeExpiredOrders();
  if (closed > 0) Logger.info('job.close-expired-orders', { closed });
  return closed;
}

async function expireCoupons() {
  couponSvc.refreshExpired();
}

/** 拼团有效期结束仍未成团：全额退款（含运费）+ 库存回滚（Q-001 / BR-GRP-003） */
async function settleExpiredGroups() {
  const teams = all("SELECT * FROM group_teams WHERE status = 1 AND expire_at <= ?", now());
  let settled = 0;
  for (const team of teams) {
    const paidMembers = all('SELECT * FROM group_members WHERE team_id = ? AND status = 2', team.id);
    const res = run("UPDATE group_teams SET status = 3, updated_at = ? WHERE id = ? AND status = 1", now(), team.id);
    if (res.changes === 0) continue;
    run("UPDATE group_buys SET status = 3, updated_at = ? WHERE id = ?", now(), team.group_buy_id);
    for (const member of paidMembers) {
      const order = require('../core/db').get('SELECT * FROM orders WHERE id = ?', member.order_id);
      if (!order) continue;
      const refund = refundSvc.createUnformedRefund(order, order.pay_amount);
      if (refund.status === 0) {
        // 未成团退款在沙箱内自动通过（全额退款为规则性动作，不依赖人工审核）
        refundSvc.audit(refund.id, { approve: true, auditorId: null });
      }
      run('UPDATE group_members SET status = 3 WHERE id = ?', member.id);
    }
    settled += 1;
    Logger.info('job.group-unformed-refund', { teamId: team.id, members: paidMembers.length });
  }
  return settled;
}

/** 到店预约过期标记：时段已过且仍为「待到店」→ 已过期（8.12 / BR-STORE-004） */
async function expireBookings() {
  const res = run("UPDATE store_bookings SET status = 4, updated_at = ? WHERE status = 1 AND booking_time < ?", now(), now());
  if (res.changes > 0) Logger.info('job.expire-bookings', { count: res.changes });
}

function start({ orderInterval = 30000, groupInterval = 60000, bookingInterval = 300000 } = {}) {
  const timers = [];
  timers.push(setInterval(() => { closeExpiredOrders().catch((e) => Logger.error('job.order-timeout', { message: e.message })); }, orderInterval));
  timers.push(setInterval(() => { expireCoupons().catch(() => {}); }, 300000));
  timers.push(setInterval(() => { settleExpiredGroups().catch((e) => Logger.error('job.group-settle', { message: e.message })); }, groupInterval));
  timers.push(setInterval(() => { expireBookings().catch(() => {}); }, bookingInterval));
  return timers;
}

module.exports = { start, closeExpiredOrders, expireCoupons, settleExpiredGroups, expireBookings };
