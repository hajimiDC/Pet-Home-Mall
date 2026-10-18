'use strict';

const userSvc = require('../services/user-service');
const { revokeToken } = require('../core/auth');
const { ok } = require('../core/http');

module.exports = function register(api) {
  // API-001 注册（FR-REG-001 ~ 006）
  api.post('/api/auth/register', { rate: { limit: 20, window: 60 } }, (ctx) => userSvc.register(ctx.body));

  // API-002 登录（FR-LOGIN-001 ~ 007、NFR-SEC-005）
  api.post('/api/auth/login', { rate: { limit: 20, window: 60 } }, (ctx) => userSvc.login(ctx.body));

  // API-003 退出登录（令牌立即失效）
  api.post('/api/auth/logout', { auth: 'user' }, (ctx) => {
    revokeToken(ctx.auth.token);
    return { loggedOut: true };
  });

  // API-004 当前用户信息
  api.get('/api/auth/me', { auth: 'user' }, (ctx) => userSvc.me(ctx.user));

  // API-005 第三方登录回调（Q-007 本期不接入）
  api.post('/api/auth/oauth/:platform', {}, (ctx) => userSvc.oauth(ctx.params.platform));

  // 会员资料更新（页头昵称展示）
  api.put('/api/user/profile', { auth: 'user' }, (ctx) => userSvc.updateProfile(ctx.user, ctx.body));

  // 第三方登录渠道开关（Q-007：保留开关，默认关闭）
  api.get('/api/auth/channels', {}, () => {
    const config = require('../core/config');
    const channels = config.getJson('third_party_login', { wechat: false, qq: false, weibo: false });
    return { channels, visible: false, note: '第三方登录本期不接入，前台图标隐藏' };
  });
};
