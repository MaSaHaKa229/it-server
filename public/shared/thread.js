// Переписка по заявке и вложения — общие для службы ИТ и сайта сотрудников
import { h, avatar, fmtDateTime, fmtSize, relTime } from './ui.js';

const isImage = (f) => /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(f.mime_type);

export function fileList(files, urlFor) {
  if (!files.length) return null;
  return h('div.files', files.map((f) => h('a.file', { href: urlFor(f), target: '_blank', rel: 'noopener', title: f.filename },
    isImage(f) ? h('img', { src: urlFor(f), alt: '' }) : '📎',
    h('span', f.filename), h('span.muted.small', fmtSize(f.size)),
    f.is_internal ? h('span.lozenge.yellow', 'внутр.') : null)));
}

/** comments: [{id, author, body, created_at, mine?, is_internal?}] */
export function thread(comments, attachments, { urlFor, isMine = (c) => c.mine }) {
  if (!comments.length) return h('p.muted', 'Комментариев пока нет');
  return h('div.thread', comments.map((c) => {
    const files = attachments.filter((a) => a.comment_id === c.id);
    return h('div.msg' + (isMine(c) ? '.mine' : '') + (c.is_internal ? '.internal' : ''),
      avatar(c.author || '?', 'sm'),
      h('div.msg-body',
        h('div.msg-head', h('strong', c.author || '—'), h('span', { title: fmtDateTime(c.created_at) }, relTime(c.created_at)),
          c.is_internal ? h('span.lozenge.yellow', 'внутренний — заявитель не видит') : null),
        h('div.msg-text', c.body),
        fileList(files, urlFor)));
  }));
}

/** Поле выбора файлов с подсказкой */
export function fileInput() {
  const input = h('input', { type: 'file', multiple: true });
  const note = h('span.muted.small', 'до 5 файлов, не больше 10 МБ каждый');
  const el = h('label.file-input', h('span', '📎 Файлы:'), input, note);
  return { el, input, files: () => [...input.files], reset: () => { input.value = ''; } };
}

const ACTION = {
  created: () => 'создал(а) заявку',
  status: (d) => ['статус: ', h('b', d.from || '—'), ' → ', h('b', d.to || '—')],
  assignee: (d) => (d.to ? ['исполнитель: ', h('b', d.to)] : ['снят исполнитель ', h('b', d.from || '')]),
  due: (d) => (d.to ? ['срок: ', h('b', fmtDateTime(d.to))] : 'срок снят'),
  priority: (d) => ['приоритет: ', h('b', d.to)],
  category: (d) => ['вид проблемы: ', h('b', d.to || '—')],
  device: (d) => (d.added ? `привязана техника ${d.added}` : d.removed ? `отвязана техника ${d.removed}`
    : d.to ? 'привязана техника из инвентаря' : 'отвязана техника'),
};
export function historyList(items) {
  if (!items.length) return null;
  return h('ul.history', items.map((x) => h('li',
    h('span', { title: fmtDateTime(x.created_at) }, fmtDateTime(x.created_at)), ' · ',
    x.author ? [h('b', x.author), ' '] : null,
    (ACTION[x.action] || (() => x.action))(x.details || {}))));
}
