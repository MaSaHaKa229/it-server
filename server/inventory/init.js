// Инициализация БД: схема + суперадмин (+ демо-данные с флагом --demo)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, query } = require('./db');

async function applySchema() {
  // Проверка версии сервера: нужны JSONB, ON CONFLICT, IF NOT EXISTS для индексов
  const v = await query("SELECT current_setting('server_version_num') AS server_version_num");
  const num = Number(v.rows[0].server_version_num);
  if (num < 110000) {
    const full = (await query('SELECT version() AS v')).rows[0].v;
    throw new Error(`Нужен PostgreSQL 11 или новее, а подключён: ${full}`);
  }

  // Выполняем схему по одной команде, чтобы при ошибке показать, какая именно не прошла
  let sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  sql = sql.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim())
    .filter(Boolean);
  for (let i = 0; i < statements.length; i++) {
    try {
      await query(statements[i]);
    } catch (e) {
      const st = statements[i];
      let where = '';
      if (e.position) {
        const pos = Number(e.position) - 1;
        const lineStart = st.lastIndexOf('\n', pos) + 1;
        const lineEnd = st.indexOf('\n', pos);
        where = `\n  Строка с ошибкой: ${st.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()}`;
      }
      throw new Error(`${e.message}\n  Команда №${i + 1} в schema.sql: ${st.split('\n')[0]}${where}`);
    }
  }
}

async function ensureSuperadmin() {
  const { rows } = await query(`SELECT count(*)::int AS n FROM users WHERE role = 'superadmin'`);
  if (rows[0].n) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  await query(
    `INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, 'superadmin')
     ON CONFLICT (username) DO UPDATE SET role = 'superadmin', is_active = TRUE`,
    [username, await bcrypt.hash(password, 10), 'Суперадминистратор']);
  console.log(`\n  Создан суперадмин: ${username} / ${password}`);
  if (!process.env.ADMIN_PASSWORD) console.log('  ВНИМАНИЕ: смените пароль после первого входа!\n');
}

