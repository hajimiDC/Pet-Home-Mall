'use strict';

const { get, all, run, parseJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, parseTime } = require('../core/money');
const { maskName } = require('../core/privacy');
const config = require('../core/config');
const db = require('../core/db');

/**
 * 商品评价服务（8.6 商品评价 Tab、9.3.8 评价管理、FR-SLR-070 ~ 075、BR-SLR-021 / 022、Q-014）
 *
 * 规则：
 *  - 发表评价：订单须属于当前用户且已完成（status=3）；同一订单明细只能评价一次（order_item_id 唯一）；
 *    评分 1-5、内容非空且 ≤ 500 字、图片最多 9 张；写入后重算店铺评分（BR-SLR-021）。
 *  - 商家回复（FR-SLR-071 / BR-SLR-022）：同一评价同时只存在一条有效回复，**回复后不可修改**；
 *    如需更正须先删除回复（reply_deleted=1，留痕由调用方记操作日志）再重新回复；
 *    前台只展示 reply_deleted=0 的有效回复。
 *  - 恶意评价申诉（FR-SLR-072 / 073）：同一评价存在处理中（status=0）的申诉时不可重复申诉；
 *    申诉通过 → hidden=1 且不计入评分；申诉驳回 → 保持原样。
 *  - 店铺评分（FR-SLR-014）：未隐藏评价的平均分保留 1 位小数，以 ×10 整数写入 shops.score。
 *
 * 说明：本服务只提供能力，商家端 / 平台端路由由其他模块注册（不在此注册路由）。
 */

const APPEAL_STATUS = { 0: '待审核', 1: '已通过', 2: '已驳回' };
const MAX_IMAGES = 9;
const MAX_CONTENT = 500;
const MAX_PAGE_SIZE = 20;

function clampSize(pageSize, fallback = 20) {
  const n = Number(pageSize);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_PAGE_SIZE);
}

function pageOf(page) {
  const n = Number(page);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function toImages(value) {
  let list = value;
  if (typeof list === 'string') list = parseJson(list, []) || [];
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim())
    .slice(0, MAX_IMAGES);
}

function appealToApi(a) {
  return {
    id: a.id,
    reviewId: a.review_id,
    shopId: a.shop_id,
    reason: a.reason,
    evidence: parseJson(a.evidence, []) || [],
    status: a.status,
    statusName: APPEAL_STATUS[a.status] || '未知',
    rejectReason: a.reject_reason,
    auditorId: a.auditor_id,
    auditedAt: a.audited_at,
    createdAt: a.created_at,
  };
}

