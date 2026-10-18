'use strict';

const catalog = require('../services/catalog-service');

/**
 * C 端商品 / 类目 / 搜索浏览（API-010 ~ API-015）
 * 覆盖：7.2 全部商品分类三级悬浮菜单、7.3 统一搜索、8.2 全部商品分类页、8.6 商品详情页
 */
module.exports = function register(api) {
  // API-010 商品分类树（支持 ?level=2 裁剪；到店分类标 isStore）
  api.get('/api/categories/tree', {}, (ctx) => catalog.categoryTree({ level: ctx.query.level }));

  // API-011 商品列表（筛选 / 排序 / 分页，筛选与排序条件可组合）
  api.get('/api/products', {}, (ctx) => catalog.listProducts(ctx.query));

  // API-012 商品详情（含 SKU、店铺、活动优惠、评价统计、售后政策）
  api.get('/api/products/:id', {}, (ctx) => catalog.productDetail(ctx.params.id));

  // API-013 商品评价列表（仅 hidden=0，含商家回复与脱敏昵称）
  api.get('/api/products/:id/comments', {}, (ctx) => catalog.productComments(ctx.params.id, ctx.query));

  // API-014 相关商品推荐（同店或同类目 8 条）
  api.get('/api/products/:id/related', {}, (ctx) => catalog.relatedProducts(ctx.params.id, { limit: ctx.query.limit }));

  // API-015 统一搜索（scope = shop / product / activity / coupon）
  api.get('/api/search', { rate: { limit: 120, window: 60 } }, (ctx) => catalog.search(ctx.query));
};
