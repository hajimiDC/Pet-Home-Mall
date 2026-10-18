'use strict';

const { get, all, pagination, parseJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, today, parseTime } = require('../core/money');
const config = require('../core/config');
const { pageInfoOf } = require('../services/catalog-service');

/**
 * C 端门店 / 到店服务浏览（API-022、API-023）
 * 覆盖：8.10 地图搜店（就近门店 + Haversine 距离 + 无定位回退默认城市）、8.12 到店（本地服务列表）
 *
 * 边界：到店服务不进入商品 / 库存 / 结算链路（BR-STORE-003），本模块只读，
 * 不写 stock_logs、不生成订单、不参与 settlement。
 */

const EARTH_RADIUS_KM = 6371;

/** Haversine 距离（km） */
function haversine(lng1, lat1, lng2, lat2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function coordParams(lngRaw, latRaw) {
  const hasLng = lngRaw !== undefined && lngRaw !== null && String(lngRaw).trim() !== '';
  const hasLat = latRaw !== undefined && latRaw !== null && String(latRaw).trim() !== '';
  if (!hasLng && !hasLat) return { hasCoords: false, lng: null, lat: null };
  if (!hasLng || !hasLat) throw Errors.badRequest('定位参数不完整，请同时提供 lng 与 lat', { field: 'lng' });
  const lng = Number(lngRaw);
  const lat = Number(latRaw);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw Errors.badRequest('经度参数不合法（-180 ~ 180）', { field: 'lng' });
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw Errors.badRequest('纬度参数不合法（-90 ~ 90）', { field: 'lat' });
  }
  return { hasCoords: true, lng, lat };
}

function distanceOf(store, coords) {
  if (!coords.hasCoords || store.lng === null || store.lat === null) return null;
  const km = haversine(coords.lng, coords.lat, Number(store.lng), Number(store.lat));
  return Number(km.toFixed(1));
}

function toStoreRow(store, coords) {
  const distance = distanceOf(store, coords);
  return {
    id: store.id,
    name: store.name,
    phone: store.phone,
    address: store.address,
    lng: store.lng,
    lat: store.lat,
    businessHours: store.business_hours,
    image: store.image,
    status: store.status,
    statusName: store.status === 1 ? '营业中' : '已停用',
    distance,
    distanceText: distance === null ? null : `${distance} km`,
    shop: {
      id: store.shop_id,
      name: store.shop_name,
      logo: store.shop_logo,
      phone: store.shop_phone,
      score: Number((Number(store.shop_score || 0) / 10).toFixed(1)),
      url: `/shops/${store.shop_id}`,
    },
    url: `/shops/${store.shop_id}`,
  };
}

