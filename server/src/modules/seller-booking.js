'use strict';

const db = require('../core/db');
const { get, all, run } = db;
const { Errors } = require('../core/errors');
const { now, toYuan, toCents } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const S = require('../services/seller-service');

/**
 * 商家端 · 预约单列表与核销
 * API-155 / API-156（FR-SLR-026、8.12、Q-002、BR-STORE-001 / 003 / 005）
 *
 * 到店履约「到店付款 + 预约制」：核销只登记收款金额与付款方式，
 * 不占用商品库存、不写 stock_log、不产生 payment / settlement 记录（BR-STORE-003）。
 */

const BOOKING_STATUS = { 1: '待到店', 2: '已核销', 3: '已取消', 4: '已过期' };
const PAY_METHOD = '到店付款';

function bookingQuery() {
  return `SELECT b.*, ss.name AS service_name, ss.store_price, ss.shop_id, st.name AS store_name,
                 st.address AS store_address
            FROM store_bookings b
            JOIN store_services ss ON ss.id = b.store_service_id
            JOIN stores st ON st.id = b.store_id`;
}

function ownBooking(shopId, id) {
  const row = get(`${bookingQuery()} WHERE b.id = ? AND ss.shop_id = ?`, Number(id), shopId);
  if (!row) throw Errors.notFound('预约不存在');
  return row;
}

function toBookingApi(row, { withVerify = false } = {}) {
  const base = {
    id: row.id,
    bookingNo: row.booking_no,
    verifyCode: row.verify_code,
    serviceId: row.store_service_id,
    serviceName: row.service_name,
    storeId: row.store_id,
    storeName: row.store_name,
    storeAddress: row.store_address,
    bookingDate: row.booking_date,
    slot: row.slot,
    bookingTime: row.booking_time,
    contact: row.contact,
    phoneMask: maskPhone(row.phone),
    remark: row.remark,
    status: row.status,
    statusName: BOOKING_STATUS[row.status] || '未知',
    payMethod: row.pay_method || PAY_METHOD,
    paidAmount: toYuan(row.paid_amount || 0),
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    canceledAt: row.canceled_at,
    createdAt: row.created_at,
  };
  if (withVerify) {
    base.verifications = all('SELECT * FROM store_verifications WHERE booking_id = ? ORDER BY id DESC', row.id)
      .map((r) => ({
        id: r.id,
        verifyCode: r.verify_code,
        storeId: r.store_id,
        verifiedBy: r.verified_by,
        paidAmount: toYuan(r.paid_amount),
        payMethod: r.pay_method,
        createdAt: r.created_at,
      }));
  }
  return base;
}

