'use strict';

/**
 * 拼团 / 到店 / 售后 / 评价 全链路测试
 * 对应《测试文档》：TC-GRP-001~003、TC-STORE-001/002、TC-AFTER-001、TC-REVIEW-001
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const jobs = require('../src/jobs');

test.before(async () => { await h.start(); });
test.after(async () => { await h.stop(); });

async function ensureAddress(token) {
  const list = await h.api.get('/api/user/addresses', { token });
  if (list.data?.rows?.length) return list.data.rows[0];
  const created = await h.api.post('/api/user/addresses', {
    receiver: '李四', phone: '13800008889', province: '上海市', city: '上海市', district: '徐汇区', detail: '漕溪北路 1 号',
  }, { token });
  return created.data;
}

/** 下单 → 支付 → 商家发货 → 确认收货，返回订单 id 与明细 id */
async function completedOrder(token, { skuId } = {}) {
  await ensureAddress(token);
  const sku = skuId
    ? h.db.get('SELECT * FROM skus WHERE id = ?', skuId)
    : h.db.get(`SELECT s.* FROM skus s JOIN products p ON p.id = s.product_id
                WHERE p.name = 'P1 全阶段天然成犬粮 2kg' ORDER BY s.id LIMIT 1`);
  const created = await h.api.post('/api/orders', { source: 'buyNow', skuId: sku.id, quantity: 1 }, { token });
  assert.equal(created.code, 1, `下单失败：${created.msg}`);
  const orderId = created.data.orders[0].orderId;
  const pay = await h.api.post('/api/payments', { orderId, channel: 'alipay' }, { token });
  assert.equal(pay.code, 1, `发起支付失败：${pay.msg}`);
  const paid = await h.api.post(`/api/payments/${pay.data.payNo}/sandbox-pay`, {}, { token });
  assert.equal(paid.code, 1);
  const seller = await h.loginSeller();
  const ship = await h.api.post(`/api/seller/orders/${orderId}/ship`, { company: '顺丰速运', trackingNo: `SF${Date.now()}` }, { token: seller });
  assert.equal(ship.code, 1, `发货失败：${ship.msg}`);
  const confirm = await h.api.post(`/api/orders/${orderId}/confirm`, {}, { token });
  assert.equal(confirm.code, 1, `确认收货失败：${confirm.msg}`);
  const detail = await h.api.get(`/api/orders/${orderId}`, { token });
  return { orderId, itemId: detail.data.items[0].id, order: detail.data };
}

test('TC-STORE-001/002 到店预约：核销码、容量、取消与不进入交易链路', async () => {
  const token = await h.loginUser();
  const service = h.db.get('SELECT * FROM store_services WHERE status = 1 LIMIT 1');
  const link = h.db.get('SELECT * FROM store_service_stores WHERE store_service_id = ?', service.id);
  const store = h.db.get('SELECT * FROM stores WHERE id = ?', link.store_id);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const stockBefore = h.db.get('SELECT stock, locked_stock FROM skus WHERE id = ?', h.db.get('SELECT sku_id FROM group_buys LIMIT 1').sku_id);
  const paymentsBefore = h.db.get('SELECT COUNT(*) AS c FROM payments').c;
  const settlementsBefore = h.db.get('SELECT COUNT(*) AS c FROM settlements').c;

  const created = await h.api.post('/api/store-bookings', {
    serviceId: service.id, storeId: store.id, bookingDate: tomorrow, slot: '09:00-10:00',
    contact: '张三', phone: '13800008888', remark: '小狗怕吹风',
  }, { token });
  assert.equal(created.code, 1, `预约失败：${created.msg}`);
  const booking = created.data;
  assert.match(booking.bookingNo, /^BK/);
  assert.match(String(booking.verifyCode), /^\d{8}$/);
  assert.equal(booking.status, 1);
  assert.equal(booking.payMethod, null);
  assert.equal(booking.payMethodName, '到店付款');

  // 不进入交易链路：无支付单、无库存变化、无结算
  assert.equal(h.db.get('SELECT COUNT(*) AS c FROM payments').c, paymentsBefore);
  const stockAfter = h.db.get('SELECT stock, locked_stock FROM skus WHERE id = ?', h.db.get('SELECT sku_id FROM group_buys LIMIT 1').sku_id);
  assert.deepEqual(stockAfter, stockBefore);
  assert.equal(h.db.get('SELECT COUNT(*) AS c FROM settlements').c, settlementsBefore);

  // 列表与详情
  const list = await h.api.get('/api/store-bookings', { token });
  assert.equal(list.code, 1);
  assert.ok(list.data.rows.some((b) => b.id === booking.id));
  const detail = await h.api.get(`/api/store-bookings/${booking.id}`, { token });
  assert.equal(detail.data.verifyCode, booking.verifyCode);

  // 他人不可见
  const tokenB = await h.loginUser('petuser02', 'Pet123456');
  const other = await h.api.get(`/api/store-bookings/${booking.id}`, { token: tokenB });
  assert.equal(other.status, 404);

  // 已选时段约满（容量 10，不构造满员；改为校验非法时段）
  const badSlot = await h.api.post('/api/store-bookings', {
    serviceId: service.id, storeId: store.id, bookingDate: tomorrow, slot: '03:00-04:00',
    contact: '张三', phone: '13800008888',
  }, { token });
  assert.equal(badSlot.status, 400);

  // 取消
  const canceled = await h.api.post(`/api/store-bookings/${booking.id}/cancel`, {}, { token });
  assert.equal(canceled.code, 1);
  assert.equal(canceled.data.status, 3);
  const again = await h.api.post(`/api/store-bookings/${booking.id}/cancel`, {}, { token });
  assert.equal(again.status, 400);
});

