'use strict';

const { get, all, run, transaction } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan } = require('../core/money');
const stock = require('../services/stock-service');

/**
 * 购物车（8.16、FR-CART-001 ~ 009、Q-004）
 * 规则：
 *  - 同一用户同一 SKU 合并为一条并累加数量（12.1）
 *  - 数量最小 1，超过可售库存自动截断并提示（FR-CART-002）
 *  - 支持勾选结算与全选 / 反选；商品下架 / 售罄行标失效且不可结算（FR-CART-009）
 */

function ensureCart(userId) {
  let cart = get('SELECT * FROM carts WHERE user_id = ?', userId);
  if (!cart) {
    const res = run('INSERT INTO carts (user_id, updated_at) VALUES (?, ?)', userId, now());
    cart = get('SELECT * FROM carts WHERE id = ?', res.lastInsertRowid);
  }
  return cart;
}

function statusOf(product, shop, sku) {
  if (!product || product.is_deleted) return { valid: false, reason: '商品已删除' };
  if (product.status === 3) return { valid: false, reason: '商品已下架' };
  if (product.status === 4) return { valid: false, reason: '商品审核未通过' };
  if (product.status === 0) return { valid: false, reason: '商品未上架' };
  if (product.status === 1) return { valid: false, reason: '商品审核中' };
  if (!shop || shop.status !== 1) return { valid: false, reason: '店铺已停用' };
  if (sku.stock - sku.locked_stock <= 0) return { valid: false, reason: '已售罄' };
  return { valid: true, reason: null };
}

function rowsOf(cartId) {
  return all(
    `SELECT ci.*, s.price AS sku_price, s.origin_price AS sku_origin, s.stock, s.locked_stock, s.spec_name,
            s.image AS sku_image, p.name AS product_name, p.main_image, p.shop_id, p.status AS product_status,
            p.is_deleted, sh.name AS shop_name, sh.status AS shop_status
       FROM cart_items ci
       JOIN skus s ON s.id = ci.sku_id
       JOIN products p ON p.id = ci.product_id
       JOIN shops sh ON sh.id = p.shop_id
      WHERE ci.cart_id = ? ORDER BY ci.id DESC`,
    cartId,
  );
}

function list(userId) {
  const cart = ensureCart(userId);
  const rows = rowsOf(cart.id);
  let goodsAmount = 0; let checkedAmount = 0; let totalQuantity = 0; let checkedQuantity = 0; let checkedCount = 0;
  const items = rows.map((r) => {
    const product = get('SELECT * FROM products WHERE id = ?', r.product_id);
    const shop = get('SELECT * FROM shops WHERE id = ?', r.shop_id);
    const sku = get('SELECT * FROM skus WHERE id = ?', r.sku_id);
    const st = statusOf(product, shop, sku);
    const available = Math.max(0, r.stock - r.locked_stock);
    const quantity = Math.min(r.quantity, Math.max(available, 0)) || r.quantity;
    const subtotal = r.sku_price * quantity;
    goodsAmount += subtotal;
    totalQuantity += quantity;
    if (r.checked === 1 && st.valid) { checkedAmount += subtotal; checkedQuantity += quantity; checkedCount += 1; }
    return {
      id: r.id, productId: r.product_id, skuId: r.sku_id, shopId: r.shop_id, shopName: r.shop_name,
      productName: r.product_name, specName: r.spec_name, image: r.sku_image || r.main_image,
      price: toYuan(r.sku_price), originPrice: r.sku_origin ? toYuan(r.sku_origin) : null,
      quantity, checked: r.checked === 1, subtotal: toYuan(subtotal),
      stock: available, availableStock: available,
      valid: st.valid, invalidReason: st.reason,
      checkoutable: st.valid,
    };
  });
  return {
    cartId: cart.id,
    items,
    totalQuantity,
    checkedQuantity,
    checkedCount,
    goodsAmount: toYuan(goodsAmount),
    checkedAmount: toYuan(checkedAmount),
    canCheckout: checkedCount > 0,
    empty: items.length === 0,
    emptyText: '购物车内暂时没有商品',
  };
}

