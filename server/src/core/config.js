'use strict';

const { get, all, run } = require('./db');
const { now } = require('./money');

/**
 * 平台可配参数（FR-SYS-009 基础字典 / FR-MAINT-002 运营内容可配置）。
 * 作用：运费、包邮门槛、订单超时、拼团规则、佣金费率、售后有效期、审核开关等
 * 全部从 system_configs 读取，改配置不改代码。
 * 读取带 30 秒缓存，写入后立即失效（NFR-PERF-004 允许 ≤60s 滞后）。
 */

const DEFAULTS = {
  freight_fee: '1000',                 // 运费 10 元（分）
  free_shipping_threshold: '9900',     // 满 99 元包邮（分）
  order_timeout_minutes: '15',         // 支付超时 15 分钟（Q-006）
  group_buy_min_qty: '10',             // 成团人数下限（Q-001）
  group_buy_max_qty: '99',             // 成团人数上限
  group_buy_valid_days: '3',           // 拼团有效期 3 天
  group_buy_allow_repeat_join: '0',    // 同一团仅可下 1 单（BR-GRP-006）
  commission_rate: '0.05',             // 平台佣金 5%（Q-016）
  settlement_period_days: '7',         // 结算 T+7
  aftersale_days: '15',                // 售后有效期 15 天（Q-013）
  aftersale_respond_hours: '48',       // 商家响应时限
  review_reply_max_len: '500',         // 商家回复字数上限
  product_audit_enabled: '1',          // 商品审核开关（Q-017 默认开启）
  activity_audit_enabled: '1',         // 活动审核开关
  store_cancel_hours: '2',             // 到店预约开始前可取消时限（Q-002）
  store_slot_default_capacity: '10',
  store_booking_need_audit: '0',
  withdraw_min_amount: '10000',        // 单笔提现下限 100 元
  withdraw_daily_limit: '3',           // 24 小时内提现次数上限
  withdraw_fee: '0',                   // 本期免手续费
  payment_channels: '["alipay","wechat"]',
  payment_notify_secret: 'pet-pay-sandbox-secret',
  third_party_login: '{"wechat":false,"qq":false,"weibo":false}', // Q-007 默认关闭
  map_provider: 'amap',
  map_key: '',
  default_city: '上海',
  search_scopes: '["shop","product","activity","coupon"]',
  hot_search_words: '["狗粮","猫砂","冻干","驱虫","宠物洗澡"]',
  service_phone: '400-800-8888',
};

let cache = null;
let cacheAt = 0;
const TTL = 30000;

function loadAll() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  const map = { ...DEFAULTS };
  for (const row of all('SELECT key, value FROM system_configs')) map[row.key] = row.value;
  cache = map;
  cacheAt = Date.now();
  return map;
}

function getRaw(key) {
  const map = loadAll();
  return map[key] !== undefined ? map[key] : DEFAULTS[key];
}

function getString(key) { return String(getRaw(key)); }
function getNumber(key) {
  const n = Number(getRaw(key));
  return Number.isFinite(n) ? n : Number(DEFAULTS[key]);
}
function getBool(key) { return ['1', 'true', 'yes', 'on'].includes(String(getRaw(key)).toLowerCase()); }
function getJson(key, fallback = null) {
  const raw = getRaw(key);
  if (raw === undefined || raw === null) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function set(key, value, description = '', adminId = null) {
  run(
    `INSERT INTO system_configs (key, value, description, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    key, String(value), description, now(), adminId,
  );
  invalidate();
}

function invalidate() { cache = null; cacheAt = 0; }

/** 初始化默认配置（幂等） */
function ensureDefaults() {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    const exists = get('SELECT key FROM system_configs WHERE key = ?', key);
    if (!exists) run('INSERT INTO system_configs (key, value, description, updated_at) VALUES (?, ?, ?, ?)', key, value, key, now());
  }
  invalidate();
}

/** 字典读取（物流公司 / 单位 / 品牌 / 支付渠道） */
function dict(type, { onlyEnabled = true } = {}) {
  const rows = all(
    `SELECT code, name, sort, status FROM dict_items WHERE type = ? ${onlyEnabled ? 'AND status = 1' : ''} ORDER BY sort ASC, id ASC`,
    type,
  );
  return rows;
}

module.exports = { DEFAULTS, getString, getNumber, getBool, getJson, set, invalidate, ensureDefaults, dict, loadAll };
