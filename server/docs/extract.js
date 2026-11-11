const mammoth = require('mammoth');
const { httpError } = require('./utils');

const ALLOWED_EXT = ['.pdf', '.docx', '.txt', '.md'];

// multer отдаёт имя файла в latin1 — восстанавливаем кириллицу
function fixFilename(name) {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('�') ? name : decoded;
  } catch {
    return name;
  }
}

function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Старые текстовые файлы часто в Windows-1251
    return new TextDecoder('windows-1251').decode(buffer);
  }
}

function cleanup(text) {
  return text
    .replace(/\u0000/g, '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- PDF ----------
// pdf.js из пакета pdf-parse подключаем напрямую и разбираем КАЖДУЮ страницу отдельно:
// сам pdf-parse при ошибке на странице молча возвращает пустую строку, и текст терялся без сообщения.
// Если основной движок не дал текста страницы, она разбирается вторым (более новым).
const PDF_ENGINES = ['v1.10.100', 'v2.0.550'];
const engines = {};
function engine(version) {
  if (!engines[version]) {
    const lib = require(`pdf-parse/lib/pdf.js/${version}/build/pdf.js`);
    lib.disableWorker = true;
    engines[version] = lib;
  }
  return engines[version];
}

async function pageText(page) {
  const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  let lastY;
  let text = '';
  for (const item of content.items) {
    text += (lastY === item.transform[5] || lastY === undefined ? '' : '\n') + item.str;
    lastY = item.transform[5];
  }
  return text;
}

async function openPdf(version, buffer) {
  // Копия данных: движок может забрать буфер себе
  const task = engine(version).getDocument({ data: new Uint8Array(buffer) });
  return task.promise || task;
}

/** Текст PDF по страницам: { text, pages, textPages, emptyPages: [номера] } */
async function extractPdf(buffer) {
  let doc;
  let used = 0;
  let firstError;
  for (; used < PDF_ENGINES.length; used++) {
    try { doc = await openPdf(PDF_ENGINES[used], buffer); break; } catch (e) { firstError = firstError || e; }
  }
  if (!doc) throw firstError;
  const total = doc.numPages;
  const texts = new Array(total).fill('');
  const read = async (d, i) => { try { return (await pageText(await d.getPage(i))).trim(); } catch { return ''; } };
  for (let i = 1; i <= total; i++) texts[i - 1] = await read(doc, i);

  // Страницы без текста пробуем вторым движком
  let missing = texts.map((t, i) => (t ? 0 : i + 1)).filter(Boolean);
  if (missing.length && used + 1 < PDF_ENGINES.length) {
    try {
      const alt = await openPdf(PDF_ENGINES[used + 1], buffer);
      for (const i of missing) texts[i - 1] = await read(alt, i);
      if (alt.destroy) alt.destroy();
    } catch { /* второй движок не открыл файл — остаёмся с тем, что есть */ }
    missing = texts.map((t, i) => (t ? 0 : i + 1)).filter(Boolean);
  }
  if (doc.destroy) doc.destroy();
  return { text: texts.filter(Boolean).join('\n\n'), texts, pages: total, textPages: total - missing.length, emptyPages: missing };
}

/** «4, 5, 6, 9» → «4–6, 9» */
function ranges(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? String(nums[i]) : `${nums[i]}–${nums[j]}`);
    i = j;
  }
  return out.join(', ');
}

/**
 * Извлечь текст из файла.
 * Возвращает { text, pages, textPages, warning } — pages/textPages только для PDF.
 */
async function extractFile(file) {
  const name = file.originalname.toLowerCase();
  let text;
  let info = { pages: null, textPages: null, warning: null };
  try {
    if (name.endsWith('.docx')) {
      text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
    } else if (name.endsWith('.pdf')) {
      const r = await extractPdf(file.buffer);
      text = r.text;
      info = { pages: r.pages, textPages: r.textPages, warning: null };
      if (r.emptyPages.length === r.pages) {
        info.warning = `В файле ${r.pages} стр., но текста в них нет — это скан (изображения страниц). ` +
          'После сохранения документа текст будет распознан автоматически и попадёт в поиск (займёт от нескольких секунд до нескольких минут). ' +
          'Сам файл сохранится и откроется целиком кнопкой «Открыть оригинал».';
      } else if (r.emptyPages.length) {
        info.warning = `Текст получен с ${r.textPages} из ${r.pages} стр. Без текста страницы: ${ranges(r.emptyPages)} — ` +
          'скорее всего, это сканы. После сохранения документа их текст будет распознан автоматически и добавлен к документу.';
      }
    } else if (name.endsWith('.txt') || name.endsWith('.md')) {
      text = decodeText(file.buffer);
    } else {
      throw httpError(400, `Неподдерживаемый формат. Допустимо: ${ALLOWED_EXT.join(', ')}`);
    }
  } catch (e) {
    if (e.expose) throw e;
    throw httpError(400, `Не удалось извлечь текст из файла: ${e.message}`);
  }
  return { text: cleanup(text), ...info };
}

const extractText = async (file) => (await extractFile(file)).text;

module.exports = { extractText, extractFile, extractPdf, cleanup, ranges, engine, fixFilename, ALLOWED_EXT };
