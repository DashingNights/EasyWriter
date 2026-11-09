// Editor operations of the toc package: insert, update and remove tables of contents and figures, mark TC entries, insert captions
// and AutoCaption. Each change is one transaction after closeHistory, so one Ctrl+Z undoes it (plan.md §1.10).
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin } from '@tiptap/pm/state';
import { insertPoint } from '@tiptap/pm/transform';
import { getState } from '../../../app/store.js';
import { run } from '../../../tooling/registry.js';
import { exactPageAt, updateFields } from '../../fields/engine.js';
import { fieldCtx, parseField } from '../../fields/registry.mjs';
import { geometryOf } from '../../geometry.js';
import { SDT_DEFAULTS } from '../../model/nodes.js';
import { ensureStyles } from '../../model/styles.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { docOfDraft } from '../../docx/files.js';
import {
  CAPTION_STYLES, SEPARATORS, TOC_FORMATS, TOC_GALLERY, TOC_STYLES, TOF_STYLES, captionInline, isFigures, leaderOf, seqId, seqNumbers, seqText,
  nameOf, styleOutline, textWidth, tocBlocks, tocEntries, withChapters,
} from './toc.mjs';

const isTocSdt = (n) => nameOf(n) === 'sdtBlock' && n.attrs.sdt?.docPart?.gallery === TOC_GALLERY;
const isTocField = (n) => nameOf(n) === 'fieldBlock' && parseField(n.attrs.code).name === 'TOC';

/** The tables in `doc` → [{pos, node, sdt: {pos, node} | null, figures}] in document order: every TOC fieldBlock, with the docPart
 * control around it, and docPart controls without a field (a manual table). */
export function tablesIn(doc) {
  const out = [];
  let sdt = null;
  doc.descendants((node, pos) => {
    if (isTocSdt(node)) {
      sdt = { pos, node, end: pos + node.nodeSize };
      let field = null;
      node.descendants((c, p) => {
        if (!field && isTocField(c)) field = { pos: pos + 1 + p, node: c };
        return !field;
      });
      if (!field) out.push({ pos, node, sdt, figures: false, manual: true });
      return true;
    }
    if (isTocField(node)) {
      const around = sdt && pos > sdt.pos && pos < sdt.end ? sdt : null;
      out.push({ pos, node, sdt: around, figures: isFigures(node.attrs.code) });
      return false;
    }
    return !node.isTextblock;
  });
  return out;
}

/** The table holding the selection of `state`, else the document's first one (`here`: none), or null. `figures`: tables of figures. */
export function tableAt(state, { figures = false, here = false } = {}) {
  const list = tablesIn(state.doc).filter((t) => t.figures === figures);
  const at = state.selection.from;
  return list.find((t) => at >= (t.sdt?.pos ?? t.pos) && at <= (t.sdt?.end ?? t.pos + t.node.nodeSize)) ?? (here ? null : list[0] ?? null);
}

/** Whether the selection of `state` is inside a table of contents or figures. */
export function inTable(state) {
  const at = state.selection.from;
  return tablesIn(state.doc).some((t) => at > (t.sdt?.pos ?? t.pos) && at < (t.sdt?.end ?? t.pos + t.node.nodeSize));
}

/** The page label of a position of `editor`'s doc: the field engine's exact page while the view is on screen, else geometry's, else
 * null. */
function pagesOf(editor) {
  const geo = geometryOf(editor.state);
  if (!geo?.pages?.length) return () => null;
  const exact = exactPageAt(editor, geo);
  return (pos) => {
    let p = null;
    try {
      p = exact?.(pos) ?? null;
    } catch {
      p = null; // a position the view cannot place: use geometry's page
    }
    const i = p ? geo.pages.indexOf(p) : geo.pageOf(pos);
    p ??= geo.pages[i];
    return p ? String(p.label ?? p.number ?? i + 1) : null;
  };
}

// RD files read before an update: draft title → doc JSON (the 'tocRd' provider hands them to TOC).
const rdFiles = new Map();
/** The doc of RD file `name` for FieldCtx `ctx`, from the drafts loaded before the update, or null. */
export const rdProvider = (ctx, name) => {
  const json = rdFiles.get(String(name ?? '').toLowerCase());
  if (!json) return null;
  try {
    return ctx.doc.type.schema.nodeFromJSON(json);
  } catch {
    return null;
  }
};
/** Loads the Document drafts the RD fields of `doc` name (by title). */
async function loadRd(doc) {
  const names = [];
  doc.descendants((n) => {
    if (nameOf(n) === 'field') {
      const f = parseField(n.attrs.code);
      if (f.name === 'RD' && f.args[0]) names.push(f.args[0]);
    }
    return true;
  });
  const drafts = getState().drafts ?? [];
  for (const name of names) {
    const d = drafts.find((x) => String(x.title).toLowerCase() === name.toLowerCase());
    let json = null;
    try {
      json = d ? await docOfDraft(await window.api.drafts.load(d.id)) : null; // a canvas draft's through the engine (engine-canvas-read)
    } catch {
      json = null;
    }
    if (json?.type === 'doc') rdFiles.set(name.toLowerCase(), json);
    else rdFiles.delete(name.toLowerCase());
  }
}