/** API-022 附近门店（地图搜店，FR-MAP-001 ~ 006） */
function nearbyStores(query = {}) {
  const { hasCoords, lng, lat } = coordParams(query.lng ?? query.lon, query.lat);
  const coords = { hasCoords, lng, lat };
  const { page, pageSize } = pagination(query, { defaultSize: 20, maxSize: 20 });

  const conditions = ['st.status = 1', 's.status = 1'];
  const params = [];
  const keyword = String(query.keyword ?? '').trim();
  if (keyword) {
    if (keyword.length > 50) throw Errors.badRequest('关键字长度不能超过 50 个字符', { field: 'keyword' });
    conditions.push('(st.name LIKE ? OR st.address LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const rows = all(
    `SELECT st.*, s.name AS shop_name, s.logo AS shop_logo, s.phone AS shop_phone, s.score AS shop_score
       FROM stores st JOIN shops s ON s.id = st.shop_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY st.id ASC LIMIT 500`,
    ...params,
  ).map((row) => toStoreRow(row, coords));

  let list = rows;
  let defaultCity = false;
  let city = null;
  if (hasCoords) {
    list = rows
      .filter((row) => row.distance !== null)
      .sort((a, b) => a.distance - b.distance || a.id - b.id);
  } else {
    // 无定位 → 默认城市视图（FR-MAP-006 / NFR-SEC-006：定位不持久化）
    defaultCity = true;
    city = config.getString('default_city') || '上海';
    const inCity = rows.filter((row) => String(row.address || '').includes(city));
    list = inCity.length ? inCity : rows;
  }

  const total = list.length;
  const pageRows = list.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  return {
    total,
    rows: pageRows,
    defaultCity,
    city,
    center: hasCoords ? { lng, lat } : null,
    pageInfo: pageInfoOf(total, page, pageSize),
  };
}

/** 可预约时段：按门店 + 日期统计已预约人数，剩余 > 0 才可选（BR-STORE-002、FR-SLR-025） */
function slotsOfService(service, storeId, date) {
  const slots = parseJson(service.booking_slots, []) || [];
  const capacity = Number(service.slot_capacity || 0);
  const bookedRows = all(
    `SELECT slot, COUNT(*) AS c FROM store_bookings
      WHERE store_service_id = ? AND store_id = ? AND booking_date = ? AND status = 1
      GROUP BY slot`,
    service.id, storeId, date,
  );
  const bookedMap = new Map(bookedRows.map((r) => [r.slot, Number(r.c || 0)]));
  return slots.map((slot) => {
    const booked = bookedMap.get(slot) || 0;
    const remaining = Math.max(0, capacity - booked);
    return {
      slot,
      capacity,
      booked,
      remaining,
      available: remaining > 0,
      disabled: remaining <= 0,
    };
  });
}

/** API-023 到店服务列表（8.12，到店付款 + 预约制，不进入交易链路） */
function storeServices(query = {}) {
  const { hasCoords, lng, lat } = coordParams(query.lng ?? query.lon, query.lat);
  const coords = { hasCoords, lng, lat };
  const { page, pageSize } = pagination(query, { defaultSize: 20, maxSize: 20 });
  const at = now();

  let date = String(query.date ?? '').trim();
  if (!date) date = today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Errors.badRequest('预约日期格式不正确，应为 YYYY-MM-DD', { field: 'date' });
  }

  const conditions = [
    'sv.status = 1',
    'sv.valid_start <= ?',
    'sv.valid_end >= ?',
    's.status = 1',
  ];
  const params = [at, at];

  const storeRaw = query.storeId ?? query.store_id;
  if (storeRaw !== undefined && storeRaw !== null && String(storeRaw).trim() !== '') {
    const storeId = Number(storeRaw);
    if (!Number.isInteger(storeId) || storeId <= 0) {
      throw Errors.badRequest('门店参数不合法', { field: 'storeId' });
    }
    conditions.push('EXISTS (SELECT 1 FROM store_service_stores ss WHERE ss.store_service_id = sv.id AND ss.store_id = ?)');
    params.push(storeId);
  }

  const keyword = String(query.keyword ?? '').trim();
  if (keyword) {
    if (keyword.length > 50) throw Errors.badRequest('关键字长度不能超过 50 个字符', { field: 'keyword' });
    conditions.push('(sv.name LIKE ? OR sv.description LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const whereSql = `WHERE ${conditions.join(' AND ')}`;
  const from = 'FROM store_services sv JOIN shops s ON s.id = sv.shop_id';
  const total = get(`SELECT COUNT(*) AS c ${from} ${whereSql}`, ...params).c;
  const rows = all(
    `SELECT sv.*, s.name AS shop_name, s.logo AS shop_logo, s.phone AS shop_phone, s.score AS shop_score
       ${from} ${whereSql} ORDER BY sv.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize,
  );

  const mapped = rows.map((service) => {
    const storeRows = all(
      `SELECT st.*, s.name AS shop_name, s.logo AS shop_logo, s.phone AS shop_phone, s.score AS shop_score
         FROM store_service_stores ss
         JOIN stores st ON st.id = ss.store_id
         JOIN shops s ON s.id = st.shop_id
        WHERE ss.store_service_id = ? AND st.status = 1 AND s.status = 1
        ORDER BY st.id ASC`,
      service.id,
    );
    const stores = storeRows.map((store) => {
      const row = toStoreRow(store, coords);
      return { ...row, slots: slotsOfService(service, store.id, date) };
    });
    const slots = [];
    for (const store of stores) {
      for (const slot of store.slots) {
        slots.push({
          storeId: store.id,
          storeName: store.name,
          distance: store.distance,
          ...slot,
        });
      }
    }
    const originPrice = Number(service.origin_price || 0);
    const storePrice = Number(service.store_price || 0);
    return {
      id: service.id,
      shopId: service.shop_id,
      shopName: service.shop_name,
      name: service.name,
      image: service.image,
      originPrice: toYuan(originPrice),
      storePrice: toYuan(storePrice),
      price: toYuan(storePrice),
      discount: toYuan(Math.max(0, originPrice - storePrice)),
      validStart: service.valid_start,
      validEnd: service.valid_end,
      validEnded: parseTime(service.valid_end) < parseTime(at),
      description: service.description,
      bookingSlots: parseJson(service.booking_slots, []) || [],
      slotCapacity: Number(service.slot_capacity || 0),
      date,
      stores,
      slots,
      bookingRequired: true,
      payMethod: '到店付款',
      inCart: false,
      note: '到店服务为预约制、到店付款，不进入购物车 / 结算 / 支付链路',
      url: `/stores/services/${service.id}`,
    };
  });

  return {
    total,
    rows: mapped,
    date,
    pageInfo: pageInfoOf(total, page, pageSize),
  };
}

module.exports = function register(api) {
  // API-023 到店服务列表（先注册更具体路径，避免与 /api/stores 混淆）
  api.get('/api/stores/services', {}, (ctx) => storeServices(ctx.query));

  // API-022 附近门店（地图搜店）
  api.get('/api/stores', {}, (ctx) => nearbyStores(ctx.query));
};

module.exports.nearbyStores = nearbyStores;
module.exports.storeServices = storeServices;
