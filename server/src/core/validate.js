'use strict';

const { Errors } = require('./errors');
const { toCents } = require('./money');

/**
 * 入参校验（NFR-SEC-007：类型 / 长度 / 范围校验，错误定位到具体字段）。
 * 所有校验器在失败时抛出 AppError 400，并携带 details.field 供前端定位字段。
 */

function fieldError(field, msg) {
  return Errors.badRequest(msg, { field });
}

function requireFields(body, fields) {
  for (const f of fields) {
    const v = body?.[f];
    if (v === undefined || v === null || String(v).trim() === '') {
      throw fieldError(f, `${labelOf(f)}不能为空`);
    }
  }
}

const LABELS = {
  username: '用户名', password: '密码', confirmPassword: '确认密码', phone: '手机号',
  email: '邮箱', receiver: '收货人', province: '省份', city: '城市', district: '区县',
  detail: '详细地址', productId: '商品', skuId: '规格', quantity: '数量', amount: '金额',
  keyword: '关键字', subjectName: '主体名称', contact: '联系人', shopName: '店铺名称',
  couponId: '优惠券', score: '评分', content: '内容', reason: '原因', storeId: '门店',
  serviceId: '到店服务', slot: '预约时段', bookingDate: '预约日期', name: '名称',
  channel: '支付渠道', type: '类型', title: '标题', account: '账号', roleId: '角色',
  threshold: '使用门槛', stock: '库存', price: '价格', categoryId: '类目',
};

function labelOf(f) { return LABELS[f] || f; }

/** 字符串：长度 + 可选字符集 */
function str(value, field, { min = 0, max = 255, pattern, patternMsg } = {}) {
  if (value === undefined || value === null) throw fieldError(field, `${labelOf(field)}不能为空`);
  const s = String(value).trim();
  if (s.length < min) throw fieldError(field, `${labelOf(field)}长度不能少于 ${min} 个字符`);
  if (s.length > max) throw fieldError(field, `${labelOf(field)}长度不能超过 ${max} 个字符`);
  if (pattern && !pattern.test(s)) throw fieldError(field, patternMsg || `${labelOf(field)}格式不正确`);
  return s;
}

const USERNAME_RE = /^[A-Za-z0-9_]{4,20}$/;
const PASSWORD_RULE = { min: 8, max: 20 };
const PHONE_RE = /^1[3-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function username(value) {
  const s = String(value ?? '').trim();
  if (!s) throw fieldError('username', '用户名不能为空');
  if (!USERNAME_RE.test(s)) throw fieldError('username', '用户名需为 4-20 位字母、数字或下划线');
  return s;
}

function password(value) {
  const s = String(value ?? '');
  if (s.length < PASSWORD_RULE.min || s.length > PASSWORD_RULE.max) {
    throw fieldError('password', `密码长度需为 ${PASSWORD_RULE.min}-${PASSWORD_RULE.max} 位`);
  }
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw fieldError('password', '密码需同时包含字母与数字');
  return s;
}

function phone(value, field = 'phone') {
  const s = String(value ?? '').trim();
  if (!PHONE_RE.test(s)) throw fieldError(field, '手机号格式不正确');
  return s;
}

function email(value, field = 'email') {
  const s = String(value ?? '').trim();
  if (!EMAIL_RE.test(s)) throw fieldError(field, '邮箱格式不正确');
  return s;
}

/** 整数，可限定范围 */
function int(value, field, { min, max, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fieldError(field, `${labelOf(field)}不能为空`);
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw fieldError(field, `${labelOf(field)}必须为整数`);
  if (min !== undefined && n < min) throw fieldError(field, `${labelOf(field)}不能小于 ${min}`);
  if (max !== undefined && n > max) throw fieldError(field, `${labelOf(field)}不能大于 ${max}`);
  return n;
}

/** 金额（元）→ 分，> 0 且至多两位小数 */
function money(value, field, { min = 1, allowZero = false } = {}) {
  const cents = toCents(value);
  if (cents === null || Number.isNaN(cents)) throw fieldError(field, `${labelOf(field)}格式不正确（最多两位小数）`);
  if (allowZero ? cents < 0 : cents < min) throw fieldError(field, `${labelOf(field)}须大于 0`);
  return cents;
}

function oneOf(value, allowed, field) {
  const s = String(value ?? '');
  if (!allowed.map(String).includes(s)) throw fieldError(field, `${labelOf(field)}取值不合法`);
  return s;
}

/** 分页页码越界提示（FR-GOODS-004） */
module.exports = {
  fieldError, requireFields, str, username, password, phone, email, int, money, oneOf, labelOf,
  USERNAME_RE, PHONE_RE, EMAIL_RE,
};
