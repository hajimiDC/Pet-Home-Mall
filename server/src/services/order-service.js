'use strict';

const { get, all, run } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, addMinutes, parseTime, isBefore } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const config = require('../core/config');
const stock = require('./stock-service');
const couponSvc = require('./coupon-service');
const activitySvc = require('./activity-service');
const db = require('../core/db');

/**
 * 订单服务（8.16 / 8.17 / 8.18、NFR-CONS-001~005）
 *
 * 金额口径（Q-003 / NFR-CONS-004）：
 *   应付 pay_amount = 商品总计 goods_amount + 运费 freight_amount − 优惠券抵扣 coupon_amount − 活动优惠 activity_amount
 *   运费：默认 10 元，商品总计满 99 元包邮（后台可配）
 *   优惠券：每单最多 1 张平台券 + 1 张店铺券（Q-003）
 * 库存：下单锁定、支付扣减、取消/超时回滚（FR-SLR-043）
 * 幂等：idempotency_key + 唯一索引（NFR-CONS-002）
 */

const STATUS = {
  0: '待付款', 1: '待发货', 2: '已发货', 3: '已完成', 4: '已取消', 5: '已退款', 6: '待成团',
};

function freightOf(goodsAmount) {
  const fee = config.getNumber('freight_fee');
  const threshold = config.getNumber('free_shipping_threshold');
  const free = goodsAmount >= threshold;
  return { fee: free ? 0 : fee, free, threshold, baseFee: fee };
}

function purchasableOf(product, shop) {
  if (!product || product.is_deleted) return { ok: false, reason: '商品已删除' };
  if (product.status === 0) return { ok: false, reason: '商品未上架' };
  if (product.status === 1) return { ok: false, reason: '商品审核中' };
  if (product.status === 4) return { ok: false, reason: '商品审核未通过' };
  if (product.status === 3) return { ok: false, reason: '商品已下架' };
  if (!shop || shop.status !== 1) return { ok: false, reason: '店铺已停用' };
  return { ok: true, reason: null };
}

/** 组装待下单明细（购物车勾选 / 立即购买） */
function resolveItems(userId, payload) {
  const source = payload.source === 'buyNow' ? 'buyNow' : 'cart';
  const items = [];
  if (source === 'buyNow') {
    const skuId = Number(payload.skuId);
    const quantity = Number(payload.quantity || 1);
    if (!skuId) throw Errors.badRequest('请选择规格', { field: 'skuId' });
    const sku = get('SELECT * FROM skus WHERE id = ?', skuId);
    if (!sku) throw Errors.notFound('规格不存在');
    const product = get('SELECT * FROM products WHERE id = ?', sku.product_id);
    const shop = get('SELECT * FROM shops WHERE id = ?', product.shop_id);
    items.push({
      productId: product.id, skuId: sku.id, quantity, price: sku.price,
      productName: product.name, specName: sku.spec_name, image: sku.image || product.main_image,
      shopId: product.shop_id, shopName: shop.name, cartItemId: null,
      product, sku, shop, available: stock.availableOf(sku),
    });
  } else {
    const cart = get('SELECT * FROM carts WHERE user_id = ?', userId);
    if (!cart) throw Errors.badRequest('请选择要结算的商品');
    let ids = Array.isArray(payload.cartItemIds) ? payload.cartItemIds.map(Number) : [];
    const params = [cart.id];
    let filter = '';
    if (ids.length) { filter = ` AND ci.id IN (${ids.map(() => '?').join(',')})`; params.push(...ids); }
    else filter = ' AND ci.checked = 1';
    const rows = all(
      `SELECT ci.*, s.price AS sku_price, s.spec_name, s.image AS sku_image, s.stock, s.locked_stock,
              p.name AS product_name, p.main_image, p.shop_id, p.status AS product_status, p.is_deleted,
              sh.name AS shop_name, sh.status AS shop_status
         FROM cart_items ci JOIN skus s ON s.id = ci.sku_id JOIN products p ON p.id = ci.product_id
         JOIN shops sh ON sh.id = p.shop_id
        WHERE ci.cart_id = ?${filter} ORDER BY ci.id ASC`,
      ...params,
    );
    if (!rows.length) throw Errors.badRequest('请选择要结算的商品');
    for (const r of rows) {
      items.push({
        productId: r.product_id, skuId: r.sku_id, quantity: r.quantity, price: r.sku_price,
        productName: r.product_name, specName: r.spec_name, image: r.sku_image || r.main_image,
        shopId: r.shop_id, shopName: r.shop_name, cartItemId: r.id,
        product: get('SELECT * FROM products WHERE id = ?', r.product_id),
        sku: get('SELECT * FROM skus WHERE id = ?', r.sku_id),
        shop: get('SELECT * FROM shops WHERE id = ?', r.shop_id),
        available: Math.max(0, r.stock - r.locked_stock),
      });
    }
  }
  for (const it of items) {
    if (!Number.isInteger(it.quantity) || it.quantity < 1) throw Errors.badRequest('商品数量必须大于等于 1', { field: 'quantity' });
    const check = purchasableOf(it.product, it.shop);
    if (!check.ok) throw Errors.badRequest(`商品「${it.productName}」${check.reason}，请返回购物车刷新`);
    if (it.quantity > it.available) {
      throw Errors.badRequest(`商品「${it.productName}」库存不足，剩余可售 ${it.available} 件`);
    }
    it.subtotal = it.price * it.quantity;
  }
  return { source, items };
}

