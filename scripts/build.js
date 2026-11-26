'use strict';

/**
 * 构建：把原始单文件演示页 + live.js 组装成可运行的前端。
 *
 * 原页面一行不改（参赛交付物要保持单文件可离线），
 * 只在其 </body> 前挂一个 live.js —— 页面内所有入口保持不变，
 * 由 live.js 在运行时覆盖为真实调用。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * 源页面查找顺序：
 *   1. 环境变量 DEMO_SRC（本地开发时指向参赛作品的原始文件）
 *   2. data/demo-source.html（随工程携带的副本，部署到 Vercel 时用这份）
 *   3. 参赛作品目录下的默认路径（仅本机存在）
 * 这样同一份构建脚本在本地和云端都能跑通。
 */
const CANDIDATES = [
  process.env.DEMO_SRC,
  path.join(ROOT, 'data', 'demo-source.html'),
  path.resolve(
    ROOT, '..', '..',
    '2026-08-31-15-47-31', '参赛作品',
    '2026浙江银行业AI智能体技能竞赛-知行队', '03_Demo演示页.html'
  )
].filter(Boolean);

const OUT = path.join(ROOT, 'public', 'index.html');
const TAG_RE = /\s*<!--\s*fxhy-live\s*-->[\s\S]*?<!--\s*\/fxhy-live\s*-->\s*/g;

function findSource() {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function main() {
  const SRC = findSource();
  if (!SRC) {
    console.error('找不到源页面。已尝试：');
    CANDIDATES.forEach((p) => console.error('  ' + p));
    console.error('\n请把 03_Demo演示页.html 复制到 data/demo-source.html，或用 DEMO_SRC 指定。');
    process.exit(1);
  }

  let html = fs.readFileSync(SRC, 'utf8');
  const originalSize = Buffer.byteLength(html);

  // 幂等：先清掉上一次注入
  html = html.replace(TAG_RE, '');

  if (!/<\/body>/i.test(html)) {
    console.error('源页面缺少 </body>，无法注入。');
    process.exit(1);
  }

  const inject =
    '\n<!-- fxhy-live -->\n' +
    '<script src="live.js" defer></script>\n' +
    '<!-- /fxhy-live -->\n';

  // live.js 必须晚于页面自身脚本执行；defer 保证按文档顺序在解析后执行
  html = html.replace(/<\/body>/i, inject + '</body>');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');

  // 校验 live.js 存在
  const livePath = path.join(ROOT, 'public', 'live.js');
  if (!fs.existsSync(livePath)) {
    console.error('缺少 public/live.js');
    process.exit(1);
  }

  console.log('构建完成');
  console.log('  源文件  ' + SRC);
  console.log('  输出    ' + OUT);
  console.log('  体积    ' + (originalSize / 1024 / 1024).toFixed(2) + ' MB → ' +
    (Buffer.byteLength(html) / 1024 / 1024).toFixed(2) + ' MB');
  console.log('  注入    <script src="live.js" defer>');
}

main();
