// Цвета календаря: личная раскраска (каждый для себя) и общие цвета видов отсутствий, приоритетов, статусов (администратор)
import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { ABSENCE_KINDS, COLOR_MODES, DEFAULT_COLORS, PALETTE, PRIORITIES, STATUSES } from '../constants.js';

const GROUPS = [
  ['absence', 'Виды отсутствий', ABSENCE_KINDS],
  ['priority', 'Приоритеты задач', PRIORITIES],
  ['status', 'Статусы задач', STATUSES],
];

function ColorInput({ value, onChange, disabled }) {
  return (
    <span className="color-pick">
      {PALETTE.map((c) => (
        <button type="button" key={c} disabled={disabled} className={`swatch ${value.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onChange(c)} title={c} />
      ))}
      {(() => {
        const own = !PALETTE.includes(value.toLowerCase());
        return (
          <label className={`swatch-input ${own ? 'on' : ''}`} style={{ background: own ? value : undefined }} title="Любой цвет">
            <input type="color" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />{!own && '…'}
          </label>
        );
      })()}
    </span>
  );
}

export default function ColorsPage() {
  const { isAdmin, colors, setColors, colorModes, setModes, toast } = useApp();
  // Черновик общих цветов: текущие значения (заданные или по умолчанию)
  const [draft, setDraft] = useState(() => Object.fromEntries(GROUPS.map(([g, , list]) => [g, Object.fromEntries(Object.keys(list).map((k) => [k, colors[g]?.[k] || DEFAULT_COLORS[g][k]]))])));
  const [busy, setBusy] = useState(false);
  const set = (g, k, v) => setDraft((d) => ({ ...d, [g]: { ...d[g], [k]: v } }));

  const save = async () => {
    setBusy(true);
    try {
      // Сохраняем только отличия от цветов по умолчанию
      const out = {};
      for (const [g] of GROUPS) {
        out[g] = {};
        for (const [k, v] of Object.entries(draft[g])) if (v.toLowerCase() !== DEFAULT_COLORS[g][k].toLowerCase()) out[g][k] = v;
      }
      const d = await api.put('/settings/colors', { colors: out });
      setColors(d.colors);
      toast('Цвета сохранены для всех пользователей');
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const reset = () => setDraft(Object.fromEntries(GROUPS.map(([g]) => [g, { ...DEFAULT_COLORS[g] }])));

  return (
    <div className="page narrow">
      <header className="page-head">
        <h2>Цвета календаря</h2>
        <p className="muted">Как раскрашивать задачи и отпуска — выбирает каждый для себя. Цвет отдельной задачи можно задать в её карточке.</p>
      </header>

      <div className="card">
        <h3>Моя раскраска</h3>
        <div className="form-grid">
          <label className="field">
            <span>Задачи</span>
            <select value={colorModes.tasks} onChange={(e) => setModes({ ...colorModes, tasks: e.target.value })}>
              {Object.entries(COLOR_MODES.tasks).map(([k, l]) => <option key={k} value={k}>Раскрашивать {l}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Отпуска и отсутствия</span>
            <select value={colorModes.absences} onChange={(e) => setModes({ ...colorModes, absences: e.target.value })}>
              {Object.entries(COLOR_MODES.absences).map(([k, l]) => <option key={k} value={k}>Раскрашивать {l}</option>)}
            </select>
          </label>
        </div>
        <p className="hint">
          Цвета категорий меняются на странице <a href="#/categories">«Категории»</a>, свой цвет сотрудника — в <a href="#/profile">профиле</a>.
          Задачи, у которых задан свой цвет, показываются этим цветом при любой раскраске.
        </p>
      </div>

      {GROUPS.map(([g, title, list]) => (
        <div className="card" key={g}>
          <h3>{title}</h3>
          {Object.entries(list).map(([k, v]) => (
            <div key={k} className="color-row">
              <span className="color-sample" style={{ '--k': draft[g][k] }}>{v.label}</span>
              <ColorInput value={draft[g][k]} disabled={!isAdmin} onChange={(c) => set(g, k, c)} />
            </div>
          ))}
        </div>
      ))}

      {isAdmin ? (
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Сохранение…' : 'Сохранить для всех'}</button>
          <button className="btn ghost" onClick={reset}>Вернуть цвета по умолчанию</button>
        </div>
      ) : <p className="muted small">Цвета видов отсутствий, приоритетов и статусов меняет администратор календаря.</p>}
    </div>
  );
}
