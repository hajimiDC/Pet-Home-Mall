'use strict';

/**
 * 重置数据库并重新写入种子数据：npm run reset
 * 等价于删除数据库文件后执行 node scripts/seed.js。
 */
const fs = require('node:fs');
const { DB_FILE, close } = require('../src/core/db');

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(`${DB_FILE}${suffix}`); } catch (_) { /* ignore */ }
}
close();

const { ensureSchema } = require('../src/core/db');
const { ensureDefaults } = require('../src/core/config');
const { seed } = require('../src/db/seed');

ensureSchema();
ensureDefaults();
seed();
// eslint-disable-next-line no-console
console.log(`数据库已重置并写入种子数据：${DB_FILE}`);
close();
