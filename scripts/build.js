'use strict';

/**
 * 构建：把原始单文件演示页 + live.js 组装成可运行的前端。
 *
 * 原页面一行不改（参赛交付物要保持单文件可离线），
 * 只在其 </body> 前挂一个 live.js —— 页面内所有入口保持不变，
 * 由 live.js 在运行时覆盖为真实调用。
 *
 * 云端（Vercel）构建时只认 data/demo-source.html：
 * 那是随工程提交的副本，不能依赖本机的参赛作品目录。
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
const LIVE = path.join(ROOT, 'public', 'live.js');
const TAG_RE = /\s*<!--\s*fxhy-live\s*-->[\s\S]*?<!--\s*\/fxhy-live\s*-->\s*/g;

function findSource() {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 相对工程根的展示路径，报错时让人一眼看出是哪个文件 */
function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/') || p;
}

/**
 * 打印"仓库里到底缺什么"。
 * Vercel 上代码来自 git 仓库，本地有的文件不等于云端有——
 * 这个提示就是为此而写：直接点名要提交的文件，而不是只说"找不到"。
 */
function reportMissing() {
  console.error('构建失败：找不到源页面（用于生成 public/index.html）。');
  console.error('');
  console.error('已尝试的路径：');
  CANDIDATES.forEach((p) => console.error('  ' + p));
  console.error('');
  console.error('云端部署时，仓库里必须包含这两个文件（本地产物不会被自动带上）：');
  console.error('  data/demo-source.html   约 1.0 MB，演示页源文件');
  console.error('  public/live.js          约 60 KB，注入页面的接入层');
  console.error('');
  console.error('检查方法：在仓库首页看有没有 data 与 public 两个目录。');
  console.error('补传后推送即会自动重新构建，无需改配置。');
  console.error('');
  console.error('本地开发也可用 DEMO_SRC 直接指向参赛作品原件：');
  console.error('  DEMO_SRC="../2026-08-31-15-47-31/参赛作品/…/03_Demo演示页.html" npm run build');
}

function main() {
  // live.js 是运行时依赖，缺了即使构建成功页面也是哑的，先查
  if (!fs.existsSync(LIVE)) {
    console.error('构建失败：缺少 ' + rel(LIVE));
    console.error('该文件是前端接入层，必须随仓库提交（不是构建产物）。');
    process.exit(1);
  }

  const SRC = findSource();

  if (!SRC) {
    // 已有产物时不让构建失败：常见于仓库里提交了 index.html、
    // 或本地只改了别的文件想重新部署。硬失败会阻断整条部署链。
    if (fs.existsSync(OUT)) {
      console.warn('未找到源页面，沿用已有的 ' + rel(OUT));
      console.warn('若要重新生成，请补上 data/demo-source.html 或设置 DEMO_SRC。');
      return;
    }
    reportMissing();
    process.exit(1);
  }

  let html = fs.readFileSync(SRC, 'utf8');
  const originalSize = Buffer.byteLength(html);

  // 幂等：先清掉上一次注入
  html = html.replace(TAG_RE, '');

  if (!/<\/body>/i.test(html)) {
    console.error('源页面缺少 </body>，无法注入：' + rel(SRC));
    process.exit(1);
  }

  /*
   * 带内容指纹：线上多次改 live.js 时，浏览器与 CDN 容易继续用旧副本，
   * 表现成"改了没生效"。文件名后缀随内容变，旧缓存自然失效。
   * 指纹只加在 query 上，不影响 live.js 自身按 src 目录推导接口前缀。
   */
  const liveHash = require('crypto')
    .createHash('md5')
    .update(fs.readFileSync(LIVE))
    .digest('hex')
    .slice(0, 8);

  const inject =
    '\n<!-- fxhy-live -->\n' +
    '<script src="live.js?v=' + liveHash + '" defer></script>\n' +
    '<!-- /fxhy-live -->\n';

  // live.js 必须晚于页面自身脚本执行；defer 保证按文档顺序在解析后执行
  html = html.replace(/<\/body>/i, inject + '</body>');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');

  console.log('构建完成');
  console.log('  源文件  ' + SRC);
  console.log('  输出    ' + rel(OUT));
  console.log('  体积    ' + (originalSize / 1024 / 1024).toFixed(2) + ' MB → ' +
    (Buffer.byteLength(html) / 1024 / 1024).toFixed(2) + ' MB');
  console.log('  注入    <script src="live.js?v=' + liveHash + '" defer>');
}

main();
