'use strict';

const { get, run, all } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, addMinutes, parseTime } = require('../core/money');
const { verifyPassword, issueToken, revokeToken, hashPassword, rolePermissions } = require('../core/auth');
const { auditLog } = require('../core/http');
const captcha = require('../core/captcha');
const v = require('../core/validate');

/**
 * 后台认证（FR-BE-001 ~ FR-BE-010）
 * - 平台端 / 商家端共用 admin_users 表，type 区分 seller / admin
 * - C 端会员账号不得登录后台（物理分表）
 * - 连续 5 次密码错误锁定 10 分钟；失败 3 次起要求图形验证码
 * - 后台会话 30 分钟静置自动登出（auth.js 校验）
 */

const LOGIN_FAIL_LIMIT = 5;
const LOCK_MINUTES = 10;
const CAPTCHA_AFTER = 3;

const MENU_MAP = {
  'menu.ops.category': { key: 'category', name: '类目管理', path: '/admin/ops/category', group: '运营' },
  'menu.ops.content': { key: 'content', name: '内容位管理', path: '/admin/ops/content', group: '运营' },
  'menu.ops.product-audit': { key: 'product-audit', name: '商品审核', path: '/admin/ops/product-audit', group: '运营' },
  'menu.ops.shop-audit': { key: 'shop-audit', name: '商家与入驻审核', path: '/admin/ops/shop-audit', group: '运营' },
  'menu.ops.activity-audit': { key: 'activity-audit', name: '营销审核', path: '/admin/ops/activity-audit', group: '运营' },
  'menu.ops.coupon': { key: 'coupon', name: '平台优惠券', path: '/admin/ops/coupon', group: '运营' },
  'menu.ops.group-buy': { key: 'group-buy', name: '拼团规则', path: '/admin/ops/group-buy', group: '运营' },
  'menu.ops.store-service': { key: 'store-service', name: '到店服务', path: '/admin/ops/store-service', group: '运营' },
  'menu.whs.stock': { key: 'stock', name: '库存总览', path: '/admin/whs/stock', group: '仓库' },
  'menu.whs.inout': { key: 'inout', name: '出入库', path: '/admin/whs/inout', group: '仓库' },
  'menu.whs.take': { key: 'take', name: '盘点', path: '/admin/whs/take', group: '仓库' },
  'menu.whs.ship': { key: 'ship', name: '拣货发货', path: '/admin/whs/ship', group: '仓库' },
  'menu.cs.work-order': { key: 'work-order', name: '咨询工单', path: '/admin/cs/work-order', group: '客服' },
  'menu.cs.aftersale': { key: 'aftersale', name: '售后处理', path: '/admin/cs/aftersale', group: '客服' },
  'menu.cs.review-appeal': { key: 'review-appeal', name: '评价申诉', path: '/admin/cs/review-appeal', group: '客服' },
  'menu.fin.reconcile': { key: 'reconcile', name: '订单对账', path: '/admin/fin/reconcile', group: '财务' },
  'menu.fin.payment': { key: 'payment', name: '支付流水', path: '/admin/fin/payment', group: '财务' },
  'menu.fin.refund': { key: 'refund', name: '退款管理', path: '/admin/fin/refund', group: '财务' },
  'menu.fin.settlement': { key: 'settlement', name: '商家结算', path: '/admin/fin/settlement', group: '财务' },
  'menu.sys.user': { key: 'user', name: '用户管理', path: '/admin/sys/user', group: '系统' },
  'menu.sys.seller': { key: 'seller', name: '商家账号', path: '/admin/sys/seller', group: '系统' },
  'menu.sys.role': { key: 'role', name: '角色权限', path: '/admin/sys/role', group: '系统' },
  'menu.sys.config': { key: 'config', name: '系统配置', path: '/admin/sys/config', group: '系统' },
  'menu.sys.log': { key: 'log', name: '操作日志', path: '/admin/sys/log', group: '系统' },
  'menu.sys.dashboard': { key: 'dashboard', name: '数据看板', path: '/admin/sys/dashboard', group: '系统' },
};

const SELLER_MENUS = [
  { key: 'apply', name: '入驻申请', path: '/seller/apply' },
  { key: 'shop', name: '店铺管理', path: '/seller/shop' },
  { key: 'store', name: '门店管理', path: '/seller/store' },
  { key: 'product', name: '商品管理', path: '/seller/product' },
  { key: 'stock', name: '库存管理', path: '/seller/stock' },
  { key: 'order', name: '订单管理', path: '/seller/order' },
  { key: 'aftersale', name: '售后服务', path: '/seller/aftersale' },
  { key: 'review', name: '评价管理', path: '/seller/review' },
  { key: 'marketing', name: '营销管理', path: '/seller/marketing' },
  { key: 'settlement', name: '结算与对账', path: '/seller/settlement' },
  { key: 'booking', name: '预约核销', path: '/seller/booking' },
];

