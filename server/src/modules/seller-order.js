'use strict';

const { get, all, run } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, fmtYuan } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const { sendRaw } = require('../core/http');
const config = require('../core/config');
const v = require('../core/validate');
const orderSvc = require('../services/order-service');
const S = require('../services/seller-service');

/**
 * 商家端 · 订单管理
 * API-071 ~ API-075 + 商家备注（FR-SLR-050 ~ 058、BR-SLR-014 ~ 017、9.3.6）
 */

const STATUS_NAME = orderSvc.STATUS;

function ownOrder(shopId, id) {
  const order = get('SELECT * FROM orders WHERE id = ? AND shop_id = ?', Number(id), shopId);
  // 跨店 / 不存在统一提示「订单不存在」（BR-SLR-014、9.3.6 校验与异常）
  if (!order) throw Errors.notFound('订单不存在');
  return order;
}

function itemSummaryOf(orderId) {
  return all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', orderId);
}

function toOrderRow(order) {
  const items = itemSummaryOf(order.id);
  const buyer = get('SELECT id, username, nickname, phone FROM users WHERE id = ?', order.user_id);
  const logistics = get('SELECT * FROM logistics WHERE order_id = ? ORDER BY id DESC LIMIT 1', order.id);
  return {
    id: order.id,
    orderNo: order.order_no,
    status: order.status,
    statusName: STATUS_NAME[order.status] || '未知',
    payAmount: toYuan(order.pay_amount),
    goodsAmount: toYuan(order.goods_amount),
    freightAmount: toYuan(order.freight_amount),
    couponAmount: toYuan(order.coupon_amount),
    payChannel: order.pay_channel,
    buyer: buyer ? { id: buyer.id, nickname: buyer.nickname || buyer.username, phoneMask: maskPhone(buyer.phone) } : null,
    itemCount: items.reduce((s, i) => s + i.quantity, 0),
    items: items.map((i) => ({
      id: i.id, productId: i.product_id, skuId: i.sku_id, productName: i.product_name,
      specName: i.spec_name, image: i.image, price: toYuan(i.price), quantity: i.quantity, subtotal: toYuan(i.subtotal),
    })),
    itemSummary: items.map((i) => `${i.product_name}${i.spec_name ? `（${i.spec_name}）` : ''}×${i.quantity}`).join('；'),
    logistics: logistics ? { company: logistics.company, trackingNo: logistics.tracking_no, shippedAt: logistics.shipped_at } : null,
    sellerRemark: order.seller_remark,
    remark: order.remark,
    createdAt: order.created_at,
    paidAt: order.paid_at,
    shippedAt: order.shipped_at,
    finishedAt: order.finished_at,
  };
}

function badgesOf(shopId) {
  return {
    pendingShip: get('SELECT COUNT(*) AS c FROM orders WHERE shop_id = ? AND status = 1', shopId).c,
    pendingReceive: get('SELECT COUNT(*) AS c FROM orders WHERE shop_id = ? AND status = 2', shopId).c,
    aftersale: get('SELECT COUNT(*) AS c FROM aftersales WHERE shop_id = ? AND status NOT IN (5, 6)', shopId).c,
    unpaid: get('SELECT COUNT(*) AS c FROM orders WHERE shop_id = ? AND status = 0', shopId).c,
  };
}

/** API-071 订单列表 */
function orderList(ctx) {
  const shop = S.shopOf(ctx);
  const { page, pageSize, offset } = S.pageOf(ctx);
  const where = ['o.shop_id = ?'];
  const params = [shop.id];

  const keyword = String(ctx.query.orderNo || ctx.query.keyword || '').trim();
  if (keyword) {
    where.push('(o.order_no LIKE ? OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.product_name LIKE ?))');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const buyer = String(ctx.query.buyer || ctx.query.nickname || '').trim();
  if (buyer) {
    where.push(`o.user_id IN (SELECT id FROM users WHERE nickname LIKE ? OR username LIKE ? OR phone LIKE ?)`);
    params.push(`%${buyer}%`, `%${buyer}%`, `%${buyer}%`);
  }
  if (ctx.query.status !== undefined && ctx.query.status !== '') {
    if (String(ctx.query.status) === 'aftersale') {
      where.push('EXISTS (SELECT 1 FROM aftersales a WHERE a.order_id = o.id AND a.status NOT IN (5, 6))');
    } else {
      where.push('o.status = ?');
      params.push(Number(ctx.query.status));
    }
  }
  S.pushTimeRange(where, params, 'o.created_at', ctx.query.startAt || ctx.query.dateStart, ctx.query.endAt || ctx.query.dateEnd);

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) AS c FROM orders o ${whereSql}`, ...params).c;
  const rows = all(`SELECT o.* FROM orders o ${whereSql} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset);
  return S.listResult(rows.map(toOrderRow), total, { page, pageSize, badges: badgesOf(shop.id) });
}

