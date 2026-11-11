// Панель (дашборд): сводка по типам, состояниям, отделам и последние изменения
import { h, clear, api, typeDot, lozenge, timeAgo } from '../ui.js';
import { state, isStaff } from '../store.js';
import { navigate } from '../app.js';
import { openCreateDevice } from './create.js';
import { plural } from './devices.js';


export async function renderDashboard(root) {
  document.title = 'Панель — ИТ Инвентарь';
  const stats = await api.get('/api/devices/stats');
  const types = {};
  for (const r of stats.byType) {
    const t = (types[r.id] ||= { id: r.id, name: r.name, code: r.code, color: r.color, total: 0, s: {} });
    t.total += r.n; t.s[r.status] = r.n;
  }
  const total = Object.values(types).reduce((a, t) => a + t.total, 0);
  const statuses = state.meta.statuses;
  const tot = {};
  Object.values(types).forEach((t) => Object.entries(t.s).forEach(([k, n]) => { tot[k] = (tot[k] || 0) + n; }));
  const fhref = (f) => `#/devices?f=${encodeURIComponent(JSON.stringify(f))}`;

  const card = (title, num, sub, href, bar) => h('div.card', { onclick: () => navigate(href.slice(1)) },
    h('h4', title), h('div.num', num), bar || null, sub ? h('div.legend', sub) : null);

  const statusBar = (s, sum) => h('div.bar', statuses.map((st) =>
    s[st.key] ? h('span', { style: { width: (s[st.key] / sum * 100) + '%', background: st.color }, title: `${st.label}: ${s[st.key]}` }) : null));
  // В легенде показываем только встречающиеся состояния, чтобы карточки не разрастались
  const legend = (s) => statuses.filter((st) => s[st.key]).map((st) => h('span', h('i', { style: { background: st.color } }), `${st.label}: ${s[st.key]}`));

  const maxDept = Math.max(1, ...stats.byDept.map((d) => d.n));

  clear(root,
    h('div.breadcrumbs', h('span', 'Служба ИТ')),
    h('div.page-head', h('h1', 'Панель'), h('span.spacer'),
      isStaff() ? h('button.btn.primary', { onclick: () => openCreateDevice() }, 'Добавить технику') : null),
    total === 0 && isStaff()
      ? h('div.empty-state', h('h3', 'База пока пуста'),
          h('p', 'Добавьте первое устройство. Справочники (модели, сотрудники, отделы) заполнятся по ходу — новые значения можно вводить прямо в форме.'),
          h('button.btn.primary', { onclick: () => openCreateDevice() }, 'Добавить устройство'))
      : null,
    h('div.cards',
      card('Вся техника', total, legend(tot), '#/devices', statusBar(tot, total || 1)),
      Object.values(types).map((t) => card(
        h('span.row', { style: { gap: '6px' } }, typeDot(t), t.name), t.total,
        legend(t.s), fhref({ type: [t.id] }), statusBar(t.s, t.total)))),
    h('div.grid2',
      h('div.section',
        h('h3', { style: { marginBottom: '12px' } }, 'Недавно изменённые'),
        stats.recent.length ? h('table.list', h('tbody', stats.recent.map((d) => h('tr.clickable', { onclick: () => navigate('/devices/' + d.id) },
          h('td', { style: { width: '90px' } }, h('span.type-cell', typeDot(d), h('a.key-link', { href: `#/devices/${d.id}` }, `${d.type_code}-${d.id}`))),
          h('td', d.hostname || h('span.muted', '—')),
          h('td', lozenge(d.status)),
          h('td.muted.small', { style: { textAlign: 'right' } }, timeAgo(d.updated_at))))))
          : h('p.muted', 'Нет данных')),
      stats.byDept.length ? h('div.section',
        h('h3', { style: { marginBottom: '12px' } }, 'Техника по отделам'),
        stats.byDept.map((d) => h('div.hbar',
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: d.name }, d.name),
          h('div.track', h('span', { style: { width: (d.n / maxDept * 100) + '%' } })),
          h('span.muted', { style: { textAlign: 'right' } }, d.n)))) : null),
    h('p.muted.small', { style: { marginTop: '24px' } },
      `Всего ${total} ${plural(total, 'единица', 'единицы', 'единиц')} техники`,
      statuses.filter((st) => tot[st.key]).length ? ': ' + statuses.filter((st) => tot[st.key]).map((st) => `${st.label.toLowerCase()} — ${tot[st.key]}`).join(', ') : '', '.'));
}
