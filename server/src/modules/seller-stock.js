'use strict';

const { get, all } = require('../core/db');
const { Errors } = require('../core/errors');
const v = require('../core/validate');
const stockSvc = require('../services/stock-service');
const S = require('../services/seller-service');

/**
 * 商家端 · 库存管理
 * API-068 ~ API-070（FR-SLR-040 ~ 045、BR-SLR-011 / 012 / 013、9.3.5）
 * 库存调整统一走 services/stock-service.js（乐观锁 + stock_log 流水）。
 */

const SOURCE_NAMES = ['下单锁定', '支付扣减', '取消回滚', '超时回滚', '手工调整', '退货入库', '出入库', '盘点'];

function ownSku(shopId, skuId) {
  const row = get(
    `SELECT s.*, p.shop_id, p.name AS product_name FROM skus s
       JOIN products p ON p.id = s.product_id
      WHERE s.id = ? AND p.shop_id = ? AND p.is_deleted = 0`,
    Number(skuId), shopId,
  );
  if (!row) throw Errors.notFound('规格不存在');
  return row;
}

/** API-068 库存列表 */
function stockList(ctx) {
  const shop = S.shopOf(ctx);
  const { page, pageSize } = S.pageOf(ctx);
  const keyword = String(ctx.query.keyword || '').trim();
  const warningOnly = S.truthy(ctx.query.warningOnly) || S.truthy(ctx.query.warning)
    || ctx.query.stockRange === 'warning';
  const result = stockSvc.listStocks({
    shopId: shop.id,
    keyword,
    warningOnly,
    page,
    pageSize,
  });
  const warningCount = get(
    `SELECT COUNT(*) AS c FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.shop_id = ? AND p.is_deleted = 0 AND (s.stock - s.locked_stock) <= s.warn_stock`,
    shop.id,
  ).c;
  return S.listResult(result.rows, result.total, { page, pageSize, warningCount });
}

/** API-069 库存调整（设置绝对值 / 增减量，原因必填） */
function stockAdjust(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  v.requireFields(body, ['skuId', 'value', 'reason']);
  const sku = ownSku(shop.id, body.skuId);
  const mode = String(body.mode || 'delta').trim();
  if (!['set', 'delta'].includes(mode)) {
    throw Errors.badRequest('调整方式仅支持 set（设置绝对值）或 delta（增减量）', { field: 'mode' });
  }
  const value = Number(body.value);
  if (!Number.isInteger(value)) throw Errors.badRequest('调整值必须为整数', { field: 'value' });
  const reason = v.str(body.reason, 'reason', { min: 1, max: 200 });

  const target = mode === 'set' ? value : sku.stock + value;
  if (target < 0) throw Errors.badRequest('库存不能为负数', { field: 'value' });
  if (target < sku.locked_stock) {
    throw Errors.badRequest(`目标库存不能小于当前锁定库存 ${sku.locked_stock}`, { field: 'value' });
  }

  const after = stockSvc.adjust(sku.id, {
    mode,
    value,
    reason,
    operatorId: ctx.admin.id,
    operatorName: ctx.admin.name || ctx.admin.account,
  });

  S.audit(ctx, '库存', '库存调整', 'sku', sku.id,
    `${sku.product_name} / ${sku.spec_name}：${mode === 'set' ? '设置为' : '增减'} ${mode === 'set' ? value : value}，`
    + `变动前 ${sku.stock} → 变动后 ${after.stock}；原因：${reason}`);

  return {
    skuId: after.id,
    productId: after.product_id,
    specName: after.spec_name,
    beforeStock: sku.stock,
    afterStock: after.stock,
    lockedStock: after.locked_stock,
    availableStock: Math.max(0, after.stock - after.locked_stock),
    changeQty: after.stock - sku.stock,
    mode,
    reason,
  };
}

/** API-070 库存流水（按 SKU / 来源 / 时间筛选） */
function stockLogs(ctx) {
  const shop = S.shopOf(ctx);
  const { page, pageSize, offset } = S.pageOf(ctx);
  const where = ['l.shop_id = ?'];
  const params = [shop.id];

  if (ctx.query.skuId) {
    const skuId = Number(ctx.query.skuId);
    if (Number.isInteger(skuId) && skuId > 0) { where.push('l.sku_id = ?'); params.push(skuId); }
  }
  const keyword = String(ctx.query.keyword || '').trim();
  if (keyword) {
    where.push('(p.name LIKE ? OR s.spec_name LIKE ? OR s.barcode LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (ctx.query.source) { where.push('l.source = ?'); params.push(String(ctx.query.source)); }
  S.pushTimeRange(where, params, 'l.created_at', ctx.query.startAt || ctx.query.dateStart, ctx.query.endAt || ctx.query.dateEnd);

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const from = `FROM stock_logs l
      LEFT JOIN skus s ON s.id = l.sku_id
      LEFT JOIN products p ON p.id = l.product_id`;
  const total = get(`SELECT COUNT(*) AS c ${from} ${whereSql}`, ...params).c;
  const rows = all(
    `SELECT l.*, p.name AS product_name, s.spec_name ${from} ${whereSql}
      ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset,
  );
  return S.listResult(rows.map((r) => ({
    id: r.id,
    skuId: r.sku_id,
    productId: r.product_id,
    productName: r.product_name,
    specName: r.spec_name,
    source: r.source,
    changeQty: r.change_qty,
    beforeQty: r.before_qty,
    afterQty: r.after_qty,
    lockedBefore: r.locked_before,
    lockedAfter: r.locked_after,
    availableAfter: Math.max(0, r.after_qty - r.locked_after),
    refNo: r.ref_no,
    operatorId: r.operator_id,
    operatorName: r.operator_name || (r.operator_id ? '' : '系统'),
    remark: r.remark,
    createdAt: r.created_at,
  })), total, { page, pageSize, sources: SOURCE_NAMES });
}

module.exports = function register(api) {
  api.get('/api/seller/stocks', { auth: 'seller' }, stockList);
  api.get('/api/seller/stocks/logs', { auth: 'seller' }, stockLogs);
  api.post('/api/seller/stocks/adjust', { auth: 'seller' }, stockAdjust);
};
