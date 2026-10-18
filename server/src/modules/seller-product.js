'use strict';

const { get, all, run } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan } = require('../core/money');
const v = require('../core/validate');
const config = require('../core/config');
const S = require('../services/seller-service');

/**
 * 商家端 · 商品管理
 * API-061 ~ API-067（FR-SLR-030 ~ 038、BR-SLR-008 / 009 / 010、9.3.4）
 */

const STATUS_NAME = { 0: '草稿', 1: '待审核', 2: '已上架', 3: '已下架', 4: '审核驳回' };

function ownProduct(shopId, id) {
  const p = get('SELECT * FROM products WHERE id = ? AND shop_id = ? AND is_deleted = 0', Number(id), shopId);
  if (!p) throw Errors.notFound('商品不存在');
  return p;
}

function toSkuApi(row) {
  return {
    id: row.id,
    skuId: row.id,
    specName: row.spec_name,
    specJson: S.parseJson(row.spec_json, null),
    price: toYuan(row.price),
    originPrice: row.origin_price === null ? null : toYuan(row.origin_price),
    stock: row.stock,
    lockedStock: row.locked_stock,
    availableStock: Math.max(0, row.stock - row.locked_stock),
    warnStock: row.warn_stock,
    barcode: row.barcode,
    image: row.image,
    status: row.status,
  };
}

function priceRangeOf(productId, fallback) {
  const row = get('SELECT MIN(price) AS min, MAX(price) AS max FROM skus WHERE product_id = ? AND status = 1', productId);
  const min = row?.min ?? fallback;
  const max = row?.max ?? fallback;
  return { priceMin: toYuan(min), priceMax: toYuan(max) };
}

function toProductApi(row, { withSkus = false } = {}) {
  const cat = get('SELECT id, name, level FROM categories WHERE id = ?', row.category_id);
  const range = priceRangeOf(row.id, row.price);
  const base = {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    categoryName: cat?.name || '',
    categoryPath: categoryPath(cat),
    mainImage: row.main_image,
    images: S.parseJson(row.images, []) || [],
    detailHtml: row.detail_html,
    brand: row.brand,
    unit: row.unit,
    productCode: row.product_code,
    price: toYuan(row.price),
    originPrice: row.origin_price === null ? null : toYuan(row.origin_price),
    priceMin: range.priceMin,
    priceMax: range.priceMax,
    totalStock: row.total_stock,
    lockedStock: row.locked_stock,
    availableStock: Math.max(0, row.total_stock - row.locked_stock),
    warnStock: row.warn_stock,
    sales: row.sales,
    status: row.status,
    statusName: STATUS_NAME[row.status] || '未知',
    auditReason: row.audit_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (withSkus) {
    base.skus = all('SELECT * FROM skus WHERE product_id = ? ORDER BY id ASC', row.id).map(toSkuApi);
    base.canDelete = get('SELECT COUNT(*) AS c FROM order_items WHERE product_id = ?', row.id).c === 0;
    base.canPublish = Boolean(row.main_image);
  }
  return base;
}

function categoryPath(cat) {
  if (!cat) return '';
  const names = [cat.name];
  let cur = cat;
  const guard = new Set();
  while (cur && cur.parent_id && !guard.has(cur.parent_id)) {
    guard.add(cur.parent_id);
    const parent = get('SELECT id, name, parent_id FROM categories WHERE id = ?', cur.parent_id);
    if (!parent) break;
    names.unshift(parent.name);
    cur = parent;
  }
  return names.join(' > ');
}

/** API-061 商品列表 */
function productList(ctx) {
  const shop = S.shopOf(ctx);
  const { page, pageSize, offset } = S.pageOf(ctx);
  const where = ['p.shop_id = ?', 'p.is_deleted = 0'];
  const params = [shop.id];

  const keyword = String(ctx.query.keyword || ctx.query.name || '').trim();
  if (keyword) { where.push('p.name LIKE ?'); params.push(`%${keyword}%`); }
  if (ctx.query.categoryId) {
    const cid = Number(ctx.query.categoryId);
    if (Number.isInteger(cid) && cid > 0) {
      where.push('(p.category_id = ? OR p.category_id IN (SELECT id FROM categories WHERE parent_id = ?))');
      params.push(cid, cid);
    }
  }
  if (ctx.query.status !== undefined && ctx.query.status !== '') {
    where.push('p.status = ?');
    params.push(Number(ctx.query.status));
  }
  S.pushTimeRange(where, params, 'p.created_at', ctx.query.startAt || ctx.query.dateStart, ctx.query.endAt || ctx.query.dateEnd);
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) AS c FROM products p ${whereSql}`, ...params).c;
  const rows = all(`SELECT p.* FROM products p ${whereSql} ORDER BY p.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
  const counts = {
    draft: get('SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND is_deleted = 0 AND status = 0', shop.id).c,
    pending: get('SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND is_deleted = 0 AND status = 1', shop.id).c,
    onSale: get('SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND is_deleted = 0 AND status = 2', shop.id).c,
    offSale: get('SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND is_deleted = 0 AND status = 3', shop.id).c,
    rejected: get('SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND is_deleted = 0 AND status = 4', shop.id).c,
  };
  return S.listResult(rows.map((r) => toProductApi(r)), total, { page, pageSize, counts });
}

