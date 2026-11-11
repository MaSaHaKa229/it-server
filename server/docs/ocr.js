// Распознавание текста сканированных страниц PDF (OCR) — в фоне, по одному документу.
//
// Картинки страниц достаёт тот же движок pdf.js, что разбирает текст (JPEG, сжатые, чёрно-белые CCITT/JBIG2),
// распознаёт tesseract.js (JavaScript + WebAssembly, работает без интернета) со словарями русского и английского.
// Распознанный текст добавляется в документ (и в поиск):
//   — если текст документа не меняли вручную (он пуст или равен тексту, извлечённому из файла), — страницы встают по порядку;
//   — иначе распознанное добавляется в конце отдельным блоком.
// Прежний текст сохраняется в истории версий.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { query, withTx } = require('./db');
const { extractPdf, cleanup, ranges, engine } = require('./extract');

const LANGS = ['rus', 'eng'];
const MIN_PIXELS = 120000;   // меньшие картинки (логотипы, печати) не распознаём
const MAX_IMAGES_PER_PAGE = 6;
const IDLE_MS = 3 * 60 * 1000; // распознаватель выгружается из памяти после простоя

let tesseract = null;
let unavailableReason = null;
try {
  tesseract = require('tesseract.js');
  for (const l of LANGS) require.resolve(`@tesseract.js-data/${l}/package.json`);
} catch (e) {
  tesseract = null;
  unavailableReason = 'на сервере не установлены компоненты распознавания (папка node_modules из архива зависимостей)';
}

const progressMap = new Map(); // id документа → { page, total }
let worker = null;
let idleTimer = null;
let running = false;
let again = false;

const available = () => !!tesseract;
const progress = (id) => progressMap.get(id) || null;

/** Словари — в одну папку (tesseract.js берёт все языки из одного места) */
function langDir() {
  const dir = path.join(os.tmpdir(), 'it-portal-tessdata');
  fs.mkdirSync(dir, { recursive: true });
  for (const l of LANGS) {
    const src = require.resolve(`@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`);
    const dst = path.join(dir, `${l}.traineddata.gz`);
    if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
  }
  return dir;
}

async function getWorker() {
  clearTimeout(idleTimer);
  if (!worker) {
    worker = await tesseract.createWorker(LANGS, 1, {
      langPath: langDir(), cacheMethod: 'none', gzip: true, logger: () => {},
      errorHandler: (e) => console.error('Распознавание текста:', e && e.message ? e.message : e),
    });
  }
  return worker;
}
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const w = worker; worker = null;
    if (w) await w.terminate().catch(() => {});
  }, IDLE_MS);
  idleTimer.unref?.();
}

/** Картинка pdf.js → PGM (оттенки серого) — этот формат tesseract читает без преобразований */
function toPgm(img) {
  const { width: w, height: h, kind, data } = img;
  const g = Buffer.alloc(w * h);
  if (kind === 1) { // 1 бит на точку
    const rb = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = (data[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
  } else {
    const n = kind === 3 ? 4 : 3;
    for (let i = 0; i < w * h; i++) g[i] = (data[i * n] * 299 + data[i * n + 1] * 587 + data[i * n + 2] * 114) / 1000;
  }
  return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), g]);
}

