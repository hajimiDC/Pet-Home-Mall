'use strict';

const userSvc = require('../services/user-service');
const couponSvc = require('../services/coupon-service');
const { get, all, run, bizNo, pagination } = require('../core/db');
const { now } = require('../core/money');
const { Errors } = require('../core/errors');

/** C 端会员域：收货地址、我的优惠券、收藏、咨询工单 */
module.exports = function register(api) {
  // API-006 ~ 009 收货地址
  api.get('/api/user/addresses', { auth: 'user' }, (ctx) => ({ rows: userSvc.listAddresses(ctx.user.id) }));
  api.post('/api/user/addresses', { auth: 'user' }, (ctx) => userSvc.createAddress(ctx.user.id, ctx.body));
  api.put('/api/user/addresses/:id', { auth: 'user' }, (ctx) => userSvc.updateAddress(ctx.user.id, ctx.params.id, ctx.body));
  api.delete('/api/user/addresses/:id', { auth: 'user' }, (ctx) => userSvc.deleteAddress(ctx.user.id, ctx.params.id));

  // API-028 我的优惠券
  api.get('/api/user/coupons', { auth: 'user' }, (ctx) => ({
    rows: couponSvc.listMine(ctx.user.id, { status: ctx.query.status }),
    total: couponSvc.listMine(ctx.user.id, { status: ctx.query.status }).length,
  }));

  // 我的收藏店铺
  api.get('/api/user/favorites', { auth: 'user' }, (ctx) => {
    const rows = all(
      `SELECT f.*, s.name, s.logo, s.score, s.status FROM favorites f JOIN shops s ON s.id = f.shop_id
        WHERE f.user_id = ? ORDER BY f.id DESC`, ctx.user.id,
    );
    return {
      total: rows.length,
      rows: rows.map((r) => ({
        shopId: r.shop_id, name: r.name, logo: r.logo, score: (r.score / 10).toFixed(1),
        status: r.status, statusName: r.status === 1 ? '营业中' : '已停用', favoritedAt: r.created_at,
      })),
    };
  });

  // 咨询工单（补充接口 API-164：9.4.3.1 工单来源，页尾「咨询客服」入口）
  api.post('/api/work-orders', { auth: 'user', rate: { limit: 10, window: 60 } }, (ctx) => {
    const content = String(ctx.body.content || '').trim();
    if (content.length < 5) throw Errors.badRequest('请至少填写 5 个字的咨询内容', { field: 'content' });
    if (content.length > 500) throw Errors.badRequest('咨询内容不能超过 500 字', { field: 'content' });
    const id = run(
      `INSERT INTO work_orders (work_no, user_id, order_id, source, type, content, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      bizNo('WO'), ctx.user.id, ctx.body.orderId || null, ctx.body.source || '在线咨询',
      ctx.body.type || '咨询', content, now(), now(),
    ).lastInsertRowid;
    const row = get('SELECT * FROM work_orders WHERE id = ?', id);
    return { id: row.id, workNo: row.work_no, status: row.status, statusName: '待受理', createdAt: row.created_at };
  });

  api.get('/api/work-orders', { auth: 'user' }, (ctx) => {
    const { pageSize, offset } = pagination(ctx.query);
    const total = get('SELECT COUNT(*) AS c FROM work_orders WHERE user_id = ?', ctx.user.id).c;
    const rows = all('SELECT * FROM work_orders WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', ctx.user.id, pageSize, offset);
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id, workNo: r.work_no, type: r.type, content: r.content,
        status: r.status, statusName: ['', '待受理', '处理中', '已解决', '已关闭'][r.status],
        replies: JSON.parse(r.replies || '[]'), createdAt: r.created_at,
      })),
    };
  });
};
