'use strict';

const db = require('../core/db');
const { Errors } = require('../core/errors');
const { toYuan, now, today } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const { auditLog, sendRaw } = require('../core/http');
const { hashPassword, revokeAllOf, clearPermissionCache, hasPermission } = require('../core/auth');
const v = require('../core/validate');
const config = require('../core/config');

/**
 * 平台后台 · 系统管理域（API-141 ~ API-150）
 * 对应《需求文档》9.4.5 管理员与系统（FR-SYS-001 ~ FR-SYS-015）、9.6.2、Q-016。
 *
 * 关键约束：
 *  - 会员/商家账号禁用后立即吊销其全部令牌（revokeAllOf），无需等待令牌过期（FR-SYS-002）；
 *  - 平台账号密码 BCrypt 哈希、首次登录强制改密（must_change_pwd = 1，FR-SYS-004）；
 *  - 内置角色（builtin = 1）不可删除；角色权限变更后 clearPermissionCache 立即生效（FR-SYS-006）；
 *  - 操作日志只读（无写接口），导出需 action.log.export 权限并记录导出日志（FR-SYS-013）。
 */

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(ctx, filename, headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  const buf = Buffer.from(`\uFEFF${lines.join('\r\n')}`, 'utf8');
  return sendRaw(ctx, 200, 'text/csv; charset=utf-8', buf, filename);
}

function isExport(ctx) {
  return String(ctx.query.export || '').toLowerCase() === 'csv';
}

function pagingOf(ctx) {
  return db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
}

/** 0/1 状态归一化：兼容 0/1、'0'/'1'、true/false */
function parseStatus(value, field = 'status') {
  if (value === true) return 1;
  if (value === false) return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || (n !== 0 && n !== 1)) {
    throw Errors.badRequest('状态取值不合法（1 启用 / 0 禁用）', { field });
  }
  return n;
}

function normDate(value, field) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '').trim());
  if (!m) throw Errors.badRequest('日期格式应为 YYYY-MM-DD', { field });
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function randomPassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  let s = '';
  for (let i = 0; i < 7; i += 1) s += letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < 2; i += 1) s += digits[Math.floor(Math.random() * digits.length)];
  return `Pet${s}`;
}

const ACCOUNT_RE = /^[A-Za-z0-9_]{4,20}$/;

function normAccount(value) {
  const s = String(value || '').trim();
  if (!ACCOUNT_RE.test(s)) throw Errors.badRequest('账号需为 4-20 位字母、数字或下划线', { field: 'account' });
  return s;
}

/* ------------------------------------------------------------------ *
 * API-141 / 142 会员管理
 * ------------------------------------------------------------------ */

function toUserApi(u) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname || '',
    phoneMask: maskPhone(u.phone),
    email: u.email || '',
    registerAt: u.created_at,
    createdAt: u.created_at,
    // 第三方登录本期不接入（Q-007），绑定信息恒为空
    thirdPartyBindings: [],
    thirdPartyBound: false,
    status: u.status,
    statusName: u.status === 1 ? '正常' : '已禁用',
    lastLoginAt: u.last_login_at,
  };
}