/** 按店铺拆分并计算金额、运费、活动优惠、券抵扣 */
function settle(items, { userId, userCouponId, shopCouponId }) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.shopId)) groups.set(it.shopId, { shopId: it.shopId, shopName: it.shopName, items: [] });
    groups.get(it.shopId).items.push(it);
  }
  const shops = [];
  for (const g of groups.values()) {
    const goodsAmount = g.items.reduce((s, i) => s + i.subtotal, 0);
    const freight = freightOf(goodsAmount);
    const act = activitySvc.bestDiscount(g.items);
    shops.push({
      shopId: g.shopId, shopName: g.shopName, items: g.items,
      goodsAmount, freight, activityAmount: act.total, activityApplied: act.applied,
      couponAmount: 0, userCouponId: null, shopCouponId: null,
    });
  }
  // 命中金额最大的店铺订单
  const main = shops.slice().sort((a, b) => b.goodsAmount - a.goodsAmount)[0];
  const couponCtx = main ? couponSvc.validateForUse({
    userId, shopId: main.shopId, goodsAmount: main.goodsAmount,
    items: main.items.map((i) => ({ productId: i.productId, subtotal: i.subtotal })),
    userCouponId, shopCouponId,
  }) : { platform: null, shop: null, total: 0 };
  if (main) {
    if (couponCtx.platform) { main.couponAmount += couponCtx.platform.discount; main.userCouponId = couponCtx.platform.userCoupon.id; }
    if (couponCtx.shop) { main.couponAmount += couponCtx.shop.discount; main.shopCouponId = couponCtx.shop.userCoupon.id; }
  }
  let totals = { goodsAmount: 0, freightAmount: 0, couponAmount: 0, activityAmount: 0, payAmount: 0 };
  for (const s of shops) {
    s.payAmount = Math.max(0, s.goodsAmount + s.freight.fee - s.couponAmount - s.activityAmount);
    totals.goodsAmount += s.goodsAmount;
    totals.freightAmount += s.freight.fee;
    totals.couponAmount += s.couponAmount;
    totals.activityAmount += s.activityAmount;
    totals.payAmount += s.payAmount;
  }
  return { shops, totals };
}

function defaultAddress(userId) {
  return get('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1', userId);
}

function addressSnapshot(addr) {
  return {
    id: addr.id, receiver: addr.receiver, phone: addr.phone,
    province: addr.province, city: addr.city, district: addr.district, detail: addr.detail,
  };
}

