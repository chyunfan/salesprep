'use strict';

/**
 * 端到端自测：不依赖真实 Kimi 账号。
 *
 * 起一个 mock 上游（完全仿真 OpenAI 兼容接口的响应格式），再起真实 server.js，
 * 用 HTTP 打过去，验证：健康检查、结构校验、禁词改写、事实比对、流式、缓存、限流。
 *
 *   node scripts/selftest.js
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const results = [];
let failed = 0;

function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, extra });
  if (!cond) failed++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
}

/* ---------------- mock 上游 ---------------- */

const REPORT_OBJ = {
  company: '测试企业有限公司',
  summary: '该企业主营智能装备制造。注册资本 5000 万元人民币。', // 5000 在 facts 里
  chapters: [
    { no: '一', title: '核心结论', blocks: [{ type: 'para', text: '客户经理走访后确认，主营业务稳定。' }] }, // 含禁词"走访"
    {
      no: '二', title: '企业总览',
      blocks: [{ type: 'kv', rows: [
        { k: '注册资本', v: '5000 万元人民币' },
        { k: '年产值', v: '{{ANNUAL_REVENUE}} 🔴 待客户经理补充' },
        { k: '参保人数', v: '126 人' }
      ] }]
    },
    { no: '三', title: '经营与资质', blocks: [{ type: 'list', items: ['省级专精特新中小企业（2025）'] }] },
    { no: '四', title: '股权与实控人', blocks: [{ type: 'para', text: '陈某某持股 51%。' }] },
    { no: '五', title: '行业环境', blocks: [{ type: 'para', text: '行业头部包括今天国际、诺力股份。' }] },
    {
      no: '六', title: '可营销点与风险',
      blocks: [
        { type: 'list', items: ['专精特新贷', '应收账款融资'] },
        { type: 'list', items: ['下游账期较长，营收达 8888 万元需核实'] } // 8888 不在 facts
      ]
    },
    { no: '七', title: '待核实事项', blocks: [{ type: 'list', items: ['行内存贷款数据'] }] }
  ],
  marketing_points: ['专精特新贷', '应收账款融资', '结算归集'],
  risks: ['下游账期较长'],
  gaps: ['行内存贷款数据待补充']
};

const SCRIPT_OBJ = {
  scenes: [1, 2, 3, 4, 5].map((i) => ({
    name: ['① 破冰与开场', '② 行业趋势', '③ 痛点切入', '④ 产品推荐', '⑤ 异议处理与收尾'][i - 1],
    when: '首次见面',
    points: ['要点一', '要点二', '要点三'],
    quotes: [
      '贵司注册资本 5000 万元人民币，我们想了解今年的经营节奏。',
      '想请教贵司在分拣设备这块的感受，比行业平均如何？',
      '贵司参保 126 人、省级专精特新，这类企业我们通常配结算归集。'
    ],
    basis: '注册资本 5000 万元人民币'
  })),
  gaps: ['行内数据待补充']
};

function startMock(port) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      const prompt = JSON.stringify(body.messages || '');
      const task = prompt.includes('营销场景的话术') ? 'script' : 'report';
      const obj = task === 'script' ? SCRIPT_OBJ : REPORT_OBJ;
      const text = JSON.stringify(obj);

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunks = text.match(/[\s\S]{1,80}/g) || [];
        let i = 0;
        const timer = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(timer);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write('data: ' + JSON.stringify({
            model: 'kimi-selftest',
            choices: [{ delta: { content: chunks[i] } }]
          }) + '\n\n');
          i++;
        }, 8);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'kimi-selftest',
        usage: { prompt_tokens: 900, completion_tokens: 500, total_tokens: 1400 },
        choices: [{ message: { role: 'assistant', content: text } }]
      }));
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

/* ---------------- 主流程 ---------------- */

const MOCK_PORT = 18901;
const APP_PORT = 18902;

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: APP_PORT, path: pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, text: out }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: APP_PORT, path: pathname }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, text: out }));
    }).on('error', reject);
  });
}

