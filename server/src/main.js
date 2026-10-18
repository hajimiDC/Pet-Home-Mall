'use strict';

const { ensureSchema, close, get } = require('./core/db');
const { ensureDefaults } = require('./core/config');
const { seedIfEmpty } = require('./db/seed');
const { createApp } = require('./app');
const { Logger } = require('./core/logger');
const jobs = require('./jobs');

/**
 * 服务入口。
 * 启动流程：建表（幂等）→ 默认配置 → 种子数据（首次）→ 装配路由 → 启动定时任务
 */
function bootstrap() {
  const port = Number(process.env.PET_PORT || 8080);
  ensureSchema();
  ensureDefaults();
  const seeded = seedIfEmpty();
  const server = createApp();
  server.listen(port, () => {
    Logger.info('server-started', { port, seeded, db: require('./core/db').DB_FILE });
    // eslint-disable-next-line no-console
    console.log(`宠物之家商城后端已启动：http://127.0.0.1:${port}/api/health`);
  });
  const timers = jobs.start();
  const shutdown = (signal) => {
    Logger.info('server-stopping', { signal });
    for (const t of timers) clearInterval(t);
    server.close(() => { close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (require.main === module) {
  bootstrap();
}

module.exports = { bootstrap };
