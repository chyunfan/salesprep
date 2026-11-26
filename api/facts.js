'use strict';

/**
 * Vercel Serverless 入口：POST /api/facts
 * 按企业全称采集公开信息，返回结构化事实集 + 来源。
 *
 * 采集优先级由环境变量决定：
 *   配了 KUAICHA_API_KEY → 走同花顺快查（结构化企业数据）
 *   没配                → 走大模型联网检索
 * 请求体可选 source: 'kuaicha' | 'web'，用于强制指定（排查数据源问题时有奇效）。
 *
 * 单独成接口而不是塞进 /api/llm，是因为它做的是"采集"：
 * 前端可以先拿到事实、把来源摆给客户经理看，再决定是否生成报告。
 * 两步分开也便于排查——报告不像样时，先看事实集是不是就没采到。
 */

const { handleFacts } = require('../lib/facts-api');

function getIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return null;
    }
  }
  return {};
}

module.exports = async function handler(req, res) {
  const origin = process.env.ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const body = getBody(req);
  if (!body) {
    res.status(400).json({ ok: false, error: 'BAD_BODY', message: '请求体不是合法 JSON' });
    return;
  }

  const r = await handleFacts(body, getIp(req));
  res.status(r.status).json(r.json);
};

/** 快查最多 8 个工具、联网检索可能多轮，留足时间 */
module.exports.config = { maxDuration: 300 };