/** API-072 订单详情 */
function orderDetail(ctx) {
  const shop = S.shopOf(ctx);
  const order = ownOrder(shop.id, ctx.params.id);
  const base = orderSvc.toApi(order, { isSeller: true });
  base.operationLogs = all(
    `SELECT id, admin_name, action, detail, ip, created_at FROM operation_logs
      WHERE target_type = 'order' AND target_id = ? ORDER BY id DESC LIMIT 50`,
    String(order.id),
  ).map((r) => ({ id: r.id, operator: r.admin_name, action: r.action, detail: r.detail, ip: r.ip, createdAt: r.created_at }));
  base.aftersales = all('SELECT id, aftersale_no, type, status, refund_amount FROM aftersales WHERE order_id = ?', order.id)
    .map((a) => ({ id: a.id, aftersaleNo: a.aftersale_no, type: a.type, status: a.status, refundAmount: toYuan(a.refund_amount) }));
  base.sellerRemark = order.seller_remark;
  return base;
}

/* --------------------------- 发货 --------------------------- */

function resolveCompany(input) {
  const raw = String(input || '').trim();
  if (!raw) throw Errors.badRequest('请选择物流公司', { field: 'company' });
  const rows = config.dict('logistics_company');
  if (!rows.length) return raw;
  const hit = rows.find((r) => r.code === raw || r.name === raw);
  if (!hit) throw Errors.badRequest('物流公司不在平台字典中', { field: 'company' });
  return hit.name;
}

function checkTrackingNo(input) {
  const no = String(input || '').trim();
  if (!no) throw Errors.badRequest('物流单号不能为空', { field: 'trackingNo' });
  if (!/^[A-Za-z0-9-]{6,40}$/.test(no)) throw Errors.badRequest('物流单号格式不正确（6~40 位字母、数字或短横线）', { field: 'trackingNo' });
  return no;
}

function shipOne(ctx, shop, { orderId, company, trackingNo }) {
  const order = get('SELECT * FROM orders WHERE id = ? AND shop_id = ?', Number(orderId), shop.id);
  if (!order) throw Errors.notFound('订单不存在');
  const exist = get('SELECT * FROM logistics WHERE order_id = ? ORDER BY id DESC LIMIT 1', order.id);
  if (order.status === 2 || exist) throw Errors.badRequest('该订单已发货');
  if (order.status !== 1) throw Errors.badRequest('当前订单状态不可发货');

  const name = resolveCompany(company);
  const no = checkTrackingNo(trackingNo);
  const sameTracking = get(
    'SELECT id FROM logistics WHERE tracking_no = ? AND order_id <> ?', no, order.id,
  );

  run(
    `INSERT INTO logistics (order_id, company, tracking_no, shipped_at, operator_id, operator_type, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'seller', ?, ?)`,
    order.id, name, no, now(), ctx.admin.id, now(), now(),
  );
  const res = run('UPDATE orders SET status = 2, shipped_at = ?, updated_at = ? WHERE id = ? AND status = 1',
    now(), now(), order.id);
  if (res.changes === 0) throw Errors.badRequest('该订单已发货');

  S.audit(ctx, '订单', '订单发货', 'order', order.id, `${order.order_no}；${name} ${no}`);
  return {
    orderId: order.id,
    orderNo: order.order_no,
    status: 2,
    statusName: STATUS_NAME[2],
    company: name,
    trackingNo: no,
    shippedAt: now(),
    duplicateWarning: sameTracking ? '该物流单号已用于其他订单，请核实是否重复发货' : null,
  };
}

/** API-073 订单发货 */
function orderShip(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  v.requireFields(body, ['company', 'trackingNo']);
  return shipOne(ctx, shop, { orderId: ctx.params.id, company: body.company, trackingNo: body.trackingNo });
}

