'use strict';

const paymentSvc = require('../services/payment-service');
const { page } = require('../core/http');

/** C 端支付（8.18、NFR-SEC-004、Q-005） */
module.exports = function register(api) {
  // API-042 发起支付（沙箱）
  api.post('/api/payments', { auth: 'user', rate: { limit: 30, window: 60 } }, (ctx) => paymentSvc.createPayment(ctx.user.id, ctx.body));

  // API-043 查询支付状态
  api.get('/api/payments/:payNo', { auth: 'user' }, (ctx) => paymentSvc.queryPayment(ctx.user.id, ctx.params.payNo));

  // API-044 支付结果回调（无令牌，须验签；幂等）
  api.post('/api/payments/notify', {}, (ctx) => {
    const payload = { ...ctx.body, ...(ctx.query || {}) };
    return paymentSvc.handleNotify(payload);
  });

  // 补充 API-165 沙箱模拟支付成功（等价于渠道回调，便于联调与演示）
  api.post('/api/payments/:payNo/sandbox-pay', { auth: 'user' }, (ctx) => paymentSvc.sandboxPay(ctx.user.id, ctx.params.payNo, ctx.body?.channel));

  /**
   * 说明：page() 用于后台支付流水列表，此处仅导出占位，避免未使用告警。
   */
  void page;
};
