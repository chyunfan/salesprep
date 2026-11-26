'use strict';

/**
 * Vercel Serverless 入口：POST /api/batch
 * 批量生成客户画像，SSE 回推每一户进度。
 *
 * 注意：批量是长任务，20 户 × 25 秒 ÷ 2 并发 ≈ 250 秒。
 * 前端按 BATCH_CHUNK 分片发（默认 3 户一片），单请求约 40 秒，
 * 不会贴着函数时长上限跑；中途失败也只影响一片。
 */

const { handleBatch } = require('../lib/handler');

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
    await handleBatch(body, { ip: getIp(req) }, send);
  } catch (e) {
    send('error', { ok: false, error: 'INTERNAL', message: e.message });
  } finally {
    res.end();
  }
};

/** 单片批量约 40 秒，留足余量 */
module.exports.config = { maxDuration: 300 };
