'use strict';

/** 轻量性能采样：关键接口 100 次，统计 P50/P95/P99（NFR-PERF-002） */
process.env.PET_LOG_SILENT = '1';
const { ensureSchema, close, get } = require('../src/core/db');
const { ensureDefaults } = require('../src/core/config');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');

const ROUNDS = Number(process.env.PET_PERF_ROUNDS || 100);

function pct(arr, p) {
  const v = [...arr].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))].toFixed(1);
}

(async () => {
  ensureSchema(); ensureDefaults(); seed();
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const t0 = process.hrtime.bigint();
    const res = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    await res.text();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'petuser01', password: 'Pet123456' }),
  }).then((r) => r.json());
  const token = login.data.token;
  const p1 = get("SELECT s.id AS sku_id, s.product_id FROM skus s JOIN products p ON p.id = s.product_id WHERE p.name = 'P1 全阶段天然成犬粮 2kg' ORDER BY s.id LIMIT 1");

  const scenarios = [
    ['GET /api/products', () => call('GET', '/api/products?page=1&pageSize=20')],
    ['GET /api/products/:id', () => call('GET', `/api/products/${p1.product_id}`)],
    ['GET /api/cart', () => call('GET', '/api/cart', { token })],
    ['POST /api/orders/preview', () => call('POST', '/api/orders/preview', { token, body: { source: 'buyNow', skuId: p1.sku_id, quantity: 1 } })],
    ['POST /api/orders', () => call('POST', '/api/orders', { token, body: { source: 'buyNow', skuId: p1.sku_id, quantity: 1, idempotencyKey: `perf-${Math.random()}` } })],
    ['GET /api/orders', () => call('GET', '/api/orders?page=1', { token })],
  ];

  console.log(`性能采样（${ROUNDS} 次/接口，单位 ms）`);
  console.log('接口'.padEnd(28), 'P50'.padStart(8), 'P95'.padStart(8), 'P99'.padStart(8), 'max'.padStart(8));
  for (const [name, fn] of scenarios) {
    const samples = [];
    for (let i = 0; i < ROUNDS; i += 1) samples.push(await fn());
    console.log(name.padEnd(28), pct(samples, 50).padStart(8), pct(samples, 95).padStart(8), pct(samples, 99).padStart(8), Math.max(...samples).toFixed(1).padStart(8));
  }
  server.close(); close();
})();
