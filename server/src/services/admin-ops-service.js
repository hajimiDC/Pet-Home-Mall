'use strict';

const { get, all, run, transaction, parseJson, toJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toCents, toYuan, parseTime, addDays } = require('../core/money');
const v = require('../core/validate');
const { auditLog } = require('../core/http');
const { maskPhone } = require('../core/privacy');
const config = require('../core/config');

/**
 * 平台后台 · 运营域共用逻辑（API-092 ~ API-122）
 *
 * 约定：
 *  - 金额：数据库存分（INTEGER），对外统一 toYuan() 返回元；
 *  - 时间：数据库存 'YYYY-MM-DD HH:MM:SS'（UTC），对外原样返回，入参统一 normTime() 归一；
 *  - 列表：{ total, rows }，分页 db.pagination(ctx.query, { defaultSize: 20, maxSize: 50 })；
 *  - 所有写操作通过 writeLog() 落 operation_logs（FR-BE-010 / FR-SYS-011）；
 *  - 商家站内通知统一 target_type='seller'、target_id=shop_id；会员通知 target_type='user'、target_id=user_id。
 */

// ==================== 时间 / 数值归一 ====================

/**
 * 归一化时间入参：支持 'YYYY-MM-DD'、'YYYY-MM-DD HH:MM'、'YYYY-MM-DD HH:MM:SS'、ISO 8601（含 T/Z）。
 * @param {*} value 原始值
 * @param {{endOfDay?:boolean, field?:string, required?:boolean}} opts
 * @returns {string|null}
 */
function normTime(value, { endOfDay = false, field = '时间', required = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw v.fieldError(field, `${v.labelOf(field)}不能为空`);
    return null;
  }
  let s = String(value).trim().replace('T', ' ').replace(/Z$/i, '').replace(/\.\d+$/, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    s = `${s} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) {
    s = `${s}:${endOfDay ? '59' : '00'}`;
  }
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    throw v.fieldError(field, `${v.labelOf(field)}格式不正确，应为 YYYY-MM-DD HH:MM:SS`);
  }
  return s;
}

/** 元 → 分，允许 0 */
function cents(value, field, { allowZero = true } = {}) {
  const c = toCents(value);
  if (c === null || Number.isNaN(c)) throw v.fieldError(field, `${v.labelOf(field)}格式不正确（最多两位小数）`);
  if (allowZero ? c < 0 : c <= 0) throw v.fieldError(field, allowZero ? `${v.labelOf(field)}不能小于 0` : `${v.labelOf(field)}须大于 0`);
  return c;
}

/** 布尔归一：true / 'true' / 1 / '1' / 'yes' / 'on' */
function boolOf(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/** 整数归一（缺省返回 def） */
function intOr(value, field, def) {
  if (value === undefined || value === null || value === '') return def;
  return v.int(value, field);
}

/** 非负整数，缺省 def */
function uintOr(value, field, def) {
  if (value === undefined || value === null || value === '') return def;
  const n = v.int(value, field, { min: 0 });
  return n;
}

// ==================== 审计 / 通知 ====================

/**
 * 写操作审计日志（FR-BE-010 / FR-SYS-011）。
 * @param {object} ctx 请求上下文
 * @param {{module:string, action:string, targetType?:string, targetId?:*, detail?:*}} entry
 */
function writeLog(ctx, { module, action, targetType = '', targetId = '', detail = '' }) {
  auditLog({
    adminId: ctx.admin?.id ?? null,
    adminName: ctx.admin?.name ?? '',
    roleCode: ctx.auth?.roleCode ?? '',
    module,
    action,
    targetType,
    targetId,
    detail,
    ip: ctx.ip,
  });
}

/** 商家站内通知（target_type='seller', target_id=shop_id） */
function notifySeller(shopId, title, content = '') {
  if (!shopId) return;
  run(
    'INSERT INTO notifications (target_type, target_id, title, content, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    'seller', Number(shopId), title, String(content || ''), now(),
  );
}

/** 会员站内通知（target_type='user', target_id=user_id） */
function notifyUser(userId, title, content = '') {
  if (!userId) return;
  run(
    'INSERT INTO notifications (target_type, target_id, title, content, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    'user', Number(userId), title, String(content || ''), now(),
  );
}

// ==================== 类目 ====================

/** 类目 id 及其全部后代 id（用于停用联动 / 删除影响统计） */
function categorySubtreeIds(rootId) {
  const rows = all(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM categories WHERE id = ?
       UNION ALL
       SELECT c.id FROM categories c JOIN sub ON c.parent_id = sub.id
     ) SELECT id FROM sub`,
    rootId,
  );
  return rows.map((r) => Number(r.id));
}

