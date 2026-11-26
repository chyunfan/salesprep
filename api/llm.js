'use strict';

/**
 * Vercel Serverless 入口：POST /api/llm
 * 与本地 server.js 共用 lib/handler.js，逻辑不分叉。
 */

const { handleJson, handleStream } = require('../lib/handler');

function getIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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

  const ip = getIp(req);
  const wantStream = body.stream === true || (req.query && req.query.stream === '1');

  if (!wantStream) {
    const r = await handleJson(body, { ip });
    res.status(r.status).json(r.json);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await handleStream(body, { ip }, send);
  } catch (e) {
    send('error', { ok: false, error: 'INTERNAL', message: e.message });
  } finally {
    res.end();
  }
};

/** 报告输出长。开启 Fluid compute 的项目各套餐都是 300 秒上限，与 vercel.json 保持一致 */
module.exports.config = { maxDuration: 300 };