function add(userId, body = {}) {
  const productId = Number(body.productId);
  const skuId = Number(body.skuId);
  let quantity = Number(body.quantity ?? 1);
  if (!skuId) throw Errors.badRequest('请选择规格', { field: 'skuId' });
  if (!Number.isInteger(quantity) || quantity < 1) throw Errors.badRequest('数量最小为 1', { field: 'quantity' });
  const sku = get('SELECT * FROM skus WHERE id = ?', skuId);
  if (!sku) throw Errors.notFound('规格不存在');
  const product = get('SELECT * FROM products WHERE id = ?', sku.product_id);
  const shop = get('SELECT * FROM shops WHERE id = ?', product.shop_id);
  const st = statusOf(product, shop, sku);
  if (!st.valid) throw Errors.badRequest(`无法加入购物车：${st.reason}`);
  if (productId && Number(productId) !== product.id) throw Errors.badRequest('商品与规格不匹配');
  const available = stock.availableOf(sku);
  let truncated = false;
  if (quantity > available) { quantity = available; truncated = true; }
  const cart = ensureCart(userId);
  let message = '商品已加入购物车！';
  const id = transaction(() => {
    const exist = get('SELECT * FROM cart_items WHERE cart_id = ? AND sku_id = ?', cart.id, skuId);
    if (exist) {
      const target = Math.min(exist.quantity + quantity, available);
      if (target < exist.quantity + quantity) truncated = true;
      run('UPDATE cart_items SET quantity = ?, checked = 1, updated_at = ? WHERE id = ?', target, now(), exist.id);
      return exist.id;
    }
    return run(`INSERT INTO cart_items (cart_id, product_id, sku_id, quantity, checked, created_at, updated_at)
                VALUES (?, ?, ?, ?, 1, ?, ?)`, cart.id, product.id, skuId, quantity, now(), now()).lastInsertRowid;
  });
  if (truncated) message = `库存不足，已调整为可售库存 ${available} 件`;
  return { ...list(userId), addedItemId: id, message, truncated };
}

function updateQuantity(userId, itemId, body = {}) {
  const cart = ensureCart(userId);
  const item = get('SELECT * FROM cart_items WHERE id = ? AND cart_id = ?', Number(itemId), cart.id);
  if (!item) throw Errors.notFound('购物车条目不存在');
  let quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) throw Errors.badRequest('数量最小为 1', { field: 'quantity' });
  const sku = get('SELECT * FROM skus WHERE id = ?', item.sku_id);
  const available = stock.availableOf(sku);
  let truncated = false;
  if (quantity > available) { quantity = available; truncated = true; }
  if (quantity < 1) throw Errors.badRequest('该商品库存不足');
  run('UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ?', quantity, now(), item.id);
  return { ...list(userId), truncated, message: truncated ? `已调整为可售库存 ${available} 件` : 'success' };
}

function check(userId, itemId, body = {}) {
  const cart = ensureCart(userId);
  const item = get('SELECT * FROM cart_items WHERE id = ? AND cart_id = ?', Number(itemId), cart.id);
  if (!item) throw Errors.notFound('购物车条目不存在');
  const checked = body.checked === undefined ? (item.checked === 1 ? 0 : 1) : (body.checked ? 1 : 0);
  run('UPDATE cart_items SET checked = ?, updated_at = ? WHERE id = ?', checked, now(), item.id);
  return list(userId);
}

function checkAll(userId, body = {}) {
  const cart = ensureCart(userId);
  const checked = body.checked ? 1 : 0;
  run('UPDATE cart_items SET checked = ?, updated_at = ? WHERE cart_id = ?', checked, now(), cart.id);
  return list(userId);
}

function remove(userId, itemId) {
  const cart = ensureCart(userId);
  const item = get('SELECT * FROM cart_items WHERE id = ? AND cart_id = ?', Number(itemId), cart.id);
  if (!item) throw Errors.notFound('购物车条目不存在');
  run('DELETE FROM cart_items WHERE id = ?', item.id);
  return list(userId);
}

function clear(userId) {
  const cart = ensureCart(userId);
  run('DELETE FROM cart_items WHERE cart_id = ?', cart.id);
  return list(userId);
}

module.exports = function register(api) {
  // API-031 购物车列表
  api.get('/api/cart', { auth: 'user' }, (ctx) => list(ctx.user.id));
  // API-032 加入购物车
  api.post('/api/cart/items', { auth: 'user' }, (ctx) => add(ctx.user.id, ctx.body));
  // API-033 修改数量
  api.put('/api/cart/items/:id', { auth: 'user' }, (ctx) => updateQuantity(ctx.user.id, ctx.params.id, ctx.body));
  // API-034 勾选 / 取消勾选；支持全选（itemId = all）
  api.put('/api/cart/items/:id/checked', { auth: 'user' }, (ctx) => (
    ctx.params.id === 'all' || ctx.params.id === 'batch'
      ? checkAll(ctx.user.id, ctx.body)
      : check(ctx.user.id, ctx.params.id, ctx.body)
  ));
  // 全选 / 反选（表头）
  api.post('/api/cart/check-all', { auth: 'user' }, (ctx) => checkAll(ctx.user.id, ctx.body));
  // API-035 删除条目
  api.delete('/api/cart/items/:id', { auth: 'user' }, (ctx) => remove(ctx.user.id, ctx.params.id));
  // API-036 清空
  api.delete('/api/cart/items', { auth: 'user' }, (ctx) => clear(ctx.user.id));
};

module.exports.list = list;
module.exports.ensureCart = ensureCart;
