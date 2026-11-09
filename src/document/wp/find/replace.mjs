// Replace for Find and Replace (docs/plans/word/plan.md §3 find): Replace with's parts written into a transaction or transform,
// Replace All as one transaction, Replace with Format, and the story JSON (headers, footers, notes, comments) rewritten in place.
// Pure: works on a ProseMirror Transform (a Transaction is one), so node tests run it.
import { Transform } from '@tiptap/pm/transform';
import { storiesOf, storyDoc } from '../../model/blocks.mjs';
import { inflect } from './forms.mjs';
import { caseLike, expand, FindError, parseReplace, searchDoc } from './query.mjs';

export { searchDoc };

const REVISION = new Set(['insertion', 'deletion']);
const MARK_KEYS = new Set(['bold', 'italic', 'strike', 'subscript', 'superscript', 'underline']);

/** The parts that replace match `m` (from searchDoc, with i and j) of `model`: Replace with `parsed` filled in. opts: the
 * search's, plus query, clip (^c) and text (Replace with as typed, for all word forms). */
export function partsFor(model, m, parsed, opts = {}) {
  const found = model.text.slice(m.i, m.j);
  if (opts.allForms && !opts.wildcards && parsed.every((p) => p.text != null)) {
    return [{ text: caseLike(inflect(parsed.map((p) => p.text).join(''), found, opts.query ?? ''), found) }].filter((p) => p.text);
  }
  return expand(parsed, found, m.groups, opts.clip ?? '');
}

/** The parts that replace range `m` ({from, to}) of `doc` with Replace with `text` → [{text} | {node}]. Throws FindError. */
export function replaceParts(doc, m, text, opts = {}) {
  const parsed = parseReplace(text, opts);
  const { matches, model } = searchDoc(doc, opts.query ?? '', { ...opts, within: null });
  const hit = matches.find((x) => x.from === m.from && x.to === m.to);
  return hit ? partsFor(model, hit, parsed, opts) : expand(parsed, doc.textBetween(m.from, m.to, '\r'), m.groups, opts.clip ?? '');
}

/** Writes `parts` over range {from, to} of transform `tr`, with the marks the range had (revision marks left to tracking) →
 * the end of what was written. ^p splits the paragraph; ^m and ^n split it around a page or column break. */
export function applyParts(tr, { from, to }, parts) {
  const { schema } = tr.doc.type;
  const $a = tr.doc.resolve(from);
  const marks = ((from < to && $a.marksAcross(tr.doc.resolve(to))) || $a.marks()).filter((x) => !REVISION.has(x.type.name));
  if (to > from) tr.delete(from, to);
  let pos = from;
  for (const p of parts) {
    if (p.text) {
      tr.insert(pos, schema.text(p.text, marks));
      pos += p.text.length;
    } else if (p.node === 'line') {
      tr.insert(pos, schema.nodes.hardBreak.create(null, null, marks));
      pos += 1;
    } else {
      tr.split(pos);
      pos += 2;
      const type = p.node === 'page' ? schema.nodes.pageBreak : p.node === 'column' ? schema.nodes.columnBreak : null;
      if (type) {
        tr.insert(pos - 1, type.create());
        pos += 1;
      }
    }
  }
  return pos;
}

/** Replace with Format: applies `format` ({run, para, style, highlight}) over {from, to} of `tr`. Run properties merge into each
 * text node's own (§1.8: patched, never rebuilt). */
export function applyFormat(tr, { from, to }, format) {
  if (!format || to <= from) return;
  const { schema } = tr.doc.type;
  const run = { ...format.run };
  if (format.highlight != null) run.highlight = format.highlight ? 'yellow' : null;
  if (format.lang != null) run.lang = { val: format.lang };
  const style = {};
  for (const [k, v] of Object.entries(run)) {
    if (v === undefined) continue;
    if (MARK_KEYS.has(k)) {
      const type = schema.marks[k];
      if (!type) continue;
      if (v === false || v === null) tr.removeMark(from, to, type);
      else tr.addMark(from, to, type.create(typeof v === 'object' ? v : null));
    } else style[k] = v;
  }
  const ts = schema.marks.textStyle;
  if (ts && Object.keys(style).length) {
    tr.doc.nodesBetween(from, to, (n, pos) => {
      if (!n.isText) return;
      const old = n.marks.find((x) => x.type === ts)?.attrs ?? {};
      tr.addMark(Math.max(from, pos), Math.min(to, pos + n.nodeSize), ts.create({ ...old, ...style }));
    });
  }
  const para = { ...format.para, ...(format.style != null && { styleId: format.style === 'Normal' ? null : format.style }) };
  if (Object.keys(para).length) {
    tr.doc.nodesBetween(from, to, (n, pos) => {
      if (!n.isTextblock) return true;
      tr.setNodeMarkup(pos, null, { ...n.attrs, ...para });
      return false;
    });
  }
}

