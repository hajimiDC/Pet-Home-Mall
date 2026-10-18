'use strict';

const { get, all, run, transaction, pagination, bizNo } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, parseTime } = require('../core/money');
const { auditLog, sendRaw } = require('../core/http');
const { maskPhone } = require('../core/privacy');
const config = require('../core/config');
const stockSvc = require('../services/stock-service');
const orderSvc = require('../services/order-service');

/**
 * 平台后台 · 仓库域（API-123 ~ API-128、FR-WHS-001 ~ FR-WHS-016、9.4.2）
 *
 * 约定：
 *  - 库存「变更」一律经 services/stock-service（changeStock / adjust / reserve），
 *    与商家端共用同一 stock_logs 流水，保证 FR-WHS-003 两端同源实时可见；
 *  - 本模块只负责平台侧的查询、单据编排与状态流转，不重复实现库存加减；
 *  - 金额库内为「分」，对外统一 toYuan()。
 */

const IN_SOURCES = ['采购入库', '退货入库', '盘盈'];
const OUT_SOURCES = ['销售出库', '报损', '盘亏'];
const ORDER_STATUS_NAME = orderSvc.STATUS;

const STOCK_SORTS = {
  stock: 's.stock',
  totalStock: 's.stock',
  lockedStock: 's.locked_stock',
  availableStock: '(s.stock - s.locked_stock)',
  warnStock: 's.warn_stock',
  price: 's.price',
  productName: 'p.name',
  skuId: 's.id',
  updatedAt: 's.updated_at',
};

const LOG_SORTS = {
  createdAt: 'l.created_at',
  changeQty: 'l.change_qty',
  beforeQty: 'l.before_qty',
  afterQty: 'l.after_qty',
  id: 'l.id',
};

/** 排序白名单（避免拼接注入，NFR-SEC-007） */
function sortSql(query = {}, map, fallback) {
  const key = String(query.sortBy || query.orderBy || '').trim();
  const dir = /^asc$/i.test(String(query.sortOrder || query.order || '').trim()) ? 'ASC' : 'DESC';
  const col = map[key];
  return col ? `${col} ${dir}` : fallback;
}

