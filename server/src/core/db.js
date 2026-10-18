'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { now } = require('./money');

/**
 * 数据访问层（对应 NFR-MAINT-001 分层架构中的 Mapper 层 / 数据源）。
 * - 运行时使用 Node 24 内置 node:sqlite（零外部依赖，便于课程环境直接运行）
 * - SQL 全部参数化，杜绝注入（NFR-SEC-007）
 * - 事务使用 BEGIN IMMEDIATE + SAVEPOINT 支持嵌套，保证 NFR-CONS-005 事务边界
 */

const DATA_DIR = process.env.PET_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_FILE = process.env.PET_DB_FILE || path.join(DATA_DIR, 'pet_home_mall.db');
const SCHEMA_FILE = path.join(__dirname, '..', 'db', 'schema.sqlite.sql');

let db = null;
let txDepth = 0;

function connect() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function ensureSchema() {
  const handle = connect();
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  handle.exec(sql);
  return handle;
}

function close() {
  if (db) { try { db.close(); } catch (_) { /* ignore */ } db = null; txDepth = 0; }
}

/** 单行查询 */
function get(sql, ...params) {
  return connect().prepare(sql).get(...params);
}

/** 多行查询 */
function all(sql, ...params) {
  return connect().prepare(sql).all(...params);
}

/** 写入，返回 { changes, lastInsertRowid } */
function run(sql, ...params) {
  return connect().prepare(sql).run(...params);
}

/** 取第一列 */
function scalar(sql, ...params) {
  const row = get(sql, ...params);
  if (!row) return undefined;
  return row[Object.keys(row)[0]];
}

/**
 * 事务：支持嵌套（内层用 SAVEPOINT），异常自动回滚。
 * @param {Function} fn
 */
function transaction(fn) {
  const handle = connect();
  const isOuter = txDepth === 0;
  const savepoint = `sp_${txDepth}`;
  if (isOuter) handle.exec('BEGIN IMMEDIATE');
  else handle.exec(`SAVEPOINT ${savepoint}`);
  txDepth += 1;
  try {
    const result = fn(handle);
    txDepth -= 1;
    if (isOuter) handle.exec('COMMIT');
    else handle.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    txDepth -= 1;
    try {
      if (isOuter) handle.exec('ROLLBACK');
      else handle.exec(`ROLLBACK TO ${savepoint}`);
    } catch (_) { /* ignore */ }
    throw err;
  }
}

/** 分页参数归一化（NFR-PERF-005：默认 20，最大 50） */
function pagination(query = {}, { defaultSize = 20, maxSize = 50 } = {}) {
  let page = Number.parseInt(query.page, 10);
  let pageSize = Number.parseInt(query.pageSize || query.size || query.limit, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = defaultSize;
  if (pageSize > maxSize) pageSize = maxSize;
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

/** 生成业务单号：前缀 + yyyyMMddHHmmss + 6 位随机 */
function bizNo(prefix) {
  const t = now().replace(/[-: ]/g, '');
  const rand = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  return `${prefix}${t}${rand}`;
}

/** 生成核销码：8 位数字（全局唯一，落库唯一索引兜底） */
function verifyCode() {
  let code = '';
  for (let i = 0; i < 8; i += 1) code += Math.floor(Math.random() * 10);
  return code;
}

/** JSON 字段安全解析 */
function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function toJson(value) {
  return value === undefined ? null : JSON.stringify(value);
}

module.exports = {
  DB_FILE, DATA_DIR, connect, ensureSchema, close, get, all, run, scalar, transaction,
  pagination, bizNo, verifyCode, parseJson, toJson,
};
