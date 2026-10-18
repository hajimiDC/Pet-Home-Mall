'use strict';

const { get, run, parseJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now } = require('../core/money');
const { maskPhone } = require('../core/privacy');
const v = require('../core/validate');
const catalog = require('../services/catalog-service');

/**
 * C 端店铺域（API-016 ~ API-021）
 * 覆盖：8.3 优选商家（店铺街）、8.4 商家详情页、9.3.1 入驻申请
 */

function parseListInput(raw, field, max) {
  let list = raw;
  if (list === undefined || list === null || list === '') return [];
  if (typeof list === 'string') {
    const text = list.trim();
    if (text.startsWith('[')) {
      try {
        list = JSON.parse(text);
      } catch (_) {
        throw Errors.badRequest(`${field} 格式不正确`, { field });
      }
    } else {
      list = text.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) throw Errors.badRequest(`${field} 须为数组`, { field });
  if (list.length > max) throw Errors.badRequest(`${field} 最多 ${max} 项`, { field });
  return list;
}

function normalizeLicenseUrls(raw) {
  const list = parseListInput(raw, 'licenseUrls', 5);
  if (list.length === 0) throw Errors.badRequest('请上传营业执照或身份证照片', { field: 'licenseUrls' });
  return list.map((item) => {
    const url = String(item ?? '').trim();
    if (!url) throw Errors.badRequest('资质图片地址不能为空', { field: 'licenseUrls' });
    if (url.length > 500) throw Errors.badRequest('资质图片地址过长', { field: 'licenseUrls' });
    return url;
  });
}

function normalizeCategoryIds(raw) {
  const list = parseListInput(raw, 'categoryIds', 20);
  if (list.length === 0) throw Errors.badRequest('请选择经营类目', { field: 'categoryIds' });
  const ids = [...new Set(list.map((item) => Number(item)))];
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('经营类目参数不合法', { field: 'categoryIds' });
    const category = get('SELECT id, status FROM categories WHERE id = ?', id);
    if (!category) throw Errors.badRequest(`经营类目 ${id} 不存在`, { field: 'categoryIds' });
    if (category.status !== 1) throw Errors.badRequest(`经营类目 ${id} 已停用，请重新选择`, { field: 'categoryIds' });
  }
  return ids;
}