/** API-062 商品详情（含 SKU） */
function productDetail(ctx) {
  const shop = S.shopOf(ctx);
  const p = ownProduct(shop.id, ctx.params.id);
  return toProductApi(p, { withSkus: true });
}

/* ---------------- 入参解析 ---------------- */

function normalizeSkus(body) {
  const raw = S.asArray(body.skus);
  const list = [];
  if (!raw.length) {
    const price = v.money(body.price, 'price', { min: 1 });
    const stock = body.stock === undefined || body.stock === '' ? 0 : v.int(body.stock, 'stock', { min: 0 });
    list.push({ id: null, specName: '默认', specJson: null, price, stock, barcode: null, image: null, originPrice: null });
    return list;
  }
  const seen = new Set();
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') throw Errors.badRequest(`第 ${index + 1} 个规格格式不正确`, { field: 'skus' });
    const specName = String(item.specName || '').trim() || (raw.length === 1 ? '默认' : `规格${index + 1}`);
    if (seen.has(specName)) throw Errors.badRequest(`规格名称重复：${specName}`, { field: 'skus' });
    seen.add(specName);
    const price = v.money(item.price, 'price', { min: 1 });
    const stock = item.stock === undefined || item.stock === '' ? 0 : v.int(item.stock, 'stock', { min: 0 });
    let specJson = item.specJson;
    if (specJson !== undefined && specJson !== null && specJson !== '') {
      if (typeof specJson === 'object') specJson = JSON.stringify(specJson);
      else {
        try { JSON.parse(String(specJson)); } catch (_) { throw Errors.badRequest('规格 JSON 格式不正确', { field: 'skus' }); }
        specJson = String(specJson);
      }
    } else {
      specJson = null;
    }
    let originPrice = null;
    if (item.originPrice !== undefined && item.originPrice !== null && item.originPrice !== '') {
      originPrice = v.money(item.originPrice, 'originPrice', { min: 0, allowZero: true });
      if (originPrice < price) throw Errors.badRequest('划线价不得低于售价', { field: 'skus' });
    }
    list.push({
      id: item.id ? Number(item.id) : null,
      specName,
      specJson,
      price,
      stock,
      barcode: item.barcode ? String(item.barcode).trim().slice(0, 64) : null,
      image: item.image ? String(item.image).trim() : null,
      originPrice,
    });
  });
  return list;
}

function parseProductPayload(body) {
  const name = v.str(body.name, 'name', { min: 2, max: 100 });
  S.assertNoBlockWord(name, 'name');
  const categoryId = v.int(body.categoryId, 'categoryId', { min: 1 });
  const cat = S.leafCategory(categoryId);
  const mainImage = body.mainImage ? String(body.mainImage).trim() : '';
  const images = S.strArray(body.images, 9);
  const detailHtml = body.detailHtml !== undefined ? String(body.detailHtml || '') : '';
  const brand = body.brand ? String(body.brand).trim().slice(0, 50) : null;
  const unit = body.unit ? String(body.unit).trim().slice(0, 20) : null;
  const productCode = body.productCode ? String(body.productCode).trim().slice(0, 64) : null;
  const skus = normalizeSkus(body);
  return { name, categoryId, cat, mainImage, images, detailHtml, brand, unit, productCode, skus };
}

function isPublish(body) {
  if (body.publish !== undefined) return S.truthy(body.publish);
  if (body.submit !== undefined) return S.truthy(body.submit);
  return String(body.status) === '1' || String(body.status) === '2';
}

function publishStatus() {
  return config.getBool('product_audit_enabled') ? 1 : 2;
}

function assertNameUnique(shopId, name, excludeId = null) {
  const row = excludeId
    ? get('SELECT id FROM products WHERE shop_id = ? AND name = ? AND id <> ?', shopId, name, excludeId)
    : get('SELECT id FROM products WHERE shop_id = ? AND name = ?', shopId, name);
  if (row) throw Errors.badRequest('同店商品名称不允许重复', { field: 'name' });
}

function minPriceOf(skus) {
  return skus.reduce((min, s) => (s.price < min ? s.price : min), skus[0].price);
}

