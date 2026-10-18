'use strict';

const { get, all, run, pagination, parseJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, toCents, parseTime } = require('../core/money');
const { maskName } = require('../core/privacy');
const config = require('../core/config');
const activitySvc = require('./activity-service');

/**
 * C 端商品 / 类目 / 店铺浏览服务（7.2 分类、8.2 商品列表、8.3 店铺街、8.4 商家详情、8.6 商品详情、7.3 搜索）
 *
 * 口径约定：
 *  - 商品前台可见：product.status = 2（已上架）且 is_deleted = 0 且 shops.status = 1（营业中）
 *  - 类目停用（status = 0）后该类目及其全部后代类目下的商品在前台不可见（FR-OPS-003）
 *  - 金额库内为「分」，对外统一 toYuan() 转元；分页单页 ≤ 20（NFR-PERF-005）
 */

const AFTER_SALE_POLICY = '交易完成后 15 天内可申请售后';

const PRICE_BUCKETS = [
  [0, 50], [50, 100], [100, 200], [200, 500], [500, null],
];

const SORT_ALIASES = {
  default: 'default', comprehensive: 'default', 综合: 'default',
  sales: 'sales', sale: 'sales', 销量: 'sales',
  priceasc: 'priceAsc', price_asc: 'priceAsc', 'price-asc': 'priceAsc', 价格升序: 'priceAsc',
  pricedesc: 'priceDesc', price_desc: 'priceDesc', 'price-desc': 'priceDesc', 价格降序: 'priceDesc',
  comments: 'comments', comment: 'comments', 评论: 'comments',
  newest: 'newest', new: 'newest', latest: 'newest', 上架时间: 'newest',
};

const ORDER_SQL = {
  default: '(fp.product_id IS NULL) ASC, fp.sort ASC, p.sales DESC, p.id DESC',
  sales: 'p.sales DESC, p.id DESC',
  priceAsc: 'p.price ASC, p.id ASC',
  priceDesc: 'p.price DESC, p.id DESC',
  comments: 'comment_count DESC, p.id DESC',
  newest: 'p.created_at DESC, p.id DESC',
};

const CARD_COLUMNS = `p.id, p.name, p.main_image, p.price, p.origin_price, p.sales, p.sales_volume,
    p.shop_id, p.category_id, p.brand, p.unit, p.created_at,
    sh.name AS shop_name, fp.product_id AS featured_id, fp.sort AS featured_sort,
    (SELECT COUNT(*) FROM shop_reviews r WHERE r.product_id = p.id AND r.hidden = 0) AS comment_count,
    (SELECT COALESCE(SUM(CASE WHEN s.status = 1 THEN MAX(s.stock - s.locked_stock, 0) ELSE 0 END), 0)
       FROM skus s WHERE s.product_id = p.id) AS available_stock`;

// ---------------- 通用小工具 ----------------

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function numParam(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw Errors.badRequest(`${field} 参数不合法`, { field });
  return n;
}

function priceParam(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const cents = toCents(value);
  if (cents === null || Number.isNaN(cents) || cents < 0) {
    throw Errors.badRequest('价格区间不合法', { field: 'price' });
  }
  return cents;
}

/** 分页信息（total / page / pageSize / totalPages；越界时 lastPage 提示） */
function pageInfoOf(total, page, pageSize, extra = {}) {
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
  const info = {
    total,
    page,
    pageSize,
    totalPages,
    requestedPage: extra.requestedPage ?? page,
    isLastPage: totalPages === 0 || page >= totalPages,
    lastPage: Boolean(extra.outOfRange),
    outOfRange: Boolean(extra.outOfRange),
    hasPrev: page > 1,
    hasNext: totalPages > 0 && page < totalPages,
  };
  if (extra.outOfRange) info.message = `页码超出范围，已停留在最后有效页（第 ${totalPages} 页）`;
  return info;
}

// ---------------- 类目树（API-010） ----------------

let categoryCache = { at: 0, rows: [], hidden: new Set() };

function categorySnapshot() {
  if (categoryCache.rows.length && Date.now() - categoryCache.at < 5000) return categoryCache;
  const rows = all('SELECT id, name, parent_id, level, icon, sort, status FROM categories ORDER BY level ASC, sort ASC, id ASC');
  const hidden = new Set(rows.filter((r) => r.status !== 1).map((r) => r.id));
  // 停用类目的后代同样在前台不可见（FR-OPS-003）
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rows) {
      if (!hidden.has(r.id) && hidden.has(Number(r.parent_id))) {
        hidden.add(r.id);
        changed = true;
      }
    }
  }
  categoryCache = { at: Date.now(), rows, hidden };
  return categoryCache;
}

