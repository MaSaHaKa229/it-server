import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

export async function migrate() {
  const sql = await readFile(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
  await pool.query(sql);
  // Базовые категории — только в пустую таблицу
  await pool.query(`
    INSERT INTO categories (name, color)
    SELECT v.name, v.color FROM (VALUES
      ('Встречи', '#0ea5e9'), ('Обслуживание техники', '#8b5cf6'), ('Отчётность', '#f59e0b'),
      ('Документы', '#10b981'), ('Обучение', '#ec4899')) AS v(name, color)
    WHERE NOT EXISTS (SELECT 1 FROM categories)`);
}