function recalcProduct(productId) {
  const row = get(
    `SELECT COALESCE(SUM(stock),0) AS s, COALESCE(SUM(locked_stock),0) AS l,
            COALESCE(MIN(CASE WHEN status = 1 THEN price END), 0) AS p
       FROM skus WHERE product_id = ?`, productId,
  );
  run(
    `UPDATE products SET total_stock = ?, locked_stock = ?,
        price = CASE WHEN ? > 0 THEN ? ELSE price END, updated_at = ?
      WHERE id = ?`,
    row.s, row.l, row.p, row.p, now(), productId,
  );
}

/** API-063 新增商品 */
function productCreate(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  const data = parseProductPayload(body);
  assertNameUnique(shop.id, data.name);

  const publish = isPublish(body);
  if (publish && !data.mainImage) {
    throw Errors.badRequest('请上传商品主图后再提交上架', { field: 'mainImage' });
  }
  const status = publish ? publishStatus() : 0;

  const productId = run(
    `INSERT INTO products (shop_id, category_id, name, main_image, images, detail_html, brand, unit, product_code,
        price, origin_price, sales, total_stock, locked_stock, warn_stock, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, ?, ?, ?, ?)`,
    shop.id, data.categoryId, data.name, data.mainImage || null, JSON.stringify(data.images), data.detailHtml,
    data.brand, data.unit, data.productCode, minPriceOf(data.skus),
    body.warnStock === undefined ? 0 : v.int(body.warnStock, 'warnStock', { min: 0 }),
    status, now(), now(),
  ).lastInsertRowid;

  for (const sku of data.skus) {
    run(
      `INSERT INTO skus (product_id, spec_name, spec_json, price, origin_price, stock, locked_stock, warn_stock,
          barcode, image, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1, ?, ?)`,
      productId, sku.specName, sku.specJson, sku.price, sku.originPrice, sku.stock, sku.barcode, sku.image, now(), now(),
    );
  }
  recalcProduct(productId);

  S.audit(ctx, '商品', '新增商品', 'product', productId,
    `${data.name}；SKU ${data.skus.length} 个；状态 ${STATUS_NAME[status]}`);
  return toProductApi(get('SELECT * FROM products WHERE id = ?', productId), { withSkus: true });
}

/** API-064 更新商品（含 SKU 增删改） */
function productUpdate(ctx) {
  const shop = S.activeShop(ctx);
  const exist = ownProduct(shop.id, ctx.params.id);
  const body = ctx.body || {};
  const data = parseProductPayload(body);
  assertNameUnique(shop.id, data.name, exist.id);

  const publish = body.publish === undefined && body.submit === undefined
    ? exist.status === 2 || exist.status === 1
    : isPublish(body);
  const mainImage = data.mainImage || exist.main_image || '';
  if (publish && !mainImage) throw Errors.badRequest('请上传商品主图后再提交上架', { field: 'mainImage' });

  run(
    `UPDATE products SET category_id = ?, name = ?, main_image = ?, images = ?, detail_html = ?, brand = ?, unit = ?,
        product_code = ?, warn_stock = ?, updated_at = ?
     WHERE id = ? AND shop_id = ?`,
    data.categoryId, data.name, mainImage, JSON.stringify(data.images), data.detailHtml, data.brand, data.unit,
    data.productCode,
    body.warnStock === undefined ? exist.warn_stock : v.int(body.warnStock, 'warnStock', { min: 0 }),
    now(), exist.id, shop.id,
  );

  syncSkus(exist.id, data.skus);
  recalcProduct(exist.id);

  S.audit(ctx, '商品', '更新商品', 'product', exist.id, `${data.name}；SKU ${data.skus.length} 个`);
  return toProductApi(get('SELECT * FROM products WHERE id = ?', exist.id), { withSkus: true });
}

function syncSkus(productId, skus) {
  const existing = all('SELECT * FROM skus WHERE product_id = ?', productId);
  const keep = new Set();
  for (const sku of skus) {
    if (sku.id) {
      const row = existing.find((x) => x.id === sku.id);
      if (!row) throw Errors.badRequest('规格不属于该商品', { field: 'skus' });
      keep.add(row.id);
      run(
        `UPDATE skus SET spec_name = ?, spec_json = ?, price = ?, origin_price = ?, stock = ?, barcode = ?, image = ?,
            version = version + 1, updated_at = ?
         WHERE id = ? AND product_id = ?`,
        sku.specName, sku.specJson, sku.price, sku.originPrice, sku.stock, sku.barcode, sku.image, now(),
        row.id, productId,
      );
    } else {
      const newId = run(
        `INSERT INTO skus (product_id, spec_name, spec_json, price, origin_price, stock, locked_stock, warn_stock,
            barcode, image, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1, ?, ?)`,
        productId, sku.specName, sku.specJson, sku.price, sku.originPrice, sku.stock, sku.barcode, sku.image, now(), now(),
      ).lastInsertRowid;
      keep.add(newId);
    }
  }
  for (const row of existing) {
    if (keep.has(row.id)) continue;
    const referenced = get('SELECT COUNT(*) AS c FROM order_items WHERE sku_id = ?', row.id).c;
    if (referenced > 0) {
      // 已产生订单的规格只停用，保留可追溯
      run('UPDATE skus SET status = 0, stock = 0, updated_at = ? WHERE id = ?', now(), row.id);
    } else {
      run('DELETE FROM skus WHERE id = ? AND product_id = ?', row.id, productId);
    }
  }
}

