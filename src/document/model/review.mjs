// The review read API (docs/plans/word/plan.md §1.11): the Review tab, the status bar, find, markup, protect and every text reader
// read tracked changes, agent suggestions and comments here, without importing tracking or comments. Pure: Node tests load it.
import { entries } from '../../suggest/core.mjs';
import { INLINE, storiesOf, storyDoc } from './blocks.mjs';

const nameOf = (x) => x?.type?.name ?? x?.type;
const REV_MARKS = { insertion: 'insert', deletion: 'delete', formatChange: 'format' };

/** Whether `marks` (ProseMirror marks or mark JSON) hold a deletion. */
export const isDeleted = (marks) => !!marks?.some((m) => nameOf(m) === 'deletion');
const isInserted = (marks) => !!marks?.some((m) => nameOf(m) === 'insertion');

// The tracked changes of one ProseMirror doc (the body or a story), unsorted; `at` is the story's locator.
function tracked(doc, at) {
  const out = [];
  const open = new Map(); // kind:id → the run being joined
  const add = (r) => out.push({ source: 'tracking', at, ...r });
  const who = (m) => ({ id: m.id, author: m.author ?? null, date: m.date ?? null });
  doc.descendants((node, pos) => {
    const end = pos + node.nodeSize;
    const a = node.attrs ?? {};
    if (node.isTextblock) {
      for (const [op, m] of Object.entries(a.markRev ?? {})) if (m) add({ ...who(m), kind: 'paraMark', op: op === 'del' ? 'delete' : 'insert', from: end - 1, to: end });
      if (a.pChange) add({ ...who(a.pChange), kind: 'paraProps', from: pos, to: end, old: a.pChange.old ?? null });
    }
    if (a.rev) {
      for (const [op, m] of Object.entries(a.rev)) {
        if (!m) continue;
        const kind = op === 'del' ? 'delete' : 'insert';
        add(node.type.name === 'tableRow' ? { ...who(m), kind: 'row', op: kind, from: pos, to: end } : { ...who(m), kind, from: pos, to: end });
      }
    }
    if (!node.isInline) return true;
    // Marks join into one run per id while the pieces touch (a paragraph boundary between them is two positions).
    for (const m of node.marks) {
      const kind = REV_MARKS[m.type.name];
      if (!kind) continue;
      const key = `${kind}:${m.attrs.id}`;
      const r = open.get(key);
      const text = node.isText ? node.text : '';
      if (r && pos <= r.to + 2) {
        r.to = end;
        r.text += text;
      } else {
        const next = { source: 'tracking', at, ...who(m.attrs), kind, from: pos, to: end, text, ...(m.attrs.move && { move: m.attrs.move }) };
        open.set(key, next);
        out.push(next);
      }
    }
    return true;
  });
  return out;
}

/** Every revision of `doc` (a Document's ProseMirror doc): [{id, source: 'tracking'|'suggestion', kind, author, date, from, to, text?,
 * op?, move?, group?, key?, at}]. Tracked changes come first, in document order: insertion, deletion and formatChange marks joined into
 * runs by id, a paragraph mark's revision (kind 'paraMark', op 'insert'|'delete'), paragraph property changes, table row and block
 * revisions; then the same inside every story JSON (`at` its locator, from and to inside that story's doc; a story that does not fit
 * the schema is skipped); then the agents' suggestions (suggest/core.mjs entries). */
export function revisionsOf(doc) {
  const body = tracked(doc, null).sort((x, y) => x.from - y.from);
  const stories = [];
  for (const s of storiesOf(doc)) {
    let sd;
    try {
      sd = storyDoc(doc.type.schema, s.content);
    } catch {
      continue;
    }
    stories.push(...tracked(sd, s.at).sort((x, y) => x.from - y.from));
  }
  const suggestions = entries(doc).map((e) => ({
    id: e.id, source: 'suggestion', kind: e.kind, author: e.by, date: e.at, from: e.from, to: e.to, group: e.g, at: null,
    ...(e.key && { key: e.key }), ...(e.nodes.length && { text: e.nodes.map((n) => n.textContent).join(' ') }),
  }));
  return [...body, ...stories, ...suggestions];
}