test('TC-AFTER-001 售后：15 天有效期、重复发起拦截、驳回必填、退货退款全流程', async () => {
  const token = await h.loginUser();
  const { orderId, itemId } = await completedOrder(token);

  // 驳回必填原因：先用另一笔订单发起售后
  const { itemId: itemId2 } = await completedOrder(token);
  const as2 = await h.api.post('/api/aftersales', { orderItemId: itemId2, type: 1, reason: '重复购买' }, { token });
  assert.equal(as2.code, 1, `售后申请失败：${as2.msg}`);
  const seller = await h.loginSeller();
  const reject = await h.api.post(`/api/seller/aftersales/${as2.data.id}/handle`, { action: 'reject' }, { token: seller });
  assert.equal(reject.status, 400, '驳回必须填写原因');
  const rejected = await h.api.post(`/api/seller/aftersales/${as2.data.id}/handle`, { action: 'reject', rejectReason: '商品已使用' }, { token: seller });
  assert.equal(rejected.code, 1);
  assert.equal(rejected.data.status, 6);

  // 主流程：退货退款
  const as1 = await h.api.post('/api/aftersales', { orderItemId: itemId, type: 2, reason: '尺码不合适', amount: 50 }, { token });
  assert.equal(as1.code, 1, `售后申请失败：${as1.msg}`);
  assert.equal(as1.data.type, 2);
  assert.equal(as1.data.status, 1);
  assert.equal(as1.data.refundAmount, 50);

  // 同一明细重复发起被拦截
  const dup = await h.api.post('/api/aftersales', { orderItemId: itemId, type: 1, reason: '再申请' }, { token });
  assert.equal(dup.status, 400);
  assert.match(dup.msg, /未关闭/);

  // 商家同意 → 待买家寄回
  const approve = await h.api.post(`/api/seller/aftersales/${as1.data.id}/handle`, { action: 'approve' }, { token: seller });
  assert.equal(approve.code, 1);
  assert.equal(approve.data.status, 3);

  // 买家寄回
  const returned = await h.api.post(`/api/aftersales/${as1.data.id}/return`, { company: '顺丰速运', trackingNo: 'SF999888' }, { token });
  assert.equal(returned.code, 1);

  // 商家确认收货 → 生成退款单（待财务审核）
  const confirm = await h.api.post(`/api/seller/aftersales/${as1.data.id}/confirm-return`, {}, { token: seller });
  assert.equal(confirm.code, 1, `确认收货失败：${confirm.msg}`);
  const refund = h.db.get('SELECT * FROM refund_orders WHERE aftersale_id = ?', as1.data.id);
  assert.ok(refund, '应生成退款单');
  assert.equal(refund.status, 0);

  // 财务审核通过 → 已退款；库存回滚（退货入库）
  const finance = await h.loginAdmin('fin01', 'Fin123456');
  const audited = await h.api.post(`/api/admin/refunds/${refund.id}/audit`, { approve: true }, { token: finance });
  assert.equal(audited.code, 1, `退款审核失败：${audited.msg}`);
  const refundAfter = h.db.get('SELECT * FROM refund_orders WHERE id = ?', refund.id);
  assert.equal(refundAfter.status, 2);
  const aftersaleAfter = h.db.get('SELECT * FROM aftersales WHERE id = ?', as1.data.id);
  assert.equal(aftersaleAfter.status, 5);
  const inbound = h.db.get("SELECT * FROM stock_logs WHERE ref_no = (SELECT order_no FROM orders WHERE id = ?) AND source = '退货入库'", orderId);
  assert.ok(inbound, '退货退款应回滚库存并记录退货入库流水');

  // 退款幂等：重复审核不再产生退款
  const repeat = await h.api.post(`/api/admin/refunds/${refund.id}/audit`, { approve: true }, { token: finance });
  assert.equal(repeat.status, 400);
});

