'use strict';

const { Router, createServer } = require('./core/http');
const { authorize } = require('./core/auth');
const ratelimit = require('./core/ratelimit');
const { Logger } = require('./core/logger');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 应用装配（对应 NFR-MAINT-001 分层架构的 Controller 层入口）。
 * 路由声明形如：
 *   api.get('/api/products/:id', { optionalUser: true }, handler)
 *   api.post('/api/orders', { auth: 'user', rate: { limit: 30, window: 60 } }, handler)
 *   api.get('/api/admin/products', { auth: 'admin', perm: 'ops.product-audit' }, handler)
 */

function makeApi(router) {
  const wrap = (method) => (pattern, optsOrHandler, maybeHandler) => {
    const opts = typeof optsOrHandler === 'function' ? {} : (optsOrHandler || {});
    const handler = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler;
    if (typeof handler !== 'function') throw new Error(`路由未提供处理函数: ${method} ${pattern}`);
    router.add(method, pattern, async (ctx) => {
      if (opts.auth || opts.optionalUser) authorize(ctx, opts);
      if (opts.rate) {
        const subject = ctx.auth ? `${ctx.auth.type}:${ctx.auth.id}` : `ip:${ctx.ip}`;
        ratelimit.hit(`${method} ${pattern} ${subject}`, opts.rate.limit, opts.rate.window || 60);
      }
      return handler(ctx);
    }, opts);
  };
  return {
    get: wrap('GET'), post: wrap('POST'), put: wrap('PUT'),
    patch: wrap('PATCH'), delete: wrap('DELETE'),
    router,
  };
}

function registerAll(api, modulesDir = path.join(__dirname, 'modules')) {
  const files = fs.readdirSync(modulesDir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  for (const file of files.sort()) {
    const mod = require(path.join(modulesDir, file));
    const register = typeof mod === 'function' ? mod : mod.register;
    if (typeof register !== 'function') throw new Error(`模块 ${file} 未导出 register 函数`);
    register(api);
  }
  Logger.info('modules-registered', { count: files.length, files });
}

function createApp() {
  const router = new Router();
  const api = makeApi(router);
  registerAll(api);
  api.get('/api/health', {}, health);
  api.get('/', {}, (ctx) => ({
    name: '宠物之家商城 · 后端服务',
    version: require('../package.json').version,
    docs: '/api/health',
  }));
  const server = createServer(router);
  server.app = { router, api };
  return server;
}

function health(ctx) {
  const { get } = require('./core/db');
  const started = process.uptime();
  const row = get('SELECT 1 AS ok');
  return {
    status: 'UP',
    db: row?.ok === 1 ? 'UP' : 'DOWN',
    uptimeSeconds: Math.floor(started),
    now: new Date().toISOString(),
    requestId: ctx.requestId,
  };
}

module.exports = { createApp, makeApi, registerAll };