/** The comments of `doc` in document order: [{id, from, to, text, author, initials, date, done, parent, content, replies}]. A comment's
 * marks join into one range per id; its thread data comes from doc.attrs.comments; replies (a parent that exists) sit in their
 * parent's replies by date, never at the top. A comment with no anchor in the text comes last; a mark whose id has no entry is no
 * comment. */
export function commentsOf(doc) {
  const anchors = new Map();
  doc.descendants((node, pos) => {
    for (const m of node.marks) {
      if (m.type.name !== 'comment') continue;
      const a = anchors.get(m.attrs.id);
      const end = pos + node.nodeSize;
      if (a) {
        a.from = Math.min(a.from, pos);
        a.to = Math.max(a.to, end);
        a.text += node.text ?? '';
      } else anchors.set(m.attrs.id, { from: pos, to: end, text: node.text ?? '' });
    }
  });
  const data = doc.attrs.comments ?? {};
  const info = new Map();
  for (const id of Object.keys(data)) {
    const c = data[id] ?? {};
    const a = anchors.get(id);
    info.set(id, {
      id, from: a?.from ?? null, to: a?.to ?? null, text: a?.text ?? '', author: c.author ?? null, initials: c.initials ?? null,
      date: c.date ?? null, done: !!c.done, parent: c.parent ?? null, content: c.content ?? null, replies: [],
    });
  }
  const top = [];
  for (const c of info.values()) {
    const p = c.parent != null && c.parent !== c.id ? info.get(c.parent) : null;
    (p ? p.replies : top).push(c);
  }
  const at = (c) => c.from ?? Infinity;
  top.sort((x, y) => (at(x) === at(y) ? 0 : at(x) - at(y)));
  for (const c of info.values()) c.replies.sort((x, y) => String(x.date ?? '').localeCompare(String(y.date ?? '')));
  return top;
}

/** Doc JSON `doc` without the comment marks whose id has no entry in its attrs.comments (an older build deleted a thread and left
 * its mark on a field or another inline node) → the same object when there is none, else a copy of the changed path. The draft
 * open path runs it (actions.js makeEditor), so such a draft heals on open without a transaction. */
export function dropOrphanComments(doc) {
  const known = doc?.attrs?.comments ?? {};
  const orphan = (m) => m?.type === 'comment' && !Object.hasOwn(known, m.attrs?.id ?? '');
  const walk = (n) => {
    let out = n;
    if (Array.isArray(n.marks) && n.marks.some(orphan)) out = { ...n, marks: n.marks.filter((m) => !orphan(m)) };
    if (Array.isArray(n.content)) {
      const kids = n.content.map(walk);
      if (kids.some((k, i) => k !== n.content[i])) out = { ...out, content: kids };
    }
    return out;
  };
  return doc && typeof doc === 'object' ? walk(doc) : doc;
}

// Inline nodes that hold text of their own; the rest of the inline leaves add nothing to what a reader counts.
const LEAF_TEXT = { hardBreak: '\n', ptab: '\t' };
const kidsOf = (n) => n.content?.content ?? (Array.isArray(n.content) ? n.content : []);
const inlineContent = (n, kids) => (typeof n.inlineContent === 'boolean' ? n.inlineContent : kids.some((c) => INLINE.has(nameOf(c))));

/** The text of `node` (a ProseMirror node or its JSON) as `display` shows it: 'final' and 'simple' leave deleted text and blocks
 * (a deletion mark, rev.del) out, 'original' leaves insertions out and keeps deletions, 'all' keeps both. A field reads as its result,
 * ruby as its base text, a hard break as a line break; blocks are joined with line breaks. */
export function visibleText(node, display = 'final') {
  const drop = display === 'original' ? (n) => isInserted(n.marks) || !!n.attrs?.rev?.ins
    : display === 'all' ? () => false : (n) => isDeleted(n.marks) || !!n.attrs?.rev?.del;
  const walk = (n) => {
    const name = nameOf(n);
    if (drop(n)) return '';
    if (name === 'text') return n.text ?? '';
    if (name === 'field') return n.attrs?.result ?? '';
    if (name === 'ruby') return n.attrs?.base ?? '';
    if (LEAF_TEXT[name]) return LEAF_TEXT[name];
    const kids = kidsOf(n);
    return kids.filter((c) => !drop(c)).map(walk).join(inlineContent(n, kids) ? '' : '\n');
  };
  return walk(node);
}
