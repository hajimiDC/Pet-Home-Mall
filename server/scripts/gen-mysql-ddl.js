'use strict';

/**
 * 由 SQLite 运行时 Schema 生成 MySQL 8 版 DDL（交付/迁移用）。
 * 类型映射：id *_id → BIGINT；金额分（INTEGER）→ DECIMAL(10,2) 元；状态/数量 → INT；
 *           时间文本 → DATETIME；JSON 文本 → JSON；坐标 REAL → DECIMAL(10,6)。
 * 说明：运行时以 sqlite 版为准（金额以“分”为整数），MySQL 版供数据库设计与迁移参考。
 */

const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src', 'db', 'schema.sqlite.sql');
const out = path.join(__dirname, '..', '..', 'sql', 'schema.mysql.sql');

const AMOUNT_HINTS = ['amount', 'price', 'fee', 'payable', 'commission', 'deal', 'refund', 'threshold', 'discount'];
const JSON_HINTS = ['images', 'scope_ids', 'category_ids', 'license_urls', 'rule_json', 'booking_slots', 'spec_json', 'receiver_snapshot', 'evidence', 'replies', 'return_logistics', 'notify_payload', 'detail_html', 'content', 'account_info'];
const DATETIME_HINTS = ['_at', 'locked_until', 'deadline', 'period'];
const LONG_TEXT = ['description', 'notice', 'remark', 'reason', 'detail', 'answer', 'message'];

function mapType(table, col, base, isPk) {
  const name = col.toLowerCase();
  if (isPk) return 'BIGINT NOT NULL AUTO_INCREMENT';
  if (base.startsWith('INTEGER') || base === 'INT') {
    if (name === 'id' || name.endsWith('_id') || name === 'user_id' || name === 'shop_id' || name === 'product_id' || name === 'sku_id') return 'BIGINT';
    if (AMOUNT_HINTS.some((h) => name.endsWith(h) || name.includes(h))) return 'DECIMAL(12,2)';
    if (JSON_HINTS.some((h) => name.includes(h))) return 'JSON';
    return 'INT';
  }
  if (base.startsWith('REAL')) return 'DECIMAL(10,6)';
  if (base.startsWith('TEXT')) {
    if (JSON_HINTS.some((h) => name.includes(h))) return 'JSON';
    if (LONG_TEXT.some((h) => name.includes(h))) return 'TEXT';
    if (DATETIME_HINTS.some((h) => name.endsWith(h)) || name === 'period') return name === 'period' ? 'VARCHAR(20)' : 'DATETIME';
    if (name === 'business_hours') return 'VARCHAR(64)';
    if (name === 'phone') return 'VARCHAR(20)';
    if (name.includes('no') || name === 'order_no' || name === 'booking_no' || name === 'verify_code') return 'VARCHAR(64)';
    if (name === 'username' || name === 'account' || name === 'name' || name === 'title' || name === 'nickname') return 'VARCHAR(128)';
    return 'VARCHAR(255)';
  }
  if (base.startsWith('REAL')) return 'DECIMAL(10,6)';
  return 'VARCHAR(255)';
}

const text = fs.readFileSync(src, 'utf8');
const blocks = text.split(/CREATE TABLE IF NOT EXISTS /).slice(1);
const tables = [];
for (const block of blocks) {
  const tableName = block.slice(0, block.indexOf('(')).trim();
  const bodyEnd = block.indexOf('\n);');
  const body = block.slice(block.indexOf('(') + 1, bodyEnd);
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const cols = [];
  const constraints = [];
  for (const line of lines) {
    if (line.startsWith('PRIMARY KEY') || line.startsWith('UNIQUE') || line.startsWith('FOREIGN') || line.startsWith('CHECK')) {
      let cleaned = line.replace(/,\s*$/, '');
      cleaned = cleaned.replace(/REFERENCES ([a-z_]+)\(id\)/, 'REFERENCES $1(id)');
      constraints.push(cleaned);
      continue;
    }
    const m = /^([a-z_]+)\s+([A-Z]+(?:\([^)]*\))?)\s*(.*?),?$/i.exec(line);
    if (!m) continue;
    const [, name, base, rest] = m;
    const isPk = /PRIMARY KEY/i.test(rest) || constraints.some((c) => /PRIMARY KEY/.test(c) && c.includes(name));
    const notNull = /NOT NULL/i.test(rest) || isPk;
    const def = /DEFAULT\s+([^,\s]+)/i.exec(rest);
    let type = mapType(tableName, name, base, isPk);
    if (isPk) {
      cols.push(`  \`${name}\` ${type} PRIMARY KEY`);
      continue;
    }
    let stmt = `  \`${name}\` ${type}`;
    if (notNull) stmt += ' NOT NULL';
    if (def && def[1].toUpperCase() !== 'NULL' && !/^\(/.test(def[1])) stmt += ` DEFAULT ${def[1]}`;
    if (/UNIQUE/i.test(rest)) stmt += ' UNIQUE';
    cols.push(stmt);
  }
  tables.push({ name: tableName, cols, constraints });
}

const header = `-- 宠物之家商城 · MySQL 8 版数据库结构（交付 / 迁移用）
-- 说明：
--   1. 运行时以 server/src/db/schema.sqlite.sql 为准（金额以“分”INTEGER 存储，服务层整数运算）；
--      本文件为等价 MySQL 设计稿，金额改为 DECIMAL(12,2) 元、时间改为 DATETIME。
--   2. 表名沿用 ER 图语义，其中 order / user 为 SQL 保留字，物理表名落为 orders / users。
--   3. 字符集统一 utf8mb4；引擎 InnoDB；主键 bigint；金额 decimal；日志类表只增不改。

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
`;

const parts = tables.map((t) => `DROP TABLE IF EXISTS \`${t.name}\`;\nCREATE TABLE \`${t.name}\` (\n${[...t.cols, ...t.constraints.map((c) => `  ${c}`)].join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;`);

const extraIndexes = `
-- 关键索引（与 SQLite 版一致：订单/商品/流水分页与过滤）
CREATE INDEX idx_orders_user_time ON orders(user_id, created_at);
CREATE INDEX idx_orders_shop_time ON orders(shop_id, created_at);
CREATE INDEX idx_orders_status_expire ON orders(status, expire_at);
CREATE INDEX idx_products_status ON products(status, is_deleted);
CREATE INDEX idx_products_shop ON products(shop_id);
CREATE INDEX idx_skus_product ON skus(product_id);
CREATE INDEX idx_stock_logs_sku_time ON stock_logs(sku_id, created_at);
CREATE INDEX idx_operation_logs_admin_time ON operation_logs(admin_id, created_at);
CREATE INDEX idx_user_coupons_user_status ON user_coupons(user_id, status);
CREATE INDEX idx_bookings_slot ON store_bookings(store_id, booking_date, slot);
SET FOREIGN_KEY_CHECKS = 1;
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${header}\n${parts.join('\n\n')}\n${extraIndexes}`, 'utf8');
console.log(`已生成 MySQL DDL：${out}（${tables.length} 张表）`);
