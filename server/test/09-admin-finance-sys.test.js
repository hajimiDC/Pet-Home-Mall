'use strict';

/**
 * 平台端 · 财务域 + 系统管理域 + 商家端结算提现/预约核销测试
 * 对应 TC-FIN-001 ~ 003、TC-LOG-001、TC-API-001、TC-STORE-002
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.before(async () => { await h.start(); });
test.after(async () => { await h.stop(); });

async function ensureAddress(token) {
  const list = await h.api.get('/api/user/addresses', { token });
  if (list.data?.rows?.length) return;
  await h.api.post('/api/user/addresses', {
    receiver: '张三', phone: '13800008888', province: '上海市', city: '上海市', district: '浦东新区', detail: '张江路 100 号',
  }, { token });
}

async function completedOrder(token) {
  await ensureAddress(token);
  const sku = h.db.get(`SELECT s.* FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.name = 'P1 全阶段天然成犬粮 2kg' ORDER BY s.id LIMIT 1`);
  const created = await h.api.post('/api/orders', { source: 'buyNow', skuId: sku.id, quantity: 1 }, { token });
  const orderId = created.data.orders[0].orderId;
  const pay = await h.api.post('/api/payments', { orderId, channel: 'alipay' }, { token });
  await h.api.post(`/api/payments/${pay.data.payNo}/sandbox-pay`, {}, { token });
  const seller = await h.loginSeller();
  await h.api.post(`/api/seller/orders/${orderId}/ship`, { company: '顺丰速运', trackingNo: `SF${Date.now()}` }, { token: seller });
  await h.api.post(`/api/orders/${orderId}/confirm`, {}, { token });
  return orderId;
}

test('TC-FIN-001 结算口径：佣金 5%、应结 = 实付 − 佣金，未过保护期不纳入', async () => {
  const user = await h.loginUser();
  const freshOrder = await completedOrder(user);
  const oldOrder = await completedOrder(user);
  // 只有过 15 天售后保护期的订单才纳入结算
  h.db.run("UPDATE orders SET finished_at = '2026-01-01 00:00:00' WHERE id = ?", oldOrder);

  const fin = await h.loginAdmin('fin01', 'Fin123456');
  const generated = await h.api.post('/api/admin/settlements', { period: '2026-01' }, { token: fin });
  assert.equal(generated.code, 1, `生成结算单失败：${generated.msg}`);
  const settlement = h.db.get("SELECT * FROM settlements WHERE period = '2026-01' LIMIT 1");
  assert.ok(settlement, '应生成结算单');
  const item = h.db.get('SELECT * FROM settlement_items WHERE settlement_id = ? AND order_id = ?', settlement.id, oldOrder);
  assert.ok(item, '过保护期订单应纳入结算');
  const freshItem = h.db.get('SELECT * FROM settlement_items WHERE settlement_id = ? AND order_id = ?', settlement.id, freshOrder);
  assert.equal(freshItem, undefined, '未过保护期订单不纳入结算');
  assert.equal(item.commission, Math.round(10800 * 0.05), '佣金 = 实付 × 5%');
  assert.equal(item.payable_amount, 10800 - item.commission);

  const list = await h.api.get('/api/admin/settlements', { token: fin });
  assert.equal(list.code, 1);
  const items = await h.api.get(`/api/admin/settlements/${settlement.id}/items`, { token: fin });
  assert.equal(items.code, 1);
});

test('TC-FIN-001/002 商家结算与提现：余额校验、下限、账户验证', async () => {
  const seller = await h.loginSeller();
  const fin = await h.loginAdmin('fin01', 'Fin123456');
  const settlements = await h.api.get('/api/seller/settlements', { token: seller });
  assert.equal(settlements.code, 1);

  // 结算单确认（待确认 → 已结算）后方可提现
  const pending = h.db.get("SELECT * FROM settlements WHERE status = 1 ORDER BY id DESC LIMIT 1");
  assert.ok(pending, '应存在待确认结算单');
  const confirmed = await h.api.post(`/api/admin/settlements/${pending.id}/confirm`, {}, { token: fin });
  assert.equal(confirmed.code, 1, `结算单确认失败：${confirmed.msg}`);

  const noAccount = await h.api.post('/api/seller/withdrawals', { amount: 100 }, { token: seller });
  assert.equal(noAccount.status, 400, '未绑定收款账户不可提现');

  const account = await h.api.post('/api/seller/accounts', {
    accountType: '对公银行账户', accountName: '宠爱之家旗舰店', bankName: '招商银行', accountNo: '6225888800001234',
  }, { token: seller });
  assert.equal(account.code, 1, `绑定账户失败：${account.msg}`);
  const accountId = account.data.id;

  // 小额打款验证：错误 3 次锁定
  const verifyAmount = h.db.get('SELECT verify_amount FROM shop_accounts WHERE id = ?', accountId).verify_amount;
  if (verifyAmount) {
    const wrong = await h.api.post(`/api/seller/accounts/${accountId}/verify`, { amount: 99.99 }, { token: seller });
    assert.equal(wrong.status, 400);
    const right = await h.api.post(`/api/seller/accounts/${accountId}/verify`, { amount: verifyAmount / 100 }, { token: seller });
    assert.equal(right.code, 1, `小额打款验证失败：${right.msg}`);
    assert.equal(h.db.get('SELECT verified FROM shop_accounts WHERE id = ?', accountId).verified, 1);
  }

  const tooSmall = await h.api.post('/api/seller/withdrawals', { amount: 50 }, { token: seller });
  assert.equal(tooSmall.status, 400, '低于单笔下限 100 元应拦截');

  const ok = await h.api.post('/api/seller/withdrawals', { amount: 100 }, { token: seller });
  assert.equal(ok.code, 1, `提现申请失败：${ok.msg}`);
  const withdrawalId = ok.data.id;

  const tooMuch = await h.api.post('/api/seller/withdrawals', { amount: 99999 }, { token: seller });
  assert.equal(tooMuch.status, 400, '超过可提现余额应拦截');

  const rejectNoReason = await h.api.post(`/api/admin/withdrawals/${withdrawalId}/audit`, { approve: false }, { token: fin });
  assert.equal(rejectNoReason.status, 400);
  const approved = await h.api.post(`/api/admin/withdrawals/${withdrawalId}/audit`, { approve: true }, { token: fin });
  assert.equal(approved.code, 1, `提现审核失败：${approved.msg}`);
  assert.equal(h.db.get('SELECT status FROM withdrawals WHERE id = ?', withdrawalId).status, 1);
});

test('TC-FIN-003 支付流水、退款审核幂等、对账锁定与财务报表', async () => {
  const fin = await h.loginAdmin('fin01', 'Fin123456');

  const payments = await h.api.get('/api/admin/payments', { token: fin });
  assert.equal(payments.code, 1);
  assert.ok(payments.data.total > 0);

  // 一条支付退款：售后同意 → 财务审核
  const user = await h.loginUser();
  await ensureAddress(user);
  const sku = h.db.get(`SELECT s.* FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.name = 'P1 全阶段天然成犬粮 2kg' ORDER BY s.id LIMIT 1`);
  const created = await h.api.post('/api/orders', { source: 'buyNow', skuId: sku.id, quantity: 1 }, { token: user });
  const orderId = created.data.orders[0].orderId;
  const pay = await h.api.post('/api/payments', { orderId, channel: 'alipay' }, { token: user });
  await h.api.post(`/api/payments/${pay.data.payNo}/sandbox-pay`, {}, { token: user });
  const detail = await h.api.get(`/api/orders/${orderId}`, { token: user });
  const as = await h.api.post('/api/aftersales', { orderItemId: detail.data.items[0].id, type: 1, reason: '资金测试' }, { token: user });
  const seller = await h.loginSeller();
  await h.api.post(`/api/seller/aftersales/${as.data.id}/handle`, { action: 'approve' }, { token: seller });
  const refundRow = h.db.get('SELECT * FROM refund_orders WHERE aftersale_id = ?', as.data.id);
  const audited = await h.api.post(`/api/admin/refunds/${refundRow.id}/audit`, { approve: true }, { token: fin });
  assert.equal(audited.code, 1, `退款审核失败：${audited.msg}`);
  const again = await h.api.post(`/api/admin/refunds/${refundRow.id}/audit`, { approve: true }, { token: fin });
  assert.equal(again.status, 400, '重复退款应被幂等拦截');

  const refunds = await h.api.get('/api/admin/refunds', { token: fin });
  assert.equal(refunds.code, 1);

  // 对账：生成 → 锁定 → 再改被拒
  const sync = await h.api.post('/api/admin/reconciliations/sync', { bizDate: new Date().toISOString().slice(0, 10) }, { token: fin });
  assert.equal(sync.code, 1, `对账生成失败：${sync.msg}`);
  const rec = h.db.get('SELECT * FROM reconciliations ORDER BY id DESC LIMIT 1');
  if (rec) {
    const locked = await h.api.post(`/api/admin/reconciliations/${rec.id}/lock`, {}, { token: fin });
    assert.equal(locked.code, 1, `对账锁定失败：${locked.msg}`);
    const againLock = await h.api.post(`/api/admin/reconciliations/${rec.id}/lock`, {}, { token: fin });
    assert.equal(againLock.status, 400);
  }

  const report = await h.api.get('/api/admin/reports/finance', { token: fin });
  assert.equal(report.code, 1);
  const csv = await h.api.get('/api/admin/payments?export=csv', { token: fin });
  assert.equal(csv.status, 200);
});

test('TC-LOG-001 操作日志：写操作必录、查询与导出、不可改删', async () => {
  const admin = await h.loginAdmin();
  const logs = await h.api.get('/api/admin/operation-logs', { token: admin });
  assert.equal(logs.code, 1);
  assert.ok(logs.data.total > 0, '后台写操作应已产生日志');
  const row = logs.data.rows[0];
  assert.ok(row.module && row.action, '日志应含模块与操作类型');
  assert.ok(row.createdAt || row.created_at);

  const filtered = await h.api.get('/api/admin/operation-logs?module=' + encodeURIComponent('认证'), { token: admin });
  assert.equal(filtered.code, 1);

  const csv = await h.api.get('/api/admin/operation-logs?export=csv', { token: admin });
  assert.equal(csv.status, 200);
  // 日志表无写接口
  const write = await h.api.post('/api/admin/operation-logs', { module: 'x' }, { token: admin });
  assert.equal(write.status, 404);

  // 日志中不含密码明文
  const leaked = h.db.get("SELECT COUNT(*) AS c FROM operation_logs WHERE detail LIKE '%Pet123456%' OR detail LIKE '%Admin123456%'");
  assert.equal(leaked.c, 0);
});

test('TC-API-001 系统管理：用户禁用令牌失效、内置角色不可删、权限树、字典与看板', async () => {
  const admin = await h.loginAdmin();

  // 会员禁用 → 令牌立即失效
  const reg = await h.api.post('/api/auth/register', {
    username: 'sysuser01', password: 'abc12345', confirmPassword: 'abc12345', phone: '13700000009',
  });
  const userToken = reg.data.token;
  assert.equal((await h.api.get('/api/auth/me', { token: userToken })).code, 1);
  const users = await h.api.get('/api/admin/users?keyword=sysuser01', { token: admin });
  assert.equal(users.code, 1);
  const userId = users.data.rows[0].id;
  const disabled = await h.api.patch(`/api/admin/users/${userId}/status`, { status: 0 }, { token: admin });
  assert.equal(disabled.code, 1);
  const afterDisable = await h.api.get('/api/auth/me', { token: userToken });
  assert.ok([401, 403].includes(afterDisable.status), '禁用后令牌应立即失效');

  // 角色：内置角色不可删
  const roles = await h.api.get('/api/admin/roles', { token: admin });
  assert.equal(roles.code, 1);
  const builtin = roles.data.rows.find((r) => r.builtin === 1 || r.builtin === true);
  assert.ok(builtin);
  const del = await h.api.delete(`/api/admin/roles/${builtin.id}`, { token: admin });
  assert.equal(del.status, 400);
  assert.match(del.msg, /内置角色/);

  const perms = await h.api.get('/api/admin/permissions', { token: admin });
  assert.equal(perms.code, 1);

  const dicts = await h.api.put('/api/admin/dicts', {
    type: 'logistics_company', items: [{ code: 'SF', name: '顺丰速运' }, { code: 'JD', name: '京东物流' }],
  }, { token: admin });
  assert.equal(dicts.code, 1, `字典保存失败：${dicts.msg}`);

  const settings = await h.api.put('/api/admin/settings', {
    settings: { commission_rate: '0.05', order_timeout_minutes: '15' },
  }, { token: admin });
  assert.equal(settings.code, 1, `配置保存失败：${settings.msg}`);

  const dashboard = await h.api.get('/api/admin/dashboard?range=month', { token: admin });
  assert.equal(dashboard.code, 1);
  assert.ok(dashboard.data.gmv !== undefined || dashboard.data.gmvAmount !== undefined || dashboard.data.total !== undefined);
});

test('TC-STORE-002 商家核销：必填收款金额、幂等、不写库存流水', async () => {
  const user = await h.loginUser();
  const service = h.db.get('SELECT * FROM store_services WHERE status = 1 LIMIT 1');
  const link = h.db.get('SELECT * FROM store_service_stores WHERE store_service_id = ?', service.id);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const booking = await h.api.post('/api/store-bookings', {
    serviceId: service.id, storeId: link.store_id, bookingDate: tomorrow, slot: '09:00-10:00',
    contact: '张三', phone: '13800008888',
  }, { token: user });
  assert.equal(booking.code, 1, `预约失败：${booking.msg}`);
  const bookingId = booking.data.id;

  const seller = await h.loginSeller();
  const list = await h.api.get('/api/seller/bookings', { token: seller });
  assert.equal(list.code, 1);
  assert.ok(list.data.rows.some((b) => b.id === bookingId));

  const noAmount = await h.api.post(`/api/seller/bookings/${bookingId}/verify`, { payMethod: '到店付款' }, { token: seller });
  assert.equal(noAmount.status, 400, '未登记收款金额应拦截');

  const stockLogsBefore = h.db.get('SELECT COUNT(*) AS c FROM stock_logs').c;
  const verified = await h.api.post(`/api/seller/bookings/${bookingId}/verify`, { paidAmount: 89, payMethod: '到店付款' }, { token: seller });
  assert.equal(verified.code, 1, `核销失败：${verified.msg}`);
  assert.equal(h.db.get('SELECT status FROM store_bookings WHERE id = ?', bookingId).status, 2);
  const record = h.db.get('SELECT * FROM store_verifications WHERE booking_id = ?', bookingId);
  assert.ok(record, '应写入核销记录');
  assert.equal(record.pay_method, '到店付款');
  assert.equal(h.db.get('SELECT COUNT(*) AS c FROM stock_logs').c, stockLogsBefore, '到店核销不写库存流水');

  const again = await h.api.post(`/api/seller/bookings/${bookingId}/verify`, { paidAmount: 89, payMethod: '到店付款' }, { token: seller });
  assert.equal(again.status, 400, '重复核销应被拒绝');
  assert.match(again.msg, /已核销/);
});
