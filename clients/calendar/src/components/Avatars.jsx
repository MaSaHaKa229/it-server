import { initials } from '../constants.js';

export default function Avatars({ people, max = 4 }) {
  if (!people?.length) return <span className="avatars empty-avatars">—</span>;
  return (
    <span className="avatars">
      {people.slice(0, max).map((p) => (
        <span key={p.id} className="avatar sm" style={{ background: p.color }} title={p.name}>{initials(p.name)}</span>
      ))}
      {people.length > max && <span className="avatar sm more-av">+{people.length - max}</span>}
    </span>
  );
}
