// Сборка сайта заявок для Firefox 52 ESR (Windows XP):
//   public/helpdesk/app.legacy.js — один файл без модулей, синтаксис переведён под Firefox 52
//   public/shared/legacy.css      — запасные стили: gap во flex-блоках, grid-gap, inset
// Запуск: npm install && npm run build (в папке clients/helpdesk-legacy)
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pub = path.join(root, 'public');

// Абсолютные импорты сайта (/shared/ui.js) → файлы в public
const publicPaths = {
  name: 'public-paths',
  setup(b) {
    b.onResolve({ filter: /^\// }, (args) => (args.kind === 'import-statement' ? { path: path.join(pub, args.path) } : undefined));
  },
};

await build({
  entryPoints: [path.join(pub, 'helpdesk', 'app.js')],
  bundle: true,
  format: 'iife',
  // firefox53: в таблице esbuild полная деструктуризация числится с 53 (в 52 нет лишь редких случаев,
  // обычная запись const { a } = … работает с Firefox 41). Остальное — ?., ??, разворот объектов,
  // catch {} — переводится в синтаксис, который понимает Firefox 52.
  target: ['firefox53'],
  outfile: path.join(pub, 'helpdesk', 'app.legacy.js'),
  inject: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'polyfills.js')],
  plugins: [publicPaths],
  legalComments: 'none',
  banner: { js: '/* Сборка для старых браузеров (Firefox 52). Не редактировать: собирается из public/helpdesk/app.js — clients/helpdesk-legacy */' },
  logLevel: 'info',
});

// ---------- запасной CSS ----------
// Firefox 52 понимает grid-gap, но не gap у flex-блоков и не inset.
function fallbacks(css) {
  const out = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // правила верхнего уровня и внутри @media
  const re = /([^{}@]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const sel = m[1].trim();
    const body = m[2];
    if (!sel || sel.startsWith('@') || /^(from|to|\d+%)$/.test(sel)) continue;
    const get = (prop) => { const r = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)').exec(body); return r ? r[1].trim() : null; };
    const gap = get('gap');
    const display = get('display') || '';
    const inset = get('inset');
    const sels = sel.split(',').map((s) => s.trim()).filter(Boolean);
    if (inset) out.push(`${sel} { top: ${inset}; right: ${inset}; bottom: ${inset}; left: ${inset}; }`);
    if (!gap) continue;
    const [rowGap, colGap = rowGap] = gap.split(/\s+/);
    if (/grid/.test(display)) { out.push(`${sel} { grid-gap: ${gap}; }`); continue; }
    if (!/flex/.test(display)) continue; // gap без display в этом правиле — не трогаем
    const column = /column/.test(get('flex-direction') || '');
    const wrap = /wrap/.test(get('flex-wrap') || '');
    const lg = (s) => `.legacy ${s}`;
    if (column) {
      if (rowGap !== '0') out.push(`${sels.map((s) => lg(s) + ' > * + *').join(', ')} { margin-top: ${rowGap}; }`);
    } else {
      if (colGap !== '0') out.push(`${sels.map((s) => lg(s) + ' > * + *').join(', ')} { margin-left: ${colGap}; }`);
      if (wrap && rowGap !== '0') out.push(`${sels.map((s) => lg(s) + ' > *').join(', ')} { margin-bottom: ${rowGap}; }`);
    }
  }
  return out;
}
const sources = ['theme.css', 'portal.css'];
const lines = [
  '/* Запасные стили для старых браузеров (Firefox 52). Подключаются только сборкой app.legacy.js.',
  '   Не редактировать: генерируются из theme.css и portal.css — clients/helpdesk-legacy/build.mjs */',
  'select { -moz-appearance: none; }',
  '.legacy .row.wrap > * { margin-bottom: 4px; }',
];
for (const f of sources) lines.push(`/* ${f} */`, ...fallbacks(readFileSync(path.join(pub, 'shared', f), 'utf8')));
writeFileSync(path.join(pub, 'shared', 'legacy.css'), lines.join('\n') + '\n');
console.log(`  public/shared/legacy.css: ${lines.length} строк`);