/** 直接子类目数量 */
function categoryChildCount(categoryId) {
  return get('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ?', categoryId).c;
}

/** 扁平类目行 → 树（children 递归，按 sort, id 排序） */
function buildCategoryTree(rows) {
  const map = new Map();
  for (const r of rows) {
    const pid = Number(r.parent_id ?? r.parentId ?? 0);
    map.set(Number(r.id), { ...r, id: Number(r.id), parentId: pid, children: [] });
  }
  const roots = [];
  for (const node of map.values()) {
    const parent = node.parentId ? map.get(node.parentId) : null;
    if (parent) parent.children.push(node); else roots.push(node);
  }
  const sortNodes = (nodes) => {
    nodes.sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);
  return roots;
}

/** 类目对外结构（snake → camel，附带商品数） */
function categoryOut(row, productCount = 0) {
  return {
    id: Number(row.id),
    name: row.name,
    parentId: Number(row.parent_id ?? row.parentId ?? 0),
    level: Number(row.level),
    icon: row.icon || '',
    sort: Number(row.sort || 0),
    status: Number(row.status),
    statusName: Number(row.status) === 1 ? '启用' : '停用',
    productCount: Number(productCount || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 类目名称路径：狗狗 / 主粮 / 进口粮 */
function categoryPath(categoryId) {
  const names = [];
  let cur = get('SELECT id, name, parent_id FROM categories WHERE id = ?', categoryId);
  for (let i = 0; i < 5 && cur; i += 1) {
    names.unshift(cur.name);
    cur = cur.parent_id ? get('SELECT id, name, parent_id FROM categories WHERE id = ?', cur.parent_id) : null;
  }
  return names.join(' / ');
}

// ==================== 通用查询辅助 ====================

/** 店铺简要信息 */
function shopBrief(shopId) {
  const s = get('SELECT id, name, logo, status, owner_id FROM shops WHERE id = ?', shopId);
  return s ? { id: s.id, name: s.name, logo: s.logo, status: s.status, ownerId: s.owner_id } : null;
}

/** 商品对外结构（含店铺 / 类目名） */
function productOut(p, extra = {}) {
  if (!p) return null;
  return {
    id: p.id,
    shopId: p.shop_id,
    shopName: p.shop_name || '',
    categoryId: p.category_id,
    categoryName: p.category_path || p.category_name || '',
    name: p.name,
    mainImage: p.main_image,
    images: parseJson(p.images, []) || [],
    brand: p.brand,
    unit: p.unit,
    productCode: p.product_code,
    price: toYuan(p.price),
    originPrice: p.origin_price === null || p.origin_price === undefined ? null : toYuan(p.origin_price),
    sales: p.sales,
    totalStock: p.total_stock,
    lockedStock: p.locked_stock,
    status: p.status,
    statusName: PRODUCT_STATUS[p.status] || '',
    auditReason: p.audit_reason || '',
    isDeleted: p.is_deleted,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    ...extra,
  };
}

const PRODUCT_STATUS = {
  0: '草稿', 1: '待审核', 2: '已上架', 3: '已下架', 4: '审核驳回',
};

const ACTIVITY_STATUS = {
  0: '待审核', 1: '已通过', 2: '已驳回', 3: '已结束', 4: '强制下线',
};

const SHOP_APPLY_STATUS = { 0: '待审核', 1: '已通过', 2: '已驳回' };

const GROUP_BUY_STATUS = {
  0: '待审核', 1: '进行中', 2: '已成团', 3: '未成团', 4: '已驳回', 5: '已下线',
};

/** 手机号脱敏 */
function maskPhoneSafe(phone) { return maskPhone(phone); }

module.exports = {
  normTime, cents, boolOf, intOr, uintOr,
  writeLog, notifySeller, notifyUser,
  categorySubtreeIds, categoryChildCount, buildCategoryTree, categoryOut, categoryPath,
  shopBrief, productOut, maskPhoneSafe,
  PRODUCT_STATUS, ACTIVITY_STATUS, SHOP_APPLY_STATUS, GROUP_BUY_STATUS,
  // 透传，减少各模块重复 require
  get, all, run, transaction, parseJson, toJson, now, toYuan, toCents, parseTime, addDays, config, v, Errors,
};
