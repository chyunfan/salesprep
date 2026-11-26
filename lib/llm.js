'use strict';

/**
 * 大模型调用封装（OpenAI 兼容）。
 * 当前接 Kimi（月之暗面），换厂商只需改 BASE_URL 与 MODEL，本文件无需改动。
 * 支持流式（SSE）与非流式两种模式。
 */

const { config } = require('./config');

class LLMError extends Error {
  constructor(code, message, status = 0, detail = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** 从模型返回的文本里兜底抽出 JSON 对象（应对没吃干净的 ```json 包裹） */
function extractJson(text) {
  if (!text || typeof text !== 'string') throw new LLMError('BAD_OUTPUT', '模型返回为空');
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch (_) {}

  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) {}
  }

  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = t.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (_) {}
  }
  throw new LLMError('BAD_OUTPUT', '模型返回的不是合法 JSON', 0, { head: t.slice(0, 200) });
}

/**
 * 发起一次对话请求。
 * @param {object} opt
 * @param {Array<{role:string,content:string}>} opt.messages
 * @param {boolean} [opt.stream] 是否流式
 * @param {(chunk:string, full:string)=>void} [opt.onDelta] 流式回调
 * @param {boolean} [opt.jsonMode] 是否要求 JSON 输出（流式时不建议开，靠提示词约束）
 * @returns {Promise<{text:string, usage:object, model:string, latencyMs:number}>}
 */
async function chat(opt) {
  const { messages, stream = false, onDelta, jsonMode = false } = opt;

  if (!config.apiKey) {
    throw new LLMError('NO_API_KEY', '服务端未配置 API Key（环境变量 KIMI_API_KEY）');
  }

  const url = `${config.baseUrl}/chat/completions`;
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: Boolean(stream)
  };
  if (jsonMode && !stream) body.response_format = { type: 'json_object' };
  if (stream) body.stream_options = { include_usage: true };

  const started = Date.now();

  /** 发一次请求，连同它的超时器一起返回（流式读取期间超时器要一直有效） */
  const send = async (payload) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          Accept: stream ? 'text/event-stream' : 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      return { res, timer };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new LLMError('TIMEOUT', `模型响应超时（>${Math.round(config.timeoutMs / 1000)} 秒）`);
      }
      throw new LLMError('NETWORK', `无法连接模型服务：${err.message}`);
    }
  };

  const readError = async (r) => {
    try {
      return (await r.text()).slice(0, 500);
    } catch (_) {
      return '';
    }
  };

  let { res, timer } = await send(body);

  if (!res.ok) {
    let detail = await readError(res);
    clearTimeout(timer);

    /*
     * 温度兜底。
     * Kimi Code 系列（kimi-for-coding、K3.1 Pro）只接受 temperature = 1，
     * 传 0.35 之类的值会被 400 直接拒掉："invalid temperature: only 1 is allowed"。
     * 这是服务端的硬约束，让用户去改配置不合理，就地按 1 重试一次。
     */
    if (res.status === 400 && /temperature/i.test(detail)) {
      const retry = await send(Object.assign({}, body, { temperature: 1 }));
      if (retry.res.ok) {
        console.warn(`[llm] ${config.model} 不接受 temperature=${config.temperature}，已按 1 重试成功`);
        res = retry.res;
        timer = retry.timer;
      } else {
        clearTimeout(retry.timer);
        detail = await readError(retry.res);
        throw new LLMError(
          'UPSTREAM',
          `模型服务返回 ${retry.res.status}（已按 temperature=1 重试）`,
          retry.res.status,
          detail
        );
      }
    } else if (res.status === 401) {
      throw new LLMError('INVALID_KEY', '密钥无效或已失效（401）', 401, detail);
    } else if (res.status === 402) {
      throw new LLMError('NO_BALANCE', '账户余额不足（402）', 402, detail);
    } else if (res.status === 429) {
      throw new LLMError('RATE_LIMIT', '触发上游限流（429）', 429, detail);
    } else if (/model|模型/i.test(detail) && /not.?found|not.?exist|invalid|不存在|无此|unknown/i.test(detail)) {
      /*
       * 地址与模型名不配对是最常见的配置错：
       * Kimi Code 的模型（kimi-for-coding）只在 api.kimi.com/coding/v1 上存在，
       * 开放平台的模型（kimi-k3 等）只在 api.moonshot.cn/v1 上存在，串了就是模型不存在。
       * 上游对这类错误不统一（有的 400 有的 404），所以按响应正文判断，把实际用的组合回显出来。
       */
      throw new LLMError(
        'MODEL_NOT_FOUND',
        `模型「${config.model}」在 ${config.baseUrl} 上不存在。` +
          '请确认 KIMI_MODEL 与 KIMI_BASE_URL 配对：Kimi Code 用 kimi-for-coding + api.kimi.com/coding/v1，' +
          '开放平台用 kimi-k3 + api.moonshot.cn/v1。',
        res.status,
        detail
      );
    } else {
      throw new LLMError('UPSTREAM', `模型服务返回 ${res.status}`, res.status, detail);
    }
  }

  /* ---------------- 非流式 ---------------- */
  if (!stream) {
    clearTimeout(timer);
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content || '';
    return {
      text,
      usage: json?.usage || {},
      model: json?.model || config.model,
      latencyMs: Date.now() - started
    };
  }

  /* ---------------- 流式 ---------------- */
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let usage = {};
  let model = config.model;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') continue;
          let evt;
          try {
            evt = JSON.parse(payload);
          } catch (_) {
            continue;
          }
          if (evt.model) model = evt.model;
          if (evt.usage) usage = evt.usage;
          const delta = evt?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            if (onDelta) onDelta(delta, full);
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (!full.trim()) throw new LLMError('BAD_OUTPUT', '模型返回为空（流式）');
  return { text: full, usage, model, latencyMs: Date.now() - started };
}

module.exports = { chat, extractJson, LLMError };
