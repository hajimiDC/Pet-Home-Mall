'use strict';

const { get, all, run } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, parseTime } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const v = require('../core/validate');
const config = require('../core/config');
const S = require('../services/seller-service');

/**
 * 商家端 · 入驻申请 / 店铺管理 / 门店与到店服务
 * API-050 ~ API-060（FR-SLR-001 ~ 007、010 ~ 014、020 ~ 026、9.3.1 ~ 9.3.3）
 */

const SUBJECT_TYPES = ['个人', '企业'];
const SLOT_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const HOURS_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const PHONE_OR_TEL_RE = /^(1[3-9]\d{9}|0\d{2,3}-?\d{7,8})$/;

const APPLY_STATUS = { 0: '待审核', 1: '审核通过', 2: '审核驳回' };
const STORE_SERVICE_STATUS = { 0: '待审核', 1: '已通过', 2: '已驳回', 3: '已下线' };

function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/** 营业时间 → 区间列表，如 '09:00-12:00,13:30-21:00' */
function hoursRanges(text) {
  return String(text || '')
    .split(/[,，;；]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((item) => {
      const m = HOURS_RE.exec(item);
      if (!m) return null;
      return { start: minutesOf(`${m[1]}:${m[2]}`), end: minutesOf(`${m[3]}:${m[4]}`) };
    })
    .filter(Boolean);
}

function slotRange(slot) {
  const m = SLOT_RE.exec(String(slot || '').trim());
  if (!m) return null;
  const start = minutesOf(`${m[1]}:${m[2]}`);
  const end = minutesOf(`${m[3]}:${m[4]}`);
  if (end <= start) return null;
  return { start, end };
}

function inRanges(ranges, slot) {
  return ranges.some((r) => slot.start >= r.start && slot.end <= r.end);
}

/* ============================ 入驻申请 ============================ */

function toApplyApi(row) {
  const cats = S.parseJson(row.category_ids, []) || [];
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectName: row.subject_name,
    contact: row.contact,
    phone: row.phone,
    phoneMask: maskPhone(row.phone),
    licenseUrls: S.parseJson(row.license_urls, []) || [],
    categoryIds: cats,
    shopName: row.shop_name,
    status: row.status,
    statusName: APPLY_STATUS[row.status] || '未知',
    rejectReason: row.reject_reason,
    submittedAt: row.created_at,
    auditedAt: row.audited_at,
    canResubmit: row.status === 2,
    canEdit: row.status === 2,
  };
}

/** 按手机号解析 C 端会员（BR-SLR-001：入驻申请与会员账号绑定） */
function resolveApplicantUser(phone) {
  return get('SELECT id, username, nickname, phone FROM users WHERE phone = ?', phone);
}

function parseApplyPayload(body) {
  v.requireFields(body, ['subjectType', 'subjectName', 'contact', 'phone', 'licenseUrls', 'categoryIds', 'shopName']);
  const subjectType = String(body.subjectType || '').trim();
  if (!SUBJECT_TYPES.includes(subjectType)) {
    throw Errors.badRequest('主体类型仅支持「个人」或「企业」', { field: 'subjectType' });
  }
  const subjectName = v.str(body.subjectName, 'subjectName', { min: 2, max: 60 });
  const contact = v.str(body.contact, 'contact', { min: 2, max: 20 });
  const phone = v.phone(body.phone);
  const licenseUrls = S.strArray(body.licenseUrls, 5);
  if (!licenseUrls.length) throw Errors.badRequest('请上传营业执照或身份证照片', { field: 'licenseUrls' });
  for (const url of licenseUrls) {
    if (!/\.(jpe?g|png)(\?.*)?$/i.test(url) && !/^https?:\/\//i.test(url)) {
      throw Errors.badRequest('资质图片仅支持 JPG / PNG 格式', { field: 'licenseUrls' });
    }
  }
  const categoryIds = S.asArray(body.categoryIds).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  if (!categoryIds.length) throw Errors.badRequest('请选择经营类目', { field: 'categoryIds' });
  for (const cid of categoryIds) {
    const cat = get('SELECT id, status FROM categories WHERE id = ?', cid);
    if (!cat) throw Errors.badRequest('经营类目不存在', { field: 'categoryIds' });
    if (cat.status !== 1) throw Errors.badRequest('所选经营类目已停用，请重新选择', { field: 'categoryIds' });
  }
  const shopName = v.str(body.shopName, 'shopName', { min: 2, max: 30 });
  S.assertNoBlockWord(shopName, 'shopName');
  const dupShop = get('SELECT id FROM shops WHERE name = ?', shopName);
  if (dupShop) throw Errors.badRequest('店铺名称已被占用，请更换', { field: 'shopName' });
  return { subjectType, subjectName, contact, phone, licenseUrls, categoryIds, shopName };
}

