'use strict';

const { get, all, run, bizNo, verifyCode, parseJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, today, toYuan, toCents, parseTime, diffMinutes } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const config = require('../core/config');
const db = require('../core/db');

/**
 * 到店预约服务（8.12、Q-002、BR-STORE-001 ~ 006、TC-STORE-001 / 002、API-151 ~ 154）
 *
 * 履约口径（Q-002 / BR-STORE-001 / 003）：
 *  - 到店付款 + 预约制：线上只提交预约，**不产生在线支付单**（pay_method 保持 NULL，paid_amount = 0），
 *    不占用商品库存、不写 stock_log、不进入 settlement / 提现链路；
 *  - 收款与付款方式在门店核销（API-156）时登记，核销幂等；
 *  - 预约状态机：1 待到店 → 2 已核销 / 3 已取消 / 4 已过期（BR-STORE-004 / 005）。
 *
 * 可预约校验（BR-STORE-002 / 006、FR-SLR-025）：
 *  服务 status=1 → 门店属于服务适用门店且 status=1 → 时段在 booking_slots 内
 *  → 预约日期不早于今天、不晚于服务有效期 → 开始时刻晚于当前时间
 *  → 该门店该日期该时段 status=1 的预约数 < slot_capacity（约满拦截）。
 */

const STATUS = { 1: '待到店', 2: '已核销', 3: '已取消', 4: '已过期' };
const OPEN_STATUS = 1;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const PHONE_RE = /^1[3-9]\d{9}$/;
const MAX_PAGE_SIZE = 20;

function clampSize(pageSize, fallback = 20) {
  const n = Number(pageSize);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_PAGE_SIZE);
}

function dateOf(value) {
  return String(value || '').slice(0, 10);
}

/** 预约开始时刻：'YYYY-MM-DD HH:MM:SS' */
function bookingTimeOf(bookingDate, slot) {
  return `${bookingDate} ${String(slot).slice(0, 5)}:00`;
}

