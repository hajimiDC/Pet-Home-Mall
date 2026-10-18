'use strict';

const { Errors } = require('./errors');

/**
 * 轻量令牌桶限流（NFR-SEC-010：搜索 / 领券 / 下单等接口按用户 / IP 限流）。
 * 单实例内存实现：Map<key, {count, resetAt}>，定期清理过期桶。
 */

const buckets = new Map();

function hit(key, limit = 60, windowSec = 60) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { remaining: limit - 1 };
  }
  bucket.count += 1;
  if (bucket.count > limit) throw Errors.tooMany('操作过于频繁，请稍后再试');
  return { remaining: Math.max(0, limit - bucket.count) };
}

function reset(key) { buckets.delete(key); }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}, 60000).unref();

module.exports = { hit, reset };
