'use strict';

const orderSvc = require('../services/order-service');
const { pagination } = require('../core/db');
const { Errors } = require('../core/errors');

/** C 端订单（8.17 结算下单、8.18 支付页、5.3 我的订单） */
module.exports = function register(api) {
  // API-037 结算预览（金额由服务端复算）
  api.post('/api/orders/preview', { auth: 'user' }, (ctx) => orderSvc.preview(ctx.user.id, ctx.body));

  // API-038 提交订单（幂等：idempotencyKey）
  api.post('/api/orders', { auth: 'user', rate: { limit: 60, window: 60 } }, (ctx) => {
    if (ctx.body?.source !== 'buyNow' && ctx.body?.source !== 'cart' && ctx.body?.source !== undefined) {
      throw Errors.badRequest('下单来源不合法');
    }
    return orderSvc.create(ctx.user.id, ctx.body);
  });

  // API-040 我的订单列表
  api.get('/api/orders', { auth: 'user' }, (ctx) => {
    const { page, pageSize } = pagination(ctx.query);
    return orderSvc.listForUser(ctx.user.id, {
      status: ctx.query.status, keyword: ctx.query.keyword, page, pageSize,
    });
  });

  // API-039 订单详情
  api.get('/api/orders/:id', { auth: 'user' }, (ctx) => orderSvc.detail(ctx.user.id, ctx.params.id));

  // API-041 取消订单
  api.post('/api/orders/:id/cancel', { auth: 'user' }, (ctx) => {
    const result = orderSvc.cancel(ctx.user.id, ctx.params.id, ctx.body?.reason || '用户取消');
    return { ...result, order: orderSvc.detail(ctx.user.id, ctx.params.id) };
  });

  // 补充 API-157 确认收货（8.17 主流程「收货」环节，清单未列）
  api.post('/api/orders/:id/confirm', { auth: 'user' }, (ctx) => orderSvc.confirmReceive(ctx.user.id, ctx.params.id));
};
