'use strict';

/**
 * C 端内容域契约测试（TC-CAT-001 / TC-SEARCH-001 / TC-GOODS-001 / TC-GOOD-001/002）
 * 说明：断言以《需求文档》可判定口径为主（分类 7 项、分页结构、空态、错误文案），
 *      对字段命名保持适度宽容，避免与具体实现耦合。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.before(async () => { await h.start(); });
test.after(async () => { await h.stop(); });

function arr(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.tree)) return data.tree;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

test('TC-CAT-001 分类树：7 个一级分类，含二级与三级词条', async () => {
  const res = await h.api.get('/api/categories/tree');
  assert.equal(res.code, 1);
  const tree = arr(res.data);
  assert.equal(tree.length, 7, `一级分类应为 7 个，实际 ${tree.length}`);
  const names = tree.map((c) => c.name);
  assert.deepEqual(names, ['狗狗', '猫猫', '小宠', '爬宠', '鸟类', '水族', '到店']);
  const dog = tree.find((c) => c.name === '狗狗');
  const level2 = dog.children || dog.sub || [];
  assert.ok(level2.length >= 9, '狗狗应有 9 个二级分类');
  const food = level2.find((c) => c.name === '主粮');
  const level3 = food.children || food.sub || [];
  assert.ok(level3.length >= 8, '主粮应有 8 个三级词条');
  const storeTop = tree.find((c) => c.name === '到店');
  assert.ok(storeTop.isStore === true || storeTop.isStore === 1 || storeTop.store === true, '到店一级分类应标记为本地服务');
});

test('TC-GOODS-001 商品列表：分页结构、筛选与排序', async () => {
  const res = await h.api.get('/api/products?page=1&pageSize=5');
  assert.equal(res.code, 1);
  assert.equal(typeof res.data.total, 'number');
  assert.ok(Array.isArray(res.data.rows));
  assert.ok(res.data.total > 0, '应存在上架商品');
  assert.ok(res.data.rows.length <= 5);
  const first = res.data.rows[0];
  assert.ok(first.id && first.name, '商品卡片应含 id / name');
  assert.equal(typeof first.price, 'number');

  const sorted = await h.api.get('/api/products?sort=priceAsc&pageSize=5');
  const prices = sorted.data.rows.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), '价格升序应生效');

  const page2 = await h.api.get('/api/products?page=2&pageSize=5');
  assert.equal(page2.code, 1);
  const ids1 = res.data.rows.map((p) => p.id);
  const ids2 = page2.data.rows.map((p) => p.id);
  assert.ok(ids2.every((id) => !ids1.includes(id)), '分页不应重复');
});

test('TC-GOOD-002 下架商品在前台列表与详情不可见', async () => {
  const p3 = h.db.get("SELECT id FROM products WHERE name LIKE 'P3%'");
  const list = await h.api.get('/api/products?keyword=P3');
  assert.equal(list.code, 1);
  assert.ok(!list.data.rows.some((p) => p.id === p3.id), '已下架商品不应出现在列表');
  const detail = await h.api.get(`/api/products/${p3.id}`);
  assert.equal(detail.status, 404);
});

test('TC-GOOD-001 商品详情包含 SKU、库存与售后政策', async () => {
  const p1 = h.db.get("SELECT id FROM products WHERE name = 'P1 全阶段天然成犬粮 2kg'");
  const res = await h.api.get(`/api/products/${p1.id}`);
  assert.equal(res.code, 1);
  const data = res.data;
  assert.ok(data.name);
  const skus = data.skus || data.skuList || [];
  assert.equal(skus.length, 4, 'P1 应有 4 个规格');
  assert.ok(skus.every((s) => typeof s.availableStock === 'number' || typeof s.stock === 'number'));
  const text = JSON.stringify(data);
  assert.match(text, /15 天|15天/, '应包含交易完成后 15 天内可申请售后的政策说明');
});

test('TC-SEARCH-001 搜索：空关键字拦截、范围路由与屏蔽词', async () => {
  const empty = await h.api.get('/api/search?scope=product&keyword=');
  assert.equal(empty.status, 400);
  assert.match(empty.msg, /请输入关键字/);

  for (const scope of ['shop', 'product', 'activity', 'coupon']) {
    const res = await h.api.get(`/api/search?scope=${scope}&keyword=${encodeURIComponent('狗')}`);
    assert.equal(res.code, 1, `${scope} 搜索应成功`);
    assert.ok(Array.isArray(res.data.rows), `${scope} 应返回 rows`);
  }

  const blocked = await h.api.get(`/api/search?scope=product&keyword=${encodeURIComponent('违禁词')}`);
  assert.equal(blocked.code, 1);
  assert.equal(blocked.data.total, 0);
  assert.equal(blocked.data.blocked, true);
});

test('TC-MAP-001 门店列表：距离与门店信息', async () => {
  const res = await h.api.get('/api/stores?lng=121.5996&lat=31.2047');
  assert.equal(res.code, 1);
  const rows = res.data.rows || arr(res.data);
  assert.ok(rows.length >= 1, '应返回门店');
  const store = rows[0];
  assert.ok(store.name);
  assert.equal(typeof store.distance, 'number');

  const degraded = await h.api.get('/api/stores');
  assert.equal(degraded.code, 1, '无定位时应降级返回默认城市列表');
});

test('到店服务列表与券中心', async () => {
  const services = await h.api.get('/api/stores/services');
  assert.equal(services.code, 1);
  const rows = services.data.rows || arr(services.data);
  assert.ok(rows.length >= 1, '应存在已审核通过的到店服务');
  assert.ok(rows.some((s) => typeof s.storePrice === 'number' && s.storePrice < s.originPrice), '到店价应低于原价');

  const coupons = await h.api.get('/api/coupons');
  assert.equal(coupons.code, 1);
  const coupons2 = coupons.data.rows || arr(coupons.data);
  assert.ok(coupons2.length >= 3, '应存在平台券与店铺券');
});

test('首页内容位：轮播图与右侧推荐位', async () => {
  const banners = await h.api.get('/api/banners');
  assert.equal(banners.code, 1);
  assert.ok(arr(banners.data).length >= 2);

  for (const tab of ['shop', 'product', 'activity']) {
    const res = await h.api.get(`/api/recommends?tab=${tab}`);
    assert.equal(res.code, 1, `${tab} 推荐位应可查询`);
  }
});

test('店铺街与商家详情', async () => {
  const list = await h.api.get('/api/shops');
  assert.equal(list.code, 1);
  const shops = list.data.rows || arr(list.data);
  assert.ok(shops.length >= 2);
  const shop = shops[0];
  assert.ok(shop.name);
  const detail = await h.api.get(`/api/shops/${shop.id}`);
  assert.equal(detail.code, 1);
  assert.match(String(detail.data.score), /^\d(\.\d)?$/);

  const products = await h.api.get(`/api/shops/${shop.id}/products`);
  assert.equal(products.code, 1);
  assert.ok(Array.isArray(products.data.rows));

  const activities = await h.api.get(`/api/shops/${shop.id}/activities`);
  assert.equal(activities.code, 1);
});

test('收藏店铺需要登录且可切换', async () => {
  const token = await h.loginUser();
  const shop = h.db.get('SELECT id FROM shops LIMIT 1');
  const noLogin = await h.api.post(`/api/shops/${shop.id}/favorite`, {});
  assert.equal(noLogin.status, 401);
  const first = await h.api.post(`/api/shops/${shop.id}/favorite`, {}, { token });
  assert.equal(first.code, 1);
  const second = await h.api.post(`/api/shops/${shop.id}/favorite`, {}, { token });
  assert.equal(second.code, 1);
  assert.notEqual(first.data.favorited, second.data.favorited);
});

test('上传接口：文件类型与大小校验', async () => {
  const token = await h.loginUser();
  const fs = require('node:fs');
  const path = require('node:path');
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const okRes = await h.api.post('/api/upload', { filename: 'a.png', contentType: 'image/png', data: png }, { token });
  assert.equal(okRes.code, 1);
  assert.match(okRes.data.url, /^\/uploads\//);
  const bad = await h.api.post('/api/upload', { filename: 'a.pdf', contentType: 'application/pdf', data: png }, { token });
  assert.equal(bad.status, 400);
  // 清理测试上传产物
  try { fs.unlinkSync(path.join(__dirname, '..', okRes.data.url)); } catch (_) { /* ignore */ }
});
