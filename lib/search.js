'use strict';

/**
 * 企业公开信息采集。
 *
 * 为什么要有这一层：
 *   报告层的事实纪律是「只允许使用传入的 facts，模型不得调用记忆」。
 *   但客户经理只输入一个企业名时，facts 从哪来？只能先采集。
 *   所以把「采集」和「组织」分开：本文件只负责把公开信息变成结构化事实，
 *   并且强制留下来源；没有来源的结论一律丢弃，绝不让模型凭记忆补空。
 *
 * 两档数据源：
 *   1. 快查（lib/kuaicha.js）：结构化企业数据，配了 KUAICHA_API_KEY 就优先走这条。
 *   2. 联网检索（本文件下半部分），两条通路，用同一把模型 key：
 *      a. 内置搜索工具 $web_search：官方契约，两轮 tool_calls。
 *      b. 裸搜索端点 {baseUrl}/search：不走模型，直接拿网页片段。
 *
 * 费用：$web_search 按次计费（官方页约 ¥0.03/次），一次采集通常触发 1-3 次。
 */

const { config, isReady, isKuaichaReady } = require('./config');
const { collectFactsViaKuaicha } = require('./kuaicha');
const { extractJson, LLMError } = require('./llm');

/** 内置联网工具的声明方式：type 必须是 builtin_function，且不能带 parameters schema */
const SEARCH_TOOL = [{ type: 'builtin_function', function: { name: '$web_search' } }];

/** 最多几轮工具调用；检索一个企业通常 1-2 轮，3 轮是安全上限 */
const MAX_ROUNDS = 3;

/**
 * 允许出现在事实集里的字段。
 * 这不是"必须全部填满"——检索不到就留空，报告层会自动降级成占位符。
 */
const FACT_KEYS = [
  '企业名称',
  '统一社会信用代码',
  '成立日期',
  '注册资本',
  '实缴资本',
  '企业类型',
  '所属行业',
  '参保人数',
  '注册地址',
  '经营范围',
  '法定代表人',
  '股东与持股',
  '实际控制人',
  '对外投资',
  '涉诉与被执行',
  '经营异常与处罚',
  '资质与荣誉',
  '主营产品或服务',
  '上下游与客户',
  '公开财务线索'
];

const SYSTEM = `你是商业银行对公业务的公开信息核验员。你的唯一任务是把一家企业的公开工商信息整理成结构化事实，供后续撰写访前报告使用。

【必须先检索】
第一步必须调用联网搜索工具（$web_search）。不要先给答案再补检索，也不要仅凭记忆作答。

【事实纪律（最高优先级）】
1. 每个字段的值只能来自本次检索到的网页原文。你的训练记忆里即使"知道"这家公司，也一律不得使用。
2. 检索结果没有覆盖的字段，值必须留空字符串 ""，并写入 missing 数组。禁止写"约""大概""不详，推测为"。
3. 禁止把相似企业、同名企业的信息张冠李戴。若检索结果明显对应多家不同企业，只采用能与企业全称完整匹配的那部分，其余留空，并在 note 中说明。
4. 数字保留原文写法（如"5,000 万元人民币"），不要换算单位、不要四舍五入、不要算比例。
5. 检索结果之间互相矛盾时，留空该字段并在 note 里写明"公开信息存在冲突"。

【输出】
只输出一个 JSON 对象，不要输出 markdown 代码块或任何解释文字。结构如下：
{
  "facts": {
    "企业名称": "工商登记全称",
    "统一社会信用代码": "",
    "成立日期": "",
    "注册资本": "",
    "实缴资本": "",
    "企业类型": "",
    "所属行业": "",
    "参保人数": "",
    "注册地址": "",
    "经营范围": "",
    "法定代表人": "",
    "股东与持股": "",
    "实际控制人": "",
    "对外投资": "",
    "涉诉与被执行": "",
    "经营异常与处罚": "",
    "资质与荣誉": "",
    "主营产品或服务": "",
    "上下游与客户": "",
    "公开财务线索": ""
  },
  "sources": [{ "title": "网页标题", "url": "https://..." }],
  "missing": ["检索不到的字段名"],
  "note": "一句话说明检索口径或冲突情况"
}

sources 必须至少包含一条本次真实检索到的网页，url 必须是 http(s) 开头的真实地址，不得编造。`;

