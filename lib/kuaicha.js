'use strict';

/**
 * 企业数据源 · 同花顺快查（MCP）。
 *
 * 为什么要它：
 *   联网检索是从网页里"读"信息，能读到的取决于网页写没写、写没写对；
 *   快查是结构化数据（注册资本、股东、实控人、被执行都是字段），更适合银行业务口径。
 *   所以采集层做成两档：配了快查就走快查，没配或查不到再回落联网检索。
 *
 * 配置全部来自环境变量，代码里不写死地址与密钥：
 *   KUAICHA_API_KEY      必填，配了才启用（唯一的开关），必须是在快查个人中心创建的 **MCP Key**
 *   KUAICHA_MCP_URL      可选，默认 https://bizveris.kuaicha365.com/mcp
 *                        （注意不是 /open/mcp，那是 OAuth 平台桥接口，用 MCP Key 打会 500）
 *   KUAICHA_AUTH_HEADER  可选，默认 open-authorization（官方口径），备选 Authorization
 *   KUAICHA_AUTH_SCHEME  可选，默认 Bearer；网关要裸 key 时设成空串
 *   KUAICHA_SOURCE       可选，默认不加；填了才作为 source 查询参数带上
 *   KUAICHA_TIMEOUT_MS   可选，单次调用超时
 *   KUAICHA_TOOLS        可选，覆盖默认取数工具集（逗号分隔）
 *
 * 协议：MCP Streamable HTTP（JSON-RPC 2.0），三步——
 *   initialize（拿 Mcp-Session-Id）→ notifications/initialized → tools/call。
 * 取数顺序（这一步很关键，详情接口只认工商全称）：
 *   1. 名称直查详情 basic_get_enterprise_basic_info
 *   2. 查不到 → basic_get_enterprise_associate 模糊搜索，用全称/简称/曾用名消歧后拿 orgid 再查
 *   3. 详情仍空 → 用模糊搜索那一行自带的工商字段兜底，并在 note 里注明降级
 *   4. 仍为空 → 带 source 再试一次（个别租户按渠道分流）
 *
 * 工具形态有两种，先 tools/list 判定：
 *   meta —— 只挂 discover / call，业务工具要 call{tool_id, params_to_tool} 包一层（官方就是这种）
 *   flat —— 业务工具直接挂出来，按名字调。
 * 响应可能是 application/json，也可能是 text/event-stream，两种都解析。
 * 服务端若返回会话失效，自动重开一次会话再试，不把这类抖动抛给用户。
 */

const { config, isKuaichaReady } = require('./config');
const { LLMError } = require('./llm');

/** 数据来源署名，按快查的使用条款要求，呈现结果时必须标注 */
const ATTRIBUTION = '同花顺旗下快查企业数据引擎';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'salesprep', version: '1.0' };

/**
 * 默认取数工具集。顺序即调用顺序参考，除基本信息外都是可失败的"增强项"：
 * 某一项查不到不影响整体，只会在 missing 里留痕。
 */
const DEFAULT_TOOLS = [
  'basic_get_enterprise_basic_info',
  'basic_get_enterprise_business_info',
  'basic_get_share_holder_info',
  'basic_get_actual_controller',
  'basic_get_invest_abroad',
  'justice_get_be_executed_person',
  'justice_get_discredited_executor',
  'operisk_get_abnormal_operation'
];

/* ------------------------------------------------------------------ 传输层 */

let sessionId = '';
let sessionOpening = null;
let reqSeq = 0;
/** 记住哪一头能过鉴权，避免每次都多花一次 401 */
let goodAuthHeader = '';
/**
 * 工具调用形态，两种都可能遇到：
 *   meta —— 网关只暴露 discover / call 两个元工具，业务工具要用 call 包一层（官方连接器就是这么走的）
 *   flat —— 网关把 155 个业务工具直接挂出来，按名字调
 * 首次调用前用 tools/list 判定一次，之后固定。
 */
let toolMode = '';
/** 某些租户按 source 分流，不带 source 会返回空；试通后记住，后续沿用 */
let preferredSource;
/** 会话初始化失败的原因。空结果时带上它，否则排查只看到"查不到"会误判成企业不存在 */
let sessionError = '';
/** 最近一次 tools/call 的原始响应摘要，用于空结果诊断 */
let lastCallSnapshot = '';
/** 最近一次 HTTP 响应的头部摘要，报文解析失败时用它代替"未返回可解析报文" */
let lastRawHead = '';

function authHeaderName() {
  return goodAuthHeader || config.kuaichaAuthHeader || 'open-authorization';
}

/**
 * @param {string} [sourceOverride] 传字符串则覆盖 source 参数（'' 表示不带）
 */
