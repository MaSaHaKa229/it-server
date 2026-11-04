// Небольшой набор функций для работы с датами (без внешних библиотек)
const LOCALE = 'ru-RU';

export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d, n) => { const x = new Date(d); x.setDate(1); x.setMonth(x.getMonth() + n); return x; };
export const startOfMonth = (d) => { const x = startOfDay(d); x.setDate(1); return x; };
export const startOfWeek = (d) => { const x = startOfDay(d); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); };
export const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
export const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

const pad = (n) => String(n).padStart(2, '0');
export const toInputDate = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
export const toInputDateTime = (d) => { const x = new Date(d); return `${toInputDate(x)}T${pad(x.getHours())}:${pad(x.getMinutes())}`; };
export const fromInputDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

export const fmtTime = (d) => new Date(d).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
export const fmtDate = (d, opts = { day: 'numeric', month: 'long' }) => new Date(d).toLocaleDateString(LOCALE, opts);
export const fmtMonthYear = (d) => {
  const s = new Date(d).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' }).replace(' г.', '');
  return s[0].toUpperCase() + s.slice(1);
};
export const fmtDateTime = (d) => new Date(d).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// Последний день, который занимает задача (для задач «на весь день» — включительно)
export function taskEndDay(t) {
  const s = new Date(t.start_at);
  const e = new Date(t.end_at);
  if (t.all_day) return startOfDay(e);
  const last = e > s ? new Date(e.getTime() - 1) : e;
  return startOfDay(last);
}

export const taskCoversDay = (t, day) => startOfDay(t.start_at) <= day && taskEndDay(t) >= day;

export function fmtTaskPeriod(t) {
  const s = new Date(t.start_at), e = new Date(t.end_at);
  if (t.all_day) {
    return sameDay(s, e) ? `${fmtDate(s)}, весь день` : `${fmtDate(s)} — ${fmtDate(e)}`;
  }
  return sameDay(s, e) ? `${fmtDate(s)}, ${fmtTime(s)}–${fmtTime(e)}` : `${fmtDateTime(s)} — ${fmtDateTime(e)}`;
}

export function relative(d) {
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  return fmtDateTime(d);
}
