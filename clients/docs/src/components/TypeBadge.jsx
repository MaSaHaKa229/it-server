import { useAuth } from '../auth.jsx';

// Цвет текста на светлой плашке — темнее цвета вида
function shade(hex) {
  const n = parseInt(String(hex || '#6B778C').slice(1), 16);
  const f = (v) => Math.round(v * 0.72).toString(16).padStart(2, '0');
  return '#' + f((n >> 16) & 255) + f((n >> 8) & 255) + f(n & 255);
}

/** Плашка вида документа (цвет из справочника) */
export default function TypeBadge({ code }) {
  const { typeMap } = useAuth();
  const t = typeMap[code];
  const color = t?.color || '#6B778C';
  return <span className="lozenge" style={{ background: color + '26', color: shade(color) }}>{t?.name || code}</span>;
}