function endpoint(sourceOverride) {
  const raw = String(config.kuaichaUrl || '').trim();
  if (!raw) throw new LLMError('KUAICHA_CONFIG', '未配置 KUAICHA_MCP_URL');
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    throw new LLMError('KUAICHA_CONFIG', `KUAICHA_MCP_URL 不是合法地址：${raw}`);
  }
  // /open/mcp 是 OAuth 平台桥接口，拿 MCP Key 打过去只会 500。
  // 官方手册写死了企业数据用 /mcp，这里直接纠正并留日志，省得对着 500 猜。
  if (/\/open\/mcp\/?$/.test(u.pathname)) {
    console.warn('[kuaicha] KUAICHA_MCP_URL 指向 /open/mcp（OAuth 桥接口），已改用 /mcp');
    u.pathname = u.pathname.replace(/\/open\/mcp\/?$/, '/mcp');
  }
  // 渠道标识：默认按配置走，允许单次覆盖。
  // 官方连接器会带 source（workbuddy），有些租户按 source 分流，所以空结果时会补试一次。
  const src = sourceOverride === undefined ? config.kuaichaSource : sourceOverride;
  if (src) u.searchParams.set('source', src);
  return u.toString();
}

function headersFor(sid, headerName) {
  const name = headerName || authHeaderName();
  const key = String(config.kuaichaKey || '').trim();
  const scheme = String(config.kuaichaAuthScheme || '').trim();
  const out = {
    // 显式声明 UTF-8：企业名是中文，网关若按平台默认编码解包会变成乱码再判"查无此主体"
    'Content-Type': 'application/json; charset=utf-8',
    Accept: 'application/json, text/event-stream'
  };
  out[name] = scheme ? `${scheme} ${key}` : key;
  if (sid) out['Mcp-Session-Id'] = sid;
  return out;
}

/** 从 SSE 或纯 JSON 响应里取出 JSON-RPC 报文 */
function parseRpc(text, contentType) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const asSse = /text\/event-stream/i.test(contentType || '') || /^(event|data|id|retry):/m.test(raw);
  if (!asSse) {
    try {
      return JSON.parse(raw);
    } catch (_) {
      /* 落到下面按行找 JSON，兼容网关在 JSON 前后加了日志的情况 */
    }
  }

  const lines = raw.split(/\r?\n/);
  const payloads = [];
  let buf = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (buf.length) payloads.push(buf.join('\n'));
      buf = [];
      continue;
    }
    if (line.startsWith('data:')) buf.push(line.slice(5).trim());
  }
  if (buf.length) payloads.push(buf.join('\n'));

  for (let i = payloads.length - 1; i >= 0; i--) {
    const p = payloads[i];
    if (!p || p === '[DONE]') continue;
    try {
      const j = JSON.parse(p);
      if (j && (j.result !== undefined || j.error !== undefined)) return j;
    } catch (_) {
      /* 继续往前找 */
    }
  }
  return null;
}

/**
 * 发一次 JSON-RPC 请求。
 * 401 时换另一种鉴权头再试一次——快查网关口径是 Authorization，
 * 但历史文档里出现过 open-authorization，两种都试比让人猜更省事。
 */
