'use strict';

/**
 * 商家端测试（TC-SLR-001 ~ 003、TC-STORE-002、TC-OPS-003、TC-GRP-001、TC-SEC-001）
 * 断言以 HTTP 状态、业务文案与数据库最终状态为准。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.before(async () => { await h.start(); });
test.after(async () => { await h.stop(); });

const shop1 = () => h.db.get("SELECT * FROM shops WHERE name = '宠爱之家旗舰店'");

test('TC-SLR-001 入驻申请：必填校验、重复提交拦截、状态查询', async () => {
  // 入驻申请与 C 端会员账号绑定（BR-SLR-001）：先注册该手机号对应的会员
  await h.api.post('/api/auth/register', {
    username: 'newseller01', password: 'Seller123456', confirmPassword: 'Seller123456', phone: '13911112222',
  });
  const token = await h.loginSeller('s3', 'Seller123456');
  const missing = await h.api.post('/api/seller/apply', { subjectType: '企业' }, { token });
  assert.equal(missing.status, 400);

  const payload = {
    subjectType: '企业', subjectName: '喵星人宠物有限公司', contact: '王五', phone: '13911112222',
    licenseUrls: ['https://picsum.photos/seed/lic/600/400'], categoryIds: [1], shopName: '喵星人宠物店',
  };
  const ok = await h.api.post('/api/seller/apply', payload, { token });
  assert.equal(ok.code, 1, `提交入驻失败：${ok.msg}`);

  const dup = await h.api.post('/api/seller/apply', payload, { token });
  assert.equal(dup.status, 400);
  assert.match(dup.msg, /已提交申请|审核中|已开通/);

  const mine = await h.api.get('/api/seller/apply', { token });
  assert.equal(mine.code, 1);
  const applyId = h.db.get('SELECT id FROM shop_applies WHERE phone = ?', '13911112222').id;

  // 平台审核通过 → 自动开通店铺并绑定商家账号 s3
  const ops = await h.loginAdmin('ops01', 'Ops123456');
  const approved = await h.api.post(`/api/admin/shop-applies/${applyId}/audit`, { action: 'approve' }, { token: ops });
  assert.equal(approved.code, 1, `入驻审核失败：${approved.msg}`);
  const shop = h.db.get("SELECT * FROM shops WHERE name = '喵星人宠物店'");
  assert.ok(shop, '审核通过应创建店铺');
  const s3 = h.db.get("SELECT * FROM admin_users WHERE account = 's3'");
  assert.equal(s3.shop_id, shop.id, '商家账号应绑定新建店铺');

  const me = await h.api.get('/api/seller/auth/me', { token });
  assert.equal(me.data.shop.id, shop.id);
  assert.ok(me.data.menus.length > 1, '开通后应拥有全部商家菜单');
});

test('TC-SEC-001 商家端数据隔离：跨店访问返回 404', async () => {
  const s1 = await h.loginSeller('s1', 'Seller123456');
  const s2 = await h.loginSeller('s2', 'Seller123456');
  const productOfS1 = h.db.get('SELECT id FROM products WHERE shop_id = ? LIMIT 1', shop1().id);
  const byS2 = await h.api.get(`/api/seller/products/${productOfS1.id}`, { token: s2 });
  assert.equal(byS2.status, 404);
  const byS1 = await h.api.get(`/api/seller/products/${productOfS1.id}`, { token: s1 });
  assert.equal(byS1.code, 1);

  // 请求体伪造 shop_id 被忽略（FR-BE-006）
  const shop2 = h.db.get("SELECT id FROM shops WHERE name = '毛孩子生活馆'");
  const list = await h.api.get(`/api/seller/products?shopId=${shop1().id}`, { token: s2 });
  assert.equal(list.code, 1);
  const expectedIds = h.db.all('SELECT id FROM products WHERE shop_id = ? AND is_deleted = 0', shop2.id).map((r) => r.id);
  assert.ok(list.data.rows.length > 0);
  assert.ok(list.data.rows.every((p) => expectedIds.includes(p.id)), '只能返回本店商品');
});

test('TC-SLR-002 商品发布：价格/库存/末级类目/重名校验与审核流转', async () => {
  const token = await h.loginSeller();
  const cat = h.db.get("SELECT id FROM categories WHERE name = '成犬粮' AND level = 3");
  const cat2 = h.db.get("SELECT id FROM categories WHERE name = '进口粮' AND level = 3");

  const base = {
    name: '自动化测试商品 A', categoryId: cat.id, mainImage: 'https://picsum.photos/seed/newp/400/400',
    images: [], detailHtml: '<p>测试</p>', brand: '测试', unit: '袋',
    skus: [{ specName: '默认', price: 10, stock: 5 }],
  };
  const badPrice = await h.api.post('/api/seller/products', { ...base, skus: [{ specName: '默认', price: 0, stock: 1 }] }, { token });
  assert.equal(badPrice.status, 400);
  assert.match(badPrice.msg, /价格/);

  const badStock = await h.api.post('/api/seller/products', { ...base, skus: [{ specName: '默认', price: 10, stock: -1 }] }, { token });
  assert.equal(badStock.status, 400);

  const badCategory = await h.api.post('/api/seller/products', { ...base, categoryId: h.db.get("SELECT id FROM categories WHERE name = '主粮' AND level = 2").id }, { token });
  assert.equal(badCategory.status, 400);
  assert.match(badCategory.msg, /末级/);

  const created = await h.api.post('/api/seller/products', { ...base, submit: true }, { token });
  assert.equal(created.code, 1, `新增商品失败：${created.msg}`);
  const productId = created.data.id || created.data.productId;
  const row = h.db.get('SELECT * FROM products WHERE id = ?', productId);
  assert.equal(row.status, 1, '开启审核时上架商品应为待审核');

  // 前台不可见
  const front = await h.api.get(`/api/products/${productId}`);
  assert.equal(front.status, 404);

  // 平台审核通过 → 前台可见
  const ops = await h.loginAdmin('ops01', 'Ops123456');
  const audit = await h.api.post(`/api/admin/product-audits/${productId}/audit`, { action: 'approve' }, { token: ops });
  assert.equal(audit.code, 1, `商品审核失败：${audit.msg}`);
  const visible = await h.api.get(`/api/products/${productId}`);
  assert.equal(visible.code, 1);

  // 同店重名拦截
  const dup = await h.api.post('/api/seller/products', { ...base, submit: false }, { token });
  assert.equal(dup.status, 400);
  assert.match(dup.msg, /重复/);

  // 批量上下架
  const batch = await h.api.patch('/api/seller/products/batch/status', { ids: [productId], status: 3 }, { token });
  assert.equal(batch.code, 1);
  assert.equal(h.db.get('SELECT status FROM products WHERE id = ?', productId).status, 3);

  // 已产生订单的商品不可删除
  const s1 = shop1();
  const orderedProduct = h.db.get(`SELECT p.id FROM products p JOIN order_items oi ON oi.product_id = p.id
    JOIN orders o ON o.id = oi.order_id WHERE o.shop_id = ? LIMIT 1`, s1.id);
  if (orderedProduct) {
    const del = await h.api.delete(`/api/seller/products/${orderedProduct.id}`, { token });
    assert.equal(del.status, 400);
    assert.match(del.msg, /订单|下架/);
  }
});

test('TC-SLR-003 库存调整：原因必填、下限校验、流水与可售口径', async () => {
  const token = await h.loginSeller();
  const sku = h.db.get(`SELECT s.* FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.name = 'P1 全阶段天然成犬粮 2kg' ORDER BY s.id LIMIT 1`);

  const noReason = await h.api.post('/api/seller/stocks/adjust', { skuId: sku.id, mode: 'delta', value: 5 }, { token });
  assert.equal(noReason.status, 400);
  assert.match(noReason.msg, /原因/);

  const negative = await h.api.post('/api/seller/stocks/adjust', { skuId: sku.id, mode: 'set', value: -5, reason: '测试' }, { token });
  assert.equal(negative.status, 400);

  const before = h.db.get('SELECT stock, locked_stock FROM skus WHERE id = ?', sku.id);
  const ok = await h.api.post('/api/seller/stocks/adjust', { skuId: sku.id, mode: 'delta', value: 7, reason: '补货入库' }, { token });
  assert.equal(ok.code, 1, `库存调整失败：${ok.msg}`);
  const after = h.db.get('SELECT stock, locked_stock FROM skus WHERE id = ?', sku.id);
  assert.equal(after.stock, before.stock + 7);

  const log = h.db.get("SELECT * FROM stock_logs WHERE sku_id = ? AND source = '手工调整' ORDER BY id DESC LIMIT 1", sku.id);
  assert.ok(log, '应生成库存流水');
  assert.equal(log.change_qty, 7);
  assert.equal(log.before_qty, before.stock);
  assert.equal(log.after_qty, after.stock);
  assert.match(log.remark, /补货/);

  const list = await h.api.get('/api/seller/stocks', { token });
  assert.equal(list.code, 1);
  const row = list.data.rows.find((r) => r.skuId === sku.id);
  assert.equal(row.availableStock, row.totalStock - row.lockedStock);

  // 目标值小于锁定库存被拦截
  h.db.run('UPDATE skus SET locked_stock = 5 WHERE id = ?', sku.id);
  const below = await h.api.post('/api/seller/stocks/adjust', { skuId: sku.id, mode: 'set', value: 2, reason: '测试' }, { token });
  assert.equal(below.status, 400);
  assert.match(below.msg, /锁定/);
  h.db.run('UPDATE skus SET locked_stock = 0 WHERE id = ?', sku.id);
});

test('TC-SLR-002 订单发货：状态校验、重复发货拦截、批量发货与导出', async () => {
  const user = await h.loginUser();
  const sku = h.db.get(`SELECT s.* FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.name = 'P1 全阶段天然成犬粮 2kg' ORDER BY s.id LIMIT 1`);
  const created = await h.api.post('/api/orders', { source: 'buyNow', skuId: sku.id, quantity: 1 }, { token: user });
  const orderId = created.data.orders[0].orderId;
  const pay = await h.api.post('/api/payments', { orderId, channel: 'alipay' }, { token: user });
  await h.api.post(`/api/payments/${pay.data.payNo}/sandbox-pay`, {}, { token: user });

  const token = await h.loginSeller();
  const notPaidShip = await h.api.post('/api/seller/orders/999999/ship', { company: '顺丰速运', trackingNo: 'X1' }, { token });
  assert.equal(notPaidShip.status, 404);

  const ship = await h.api.post(`/api/seller/orders/${orderId}/ship`, { company: '顺丰速运', trackingNo: `SF${Date.now()}` }, { token });
  assert.equal(ship.code, 1, `发货失败：${ship.msg}`);
  const again = await h.api.post(`/api/seller/orders/${orderId}/ship`, { company: '顺丰速运', trackingNo: 'SF222' }, { token });
  assert.equal(again.status, 400);
  assert.match(again.msg, /已发货|状态/);

  const detail = await h.api.get(`/api/seller/orders/${orderId}`, { token });
  assert.equal(detail.code, 1);
  assert.equal(detail.data.status, 2);
  assert.ok(detail.data.logistics?.trackingNo);
  assert.match(detail.data.buyer.phoneMask, /^\d{3}\*{4}\d{4}$/);

  // 批量发货逐条返回
  const batch = await h.api.post('/api/seller/orders/batch/ship', [{ orderId, company: '顺丰速运', trackingNo: 'SF333' }], { token });
  assert.equal(batch.code, 1);
  assert.ok(Array.isArray(batch.data.results || batch.data));

  // 导出 CSV
  const csv = await h.api.get('/api/seller/orders/export', { token });
  assert.equal(csv.status, 200);
});

test('TC-OPS-003 商家营销：活动保存与提前结束、券面额校验、拼团价校验', async () => {
  const token = await h.loginSeller();
  const product = h.db.get('SELECT id FROM products WHERE shop_id = ? AND status = 2 LIMIT 1', shop1().id);

  const badTime = await h.api.post('/api/seller/activities', {
    title: '倒置时间活动', type: '满减', startAt: '2027-01-02 00:00:00', endAt: '2027-01-01 00:00:00', productIds: [product.id],
    ruleJson: { threshold: 100, discount: 10 },
  }, { token });
  assert.equal(badTime.status, 400);

  const noProducts = await h.api.post('/api/seller/activities', {
    title: '无商品活动', type: '满减', startAt: '2026-01-01 00:00:00', endAt: '2027-01-01 00:00:00', productIds: [],
    ruleJson: { threshold: 100, discount: 10 },
  }, { token });
  assert.equal(noProducts.status, 400);

  const created = await h.api.post('/api/seller/activities', {
    title: '测试满减活动', type: '满减', startAt: '2026-01-01 00:00:00', endAt: '2027-12-31 00:00:00', productIds: [product.id],
    ruleDesc: '满 100 减 10', ruleJson: { threshold: 10000, discount: 1000 }, image: 'https://picsum.photos/seed/a/800/300',
  }, { token });
  assert.equal(created.code, 1, `活动保存失败：${created.msg}`);
  const activityId = created.data.id;
  const closed = await h.api.post(`/api/seller/activities/${activityId}/close`, {}, { token });
  assert.equal(closed.code, 1);
  assert.equal(h.db.get('SELECT status FROM activities WHERE id = ?', activityId).status, 3);

  // 券面额 ≥ 门槛 → 拦截
  const badCoupon = await h.api.post('/api/seller/coupons', {
    name: '无效券', type: 1, threshold: 100, amount: 100, startAt: '2026-01-01 00:00:00', endAt: '2027-01-01 00:00:00', stock: 10,
  }, { token });
  assert.equal(badCoupon.status, 400);

  const coupon = await h.api.post('/api/seller/coupons', {
    name: '店铺测试券', type: 1, threshold: 50, amount: 5, startAt: '2026-01-01 00:00:00', endAt: '2027-01-01 00:00:00',
    stock: 100, limitPerUser: 1, scopeType: 4, scopeIds: [shop1().id],
  }, { token });
  assert.equal(coupon.code, 1, `店铺券保存失败：${coupon.msg}`);
  assert.equal(h.db.get('SELECT shop_id FROM coupons WHERE name = ?', '店铺测试券').shop_id, shop1().id);

  // 拼团价高于商城价 → 拦截
  const sku = h.db.get(`SELECT s.* FROM skus s JOIN products p ON p.id = s.product_id WHERE p.shop_id = ? LIMIT 1`, shop1().id);
  const tooHigh = await h.api.post('/api/seller/group-buys/apply', {
    productId: sku.product_id, skuId: sku.id, groupPrice: (sku.price + 1000) / 100, requiredCount: 10,
  }, { token });
  assert.equal(tooHigh.status, 400);
  assert.match(tooHigh.msg, /拼团价/);

  const okApply = await h.api.post('/api/seller/group-buys/apply', {
    productId: sku.product_id, skuId: sku.id, groupPrice: (sku.price - 1000) / 100, requiredCount: 10,
  }, { token });
  assert.equal(okApply.code, 1, `拼团报名失败：${okApply.msg}`);
});

test('门店与店铺维护：经纬度校验、门店列表、店铺资料与概览', async () => {
  const token = await h.loginSeller();
  const badStore = await h.api.post('/api/seller/stores', { name: '无坐标门店', address: '上海', phone: '021-1' }, { token });
  assert.equal(badStore.status, 400);

  const store = await h.api.post('/api/seller/stores', {
    name: '自动化测试门店', phone: '021-66668888', address: '上海市黄浦区南京东路 1 号',
    lng: 121.4805, lat: 31.2363, businessHours: '09:00-21:00',
  }, { token });
  assert.equal(store.code, 1, `新增门店失败：${store.msg}`);
  const storeId = store.data.id;

  const list = await h.api.get('/api/seller/stores?keyword=自动化', { token });
  assert.equal(list.code, 1);
  assert.ok(list.data.rows.some((s) => s.id === storeId));

  const disabled = await h.api.patch(`/api/seller/stores/${storeId}/status`, { status: 0 }, { token });
  assert.equal(disabled.code, 1);

  const shopInfo = await h.api.get('/api/seller/shop', { token });
  assert.equal(shopInfo.code, 1);
  assert.equal(shopInfo.data.name, '宠爱之家旗舰店');

  const stat = await h.api.get('/api/seller/shop/stat', { token });
  assert.equal(stat.code, 1);
  const statValues = Object.values(stat.data).filter((v) => typeof v === 'number');
  assert.ok(statValues.length >= 3, '数据概览应返回多项数值指标');

  // 名称修改进入待审核，前台仍展示原名
  const renamed = await h.api.put('/api/seller/shop', { name: '宠爱之家旗舰店（新）' }, { token });
  assert.equal(renamed.code, 1);
  assert.equal(h.db.get('SELECT name FROM shops WHERE id = ?', shop1().id).name, '宠爱之家旗舰店');
  assert.equal(h.db.get('SELECT name_pending FROM shops WHERE id = ?', shop1().id).name_pending, '宠爱之家旗舰店（新）');
});