/** 类目及其全部后代 id（列表筛选 categoryId 含后代，TC-CAT-001 / TC-GOODS-001） */
function descendantsOf(categoryId) {
  const cid = Number(categoryId);
  const { rows } = categorySnapshot();
  const result = [cid];
  const seen = new Set(result);
  for (let i = 0; i < result.length; i += 1) {
    for (const row of rows) {
      if (Number(row.parent_id) === result[i] && !seen.has(row.id)) {
        result.push(row.id);
        seen.add(row.id);
      }
    }
  }
  return result;
}

/** 类目路径（面包屑） */
function categoryPath(categoryId) {
  const { rows } = categorySnapshot();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path = [];
  let cur = byId.get(Number(categoryId));
  let guard = 0;
  while (cur && guard < 6) {
    path.unshift({ id: cur.id, name: cur.name, level: cur.level });
    cur = byId.get(Number(cur.parent_id));
    guard += 1;
  }
  return path;
}

function categoryTree({ level } = {}) {
  const snap = categorySnapshot();
  let maxLevel = Number(level);
  if (!Number.isInteger(maxLevel) || maxLevel < 1) maxLevel = 3;
  if (maxLevel > 3) maxLevel = 3;

  const storeRoot = snap.rows.find((r) => Number(r.parent_id) === 0 && (r.icon === 'store' || r.name === '到店'));
  const storeIds = storeRoot ? new Set(descendantsOf(storeRoot.id)) : new Set();

  const visible = snap.rows.filter((r) => !snap.hidden.has(r.id) && r.level <= maxLevel);
  const byParent = new Map();
  for (const row of visible) {
    const pid = Number(row.parent_id) || 0;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(row);
  }

  const build = (parentId) => (byParent.get(parentId) || []).map((row) => {
    const node = {
      id: row.id,
      name: row.name,
      parentId: Number(row.parent_id) || 0,
      level: row.level,
      icon: row.icon,
      sort: row.sort,
      isStore: storeIds.has(row.id),
    };
    if (row.level < maxLevel) node.children = build(row.id);
    return node;
  });

  const rows = build(0);
  const counts = { level1: 0, level2: 0, level3: 0 };
  for (const row of visible) counts[`level${row.level}`] = (counts[`level${row.level}`] || 0) + 1;
  return {
    total: rows.length,
    level: maxLevel,
    counts,
    storeCategoryId: storeRoot ? storeRoot.id : null,
    rows,
  };
}

// ---------------- 商品列表（API-011） ----------------

function featuredJoinParts() {
  const at = now();
  return {
    join: `LEFT JOIN (SELECT product_id, MIN(sort) AS sort FROM featured_products
        WHERE status = 1 AND (start_at IS NULL OR start_at = '' OR start_at <= ?)
          AND (end_at IS NULL OR end_at = '' OR end_at > ?)
        GROUP BY product_id) fp ON fp.product_id = p.id`,
    params: [at, at],
  };
}