/** API-021 商家入驻申请（FR-SLR-001 ~ 007、BR-SLR-001） */
function applyShop(userId, body = {}) {
  const subjectType = String(body.subjectType ?? body.subject_type ?? '').trim();
  if (!['个人', '企业'].includes(subjectType)) {
    throw Errors.badRequest('主体类型只能为「个人」或「企业」', { field: 'subjectType' });
  }
  const subjectName = v.str(body.subjectName ?? body.subject_name, 'subjectName', { min: 2, max: 60 });
  const contact = v.str(body.contact, 'contact', { min: 2, max: 20 });
  const phone = v.phone(body.phone);
  const shopName = v.str(body.shopName ?? body.shop_name, 'shopName', { min: 2, max: 30 });
  const licenseUrls = normalizeLicenseUrls(body.licenseUrls ?? body.license_urls);
  const categoryIds = normalizeCategoryIds(body.categoryIds ?? body.category_ids);

  // 一个会员账号本期只能申请 1 家店铺（BR-SLR-001）
  if (get('SELECT id FROM shops WHERE owner_id = ?', userId)) {
    throw Errors.badRequest('您已开通店铺，无需重复申请');
  }
  const mine = get('SELECT * FROM shop_applies WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId);
  if (mine && mine.status === 0) throw Errors.badRequest('您的入驻申请正在审核中，请勿重复提交');
  if (mine && mine.status === 1) throw Errors.badRequest('您已开通店铺，无需重复申请');

  // 同一主体名称或联系电话重复提交（FR-SLR-003）；本人被驳回的记录允许修改后重新提交
  const duplicate = get(
    `SELECT id FROM shop_applies
      WHERE (subject_name = ? OR phone = ?)
        AND NOT (user_id = ? AND status = 2)
      LIMIT 1`,
    subjectName, phone, userId,
  );
  if (duplicate) throw Errors.badRequest('该主体已提交申请');

  if (get('SELECT id FROM shops WHERE name = ?', shopName)) {
    throw Errors.badRequest('店铺名称已被占用，请更换店铺名称', { field: 'shopName' });
  }

  const licenseJson = JSON.stringify(licenseUrls);
  const categoryJson = JSON.stringify(categoryIds);
  let applyId;
  if (mine && mine.status === 2) {
    // 驳回后修改重新提交：复用原申请记录，状态回到待审核
    run(
      `UPDATE shop_applies SET subject_type = ?, subject_name = ?, contact = ?, phone = ?, license_urls = ?,
          category_ids = ?, shop_name = ?, status = 0, reject_reason = NULL, audited_by = NULL, audited_at = NULL,
          updated_at = ? WHERE id = ?`,
      subjectType, subjectName, contact, phone, licenseJson, categoryJson, shopName, now(), mine.id,
    );
    applyId = mine.id;
  } else {
    applyId = run(
      `INSERT INTO shop_applies (user_id, subject_type, subject_name, contact, phone, license_urls,
          category_ids, shop_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      userId, subjectType, subjectName, contact, phone, licenseJson, categoryJson, shopName, now(), now(),
    ).lastInsertRowid;
  }

  const row = get('SELECT * FROM shop_applies WHERE id = ?', applyId);
  return {
    id: Number(row.id),
    status: row.status,
    statusName: '待审核',
    subjectType: row.subject_type,
    subjectName: row.subject_name,
    contact: row.contact,
    phone: maskPhone(row.phone),
    shopName: row.shop_name,
    licenseUrls: parseJson(row.license_urls, []) || [],
    categoryIds: parseJson(row.category_ids, []) || [],
    createdAt: row.created_at,
    message: '入驻申请已提交，平台将在 1-3 个工作日内完成审核',
  };
}

module.exports = function register(api) {
  // API-016 商家列表（店铺街：仅营业中，支持关键字 / 评分 / 销量 / 上新排序）
  api.get('/api/shops', {}, (ctx) => catalog.listShops(ctx.query));

  // API-021 商家入驻申请（需登录）
  api.post('/api/shops/apply', { auth: 'user', rate: { limit: 10, window: 60 } }, (ctx) => applyShop(ctx.user.id, ctx.body));

  // API-017 商家详情（optionalUser 用于返回当前用户收藏状态）
  api.get('/api/shops/:id', { optionalUser: true }, (ctx) => catalog.shopDetail(ctx.params.id, ctx.user ? ctx.user.id : null));

  // API-018 商家店内商品（分页）
  api.get('/api/shops/:id/products', {}, (ctx) => catalog.shopProducts(ctx.params.id, ctx.query));

  // API-019 商家活动（仅进行中）
  api.get('/api/shops/:id/activities', {}, (ctx) => catalog.shopActivities(ctx.params.id, ctx.query));

  // API-020 收藏 / 取消收藏店铺（需登录，切换语义）
  api.post('/api/shops/:id/favorite', { auth: 'user' }, (ctx) => {
    const sid = Number(ctx.params.id);
    if (!Number.isInteger(sid) || sid <= 0) throw Errors.notFound('店铺不存在或已停用');
    const shop = get('SELECT id, name, status FROM shops WHERE id = ?', sid);
    if (!shop || shop.status !== 1) throw Errors.notFound('店铺不存在或已停用');
    const exist = get('SELECT id FROM favorites WHERE user_id = ? AND shop_id = ?', ctx.user.id, sid);
    let favorited;
    if (exist) {
      run('DELETE FROM favorites WHERE id = ?', exist.id);
      favorited = false;
    } else {
      run('INSERT INTO favorites (user_id, shop_id, created_at) VALUES (?, ?, ?)', ctx.user.id, sid, now());
      favorited = true;
    }
    const favoriteCount = get('SELECT COUNT(*) AS c FROM favorites WHERE shop_id = ?', sid).c;
    return {
      shopId: sid,
      favorited,
      favoriteCount: Number(favoriteCount || 0),
      message: favorited ? '收藏成功' : '已取消收藏',
    };
  });
};

module.exports.applyShop = applyShop;