// A free _Toc name: _Toc and 9 digits, as Word writes them.
function tocName(doc, taken) {
  for (;;) {
    const name = `_Toc${String(Math.floor(1e8 + Math.random() * 9e8))}`;
    if (!taken.has(name) && !fieldCtx({ doc }).bookmark(name)) {
      taken.add(name);
      return name;
    }
  }
}

/** Builds the block JSON of TOC code `code` into `tr`: hidden _Toc bookmarks go around every entry that lacks one (in `tr`), then the
 * entries are read from tr.doc; page numbers come from the layout of `editor`'s current doc through the inverse mapping. */
function buildInto(tr, editor, code, { leader = 'dot', at = 0 } = {}) {
  const f = parseField(code);
  const page = pagesOf(editor);
  const ctx = fieldCtx({ doc: tr.doc });
  const rd = (name) => rdProvider(ctx, name);
  const taken = new Set();
  const inserts = [];
  tocEntries(tr.doc, f, { rd }).forEach((e, i) => {
    if (e.bookmark || e.rd) return;
    const name = tocName(tr.doc, taken);
    const mark = (end) => tr.doc.type.schema.nodes.bookmark.create({ name, id: name, end });
    inserts.push({ pos: e.to, end: true, i, node: mark(true) }, { pos: e.from, end: false, i, node: mark(false) });
  });
  // Highest position first, so each insert leaves the others' positions as they were. At one place ends go before starts; a later
  // entry nested in an earlier one (a TC field at a heading's edge) gets its markers inside the earlier entry's.
  inserts.sort((a, b) => b.pos - a.pos || (b.end ? 1 : 0) - (a.end ? 1 : 0) || (a.end ? a.i - b.i : b.i - a.i));
  for (const i of inserts) tr.insert(i.pos, i.node);
  const back = tr.mapping.invert();
  const pageOf = (p) => page(back.map(p));
  let entries = tocEntries(tr.doc, f, { rd });
  if (typeof f.sw.s === 'string') entries = withChapters(tr.doc, entries, f.sw.s);
  return tocBlocks(entries, f, { pageOf, leader, width: textWidth(tr.doc, tr.mapping.map(at)) });
}

const sdtJson = () => ({ ...SDT_DEFAULTS, id: String(Math.floor(Math.random() * 2 ** 31)), type: 'docPart', docPart: { gallery: TOC_GALLERY, category: null } });

/** Adds `defs`' styles that `tr.doc` lacks (ensureStyles) and, for a Formats preset, patches the TOC level styles' run properties.
 * From template leaves the styles as they are, a preset's patch included, because they may hold the user's own Modify Style changes;
 * the dialog reopens on From template (recorded deviation: Word keeps no record of the preset either). */
function addStyles(tr, defs, format = null) {
  let styles = ensureStyles(tr.doc, defs) ?? tr.doc.attrs.styles;
  const preset = format && TOC_FORMATS[format];
  if (preset) {
    const list = { ...styles.list };
    for (const [level, run] of Object.entries(preset)) {
      const id = `TOC${level}`;
      list[id] = { ...list[id], run: { ...list[id]?.run, ...run } };
    }
    styles = { ...styles, list };
  }
  if (styles !== tr.doc.attrs.styles) tr.setDocAttribute('styles', styles);
}

// Where a new block goes for a caret at `pos` of tr.doc: before its paragraph at its start, after it at its end, else the paragraph
// is split there. An empty paragraph is replaced. → {from, to} to replace.
function placeAt(tr, pos, type) {
  const $p = tr.doc.resolve(pos);
  if ($p.parent.isTextblock && $p.depth > 0) {
    const d = $p.depth;
    if ($p.parent.content.size === 0) return { from: $p.before(d), to: $p.after(d) };
    if ($p.parentOffset === 0) return { from: $p.before(d), to: $p.before(d) };
    if ($p.parentOffset === $p.parent.content.size) return { from: $p.after(d), to: $p.after(d) };
    tr.split(pos);
    return { from: pos + 1, to: pos + 1 };
  }
  const at = insertPoint(tr.doc, pos, type) ?? pos;
  return { from: at, to: at };
}