/**
 * 判定"检索不到"的写法。
 * 注意不能写成 ^(|未提供|暂无) —— 第一个分支是空串时整个正则恒为真，会把所有值都判成空。
 * "无" 也只认单独出现或后面跟标点，否则"无锡市…"这种地址会被误杀。
 */
const EMPTY_WORDS = /^(?:未(?:能)?(?:检索|查询|找到|获取|披露|公开|提供|知悉)|暂无|不详|未知|无$|无[，,。；;、]|—+|-+|–+|n\/?a$|null$|待补充|未公开|不适用|不涉及)/i;

function isBlank(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  const s = String(v).trim();
  if (!s) return true;
  return EMPTY_WORDS.test(s) || s.length > 400;
}

/**
 * 单次 chat/completions 请求（带工具），自己实现是因为 lib/llm.js 的 chat()
 * 不支持 tools 与 tool_calls 回传，而检索必须走这条路。
 */
async function postChat(payload) {
  if (!config.apiKey) {
    throw new LLMError('NO_API_KEY', '服务端未配置 API Key（环境变量 KIMI_API_KEY）');
  }

  const url = `${config.baseUrl}/chat/completions`;

  const send = async (body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          Accept: 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      clearTimeout(timer);
      return { res, text };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new LLMError('TIMEOUT', `联网检索超时（>${Math.round(config.timeoutMs / 1000)} 秒）`);
      }
      throw new LLMError('NETWORK', `无法连接模型服务：${err.message}`);
    }
  };

  let { res, text } = await send(payload);

  // 与 llm.js 同一条兜底：kimi-for-coding 只接受 temperature=1
  if (!res.ok && res.status === 400 && /temperature/i.test(text)) {
    const retry = await send(Object.assign({}, payload, { temperature: 1 }));
    if (retry.res.ok) {
      res = retry.res;
      text = retry.text;
    } else {
      throw new LLMError('UPSTREAM', `模型服务返回 ${retry.res.status}`, retry.res.status, retry.text.slice(0, 500));
    }
  }

  if (!res.ok) {
    if (res.status === 401) throw new LLMError('INVALID_KEY', '密钥无效或已失效（401）', 401, text.slice(0, 300));
    if (res.status === 402) throw new LLMError('NO_BALANCE', '账户余额不足（402）', 402, text.slice(0, 300));
    if (res.status === 429) throw new LLMError('RATE_LIMIT', '触发上游限流（429）', 429, text.slice(0, 300));
    throw new LLMError('UPSTREAM', `模型服务返回 ${res.status}`, res.status, text.slice(0, 500));
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    throw new LLMError('BAD_OUTPUT', '模型返回的不是合法 JSON', 0, text.slice(0, 200));
  }
}

/**
 * 工具声明被拒（模型/端点不支持 builtin_function）——这类错误要回落而不是直接失败。
 *
 * 实测：Kimi Code 网关（kimi-for-coding）对带 tools 的请求回
 * `400 Invalid request: tokenization failed`，正文里连 tool 字样都没有，
 * 只按关键词判断会漏掉，于是整条采集直接失败。所以 400/404/422 一律当作
 * "这个入口不吃 tools"，转去试搜索端点。真正的参数错误也会因此多花一次请求，
 * 但比把用户挡在门外划算。
 */
function isToolUnsupported(err) {
  if (!err || err.code !== 'UPSTREAM') return false;
  if ([400, 404, 422, 405].includes(Number(err.status))) return true;
  const d = String(err.detail || '');
  return /tool|builtin|function|web_search|unsupported|not.?support|tokeniz/i.test(d);
}

/**
 * 通路一：内置 $web_search，两轮 tool_calls。
 * 第一轮模型只返回工具调用，客户端把 assistant 消息（含 reasoning_content）原样回传，
 * 再补一条 tool 消息把参数还给它，服务端才会真正执行搜索并给出正文。
 */
