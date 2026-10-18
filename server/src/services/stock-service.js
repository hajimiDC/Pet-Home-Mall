'use strict';

const { get, run, all } = require('../core/db');
const { Errors } = require('../core/errors');
const { now } = require('../core/money');

/**
 * 库存服务（FR-SLR-040 ~ 045、FR-SLR-042、NFR-CONS-001/003、NFR-CONS-005）
 *
 * 口径（FR-SLR-043）：可售库存 = 总库存(stock) − 锁定库存(locked_stock)
 * 生命周期：
 *   下单 → reserve()   锁定库存 +q（总库存不变）        source=下单锁定
 *   支付 → deduct()    总库存 −q、锁定库存 −q           source=支付扣减
 *   取消/超时 → release() 锁定库存 −q                   source=取消回滚 / 超时回滚
 *   售后入库 → inbound()  总库存 +q                     source=退货入库
 * 并发安全：条件 UPDATE（stock - locked_stock >= ?）单语句原子完成，杜绝超卖。
 */

function skuRow(skuId) {
  const sku = get('SELECT * FROM skus WHERE id = ?', skuId);
  if (!sku) throw Errors.notFound('规格不存在');
  return sku;
}

function productRow(productId) {
  const p = get('SELECT * FROM products WHERE id = ?', productId);
  if (!p) throw Errors.notFound('商品不存在');
  return p;
}