function buildProductWhere(query = {}, { withBrand = true, withFeatured = false } = {}) {
  const conditions = ['p.status = 2', 'p.is_deleted = 0', 'sh.status = 1'];
  const params = [];

  const snap = categorySnapshot();
  if (snap.hidden.size) {
    const ids = [...snap.hidden];
    conditions.push(`p.category_id NOT IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  const categoryRaw = query.categoryId ?? query.category_id;
  if (categoryRaw !== undefined && categoryRaw !== null && String(categoryRaw).trim() !== '') {
    const cid = numParam(categoryRaw, 'categoryId');
    const ids = descendantsOf(cid);
    conditions.push(`p.category_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  const keyword = String(query.keyword ?? '').trim();
  if (keyword) {
    if (keyword.length > 50) throw Errors.badRequest('关键字长度不能超过 50 个字符', { field: 'keyword' });
    conditions.push('(p.name LIKE ? OR p.brand LIKE ? OR p.product_code LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  if (withBrand) {
    const brand = String(query.brand ?? '').trim();
    if (brand) {
      conditions.push('p.brand = ?');
      params.push(brand);
    }
  }

  const shopRaw = query.shopId ?? query.shop_id;
  if (shopRaw !== undefined && shopRaw !== null && String(shopRaw).trim() !== '') {
    const sid = numParam(shopRaw, 'shopId');
    conditions.push('p.shop_id = ?');
    params.push(sid);
  }

  const minCents = priceParam(query.minPrice);
  const maxCents = priceParam(query.maxPrice);
  if (minCents !== null && maxCents !== null && minCents > maxCents) {
    throw Errors.badRequest('价格区间不合法：最低价不能高于最高价', { field: 'price' });
  }
  if (minCents !== null) { conditions.push('p.price >= ?'); params.push(minCents); }
  if (maxCents !== null) { conditions.push('p.price <= ?'); params.push(maxCents); }

  if (withFeatured && isTruthy(query.featured)) conditions.push('fp.product_id IS NOT NULL');

  return { whereSql: `WHERE ${conditions.join(' AND ')}`, params };
}

function orderSqlOf(sortRaw) {
  const key = String(sortRaw ?? 'default').trim().toLowerCase().replace(/\s+/g, '');
  return ORDER_SQL[SORT_ALIASES[key] || 'default'];
}

function countCards(where) {
  const fj = featuredJoinParts();
  const from = `FROM products p JOIN shops sh ON sh.id = p.shop_id ${fj.join}`;
  return get(`SELECT COUNT(*) AS c ${from} ${where.whereSql}`, ...fj.params, ...where.params).c;
}

function queryCards({ whereSql, params = [], orderSql = ORDER_SQL.default, limit = 20, offset = 0 }) {
  const fj = featuredJoinParts();
  const from = `FROM products p JOIN shops sh ON sh.id = p.shop_id ${fj.join}`;
  const rows = all(
    `SELECT ${CARD_COLUMNS} ${from} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    ...fj.params, ...params, limit, offset,
  );
  return rows.map(toCard);
}

function toCard(row) {
  const availableStock = Math.max(0, Number(row.available_stock || 0));
  return {
    id: row.id,
    name: row.name,
    mainImage: row.main_image,
    price: toYuan(row.price),
    originPrice: row.origin_price === null || row.origin_price === undefined ? null : toYuan(row.origin_price),
    sales: Number(row.sales || 0),
    shopId: row.shop_id,
    shopName: row.shop_name,
    commentCount: Number(row.comment_count || 0),
    availableStock,
    brand: row.brand,
    unit: row.unit,
    categoryId: row.category_id,
    featured: row.featured_id !== null && row.featured_id !== undefined,
    soldOut: availableStock <= 0,
    url: `/products/${row.id}`,
  };
}

/** 左侧筛选：品牌 + 价格区间（品牌统计不含品牌自身条件，便于多选切换） */
function buildProductFilters(query = {}) {
  const where = buildProductWhere(query, { withBrand: false, withFeatured: true });
  const fj = featuredJoinParts();
  const from = `FROM products p JOIN shops sh ON sh.id = p.shop_id ${fj.join}`;

  const brands = all(
    `SELECT p.brand AS brand, COUNT(*) AS c ${from} ${where.whereSql}
        AND p.brand IS NOT NULL AND p.brand <> ''
      GROUP BY p.brand ORDER BY c DESC, p.brand ASC LIMIT 30`,
    ...fj.params, ...where.params,
  ).map((r) => ({ value: r.brand, label: r.brand, count: Number(r.c || 0) }));

  const agg = get(
    `SELECT MIN(p.price) AS min_price, MAX(p.price) AS max_price,
        SUM(CASE WHEN p.price < 5000 THEN 1 ELSE 0 END) AS b0,
        SUM(CASE WHEN p.price >= 5000 AND p.price < 10000 THEN 1 ELSE 0 END) AS b1,
        SUM(CASE WHEN p.price >= 10000 AND p.price < 20000 THEN 1 ELSE 0 END) AS b2,
        SUM(CASE WHEN p.price >= 20000 AND p.price < 50000 THEN 1 ELSE 0 END) AS b3,
        SUM(CASE WHEN p.price >= 50000 THEN 1 ELSE 0 END) AS b4
      ${from} ${where.whereSql}`,
    ...fj.params, ...where.params,
  ) || {};

  const priceRanges = PRICE_BUCKETS.map(([min, max], index) => ({
    label: max === null ? `${min} 元以上` : `${min}-${max} 元`,
    min,
    max,
    count: Number(agg[`b${index}`] || 0),
  }));

  return {
    brands,
    priceRanges,
    priceRange: {
      min: agg.min_price === null || agg.min_price === undefined ? null : toYuan(agg.min_price),
      max: agg.max_price === null || agg.max_price === undefined ? null : toYuan(agg.max_price),
    },
    sortOptions: [
      { value: 'default', label: '综合' },
      { value: 'sales', label: '销量' },
      { value: 'priceAsc', label: '价格升序' },
      { value: 'priceDesc', label: '价格降序' },
      { value: 'comments', label: '评论' },
      { value: 'newest', label: '上架时间' },
    ],
  };
}

function listProducts(query = {}) {
  const { page, pageSize } = pagination(query, { defaultSize: 20, maxSize: 20 });
  const where = buildProductWhere(query, { withBrand: true, withFeatured: true });
  const total = countCards(where);
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
  let pageNo = page;
  let outOfRange = false;
  if (totalPages > 0 && pageNo > totalPages) {
    pageNo = totalPages;
    outOfRange = true;
  }
  const rows = total > 0
    ? queryCards({
      whereSql: where.whereSql,
      params: where.params,
      orderSql: orderSqlOf(query.sort),
      limit: pageSize,
      offset: (pageNo - 1) * pageSize,
    })
    : [];
  return {
    total,
    rows,
    filters: buildProductFilters(query),
    pageInfo: pageInfoOf(total, pageNo, pageSize, { requestedPage: page, outOfRange }),
  };
}

// ---------------- 商品详情 / 评价 / 推荐（API-012 ~ 014） ----------------

function loadVisibleProduct(id) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) throw Errors.notFound('商品不存在或已下架');
  const row = get(
    `SELECT p.*, sh.status AS shop_status, sh.name AS shop_name
       FROM products p JOIN shops sh ON sh.id = p.shop_id WHERE p.id = ?`, pid,
  );
  const snap = categorySnapshot();
  if (!row || row.is_deleted || row.status !== 2 || row.shop_status !== 1 || snap.hidden.has(Number(row.category_id))) {
    throw Errors.notFound('商品不存在或已下架');
  }
  return row;
}

function reviewStats(productId) {
  const row = get('SELECT COUNT(*) AS c, AVG(score) AS a FROM shop_reviews WHERE product_id = ? AND hidden = 0', productId);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const item of all('SELECT score, COUNT(*) AS c FROM shop_reviews WHERE product_id = ? AND hidden = 0 GROUP BY score', productId)) {
    distribution[item.score] = Number(item.c || 0);
  }
  const count = Number(row?.c || 0);
  return {
    average: count ? Number(Number(row.a).toFixed(1)) : 0,
    count,
    distribution,
  };
}

function skuCards(productId) {
  return all('SELECT * FROM skus WHERE product_id = ? ORDER BY id ASC', productId).map((sku) => {
    const availableStock = Math.max(0, Number(sku.stock || 0) - Number(sku.locked_stock || 0));
    const soldOut = sku.status !== 1 || availableStock <= 0;
    return {
      id: sku.id,
      specName: sku.spec_name,
      specJson: parseJson(sku.spec_json, null),
      price: toYuan(sku.price),
      originPrice: sku.origin_price === null || sku.origin_price === undefined ? null : toYuan(sku.origin_price),
      stock: Number(sku.stock || 0),
      lockedStock: Number(sku.locked_stock || 0),
      availableStock,
      status: sku.status,
      statusName: sku.status === 1 ? '在售' : '停用',
      soldOut,
      disabled: soldOut,
      image: sku.image,
      barcode: sku.barcode,
    };
  });
}

function productActivities(productId, priceCents) {
  return activitySvc.activitiesOfProduct(productId).map((a) => ({
    id: a.id,
    title: a.title,
    type: a.type,
    ruleDesc: a.rule_desc,
    startAt: a.start_at,
    endAt: a.end_at,
    discount: toYuan(activitySvc.discountFor(a, Number(priceCents || 0))),
  }));
}

function productDetail(id) {
  const product = loadVisibleProduct(id);
  const shop = get('SELECT * FROM shops WHERE id = ?', product.shop_id);
  const skus = skuCards(product.id);
  const availableStock = skus.reduce((sum, sku) => sum + (sku.status === 1 ? sku.availableStock : 0), 0);
  const activities = productActivities(product.id, product.price);
  const productCount = get(
    'SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND status = 2 AND is_deleted = 0', shop.id,
  ).c;

  return {
    id: product.id,
    name: product.name,
    mainImage: product.main_image,
    images: parseJson(product.images, []) || [],
    detailHtml: product.detail_html,
    brand: product.brand,
    unit: product.unit,
    productCode: product.product_code,
    categoryId: product.category_id,
    categoryPath: categoryPath(product.category_id),
    price: toYuan(product.price),
    originPrice: product.origin_price === null || product.origin_price === undefined ? null : toYuan(product.origin_price),
    sales: Number(product.sales || 0),
    salesVolume: Number(product.sales_volume || 0),
    stock: availableStock,
    availableStock,
    soldOut: availableStock <= 0,
    status: product.status,
    skus,
    shop: {
      id: shop.id,
      name: shop.name,
      logo: shop.logo,
      banner: shop.banner,
      phone: shop.phone,
      score: Number((shop.score / 10).toFixed(1)),
      scoreText: (shop.score / 10).toFixed(1),
      productCount,
      url: `/shops/${shop.id}`,
    },
    activities,
    promotionTip: activities.length
      ? `当前活动：${activities.map((a) => a.ruleDesc || a.title).join('；')}`
      : null,
    reviewStats: reviewStats(product.id),
    afterSalePolicy: AFTER_SALE_POLICY,
    afterSale: {
      days: config.getNumber('aftersale_days'),
      policy: AFTER_SALE_POLICY,
      text: AFTER_SALE_POLICY,
    },
    createdAt: product.created_at,
  };
}

function productComments(id, query = {}) {
  const product = loadVisibleProduct(id);
  const { page, pageSize } = pagination(query, { defaultSize: 20, maxSize: 20 });
  const total = get('SELECT COUNT(*) AS c FROM shop_reviews WHERE product_id = ? AND hidden = 0', product.id).c;
  const rows = all(
    `SELECT r.*, u.nickname, u.username, u.avatar
       FROM shop_reviews r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.product_id = ? AND r.hidden = 0
      ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    product.id, pageSize, (page - 1) * pageSize,
  ).map((r) => ({
    id: r.id,
    score: r.score,
    content: r.content,
    images: parseJson(r.images, []) || [],
    reply: r.reply_deleted ? null : (r.reply || null),
    repliedAt: r.reply_deleted ? null : (r.replied_at || null),
    replied: Boolean(!r.reply_deleted && r.reply),
    nickname: maskName(r.nickname || r.username || '匿名用户'),
    avatar: r.avatar,
    createdAt: r.created_at,
  }));
  return {
    total,
    rows,
    stats: reviewStats(product.id),
    pageInfo: pageInfoOf(total, page, pageSize),
  };
}

function relatedProducts(id, { limit = 8 } = {}) {
  const product = loadVisibleProduct(id);
  const max = Math.min(20, Math.max(1, Number(limit) || 8));
  const snap = categorySnapshot();
  const conditions = [
    'p.status = 2', 'p.is_deleted = 0', 'sh.status = 1', 'p.id <> ?', '(p.shop_id = ? OR p.category_id = ?)',
  ];
  const params = [product.id, product.shop_id, product.category_id];
  if (snap.hidden.size) {
    const hiddenIds = [...snap.hidden];
    conditions.push(`p.category_id NOT IN (${hiddenIds.map(() => '?').join(',')})`);
    params.push(...hiddenIds);
  }
  // 同店优先，其次同类目；shop_id 取自库内整数，直接内联以避免 ORDER BY 占位符与 LIMIT 参数错位
  const sameShopFirst = `(p.shop_id = ${Number(product.shop_id)}) DESC`;
  const rows = queryCards({
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params,
    orderSql: `${sameShopFirst}, p.sales DESC, p.id DESC`,
    limit: max,
    offset: 0,
  });
  return { total: rows.length, rows };
}

// ---------------- 统一搜索（API-015） ----------------

function findBlockWord(keyword) {
  const at = now();
  const words = all(
    `SELECT word FROM search_words WHERE type = 'block'
        AND (start_at IS NULL OR start_at = '' OR start_at <= ?)
        AND (end_at IS NULL OR end_at = '' OR end_at > ?)`,
    at, at,
  );
  const lower = String(keyword).toLowerCase();
  const hit = words.find((w) => w.word && lower.includes(String(w.word).toLowerCase()));
  return hit ? hit.word : null;
}

const SEARCH_SCOPES = ['shop', 'product', 'activity', 'coupon'];

function search(query = {}) {
  const keyword = String(query.keyword ?? '').trim();
  if (!keyword) throw Errors.badRequest('请输入关键字', { field: 'keyword' });
  if (keyword.length > 50) throw Errors.badRequest('关键字长度不能超过 50 个字符', { field: 'keyword' });

  const scope = String(query.scope ?? 'product').trim();
  if (!SEARCH_SCOPES.includes(scope)) throw Errors.badRequest('搜索范围不合法', { field: 'scope' });

  const blockWord = findBlockWord(keyword);
  if (blockWord) {
    return { total: 0, rows: [], blocked: true, keyword, scope, msg: '搜索内容包含违规词' };
  }

  if (scope === 'shop') {
    return { ...listShops({ ...query, keyword }), scope, keyword, blocked: false };
  }
  if (scope === 'activity') {
    const { page, pageSize } = pagination(query, { defaultSize: 20, maxSize: 20 });
    const result = activitySvc.listActive({ keyword, page, pageSize });
    return {
      total: result.total,
      rows: result.rows,
      pageInfo: pageInfoOf(result.total, page, pageSize),
      scope,
      keyword,
      blocked: false,
    };
  }
  if (scope === 'coupon') {
    return { ...listCoupons({ ...query, keyword }, query.userId || null), scope, keyword, blocked: false };
  }
  return { ...listProducts({ ...query, keyword }), scope, keyword, blocked: false };
}

// ---------------- 店铺（API-016 ~ 019，供搜索 scope=shop 复用） ----------------

function shopCategoryNames(shop) {
  const ids = (parseJson(shop.category_ids, []) || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const names = [];
  for (const id of ids) {
    const row = get('SELECT name FROM categories WHERE id = ?', id);
    if (row) names.push(row.name);
  }
  if (names.length) return names;
  const rows = all(
    `SELECT DISTINCT CASE WHEN c3.level = 3 THEN COALESCE(c2.name, c3.name) ELSE c3.name END AS name
       FROM products p
       JOIN categories c3 ON c3.id = p.category_id
       LEFT JOIN categories c2 ON c2.id = c3.parent_id
      WHERE p.shop_id = ? AND p.status = 2 AND p.is_deleted = 0
      LIMIT 5`, shop.id,
  );
  return rows.map((r) => r.name).filter(Boolean);
}

function shopSortSql(sortRaw) {
  const key = String(sortRaw ?? 'score').trim().toLowerCase();
  if (key === 'sales' || key === '销量') {
    return '(SELECT COALESCE(SUM(p.sales), 0) FROM products p WHERE p.shop_id = s.id AND p.is_deleted = 0) DESC, s.id DESC';
  }
  if (key === 'new' || key === 'newest' || key === '上架时间') return 's.created_at DESC, s.id DESC';
  if (key === 'default' || key === '综合') return 's.score DESC, s.id ASC';
  return 's.score DESC, s.id DESC';
}

function toShopCard(row) {
  const categoryNames = shopCategoryNames(row);
  return {
    id: row.id,
    name: row.name,
    logo: row.logo,
    banner: row.banner,
    description: row.description,
    notice: row.notice,
    phone: row.phone,
    score: Number((row.score / 10).toFixed(1)),
    scoreText: (row.score / 10).toFixed(1),
    categoryNames,
    mainCategory: categoryNames[0] || '',
    productCount: Number(row.product_count || 0),
    salesTotal: Number(row.sales_total || 0),
    favoriteCount: Number(row.favorite_count || 0),
    recommended: Boolean(row.recommended),
    status: row.status,
    statusName: row.status === 1 ? '营业中' : '已停用',
    createdAt: row.created_at,
    url: `/shops/${row.id}`,
  };
}

function listShops(query = {}) {
  const { page, pageSize } = pagination(query, { defaultSize: 20, maxSize: 20 });
  const conditions = ['s.status = 1'];
  const params = [];
  const keyword = String(query.keyword ?? '').trim();
  if (keyword) {
    if (keyword.length > 50) throw Errors.badRequest('关键字长度不能超过 50 个字符', { field: 'keyword' });
    conditions.push('(s.name LIKE ? OR s.description LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const whereSql = `WHERE ${conditions.join(' AND ')}`;
  const at = now();
  const select = `SELECT s.*,
      (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 2 AND p.is_deleted = 0) AS product_count,
      (SELECT COALESCE(SUM(p.sales), 0) FROM products p WHERE p.shop_id = s.id AND p.is_deleted = 0) AS sales_total,
      (SELECT COUNT(*) FROM favorites f WHERE f.shop_id = s.id) AS favorite_count,
      EXISTS (SELECT 1 FROM shop_recommends sr WHERE sr.shop_id = s.id
                AND (sr.start_at IS NULL OR sr.start_at = '' OR sr.start_at <= ?)
                AND (sr.end_at IS NULL OR sr.end_at = '' OR sr.end_at > ?)) AS recommended
    FROM shops s`;
  const total = get(`SELECT COUNT(*) AS c FROM shops s ${whereSql}`, ...params).c;
  const rows = all(
    `${select} ${whereSql} ORDER BY ${shopSortSql(query.sort)} LIMIT ? OFFSET ?`,
    at, at, ...params, pageSize, (page - 1) * pageSize,
  ).map(toShopCard);
  return { total, rows, pageInfo: pageInfoOf(total, page, pageSize) };
}

function shopDetail(id, userId = null) {
  const sid = Number(id);
  if (!Number.isInteger(sid) || sid <= 0) throw Errors.notFound('店铺不存在或已停用');
  const shop = get('SELECT * FROM shops WHERE id = ?', sid);
  if (!shop || shop.status !== 1) throw Errors.notFound('店铺不存在或已停用');
  const at = now();
  const productCount = get(
    'SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND status = 2 AND is_deleted = 0', sid,
  ).c;
  const salesTotal = get('SELECT COALESCE(SUM(sales), 0) AS c FROM products WHERE shop_id = ? AND is_deleted = 0', sid).c;
  const favoriteCount = get('SELECT COUNT(*) AS c FROM favorites WHERE shop_id = ?', sid).c;
  const favorited = userId
    ? Boolean(get('SELECT id FROM favorites WHERE user_id = ? AND shop_id = ?', userId, sid))
    : false;
  const recommended = Boolean(get(
    `SELECT id FROM shop_recommends WHERE shop_id = ?
        AND (start_at IS NULL OR start_at = '' OR start_at <= ?)
        AND (end_at IS NULL OR end_at = '' OR end_at > ?) LIMIT 1`, sid, at, at,
  ));
  const categoryNames = shopCategoryNames(shop);
  return {
    id: shop.id,
    name: shop.name,
    logo: shop.logo,
    banner: shop.banner,
    description: shop.description,
    notice: shop.notice,
    phone: shop.phone,
    servicePhone: shop.phone,
    score: Number((shop.score / 10).toFixed(1)),
    scoreText: (shop.score / 10).toFixed(1),
    categoryNames,
    mainCategory: categoryNames[0] || '',
    productCount,
    salesTotal: Number(salesTotal || 0),
    favoriteCount: Number(favoriteCount || 0),
    favorited,
    recommended,
    status: shop.status,
    statusName: '营业中',
    createdAt: shop.created_at,
    url: `/shops/${shop.id}`,
  };
}

function shopProducts(id, query = {}) {
  const sid = Number(id);
  if (!Number.isInteger(sid) || sid <= 0) throw Errors.notFound('店铺不存在或已停用');
  const shop = get('SELECT id, status FROM shops WHERE id = ?', sid);
  if (!shop || shop.status !== 1) throw Errors.notFound('店铺不存在或已停用');
  return listProducts({ ...query, shopId: sid });
}

function shopActivities(id, query = {}) {
  const sid = Number(id);
  if (!Number.isInteger(sid) || sid <= 0) throw Errors.notFound('店铺不存在或已停用');
  const shop = get('SELECT id, status FROM shops WHERE id = ?', sid);
  if (!shop || shop.status !== 1) throw Errors.notFound('店铺不存在或已停用');
  const { page, pageSize } = pagination(query, { defaultSize: 20, maxSize: 20 });
  const result = activitySvc.listActive({
    keyword: String(query.keyword ?? '').trim(), shopId: sid, page, pageSize,
  });
  return { total: result.total, rows: result.rows, pageInfo: pageInfoOf(result.total, page, pageSize) };
}

// ---------------- 券中心（API-026 / 搜索 scope=coupon 复用） ----------------

const SCOPE_NAMES = ['全场通用', '指定类目', '指定商品', '指定店铺'];

function listCoupons(query = {}, userId = null) {
  const { page, pageSize } = pagination(query, { defaultSize: 20, maxSize: 20 });
  const at = now();
  const conditions = ['c.status = 1', 'c.start_at <= ?', 'c.end_at > ?'];
  const params = [at, at];

  const shopRaw = query.shopId ?? query.shop_id;
  if (shopRaw !== undefined && shopRaw !== null && String(shopRaw).trim() !== '') {
    const sid = Number(shopRaw);
    if (!Number.isInteger(sid) || sid < 0) throw Errors.badRequest('店铺参数不合法', { field: 'shopId' });
    conditions.push('c.shop_id = ?');
    params.push(sid);
  }

  const keyword = String(query.keyword ?? '').trim();
  if (keyword) {
    if (keyword.length > 50) throw Errors.badRequest('关键字长度不能超过 50 个字符', { field: 'keyword' });
    conditions.push('(c.name LIKE ? OR sh.name LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const whereSql = `WHERE ${conditions.join(' AND ')}`;
  const from = 'FROM coupons c LEFT JOIN shops sh ON sh.id = c.shop_id';
  const total = get(`SELECT COUNT(*) AS c ${from} ${whereSql}`, ...params).c;
  const rows = all(
    `SELECT c.*, sh.name AS shop_name ${from} ${whereSql}
      ORDER BY (c.shop_id = 0) DESC, c.amount DESC, c.id ASC LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize,
  );

  const mineMap = new Map();
  if (userId) {
    for (const m of all('SELECT coupon_id, COUNT(*) AS c FROM user_coupons WHERE user_id = ? GROUP BY coupon_id', userId)) {
      mineMap.set(m.coupon_id, Number(m.c || 0));
    }
  }

  const mapped = rows.map((coupon) => {
    const stock = Number(coupon.stock || 0);
    const received = Number(coupon.received || 0);
    const remain = Math.max(0, stock - received);
    const mineCount = mineMap.get(coupon.id) || 0;
    const limitPerUser = Number(coupon.limit_per_user || 1);
    const reachedLimit = mineCount >= limitPerUser;
    const soldOut = remain <= 0;
    let claimStatus = '可领取';
    if (reachedLimit) claimStatus = '已领取';
    else if (soldOut) claimStatus = '已抢光';
    const scopeType = coupon.scope_type || 1;
    const scopeIds = parseJson(coupon.scope_ids, []) || [];
    return {
      id: coupon.id,
      name: coupon.name,
      type: coupon.type,
      typeName: coupon.type === 2 ? '折扣券' : '满减券',
      shopId: coupon.shop_id,
      shopName: Number(coupon.shop_id) === 0 ? '平台券' : coupon.shop_name,
      source: Number(coupon.shop_id) === 0 ? '平台券' : '店铺券',
      threshold: toYuan(coupon.threshold),
      amount: toYuan(coupon.amount),
      discountRate: coupon.discount_rate,
      scopeType,
      scopeName: SCOPE_NAMES[scopeType - 1] || '全场通用',
      scopeIds,
      scopeText: scopeType === 1
        ? '全场通用'
        : `${SCOPE_NAMES[scopeType - 1]}（${scopeIds.length} 项）`,
      startAt: coupon.start_at,
      endAt: coupon.end_at,
      validDays: coupon.valid_days,
      stock,
      received,
      remain,
      soldOut,
      limitPerUser,
      claimType: coupon.claim_type,
      claimable: !reachedLimit && !soldOut,
      claimStatus,
      mine: userId ? { count: mineCount, reachedLimit } : null,
    };
  });

  return { total, rows: mapped, pageInfo: pageInfoOf(total, page, pageSize) };
}

module.exports = {
  AFTER_SALE_POLICY,
  SEARCH_SCOPES,
  pageInfoOf,
  isTruthy,
  numParam,
  categorySnapshot,
  descendantsOf,
  categoryPath,
  categoryTree,
  listProducts,
  productDetail,
  productComments,
  relatedProducts,
  reviewStats,
  search,
  findBlockWord,
  listShops,
  shopDetail,
  shopProducts,
  shopActivities,
  shopCategoryNames,
  listCoupons,
  SCOPE_NAMES,
};
