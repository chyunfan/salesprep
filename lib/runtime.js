'use strict';

/**
 * 运行时组件：限流、缓存、审计日志。
 * 全部为内存实现，单实例够用；多实例部署时换 Redis 即可，接口不变。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');

/* ---------------- 限流 ---------------- */

const buckets = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const win = 60 * 1000;
  let b = buckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + win };
    buckets.set(key, b);
  }
  b.count += 1;
  const remaining = Math.max(0, config.rateLimitPerMin - b.count);
  return {
    ok: b.count <= config.rateLimitPerMin,
    remaining,
    resetSec: Math.ceil((b.reset - now) / 1000),
    limit: config.rateLimitPerMin
  };
}

/* 定期清理，避免长期运行内存增长 */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 120000).unref();

/* ---------------- 缓存 ---------------- */

const cache = new Map();

function cacheKey(task, company, facts) {
  const h = crypto.createHash('sha1').update(JSON.stringify(facts || {})).digest('hex').slice(0, 12);
  return `${task}::${(company || '').trim()}::${h}`;
}

function cacheGet(key) {
  if (!config.cacheTtl) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expire) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (!config.cacheTtl) return;
  cache.set(key, { value, expire: Date.now() + config.cacheTtl * 1000 });
  if (cache.size > 500) {
    // 简单淘汰：删最早插入的
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

/* ---------------- 审计日志 ---------------- */

const LOG_DIR = path.join(config.root, 'data');
const LOG_FILE = path.join(LOG_DIR, 'audit.log');

function digest(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * 写一条调用记录。只记摘要与校验结论，不记完整原文与密钥。
 */
function audit(entry) {
  if (!config.auditLog) return;
  try {
    const row = {
      ts: new Date().toISOString(),
      task: entry.task,
      company: entry.company,
      model: entry.model,
      latencyMs: entry.latencyMs,
      promptDigest: entry.prompt ? digest(entry.prompt) : null,
      outputChars: entry.outputChars || 0,
      tokens: entry.usage || null,
      checks: entry.checks || null,
      ok: Boolean(entry.ok),
      error: entry.error || null,
      cache: Boolean(entry.cache)
    };

    // Serverless 的代码目录只读，写文件必然失败。改走标准输出，
    // 平台上在 Functions → Logs 里能看到同样的结构。
    if (process.env.VERCEL) {
      console.log('[audit] ' + JSON.stringify(row));
      return;
    }

    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFile(LOG_FILE, JSON.stringify(row) + '\n', () => {});
  } catch (_) {
    /* 日志失败不影响主流程 */
  }
}

module.exports = { rateLimit, cacheGet, cacheSet, cacheKey, audit };
