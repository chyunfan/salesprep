'use strict';

/**
 * /api/facts 的业务实现。
 *
 * 单独抽出来是因为有两个入口要用同一套逻辑：Vercel 的 api/facts.js 与本地 server.js。
 * 两边各写一遍，早晚会出现"本地能查、线上报错"这种只有部署后才发现的偏差。
 */

const { collectFacts } = require('./search');
const { rateLimit, cacheGet, cacheSet } = require('./runtime');
const { isReady, isKuaichaReady } = require('./config');

const STATUS = {
  BAD_INPUT: 400,
  NO_API_KEY: 503,
  KUAICHA_CONFIG: 503,
  KUAICHA_AUTH: 401,
  KUAICHA_NO_BALANCE: 402,
  KUAICHA_RATE_LIMIT: 429,
  KUAICHA_TIMEOUT: 504,
  KUAICHA_NOT_FOUND: 404,
  KUAICHA_EMPTY: 422,
  KUAICHA_UPSTREAM: 502,
  KUAICHA_NETWORK: 502,
  KUAICHA_BAD_RESPONSE: 502,
  SEARCH_EMPTY: 422,
  SEARCH_NO_SOURCE: 422,
  SEARCH_NOT_USED: 502,
  SEARCH_ENDPOINT_FAIL: 502,
  INVALID_KEY: 401,
  NO_BALANCE: 402,
  RATE_LIMIT: 429,
  TIMEOUT: 504
};

/** 数据源只接受这三个值，其它一律当 auto，避免前端传错就报 400 */
function normalizeSource(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'kuaicha' || s === 'web') return s;
  return 'auto';
}

/**
 * @param {object} body 请求体，需要 company，可选 source
 * @param {string} ip 客户端标识，用于限流
 * @returns {Promise<{status:number,json:object}>}
 */
async function handleFacts(body, ip) {
  const company = String((body && body.company) || '').trim();
  const source = normalizeSource(body && body.source);

  if (!company) {
    return { status: 400, json: { ok: false, error: 'BAD_INPUT', message: '必须提供 company（企业全称）' } };
  }
  if (company.length > 60) {
    return { status: 400, json: { ok: false, error: 'BAD_INPUT', message: '企业全称过长（最多 60 字）' } };
  }

  const anySource = isKuaichaReady() || isReady();
  if (!anySource) {
    return {
      status: 503,
      json: {
        ok: false,
        error: 'NO_API_KEY',
        message: '未配置数据源：请设置 KUAICHA_API_KEY（快查企业数据）或 KIMI_API_KEY（联网检索）'
      }
    };
  }
  if (source === 'kuaicha' && !isKuaichaReady()) {
    return {
      status: 503,
      json: { ok: false, error: 'KUAICHA_CONFIG', message: '未配置 KUAICHA_API_KEY，无法使用快查数据源' }
    };
  }

  // 采集按次计费/占额度，同名的短时间内直接复用
  const key = `facts::${source}::${company}`;
  const cached = cacheGet(key);
  if (cached) return { status: 200, json: Object.assign({ ok: true, cached: true }, cached) };

  const rl = rateLimit(ip);
  if (!rl.ok) {
    return {
      status: 429,
      json: {
        ok: false,
        error: 'RATE_LIMIT',
        message: `请求过于频繁（每分钟 ${rl.limit} 次），请 ${rl.resetSec} 秒后再试`
      }
    };
  }

  try {
    const out = await collectFacts(company, { source });
    const payload = {
      company: out.company,
      facts: out.facts,
      sources: out.sources,
      missing: out.missing,
      note: out.note,
      via: out.via,
      attribution: out.attribution || null,
      rounds: out.rounds,
      ms: out.ms,
      model: out.model
    };
    cacheSet(key, payload);
    if (process.env.VERCEL) {
      console.log(
        '[facts] ' +
          JSON.stringify({
            company,
            via: out.via,
            fields: Object.keys(out.facts).length,
            sources: out.sources.length,
            ms: out.ms
          })
      );
    }
    return { status: 200, json: Object.assign({ ok: true, cached: false }, payload) };
  } catch (e) {
    const code = e.code || 'INTERNAL';
    if (process.env.VERCEL) {
      console.log(
        '[facts:error] ' +
          JSON.stringify({ company, source, code, message: e.message, detail: (e.detail || '').slice(0, 300) })
      );
    }
    return {
      status: STATUS[code] || 500,
      json: {
        ok: false,
        error: code,
        message: e.message,
        detail: e.detail ? String(e.detail).slice(0, 500) : undefined
      }
    };
  }
}

module.exports = { handleFacts, STATUS, normalizeSource };
