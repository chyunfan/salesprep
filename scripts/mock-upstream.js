'use strict';

/**
 * 本地仿真上游：完整模仿 OpenAI 兼容的 /chat/completions 的响应格式（含流式）。
 *
 * 用途：
 *   1. 没有 API Key 时联调前端（真实数据流、真实校验、真实渲染，只是内容是假的）
 *   2. 自测脚本的 fixture
 *
 *   node scripts/mock-upstream.js [port]
 *   然后把 .env 的 KIMI_BASE_URL 指向 http://127.0.0.1:18901
 *
 * 注意：它故意在输出里埋了一处禁词（走访）和一个编造数字（8888），
 * 用来验证校验层确实在工作——所以看到"校验有告警"是预期结果，不是 bug。
 */

const http = require('http');

const REPORT_OBJ = {
  company: '测试企业有限公司',
  summary: '该企业主营智能装备制造，注册资本 5000 万元人民币，参保 126 人，为省级专精特新中小企业。',
  chapters: [
    { no: '一', title: '核心结论', blocks: [{ type: 'para', text: '客户经理走访后确认，主营业务稳定，下游以快递与电商仓配为主。' }] },
    {
      no: '二', title: '企业总览',
      blocks: [{
        type: 'kv', rows: [
          { k: '注册资本', v: '5000 万元人民币' },
          { k: '参保人数', v: '126 人' },
          { k: '年产值', v: '{{ANNUAL_REVENUE}} 🔴 待客户经理补充' },
          { k: '行内存款', v: '{{DEPOSIT_BALANCE}} 🔴 待客户经理补充' }
        ]
      }]
    },
    { no: '三', title: '经营与资质', blocks: [{ type: 'list', items: ['省级专精特新中小企业（2025）', '主营交叉带分拣机、输送系统'] }] },
    { no: '四', title: '股权与实际控制人', blocks: [{ type: 'para', text: '陈某某持股 51%、表决权 51%。同名人物以「任职企业全称+时间段+职务」三要素锚定后排除，不臆断亲属关系。' }] },
    { no: '五', title: '行业环境', blocks: [{ type: 'para', text: '行业头部包括今天国际、诺力股份；政策方向为制造业设备更新与智能仓储推广。' }] },
    {
      no: '六', title: '可营销点与风险',
      blocks: [
        { type: 'list', items: ['专精特新贷：可用信用与知识产权增信', '应收账款融资：盘活已确认应收', '结算归集与代发：提升综合贡献'] },
        { type: 'list', items: ['下游账期普遍偏长，现金流需关注（营收规模 8888 万元待核实）'] }
      ]
    },
    { no: '七', title: '待核实事项', blocks: [{ type: 'list', items: ['行内存贷款与代发数据', '近两年实际营收与纳税额', '主要客户集中度'] }] }
  ],
  marketing_points: ['专精特新贷', '应收账款融资', '结算归集与代发'],
  risks: ['下游账期较长，回款节奏需关注'],
  gaps: ['行内存贷款数据', '近两年营收与纳税额', '主要客户集中度']
};

function sceneOf(name, when) {
  return {
    name,
    when,
    points: ['先用行业共性话题起头，降低对方戒备', '把话语权交给对方，多问少说', '落到经营近况，引出真实需求'],
    quotes: [
      '贵司注册资本 5000 万元人民币、参保 126 人，我们想先了解下今年的经营节奏。',
      '想请教一下，贵司在这行今年感受如何，比行业平均好还是差？',
      '贵司是省级专精特新中小企业（2025），这类企业我们通常配「专精特新贷 + 结算归集」，您看先从哪块聊更顺？'
    ],
    basis: '注册资本 5000 万元人民币、参保 126 人、省级专精特新中小企业（2025）'
  };
}

const SCRIPT_OBJ = {
  scenes: [
    sceneOf('① 破冰与开场', '首次见面 · 进门寒暄'),
    sceneOf('② 行业趋势', '对方话不多 · 出现冷场'),
    sceneOf('③ 痛点切入', '聊到回款 · 现金流'),
    sceneOf('④ 产品推荐', '需求确认后 · 方案介绍'),
    sceneOf('⑤ 异议处理与收尾', '客户犹豫 · 已有合作行')
  ],
  gaps: ['行内数据待补充']
};

function createMock(port = 18901) {
  // MOCK_DELAY_MS：人为放慢，用于验证进度条、分片、超时等与时间相关的行为。
  // 真实模型约 15–30 秒一户，本地仿真默认不拖时间。
  const delay = Math.max(0, Number(process.env.MOCK_DELAY_MS || 0));

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      const prompt = JSON.stringify(body.messages || []);
      // 用任务独有句判别，不能用宽泛的"话术"——report 的 system 里也含"营销话术"
      const isScript = prompt.includes('营销场景的话术') || prompt.includes('场景固定为');
      const obj = isScript ? SCRIPT_OBJ : REPORT_OBJ;
      const text = JSON.stringify(obj);

      const respond = () => {
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunks = text.match(/[\s\S]{1,80}/g) || [];
        let i = 0;
        const timer = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(timer);
            res.write('data: ' + JSON.stringify({ model: 'mock-kimi', usage: { total_tokens: 1200 }, choices: [{ delta: {} }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write('data: ' + JSON.stringify({
            model: 'mock-kimi',
            choices: [{ delta: { content: chunks[i] } }]
          }) + '\n\n');
          i++;
        }, 10);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock-kimi',
        usage: { prompt_tokens: 900, completion_tokens: 500, total_tokens: 1400 },
        choices: [{ message: { role: 'assistant', content: text } }]
      }));
      };

      if (delay) setTimeout(respond, delay);
      else respond();
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { createMock, REPORT_OBJ, SCRIPT_OBJ };

if (require.main === module) {
  const port = Number(process.argv[2] || 18901);
  createMock(port).then(() => {
    console.log('mock 上游已启动：http://127.0.0.1:' + port);
    console.log('把 .env 里的 KIMI_BASE_URL 指向它，KIMI_API_KEY 随便填一个 sk- 开头的值即可。');
    console.log('提示：输出里故意埋了禁词与编造数字，用于验证校验层。');
  });
}