/** 结算预览（API-037） */
function preview(userId, payload = {}) {
  const { items } = resolveItems(userId, payload);
  const { shops, totals } = settle(items, {
    userId, userCouponId: payload.userCouponId ? Number(payload.userCouponId) : null,
    shopCouponId: payload.shopCouponId ? Number(payload.shopCouponId) : null,
  });
  const mainShop = shops.slice().sort((a, b) => b.goodsAmount - a.goodsAmount)[0];
  const couponOptions = mainShop
    ? couponSvc.availableForOrder({
      userId, shopId: mainShop.shopId, goodsAmount: mainShop.goodsAmount,
      items: mainShop.items.map((i) => ({ productId: i.productId, subtotal: i.subtotal })),
    })
    : { platform: [], shop: [] };
  const address = payload.addressId
    ? get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', Number(payload.addressId), userId)
    : defaultAddress(userId);
  const allAddresses = all('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC', userId);

  return {
    source: payload.source === 'buyNow' ? 'buyNow' : 'cart',
    items: shops.flatMap((s) => s.items.map((i) => ({
      shopId: i.shopId, shopName: i.shopName, productId: i.productId, skuId: i.skuId,
      productName: i.productName, specName: i.specName, image: i.image,
      price: toYuan(i.price), quantity: i.quantity, subtotal: toYuan(i.subtotal),
      availableStock: i.available, cartItemId: i.cartItemId,
    }))),
    shops: shops.map((s) => ({
      shopId: s.shopId, shopName: s.shopName,
      goodsAmount: toYuan(s.goodsAmount), freightAmount: toYuan(s.freight.fee),
      freeShipping: s.freight.free, couponAmount: toYuan(s.couponAmount),
      activityAmount: toYuan(s.activityAmount), payAmount: toYuan(s.payAmount),
      activities: s.activityApplied.map((a) => ({ ...a, discount: toYuan(a.discount) })),
    })),
    goodsAmount: toYuan(totals.goodsAmount),
    freightAmount: toYuan(totals.freightAmount),
    couponAmount: toYuan(totals.couponAmount),
    activityAmount: toYuan(totals.activityAmount),
    payAmount: toYuan(totals.payAmount),
    freeShipping: shops.every((s) => s.freight.free),
    freightRule: {
      fee: toYuan(config.getNumber('freight_fee')),
      threshold: toYuan(config.getNumber('free_shipping_threshold')),
      desc: `默认运费 ${toYuan(config.getNumber('freight_fee'))} 元，满 ${toYuan(config.getNumber('free_shipping_threshold'))} 元包邮`,
    },
    coupons: {
      platform: couponOptions.platform, shop: couponOptions.shop,
      bestPlatformId: couponOptions.bestPlatformId, bestShopId: couponOptions.bestShopId,
    },
    address: address ? { ...addressSnapshot(address), phoneMask: maskPhone(address.phone) } : null,
    addresses: allAddresses.map((a) => ({ ...addressSnapshot(a), isDefault: a.is_default === 1, phoneMask: maskPhone(a.phone) })),
    payChannels: config.getJson('payment_channels', ['alipay', 'wechat']),
    deliveryType: '快递',
  };
}

