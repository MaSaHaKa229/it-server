// Чтение таблиц из .xlsx и .csv без внешних зависимостей.
// .xlsx — это zip-архив с XML внутри: распаковываем встроенным zlib и разбираем нужные части.
const zlib = require('zlib');
const { HttpError } = require('./util');

const MAX_ROWS = 20000;
const MAX_COLS = 200;

// ---------------- ZIP ----------------
function readZip(buf) {
  // Ищем запись End Of Central Directory (с конца файла)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new HttpError(400, 'Файл повреждён или это не .xlsx');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new HttpError(400, 'Файл повреждён');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name.replace(/^\/+/, ''), { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => files.has(name),
    text(name) {
      const f = files.get(name);
      if (!f) return null;
      const lh = f.local;
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const raw = buf.subarray(start, start + f.csize);
      const data = f.method === 0 ? raw : f.method === 8 ? zlib.inflateRawSync(raw) : null;
      if (!data) throw new HttpError(400, 'Неподдерживаемое сжатие в файле');
      return data.toString('utf8');
    },
  };
}

// ---------------- XML helpers ----------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1].replace(/^\w+:/, (p) => (p === 'r:' ? 'r:' : ''))] = unescapeXml(m[2]);
  return out;
}
/** Текст из <t>…</t> внутри фрагмента (без фонетических подсказок <rPh>) */
const textOf = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)]
  .map((m) => unescapeXml(m[1] || '')).join('');

const colIndex = (ref) => {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// Встроенные форматы Excel, которые являются датами
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const isDateFormat = (code) => {
  const c = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  return /[dmy]/i.test(c) && !/^[#0.,\s%]*$/.test(c);
};

function serialToDate(serial, date1904) {
  const ms = Math.round((serial - (date1904 ? -1462 : 25569)) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  const time = iso.slice(11, 19);
  return time === '00:00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time.slice(0, 5)}`;
}

const numToText = (s) => {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  // Убираем артефакты плавающей точки (0.30000000000000004 → 0.3)
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15)));
};

// ---------------- XLSX ----------------
function readXlsx(buf) {
  const zip = readZip(buf);
  const wbXml = zip.text('xl/workbook.xml');
  if (!wbXml) throw new HttpError(400, 'В файле нет листов Excel. Сохраните его в формате .xlsx');
  const date1904 = /date1904\s*=\s*"(1|true)"/.test(wbXml);

  const rels = {};
  for (const m of (zip.text('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    let target = a.Target || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    rels[a.Id] = target.replace(/\/[^/]+\/\.\.\//g, '/');
  }

  const shared = [];
  const ss = zip.text('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(textOf(m[1] || ''));

  // Стили: какие индексы стилей являются датами
  const dateStyles = new Set();
  const st = zip.text('xl/styles.xml');
  if (st) {
    const custom = {};
    for (const m of st.matchAll(/<numFmt\b[^>]*\/?>/g)) {
      const a = attrs(m[0]);
      custom[a.numFmtId] = a.formatCode || '';
    }
    const xfs = (/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st) || [])[1] || '';
    let i = 0;
    for (const m of xfs.matchAll(/<xf\b[^>]*?(\/>|>)/g)) {
      const id = Number(attrs(m[0]).numFmtId || 0);
      if (DATE_FMT_IDS.has(id) || (custom[id] && isDateFormat(custom[id]))) dateStyles.add(i);
      i++;
    }
  }

  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const a = attrs(m[0]);
    const rid = a['r:id'] || a.id;
    const path = rels[rid];
    const xml = path && zip.text(path);
    if (xml == null) continue;
    sheets.push({ name: a.name || `Лист ${sheets.length + 1}`, rows: readSheet(xml, shared, dateStyles, date1904) });
  }
  if (!sheets.length) throw new HttpError(400, 'Не удалось прочитать листы файла');
  return sheets;
}

function readSheet(xml, shared, dateStyles, date1904) {
  const rows = [];
  const data = (/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml) || [])[1] || '';
  let nextRow = 0;
  for (const rm of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(rm[1]);
    const r = ra.r ? Number(ra.r) - 1 : nextRow;
    nextRow = r + 1;
    if (r >= MAX_ROWS + 50) break;
    const row = [];
    let nextCol = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(cm[1]);
      const c = ca.r ? colIndex(ca.r) : nextCol;
      nextCol = c + 1;
      if (c >= MAX_COLS) continue;
      const inner = cm[2] || '';
      const v = (/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let val = '';
      switch (ca.t) {
        case 's': val = shared[Number(v)] ?? ''; break;
        case 'inlineStr': val = textOf(inner); break;
        case 'str': val = v != null ? unescapeXml(v) : ''; break;
        case 'b': val = v === '1' ? 'Да' : v === '0' ? 'Нет' : ''; break;
        case 'e': val = ''; break;
        case 'd': val = v ? unescapeXml(v).slice(0, 10) : ''; break;
        default:
          if (v == null || v === '') val = '';
          else if (ca.s != null && dateStyles.has(Number(ca.s))) val = serialToDate(Number(v), date1904);
          else val = numToText(v);
      }
      row[c] = String(val).trim();
    }
    rows[r] = row;
  }
  return normalize(rows);
}

/** Прямоугольная таблица: пустые строки в конце убираем, дыры заполняем пустыми строками */
function normalize(rows) {
  let width = 0;
  for (const r of rows) if (r) width = Math.max(width, r.length);
  width = Math.min(width, MAX_COLS);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const row = [];
    for (let c = 0; c < width; c++) row.push(r[c] == null ? '' : String(r[c]));
    out.push(row);
  }
  while (out.length && out[out.length - 1].every((v) => v === '')) out.pop();
  if (out.length > MAX_ROWS + 1) throw new HttpError(400, `Слишком много строк (больше ${MAX_ROWS}). Разделите файл на части`);
  return out;
}

// ---------------- CSV ----------------
function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Excel в русской Windows сохраняет CSV в кодировке Windows-1251
    return new TextDecoder('windows-1251').decode(buf);
  }
}

function readCsv(buf) {
  const text = decodeText(buf).replace(/\r\n?/g, '\n');
  const first = text.split('\n', 1)[0];
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell.trim()); rows.push(row); }
  return [{ name: 'CSV', rows: normalize(rows) }];
}

/** Прочитать файл таблицы. Возвращает [{ name, rows: string[][] }] */
function readSpreadsheet(buf, filename = '') {
  const ext = (/\.([a-z0-9]+)$/i.exec(filename) || [])[1]?.toLowerCase();
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (ext === 'xls' || (buf.length > 8 && buf.readUInt32LE(0) === 0xe011cfd0)) {
    throw new HttpError(400, 'Старый формат .xls не поддерживается. Откройте файл в Excel и сохраните как .xlsx');
  }
  if (isZip) return readXlsx(buf);
  if (ext === 'xlsx' || ext === 'xlsm') throw new HttpError(400, 'Файл повреждён или это не .xlsx');
  return readCsv(buf);
}

module.exports = { readSpreadsheet };