function listUsers(ctx) {
  const { page, pageSize, limit, offset } = pagingOf(ctx);
  const q = ctx.query;
  const params = [];
  let where = 'WHERE 1 = 1';
  if (q.phone) { where += ' AND phone LIKE ?'; params.push(`%${q.phone}%`); }
  if (q.nickname) { where += ' AND nickname LIKE ?'; params.push(`%${q.nickname}%`); }
  if (q.keyword) {
    where += ' AND (nickname LIKE ? OR username LIKE ? OR phone LIKE ?)';
    params.push(`%${q.keyword}%`, `%${q.keyword}%`, `%${q.keyword}%`);
  }
  if (q.status !== undefined && q.status !== '') {
    where += ' AND status = ?';
    params.push(parseStatus(q.status));
  }
  const total = db.get(`SELECT COUNT(*) AS c FROM users ${where}`, ...params).c;
  const rows = db.all(`SELECT * FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  return { total, rows: rows.map(toUserApi), page, pageSize };
}

function setUserStatus(ctx) {
  const id = Number(ctx.params.id);
  const status = parseStatus(ctx.body.status);
  const user = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw Errors.notFound('会员不存在');
  db.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
  // 禁用后该用户所有令牌立即失效（FR-SYS-002 / NFR-SEC-001）
  if (status === 0) revokeAllOf('user', id);
  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '系统管理-用户管理', action: status === 1 ? '启用会员' : '禁用会员',
    targetType: 'user', targetId: id,
    detail: { username: user.username, from: user.status, to: status, tokenRevoked: status === 0 }, ip: ctx.ip,
  });
  return { ...toUserApi(db.get('SELECT * FROM users WHERE id = ?', id)), tokenRevoked: status === 0 };
}

/* ------------------------------------------------------------------ *
 * API-143 商家账号
 * ------------------------------------------------------------------ */

function toSellerApi(row) {
  return {
    id: row.id,
    account: row.account,
    name: row.name || '',
    type: row.type,
    shopId: row.shop_id,
    shopName: row.shop_name || '',
    shopStatus: row.shop_status,
    status: row.status,
    statusName: row.status === 1 ? '正常' : '已禁用',
    mustChangePwd: row.must_change_pwd === 1,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

function listSellerAccounts(ctx) {
  const { page, pageSize, limit, offset } = pagingOf(ctx);
  const q = ctx.query;
  const params = [];
  let where = "WHERE a.type = 'seller'";
  if (q.keyword) {
    where += ' AND (a.account LIKE ? OR a.name LIKE ? OR s.name LIKE ?)';
    params.push(`%${q.keyword}%`, `%${q.keyword}%`, `%${q.keyword}%`);
  }
  if (q.status !== undefined && q.status !== '') { where += ' AND a.status = ?'; params.push(parseStatus(q.status)); }
  if (q.shopId) { where += ' AND a.shop_id = ?'; params.push(Number(q.shopId)); }
  const from = 'FROM admin_users a LEFT JOIN shops s ON s.id = a.shop_id';
  const total = db.get(`SELECT COUNT(*) AS c ${from} ${where}`, ...params).c;
  const rows = db.all(
    `SELECT a.*, s.name AS shop_name, s.status AS shop_status ${from} ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  return { total, rows: rows.map(toSellerApi), page, pageSize };
}

function setSellerStatus(ctx) {
  const id = Number(ctx.params.id);
  const status = parseStatus(ctx.body.status);
  const admin = db.get("SELECT * FROM admin_users WHERE id = ? AND type = 'seller'", id);
  if (!admin) throw Errors.notFound('商家账号不存在');
  db.run('UPDATE admin_users SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
  // 禁用后令牌失效（subject_type = seller）
  if (status === 0) revokeAllOf('seller', id);
  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '系统管理-商家账号', action: status === 1 ? '启用商家账号' : '禁用商家账号',
    targetType: 'admin_user', targetId: id,
    detail: { account: admin.account, shopId: admin.shop_id, from: admin.status, to: status, tokenRevoked: status === 0 },
    ip: ctx.ip,
  });
  const fresh = db.get(
    'SELECT a.*, s.name AS shop_name, s.status AS shop_status FROM admin_users a LEFT JOIN shops s ON s.id = a.shop_id WHERE a.id = ?',
    id,
  );
  return { ...toSellerApi(fresh), tokenRevoked: status === 0 };
}

function resetSellerPassword(ctx) {
  const id = Number(ctx.params.id);
  const admin = db.get("SELECT * FROM admin_users WHERE id = ? AND type = 'seller'", id);
  if (!admin) throw Errors.notFound('商家账号不存在');
  const body = ctx.body || {};
  const plain = body.password ? v.password(body.password) : randomPassword();
  db.run(
    `UPDATE admin_users SET password_hash = ?, must_change_pwd = 1, fail_count = 0, locked_until = NULL, updated_at = ?
      WHERE id = ?`,
    hashPassword(plain), now(), id,
  );
  revokeAllOf('seller', id);
  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '系统管理-商家账号', action: '重置商家密码', targetType: 'admin_user', targetId: id,
    detail: { account: admin.account, shopId: admin.shop_id, mustChangePwd: true, tokenRevoked: true }, ip: ctx.ip,
  });
  return { id, account: admin.account, newPassword: plain, mustChangePwd: true, tokenRevoked: true };
}

/* ------------------------------------------------------------------ *
 * API-144 平台账号
 * ------------------------------------------------------------------ */

