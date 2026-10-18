'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const paymentSvc = require('../src/services/payment-service');
const jobs = require('../src/jobs');

test.before(async () => { await h.start(); });
test.after(async () => { await h.stop(); });

const p1Sku = () => h.db.get(`SELECT s.* FROM skus s JOIN products p ON p.id = s.product_id
  WHERE p.name = 'P1 全阶段天然成犬粮 2kg' ORDER BY s.id LIMIT 1`);
const couponId = (name) => h.db.get('SELECT id FROM coupons WHERE name = ?', name).id;

async function clearCart(token) {
  await h.api.delete('/api/cart/items', { token });
}

test('TC-GOOD-001 加购：数量非法纠正、库存截断、合并同 SKU', async () => {
  const token = await h.loginUser();
  await clearCart(token);
  const sku = p1Sku();

  const zero = await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 0 }, { token });
  assert.equal(zero.status, 400);
  assert.match(zero.msg, /数量最小为 1/);

  const huge = await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 999 }, { token });
  assert.equal(huge.code, 1);
  assert.equal(huge.data.truncated, true);
  assert.match(huge.data.message, /库存不足/);
  const item = huge.data.items.find((i) => i.skuId === sku.id);
  assert.equal(item.quantity, item.availableStock);

  // 合并同 SKU
  await clearCart(token);
  await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 2 }, { token });
  const merged = await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 3 }, { token });
  assert.equal(merged.data.items.length, 1);
  assert.equal(merged.data.items[0].quantity, 5);
});

test('TC-GOOD-002 下架商品不可加购，购物车标记失效', async () => {
  const token = await h.loginUser();
  await clearCart(token);
  const p3 = h.db.get("SELECT s.* FROM skus s JOIN products p ON p.id = s.product_id WHERE p.name LIKE 'P3%'");
  const res = await h.api.post('/api/cart/items', { productId: p3.product_id, skuId: p3.id, quantity: 1 }, { token });
  assert.equal(res.status, 400);
  assert.match(res.msg, /已下架/);
});

test('TC-CART-001 勾选 / 全选 / 删除 / 空态与金额重算', async () => {
  const token = await h.loginUser();
  await clearCart(token);
  const sku = p1Sku();
  await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 2 }, { token });
  let cart = await h.api.get('/api/cart', { token });
  assert.equal(cart.code, 1);
  assert.equal(cart.data.goodsAmount, 196);
  assert.equal(cart.data.canCheckout, true);

  const itemId = cart.data.items[0].id;
  const unchecked = await h.api.put(`/api/cart/items/${itemId}/checked`, { checked: false }, { token });
  assert.equal(unchecked.data.checkedAmount, 0);
  assert.equal(unchecked.data.canCheckout, false);

  const all = await h.api.post('/api/cart/check-all', { checked: true }, { token });
  assert.equal(all.data.canCheckout, true);

  const qty = await h.api.put(`/api/cart/items/${itemId}`, { quantity: 3 }, { token });
  assert.equal(qty.data.items[0].subtotal, 294);

  const removed = await h.api.delete(`/api/cart/items/${itemId}`, { token });
  assert.equal(removed.data.items.length, 0);
  assert.equal(removed.data.empty, true);
  assert.equal(removed.data.emptyText, '购物车内暂时没有商品');
});

test('TC-ORDER-001 金额公式：98 元商品 + 10 元运费 = 108，满 99 包邮', async () => {
  const token = await h.loginUser();
  await clearCart(token);
  const sku = p1Sku();
  await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 2 }, { token });

  const preview = await h.api.post('/api/orders/preview', { source: 'cart' }, { token });
  assert.equal(preview.code, 1);
  assert.equal(preview.data.goodsAmount, 196);
  // 196 >= 99 已包邮
  assert.equal(preview.data.freightAmount, 0);

  await clearCart(token);
  await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 1 }, { token });
  const single = await h.api.post('/api/orders/preview', { source: 'cart' }, { token });
  assert.equal(single.data.goodsAmount, 98);
  assert.equal(single.data.freightAmount, 10);
  assert.equal(single.data.payAmount, 108);
  assert.equal(single.data.freeShipping, false);
  assert.equal(single.data.freightRule.fee, 10);
  assert.equal(single.data.freightRule.threshold, 99);

  const created = await h.api.post('/api/orders', { source: 'cart', payAmount: 1 }, { token });
  assert.equal(created.code, 1);
  assert.equal(created.data.payAmount, 108, '服务端忽略前端传入金额');
  const detail = await h.api.get(`/api/orders/${created.data.orders[0].orderId}`, { token });
  assert.equal(detail.data.payAmount, 108);
  assert.equal(detail.data.receiver.receiver, '张三');
});