async function seedDemo() {
  const { rows } = await query('SELECT count(*)::int AS n FROM devices');
  if (rows[0].n) { console.log('Демо-данные не добавлены: в базе уже есть устройства'); return; }
  const L = {};
  const lk = async (kind, value) => {
    const r = await query(
      `INSERT INTO lookups (kind, value) VALUES ($1, $2)
       ON CONFLICT (kind, value) DO UPDATE SET value = EXCLUDED.value RETURNING id`, [kind, value]);
    return (L[kind + ':' + value] = r.rows[0].id);
  };
  const types = Object.fromEntries((await query('SELECT id, code FROM device_types')).rows.map((r) => [r.code, r.id]));
  const depts = ['Бухгалтерия', 'Отдел кадров', 'Служба ИТ', 'Отдел продаж', 'Юридический отдел'];
  const emps = ['Иванов И.И.', 'Петрова А.С.', 'Сидоров П.П.', 'Кузнецова М.В.', 'Смирнов Д.А.', 'Волкова Е.Н.'];
  for (const d of depts) await lk('department', d);
  for (const e of emps) await lk('employee', e);
  for (const x of ['Каб. 101', 'Каб. 205', 'Серверная', 'Каб. 310']) await lk('location', x);
  for (const x of ['Intel Core i5-12400', 'Intel Core i7-12700', 'AMD Ryzen 5 5600G', 'Intel Xeon Silver 4314']) await lk('cpu', x);
  for (const x of ['8 ГБ', '16 ГБ', '32 ГБ', '128 ГБ']) await lk('ram', x);
  for (const x of ['SSD 256 ГБ', 'SSD 512 ГБ', 'SSD 1 ТБ', 'RAID10 4×1.92 ТБ']) await lk('storage', x);
  for (const x of ['Windows 10 Pro', 'Windows 11 Pro', 'Windows Server 2022', 'Astra Linux 1.7']) await lk('os', x);
  for (const x of ['Dell OptiPlex 7010', 'Lenovo ThinkCentre M70q', 'HP ProBook 450 G9', 'Dell PowerEdge R650',
    'HP LaserJet Pro M404dn', 'Kyocera ECOSYS M2540dn', 'Canon i-SENSYS MF445dw']) await lk('model', x);

  const sw = {};
  for (const [name, vendor] of [['Microsoft Office 2021', 'Microsoft'], ['1С:Предприятие 8.3', '1С'],
    ['Kaspersky Endpoint Security', 'Лаборатория Касперского'], ['Google Chrome', 'Google'],
    ['7-Zip', 'Igor Pavlov'], ['КонсультантПлюс', 'КонсультантПлюс']]) {
    sw[name] = (await query('INSERT INTO software (name, vendor) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET vendor = EXCLUDED.vendor RETURNING id', [name, vendor])).rows[0].id;
  }

  const admin = (await query(`SELECT id FROM users WHERE role = 'superadmin' ORDER BY id LIMIT 1`)).rows[0].id;
  const add = async (d, soft = []) => {
    const r = await query(
      `INSERT INTO devices (type_id, inv_number, hostname, model_id, cpu_id, ram_id, storage_id, os_id, employee_id,
         department_id, location_id, serial_number, ip_address, status, specs, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING id`,
      [types[d.t], d.inv, d.host, L['model:' + d.model], L['cpu:' + d.cpu] || null, L['ram:' + d.ram] || null,
        L['storage:' + d.disk] || null, L['os:' + d.os] || null, L['employee:' + d.emp] || null,
        L['department:' + d.dep] || null, L['location:' + d.loc] || null, d.sn, d.ip, d.status || 'in_use', d.specs || null, admin]);
    for (const [name, ver] of soft) {
      await query('INSERT INTO device_software (device_id, software_id, version) VALUES ($1, $2, $3)', [r.rows[0].id, sw[name], ver]);
    }
    await query(`INSERT INTO device_history (device_id, user_id, action) VALUES ($1, $2, 'created')`, [r.rows[0].id, admin]);
  };
  const office = [['Microsoft Office 2021', '2108'], ['Kaspersky Endpoint Security', '12.3'], ['Google Chrome', '129']];
  await add({ t: 'PC', inv: 'ИН-0001', host: 'BUH-PC01', model: 'Dell OptiPlex 7010', cpu: 'Intel Core i5-12400', ram: '16 ГБ', disk: 'SSD 512 ГБ', os: 'Windows 11 Pro', emp: 'Петрова А.С.', dep: 'Бухгалтерия', loc: 'Каб. 101', sn: 'DL7010-8841', ip: '10.0.1.21' }, [...office, ['1С:Предприятие 8.3', '8.3.24']]);
  await add({ t: 'PC', inv: 'ИН-0002', host: 'BUH-PC02', model: 'Dell OptiPlex 7010', cpu: 'Intel Core i5-12400', ram: '8 ГБ', disk: 'SSD 256 ГБ', os: 'Windows 10 Pro', emp: 'Кузнецова М.В.', dep: 'Бухгалтерия', loc: 'Каб. 101', sn: 'DL7010-8842', ip: '10.0.1.22' }, [...office, ['1С:Предприятие 8.3', '8.3.24'], ['КонсультантПлюс', '4018']]);
  await add({ t: 'PC', inv: 'ИН-0003', host: 'HR-PC01', model: 'Lenovo ThinkCentre M70q', cpu: 'AMD Ryzen 5 5600G', ram: '16 ГБ', disk: 'SSD 512 ГБ', os: 'Windows 11 Pro', emp: 'Волкова Е.Н.', dep: 'Отдел кадров', loc: 'Каб. 205', sn: 'LNV-M70Q-1122', ip: '10.0.1.31' }, office);
  await add({ t: 'PC', inv: 'ИН-0004', host: 'SALES-PC03', model: 'Lenovo ThinkCentre M70q', cpu: 'Intel Core i5-12400', ram: '8 ГБ', disk: 'SSD 256 ГБ', os: 'Windows 10 Pro', emp: 'Смирнов Д.А.', dep: 'Отдел продаж', loc: 'Каб. 310', sn: 'LNV-M70Q-1190', ip: '10.0.1.45', status: 'broken', specs: 'Не включается, подозрение на БП' }, office);
  await add({ t: 'NB', inv: 'ИН-0005', host: 'IT-NB01', model: 'HP ProBook 450 G9', cpu: 'Intel Core i7-12700', ram: '32 ГБ', disk: 'SSD 1 ТБ', os: 'Windows 11 Pro', emp: 'Сидоров П.П.', dep: 'Служба ИТ', loc: 'Каб. 205', sn: 'HP450G9-5531', ip: '10.0.1.60' }, [...office, ['7-Zip', '24.08']]);
  await add({ t: 'SRV', inv: 'ИН-0100', host: 'SRV-DC01', model: 'Dell PowerEdge R650', cpu: 'Intel Xeon Silver 4314', ram: '128 ГБ', disk: 'RAID10 4×1.92 ТБ', os: 'Windows Server 2022', dep: 'Служба ИТ', loc: 'Серверная', sn: 'R650-00017', ip: '10.0.0.10', specs: 'Контроллер домена, DNS, DHCP' });
  await add({ t: 'SRV', inv: 'ИН-0101', host: 'SRV-1C', model: 'Dell PowerEdge R650', cpu: 'Intel Xeon Silver 4314', ram: '128 ГБ', disk: 'RAID10 4×1.92 ТБ', os: 'Windows Server 2022', dep: 'Служба ИТ', loc: 'Серверная', sn: 'R650-00018', ip: '10.0.0.11' }, [['1С:Предприятие 8.3', '8.3.24']]);
  await add({ t: 'PRN', inv: 'ИН-0200', host: 'PRN-BUH', model: 'HP LaserJet Pro M404dn', emp: 'Петрова А.С.', dep: 'Бухгалтерия', loc: 'Каб. 101', sn: 'HPM404-7781', ip: '10.0.2.10' });
  await add({ t: 'PRN', inv: 'ИН-0201', host: 'PRN-OLD', model: 'HP LaserJet Pro M404dn', dep: 'Отдел продаж', loc: 'Каб. 310', sn: 'HPM404-1002', ip: '10.0.2.11', status: 'written_off' });
  await add({ t: 'MFU', inv: 'ИН-0300', host: 'MFU-HR', model: 'Kyocera ECOSYS M2540dn', dep: 'Отдел кадров', loc: 'Каб. 205', sn: 'KY2540-3321', ip: '10.0.2.20' });
  await add({ t: 'MFU', inv: 'ИН-0301', host: 'MFU-SALES', model: 'Canon i-SENSYS MF445dw', dep: 'Отдел продаж', loc: 'Каб. 310', sn: 'CN445-9910', ip: '10.0.2.21' });

  // Пример доп. поля для всей техники и для принтеров/МФУ
  await query(`INSERT INTO field_defs (label, field_type, scope) VALUES ('Дата покупки', 'date', 'all')`);
  await query(`INSERT INTO field_defs (label, field_type, options, scope, type_id)
               VALUES ('Картридж', 'text', '[]', 'type', $1)`, [types.PRN]);
  console.log('Демо-данные добавлены');
}

async function init({ demo = false, quiet = false } = {}) {
  await applySchema();
  await ensureSuperadmin();
  if (demo) await seedDemo();
  if (!quiet) console.log('База данных готова');
}

module.exports = { init };

if (require.main === module) {
  init({ demo: process.argv.includes('--demo') })
    .catch((e) => { console.error('Ошибка инициализации:', e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