function toAdminApi(row) {
  return {
    id: row.id,
    account: row.account,
    name: row.name || '',
    type: row.type,
    roleId: row.role_id,
    roleCode: row.role_code || null,
    roleName: row.role_name || null,
    status: row.status,
    statusName: row.status === 1 ? '正常' : '已停用',
    mustChangePwd: row.must_change_pwd === 1,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

function listAdminUsers(ctx) {
  const { page, pageSize, limit, offset } = pagingOf(ctx);
  const q = ctx.query;
  const params = [];
  let where = "WHERE a.type = 'admin'";
  if (q.keyword) { where += ' AND (a.account LIKE ? OR a.name LIKE ?)'; params.push(`%${q.keyword}%`, `%${q.keyword}%`); }
  if (q.status !== undefined && q.status !== '') { where += ' AND a.status = ?'; params.push(parseStatus(q.status)); }
  if (q.roleId) { where += ' AND a.role_id = ?'; params.push(Number(q.roleId)); }
  const from = 'FROM admin_users a LEFT JOIN roles r ON r.id = a.role_id';
  const total = db.get(`SELECT COUNT(*) AS c ${from} ${where}`, ...params).c;
  const rows = db.all(
    `SELECT a.*, r.code AS role_code, r.name AS role_name ${from} ${where} ORDER BY a.id ASC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  return { total, rows: rows.map(toAdminApi), page, pageSize };
}

function saveAdminUser(ctx) {
  const b = ctx.body || {};
  const id = b.id !== undefined && b.id !== null && b.id !== '' ? v.int(b.id, 'id', { min: 1 }) : null;
  const roleId = b.roleId !== undefined && b.roleId !== null && b.roleId !== ''
    ? v.int(b.roleId, 'roleId', { min: 1 }) : null;
  if (roleId) {
    const role = db.get('SELECT * FROM roles WHERE id = ?', roleId);
    if (!role) throw Errors.badRequest('角色不存在', { field: 'roleId' });
  }
  const status = b.status !== undefined && b.status !== null && b.status !== '' ? parseStatus(b.status) : 1;

  let target = null;
  if (id) {
    target = db.get('SELECT * FROM admin_users WHERE id = ?', id);
    if (!target) throw Errors.notFound('平台账号不存在');
    if (target.type === 'seller') throw Errors.badRequest('商家账号请在「商家账号」中维护');
    if (id === ctx.admin.id && status === 0) throw Errors.badRequest('不能停用当前登录账号');
  }

  const account = b.account !== undefined && b.account !== '' ? normAccount(b.account) : (target ? target.account : null);
  if (!account) throw Errors.badRequest('账号不能为空', { field: 'account' });
  const dup = db.get('SELECT id FROM admin_users WHERE account = ?', account);
  if (dup && (!target || dup.id !== target.id)) throw Errors.badRequest('账号已存在', { field: 'account' });

  if (!target) {
    const name = v.str(b.name, 'name', { min: 1, max: 32 });
    const plain = v.password(b.password);
    if (!roleId) throw Errors.badRequest('角色不能为空', { field: 'roleId' });
    const newId = db.run(
      `INSERT INTO admin_users (account, password_hash, name, type, shop_id, role_id, status, must_change_pwd, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', NULL, ?, ?, 1, ?, ?)`,
      account, hashPassword(plain), name, roleId, status, now(), now(),
    ).lastInsertRowid;
    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '系统管理-平台账号', action: '新增平台账号', targetType: 'admin_user', targetId: newId,
      detail: { account, name, roleId, status }, ip: ctx.ip,
    });
    return { created: true, ...toAdminApi(db.get(
      'SELECT a.*, r.code AS role_code, r.name AS role_name FROM admin_users a LEFT JOIN roles r ON r.id = a.role_id WHERE a.id = ?', newId,
    )) };
  }

  const name = b.name !== undefined && b.name !== '' ? v.str(b.name, 'name', { min: 1, max: 32 }) : target.name;
  const nextRoleId = roleId || target.role_id;
  db.run('UPDATE admin_users SET account = ?, name = ?, role_id = ?, status = ?, updated_at = ? WHERE id = ?',
    account, name, nextRoleId, status, now(), id);

  let passwordReset = false;
  if (b.password) {
    db.run('UPDATE admin_users SET password_hash = ?, must_change_pwd = 1, updated_at = ? WHERE id = ?',
      hashPassword(v.password(b.password)), now(), id);
    passwordReset = true;
  }
  // 停用或重置密码后立即吊销该账号全部令牌
  if (status === 0 || passwordReset) revokeAllOf('admin', id);
  clearPermissionCache();

  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '系统管理-平台账号',
    action: status === 0 ? '停用平台账号' : (status === 1 && target.status === 0 ? '启用平台账号' : '编辑平台账号'),
    targetType: 'admin_user', targetId: id,
    detail: { account, name, roleId: nextRoleId, status, passwordReset, tokenRevoked: status === 0 || passwordReset },
    ip: ctx.ip,
  });
  return {
    created: false,
    passwordReset,
    ...toAdminApi(db.get(
      'SELECT a.*, r.code AS role_code, r.name AS role_name FROM admin_users a LEFT JOIN roles r ON r.id = a.role_id WHERE a.id = ?', id,
    )),
  };
}

/* ------------------------------------------------------------------ *
 * API-145 角色与权限分配
 * ------------------------------------------------------------------ */

function permissionsOfRole(roleId) {
  return db.all(
    `SELECT p.id, p.code, p.name, p.type FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? ORDER BY p.type, p.id`,
    roleId,
  );
}

function toRoleApi(row) {
  const perms = permissionsOfRole(row.id);
  const accounts = db.get('SELECT COUNT(*) AS c FROM admin_users WHERE role_id = ?', row.id).c;
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    builtin: row.builtin === 1,
    builtinValue: row.builtin,
    permissionIds: perms.map((p) => p.id),
    permissionCodes: perms.map((p) => p.code),
    permissions: perms,
    accountCount: accounts,
    createdAt: row.created_at,
  };
}

function listRoles(ctx) {
  const rows = db.all('SELECT * FROM roles ORDER BY builtin DESC, id ASC');
  return { total: rows.length, rows: rows.map(toRoleApi) };
}

