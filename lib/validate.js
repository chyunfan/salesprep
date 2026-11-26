'use strict';

/**
 * 校验层：三道关。
 *
 * 关卡 1 · 结构校验 —— 字段是否存在、类型是否正确、数量是否符合契约
 * 关卡 2 · 禁词过滤 —— 确定性替换，不指望提示词
 * 关卡 3 · 事实比对 —— 输出里的每个数字，必须能在 FACTS 中找到原值
 *
 * 这一层是"助手"和"风险源"的分界线。模型输出永远不可信，只有代码可信。
 */

const { BANNED } = require('./prompts');

/* ---------------- 工具 ---------------- */

function walkStrings(node, fn, path = '$') {
  if (typeof node === 'string') return fn(node, path);
  if (Array.isArray(node)) return node.forEach((v, i) => walkStrings(v, fn, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) walkStrings(node[k], fn, `${path}.${k}`);
  }
}

/** 归一化：去逗号/空格/全角符号，便于数字比对 */
function normalize(s) {
  return String(s)
    .replace(/[，,\s\u00a0]/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/％/g, '%')
    .toLowerCase();
}

/* ---------------- 关卡 1：结构 ---------------- */

function checkStructure(task, data) {
  const errors = [];

  if (task === 'report') {
    if (!data || typeof data !== 'object') return ['返回内容不是对象'];
    if (typeof data.company !== 'string' || !data.company.trim()) errors.push('缺少 company');
    if (!Array.isArray(data.chapters) || data.chapters.length < 5) {
      errors.push(`chapters 至少 5 章，实际 ${Array.isArray(data.chapters) ? data.chapters.length : 0}`);
    } else {
      data.chapters.forEach((c, i) => {
        if (!c || typeof c.title !== 'string') errors.push(`chapters[${i}] 缺少 title`);
        if (!Array.isArray(c.blocks) || !c.blocks.length) errors.push(`chapters[${i}] 缺少 blocks`);
      });
    }
    for (const k of ['marketing_points', 'risks', 'gaps']) {
      if (!Array.isArray(data[k])) errors.push(`${k} 必须是数组`);
    }
  }

  if (task === 'script') {
    if (!data || !Array.isArray(data.scenes)) return ['缺少 scenes 数组'];
    if (data.scenes.length !== 5) errors.push(`scenes 必须恰好 5 个，实际 ${data.scenes.length}`);
    data.scenes.forEach((s, i) => {
      if (!s || typeof s.name !== 'string') errors.push(`scenes[${i}] 缺少 name`);
      if (!Array.isArray(s.points) || s.points.length !== 3) {
        errors.push(`scenes[${i}].points 必须恰好 3 条`);
      }
      if (!Array.isArray(s.quotes) || s.quotes.length !== 3) {
        errors.push(`scenes[${i}].quotes 必须恰好 3 条`);
      } else if (s.quotes.some((q) => typeof q !== 'string' || q.trim().length < 8)) {
        errors.push(`scenes[${i}].quotes 存在过短或非文本条目`);
      }
      if (typeof s.basis !== 'string') errors.push(`scenes[${i}] 缺少 basis`);
    });
  }

  return errors;
}

/* ---------------- 关卡 2：禁词 ---------------- */

function filterBanned(data) {
  const hits = [];

  function rebuild(node, path) {
    if (typeof node === 'string') {
      let out = node;
      for (const { word, to } of BANNED) {
        if (out.includes(word)) {
          hits.push({ word, to, path, count: out.split(word).length - 1 });
          out = out.split(word).join(to);
        }
      }
      return out;
    }
    if (Array.isArray(node)) return node.map((v, i) => rebuild(v, `${path}[${i}]`));
    if (node && typeof node === 'object') {
      const o = {};
      for (const k of Object.keys(node)) o[k] = rebuild(node[k], `${path}.${k}`);
      return o;
    }
    return node;
  }

  return { data: rebuild(data, '$'), hits };
}

/* ---------------- 关卡 3：事实比对 ---------------- */

/**
 * 提取"事实性数字"：长度 >= 2 的数字串（含千分位、小数、百分号）。
 * 章节序号（一/二…）、场景序号（①②…）、步骤编号不参与比对。
 */
function extractNumbers(text) {
  const out = [];
  // 先剔除占位符，占位符里的字段名可能含数字
  const cleaned = String(text).replace(/\{\{[A-Z0-9_]+\}\}/g, ' ');
  const re = /\d[\d,.]*%?/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const tok = m[0].replace(/[.,]$/, '');
    const bare = tok.replace(/,/g, '');
    if (bare.replace(/[.%]/g, '').length < 2) continue; // 单个数字噪音太大，跳过
    out.push(tok);
  }
  return out;
}

function checkFacts(data, facts) {
  const factText = normalize(JSON.stringify(facts || {}));
  const unverified = [];

  function scan(node, path) {
    if (typeof node === 'string') {
      for (const tok of extractNumbers(node)) {
        if (!factText.includes(normalize(tok))) {
          unverified.push({ token: tok, path, sample: node.slice(0, 60) });
        }
      }
      return;
    }
    if (Array.isArray(node)) return node.forEach((v, i) => scan(v, `${path}[${i}]`));
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) scan(node[k], `${path}.${k}`);
    }
  }

  scan(data, '$');

  // 去重（同一 token + 同一路径只报一次）
  const seen = new Set();
  const unique = unverified.filter((u) => {
    const key = u.path + '|' + u.token;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique;
}

/* ---------------- 总装 ---------------- */

/**
 * @returns {{data:object, checks:{structure:string[], banned:Array, unverified:Array}, pass:boolean, fatal:boolean}}
 *   fatal=true 表示结构性问题，必须重试或降级
 *   pass=false 但 fatal=false 表示"有瑕疵但可用"，前端需标注
 */
function runChecks(task, data, facts) {
  const structure = checkStructure(task, data);
  if (structure.length) {
    return { data, checks: { structure, banned: [], unverified: [] }, pass: false, fatal: true };
  }

  const { data: cleaned, hits } = filterBanned(data);
  const unverified = checkFacts(cleaned, facts);

  const pass = hits.length === 0 && unverified.length === 0;
  return {
    data: cleaned,
    checks: {
      structure: [],
      banned: hits,
      unverified: unverified.slice(0, 30)
    },
    pass,
    fatal: false
  };
}

module.exports = { runChecks, checkStructure, filterBanned, checkFacts, extractNumbers, normalize };
