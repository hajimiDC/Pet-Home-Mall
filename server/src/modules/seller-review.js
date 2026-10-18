'use strict';

const { get, all, run } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan } = require('../core/money');
const { maskName } = require('../core/privacy');
const v = require('../core/validate');
const config = require('../core/config');
const S = require('../services/seller-service');

/**
 * 商家端 · 评价管理
 * API-078 ~ API-080 + 删除回复（FR-SLR-070 ~ 075、BR-SLR-021 / 022、Q-014、9.3.8）
 * 规则：一次回复、回复后不可修改；删除后可重新回复；同一评价申诉处理中不可重复申诉。
 */

const APPEAL_STATUS = { 0: '处理中', 1: '申诉通过', 2: '申诉驳回' };

function ownReview(shopId, id) {
  const row = get('SELECT * FROM shop_reviews WHERE id = ? AND shop_id = ?', Number(id), shopId);
  if (!row) throw Errors.notFound('评价不存在');
  return row;
}

function toReviewApi(row) {
  const user = get('SELECT id, username, nickname FROM users WHERE id = ?', row.user_id);
  const product = get('SELECT id, name, main_image FROM products WHERE id = ?', row.product_id);
  const appeal = get('SELECT * FROM review_appeals WHERE review_id = ? ORDER BY id DESC LIMIT 1', row.id);
  const replied = Boolean(row.reply);
  return {
    id: row.id,
    productId: row.product_id,
    productName: product?.name || '',
    productImage: product?.main_image || '',
    orderId: row.order_id,
    score: row.score,
    content: row.content,
    images: S.parseJson(row.images, []) || [],
    reviewer: maskName(user?.nickname || user?.username || '匿名用户'),
    reviewerId: row.user_id,
    createdAt: row.created_at,
    replied,
    reply: row.reply,
    repliedAt: row.replied_at,
    hidden: row.hidden === 1,
    appeal: appeal ? {
      id: appeal.id,
      reason: appeal.reason,
      evidence: S.parseJson(appeal.evidence, []) || [],
      status: appeal.status,
      statusName: APPEAL_STATUS[appeal.status] || '未知',
      rejectReason: appeal.reject_reason,
      createdAt: appeal.created_at,
    } : null,
  };
}

/** API-078 评价列表 */
function reviewList(ctx) {
  const shop = S.shopOf(ctx);
  const { page, pageSize, offset } = S.pageOf(ctx);
  const where = ['r.shop_id = ?'];
  const params = [shop.id];

  if (ctx.query.productId) {
    const pid = Number(ctx.query.productId);
    if (Number.isInteger(pid) && pid > 0) { where.push('r.product_id = ?'); params.push(pid); }
  }
  if (ctx.query.score !== undefined && ctx.query.score !== '') {
    where.push('r.score = ?'); params.push(Number(ctx.query.score));
  }
  if (ctx.query.replied !== undefined && ctx.query.replied !== '') {
    where.push(S.truthy(ctx.query.replied) ? "r.reply IS NOT NULL AND r.reply <> ''" : "(r.reply IS NULL OR r.reply = '')");
  }
  const keyword = String(ctx.query.keyword || '').trim();
  if (keyword) {
    where.push('(r.content LIKE ? OR EXISTS (SELECT 1 FROM products p WHERE p.id = r.product_id AND p.name LIKE ?))');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  S.pushTimeRange(where, params, 'r.created_at', ctx.query.startAt || ctx.query.dateStart, ctx.query.endAt || ctx.query.dateEnd);

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) AS c FROM shop_reviews r ${whereSql}`, ...params).c;
  const rows = all(
    `SELECT r.* FROM shop_reviews r ${whereSql} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset,
  );
  const avg = get(
    'SELECT AVG(score) AS a, COUNT(*) AS c FROM shop_reviews WHERE shop_id = ? AND hidden = 0', shop.id,
  );
  return S.listResult(rows.map(toReviewApi), total, {
    page,
    pageSize,
    scoreAvg: avg?.a ? Number(Number(avg.a).toFixed(1)) : 0,
    unrepliedCount: get(
      "SELECT COUNT(*) AS c FROM shop_reviews WHERE shop_id = ? AND hidden = 0 AND (reply IS NULL OR reply = '')", shop.id,
    ).c,
    shopScore: Number((get('SELECT score FROM shops WHERE id = ?', shop.id).score / 10).toFixed(1)),
  });
}

/** API-079 评价回复（仅一次，不可修改） */
function reviewReply(ctx) {
  const shop = S.activeShop(ctx);
  const row = ownReview(shop.id, ctx.params.id);
  if (row.reply) {
    throw Errors.badRequest('评价回复不可修改，请删除后重新回复', { field: 'reply' });
  }
  const body = ctx.body || {};
  if (!String(body.content ?? '').trim()) throw Errors.badRequest('回复内容不能为空', { field: 'content' });
  const maxLen = config.getNumber('review_reply_max_len') || 500;
  const content = v.str(body.content, 'content', { min: 1, max: maxLen });
  S.assertNoBlockWord(content, 'content');

  run('UPDATE shop_reviews SET reply = ?, replied_at = ?, reply_deleted = 0, updated_at = ? WHERE id = ? AND shop_id = ?',
    content, now(), now(), row.id, shop.id);
  S.audit(ctx, '评价', '回复评价', 'shop_review', row.id, content);
  return toReviewApi(get('SELECT * FROM shop_reviews WHERE id = ?', row.id));
}

/** DELETE /api/seller/reviews/:id/reply 删除回复（留痕后可重新回复） */
function reviewReplyDelete(ctx) {
  const shop = S.activeShop(ctx);
  const row = ownReview(shop.id, ctx.params.id);
  if (!row.reply) throw Errors.badRequest('该评价暂无回复');
  run('UPDATE shop_reviews SET reply = NULL, replied_at = NULL, reply_deleted = 1, updated_at = ? WHERE id = ? AND shop_id = ?',
    now(), row.id, shop.id);
  S.audit(ctx, '评价', '删除评价回复', 'shop_review', row.id, `原回复：${row.reply}`);
  return { deleted: true, reviewId: row.id };
}

/** API-080 评价申诉（同一评价处理中不可重复申诉） */
function reviewAppeal(ctx) {
  const shop = S.activeShop(ctx);
  const row = ownReview(shop.id, ctx.params.id);
  const body = ctx.body || {};
  const reason = v.str(body.reason, 'reason', { min: 2, max: 300 });
  const evidence = S.strArray(body.evidence, 9);
  const running = get('SELECT * FROM review_appeals WHERE review_id = ? AND status = 0', row.id);
  if (running) throw Errors.badRequest('该评价申诉处理中');

  const id = run(
    `INSERT INTO review_appeals (review_id, shop_id, reason, evidence, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    row.id, shop.id, reason, JSON.stringify(evidence), now(), now(),
  ).lastInsertRowid;
  S.audit(ctx, '评价', '评价申诉', 'review_appeal', id, `评价 ${row.id}；原因：${reason}`);
  return {
    id,
    reviewId: row.id,
    reason,
    evidence,
    status: 0,
    statusName: APPEAL_STATUS[0],
    createdAt: now(),
  };
}

module.exports = function register(api) {
  api.get('/api/seller/reviews', { auth: 'seller' }, reviewList);
  api.post('/api/seller/reviews/:id/reply', { auth: 'seller' }, reviewReply);
  api.delete('/api/seller/reviews/:id/reply', { auth: 'seller' }, reviewReplyDelete);
  api.post('/api/seller/reviews/:id/appeal', { auth: 'seller' }, reviewAppeal);
};
