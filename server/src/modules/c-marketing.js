'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { get, all, run, pagination, parseJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, parseTime } = require('../core/money');
const { UPLOAD_DIR } = require('../core/http');
const activitySvc = require('../services/activity-service');
const couponSvc = require('../services/coupon-service');
const catalog = require('../services/catalog-service');

/**
 * C 端营销与内容位（API-024 ~ API-027、API-045 ~ API-047）
 * 覆盖：8.7 商家活动列表、8.8 商家活动详情、8.9 优惠卡券、7.5 右侧菜单栏推荐位、8.1 首页轮播、8.4 / 8.13 图片上传
 */

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MIME_EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png' };
const UPLOAD_ERR = '仅支持 JPG/PNG，单张不超过 5MB';

function pageOf(query) {
  return pagination(query, { defaultSize: 20, maxSize: 20 });
}

// ---------------- API-024 / API-025 商家活动 ----------------

function listActivities(query = {}) {
  const { page, pageSize } = pageOf(query);
  const keyword = String(query.keyword ?? '').trim();
  const result = activitySvc.listActive({ keyword, page, pageSize });
  return {
    total: result.total,
    rows: result.rows,
    pageInfo: catalog.pageInfoOf(result.total, page, pageSize),
  };
}

function activityProductsOf(activityId) {
  const snap = catalog.categorySnapshot();
  return all(
    `SELECT p.id, p.name, p.main_image, p.price, p.origin_price, p.status, p.is_deleted, p.category_id, p.sales,
            sh.id AS shop_id, sh.name AS shop_name, sh.status AS shop_status,
            (SELECT COALESCE(SUM(CASE WHEN s.status = 1 THEN MAX(s.stock - s.locked_stock, 0) ELSE 0 END), 0)
               FROM skus s WHERE s.product_id = p.id) AS available_stock
       FROM activity_products ap
       JOIN products p ON p.id = ap.product_id
       JOIN shops sh ON sh.id = p.shop_id
      WHERE ap.activity_id = ?
      ORDER BY p.id ASC`,
    activityId,
  ).filter((p) => !p.is_deleted).map((p) => {
    const availableStock = Math.max(0, Number(p.available_stock || 0));
    const buyable = p.status === 2
      && p.shop_status === 1
      && !snap.hidden.has(Number(p.category_id))
      && availableStock > 0;
    return {
      id: p.id,
      name: p.name,
      image: p.main_image,
      price: toYuan(p.price),
      originPrice: p.origin_price === null || p.origin_price === undefined ? null : toYuan(p.origin_price),
      sales: Number(p.sales || 0),
      availableStock,
      soldOut: availableStock <= 0,
      buyable,
      shopId: p.shop_id,
      shopName: p.shop_name,
      status: p.status,
      statusName: ['草稿', '待审核', '已上架', '已下架', '审核驳回'][p.status] || '',
      url: `/products/${p.id}`,
    };
  });
}

function activityDetail(id) {
  const aid = Number(id);
  if (!Number.isInteger(aid) || aid <= 0) throw Errors.notFound('活动不存在或已下线');
  const row = get(
    `SELECT a.*, s.name AS shop_name, s.logo AS shop_logo, s.phone AS shop_phone, s.score AS shop_score
       FROM activities a JOIN shops s ON s.id = a.shop_id
      WHERE a.id = ?`, aid,
  );
  // 待审核 / 已驳回 / 强制下线的活动前台不展示（FR-OPS-031 / FR-OPS-032）
  if (!row || row.status === 0 || row.status === 2 || row.status === 4) {
    throw Errors.notFound('活动不存在或已下线');
  }
  run('UPDATE activities SET views = views + 1 WHERE id = ?', aid);
  const views = Number(row.views || 0) + 1;

  const detail = activitySvc.toApi({ ...row, views });
  const ended = row.status === 3 || parseTime(row.end_at) <= parseTime(now());
  const started = parseTime(row.start_at) <= parseTime(now());
  const products = activityProductsOf(aid);

  return {
    ...detail,
    id: row.id,
    title: row.title,
    type: row.type,
    image: row.image,
    content: row.content,
    ruleDesc: row.rule_desc,
    startAt: row.start_at,
    endAt: row.end_at,
    views,
    shop: {
      id: row.shop_id,
      name: row.shop_name,
      logo: row.shop_logo,
      phone: row.shop_phone,
      score: Number((Number(row.shop_score || 0) / 10).toFixed(1)),
      url: `/shops/${row.shop_id}`,
    },
    shopId: row.shop_id,
    shopName: row.shop_name,
    shopLogo: row.shop_logo,
    products,
    productCount: products.length,
    started,
    ended,
    endedText: ended ? '活动已结束' : null,
    statusName: ended ? '已结束' : '进行中',
    url: `/activities/${row.id}`,
  };
}

