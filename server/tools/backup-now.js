// Резервная копия базы портала из командной строки — её делает сценарий обновления (scripts\update-portal.ps1)
// перед заменой файлов.
//   node server\tools\backup-now.js --root C:\it-portal
// --root — папка установленного портала: оттуда берётся .env (подключение к базе), туда же (в backups),
// если в настройках портала не указана другая папка для копий.
const path = require('path');

const i = process.argv.indexOf('--root');
const root = i > 0 ? path.resolve(process.argv[i + 1]) : path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(root, '.env') });
process.env.PORTAL_BACKUP_DEFAULT_DIR = path.join(root, 'backups');

const { createBackup } = require('../portal/backup');

createBackup('before-update')
  .then((r) => {
    console.log(`OK ${r.file} ${r.size} ${r.rows}`);
    return require('../db').closeAll();
  })
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`ERROR ${e.message}`);
    process.exit(1);
  });
