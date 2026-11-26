'use strict';

/**
 * 业务编排：一个入口，两种传输（JSON / SSE）。
 * server.js（本地）与 api/llm.js（Vercel）都只做传输适配，逻辑全在这里。
 */

const { config, isReady, publicStatus } = require('./config');
const { buildMessages } = require('./prompts');
const { chat, extractJson, LLMError } = require('./llm');
const { runChecks } = require('./validate');
const { rateLimit, cacheGet, cacheSet, cacheKey, audit } = require('./runtime');

const TASKS = new Set(['report', 'script']);

function bad(status, code, message, extra = {}) {
  return { status, json: { ok: false, error: code, message, ...extra } };
}

/** 入参校验 */
function parseInput(body) {
  if (!body || typeof body !== 'object') return { error: '请求体必须是 JSON 对象' };

  const task = String(body.task || '').trim();
  if (!TASKS.has(task)) {
    return { error: `task 必须是 ${[...TASKS].join(' 或 ')}；照片核验不经过模型，由前端本地计算` };
  }

  const company = String(body.company || '').trim();
  if (!company) return { error: '必须提供 company（企业全称）' };
  if (company.length > 60) return { error: 'company 过长（最多 60 字）' };

  const facts = body.facts;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts) || !Object.keys(facts).length) {
    return {
      error:
        'FACTS 不能为空。模型只允许基于你提供的事实组织内容，不接受"让它自己查"——那只会得到幻觉。'
    };
  }

  // 体积闸门：防止把整份材料塞进来
  const size = JSON.stringify(facts).length;
  if (size > 12000) return { error: `FACTS 过大（${size} 字符，上限 12000）` };

  return { task, company, facts, stream: Boolean(body.stream) };
}

/** 调模型 + 解析 + 校验，含一次自动重试 */
async function generate(task, payload, opt = {}) {
  const messages = buildMessages(task, payload);
  const { onDelta } = opt;

  let called = await chat({ messages, stream: Boolean(onDelta), onDelta, jsonMode: !onDelta });
  let data;
  let parseError = null;

  try {
    data = extractJson(called.text);
  } catch (err) {
    parseError = err;
  }

  let verdict = parseError
    ? { fatal: true, checks: { structure: [parseError.message], banned: [], unverified: [] } }
    : runChecks(task, data, payload.facts);

  /* 结构性失败 → 重试一次（非流式），把错误回灌给模型 */
  if (verdict.fatal) {
    if (opt.onRetry) opt.onRetry(verdict.checks.structure);

    const fixMessages = [
      ...messages,
      { role: 'assistant', content: called.text.slice(0, 2000) },
      {
        role: 'user',
        content: `上面的输出不符合要求：${verdict.checks.structure.join('；')}。请严格按规定的 JSON 结构重新输出完整对象，不要输出任何解释文字。`
      }
    ];

    called = await chat({ messages: fixMessages, stream: false, jsonMode: true });
    data = extractJson(called.text); // 二次失败直接抛 BAD_OUTPUT
    verdict = runChecks(task, data, payload.facts);

    /* 重试仍不合格：宁可失败，也不能把结构残缺的数据当成功交出去 */
    if (verdict.fatal) {
      throw new LLMError(
        'STRUCTURE',
        '模型两次输出的结构都不符合契约，已终止（不会把残缺数据交付给前端）',
        0,
        { errors: verdict.checks.structure }
      );
    }
  }

  return {
    data: verdict.data,
    checks: {
      pass: verdict.pass,
      structure: verdict.checks.structure,
      banned: verdict.checks.banned,
      unverified: verdict.checks.unverified,
      // 有瑕疵但可用：前端必须标注"存在未验证数字"
      degraded: !verdict.pass && !verdict.fatal
    },
    usage: called.usage,
    model: called.model,
    latencyMs: called.latencyMs
  };
}

/** 非流式：返回完整 JSON */
async function handleJson(body, ctx = {}) {
  const status = publicStatus();
  if (!status.live) {
    return bad(503, 'NO_API_KEY', status.reason, { status });
  }

  const input = parseInput(body);
  if (input.error) return bad(400, 'BAD_INPUT', input.error);

  const rl = ctx.skipRateLimit ? { ok: true } : rateLimit(ctx.ip);
  if (!rl.ok) {
    return bad(429, 'RATE_LIMIT', `请求过于频繁，请 ${rl.resetSec} 秒后再试`, { limit: rl });
  }

  const key = cacheKey(input.task, input.company, input.facts);
  const cached = cacheGet(key);
  if (cached) {
    audit({ task: input.task, company: input.company, ok: true, cache: true, ...cached.meta });
    return { status: 200, json: { ...cached, cache: true } };
  }

  try {
    const r = await generate(input.task, input, {
      onRetry: (errs) => audit({ task: input.task, company: input.company, ok: false, error: 'STRUCTURE_RETRY:' + errs.join('|') })
    });

    const out = {
      ok: true,
      task: input.task,
      data: r.data,
      checks: r.checks,
      meta: {
        model: r.model,
        latencyMs: r.latencyMs,
        tokens: r.usage,
        cache: false,
        at: new Date().toISOString()
      }
    };
    cacheSet(key, out);
    audit({
      task: input.task,
      company: input.company,
      model: r.model,
      latencyMs: r.latencyMs,
      usage: r.usage,
      outputChars: JSON.stringify(r.data).length,
      checks: { pass: r.checks.pass, banned: r.checks.banned.length, unverified: r.checks.unverified.length },
      ok: true
    });
    return { status: 200, json: out };
  } catch (err) {
    const e = err instanceof LLMError ? err : new LLMError('INTERNAL', err.message);
    const httpStatus = e.code === 'NO_API_KEY' ? 503 : e.code === 'INVALID_KEY' ? 502 : 502;
    audit({ task: input.task, company: input.company, ok: false, error: e.code + ':' + e.message });
    return bad(httpStatus, e.code, e.message, { detail: e.detail });
  }
}

