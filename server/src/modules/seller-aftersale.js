'use strict';

const { get } = require('../core/db');
const { Errors } = require('../core/errors');
const { toYuan } = require('../core/money');
const v = require('../core/validate');
const aftersaleSvc = require('../services/aftersale-service');
const S = require('../services/seller-service');

/**
 * 商家端 · 售后服务
 * API-076 / API-077 + 退货退款确认收货（FR-SLR-060 ~ 066、BR-SLR-018 / 019 / 020、9.3.7）
 */

/** API-076 售后单列表 */
function aftersaleList(ctx) {
  const shop = S.shopOf(ctx);
  const { page, pageSize } = S.pageOf(ctx);
  const keyword = String(ctx.query.keyword || ctx.query.aftersaleNo || '').trim();
  const result = aftersaleSvc.listForSeller(shop.id, {
    status: ctx.query.status !== undefined && ctx.query.status !== '' ? Number(ctx.query.status) : undefined,
    keyword,
    page,
    pageSize,
  });
  return S.listResult(result.rows, result.total, {
    page,
    pageSize,
    statusOptions: Object.entries(aftersaleSvc.STATUS).map(([code, name]) => ({ code: Number(code), name })),
    pendingCount: get('SELECT COUNT(*) AS c FROM aftersales WHERE shop_id = ? AND status = 1', shop.id).c,
  });
}

/** API-077 售后处理（同意 / 驳回 / 协商修改退款金额） */
function aftersaleHandle(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM aftersales WHERE id = ? AND shop_id = ?', id, shop.id);
  if (!row) throw Errors.notFound('售后单不存在');

  const action = String(body.action || '').trim();
  if (!['approve', 'reject'].includes(action)) {
    throw Errors.badRequest('处理动作仅支持 approve（同意）或 reject（驳回）', { field: 'action' });
  }
  if (action === 'reject' && !String(body.rejectReason || '').trim()) {
    throw Errors.badRequest('驳回原因必填', { field: 'rejectReason' });
  }
  if (action === 'approve' && body.refundAmount !== undefined && body.refundAmount !== '') {
    const amount = require('../core/money').toCents(body.refundAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw Errors.badRequest('退款金额不合法', { field: 'refundAmount' });
    }
    const order = get('SELECT * FROM orders WHERE id = ?', row.order_id);
    const refunded = get("SELECT COALESCE(SUM(amount),0) AS s FROM refund_orders WHERE order_id = ? AND status IN (1,2)", row.order_id).s;
    if (amount > order.pay_amount - refunded) {
      throw Errors.badRequest('退款金额不得超过订单实付金额', { field: 'refundAmount' });
    }
  }

  let result = aftersaleSvc.handleSeller(shop.id, id, {
    action,
    rejectReason: body.rejectReason,
    refundAmount: body.refundAmount,
  }, { id: ctx.admin.id, name: ctx.admin.name });

  S.audit(ctx, '售后', action === 'approve' ? '同意售后' : '驳回售后', 'aftersale', id,
    `${row.aftersale_no}；${action === 'approve' ? `同意退款 ${toYuan(result.refundAmount)} 元` : `驳回原因：${body.rejectReason}`}`);

  // action2 = confirmReturn：商家已收到买家寄回商品时一并确认收货并发起退款
  const action2 = String(body.action2 || '').trim();
  if (action2 === 'confirmReturn' || action2 === 'confirm-return') {
    if (row.type !== 2) throw Errors.badRequest('仅退货退款售后单支持确认收货', { field: 'action2' });
    result = aftersaleSvc.confirmReturn(shop.id, id, { id: ctx.admin.id, name: ctx.admin.name });
    S.audit(ctx, '售后', '确认收到退货', 'aftersale', id, `${row.aftersale_no}；已确认收货并发起退款`);
  }
  return result;
}

/** POST /api/seller/aftersales/:id/confirm-return 确认收到退货并发起退款 */
function aftersaleConfirmReturn(ctx) {
  const shop = S.activeShop(ctx);
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM aftersales WHERE id = ? AND shop_id = ?', id, shop.id);
  if (!row) throw Errors.notFound('售后单不存在');
  const result = aftersaleSvc.confirmReturn(shop.id, id, { id: ctx.admin.id, name: ctx.admin.name });
  S.audit(ctx, '售后', '确认收到退货', 'aftersale', id, `${row.aftersale_no}；退款 ${toYuan(result.refundAmount)} 元待财务审核`);
  return result;
}

module.exports = function register(api) {
  api.get('/api/seller/aftersales', { auth: 'seller' }, aftersaleList);
  api.post('/api/seller/aftersales/:id/handle', { auth: 'seller' }, aftersaleHandle);
  api.post('/api/seller/aftersales/:id/confirm-return', { auth: 'seller' }, aftersaleConfirmReturn);
};