/** 解析权限入参：permissionIds（数字）或 permissionCodes（权限码）；未提供返回 null */
function resolvePermissionIds(body) {
  const hasIds = Array.isArray(body.permissionIds);
  const hasCodes = Array.isArray(body.permissionCodes);
  if (!hasIds && !hasCodes) return null;
  const ids = new Set();
  if (hasIds) {
    for (const raw of body.permissionIds) {
      const id = Number(raw);
      if (!Number.isInteger(id)) throw Errors.badRequest('权限 ID 不合法', { field: 'permissionIds' });
      ids.add(id);
    }
  }
  if (hasCodes) {
    for (const raw of body.permissionCodes) {
      const code = String(raw || '').trim();
      const p = db.get('SELECT id FROM permissions WHERE code = ?', code);
      if (!p) throw Errors.badRequest(`权限码不存在：${code}`, { field: 'permissionCodes' });
      ids.add(p.id);
    }
  }
  const result = [...ids];
  for (const id of result) {
    if (!db.get('SELECT id FROM permissions WHERE id = ?', id)) {
      throw Errors.badRequest(`权限不存在：${id}`, { field: 'permissionIds' });
    }
  }
  return result;
}

function replaceRolePermissions(roleId, permissionIds) {
  db.run('DELETE FROM role_permissions WHERE role_id = ?', roleId);
  for (const pid of permissionIds) {
    db.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', roleId, pid);
  }
  // 权限变更立即生效（清空角色权限缓存）
  clearPermissionCache();
}

function deleteRole(ctx, roleId) {
  const role = db.get('SELECT * FROM roles WHERE id = ?', Number(roleId));
  if (!role) throw Errors.notFound('角色不存在');
  if (role.builtin === 1) throw Errors.badRequest('内置角色不可删除');
  const used = db.get('SELECT COUNT(*) AS c FROM admin_users WHERE role_id = ?', role.id).c;
  if (used > 0) throw Errors.badRequest('该角色下仍有账号，无法删除');
  db.transaction(() => {
    db.run('DELETE FROM role_permissions WHERE role_id = ?', role.id);
    db.run('DELETE FROM roles WHERE id = ?', role.id);
  });
  clearPermissionCache();
  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '系统管理-角色权限', action: '删除角色', targetType: 'role', targetId: role.id,
    detail: { name: role.name, code: role.code }, ip: ctx.ip,
  });
  return { deleted: true, id: role.id, code: role.code };
}

/** 角色新增 / 编辑 / 删除（POST 单一入口，action = create|update|delete） */
function saveRole(ctx) {
  const b = ctx.body || {};
  const action = String(b.action || (b.delete === true ? 'delete' : '')).toLowerCase();
  const id = b.id !== undefined && b.id !== null && b.id !== '' ? v.int(b.id, 'id', { min: 1 }) : null;
  if (action === 'delete' || action === 'remove') {
    if (!id) throw Errors.badRequest('要删除的角色 ID 不能为空', { field: 'id' });
    return deleteRole(ctx, id);
  }

  const permissionIds = resolvePermissionIds(b);
  const name = b.name !== undefined && b.name !== '' ? v.str(b.name, 'name', { min: 1, max: 32 }) : null;
  const code = b.code !== undefined && b.code !== '' ? String(b.code).trim() : null;
  if (code && !/^[a-z][a-z0-9_]{1,31}$/.test(code)) {
    throw Errors.badRequest('角色编码需为 2-32 位小写字母、数字或下划线', { field: 'code' });
  }

  if (!id) {
    if (!name) throw Errors.badRequest('角色名称不能为空', { field: 'name' });
    if (!code) throw Errors.badRequest('角色编码不能为空', { field: 'code' });
    if (db.get('SELECT id FROM roles WHERE code = ?', code)) throw Errors.badRequest('角色编码已存在', { field: 'code' });
    const newId = db.transaction(() => {
      const rid = db.run('INSERT INTO roles (name, code, builtin, created_at) VALUES (?, ?, 0, ?)', name, code, now()).lastInsertRowid;
      if (permissionIds) replaceRolePermissions(rid, permissionIds);
      return rid;
    });
    clearPermissionCache();
    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '系统管理-角色权限', action: '新增角色', targetType: 'role', targetId: newId,
      detail: { name, code, permissionCount: permissionIds ? permissionIds.length : 0 }, ip: ctx.ip,
    });
    return { created: true, ...toRoleApi(db.get('SELECT * FROM roles WHERE id = ?', newId)) };
  }

  const role = db.get('SELECT * FROM roles WHERE id = ?', id);
  if (!role) throw Errors.notFound('角色不存在');
  if (role.builtin === 1 && code && code !== role.code) throw Errors.badRequest('内置角色编码不可修改');
  if (code && code !== role.code && db.get('SELECT id FROM roles WHERE code = ?', code)) {
    throw Errors.badRequest('角色编码已存在', { field: 'code' });
  }
  db.transaction(() => {
    db.run('UPDATE roles SET name = ?, code = ? WHERE id = ?', name || role.name, code || role.code, id);
    if (permissionIds) replaceRolePermissions(id, permissionIds);
  });
  clearPermissionCache();
  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '系统管理-角色权限', action: '编辑角色', targetType: 'role', targetId: id,
    detail: { name: name || role.name, code: code || role.code, permissionsReplaced: !!permissionIds, permissionCount: permissionIds ? permissionIds.length : null },
    ip: ctx.ip,
  });
  return { created: false, ...toRoleApi(db.get('SELECT * FROM roles WHERE id = ?', id)) };
}

