'use strict';

/** 初始化种子数据：node scripts/seed.js [--force] */
const fs = require('node:fs');
const { ensureSchema, close, get, DB_FILE } = require('../src/core/db');
const { ensureDefaults } = require('../src/core/config');
const { seed, seedIfEmpty } = require('../src/db/seed');

const force = process.argv.includes('--force');
if (force) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${DB_FILE}${suffix}`); } catch (_) { /* ignore */ }
  }
}
ensureSchema();
ensureDefaults();
if (get('SELECT COUNT(*) AS c FROM users').c > 0 && !force) {
  console.log(`数据库已存在数据（${DB_FILE}），如需重置请执行：npm run seed -- --force`);
} else {
  seed();
  console.log(`种子数据已写入：${DB_FILE}`);
}
close();