function writeLog(entry) {
  run(
    `INSERT INTO stock_logs (sku_id, product_id, shop_id, source, change_qty, before_qty, after_qty,
       locked_before, locked_after, ref_no, operator_id, operator_name, remark, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    entry.skuId, entry.productId, entry.shopId, entry.source, entry.changeQty,
    entry.beforeQty, entry.afterQty, entry.lockedBefore, entry.lockedAfter,
    entry.refNo || null, entry.operatorId || null, entry.operatorName || '', entry.remark || '', now(),
  );
}

function syncProductTotals(productId) {
  const agg = get('SELECT COALESCE(SUM(stock),0) AS s, COALESCE(SUM(locked_stock),0) AS l, COALESCE(MIN(price),0) AS p FROM skus WHERE product_id = ?', productId);
  run('UPDATE products SET total_stock = ?, locked_stock = ?, price = CASE WHEN ? > 0 THEN ? ELSE price END, updated_at = ? WHERE id = ?',
    agg.s, agg.l, agg.p, agg.p, now(), productId);
  return agg;
}

function availableOf(sku) {
  return Math.max(0, sku.stock - sku.locked_stock);
}

/**
 * 锁定库存（下单）
 * @param {number} qty 正整数
 */
function reserve(skuId, qty, { refNo = '', operatorId = null, operatorName = '' } = {}) {
  if (!Number.isInteger(qty) || qty <= 0) throw Errors.badRequest('数量必须为正整数');
  const before = skuRow(skuId);
  const res = run(
    'UPDATE skus SET locked_stock = locked_stock + ?, version = version + 1, updated_at = ? WHERE id = ? AND stock - locked_stock >= ?',
    qty, now(), skuId, qty,
  );
  if (res.changes === 0) {
    const fresh = skuRow(skuId);
    throw Errors.badRequest(`商品「${productRow(fresh.product_id).name}」库存不足，剩余可售 ${availableOf(fresh)} 件`);
  }
  const after = skuRow(skuId);
  writeLog({
    skuId, productId: after.product_id, shopId: productRow(after.product_id).shop_id, source: '下单锁定',
    changeQty: 0, beforeQty: before.stock, afterQty: after.stock,
    lockedBefore: before.locked_stock, lockedAfter: after.locked_stock, refNo, operatorId, operatorName,
    remark: `锁定 ${qty} 件`,
  });
  syncProductTotals(after.product_id);
  return after;
}

/** 支付成功扣减（总库存与锁定库存同步减少） */
function deduct(skuId, qty, { refNo = '', operatorName = '系统' } = {}) {
  const before = skuRow(skuId);
  const res = run(
    `UPDATE skus SET stock = stock - ?, locked_stock = CASE WHEN locked_stock >= ? THEN locked_stock - ? ELSE 0 END,
       version = version + 1, updated_at = ? WHERE id = ? AND stock >= ?`,
    qty, qty, qty, now(), skuId, qty,
  );
  if (res.changes === 0) throw Errors.badRequest('库存扣减失败，库存不足');
  const after = skuRow(skuId);
  writeLog({
    skuId, productId: after.product_id, shopId: productRow(after.product_id).shop_id, source: '支付扣减',
    changeQty: -qty, beforeQty: before.stock, afterQty: after.stock,
    lockedBefore: before.locked_stock, lockedAfter: after.locked_stock, refNo, operatorName,
    remark: `支付扣减 ${qty} 件`,
  });
  syncProductTotals(after.product_id);
  return after;
}

/** 取消 / 超时回滚锁定库存（幂等：已释放则跳过） */
function release(skuId, qty, { refNo = '', source = '取消回滚', operatorName = '系统' } = {}) {
  const before = skuRow(skuId);
  if (before.locked_stock < qty) {
    return { skipped: true, sku: before };
  }
  const res = run(
    'UPDATE skus SET locked_stock = locked_stock - ?, version = version + 1, updated_at = ? WHERE id = ? AND locked_stock >= ?',
    qty, now(), skuId, qty,
  );
  if (res.changes === 0) return { skipped: true, sku: skuRow(skuId) };
  const after = skuRow(skuId);
  writeLog({
    skuId, productId: after.product_id, shopId: productRow(after.product_id).shop_id, source,
    changeQty: 0, beforeQty: before.stock, afterQty: after.stock,
    lockedBefore: before.locked_stock, lockedAfter: after.locked_stock, refNo, operatorName,
    remark: `释放锁定 ${qty} 件`,
  });
  syncProductTotals(after.product_id);
  return after;
}

/** 手工调整（设置绝对值 / 增减量），FR-SLR-041 / 045 */
function adjust(skuId, { mode = 'delta', value, reason, operatorId = null, operatorName = '' }) {
  if (!reason || !String(reason).trim()) throw Errors.badRequest('调整原因不能为空', { field: 'reason' });
  const before = skuRow(skuId);
  const n = Number(value);
  if (!Number.isInteger(n)) throw Errors.badRequest('调整值必须为整数', { field: 'value' });
  const target = mode === 'set' ? n : before.stock + n;
  if (target < 0) throw Errors.badRequest('库存不能为负数', { field: 'value' });
  if (target < before.locked_stock) {
    throw Errors.badRequest(`目标库存不能小于当前锁定库存 ${before.locked_stock}`, { field: 'value' });
  }
  const res = run(
    'UPDATE skus SET stock = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
    target, now(), skuId, before.version,
  );
  if (res.changes === 0) throw Errors.conflict('库存已被其他操作修改，请刷新后重试');
  const after = skuRow(skuId);
  writeLog({
    skuId, productId: after.product_id, shopId: productRow(after.product_id).shop_id, source: '手工调整',
    changeQty: target - before.stock, beforeQty: before.stock, afterQty: after.stock,
    lockedBefore: before.locked_stock, lockedAfter: after.locked_stock,
    operatorId, operatorName, remark: reason,
  });
  syncProductTotals(after.product_id);
  return after;
}

/** 入库 / 出库 / 退货入库 / 盘点（FR-WHS-004 ~ 010、FR-SLR-066） */
function changeStock(skuId, qty, { source, refNo = '', operatorId = null, operatorName = '', remark = '' }) {
  const before = skuRow(skuId);
  const target = before.stock + qty;
  if (target < 0) throw Errors.badRequest('出库数量超过当前总库存');
  if (target < before.locked_stock) throw Errors.badRequest('出库后库存不能小于锁定库存');
  run('UPDATE skus SET stock = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?', target, now(), skuId, before.version);
  const after = skuRow(skuId);
  writeLog({
    skuId, productId: after.product_id, shopId: productRow(after.product_id).shop_id, source,
    changeQty: qty, beforeQty: before.stock, afterQty: after.stock,
    lockedBefore: before.locked_stock, lockedAfter: after.locked_stock,
    refNo, operatorId, operatorName, remark,
  });
  syncProductTotals(after.product_id);
  return after;
}

/** 库存总览（商家端 / 平台端同源，FR-WHS-003） */
function listStocks({ shopId = null, keyword = '', warningOnly = false, page = 1, pageSize = 20 } = {}) {
  const where = ['p.is_deleted = 0'];
  const params = [];
  if (shopId) { where.push('p.shop_id = ?'); params.push(shopId); }
  if (keyword) { where.push('(p.name LIKE ? OR s.spec_name LIKE ? OR s.barcode LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  if (warningOnly) where.push('(s.stock - s.locked_stock) <= s.warn_stock');
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) AS c FROM skus s JOIN products p ON p.id = s.product_id ${whereSql}`, ...params).c;
  const rows = all(
    `SELECT s.*, p.name AS product_name, p.main_image, p.shop_id, sh.name AS shop_name
       FROM skus s JOIN products p ON p.id = s.product_id JOIN shops sh ON sh.id = p.shop_id
       ${whereSql} ORDER BY p.id DESC, s.id ASC LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize,
  );
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id, skuId: r.id, productId: r.product_id, productName: r.product_name, specName: r.spec_name,
      shopId: r.shop_id, shopName: r.shop_name, image: r.main_image, price: r.price / 100,
      totalStock: r.stock, lockedStock: r.locked_stock, availableStock: Math.max(0, r.stock - r.locked_stock),
      warnStock: r.warn_stock, warning: (r.stock - r.locked_stock) <= r.warn_stock, barcode: r.barcode,
    })),
  };
}

module.exports = {
  reserve, deduct, release, adjust, changeStock, availableOf, syncProductTotals, listStocks, skuRow, productRow,
};
