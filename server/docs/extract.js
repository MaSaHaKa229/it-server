const mammoth = require('mammoth');
// Прямой импорт: index.js пакета pdf-parse в некоторых окружениях пытается читать тестовый файл
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
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

async function extractText(file) {
  const name = file.originalname.toLowerCase();
  let text;
  try {
    if (name.endsWith('.docx')) {
      text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
    } else if (name.endsWith('.pdf')) {
      text = (await pdfParse(file.buffer)).text;
    } else if (name.endsWith('.txt') || name.endsWith('.md')) {
      text = decodeText(file.buffer);
    } else {
      throw httpError(400, `Неподдерживаемый формат. Допустимо: ${ALLOWED_EXT.join(', ')}`);
    }
  } catch (e) {
    if (e.expose) throw e;
    throw httpError(400, `Не удалось извлечь текст из файла: ${e.message}`);
  }
  return cleanup(text);
}

module.exports = { extractText, fixFilename, ALLOWED_EXT };