function isTrue(value) {
  if (value === true || value === 1) return true;
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function toInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 时间区间过滤（起止均可缺省） */
function rangeFilter(query, where, params, column) {
  const start = String(query.startTime || query.startDate || '').trim();
  const end = String(query.endTime || query.endDate || '').trim();
  if (start) { where.push(`${column} >= ?`); params.push(start); }
  if (end) { where.push(`${column} <= ?`); params.push(end); }
}

function csvEscape(value) {
  return `"${String(value === null || value === undefined ? '' : value).replace(/"/g, '""')}"`;
}

function csvBuffer(header, rows) {
  const lines = [header.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  // BOM 便于 Excel 正确识别 UTF-8
  return Buffer.from(`\uFEFF${lines.join('\r\n')}`, 'utf8');
}

function shopOf(shopId) {
  const shop = get('SELECT * FROM shops WHERE id = ?', Number(shopId));
  if (!shop) throw Errors.notFound('店铺不存在');
  return shop;
}

function skuOf(skuId) {
  const sku = get(
    `SELECT s.*, p.name AS product_name, p.shop_id, p.is_deleted
       FROM skus s JOIN products p ON p.id = s.product_id WHERE s.id = ?`,
    Number(skuId),
  );
  if (!sku) throw Errors.notFound(`规格（SKU ${skuId}）不存在`);
  return sku;
}

function stockOrderView(order) {
  const shop = get('SELECT id, name FROM shops WHERE id = ?', order.shop_id);
  const items = all('SELECT * FROM stock_order_items WHERE stock_order_id = ? ORDER BY id ASC', order.id);
  return {
    id: order.id,
    stockOrderNo: order.stock_order_no,
    type: order.type,
    typeName: order.type === 1 ? '入库' : '出库',
    sourceType: order.source_type,
    shopId: order.shop_id,
    shopName: shop?.name || '',
    status: order.status,
    statusName: ['草稿', '已提交', '已作废'][order.status] || '未知',
    remark: order.remark || '',
    operatorId: order.operator_id,
    createdAt: order.created_at,
    submittedAt: order.submitted_at,
    items: items.map((it) => {
      const sku = get(
        `SELECT s.spec_name, p.name AS product_name FROM skus s JOIN products p ON p.id = s.product_id WHERE s.id = ?`,
        it.sku_id,
      );
      return {
        id: it.id,
        skuId: it.sku_id,
        productName: sku?.product_name || '',
        specName: sku?.spec_name || '',
        quantity: it.quantity,
        beforeStock: it.before_qty,
        afterStock: it.after_qty,
      };
    }),
  };
}

function stockTakeView(take) {
  const shop = get('SELECT id, name FROM shops WHERE id = ?', take.shop_id);
  const items = all('SELECT * FROM stock_take_items WHERE stock_take_id = ? ORDER BY id ASC', take.id);
  const rows = items.map((it) => {
    const sku = get(
      `SELECT s.spec_name, s.barcode, s.stock, p.name AS product_name FROM skus s
         JOIN products p ON p.id = s.product_id WHERE s.id = ?`,
      it.sku_id,
    );
    const diffQty = it.actual_qty - it.book_qty;
    return {
      id: it.id,
      skuId: it.sku_id,
      productName: sku?.product_name || '',
      specName: sku?.spec_name || '',
      barcode: sku?.barcode || '',
      bookQty: it.book_qty,
      actualQty: it.actual_qty,
      diffQty,
      diffType: diffQty === 0 ? '无差异' : (diffQty > 0 ? '盘盈' : '盘亏'),
      currentStock: sku ? sku.stock : null,
    };
  });
  const gain = rows.filter((r) => r.diffQty > 0);
  const loss = rows.filter((r) => r.diffQty < 0);
  return {
    id: take.id,
    takeNo: take.take_no,
    shopId: take.shop_id,
    shopName: shop?.name || '',
    scope: take.scope,
    status: take.status,
    statusName: take.status === 1 ? '已确认' : '草稿',
    operatorId: take.operator_id,
    createdAt: take.created_at,
    confirmedAt: take.confirmed_at,
    total: rows.length,
    rows,
    summary: {
      itemCount: rows.length,
      gainCount: gain.length,
      gainQty: gain.reduce((s, r) => s + r.diffQty, 0),
      lossCount: loss.length,
      lossQty: loss.reduce((s, r) => s + r.diffQty, 0),
      diffCount: rows.filter((r) => r.diffQty !== 0).length,
    },
  };
}

/** 物料公司字典内校验：接受 code 或 name，返回字典标准名称 */
function logisticsCompanyName(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const dict = config.dict('logistics_company');
  const hit = dict.find((d) => d.code === raw || d.name === raw
    || d.code.toLowerCase() === raw.toLowerCase());
  return hit ? hit.name : null;
}

function extractBatchList(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.items)) return body.items;
  if (body && Array.isArray(body.orders)) return body.orders;
  if (body && Array.isArray(body.list)) return body.list;
  return [];
}

