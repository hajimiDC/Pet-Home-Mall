'use strict';

const { get, all, run } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, parseTime } = require('../core/money');

/**
 * 优惠券服务（FR-ORDDER-012、BR-SLR-025、Q-003、8.9）
 * 规则：
 *  - 每笔订单最多「1 张平台券 + 1 张店铺券」，同类互斥（Q-003）
 *  - 店铺券仅可用于本店商品（FR-SLR-085）
 *  - 门槛不满足 / 已过期 / 已领完 / 已使用 → 置灰并给出原因
 *  - 领取幂等：同一用户超限领取 → 提示「您已领取该券」
 */

function refreshExpired(userId = null) {
  const sql = `UPDATE user_coupons SET status = 2 WHERE status = 0 AND expire_at <= ?${userId ? ' AND user_id = ?' : ''}`;
  if (userId) run(sql, now(), userId); else run(sql, now());
}

function couponStatusOf(row, at = now()) {
  if (row.status === 1) return '已使用';
  if (row.status === 2) return '已过期';
  if (parseTime(row.expire_at) <= parseTime(at)) return '已过期';
  return '未使用';
}

function scopeMatches(coupon, { shopId, items }) {
  const scopeType = coupon.scope_type || 1;
  const ids = require('../core/db').parseJson(coupon.scope_ids, []) || [];
  if (scopeType === 1) return true;
  if (scopeType === 4) return ids.map(Number).includes(Number(shopId));
  if (scopeType === 3) return items.some((i) => ids.map(Number).includes(Number(i.productId)));
  if (scopeType === 2) {
    return items.some((i) => {
      const prod = get('SELECT category_id FROM products WHERE id = ?', i.productId);
      if (!prod) return false;
      let cat = prod.category_id;
      for (let depth = 0; depth < 4 && cat; depth += 1) {
        if (ids.map(Number).includes(Number(cat))) return true;
        const row = get('SELECT parent_id FROM categories WHERE id = ?', cat);
        cat = row?.parent_id || 0;
      }
      return false;
    });
  }
  return false;
}

/** 计算某张券对给定商品总计的抵扣金额（分） */
function discountOf(coupon, goodsAmount) {
  if (goodsAmount <= 0) return 0;
  if (coupon.type === 2) {
    const rate = Number(coupon.discount_rate || 1);
    return Math.max(0, Math.round(goodsAmount * (1 - rate)));
  }
  return Math.min(coupon.amount, goodsAmount);
}

/**
 * 计算订单可用券（结算页展示用）
 * @param {{userId:number, shopId:number, goodsAmount:number, items:Array<{productId:number, subtotal:number}>}} ctx
 */
function availableForOrder({ userId, shopId, goodsAmount, items }) {
  refreshExpired(userId);
  const rows = all(
    `SELECT uc.id AS user_coupon_id, uc.status AS uc_status, uc.expire_at, c.*
       FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id
      WHERE uc.user_id = ? AND uc.status = 0 AND uc.expire_at > ?
      ORDER BY c.shop_id = 0 DESC, c.amount DESC, c.id ASC`,
    userId, now(),
  );
  const result = { platform: [], shop: [], bestPlatformId: null, bestShopId: null };
  for (const row of rows) {
    const isPlatform = Number(row.shop_id) === 0;
    const reason = [];
    if (row.status !== 1) reason.push('券已下架');
    if (parseTime(row.start_at) > parseTime(now())) reason.push('未到使用时间');
    if (parseTime(row.end_at) <= parseTime(now())) reason.push('券已过期');
    if (!scopeMatches(row, { shopId, items })) reason.push(isPlatform ? '不适用于本店商品' : '不适用于本店商品');
    if (goodsAmount < row.threshold) reason.push(`未满 ${(row.threshold / 100).toFixed(2)} 元`);
    const usable = reason.length === 0;
    const item = {
      userCouponId: row.user_coupon_id,
      couponId: row.id,
      name: row.name,
      type: row.type,
      typeName: row.type === 2 ? '折扣券' : '满减券',
      threshold: row.threshold / 100,
      amount: row.amount / 100,
      discountRate: row.discount_rate,
      scopeType: row.scope_type,
      scopeName: ['全场通用', '指定类目', '指定商品', '指定店铺'][row.scope_type - 1] || '全场通用',
      expireAt: row.expire_at,
      usable,
      reason: reason.join('；') || null,
      discount: usable ? discountOf(row, goodsAmount) / 100 : 0,
      source: isPlatform ? '平台券' : '店铺券',
    };
    if (isPlatform) result.platform.push(item); else result.shop.push(item);
  }
  const bestPlatform = result.platform.filter((c) => c.usable).sort((a, b) => b.discount - a.discount)[0];
  const bestShop = result.shop.filter((c) => c.usable).sort((a, b) => b.discount - a.discount)[0];
  result.bestPlatformId = bestPlatform?.userCouponId || null;
  result.bestShopId = bestShop?.userCouponId || null;
  return result;
}

/**
 * 校验并计算下单时可用的券（服务端复算，不信任前端，NFR-SEC-004）
 * @returns {{platform:object|null, shop:object|null, total:number}}
 */
