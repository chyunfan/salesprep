/* ============================================================================
 * live.js —— 把演示页从"写死样例"接到真实大模型
 *
 * 做法：不重写页面，只覆盖四个入口
 *   startReport()        报告生成 → 调 /api/llm (task=report, stream)
 *   genScript()          话术生成 → 调 /api/llm (task=script, stream)
 *   openDeliverable()    交付物预览 → 渲染真实数据
 *   downloadDeliverable() 交付物下载 → 真实文件 / 打印为 PDF
 *
 * 未配置密钥或调用失败时，自动退回原有演示流程，并在界面明示原因——不静默假装成功。
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
   * 先抓住页面原有的函数引用，再做任何覆盖。
   * 顺序错了会把自己当成"原始实现"，降级时无限递归——这个坑踩过一次。
   * ---------------------------------------------------------------- */
  const LEGACY = {
    startReport: window.startReport,
    genScript: window.genScript,
    openDeliverable: window.openDeliverable
  };

  /* ---------------------------------------------------------------- 状态 */

  const STATE = {
    ready: false,
    model: null,
    busy: false,
    report: null,      // 最近一次真实报告
    script: null,      // 最近一次真实话术
    checks: null,
    facts: null,       // 当前使用的事实集
    factsName: '',
    factsFor: null,    // 事实集归属的企业全称。A 企业的事实绝不能写进 B 企业的报告
    sources: null,     // 采集时命中的来源，供人工核对
    via: null,         // kuaicha（快查结构化数据）| web_search | search_endpoint
    attribution: null, // 数据源署名，快查要求呈现时标注
    sample: false,     // 当前报告是否基于内置样例
    lastError: null,
    mode: 'demo'       // demo | live
  };

  /** 内置脱敏样例事实：演示不依赖任何接口，且保证模型有据可依 */
  const SAMPLE_FACTS = {
    企业名称: '杭州明远智能装备有限公司',
    统一社会信用代码: '91330100MA2XXXXX0K（脱敏）',
    成立日期: '2013-06-18',
    注册资本: '5000 万元人民币',
    实缴资本: '5000 万元（全额实缴）',
    企业类型: '有限责任公司（自然人投资或控股）',
    所属行业: '智能物流分拣装备制造（C3492 连续搬运设备制造）',
    参保人数: '126 人',
    注册地址: '杭州市余杭区某某街道某某路 18 号（脱敏）',
    经营范围: '智能物流分拣设备、输送系统、自动化仓储设备的研发、制造、销售与技术服务',
    主营产品: '交叉带分拣机、摆轮分拣机、输送系统',
    下游客户: '快递企业、电商仓配中心',
    资质: ['省级专精特新中小企业（2025）', 'ISO9001 质量管理体系认证', '高新技术企业'],
    股权结构: '陈某某持股 51%、表决权 51%；杭州某某投资合伙企业持股 30%；其余 19% 由 3 名自然人均分',
    法定代表人: '陈某某',
    实际控制人: '陈某某（2013-06 起任执行董事、经理）',
    同名核验: '检索到 3 位同名自然人（分别任职于建材贸易、餐饮企业），以"任职企业全称+时间段+职务"三要素锚定后排除，不臆断亲属关系',
    涉诉情况: '近三年 3 起买卖合同纠纷，其中 2 起为原告追讨货款，均已结案',
    行业头部: ['今天国际', '诺力股份'],
    政策动向: ['制造业设备更新', '智能仓储推广'],
    行内数据: '未提供（存款、贷款、代发等一律标记待补充，禁止估算）'
  };

  const TASK_LABEL = { report: '企业画像报告', script: '营销话术' };

  /** 样例企业全称：只有查询这一家时，才允许用内置样例 */
  const SAMPLE_COMPANY = SAMPLE_FACTS.企业名称;

  /** 归一化企业名：去空格、括号统一，用于判定"是不是样例企业" */
  function normName(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .replace(/[（]/g, '(')
      .replace(/[）]/g, ')')
      .toUpperCase();
  }

  function isSampleCompany(name) {
    const n = normName(name);
    if (!n) return false;
    return n === normName(SAMPLE_COMPANY) || n.indexOf('明远智能装备') >= 0;
  }

  /* ---------------------------------------------------------------- 工具 */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 高亮占位符与待补充红标 */
  function rich(s) {
    return esc(s)
      .replace(/\{\{([A-Z0-9_]+)\}\}/g, '<code class="fx-ph">{{$1}}</code>')
      .replace(/🔴\s*待客户经理补充/g, '<span class="fx-todo">🔴 待客户经理补充</span>');
  }

  function toastSafe(msg, ms) {
    try {
      if (typeof toast === 'function') { toast(msg); return; }
    } catch (_) {}
    console.log('[fxhy]', msg);
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* ---------------------------------------------------------------- SSE */

  /**
   * 调 /api/llm 并读取 SSE 流。
   * @param {object} body 请求体
   * @param {object} hooks {onMeta,onDelta,onRetry,onResult,onError}
   */
  async function callStream(body, hooks) {
    const res = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ stream: true }, body))
    });

    if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
      const j = await res.json();
      throw Object.assign(new Error(j.message || '请求失败'), { code: j.error });
    }
    if (!res.body) throw new Error('当前浏览器不支持流式读取');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let result = null;
    let error = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);

        let event = 'message';
        const dataLines = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;

        let payload;
        try { payload = JSON.parse(dataLines.join('\n')); } catch (_) { continue; }

        if (event === 'meta') hooks.onMeta && hooks.onMeta(payload);
        else if (event === 'delta') hooks.onDelta && hooks.onDelta(payload);
        else if (event === 'retry') hooks.onRetry && hooks.onRetry(payload);
        else if (event === 'result') result = payload;
        else if (event === 'error') error = payload;
      }
    }

    if (error) {
      throw Object.assign(new Error(error.message || '生成失败'), { code: error.error, detail: error.detail });
    }
    if (!result) throw Object.assign(new Error('连接中断，未收到完整结果'), { code: 'NO_RESULT' });
    return result;
  }

  /* ---------------------------------------------------------------- 事实采集 */

  /**
   * 按企业全称联网采集公开信息。
   * 这是"真实企业出真实报告"的唯一入口——采集失败就抛错，不拿样例顶上。
   */
  async function fetchFacts(company) {
    const res = await fetch('/api/facts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company })
    });
    let j = {};
    try {
      j = await res.json();
    } catch (_) {
      /* 网关返回非 JSON（如超时页）时按状态码报错 */
    }
    if (!res.ok || !j.ok) {
      const err = new Error(j.message || '检索公开信息失败（HTTP ' + res.status + '）');
      err.code = j.error || 'FACTS_FAILED';
      err.detail = j.detail || '';
      throw err;
    }
    return j;
  }

  /**
   * 把错误码翻译成下一步动作。
   * 报告与话术两条路径共用，避免出现"报告里提示了、话术里没提示"。
   */
  function adviceFor(err) {
    const code = err && err.code;
    if (code === 'SEARCH_NO_SOURCE' || code === 'SEARCH_EMPTY') {
      return '未获取到可引用的公开信息：请核对全称是否与工商登记一致，或改用「批量清单」上传该企业的材料。';
    }
    if (code === 'SEARCH_UNSUPPORTED') {
      return '当前 KIMI 入口不支持联网检索，且快查不可用：请在服务端配置 KUAICHA_API_KEY，或改用「批量清单」上传材料。';
    }
    if (code === 'KUAICHA_NOT_FOUND') {
      return '快查未收录该主体：请核对工商登记全称（可用统一社会信用代码），或改用「批量清单」上传材料。';
    }
    if (code === 'KUAICHA_AUTH') {
      return '快查鉴权失败：请在服务端核对 KUAICHA_API_KEY 是否为「MCP Key」，以及 KUAICHA_AUTH_HEADER。';
    }
    if (code === 'KUAICHA_UPSTREAM' || code === 'KUAICHA_BAD_RESPONSE') {
      return '快查接口异常：多半是 Key 类型不对或额度为空，请到 open.kuaicha365.com 用户中心确认；也可改用「批量清单」上传材料。';
    }
    if (code === 'NO_API_KEY') {
      return '服务端未配置数据源（KUAICHA_API_KEY 或 KIMI_API_KEY），无法采集企业信息与生成内容。';
    }
    return '';
  }

  /**
   * 保证事实集与当前查询企业一致。
   * 优先级：同名缓存/手工编辑过的事实 > 样例企业走内置样例 > 联网检索。
   * 关键点：factsFor 记录事实归属，换企业必然重新采集，杜绝张三的名单写进李四的报告。
   */
  async function ensureFacts(company, onStage) {
    const say = (m) => { if (typeof onStage === 'function') onStage(m); };

    if (isSampleCompany(company)) {
      STATE.facts = SAMPLE_FACTS;
      STATE.factsFor = company;
      STATE.sources = null;
      STATE.via = null;
      STATE.attribution = null;
      STATE.sample = true;
      STATE.factsName = '内置脱敏样例';
      updateFactsName();
      return { facts: SAMPLE_FACTS, sample: true, sources: [] };
    }

    if (STATE.factsFor === company && STATE.facts && Object.keys(STATE.facts).length) {
      say('复用已采集的事实集');
      return { facts: STATE.facts, sample: false, sources: STATE.sources || [] };
    }

    say('正在采集「' + company + '」的企业信息…');
    const j = await fetchFacts(company);

    STATE.facts = j.facts || {};
    STATE.factsFor = company;
    STATE.sources = j.sources || [];
    STATE.via = j.via || null;
    STATE.attribution = j.attribution || null;
    STATE.sample = false;
    STATE.factsName = sourceLabel(j);
    updateFactsName();

    say('已获取 ' + Object.keys(STATE.facts).length + ' 项事实');
    return { facts: STATE.facts, sample: false, sources: STATE.sources, meta: j };
  }

  /** 事实源的中文口径：快查是结构化接口，联网检索是网页，两者不能混着说 */
  function sourceLabel(j) {
    if (j && j.via === 'kuaicha') return '快查企业数据';
    const n = ((j && j.sources) || []).length;
    return n ? '联网检索 ' + n + ' 个来源' : '联网检索';
  }

  /* ---------------------------------------------------------------- 界面：状态徽标 */

  function paintBadge() {
    let el = $('fxLiveBadge');
    if (!el) {
      const bar = document.querySelector('.topbar');
      if (!bar) return;
      el = document.createElement('span');
      el.id = 'fxLiveBadge';
      el.className = 'fx-badge';
      const anchor = bar.querySelector('.badge');
      bar.insertBefore(el, anchor || null);
    }
    if (STATE.mode === 'live') {
      el.className = 'fx-badge fx-on';
      el.innerHTML = '● LIVE<span class="fx-badge-sub">' + esc(STATE.model || 'kimi') + '</span>';
      el.title = '已连接大模型，生成内容为实时产出';
    } else {
      el.className = 'fx-badge fx-off';
      el.innerHTML = '○ DEMO<span class="fx-badge-sub">样例数据</span>';
      el.title = STATE.lastError || '未连接大模型，当前展示内置样例';
    }
  }

  /* ---------------------------------------------------------------- 界面：事实来源条 */

  function paintFactsBar() {
    if ($('fxFactsBar')) return;
    const panel = $('panel-report');
    const row = panel && panel.querySelector('.input-row');
    if (!row) return;

    const bar = document.createElement('div');
    bar.id = 'fxFactsBar';
    bar.className = 'fx-factsbar';
    bar.innerHTML =
      '<span class="fx-fb-k">事实源</span>' +
      '<span class="fx-fb-v" id="fxFactsName"></span>' +
      '<button class="fx-fb-btn" onclick="fxhyFacts()">查看 / 编辑</button>' +
      '<button class="fx-fb-btn" onclick="fxhySources()">来源</button>' +
      '<button class="fx-fb-btn" onclick="fxhyBatch()">📋 批量清单</button>' +
      '<span class="fx-fb-tip">事实按查询企业实时采集；查不到的字段写成占位符，不编造</span>';
    row.parentNode.insertBefore(bar, row.nextSibling);

    // 话术面板也提示一句，避免两边事实不一致造成误解
    const sPanel = $('panel-script');
    const sRow = sPanel && sPanel.querySelector('.input-row');
    if (sRow && !$('fxFactsBar2')) {
      const b2 = document.createElement('div');
      b2.id = 'fxFactsBar2';
      b2.className = 'fx-factsbar fx-factsbar-lite';
      b2.innerHTML = '<span class="fx-fb-k">事实源</span><span class="fx-fb-v">与企业画像共用同一份事实集，确保两个能力口径一致</span>';
      sRow.parentNode.insertBefore(b2, sRow.nextSibling);
    }
    updateFactsName();
  }

  function updateFactsName() {
    const el = $('fxFactsName');
    if (!el) return;
    const n = Object.keys(STATE.facts || {}).length;
    el.textContent = (STATE.factsName || '内置脱敏样例') + ' · ' + n + ' 项';
  }

  /* ---------------------------------------------------------------- 界面：事实编辑 */

  window.fxhyFacts = function fxhyFacts() {
    const cur = JSON.stringify(STATE.facts || SAMPLE_FACTS, null, 2);
    const html =
      '<div class="fx-facts-modal">' +
      '<p class="fx-hint">这些是模型唯一可用的事实。生产环境接入工商 / 司法接口后由系统自动填充；' +
      '演示时可手工修改，改完点「应用」立即生效。</p>' +
      '<textarea id="fxFactsInput" spellcheck="false">' + esc(cur) + '</textarea>' +
      '<div class="fx-facts-actions">' +
      '<button class="btn" onclick="fxhyFactsReset()">恢复样例</button>' +
      '<span style="flex:1"></span>' +
      '<button class="btn" onclick="closeModal()">取消</button>' +
      '<button class="btn primary" onclick="fxhyFactsApply()">应用</button>' +
      '</div></div>';
    openModal('事实来源（JSON）', html);
    const foot = $('modalFoot');
    if (foot) foot.classList.remove('on');
  };

  /** 把采集用到的公开网页摆出来，让客户经理能逐个点开核对 */
  window.fxhySources = function () {
    const src = STATE.sources || [];
    const who = STATE.factsFor || '';
    let body;

    if (src.length && STATE.via === 'kuaicha') {
      body =
        '<p class="fx-hint">「' + esc(who) + '」的事实来自' + esc(STATE.attribution || '快查企业数据引擎') +
        '，是结构化企业数据（工商登记、股东、实控人、涉诉均为字段），不是网页抓取，' +
        '因此没有可逐个点开的原文页面。</p>' +
        '<ul class="fx-src-list">' +
        '<li><a href="https://www.kuaicha365.com" target="_blank" rel="noopener noreferrer">' +
        esc(STATE.attribution || '快查企业数据引擎') + '</a><span>结构化企业数据接口</span></li>' +
        '</ul>' +
        '<p class="fx-hint">数据接口返回的是"登记口径"结论，登记状态、注册资本变更可能有滞后；' +
        '涉及授信决策时，建议再核对营业执照与最新工商变更。</p>';
    } else if (src.length) {
      body =
        '<p class="fx-hint">以下是本次为「' + esc(who) + '」采集事实时命中并引用的公开网页。' +
        '注册资本、股东、涉诉这类关键数字，建议点开原文核对后再用于客户沟通。</p>' +
        '<ul class="fx-src-list">' +
        src
          .map(
            (s) =>
              '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' +
              esc(s.title || s.url) + '</a><span>' + esc(s.url) + '</span></li>'
          )
          .join('') +
        '</ul>';
    } else if (isSampleCompany(who)) {
      body =
        '<p class="fx-hint">当前使用内置脱敏样例（' + esc(SAMPLE_COMPANY) + '），没有外部来源。' +
        '换成真实企业全称后，系统会联网检索，并在这里列出可核对的网页。</p>';
    } else {
      body = '<p class="fx-hint">当前事实集来自手工填写或清单导入，没有外部网页来源。</p>';
    }

    openModal('事实来源', body);
    const foot = $('modalFoot');
    if (foot) foot.classList.remove('on');
  };

  window.fxhyFactsReset = function () {
    const ta = $('fxFactsInput');
    if (ta) ta.value = JSON.stringify(SAMPLE_FACTS, null, 2);
  };

  window.fxhyFactsApply = function () {
    const ta = $('fxFactsInput');
    if (!ta) return;
    let obj;
    try {
      obj = JSON.parse(ta.value);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('必须是对象');
    } catch (e) {
      toastSafe('JSON 格式有误：' + e.message);
      return;
    }
    STATE.facts = obj;
    STATE.factsName = '自定义事实集';
    /*
     * 手工改过的事实要绑定到当前输入的企业名上，否则下次生成又会被重新检索覆盖，
     * 客户经理刚补的存款、授信数据就白填了。
     */
    const el = $('companyInput');
    const cur = ((el && el.value) || '').trim();
    if (cur) STATE.factsFor = cur;
    STATE.sources = null;
    STATE.via = 'manual';
    STATE.attribution = null;
    STATE.sample = false;
    updateFactsName();
    closeModal();
    toastSafe('事实已更新，共 ' + Object.keys(obj).length + ' 项');
  };

  /* ---------------------------------------------------------------- 报告渲染 */

  /** 把"事实比对未通过"的数字在正文里标出来——看得见才管得住 */
  function markUnverified(html) {
    const toks = Array.from(new Set(((STATE.checks && STATE.checks.unverified) || []).map((u) => u.token)))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (!toks.length) return html;

    return String(html)
      .split(/(<[^>]+>)/)
      .map((part) => {
        if (part.startsWith('<')) return part;
        let out = part;
        for (const t of toks) {
          if (!t) continue;
          out = out.split(t).join('<mark class="fx-unv-mark" title="该数字在事实源中找不到原值">' + t + '</mark>');
        }
        return out;
      })
      .join('');
  }

  function blockHtml(b) {
    if (!b || typeof b !== 'object') return '';
    if (b.type === 'kv' && Array.isArray(b.rows)) {
      const rows = b.rows.map((r) =>
        '<tr><td class="fx-k">' + rich(r.k || '') + '</td><td>' + markUnverified(rich(r.v || '')) + '</td></tr>'
      ).join('');
      return '<table class="fx-table">' + rows + '</table>';
    }
    if (b.type === 'list' && Array.isArray(b.items)) {
      return '<ul class="fx-list">' + b.items.map((t) => '<li>' + markUnverified(rich(t)) + '</li>').join('') + '</ul>';
    }
    if (b.type === 'para') return '<p class="fx-p">' + markUnverified(rich(b.text || '')) + '</p>';
    return '';
  }

  /**
   * 银行内部业务字段。
   * 这类数据只存在于行内系统（存款、贷款、代发、结算…），公开渠道永远查不到，
   * 联网采集来的事实集里必然为空。所以不能让它占着正文的版面写一长串"未提供"。
   */
  const INNER_KEY_RE = /行内|银行内部|本行|存款|贷款|授信|代发|结算账户|结算量|开户|理财|票据|中间业务|综合贡献|信用评级|日均余额/;
  /* 同样不能写 ^(|待补充) —— 空分支会让正则恒真，把有数值的行也折叠掉 */
  const BLANK_VAL_RE = /^(?:—+|-+|–+|待补充|未提供|暂无|不详|未知|不适用|n\/?a$|待客户经理补充|需补充|需核实|无$|无[，,。；;])/i;

  /** 判断某一行是不是"行内业务 + 空值"——是的话收进折叠区 */
  function isInnerBlank(k, v) {
    if (!INNER_KEY_RE.test(String(k || ''))) return false;
    const s = String(v == null ? '' : v)
      .replace(/🔴\s*待客户经理补充/g, '')
      .replace(/\{\{[^}]*\}\}/g, '')
      .trim();
    if (!s) return true;
    return BLANK_VAL_RE.test(s);
  }

  /** 折叠区：交互版默认收起，打印版展开成普通章节（归档件要完整） */
  function innerFoldHtml(rows, expand) {
    if (!rows.length) return '';
    const table =
      '<table class="fx-table fx-inner-table"><tbody>' +
      rows
        .map(
          (r) =>
            '<tr><td class="fx-k">' + rich(r.k || '') + '</td><td>' +
            markUnverified(rich(String(r.v || '').replace(/🔴\s*待客户经理补充/g, '') || '待客户经理补充')) +
            '</td></tr>'
        )
        .join('') +
      '</tbody></table>';

    if (expand) {
      return (
        '<section class="fx-chap fx-inner-section"><h4>银行内部业务数据（待补充）</h4>' + table + '</section>'
      );
    }
    return (
      '<details class="fx-inner-fold">' +
      '<summary>银行内部业务数据 · ' + rows.length + ' 项待补充' +
      '<span class="fx-inner-hint">点开填写，公开渠道无法获取</span></summary>' +
      table +
      '</details>'
    );
  }

  /** 打印版的来源脚注：归档件必须能回溯到具体出处 */
  function sourcesFooter() {
    const list = STATE.sources || [];
    if (!list.length) return '';

    if (STATE.via === 'kuaicha') {
      return (
        '<div class="fx-sources"><b>数据来源</b>' +
        '<div style="margin-top:4px">' + esc(STATE.attribution || '同花顺旗下快查企业数据引擎') +
        '（结构化企业数据接口）</div>' +
        '<div class="fx-src-note">以上字段取自工商登记与公开企业数据，口径为登记值。' +
        '登记状态、注册资本变更可能存在滞后，授信决策前请复核营业执照与最新工商变更；' +
        '接口未覆盖的字段已在正文以占位符标出。</div></div>'
      );
    }

    return (
      '<div class="fx-sources"><b>公开信息来源</b><ol>' +
      list
        .map((s) => '<li>' + esc(s.title || '来源') + ' — ' + esc(s.url || '') + '</li>')
        .join('') +
      '</ol><div class="fx-src-note">以上为联网检索命中的公开网页。涉及注册资本、股东、涉诉等关键数字，' +
      '请点开原文核对后再用于客户沟通；检索结果不保证完整，缺失项已在正文以占位符标出。</div></div>'
    );
  }

  /** 报告正文（弹窗与下载共用）；opts.expandInner 为 true 时行内数据不折叠 */
  function reportBodyHtml(rep, opts) {
    if (!rep) return '<p class="fx-p">暂无数据</p>';
    const o = opts || {};
    const innerRows = [];

    const chapters = (rep.chapters || [])
      .map((c) => {
        const body = (c.blocks || [])
          .map((b) => {
            if (!b || b.type !== 'kv' || !Array.isArray(b.rows)) return blockHtml(b);

            const kept = [];
            for (const r of b.rows) {
              if (isInnerBlank(r && r.k, r && r.v)) innerRows.push(r);
              else kept.push(r);
            }
            if (!kept.length) return '';
            return blockHtml(Object.assign({}, b, { rows: kept }));
          })
          .join('');
        if (!body.trim()) return '';
        return '<section class="fx-chap"><h4>' + rich((c.no ? c.no + '、' : '') + (c.title || '')) + '</h4>' + body + '</section>';
      })
      .join('');

    const inner = innerFoldHtml(innerRows, Boolean(o.expandInner));

    const mp = (rep.marketing_points || []).length
      ? '<div class="fx-side"><b>可营销点</b><ul>' + rep.marketing_points.map((t) => '<li>' + markUnverified(rich(t)) + '</li>').join('') + '</ul></div>' : '';
    const rk = (rep.risks || []).length
      ? '<div class="fx-side fx-side-warn"><b>风险提示</b><ul>' + rep.risks.map((t) => '<li>' + markUnverified(rich(t)) + '</li>').join('') + '</ul></div>' : '';
    const gp = (rep.gaps || []).length
      ? '<div class="fx-side fx-side-gap"><b>待现场核实</b><ul>' + rep.gaps.map((t) => '<li>' + markUnverified(rich(t)) + '</li>').join('') + '</ul></div>' : '';

    return (
      '<div class="fx-report">' +
      '<div class="fx-rep-head"><div class="fx-rep-name">' + rich(rep.company || '') + '</div>' +
      '<div class="fx-rep-sum">' + rich(rep.summary || '') + '</div></div>' +
      chapters +
      (mp || rk || gp ? '<div class="fx-sides">' + mp + rk + gp + '</div>' : '') +
      inner +
      checkStrip() +
      '</div>'
    );
  }

  /** 校验结果条：把服务端的 checks 如实展示 */
  function checkStrip() {
    const c = STATE.checks;
    if (!c) return '';
    const banned = c.banned || [];
    const unv = c.unverified || [];
    const okCls = c.pass ? 'fx-ok' : 'fx-warn';
    const parts = [];
    parts.push('<span class="' + okCls + '">' + (c.pass ? '✓ 校验通过' : '⚠ 校验有告警') + '</span>');

    // 只报数量与改写后的词，不复述禁词原文——否则全文检索仍会命中
    const replaced = Array.from(new Set(banned.map((b) => b.to))).join('、');
    parts.push('禁词 ' + banned.length + ' 处' + (banned.length ? '（已改写为「' + esc(replaced) + '」）' : ''));

    parts.push('事实比对未通过 ' + unv.length + ' 处');
    if (unv.length) {
      parts.push('<span class="fx-unv">' + esc(unv.slice(0, 6).map((u) => u.token).join('、')) + '</span>');
    }
    return '<div class="fx-checks"><b>强制校验</b> ' + parts.join(' · ') +
      (unv.length
        ? '<div class="fx-checks-note">标红数字在事实源中找不到原值，请人工核对后再使用；核实后请更新事实源，不要直接引用。</div>'
        : '') +
      '</div>';
  }

  /* ---------------------------------------------------------------- 可打印文档 */

  /** A4 打印样式：单户文档与批量汇总共用，保证两处版式一致 */
  const DOC_STYLE =
      
      '@page{size:A4;margin:18mm 16mm}' +
      'body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#16232e;line-height:1.75;font-size:11pt;margin:0}' +
      'h1{font-size:18pt;margin:0 0 4px;letter-spacing:.5px}' +
      '.sub{color:#6b7a89;font-size:9pt;margin-bottom:16px;border-bottom:2px solid #0F2E4A;padding-bottom:10px}' +
      'h2,.fx-chap h4{font-size:12.5pt;margin:18px 0 6px;padding-left:9px;border-left:4px solid #2563EB;page-break-after:avoid;color:#0F2E4A}' +
      '.fx-chap{margin-top:6px}' +
      'p{margin:6px 0;text-align:justify}' +
      'table{border-collapse:collapse;width:100%;margin:8px 0;page-break-inside:avoid}' +
      'td,th{border:1px solid #d8e0e8;padding:6px 9px;font-size:10pt;vertical-align:top}' +
      'td.fx-k{width:26%;background:#f5f8fb;color:#33475b}' +
      'ul{margin:6px 0 6px 18px;padding:0}li{margin:3px 0}' +
      '.fx-todo{color:#c62828;font-weight:bold}' +
      'code.fx-ph{background:#fff3e0;padding:0 3px;border-radius:3px;font-size:9.5pt;color:#8a5a00}' +
      '.fx-sides{margin-top:14px;page-break-inside:avoid}' +
      '.fx-side{border:1px solid #d8e0e8;border-radius:6px;padding:9px 12px;margin:8px 0}' +
      '.fx-side b{display:block;font-size:10.5pt;margin-bottom:4px;color:#0F2E4A}' +
      '.fx-sources{margin-top:14px;padding:9px 12px;border-top:1px solid #d8e0e8;font-size:9pt;color:#44586a}' +
      '.fx-sources ol{margin:4px 0 0 16px;padding:0;line-height:1.7;word-break:break-all}' +
      '.fx-src-note{margin-top:6px;color:#8494a3;font-size:8.5pt;line-height:1.6}' +
      '.fx-inner-section{margin-top:10px}' +
      'details.fx-inner-fold{display:block}' +
      '.fx-side-warn{border-color:#f0c2c2;background:#fff7f7}' +
      '.fx-side-gap{border-color:#f3dca8;background:#fffdf5}' +
      '.fx-unv-mark{background:#fff1f1;color:#c62828;border-bottom:1pt wavy #e57373;padding:0 2px;font-weight:700}' +
      '.fx-checks{margin-top:14px;padding:8px 11px;border:1pt dashed #ccd9e6;border-radius:5px;font-size:8.5pt;color:#4a5e70;line-height:1.6;page-break-inside:avoid}' +
      '.fx-checks b{color:#0F2E4A;margin-right:5px}' +
      '.fx-checks .fx-ok{color:#177245;font-weight:700}.fx-checks .fx-warn{color:#b45309;font-weight:700}' +
      '.fx-checks-note{margin-top:3px;color:#8a97a5;font-size:8pt}' +
      '.foot{margin-top:18px;padding-top:8px;border-top:1px solid #d8e0e8;color:#8494a3;font-size:8.5pt}';

  function printableDoc(rep) {
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>' + esc((rep && rep.company) || '访前画像') + ' · 访前画像报告</title>' +
      '<style>' +
      DOC_STYLE +
      '</style></head><body>' +
      '<h1>对公客户访前画像报告</h1>' +
      '<div class="sub">' + esc((rep && rep.company) || '') + ' · AI 生成内容，须经人工复核后方可使用</div>' +
      reportBodyHtml(rep, { expandInner: true }) +
      sourcesFooter() +
      '<div class="foot">本文档基于查询企业全称联网检索到的公开信息生成，每项数据均可在信息来源中回溯核对；' +
      '银行内部业务数据公开渠道无法获取，统一列在「银行内部业务数据（待补充）」一节，请现场核实后填写。' +
      'AI 生成内容，须经人工复核后方可使用。</div>' +
      '</body></html>';
  }

  /* ---------------------------------------------------------------- 能力一：报告 */

  function setPipe(idx, status, cls) {
    const box = $('pipe-' + idx);
    if (!box) return;
    box.classList.remove('active', 'done');
    if (cls) box.classList.add(cls);
    const st = $('pstat-' + idx);
    if (st) st.textContent = status;
  }

  window.startReport = async function startReportLive() {
    if (STATE.busy) return;

    const nameEl = $('companyInput');
    const name = ((nameEl && nameEl.value) || '').trim();
    if (!name) {
      toastSafe('请先输入要查询的企业全称');
      if (nameEl) nameEl.focus();
      return;
    }

    if (!STATE.ready) {
      STATE.lastError = '未连接大模型';
      toastSafe('未连接大模型：当前无法生成真实报告。请配置环境变量 KIMI_API_KEY 后刷新页面。');
      return;
    }

    STATE.busy = true;
    STATE.lastError = null;
    const btn = $('btnReport');
    if (btn) btn.disabled = true;
    const dv = $('deliverables');
    if (dv) dv.classList.remove('show');

    if (typeof renderPipeline === 'function') renderPipeline();

    try {
      /*
       * A · 事实准备
       * 这是本次改造的核心：企业名决定事实集。
       * 样例企业走内置样例，其余一律联网检索；检索不到就中止，绝不用样例冒充。
       */
      setPipe(0, '准备事实…', 'active');
      let pack;
      try {
        pack = await ensureFacts(name, (msg) => setPipe(0, msg, 'active'));
      } catch (err) {
        setPipe(0, '✗ 未取得事实', 'active');
        throw err;
      }
      const facts = pack.facts;
      setPipe(
        0,
        '✓ ' + (pack.sample ? '内置样例' : '联网检索') + ' · ' + Object.keys(facts).length + ' 项',
        'done'
      );

      /* B · 模型生成（真实耗时，流式回传字数） */
      setPipe(1, '模型生成中…', 'active');
      let lastLen = 0;
      const t0 = Date.now();

      const result = await callStream(
        { task: 'report', company: name, facts },
        {
          onMeta: (m) => setPipe(1, '模型生成中… ' + (m.model || ''), 'active'),
          onDelta: (d) => {
            if (d.len - lastLen > 200) {
              lastLen = d.len;
              const sec = Math.round((Date.now() - t0) / 100) / 10;
              setPipe(1, '生成中 ' + d.len + ' 字 · ' + sec + 's', 'active');
            }
          },
          onRetry: () => setPipe(1, '结构不合格，正在重写…', 'active')
        }
      );

      STATE.report = result.data;
      STATE.checks = result.checks;
      /*
       * 标题与文件名一律以查询名为准。
       * 模型偶有把全称写成简称、或补上"有限公司"的，报告是要归档到具体客户名下的，
       * 抬头不能跟着模型走；否则又会出现"查 A 企业、成品写 B 企业"。
       */
      if (STATE.report) STATE.report.company = name;
      const sec = Math.round((Date.now() - t0) / 100) / 10;
      setPipe(1, '✓ 完成 · ' + sec + 's', 'done');

      /* C · A4 版式适配（真实：同一份数据派生打印版） */
      setPipe(2, '执行中…', 'active');
      await sleep(360);
      setPipe(2, '✓ 完成 · A4 纵向', 'done');

      /* D · 强制校验（真实：用服务端返回的校验结论） */
      setPipe(3, '执行中…', 'active');
      await sleep(380);
      const c = result.checks || {};
      setPipe(3, c.pass ? '✓ 通过' : '⚠ ' + ((c.banned || []).length + (c.unverified || []).length) + ' 项告警',
        c.pass ? 'done' : 'active');
      if (!c.pass) await sleep(300);

      /* E · 交付 */
      setPipe(4, '执行中…', 'active');
      await sleep(320);
      setPipe(4, '✓ 完成 · 2 件', 'done');

      /* 交付物卡片 */
      DELIV.html = () => reportBodyHtml(STATE.report);
      DELIV.pdf = () => printablePreviewHtml(STATE.report);

      const grid = $('delivGrid');
      if (grid) {
        grid.innerHTML =
          card('html', '🖥', '企业画像报告.html', '交互版 · ' + (STATE.report.chapters || []).length + ' 章 · 实时生成',
            'openDeliverable(\'html\', \'' + String(name).replace(/'/g, '') + '\')', 'dl-html') +
          card('pdf', '📄', '企业画像报告.pdf', 'A4 纵向 · 点「打印」另存为 PDF',
            'openDeliverable(\'pdf\', \'' + String(name).replace(/'/g, '') + '\')', 'dl-pdf');
      }
      if (dv) { dv.classList.add('show'); dv.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }

      /* 记录 */
      if (!suppressRecord) {
        addRecord({
          ability: 'report',
          company: name,
          summary: '五阶段完成 · 实时生成 · ' + sec + 's',
          detail: {
            stages: ['A', 'B', 'C', 'D', 'E'],
            pages: (STATE.report.chapters || []).length,
            model: result.meta && result.meta.model,
            checks: c
          }
        });
      } else { suppressRecord = false; }

      STATE.mode = 'live';
      paintBadge();
      if (!c.pass) toastSafe('生成完成，但有 ' + ((c.banned || []).length + (c.unverified || []).length) + ' 项校验告警，请查看报告底部');
    } catch (err) {
      console.error('[fxhy] report failed', err);
      STATE.lastError = err.message;
      /*
       * 不回退样例。这是本次改造的红线：
       * 把"杭州明远智能装备"的股东、人数、产品当成真实客户的资料交付，
       * 比交不出报告危险得多——客户经理会照着这份东西去见客户。
       */
      const advice = adviceFor(err);
      setPipe(1, '✗ 已中止', 'active');
      if (dv) dv.classList.remove('show');
      if (typeof resetReport === 'function') resetReport();
      toastSafe('生成失败：' + err.message + (advice ? '｜' + advice : ''));
      if (err.detail) console.warn('[fxhy] 上游原文：', err.detail);
    } finally {
      STATE.busy = false;
      if (btn) btn.disabled = false;
    }
  };

  function card(k, ic, title, sub, click, dlKind) {
    return '<div class="deliv-card" onclick="' + click + '">' +
      '<div class="ic">' + ic + '</div><b>' + esc(title) + '</b><span>' + esc(sub) + '</span>' +
      '<div class="deliv-actions"><div class="go">点击预览 →</div>' +
      '<button class="dl-btn" onclick="fxhyDownload(\'' + dlKind + '\', event)">' +
      (dlKind === 'dl-pdf' ? '🖨 打印' : '⬇ 下载') + '</button></div></div>';
  }

  function printablePreviewHtml(rep) {
    const c = STATE.checks || {};
    return '<h4>A4 打印版说明</h4>' +
      '<p class="fx-p">打印版与交互版<b>同源同口径</b>：同一份生成结果，换一套版式渲染。' +
      '章节按 A4 纵向排布，表格与图表不会被切成两半。</p>' +
      '<table class="fx-table">' +
      '<tr><td class="fx-k">报告企业</td><td>' + rich((rep && rep.company) || '') + '</td></tr>' +
      '<tr><td class="fx-k">章节数</td><td>' + ((rep && rep.chapters) || []).length + ' 章</td></tr>' +
      '<tr><td class="fx-k">禁词残留</td><td>' + ((c.banned || []).length) + ' 处</td></tr>' +
      '<tr><td class="fx-k">事实比对</td><td>' + (c.pass ? '全部通过' : (c.unverified || []).length + ' 项待人工核对') + '</td></tr>' +
      '<tr><td class="fx-k">生成模型</td><td>' + esc(STATE.model || '—') + '</td></tr>' +
      '</table>' +
      '<p class="fx-p" style="margin-top:14px">点右上「打印」→ 在打印对话框中选择「另存为 PDF」，纸张选 A4、边距默认，即可得到可签字归档的 PDF。</p>' +
      '<p class="fx-p" style="color:#8a97a5;font-size:12px">不在服务端生成 PDF 是刻意的：服务端渲染需要引入无头浏览器（约 300MB 依赖），' +
      '而浏览器自带的打印引擎已经足够，且不产生额外故障点。</p>';
  }

  /* ---------------------------------------------------------------- 交付物 */

  window.openDeliverable = function openDeliverableLive(k, n) {
    if (!STATE.report) return legacyOpen(k, n);

    const titles = {
      html: '交付物 ① · 企业画像报告（实时生成）',
      pdf: '交付物 ② · A4 打印版'
    };
    const body = k === 'html' ? reportBodyHtml(STATE.report) : printablePreviewHtml(STATE.report);
    openModal(titles[k] || '预览', body);

    const tip = $('modalFootTip');
    const btn = $('modalDlBtn');
    const foot = $('modalFoot');
    if (tip) tip.textContent = (STATE.report.company || '') + ' · ' + esc(STATE.model || '') + ' 实时生成 · AI 内容须人工复核';
    if (btn) {
      btn.textContent = k === 'html' ? '⬇ 下载 HTML' : '🖨 打印 / 另存 PDF';
      btn.onclick = () => (k === 'html' ? downloadHtml() : printReport());
    }
    if (foot) foot.classList.add('on');
  };

  window.fxhyDownload = function (kind, ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (kind === 'dl-html') return downloadHtml();
    return printReport();
  };

  function downloadHtml() {
    if (!STATE.report) { toastSafe('请先生成报告'); return; }
    const html = printableDoc(STATE.report);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (STATE.report.company || '访前画像') + '-企业画像报告.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function printReport() {
    if (!STATE.report) { toastSafe('请先生成报告'); return; }
    const w = window.open('', '_blank');
    if (!w) { toastSafe('浏览器拦截了弹窗，请允许后重试'); return; }
    w.document.open();
    w.document.write(printableDoc(STATE.report));
    w.document.close();
    w.onload = () => setTimeout(() => w.print(), 300);
  }

  /* ---------------------------------------------------------------- 能力二：话术 */

  window.genScript = async function genScriptLive() {
    if (STATE.busy) return;

    const el = $('scriptCompany');
    const name = ((el && el.value) || '').trim();
    if (!name) {
      toastSafe('请先输入要查询的企业全称');
      if (el) el.focus();
      return;
    }

    if (!STATE.ready) {
      STATE.lastError = '未连接大模型';
      toastSafe('未连接大模型：当前无法生成真实话术。请配置环境变量 KIMI_API_KEY 后刷新页面。');
      return;
    }

    STATE.busy = true;
    const area = $('scriptArea');
    const t0 = Date.now();

    if (area) {
      area.innerHTML =
        '<div class="script-card"><div class="script-body">' +
        '<p id="fxScriptStatus" style="font-size:13.5px;color:#64748b">正在取得该企业的事实集…</p>' +
        '</div></div>';
    }

    try {
      /* 与报告共用一条事实链：同样按企业名取事实，换企业必然重新采集 */
      const pack = await ensureFacts(name, (msg) => {
        const s = $('fxScriptStatus');
        if (s) s.textContent = msg;
      });

      const result = await callStream(
        { task: 'script', company: name, facts: pack.facts },
        {
          onDelta: (d) => {
            const s = $('fxScriptStatus');
            if (s) s.textContent = '模型生成中… 已输出 ' + d.len + ' 字 · ' +
              Math.round((Date.now() - t0) / 100) / 10 + 's';
          },
          onRetry: () => {
            const s = $('fxScriptStatus');
            if (s) s.textContent = '结构不合格，正在重写…';
          }
        }
      );

      const scenes = result.data.scenes || [];
      if (scenes.length !== 5) throw new Error('返回场景数不足 5 个');

      /* SCENES 是 const，只能就地替换内容 */
      SCENES.length = 0;
      scenes.forEach((s) =>
        SCENES.push({
          name: s.name,
          when: s.when,
          points: s.points,
          quotes: s.quotes,
          basis: s.basis
        })
      );
      vIdx = SCENES.map(() => 0);
      curScene = 0;
      scriptGenerated = true;
      STATE.script = scenes;
      STATE.scriptChecks = result.checks;

      renderSceneTabs();
      renderScript(0);

      const sec = Math.round((Date.now() - t0) / 100) / 10;
      if (!suppressRecord) {
        addRecord({
          ability: 'script',
          company: name,
          summary: '五场景 · 每场景 3 种说法 · 实时生成 · ' + sec + 's',
          detail: { scenes: JSON.parse(JSON.stringify(scenes)), vIdx: vIdx.slice(), model: result.meta && result.meta.model }
        });
      } else { suppressRecord = false; }

      STATE.mode = 'live';
      paintBadge();

      if (result.checks && !result.checks.pass) {
        toastSafe('话术已生成，但有校验告警，请核对未验证数字');
      }
    } catch (err) {
      console.error('[fxhy] script failed', err);
      STATE.lastError = err.message;
      /* 与报告一致：失败就如实报错，不把样例话术当成该客户的产出 */
      const advice = adviceFor(err);
      if (area) {
        area.innerHTML =
          '<div class="script-card"><div class="script-body">' +
          '<p style="font-size:13.5px;color:#b42318;font-weight:600">话术生成失败</p>' +
          '<p style="font-size:13px;color:#475569;line-height:1.75">' + esc(err.message) +
          (advice ? '<br>' + esc(advice) : '') + '</p>' +
          '</div></div>';
      }
      toastSafe('生成失败：' + err.message + (advice ? '｜' + advice : ''));
      if (err.detail) console.warn('[fxhy] 上游原文：', err.detail);
    } finally {
      STATE.busy = false;
    }
  };

  /* ---------------------------------------------------------------- 回退 */

  function legacy(name) {
    const fn = LEGACY[name];
    if (typeof fn === 'function') {
      try { return fn(); } catch (e) { console.error('[fxhy] legacy fallback failed', e); }
    }
  }

  const legacyOpen = (k, n) => (LEGACY.openDeliverable ? LEGACY.openDeliverable(k, n) : null);

  /* ---------------------------------------------------------------- 样式 */

  function injectStyle() {
    if ($('fxStyle')) return;
    const st = document.createElement('style');
    st.id = 'fxStyle';
    st.textContent = `
.fx-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;
  padding:5px 11px;border-radius:99px;letter-spacing:.4px;white-space:nowrap}
.fx-badge.fx-on{background:#e7f6ec;color:#177245;border:1px solid #bde5ca}
.fx-badge.fx-off{background:#f1f5f9;color:#64748b;border:1px solid #dde5ed}
.fx-badge-sub{font-weight:400;opacity:.75;font-size:11px}
.fx-factsbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  background:#f5f8fb;border:1px solid #e2e9f0;border-radius:10px;
  padding:9px 14px;margin:10px 0 4px;font-size:12.5px;color:#475a6b}
.fx-factsbar-lite{background:transparent;border:none;padding:6px 2px}
.fx-fb-k{font-weight:700;color:#0F2E4A;background:#fff;border:1px solid #dde5ed;
  border-radius:6px;padding:2px 8px;font-size:11.5px}
.fx-fb-v{color:#0F2E4A;font-weight:600}
.fx-fb-btn{border:1px solid #c9d6e2;background:#fff;border-radius:6px;padding:3px 10px;
  font-size:12px;color:#2563EB;cursor:pointer}
.fx-fb-btn:hover{background:#eef4ff}
.fx-fb-tip{color:#8a97a5;font-size:11.5px}
.fx-facts-modal textarea{width:100%;height:340px;font-family:Consolas,Monaco,monospace;
  font-size:12.5px;line-height:1.6;border:1px solid #d8e0e8;border-radius:8px;padding:12px;
  background:#fbfdff;color:#16232e;resize:vertical}
.fx-facts-actions{display:flex;gap:10px;margin-top:12px;align-items:center}
.fx-hint{font-size:13px;color:#5b6b7b;line-height:1.7;margin:0 0 10px}
.fx-report{font-size:13.5px;color:#1f2d3a}
.fx-rep-head{border-left:4px solid #2563EB;padding-left:12px;margin-bottom:6px}
.fx-rep-name{font-size:19px;font-weight:800;color:#0F2E4A;letter-spacing:.4px}
.fx-rep-sum{margin-top:7px;color:#41576b;line-height:1.75}
.fx-chap{margin-top:16px}
.fx-chap h4{font-size:14px;font-weight:800;color:#0F2E4A;margin:0 0 7px;
  padding-bottom:5px;border-bottom:1px solid #e6edf4}
.fx-p{margin:6px 0;line-height:1.8;text-align:justify}
.fx-table{border-collapse:collapse;width:100%;margin:8px 0}
.fx-table td{border:1px solid #e2e9f0;padding:7px 10px;font-size:12.5px;vertical-align:top;line-height:1.65}
.fx-table td.fx-k{width:25%;background:#f7fafd;color:#44586a;font-weight:600}
.fx-list{margin:6px 0 6px 18px;padding:0;line-height:1.8}
.fx-todo{color:#c62828;font-weight:700;background:#fff5f5;padding:0 4px;border-radius:3px}
code.fx-ph{background:#fff4e0;color:#8a5a00;padding:1px 4px;border-radius:3px;font-size:12px}
.fx-sides{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:16px}
.fx-inner-fold{margin-top:16px;border:1px solid #e2e9f0;border-radius:9px;background:#fbfdff;overflow:hidden}
.fx-inner-fold>summary{cursor:pointer;padding:10px 13px;font-size:12.5px;font-weight:700;color:#44586a;
  list-style:none;display:flex;align-items:center;gap:8px}
.fx-inner-fold>summary::-webkit-details-marker{display:none}
.fx-inner-fold>summary:before{content:"▸";color:#93a5b8;font-size:11px;transition:transform .15s}
.fx-inner-fold[open]>summary:before{transform:rotate(90deg)}
.fx-inner-fold>summary:hover{background:#f1f6fb}
.fx-inner-hint{margin-left:auto;font-weight:400;font-size:11.5px;color:#93a5b8}
.fx-inner-table{margin:0}
.fx-inner-table td{border-left:0;border-right:0;border-bottom:1px solid #eef3f8}
.fx-inner-table tr:last-child td{border-bottom:0}
.fx-sources{margin-top:18px;padding:12px 14px;border-radius:9px;background:#f6f9fc;font-size:12px;color:#44586a}
.fx-sources ol{margin:6px 0 0 18px;padding:0;line-height:1.8;word-break:break-all}
.fx-src-note{margin-top:8px;color:#8494a3;font-size:11.5px;line-height:1.6}
.fx-src-list{margin:8px 0 0;padding:0;list-style:none;max-height:52vh;overflow:auto}
.fx-src-list li{padding:9px 11px;border:1px solid #e2e9f0;border-radius:8px;margin-bottom:8px;background:#fbfdff}
.fx-src-list a{font-size:12.5px;color:#1d4ed8;text-decoration:none;font-weight:600;display:block;line-height:1.5}
.fx-src-list a:hover{text-decoration:underline}
.fx-src-list span{display:block;font-size:11px;color:#93a5b8;margin-top:3px;word-break:break-all}
.fx-side{border:1px solid #e2e9f0;border-radius:9px;padding:10px 12px;background:#fbfdff}
.fx-side b{display:block;font-size:12.5px;color:#0F2E4A;margin-bottom:5px}
.fx-side ul{margin:0 0 0 16px;padding:0;font-size:12.5px;line-height:1.7}
.fx-side-warn{background:#fffafa;border-color:#f3cccc}
.fx-side-gap{background:#fffdf6;border-color:#f0e0b4}
.fx-checks{margin-top:18px;padding:11px 13px;border-radius:9px;background:#f6f9fc;
  border:1px dashed #ccd9e6;font-size:12px;color:#4a5e70;line-height:1.7}
.fx-checks b{color:#0F2E4A;margin-right:6px}
.fx-checks .fx-ok{color:#177245;font-weight:700}
.fx-checks .fx-warn{color:#b45309;font-weight:700}
.fx-checks .fx-unv{color:#b45309;font-family:Consolas,monospace}
.fx-checks-note{margin-top:5px;color:#8a97a5;font-size:11.5px}
.fx-unv-mark{background:#fff1f1;color:#c62828;border-bottom:2px wavy #e57373;
  padding:0 2px;border-radius:2px;font-weight:700}
@media (max-width:900px){.fx-sides{grid-template-columns:1fr}}
`;
    document.head.appendChild(st);
  }

  /* ---------------------------------------------------------------- 批量导入：客户清单 */

  /**
   * 一次上传整份客户清单，逐户生成画像。
   *
   * 三个约束决定了实现方式：
   *   1. 表格在服务端解析（Node 有 zlib，浏览器没有，且 xlsx 要先解 zip）；
   *   2. 批量走 /api/batch，而不是前端循环调 /api/llm——
   *      否则 20 户会把 12 次/分钟的限流额度耗光，还会乱序；
   *   3. 汇总用一份 HTML 承载全部客户，靠打印引擎出 PDF，不引任何打包库。
   *
   * 分片：Serverless 函数有时长上限（老项目 60 秒，开了 Fluid 的 300 秒），
   * 一次请求跑不完 20 户，所以按 BATCH.chunk 分几片发，片上仍是并发生成。
   */

  const BATCH = {
    headers: [],
    rows: [],
    companyCol: '',
    kind: '',
    total: 0,
    results: [],
    running: false,
    max: 20,
    chunk: 3,
    fatal: null,
    startedAt: 0
  };

  const BATCH_CSS = `
.fxb-drop{border:2px dashed #c9d6e2;border-radius:12px;padding:26px 18px;text-align:center;
  background:#fbfdff;color:#475a6b;font-size:13px;line-height:1.8;transition:.15s}
.fxb-drop.over{border-color:#2563EB;background:#f0f6ff}
.fxb-drop.busy{opacity:.55;pointer-events:none}
.fxb-drop-ic{font-size:30px;line-height:1;margin-bottom:8px}
.fxb-tip{font-size:12px;color:#8a97a5;line-height:1.75}
.fxb-tip a{color:#2563EB;text-decoration:none;border-bottom:1px dashed #93b4f5}
.fxb-file{display:flex;align-items:center;gap:10px;background:#f5f8fb;border:1px solid #e2e9f0;
  border-radius:9px;padding:9px 13px;font-size:12.5px;margin-bottom:10px;color:#475a6b}
.fxb-file b{color:#0F2E4A}
.fxb-preview{max-height:250px;overflow:auto;border:1px solid #e2e9f0;border-radius:9px;margin:10px 0}
.fxb-preview table{border-collapse:collapse;width:100%;font-size:12px}
.fxb-preview th{position:sticky;top:0;background:#f0f5fa;color:#33475b;font-weight:700;
  text-align:left;padding:7px 9px;border-bottom:1px solid #e2e9f0;white-space:nowrap}
.fxb-preview td{padding:6px 9px;border-bottom:1px solid #f0f4f8;color:#33475b;
  white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.fxb-row2{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}
.fxb-row2 label{font-size:12.5px;color:#5b6b7b}
.fxb-row2 select,.fxb-row2 input{border:1px solid #c9d6e2;border-radius:6px;padding:4px 8px;
  font-size:12.5px;color:#0F2E4A;background:#fff}
.fxb-bar{height:8px;border-radius:99px;background:#eef2f7;overflow:hidden}
.fxb-bar-in{height:100%;width:0;background:linear-gradient(90deg,#2563EB,#60a5fa);
  transition:width .35s ease}
.fxb-prog-txt{font-size:12px;color:#5b6b7b;margin-top:6px;text-align:right}
.fxb-list{margin-top:12px;max-height:290px;overflow:auto;border:1px solid #eef2f7;border-radius:9px}
.fxb-row{display:flex;align-items:center;gap:10px;padding:8px 12px;
  border-bottom:1px solid #f3f6fa;font-size:12.5px}
.fxb-row:last-child{border-bottom:none}
.fxb-n{width:26px;color:#94a3b8;font-variant-numeric:tabular-nums;font-size:11.5px}
.fxb-name{flex:1;color:#1f2d3a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fxb-st{font-size:11.5px;font-weight:700;color:#94a3b8;white-space:nowrap}
.fxb-st.fx-ok{color:#177245}
.fxb-st.fx-fail{color:#c62828}
.fxb-st.fx-run{color:#2563EB}
.fxb-sum{display:flex;gap:20px;align-items:baseline;margin:4px 0 14px}
.fxb-sum b{font-size:22px;color:#0F2E4A;font-variant-numeric:tabular-nums}
.fxb-sum span{font-size:12px;color:#5b6b7b}
.fxb-fail{margin-top:10px;border:1px solid #f3cccc;background:#fffafa;border-radius:9px;
  padding:9px 12px;font-size:12px;color:#8a3b3b;line-height:1.75;max-height:150px;overflow:auto}
.fxb-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
`;

  function injectBatchStyle() {
    if ($('fxbStyle')) return;
    const st = document.createElement('style');
    st.id = 'fxbStyle';
    st.textContent = BATCH_CSS;
    document.head.appendChild(st);
  }

  function fmtMs(ms) {
    if (!ms) return '';
    return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s';
  }

  /** 批量接口的事件与 /api/llm 不同，单独一份读取器，避免改动已经跑通的那条链路 */
  async function postSse(url, body, onEvent) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      let msg = '请求失败（' + res.status + '）';
      try {
        const j = await res.json();
        msg = j.message || msg;
      } catch (_) {}
      throw new Error(msg);
    }
    if (!res.body) throw new Error('当前浏览器不支持流式读取，请换 Chrome / Edge');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);

        let ev = 'message';
        const lines = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) lines.push(line.slice(5).trim());
        }
        if (!lines.length) continue;

        let payload;
        try {
          payload = JSON.parse(lines.join('\n'));
        } catch (_) {
          continue;
        }
        onEvent(ev, payload);
      }
    }
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
      fr.onerror = () => reject(new Error('文件读取失败'));
      fr.readAsDataURL(file);
    });
  }

  /** 该行的"事实"：除企业名称列以外的所有非空列 */
  function factsOfRow(row) {
    const o = {};
    for (const h of BATCH.headers) {
      if (h === BATCH.companyCol) continue;
      const v = String(row[h] == null ? '' : row[h]).trim();
      if (v) o[h] = v;
    }
    return o;
  }

  /* ---------------- 步骤一：上传 ---------------- */

  function batchUploadHtml() {
    return (
      '<div class="fxb-drop" id="fxbDrop">' +
      '<div class="fxb-drop-ic">📄</div>' +
      '<div>把客户清单拖到这里，或 <button class="btn primary" onclick="fxbChoose()">选择文件</button></div>' +
      '<div class="fxb-tip">支持 .xlsx 与 .csv（GBK 编码也能读）。第一行是表头，' +
      '其中一列写企业全称，其余列写你掌握的事实。</div>' +
      '<input type="file" id="fxbFile" accept=".xlsx,.csv,text/csv" style="display:none" onchange="fxbFilePicked(this)">' +
      '</div>' +
      '<p class="fxb-tip" style="margin-top:12px">没有现成表格？' +
      '<a href="javascript:fxbTemplate()">下载空白模板</a>（CSV，Excel 可直接打开）。' +
      '表头写什么，模型就看到什么——列名尽量用「注册资本」「参保人数」这类明确的说法。</p>' +
      '<p class="fxb-tip">一次最多生成 ' + BATCH.max + ' 户；更多的请分批。' +
      '每户约 15–30 秒，服务端同时跑 2 户。</p>'
    );
  }

  function bindDrop() {
    const box = $('fxbDrop');
    if (!box) return;
    ['dragenter', 'dragover'].forEach((t) =>
      box.addEventListener(t, (e) => {
        e.preventDefault();
        box.classList.add('over');
      })
    );
    ['dragleave', 'drop'].forEach((t) =>
      box.addEventListener(t, (e) => {
        e.preventDefault();
        box.classList.remove('over');
      })
    );
    box.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) fxbParse(f);
    });
  }

  window.fxhyBatch = function fxhyBatch() {
    injectBatchStyle();
    BATCH.headers = [];
    BATCH.rows = [];
    BATCH.results = [];
    BATCH.running = false;
    BATCH.fatal = null;
    openModal('批量导入客户清单', batchUploadHtml());
    bindDrop();
  };

  window.fxbChoose = function () {
    const el = $('fxbFile');
    if (el) el.click();
  };

  window.fxbFilePicked = function (input) {
    const f = input && input.files && input.files[0];
    if (f) fxbParse(f);
  };

  async function fxbParse(file) {
    const name = file.name || '';
    if (!/\.(xlsx|csv|txt)$/i.test(name)) {
      toastSafe('只支持 .xlsx 与 .csv 文件');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      toastSafe('文件 ' + (file.size / 1048576).toFixed(1) + ' MB，超过 4 MB，请先精简清单');
      return;
    }

    const drop = $('fxbDrop');
    if (drop) drop.classList.add('busy');
    toastSafe('正在解析清单…');

    try {
      const b64 = await readAsBase64(file);
      const res = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: name, base64: b64 })
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.message || '解析失败');

      BATCH.headers = j.headers || [];
      BATCH.rows = j.rows || [];
      BATCH.companyCol = j.companyCol || BATCH.headers[0] || '';
      BATCH.kind = j.kind || '';
      BATCH.total = j.total || BATCH.rows.length;

      renderPreview(name, j);
    } catch (e) {
      if (drop) drop.classList.remove('busy');
      toastSafe('解析失败：' + e.message);
    }
  }

  /* ---------------- 步骤二：确认列映射 ---------------- */

  function renderPreview(filename, meta) {
    const cols = BATCH.headers.slice(0, 6);
    const head = cols.map((h) => '<th>' + esc(h) + '</th>').join('');
    const body = BATCH.rows
      .slice(0, 6)
      .map((r) => '<tr>' + cols.map((h) => '<td>' + esc(r[h] || '') + '</td>').join('') + '</tr>')
      .join('');

    const more = BATCH.headers.length > 6 ? '（仅显示前 6 列）' : '';
    const opt = BATCH.headers
      .map((h) => '<option value="' + esc(h) + '"' + (h === BATCH.companyCol ? ' selected' : '') + '>' + esc(h) + '</option>')
      .join('');

    const truncated = meta && meta.truncated
      ? '<p class="fxb-tip">表格共 ' + meta.total + ' 行，已截取前 ' + BATCH.rows.length + ' 行（上限 ' + meta.maxRows + '）。</p>'
      : '';

    $('modalBody').innerHTML =
      '<div class="fxb-file"><b>' + esc(filename) + '</b>' +
      '<span>' + (BATCH.kind === 'xlsx' ? 'Excel' : 'CSV') +
      (meta.sheetName ? ' · ' + esc(meta.sheetName) : '') + '</span>' +
      '<span>共 <b>' + BATCH.rows.length + '</b> 户</span>' +
      (meta.truncated ? '<span style="color:#b45309">已截断</span>' : '') +
      '</div>' +
      '<div class="fxb-row2"><label>企业名称列</label><select onchange="fxbSetCol(this.value)">' + opt + '</select>' +
      '<span class="fxb-tip">这一列会成为报告的标题，其余列自动成为事实源</span></div>' +
      '<div class="fxb-preview"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="fxb-tip">预览前 6 行' + more + '。' + truncated + '</p>' +
      '<div class="fxb-actions">' +
      '<button class="btn" onclick="fxhyBatch()">重新选择</button>' +
      '<span style="flex:1"></span>' +
      '<button class="btn primary" onclick="fxbStart()">开始生成 ' + BATCH.rows.length + ' 户画像</button>' +
      '</div>';
  }

  window.fxbSetCol = function (col) {
    BATCH.companyCol = col;
    toastSafe('企业名称列已设为「' + col + '」');
  };

  /* ---------------- 步骤三：逐户生成 ---------------- */

  function renderProgress(targets) {
    const list = targets
      .map(
        (idx) =>
          '<div class="fxb-row" id="fxbRow-' + idx + '">' +
          '<span class="fxb-n">' + (targets.indexOf(idx) + 1) + '</span>' +
          '<span class="fxb-name">' + esc(BATCH.rows[idx][BATCH.companyCol] || '') + '</span>' +
          '<span class="fxb-st">等待</span></div>'
      )
      .join('');

    $('modalBody').innerHTML =
      '<div class="fxb-bar"><div class="fxb-bar-in" id="fxbBar"></div></div>' +
      '<div class="fxb-prog-txt" id="fxbProgTxt">0 / ' + targets.length + '</div>' +
      '<div class="fxb-list" id="fxbList">' + list + '</div>' +
      '<p class="fxb-tip" style="margin-top:12px">生成期间请不要关闭窗口。' +
      '每户独立校验，某户失败不影响其余户。</p>';
  }

  function updateRow(res) {
    const row = $('fxbRow-' + res.index);
    if (!row) return;
    const st = row.querySelector('.fxb-st');
    if (!st) return;
    if (res.ok) {
      st.className = 'fxb-st fx-ok';
      st.textContent = '完成 ' + fmtMs(res.ms);
      st.title = res.cache ? '命中缓存' : '已生成';
    } else {
      st.className = 'fxb-st fx-fail';
      st.textContent = '失败';
      st.title = res.error || '';
    }
  }

  window.fxbStart = function () {
    runBatch(null);
  };

  async function runBatch(onlyIndexes) {
    if (BATCH.running) return;

    const targets = (onlyIndexes || BATCH.rows.map((_, i) => i)).filter(
      (i) => String(BATCH.rows[i][BATCH.companyCol] || '').trim()
    );
    if (!targets.length) {
      toastSafe('清单里没有有效的企业名称，请检查企业名称列');
      return;
    }
    if (targets.length > BATCH.max) {
      toastSafe('一次最多 ' + BATCH.max + ' 户，请分批上传');
      return;
    }

    if (!STATE.ready) {
      toastSafe('未连接大模型（KIMI_API_KEY 未配置），无法批量生成');
      return;
    }

    BATCH.running = true;
    BATCH.fatal = null;
    BATCH.startedAt = Date.now();

    renderProgress(targets);
    let done = 0;

    // 按片发送：每片独立请求，单片失败不影响已完成的户
    const size = Math.max(1, Math.min(BATCH.chunk || 3, targets.length));
    const groups = [];
    for (let i = 0; i < targets.length; i += size) groups.push(targets.slice(i, i + size));

    try {
      for (const group of groups) {
        const payload = group.map((i) => ({
          company: String(BATCH.rows[i][BATCH.companyCol] || '').trim(),
          facts: factsOfRow(BATCH.rows[i])
        }));

        let stop = null;
        await postSse('/api/batch', { task: 'report', rows: payload }, (ev, p) => {
          if (ev === 'item') {
            const realIdx = group[p.index];
            if (realIdx === undefined) return;
            BATCH.results[realIdx] = Object.assign({}, p, { index: realIdx });
            updateRow(BATCH.results[realIdx]);
            done++;
            const bar = $('fxbBar');
            const txt = $('fxbProgTxt');
            if (bar) bar.style.width = Math.round((done / targets.length) * 100) + '%';
            if (txt) txt.textContent = done + ' / ' + targets.length;
          } else if (ev === 'error') {
            stop = p.message || '批量生成失败';
          } else if (ev === 'done') {
            BATCH.elapsed = Date.now() - BATCH.startedAt;
          }
        });

        if (stop) {
          BATCH.fatal = stop;
          break;
        }
      }
    } catch (e) {
      BATCH.fatal = e.message || String(e);
    }

    // 没轮到的户补成失败态：汇总里能看见，也能用「重试未完成」补跑
    if (BATCH.fatal) {
      targets.forEach((i) => {
        if (!BATCH.results[i]) BATCH.results[i] = { ok: false, index: i, error: BATCH.fatal, skipped: true };
      });
    }

    BATCH.running = false;
    renderSummary();
  }

  /* ---------------- 步骤四：汇总 ---------------- */

  function renderSummary() {
    const oks = [];
    const fails = [];
    BATCH.results.forEach((r, i) => {
      if (r && r.ok) oks.push(i);
      else if (r) fails.push(i);
    });
    const elapsed = BATCH.elapsed || Date.now() - BATCH.startedAt;

    const failHtml = fails.length
      ? '<div class="fxb-fail"><b>未完成 ' + fails.length + ' 户</b><br>' +
        fails
          .map((i) => '· ' + esc(BATCH.rows[i][BATCH.companyCol] || '') + '：' + esc((BATCH.results[i] && BATCH.results[i].error) || '未生成'))
          .join('<br>') +
        '</div>'
      : '';

    const warn = BATCH.fatal
      ? '<p class="fxb-tip" style="color:#c62828;margin:8px 0">' + esc(BATCH.fatal) + '</p>'
      : '';

    $('modalBody').innerHTML =
      '<div class="fxb-sum"><b>' + oks.length + '</b><span>户已生成</span>' +
      (fails.length ? '<b style="color:#c62828">' + fails.length + '</b><span>户未完成</span>' : '') +
      '<span style="margin-left:auto">用时 ' + fmtMs(elapsed) + '</span></div>' +
      warn +
      failHtml +
      '<div class="fxb-list" style="margin-top:12px">' +
      BATCH.results
        .map((r, i) =>
          r
            ? '<div class="fxb-row"><span class="fxb-n">' + (i + 1) + '</span>' +
              '<span class="fxb-name">' + esc(BATCH.rows[i][BATCH.companyCol] || '') + '</span>' +
              '<span class="fxb-st ' + (r.ok ? 'fx-ok' : 'fx-fail') + '">' +
              (r.ok ? '完成 ' + fmtMs(r.ms) : '失败') + '</span></div>'
            : ''
        )
        .join('') +
      '</div>' +
      '<div class="fxb-actions">' +
      '<button class="btn primary" onclick="fxbDownload()"' + (oks.length ? '' : ' disabled') + '>下载汇总报告</button>' +
      '<button class="btn" onclick="fxbPrint()"' + (oks.length ? '' : ' disabled') + '>打印为 PDF</button>' +
      (fails.length ? '<button class="btn" onclick="fxbRetry()">重试未完成</button>' : '') +
      '<span style="flex:1"></span>' +
      '<button class="btn" onclick="fxhyBatch()">再传一份</button>' +
      '</div>';
  }

  window.fxbRetry = function () {
    const fails = [];
    BATCH.results.forEach((r, i) => {
      if (!r || !r.ok) fails.push(i);
    });
    if (!fails.length) return;
    runBatch(fails);
  };

  /** 打印/下载用的 A4 汇总文档：封面清单 + 每户一节，分页在户与户之间 */
  function batchDocHtml() {
    const items = BATCH.results
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r && x.r.ok);

    const coverRows = items
      .map(
        (x, n) =>
          '<tr><td style="width:36px;text-align:center;color:#6b7a89">' + (n + 1) + '</td>' +
          '<td>' + esc(BATCH.rows[x.i][BATCH.companyCol] || '') + '</td></tr>'
      )
      .join('');

    const cover =
      '<section class="fxb-cover">' +
      '<h1>对公客户访前画像报告</h1>' +
      '<div class="sub">批量版 · 共 ' + items.length + ' 户 · 生成于 ' +
      esc(new Date().toLocaleString('zh-CN')) + ' · AI 生成内容，须经人工复核后方可使用</div>' +
      '<h2>客户清单</h2><table><tbody>' + coverRows + '</tbody></table>' +
      '<p class="fxb-note">本文件由「营销助手」按上传的客户清单逐户生成。' +
      '每户仅使用清单中该行的字段作为事实，缺失项以占位符标出，未获取的行内数据一律待补充，不做估算。</p>' +
      '</section>';

    const saved = STATE.checks;
    const sections = items
      .map((x, n) => {
        STATE.checks = x.r.checks || null;
        // 企业名以清单为准：模型偶有改写全称（少写"有限公司"或换简称），
        // 而这份报告是要归档到具体客户名下的，标题不能跟着模型走。
        const rep = Object.assign({}, x.r.data, {
          company: String(BATCH.rows[x.i][BATCH.companyCol] || (x.r.data && x.r.data.company) || '')
        });
        return (
          '<section class="fxb-item">' +
          '<div class="fxb-item-no">第 ' + (n + 1) + ' 户 / 共 ' + items.length + ' 户</div>' +
          reportBodyHtml(rep, { expandInner: true }) +
          '</section>'
        );
      })
      .join('');
    STATE.checks = saved;

    return (
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>对公客户访前画像报告（批量 ' + items.length + ' 户）</title>' +
      '<style>' + DOC_STYLE +
      '.fxb-cover{page-break-after:always}' +
      '.fxb-cover h1{font-size:20pt;margin-bottom:6px}' +
      '.fxb-cover .sub{border-bottom:2px solid #0F2E4A;padding-bottom:10px}' +
      '.fxb-cover table{width:70%;margin-top:8px}' +
      '.fxb-note{margin-top:16px;color:#6b7a89;font-size:9pt;line-height:1.7}' +
      '.fxb-item{page-break-before:always}' +
      '.fxb-item-no{font-size:8.5pt;color:#8494a3;letter-spacing:.5px;margin-bottom:6px}' +
      '</style></head><body>' +
      cover + sections +
      '</body></html>'
    );
  }

  window.fxbDownload = function () {
    const html = batchDocHtml();
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    a.download = '批量访前画像报告-' + BATCH.results.filter((r) => r && r.ok).length + '户-' + stamp + '.html';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1500);
    toastSafe('已下载汇总报告，可直接用浏览器打开后打印为 PDF');
  };

  window.fxbPrint = function () {
    const w = window.open('', '_blank');
    if (!w) {
      toastSafe('浏览器拦截了新窗口，请允许弹窗后重试，或用「下载汇总报告」');
      return;
    }
    w.document.open();
    w.document.write(batchDocHtml());
    w.document.close();
    setTimeout(() => {
      try {
        w.focus();
        w.print();
      } catch (_) {}
    }, 500);
  };

  /* ---------------- 模板下载 ---------------- */

  window.fxbTemplate = function () {
    const cols = [
      '企业名称', '统一社会信用代码', '注册资本', '成立日期', '参保人数', '所属行业',
      '注册地址', '经营范围', '主营产品', '下游客户', '股权结构', '涉诉情况'
    ];
    const sample = [
      ['杭州明远智能装备有限公司', '91330100MA2XXXXX0K', '5000 万元人民币', '2013-06-18', '126 人',
       '智能物流分拣装备制造', '杭州市余杭区某某路 18 号', '智能物流分拣设备、输送系统的研发与制造',
       '交叉带分拣机、摆轮分拣机', '快递企业、电商仓配中心', '陈某某持股 51%', '近三年 3 起买卖合同纠纷，均已结案'],
      ['宁波海川精密部件有限公司', '91330200MA2YYYYY1L', '1200 万元人民币', '2017-10-02', '58 人',
       '汽车零部件制造', '宁波市北仑区某某路 6 号', '精密冲压件、注塑件的生产与销售',
       '变速箱阀体、传感器外壳', '整车厂一级供应商', '王某某持股 70%、李某持股 30%', '无']
    ];

    const quote = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [cols.map(quote).join(','), ...sample.map((r) => r.map(quote).join(','))];
    const csv = '\uFEFF' + lines.join('\r\n');

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = '客户清单模板.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1500);
    toastSafe('模板已下载，用 Excel 打开填写即可');
  };

  /* ---------------------------------------------------------------- 启动 */

  async function boot() {
    injectStyle();

    /* 探活 */
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const j = await r.json();
      STATE.ready = Boolean(j.live);
      STATE.model = j.model || null;
      STATE.mode = j.live ? 'live' : 'demo';
      STATE.lastError = j.reason || null;
      BATCH.max = Number(j.maxBatch) || 20;
      BATCH.chunk = Number(j.batchChunk) || 3;
      STATE.facts = SAMPLE_FACTS;
      STATE.factsName = '内置脱敏样例';
    } catch (e) {
      STATE.ready = false;
      STATE.mode = 'demo';
      STATE.lastError = '未检测到本地服务（/api/health 不可达），当前为演示样例模式';
      STATE.facts = SAMPLE_FACTS;
      STATE.factsName = '内置脱敏样例';
    }

    paintBadge();
    paintFactsBar();

    if (!STATE.ready) {
      console.warn('[fxhy]', STATE.lastError);
      setTimeout(() => {
        toastSafe('演示模式：未配置 KIMI_API_KEY，页面使用内置样例。配置后刷新即可实时生成');
      }, 900);
    }
  }

  /* 覆盖入口：等页面自身的脚本执行完再挂 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
