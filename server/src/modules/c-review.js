'use strict';

const reviewSvc = require('../services/review-service');
const { pagination } = require('../core/db');

/**
 * C 端商品评价（8.6 商品评价 Tab、FR-SLR-071、BR-SLR-021 / 022）
 * 商家回复、申诉与申诉审核为服务能力（review-service 导出），对应路由由商家端 / 平台端模块注册。
 */
module.exports = function register(api) {
  // API-161 发表评价（订单须属于当前用户且已完成，同一明细仅可评价一次）
  api.post('/api/reviews', { auth: 'user', rate: { limit: 20, window: 60 } }, (ctx) =>
    reviewSvc.create(ctx.user.id, ctx.body));

  // 我的评价列表
  api.get('/api/user/reviews', { auth: 'user' }, (ctx) => {
    const { page, pageSize } = pagination(ctx.query, { defaultSize: 10, maxSize: 20 });
    return reviewSvc.listForUser(ctx.user.id, { page, pageSize });
  });
};
