'use strict';

const { get, all, run } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, addMinutes, parseTime } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const { hashPassword, verifyPassword, issueToken } = require('../core/auth');
const v = require('../core/validate');
const db = require('../core/db');

/**
 * 会员服务（8.13 注册 / 8.14 登录 / 7.1 页头 / 收货地址）
 * 安全：BCrypt 加盐存储、统一错误提示（防账号枚举）、连续 5 次失败锁定 15 分钟（NFR-SEC-005）
 */

const MAX_FAIL = 5;
const LOCK_MINUTES = 15;

function publicUser(u) {
  const cartCount = get(
    'SELECT COALESCE(SUM(ci.quantity),0) AS c FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.user_id = ?',
    u.id,
  ).c;
  const couponCount = get('SELECT COUNT(*) AS c FROM user_coupons WHERE user_id = ? AND status = 0 AND expire_at > ?', u.id, now()).c;
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname || u.username,
    avatar: u.avatar,
    phone: u.phone ? maskPhone(u.phone) : null,
    email: u.email,
    status: u.status,
    cartCount,
    couponCount,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

/** 注册（API-001）：字段校验 + 唯一性 + 自动登录（FR-REG-001 ~ 006） */
function register(body = {}) {
  const username = v.username(body.username);
  const password = v.password(body.password);
  const confirm = String(body.confirmPassword ?? body.confirm ?? '');
  if (confirm !== String(body.password)) throw v.fieldError('confirmPassword', '两次输入的密码不一致');
  const account = String(body.phone || body.email || body.account || '').trim();
  if (!account) throw v.fieldError('phone', '邮箱或手机号不能为空');
  const isPhone = /^1[3-9]\d{9}$/.test(account);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account);
  if (!isPhone && !isEmail) throw v.fieldError('phone', '邮箱或手机号格式不正确');

  if (get('SELECT id FROM users WHERE username = ?', username)) {
    throw Errors.badRequest('该账号已注册', { field: 'username' });
  }
  if (isPhone && get('SELECT id FROM users WHERE phone = ?', account)) {
    throw Errors.badRequest('该账号已注册', { field: 'phone' });
  }
  if (isEmail && get('SELECT id FROM users WHERE email = ?', account)) {
    throw Errors.badRequest('该账号已注册', { field: 'email' });
  }
  const id = db.transaction(() => {
    const res = run(
      `INSERT INTO users (username, password_hash, phone, email, nickname, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      username, hashPassword(password), isPhone ? account : null, isEmail ? account : null,
      username, now(), now(),
    );
    run('INSERT INTO carts (user_id, updated_at) VALUES (?, ?)', res.lastInsertRowid, now());
    return res.lastInsertRowid;
  });
  const user = get('SELECT * FROM users WHERE id = ?', id);
  const session = issueToken('user', id, { remember: false });
  return { ...session, user: publicUser(user), token: session.token, redirect: body.redirect || '/' };
}

/** 登录（API-002）：账号可为用户名 / 手机号 / 邮箱；统一失败提示 */
function login(body = {}) {
  const account = String(body.account || body.username || body.phone || '').trim();
  const password = String(body.password ?? '');
  if (!account || !password) throw Errors.badRequest('账号或密码错误');
  const user = get('SELECT * FROM users WHERE username = ? OR phone = ? OR email = ?', account, account, account);
  if (!user) throw Errors.badRequest('账号或密码错误');
  if (user.status !== 1) throw Errors.forbidden('账号已被禁用');
  if (user.locked_until && parseTime(user.locked_until) > new Date()) {
    const left = Math.ceil((parseTime(user.locked_until).getTime() - Date.now()) / 60000);
    throw Errors.badRequest(`登录失败次数过多，账号已锁定，请 ${left} 分钟后重试`);
  }
  if (!verifyPassword(password, user.password_hash)) {
    const fail = user.fail_count + 1;
    if (fail >= MAX_FAIL) {
      run('UPDATE users SET fail_count = 0, locked_until = ?, updated_at = ? WHERE id = ?', addMinutes(LOCK_MINUTES), now(), user.id);
      throw Errors.badRequest(`登录失败次数过多，账号已锁定 ${LOCK_MINUTES} 分钟`);
    }
    run('UPDATE users SET fail_count = ?, updated_at = ? WHERE id = ?', fail, now(), user.id);
    throw Errors.badRequest('账号或密码错误');
  }
  run('UPDATE users SET fail_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?', now(), now(), user.id);
  const remember = Boolean(body.remember);
  const session = issueToken('user', user.id, { remember });
  return { ...session, user: publicUser(get('SELECT * FROM users WHERE id = ?', user.id)), remember };
}

/** 第三方登录（API-005）：Q-007 本期不接入 */
function oauth(platform) {
  throw Errors.badRequest(`第三方登录（${platform}）本期暂未开放`);
}

function me(user) {
  return publicUser(user);
}

function updateProfile(user, body = {}) {
  const nickname = body.nickname ? v.str(body.nickname, 'nickname', { min: 1, max: 20 }) : user.nickname;
  const avatar = body.avatar !== undefined ? String(body.avatar) : user.avatar;
  run('UPDATE users SET nickname = ?, avatar = ?, updated_at = ? WHERE id = ?', nickname, avatar, now(), user.id);
  return publicUser(get('SELECT * FROM users WHERE id = ?', user.id));
}

// ---------------- 收货地址（API-006 ~ 009） ----------------

function validateAddressPayload(body) {
  const receiver = v.str(body.receiver, 'receiver', { min: 2, max: 20 });
  if (/[<>{}\\|`]/.test(receiver)) throw v.fieldError('receiver', '收货人姓名不能包含特殊字符');
  const phone = v.phone(body.phone);
  const province = v.str(body.province, 'province', { min: 1, max: 30 });
  const city = v.str(body.city, 'city', { min: 1, max: 30 });
  const district = v.str(body.district, 'district', { min: 1, max: 30 });
  const detail = v.str(body.detail, 'detail', { min: 1, max: 200 });
  return { receiver, phone, province, city, district, detail, isDefault: body.isDefault ? 1 : 0 };
}

function listAddresses(userId) {
  return all('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC', userId).map((a) => ({
    id: a.id, receiver: a.receiver, phone: a.phone, phoneMask: maskPhone(a.phone),
    province: a.province, city: a.city, district: a.district, detail: a.detail,
    isDefault: a.is_default === 1,
    fullAddress: `${a.province}${a.city}${a.district}${a.detail}`,
  }));
}

function createAddress(userId, body = {}) {
  const data = validateAddressPayload(body);
  return db.transaction(() => {
    const count = get('SELECT COUNT(*) AS c FROM addresses WHERE user_id = ?', userId).c;
    const makeDefault = data.isDefault || count === 0 ? 1 : 0;
    if (makeDefault) run('UPDATE addresses SET is_default = 0 WHERE user_id = ?', userId);
    const res = run(
      `INSERT INTO addresses (user_id, receiver, phone, province, city, district, detail, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId, data.receiver, data.phone, data.province, data.city, data.district, data.detail, makeDefault, now(), now(),
    );
    return listAddresses(userId).find((a) => a.id === res.lastInsertRowid);
  });
}

function updateAddress(userId, id, body = {}) {
  const exist = get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!exist) throw Errors.notFound('收货地址不存在');
  const data = validateAddressPayload(body);
  return db.transaction(() => {
    if (data.isDefault) run('UPDATE addresses SET is_default = 0 WHERE user_id = ?', userId);
    run(`UPDATE addresses SET receiver = ?, phone = ?, province = ?, city = ?, district = ?, detail = ?,
         is_default = CASE WHEN ? = 1 THEN 1 ELSE is_default END, updated_at = ? WHERE id = ?`,
      data.receiver, data.phone, data.province, data.city, data.district, data.detail, data.isDefault, now(), Number(id));
    return listAddresses(userId).find((a) => a.id === Number(id));
  });
}

function deleteAddress(userId, id) {
  const exist = get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!exist) throw Errors.notFound('收货地址不存在');
  run('DELETE FROM addresses WHERE id = ?', Number(id));
  if (exist.is_default) {
    const next = get('SELECT * FROM addresses WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId);
    if (next) run('UPDATE addresses SET is_default = 1 WHERE id = ?', next.id);
  }
  return { deleted: true };
}

module.exports = {
  register, login, oauth, me, updateProfile, publicUser,
  listAddresses, createAddress, updateAddress, deleteAddress,
};
