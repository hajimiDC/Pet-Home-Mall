'use strict';

/**
 * 集成测试基座：每个测试文件使用独立 SQLite 文件，启动真实 HTTP 服务，
 * 通过 fetch 调用接口，验证《测试文档》中的可判定结果。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const testDir = path.join(os.tmpdir(), 'pet-mall-tests');
fs.mkdirSync(testDir, { recursive: true });
const dbFile = path.join(testDir, `test-${process.pid}-${Date.now()}.db`);
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.PET_DB_FILE = dbFile;
process.env.PET_LOG_SILENT = '1';
process.env.PET_JWT_SECRET = 'test-secret';
process.env.PET_ENC_KEY = 'test-enc-key';

const { ensureSchema, close, get, all, run } = require('../src/core/db');
const { ensureDefaults } = require('../src/core/config');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');

let server = null;
let base = '';

async function start() {
  if (server) return base;
  ensureSchema();
  ensureDefaults();
  seed();
  server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch (_) { /* ignore */ }
  }
}

async function call(method, url, { token, body, headers } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  return { status: res.status, code: json.code, msg: json.msg, data: json.data, headers: res.headers, raw: json };
}

const api = {
  get: (url, opts) => call('GET', url, opts),
  post: (url, body, opts = {}) => call('POST', url, { ...opts, body }),
  put: (url, body, opts = {}) => call('PUT', url, { ...opts, body }),
  patch: (url, body, opts = {}) => call('PATCH', url, { ...opts, body }),
  delete: (url, opts) => call('DELETE', url, opts),
};

async function loginUser(account = 'petuser01', password = 'Pet123456') {
  const res = await api.post('/api/auth/login', { account, password });
  if (res.code !== 1) throw new Error(`会员登录失败: ${res.msg}`);
  return res.data.token;
}

async function loginSeller(account = 's1', password = 'Seller123456') {
  const res = await api.post('/api/seller/auth/login', { account, password });
  if (res.code !== 1) throw new Error(`商家登录失败: ${res.msg}`);
  return res.data.token;
}

async function loginAdmin(account = 'admin', password = 'Admin123456') {
  const res = await api.post('/api/admin/auth/login', { account, password });
  if (res.code !== 1) throw new Error(`平台登录失败: ${res.msg}`);
  return res.data.token;
}

/** 走通「加入购物车 → 结算预览 → 下单」 */
async function createOrder(token, { skuId, quantity = 1, userCouponId, shopCouponId } = {}) {
  const sku = skuId
    ? get('SELECT * FROM skus WHERE id = ?', skuId)
    : get(`SELECT s.* FROM skus s JOIN products p ON p.id = s.product_id
            WHERE p.name = 'P1 全阶段天然成犬粮 2kg' ORDER BY s.id LIMIT 1`);
  const add = await api.post('/api/cart/items', { productId: sku.product_id, skuId: sku.id, quantity }, { token });
  if (add.code !== 1) throw new Error(`加购失败: ${add.msg}`);
  const created = await api.post('/api/orders', { source: 'cart', userCouponId, shopCouponId }, { token });
  if (created.code !== 1) throw new Error(`下单失败: ${created.msg}`);
  return created.data.orders[0];
}

/** 下单 → 支付（沙箱）→ 返回订单 id 与支付单号 */
async function payOrder(token, order) {
  const pay = await api.post('/api/payments', { orderId: order.orderId, channel: 'alipay' }, { token });
  if (pay.code !== 1) throw new Error(`发起支付失败: ${pay.msg}`);
  const sandbox = await api.post(`/api/payments/${pay.data.payNo}/sandbox-pay`, {}, { token });
  if (sandbox.code !== 1) throw new Error(`模拟支付失败: ${sandbox.msg}`);
  return { payNo: pay.data.payNo, result: sandbox.data };
}

module.exports = {
  start, stop, api, call, loginUser, loginSeller, loginAdmin, createOrder, payOrder,
  db: { get, all, run }, dbFile,
};
