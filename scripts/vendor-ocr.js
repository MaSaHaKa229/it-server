// Компоненты распознавания сканов (tesseract.js + словари rus/eng) — в папку <выход>/node_modules.
// Используется при сборке архива обновления (scripts/make-update.sh): компоненты едут внутри папки
// server\vendor\ocr, которую пользователь и так заменяет целиком, — без отдельного переноса node_modules.
// Берёт уже установленные пакеты из node_modules проекта (интернет не нужен) и выбрасывает лишнее:
// словари 4.0.0 (используется 4.0.0_best_int). Ядра оставляем все: tesseract.js выбирает вариант
// по возможностям процессора и версии Node.js.
//   node scripts/vendor-ocr.js <папка-выхода>
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'server', 'vendor', 'ocr'));
const START = ['tesseract.js', '@tesseract.js-data/rus', '@tesseract.js-data/eng'];

// Пакет и его зависимости (с учётом вложенных node_modules)
function pkgDir(name, fromDir) {
  for (let d = fromDir; ; d = path.dirname(d)) {
    const p = path.join(d, 'node_modules', name);
    if (fs.existsSync(path.join(p, 'package.json'))) return p;
    if (d === path.dirname(d)) throw new Error(`не найден пакет ${name} — выполните npm install`);
  }
}
const seen = new Map(); // каталог пакета → имя
function walk(name, fromDir) {
  const dir = pkgDir(name, fromDir);
  if (seen.has(dir)) return;
  seen.set(dir, name);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pj.dependencies || {})) walk(dep, dir);
}
for (const n of START) walk(n, root);

fs.rmSync(out, { recursive: true, force: true });
const nm = path.join(out, 'node_modules');
for (const [dir, name] of seen) {
  // Вложенные пакеты (…/node_modules/a/node_modules/b) кладём так же вложенно
  const rel = path.relative(path.join(root, 'node_modules'), dir);
  const dst = path.join(nm, rel);
  fs.cpSync(dir, dst, {
    recursive: true,
    filter: (src) => {
      const r = path.relative(dir, src);
      if (r.split(path.sep)[0] === 'node_modules') return false; // вложенные пакеты копируются отдельно (только нужные)
      if (name.startsWith('@tesseract.js-data/') && /^4\.0\.0([\\/]|$)/.test(r)) return false;
      return true;
    },
  });
}
fs.writeFileSync(path.join(out, 'README.txt'),
  'Компоненты распознавания текста сканов PDF (tesseract.js, словари русского и английского).\r\n'
  + 'Собираются автоматически при подготовке архива обновления (scripts/vendor-ocr.js). Не удалять.\r\n');
let size = 0;
const count = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) count(p); else size += fs.statSync(p).size; } };
count(out);
console.log(`Компоненты распознавания: ${seen.size} пакетов, ${(size / 1048576).toFixed(1)} МБ → ${out}`);