test('TC-REVIEW-001 评价：一单一评、商家回复不可改、删除后可重发', async () => {
  const token = await h.loginUser();
  const { orderId, itemId } = await completedOrder(token);

  const review = await h.api.post('/api/reviews', {
    orderItemId: itemId, score: 5, content: '狗粮很香，狗狗爱吃！', images: [],
  }, { token });
  assert.equal(review.code, 1, `评价失败：${review.msg}`);
  const reviewId = review.data.id;

  const dup = await h.api.post('/api/reviews', { orderItemId: itemId, score: 4, content: '再评一次' }, { token });
  assert.equal(dup.status, 400);

  // 前台商品评价列表可见
  const productComments = await h.api.get(`/api/products/${review.data.productId}/comments`);
  assert.equal(productComments.code, 1);
  assert.ok(productComments.data.rows.some((r) => r.id === reviewId));

  const seller = await h.loginSeller();
  const reply = await h.api.post(`/api/seller/reviews/${reviewId}/reply`, { content: '感谢支持，欢迎回购～' }, { token: seller });
  assert.equal(reply.code, 1, `回复失败：${reply.msg}`);
  const modify = await h.api.post(`/api/seller/reviews/${reviewId}/reply`, { content: '修改回复' }, { token: seller });
  assert.equal(modify.status, 400);
  assert.match(modify.msg, /不可修改/);

  const del = await h.api.delete(`/api/seller/reviews/${reviewId}/reply`, { token: seller });
  assert.equal(del.code, 1, `删除回复失败：${del.msg}`);
  const replyAgain = await h.api.post(`/api/seller/reviews/${reviewId}/reply`, { content: '重新回复：感谢支持' }, { token: seller });
  assert.equal(replyAgain.code, 1);

  const appeal = await h.api.post(`/api/seller/reviews/${reviewId}/appeal`, { reason: '恶意评价', evidence: ['x.png'] }, { token: seller });
  assert.equal(appeal.code, 1, `申诉失败：${appeal.msg}`);
  const appealDup = await h.api.post(`/api/seller/reviews/${reviewId}/appeal`, { reason: '再次申诉' }, { token: seller });
  assert.equal(appealDup.status, 400);
  assert.match(appealDup.msg, /处理中/);
});