async function post(body, sid, headerName, sourceOverride) {
  const url = endpoint(sourceOverride);
  const attempt = async (hName) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.kuaichaTimeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: headersFor(sid, hName),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      return { res, text };
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new LLMError(
          'KUAICHA_TIMEOUT',
          `快查接口超时（>${Math.round(config.kuaichaTimeoutMs / 1000)} 秒）`
        );
      }
      throw new LLMError('KUAICHA_NETWORK', `无法连接快查接口：${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  let { res, text } = await attempt(headerName);

  /*
   * 鉴权头换一次再试。除了标准的 401，网关有时把"头名不对"报成 500 并在正文里提授权，
   * 这种也按鉴权问题处理——否则会被当成上游故障，白白回落到质量更差的网页检索。
   */
  const authLike = res.status === 401 || (res.status === 500 && /authoriz|illegal|token|api.?key|unauthor/i.test(String(text)));
  if (authLike) {
    const used = (headerName || authHeaderName()).toLowerCase();
    const alt = used === 'authorization' ? 'open-authorization' : 'Authorization';
    const retry = await attempt(alt);
    if (retry.res.ok) {
      goodAuthHeader = alt;
      res = retry.res;
      text = retry.text;
    } else if (res.status === 401) {
      throw new LLMError(
        'KUAICHA_AUTH',
        '快查鉴权失败（401）。请确认 KUAICHA_API_KEY 有效，且与该网关要求的鉴权头一致（KUAICHA_AUTH_HEADER）',
        401,
        String(text).slice(0, 200)
      );
    }
  }

  if (!res.ok) {
    const snippet = String(text).slice(0, 300);
    if (res.status === 402) throw new LLMError('KUAICHA_NO_BALANCE', '快查账户额度不足（402）', 402, snippet);
    if (res.status === 429) throw new LLMError('KUAICHA_RATE_LIMIT', '快查接口限流（429）', 429, snippet);
    // 服务端错误把原文带上：500 这类只有网关自己知道为什么，藏起来等于没法排查
    const brief = String(text).replace(/\s+/g, ' ').slice(0, 120);
    throw new LLMError(
      'KUAICHA_UPSTREAM',
      `快查接口返回 ${res.status}${brief ? '：' + brief : ''}`,
      res.status,
      snippet
    );
  }

  const sid2 = res.headers.get('mcp-session-id');
  lastRawHead = `${res.status} ${res.headers.get('content-type') || ''} :: ${String(text)
    .replace(/\s+/g, ' ')
    .slice(0, 240)}`;
  return {
    json: parseRpc(text, res.headers.get('content-type')),
    text,
    sessionId: sid2 || ''
  };
}

/** 打开会话。拿不到 session id 也不报错——有的网关是无状态的，直接 tools/call 即可 */
async function openSession() {
  let sid = '';
  let failure = '';

  /*
   * 协议版本有多代，网关不一定都认。先按新版握手，被拒再退一版。
   * 两版都失败也不抛：有的网关无状态，不带会话照样能 tools/call；
   * 但把原因记在 sessionError 里，空结果时能立刻分辨"是没会话"还是"真没这家企业"。
   */
  for (const version of [PROTOCOL_VERSION, '2024-11-05']) {
    try {
      const { sessionId: got, json } = await post({
        jsonrpc: '2.0',
        id: ++reqSeq,
        method: 'initialize',
        params: { protocolVersion: version, capabilities: {}, clientInfo: CLIENT_INFO }
      });
      if (json && json.error) {
        failure = `${version}: ${json.error.message || JSON.stringify(json.error).slice(0, 120)}`;
        continue;
      }
      sid = got || '';
      break;
    } catch (e) {
      failure = `${version}: ${e.code || ''} ${e.message}`;
    }
  }

  sessionError = sid ? '' : failure;
  if (!sid && failure) console.warn(`[kuaicha] 会话初始化未拿到 session：${failure}`);

  sessionId = sid;
  if (sessionId) {
    // 通知没有 id，服务端按规范回 202 空体；失败也无所谓
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId).catch(() => {});
  }
  return sessionId;
}

async function ensureSession() {
  if (sessionId) return sessionId;
  if (!sessionOpening) {
    sessionOpening = openSession().finally(() => {
      sessionOpening = null;
    });
  }
  return sessionOpening;
}

function resetSession() {
  sessionId = '';
  sessionOpening = null;
}

const SESSION_HINTS = /session|initializ|not\s*initialized|expired|-32602|-32600/i;

/**
 * 判定网关的工具暴露形态。
 * 官方连接器（open/mcp）只挂 discover + call 两个元工具，业务工具藏在 call 后面；
 * 自建通道也可能把业务工具直接列出来。用一次 tools/list 问清楚，比猜稳。
 */
async function detectToolMode() {
  if (toolMode) return toolMode;
  try {
    const id = ++reqSeq;
    const sid = await ensureSession().catch(() => '');
    const { json } = await post({ jsonrpc: '2.0', id, method: 'tools/list' }, sid);
    const list = (json && json.result && json.result.tools) || [];
    const names = list.map((t) => String((t && t.name) || ''));
    if (names.includes('call')) toolMode = 'meta';
    else if (names.includes('basic_get_enterprise_basic_info')) toolMode = 'flat';
    else toolMode = 'meta';
  } catch (_) {
    // 连 tools/list 都拿不到时按官方连接器的形态试，错了还有下面的一次回退
    toolMode = 'meta';
  }
  return toolMode;
}

/** 把「业务工具 + 参数」翻译成当前网关认识的调用形态 */
function shapeCall(mode, toolId, args) {
  if (mode === 'flat') return { name: toolId, arguments: args || {} };
  return {
    name: 'call',
    arguments: {
      tool_id: toolId,
      params_to_tool: JSON.stringify(args || {})
    }
  };
}

/**
 * 一次 tools/call 的 result 里到底有没有业务内容。
 *
 * 为什么要单独判：网关对"工具名/参数不对"有时不报错，而是回 200 + 空 content。
 * 旧逻辑只把 error 当失败，空 content 会被当成"这家企业不存在"——
 * 一路降级三级全空，最后给人的结论却是"查无此主体"，方向完全错。
 */
function hasBizPayload(result) {
  if (!result) return false;
  if (result.status_code !== undefined) return true;
  if (result.structuredContent) return true;
  if (Array.isArray(result.content)) {
    return result.content.some((c) => c && typeof c.text === 'string' && c.text.trim());
  }
  // 少数网关把业务对象直接摊在 result 上
  return Boolean(result.data || result.list || result.corp_name);
}

/** 把 result 压成一句诊断摘要，空结果时替代"接口返回空结果"这种无信息量的话 */
function snapshotOf(result) {
  if (!result) return 'result=null';
  const keys = Object.keys(result).join(',') || '空对象';
  const texts = Array.isArray(result.content)
    ? result.content
        .filter((c) => c && typeof c.text === 'string')
        .map((c) => c.text)
        .join('')
    : '';
  const head = texts.replace(/\s+/g, ' ').slice(0, 220);
  return `keys=${keys}${result.isError ? ' isError=true' : ''} text=${head || '(空)'}`;
}

/** 调一个 MCP 工具，返回工具返回的 JSON（通常是 {status_code,status_msg,data}） */
async function callTool(toolId, args, opts) {
  const mode = await detectToolMode();
  const src = opts && opts.source !== undefined ? opts.source : preferredSource;

  const doCall = async (sid, m) => {
    const id = ++reqSeq;
    const shaped = shapeCall(m, toolId, args);
    const { json, sessionId: sid2 } = await post(
      { jsonrpc: '2.0', id, method: 'tools/call', params: shaped },
      sid,
      undefined,
      src
    );
    return { json, sid: sid2 || sid };
  };

  const sid = await ensureSession().catch(() => '');
  let { json } = await doCall(sid, mode);

  // 会话失效：重开一次再试。这类抖动不该让整份报告失败
  if (json && json.error && SESSION_HINTS.test(String(json.error.message || json.error.code || ''))) {
    resetSession();
    const sid2 = await ensureSession().catch(() => '');
    ({ json } = await doCall(sid2, mode));
  }

  /*
   * 形态猜错的兜底：网关回"未知工具"说明这个命名方式不对，
   * 换另一种形态再试一次，并把正确形态记住，后续同类调用不再白跑。
   */
  if (json && json.error && UNKNOWN_TOOL_HINTS.test(String(json.error.message || ''))) {
    const other = mode === 'meta' ? 'flat' : 'meta';
    const retry = await doCall(sessionId, other);
    if (!(retry.json && retry.json.error && UNKNOWN_TOOL_HINTS.test(String(retry.json.error.message || '')))) {
      toolMode = other;
      json = retry.json;
    }
  }

  /*
   * 形态猜错但网关不明说：200 + 空 content。这种必须也换形态试一次，
   * 否则会被误判成"企业不存在"，把真正的原因藏起来。
   */
  if (json && !json.error && !hasBizPayload(json.result)) {
    const other = mode === 'meta' ? 'flat' : 'meta';
    try {
      const retry = await doCall(sessionId || sid, other);
      if (retry.json && !retry.json.error && hasBizPayload(retry.json.result)) {
        console.warn(`[kuaicha] ${toolId} 在 ${mode} 形态下返回空，改用 ${other} 形态后取到数据`);
        toolMode = other;
        json = retry.json;
      }
    } catch (e) {
      console.warn(`[kuaicha] ${toolId} 换 ${other} 形态重试失败：${e.code || ''} ${e.message}`);
    }
  }

  if (!json) {
    // 解析不出 JSON-RPC：把原始响应头尾带上，否则只能对着"无报文"猜
    throw new LLMError(
      'KUAICHA_BAD_RESPONSE',
      `快查工具 ${toolId} 未返回可解析报文`,
      undefined,
      lastRawHead || '(空响应)'
    );
  }
  if (json.error) {
    throw new LLMError(
      'KUAICHA_UPSTREAM',
      `快查工具 ${toolId} 报错：${json.error.message || '未知错误'}`,
      undefined,
      JSON.stringify(json.error).slice(0, 300)
    );
  }

  lastCallSnapshot = snapshotOf(json.result);
  return unwrap(json.result);
}

/** 网关说"没这个工具"——多半是调用形态不对，不是真没有数据 */
const UNKNOWN_TOOL_HINTS = /未知工具|unknown\s*tool|tool\s*not\s*found|no\s*such\s*tool|不存在的工具|-32601/i;

/** 把 MCP 的 content 数组还原成业务 JSON */
function unwrap(result) {
  if (!result) return null;

  const texts = Array.isArray(result.content)
    ? result.content
        .filter((c) => c && typeof c.text === 'string')
        .map((c) => c.text)
        .join('')
    : '';

  if (texts) {
    try {
      return JSON.parse(texts);
    } catch (_) {
      /* 不是 JSON 就原样带上，让上层当"无结构化数据"处理 */
      return { status_code: -1, status_msg: texts.slice(0, 200), data: null };
    }
  }

  if (result.structuredContent) return result.structuredContent;
  return result;
}

/* ------------------------------------------------------------------ 字段映射 */

/** 从工具返回里取 data.list（各工具口径一致），拿不到就是空数组 */
function listOf(payload) {
  const data = payload && payload.data;
  if (!data) return [];
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data)) return data;
  return [];
}

function totalOf(payload) {
  const data = payload && payload.data;
  const n = Number(data && (data.total ?? data.show_total));
  return Number.isFinite(n) ? n : null;
}

/** 工具是否"查到了东西"：status_code 为 0 或有 data */
function okOf(payload) {
  if (!payload) return false;
  if (payload.status_code !== undefined) return Number(payload.status_code) === 0 && Boolean(payload.data);
  return Boolean(payload.data);
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function industryLine(d) {
  const parts = [d.big_industry, d.small_industry, d.third_industry, d.fourth_industry]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  // 去重后取最细的三级，避免"制造业 / 制造业 / 制造业"这种重复
  const uniq = parts.filter((x, i) => parts.indexOf(x) === i);
  return uniq.slice(0, 3).join(' / ');
}

function staffLine(d) {
  const n = String(d.social_staff_num || d.staff_num_range || '').trim();
  if (!n) return '';
  return /人/.test(n) ? n : `${n} 人（工商年报口径）`;
}

function holderLine(payload) {
  const list = listOf(payload);
  if (!list.length) return '';
  const names = list.slice(0, 6).map((h) => {
    const name = h.sponsor || h.holder_name || h.name || '';
    const kind = h.holder_type ? `（${h.holder_type}）` : '';
    return name ? name + kind : '';
  });
  const total = totalOf(payload);
  const head = names.filter(Boolean).join('、');
  if (!head) return '';
  return total && total > names.filter(Boolean).length ? `${head} 等，共 ${total} 名股东` : head;
}

function controllerLine(payload) {
  const list = listOf(payload);
  const c = list[0];
  if (!c) return '';
  const name = c.actual_controller_name || c.name || '';
  if (!name) return '';
  const ratio = c.held_ratio || c.hold_rate || '';
  const src = c.data_source ? `，${c.data_source}` : '';
  return ratio ? `${name}（合计持股 ${ratio}%${src}）` : `${name}${src}`;
}

function investLine(payload) {
  const list = listOf(payload);
  if (!list.length) return '';
  const names = list.slice(0, 5).map((x) => {
    const name = x.frgn_invest_corp_name || x.corp_name || x.name || '';
    const ratio = x.invest_ratio;
    return name ? (ratio != null ? `${name}（${ratio}%）` : name) : '';
  });
  const total = totalOf(payload);
  const head = names.filter(Boolean).join('、');
  if (!head) return '';
  return total && total > names.filter(Boolean).length
    ? `${head}等，共 ${total} 家对外投资`
    : `${head}，共 ${names.filter(Boolean).length} 家对外投资`;
}

/** 司法/经营风险统一成一句话："无记录"也要明确写出来，不能被当成"没查到" */
function riskLine(payload, label, emptyText) {
  if (!okOf(payload)) return '';
  const list = listOf(payload);
  const total = totalOf(payload);
  const n = total == null ? list.length : total;
  if (!n) return emptyText;
  const first = list[0] || {};
  const caseNo = first.case_no || first.an_no || first.case_num || first.anjian_hao || '';
  const court = first.exec_court || first.court || first.court_name || '';
  const extra = [caseNo, court].filter(Boolean).join(' · ');
  return `${label} ${n} 条${extra ? '，最近一条：' + extra : ''}`;
}

function businessLine(payload) {
  const b = listOf(payload)[0];
  if (!b) return { product: '', intro: '' };
  const product = [b.business, b.product_name].map((x) => clip(x, 60)).filter(Boolean).join('；');
  return { product, intro: clip(b.introduction, 280) };
}

/** 并发跑多个工具，限并发数，避免一次打满服务商 QPS */
async function runTools(toolIds, args, limit) {
  const out = {};
  const queue = toolIds.slice();
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        out[id] = { ok: true, payload: await callTool(id, args) };
      } catch (e) {
        out[id] = { ok: false, error: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit || 3, toolIds.length) }, worker));
  return out;
}

/* ------------------------------------------------------ 主体解析：名称 → orgid */

const cleanName = (s) => String(s || '').replace(/[\s\u3000]/g, '');

/** 去掉空字段，避免"注册资本为空字符串"被当成已采集 */
function prune(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    if (String(v == null ? '' : v).trim()) out[k] = v;
  }
  return out;
}

/**
 * 用「根据关键词模糊搜索匹配企业」把名称/简称/曾用名换成标准主体。
 *
 * 为什么必须有这一步：详情接口只认工商全称，少一个"股份"、多一个括号、
 * 或者客户经理只记得简称，都会直接返"未查询到该主体"，而主体其实明明存在。
 * 官方文档也把这一步写成"名称 → 统代/orgid 的入口"。
 * 顺带还能拿到简称、曾用名、电话、邮箱、社保人数这些详情接口不给的字段。
 */
async function resolveSubject(name) {
  const payload = await callTool('basic_get_enterprise_associate', { query: name });
  const list = listOf(payload).filter((x) => x && (x.corp_name || x.orgid));
  if (!list.length) return { pick: null, list };

  const target = cleanName(name);
  const exact = list.find((x) => cleanName(x.corp_name) === target);
  const short = list.find((x) => cleanName(x.short_name) === target);
  const former = list.find((x) => (x.former_name || []).some((n) => cleanName(n) === target));
  // 只有全称/简称/曾用名完全命中才算消歧成功；否则宁可让人补全，也不张冠李戴
  const pick = exact || short || former || (list.length === 1 ? list[0] : null);
  return { pick, list };
}

/** 模糊搜索的行本身就带一整套工商字段，详情接口不通时用它兜底 */
function factsFromAssociate(row) {
  if (!row) return {};
  const industry = [row.first_industry, row.second_industry, row.third_industry]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  return prune({
    企业名称: clip(row.corp_name, 60),
    统一社会信用代码: clip(row.creditcode, 30),
    成立日期: clip(row.established_date, 20),
    注册资本: clip(row.capital, 40),
    实缴资本: clip(row.actual_capital, 40),
    企业类型: clip(row.type, 40),
    所属行业: clip(industry.filter((x, i) => industry.indexOf(x) === i).slice(0, 3).join(' / '), 60),
    参保人数: clip(row.social_staff_num ? `${row.social_staff_num} 人（工商年报口径）` : '', 40),
    注册地址: clip(row.address, 120),
    经营范围: clip(row.operating_scope, 380),
    法定代表人: clip(row.legal_person, 30),
    登记状态: clip(row.state, 20),
    企业简称: clip(row.short_name, 40)
  });
}

/* ------------------------------------------------------------------ 采集入口 */

/**
 * 用快查采集一家企业的结构化事实。
 *
 * @param {string} company 企业全称（也接受统一社会信用代码）
 * @returns {Promise<{company:string,facts:object,sources:Array,missing:Array,note:string,via:string,ms:number,attribution:string}>}
 */
async function collectFactsViaKuaicha(company) {
  const name = String(company || '').trim();
  if (!name) throw new LLMError('BAD_INPUT', '必须提供企业全称');
  if (!isKuaichaReady()) throw new LLMError('KUAICHA_CONFIG', '未配置 KUAICHA_API_KEY');

  const started = Date.now();

  /* 第一步：按名称直查详情——最快的路径，命中就不再多花调用 */
  let rst = await callTool('basic_get_enterprise_basic_info', { corp_name: name });
  let subject = null;
  let degraded = '';

  /* 第二步：查不到就走官方推荐的「模糊搜索 → orgid → 详情」 */
  if (!okOf(rst)) {
    let resolved = null;
    try {
      resolved = await resolveSubject(name);
    } catch (e) {
      console.warn(`[kuaicha] 主体解析失败：${e.code || ''} ${e.message}`);
    }

    if (resolved && resolved.pick) {
      subject = resolved.pick;
      const retried = await callTool('basic_get_enterprise_basic_info', { orgid: subject.orgid });
      if (okOf(retried)) {
        rst = retried;
      } else {
        degraded = '详情接口返回空，已用模糊搜索命中的工商字段补齐';
      }
    } else if (resolved && resolved.list.length > 1) {
      const top = resolved.list.slice(0, 5).map((x) => x.corp_name).filter(Boolean);
      throw new LLMError(
        'KUAICHA_AMBIGUOUS',
        `「${name}」匹配到 ${resolved.list.length} 家候选，无法确定是哪一家。请填工商登记全称：${top.join('、')}`
      );
    } else {
      /*
       * 最后再试一把：官方连接器会带 source 参数，个别租户按 source 分流，
       * 不带就返回空。只试一次，通了就记住，后续调用沿用。
       */
      const retry = await callTool(
        'basic_get_enterprise_basic_info',
        { corp_name: name },
        { source: preferredSource || 'salesprep' }
      ).catch(() => null);
      if (retry && okOf(retry)) {
        preferredSource = preferredSource || 'salesprep';
        rst = retry;
      }
    }
  }

  const d = okOf(rst) && rst.data ? rst.data : null;
  const facts = d
    ? prune({
        企业名称: clip(d.corp_name, 60),
        统一社会信用代码: clip(d.creditcode, 30),
        成立日期: clip(d.established_date, 20),
        注册资本: clip(d.capital, 40),
        实缴资本: clip(d.actual_capital, 40),
        企业类型: clip(d.corp_type, 40),
        所属行业: clip(industryLine(d), 60),
        参保人数: clip(staffLine(d), 40),
        注册地址: clip(d.address, 120),
        经营范围: clip(d.operating_scope, 380),
        法定代表人: clip(d.legal_person, 30),
        登记状态: clip(d.state, 20)
      })
    : factsFromAssociate(subject);

  if (!Object.keys(facts).length) {
    // 两个入口都空：把上游原话、最后一次响应、会话状态全带出来。
    // 只写"查不到"会让人以为企业不存在，实际可能是会话没建立或形态不对。
    const said = [rst && rst.status_code, rst && rst.status_msg]
      .filter((x) => x !== undefined && x !== null && x !== '')
      .join(' / ');
    const detail = [
      `status=${said || 'empty'}`,
      '已尝试：名称直查、模糊搜索、带 source 重试',
      lastCallSnapshot ? `最后响应：${lastCallSnapshot}` : '',
      sessionError ? `会话异常：${sessionError}` : ''
    ]
      .filter(Boolean)
      .join('；');

    throw new LLMError(
      'KUAICHA_NOT_FOUND',
      `快查未查到「${name}」：${said || '接口返回空结果'}。请核对工商登记全称（可带上地区，如"杭州××有限公司"），或直接填统一社会信用代码；` +
        '若确认名称无误，请访问 /api/health?probe=1 查看接口原始响应',
      undefined,
      detail
    );
  }

  // 增强项：任何一个失败都不影响出报告，只在 missing 里留痕。
  // 已经解析出 orgid 就用 orgid 查——分支、简称这类名字详情接口不认，orgid 永远认。
  const tools = (config.kuaichaTools ? String(config.kuaichaTools).split(',') : DEFAULT_TOOLS)
    .map((s) => s.trim())
    .filter((s) => s && s !== 'basic_get_enterprise_basic_info');

  const args = subject && subject.orgid ? { orgid: subject.orgid } : { corp_name: name };
  const enrich = await runTools(tools, args, 3);

  const biz = enrich['basic_get_enterprise_business_info'];
  if (biz && biz.ok) {
    const b = businessLine(biz.payload);
    if (b.product) facts['主营产品或服务'] = b.product;
    if (b.intro) facts['企业简介'] = b.intro;
  }

  const holder = enrich['basic_get_share_holder_info'];
  if (holder && holder.ok) {
    const v = holderLine(holder.payload);
    if (v) facts['股东与持股'] = clip(v, 300);
  }

  const controller = enrich['basic_get_actual_controller'];
  if (controller && controller.ok) {
    const v = controllerLine(controller.payload);
    if (v) facts['实际控制人'] = clip(v, 160);
  }

  const invest = enrich['basic_get_invest_abroad'];
  if (invest && invest.ok) {
    const v = investLine(invest.payload);
    if (v) facts['对外投资'] = clip(v, 300);
  }

  const executed = enrich['justice_get_be_executed_person'];
  const discredited = enrich['justice_get_discredited_executor'];
  const abnormal = enrich['operisk_get_abnormal_operation'];

  const riskParts = [
    executed && executed.ok ? riskLine(executed.payload, '被执行人', '无被执行记录') : '',
    discredited && discredited.ok ? riskLine(discredited.payload, '失信被执行人', '无失信记录') : '',
    abnormal && abnormal.ok ? riskLine(abnormal.payload, '经营异常', '无经营异常记录') : ''
  ].filter(Boolean);
  if (riskParts.length) facts['涉诉与被执行'] = clip(riskParts.join('；'), 300);

  // 采集口径写进事实集，报告可引用，也便于事后追溯
  facts['信息采集方式'] = '同花顺快查企业数据引擎（结构化企业数据）';
  facts['信息采集时间'] = new Date().toISOString().slice(0, 10);

  const missing = [];
  for (const k of ['统一社会信用代码', '注册资本', '成立日期', '所属行业', '经营范围', '法定代表人', '股东与持股', '实际控制人', '涉诉与被执行']) {
    if (!facts[k]) missing.push(k);
  }

  // 快查是结构化接口，不是网页抓取，所以没有可点击的网页来源；
  // 用一条署名来源承载"出处"，前端会按类型分别展示。
  const sources = [
    {
      title: ATTRIBUTION,
      url: 'https://www.kuaicha365.com',
      kind: 'data_api',
      note: `结构化企业数据接口，查询对象：${facts.企业名称 || name}`
    }
  ];

  const noteParts = [
    `数据来自${ATTRIBUTION}，字段口径以工商登记与公开数据为准；未覆盖项已留空，请现场核实`
  ];
  if (facts.企业名称 && cleanName(facts.企业名称) !== cleanName(name)) {
    noteParts.push(`按工商全称「${facts.企业名称}」采集`);
  }
  if (degraded) noteParts.push(degraded);

  return {
    company: facts.企业名称 || name,
    facts,
    sources,
    missing,
    note: noteParts.join('；'),
    via: 'kuaicha',
    rounds: 1,
    ms: Date.now() - started,
    model: null,
    attribution: ATTRIBUTION
  };
}

/* ------------------------------------------------------------------ 链路自检 */

/**
 * 按真实链路逐步打网关，把每一步的原始响应摘要返回。
 *
 * 为什么需要它：线上与官方连接器的差异只可能落在传输层——
 * 会话有没有建立、调用形态对不对、参数是字符串还是对象、网关回的是空 content 还是业务空。
 * 这些在业务报错里已经区分不出来，用一次自检把全部假设同时验掉，比再猜三轮快。
 *
 * 只读诊断：不回显密钥，地址里的 source 打码，不写库。
 * 代价：会真实消耗 3~4 次快查调用额度。
 */
async function probe(company) {
  const name = String(company || '').trim() || '浙江富阳农村商业银行股份有限公司';
  const out = {
    ok: true,
    endpoint: endpoint().replace(/([?&]source=)[^&]*/g, '$1***'),
    authHeader: authHeaderName(),
    protocol: PROTOCOL_VERSION,
    hasKey: isKuaichaReady(),
    node: process.version,
    steps: []
  };

  if (!out.hasKey) {
    out.ok = false;
    out.error = '未配置 KUAICHA_API_KEY';
    return out;
  }

  const send = async (body, sid) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.kuaichaTimeoutMs);
    try {
      const res = await fetch(endpoint(), {
        method: 'POST',
        headers: headersFor(sid, null),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      return {
        status: res.status,
        ct: res.headers.get('content-type') || '',
        sid: res.headers.get('mcp-session-id') || '',
        text
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const record = (label, r, extra) => {
    const j = r ? parseRpc(r.text, r.ct) : null;
    const item = Object.assign(
      {
        step: label,
        http: r ? r.status : 'ERR',
        contentType: r ? r.ct : '',
        session: r && r.sid ? 'yes' : 'no',
        bodyHead: String((r && r.text) || '')
          .replace(/\s+/g, ' ')
          .slice(0, 260)
      },
      extra || {}
    );
    if (j && j.error) item.rpcError = String(j.error.message || JSON.stringify(j.error)).slice(0, 200);
    const u = j && j.result;
    if (u) {
      item.resultKeys = Object.keys(u).join(',');
      if (Array.isArray(u.content)) {
        const txt = u.content
          .filter((c) => c && typeof c.text === 'string')
          .map((c) => c.text)
          .join('');
        item.textHead = txt.replace(/\s+/g, ' ').slice(0, 300);
        try {
          const biz = JSON.parse(txt);
          item.biz = {
            status_code: biz.status_code,
            status_msg: biz.status_msg,
            hasData: Boolean(biz.data)
          };
        } catch (_) {
          /* 非 JSON，textHead 已留证 */
        }
      }
    }
    out.steps.push(item);
    return j;
  };

  const callBody = (toolId, args) => ({
    jsonrpc: '2.0',
    id: ++reqSeq,
    method: 'tools/call',
    params: { name: 'call', arguments: { tool_id: toolId, params_to_tool: JSON.stringify(args) } }
  });

  try {
    const init = await send({
      jsonrpc: '2.0',
      id: ++reqSeq,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }
    });
    const sid = init.sid;
    record('initialize', init);

    if (sid) record('notifications/initialized', await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid));

    const list = await send({ jsonrpc: '2.0', id: ++reqSeq, method: 'tools/list' }, sid);
    const lj = record('tools/list', list);
    out.tools = ((lj && lj.result && lj.result.tools) || []).map((t) => t && t.name).filter(Boolean);

    // 三种参数/形态各打一次，谁通一看就知道
    record('名称直查 · params_to_tool 字符串', await send(callBody('basic_get_enterprise_basic_info', { corp_name: name }), sid));
    record(
      '名称直查 · params_to_tool 对象',
      await send(
        {
          jsonrpc: '2.0',
          id: ++reqSeq,
          method: 'tools/call',
          params: {
            name: 'call',
            arguments: { tool_id: 'basic_get_enterprise_basic_info', params_to_tool: { corp_name: name } }
          }
        },
        sid
      )
    );
    record('模糊搜索 · query', await send(callBody('basic_get_enterprise_associate', { query: name }), sid));
  } catch (e) {
    out.ok = false;
    out.error = `${e.code || ''} ${e.message}`.trim();
  }

  return out;
}

module.exports = { collectFactsViaKuaicha, probe, ATTRIBUTION, DEFAULT_TOOLS };
