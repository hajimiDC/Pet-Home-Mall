'use strict';

const crypto = require('node:crypto');

/**
 * 图形验证码（FR-BE-001、NFR-SEC-005 防爆破）
 * 单实例内存存储；登录失败达到阈值后强制校验。
 * 说明：为便于自动化测试与演示，响应同时返回 code（生产环境应移除该字段）。
 */

const store = new Map();
const TTL = 5 * 60 * 1000;

function create() {
  const id = crypto.randomUUID();
  const code = String(Math.floor(1000 + Math.random() * 9000));
  store.set(id, { code, expireAt: Date.now() + TTL });
  const svg = renderSvg(code);
  return { id, code, svg, expireSeconds: TTL / 1000 };
}

function renderSvg(code) {
  const chars = code.split('').map((c, i) => {
    const x = 18 + i * 22;
    const y = 28 + Math.floor(Math.random() * 6) - 3;
    const rotate = Math.floor(Math.random() * 30) - 15;
    return `<text x="${x}" y="${y}" font-size="24" font-family="monospace" fill="#d94a4a" transform="rotate(${rotate} ${x} ${y})">${c}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="#f7f7f7"/>${chars}</svg>`;
}

function verify(id, input) {
  const rec = store.get(String(id || ''));
  if (!rec) return false;
  if (rec.expireAt < Date.now()) { store.delete(id); return false; }
  const ok = String(input || '').trim() === rec.code;
  if (ok) store.delete(id);
  return ok;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (v.expireAt < now) store.delete(k);
}, 60000).unref();

module.exports = { create, verify };
