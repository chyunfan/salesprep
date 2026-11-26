'use strict';

/**
 * 零依赖表格解析：CSV（UTF-8 / GBK）与 XLSX（解 zip + 读 XML）。
 *
 * 只取第一张工作表，够用且可预测——客户清单从来不靠第二张表表达业务含义。
 * 不做样式、公式、合并单元格的还原：合并单元格的空位按空串处理，
 * 由后续"列映射"环节给用户看清楚，而不是猜。
 */

const zlib = require('zlib');

const MAX_ROWS = 500;

/**
 * 前端把文件读成 base64 塞进 JSON，体积会膨胀约 1/3。
 * Vercel 的函数请求体上限是 4.5 MB（平台层面，改不了），
 * 所以云端把原始文件卡在 3 MB，留足编码与 JSON 外壳的余量；
 * 本地/内网没有这层限制，放宽到 8 MB。
 */
const MAX_UPLOAD_MB = Number(process.env.UPLOAD_MAX_MB) > 0
  ? Number(process.env.UPLOAD_MAX_MB)
  : (process.env.VERCEL ? 3 : 8);

/* ------------------------------------------------------------------ 文本解码 */

/** Excel 导出的 CSV 在中文 Windows 上常是 GBK，先按 UTF-8 严格解，失败再退 GBK */
function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch (__) {
      return buf.toString('utf8');
    }
  }
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ CSV */

/** RFC4180 的够用实现：双引号包裹、"" 转义、字段内换行 */
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ ZIP */

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** 只建目录索引，按需解压，避免把 1MB 的 xlsx 全展开 */
function readZipIndex(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 zip 结尾）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function readZipEntry(buf, ent) {
  const lo = ent.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + ent.compSize);

  if (ent.method === 0) return data;
  if (ent.method === 8) {
    try {
      return zlib.inflateRawSync(data);
    } catch (_) {
      return zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    }
  }
  return null; // 不支持的压缩方式（如 bzip2），极少见
}

/* ------------------------------------------------------------------ XLSX */

function readSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1];
    let s = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(inner))) s += decodeXml(tm[1]);
    out.push(s);
  }
  return out;
}

/** "AB12" → 27（0 基） */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readSheetRows(xml, shared) {
  const rows = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;

  while ((rm = rowRe.exec(xml))) {
    const body = rm[2] || '';
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;

    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const refM = /\br="([A-Z]+\d+)"/.exec(attrs);
      const tM = /\bt="([^"]+)"/.exec(attrs);
      const idx = refM ? colIndex(refM[1]) : cells.length;

      let val = '';
      if (tM && tM[1] === 'inlineStr') {
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let tm;
        while ((tm = tRe.exec(inner))) val += decodeXml(tm[1]);
      } else {
        const vM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vM ? decodeXml(vM[1]) : '';
        if (tM && tM[1] === 's') val = shared[Number(raw)] ?? '';
        else val = raw;
      }
      cells[idx >= 0 ? idx : cells.length] = val;
    }

    // 补齐中间空列
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/* ------------------------------------------------------------------ 统一出口 */

const DATE_RE = /日期|时间|年月|date|time/i;

/** Excel 日期序列号 → YYYY-MM-DD（仅在列名像日期时启用，避免把金额误转） */
function excelDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return null;
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

/** 二维数组 → { headers, rows } */
function toTable(matrix) {
  const clean = matrix.filter((r) => r.some((c) => String(c == null ? '' : c).trim() !== ''));
  if (!clean.length) return { headers: [], rows: [] };

  const headers = clean[0].map((h, i) => {
    const s = String(h == null ? '' : h).trim();
    return s || '列' + (i + 1);
  });

  const rows = [];
  for (const r of clean.slice(1)) {
    const o = {};
    let empty = true;
    headers.forEach((h, i) => {
      let v = r[i];
      v = v == null ? '' : String(v).trim();
      if (DATE_RE.test(h)) {
        const d = excelDate(v);
        if (d) v = d;
      }
      if (v !== '') empty = false;
      o[h] = v;
    });
    if (!empty) rows.push(o);
  }
  return { headers, rows };
}