/** Inserts or replaces the table of contents: `code` with heading `title` inside a docPart control (Automatic Table 1 and 2, the
 * dialog's OK), or `manual` entries without a field. A table already in the document is replaced where it stands. One undo step. */
export function insertToc(editor, { code = 'TOC \\o "1-3" \\h \\z \\u', title = 'Contents', manual = false, leader = 'dot', format = null } = {}) {
  const { state } = editor;
  const tr = closeHistory(state.tr);
  addStyles(tr, TOC_STYLES, format);
  const old = tableAt(state);
  const oldRange = old && !old.figures ? { from: old.sdt?.pos ?? old.pos, to: old.sdt?.end ?? old.pos + old.node.nodeSize } : null;
  const at = oldRange?.from ?? state.selection.from;
  const heading = { type: 'paragraph', attrs: { styleId: 'TOCHeading' }, content: [{ type: 'text', text: title }] };
  let body;
  if (manual) {
    const width = textWidth(tr.doc, at);
    const row = (level, text) => ({ type: 'paragraph', attrs: { styleId: `TOC${level}`, tabs: [{ pos: width, align: 'right', leader }] },
      content: [{ type: 'text', text: `${text}\t1` }] });
    body = [row(1, 'Chapter title (level 1)'), row(2, 'Chapter title (level 2)'), row(3, 'Chapter title (level 3)')];
  } else body = [{ type: 'fieldBlock', attrs: { code }, content: buildInto(tr, editor, code, { leader, at }) }];
  const node = state.schema.nodeFromJSON({ type: 'sdtBlock', attrs: { sdt: sdtJson() }, content: [heading, ...body] });
  if (oldRange) tr.replaceWith(tr.mapping.map(oldRange.from), tr.mapping.map(oldRange.to), node);
  else {
    const r = placeAt(tr, tr.mapping.map(at), node.type);
    tr.replaceWith(r.from, r.to, node);
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Inserts a table of figures with `code` at the caret as a plain fieldBlock, or in place of table `replace` (from tableAt). One undo
 * step. */
export function insertTof(editor, { code, leader = 'dot', replace = null }) {
  const { state } = editor;
  const tr = closeHistory(state.tr);
  addStyles(tr, TOF_STYLES);
  const at = replace?.pos ?? state.selection.from;
  const blocks = buildInto(tr, editor, code, { leader, at });
  const node = state.schema.nodeFromJSON({ type: 'fieldBlock', attrs: { code }, content: blocks });
  const r = replace ? { from: tr.mapping.map(replace.pos), to: tr.mapping.map(replace.pos + replace.node.nodeSize) } : placeAt(tr, tr.mapping.map(at), node.type);
  tr.replaceWith(r.from, r.to, node);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Updates the table at the caret (or the first; `figures`: every table of figures). mode 'pages' refreshes the page numbers through
 * the field engine (G5); 'all' rebuilds the entries and adds the bookmarks new headings need, in one transaction. */
export async function updateTables(editor, mode, { figures = false } = {}) {
  const list = figures ? tablesIn(editor.state.doc).filter((t) => t.figures) : [tableAt(editor.state)].filter((t) => t && !t.figures && !t.manual);
  if (!list.length) return false;
  if (mode === 'pages') {
    for (const t of list.reverse()) {
      const now = tablesIn(editor.state.doc).find((x) => x.node.attrs.code === t.node.attrs.code && x.figures === t.figures);
      if (now) await updateFields(editor, { from: now.pos, to: now.pos + now.node.nodeSize }, 'manual', { names: ['TOC'], mode: 'pages' });
    }
    return true;
  }
  await loadRd(editor.state.doc);
  const { state } = editor;
  const tr = closeHistory(state.tr);
  addStyles(tr, figures ? TOF_STYLES : TOC_STYLES);
  for (const t of [...list].reverse()) {
    const blocks = buildInto(tr, editor, t.node.attrs.code, { leader: leaderOf(t.node), at: t.pos });
    const pos = tr.mapping.map(t.pos);
    const node = tr.doc.nodeAt(pos);
    if (!node || nameOf(node) !== 'fieldBlock') continue;
    tr.replaceWith(pos + 1, pos + node.nodeSize - 1, blocks.map((j) => state.schema.nodeFromJSON(j)));
    if (node.attrs.dirty) tr.setNodeAttribute(pos, 'dirty', false);
  }
  editor.view.dispatch(tr);
  return true;
}

/** Removes the table of contents (its control, or the bare field). One undo step. */
export function removeToc(editor) {
  const t = tableAt(editor.state);
  if (!t || t.figures) return false;
  const from = t.sdt?.pos ?? t.pos;
  const to = t.sdt?.end ?? t.pos + t.node.nodeSize;
  const tr = closeHistory(editor.state.tr);
  if (editor.state.doc.childCount === 1 && from === 0) tr.replaceWith(from, to, editor.state.schema.nodes.paragraph.create());
  else tr.delete(from, to);
  editor.view.dispatch(tr);
  return true;
}

/** Writes a hidden TC field with `code` after the selection of `editor`. One undo step. */
export function markEntry(editor, code) {
  const { state } = editor;
  const node = state.schema.nodes.field.create({ code, result: null }, null, [state.schema.marks.textStyle.create({ vanish: true })]);
  editor.view.dispatch(closeHistory(state.tr.insert(state.selection.to, node)));
  return true;
}

// ---------- captions ----------
/** The object a caption goes with in `state`: a node-selected block, the paragraph of a node-selected inline object, or the table
 * around the caret → {from, to} of the block, or null. */
export function captionTarget(state) {
  const sel = state.selection;
  const n = sel.node;
  if (n) {
    if (n.isBlock) return { from: sel.from, to: sel.to, kind: nameOf(n) };
    const $f = sel.$from;
    return { from: $f.before($f.depth), to: $f.after($f.depth), kind: nameOf(n) };
  }
  const $f = sel.$from;
  for (let d = $f.depth; d > 0; d--) if (nameOf($f.node(d)) === 'table') return { from: $f.before(d), to: $f.after(d), kind: 'table' };
  return null;
}

/** The STYLEREF n \s result before `pos`: the number of the last Heading n's list label, 0 when it has none (probe). */
function chapterBefore(doc, pos, level) {
  let at = null;
  doc.nodesBetween(0, pos, (n, p) => {
    if (n.isTextblock) {
      if (styleOutline(doc, n) === level - 1) at = p;
      return false;
    }
    return true;
  });
  if (at == null) return '0';
  const label = fieldCtx({ doc }).listLabel(at + 1)?.text;
  return label ? (label.match(/\d+|[a-z]+/i)?.[0] ?? '0') : '0';
}

/** Sets every SEQ `id` field result in `tr` to its number in document order. */
function renumber(tr, id) {
  for (const s of seqNumbers(tr.doc)) {
    if (s.id !== id.toLowerCase()) continue;
    const node = tr.doc.nodeAt(s.pos);
    const text = seqText(s.n, s.f.format);
    if (node && node.attrs.result !== text) tr.setNodeMarkup(s.pos, null, { ...node.attrs, result: text }, node.marks);
  }
}

/** The numbering of `label` from settings.word.captions: {format, chapter: {level, sep} | null}. */
export function numberingOf(settings, label) {
  const n = wordSettings(settings).captions?.numbering?.[label] ?? {};
  return { format: n.format ?? 'ARABIC', chapter: n.chapter ? { level: n.level ?? 1, sep: n.sep ?? 'hyphen' } : null };
}

/** The text the Caption dialog shows for `label` before the typed text: "Figure 1", "Figure 2-1" with chapter numbers, the number alone
 * when the label is excluded. */
export function captionPrefix(state, label, { exclude = false } = {}) {
  const obj = captionTarget(state);
  const at = obj ? obj.to : state.selection.to;
  const { format, chapter } = numberingOf(getState().settings, label);
  const n = seqNumbers(state.doc).filter((s) => s.id === seqId(label).toLowerCase() && s.pos < at).length + 1;
  const num = chapter ? `${chapterBefore(state.doc, at, chapter.level)}${SEPARATORS[chapter.sep] ?? '-'}${seqText(n, [format])}` : seqText(n, [format]);
  return exclude ? num : `${label} ${num}`;
}

/** Inserts a caption paragraph for `label` (`text` after the number) above or below the selected object, or after the caret's
 * paragraph without one. Fills the SEQ and STYLEREF results and renumbers that label's later captions. One undo step. */
export function insertCaption(editor, { label = 'Figure', text = '', position = 'below', exclude = false, target = undefined, tr: given = null } = {}) {
  const { state } = editor;
  const tr = given ?? closeHistory(state.tr);
  addStyles(tr, CAPTION_STYLES);
  const obj = target === undefined ? captionTarget(state) : target;
  let at;
  if (obj) at = tr.mapping.map(position === 'above' ? obj.from : obj.to);
  else {
    const $f = tr.doc.resolve(tr.mapping.map(state.selection.to));
    at = $f.depth ? $f.after($f.depth) : tr.doc.content.size;
  }
  const { format, chapter } = numberingOf(getState().settings, label);
  const id = seqId(label);
  const before = seqNumbers(tr.doc).filter((s) => s.id === id.toLowerCase() && s.pos < at).length;
  const content = captionInline(label, { exclude, chapter, format, text, seq: before + 1, chapterText: chapter ? chapterBefore(tr.doc, at, chapter.level) : '0' });
  const para = state.schema.nodeFromJSON({ type: 'paragraph', attrs: { styleId: 'Caption' }, content });
  tr.insert(at, para);
  renumber(tr, id);
  if (!given) editor.view.dispatch(tr.scrollIntoView());
  return true;
}

// ---------- AutoCaption ----------
// The app's object kinds AutoCaption offers (in place of Word's OLE classes) → the node type and its attribute test.
export const AUTO_KINDS = [
  ['table', 'Table', (n) => nameOf(n) === 'table'],
  ['picture', 'Picture', (n) => nameOf(n) === 'image'],
  ['canvas', 'Canvas', (n) => nameOf(n) === 'canvas' && n.attrs.kind !== 'flowchart'],
  ['flowchart', 'Flowchart', (n) => nameOf(n) === 'canvas' && n.attrs.kind === 'flowchart'],
  ['planChart', 'Plan chart', (n) => nameOf(n) === 'planChart'],
  ['equation', 'Equation', (n) => nameOf(n) === 'equation'],
  ['textBox', 'Text box', (n) => nameOf(n) === 'textBox'],
];

// The new objects a transaction's steps insert (node identity survives the insert).
function insertedObjects(tr, kinds) {
  const out = new Set();
  for (const step of tr.steps) {
    step.slice?.content.descendants((n) => {
      if (kinds.some(([, , is]) => is(n))) out.add(n);
      return true;
    });
  }
  return out;
}

// Paste, drop (a drag-move too) and cut carry objects already in a draft: Word captions only new inserts.
const MOVES = new Set(['paste', 'drop', 'cut']);

/** The plugin of `editor` that adds a caption when one of settings.word.captions.autoCaption's kinds is inserted in the main text (a
 * header, footer or note story gets none); its step joins the insert's undo step (an appended transaction). Undo, redo, loads, moves
 * and other packages' engine writes are not inserts. */
const autoCaption = (editor) => new Plugin({
  appendTransaction(trs, _old, next) {
    if (editor.options.editorProps?.attributes?.['data-story']) return null;
    const auto = wordSettings(getState().settings).captions?.autoCaption ?? {};
    const kinds = AUTO_KINDS.filter(([k]) => auto[k]?.on);
    if (!kinds.length) return null;
    const objs = new Set();
    for (const t of trs) {
      if (!t.docChanged || t.getMeta('history$') || t.getMeta('addToHistory') === false || t.getMeta('tocAutoCaption') || MOVES.has(t.getMeta('uiEvent'))) continue;
      for (const n of insertedObjects(t, kinds)) objs.add(n);
    }
    if (!objs.size) return null;
    const found = [];
    next.doc.descendants((n, pos) => {
      if (objs.has(n)) found.push({ n, pos });
      return true;
    });
    if (!found.length) return null;
    const tr = next.tr.setMeta('tocAutoCaption', true);
    for (const { n, pos } of found.reverse()) {
      const [kind] = kinds.find(([, , is]) => is(n));
      const opt = auto[kind];
      const $p = next.doc.resolve(pos);
      const target = n.isBlock ? { from: pos, to: pos + n.nodeSize } : { from: $p.before($p.depth), to: $p.after($p.depth) };
      insertCaption({ state: next }, { label: opt.label ?? 'Figure', position: opt.position ?? 'below', target, tr });
    }
    return tr.docChanged ? tr : null;
  },
});

/** F9 inside a table of contents opens Update Table (Word asks there too); AutoCaption watches inserts. */
export const TocKeys = Extension.create({
  name: 'wordToc',
  priority: 1300, // before WordKeys (1200), whose F9 updates fields
  addKeyboardShortcuts() {
    return {
      F9: () => {
        if (!this.editor.view.dom.isConnected || !inTable(this.editor.state)) return false;
        const t = tableAt(this.editor.state);
        run(t?.figures ? 'references.captions.updateTable' : 'references.tableOfContents.updateTable');
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [autoCaption(this.editor)];
  },
});