/**
 * 流式：SSE。事件顺序
 *   meta  → 任务开始
 *   delta → 文本增量（供前端显示"正在生成"，不直接展示 JSON）
 *   retry → 结构不合格，正在重写
 *   result / error
 */
async function handleStream(body, ctx, send) {
  const status = publicStatus();
  if (!status.live) {
    send('error', { ok: false, error: 'NO_API_KEY', message: status.reason });
    return;
  }

  const input = parseInput(body);
  if (input.error) {
    send('error', { ok: false, error: 'BAD_INPUT', message: input.error });
    return;
  }

  const rl = ctx.skipRateLimit ? { ok: true } : rateLimit(ctx.ip);
  if (!rl.ok) {
    send('error', { ok: false, error: 'RATE_LIMIT', message: `请求过于频繁，请 ${rl.resetSec} 秒后再试` });
    return;
  }

  const key = cacheKey(input.task, input.company, input.facts);
  const cached = cacheGet(key);
  if (cached) {
    send('meta', { task: input.task, model: cached.meta.model, cache: true });
    send('result', { ...cached, cache: true });
    return;
  }

  send('meta', { task: input.task, model: config.model, cache: false });

  try {
    const r = await generate(input.task, input, {
      onDelta: (_chunk, full) => send('delta', { len: full.length, tail: full.slice(-40) }),
      onRetry: () => send('retry', { message: '输出结构不合格，正在重写（第 2 次）' })
    });

    const out = {
      ok: true,
      task: input.task,
      data: r.data,
      checks: r.checks,
      meta: {
        model: r.model,
        latencyMs: r.latencyMs,
        tokens: r.usage,
        cache: false,
        at: new Date().toISOString()
      }
    };
    cacheSet(key, out);
    audit({
      task: input.task,
      company: input.company,
      model: r.model,
      latencyMs: r.latencyMs,
      usage: r.usage,
      outputChars: JSON.stringify(r.data).length,
      checks: { pass: r.checks.pass, banned: r.checks.banned.length, unverified: r.checks.unverified.length },
      ok: true
    });
    send('result', out);
  } catch (err) {
    const e = err instanceof LLMError ? err : new LLMError('INTERNAL', err.message);
    audit({ task: input.task, company: input.company, ok: false, error: e.code + ':' + e.message });
    send('error', { ok: false, error: e.code, message: e.message, detail: e.detail });
  }
}

/* ------------------------------------------------------------------ 批量 */

/**
 * 批量生成：一次提交多户，服务端按并发逐户跑，用 SSE 回推进度。
 *
 * 为什么不干脆让前端循环调 /api/llm：那样 20 户会把自己的限流额度耗光（12 次/分钟），
 * 而且前端要自己管并发、重试、乱序。放在服务端整批只计一次额度，顺序也就稳了。
 *
 * 事件：start →（若干）item → done / error
 */
async function handleBatch(body, ctx, send) {
  const status = publicStatus();
  if (!status.live) {
    send('error', { ok: false, error: 'NO_API_KEY', message: status.reason });
    return;
  }

  const task = body && body.task === 'script' ? 'script' : 'report';
  const list = Array.isArray(body && body.rows) ? body.rows : [];

  if (!list.length) {
    send('error', { ok: false, error: 'BAD_INPUT', message: '清单为空：没有可生成的客户' });
    return;
  }
  if (list.length > config.batchMax) {
    send('error', {
      ok: false,
      error: 'TOO_MANY',
      message: `一次最多 ${config.batchMax} 户（当前 ${list.length} 户），请分批上传`
    });
    return;
  }

  const rl = ctx.skipRateLimit ? { ok: true } : rateLimit(ctx.ip);
  if (!rl.ok) {
    send('error', { ok: false, error: 'RATE_LIMIT', message: `请求过于频繁，请 ${rl.resetSec} 秒后再试` });
    return;
  }

  const items = list.map((r, i) => ({
    index: i,
    company: String((r && r.company) || '').trim(),
    facts: (r && r.facts) || {}
  }));

  const startedAt = Date.now();
  let cursor = 0;
  let doneCount = 0;
  let okCount = 0;
  const results = new Array(items.length);

  send('start', {
    total: items.length,
    task,
    model: status.model,
    concurrency: config.batchConcurrency
  });

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;

      const it = items[i];
      const t0 = Date.now();
      let rec;

      try {
        const r = await handleJson(
          { task, company: it.company, facts: it.facts },
          { ip: ctx.ip, skipRateLimit: true }
        );
        if (r.status === 200 && r.json && r.json.ok) {
          rec = {
            ok: true,
            data: r.json.data,
            checks: r.json.checks,
            meta: r.json.meta,
            cache: Boolean(r.json.cache)
          };
          okCount++;
        } else {
          rec = {
            ok: false,
            error: (r.json && r.json.message) || '生成失败',
            code: (r.json && r.json.error) || 'FAILED'
          };
        }
      } catch (err) {
        rec = { ok: false, error: err.message, code: 'INTERNAL' };
      }

      results[i] = rec;
      doneCount++;
      send('item', Object.assign({ index: i, company: it.company, ms: Date.now() - t0, done: doneCount }, rec));
    }
  };

  const n = Math.max(1, Math.min(config.batchConcurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));

  send('done', {
    ok: true,
    total: items.length,
    succeeded: okCount,
    failed: items.length - okCount,
    elapsedMs: Date.now() - startedAt
  });
}

module.exports = { handleJson, handleStream, handleBatch, parseInput, isReady, publicStatus };
