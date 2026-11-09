// Revision balloons, the people filter and the Reviewing pane's counts (docs/plans/word plan.md §3 markup). Pure: node tests load it.
// Reads revisions from review.mjs revisionsOf and settings.word.tracking (plan.md §1.12) with the names tracking draws from.
import { describe } from './describe.mjs';

/** `s` cut to `n` characters with an ellipsis ('' for none). */
export const cut = (s, n = 80) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? '');

/** A balloon's or pane row's time: day, month and time of `t` ('' for none). */
export const clock = (t) => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** Whether a change by `author` shows under Show Markup > Specific People (`people` null shows everyone). */
export const shownFor = (people, author) => people == null || people.includes(author ?? '');

/** The balloon text of revision `r`: 'Deleted: text', 'Moved: text', or the formatting describer's words when r carries the
 * marks before (`old`) and now (`now`). */
export function labelOf(r) {
  if (r.kind === 'delete') return `${r.move ? 'Moved' : 'Deleted'}: ${cut(r.text)}`;
  if (r.kind === 'paraProps') return 'Formatted: Paragraph';
  if (r.kind === 'format') return r.old || r.now ? describe(r.old ?? [], r.now ?? []) : 'Formatted';
  return r.kind;
}

/** The balloons for `revisions` under `t` (settings.word.tracking) → [{id, rev, label}] in revision order. Only All Markup draws
 * balloons; 'revisions' gives deletions and formatting, 'comments' formatting only, 'none' nothing. Insertions stay inline, story
 * revisions and agent suggestions never get one (suggestions have their own cards). */
export function balloons(revisions, t) {
  if (t?.display !== 'all' || !['revisions', 'comments'].includes(t.balloons)) return [];
  const show = t.show ?? {};
  return revisions.filter((r) => {
    if (r.source !== 'tracking' || r.at || !shownFor(t.people, r.author)) return false;
    if (r.kind === 'format' || r.kind === 'paraProps') return show.formatting !== false;
    return r.kind === 'delete' && t.balloons === 'revisions' && show.insDel !== false;
  }).map((rev) => ({ id: `${rev.kind}-${rev.id}-${rev.from}`, rev, label: labelOf(rev) }));
}

/** The Reviewing pane's summary of `revisions` and `comments` → {total, insertions, deletions, moves, formatting, comments}. */
export function summary(revisions, comments) {
  const s = { total: revisions.length + comments.length, insertions: 0, deletions: 0, moves: 0, formatting: 0, comments: comments.length };
  for (const r of revisions) {
    const op = r.op ?? r.kind;
    if (r.move) s.moves++;
    else if (r.kind === 'format' || r.kind === 'paraProps' || r.kind === 'attr') s.formatting++;
    else if (r.kind === 'replace') {
      s.insertions++;
      s.deletions++;
    } else if (op === 'insert') s.insertions++;
    else if (op === 'delete') s.deletions++;
  }
  return s;
}

/** Every reviewer of the document, sorted: the authors of tracked changes and comments and the names in doc.attrs.people. */
export function authorsOf(revisions, comments, people) {
  const all = new Set();
  for (const r of revisions) if (r.source === 'tracking' && r.author) all.add(r.author);
  const walk = (cs) => cs.forEach((c) => { if (c.author) all.add(c.author); walk(c.replies ?? []); });
  walk(comments);
  for (const p of people ?? []) if (p?.name) all.add(p.name);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** The people setting after checking or unchecking `name` under Specific People, from `people` (null = all of `authors`). */
export function togglePerson(people, name, authors) {
  const now = people ?? authors;
  const next = now.includes(name) ? now.filter((n) => n !== name) : [...now, name];
  return authors.every((a) => next.includes(a)) ? null : next;
}
