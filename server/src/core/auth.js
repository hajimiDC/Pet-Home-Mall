'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Errors } = require('./errors');
const { now, parseTime, addMinutes } = require('./money');
const { get, run } = require('./db');

/**
 * 认证与鉴权（FR-BE-001 ~ FR-BE-009、NFR-SEC-001 / 002 / 005）
 * - 密码：BCrypt 加盐哈希（cost=10）
 * - 令牌：JWT HS256，服务端落库 auth_tokens（支持登出立即失效、后台 30 分钟静置自动登出）
 * - 后台鉴权：RBAC（admin_user → role → permission），商家端强制 shop_id 隔离
 */

const JWT_SECRET = process.env.PET_JWT_SECRET || 'pet-home-mall-dev-secret-2026';
const USER_TOKEN_TTL_MIN = Number(process.env.PET_USER_TOKEN_TTL_MIN || 7 * 24 * 60);
const ADMIN_TOKEN_TTL_MIN = Number(process.env.PET_ADMIN_TOKEN_TTL_MIN || 8 * 60);
const ADMIN_IDLE_MIN = Number(process.env.PET_ADMIN_IDLE_MIN || 30);
const BCRYPT_COST = 10;

const permissionCache = new Map(); // roleId -> { codes:Set, at:number }

function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_COST);
}

function verifyPassword(plain, hash) {
  if (!hash) return false;
  try { return bcrypt.compareSync(plain, hash); } catch (_) { return false; }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function verify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw Errors.unauthorized('令牌格式不正确');
  const [header, body, sig] = parts;
  const expect = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw Errors.unauthorized('令牌签名校验失败');
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); } catch (_) { throw Errors.unauthorized('令牌内容不合法'); }
  if (!payload.exp || parseTime(payload.exp) <= new Date()) throw Errors.unauthorized('登录已过期，请重新登录');
  return payload;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * 签发令牌并落库
 * @param {'user'|'seller'|'admin'} type
 * @param {number} id
 * @param {{remember?:boolean, shopId?:number, roleId?:number, roleCode?:string, name?:string}} extra
 */