/** API-065 商品上下架 */
function productStatus(ctx) {
  const shop = S.activeShop(ctx);
  const p = ownProduct(shop.id, ctx.params.id);
  const body = ctx.body || {};
  const action = String(body.action ?? body.status ?? '').trim();
  const ups = ['on', 'up', '上架', '1', '2'];
  const downs = ['off', 'down', '下架', '3'];

  if (downs.includes(action)) {
    if (p.status === 3) throw Errors.badRequest('商品已下架');
    run('UPDATE products SET status = 3, updated_at = ? WHERE id = ? AND shop_id = ?', now(), p.id, shop.id);
    S.audit(ctx, '商品', '商品下架', 'product', p.id, p.name);
    return toProductApi(get('SELECT * FROM products WHERE id = ?', p.id));
  }
  if (!ups.includes(action)) throw Errors.badRequest('上下架动作不合法（上架 / 下架）', { field: 'action' });

  if (!p.main_image) throw Errors.badRequest('请先上传商品主图后再上架', { field: 'mainImage' });
  if (p.status === 1) throw Errors.badRequest('商品正在审核中，请等待审核结果');
  if (p.status === 2) throw Errors.badRequest('商品已上架');
  const skuCount = get('SELECT COUNT(*) AS c FROM skus WHERE product_id = ? AND status = 1', p.id).c;
  if (!skuCount) throw Errors.badRequest('请先维护商品规格后再上架');

  const target = publishStatus();
  run('UPDATE products SET status = ?, audit_reason = NULL, updated_at = ? WHERE id = ? AND shop_id = ?',
    target, now(), p.id, shop.id);
  S.audit(ctx, '商品', '提交上架', 'product', p.id, `${p.name}；状态 ${STATUS_NAME[target]}`);
  return {
    ...toProductApi(get('SELECT * FROM products WHERE id = ?', p.id)),
    needAudit: target === 1,
    tip: target === 1 ? '已提交平台审核，审核通过后前台可见' : '已上架，前台可见',
  };
}

/** API-066 批量上下架（返回影响条数与逐条结果） */
function productBatchStatus(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  const ids = S.asArray(body.ids).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) throw Errors.badRequest('请选择要操作的商品', { field: 'ids' });
  const action = String(body.action ?? body.status ?? '').trim();
  const results = [];
  let affected = 0;
  for (const id of ids) {
    try {
      const result = productStatus({ ...ctx, params: { id }, body: { action } });
      affected += 1;
      results.push({ id, ok: true, status: result.status, statusName: result.statusName, msg: result.tip || '操作成功' });
    } catch (err) {
      results.push({ id, ok: false, msg: err.message });
    }
  }
  S.audit(ctx, '商品', '批量上下架', 'product', ids.join(','), `动作 ${action}；影响 ${affected} 条`);
  return { affected, total: ids.length, results };
}

/** API-067 逻辑删除 */
function productDelete(ctx) {
  const shop = S.activeShop(ctx);
  const p = ownProduct(shop.id, ctx.params.id);
  const ordered = get('SELECT COUNT(*) AS c FROM order_items WHERE product_id = ?', p.id).c;
  if (ordered > 0) throw Errors.badRequest('该商品已产生订单，仅允许下架');
  run('UPDATE products SET is_deleted = 1, status = 3, updated_at = ? WHERE id = ? AND shop_id = ?', now(), p.id, shop.id);
  S.audit(ctx, '商品', '删除商品', 'product', p.id, p.name);
  return { deleted: true, id: p.id };
}

module.exports = function register(api) {
  api.get('/api/seller/products', { auth: 'seller' }, productList);
  api.patch('/api/seller/products/batch/status', { auth: 'seller' }, productBatchStatus);
  api.get('/api/seller/products/:id', { auth: 'seller' }, productDetail);
  api.post('/api/seller/products', { auth: 'seller' }, productCreate);
  api.put('/api/seller/products/:id', { auth: 'seller' }, productUpdate);
  api.patch('/api/seller/products/:id/status', { auth: 'seller' }, productStatus);
  api.delete('/api/seller/products/:id', { auth: 'seller' }, productDelete);
};