/** Replaces every match of `query` in `tr`'s doc with `text` (Replace with) and, with opts.replaceFormat, its formats → the count.
 * opts: the search's (§1.18) plus clip and replaceFormat. Throws FindError for a query or replacement Word refuses. */
export function replaceAll(tr, query, text, opts = {}) {
  const { matches, model, error } = searchDoc(tr.doc, query, opts);
  if (error) throw new FindError(error);
  const parsed = parseReplace(text, opts);
  const keep = !text && opts.replaceFormat; // an empty Replace with plus formats keeps the text
  for (const m of [...matches].reverse()) {
    if (keep) applyFormat(tr, m, opts.replaceFormat);
    else {
      const end = applyParts(tr, m, partsFor(model, m, parsed, { ...opts, query }));
      applyFormat(tr, { from: m.from, to: end }, opts.replaceFormat);
    }
  }
  return matches.length;
}

/** Which Find In story a storiesOf entry belongs to: 'headers', 'footnotes', 'endnotes' or 'comments'. */
export function storyKind(doc, s) {
  if (s.at.story === 'header' || s.at.story === 'footer') return 'headers';
  if (s.at.story === 'comment') return 'comments';
  return doc.nodeAt(s.holder)?.attrs.kind === 'endnote' ? 'endnotes' : 'footnotes';
}

/** Matches of `query` in the stories of `doc` held in attributes → [{story, at, count, first: {from, to}}] for the kinds in
 * `kinds` (a Set of storyKind values). */
export function searchStories(doc, query, opts, kinds) {
  const { schema } = doc.type;
  const out = [];
  for (const s of storiesOf(doc)) {
    const kind = storyKind(doc, s);
    if (!kinds.has(kind)) continue;
    const { matches } = searchDoc(storyDoc(schema, s.content), query, opts);
    if (matches.length) out.push({ story: kind, at: s.at, count: matches.length, first: { from: matches[0].from, to: matches[0].to } });
  }
  return out;
}

/** Replace All inside the stories of `tr`'s doc (kinds as searchStories): each story's JSON is rewritten in the same transaction,
 * patched into its holder (the noteRef, the sect of its section, doc.attrs.comments) → the count. */
export function replaceInStories(tr, query, text, opts, kinds) {
  const { schema } = tr.doc.type;
  let count = 0;
  for (const s of storiesOf(tr.doc)) {
    if (!kinds.has(storyKind(tr.doc, s))) continue;
    const t = new Transform(storyDoc(schema, s.content));
    const n = replaceAll(t, query, text, opts);
    if (!n) continue;
    count += n;
    const content = t.doc.toJSON().content;
    const { at, holder } = s;
    if (at.story === 'note') {
      const node = tr.doc.nodeAt(holder);
      tr.setNodeMarkup(holder, null, { ...node.attrs, content });
    } else if (at.story === 'comment') {
      const comments = tr.doc.attrs.comments ?? {};
      tr.setDocAttribute('comments', { ...comments, [at.id]: { ...comments[at.id], content } });
    } else {
      const key = at.story === 'header' ? 'hdr' : 'ftr';
      const sect = holder == null ? tr.doc.attrs.sect : tr.doc.nodeAt(holder).attrs.sect;
      const next = { ...sect, [key]: { ...sect?.[key], [at.part]: content } };
      if (holder == null) tr.setDocAttribute('sect', next);
      else tr.setNodeMarkup(holder, null, { ...tr.doc.nodeAt(holder).attrs, sect: next });
    }
  }
  return count;
}
