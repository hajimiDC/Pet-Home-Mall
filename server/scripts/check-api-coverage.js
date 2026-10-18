'use strict';

/**
 * 接口覆盖度核对：解析《需求文档》10.5 / 9.6 的 API 表格，与已注册路由逐一比对。
 * 用法：node scripts/check-api-coverage.js
 */
const fs = require('node:fs');
const path = require('node:path');

const DOC = process.env.PET_REQ_DOC || 'C:/Users/可乐绝育了/.dsh/attachments/v1/files/eb/eb447bb4d6f96f7be6c99933268837fbf53da05868f5871fb9bf194bf1c496fe/需求文档.md';
const text = fs.readFileSync(DOC, 'utf8');

const required = [];
const re = /^\|\s*(API-\d{3})\s*\|[^|]*\|[^|]*\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|/gm;
let m;
while ((m = re.exec(text)) !== null) required.push({ id: m[1], method: m[2], path: m[3].trim() });

const { createApp } = require('../src/app');
const app = createApp();
const routes = app.app.router.routes.map((r) => ({ method: r.method, path: r.pattern }));

function normalize(p) {
  return p.replace(/\{[^}]+\}/g, ':param').replace(/\/:([A-Za-z_]+)/g, '/:param').replace(/\/+$/, '');
}
const routeKeys = new Set(routes.map((r) => `${r.method} ${normalize(r.path)}`));

const missing = required.filter((r) => !routeKeys.has(`${r.method} ${normalize(r.path)}`));
const unique = [...new Map(required.map((r) => [`${r.id}`, r])).values()];

console.log(`需求文档接口数：${unique.length}`);
console.log(`已注册路由数：${routes.length}`);
console.log(`已覆盖：${unique.length - missing.length}`);
if (missing.length) {
  console.log('\n未覆盖接口：');
  for (const x of missing) console.log(`  ${x.id} ${x.method} ${x.path}`);
} else {
  console.log('\n✅ 需求文档列出的 API 全部已实现');
}

const apiNumbers = [...new Set(unique.map((r) => Number(r.id.slice(4))))].sort((a, b) => a - b);
const gaps = [];
for (let i = apiNumbers[0]; i <= apiNumbers[apiNumbers.length - 1]; i += 1) if (!apiNumbers.includes(i)) gaps.push(i);
console.log(`编号区间：API-${apiNumbers[0]} ~ API-${apiNumbers[apiNumbers.length - 1]}；缺号：${gaps.length ? gaps.join(', ') : '无'}`);
process.exit(missing.length ? 1 : 0);
