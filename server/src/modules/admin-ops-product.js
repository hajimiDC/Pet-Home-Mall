'use strict';

const db = require('../core/db');
const { get, all, run, transaction } = db;
const { now, toYuan, parseTime } = require('../core/money');
const { Errors } = require('../core/errors');
const v = require('../core/validate');
const svc = require('../services/admin-ops-service');

/**
 * 平台后台 · 运营域：商品上架审核 + 优选商品
 * 覆盖 API-104 ~ API-107（FR-OPS-017 ~ FR-OPS-021）
 *
 * 权限码：menu.ops.product-audit
 * 商品状态：0 草稿 / 1 待审核 / 2 已上架 / 3 已下架 / 4 审核驳回（schema 注释）
 */

const PERM_PRODUCT_AUDIT = 'menu.ops.product-audit';

const PRODUCT_SELECT = `
  SELECT p.*, s.name AS shop_name, s.logo AS shop_logo, c.name AS category_name
    FROM products p
    LEFT JOIN shops s ON s.id = p.shop_id
    LEFT JOIN categories c ON c.id = p.category_id`;

// ==================== API-104 商品审核列表 ====================

/**
 * GET /api/admin/product-audits
 * ?status=1（默认 1 待审核，status=all 查全部）&shopId=&categoryId=&keyword=&startAt=&endAt=&page=&pageSize=
 * 时间筛选维度：商品提交时间 created_at。
 */