module.exports = function register(api) {
  /* ============================ API-123 库存总览 ============================ */
  api.get('/api/admin/stocks', { auth: 'admin', perm: 'menu.whs.stock' }, (ctx) => {
    const { pageSize, offset } = pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
    const where = ['p.is_deleted = 0'];
    const params = [];

    const keyword = String(ctx.query.keyword || '').trim();
    if (keyword) {
      where.push('(p.name LIKE ? OR s.spec_name LIKE ? OR s.barcode LIKE ? OR p.product_code LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    const shopId = toInt(ctx.query.shopId);
    if (shopId) { where.push('p.shop_id = ?'); params.push(shopId); }
    if (isTrue(ctx.query.warningOnly)) where.push('(s.stock - s.locked_stock) <= s.warn_stock');

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = get(
      `SELECT COUNT(*) AS c FROM skus s JOIN products p ON p.id = s.product_id ${whereSql}`,
      ...params,
    ).c;
    const agg = get(
      `SELECT COALESCE(SUM(s.stock), 0) AS total_stock, COALESCE(SUM(s.locked_stock), 0) AS locked_stock,
              COALESCE(SUM(CASE WHEN (s.stock - s.locked_stock) <= s.warn_stock THEN 1 ELSE 0 END), 0) AS warning_count
         FROM skus s JOIN products p ON p.id = s.product_id ${whereSql}`,
      ...params,
    );
    const orderBy = sortSql(ctx.query, STOCK_SORTS, 'p.id DESC, s.id ASC');
    const rows = all(
      `SELECT s.*, p.name AS product_name, p.main_image, p.shop_id, p.product_code, sh.name AS shop_name
         FROM skus s JOIN products p ON p.id = s.product_id JOIN shops sh ON sh.id = p.shop_id
         ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      ...params, pageSize, offset,
    );

    return {
      total,
      rows: rows.map((r) => ({
        skuId: r.id,
        productId: r.product_id,
        productName: r.product_name,
        productCode: r.product_code,
        specName: r.spec_name,
        barcode: r.barcode,
        image: r.image || r.main_image,
        price: toYuan(r.price),
        shopId: r.shop_id,
        shopName: r.shop_name,
        totalStock: r.stock,
        lockedStock: r.locked_stock,
        availableStock: Math.max(0, r.stock - r.locked_stock),
        warnStock: r.warn_stock,
        warning: (r.stock - r.locked_stock) <= r.warn_stock,
        version: r.version,
        updatedAt: r.updated_at,
      })),
      summary: {
        totalStock: agg.total_stock,
        lockedStock: agg.locked_stock,
        availableStock: Math.max(0, agg.total_stock - agg.locked_stock),
        warningCount: agg.warning_count,
      },
      source: 'stock_logs', // FR-WHS-003：与商家端 9.3.5 同源
    };
  });

  /* ========================= API-124 出入库单保存 / 提交 ========================= */
  api.post('/api/admin/stock-orders', { auth: 'admin', perm: 'menu.whs.inout' }, (ctx) => {
    const body = ctx.body || {};
    const type = Number(body.type);
    if (type !== 1 && type !== 2) throw Errors.badRequest('单据类型不合法（1 入库 / 2 出库）', { field: 'type' });

    const sourceType = String(body.sourceType || '').trim();
    const allowed = type === 1 ? IN_SOURCES : OUT_SOURCES;
    if (!allowed.includes(sourceType)) {
      throw Errors.badRequest(
        `来源与单据类型不匹配，${type === 1 ? '入库' : '出库'}单来源须为：${allowed.join(' / ')}`,
        { field: 'sourceType' },
      );
    }

    const shop = shopOf(body.shopId);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw Errors.badRequest('请至少录入一条商品明细', { field: 'items' });
    }
    if (body.items.length > 200) throw Errors.badRequest('单次最多录入 200 条明细', { field: 'items' });

    // 合并重复 SKU，并校验归属当前店铺（FR-BE-007 数据隔离）
    const merged = new Map();
    for (const item of body.items) {
      const skuId = toInt(item.skuId);
      const quantity = Number(item.quantity);
      if (!skuId) throw Errors.badRequest('请选择规格（skuId）', { field: 'skuId' });
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw Errors.badRequest('数量必须为正整数', { field: 'quantity' });
      }
      const sku = skuOf(skuId);
      if (sku.shop_id !== shop.id) {
        throw Errors.badRequest(`规格（SKU ${skuId}）不属于所选店铺`, { field: 'skuId' });
      }
      merged.set(skuId, (merged.get(skuId) || 0) + quantity);
    }

    const submit = isTrue(body.submit);
    const remark = String(body.remark || '').trim().slice(0, 200);
    const stockOrderNo = bizNo(type === 1 ? 'IO' : 'OD');

    const id = transaction(() => {
      const orderId = run(
        `INSERT INTO stock_orders (stock_order_no, type, shop_id, source_type, status, operator_id, remark, created_at, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        stockOrderNo, type, shop.id, sourceType, submit ? 1 : 0, ctx.admin.id, remark, now(), submit ? now() : null,
      ).lastInsertRowid;

      for (const [skuId, quantity] of merged) {
        const beforeQty = stockSvc.skuRow(skuId).stock;
        let afterQty = null;
        if (submit) {
          const signedQty = type === 1 ? quantity : -quantity;
          const after = stockSvc.changeStock(skuId, signedQty, {
            source: sourceType,
            refNo: stockOrderNo,
            operatorId: ctx.admin.id,
            operatorName: ctx.admin.name,
            remark: `${sourceType}（${stockOrderNo}）`,
          });
          afterQty = after.stock;
        }
        run(
          `INSERT INTO stock_order_items (stock_order_id, sku_id, quantity, before_qty, after_qty)
           VALUES (?, ?, ?, ?, ?)`,
          orderId, skuId, quantity, submit ? beforeQty : null, submit ? afterQty : null,
        );
      }
      return orderId;
    });

    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '仓库', action: submit ? `${sourceType}单提交` : `${sourceType}单保存草稿`,
      targetType: 'stock_order', targetId: stockOrderNo,
      detail: {
        stockOrderNo, type, sourceType, shopId: shop.id, shopName: shop.name,
        itemCount: merged.size, submit, remark,
      },
      ip: ctx.ip,
    });

    return stockOrderView(get('SELECT * FROM stock_orders WHERE id = ?', id));
  });

  /* ====================== API-124 出入库单作废（反向对冲） ====================== */
  api.post('/api/admin/stock-orders/:id/void', { auth: 'admin', perm: 'menu.whs.inout' }, (ctx) => {
    const order = get('SELECT * FROM stock_orders WHERE id = ?', Number(ctx.params.id));
    if (!order) throw Errors.notFound('出入库单不存在');
    if (order.status === 2) throw Errors.badRequest('单据已作废，请勿重复操作');
    if (order.status !== 0 && order.status !== 1) throw Errors.badRequest('单据当前状态不可作废');

    const reason = String((ctx.body || {}).reason || '').trim().slice(0, 200);
    let reversed = false;

    if (order.status === 1) {
      // 已提交单据不可修改，只能生成反向流水对冲（FR-WHS-006）
      const items = all('SELECT * FROM stock_order_items WHERE stock_order_id = ? ORDER BY id ASC', order.id);
      transaction(() => {
        for (const item of items) {
          const signedQty = order.type === 1 ? -item.quantity : item.quantity;
          stockSvc.changeStock(item.sku_id, signedQty, {
            source: order.type === 1 ? '入库单作废' : '出库单作废',
            refNo: order.stock_order_no,
            operatorId: ctx.admin.id,
            operatorName: ctx.admin.name,
            remark: `作废${order.source_type}单（${order.stock_order_no}）${reason ? `：${reason}` : ''}`,
          });
        }
        run('UPDATE stock_orders SET status = 2 WHERE id = ? AND status = 1', order.id);
      });
      reversed = true;
    } else {
      run('UPDATE stock_orders SET status = 2 WHERE id = ? AND status = 0', order.id);
    }

    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '仓库', action: '出入库单作废', targetType: 'stock_order', targetId: order.stock_order_no,
      detail: {
        stockOrderNo: order.stock_order_no, type: order.type, sourceType: order.source_type,
        reversed, reason,
      },
      ip: ctx.ip,
    });

    return stockOrderView(get('SELECT * FROM stock_orders WHERE id = ?', order.id));
  });

  /* ==================== API-125 盘点单创建 / 录入 / 确认 ==================== */
  api.post('/api/admin/stock-takes', { auth: 'admin', perm: 'menu.whs.take' }, (ctx) => {
    const body = ctx.body || {};
    const takeId = toInt(body.takeId);
    if (takeId) return recordStockTake(ctx, takeId);
    return createStockTake(ctx);
  });

  api.get('/api/admin/stock-takes', { auth: 'admin', perm: 'menu.whs.take' }, (ctx) => {
    const { pageSize, offset } = pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
    const where = ['1 = 1'];
    const params = [];
    const shopId = toInt(ctx.query.shopId);
    if (shopId) { where.push('t.shop_id = ?'); params.push(shopId); }
    const status = toInt(ctx.query.status);
    if (status !== null) { where.push('t.status = ?'); params.push(status); }
    const keyword = String(ctx.query.keyword || '').trim();
    if (keyword) { where.push('(t.take_no LIKE ? OR sh.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    rangeFilter(ctx.query, where, params, 't.created_at');
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = get(
      `SELECT COUNT(*) AS c FROM stock_takes t JOIN shops sh ON sh.id = t.shop_id ${whereSql}`,
      ...params,
    ).c;
    const rows = all(
      `SELECT t.*, sh.name AS shop_name,
              (SELECT COUNT(*) FROM stock_take_items i WHERE i.stock_take_id = t.id) AS item_count,
              (SELECT COUNT(*) FROM stock_take_items i WHERE i.stock_take_id = t.id AND i.actual_qty <> i.book_qty) AS diff_count
         FROM stock_takes t JOIN shops sh ON sh.id = t.shop_id
         ${whereSql} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
      ...params, pageSize, offset,
    );
    return {
      total,
      rows: rows.map((t) => ({
        id: t.id,
        takeNo: t.take_no,
        shopId: t.shop_id,
        shopName: t.shop_name,
        scope: t.scope,
        status: t.status,
        statusName: t.status === 1 ? '已确认' : '草稿',
        itemCount: t.item_count,
        diffCount: t.diff_count,
        operatorId: t.operator_id,
        createdAt: t.created_at,
        confirmedAt: t.confirmed_at,
      })),
    };
  });

  api.get('/api/admin/stock-takes/:id', { auth: 'admin', perm: 'menu.whs.take' }, (ctx) => {
    const take = get('SELECT * FROM stock_takes WHERE id = ?', Number(ctx.params.id));
    if (!take) throw Errors.notFound('盘点单不存在');
    return stockTakeView(take);
  });

  /* ==================== API-126 待发货订单池 ==================== */
  api.get('/api/admin/orders/pending-ship', { auth: 'admin', perm: 'menu.whs.ship' }, (ctx) => {
    const { pageSize, offset } = pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
    const where = ['o.status = 1'];
    const params = [];

    const shopId = toInt(ctx.query.shopId);
    if (shopId) { where.push('o.shop_id = ?'); params.push(shopId); }
    rangeFilter(ctx.query, where, params, 'o.created_at');
    const keyword = String(ctx.query.keyword || '').trim();
    if (keyword) {
      where.push('(o.order_no LIKE ? OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.product_name LIKE ?))');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    const productId = toInt(ctx.query.productId);
    if (productId) {
      where.push('EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.product_id = ?)');
      params.push(productId);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = get(`SELECT COUNT(*) AS c FROM orders o ${whereSql}`, ...params).c;
    const rows = all(
      `SELECT o.*, sh.name AS shop_name, u.username, u.nickname, u.phone
         FROM orders o JOIN shops sh ON sh.id = o.shop_id JOIN users u ON u.id = o.user_id
         ${whereSql} ORDER BY o.paid_at ASC, o.id ASC LIMIT ? OFFSET ?`,
      ...params, pageSize, offset,
    );

    // 一次性取回本页订单明细，避免 N+1
    const itemMap = new Map();
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const items = all(
        `SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`,
        ...ids,
      );
      for (const it of items) {
        if (!itemMap.has(it.order_id)) itemMap.set(it.order_id, []);
        itemMap.get(it.order_id).push(it);
      }
    }

    return {
      total,
      rows: rows.map((o) => {
        const base = o.paid_at || o.created_at;
        const waitingHours = base
          ? Math.max(0, Math.round((Date.now() - parseTime(base).getTime()) / 3600000 * 10) / 10)
          : 0;
        return {
          orderId: o.id,
          orderNo: o.order_no,
          status: o.status,
          statusName: ORDER_STATUS_NAME[o.status] || '待发货',
          shopId: o.shop_id,
          shopName: o.shop_name,
          buyer: { nickname: o.nickname || o.username, phoneMask: maskPhone(o.phone) },
          payAmount: toYuan(o.pay_amount),
          goodsAmount: toYuan(o.goods_amount),
          payChannel: o.pay_channel,
          paidAt: o.paid_at,
          createdAt: o.created_at,
          waitingHours,
          remark: o.remark || '',
          items: (itemMap.get(o.id) || []).map((it) => ({
            orderItemId: it.id,
            productId: it.product_id,
            skuId: it.sku_id,
            productName: it.product_name,
            specName: it.spec_name,
            image: it.image,
            price: toYuan(it.price),
            quantity: it.quantity,
            subtotal: toYuan(it.subtotal),
          })),
        };
      }),
    };
  });

  /* ==================== API-127 批量发货 ==================== */
  api.post('/api/admin/orders/batch/ship', { auth: 'admin', perm: 'menu.whs.ship' }, (ctx) => {
    const list = extractBatchList(ctx.body);
    if (!list.length) throw Errors.badRequest('请提交待发货列表', { field: 'items' });
    if (list.length > 200) throw Errors.badRequest('单次最多处理 200 笔订单', { field: 'items' });

    const results = [];
    let successCount = 0;
    let failedCount = 0;

    list.forEach((entry, index) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      const result = { index, orderId: toInt(row.orderId), orderNo: row.orderNo || '', success: false, reason: '' };
      try {
        const order = row.orderId
          ? get('SELECT * FROM orders WHERE id = ?', toInt(row.orderId))
          : get('SELECT * FROM orders WHERE order_no = ?', String(row.orderNo || '').trim());
        if (!order) throw Errors.notFound('订单不存在');
        result.orderId = order.id;
        result.orderNo = order.order_no;
        if (order.status !== 1) {
          throw Errors.badRequest(`订单状态不符（当前：${ORDER_STATUS_NAME[order.status] || order.status}），仅待发货订单可发货`);
        }

        const trackingNo = String(row.trackingNo || '').trim();
        if (!trackingNo) throw Errors.badRequest('物流单号不能为空', { field: 'trackingNo' });
        if (trackingNo.length > 64) throw Errors.badRequest('物流单号长度不能超过 64 个字符', { field: 'trackingNo' });

        const company = logisticsCompanyName(row.company);
        if (!company) {
          throw Errors.badRequest('物流公司不在字典内，请从物流公司列表中选择', { field: 'company' });
        }

        const duplicated = get('SELECT id, order_id FROM logistics WHERE tracking_no = ?', trackingNo);
        if (duplicated) throw Errors.badRequest('物流单号已被使用（重复单号）', { field: 'trackingNo' });

        transaction(() => {
          const updated = run(
            'UPDATE orders SET status = 2, shipped_at = ?, updated_at = ? WHERE id = ? AND status = 1',
            now(), now(), order.id,
          );
          if (updated.changes === 0) throw Errors.badRequest('订单状态已变化，请刷新后重试');
          run(
            `INSERT INTO logistics (order_id, company, tracking_no, shipped_at, operator_id, operator_type, updated_at, created_at)
             VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)`,
            order.id, company, trackingNo, now(), ctx.admin.id, now(), now(),
          );
        });

        result.success = true;
        result.company = company;
        result.trackingNo = trackingNo;
        result.status = 2;
        result.statusName = ORDER_STATUS_NAME[2];
        successCount += 1;
      } catch (err) {
        failedCount += 1;
        result.reason = err.message || '发货失败';
      }
      results.push(result);
    });

    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '仓库', action: '批量发货', targetType: 'order_batch', targetId: `count:${list.length}`,
      detail: { total: list.length, successCount, failedCount },
      ip: ctx.ip,
    });

    return { total: list.length, successCount, failedCount, results };
  });

  /* ==================== API-128 库存流水查询 / 导出 ==================== */
  api.get('/api/admin/stocks/logs', { auth: 'admin', perm: 'menu.whs.stock' }, (ctx) => {
    const where = ['1 = 1'];
    const params = [];

    const skuId = toInt(ctx.query.skuId);
    if (skuId) { where.push('l.sku_id = ?'); params.push(skuId); }
    const productId = toInt(ctx.query.productId);
    if (productId) { where.push('l.product_id = ?'); params.push(productId); }
    const shopId = toInt(ctx.query.shopId);
    if (shopId) { where.push('l.shop_id = ?'); params.push(shopId); }

    const sourceRaw = String(ctx.query.source || '').trim();
    if (sourceRaw) {
      const sources = sourceRaw.split(',').map((s) => s.trim()).filter(Boolean);
      where.push(`l.source IN (${sources.map(() => '?').join(',')})`);
      params.push(...sources);
    }

    const operatorId = toInt(ctx.query.operatorId);
    if (operatorId) { where.push('l.operator_id = ?'); params.push(operatorId); }
    const operatorName = String(ctx.query.operatorName || '').trim();
    if (operatorName) { where.push('l.operator_name LIKE ?'); params.push(`%${operatorName}%`); }

    const refNo = String(ctx.query.refNo || '').trim();
    if (refNo) { where.push('l.ref_no LIKE ?'); params.push(`%${refNo}%`); }

    rangeFilter(ctx.query, where, params, 'l.created_at');

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const selectSql = `SELECT l.*, s.spec_name, s.barcode, p.name AS product_name, sh.name AS shop_name
        FROM stock_logs l
        LEFT JOIN skus s ON s.id = l.sku_id
        LEFT JOIN products p ON p.id = l.product_id
        LEFT JOIN shops sh ON sh.id = l.shop_id
        ${whereSql}`;

    const mapRow = (r) => ({
      id: r.id,
      skuId: r.sku_id,
      productId: r.product_id,
      productName: r.product_name || '',
      specName: r.spec_name || '',
      barcode: r.barcode || '',
      shopId: r.shop_id,
      shopName: r.shop_name || '',
      source: r.source,
      changeQty: r.change_qty,
      beforeQty: r.before_qty,
      afterQty: r.after_qty,
      lockedBefore: r.locked_before,
      lockedAfter: r.locked_after,
      refNo: r.ref_no || '',
      operatorId: r.operator_id,
      operatorName: r.operator_name || '',
      remark: r.remark || '',
      createdAt: r.created_at,
    });

    if (String(ctx.query.export || '').toLowerCase() === 'csv') {
      const rows = all(`${selectSql} ORDER BY l.created_at DESC, l.id DESC LIMIT 10000`, ...params);
      auditLog({
        adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
        module: '仓库', action: '库存流水导出', targetType: 'stock_log', targetId: `rows:${rows.length}`,
        detail: { rows: rows.length, filter: Object.keys(ctx.query).filter((k) => k !== 'export') },
        ip: ctx.ip,
      });
      const header = ['流水ID', 'SKU ID', '商品名称', '规格', '条码', '店铺', '来源', '变动数量',
        '变动前库存', '变动后库存', '变动前锁定', '变动后锁定', '关联单号', '操作人', '操作时间', '备注'];
      const body = rows.map((r) => {
        const m = mapRow(r);
        return [m.id, m.skuId, m.productName, m.specName, m.barcode, m.shopName, m.source, m.changeQty,
          m.beforeQty, m.afterQty, m.lockedBefore, m.lockedAfter, m.refNo, m.operatorName, m.createdAt, m.remark];
      });
      const filename = `stock-logs-${now().replace(/[-: ]/g, '')}.csv`;
      return sendRaw(ctx, 200, 'text/csv; charset=utf-8', csvBuffer(header, body), filename);
    }

    const { pageSize, offset } = pagination(ctx.query, { defaultSize: 20, maxSize: 50 });
    const total = get(`SELECT COUNT(*) AS c FROM stock_logs l ${whereSql}`, ...params).c;
    const orderBy = sortSql(ctx.query, LOG_SORTS, 'l.created_at DESC, l.id DESC');
    const rows = all(`${selectSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, ...params, pageSize, offset);
    return { total, rows: rows.map(mapRow) };
  });

  /* ---------------- 盘点实现（供 API-125 复用） ---------------- */
  function createStockTake(ctx) {
    const body = ctx.body || {};
    const shop = shopOf(body.shopId);
    const rawItems = Array.isArray(body.items) ? body.items : [];

    let skus;
    if (rawItems.length) {
      const seen = new Set();
      skus = [];
      for (const item of rawItems) {
        const skuId = toInt(item.skuId);
        if (!skuId) throw Errors.badRequest('请选择规格（skuId）', { field: 'skuId' });
        if (seen.has(skuId)) continue;
        seen.add(skuId);
        const sku = skuOf(skuId);
        if (sku.shop_id !== shop.id) {
          throw Errors.badRequest(`规格（SKU ${skuId}）不属于所选店铺`, { field: 'skuId' });
        }
        skus.push(sku);
      }
    } else {
      skus = all(
        `SELECT s.*, p.name AS product_name, p.shop_id FROM skus s JOIN products p ON p.id = s.product_id
          WHERE p.shop_id = ? AND p.is_deleted = 0 ORDER BY s.id ASC`,
        shop.id,
      );
    }
    if (!skus.length) throw Errors.badRequest('该店铺下没有可盘点的规格（SKU）');

    const scope = String(body.scope || '').trim() || (rawItems.length ? '指定SKU' : '全部');
    const takeNo = bizNo('ST');

    const takeId = transaction(() => {
      const id = run(
        `INSERT INTO stock_takes (take_no, shop_id, scope, status, operator_id, created_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
        takeNo, shop.id, scope.slice(0, 50), ctx.admin.id, now(),
      ).lastInsertRowid;
      for (const sku of skus) {
        // 账面快照：actual_qty 默认等于账面，录入实盘后覆盖（FR-WHS-008）
        run(
          `INSERT INTO stock_take_items (stock_take_id, sku_id, book_qty, actual_qty, diff_qty)
           VALUES (?, ?, ?, ?, 0)`,
          id, sku.id, sku.stock, sku.stock,
        );
      }
      return id;
    });

    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '仓库', action: '创建盘点单', targetType: 'stock_take', targetId: takeNo,
      detail: { takeNo, shopId: shop.id, shopName: shop.name, scope, itemCount: skus.length },
      ip: ctx.ip,
    });

    return stockTakeView(get('SELECT * FROM stock_takes WHERE id = ?', takeId));
  }

  function recordStockTake(ctx, takeId) {
    const body = ctx.body || {};
    const take = get('SELECT * FROM stock_takes WHERE id = ?', takeId);
    if (!take) throw Errors.notFound('盘点单不存在');
    if (take.status !== 0) {
      throw Errors.badRequest('盘点单已确认，不可修改，如需调整请重新发起盘点');
    }

    const items = Array.isArray(body.items) ? body.items : [];
    const confirm = isTrue(body.confirm);

    if (!items.length && !confirm) {
      throw Errors.badRequest('请录入实盘数量（items）或指定 confirm:true 确认盘点', { field: 'items' });
    }

    transaction(() => {
      for (const item of items) {
        const skuId = toInt(item.skuId);
        if (!skuId) throw Errors.badRequest('请选择规格（skuId）', { field: 'skuId' });
        const actualQty = Number(item.actualQty);
        if (!Number.isInteger(actualQty) || actualQty < 0) {
          throw Errors.badRequest('实盘数量必须为非负整数', { field: 'actualQty' });
        }
        const row = get('SELECT * FROM stock_take_items WHERE stock_take_id = ? AND sku_id = ?', take.id, skuId);
        if (!row) throw Errors.badRequest(`规格（SKU ${skuId}）不在该盘点单范围内`, { field: 'skuId' });
        run(
          'UPDATE stock_take_items SET actual_qty = ?, diff_qty = ? WHERE id = ?',
          actualQty, actualQty - row.book_qty, row.id,
        );
      }
      if (confirm) confirmStockTake(ctx, take);
    });

    auditLog({
      adminId: ctx.admin.id, adminName: ctx.admin.name, roleCode: ctx.auth.roleCode,
      module: '仓库', action: confirm ? '盘点确认' : '录入实盘',
      targetType: 'stock_take', targetId: take.take_no,
      detail: { takeNo: take.take_no, itemCount: items.length, confirm },
      ip: ctx.ip,
    });

    return stockTakeView(get('SELECT * FROM stock_takes WHERE id = ?', take.id));
  }

  function confirmStockTake(ctx, take) {
    const rows = all('SELECT * FROM stock_take_items WHERE stock_take_id = ? ORDER BY id ASC', take.id);
    let changed = 0;
    for (const row of rows) {
      const diffQty = row.actual_qty - row.book_qty;
      if (diffQty === 0) continue;
      // 盘盈 / 盘亏 一律走 stock-service，写入 stock_logs（FR-WHS-010）
      stockSvc.changeStock(row.sku_id, diffQty, {
        source: diffQty > 0 ? '盘盈' : '盘亏',
        refNo: take.take_no,
        operatorId: ctx.admin.id,
        operatorName: ctx.admin.name,
        remark: `盘点差异（${take.take_no}）`,
      });
      changed += 1;
    }
    run('UPDATE stock_takes SET status = 1, confirmed_at = ? WHERE id = ? AND status = 0', now(), take.id);
    take.changedCount = changed;
  }
};