/** 提交订单（API-038）：幂等 + 事务 */
function create(userId, payload = {}) {
  const idemKey = payload.idempotencyKey ? String(payload.idempotencyKey).slice(0, 64) : null;
  if (idemKey) {
    const exist = get(
      `SELECT * FROM orders WHERE user_id = ? AND (idempotency_key = ? OR idempotency_key LIKE ?)
       ORDER BY id ASC LIMIT 1`,
      userId, idemKey, `${idemKey}-%`,
    );
    if (exist) return { orders: [summarize(exist)], idempotent: true };
  }
  const { items, source } = resolveItems(userId, payload);
  // 拼团：按拼团价下单（BR-GRP-004 / BR-GRP-005：只影响价格，共用 SKU 库存池）
  let groupBuy = null; let team = null;
  if (payload.groupBuyId) {
    groupBuy = get('SELECT * FROM group_buys WHERE id = ?', Number(payload.groupBuyId));
    if (!groupBuy) throw Errors.notFound('拼团活动不存在');
    if (groupBuy.status !== 1) throw Errors.badRequest('拼团活动未开始或已结束');
    if (isBefore(groupBuy.end_at, now())) throw Errors.badRequest('拼团活动已结束');
    if (items.length !== 1 || items[0].skuId !== groupBuy.sku_id) throw Errors.badRequest('拼团商品与规格不匹配');
    items[0].price = groupBuy.group_price;
    items[0].subtotal = groupBuy.group_price * items[0].quantity;
    if (payload.teamId) {
      team = get('SELECT * FROM group_teams WHERE id = ? AND group_buy_id = ?', Number(payload.teamId), groupBuy.id);
      if (!team) throw Errors.notFound('拼团团不存在');
      if (team.status !== 1) throw Errors.badRequest(team.status === 2 ? '该团已满' : '该团已结束');
      if (parseTime(team.expire_at) <= new Date()) throw Errors.badRequest('该团已结束');
      const joined = get('SELECT id FROM group_members WHERE team_id = ? AND user_id = ? AND status != 3', team.id, userId);
      if (joined && !config.getBool('group_buy_allow_repeat_join')) throw Errors.badRequest('同一团仅可下 1 单');
    }
  }
  const address = payload.addressId
    ? get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', Number(payload.addressId), userId)
    : defaultAddress(userId);
  if (!address) throw Errors.badRequest('请先添加收货地址', { field: 'addressId' });
  validateAddress(address);
  const remark = payload.remark ? String(payload.remark).slice(0, 200) : '';
  const { shops, totals } = settle(items, {
    userId,
    userCouponId: payload.userCouponId ? Number(payload.userCouponId) : null,
    shopCouponId: payload.shopCouponId ? Number(payload.shopCouponId) : null,
  });

  const expireAt = addMinutes(config.getNumber('order_timeout_minutes'));
  const created = db.transaction(() => {
    const orderIds = [];
    for (const s of shops) {
      for (const it of s.items) {
        stock.reserve(it.skuId, it.quantity, { operatorName: '系统' });
      }
      const orderNo = db.bizNo('PO');
      const res = run(
        `INSERT INTO orders (order_no, user_id, shop_id, user_coupon_id, shop_coupon_id, goods_amount, freight_amount,
           coupon_amount, activity_amount, pay_amount, status, remark, receiver_snapshot, group_buy_id, group_team_id,
           idempotency_key, expire_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
        orderNo, userId, s.shopId, s.userCouponId, s.shopCouponId, s.goodsAmount, s.freight.fee,
        s.couponAmount, s.activityAmount, s.payAmount, remark, JSON.stringify(addressSnapshot(address)),
        groupBuy?.id || null, team?.id || null, shops.length === 1 ? idemKey : (idemKey ? `${idemKey}-${s.shopId}` : null),
        expireAt, now(), now(),
      );
      const orderId = res.lastInsertRowid;
      for (const it of s.items) {
        run(
          `INSERT INTO order_items (order_id, product_id, sku_id, product_name, spec_name, image, price, quantity, subtotal, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          orderId, it.productId, it.skuId, it.productName, it.specName, it.image, it.price, it.quantity, it.subtotal, now(),
        );
      }
      orderIds.push(orderId);
    }
    for (const s of shops) {
      if (s.userCouponId) couponSvc.markUsed(s.userCouponId, orderIds[shops.indexOf(s)]);
      if (s.shopCouponId) couponSvc.markUsed(s.shopCouponId, orderIds[shops.indexOf(s)]);
    }
    if (source === 'cart') {
      for (const it of items) if (it.cartItemId) run('DELETE FROM cart_items WHERE id = ?', it.cartItemId);
    }
    if (groupBuy) {
      const orderId = orderIds[0];
      let teamId = team?.id;
      if (!teamId) {
        const teamRes = run(
          `INSERT INTO group_teams (group_buy_id, leader_user_id, required_count, joined_count, expire_at, status, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, 1, ?, ?)`,
          groupBuy.id, userId, groupBuy.required_count,
          require('../core/money').addDays(groupBuy.valid_days), now(), now(),
        );
        teamId = teamRes.lastInsertRowid;
        run('UPDATE orders SET group_team_id = ? WHERE id = ?', teamId, orderId);
      }
      run('INSERT INTO group_members (team_id, user_id, order_id, status, created_at) VALUES (?, ?, ?, 1, ?)',
        teamId, userId, orderId, now());
    }
    return orderIds;
  });

  const orders = created.map((id) => get('SELECT * FROM orders WHERE id = ?', id));
  return {
    orders: orders.map((o) => summarize(o)),
    payAmount: toYuan(totals.payAmount),
    expireAt,
  };
}

function validateAddress(addr) {
  const name = String(addr.receiver || '').trim();
  if (name.length < 2 || name.length > 20) throw Errors.badRequest('收货人姓名需为 2-20 个字符', { field: 'receiver' });
  if (!/^1[3-9]\d{9}$/.test(addr.phone)) throw Errors.badRequest('联系电话格式不正确', { field: 'phone' });
  if (!addr.province || !addr.city || !addr.district) throw Errors.badRequest('所在地区三级须完整选择', { field: 'district' });
  if (!addr.detail) throw Errors.badRequest('详细地址不能为空', { field: 'detail' });
}

function summarize(order) {
  return {
    orderId: order.id, orderNo: order.order_no, status: order.status,
    statusName: STATUS[order.status], payAmount: toYuan(order.pay_amount), expireAt: order.expire_at,
  };
}