function listProductAudits(ctx) {
  const params = [];
  let where = 'WHERE p.is_deleted = 0';
  const rawStatus = ctx.query.status;
  if (rawStatus === undefined || rawStatus === '' || rawStatus === null) {
    where += ' AND p.status = 1';
  } else if (String(rawStatus).toLowerCase() !== 'all') {
    where += ' AND p.status = ?';
    params.push(Number(v.oneOf(rawStatus, ['0', '1', '2', '3', '4'], 'status')));
  }
  if (ctx.query.shopId) { where += ' AND p.shop_id = ?'; params.push(v.int(ctx.query.shopId, 'shopId', { min: 1 })); }
  if (ctx.query.categoryId) {
    const categoryId = v.int(ctx.query.categoryId, 'categoryId', { min: 1 });
    const ids = svc.categorySubtreeIds(categoryId);
    where += ` AND p.category_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }
  if (ctx.query.keyword) {
    where += ' AND (p.name LIKE ? OR p.product_code LIKE ? OR s.name LIKE ?)';
    const kw = `%${String(ctx.query.keyword).trim()}%`;
    params.push(kw, kw, kw);
  }
  const startAt = svc.normTime(ctx.query.startAt, { field: 'startAt' });
  const endAt = svc.normTime(ctx.query.endAt, { field: 'endAt', endOfDay: true });
  if (startAt) { where += ' AND p.created_at >= ?'; params.push(startAt); }
  if (endAt) { where += ' AND p.created_at <= ?'; params.push(endAt); }

  const { page, pageSize, offset } = db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
  const total = Number(get(`SELECT COUNT(*) AS c FROM products p LEFT JOIN shops s ON s.id = p.shop_id ${where}`, ...params).c);
  const rows = all(`${PRODUCT_SELECT} ${where} ORDER BY p.created_at ASC, p.id ASC LIMIT ? OFFSET ?`, ...params, pageSize, offset)
    .map((p) => productAuditOut(p));

  return {
    total,
    rows,
    page,
    pageSize,
    pendingCount: Number(get('SELECT COUNT(*) AS c FROM products WHERE is_deleted = 0 AND status = 1').c),
  };
}

function productAuditOut(p) {
  const skus = all('SELECT id, spec_name, price, stock, status FROM skus WHERE product_id = ? ORDER BY id ASC', p.id);
  const minSkuPrice = skus.length ? Math.min(...skus.map((s) => Number(s.price))) : Number(p.price);
  return svc.productOut(p, {
    categoryPath: svc.categoryPath(p.category_id),
    skuCount: skus.length,
    minSkuPrice: toYuan(minSkuPrice),
    skus: skus.map((s) => ({ id: s.id, specName: s.spec_name, price: toYuan(s.price), stock: s.stock, status: s.status })),
    submittedAt: p.created_at,
  });
}

// ==================== API-105 商品审核操作 ====================

/**
 * POST /api/admin/product-audits/:id/audit
 * { action: 'approve' | 'reject' | 'modify-approve', rejectReason?, patch? }
 *  - approve：status=2（已上架），清空驳回原因
 *  - reject：rejectReason 必填（缺失 → 400「请填写驳回原因」），status=4 + audit_reason
 *  - modify-approve：先按 patch 修改商品信息（名称 / 价格 / 类目 / 主图等），再置 status=2
 * 额外支持 action='offline'（FR-OPS-019 商品违规强制下架，status=3，原因必填），属同一审核接口的处置能力。
 * 审核结果均写站内通知与操作日志（FR-BE-010 / FR-OPS-017）。
 */
function auditProduct(ctx) {
  const id = v.int(ctx.params.id, 'id', { min: 1 });
  const product = get(`${PRODUCT_SELECT} WHERE p.id = ?`, id);
  if (!product) throw Errors.notFound('商品不存在');
  if (Number(product.is_deleted) === 1) throw Errors.badRequest('商品已删除，无法审核');

  const body = ctx.body || {};
  const action = v.oneOf(body.action, ['approve', 'reject', 'modify-approve', 'offline'], 'action');
  const reason = String(body.rejectReason ?? body.auditReason ?? '').trim();

  if (action === 'reject' && !reason) throw Errors.badRequest('请填写驳回原因');
  if (action === 'offline' && !reason) throw Errors.badRequest('请填写下架原因');

  // 审核对象允许为任意未删除状态：待审核 → 正常审核；已上架 / 已下架 → 平台复核或违规处置（fromStatus 记入审计）

  const patchApplied = {};
  const nextStatus = action === 'reject' ? 4 : (action === 'offline' ? 3 : 2);
  const auditReason = action === 'approve' || action === 'modify-approve' ? null : reason;

  transaction(() => {
    if (action === 'modify-approve' && body.patch && typeof body.patch === 'object') {
      applyProductPatch(product, body.patch, patchApplied);
    }
    run('UPDATE products SET status = ?, audit_reason = ?, updated_at = ? WHERE id = ?',
      nextStatus, auditReason, now(), id);
  });

  const title = action === 'reject' ? '商品审核未通过' : (action === 'offline' ? '商品已被强制下架' : '商品审核通过');
  const content = action === 'reject'
    ? `您的商品「${product.name}」未通过平台审核，原因：${reason}。请修改后重新提交审核。`
    : (action === 'offline'
      ? `您的商品「${product.name}」已被平台强制下架，原因：${reason}。请整改后重新提交审核。`
      : `您的商品「${product.name}」已通过平台审核，现已上架。`);
  svc.notifySeller(product.shop_id, title, content);

  const actionName = { approve: '审核通过', reject: '审核驳回', 'modify-approve': '修改后通过', offline: '强制下架' }[action];
  svc.writeLog(ctx, {
    module: '商品审核', action: actionName, targetType: 'product', targetId: id,
    detail: { productName: product.name, shopId: product.shop_id, fromStatus: product.status, toStatus: nextStatus, reason: auditReason || '', patch: patchApplied },
  });

  const updated = get(`${PRODUCT_SELECT} WHERE p.id = ?`, id);
  return {
    id,
    action,
    actionName,
    status: nextStatus,
    statusName: svc.PRODUCT_STATUS[nextStatus] || '',
    auditReason: auditReason || '',
    patchApplied,
    product: productAuditOut(updated),
  };
}

/** 「修改后通过」允许平台修正的字段（价格按分入库，入参为元） */
function applyProductPatch(product, patch, applied) {
  const fields = [];
  const params = [];
  const set = (column, value, label) => { fields.push(`${column} = ?`); params.push(value); applied[label] = value; };

  if (patch.name !== undefined) {
    const name = v.str(patch.name, 'name', { min: 1, max: 100 });
    const dup = get('SELECT id FROM products WHERE shop_id = ? AND name = ? AND id <> ?', product.shop_id, name, product.id);
    if (dup) throw Errors.badRequest('同一店铺下商品名称不能重复');
    set('name', name, 'name');
  }
  if (patch.price !== undefined) {
    const cents = svc.cents(patch.price, 'price', { allowZero: false });
    set('price', cents, 'price');
    applied.priceYuan = toYuan(cents);
  }
  if (patch.originPrice !== undefined) {
    const cents = patch.originPrice === null || patch.originPrice === '' ? null : svc.cents(patch.originPrice, 'originPrice', { allowZero: false });
    set('origin_price', cents, 'originPrice');
    if (cents !== null) applied.originPriceYuan = toYuan(cents);
  }
  if (patch.categoryId !== undefined) {
    const categoryId = v.int(patch.categoryId, 'categoryId', { min: 1 });
    const category = get('SELECT id FROM categories WHERE id = ?', categoryId);
    if (!category) throw Errors.badRequest('类目不存在');
    set('category_id', categoryId, 'categoryId');
  }
  if (patch.mainImage !== undefined) set('main_image', String(patch.mainImage || '').trim(), 'mainImage');
  if (patch.brand !== undefined) set('brand', String(patch.brand || '').trim(), 'brand');
  if (patch.unit !== undefined) set('unit', String(patch.unit || '').trim(), 'unit');
  if (patch.detailHtml !== undefined) set('detail_html', String(patch.detailHtml || ''), 'detailHtml');
  if (patch.barcode !== undefined) set('product_code', String(patch.barcode || '').trim(), 'productCode');

  if (!fields.length) return;
  fields.push('updated_at = ?');
  params.push(now());
  run(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, ...params, product.id);
  Object.assign(product, patch);
}

// ==================== API-106 优选商品列表 ====================

/**
 * GET /api/admin/featured-products
 * 优选名单 + 商品快照。已下架 / 已删除商品自动剔除（FR-OPS-021）：
 *  - 列表读取时物理删除失效记录，并在 removed 中返回剔除原因，便于运营感知；
 *  - ?dryRun=1 只标记不删除（用于预览）。
 */
function listFeatured(ctx) {
  const rows = all(
    `SELECT fp.id AS featured_id, fp.product_id, fp.sort, fp.start_at, fp.end_at, fp.status, fp.created_at,
            p.name, p.main_image, p.price, p.origin_price, p.status AS product_status, p.is_deleted, p.shop_id,
            s.name AS shop_name, c.name AS category_name
       FROM featured_products fp
       LEFT JOIN products p ON p.id = fp.product_id
       LEFT JOIN shops s ON s.id = p.shop_id
       LEFT JOIN categories c ON c.id = p.category_id
      ORDER BY fp.sort ASC, fp.id ASC`,
  );

  const removed = [];
  const valid = [];
  for (const r of rows) {
    const reason = invalidFeaturedReason(r);
    if (reason) {
      removed.push({ featuredId: Number(r.featured_id), productId: Number(r.product_id), productName: r.name || '', reason });
    } else {
      valid.push(r);
    }
  }

  const dryRun = String(ctx.query.dryRun || '') === '1' || String(ctx.query.dryRun || '').toLowerCase() === 'true';
  if (removed.length && !dryRun) {
    transaction(() => {
      for (const item of removed) run('DELETE FROM featured_products WHERE id = ?', item.featuredId);
    });
  }

  const { page, pageSize, offset } = db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
  const keyword = String(ctx.query.keyword || '').trim();
  const filtered = keyword
    ? valid.filter((r) => String(r.name || '').includes(keyword) || String(r.shop_name || '').includes(keyword))
    : valid;
  const pageRows = filtered.slice(offset, offset + pageSize).map((r) => ({
    id: Number(r.featured_id),
    featuredId: Number(r.featured_id),
    productId: Number(r.product_id),
    productName: r.name || '',
    mainImage: r.main_image || '',
    shopId: r.shop_id,
    shopName: r.shop_name || '',
    categoryName: r.category_name || '',
    price: toYuan(r.price),
    originPrice: r.origin_price === null || r.origin_price === undefined ? null : toYuan(r.origin_price),
    productStatus: Number(r.product_status),
    productStatusName: svc.PRODUCT_STATUS[r.product_status] || '',
    sort: Number(r.sort || 0),
    startAt: r.start_at,
    endAt: r.end_at,
    status: Number(r.status),
    effective: featuredEffective(r),
    createdAt: r.created_at,
  }));

  return {
    total: filtered.length,
    rows: pageRows,
    page,
    pageSize,
    removed,
    removedCount: removed.length,
    dryRun,
    note: removed.length && !dryRun
      ? `已自动剔除 ${removed.length} 个失效商品（已下架 / 已删除），前台优选商品同步更新`
      : (removed.length ? '检测到失效商品，dryRun=1 未执行剔除' : ''),
  };
}

/** 优选条目失效原因（返回 null 表示有效） */
function invalidFeaturedReason(r) {
  if (!r.product_id || r.name === null || r.name === undefined) return '商品已删除';
  if (Number(r.is_deleted) === 1) return '商品已删除';
  if (Number(r.product_status) !== 2) return `商品已${svc.PRODUCT_STATUS[r.product_status] || '下架'}，自动剔除`;
  return null;
}

function featuredEffective(r) {
  if (Number(r.status ?? 1) !== 1) return 'offline';
  if (r.start_at && parseTime(r.start_at) > new Date()) return 'pending';
  if (r.end_at && parseTime(r.end_at) <= new Date()) return 'expired';
  return 'online';
}

// ==================== API-107 优选商品保存 ====================

/**
 * POST /api/admin/featured-products
 *  - 整体保存：{ productIds: [1,2,3], startAt?, endAt?, sort? }
 *  - 单条保存：{ productId, sort, startAt, endAt }
 * 已下架 / 已删除 / 不存在的商品自动跳过，并在 skipped 中返回原因（FR-OPS-021）。
 */
function saveFeatured(ctx) {
  const body = ctx.body || {};
  const ids = Array.isArray(body.productIds)
    ? body.productIds
    : (Array.isArray(body.items) ? body.items.map((item) => (typeof item === 'object' ? item?.productId : item)) : null);
  if (ids) return replaceFeatured(ctx, ids, body);
  return saveOneFeatured(ctx, body);
}

function checkFeaturedProduct(productId) {
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, productId, reason: '商品 ID 非法' };
  const p = get('SELECT id, name, status, is_deleted FROM products WHERE id = ?', id);
  if (!p) return { ok: false, productId: id, reason: '商品不存在' };
  if (Number(p.is_deleted) === 1) return { ok: false, productId: id, reason: '商品已删除' };
  if (Number(p.status) !== 2) return { ok: false, productId: id, reason: `商品已${svc.PRODUCT_STATUS[p.status] || '下架'}（status=${p.status}）` };
  return { ok: true, productId: id, product: p };
}

function replaceFeatured(ctx, rawIds, body) {
  if (!rawIds.length) throw Errors.badRequest('优选商品名单不能为空');
  if (rawIds.length > 200) throw Errors.badRequest('优选商品单次最多保存 200 个');
  const startAt = svc.normTime(body.startAt, { field: 'startAt' });
  const endAt = svc.normTime(body.endAt, { field: 'endAt', endOfDay: true });
  if (startAt && endAt && startAt >= endAt) throw Errors.badRequest('生效结束时间须晚于开始时间');
  const status = body.status !== undefined ? Number(v.oneOf(body.status, ['0', '1'], 'status')) : 1;

  const seen = new Set();
  const accepted = [];
  const skipped = [];
  rawIds.forEach((rawId, index) => {
    const check = checkFeaturedProduct(rawId);
    if (!check.ok) { skipped.push({ productId: check.productId, reason: check.reason }); return; }
    if (seen.has(check.productId)) return;
    seen.add(check.productId);
    accepted.push({ productId: check.productId, sort: index });
  });

  transaction(() => {
    run('DELETE FROM featured_products');
    for (const item of accepted) {
      run('INSERT INTO featured_products (product_id, sort, start_at, end_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        item.productId, item.sort, startAt, endAt, status, now());
    }
  });

  svc.writeLog(ctx, {
    module: '优选商品', action: '保存优选名单', targetType: 'featured_product', targetId: 'batch',
    detail: { saved: accepted.length, skipped, startAt, endAt },
  });

  return {
    mode: 'replace',
    saved: accepted.length,
    skipped,
    skippedCount: skipped.length,
    productIds: accepted.map((a) => a.productId),
    note: skipped.length ? `已跳过 ${skipped.length} 个不可用商品（已下架 / 已删除 / 不存在）` : '优选名单已全量覆盖保存',
  };
}

function saveOneFeatured(ctx, body) {
  const productId = v.int(body.productId, 'productId', { min: 1 });
  const check = checkFeaturedProduct(productId);
  if (!check.ok) throw Errors.badRequest(check.reason);

  const sort = body.sort !== undefined ? svc.intOr(body.sort, 'sort', 0) : Number(get('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM featured_products').s);
  const startAt = svc.normTime(body.startAt, { field: 'startAt' });
  const endAt = svc.normTime(body.endAt, { field: 'endAt', endOfDay: true });
  if (startAt && endAt && startAt >= endAt) throw Errors.badRequest('生效结束时间须晚于开始时间');
  const status = body.status !== undefined ? Number(v.oneOf(body.status, ['0', '1'], 'status')) : 1;

  const existing = get('SELECT * FROM featured_products WHERE product_id = ?', productId);
  if (existing) {
    run('UPDATE featured_products SET sort = ?, start_at = ?, end_at = ?, status = ? WHERE id = ?',
      sort, startAt ?? existing.start_at, endAt ?? existing.end_at, status, existing.id);
  } else {
    run('INSERT INTO featured_products (product_id, sort, start_at, end_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      productId, sort, startAt, endAt, status, now());
  }

  svc.writeLog(ctx, {
    module: '优选商品', action: existing ? '更新优选商品' : '新增优选商品', targetType: 'featured_product', targetId: productId,
    detail: { productId, sort, startAt, endAt, status },
  });

  const row = get('SELECT * FROM featured_products WHERE product_id = ?', productId);
  return {
    mode: 'single',
    updated: Boolean(existing),
    row: {
      id: Number(row.id),
      productId: Number(row.product_id),
      sort: Number(row.sort),
      startAt: row.start_at,
      endAt: row.end_at,
      status: Number(row.status),
      effective: featuredEffective(row),
    },
  };
}

module.exports = function register(api) {
  // API-104 / 105 商品上架审核（FR-OPS-017 ~ 019）
  api.get('/api/admin/product-audits', { auth: 'admin', perm: PERM_PRODUCT_AUDIT }, listProductAudits);
  api.post('/api/admin/product-audits/:id/audit', { auth: 'admin', perm: PERM_PRODUCT_AUDIT }, auditProduct);

  // API-106 / 107 优选商品（FR-OPS-020 ~ 021）
  api.get('/api/admin/featured-products', { auth: 'admin', perm: PERM_PRODUCT_AUDIT }, listFeatured);
  api.post('/api/admin/featured-products', { auth: 'admin', perm: PERM_PRODUCT_AUDIT }, saveFeatured);
};