test('TC-ORDER-002 优惠券门槛与「1 张平台券 + 1 张店铺券」', async () => {
  const token = await h.loginUser();
  await clearCart(token);
  const sku = p1Sku();

  // 领取平台券（满 100 减 10）与店铺券（满 50 减 5）
  const c1 = couponId('平台满 100 减 10');
  const c2 = couponId('店铺满 50 减 5');
  const claim1 = await h.api.post(`/api/coupons/${c1}/claim`, {}, { token });
  const claim2 = await h.api.post(`/api/coupons/${c2}/claim`, {}, { token });
  assert.equal(claim1.code, 1, `平台券领取失败: ${claim1.msg}`);
  assert.equal(claim2.code, 1, `店铺券领取失败: ${claim2.msg}`);

  // 40 元：两张券都不满足门槛
  const cheap = h.db.get("SELECT s.* FROM skus s JOIN products p ON p.id = s.product_id WHERE p.name LIKE '麦富迪肉干肉条%'");
  await h.api.post('/api/cart/items', { productId: cheap.product_id, skuId: cheap.id, quantity: 1 }, { token });
  const previewCheap = await h.api.post('/api/orders/preview', { source: 'cart' }, { token });
  const c1Option = previewCheap.data.coupons.platform.find((c) => c.couponId === c1);
  const c2Option = previewCheap.data.coupons.shop.find((c) => c.couponId === c2);
  assert.equal(c1Option.usable, false);
  assert.match(c1Option.reason, /未满/);
  assert.equal(c2Option.usable, false);

  // 196 元（2 件）+ 两张券：应付 = 196 + 0（满 99 包邮）- 10 - 5 = 181
  await clearCart(token);
  await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 2 }, { token });
  const options = await h.api.post('/api/orders/preview', { source: 'cart' }, { token });
  const platform = options.data.coupons.platform.find((c) => c.couponId === c1);
  const shop = options.data.coupons.shop.find((c) => c.couponId === c2);
  assert.equal(platform.usable, true);
  assert.equal(shop.usable, true);

  const both = await h.api.post('/api/orders/preview', {
    source: 'cart', userCouponId: platform.userCouponId, shopCouponId: shop.userCouponId,
  }, { token });
  assert.equal(both.data.couponAmount, 15);
  assert.equal(both.data.freightAmount, 0);
  assert.equal(both.data.payAmount, 181);
  assert.equal(both.data.goodsAmount + both.data.freightAmount - both.data.couponAmount, both.data.payAmount);

  // 已使用的券不可重复用
  const created = await h.api.post('/api/orders', {
    source: 'cart', userCouponId: platform.userCouponId, shopCouponId: shop.userCouponId,
  }, { token });
  assert.equal(created.code, 1);
  await clearCart(token);
  await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 2 }, { token });
  const reuse = await h.api.post('/api/orders/preview', { source: 'cart', userCouponId: platform.userCouponId }, { token });
  assert.equal(reuse.status, 400);
  assert.match(reuse.msg, /优惠券不可用/);
});

test('TC-ORDER-001 缺少收货地址时拦截下单', async () => {
  const tokenB = await h.loginUser('petuser02', 'Pet123456');
  await clearCart(tokenB);
  const sku = p1Sku();
  await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 1 }, { token: tokenB });
  const res = await h.api.post('/api/orders', { source: 'cart' }, { token: tokenB });
  assert.equal(res.status, 400);
  assert.match(res.msg, /请先添加收货地址/);
});

test('TC-CONS-001 重复提交仅生成一个订单（幂等键）', async () => {
  const token = await h.loginUser();
  await clearCart(token);
  const sku = p1Sku();
  await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 1 }, { token });
  const key = `idem-${Date.now()}`;
  const first = await h.api.post('/api/orders', { source: 'cart', idempotencyKey: key }, { token });
  const second = await h.api.post('/api/orders', { source: 'cart', idempotencyKey: key }, { token });
  assert.equal(first.code, 1);
  assert.equal(second.code, 1);
  assert.equal(second.data.orders[0].orderId, first.data.orders[0].orderId);
  const count = h.db.get('SELECT COUNT(*) AS c FROM orders WHERE idempotency_key = ?', key).c;
  assert.equal(count, 1);
});

test('TC-PAY-001 支付超时：自动关单、释放库存并记录回滚流水', async () => {
  const token = await h.loginUser();
  await clearCart(token);
  const sku = p1Sku();
  const before = h.db.get('SELECT stock, locked_stock FROM skus WHERE id = ?', sku.id);
  await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 2 }, { token });
  const created = await h.api.post('/api/orders', { source: 'cart' }, { token });
  const orderId = created.data.orders[0].orderId;
  const locked = h.db.get('SELECT locked_stock FROM skus WHERE id = ?', sku.id);
  assert.equal(locked.locked_stock, before.locked_stock + 2);

  h.db.get("UPDATE orders SET expire_at = '2000-01-01 00:00:00' WHERE id = ?", orderId);
  const closed = await jobs.closeExpiredOrders();
  assert.ok(closed >= 1);
  const order = h.db.get('SELECT * FROM orders WHERE id = ?', orderId);
  assert.equal(order.status, 4);
  assert.match(order.cancel_reason, /超时/);
  const after = h.db.get('SELECT stock, locked_stock FROM skus WHERE id = ?', sku.id);
  assert.equal(after.locked_stock, before.locked_stock);
  assert.equal(after.stock, before.stock);
  const log = h.db.get("SELECT * FROM stock_logs WHERE ref_no = ? AND source = '超时回滚'", order.order_no);
  assert.ok(log, '应记录超时回滚库存流水');

  // 超时订单不可支付
  const pay = await h.api.post('/api/payments', { orderId, channel: 'alipay' }, { token });
  assert.equal(pay.status, 400);
});

