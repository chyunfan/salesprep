'use strict';

/**
 * 本地/内网服务器。零依赖，node server.js 即可跑。
 * 若部署到 Vercel，本文件不参与，由 api/ 下的函数接管。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { config, publicStatus } = require('./lib/config');
const { handleJson, handleStream, handleBatch } = require('./lib/handler');
const { parseUpload } = require('./lib/sheet');

const PUBLIC_DIR = path.join(config.root, 'public');
const PORT = config.port;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.map': 'application/json'
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', config.allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 路径穿越防护
  const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      // 单页应用式兜底：找不到就回首页
      const index = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(index)) return serveStatic(req, res, '/index.html');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<h1>尚未构建前端</h1><p>先执行 <code>npm run build</code> 生成 public/index.html，再访问本页。</p>'
      );
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(abs).pipe(res);
  });
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/health') {
    const payload = {
      ok: true,
      service: 'salesprep',
      ...publicStatus(),
      time: new Date().toISOString()
    };
    // 与线上同口径的自检入口，见 api/health.js
    if (url.searchParams.get('probe') === '1') {
      try {
        const { probe } = require('./lib/kuaicha');
        payload.probe = await probe(url.searchParams.get('company') || '');
      } catch (e) {
        payload.probe = { ok: false, error: `${e.code || ''} ${e.message}`.trim() };
      }
    }
    return sendJson(res, 200, payload);
  }

  if (pathname === '/api/llm') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'BAD_BODY', message: e.message });
    }

    const ip = clientIp(req);

    // 流式：body.stream 或 ?stream=1
    const wantStream = body.stream === true || url.searchParams.get('stream') === '1';
    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      let closed = false;
      req.on('close', () => {
        closed = true;
      });

      const send = (event, data) => {
        if (closed) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const hb = setInterval(() => {
        if (!closed) res.write(': ping\n\n');
      }, 15000);

      try {
        await handleStream(body, { ip }, send);
      } catch (e) {
        send('error', { ok: false, error: 'INTERNAL', message: e.message });
      } finally {
        clearInterval(hb);
        if (!closed) res.end();
      }
      return;
    }

    const result = await handleJson(body, { ip });
    return sendJson(res, result.status, result.json);
  }

  /* 上传客户清单：JSON 里带 base64，避开 multipart——零依赖项目不想为它写解析器 */
  if (pathname === '/api/parse') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    let body;
    try {
      body = await readBody(req, 12 * 1024 * 1024);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'BAD_BODY', message: e.message });
    }
    const r = parseUpload(body);
    return sendJson(res, r.status, r.json);
  }

  /* 采集企业公开信息：与 Vercel 上的 api/facts.js 同源，逻辑都在 lib/facts-api.js。
     数据源由环境变量决定：配了 KUAICHA_API_KEY 走快查，否则走联网检索。 */
  if (pathname === '/api/facts') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });

    let body;
    try {
      body = await readBody(req, 1024 * 1024);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'BAD_BODY', message: e.message });
    }

    const { handleFacts } = require('./lib/facts-api');
    const r = await handleFacts(body, clientIp(req));
    return sendJson(res, r.status, r.json);
  }

  /* 批量生成：SSE 回推每一户的进度 */
  if (pathname === '/api/batch') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });

    let body;
    try {
      body = await readBody(req, 4 * 1024 * 1024);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'BAD_BODY', message: e.message });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    const send = (event, data) => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const hb = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15000);

    try {
      await handleBatch(body, { ip: clientIp(req) }, send);
    } catch (e) {
      send('error', { ok: false, error: 'INTERNAL', message: e.message });
    } finally {
      clearInterval(hb);
      if (!closed) res.end();
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  // 明确拒绝对 .env 的任何探测
  if (/\.env/i.test(pathname)) {
    res.writeHead(404).end('Not Found');
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  const s = publicStatus();
  const line = '─'.repeat(56);
  console.log(line);
  console.log('  营销助手 · 访前画像智能体（live 版）');
  console.log(line);
  console.log(`  地址      http://localhost:${PORT}`);
  console.log(`  模型      ${s.live ? s.model + '（' + s.provider + '）' : '未配置'}`);
  console.log(`  状态      ${s.live ? '● 已连接，可真实生成' : '○ 未配置密钥，仅演示样例'}`);
  if (!s.live) console.log(`  原因      ${s.reason}`);
  console.log(`  照片核验  本地客观指标 + 人工复核（未启用多模态识别）`);
  console.log(`  批量导入  单次最多 ${s.maxBatch} 户，服务端并发 ${s.concurrency}`);
  console.log(line);
  console.log('  按 Ctrl+C 停止');
});

process.on('SIGINT', () => {
  console.log('\n已停止。');
  process.exit(0);
});
