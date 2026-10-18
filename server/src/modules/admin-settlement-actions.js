'use strict';

const { get, run } = require('../core/db');
const { Errors } = require('../core/errors');
const { now } = require('../core/money');
const { auditLog } = require('../core/http');

/**
 * 结算单状态流转（补充接口 API-166 / API-167）
 * 需求依据：FR-SLR-091 结算单状态「待生成 / 待确认 / 已结算 / 已打款」、FR-FIN-011/012。
 * 10.5 / 9.6 清单仅给出「生成结算单」，缺失确认与打款动作；此处按 9.3.10 状态定义补齐，
 * 否则商家侧「可提现余额」永远为 0（提现链路不可闭环）。
 */
module.exports = function register(api) {
  api.post('/api/admin/settlements/:id/confirm', { auth: 'admin', perm: 'action.settlement.generate' }, (ctx) => {
    const s = get('SELECT * FROM settlements WHERE id = ?', Number(ctx.params.id));
    if (!s) throw Errors.notFound('结算单不存在');
    if (s.status !== 1) throw Errors.badRequest('仅待确认的结算单可确认');
    run('UPDATE settlements SET status = 2 WHERE id = ? AND status = 1', s.id);
    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '财务-商家结算', action: '确认结算单', targetType: 'settlement', targetId: s.id,
      detail: { period: s.period, shopId: s.shop_id }, ip: ctx.ip,
    });
    return { id: s.id, status: 2, statusName: '已结算', confirmedAt: now() };
  });

  api.post('/api/admin/settlements/:id/pay', { auth: 'admin', perm: 'action.settlement.generate' }, (ctx) => {
    const s = get('SELECT * FROM settlements WHERE id = ?', Number(ctx.params.id));
    if (!s) throw Errors.notFound('结算单不存在');
    if (s.status !== 2) throw Errors.badRequest('仅已结算的结算单可打款');
    run('UPDATE settlements SET status = 3 WHERE id = ? AND status = 2', s.id);
    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '财务-商家结算', action: '结算单打款', targetType: 'settlement', targetId: s.id,
      detail: { period: s.period, shopId: s.shop_id }, ip: ctx.ip,
    });
    return { id: s.id, status: 3, statusName: '已打款', paidAt: now() };
  });
};