/* ------------------------------------------------------------------ *
 * API-146 权限树
 * ------------------------------------------------------------------ */

const DOMAIN_NAMES = {
  ops: '运营域', whs: '仓库域', cs: '客服域', fin: '财务域', sys: '系统管理域',
};

function permissionGroupOf(code) {
  const parts = String(code).split('.');
  return parts.length > 1 ? parts[1] : 'other';
}

function permissionTree(ctx) {
  const rows = db.all('SELECT * FROM permissions ORDER BY type ASC, id ASC');
  const items = rows.map((p) => ({
    id: p.id, code: p.code, name: p.name, type: p.type,
    typeName: p.type === 'menu' ? '菜单' : '操作',
    parentId: p.parent_id,
    group: permissionGroupOf(p.code),
    groupName: DOMAIN_NAMES[permissionGroupOf(p.code)] || '其他',
  }));

  const groupsMap = new Map();
  for (const it of items) {
    if (!groupsMap.has(it.group)) groupsMap.set(it.group, { key: it.group, name: it.groupName, menu: [], action: [] });
    groupsMap.get(it.group)[it.type === 'menu' ? 'menu' : 'action'].push(it);
  }
  return {
    total: items.length,
    byType: {
      menu: items.filter((i) => i.type === 'menu'),
      action: items.filter((i) => i.type === 'action'),
    },
    groups: [...groupsMap.values()],
    // 当前 parent_id 均为 0（菜单/操作两级由分组体现），保留 tree 字段便于前端递归渲染
    tree: items.filter((i) => !i.parentId),
    items,
  };
}

/* ------------------------------------------------------------------ *
 * API-147 字典配置
 * ------------------------------------------------------------------ */

function toDictApi(row) {
  return {
    id: row.id, type: row.type, code: row.code, name: row.name,
    sort: row.sort, status: row.status, statusName: row.status === 1 ? '启用' : '停用',
  };
}

function getDicts(ctx) {
  const type = String(ctx.query.type || '').trim();
  if (type) {
    const rows = db.all('SELECT * FROM dict_items WHERE type = ? ORDER BY sort ASC, id ASC', type);
    return { type, total: rows.length, items: rows.map(toDictApi) };
  }
  const types = db.all('SELECT type, COUNT(*) AS c FROM dict_items GROUP BY type ORDER BY type ASC');
  const rows = db.all('SELECT * FROM dict_items ORDER BY type ASC, sort ASC, id ASC');
  return {
    type: 'all',
    total: rows.length,
    types: types.map((t) => ({ type: t.type, count: t.c })),
    items: rows.map(toDictApi),
  };
}

function saveDicts(ctx) {
  const b = ctx.body || {};
  const type = v.str(b.type, 'type', {
    min: 2, max: 32, pattern: /^[a-z][a-z0-9_]{1,31}$/,
    patternMsg: '字典类型需为 2-32 位小写字母、数字或下划线',
  });
  if (!Array.isArray(b.items)) throw Errors.badRequest('items 必须为数组', { field: 'items' });

  const seen = new Set();
  const items = b.items.map((it, index) => {
    const code = v.str(it && it.code, 'code', { min: 1, max: 32 });
    const name = v.str(it && it.name, 'name', { min: 1, max: 64 });
    if (seen.has(code)) throw Errors.badRequest(`字典项编码重复：${code}`, { field: 'items' });
    seen.add(code);
    const sort = it.sort !== undefined && it.sort !== null && it.sort !== '' ? v.int(it.sort, 'sort', { min: 0 }) : index;
    const status = it.status !== undefined && it.status !== null && it.status !== '' ? parseStatus(it.status) : 1;
    return { code, name, sort, status };
  });

  db.transaction(() => {
    db.run('DELETE FROM dict_items WHERE type = ?', type);
    for (const it of items) {
      db.run('INSERT INTO dict_items (type, code, name, sort, status) VALUES (?, ?, ?, ?, ?)',
        type, it.code, it.name, it.sort, it.status);
    }
  });

  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '系统管理-系统配置', action: '保存字典配置', targetType: 'dict_item', targetId: type,
    detail: { type, count: items.length, codes: items.map((i) => i.code) }, ip: ctx.ip,
  });
  const rows = db.all('SELECT * FROM dict_items WHERE type = ? ORDER BY sort ASC, id ASC', type);
  return { type, total: rows.length, items: rows.map(toDictApi) };
}

/* ------------------------------------------------------------------ *
 * API-148 集成参数（system_configs）
 * ------------------------------------------------------------------ */

const SECRET_KEY_RE = /(secret|password|token|_key$|access_key|app_key)/i;

