'use strict';

const { get, all, parseJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, parseTime } = require('../core/money');
const { maskName } = require('../core/privacy');
const orderSvc = require('../services/order-service');
const stock = require('../services/stock-service');

/**
 * C 端拼团（8.11、BR-GRP-001 ~ 006、Q-001、API-029 / 030）
 * 规则：成团人数 10~99、有效期 3 天、未成团全额退款（含运费）并回滚库存、
 *       拼团与普通商品共用 SKU 库存池、同一团仅可下 1 单（默认）。
 */

function progressOf(groupBuy, at = now()) {
  const joined = get("SELECT COUNT(*) AS c FROM group_members gm JOIN group_teams t ON t.id = gm.team_id WHERE t.group_buy_id = ? AND gm.status = 2", groupBuy.id).c;
  const remaining = Math.max(0, groupBuy.required_count - joined);
  return {
    requiredCount: groupBuy.required_count,
    joinedCount: joined,
    remaining,
    text: remaining > 0 ? `还差 ${remaining} 人成团` : '已成团',
    serverTime: at,
  };
}

function toCard(g, at = now()) {
  const product = get('SELECT * FROM products WHERE id = ?', g.product_id);
  const sku = get('SELECT * FROM skus WHERE id = ?', g.sku_id);
  const shop = get('SELECT id, name FROM shops WHERE id = ?', g.shop_id);
  const progress = progressOf(g, at);
  return {
    id: g.id,
    title: g.title || product?.name,
    productId: g.product_id,
    skuId: g.sku_id,
    shopId: g.shop_id,
    shopName: shop?.name,
    image: product?.main_image,
    marketPrice: toYuan(sku?.price || product?.price || 0),
    groupPrice: toYuan(g.group_price),
    requiredCount: g.required_count,
    joinedCount: progress.joinedCount,
    remaining: progress.remaining,
    progressText: progress.text,
    startAt: g.start_at,
    endAt: g.end_at,
    expireAt: g.end_at,
    status: g.status,
    statusName: ['待审核', '进行中', '已成团', '未成团', '已驳回', '已下线'][g.status] || '',
    availableStock: sku ? Math.max(0, sku.stock - sku.locked_stock) : 0,
  };
}

function teamOf(team) {
  const leader = get('SELECT id, username, nickname FROM users WHERE id = ?', team.leader_user_id);
  const paid = get("SELECT COUNT(*) AS c FROM group_members WHERE team_id = ? AND status = 2", team.id).c;
  return {
    teamId: team.id,
    leader: { nickname: maskName(leader?.nickname || leader?.username || '团长') },
    requiredCount: team.required_count,
    joinedCount: paid,
    remaining: Math.max(0, team.required_count - paid),
    expireAt: team.expire_at,
    status: team.status,
    statusName: ['', '进行中', '已成团', '未成团'][team.status] || '',
  };
}

module.exports = function register(api) {
  // API-029 拼团活动列表（4 列 × 2 行卡片数据）
  api.get('/api/group-buys', {}, (ctx) => {
    const { pagination } = require('../core/db');
    const { page, pageSize } = pagination(ctx.query, { defaultSize: 8, maxSize: 20 });
    const at = now();
    const params = [at, at];
    let where = 'WHERE g.status = 1 AND g.start_at <= ? AND g.end_at > ?';
    if (ctx.query.keyword) { where += ' AND g.title LIKE ?'; params.push(`%${ctx.query.keyword}%`); }
    const total = get(`SELECT COUNT(*) AS c FROM group_buys g ${where}`, ...params).c;
    const rows = all(`SELECT g.* FROM group_buys g ${where} ORDER BY g.start_at DESC LIMIT ? OFFSET ?`,
      ...params, pageSize, (page - 1) * pageSize);
    return { total, rows: rows.map((g) => toCard(g, at)) };
  });

  // 拼团详情（复用商品详情模板所需的拼团信息）
  api.get('/api/group-buys/:id', {}, (ctx) => {
    const g = get('SELECT * FROM group_buys WHERE id = ?', Number(ctx.params.id));
    if (!g) throw Errors.notFound('拼团活动不存在');
    const teams = all('SELECT * FROM group_teams WHERE group_buy_id = ? AND status = 1 ORDER BY id DESC LIMIT 5', g.id).map(teamOf);
    return {
      ...toCard(g),
      rules: {
        requiredRange: '10~99 人',
        validDays: g.valid_days,
        priceRule: '拼团价不得高于商城价；拼团与普通商品共用 SKU 库存池',
        unformedRule: '有效期结束仍未成团：全额退款（含运费）并回滚库存',
      },
      teams,
      product: get('SELECT id, name, main_image, price FROM products WHERE id = ?', g.product_id),
    };
  });

  // API-030 发起 / 参与拼团（开团或参团 → 生成拼团订单并锁定库存 → 进入支付）
  api.post('/api/group-buys/:id/join', { auth: 'user', rate: { limit: 30, window: 60 } }, (ctx) => {
    const g = get('SELECT * FROM group_buys WHERE id = ?', Number(ctx.params.id));
    if (!g) throw Errors.notFound('拼团活动不存在');
    if (g.status !== 1) throw Errors.badRequest('拼团活动未开始或已结束');
    if (parseTime(g.start_at) > new Date()) throw Errors.badRequest('拼团活动未开始');
    if (parseTime(g.end_at) <= new Date()) throw Errors.badRequest('拼团活动已结束');

    const quantity = Number(ctx.body?.quantity || 1);
    if (!Number.isInteger(quantity) || quantity < 1) throw Errors.badRequest('数量最小为 1', { field: 'quantity' });
    const sku = get('SELECT * FROM skus WHERE id = ?', g.sku_id);
    if (stock.availableOf(sku) < quantity) throw Errors.badRequest('库存不足');

    const created = orderSvc.create(ctx.user.id, {
      source: 'buyNow',
      skuId: g.sku_id,
      quantity,
      groupBuyId: g.id,
      teamId: ctx.body?.teamId ? Number(ctx.body.teamId) : undefined,
      addressId: ctx.body?.addressId,
      remark: ctx.body?.remark || '',
      idempotencyKey: ctx.body?.idempotencyKey,
    });
    const order = get('SELECT * FROM orders WHERE id = ?', created.orders[0].orderId);
    const team = order.group_team_id ? get('SELECT * FROM group_teams WHERE id = ?', order.group_team_id) : null;
    return {
      order: orderSvc.summarize(order),
      team: team ? teamOf(team) : null,
      progress: progressOf(g),
      action: ctx.body?.teamId ? '参团' : '开团',
      hint: '拼团订单已生成并锁定库存，请在 15 分钟内完成支付',
    };
  });
};

module.exports.progressOf = progressOf;
module.exports.toCard = toCard;
