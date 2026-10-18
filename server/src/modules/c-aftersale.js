'use strict';

const aftersaleSvc = require('../services/aftersale-service');
const { pagination } = require('../core/db');

/**
 * C 端售后（8.6 售后服务 Tab、BR-SLR-018 / 020、Q-013）
 * 状态机、退款联动与「15 天有效期」「同一明细不可重复发起」规则全部复用 aftersale-service，不重复实现。
 */
module.exports = function register(api) {
  // API-158 申请售后（仅退款 / 退货退款）
  api.post('/api/aftersales', { auth: 'user', rate: { limit: 20, window: 60 } }, (ctx) =>
    aftersaleSvc.create(ctx.user.id, ctx.body));

  // API-159 我的售后单列表
  api.get('/api/aftersales', { auth: 'user' }, (ctx) => {
    const { page, pageSize } = pagination(ctx.query, { defaultSize: 10, maxSize: 20 });
    return aftersaleSvc.listMine(ctx.user.id, { status: ctx.query.status, page, pageSize });
  });

  // API-159b 售后单详情（含订单与支付信息）
  api.get('/api/aftersales/:id', { auth: 'user' }, (ctx) => aftersaleSvc.detail(ctx.user.id, ctx.params.id));

  // API-160 买家寄回：填写退货物流单号
  api.post('/api/aftersales/:id/return', { auth: 'user' }, (ctx) =>
    aftersaleSvc.buyerReturn(ctx.user.id, ctx.params.id, ctx.body));
};