/** Картинки страницы (крупные) */
async function pageImages(lib, page) {
  const ops = await page.getOperatorList();
  const out = [];
  for (let k = 0; k < ops.fnArray.length && out.length < MAX_IMAGES_PER_PAGE; k++) {
    const fn = ops.fnArray[k];
    let img = null;
    try {
      if (fn === lib.OPS.paintImageXObject || fn === lib.OPS.paintJpegXObject) img = page.objs.get(ops.argsArray[k][0]);
      else if (fn === lib.OPS.paintInlineImageXObject) img = ops.argsArray[k][0];
    } catch { img = null; }
    if (img && img.data && img.width * img.height >= MIN_PIXELS) out.push(img);
  }
  return out;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function processDocument(id) {
  const { rows } = await query('SELECT filename, data FROM document_files WHERE document_id = $1', [id]);
  const file = rows[0];
  if (!file || !file.filename.toLowerCase().endsWith('.pdf')) {
    await query(`UPDATE document_files SET ocr_status = 'none' WHERE document_id = $1`, [id]);
    return;
  }
  const r = await extractPdf(file.data);
  await query('UPDATE document_files SET pages = $2, text_pages = $3 WHERE document_id = $1', [id, r.pages, r.textPages]);
  if (!r.emptyPages.length) {
    await query(`UPDATE document_files SET ocr_status = 'none', ocr_at = now() WHERE document_id = $1`, [id]);
    return;
  }

  const lib = engine('v2.0.550');
  const pdf = await lib.getDocument({ data: new Uint8Array(file.data), nativeImageDecoderSupport: 'none' }).promise;
  const w = await getWorker();
  const recognized = {}; // номер страницы → текст
  try {
    for (let n = 0; n < r.emptyPages.length; n++) {
      const p = r.emptyPages[n];
      progressMap.set(id, { page: n + 1, total: r.emptyPages.length });
      try {
        const page = await pdf.getPage(p);
        const parts = [];
        for (const img of await pageImages(lib, page)) {
          const res = await w.recognize(toPgm(img));
          const t = cleanup(res.data.text || '');
          if (t) parts.push(t);
        }
        page.cleanup?.();
        if (parts.length) recognized[p] = parts.join('\n\n');
      } catch (e) {
        console.error(`Распознавание текста: документ ${id}, стр. ${p}:`, e.message);
      }
    }
  } finally {
    pdf.destroy?.();
    scheduleIdle();
  }

  const pages = Object.keys(recognized).map(Number).sort((a, b) => a - b);
  if (pages.length) {
    await withTx(async (c) => {
      const { rows: [d] } = await c.query('SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id]);
      if (!d) return;
      const base = cleanup(r.text);
      let content;
      if (!norm(d.content) || norm(d.content) === norm(base)) {
        // Текст не меняли вручную — собираем документ по порядку страниц
        content = r.texts.map((t, i) => t || recognized[i + 1] || '').filter(Boolean).join('\n\n');
      } else {
        content = `${d.content}\n\n**Распознанный текст сканированных страниц (стр. ${ranges(pages)}):**\n\n`
          + pages.map((p) => recognized[p]).join('\n\n');
      }
      content = cleanup(content);
      await c.query(
        `INSERT INTO document_versions (document_id, title, doc_type, number, adopted_at, status, content, edited_by, edited_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, d.title, d.doc_type, d.number, d.adopted_at, d.status, d.content, d.updated_by, d.updated_at]);
      await c.query('UPDATE documents SET content = $2, updated_at = now() WHERE id = $1', [id, content]);
    });
  }
  await query(
    `UPDATE document_files SET ocr_status = 'done', ocr_pages = $2, ocr_error = $3, ocr_at = now() WHERE document_id = $1`,
    [id, pages, pages.length ? null : 'На сканированных страницах текст не найден']);
}

/** Обработать очередь: документы со статусом pending, по одному */
async function drain() {
  if (running) { again = true; return; }
  running = true;
  try {
    do {
      again = false;
      for (;;) {
        const { rows } = await query(
          `UPDATE document_files SET ocr_status = 'running'
            WHERE document_id = (SELECT document_id FROM document_files WHERE ocr_status = 'pending' ORDER BY uploaded_at LIMIT 1)
          RETURNING document_id`);
        if (!rows[0]) break;
        const id = rows[0].document_id;
        if (!tesseract) {
          await query(`UPDATE document_files SET ocr_status = 'unavailable', ocr_error = $2 WHERE document_id = $1`, [id, unavailableReason]);
          continue;
        }
        try {
          await processDocument(id);
        } catch (e) {
          console.error(`Распознавание текста: документ ${id}:`, e);
          const msg = e.code === '54000' ? 'Текст документа слишком велик для поиска' : (e.message || String(e)).slice(0, 300);
          await query(`UPDATE document_files SET ocr_status = 'error', ocr_error = $2, ocr_at = now() WHERE document_id = $1`, [id, msg])
            .catch(() => {});
        } finally {
          progressMap.delete(id);
        }
      }
    } while (again);
  } finally {
    running = false;
  }
}

const kick = () => { setImmediate(() => drain().catch((e) => console.error('Распознавание текста:', e.message))); };

/**
 * При запуске портала: в очередь — прерванные, ждавшие установки компонентов
 * и ранее загруженные PDF, которые ещё не проверялись (сканы прошлых версий распознаются сами).
 */
async function start() {
  try {
    await query(
      `UPDATE document_files SET ocr_status = 'pending'
        WHERE ocr_status IN ('running', 'unavailable')
           OR (ocr_status IS NULL AND lower(filename) LIKE '%.pdf' AND (pages IS NULL OR text_pages IS NULL OR text_pages < pages))`);
    await query(`UPDATE document_files SET ocr_status = 'none' WHERE ocr_status IS NULL`);
    if (!tesseract) console.warn(`Распознавание сканов PDF недоступно: ${unavailableReason}`);
    kick();
  } catch (e) {
    console.error('Распознавание текста:', e.message);
  }
}

module.exports = { start, kick, progress, available };