test('TC-PAY-002 支付渠道校验、回调验签与幂等', async () => {
  const token = await h.loginUser();
  await clearCart(token);
  const sku = p1Sku();
  await h.api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity: 1 }, { token });
  const created = await h.api.post('/api/orders', { source: 'cart' }, { token });
  const orderId = created.data.orders[0].orderId;

  const noChannel = await h.api.post('/api/payments', { orderId }, { token });
  assert.equal(noChannel.status, 400);
  assert.equal(noChannel.msg, '请选择支付方式');

  const wrongChannel = await h.api.post('/api/payments', { orderId, channel: 'unionpay' }, { token });
  assert.equal(wrongChannel.status, 400);

  const pay = await h.api.post('/api/payments', { orderId, channel: 'wechat' }, { token });
  assert.equal(pay.code, 1);
  assert.equal(pay.data.amount, 108);
  const payNo = pay.data.payNo;

  // 错误签名
  const bad = await h.api.post('/api/payments/notify', { payNo, status: 1, amount: '108.00', timestamp: 1, sign: 'deadbeef' });
  assert.equal(bad.status, 403);

  // 正确签名，重放两次只生效一次
  const timestamp = Date.now();
  const sign = paymentSvc.signPayload({ payNo, status: 1, amount: '108.00', timestamp });
  const first = await h.api.post('/api/payments/notify', { payNo, status: 1, amount: '108.00', timestamp, sign });
  assert.equal(first.code, 1);
  const replay = await h.api.post('/api/payments/notify', { payNo, status: 1, amount: '108.00', timestamp, sign });
  assert.equal(replay.code, 1);
  assert.equal(replay.data.duplicated, true);

  const query = await h.api.get(`/api/payments/${payNo}`, { token });
  assert.equal(query.data.status, 1);
  const order = await h.api.get(`/api/orders/${orderId}`, { token });
  assert.equal(order.data.status, 1);
  assert.equal(order.data.statusName, '待发货');

  // 已支付订单再次支付被拦截
  const again = await h.api.post('/api/payments', { orderId, channel: 'alipay' }, { token });
  assert.equal(again.status, 400);
  assert.match(again.msg, /已支付/);

  // 非本人支付单不可查询
  const tokenB = await h.loginUser('petuser02', 'Pet123456');
  const other = await h.api.get(`/api/payments/${payNo}`, { token: tokenB });
  assert.equal(other.status, 404);
});

test('TC-CONS-001 并发下单不超卖、库存不为负', async () => {
  const token = await h.loginUser();
  const shop = h.db.get('SELECT * FROM shops LIMIT 1');
  const cat = h.db.get("SELECT id FROM categories WHERE name = '成犬粮' AND level = 3");
  const productId = h.db.run(
    `INSERT INTO products (shop_id, category_id, name, main_image, price, origin_price, total_stock, locked_stock, warn_stock, status, created_at, updated_at)
     VALUES (?, ?, '并发压测商品', 'x.png', 1000, 1200, 10, 0, 1, 2, datetime('now'), datetime('now'))`,
    shop.id, cat.id,
  ).lastInsertRowid;
  const skuId = h.db.run(
    `INSERT INTO skus (product_id, spec_name, price, stock, locked_stock, warn_stock, status, created_at, updated_at)
     VALUES (?, '默认', 1000, 10, 0, 1, 1, datetime('now'), datetime('now'))`, productId,
  ).lastInsertRowid;

  const requests = Array.from({ length: 20 }, (_, i) => h.api.post('/api/orders', {
    source: 'buyNow', skuId, quantity: 1, idempotencyKey: `concurrent-${i}`,
  }, { token }));
  const results = await Promise.all(requests);
  const success = results.filter((r) => r.code === 1);
  assert.ok(success.length <= 10, `成功订单数应 ≤ 10，实际 ${success.length}`);
  assert.equal(success.length, 10, '库存 10 件应恰好成交 10 单');
  const sku = h.db.get('SELECT stock, locked_stock FROM skus WHERE id = ?', skuId);
  assert.equal(sku.stock, 10, '下单只锁定不扣减总库存');
  assert.equal(sku.locked_stock, 10);
  assert.ok(sku.stock - sku.locked_stock >= 0);
  const failed = results.filter((r) => r.code === 0);
  assert.ok(failed.every((r) => /库存不足|库存/.test(r.msg)));
});