// ---------------- API-026 / API-027 优惠券 ----------------

function claimCoupon(userId, couponId) {
  const cid = Number(couponId);
  if (!Number.isInteger(cid) || cid <= 0) throw Errors.notFound('优惠券不存在');
  const result = couponSvc.claim(userId, cid);
  return {
    claimed: true,
    ...result,
    shopId: get('SELECT shop_id FROM coupons WHERE id = ?', cid)?.shop_id ?? null,
    message: '领取成功，可在「我的优惠券」中查看',
  };
}

// ---------------- API-045 推荐位（右侧菜单栏） ----------------

const RECOMMEND_TABS = ['shop', 'product', 'activity'];

function visibleProductRow(productId) {
  const row = get(
    `SELECT p.*, sh.name AS shop_name, sh.status AS shop_status
       FROM products p JOIN shops sh ON sh.id = p.shop_id WHERE p.id = ?`, productId,
  );
  const snap = catalog.categorySnapshot();
  if (!row || row.is_deleted || row.status !== 2 || row.shop_status !== 1 || snap.hidden.has(Number(row.category_id))) {
    return null;
  }
  return row;
}

function recommendItem(tab, slot) {
  if (tab === 'shop') {
    const shop = get('SELECT * FROM shops WHERE id = ? AND status = 1', slot.target_id);
    if (!shop) return null;
    const categoryNames = catalog.shopCategoryNames(shop);
    return {
      id: slot.id,
      tab,
      targetId: shop.id,
      sort: slot.sort,
      name: shop.name,
      image: shop.logo,
      description: shop.description,
      subtitle: categoryNames[0] || '',
      score: Number((shop.score / 10).toFixed(1)),
      url: `/shops/${shop.id}`,
    };
  }
  if (tab === 'product') {
    const product = visibleProductRow(slot.target_id);
    if (!product) return null;
    return {
      id: slot.id,
      tab,
      targetId: product.id,
      sort: slot.sort,
      name: product.name,
      image: product.main_image,
      subtitle: product.shop_name,
      price: toYuan(product.price),
      originPrice: product.origin_price === null || product.origin_price === undefined ? null : toYuan(product.origin_price),
      shopId: product.shop_id,
      shopName: product.shop_name,
      url: `/products/${product.id}`,
    };
  }
  const activity = get(
    `SELECT a.*, s.name AS shop_name FROM activities a JOIN shops s ON s.id = a.shop_id
      WHERE a.id = ? AND a.status = 1 AND a.start_at <= ? AND a.end_at > ?`,
    slot.target_id, now(), now(),
  );
  if (!activity) return null;
  return {
    id: slot.id,
    tab,
    targetId: activity.id,
    sort: slot.sort,
    name: activity.title,
    image: activity.image,
    subtitle: activity.shop_name,
    startAt: activity.start_at,
    endAt: activity.end_at,
    shopId: activity.shop_id,
    shopName: activity.shop_name,
    url: `/activities/${activity.id}`,
  };
}

function listRecommends(query = {}) {
  const tab = String(query.tab ?? 'shop').trim() || 'shop';
  if (!RECOMMEND_TABS.includes(tab)) {
    throw Errors.badRequest('推荐位类型不合法（shop / product / activity）', { field: 'tab' });
  }
  const at = now();
  const slots = all(
    `SELECT * FROM recommend_slots WHERE tab_type = ?
        AND (start_at IS NULL OR start_at = '' OR start_at <= ?)
        AND (end_at IS NULL OR end_at = '' OR end_at > ?)
      ORDER BY sort ASC, id ASC`,
    tab, at, at,
  );
  const rows = [];
  for (const slot of slots) {
    const item = recommendItem(tab, slot);
    if (item) rows.push(item); // 目标已下架 / 停用 → 隐藏该项（BR-RSIDE-003）
  }
  return { tab, total: rows.length, rows };
}