/** 取消订单（用户主动） */
function cancel(userId, orderId, reason = '用户取消') {
  const order = get('SELECT * FROM orders WHERE id = ? AND user_id = ?', Number(orderId), userId);
  if (!order) throw Errors.notFound('订单不存在');
  if (order.status !== 0) throw Errors.badRequest(order.status === 4 ? '订单已取消' : '当前订单状态不可取消');
  return db.transaction(() => closeOrder(order, reason, '取消回滚'));
}

/** 超时关单（定时任务） */
function closeExpiredOrders() {
  const rows = all('SELECT * FROM orders WHERE status = 0 AND expire_at <= ?', now());
  let closed = 0;
  for (const order of rows) {
    try {
      db.transaction(() => closeOrder(order, '超时未支付', '超时回滚'));
      closed += 1;
    } catch (_) { /* 单笔失败不影响其它订单 */ }
  }
  return closed;
}

function closeOrder(order, reason, source) {
  const res = run(
    "UPDATE orders SET status = 4, closed_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ? AND status = 0",
    now(), reason, now(), order.id,
  );
  if (res.changes === 0) return { skipped: true };
  const items = all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  for (const item of items) {
    stock.release(item.sku_id, item.quantity, { refNo: order.order_no, source });
  }
  couponSvc.restore(order.user_coupon_id);
  couponSvc.restore(order.shop_coupon_id);
  if (order.group_team_id) {
    run('UPDATE group_members SET status = 3 WHERE order_id = ?', order.id);
  }
  return { closed: true };
}

/** 支付成功处理（由支付服务调用） */
function markPaid(order, payment) {
  return db.transaction(() => {
    const fresh = get('SELECT * FROM orders WHERE id = ?', order.id);
    if (fresh.status !== 0) return { already: true, order: fresh };
    if (parseTime(fresh.expire_at) <= new Date()) {
      closeOrder(fresh, '超时未支付', '超时回滚');
      throw Errors.badRequest('订单已超时，请重新下单');
    }
    const items = all('SELECT * FROM order_items WHERE order_id = ?', fresh.id);
    for (const item of items) {
      stock.deduct(item.sku_id, item.quantity, { refNo: fresh.order_no });
      run('UPDATE products SET sales = sales + ?, sales_volume = sales_volume + ? WHERE id = ?', item.quantity, item.quantity, item.product_id);
    }
    const nextStatus = fresh.group_team_id ? 6 : 1;
    run('UPDATE orders SET status = ?, pay_channel = ?, paid_at = ?, updated_at = ? WHERE id = ?',
      nextStatus, payment.channel, now(), now(), fresh.id);
    if (fresh.group_team_id) {
      run('UPDATE group_members SET status = 2 WHERE order_id = ?', fresh.id);
      const team = get('SELECT * FROM group_teams WHERE id = ?', fresh.group_team_id);
      const paidCount = get('SELECT COUNT(*) AS c FROM group_members WHERE team_id = ? AND status = 2', team.id).c;
      run('UPDATE group_teams SET joined_count = ?, updated_at = ? WHERE id = ?', paidCount, now(), team.id);
      if (paidCount >= team.required_count) {
        run("UPDATE group_teams SET status = 2, updated_at = ? WHERE id = ?", now(), team.id);
        run("UPDATE orders SET status = 1, updated_at = ? WHERE group_team_id = ? AND status = 6", now(), team.id);
      }
    }
    return { paid: true, order: get('SELECT * FROM orders WHERE id = ?', fresh.id) };
  });
}

/** 订单详情（含归属校验） */
function detail(userId, orderId, { isSeller = false, shopId = null } = {}) {
  const order = isSeller
    ? get('SELECT * FROM orders WHERE id = ? AND shop_id = ?', Number(orderId), shopId)
    : get('SELECT * FROM orders WHERE id = ? AND user_id = ?', Number(orderId), userId);
  if (!order) throw Errors.notFound('订单不存在');
  return toApi(order, { isSeller });
}

