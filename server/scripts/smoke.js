'use strict';

/**
 * 冒烟脚本：启动服务 → 走通「登录 → 加购 → 结算预览 → 下单 → 支付」主链路。
 * 用法：node scripts/smoke.js
 */
process.env.PET_LOG_SILENT = process.env.PET_LOG_SILENT || '1';

const { ensureSchema, close, get } = require('../src/core/db');
const { ensureDefaults } = require('../src/core/config');
const { seedIfEmpty } = require('../src/db/seed');
const { createApp } = require('../src/app');

async function main() {
  ensureSchema();
  ensureDefaults();
  seedIfEmpty();
  const server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ...json };
  };

  const log = (name, r) => {
    const brief = JSON.stringify(r).slice(0, 220);
    console.log(`${r.code === 1 || r.status < 400 ? '✅' : '❌'} ${name} [${r.status}] ${brief}`);
  };

  log('health', await call('GET', '/api/health'));
  const login = await call('POST', '/api/auth/login', { body: { account: 'petuser01', password: 'Pet123456' } });
  log('login', login);
  const token = login.data?.token;
  log('me', await call('GET', '/api/auth/me', { token }));

  const p1 = get("SELECT s.id AS sku_id, s.product_id FROM skus s JOIN products p ON p.id = s.product_id WHERE p.name = 'P1 全阶段天然成犬粮 2kg' ORDER BY s.id LIMIT 1");
  log('add cart', await call('POST', '/api/cart/items', { token, body: { productId: p1.product_id, skuId: p1.sku_id, quantity: 1 } }));
  const preview = await call('POST', '/api/orders/preview', { token, body: { source: 'cart' } });
  log('preview', preview);
  const order = await call('POST', '/api/orders', { token, body: { source: 'cart', idempotencyKey: `smoke-${Date.now()}` } });
  log('create order', order);
  const orderId = order.data?.orders?.[0]?.orderId;
  if (!orderId) throw new Error('下单失败，终止冒烟');
  log('order detail', await call('GET', `/api/orders/${orderId}`, { token }));
  const pay = await call('POST', '/api/payments', { token, body: { orderId, channel: 'alipay' } });
  log('create payment', pay);
  const payNo = pay.data?.payNo;
  log('sandbox pay', await call('POST', `/api/payments/${payNo}/sandbox-pay`, { token, body: {} }));
  log('payment query', await call('GET', `/api/payments/${payNo}`, { token }));
  log('order after pay', await call('GET', `/api/orders/${orderId}`, { token }));
  log('admin login', await call('POST', '/api/admin/auth/login', { body: { account: 'admin', password: 'Admin123456' } }));
  log('seller login', await call('POST', '/api/seller/auth/login', { body: { account: 's1', password: 'Seller123456' } }));

  server.close();
  close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('SMOKE FAILED', e); process.exit(1); });