async function collectByBuiltinTool(company) {
  let messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `企业全称：${company}\n\n请先联网检索该企业的公开工商信息，再按约定结构输出 JSON。` }
  ];

  let searched = false;
  let usage = {};
  let model = config.model;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const json = await postChat({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      tools: SEARCH_TOOL
    });

    model = json.model || model;
    if (json.usage) usage = json.usage;

    const choice = (json.choices && json.choices[0]) || {};
    const msg = choice.message || {};

    if (choice.finish_reason === 'tool_calls' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      searched = true;
      // 原样回传：reasoning_content 是 K2.8 思考模式要求的字段，丢了会 400
      messages = messages.concat([msg]);
      for (const tc of msg.tool_calls) {
        const args = tc.function && tc.function.arguments;
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof args === 'string' ? args : JSON.stringify(args || {})
        });
      }
      continue;
    }

    if (!searched) {
      // 模型跳过了检索直接作答——这种内容不可信，逼它搜一次
      messages = messages.concat([
        msg && msg.content ? { role: 'assistant', content: msg.content } : null,
        { role: 'user', content: '你还没有调用联网搜索工具。请先调用 $web_search 检索该企业，再输出 JSON。' }
      ].filter(Boolean));
      continue;
    }

    return { text: msg.content || '', searched, rounds: round + 1, usage, model };
  }

  throw new LLMError('SEARCH_NOT_USED', '模型连续多轮未返回检索结果，可能是该模型入口不支持联网搜索');
}

/**
 * 通路二：搜索端点。不走模型，直接拿网页片段，再让模型只依据片段抽字段。
 *
 * 端点按官方契约优先：POST {baseUrl}/tools/search，字段 text_query / limit / timeout_seconds。
 * 之前用的 /search + query + maxResults 是老形态，留作兼容兜底。
 *
 * 审计误伤会重试一次：返回 websearch_audit_failed 时，
 * 用一个更短、更中性的查询（只留企业名）再要一次，很多人是被长查询里的
 * "注册资本/法定代表人"这类词组合触发的，不是真敏感。
 */
function arrayOfSearch(json) {
  const list = json && (json.search_results || json.results || json.data);
  return Array.isArray(list) ? list : [];
}

async function postSearch(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 45000));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    clearTimeout(timer);

    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      /* 非 JSON 交给下面的状态码判断 */
    }

    if (!res.ok) {
      const errType = String((json && json.error && json.error.type) || '');
      if (res.status === 401) {
        throw new LLMError('INVALID_KEY', '密钥无效或已失效（401）', 401, text.slice(0, 300));
      }
      if (res.status === 429) {
        throw new LLMError('RATE_LIMIT', '触发上游限流（429）', 429, text.slice(0, 300));
      }
      if (/audit|blocked|safety/i.test(errType + ' ' + text)) {
        throw new LLMError('SEARCH_BLOCKED', '检索请求被内容安全策略拦截', 0, text.slice(0, 300));
      }
      throw new LLMError('SEARCH_ENDPOINT_FAIL', `搜索端点返回 ${res.status}`, res.status, text.slice(0, 300));
    }
    return json;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof LLMError) throw err;
    if (err.name === 'AbortError') {
      throw new LLMError('SEARCH_ENDPOINT_FAIL', '搜索端点超时', 0, null);
    }
    throw new LLMError('SEARCH_ENDPOINT_FAIL', `搜索端点不可用：${err.message}`);
  }
}