/** 评价对外结构：前台只暴露有效回复；商家端可额外看到申诉与删除留痕 */
function toApi(r, { withAppeal = false } = {}) {
  const user = get('SELECT id, username, nickname FROM users WHERE id = ?', r.user_id);
  const product = get('SELECT id, name, main_image FROM products WHERE id = ?', r.product_id);
  const replyValid = !!r.reply && r.reply_deleted !== 1;
  const base = {
    id: r.id,
    shopId: r.shop_id,
    productId: r.product_id,
    productName: product?.name || '',
    productImage: product?.main_image || '',
    orderId: r.order_id,
    orderItemId: r.order_item_id,
    userId: r.user_id,
    userNickname: maskName(user?.nickname || user?.username || '匿名'),
    score: r.score,
    content: r.content || '',
    images: toImages(r.images),
    reply: replyValid ? r.reply : null,
    repliedAt: replyValid ? r.replied_at : null,
    hasReply: replyValid,
    replyDeleted: r.reply_deleted === 1,
    hidden: r.hidden === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (withAppeal) {
    const appeal = get('SELECT * FROM review_appeals WHERE review_id = ? ORDER BY id DESC LIMIT 1', r.id);
    base.rawReply = r.reply || '';
    base.withAppeal = true;
    base.appeal = appeal ? appealToApi(appeal) : null;
  }
  return base;
}

/**
 * 发表评价（API-161 / C 端）
 * @param {number} userId
 * @param {{orderItemId:number, score:number, content:string, images?:string[]}} payload
 */
function create(userId, payload = {}) {
  const orderItemId = Number(payload.orderItemId);
  if (!Number.isInteger(orderItemId) || orderItemId <= 0) {
    throw Errors.badRequest('请选择要评价的商品', { field: 'orderItemId' });
  }
  const item = get('SELECT * FROM order_items WHERE id = ?', orderItemId);
  if (!item) throw Errors.notFound('订单明细不存在');
  const order = get('SELECT * FROM orders WHERE id = ? AND user_id = ?', item.order_id, userId);
  if (!order) throw Errors.notFound('订单不存在');
  if (order.status !== 3) throw Errors.badRequest('订单完成后才能评价');
  const exist = get('SELECT id FROM shop_reviews WHERE order_item_id = ?', orderItemId);
  if (exist) throw Errors.badRequest('该商品已评价，请勿重复评价');

  const score = Number(payload.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw Errors.badRequest('评分需为 1-5 的整数', { field: 'score' });
  }
  const content = String(payload.content ?? '').trim();
  if (!content) throw Errors.badRequest('请填写评价内容', { field: 'content' });
  if (content.length > MAX_CONTENT) {
    throw Errors.badRequest(`评价内容不能超过 ${MAX_CONTENT} 字`, { field: 'content' });
  }
  const images = toImages(payload.images);

  const id = run(
    `INSERT INTO shop_reviews (shop_id, product_id, order_id, order_item_id, user_id, score, content, images,
       reply, replied_at, reply_deleted, hidden, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?)`,
    order.shop_id, item.product_id, order.id, orderItemId, userId, score, content,
    JSON.stringify(images), now(), now(),
  ).lastInsertRowid;

  refreshShopScore(order.shop_id);
  return toApi(get('SELECT * FROM shop_reviews WHERE id = ?', id));
}

/** 商品评价列表（API-013 能力导出）：仅展示未隐藏评价 */
function listByProduct(productId, { page = 1, pageSize = 20 } = {}) {
  const pid = Number(productId);
  const size = clampSize(pageSize);
  const current = pageOf(page);
  const total = get('SELECT COUNT(*) AS c FROM shop_reviews WHERE product_id = ? AND hidden = 0', pid).c;
  const rows = all(
    `SELECT * FROM shop_reviews WHERE product_id = ? AND hidden = 0
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    pid, size, (current - 1) * size,
  );
  const agg = get('SELECT COALESCE(AVG(score), 0) AS avg FROM shop_reviews WHERE product_id = ? AND hidden = 0', pid);
  const avg = Number(agg?.avg) || 0;
  return {
    total,
    rows: rows.map((r) => toApi(r)),
    page: current,
    pageSize: size,
    avgScore: Number(avg.toFixed(1)),
  };
}

/** 商家端评价列表（API-075 能力导出）：支持评分 / 是否回复 / 是否隐藏筛选 */
function listForShop(shopId, { page = 1, pageSize = 20, productId, score, replied, hidden } = {}) {
  const size = clampSize(pageSize);
  const current = pageOf(page);
  const params = [Number(shopId)];
  let where = 'WHERE shop_id = ?';
  if (productId) { where += ' AND product_id = ?'; params.push(Number(productId)); }
  if (score) { where += ' AND score = ?'; params.push(Number(score)); }
  if (replied !== undefined && replied !== null && replied !== '') {
    if (String(replied) === '1' || replied === true) where += ' AND reply IS NOT NULL AND reply_deleted = 0';
    else where += ' AND (reply IS NULL OR reply_deleted = 1)';
  }
  if (hidden !== undefined && hidden !== null && hidden !== '') {
    where += ' AND hidden = ?';
    params.push(Number(hidden) ? 1 : 0);
  }
  const total = get(`SELECT COUNT(*) AS c FROM shop_reviews ${where}`, ...params).c;
  const rows = all(
    `SELECT * FROM shop_reviews ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ...params, size, (current - 1) * size,
  );
  return { total, rows: rows.map((r) => toApi(r, { withAppeal: true })), page: current, pageSize: size };
}

/** 我的评价列表（C 端「我的评价」） */
function listForUser(userId, { page = 1, pageSize = 20 } = {}) {
  const size = clampSize(pageSize);
  const current = pageOf(page);
  const total = get('SELECT COUNT(*) AS c FROM shop_reviews WHERE user_id = ?', userId).c;
  const rows = all(
    'SELECT * FROM shop_reviews WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    userId, size, (current - 1) * size,
  );
  return { total, rows: rows.map((r) => toApi(r)), page: current, pageSize: size };
}

/**
 * 商家回复（FR-SLR-071 / BR-SLR-022 / Q-014）
 * 已有有效回复再提交 → 400「评价回复不可修改，请删除后重新回复」。
 */
function reply(shopId, reviewId, content) {
  const r = get('SELECT * FROM shop_reviews WHERE id = ? AND shop_id = ?', Number(reviewId), Number(shopId));
  if (!r) throw Errors.notFound('评价不存在');
  const maxLen = Number(config.getNumber('review_reply_max_len')) || 500;
  const text = String(content ?? '').trim();
  if (!text) throw Errors.badRequest('回复内容不能为空', { field: 'content' });
  if (text.length > maxLen) throw Errors.badRequest(`回复内容不能超过 ${maxLen} 字`, { field: 'content' });
  if (r.reply && r.reply_deleted !== 1) {
    throw Errors.badRequest('评价回复不可修改，请删除后重新回复');
  }
  run(
    'UPDATE shop_reviews SET reply = ?, replied_at = ?, reply_deleted = 0, updated_at = ? WHERE id = ?',
    text, now(), now(), r.id,
  );
  return toApi(get('SELECT * FROM shop_reviews WHERE id = ?', r.id), { withAppeal: true });
}

/** 删除回复（保留 reply 原文留痕，reply_deleted=1；操作日志由调用方记录） */
function deleteReply(shopId, reviewId) {
  const r = get('SELECT * FROM shop_reviews WHERE id = ? AND shop_id = ?', Number(reviewId), Number(shopId));
  if (!r) throw Errors.notFound('评价不存在');
  if (!r.reply || r.reply_deleted === 1) throw Errors.badRequest('该评价暂无有效回复');
  run('UPDATE shop_reviews SET reply_deleted = 1, updated_at = ? WHERE id = ?', now(), r.id);
  return toApi(get('SELECT * FROM shop_reviews WHERE id = ?', r.id), { withAppeal: true });
}

/** 恶意评价申诉（FR-SLR-072）：同一评价处理中不可重复申诉 */
function appeal(shopId, reviewId, { reason, evidence } = {}) {
  const r = get('SELECT * FROM shop_reviews WHERE id = ? AND shop_id = ?', Number(reviewId), Number(shopId));
  if (!r) throw Errors.notFound('评价不存在');
  const running = get('SELECT * FROM review_appeals WHERE review_id = ? AND status = 0', r.id);
  if (running) throw Errors.badRequest('该评价申诉处理中');
  const text = String(reason ?? '').trim();
  if (!text) throw Errors.badRequest('请填写申诉原因', { field: 'reason' });
  if (text.length > 200) throw Errors.badRequest('申诉原因不能超过 200 字', { field: 'reason' });
  const list = toImages(evidence);
  const id = run(
    `INSERT INTO review_appeals (review_id, shop_id, reason, evidence, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    r.id, Number(shopId), text, JSON.stringify(list), now(), now(),
  ).lastInsertRowid;
  return { ...appealToApi(get('SELECT * FROM review_appeals WHERE id = ?', id)), review: toApi(r, { withAppeal: true }) };
}

/**
 * 平台客服审核申诉（FR-SLR-073）
 * 通过 → 评价 hidden=1 且不计入评分；驳回 → 保持原样（驳回原因必填）。
 */
function auditAppeal(appealId, { approve, rejectReason, auditorId = null } = {}) {
  const a = get('SELECT * FROM review_appeals WHERE id = ?', Number(appealId));
  if (!a) throw Errors.notFound('申诉记录不存在');
  if (a.status !== 0) throw Errors.badRequest('该申诉已处理');
  if (approve) {
    db.transaction(() => {
      run(
        'UPDATE review_appeals SET status = 1, auditor_id = ?, audited_at = ?, updated_at = ? WHERE id = ? AND status = 0',
        auditorId, now(), now(), a.id,
      );
      run('UPDATE shop_reviews SET hidden = 1, updated_at = ? WHERE id = ?', now(), a.review_id);
    });
  } else {
    if (!rejectReason || !String(rejectReason).trim()) {
      throw Errors.badRequest('驳回原因必填', { field: 'rejectReason' });
    }
    run(
      'UPDATE review_appeals SET status = 2, reject_reason = ?, auditor_id = ?, audited_at = ?, updated_at = ? WHERE id = ? AND status = 0',
      String(rejectReason).trim().slice(0, 200), auditorId, now(), now(), a.id,
    );
  }
  const shopScore = refreshShopScore(a.shop_id);
  const review = get('SELECT * FROM shop_reviews WHERE id = ?', a.review_id);
  return {
    ...appealToApi(get('SELECT * FROM review_appeals WHERE id = ?', a.id)),
    approved: !!approve,
    review: review ? toApi(review, { withAppeal: true }) : null,
    shopScore,
  };
}

/**
 * 重算店铺评分（FR-SLR-014 / BR-SLR-021）
 * 评分 = 未隐藏评价平均分，保留 1 位小数，以 ×10 整数存入 shops.score（如 3.3 → 33）。
 * 无有效评价时保持店铺现有评分不变。
 */
function refreshShopScore(shopId) {
  const sid = Number(shopId);
  const agg = get(
    'SELECT COUNT(*) AS c, COALESCE(AVG(score), 0) AS avg FROM shop_reviews WHERE shop_id = ? AND hidden = 0',
    sid,
  );
  const count = Number(agg?.c) || 0;
  const shop = get('SELECT id, score FROM shops WHERE id = ?', sid);
  if (!shop) return { shopId: sid, score: null, scoreText: null, count: 0 };
  if (count === 0) {
    return { shopId: sid, score: shop.score, scoreText: (Number(shop.score) / 10).toFixed(1), count: 0 };
  }
  const score = Math.round(Number(agg.avg) * 10);
  run('UPDATE shops SET score = ?, updated_at = ? WHERE id = ?', score, now(), sid);
  return { shopId: sid, score, scoreText: (score / 10).toFixed(1), count };
}

module.exports = {
  APPEAL_STATUS, toApi, appealToApi, create, listByProduct, listForShop, listForUser,
  reply, deleteReply, appeal, auditAppeal, refreshShopScore,
};
