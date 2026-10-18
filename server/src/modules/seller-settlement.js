'use strict';

const { get } = require('../core/db');
const { Errors } = require('../core/errors');
const { toYuan, toCents } = require('../core/money');
const v = require('../core/validate');
const config = require('../core/config');
const settlementSvc = require('../services/settlement-service');
const S = require('../services/seller-service');

/**
 * 商家端 · 结算与对账 / 提现
 * API-088 / API-089 + 提现记录（FR-SLR-090 ~ 095、BR-SLR-026 ~ 028、Q-016、9.3.10）
 * 结算口径、佣金费率、T+7 周期均复用 services/settlement-service.js。
 */

function balanceApi(shopId) {
  const b = settlementSvc.balanceOf(shopId);
  return {
    settledAmount: toYuan(b.settled),
    withdrawnAmount: toYuan(b.withdrawn),
    availableAmount: toYuan(b.available),
    commissionRate: config.getNumber('commission_rate'),
    settlementPeriodDays: config.getNumber('settlement_period_days'),
    withdrawMinAmount: toYuan(config.getNumber('withdraw_min_amount')),
    withdrawDailyLimit: config.getNumber('withdraw_daily_limit'),
  };
}

/** API-088 结算单列表 / 明细下钻（?id=） */
function settlementList(ctx) {
  const shop = S.shopOf(ctx);
  S.ensureSettlementTables();
  const { page, pageSize } = S.pageOf(ctx);

  if (ctx.query.id) {
    const id = Number(ctx.query.id);
    if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('结算单 ID 不合法', { field: 'id' });
    const row = get('SELECT * FROM settlements WHERE id = ? AND shop_id = ?', id, shop.id);
    if (!row) throw Errors.notFound('结算单不存在');
    return {
      settlement: settlementSvc.toApi(row),
      items: settlementSvc.itemsOf(id, shop.id),
      balance: balanceApi(shop.id),
    };
  }

  const result = settlementSvc.list({
    shopId: shop.id,
    period: ctx.query.period ? String(ctx.query.period) : undefined,
    status: ctx.query.status !== undefined && ctx.query.status !== '' ? Number(ctx.query.status) : undefined,
    page,
    pageSize,
  });
  return S.listResult(result.rows, result.total, { page, pageSize, balance: balanceApi(shop.id) });
}

/** GET /api/seller/settlements/:id/items 结算明细（按订单下钻） */
function settlementItems(ctx) {
  const shop = S.shopOf(ctx);
  S.ensureSettlementTables();
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('结算单 ID 不合法', { field: 'id' });
  const row = get('SELECT * FROM settlements WHERE id = ? AND shop_id = ?', id, shop.id);
  if (!row) throw Errors.notFound('结算单不存在');
  return {
    settlement: settlementSvc.toApi(row),
    items: settlementSvc.itemsOf(id, shop.id),
    balance: balanceApi(shop.id),
  };
}

/** API-089 提现申请（收款账户校验 → 余额校验 → 复用 settlementService.applyWithdrawal） */
function withdrawalApply(ctx) {
  const shop = S.activeShop(ctx);
  S.ensureSettlementTables();
  const body = ctx.body || {};
  v.requireFields(body, ['amount']);
  const cents = toCents(body.amount);
  if (!Number.isInteger(cents) || cents <= 0) {
    throw Errors.badRequest('提现金额不合法', { field: 'amount' });
  }
  const account = get(
    'SELECT * FROM shop_accounts WHERE shop_id = ? AND status = 1 AND verified = 1 ORDER BY id DESC LIMIT 1', shop.id,
  );
  if (!account) throw Errors.badRequest('请先绑定并通过验证的收款账户');
  const result = settlementSvc.applyWithdrawal(shop.id, {
    amount: body.amount,
    settlementId: body.settlementId ? Number(body.settlementId) : null,
  }, { id: ctx.admin.id, name: ctx.admin.name });
  S.audit(ctx, '结算', '提现申请', 'withdrawal', result.id,
    `金额 ${toYuan(cents)} 元；状态 ${result.statusName}`);
  return { ...result, tip: '提现申请已提交，等待平台财务审核' };
}

/** GET /api/seller/withdrawals 提现记录 */
function withdrawalList(ctx) {
  const shop = S.shopOf(ctx);
  S.ensureSettlementTables();
  const { page, pageSize } = S.pageOf(ctx);
  const result = settlementSvc.listWithdrawals({
    shopId: shop.id,
    status: ctx.query.status !== undefined && ctx.query.status !== '' ? Number(ctx.query.status) : undefined,
    page,
    pageSize,
  });
  return S.listResult(result.rows, result.total, { page, pageSize, balance: balanceApi(shop.id) });
}

module.exports = function register(api) {
  api.get('/api/seller/settlements', { auth: 'seller' }, settlementList);
  api.get('/api/seller/settlements/:id/items', { auth: 'seller' }, settlementItems);
  api.get('/api/seller/withdrawals', { auth: 'seller' }, withdrawalList);
  api.post('/api/seller/withdrawals', { auth: 'seller' }, withdrawalApply);
};
