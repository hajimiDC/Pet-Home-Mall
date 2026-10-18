'use strict';

/** 导出全部已注册路由清单（用于生成《接口清单》文档、核对 API-001~156 覆盖度） */
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../src/app');

const app = createApp();
const routes = app.app.router.routes
  .map((r) => ({
    method: r.method,
    path: r.pattern,
    auth: r.opts.auth || (r.opts.optionalUser ? 'optional' : 'public'),
    perm: r.opts.perm ? (Array.isArray(r.opts.perm) ? r.opts.perm.join(',') : r.opts.perm) : '',
    rate: r.opts.rate ? `${r.opts.rate.limit}/${r.opts.rate.window || 60}s` : '',
  }))
  .sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));

const outFile = process.argv[2] || path.join(__dirname, '..', '..', 'docs', '接口清单.md');
const lines = [
  '# 宠物之家商城 · 接口清单（自动生成）',
  '',
  `> 由 \`server/scripts/routes.js\` 从路由注册表导出，共 **${routes.length}** 个路由。`,
  '> 鉴权：public = 无需登录；optional = 可选登录；user = 会员；seller = 商家；admin = 平台（含权限码）。',
  '',
  '| # | 方法 | 路径 | 鉴权 | 权限码 | 限流 |',
  '|---|---|---|---|---|---|',
  ...routes.map((r, i) => `| ${i + 1} | ${r.method} | \`${r.path}\` | ${r.auth} | ${r.perm || '-'} | ${r.rate || '-'} |`),
  '',
];
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
console.log(`已导出 ${routes.length} 个路由到 ${outFile}`);