async function collectBySearchEndpoint(company) {
  const base = String(config.baseUrl).replace(/\/+$/, '');
  const richQuery = `${company} 工商登记 注册资本 成立日期 法定代表人`;

  const shapes = [
    { path: '/tools/search', body: (q) => ({ text_query: q, limit: 8, timeout_seconds: 20 }) },
    { path: '/search', body: (q) => ({ query: q, maxResults: 8 }) }
  ];

  const errors = [];
  let list = [];
  let usedPath = '';

  for (const shape of shapes) {
    const queries = [richQuery, company];
    for (let i = 0; i < queries.length; i++) {
      try {
        const json = await postSearch(base + shape.path, shape.body(queries[i]));
        const got = arrayOfSearch(json);
        if (got.length) {
          list = got;
          usedPath = shape.path;
        }
        break;
      } catch (e) {
        errors.push(e);
        // 只有审计类错误值得换个短查询重试，其它错误换个端点更有效
        if (e.code !== 'SEARCH_BLOCKED') break;
      }
    }
    if (list.length) break;
  }

  if (!list.length) {
    const blocked = errors.find((e) => e.code === 'SEARCH_BLOCKED');
    const pick = blocked || errors[errors.length - 1];
    if (pick) throw pick;
    throw new LLMError('SEARCH_EMPTY', `检索「${company}」没有返回任何网页`);
  }

  const snippets = list.slice(0, 8).map((r, i) => {
    const title = r.title || r.name || r.site_name || '';
    const link = r.url || r.link || '';
    const body = r.snippet || r.text || r.content || r.description || r.summary || '';
    return `[${i + 1}] ${title}\nURL: ${link}\n${String(body).slice(0, 1200)}`;
  });

  const sources = list
    .map((r) => ({ title: r.title || r.name || r.site_name || '', url: r.url || r.link || '' }))
    .filter((s) => /^https?:\/\//i.test(s.url));

  const { chat } = require('./llm');
  const asked = await chat({
    messages: [
      { role: 'system', content: SYSTEM + '\n\n本次你无法调用工具，下面【检索片段】就是全部可用事实来源。' },
      {
        role: 'user',
        content: `企业全称：${company}\n\n【检索片段】\n${snippets.join('\n\n---\n\n')}\n\n请只依据上述片段，按约定结构输出 JSON。sources 直接使用片段里的 URL。`
      }
    ],
    jsonMode: true
  });

  const parsed = extractJson(asked.text);
  // 裸端点的来源以实际返回为准，模型回填的只作补充
  if (!parsed.sources || !parsed.sources.length) parsed.sources = sources;
  return { payload: parsed, searched: true, rounds: 1, usage: asked.usage, model: asked.model, endpoint: usedPath };
}

/** 规整：丢掉空值与超长值，去重来源 */
function normalize(payload, company) {
  const raw = (payload && payload.facts) || {};
  const facts = {};
  for (const k of FACT_KEYS) {
    const v = raw[k];
    if (isBlank(v)) continue;
    facts[k] = Array.isArray(v) ? v.filter((x) => !isBlank(x)) : String(v).trim();
  }

  const sources = []
    .concat(payload && payload.sources ? payload.sources : [])
    .filter((s) => s && /^https?:\/\//i.test(String(s.url || '')))
    .map((s) => ({ title: String(s.title || '').slice(0, 80), url: String(s.url).slice(0, 300) }))
    .filter((s, i, arr) => arr.findIndex((x) => x.url === s.url) === i)
    .slice(0, 8);

  const missing = Array.isArray(payload && payload.missing) ? payload.missing.slice(0, 20) : [];

  return { company, facts, sources, missing, note: String((payload && payload.note) || '').slice(0, 200) };
}

/**
 * 采集入口。
 *
 * 数据源优先级（可用 KUAICHA_* 环境变量决定第一档是否生效）：
 *   1. 快查（结构化企业数据）—— 配了 KUAICHA_API_KEY 就用它
 *   2. 联网检索（$web_search → /search 端点）—— 没配快查、或快查没查到/临时不可用时回落
 *
 * 只有两类快查错误不回落：鉴权失败与配置错误。这两种是"部署配错了"，
 * 静默换成网页检索会把问题藏起来，让人以为一切正常。
 *
 * @param {string} company 企业全称
 * @param {{source?:'auto'|'kuaicha'|'web'}} [opts] 强制指定数据源，便于排查
 * @returns {Promise<{company:string,facts:object,sources:Array,missing:Array,note:string,via:string,rounds:number,ms:number,model:string,attribution?:string}>}
 */
async function collectFacts(company, opts) {
  const name = String(company || '').trim();
  const source = (opts && opts.source) || 'auto';
  if (!name) throw new LLMError('BAD_INPUT', '必须提供企业全称');
  if (name.length > 60) throw new LLMError('BAD_INPUT', '企业全称过长（最多 60 字）');
  if (source !== 'web' && !isKuaichaReady() && source === 'kuaicha') {
    throw new LLMError('KUAICHA_CONFIG', '未配置 KUAICHA_API_KEY，无法使用快查数据源');
  }
  if (!isKuaichaReady() && !isReady()) {
    throw new LLMError('NO_API_KEY', '未配置任何数据源：KUAICHA_API_KEY 与 KIMI_API_KEY 都为空');
  }

  // 第一档：快查
  if (source !== 'web' && isKuaichaReady()) {
    try {
      return await collectFactsViaKuaicha(name);
    } catch (err) {
      const fatal = err.code === 'KUAICHA_AUTH' || err.code === 'KUAICHA_CONFIG' || err.code === 'BAD_INPUT';
      if (fatal || source === 'kuaicha') throw err;
      if (!isReady()) {
        // 没有大模型 key 就没有第二档，如实报快查的错
        throw err;
      }
      console.warn(`[facts] 快查不可用（${err.code}: ${err.message}），回落联网检索`);
      try {
        return await collectByWeb(name);
      } catch (err2) {
        err2.message = `${err2.message}（快查也失败：${err.message}）`;
        throw err2;
      }
    }
  }

  if (source === 'kuaicha') {
    throw new LLMError('KUAICHA_CONFIG', '未配置 KUAICHA_API_KEY，无法使用快查数据源');
  }

  return collectByWeb(name);
}

/** 第二档：联网检索。内置搜索工具不通就走裸搜索端点 */
async function collectByWeb(name) {
  const started = Date.now();
  let payload;
  let via = 'web_search';
  let rounds = 0;
  let model = config.model;

  try {
    const r = await collectByBuiltinTool(name);
    payload = extractJson(r.text);
    rounds = r.rounds;
    model = r.model;
  } catch (err) {
    if (!isToolUnsupported(err) && err.code !== 'SEARCH_NOT_USED') throw err;
    console.warn(`[search] 内置 $web_search 不可用（${err.code}: ${err.message}），回落搜索端点`);
    via = 'search_endpoint';
    let r;
    try {
      r = await collectBySearchEndpoint(name);
    } catch (err2) {
      /*
       * 两条都不通，说明这把 key 对应的入口根本没有联网检索能力。
       * 这时给出可执行的下一步，而不是把 "400/404" 原样丢给客户经理。
       */
      if ([400, 401, 403, 404, 405].includes(Number(err2.status))) {
        throw new LLMError(
          'SEARCH_UNSUPPORTED',
          '当前模型入口不支持联网检索（工具调用与搜索端点都不可用）。请配置 KUAICHA_API_KEY 使用快查数据，或改用「批量清单」上传企业材料',
          0,
          err2.detail || err2.message
        );
      }
      throw err2;
    }
    payload = r.payload;
    rounds = r.rounds;
    model = r.model;
  }

  const out = normalize(payload, name);
  out.via = via;
  out.rounds = rounds;
  out.ms = Date.now() - started;
  out.model = model;

  /*
   * 没有来源就不算采集成功。
   * 这条是本次改造的红线：宁可报错让客户经理换方式，也不返回一份无法溯源的事实集，
   * 否则下游报告会把"模型记忆"当"公开信息"用，风险比空白报告大得多。
   */
  if (!out.sources.length) {
    throw new LLMError('SEARCH_NO_SOURCE', `检索「${name}」没有得到可引用的网页来源，无法确认信息真实性`);
  }
  if (!Object.keys(out.facts).length) {
    throw new LLMError('SEARCH_EMPTY', `检索「${name}」未获取到任何可用字段，请核对全称或改用上传材料`);
  }

  // 采集口径写进事实集，报告可引用，也便于事后追溯
  out.facts['信息采集方式'] = via === 'web_search' ? '联网检索（内置搜索工具）' : '联网检索（搜索端点）';
  out.facts['信息采集时间'] = new Date().toISOString().slice(0, 10);
  out.facts['公开来源'] = out.sources
    .slice(0, 3)
    .map((s, i) => `${i + 1}. ${s.title || '来源'} ${s.url}`)
    .join('；');

  return out;
}

module.exports = { collectFacts, FACT_KEYS };