/** API-050 提交入驻申请 */
function applySubmit(ctx) {
  const body = ctx.body || {};
  const payload = parseApplyPayload(body);

  // 已开通店铺 → 不允许再次提交（BR-SLR-001：一个会员账号仅可申请 1 家店铺）
  if (ctx.admin.shop_id) {
    const shop = get('SELECT * FROM shops WHERE id = ?', ctx.admin.shop_id);
    if (shop) throw Errors.badRequest('店铺已开通');
  }

  const owner = resolveApplicantUser(payload.phone);
  if (!owner) {
    throw Errors.badRequest('该手机号未注册会员账号，请先使用该手机号注册会员后再提交入驻申请', { field: 'phone' });
  }

  const mine = get('SELECT * FROM shop_applies WHERE user_id = ? ORDER BY id DESC LIMIT 1', owner.id);
  if (mine && mine.status === 0) throw Errors.badRequest('该主体已提交申请');
  if (mine && mine.status === 1) throw Errors.badRequest('店铺已开通');

  const dup = get(
    `SELECT id FROM shop_applies WHERE status IN (0, 1) AND user_id <> ? AND (subject_name = ? OR phone = ?)`,
    owner.id, payload.subjectName, payload.phone,
  );
  if (dup) throw Errors.badRequest('该主体已提交申请');

  const applyId = run(
    `INSERT INTO shop_applies (user_id, subject_type, subject_name, contact, phone, license_urls, category_ids,
        shop_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    owner.id, payload.subjectType, payload.subjectName, payload.contact, payload.phone,
    JSON.stringify(payload.licenseUrls), JSON.stringify(payload.categoryIds), payload.shopName, now(), now(),
  ).lastInsertRowid;

  // 驳回后重新提交：沿用同一会员账号的旧记录（保证只有一条有效申请）
  if (mine && mine.status === 2) {
    run(
      `UPDATE shop_applies SET subject_type = ?, subject_name = ?, contact = ?, phone = ?, license_urls = ?,
          category_ids = ?, shop_name = ?, status = 0, reject_reason = NULL, audited_by = NULL, audited_at = NULL,
          updated_at = ?
       WHERE id = ?`,
      payload.subjectType, payload.subjectName, payload.contact, payload.phone,
      JSON.stringify(payload.licenseUrls), JSON.stringify(payload.categoryIds), payload.shopName, now(), mine.id,
    );
    run('DELETE FROM shop_applies WHERE id = ?', applyId);
    S.bindApply(ctx.admin.id, mine.id, owner.id);
    S.audit(ctx, '入驻', '重新提交入驻申请', 'shop_apply', mine.id, `${payload.subjectName} / ${payload.shopName}`);
    return toApplyApi(get('SELECT * FROM shop_applies WHERE id = ?', mine.id));
  }

  S.bindApply(ctx.admin.id, applyId, owner.id);
  S.audit(ctx, '入驻', '提交入驻申请', 'shop_apply', applyId, `${payload.subjectName} / ${payload.shopName}`);
  return toApplyApi(get('SELECT * FROM shop_applies WHERE id = ?', applyId));
}

/** API-051 查询本人申请与进度 */
function applyDetail(ctx) {
  const shop = ctx.admin.shop_id ? get('SELECT * FROM shops WHERE id = ?', ctx.admin.shop_id) : null;
  let row = null;
  if (shop) {
    row = get('SELECT * FROM shop_applies WHERE user_id = ? ORDER BY id DESC LIMIT 1', shop.owner_id);
  }
  if (!row) {
    S.ensureApplyBindingTable();
    const bind = get('SELECT * FROM seller_apply_bindings WHERE admin_id = ?', ctx.admin.id);
    if (bind) row = get('SELECT * FROM shop_applies WHERE id = ?', bind.apply_id);
  }
  return {
    shopOpened: Boolean(shop),
    shop: shop ? { id: shop.id, name: shop.name, status: shop.status, statusName: shop.status === 1 ? '营业中' : '已停用' } : null,
    apply: row ? toApplyApi(row) : null,
    canSubmit: !shop && !(row && row.status === 0),
    canAccessSellerCenter: Boolean(shop) && (!row || row.status === 1),
  };
}

/* ============================ 店铺管理 ============================ */

function toShopApi(shop) {
  return {
    id: shop.id,
    name: shop.name,
    namePending: shop.name_pending,
    nameAuditing: Boolean(shop.name_pending),
    logo: shop.logo,
    banner: shop.banner,
    description: shop.description,
    notice: shop.notice,
    phone: shop.phone,
    categoryIds: S.parseJson(shop.category_ids, []) || [],
    score: Number((shop.score / 10).toFixed(1)),
    status: shop.status,
    statusName: shop.status === 1 ? '营业中' : '已停用',
    disableReason: shop.disable_reason,
    readonly: shop.status !== 1,
    createdAt: shop.created_at,
    updatedAt: shop.updated_at,
  };
}

/** API-052 店铺信息 */
function shopInfo(ctx) {
  const shop = S.shopOf(ctx);
  return toShopApi(shop);
}

/** 店铺名称全局唯一 + 违禁词（BR-SLR-003 / FR-OPS-024） */
function assertShopNameAvailable(shop, name) {
  S.assertNoBlockWord(name, 'name');
  const dup = get('SELECT id FROM shops WHERE name = ? AND id <> ?', name, shop.id);
  if (dup) throw Errors.badRequest('店铺名称已被占用，请更换', { field: 'name' });
}

/** API-053 更新店铺资料（名称走审核，其余直接生效） */
function shopUpdate(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  const changes = [];
  let namePending = shop.name_pending;

  if (body.name !== undefined && String(body.name).trim() && String(body.name).trim() !== shop.name) {
    const name = v.str(body.name, 'name', { min: 2, max: 30 });
    if (name !== shop.name_pending) {
      assertShopNameAvailable(shop, name);
      namePending = name;
    }
  }

  const sets = [];
  const params = [];
  if (namePending !== shop.name_pending) {
    sets.push('name_pending = ?');
    params.push(namePending);
    changes.push(`店铺名称提交审核：${namePending}`);
  }
  if (body.logo !== undefined) { sets.push('logo = ?'); params.push(String(body.logo || '')); changes.push('logo'); }
  if (body.banner !== undefined) { sets.push('banner = ?'); params.push(String(body.banner || '')); changes.push('banner'); }
  if (body.notice !== undefined) {
    const notice = v.str(body.notice, 'notice', { min: 0, max: 500 });
    sets.push('notice = ?'); params.push(notice); changes.push('公告');
  }
  if (body.description !== undefined) {
    const desc = v.str(body.description, 'description', { min: 0, max: 1000 });
    sets.push('description = ?'); params.push(desc); changes.push('简介');
  }
  if (body.phone !== undefined) {
    const phone = String(body.phone || '').trim();
    if (!phone) throw Errors.badRequest('客服电话不能为空', { field: 'phone' });
    if (!PHONE_OR_TEL_RE.test(phone)) throw Errors.badRequest('客服电话格式不正确', { field: 'phone' });
    sets.push('phone = ?'); params.push(phone); changes.push('客服电话');
  }
  if (!sets.length) throw Errors.badRequest('没有需要更新的店铺资料');

  sets.push('updated_at = ?');
  params.push(now(), shop.id);
  run(`UPDATE shops SET ${sets.join(', ')} WHERE id = ?`, ...params);

  S.audit(ctx, '店铺', '更新店铺资料', 'shop', shop.id, changes.join('、'));
  const fresh = get('SELECT * FROM shops WHERE id = ?', shop.id);
  return { ...toShopApi(fresh), nameAuditing: Boolean(fresh.name_pending) };
}

/** API-054 店铺数据概览（FR-SLR-013） */
function shopStat(ctx) {
  const shop = S.shopOf(ctx);
  const productCount = get('SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND is_deleted = 0', shop.id).c;
  const onSaleCount = get('SELECT COUNT(*) AS c FROM products WHERE shop_id = ? AND is_deleted = 0 AND status = 2', shop.id).c;
  const pendingShipCount = get('SELECT COUNT(*) AS c FROM orders WHERE shop_id = ? AND status = 1', shop.id).c;
  const totalOrderCount = get('SELECT COUNT(*) AS c FROM orders WHERE shop_id = ? AND status NOT IN (0, 4)', shop.id).c;
  const allOrderCount = get('SELECT COUNT(*) AS c FROM orders WHERE shop_id = ?', shop.id).c;
  const pendingReceive = get('SELECT COUNT(*) AS c FROM orders WHERE shop_id = ? AND status = 2', shop.id).c;
  const aftersaleCount = get(
    'SELECT COUNT(*) AS c FROM aftersales WHERE shop_id = ? AND status NOT IN (5, 6)', shop.id,
  ).c;
  const reviewCount = get('SELECT COUNT(*) AS c FROM shop_reviews WHERE shop_id = ? AND hidden = 0', shop.id).c;
  return {
    shopId: shop.id,
    shopName: shop.name,
    productCount,
    onSaleCount,
    pendingShipCount,
    pendingReceiveCount: pendingReceive,
    totalOrderCount,
    allOrderCount,
    aftersaleCount,
    reviewCount,
    score: Number((shop.score / 10).toFixed(1)),
    status: shop.status,
    statusName: shop.status === 1 ? '营业中' : '已停用',
    namePending: shop.name_pending,
  };
}

/* ============================ 门店管理 ============================ */

function toStoreApi(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    lng: row.lng,
    lat: row.lat,
    businessHours: row.business_hours,
    image: row.image,
    status: row.status,
    statusName: row.status === 1 ? '启用' : '停用',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ownStore(shopId, id) {
  const row = get('SELECT * FROM stores WHERE id = ? AND shop_id = ?', Number(id), shopId);
  if (!row) throw Errors.notFound('门店不存在');
  return row;
}

function parseStorePayload(body) {
  const name = v.str(body.name, 'name', { min: 2, max: 50 });
  const address = v.str(body.address, 'address', { min: 5, max: 200 });
  const phone = String(body.phone || '').trim();
  if (!phone) throw Errors.badRequest('联系电话不能为空', { field: 'phone' });
  if (!PHONE_OR_TEL_RE.test(phone)) throw Errors.badRequest('联系电话格式不正确', { field: 'phone' });

  const hasLng = body.lng !== undefined && body.lng !== null && String(body.lng).trim() !== '';
  const hasLat = body.lat !== undefined && body.lat !== null && String(body.lat).trim() !== '';
  if (!hasLng || !hasLat) throw Errors.badRequest('请在地图上选择门店位置', { field: 'lng' });
  const lng = Number(body.lng);
  const lat = Number(body.lat);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw Errors.badRequest('经度须在 -180 ~ 180 之间', { field: 'lng' });
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw Errors.badRequest('纬度须在 -90 ~ 90 之间', { field: 'lat' });
  }

  const businessHours = String(body.businessHours || '09:00-21:00').trim();
  const ranges = hoursRanges(businessHours);
  if (!ranges.length) throw Errors.badRequest('营业时间格式应为 HH:MM-HH:MM', { field: 'businessHours' });

  return {
    name, phone, address, lng, lat, businessHours,
    image: body.image !== undefined ? String(body.image || '') : null,
  };
}

/** API-055 门店列表（名称 / 地址模糊搜索 + 分页，展示经纬度） */
function storesList(ctx) {
  const shop = S.shopOf(ctx);
  const { pageSize, offset } = S.pageOf(ctx);
  const keyword = String(ctx.query.keyword || ctx.query.name || '').trim();
  const where = ['shop_id = ?'];
  const params = [shop.id];
  if (keyword) {
    where.push('(name LIKE ? OR address LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (ctx.query.status !== undefined && ctx.query.status !== '') {
    where.push('status = ?');
    params.push(Number(ctx.query.status) === 0 ? 0 : 1);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) AS c FROM stores ${whereSql}`, ...params).c;
  const rows = all(`SELECT * FROM stores ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
  return S.listResult(rows.map(toStoreApi), total, { page: S.pageOf(ctx).page, pageSize });
}

/** API-056 新增门店 */
function storeCreate(ctx) {
  const shop = S.activeShop(ctx);
  const payload = parseStorePayload(ctx.body || {});
  const id = run(
    `INSERT INTO stores (shop_id, name, phone, address, lng, lat, business_hours, image, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    shop.id, payload.name, payload.phone, payload.address, payload.lng, payload.lat,
    payload.businessHours, payload.image, now(), now(),
  ).lastInsertRowid;
  S.audit(ctx, '门店', '新增门店', 'store', id, `${payload.name}（${payload.lng},${payload.lat}）`);
  return toStoreApi(get('SELECT * FROM stores WHERE id = ?', id));
}

/** API-057 更新门店 */
function storeUpdate(ctx) {
  const shop = S.activeShop(ctx);
  const row = ownStore(shop.id, ctx.params.id);
  const payload = parseStorePayload(ctx.body || {});
  run(
    `UPDATE stores SET name = ?, phone = ?, address = ?, lng = ?, lat = ?, business_hours = ?, image = ?, updated_at = ?
     WHERE id = ? AND shop_id = ?`,
    payload.name, payload.phone, payload.address, payload.lng, payload.lat,
    payload.businessHours, payload.image === null ? row.image : payload.image, now(), row.id, shop.id,
  );
  S.audit(ctx, '门店', '更新门店', 'store', row.id, `${payload.name}（${payload.lng},${payload.lat}）`);
  return toStoreApi(get('SELECT * FROM stores WHERE id = ?', row.id));
}

/** API-058 删除门店（被到店服务 / 预约引用时拦截并给出影响条数） */
function storeDelete(ctx) {
  const shop = S.activeShop(ctx);
  const row = ownStore(shop.id, ctx.params.id);
  const serviceCount = get('SELECT COUNT(*) AS c FROM store_service_stores WHERE store_id = ?', row.id).c;
  if (serviceCount > 0) {
    throw Errors.badRequest(`该门店被 ${serviceCount} 个到店服务引用，请先解除关联后再删除`);
  }
  const bookingCount = get('SELECT COUNT(*) AS c FROM store_bookings WHERE store_id = ?', row.id).c;
  if (bookingCount > 0) {
    throw Errors.badRequest(`该门店存在 ${bookingCount} 条预约记录，不可删除，仅可停用`);
  }
  run('DELETE FROM stores WHERE id = ? AND shop_id = ?', row.id, shop.id);
  S.audit(ctx, '门店', '删除门店', 'store', row.id, row.name);
  return { deleted: true, id: row.id };
}

/** API-059 启用 / 停用门店（停用不影响存量预约，BR-STORE-006） */
function storeStatus(ctx) {
  const shop = S.activeShop(ctx);
  const row = ownStore(shop.id, ctx.params.id);
  const body = ctx.body || {};
  let status = body.status;
  if (status === undefined && body.enabled !== undefined) status = S.truthy(body.enabled) ? 1 : 0;
  if (status === undefined) throw Errors.badRequest('请指定门店状态', { field: 'status' });
  status = Number(status) === 0 ? 0 : 1;
  run('UPDATE stores SET status = ?, updated_at = ? WHERE id = ? AND shop_id = ?', status, now(), row.id, shop.id);
  const pendingBookings = get(
    'SELECT COUNT(*) AS c FROM store_bookings WHERE store_id = ? AND status = 1', row.id,
  ).c;
  S.audit(ctx, '门店', status === 1 ? '启用门店' : '停用门店', 'store', row.id,
    `${row.name}；存量待到店预约 ${pendingBookings} 条`);
  return {
    ...toStoreApi(get('SELECT * FROM stores WHERE id = ?', row.id)),
    pendingBookings,
    tip: status === 0
      ? `门店已停用，不再接受新预约；存量 ${pendingBookings} 条未核销预约保留至有效期结束`
      : '门店已启用',
  };
}

/* ============================ 到店服务 ============================ */

function toServiceApi(row, storeIds = null) {
  const stores = storeIds || all(
    `SELECT s.id, s.name, s.address, s.business_hours FROM store_service_stores ss
       JOIN stores s ON s.id = ss.store_id WHERE ss.store_service_id = ? ORDER BY s.id`,
    row.id,
  ).map((s) => ({ id: s.id, name: s.name, address: s.address, businessHours: s.business_hours }));
  return {
    id: row.id,
    name: row.name,
    image: row.image,
    originPrice: toYuan(row.origin_price),
    storePrice: toYuan(row.store_price),
    validStart: row.valid_start,
    validEnd: row.valid_end,
    description: row.description,
    bookingSlots: S.parseJson(row.booking_slots, []) || [],
    slotCapacity: row.slot_capacity,
    stores,
    storeIds: stores.map((s) => s.id),
    status: row.status,
    statusName: STORE_SERVICE_STATUS[row.status] || '未知',
    auditReason: row.audit_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** API-060 保存到店服务条目（新增 / 更新） */
function storeServiceSave(ctx) {
  const shop = S.activeShop(ctx);
  const body = ctx.body || {};
  v.requireFields(body, ['name', 'originPrice', 'storePrice', 'validStart', 'validEnd']);

  const name = v.str(body.name, 'name', { min: 2, max: 60 });
  const originPrice = v.money(body.originPrice, 'originPrice', { min: 1 });
  const storePrice = v.money(body.storePrice, 'storePrice', { min: 1 });
  if (storePrice > originPrice) throw Errors.badRequest('到店价不得高于原价', { field: 'storePrice' });

  const validStart = S.timeBound(body.validStart, false);
  const validEnd = S.timeBound(body.validEnd, true);
  if (!validStart || !validEnd) throw Errors.badRequest('有效期不能为空', { field: 'validStart' });
  if (parseTime(validEnd) <= parseTime(validStart)) {
    throw Errors.badRequest('有效期结束时间须晚于开始时间', { field: 'validEnd' });
  }

  const storeIds = S.asArray(body.storeIds).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  if (!storeIds.length) throw Errors.badRequest('请至少选择一个适用门店', { field: 'storeIds' });
  const stores = [];
  for (const sid of storeIds) {
    const store = get('SELECT * FROM stores WHERE id = ? AND shop_id = ?', sid, shop.id);
    if (!store) throw Errors.notFound('门店不存在');
    stores.push(store);
  }

  const bookingSlots = S.strArray(body.bookingSlots, 20);
  const slotCapacity = body.slotCapacity === undefined || body.slotCapacity === ''
    ? config.getNumber('store_slot_default_capacity')
    : v.int(body.slotCapacity, 'slotCapacity', { min: 1, max: 999 });
  if (bookingSlots.length) {
    for (const slot of bookingSlots) {
      const range = slotRange(slot);
      if (!range) throw Errors.badRequest(`预约时段「${slot}」格式应为 HH:MM-HH:MM`, { field: 'bookingSlots' });
      const fit = stores.some((store) => {
        const ranges = hoursRanges(store.business_hours);
        if (!ranges.length) return false;
        return inRanges(ranges, range);
      });
      if (!fit) throw Errors.badRequest(`预约时段「${slot}」超出门店营业时间`, { field: 'bookingSlots' });
    }
  }

  const description = body.description !== undefined
    ? v.str(body.description, 'description', { min: 0, max: 2000 })
    : '';
  const image = body.image !== undefined ? String(body.image || '') : null;

  const serviceId = body.id ? Number(body.id) : null;
  let id = null;
  if (serviceId) {
    const exist = get('SELECT * FROM store_services WHERE id = ? AND shop_id = ?', serviceId, shop.id);
    if (!exist) throw Errors.notFound('到店服务不存在');
    run(
      `UPDATE store_services SET name = ?, image = ?, origin_price = ?, store_price = ?, valid_start = ?, valid_end = ?,
          description = ?, booking_slots = ?, slot_capacity = ?, status = 0, audit_reason = NULL, updated_at = ?
       WHERE id = ? AND shop_id = ?`,
      name, image === null ? exist.image : image, originPrice, storePrice, validStart, validEnd,
      description, JSON.stringify(bookingSlots), slotCapacity, now(), exist.id, shop.id,
    );
    run('DELETE FROM store_service_stores WHERE store_service_id = ?', exist.id);
    id = exist.id;
  } else {
    id = run(
      `INSERT INTO store_services (shop_id, name, image, origin_price, store_price, valid_start, valid_end,
          description, booking_slots, slot_capacity, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      shop.id, name, image, originPrice, storePrice, validStart, validEnd,
      description, JSON.stringify(bookingSlots), slotCapacity, now(), now(),
    ).lastInsertRowid;
  }
  for (const sid of storeIds) {
    run('INSERT OR IGNORE INTO store_service_stores (store_service_id, store_id) VALUES (?, ?)', id, sid);
  }
  S.audit(ctx, '到店服务', serviceId ? '更新到店服务' : '新增到店服务', 'store_service', id,
    `${name}；到店价 ${toYuan(storePrice)} 元；门店 ${storeIds.length} 个`);
  return toServiceApi(get('SELECT * FROM store_services WHERE id = ?', id));
}

module.exports = function register(api) {
  // 入驻
  api.post('/api/seller/apply', { auth: 'seller' }, applySubmit);
  api.get('/api/seller/apply', { auth: 'seller' }, applyDetail);
  // 店铺
  api.get('/api/seller/shop', { auth: 'seller' }, shopInfo);
  api.put('/api/seller/shop', { auth: 'seller' }, shopUpdate);
  api.get('/api/seller/shop/stat', { auth: 'seller' }, shopStat);
  // 门店
  api.get('/api/seller/stores', { auth: 'seller' }, storesList);
  api.post('/api/seller/stores', { auth: 'seller' }, storeCreate);
  api.put('/api/seller/stores/:id', { auth: 'seller' }, storeUpdate);
  api.delete('/api/seller/stores/:id', { auth: 'seller' }, storeDelete);
  api.patch('/api/seller/stores/:id/status', { auth: 'seller' }, storeStatus);
  // 到店服务
  api.post('/api/seller/store-services', { auth: 'seller' }, storeServiceSave);
};
