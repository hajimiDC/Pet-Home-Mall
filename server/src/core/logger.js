'use strict';

/** 结构化日志（NFR-MAINT-004：可定位到接口与 requestId；NFR-SEC-009：禁止打印密码等敏感明文） */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const LEVEL = LEVELS[(process.env.PET_LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
const SILENT = process.env.PET_LOG_SILENT === '1';

function write(level, event, fields = {}) {
  if (LEVELS[level] < LEVEL || SILENT) return;
  const entry = { ts: new Date().toISOString(), level, event, ...redact(fields) };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function redact(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (/password|pwd|token|secret|authorization/i.test(k)) out[k] = '***';
    else if (v instanceof Error) out[k] = v.message;
    else out[k] = v;
  }
  return out;
}

const Logger = {
  debug: (e, f) => write('debug', e, f),
  info: (e, f) => write('info', e, f),
  warn: (e, f) => write('warn', e, f),
  error: (e, f) => write('error', e, f),
};

module.exports = { Logger };