const SETTING_GROUPS = [
  { key: 'payment', name: '支付沙箱参数', keys: ['payment_channels', 'payment_notify_secret'] },
  { key: 'sms', name: '短信配置', keys: ['sms_provider', 'sms_access_key', 'sms_access_secret', 'sms_sign', 'sms_template_code'] },
  { key: 'map', name: '地图服务', keys: ['map_provider', 'map_key', 'default_city'] },
  { key: 'freight', name: '运费规则', keys: ['freight_fee', 'free_shipping_threshold'] },
  { key: 'timeout', name: '超时与有效期', keys: ['order_timeout_minutes', 'aftersale_days', 'aftersale_respond_hours', 'store_cancel_hours', 'store_slot_default_capacity', 'review_reply_max_len'] },
  { key: 'commission', name: '佣金与结算', keys: ['commission_rate', 'settlement_period_days', 'withdraw_min_amount', 'withdraw_daily_limit', 'withdraw_fee'] },
  { key: 'groupbuy', name: '拼团规则', keys: ['group_buy_min_qty', 'group_buy_max_qty', 'group_buy_valid_days', 'group_buy_allow_repeat_join'] },
  { key: 'audit', name: '审核开关', keys: ['product_audit_enabled', 'activity_audit_enabled', 'store_booking_need_audit'] },
  { key: 'other', name: '其他参数', keys: ['third_party_login', 'search_scopes', 'hot_search_words', 'service_phone'] },
];

function maskSetting(key, value) {
  if (!SECRET_KEY_RE.test(key)) return String(value === undefined || value === null ? '' : value);
  const s = String(value === undefined || value === null ? '' : value);
  if (!s) return '';
  return s.length <= 6 ? '******' : `${s.slice(0, 2)}******${s.slice(-2)}`;
}

function readSettings() {
  const all = config.loadAll();
  const descriptions = new Map(db.all('SELECT key, description FROM system_configs').map((r) => [r.key, r.description]));
  const placed = new Set();
  const groups = SETTING_GROUPS.map((g) => ({
    key: g.key,
    name: g.name,
    items: g.keys.filter((k) => k in all).map((k) => {
      placed.add(k);
      const secret = SECRET_KEY_RE.test(k);
      return {
        key: k,
        value: maskSetting(k, all[k]),
        masked: secret,
        description: descriptions.get(k) || k,
      };
    }),
  })).filter((g) => g.items.length);
  const leftover = Object.keys(all).filter((k) => !placed.has(k));
  if (leftover.length) {
    groups.push({
      key: 'extra',
      name: '扩展参数',
      items: leftover.sort().map((k) => ({
        key: k, value: maskSetting(k, all[k]), masked: SECRET_KEY_RE.test(k), description: descriptions.get(k) || k,
      })),
    });
  }
  return groups;
}

function getSettings() {
  const groups = readSettings();
  return { total: groups.reduce((n, g) => n + g.items.length, 0), groups, items: groups.flatMap((g) => g.items) };
}

const SETTING_KEY_RE = /^(sms|payment|map|freight|order|group_buy|commission|aftersale|withdraw|store|review|product|activity|search|hot)_/;

function saveSettings(ctx) {
  const b = ctx.body || {};
  let items = [];
  if (Array.isArray(b.items)) {
    items = b.items;
  } else if (b.settings && typeof b.settings === 'object') {
    items = Object.entries(b.settings).map(([key, value]) => ({ key, value }));
  }
  if (!items.length) throw Errors.badRequest('没有需要保存的配置项', { field: 'settings' });

  const applied = [];
  for (const raw of items) {
    const key = String((raw && raw.key) || '').trim();
    if (!key) throw Errors.badRequest('配置项 key 不能为空', { field: 'key' });
    const known = Object.prototype.hasOwnProperty.call(config.DEFAULTS, key);
    if (!known && !SETTING_KEY_RE.test(key)) throw Errors.badRequest(`不支持的配置项：${key}`, { field: 'key' });
    let value = raw.value;
    if (typeof value === 'object' && value !== null) value = JSON.stringify(value);
    value = value === undefined || value === null ? '' : String(value);
    // 密钥类字段回显为掩码，前端未修改时回传掩码，跳过保存以免覆盖真实值
    if (SECRET_KEY_RE.test(key) && value.includes('****')) continue;
    config.set(key, value, raw.description || key, ctx.admin.id);
    applied.push(key);
  }
  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '系统管理-系统配置', action: '保存集成参数', targetType: 'system_config', targetId: applied.join(','),
    detail: { keys: applied.length }, ip: ctx.ip,
  });
  return { updated: applied.length, keys: applied, settings: getSettings() };
}

/* ------------------------------------------------------------------ *
 * API-149 操作日志（只读）
 * ------------------------------------------------------------------ */

