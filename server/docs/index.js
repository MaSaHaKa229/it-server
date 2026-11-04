// Модуль «Документы» (реестр нормативных документов) внутри портала
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { pool } = require('./db');

async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

function apiRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '50mb' }));
  r.use('/auth', require('./routes/auth'));
  r.use('/documents', require('./routes/documents'));
  r.use((req, res) => res.status(404).json({ error: 'Не найдено' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (максимум 50 МБ)' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!err.expose && !(err.status && err.status < 500)) console.error(err);
    res.status(err.status || 500).json({ error: err.expose || (err.status && err.status < 500) ? err.message : 'Внутренняя ошибка сервера' });
  });
  return r;
}

module.exports = { migrate, apiRouter };
