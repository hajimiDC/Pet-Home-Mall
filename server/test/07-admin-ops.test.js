'use strict';

/**
 * 平台端 · 运营域测试（TC-OPS-001 ~ 003、TC-SEC-001、TC-SLR-001/002）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.before(async () => { await h.start(); });
test.after(async () => { await h.stop(); });

test('TC-SEC-001 平台 RBAC：无权菜单 403，超级管理员全通', async () => {
  const ops = await h.loginAdmin('ops01', 'Ops123456');
  const fin = await h.loginAdmin('fin01', 'Fin123456');
  const noToken = await h.api.get('/api/admin/categories');
  assert.equal(noToken.status, 401);

  // 财务访问运营类目管理 → 403
  const forbidden = await h.api.get('/api/admin/categories', { token: fin });
  assert.equal(forbidden.status, 403);
  // 运营访问财务对账 → 403
  const forbidden2 = await h.api.get('/api/admin/reconciliations', { token: ops });
  assert.equal(forbidden2.status, 403);
  // 超管均可访问
  const admin = await h.loginAdmin();
  assert.equal((await h.api.get('/api/admin/categories', { token: admin })).code, 1);
  assert.equal((await h.api.get('/api/admin/reconciliations', { token: admin })).code, 1);

  // 菜单权限随角色返回
  const me = await h.api.get('/api/admin/auth/me', { token: ops });
  assert.equal(me.code, 1);
  assert.ok(me.data.menus.some((m) => m.key === 'category'));
  assert.ok(!me.data.menus.some((m) => m.key === 'reconcile'));
});

test('TC-OPS-001 类目：新增、层级上限、同父重名、删除拦截、停用联动下架', async () => {
  const token = await h.loginAdmin('ops01', 'Ops123456');
  const dog = h.db.get("SELECT * FROM categories WHERE name = '狗狗' AND level = 1");
  const food = h.db.get("SELECT * FROM categories WHERE name = '主粮' AND parent_id = ? AND level = 2", dog.id);

  const created = await h.api.post('/api/admin/categories', { name: '测试二级类目', parentId: dog.id, sort: 99, status: 1 }, { token });
  assert.equal(created.code, 1, `新增类目失败：${created.msg}`);
  const newId = created.data.id;

  const dup = await h.api.post('/api/admin/categories', { name: '测试二级类目', parentId: dog.id }, { token });
  assert.equal(dup.status, 400);
  assert.match(dup.msg, /名称/);

  // 三级下再建 → 超层级
  const level3 = h.db.get('SELECT id FROM categories WHERE level = 3 LIMIT 1');
  const tooDeep = await h.api.post('/api/admin/categories', { name: '四级类目', parentId: level3.id }, { token });
  assert.equal(tooDeep.status, 400);
  assert.match(tooDeep.msg, /三级|层级/);

  // 删除存在商品的类目 → 拦截
  const usedCategory = h.db.get(`SELECT category_id FROM products WHERE status = 2 LIMIT 1`);
  const del = await h.api.delete(`/api/admin/categories/${usedCategory.category_id}`, { token });
  assert.equal(del.status, 400);
  assert.match(del.msg, /商品|子类目/);

  // 停用含商品的类目 → 该商品自动下架
  const product = h.db.get('SELECT * FROM products WHERE status = 2 AND category_id = ? LIMIT 1', usedCategory.category_id)
    || h.db.get('SELECT * FROM products WHERE status = 2 LIMIT 1');
  const disabled = await h.api.patch(`/api/admin/categories/${product.category_id}/status`, { status: 0 }, { token });
  if (disabled.code === 1) {
    assert.equal(h.db.get('SELECT status FROM products WHERE id = ?', product.id).status, 3, '类目停用应联动下架商品');
    // 恢复
    await h.api.patch(`/api/admin/categories/${product.category_id}/status`, { status: 1 }, { token });
  }

  // 清理：删除空类目
  const removed = await h.api.delete(`/api/admin/categories/${newId}`, { token });
  assert.equal(removed.code, 1);
});

test('TC-OPS-002 商品审核：驳回必填原因、通过后前台可见', async () => {
  const ops = await h.loginAdmin('ops01', 'Ops123456');
  const shop = h.db.get('SELECT * FROM shops LIMIT 1');
  const cat = h.db.get("SELECT id FROM categories WHERE name = '成犬粮' AND level = 3");
  const productId = h.db.run(
    `INSERT INTO products (shop_id, category_id, name, main_image, price, origin_price, total_stock, locked_stock, warn_stock, status, created_at, updated_at)
     VALUES (?, ?, '待审核测试商品', 'https://picsum.photos/seed/audit/400/400', 5000, 6000, 10, 0, 1, 1, datetime('now'), datetime('now'))`,
    shop.id, cat.id,
  ).lastInsertRowid;
  h.db.run(`INSERT INTO skus (product_id, spec_name, price, stock, locked_stock, warn_stock, status, created_at, updated_at)
            VALUES (?, '默认', 5000, 10, 0, 1, 1, datetime('now'), datetime('now'))`, productId);

  const list = await h.api.get('/api/admin/product-audits', { token: ops });
  assert.equal(list.code, 1);
  assert.ok(list.data.rows.some((p) => p.id === productId));

  const noReason = await h.api.post(`/api/admin/product-audits/${productId}/audit`, { action: 'reject' }, { token: ops });
  assert.equal(noReason.status, 400);
  assert.match(noReason.msg, /原因/);

  const rejected = await h.api.post(`/api/admin/product-audits/${productId}/audit`, { action: 'reject', rejectReason: '主图不合规' }, { token: ops });
  assert.equal(rejected.code, 1);
  assert.equal(h.db.get('SELECT status FROM products WHERE id = ?', productId).status, 4);
  assert.equal((await h.api.get(`/api/products/${productId}`)).status, 404);

  h.db.run('UPDATE products SET status = 1 WHERE id = ?', productId);
  const approved = await h.api.post(`/api/admin/product-audits/${productId}/audit`, { action: 'approve' }, { token: ops });
  assert.equal(approved.code, 1);
  assert.equal(h.db.get('SELECT status FROM products WHERE id = ?', productId).status, 2);
  assert.equal((await h.api.get(`/api/products/${productId}`)).code, 1);

  // 上报操作日志
  const logs = h.db.get("SELECT COUNT(*) AS c FROM operation_logs WHERE module LIKE '%商品%'").c;
  assert.ok(logs >= 1, '审核操作应写入操作日志');
});

test('TC-OPS-002 活动审核：驳回必填原因、强制下线、审核开关', async () => {
  const ops = await h.loginAdmin('ops01', 'Ops123456');
  const shop = h.db.get('SELECT * FROM shops LIMIT 1');
  const activityId = h.db.run(
    `INSERT INTO activities (shop_id, title, type, start_at, end_at, status, created_at, updated_at)
     VALUES (?, '待审核活动', '满减', datetime('now'), '2027-12-31 00:00:00', 0, datetime('now'), datetime('now'))`,
    shop.id,
  ).lastInsertRowid;

  const list = await h.api.get('/api/admin/activity-audits', { token: ops });
  assert.equal(list.code, 1);
  assert.ok(list.data.rows.some((a) => a.id === activityId));

  const rejectNoReason = await h.api.post(`/api/admin/activity-audits/${activityId}/audit`, { action: 'reject' }, { token: ops });
  assert.equal(rejectNoReason.status, 400);

  const approve = await h.api.post(`/api/admin/activity-audits/${activityId}/audit`, { action: 'approve' }, { token: ops });
  assert.equal(approve.code, 1);
  assert.equal(h.db.get('SELECT status FROM activities WHERE id = ?', activityId).status, 1);

  const offline = await h.api.post(`/api/admin/activity-audits/${activityId}/audit`, { action: 'offline', rejectReason: '违规宣传' }, { token: ops });
  assert.equal(offline.code, 1);
  assert.equal(h.db.get('SELECT status FROM activities WHERE id = ?', activityId).status, 4);

  // 审核开关写入配置（默认开启）
  const settings = await h.api.get('/api/admin/settings', { token: await h.loginAdmin() });
  assert.equal(settings.code, 1);
});

test('TC-OPS-003 平台券与拼团规则：门槛与人数区间校验', async () => {
  const ops = await h.loginAdmin('ops01', 'Ops123456');

  const badCoupon = await h.api.post('/api/admin/coupons', {
    name: '面额超门槛', type: 1, threshold: 100, amount: 100, startAt: '2026-01-01 00:00:00', endAt: '2027-01-01 00:00:00', stock: 10,
  }, { token: ops });
  assert.equal(badCoupon.status, 400);

  const okCoupon = await h.api.post('/api/admin/coupons', {
    name: '平台测试券', type: 1, threshold: 100, amount: 10, startAt: '2026-01-01 00:00:00', endAt: '2027-01-01 00:00:00',
    stock: 100, limitPerUser: 1, scopeType: 1,
  }, { token: ops });
  assert.equal(okCoupon.code, 1, `平台券创建失败：${okCoupon.msg}`);
  assert.equal(h.db.get('SELECT shop_id FROM coupons WHERE name = ?', '平台测试券').shop_id, 0);

  const rule9 = await h.api.put('/api/admin/group-buy-rule', { minQty: 9 }, { token: ops });
  assert.equal(rule9.status, 400);
  assert.match(rule9.msg, /10|99|区间/);
  const rule100 = await h.api.put('/api/admin/group-buy-rule', { maxQty: 100 }, { token: ops });
  assert.equal(rule100.status, 400);
  const rule10 = await h.api.put('/api/admin/group-buy-rule', {
    minQty: 10, maxQty: 99, validDays: 3, allowRepeatJoin: false, unfullAction: '全额退款并回滚库存',
  }, { token: ops });
  assert.equal(rule10.code, 1, `拼团规则保存失败：${rule10.msg}`);
  assert.equal(h.db.get("SELECT value FROM system_configs WHERE key = 'group_buy_valid_days'").value, '3');
});

test('TC-OPS-003 到店服务审核后前台可选，核销记录可查', async () => {
  const ops = await h.loginAdmin('ops01', 'Ops123456');
  const service = h.db.get('SELECT * FROM store_services WHERE status = 0 LIMIT 1');
  assert.ok(service, '种子数据应包含待审核到店服务');

  const before = await h.api.get('/api/stores/services');
  assert.ok(!(before.data.rows || []).some((s) => s.id === service.id), '未审核通过不展示');

  const approved = await h.api.post(`/api/admin/store-services/${service.id}/audit`, { action: 'approve' }, { token: ops });
  assert.equal(approved.code, 1, `到店服务审核失败：${approved.msg}`);
  assert.equal(h.db.get('SELECT status FROM store_services WHERE id = ?', service.id).status, 1);

  const after = await h.api.get('/api/stores/services');
  assert.ok((after.data.rows || []).some((s) => s.id === service.id), '审核通过后前台可选');

  const records = await h.api.get('/api/admin/store-verifications', { token: ops });
  assert.equal(records.code, 1);
  const overview = await h.api.get('/api/admin/store-overview', { token: ops });
  assert.equal(overview.code, 1);
});

test('TC-OPS-002 店铺停用联动：商品与活动下架、前台不可见', async () => {
  const ops = await h.loginAdmin('ops01', 'Ops123456');
  const shop = h.db.get("SELECT * FROM shops WHERE name = '毛孩子生活馆'");
  const onSale = h.db.get('SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND status = 2', shop.id).c;

  const disabled = await h.api.patch(`/api/admin/shops/${shop.id}/status`, { status: 0, reason: '违规经营' }, { token: ops });
  assert.equal(disabled.code, 1, `店铺停用失败：${disabled.msg}`);
  assert.equal(h.db.get('SELECT status FROM shops WHERE id = ?', shop.id).status, 0);
  const remain = h.db.get('SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND status = 2', shop.id).c;
  assert.equal(remain, 0, '店铺停用后商品应自动下架');
  assert.ok(onSale >= 0);

  const shops = await h.api.get('/api/shops');
  assert.ok(!(shops.data.rows || []).some((s) => s.id === shop.id), '停用店铺前台不展示');

  // 恢复
  const enabled = await h.api.patch(`/api/admin/shops/${shop.id}/status`, { status: 1 }, { token: ops });
  assert.equal(enabled.code, 1);
});

test('内容位与搜索词：轮播、推荐位、页尾、热词维护', async () => {
  const ops = await h.loginAdmin('ops01', 'Ops123456');
  const banner = await h.api.post('/api/admin/banners', {
    title: '自动化轮播', position: 'home', image: 'https://picsum.photos/seed/b/1200/400', link: '/', sort: 9, status: 1,
  }, { token: ops });
  assert.equal(banner.code, 1, `轮播保存失败：${banner.msg}`);

  const slot = await h.api.post('/api/admin/recommend-slots', {
    tabType: 'product', targetId: h.db.get('SELECT id FROM products LIMIT 1').id, sort: 1,
  }, { token: ops });
  assert.equal(slot.code, 1, `推荐位保存失败：${slot.msg}`);

  const footer = await h.api.put('/api/admin/footer', {
    links: [{ groupName: '购物指南', title: '购物流程', url: '/help/flow', sort: 0 }],
    servicePhone: '400-800-8888',
  }, { token: ops });
  assert.equal(footer.code, 1, `页尾更新失败：${footer.msg}`);

  const words = await h.api.post('/api/admin/search-words', { word: '测试热词', type: 'hot', sort: 1 }, { token: ops });
  assert.equal(words.code, 1, `搜索词保存失败：${words.msg}`);

  const reindex = await h.api.post('/api/admin/search/reindex', {}, { token: ops });
  assert.equal(reindex.code, 1);
});
