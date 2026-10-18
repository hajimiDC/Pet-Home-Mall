'use strict';

const { get, all, run, pagination, parseJson } = require('../core/db');
const { Errors } = require('../core/errors');
const { now, toYuan, parseTime, addDays } = require('../core/money');
const { requireShop } = require('../core/auth');
const { auditLog } = require('../core/http');
const config = require('../core/config');

/**
 * 商家端（卖家中心）共用逻辑（9.2.3 FR-BE-006、9.3 全模块）
 *
 * 统一约定：
 *  - 所有查询强制按 ctx.admin.shop_id 隔离，忽略请求体 / URL 中的 shop_id；
 *  - 跨店资源统一 404（不区分「不存在」与「无权」，避免越权探测，BR-SLR-014）；
 *  - 未开通店铺（shop_id 为空）除入驻申请外一律 403「请先完成入驻审核」；
 *  - 写操作统一落 operation_logs（FR-BE-010 / FR-SYS-011）。
 */

const SELLER_ROLE = 'seller';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** 当前商家店铺（未开通 → 403 请先完成入驻审核） */
function shopOf(ctx) {
  return requireShop(ctx);
}

/** 当前商家店铺，且要求店铺为「营业中」（停用 → 403 仅可查看） */
function activeShop(ctx) {
  const shop = shopOf(ctx);
  if (Number(shop.status) !== 1) throw Errors.forbidden('店铺已停用，仅可查看');
  return shop;
}

/** 审计日志（商家端统一入口） */
function audit(ctx, module, action, targetType, targetId, detail) {
  auditLog({
    adminId: ctx.admin?.id ?? null,
    adminName: ctx.admin?.name || ctx.admin?.account || '',
    roleCode: SELLER_ROLE,
    module,
    action,
    targetType: targetType || '',
    targetId: targetId ?? '',
    detail: detail === undefined ? '' : detail,
    ip: ctx.ip,
  });
}

/** 分页参数（默认 20，最大 50） */
function pageOf(ctx) {
  return pagination(ctx.query || {}, { defaultSize: 20, maxSize: 50 });
}

function listResult(rows, total, extra = {}) {
  return { total, rows, ...extra };
}

/** 时间筛选值归一：「2026-10-12」→ 当日 00:00:00 / 23:59:59 */
function timeBound(value, isEnd = false) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (DATE_RE.test(s)) return `${s} ${isEnd ? '23:59:59' : '00:00:00'}`;
  return s.replace('T', ' ').slice(0, 19);
}

/** 组装时间区间条件（列名由调用方给出，已限定为内部常量） */
function pushTimeRange(where, params, column, from, to) {
  const f = timeBound(from, false);
  const t = timeBound(to, true);
  if (f) { where.push(`${column} >= ?`); params.push(f); }
  if (t) { where.push(`${column} <= ?`); params.push(t); }
}

/** 布尔型查询参数 */
function truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());
}

/** 把任意入参转成数组（支持数组 / JSON 字符串 / 逗号分隔） */
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) { return []; }
    }
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [value];
}

/** 字符串数组（图片 / 证据等），去空并截断 */
function strArray(value, max = 9) {
  return asArray(value).map((x) => String(x).trim()).filter(Boolean).slice(0, max);
}

/** 违禁词匹配（search_words.type='block' + system_configs.block_words） */
function blockWordIn(text) {
  const s = String(text || '');
  if (!s) return null;
  const words = all("SELECT word FROM search_words WHERE type = 'block'").map((r) => r.word);
  const extra = config.getJson('block_words', []);
  const pool = words.concat(Array.isArray(extra) ? extra : String(extra || '').split(','));
  for (const w of pool) {
    const word = String(w || '').trim();
    if (word && s.includes(word)) return word;
  }
  return null;
}

/** 违禁词校验（BR-SLR-003 / FR-OPS-028） */
function assertNoBlockWord(text, field = 'name') {
  const word = blockWordIn(text);
  if (word) throw Errors.badRequest(`内容包含违禁词「${word}」，请修改后提交`, { field });
}

/** 最末级类目校验（BR-SLR-008） */
function leafCategory(categoryId) {
  const cat = get('SELECT * FROM categories WHERE id = ?', Number(categoryId));
  if (!cat) throw Errors.badRequest('商品类目不存在', { field: 'categoryId' });
  if (Number(cat.level) !== 3) throw Errors.badRequest('商品必须归属到最末级类目', { field: 'categoryId' });
  return cat;
}

/** 时间戳 → 秒级字符串（导出 / 展示用） */
function fmtTime(v) {
  if (!v) return '';
  return String(v);
}

/** 距离自然日天数（用于 T+N 生效） */
function daysFromNow(days) {
  return addDays(days);
}

/**
 * 兼容性建表：schema.sqlite.sql 未包含 settlement / withdrawal 相关表，
 * 而结算与提现 service 依赖它们。此处以 IF NOT EXISTS 幂等补齐（不改动 schema 文件）。
 */
let settlementReady = false;
function ensureSettlementTables() {
  if (settlementReady) return;
  run(`CREATE TABLE IF NOT EXISTS settlements (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id        INTEGER NOT NULL,
    period         TEXT    NOT NULL,
    deal_amount    INTEGER NOT NULL DEFAULT 0,
    commission     INTEGER NOT NULL DEFAULT 0,
    payable_amount INTEGER NOT NULL DEFAULT 0,
    status         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT    NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS settlement_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_id  INTEGER NOT NULL,
    order_id       INTEGER NOT NULL,
    deal_amount    INTEGER NOT NULL DEFAULT 0,
    commission     INTEGER NOT NULL DEFAULT 0,
    refund_amount  INTEGER NOT NULL DEFAULT 0,
    payable_amount INTEGER NOT NULL DEFAULT 0
  )`);
  run(`CREATE TABLE IF NOT EXISTS withdrawals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id       INTEGER NOT NULL,
    settlement_id INTEGER,
    amount        INTEGER NOT NULL,
    account_info  INTEGER,
    status        INTEGER NOT NULL DEFAULT 0,
    reject_reason TEXT,
    auditor_id    INTEGER,
    audited_at    TEXT,
    paid_at       TEXT,
    created_at    TEXT    NOT NULL
  )`);
  settlementReady = true;
}

/**
 * 兼容性建表：admin_users 与 users 之间无外键关联字段，
 * 而 shop_applies.user_id 必须指向 users(id)（FR-SLR-001 / BR-SLR-001）。
 * 此表记录「商家后台账号 → 入驻申请」的绑定，供未开店账号查询本人申请进度。
 */
let applyBindReady = false;
function ensureApplyBindingTable() {
  if (applyBindReady) return;
  run(`CREATE TABLE IF NOT EXISTS seller_apply_bindings (
    admin_id   INTEGER PRIMARY KEY,
    apply_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    created_at TEXT    NOT NULL
  )`);
  applyBindReady = true;
}

function bindApply(adminId, applyId, userId) {
  ensureApplyBindingTable();
  run(
    `INSERT INTO seller_apply_bindings (admin_id, apply_id, user_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(admin_id) DO UPDATE SET apply_id = excluded.apply_id, user_id = excluded.user_id`,
    adminId, applyId, userId, now(),
  );
}

module.exports = {
  SELLER_ROLE, DATE_RE, TIME_RE,
  shopOf, activeShop, audit, pageOf, listResult,
  timeBound, pushTimeRange, truthy, asArray, strArray, fmtTime, daysFromNow,
  blockWordIn, assertNoBlockWord, leafCategory,
  ensureSettlementTables, ensureApplyBindingTable, bindApply,
  parseJson, parseTime, toYuan, now, config,
};
