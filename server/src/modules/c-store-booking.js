'use strict';

const bookingSvc = require('../services/store-booking-service');
const { pagination } = require('../core/db');

/**
 * C 端到店预约（8.12 到店、Q-002 到店付款 + 预约制）
 * API-151 ~ API-154：只提交预约，不进入购物车 / 结算 / 支付链路（BR-STORE-003）。
 */
module.exports = function register(api) {
  // API-151 创建到店预约（选门店 / 服务 / 预约时段）
  api.post('/api/store-bookings', { auth: 'user', rate: { limit: 30, window: 60 } }, (ctx) =>
    bookingSvc.create(ctx.user.id, ctx.body));

  // API-152 我的预约列表（支持 status 过滤；列表时刷新「已过期」状态）
  api.get('/api/store-bookings', { auth: 'user' }, (ctx) => {
    const { page, pageSize } = pagination(ctx.query, { defaultSize: 10, maxSize: 20 });
    return bookingSvc.listMine(ctx.user.id, { status: ctx.query.status, page, pageSize });
  });

  // API-153 预约详情（含核销码；非本人 404）
  api.get('/api/store-bookings/:id', { auth: 'user' }, (ctx) => bookingSvc.detail(ctx.user.id, ctx.params.id));

  // API-154 取消预约（仅待到店、且在开始前 store_cancel_hours 小时之外）
  api.post('/api/store-bookings/:id/cancel', { auth: 'user' }, (ctx) =>
    bookingSvc.cancel(ctx.user.id, ctx.params.id));
};
