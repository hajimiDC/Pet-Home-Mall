'use strict';

/**
 * 顺序执行全部测试文件（每个文件独立临时数据库）。
 * 采用 stdio: 'inherit'，既能在普通环境运行，也兼容受限环境（禁止管道子进程）。
 * 用法：npm test  /  node scripts/run-tests.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort();
let passed = 0;
let failed = 0;
const summary = [];

for (const file of files) {
  // eslint-disable-next-line no-console
  console.log(`\n▶ ${file}`);
  const res = spawnSync(process.execPath, [path.join(testDir, file)], {
    stdio: 'inherit',
    env: { ...process.env, PET_LOG_SILENT: '1' },
  });
  if (res.status === 0) { passed += 1; summary.push(`✅ ${file}`); }
  else { failed += 1; summary.push(`❌ ${file}（exit ${res.status}）`); }
}

// eslint-disable-next-line no-console
console.log('\n==================== 测试汇总 ====================');
for (const line of summary) console.log(line);
console.log(`文件：${files.length}，通过：${passed}，失败：${failed}`);
process.exit(failed > 0 ? 1 : 0);