function toApi(order, { isSeller = false } = {}) {
  const items = all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', order.id);
  const receiver = db.parseJson(order.receiver_snapshot, {}) || {};
  const shop = get('SELECT id, name, logo FROM shops WHERE id = ?', order.shop_id);
  const logistics = get('SELECT * FROM logistics WHERE order_id = ? ORDER BY id DESC LIMIT 1', order.id);
  const payment = get('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', order.id);
  const buyer = get('SELECT id, username, nickname, phone FROM users WHERE id = ?', order.user_id);
  const remain = Math.max(0, Math.floor((parseTime(order.expire_at).getTime() - Date.now()) / 1000));
  const base = {
    id: order.id,
    orderNo: order.order_no,
    status: order.status,
    statusName: STATUS[order.status] || '未知',
    shopId: order.shop_id,
    shopName: shop?.name || '',
    shopLogo: shop?.logo || '',
    goodsAmount: toYuan(order.goods_amount),
    freightAmount: toYuan(order.freight_amount),
    couponAmount: toYuan(order.coupon_amount),
    activityAmount: toYuan(order.activity_amount),
    payAmount: toYuan(order.pay_amount),
    payChannel: order.pay_channel,
    remark: order.remark,
    receiver: {
      receiver: receiver.receiver, phone: isSeller ? maskPhone(receiver.phone) : receiver.phone,
      phoneMask: maskPhone(receiver.phone),
      province: receiver.province, city: receiver.city, district: receiver.district, detail: receiver.detail,
      fullAddress: `${receiver.province || ''}${receiver.city || ''}${receiver.district || ''}${receiver.detail || ''}`,
    },
    items: items.map((i) => ({
      id: i.id, productId: i.product_id, skuId: i.sku_id, productName: i.product_name,
      specName: i.spec_name, image: i.image, price: toYuan(i.price), quantity: i.quantity,
      subtotal: toYuan(i.subtotal), aftersaleId: i.aftersale_id,
    })),
    logistics: logistics ? { company: logistics.company, trackingNo: logistics.tracking_no, shippedAt: logistics.shipped_at } : null,
    payment: payment ? { payNo: payment.pay_no, channel: payment.channel, amount: toYuan(payment.amount), status: payment.status, paidAt: payment.paid_at } : null,
    groupBuyId: order.group_buy_id,
    groupTeamId: order.group_team_id,
    createdAt: order.created_at,
    paidAt: order.paid_at,
    shippedAt: order.shipped_at,
    finishedAt: order.finished_at,
    closedAt: order.closed_at,
    cancelReason: order.cancel_reason,
    expireAt: order.expire_at,
    remainSeconds: order.status === 0 ? remain : 0,
    deliveryType: '快递',
  };
  if (isSeller) {
    base.buyer = { id: buyer?.id, nickname: buyer?.nickname || buyer?.username, phoneMask: maskPhone(buyer?.phone) };
    base.sellerRemark = order.seller_remark;
  }
  return base;
}

/** 我的订单列表（API-040） */
function listForUser(userId, { status, keyword, page = 1, pageSize = 20 } = {}) {
  const params = [userId];
  let where = 'WHERE o.user_id = ?';
  if (status !== undefined && status !== '' && status !== null) {
    if (String(status) === 'aftersale') where += ' AND EXISTS (SELECT 1 FROM aftersales a WHERE a.order_id = o.id)';
    else { where += ' AND o.status = ?'; params.push(Number(status)); }
  }
  if (keyword) { where += ' AND (o.order_no LIKE ? OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.product_name LIKE ?))'; params.push(`%${keyword}%`, `%${keyword}%`); }
  const total = get(`SELECT COUNT(*) AS c FROM orders o ${where}`, ...params).c;
  const rows = all(`SELECT o.* FROM orders o ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
  return { total, rows: rows.map((o) => toApi(o)) };
}

/** 确认收货（补充接口 API-157，对应 8.17 主流程「收货」） */
function confirmReceive(userId, orderId) {
  const order = get('SELECT * FROM orders WHERE id = ? AND user_id = ?', Number(orderId), userId);
  if (!order) throw Errors.notFound('订单不存在');
  if (order.status !== 2) throw Errors.badRequest('当前订单状态不可确认收货');
  run('UPDATE orders SET status = 3, finished_at = ?, updated_at = ? WHERE id = ? AND status = 2', now(), now(), order.id);
  return { orderId: order.id, status: 3, statusName: STATUS[3], finishedAt: now() };
}

module.exports = {
  STATUS, preview, create, cancel, closeExpiredOrders, markPaid, detail, listForUser, confirmReceive,
  toApi, settle, resolveItems, summarize, freightOf, purchasableOf, validateAddress,
};