/**
 * @param {Buffer} buf 文件内容
 * @param {string} filename 用于判断格式
 * @returns {{headers:string[], rows:object[], total:number, truncated:boolean, kind:string}}
 */
function parseTable(buf, filename) {
  const name = String(filename || '').toLowerCase();
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  let matrix;

  if (isZip || name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    const idx = readZipIndex(buf);
    const wb = idx.get('xl/workbook.xml');
    const sst = idx.get('xl/sharedStrings.xml');
    let sheetName = null;

    // 优先按 workbook 里第一张表的 r:id 找，找不到就退回 sheet1.xml
    if (wb) {
      const xml = readZipEntry(buf, wb);
      const m = /<sheet\b[^>]*name="([^"]*)"[^>]*\/>/.exec(xml ? xml.toString('utf8') : '');
      if (m) sheetName = m[1];
    }
    if (!idx.has('xl/worksheets/sheet1.xml')) {
      throw new Error('这个文件里没有可读的工作表（只支持 .xlsx，老的 .xls 请另存为 .xlsx 或 .csv）');
    }

    const sheetXml = readZipEntry(buf, idx.get('xl/worksheets/sheet1.xml')).toString('utf8');
    const shared = sst ? readSharedStrings(readZipEntry(buf, sst).toString('utf8')) : [];
    matrix = readSheetRows(sheetXml, shared);

    const table = toTable(matrix);
    const total = table.rows.length;
    table.rows = table.rows.slice(0, MAX_ROWS);
    return { ...table, total, truncated: total > MAX_ROWS, kind: 'xlsx', sheetName };
  }

  if (name.endsWith('.csv') || name.endsWith('.txt') || !name.includes('.')) {
    matrix = parseCsv(decodeText(buf));
    const table = toTable(matrix);
    const total = table.rows.length;
    table.rows = table.rows.slice(0, MAX_ROWS);
    return { ...table, total, truncated: total > MAX_ROWS, kind: 'csv' };
  }

  throw new Error('只支持 .xlsx 与 .csv 文件');
}

/** 识别"哪一列是企业名称" */
function detectCompanyCol(headers) {
  const strong = /企业名称|公司名称|客户名称|单位名称|企业全称|客户全称|户名/;
  const weak = /企业|公司|客户|单位|名称/;
  const hit = headers.find((h) => strong.test(h));
  if (hit) return hit;
  return headers.find((h) => weak.test(h)) || headers[0] || '';
}

/** 上传接口的业务封装：server.js 与 Vercel 函数共用，避免两处逻辑分叉 */
const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;

function parseUpload(body) {
  const raw = String((body && body.base64) || '');
  const filename = String((body && body.filename) || '');
  if (!raw) {
    return { status: 400, json: { ok: false, error: 'BAD_INPUT', message: '没有收到文件内容' } };
  }

  let buf;
  try {
    buf = Buffer.from(raw.replace(/^data:[^,]*,/, ''), 'base64');
  } catch (_) {
    return { status: 400, json: { ok: false, error: 'BAD_INPUT', message: '文件内容不是合法的 base64' } };
  }
  if (!buf.length) {
    return { status: 400, json: { ok: false, error: 'BAD_INPUT', message: '文件是空的' } };
  }
  if (buf.length > MAX_UPLOAD) {
    return {
      status: 413,
      json: { ok: false, error: 'TOO_LARGE', message: `文件超过 ${MAX_UPLOAD / 1024 / 1024} MB，请缩减后再传` }
    };
  }

  try {
    const t = parseTable(buf, filename);
    if (!t.rows.length) {
      return {
        status: 400,
        json: {
          ok: false,
          error: 'EMPTY',
          message: '表格里没有数据行。请确认第一行是表头，从第二行开始是客户'
        }
      };
    }
    return {
      status: 200,
      json: {
        ok: true,
        kind: t.kind,
        sheetName: t.sheetName || null,
        headers: t.headers,
        rows: t.rows,
        total: t.total,
        truncated: t.truncated,
        maxRows: MAX_ROWS,
        companyCol: detectCompanyCol(t.headers)
      }
    };
  } catch (e) {
    return { status: 400, json: { ok: false, error: 'PARSE_FAILED', message: e.message } };
  }
}

module.exports = { parseTable, parseUpload, detectCompanyCol, MAX_ROWS };