function menusOf(admin) {
  if (admin.type === 'seller') {
    if (!admin.shop_id) return [{ key: 'apply', name: '入驻申请', path: '/seller/apply' }];
    return SELLER_MENUS;
  }
  const codes = rolePermissions(admin.role_id);
  const isSuper = codes.has('*') || codes.has('super_admin');
  return Object.entries(MENU_MAP)
    .filter(([code]) => isSuper || codes.has(code))
    .map(([, menu]) => menu);
}

function permissionsOf(admin) {
  if (admin.type === 'seller') return ['seller.*'];
  const codes = rolePermissions(admin.role_id);
  return [...codes];
}

/** 后台登录：type = 'admin' | 'seller' */
function login(type, body = {}, ip = '') {
  const account = String(body.account || '').trim();
  const password = String(body.password || '');
  if (!account || !password) throw Errors.badRequest('账号或密码错误');
  const admin = get('SELECT * FROM admin_users WHERE account = ? AND type = ?', account, type);
  if (!admin) throw Errors.badRequest('账号或密码错误');
  if (admin.status !== 1) throw Errors.forbidden('账号已被禁用');
  if (admin.locked_until && parseTime(admin.locked_until) > new Date()) {
    const left = Math.ceil((parseTime(admin.locked_until).getTime() - Date.now()) / 60000);
    throw Errors.badRequest(`账号已锁定，请 ${left} 分钟后重试`);
  }
  // 失败 ≥3 次后要求图形验证码（NFR-SEC-005）
  if (admin.fail_count >= CAPTCHA_AFTER) {
    if (!body.captchaId || !captcha.verify(body.captchaId, body.captcha)) {
      throw Errors.badRequest('请输入正确的图形验证码', { field: 'captcha', needCaptcha: true });
    }
  }
  if (!verifyPassword(password, admin.password_hash)) {
    const fail = admin.fail_count + 1;
    if (fail >= LOGIN_FAIL_LIMIT) {
      run('UPDATE admin_users SET fail_count = 0, locked_until = ?, updated_at = ? WHERE id = ?', addMinutes(LOCK_MINUTES), now(), admin.id);
      throw Errors.badRequest(`连续 ${LOGIN_FAIL_LIMIT} 次密码错误，账号锁定 ${LOCK_MINUTES} 分钟`);
    }
    run('UPDATE admin_users SET fail_count = ?, updated_at = ? WHERE id = ?', fail, now(), admin.id);
    throw Errors.badRequest('账号或密码错误');
  }
  run('UPDATE admin_users SET fail_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?', now(), now(), admin.id);
  const role = admin.role_id ? get('SELECT * FROM roles WHERE id = ?', admin.role_id) : null;
  const session = issueToken(type, admin.id, {
    shopId: admin.shop_id, roleId: admin.role_id, roleCode: role?.code,
  });
  auditLog({
    adminId: admin.id, adminName: admin.name || admin.account, roleCode: role?.code || type,
    module: '认证', action: '登录', targetType: 'admin_user', targetId: admin.id, detail: `${type} 登录成功`, ip,
  });
  return {
    ...session,
    admin: {
      id: admin.id, account: admin.account, name: admin.name, type,
      shopId: admin.shop_id, role: role ? { id: role.id, code: role.code, name: role.name } : null,
      mustChangePwd: admin.must_change_pwd === 1,
      menus: menusOf(admin), permissions: permissionsOf(admin),
    },
  };
}

function me(admin) {
  const role = admin.role_id ? get('SELECT * FROM roles WHERE id = ?', admin.role_id) : null;
  const shop = admin.shop_id ? get('SELECT * FROM shops WHERE id = ?', admin.shop_id) : null;
  return {
    id: admin.id, account: admin.account, name: admin.name, type: admin.type,
    shopId: admin.shop_id,
    shop: shop ? { id: shop.id, name: shop.name, status: shop.status, statusName: shop.status === 1 ? '营业中' : '已停用' } : null,
    role: role ? { id: role.id, code: role.code, name: role.name } : null,
    mustChangePwd: admin.must_change_pwd === 1,
    menus: menusOf(admin), permissions: permissionsOf(admin),
    lastLoginAt: admin.last_login_at,
  };
}

function changePassword(admin, body = {}) {
  const oldPwd = String(body.oldPassword || '');
  const newPwd = v.password(body.newPassword);
  if (!verifyPassword(oldPwd, admin.password_hash)) throw Errors.badRequest('原密码不正确', { field: 'oldPassword' });
  run('UPDATE admin_users SET password_hash = ?, must_change_pwd = 0, updated_at = ? WHERE id = ?',
    hashPassword(newPwd), now(), admin.id);
  return { changed: true };
}

module.exports = {
  login, me, changePassword, menusOf, permissionsOf, MENU_MAP, SELLER_MENUS,
  LOGIN_FAIL_LIMIT, LOCK_MINUTES,
};