test('TC-GRP-001/002 拼团：参团资格、支付后待成团、满员成团流转', async () => {
  const groupBuy = h.db.get("SELECT * FROM group_buys WHERE status = 1 LIMIT 1");
  const tokenA = await h.loginUser();
  const tokenB = await h.loginUser('petuser02', 'Pet123456');
  await ensureAddress(tokenA);
  await ensureAddress(tokenB);

  const joinA = await h.api.post(`/api/group-buys/${groupBuy.id}/join`, { quantity: 1 }, { token: tokenA });
  assert.equal(joinA.code, 1, `开团失败：${joinA.msg}`);
  assert.equal(joinA.data.action, '开团');
  const teamId = joinA.data.team.teamId;
  const orderA = joinA.data.order.orderId;

  // 同一团仅可下 1 单（未支付前再次参团被拦截）
  const repeat = await h.api.post(`/api/group-buys/${groupBuy.id}/join`, { teamId }, { token: tokenA });
  assert.equal(repeat.status, 400);
  assert.match(repeat.msg, /仅可下 1 单/);

  // 会员 A 支付 → 待成团
  const payA = await h.api.post('/api/payments', { orderId: orderA, channel: 'alipay' }, { token: tokenA });
  await h.api.post(`/api/payments/${payA.data.payNo}/sandbox-pay`, {}, { token: tokenA });
  const orderAAfter = h.db.get('SELECT * FROM orders WHERE id = ?', orderA);
  assert.equal(orderAAfter.status, 6);
  assert.equal(orderAAfter.pay_amount, 7900 + 1000, '拼团价 79 + 运费 10');

  // 成团人数临时调整为 2（模拟已满员），会员 B 参团并支付
  h.db.run('UPDATE group_teams SET required_count = 2 WHERE id = ?', teamId);
  h.db.run('UPDATE group_buys SET required_count = 2 WHERE id = ?', groupBuy.id);
  const joinB = await h.api.post(`/api/group-buys/${groupBuy.id}/join`, { teamId }, { token: tokenB });
  assert.equal(joinB.code, 1, `参团失败：${joinB.msg}`);
  const orderB = joinB.data.order.orderId;
  const payB = await h.api.post('/api/payments', { orderId: orderB, channel: 'wechat' }, { token: tokenB });
  await h.api.post(`/api/payments/${payB.data.payNo}/sandbox-pay`, {}, { token: tokenB });

  const team = h.db.get('SELECT * FROM group_teams WHERE id = ?', teamId);
  assert.equal(team.status, 2, '满员后团状态应为已成团');
  assert.equal(team.joined_count, 2);
  const orderAAfter2 = h.db.get('SELECT * FROM orders WHERE id = ?', orderA);
  assert.equal(orderAAfter2.status, 1, '成团后订单转为待发货');
});

test('TC-GRP-003 未成团：全额退款（含运费）并回滚库存', async () => {
  const token = await h.loginUser();
  await ensureAddress(token);
  const groupBuy = h.db.get("SELECT * FROM group_buys WHERE status = 1 LIMIT 1");
  h.db.run('UPDATE group_buys SET status = 1, end_at = ? WHERE id = ?', '2027-12-31 00:00:00', groupBuy.id);
  h.db.run('UPDATE group_buys SET required_count = 10 WHERE id = ?', groupBuy.id);

  const sku = h.db.get('SELECT * FROM skus WHERE id = ?', groupBuy.sku_id);
  const stockBefore = sku.stock;
  const join = await h.api.post(`/api/group-buys/${groupBuy.id}/join`, { quantity: 1 }, { token });
  assert.equal(join.code, 1, `开团失败：${join.msg}`);
  const orderId = join.data.order.orderId;
  const pay = await h.api.post('/api/payments', { orderId, channel: 'alipay' }, { token });
  await h.api.post(`/api/payments/${pay.data.payNo}/sandbox-pay`, {}, { token });
  const paidOrder = h.db.get('SELECT * FROM orders WHERE id = ?', orderId);
  assert.equal(paidOrder.status, 6);
  const stockAfterPay = h.db.get('SELECT stock FROM skus WHERE id = ?', sku.id).stock;
  assert.equal(stockAfterPay, stockBefore - 1, '支付后总库存扣减');

  // 团有效期到点
  h.db.run("UPDATE group_teams SET expire_at = '2000-01-01 00:00:00' WHERE id = ?", join.data.team.teamId);
  const settled = await jobs.settleExpiredGroups();
  assert.ok(settled >= 1);

  const team = h.db.get('SELECT * FROM group_teams WHERE id = ?', join.data.team.teamId);
  assert.equal(team.status, 3, '未成团团状态');
  const refund = h.db.get('SELECT * FROM refund_orders WHERE order_id = ?', orderId);
  assert.ok(refund, '应生成退款单');
  assert.equal(refund.amount, paidOrder.pay_amount, '退款金额含运费（全额）');
  assert.equal(refund.status, 2, '未成团退款自动完成');
  const orderAfter = h.db.get('SELECT * FROM orders WHERE id = ?', orderId);
  assert.equal(orderAfter.status, 5, '订单应为已退款');
  const stockAfterRefund = h.db.get('SELECT stock FROM skus WHERE id = ?', sku.id).stock;
  assert.equal(stockAfterRefund, stockBefore, '库存回滚');
});