function cancelHours() {
  const n = config.getNumber('store_cancel_hours');
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

function capacityOf(service) {
  const own = Number(service?.slot_capacity);
  if (Number.isInteger(own) && own > 0) return own;
  const fallback = config.getNumber('store_slot_default_capacity');
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 10;
}

/** 预约单对外结构（含预约号、核销码、门店、服务、时段） */
function toApi(b, { mask = false } = {}) {
  const service = get('SELECT * FROM store_services WHERE id = ?', b.store_service_id);
  const store = get('SELECT * FROM stores WHERE id = ?', b.store_id);
  const shop = service ? get('SELECT id, name, logo, phone FROM shops WHERE id = ?', service.shop_id) : null;
  const hours = cancelHours();
  const remainMinutes = b.booking_time ? diffMinutes(now(), b.booking_time) : 0;
  const phone = mask ? maskPhone(b.phone) : b.phone;
  return {
    id: b.id,
    bookingNo: b.booking_no,
    verifyCode: b.verify_code,
    status: b.status,
    statusName: STATUS[b.status] || '未知',
    storeServiceId: b.store_service_id,
    storeId: b.store_id,
    bookingDate: b.booking_date,
    slot: b.slot,
    bookingTime: b.booking_time,
    contact: b.contact,
    phone,
    phoneMask: maskPhone(b.phone),
    remark: b.remark || '',
    payMethod: b.pay_method || null,
    payMethodName: '到店付款',
    paidAmount: toYuan(b.paid_amount || 0),
    cancelDeadlineHours: hours,
    canCancel: b.status === OPEN_STATUS && remainMinutes >= hours * 60,
    verifiedAt: b.verified_at,
    canceledAt: b.canceled_at,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    service: service ? {
      id: service.id,
      name: service.name,
      image: service.image,
      originPrice: toYuan(service.origin_price),
      storePrice: toYuan(service.store_price),
      validStart: service.valid_start,
      validEnd: service.valid_end,
      description: service.description,
      bookingSlots: parseJson(service.booking_slots, []) || [],
      slotCapacity: capacityOf(service),
    } : null,
    store: store ? {
      id: store.id,
      name: store.name,
      phone: store.phone,
      address: store.address,
      businessHours: store.business_hours,
      lng: store.lng,
      lat: store.lat,
      image: store.image,
      status: store.status,
    } : null,
    shop: shop ? { id: shop.id, name: shop.name, logo: shop.logo, phone: shop.phone } : null,
  };
}

/** 把开始时刻已过的「待到店」单子标记为「已过期」（BR-STORE-004，可按用户过滤） */
function expireOverdue(userId = null) {
  const sql = `UPDATE store_bookings SET status = 4, updated_at = ? WHERE status = 1 AND booking_time < ?${userId ? ' AND user_id = ?' : ''}`;
  const args = userId ? [now(), now(), userId] : [now(), now()];
  return run(sql, ...args).changes;
}

/** 创建预约（API-151） */
function create(userId, payload = {}) {
  // ---- 1. 服务校验：存在、已通过审核、在有效期内 ----
  const serviceId = Number(payload.serviceId);
  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    throw Errors.badRequest('请选择到店服务', { field: 'serviceId' });
  }
  const service = get('SELECT * FROM store_services WHERE id = ?', serviceId);
  if (!service) throw Errors.notFound('到店服务不存在');
  if (service.status !== 1) throw Errors.badRequest('该到店服务未通过审核或已下线，暂不可预约');
  const todayStr = today();
  const validStart = dateOf(service.valid_start);
  const validEnd = dateOf(service.valid_end);
  if (validEnd && validEnd < todayStr) throw Errors.badRequest('该到店服务已过有效期');
  if (validStart && validStart > todayStr) throw Errors.badRequest('该到店服务尚未生效');

  // ---- 2. 门店校验：存在、属于服务适用门店、门店启用（BR-STORE-006）----
  const storeId = Number(payload.storeId);
  if (!Number.isInteger(storeId) || storeId <= 0) {
    throw Errors.badRequest('请选择预约门店', { field: 'storeId' });
  }
  const store = get('SELECT * FROM stores WHERE id = ?', storeId);
  if (!store) throw Errors.notFound('门店不存在');
  const linked = get(
    'SELECT 1 AS ok FROM store_service_stores WHERE store_service_id = ? AND store_id = ?',
    serviceId, storeId,
  );
  if (!linked) throw Errors.badRequest('该到店服务不适用于所选门店');
  if (store.status !== 1) throw Errors.badRequest('该门店已停用，暂不接受预约');

  // ---- 3. 预约日期校验：格式、不早于今天、在服务有效期区间内 ----
  const bookingDate = String(payload.bookingDate || '').trim();
  if (!DATE_RE.test(bookingDate)) {
    throw Errors.badRequest('预约日期格式应为 YYYY-MM-DD', { field: 'bookingDate' });
  }
  if (bookingDate < todayStr) throw Errors.badRequest('预约日期不得早于今天', { field: 'bookingDate' });
  if (validStart && bookingDate < validStart) throw Errors.badRequest('预约日期不得早于服务生效日期', { field: 'bookingDate' });
  if (validEnd && bookingDate > validEnd) throw Errors.badRequest('预约日期不得晚于服务有效期', { field: 'bookingDate' });

  // ---- 4. 时段校验：必须在服务配置的可预约时段内（FR-SLR-025）----
  const slot = String(payload.slot || '').trim();
  if (!slot) throw Errors.badRequest('请选择预约时段', { field: 'slot' });
  if (!SLOT_RE.test(slot)) throw Errors.badRequest('预约时段格式应为 HH:MM-HH:MM', { field: 'slot' });
  const slots = parseJson(service.booking_slots, []) || [];
  if (!slots.includes(slot)) throw Errors.badRequest('预约时段不在该服务可预约范围内', { field: 'slot' });

  // ---- 5. 开始时刻必须晚于当前时间 ----
  const bookingTime = bookingTimeOf(bookingDate, slot);
  if (!(parseTime(bookingTime) > new Date())) {
    throw Errors.badRequest('该预约时段已开始，请选择其他时段', { field: 'slot' });
  }

  // ---- 6. 联系人与手机号 ----
  const contact = String(payload.contact || '').trim();
  if (contact.length < 2 || contact.length > 20) {
    throw Errors.badRequest('联系人需为 2-20 个字符', { field: 'contact' });
  }
  const phone = String(payload.phone || '').trim();
  if (!PHONE_RE.test(phone)) throw Errors.badRequest('手机号格式不正确', { field: 'phone' });
  const remark = payload.remark ? String(payload.remark).trim().slice(0, 200) : null;

  // ---- 7. 容量校验 + 生成全局唯一预约号 / 8 位核销码（事务内复查，防并发超约）----
  const capacity = capacityOf(service);
  const bookedBefore = get(
    `SELECT COUNT(*) AS c FROM store_bookings
      WHERE store_id = ? AND booking_date = ? AND slot = ? AND status = 1`,
    storeId, bookingDate, slot,
  ).c;
  if (bookedBefore >= capacity) throw Errors.badRequest('该时段已约满，请选择其他时段');

  const id = db.transaction(() => {
    const booked = get(
      `SELECT COUNT(*) AS c FROM store_bookings
        WHERE store_id = ? AND booking_date = ? AND slot = ? AND status = 1`,
      storeId, bookingDate, slot,
    ).c;
    if (booked >= capacity) throw Errors.badRequest('该时段已约满，请选择其他时段');

    let bookingNo = null;
    let code = null;
    for (let attempt = 0; attempt < 20 && !bookingNo; attempt += 1) {
      const no = bizNo('BK');
      const vc = verifyCode();
      const clash = get('SELECT id FROM store_bookings WHERE booking_no = ? OR verify_code = ?', no, vc);
      if (!clash) { bookingNo = no; code = vc; }
    }
    if (!bookingNo || !code) throw Errors.internal('预约号生成失败，请稍后重试');

    return run(
      `INSERT INTO store_bookings (booking_no, store_service_id, store_id, user_id, booking_date, slot, booking_time,
         contact, phone, remark, verify_code, status, pay_method, paid_amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 0, ?, ?)`,
      bookingNo, serviceId, storeId, userId, bookingDate, slot, bookingTime,
      contact, phone, remark, code, now(), now(),
    ).lastInsertRowid;
  });

  return toApi(get('SELECT * FROM store_bookings WHERE id = ?', id));
}

