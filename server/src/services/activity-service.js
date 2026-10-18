'use strict';

const { get, all, parseJson } = require('../core/db');
const { now, parseTime, toYuan } = require('../core/money');

/**
 * 商家活动服务（8.7 / 8.8 / BR-SLR-029 / Q-015）
 * 规则：同类活动允许时间重叠；同一商品命中多个活动时按「优惠力度最优的一个」生效，活动之间不叠加。
 */

const TYPE_NAMES = { 满减: '满减', 折扣: '折扣', 满赠: '满赠', 秒杀: '秒杀' };

function isRunning(activity, at = now()) {
  return activity.status === 1 && parseTime(activity.start_at) <= parseTime(at) && parseTime(activity.end_at) > parseTime(at);
}

/** 单个活动对某商品小计的优惠金额（分） */
function discountFor(activity, subtotal) {
  const rule = parseJson(activity.rule_json, {}) || {};
  if (activity.type === '满减') {
    const threshold = Number(rule.threshold || 0);
    if (subtotal < threshold) return 0;
    return Math.min(Number(rule.discount || 0), subtotal);
  }
  if (activity.type === '折扣' || activity.type === '秒杀') {
    const rate = Number(rule.rate ?? 1);
    if (!(rate > 0 && rate < 1)) return 0;
    return Math.max(0, Math.round(subtotal * (1 - rate)));
  }
  return 0; // 满赠不产生金额优惠
}

function activitiesOfProduct(productId, at = now()) {
  return all(
    `SELECT a.* FROM activities a JOIN activity_products ap ON ap.activity_id = a.id
      WHERE ap.product_id = ? AND a.status = 1 AND a.start_at <= ? AND a.end_at > ?`,
    productId, at, at,
  );
}

/**
 * 计算订单活动优惠（逐商品取最优活动，不叠加）
 * @param {Array<{productId:number, subtotal:number}>} items
 */
function bestDiscount(items, at = now()) {
  let total = 0;
  const applied = new Map();
  for (const item of items) {
    let best = null;
    for (const act of activitiesOfProduct(item.productId, at)) {
      const discount = discountFor(act, item.subtotal);
      if (discount > 0 && (!best || discount > best.discount)) best = { activity: act, discount };
    }
    if (best) {
      total += best.discount;
      applied.set(best.activity.id, {
        activityId: best.activity.id,
        title: best.activity.title,
        type: best.activity.type,
        discount: best.discount,
      });
    }
  }
  return { total: Math.min(total, items.reduce((s, i) => s + i.subtotal, 0)), applied: [...applied.values()] };
}

/** 前台活动列表：按开始时间倒序，仅进行中（BR-SLR-030） */
function listActive({ keyword = '', page = 1, pageSize = 20, shopId = null } = {}) {
  const params = [now(), now()];
  let where = 'WHERE a.status = 1 AND a.start_at <= ? AND a.end_at > ?';
  if (shopId) { where += ' AND a.shop_id = ?'; params.push(shopId); }
  if (keyword) { where += ' AND (a.title LIKE ? OR s.name LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  const from = 'FROM activities a JOIN shops s ON s.id = a.shop_id';
  const total = get(`SELECT COUNT(*) AS c ${from} ${where}`, ...params).c;
  const rows = all(
    `SELECT a.*, s.name AS shop_name, s.logo AS shop_logo ${from} ${where} ORDER BY a.start_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize,
  );
  return { total, rows: rows.map(toApi) };
}

function toApi(a) {
  const rule = parseJson(a.rule_json, {}) || {};
  const products = all(
    `SELECT p.id, p.name, p.main_image, p.price FROM activity_products ap JOIN products p ON p.id = ap.product_id WHERE ap.activity_id = ?`,
    a.id,
  ).map((p) => ({ id: p.id, name: p.name, image: p.main_image, price: toYuan(p.price) }));
  return {
    id: a.id,
    title: a.title,
    type: a.type,
    image: a.image,
    content: a.content,
    ruleDesc: a.rule_desc,
    rule: { ...rule, threshold: rule.threshold !== undefined ? toYuan(rule.threshold) : undefined, discount: rule.discount !== undefined ? toYuan(rule.discount) : undefined },
    shopId: a.shop_id,
    shopName: a.shop_name,
    shopLogo: a.shop_logo,
    startAt: a.start_at,
    endAt: a.end_at,
    status: a.status,
    statusName: ['待审核', '进行中', '已驳回', '已结束', '已下线'][a.status] || '',
    views: a.views,
    joinCount: a.join_count,
    orderCount: a.order_count,
    dealAmount: toYuan(a.deal_amount),
    products,
  };
}

module.exports = { bestDiscount, discountFor, listActive, toApi, isRunning, activitiesOfProduct, TYPE_NAMES };