// ---------------- API-046 轮播图 ----------------

function listBanners(query = {}) {
  const position = String(query.position ?? 'home').trim() || 'home';
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
  const at = now();
  const rows = all(
    `SELECT id, title, position, image, link, sort, start_at, end_at FROM banners
      WHERE status = 1 AND position = ?
        AND (start_at IS NULL OR start_at = '' OR start_at <= ?)
        AND (end_at IS NULL OR end_at = '' OR end_at > ?)
      ORDER BY sort ASC, id ASC LIMIT ?`,
    position, at, at, limit,
  );
  return {
    total: rows.length,
    position,
    rows: rows.map((b) => ({
      id: b.id,
      title: b.title,
      position: b.position,
      image: b.image,
      link: b.link,
      sort: b.sort,
      startAt: b.start_at,
      endAt: b.end_at,
    })),
  };
}

// ---------------- API-047 图片上传 ----------------

function uploadImage(body = {}) {
  const originalFilename = String(body.filename ?? '').trim();
  let contentType = String(body.contentType ?? body.content_type ?? '').trim().toLowerCase();
  let data = String(body.data ?? body.base64 ?? body.content ?? '').trim();

  const dataUrl = /^data:([^;,]+);base64,(.*)$/i.exec(data);
  if (dataUrl) {
    if (!contentType) contentType = String(dataUrl[1]).toLowerCase();
    data = dataUrl[2];
  }

  let ext = MIME_EXT[contentType];
  if (!ext && originalFilename) {
    const lower = originalFilename.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
      ext = '.jpg';
      contentType = contentType || 'image/jpeg';
    } else if (lower.endsWith('.png')) {
      ext = '.png';
      contentType = contentType || 'image/png';
    }
  }
  if (!ext) throw Errors.badRequest(UPLOAD_ERR, { field: 'contentType' });
  if (!data) throw Errors.badRequest('请上传图片内容（data 为 base64）', { field: 'data' });

  // base64 长度预判，避免无谓的大内存解码（4/3 膨胀 + 少量填充）
  if (Math.ceil((data.length * 3) / 4) > MAX_UPLOAD_BYTES + 3) {
    throw Errors.badRequest(UPLOAD_ERR, { field: 'data' });
  }
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw Errors.badRequest('图片内容不是合法的 Base64', { field: 'data' });
  if (buf.length > MAX_UPLOAD_BYTES) throw Errors.badRequest(UPLOAD_ERR, { field: 'data' });

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const storedName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buf);

  return {
    url: `/uploads/${storedName}`,
    size: buf.length,
    filename: originalFilename || storedName,
    storedName,
    contentType,
  };
}

module.exports = function register(api) {
  // API-024 商家活动列表（仅进行中，开始时间倒序）
  api.get('/api/activities', {}, (ctx) => listActivities(ctx.query));

  // API-025 活动详情（含关联商品、所属店铺、活动已结束标记，views + 1）
  api.get('/api/activities/:id', {}, (ctx) => activityDetail(ctx.params.id));

  // API-026 优惠券列表（券中心；登录时附带 mine 已领数量与是否达上限）
  api.get('/api/coupons', { optionalUser: true }, (ctx) => catalog.listCoupons(ctx.query, ctx.user ? ctx.user.id : null));

  // API-027 领取优惠券（限流 10 次 / 60 秒，幂等拦截重复领取）
  api.post('/api/coupons/:id/claim', { auth: 'user', rate: { limit: 10, window: 60 } }, (ctx) => claimCoupon(ctx.user.id, ctx.params.id));

  // API-045 推荐位内容（右侧菜单栏：推荐商家 / 推荐商品 / 最新活动）
  api.get('/api/recommends', {}, (ctx) => listRecommends(ctx.query));

  // API-046 轮播图列表（生效时间内，按 sort）
  api.get('/api/banners', {}, (ctx) => listBanners(ctx.query));

  // API-047 上传图片（JPG / PNG，单张 ≤ 5MB）
  api.post('/api/upload', { auth: 'user', rate: { limit: 30, window: 60 } }, (ctx) => uploadImage(ctx.body));
};

module.exports.listActivities = listActivities;
module.exports.activityDetail = activityDetail;
module.exports.claimCoupon = claimCoupon;
module.exports.listRecommends = listRecommends;
module.exports.listBanners = listBanners;
module.exports.uploadImage = uploadImage;
