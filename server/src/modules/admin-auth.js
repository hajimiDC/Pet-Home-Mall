'use strict';

const adminAuth = require('../services/auth-admin-service');
const captcha = require('../core/captcha');
const { revokeToken } = require('../core/auth');
const { auditLog } = require('../core/http');

/** 平台端认证（API-090 / 091、FR-BE-001 ~ 009） */
module.exports = function register(api) {
  api.post('/api/admin/auth/login', { rate: { limit: 20, window: 60 } },
    (ctx) => adminAuth.login('admin', ctx.body, ctx.ip));

  api.get('/api/admin/auth/me', { auth: 'admin' }, (ctx) => adminAuth.me(ctx.admin));

  api.post('/api/admin/auth/logout', { auth: 'admin' }, (ctx) => {
    revokeToken(ctx.auth.token);
    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '认证', action: '退出登录', targetType: 'admin_user', targetId: ctx.admin.id, ip: ctx.ip,
    });
    return { loggedOut: true };
  });

  api.put('/api/admin/auth/password', { auth: 'admin' }, (ctx) => adminAuth.changePassword(ctx.admin, ctx.body));

  // 图形验证码（登录失败 3 次后强制要求）
  api.get('/api/captcha', {}, () => captcha.create());
};
