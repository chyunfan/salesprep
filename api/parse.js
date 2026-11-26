'use strict';

/**
 * Vercel Serverless 入口：POST /api/parse
 * 解析上传的客户清单（.xlsx / .csv）。与本地 server.js 共用 lib/sheet.js。
 */

const { parseUpload } = require('../lib/sheet');

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

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
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
  const r = parseUpload(body);
  res.status(r.status).json(r.json);
};

/** 文件解析很快，给 60 秒足够（与 vercel.json 一致） */
module.exports.config = { maxDuration: 60 };