function streamPost(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(Object.assign({ stream: true }, body));
    const req = http.request(
      { host: '127.0.0.1', port: APP_PORT, path: pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let out = '';
        const events = [];
        res.on('data', (c) => {
          out += c;
          const parts = out.split('\n\n');
          out = parts.pop();
          for (const p of parts) {
            const m = /^event:\s*(\w+)\ndata:\s*(.*)$/m.exec(p.trim());
            if (m) events.push({ event: m[1], data: m[2] });
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, events }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('\n=== 营销助手 live 版 · 端到端自测 ===\n');

  const mock = await startMock(MOCK_PORT);
  console.log('mock 上游已启动 :' + MOCK_PORT);

  const app = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      KIMI_API_KEY: 'sk-selftest-0000',
      KIMI_BASE_URL: 'http://127.0.0.1:' + MOCK_PORT,
      KIMI_MODEL: 'kimi-selftest',
      PORT: String(APP_PORT),
      CACHE_TTL_SECONDS: '60',
      RATE_LIMIT_PER_MIN: '8',
      AUDIT_LOG: 'false',
      LLM_TIMEOUT_MS: '20000'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let appLog = '';
  app.stdout.on('data', (d) => (appLog += d));
  app.stderr.on('data', (d) => (appLog += d));

  // 等服务起来
  for (let i = 0; i < 40; i++) {
    try {
      await get('/api/health');
      break;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const FACTS = {
    注册资本: '5000 万元人民币',
    参保人数: '126 人',
    资质: ['省级专精特新中小企业（2025）'],
    股权结构: '陈某某持股 51%',
    行业头部: ['今天国际', '诺力股份']
  };

  try {
    /* 1. 健康检查 */
    const h = JSON.parse((await get('/api/health')).text);
    ok('健康检查返回 live=true', h.ok && h.live === true);
    ok('健康检查不泄露密钥', !JSON.stringify(h).includes('sk-'));
    ok('明确声明不具备视觉能力', h.vision === false);

    /* 2. 客户清单上传 + 批量生成 */
    const csv = '企业名称,注册资本,参保人数\n' +
      '杭州明远智能装备有限公司,5000 万元,126\n' +
      '宁波海川精密部件有限公司,1200 万元,58\n';
    const upRes = await post('/api/parse', {
      filename: '客户清单.csv',
      base64: Buffer.from(csv, 'utf8').toString('base64')
    });
    const upJson = JSON.parse(upRes.text || '{}');
    ok('清单上传解析成功', upRes.status === 200 && (upJson.rows || []).length === 2);
    ok('自动识别企业名称列', upJson.companyCol === '企业名称');

    const badFile = await post('/api/parse', {
      filename: 'x.pdf',
      base64: Buffer.from('not a table').toString('base64')
    });
    ok('非表格文件被拒绝', badFile.status === 400);

    const batchRes = await streamPost('/api/batch', {
      task: 'report',
      rows: [
        { company: '杭州明远智能装备有限公司', facts: FACTS },
        { company: '宁波海川精密部件有限公司', facts: FACTS }
      ]
    });
    const batchItems = batchRes.events
      .filter((e) => e.event === 'item')
      .map((e) => JSON.parse(e.data));
    const batchDone = batchRes.events.find((e) => e.event === 'done');
    ok('批量接口逐户回推', batchItems.length === 2);
    ok('批量每户均成功', batchItems.every((it) => it.ok));
    ok('批量汇总统计正确', Boolean(batchDone) && JSON.parse(batchDone.data).succeeded === 2);

    /* 3. 入参兜底 */
    const noFacts = await post('/api/llm', { task: 'report', company: '某公司', facts: {} });
    ok('空事实集被拒绝', noFacts.status === 400 && JSON.parse(noFacts.text).error === 'BAD_INPUT');
    const badTask = await post('/api/llm', { task: 'photo', company: '某公司', facts: FACTS });
    ok('非法 task 被拒绝', badTask.status === 400);

    /* 4. 报告：结构 + 禁词 + 事实比对 */
    const r1 = await post('/api/llm', { task: 'report', company: '测试企业有限公司', facts: FACTS });
    const j1 = JSON.parse(r1.text);
    ok('报告请求成功', r1.status === 200 && j1.ok === true);
    ok('七章结构完整', (j1.data.chapters || []).length === 7);
    ok('禁词"走访"已被改写', !JSON.stringify(j1.data).includes('走访') &&
      JSON.stringify(j1.checks.banned).includes('走访'));
    ok('改写后出现合规替代词', JSON.stringify(j1.data).includes('现场核实'));
    ok('编造数字 8888 被揪出', JSON.stringify(j1.checks.unverified).includes('8888'));
    ok('事实源内的 5000 未被误报', !JSON.stringify(j1.checks.unverified).includes('5000'));
    ok('占位符保留未被改写', JSON.stringify(j1.data).includes('{{ANNUAL_REVENUE}}'));
    ok('校验未整体通过（有告警）', j1.checks.pass === false && j1.checks.degraded === true);

    /* 4. 缓存 */
    const r2 = await post('/api/llm', { task: 'report', company: '测试企业有限公司', facts: FACTS });
    const j2 = JSON.parse(r2.text);
    ok('相同请求命中缓存', j2.cache === true && j2.meta.latencyMs === j1.meta.latencyMs);

    /* 5. 话术：结构契约 */
    const r3 = await post('/api/llm', { task: 'script', company: '测试企业有限公司', facts: FACTS });
    const j3 = JSON.parse(r3.text);
    ok('话术请求成功', j3.ok === true);
    ok('恰好 5 个场景', (j3.data.scenes || []).length === 5);
    ok('每个场景 3 条要点 + 3 种说法',
      j3.data.scenes.every((s) => s.points.length === 3 && s.quotes.length === 3));

    /* 6. 流式 */
    const st = await streamPost('/api/llm', { task: 'script', company: '流式测试企业', facts: FACTS });
    const evNames = st.events.map((e) => e.event);
    ok('流式返回 SSE 事件', st.status === 200 && evNames.includes('meta'));
    ok('流式有 delta 增量', evNames.filter((e) => e === 'delta').length > 3);
    const resEvt = st.events.find((e) => e.event === 'result');
    ok('流式最终返回 result', Boolean(resEvt));
    if (resEvt) {
      const d = JSON.parse(resEvt.data);
      ok('流式结果结构与非流式一致', d.ok && d.data.scenes.length === 5);
    }

    /* 7. 限流 */
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const r = await post('/api/llm', { task: 'script', company: '限流测试' + i, facts: FACTS });
      if (r.status === 429) { limited = true; break; }
    }
    ok('超过阈值触发限流 429', limited);

    /* 8. 密钥保护 */
    const html = (await get('/')).text;
    ok('首页可访问', html.includes('营销助手'));
    ok('首页已注入 live.js', html.includes('live.js'));
    ok('首页源码中不含密钥', !html.includes('sk-'));
  } catch (e) {
    console.error('\n自测过程异常：', e);
    failed++;
  } finally {
    app.kill();
    mock.close();
  }

  console.log('\n' + '─'.repeat(52));
  console.log(failed === 0 ? '全部通过：' + results.length + ' 项' : '失败 ' + failed + ' / ' + results.length + ' 项');
  if (failed && appLog) console.log('\n服务端输出：\n' + appLog.slice(-800));
  console.log('─'.repeat(52) + '\n');
  process.exit(failed === 0 ? 0 : 1);
})();