/** API-155 预约单列表（按日期 / 门店 / 状态筛选） */
function bookingList(ctx) {
  const shop = S.shopOf(ctx);
  const { page, pageSize, offset } = S.pageOf(ctx);
  const where = ['ss.shop_id = ?'];
  const params = [shop.id];

  const date = String(ctx.query.date || ctx.query.bookingDate || '').trim();
  if (date) { where.push('b.booking_date = ?'); params.push(date.slice(0, 10)); }
  if (ctx.query.dateStart) { where.push('b.booking_date >= ?'); params.push(String(ctx.query.dateStart).slice(0, 10)); }
  if (ctx.query.dateEnd) { where.push('b.booking_date <= ?'); params.push(String(ctx.query.dateEnd).slice(0, 10)); }
  if (ctx.query.storeId) {
    const sid = Number(ctx.query.storeId);
    if (Number.isInteger(sid) && sid > 0) { where.push('b.store_id = ?'); params.push(sid); }
  }
  if (ctx.query.status !== undefined && ctx.query.status !== '') {
    where.push('b.status = ?'); params.push(Number(ctx.query.status));
  }
  if (ctx.query.serviceId) {
    const sid = Number(ctx.query.serviceId);
    if (Number.isInteger(sid) && sid > 0) { where.push('b.store_service_id = ?'); params.push(sid); }
  }
  const keyword = String(ctx.query.keyword || ctx.query.bookingNo || '').trim();
  if (keyword) {
    where.push('(b.booking_no LIKE ? OR b.verify_code LIKE ? OR b.contact LIKE ? OR b.phone LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const from = bookingQuery();
  const total = get(`SELECT COUNT(*) AS c FROM (${from} ${whereSql}) t`, ...params).c;
  const rows = all(`${from} ${whereSql} ORDER BY b.booking_date DESC, b.slot ASC, b.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset);
  const counts = {
    pending: get(
      `SELECT COUNT(*) AS c FROM store_bookings b JOIN store_services ss ON ss.id = b.store_service_id
        WHERE ss.shop_id = ? AND b.status = 1`, shop.id,
    ).c,
    verified: get(
      `SELECT COUNT(*) AS c FROM store_bookings b JOIN store_services ss ON ss.id = b.store_service_id
        WHERE ss.shop_id = ? AND b.status = 2`, shop.id,
    ).c,
  };
  return S.listResult(rows.map((r) => toBookingApi(r)), total, { page, pageSize, counts });
}

/** API-156 预约核销（幂等：重复核销被拒绝） */
function bookingVerify(ctx) {
  const shop = S.activeShop(ctx);
  const row = ownBooking(shop.id, ctx.params.id);
  if (row.status === 2) throw Errors.badRequest('该预约已核销');
  if (row.status === 3) throw Errors.badRequest('该预约已取消，不可核销');
  if (row.status === 4) throw Errors.badRequest('该预约已过期，不可核销');
  if (row.status !== 1) throw Errors.badRequest('当前预约状态不可核销');

  const body = ctx.body || {};
  const cents = toCents(body.paidAmount);
  if (cents === null || Number.isNaN(cents) || !Number.isInteger(cents) || cents <= 0) {
    throw Errors.badRequest('请登记到店收款金额', { field: 'paidAmount' });
  }
  const requiredMethod = String(body.payMethod || PAY_METHOD).trim();
  if (requiredMethod !== PAY_METHOD) {
    throw Errors.badRequest(`付款方式固定为「${PAY_METHOD}」`, { field: 'payMethod' });
  }

  const verifyId = db.transaction(() => {
    const fresh = get('SELECT * FROM store_bookings WHERE id = ?', row.id);
    if (fresh.status !== 1) {
      throw Errors.badRequest(fresh.status === 2 ? '该预约已核销' : '当前预约状态不可核销');
    }
    const id = run(
      `INSERT INTO store_verifications (booking_id, verify_code, store_id, shop_id, verified_by, paid_amount, pay_method, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      fresh.id, fresh.verify_code, fresh.store_id, shop.id, ctx.admin.id, cents, PAY_METHOD, now(),
    ).lastInsertRowid;
    const updated = run(
      `UPDATE store_bookings SET status = 2, paid_amount = ?, pay_method = ?, verified_by = ?, verified_at = ?, updated_at = ?
        WHERE id = ? AND status = 1`,
      cents, PAY_METHOD, ctx.admin.id, now(), now(), fresh.id,
    );
    if (updated.changes === 0) throw Errors.badRequest('该预约已核销');
    return id;
  });

  S.audit(ctx, '门店', '预约核销', 'store_booking', row.id,
    `${row.booking_no}；核销码 ${row.verify_code}；收款 ${toYuan(cents)} 元；付款方式 ${PAY_METHOD}`);

  const fresh = ownBooking(shop.id, row.id);
  return {
    ...toBookingApi(fresh, { withVerify: true }),
    verifyId,
    tip: '核销成功，已登记到店收款金额',
    inventoryTouched: false,
  };
}

module.exports = function register(api) {
  api.get('/api/seller/bookings', { auth: 'seller' }, bookingList);
  api.post('/api/seller/bookings/:id/verify', { auth: 'seller' }, bookingVerify);
};
