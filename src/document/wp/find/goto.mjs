// Go To and browse (docs/plans/word/plan.md §3 find; index-editing.md Go To): what the box means and the items of each target
// in the doc. Pure: pages and lines come from the view (index.js), everything else from the doc.
import { parseField } from '../../fields/registry.mjs';
import { commentsOf } from '../../model/review.mjs';
import { sectionsOf } from '../../model/sections.mjs';

/** The Go to what list: [id, label, box label]. */
export const TARGETS = [
  ['page', 'Page', 'Enter page number:'],
  ['section', 'Section', 'Enter section number:'],
  ['line', 'Line', 'Enter line number:'],
  ['bookmark', 'Bookmark', 'Enter bookmark name:'],
  ['comment', 'Comment', "Enter reviewer's name:"],
  ['footnote', 'Footnote', 'Enter footnote number:'],
  ['endnote', 'Endnote', 'Enter endnote number:'],
  ['field', 'Field', 'Enter field name:'],
  ['table', 'Table', 'Enter table number:'],
  ['graphic', 'Graphic', 'Enter graphic number:'],
  ['equation', 'Equation', 'Enter equation number:'],
  ['object', 'Object', 'Enter object name:'],
  ['heading', 'Heading', 'Enter heading number:'],
];

/** Targets whose box takes a name (with a list) instead of a number. */
export const NAMED = new Set(['bookmark', 'comment', 'field', 'object']);

/** The Go To box `text` → {kind: 'step'} (empty), {kind: 'rel', n} (+n, -n), {kind: 'abs', n}, {kind: 'page', page, section}
 * (p3s2, s2), {kind: 'name', name} or null (not valid). target: the Go to what id. */
export function parseGoTo(text, target = 'page') {
  const s = String(text ?? '').trim();
  if (!s) return { kind: 'step' };
  const rel = s.match(/^([+-])\s*(\d*)$/);
  if (rel) return { kind: 'rel', n: (rel[1] === '-' ? -1 : 1) * (rel[2] === '' ? 1 : Number(rel[2])) };
  if (/^\d+$/.test(s)) return { kind: 'abs', n: Number(s) };
  if (target === 'page') {
    const ps = s.match(/^(?:p(\d+))?\s*(?:s(\d+))?$/i);
    if (ps && (ps[1] || ps[2])) return { kind: 'page', page: ps[1] ? Number(ps[1]) : 1, section: ps[2] ? Number(ps[2]) : null };
  }
  return NAMED.has(target) ? { kind: 'name', name: s } : null;
}

const GRAPHICS = new Set(['image', 'canvas', 'planChart']);
const OBJECTS = new Set(['textBox', 'canvas', 'planChart']);

/** The items of `target` in `doc` in document order → [{from, to, name?}]. Page and line are the view's (index.js). */
export function itemsOf(doc, target) {
  const out = [];
  const nodes = (test, name) => doc.descendants((n, pos) => {
    if (test(n)) out.push({ from: pos, to: pos + n.nodeSize, name: name?.(n) ?? null });
  });
  switch (target) {
    case 'section': return sectionsOf(doc).map((s) => ({ from: s.from, to: s.to }));
    case 'bookmark': nodes((n) => n.type.name === 'bookmark' && !n.attrs.end, (n) => n.attrs.name); break;
    case 'comment': return commentsOf(doc).filter((c) => !c.parent).map((c) => ({ from: c.from, to: c.to, name: c.author ?? '' }));
    case 'footnote': case 'endnote': nodes((n) => n.type.name === 'noteRef' && n.attrs.kind === target); break;
    case 'field': nodes((n) => n.type.name === 'field' || n.type.name === 'fieldBlock', (n) => parseField(n.attrs.code ?? '').name); break;
    case 'table': nodes((n) => n.type.name === 'table'); break;
    case 'graphic': nodes((n) => GRAPHICS.has(n.type.name)); break;
    case 'equation': nodes((n) => n.type.name === 'equation'); break;
    case 'object': nodes((n) => OBJECTS.has(n.type.name), (n) => n.attrs.name ?? n.attrs.title ?? n.type.name); break;
    case 'heading': nodes((n) => n.type.name === 'heading' || (n.isTextblock && n.attrs.outlineLevel != null && n.attrs.outlineLevel < 9)); break;
    default: break;
  }
  return out;
}

/** The names the box lists for a named target (Any reviewer first for comments). */
export function namesOf(doc, target) {
  const names = [...new Set(itemsOf(doc, target).map((i) => i.name).filter(Boolean))];
  return target === 'comment' ? ['Any reviewer', ...names] : names.sort();
}

/** The index of the item to go to among `items` (sorted, [{from}]) for parsed box `q` from position `at`, moving `dir` (1 Next,
 * -1 Previous) → index or -1. Numbers are 1-based; a name picks the next (or previous) item with that name. */
export function pick(items, q, at, dir = 1) {
  if (!items.length || !q) return -1;
  // The current item: the last one starting at or before the caret.
  let cur = -1;
  for (let i = 0; i < items.length && items[i].from <= at; i++) cur = i;
  const inRange = (i) => (i >= 0 && i < items.length ? i : -1);
  if (q.kind === 'abs') return inRange(q.n - 1);
  if (q.kind === 'rel') return inRange(cur + q.n);
  if (q.kind === 'step') return inRange(dir > 0 ? items.findIndex((it) => it.from > at) : cur >= 0 && items[cur].from < at ? cur : cur - 1);
  if (q.kind === 'name') {
    const any = q.name === 'Any reviewer';
    const ok = (it) => any || (it.name ?? '').toLowerCase() === q.name.toLowerCase();
    const order = dir > 0 ? items.map((_, i) => i) : items.map((_, i) => items.length - 1 - i);
    const next = order.find((i) => ok(items[i]) && (dir > 0 ? items[i].from > at : items[i].from < at));
    return next ?? order.find((i) => ok(items[i])) ?? -1;
  }
  return -1;
}
