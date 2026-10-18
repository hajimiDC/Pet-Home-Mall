'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { AppError, Errors } = require('./errors');
const { now } = require('./money');
const { Logger } = require('./logger');

/**
 * 轻量 HTTP 框架（替代 Express，零外部依赖）。
 * 提供：路径参数路由、JSON 请求体、统一响应体、统一异常、静态资源、请求日志与 requestId。
 * 统一响应体遵循《需求文档》10.5：{ code: 1, msg: 'success', data: null }
 */

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MAX_BODY = 12 * 1024 * 1024; // 支持 5MB 图片经 base64 传输（约 6.7MB）+ 余量

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const segments = pattern.split('/').filter(Boolean);
    this.routes.push({ method, pattern, segments, handler, opts });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { matched = false; break; }
      }
      if (matched) return { route, params };
    }
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Errors.badRequest('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf, contentType) {
  if (!buf || buf.length === 0) return {};
  const type = String(contentType || '');
  if (type.includes('application/json') || type.includes('text/plain') || type === '') {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch (_) {
      throw Errors.badRequest('请求体不是合法的 JSON');
    }
  }
  return { raw: buf };
}

function ok(ctx, data = null, msg = 'success') {
  return sendJson(ctx, 200, { code: 1, msg, data });
}

function fail(ctx, msg, httpStatus = 400, extra = {}) {
  return sendJson(ctx, httpStatus, { code: 0, msg, data: null, ...extra });
}

function sendJson(ctx, status, payload) {
  if (ctx.res.writableEnded) return;
  const body = JSON.stringify(payload);
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Request-Id': ctx.requestId,
    'Cache-Control': 'no-store',
  });
  ctx.res.end(body);
}

function sendRaw(ctx, status, contentType, buf, filename) {
  const headers = {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'X-Request-Id': ctx.requestId,
  };
  if (filename) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`;
  ctx.res.writeHead(status, headers);
  ctx.res.end(buf);
}

function serveStatic(ctx, baseDir, relative) {
  const safe = path.normalize(relative).replace(/^([/\\])+/, '');
  const full = path.join(baseDir, safe);
  if (!full.startsWith(path.normalize(baseDir))) return fail(ctx, '资源不存在', 404);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return fail(ctx, '资源不存在', 404);
  const ext = path.extname(full).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
  };
  const buf = fs.readFileSync(full);
  return sendRaw(ctx, 200, types[ext] || 'application/octet-stream', buf);
}

/** 分页响应包装：{ total, rows } */
function page(rows, total, extra = {}) {
  return { total, rows, ...extra };
}

function createServer(router, { logger } = {}) {
  const log = logger || Logger;

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(parsed.pathname);
    const ctx = {
      req,
      res,
      method: req.method,
      pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
      params: {},
      body: {},
      files: [],
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '',
      requestId,
      auth: null,
      startedAt: started,
      userAgent: req.headers['user-agent'] || '',
    };

    try {
      // 静态资源与上传文件
      if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
        return serveStatic(ctx, UPLOAD_DIR, pathname.slice('/uploads/'.length));
      }
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        return serveStatic(ctx, PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
      }

      const matched = router.match(req.method, pathname);
      if (!matched) throw Errors.notFound(`接口不存在: ${req.method} ${pathname}`);
      ctx.params = matched.params;
      ctx.route = matched.route;

      const buf = await readBody(req);
      const contentType = req.headers['content-type'] || '';
      if (buf.length && (contentType.includes('multipart/form-data'))) {
        ctx.rawBody = buf;
        ctx.body = {};
      } else {
        ctx.body = parseJsonBody(buf, contentType);
      }
      if (ctx.body && typeof ctx.body === 'object' && !Buffer.isBuffer(ctx.body)) {
        for (const [k, v] of Object.entries(ctx.body)) {
          if (typeof v === 'string') ctx.body[k] = v.trim();
        }
      }

      const result = await matched.route.handler(ctx);
      if (result !== undefined && !ctx.res.writableEnded) ok(ctx, result);
      if (!ctx.res.writableEnded) ok(ctx, null);

      log.info('access', {
        requestId, method: req.method, path: pathname, status: ctx.res.statusCode,
        cost: Date.now() - started, ip: ctx.ip,
      });
    } catch (err) {
      const isApp = err instanceof AppError;
      const status = isApp ? err.httpStatus : 500;
      const msg = isApp ? err.message : '服务器内部错误';
      if (!isApp) log.error('unhandled', { requestId, path: pathname, message: err.message, stack: err.stack });
      else if (status >= 500) log.error('app-error', { requestId, path: pathname, message: err.message });
      else log.warn('biz-error', { requestId, method: req.method, path: pathname, status, message: err.message });
      fail(ctx, msg, status, err.details ? { details: err.details } : {});
    }
  });
}

/** 记录审计日志（供 service 层调用，失败不阻断主流程） */
function auditLog({ adminId = null, adminName = '', roleCode = '', module, action, targetType = '', targetId = '', detail = '', ip = '' }) {
  try {
    const { run } = require('./db');
    run(
      `INSERT INTO operation_logs (admin_id, admin_name, role_code, module, action, target_type, target_id, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      adminId, adminName || '', roleCode || '', module, action, String(targetType || ''),
      String(targetId || ''), typeof detail === 'string' ? detail : JSON.stringify(detail), ip || '', now(),
    );
  } catch (_) { /* 审计失败不影响业务 */ }
}

module.exports = {
  Router, createServer, ok, fail, page, sendRaw, auditLog, UPLOAD_DIR, PUBLIC_DIR, MAX_BODY,
};