function listOperationLogs(ctx) {
  const { page, pageSize, limit, offset } = pagingOf(ctx);
  const q = ctx.query;
  const params = [];
  let where = 'WHERE 1 = 1';
  if (q.adminId) { where += ' AND admin_id = ?'; params.push(Number(q.adminId)); }
  if (q.operator) { where += ' AND admin_name LIKE ?'; params.push(`%${q.operator}%`); }
  if (q.module) { where += ' AND module = ?'; params.push(q.module); }
  if (q.action) { where += ' AND action LIKE ?'; params.push(`%${q.action}%`); }
  if (q.roleCode) { where += ' AND role_code = ?'; params.push(q.roleCode); }
  if (q.keyword) {
    where += ' AND (detail LIKE ? OR target_id LIKE ? OR admin_name LIKE ?)';
    params.push(`%${q.keyword}%`, `%${q.keyword}%`, `%${q.keyword}%`);
  }
  if (q.dateFrom) { where += ' AND substr(created_at, 1, 10) >= ?'; params.push(normDate(q.dateFrom, 'dateFrom')); }
  if (q.dateTo) { where += ' AND substr(created_at, 1, 10) <= ?'; params.push(normDate(q.dateTo, 'dateTo')); }

  const total = db.get(`SELECT COUNT(*) AS c FROM operation_logs ${where}`, ...params).c;
  const rows = db.all(`SELECT * FROM operation_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset);
  const mapRow = (r) => ({
    id: r.id, adminId: r.admin_id, adminName: r.admin_name, roleCode: r.role_code,
    module: r.module, action: r.action, targetType: r.target_type, targetId: r.target_id,
    detail: r.detail, ip: r.ip, createdAt: r.created_at,
  });

  if (!isExport(ctx)) return { total, rows: rows.map(mapRow), page, pageSize, readOnly: true };

  // 导出需独立操作权限（FR-SYS-013 / action.log.export）
  if (!hasPermission(ctx.admin, 'action.log.export')) throw Errors.forbidden('无权导出操作日志（403）');
  sendCsv(ctx, `operation-logs-${today()}.csv`,
    ['日志ID', '操作人ID', '操作人', '角色', '模块', '操作', '对象类型', '对象ID', '详情', 'IP', '时间'],
    rows.map(mapRow).map((r) => [r.id, r.adminId, r.adminName, r.roleCode, r.module, r.action,
      r.targetType, r.targetId, r.detail, r.ip, r.createdAt]));
  auditLog({
    adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
    module: '系统管理-操作日志', action: '导出操作日志', targetType: 'operation_log', targetId: 'csv',
    detail: { total, filters: { module: q.module || '', action: q.action || '', dateFrom: q.dateFrom || '', dateTo: q.dateTo || '' } },
    ip: ctx.ip,
  });
  return undefined;
}

/* ------------------------------------------------------------------ *
 * API-150 数据看板
 * ------------------------------------------------------------------ */

const RANGE_SPAN = { day: 1, week: 7, month: 30, today: 1, '7d': 7, '30d': 30 };

function dashboard(ctx) {
  const raw = String(ctx.query.range || 'day');
  const range = ['day', 'week', 'month'].includes(raw) ? raw : 'day';
  const span = RANGE_SPAN[range];
  const from = today(-(span - 1));
  const to = today();

  const paid = db.get(
    `SELECT COALESCE(SUM(p.amount), 0) AS gmv, COUNT(DISTINCT o.id) AS order_count
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.status IN (1, 3) AND p.paid_at IS NOT NULL AND substr(p.paid_at, 1, 10) BETWEEN ? AND ?`,
    from, to,
  );
  const refund = db.get(
    `SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS c FROM refund_orders
      WHERE status = 2 AND refunded_at IS NOT NULL AND substr(refunded_at, 1, 10) BETWEEN ? AND ?`,
    from, to,
  );
  const userTotal = db.get('SELECT COUNT(*) AS c FROM users').c;
  const newUsers = db.get("SELECT COUNT(*) AS c FROM users WHERE substr(created_at, 1, 10) BETWEEN ? AND ?", from, to).c;
  const shopTotal = db.get('SELECT COUNT(*) AS c FROM shops').c;
  const newShops = db.get("SELECT COUNT(*) AS c FROM shops WHERE substr(created_at, 1, 10) BETWEEN ? AND ?", from, to).c;
  const productTotal = db.get('SELECT COUNT(*) AS c FROM products WHERE status = 2 AND is_deleted = 0').c;
  const newProducts = db.get(
    'SELECT COUNT(*) AS c FROM products WHERE status = 2 AND is_deleted = 0 AND substr(created_at, 1, 10) BETWEEN ? AND ?',
    from, to,
  ).c;
  const pending = {
    refundAudit: db.get('SELECT COUNT(*) AS c FROM refund_orders WHERE status = 0').c,
    withdrawalAudit: db.get('SELECT COUNT(*) AS c FROM withdrawals WHERE status = 0').c,
    aftersalePending: db.get("SELECT COUNT(*) AS c FROM aftersales WHERE status IN (1, 4, 7)").c,
  };

  const refundRate = paid.gmv > 0 ? Number(((refund.amount / paid.gmv) * 100).toFixed(2)) : 0;
  const orderRefundRate = paid.order_count > 0 ? Number(((refund.c / paid.order_count) * 100).toFixed(2)) : 0;

  const trend = db.all(
    `SELECT substr(p.paid_at, 1, 10) AS d, COALESCE(SUM(p.amount), 0) AS gmv, COUNT(DISTINCT o.id) AS order_count
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.status IN (1, 3) AND p.paid_at IS NOT NULL AND substr(p.paid_at, 1, 10) BETWEEN ? AND ?
      GROUP BY d ORDER BY d ASC`,
    from, to,
  ).map((r) => ({ date: r.d, gmv: toYuan(r.gmv), orderCount: r.order_count }));

  const metrics = {
    gmv: toYuan(paid.gmv),
    orderCount: paid.order_count,
    userCount: userTotal,
    newUserCount: newUsers,
    shopCount: shopTotal,
    newShopCount: newShops,
    productCount: productTotal,
    newProductCount: newProducts,
    refundAmount: toYuan(refund.amount),
    refundCount: refund.c,
    refundRate,
    orderRefundRate,
    pendingAudit: pending,
  };

  return {
    range, dateFrom: from, dateTo: to,
    ...metrics,
    metrics,
    trend,
    caliber: {
      range,
      dateFrom: from,
      dateTo: to,
      gmv: 'GMV：统计期内支付成功（含已全额退款前已支付）流水金额之和，单位元，口径与订单对账一致',
      orderCount: '订单量：统计期内产生成功支付流水的订单去重数',
      userCount: '用户数：平台注册会员总数（newUserCount 为统计期内新增）',
      shopCount: '店铺数：平台入驻店铺总数（newShopCount 为统计期内新增）',
      productCount: '商品数：状态为已上架且未删除的商品总数（newProductCount 为统计期内新增）',
      refundRate: '退款率：统计期内退款成功金额 ÷ 成交额 × 100%；orderRefundRate 为退款单数 ÷ 支付订单数',
      range: 'range=day 今日 / week 近 7 日 / month 近 30 日',
    },
  };
}

/* ------------------------------------------------------------------ *
 * 路由注册
 * ------------------------------------------------------------------ */

module.exports = function register(api) {
  /* 结算 / 提现 / 对账表由 schema.sqlite.sql 统一建表（启动时 ensureSchema），此处无需兜底 DDL。 */

  /* ---------- API-141 / 142 会员管理 ---------- */
  api.get('/api/admin/users', { auth: 'admin', perm: 'menu.sys.user' }, listUsers);
  api.patch('/api/admin/users/:id/status', { auth: 'admin', perm: 'menu.sys.user' }, setUserStatus);

  /* ---------- API-143 商家账号 ---------- */
  api.get('/api/admin/seller-accounts', { auth: 'admin', perm: 'menu.sys.seller' }, listSellerAccounts);
  api.patch('/api/admin/seller-accounts/:id/status', { auth: 'admin', perm: 'menu.sys.seller' }, setSellerStatus);
  api.post('/api/admin/seller-accounts/:id/reset-password', { auth: 'admin', perm: 'menu.sys.seller' }, resetSellerPassword);

  /* ---------- API-144 平台账号 ---------- */
  api.get('/api/admin/admin-users', { auth: 'admin', perm: ['menu.sys.role', 'menu.sys.user'] }, listAdminUsers);
  api.post('/api/admin/admin-users', { auth: 'admin', perm: 'menu.sys.role' }, saveAdminUser);

  /* ---------- API-145 / 146 角色与权限 ---------- */
  api.get('/api/admin/roles', { auth: 'admin', perm: 'menu.sys.role' }, listRoles);
  api.post('/api/admin/roles', { auth: 'admin', perm: 'menu.sys.role' }, saveRole);
  api.delete('/api/admin/roles/:id', { auth: 'admin', perm: 'menu.sys.role' },
    (ctx) => deleteRole(ctx, Number(ctx.params.id)));
  api.get('/api/admin/permissions', { auth: 'admin', perm: 'menu.sys.role' }, permissionTree);

  /* ---------- API-147 字典 ---------- */
  api.get('/api/admin/dicts', { auth: 'admin', perm: 'menu.sys.config' }, getDicts);
  api.put('/api/admin/dicts', { auth: 'admin', perm: 'menu.sys.config' }, saveDicts);

  /* ---------- API-148 集成参数 ---------- */
  api.get('/api/admin/settings', { auth: 'admin', perm: 'menu.sys.config' }, () => getSettings());
  api.put('/api/admin/settings', { auth: 'admin', perm: 'menu.sys.config' }, saveSettings);

  /* ---------- API-149 操作日志（只读，无写接口） ---------- */
  api.get('/api/admin/operation-logs', { auth: 'admin', perm: 'menu.sys.log' }, listOperationLogs);

  /* ---------- API-150 数据看板 ---------- */
  api.get('/api/admin/dashboard', { auth: 'admin', perm: 'menu.sys.dashboard' }, dashboard);
};