function validateForUse({ userId, shopId, goodsAmount, items, userCouponId, shopCouponId }) {
  const out = { platform: null, shop: null, total: 0 };
  const check = (ucId, expectPlatform) => {
    const row = get(
      `SELECT uc.id AS user_coupon_id, uc.user_id AS uc_user_id, uc.status AS uc_status,
              uc.expire_at AS uc_expire_at, uc.order_id AS uc_order_id,
              c.id AS coupon_id, c.shop_id, c.name, c.type, c.threshold, c.amount, c.discount_rate,
              c.scope_type, c.scope_ids, c.start_at, c.end_at, c.status AS coupon_status
         FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.id = ?`,
      ucId,
    );
    if (!row || row.uc_user_id !== userId) throw Errors.badRequest('优惠券不可用，请重新选择');
    if (row.uc_status !== 0) throw Errors.badRequest('优惠券不可用，请重新选择');
    if (parseTime(row.uc_expire_at) <= parseTime(now())) throw Errors.badRequest('优惠券不可用，请重新选择');
    if ((Number(row.shop_id) === 0) !== expectPlatform) throw Errors.badRequest('优惠券不可用，请重新选择');
    if (!scopeMatches(row, { shopId, items })) throw Errors.badRequest('优惠券不可用，请重新选择');
    if (goodsAmount < row.threshold) throw Errors.badRequest('优惠券不可用，请重新选择');
    return {
      userCoupon: { id: row.user_coupon_id },
      coupon: row,
      discount: discountOf(row, goodsAmount),
    };
  };
  if (userCouponId) { out.platform = check(userCouponId, true); out.total += out.platform.discount; }
  if (shopCouponId) { out.shop = check(shopCouponId, false); out.total += out.shop.discount; }
  return out;
}

function claim(userId, couponId) {
  const coupon = get('SELECT * FROM coupons WHERE id = ?', couponId);
  if (!coupon) throw Errors.notFound('优惠券不存在');
  if (coupon.status !== 1) throw Errors.badRequest('优惠券已下架');
  if (parseTime(coupon.start_at) > parseTime(now())) throw Errors.badRequest('活动未开始，暂不可领取');
  if (parseTime(coupon.end_at) <= parseTime(now())) throw Errors.badRequest('优惠券已过期');
  const mine = get('SELECT COUNT(*) AS c FROM user_coupons WHERE user_id = ? AND coupon_id = ?', userId, couponId).c;
  if (mine >= coupon.limit_per_user) throw Errors.badRequest(mine > 0 ? '您已领取该券' : '已达领取上限');
  const res = run('UPDATE coupons SET received = received + 1 WHERE id = ? AND received < stock AND status = 1', couponId);
  if (res.changes === 0) throw Errors.badRequest('券已抢光');
  const expireAt = coupon.valid_days
    ? require('../core/money').addDays(coupon.valid_days)
    : coupon.end_at;
  run('INSERT INTO user_coupons (user_id, coupon_id, status, expire_at, received_at) VALUES (?, ?, 0, ?, ?)',
    userId, couponId, expireAt, now());
  const uc = get('SELECT * FROM user_coupons WHERE user_id = ? AND coupon_id = ? ORDER BY id DESC LIMIT 1', userId, couponId);
  return { userCouponId: uc.id, couponId, name: coupon.name, expireAt };
}

function markUsed(userCouponId, orderId) {
  if (!userCouponId) return;
  const res = run('UPDATE user_coupons SET status = 1, order_id = ?, used_at = ? WHERE id = ? AND status = 0', orderId, now(), userCouponId);
  if (res.changes === 0) throw Errors.badRequest('优惠券不可用，请重新选择');
}

function restore(userCouponId) {
  if (!userCouponId) return;
  run('UPDATE user_coupons SET status = 0, order_id = NULL, used_at = NULL WHERE id = ?', userCouponId);
}

function listMine(userId, { status } = {}) {
  refreshExpired(userId);
  const params = [userId];
  let sql = `SELECT uc.id AS userCouponId, uc.status, uc.expire_at, uc.received_at, uc.used_at, c.*
               FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.user_id = ?`;
  if (status !== undefined && status !== '') { sql += ' AND uc.status = ?'; params.push(Number(status)); }
  sql += ' ORDER BY uc.status ASC, uc.expire_at ASC';
  return all(sql, ...params).map((r) => ({
    userCouponId: r.userCouponId,
    couponId: r.id,
    name: r.name,
    type: r.type,
    typeName: r.type === 2 ? '折扣券' : '满减券',
    threshold: r.threshold / 100,
    amount: r.amount / 100,
    discountRate: r.discount_rate,
    scopeType: r.scope_type,
    scopeName: ['全场通用', '指定类目', '指定商品', '指定店铺'][r.scope_type - 1] || '全场通用',
    shopId: r.shop_id,
    source: Number(r.shop_id) === 0 ? '平台券' : '店铺券',
    status: r.status,
    statusName: couponStatusOf(r),
    expireAt: r.expire_at,
    receivedAt: r.received_at,
  }));
}

module.exports = { availableForOrder, validateForUse, claim, markUsed, restore, listMine, refreshExpired, discountOf };