/** 我的预约列表（API-152）：先按当前时间刷新过期状态，再按创建时间倒序分页 */
function listMine(userId, { status, page = 1, pageSize = 20 } = {}) {
  expireOverdue(userId);
  const size = clampSize(pageSize);
  const current = Number.isInteger(Number(page)) && Number(page) >= 1 ? Number(page) : 1;
  const offset = (current - 1) * size;
  const params = [userId];
  let where = 'WHERE b.user_id = ?';
  const raw = status === undefined || status === null ? '' : String(status).trim();
  if (raw && raw !== 'all') {
    const st = Number(raw);
    if (Number.isInteger(st) && STATUS[st]) { where += ' AND b.status = ?'; params.push(st); }
  }
  const total = get(`SELECT COUNT(*) AS c FROM store_bookings b ${where}`, ...params).c;
  const rows = all(
    `SELECT b.* FROM store_bookings b ${where} ORDER BY b.created_at DESC, b.id DESC LIMIT ? OFFSET ?`,
    ...params, size, offset,
  );
  return { total, rows: rows.map((b) => toApi(b)), page: current, pageSize: size };
}

/** 预约详情（API-153）：非本人一律 404，避免越权探测 */
function detail(userId, id) {
  expireOverdue(userId);
  const b = get('SELECT * FROM store_bookings WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!b) throw Errors.notFound('预约不存在');
  return toApi(b);
}

/** 取消预约（API-154）：仅「待到店」且在开始前 store_cancel_hours 小时之外可取消 */
function cancel(userId, id) {
  expireOverdue(userId);
  const b = get('SELECT * FROM store_bookings WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!b) throw Errors.notFound('预约不存在');
  if (b.status === 2) throw Errors.badRequest('预约已核销，不可取消');
  if (b.status === 3) throw Errors.badRequest('预约已取消，请勿重复操作');
  if (b.status === 4) throw Errors.badRequest('预约已过期，不可取消');
  if (b.status !== OPEN_STATUS) throw Errors.badRequest('当前预约状态不可取消');
  const hours = cancelHours();
  const remainMinutes = diffMinutes(now(), b.booking_time);
  if (remainMinutes < hours * 60) throw Errors.badRequest('已超过可取消时间');
  const res = run(
    'UPDATE store_bookings SET status = 3, canceled_at = ?, updated_at = ? WHERE id = ? AND status = 1',
    now(), now(), b.id,
  );
  if (res.changes === 0) throw Errors.badRequest('当前预约状态不可取消');
  return toApi(get('SELECT * FROM store_bookings WHERE id = ?', b.id));
}

/**
 * 商家端预约列表（API-155 能力导出，路由由商家端模块注册）：
 * 商家数据按 shop_id 隔离，联系人手机号脱敏（12.4 / NFR-SEC-008）。
 */
function listForSeller(shopId, { status, storeId, date, page = 1, pageSize = 20 } = {}) {
  const size = clampSize(pageSize);
  const current = Number.isInteger(Number(page)) && Number(page) >= 1 ? Number(page) : 1;
  const params = [shopId];
  let where = 'WHERE s.shop_id = ?';
  const st = status === undefined || status === null || status === '' ? null : Number(status);
  if (st !== null && STATUS[st]) { where += ' AND b.status = ?'; params.push(st); }
  if (storeId) { where += ' AND b.store_id = ?'; params.push(Number(storeId)); }
  if (date) { where += ' AND b.booking_date = ?'; params.push(String(date).slice(0, 10)); }
  const total = get(
    `SELECT COUNT(*) AS c FROM store_bookings b JOIN store_services s ON s.id = b.store_service_id ${where}`,
    ...params,
  ).c;
  const rows = all(
    `SELECT b.* FROM store_bookings b JOIN store_services s ON s.id = b.store_service_id
      ${where} ORDER BY b.booking_time DESC, b.id DESC LIMIT ? OFFSET ?`,
    ...params, size, (current - 1) * size,
  );
  return { total, rows: rows.map((b) => toApi(b, { mask: true })), page: current, pageSize: size };
}

/**
 * 核销（API-156 能力导出，商家端路由由他人注册；FR-SLR-026 / BR-STORE-005）
 * 规则：核销码须属于本店；重复核销被拒绝（幂等）；必须登记收款金额（付款方式=到店付款）。
 */
function verify(shopId, payload = {}, operator = {}) {
  const code = String(payload.verifyCode || '').trim();
  const bookingId = payload.bookingId ? Number(payload.bookingId) : null;
  if (!code && !bookingId) throw Errors.badRequest('请提供核销码', { field: 'verifyCode' });
  const b = code
    ? get(`SELECT b.* FROM store_bookings b JOIN store_services s ON s.id = b.store_service_id
            WHERE b.verify_code = ? AND s.shop_id = ?`, code, shopId)
    : get(`SELECT b.* FROM store_bookings b JOIN store_services s ON s.id = b.store_service_id
            WHERE b.id = ? AND s.shop_id = ?`, bookingId, shopId);
  if (!b) throw Errors.notFound('预约单不存在');
  if (b.status === 2) throw Errors.badRequest('该预约已核销，请勿重复核销');
  if (b.status === 3) throw Errors.badRequest('该预约已取消，不可核销');
  if (b.status === 4) throw Errors.badRequest('该预约已过期，不可核销');
  if (b.status !== OPEN_STATUS) throw Errors.badRequest('当前预约状态不可核销');
  const amount = toCents(payload.paidAmount);
  if (amount === null || Number.isNaN(amount) || amount < 0) {
    throw Errors.badRequest('请填写收款金额', { field: 'paidAmount' });
  }
  const payMethod = payload.payMethod ? String(payload.payMethod).trim() : '到店付款';
  const service = get('SELECT * FROM store_services WHERE id = ?', b.store_service_id);
  const operatorId = operator.id || null;

  db.transaction(() => {
    const res = run(
      `UPDATE store_bookings SET status = 2, paid_amount = ?, pay_method = ?, verified_by = ?,
         verified_at = ?, updated_at = ? WHERE id = ? AND status = 1`,
      amount, payMethod, operatorId, now(), now(), b.id,
    );
    if (res.changes === 0) throw Errors.badRequest('该预约已核销，请勿重复核销');
    run(
      `INSERT INTO store_verifications (booking_id, verify_code, store_id, shop_id, verified_by,
         paid_amount, pay_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      b.id, b.verify_code, b.store_id, service.shop_id, operatorId || 0, amount, payMethod, now(),
    );
  });

  return toApi(get('SELECT * FROM store_bookings WHERE id = ?', b.id));
}

module.exports = {
  STATUS, toApi, expireOverdue, create, listMine, detail, cancel,
  listForSeller, verify, bookingTimeOf,
};
