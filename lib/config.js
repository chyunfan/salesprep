'use strict';

/**
 * 配置读取。
 * 优先级：真实环境变量 > .env 文件 > 内置默认值。
 * 密钥只在服务端内存中存在，任何情况下不返回给前端。
 *
 * 变量名支持三种写法，按顺序取第一个有值的：
 *   KIMI_*      Kimi（月之暗面）开放平台，当前默认
 *   LLM_*       通用写法，接其它 OpenAI 兼容服务（含行内网关）时用
 *   DEEPSEEK_*  旧版变量名，保留向后兼容
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 极简 .env 解析，避免为一个变量引入 dotenv */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // 去掉包裹引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(ROOT, '.env'));

function pick(key, fallback) {
  const v = process.env[key];
  if (v !== undefined && v !== '') return v;
  if (fileEnv[key] !== undefined && fileEnv[key] !== '') return fileEnv[key];
  return fallback;
}

/**
 * 依次尝试多个变量名，取第一个非空值。
 * 按来源分层：先在整个真实环境变量里找（任何别名都算），再退到 .env 文件。
 * 否则 .env 里留着的 KIMI_* 模板行会把部署平台注入的 LLM_* 盖掉。
 */
function pickAny(keys, fallback) {
  for (const source of [process.env, fileEnv]) {
    for (const k of keys) {
      const v = source[k];
      if (v !== undefined && v !== '') return v;
    }
  }
  return fallback;
}

function num(key, fallback) {
  const v = Number(pick(key, ''));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 默认值取「开放平台」这一套：按量付费、通用、不依赖会员。
 * 地址与模型必须配对，串了就报模型不存在：
 *   开放平台  https://api.moonshot.cn/v1   kimi-k3 / kimi-k2.7-code / kimi-k2.6
 *   Kimi Code https://api.kimi.com/coding/v1  kimi-for-coding（背后是 K2.8 Preview）
 * 两套都用 KIMI_BASE_URL 与 KIMI_MODEL 覆盖，代码不做判断。
 */
const DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1';
const DEFAULT_MODEL = 'kimi-k3';

/** 补全常见漏写：Kimi 的端点必须带 /v1，而用户常只填域名 */
function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  if (!u) return DEFAULT_BASE_URL;
  if (/moonshot|kimi/i.test(u) && !/\/v\d+$/i.test(u)) u += '/v1';
  return u;
}

/** 从地址推断服务商，仅用于界面显示，不参与调用 */
function providerOf(url) {
  if (/moonshot|kimi/i.test(url)) return 'kimi';
  if (/deepseek/i.test(url)) return 'deepseek';
  try {
    return new URL(url).hostname.replace(/^api\./, '');
  } catch (_) {
    return 'openai-compatible';
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return '';
  }
}

/**
 * Vercel 平台上 VERCEL=1，用于给平台相关的默认值让路（如上传体积）。
 * 函数时长：开启了 Fluid compute 的项目，Hobby 也是 300 秒上限（vercel.json 已按此配置）；
 * 只有没开 Fluid 的旧项目才是 60 秒，那种情况需要显式调小 LLM_TIMEOUT_MS。
 */
const ON_VERCEL = Boolean(process.env.VERCEL);

const config = {
  root: ROOT,
  apiKey: pickAny(['KIMI_API_KEY', 'LLM_API_KEY', 'DEEPSEEK_API_KEY'], ''),
  baseUrl: normalizeBaseUrl(pickAny(['KIMI_BASE_URL', 'LLM_BASE_URL', 'DEEPSEEK_BASE_URL'], DEFAULT_BASE_URL)),
  model: pickAny(['KIMI_MODEL', 'LLM_MODEL', 'DEEPSEEK_MODEL'], DEFAULT_MODEL),

  port: num('PORT', 8787),
  timeoutMs: num('LLM_TIMEOUT_MS', 120000),
  maxTokens: num('LLM_MAX_TOKENS', 4096),
  temperature: (() => {
    const v = Number(pick('LLM_TEMPERATURE', '0.35'));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.35;
  })(),

  allowOrigin: pick('ALLOW_ORIGIN', '*'),
  rateLimitPerMin: num('RATE_LIMIT_PER_MIN', 12),
  cacheTtl: num('CACHE_TTL_SECONDS', 1800),
  auditLog: String(pick('AUDIT_LOG', 'true')).toLowerCase() !== 'false',

  // 批量导入客户清单：一次最多几户、服务端同时跑几户、每个请求带几户
  // chunk 是为了适配 Vercel 的函数时长上限——一次请求跑不完的户数，前端分几片发。
  batchMax: num('BATCH_MAX', 20),
  batchConcurrency: num('BATCH_CONCURRENCY', 2),
  batchChunk: num('BATCH_CHUNK', 3)
};

/**
 * 是否具备真实调用能力。
 * Kimi / DeepSeek 的密钥都以 sk- 开头；行内网关的密钥可能是自定义格式，
 * 因此这里只排除没填或填了占位符的情况，不做严格前缀校验。
 */
function isReady() {
  const k = String(config.apiKey || '').trim();
  if (k.length < 8) return false;
  if (/^(sk-)?(你的|填入|xxx+|changeme|placeholder|your[-_]?key)/i.test(k)) return false;
  return true;
}

/** 给前端看的能力矩阵，绝不包含密钥本身 */
function publicStatus() {
  return {
    live: isReady(),
    provider: providerOf(config.baseUrl),
    model: isReady() ? config.model : null,
    // 只回域名，便于排查"到底连的哪里"，不含路径与密钥
    host: hostOf(config.baseUrl),
    // 当前前端仍用 canvas 计算照片的客观指标，未走多模态调用。
    // Kimi K3.1 本身支持图像输入，要真接视觉见 README「已知边界」。
    vision: false,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
    // 前端据此提示"一次最多几户"，不必把数字写死在页面里
    maxBatch: config.batchMax,
    concurrency: config.batchConcurrency,
    // 前端按这个粒度分片请求：Vercel 上函数有时长上限，一次跑完整批会被掐断
    batchChunk: config.batchChunk,
    reason: isReady()
      ? null
      : '未配置 API Key（环境变量 KIMI_API_KEY），当前仅能以演示样例运行'
  };
}

module.exports = { config, isReady, publicStatus, providerOf, ROOT };