/** API-074 批量发货（逐条返回结果） */
function orderBatchShip(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  const list = S.asArray(body.items || body.list || body);
  if (!list.length) throw Errors.badRequest('请提供需要发货的订单列表', { field: 'items' });
  const results = [];
  let affected = 0;
  for (const item of list) {
    const orderId = item?.orderId ?? item?.id;
    try {
      const r = shipOne(ctx, shop, { orderId, company: item.company, trackingNo: item.trackingNo });
      affected += 1;
      results.push({ orderId: Number(orderId), ok: true, orderNo: r.orderNo, company: r.company, trackingNo: r.trackingNo });
    } catch (err) {
      results.push({ orderId: Number(orderId), ok: false, msg: err.message });
    }
  }
  S.audit(ctx, '订单', '批量发货', 'order', results.map((r) => r.orderId).join(','),
    `提交 ${list.length} 条，成功 ${affected} 条`);
  return { affected, total: list.length, results };
}

/** API-075 订单明细导出（按商品维度 CSV） */
function orderExport(ctx) {
  const shop = S.shopOf(ctx);
  const where = ['o.shop_id = ?'];
  const params = [shop.id];
  if (ctx.query.status !== undefined && ctx.query.status !== '') {
    where.push('o.status = ?');
    params.push(Number(ctx.query.status));
  }
  const keyword = String(ctx.query.orderNo || ctx.query.keyword || '').trim();
  if (keyword) { where.push('o.order_no LIKE ?'); params.push(`%${keyword}%`); }
  S.pushTimeRange(where, params, 'o.created_at', ctx.query.startAt || ctx.query.dateStart, ctx.query.endAt || ctx.query.dateEnd);
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orders = all(
    `SELECT o.* FROM orders o ${whereSql} ORDER BY o.created_at DESC, o.id DESC LIMIT 5000`,
    ...params,
  );

  const header = ['订单号', '下单时间', '支付时间', '商品名称', '规格', '数量', '单价', '小计',
    '订单金额', '支付方式', '买家昵称', '收货人', '联系电话', '订单状态', '物流公司', '物流单号'];
  const lines = [header.join(',')];
  const esc = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
  for (const order of orders) {
    const buyer = get('SELECT nickname, username FROM users WHERE id = ?', order.user_id);
    const receiver = S.parseJson(order.receiver_snapshot, {}) || {};
    const logistics = get('SELECT * FROM logistics WHERE order_id = ? ORDER BY id DESC LIMIT 1', order.id) || {};
    for (const item of itemSummaryOf(order.id)) {
      lines.push([
        order.order_no, order.created_at, order.paid_at || '', item.product_name, item.spec_name || '',
        item.quantity, fmtYuan(item.price), fmtYuan(item.subtotal), fmtYuan(order.pay_amount),
        order.pay_channel || '', buyer?.nickname || buyer?.username || '', receiver.receiver || '',
        maskPhone(receiver.phone), STATUS_NAME[order.status] || '', logistics.company || '', logistics.tracking_no || '',
      ].map(esc).join(','));
    }
  }
  const csv = `${lines.join('\r\n')}\r\n`;
  S.audit(ctx, '订单', '导出订单明细', 'order', '', `导出 ${orders.length} 笔订单，${lines.length - 1} 行商品明细`);
  return sendRaw(ctx, 200, 'text/csv; charset=utf-8', Buffer.from(`\uFEFF${csv}`, 'utf8'), 'orders.csv');
}

/** PUT /api/seller/orders/:id/remark 商家备注（买家不可见） */
function orderRemark(ctx) {
  const shop = S.activeShop(ctx);
  const order = ownOrder(shop.id, ctx.params.id);
  const body = ctx.body || {};
  const remark = v.str(body.remark ?? body.sellerRemark, 'remark', { min: 0, max: 500 });
  run('UPDATE orders SET seller_remark = ?, updated_at = ? WHERE id = ? AND shop_id = ?', remark, now(), order.id, shop.id);
  S.audit(ctx, '订单', '设置商家备注', 'order', order.id, remark);
  return { orderId: order.id, orderNo: order.order_no, sellerRemark: remark, visibleToBuyer: false };
}

module.exports = function register(api) {
  api.get('/api/seller/orders', { auth: 'seller' }, orderList);
  // 静态路径必须声明在 :id 之前，避免被参数路由吞掉
  api.get('/api/seller/orders/export', { auth: 'seller' }, orderExport);
  api.post('/api/seller/orders/batch/ship', { auth: 'seller' }, orderBatchShip);
  api.get('/api/seller/orders/:id', { auth: 'seller' }, orderDetail);
  api.post('/api/seller/orders/:id/ship', { auth: 'seller' }, orderShip);
  api.put('/api/seller/orders/:id/remark', { auth: 'seller' }, orderRemark);
};
