'use strict';

/**
 * 平台端 · 仓库域 + 客服域测试（TC-SLR-003、TC-AFTER-001、TC-REVIEW-001、TC-LOG-001）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.before(async () => { await h.start(); });
test.after(async () => { await h.stop(); });

const skuOf = () => h.db.get(`SELECT s.* FROM skus s JOIN products p ON p.id = s.product_id
  WHERE p.name = 'P1 全阶段天然成犬粮 2kg' ORDER BY s.id LIMIT 1`);

async function completedOrder(token) {
  const addr = await h.api.get('/api/user/addresses', { token });
  if (!addr.data?.rows?.length) {
    await h.api.post('/api/user/addresses', {
      receiver: '张三', phone: '13800008888', province: '上海市', city: '上海市', district: '浦东新区', detail: '张江路 100 号',
    }, { token });
  }
  const sku = skuOf();
  const created = await h.api.post('/api/orders', { source: 'buyNow', skuId: sku.id, quantity: 1 }, { token });
  const orderId = created.data.orders[0].orderId;
  const pay = await h.api.post('/api/payments', { orderId, channel: 'alipay' }, { token });
  await h.api.post(`/api/payments/${pay.data.payNo}/sandbox-pay`, {}, { token });
  const seller = await h.loginSeller();
  await h.api.post(`/api/seller/orders/${orderId}/ship`, { company: '顺丰速运', trackingNo: `SF${Date.now()}${Math.floor(Math.random() * 1000)}` }, { token: seller });
  await h.api.post(`/api/orders/${orderId}/confirm`, {}, { token });
  const detail = await h.api.get(`/api/orders/${orderId}`, { token });
  return { orderId, itemId: detail.data.items[0].id };
}

test('API-123 库存总览：可售 = 总库存 − 锁定库存', async () => {
  const token = await h.loginAdmin('whs01', 'Whs123456');
  const res = await h.api.get('/api/admin/stocks', { token });
  assert.equal(res.code, 1);
  assert.ok(res.data.rows.length > 0);
  const row = res.data.rows[0];
  assert.equal(row.availableStock, row.totalStock - row.lockedStock);
});

test('API-124 出入库：提交加库存、草稿不动库存、作废反向对冲', async () => {
  const token = await h.loginAdmin('whs01', 'Whs123456');
  const sku = skuOf();
  const before = h.db.get('SELECT stock FROM skus WHERE id = ?', sku.id).stock;
  const shopId = sku.product_id ? h.db.get('SELECT shop_id FROM products WHERE id = ?', sku.product_id).shop_id : 1;

  const draft = await h.api.post('/api/admin/stock-orders', {
    type: 1, sourceType: '采购入库', shopId, items: [{ skuId: sku.id, quantity: 5 }],
  }, { token });
  assert.equal(draft.code, 1, `草稿创建失败：${draft.msg}`);
  assert.equal(h.db.get('SELECT stock FROM skus WHERE id = ?', sku.id).stock, before, '草稿不动库存');

  const submitted = await h.api.post('/api/admin/stock-orders', {
    type: 1, sourceType: '采购入库', shopId, items: [{ skuId: sku.id, quantity: 6 }], submit: true,
  }, { token });
  assert.equal(submitted.code, 1, `入库提交失败：${submitted.msg}`);
  assert.equal(h.db.get('SELECT stock FROM skus WHERE id = ?', sku.id).stock, before + 6);
  const orderId = submitted.data.id;
  const log = h.db.get("SELECT * FROM stock_logs WHERE sku_id = ? AND source = '采购入库' ORDER BY id DESC LIMIT 1", sku.id);
  assert.ok(log, '应生成入库流水');

  const voided = await h.api.post(`/api/admin/stock-orders/${orderId}/void`, { reason: '录错数量' }, { token });
  assert.equal(voided.code, 1, `作废失败：${voided.msg}`);
  assert.equal(h.db.get('SELECT stock FROM skus WHERE id = ?', sku.id).stock, before, '作废应反向对冲');
  const again = await h.api.post(`/api/admin/stock-orders/${orderId}/void`, {}, { token });
  assert.equal(again.status, 400);
});

test('API-125 盘点：差异计算与确认后更新库存', async () => {
  const token = await h.loginAdmin('whs01', 'Whs123456');
  const sku = skuOf();
  const shopId = h.db.get('SELECT shop_id FROM products WHERE id = ?', sku.product_id).shop_id;
  const before = h.db.get('SELECT stock FROM skus WHERE id = ?', sku.id).stock;

  const created = await h.api.post('/api/admin/stock-takes', { shopId, scope: '指定 SKU', items: [{ skuId: sku.id }] }, { token });
  assert.equal(created.code, 1, `盘点创建失败：${created.msg}`);
  const takeId = created.data.id;

  const recorded = await h.api.post('/api/admin/stock-takes', {
    takeId, items: [{ skuId: sku.id, actualQty: before - 2 }], confirm: true,
  }, { token });
  assert.equal(recorded.code, 1, `盘点确认失败：${recorded.msg}`);
  assert.equal(h.db.get('SELECT stock FROM skus WHERE id = ?', sku.id).stock, before - 2);
  assert.equal(h.db.get('SELECT status FROM stock_takes WHERE id = ?', takeId).status, 1);
});

test('API-126/127 待发货池与批量发货逐条结果', async () => {
  const whs = await h.loginAdmin('whs01', 'Whs123456');
  const user = await h.loginUser();
  await h.api.post('/api/user/addresses', {
    receiver: '张三', phone: '13800008888', province: '上海市', city: '上海市', district: '浦东新区', detail: '张江路 100 号',
  }, { token: user });
  const sku = skuOf();
  const created = await h.api.post('/api/orders', { source: 'buyNow', skuId: sku.id, quantity: 1 }, { token: user });
  const orderId = created.data.orders[0].orderId;
  const pay = await h.api.post('/api/payments', { orderId, channel: 'alipay' }, { token: user });
  await h.api.post(`/api/payments/${pay.data.payNo}/sandbox-pay`, {}, { token: user });

  const pool = await h.api.get('/api/admin/orders/pending-ship', { token: whs });
  assert.equal(pool.code, 1);
  assert.ok(pool.data.rows.some((o) => (o.orderId || o.id) === orderId));

  const batch = await h.api.post('/api/admin/orders/batch/ship', {
    items: [
      { orderId, company: '顺丰速运', trackingNo: `SFB${Date.now()}` },
      { orderId: 999999, company: '顺丰速运', trackingNo: 'SFX1' },
    ],
  }, { token: whs });
  assert.equal(batch.code, 1, `批量发货失败：${batch.msg}`);
  const results = batch.data.results || batch.data;
  assert.ok(Array.isArray(results));
  assert.equal(results.filter((r) => r.success === true || r.ok === true).length, 1);
  assert.equal(h.db.get('SELECT status FROM orders WHERE id = ?', orderId).status, 2);
});

test('API-128 库存流水查询与导出', async () => {
  const token = await h.loginAdmin('whs01', 'Whs123456');
  const logs = await h.api.get('/api/admin/stocks/logs', { token });
  assert.equal(logs.code, 1);
  assert.ok(logs.data.rows.length > 0);
  const csv = await h.api.get('/api/admin/stocks/logs?export=csv', { token });
  assert.equal(csv.status, 200);
});

test('API-129/130 客服工单：受理、回复、解决、关闭', async () => {
  const cs = await h.loginAdmin('cs01', 'Cs123456');
  const list = await h.api.get('/api/admin/work-orders', { token: cs });
  assert.equal(list.code, 1);
  const order = list.data.rows[0];
  assert.ok(order, '应有种子工单');

  const accept = await h.api.post(`/api/admin/work-orders/${order.id}/handle`, { action: 'accept' }, { token: cs });
  assert.equal(accept.code, 1, `受理失败：${accept.msg}`);
  const reply = await h.api.post(`/api/admin/work-orders/${order.id}/handle`, { action: 'reply', content: '您好，P1 适合 2 岁金毛食用。' }, { token: cs });
  assert.equal(reply.code, 1, `回复失败：${reply.msg}`);
  const resolved = await h.api.post(`/api/admin/work-orders/${order.id}/handle`, { action: 'resolve' }, { token: cs });
  assert.equal(resolved.code, 1);
  const closed = await h.api.post(`/api/admin/work-orders/${order.id}/handle`, { action: 'close' }, { token: cs });
  assert.equal(closed.code, 1);
  const replies = JSON.parse(h.db.get('SELECT replies FROM work_orders WHERE id = ?', order.id).replies || '[]');
  assert.ok(replies.length >= 1, '工单沟通记录应留痕');
});

test('API-132 客服介入售后：同意后生成待审核退款单', async () => {
  const user = await h.loginUser();
  const { itemId } = await completedOrder(user);
  const as = await h.api.post('/api/aftersales', { orderItemId: itemId, type: 1, reason: '客服介入测试' }, { token: user });
  assert.equal(as.code, 1, `售后申请失败：${as.msg}`);

  const cs = await h.loginAdmin('cs01', 'Cs123456');
  const intervened = await h.api.post(`/api/admin/aftersales/${as.data.id}/intervene`, { action: 'approve', conclusion: '商家超时未响应' }, { token: cs });
  assert.equal(intervened.code, 1, `客服介入失败：${intervened.msg}`);
  const refund = h.db.get('SELECT * FROM refund_orders WHERE aftersale_id = ?', as.data.id);
  assert.ok(refund, '介入同意应生成退款单');
  assert.equal(refund.status, 0, '退款单待财务审核');
});

test('API-133 评价申诉审核：通过后隐藏且不计入评分', async () => {
  const user = await h.loginUser();
  const { itemId } = await completedOrder(user);
  const review = await h.api.post('/api/reviews', { orderItemId: itemId, score: 1, content: '恶意差评测试' }, { token: user });
  assert.equal(review.code, 1, `评价失败：${review.msg}`);

  const seller = await h.loginSeller();
  const appeal = await h.api.post(`/api/seller/reviews/${review.data.id}/appeal`, { reason: '恶意评价', evidence: ['x.png'] }, { token: seller });
  assert.equal(appeal.code, 1, `申诉失败：${appeal.msg}`);

  const cs = await h.loginAdmin('cs01', 'Cs123456');
  const list = await h.api.get('/api/admin/review-appeals', { token: cs });
  assert.equal(list.code, 1);
  const appealRow = h.db.get('SELECT * FROM review_appeals WHERE review_id = ?', review.data.id);

  const noReason = await h.api.post(`/api/admin/review-appeals/${appealRow.id}/audit`, { approve: false }, { token: cs });
  assert.equal(noReason.status, 400, '驳回必须填写原因');

  const approved = await h.api.post(`/api/admin/review-appeals/${appealRow.id}/audit`, { approve: true }, { token: cs });
  assert.equal(approved.code, 1, `申诉审核失败：${approved.msg}`);
  assert.equal(h.db.get('SELECT hidden FROM shop_reviews WHERE id = ?', review.data.id).hidden, 1);

  const comments = await h.api.get(`/api/products/${review.data.productId}/comments`);
  assert.ok(!(comments.data.rows || []).some((r) => r.id === review.data.id), '隐藏评价前台不展示');
});