function issueToken(type, id, extra = {}) {
  const ttl = type === 'user' ? (extra.remember ? Math.max(USER_TOKEN_TTL_MIN, 30 * 24 * 60) : USER_TOKEN_TTL_MIN) : ADMIN_TOKEN_TTL_MIN;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttl * 60000);
  const payload = {
    sub: id,
    typ: type,
    shopId: extra.shopId ?? null,
    roleId: extra.roleId ?? null,
    role: extra.roleCode ?? null,
    jti: crypto.randomUUID(),
    iat: Math.floor(issuedAt.getTime() / 1000),
    exp: `${expiresAt.toISOString().slice(0, 10)} ${expiresAt.toISOString().slice(11, 19)}`,
  };
  const token = sign(payload);
  run(
    `INSERT INTO auth_tokens (token_hash, subject_type, subject_id, issued_at, expires_at, last_active_at, revoked)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    sha256(token), type, id, now(), payload.exp, now(),
  );
  return { token, expiresAt: payload.exp, expiresIn: ttl * 60 };
}

function revokeToken(token) {
  if (!token) return;
  run('UPDATE auth_tokens SET revoked = 1 WHERE token_hash = ?', sha256(token));
}

function revokeAllOf(type, id) {
  run('UPDATE auth_tokens SET revoked = 1 WHERE subject_type = ? AND subject_id = ?', type, id);
}

function rolePermissions(roleId) {
  if (!roleId) return new Set();
  const cached = permissionCache.get(roleId);
  if (cached && Date.now() - cached.at < 30000) return cached.codes;
  const rows = require('./db').all(
    `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?
     UNION
     SELECT r.code AS code FROM roles r WHERE r.id = ? AND r.code = 'super_admin'`,
    roleId, roleId,
  );
  const codes = new Set(rows.map((r) => r.code));
  permissionCache.set(roleId, { codes, at: Date.now() });
  return codes;
}

function clearPermissionCache() { permissionCache.clear(); }

function hasPermission(admin, code) {
  if (!code) return true;
  if (!admin) return false;
  if (admin.type === 'seller') return true; // 商家端按 shop_id 隔离，菜单权限由前端按入驻状态裁剪
  const codes = rolePermissions(admin.role_id);
  if (codes.has('*') || codes.has('super_admin')) return true;
  return codes.has(code) || codes.has(`${code}.view`);
}

/** 从请求头解析令牌并校验会话有效性 */
function resolveSession(ctx) {
  const header = ctx.req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const token = m[1].trim();
  const payload = verify(token);
  const record = get('SELECT * FROM auth_tokens WHERE token_hash = ?', sha256(token));
  if (!record || record.revoked) throw Errors.unauthorized('登录已失效，请重新登录');
  if (parseTime(record.expires_at) <= new Date()) throw Errors.unauthorized('登录已过期，请重新登录');

  const isBackend = payload.typ === 'seller' || payload.typ === 'admin';
  if (isBackend) {
    // FR-BE-008：后台会话 30 分钟无操作自动登出
    const idleMin = (Date.now() - parseTime(record.last_active_at).getTime()) / 60000;
    if (idleMin > ADMIN_IDLE_MIN) {
      run('UPDATE auth_tokens SET revoked = 1 WHERE id = ?', record.id);
      throw Errors.unauthorized('长时间未操作，已自动退出，请重新登录');
    }
    run('UPDATE auth_tokens SET last_active_at = ? WHERE id = ?', now(), record.id);
  }

  if (payload.typ === 'user') {
    const user = get('SELECT * FROM users WHERE id = ?', payload.sub);
    if (!user) throw Errors.unauthorized('账号不存在');
    if (user.status !== 1) throw Errors.forbidden('账号已被禁用');
    return { type: 'user', id: user.id, token, user };
  }

  const admin = get('SELECT * FROM admin_users WHERE id = ?', payload.sub);
  if (!admin) throw Errors.unauthorized('后台账号不存在');
  if (admin.status !== 1) throw Errors.forbidden('后台账号已被禁用');
  if (payload.typ === 'seller') {
    if (admin.type !== 'seller') throw Errors.forbidden('非商家账号');
    return { type: 'seller', id: admin.id, token, admin, shopId: admin.shop_id };
  }
  if (admin.type !== 'admin') throw Errors.forbidden('非平台账号');
  return { type: 'admin', id: admin.id, token, admin, roleCode: admin.role_id ? (get('SELECT code FROM roles WHERE id = ?', admin.role_id)?.code) : null };
}

/**
 * 路由级鉴权入口
 * @param {object} ctx
 * @param {{auth?:'user'|'seller'|'admin'|'any', perm?:string|string[], optionalUser?:boolean}} opts
 */
function authorize(ctx, opts = {}) {
  const wanted = opts.auth || (opts.optionalUser ? 'optional-user' : 'none');
  if (wanted === 'none') return null;

  const session = resolveSession(ctx);
  if (!session) {
    if (wanted === 'optional-user') return null;
    throw Errors.unauthorized('请先登录');
  }
  ctx.auth = session;
  ctx.user = session.type === 'user' ? session.user : null;
  ctx.admin = session.admin || null;

  if (wanted === 'user') {
    if (session.type !== 'user') throw Errors.forbidden('请使用会员账号访问');
    return session;
  }
  if (wanted === 'seller') {
    if (session.type !== 'seller') throw Errors.forbidden('请使用商家账号访问');
    return session;
  }
  if (wanted === 'admin') {
    if (session.type !== 'admin') throw Errors.forbidden('请使用平台账号访问');
    const perms = opts.perm ? (Array.isArray(opts.perm) ? opts.perm : [opts.perm]) : [];
    if (perms.length === 0) return session; // 仅要求登录（如 /auth/me），不做权限码校验
    const allowed = opts.permMode === 'all' ? perms.every((p) => hasPermission(session.admin, p)) : perms.some((p) => hasPermission(session.admin, p));
    if (!allowed) throw Errors.forbidden('无权访问该功能（403）');
    return session;
  }
  if (wanted === 'any') return session;
  return session;
}

/** 商家数据隔离：取当前商家 shop_id，缺失则提示先入驻（FR-BE-006） */
function requireShop(ctx) {
  const admin = ctx.admin;
  if (!admin || !admin.shop_id) throw Errors.forbidden('请先完成入驻审核');
  const shop = get('SELECT * FROM shops WHERE id = ?', admin.shop_id);
  if (!shop) throw Errors.forbidden('店铺不存在，请先完成入驻审核');
  return shop;
}

module.exports = {
  authorize, resolveSession, issueToken, revokeToken, revokeAllOf, hashPassword, verifyPassword,
  hasPermission, rolePermissions, clearPermissionCache, requireShop,
  JWT_SECRET, ADMIN_IDLE_MIN, BCRYPT_COST,
};
