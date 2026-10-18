'use strict';

const adminAuth = require('../services/auth-admin-service');
const { revokeToken } = require('../core/auth');
const { auditLog } = require('../core/http');

/** 商家端认证（API-048 / 049、FR-BE-001 ~ 009、9.2.3） */
module.exports = function register(api) {
  api.post('/api/seller/auth/login', { rate: { limit: 20, window: 60 } },
    (ctx) => adminAuth.login('seller', ctx.body, ctx.ip));

  api.get('/api/seller/auth/me', { auth: 'seller' }, (ctx) => adminAuth.me(ctx.admin));

  api.post('/api/seller/auth/logout', { auth: 'seller' }, (ctx) => {
    revokeToken(ctx.auth.token);
    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: 'seller',
      module: '认证', action: '退出登录', targetType: 'admin_user', targetId: ctx.admin.id, ip: ctx.ip,
    });
    return { loggedOut: true };
  });

  api.put('/api/seller/auth/password', { auth: 'seller' }, (ctx) => adminAuth.changePassword(ctx.admin, ctx.body));
};
