// Index and table of authorities (docs/plans/word/plan.md §3 index-toa): XE and TA entries marked as hidden fields, the INDEX and
// TOA fieldBlocks built from them (builders in index.mjs), the Index and Table of Authorities tabs of Word's four-tab dialog, Mark
// Index Entry, Mark Citation, AutoMark and Update Index and Update Table.
import { closeHistory } from '@tiptap/pm/history';
import { getState } from '../../../app/store.js';
import { activeSurface } from '../../../tooling/surface.js';
import { commandOf, run } from '../../../tooling/registry.js';
import { parseField, fieldCtx } from '../../fields/registry.mjs';
import { computeField, updateFields } from '../../fields/engine.js';
import { geometryOf, pageAtPos } from '../../geometry.js';
import { sectionOf } from '../../model/sections.mjs';
import { ensureStyles } from '../../model/styles.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { DIALOGS } from './dialogs.jsx';
import { buildIndex, buildToa, levelsOf, STYLES } from './index.mjs';

const HIDDEN = [{ type: 'textStyle', attrs: { vanish: true } }];

/** Every field named `name` in `doc` → [{pos, f}] in document order. Generated results (INDEX, TOA, TOC blocks) are skipped, so a
 * table never counts a field that sits in its own output. */
export function fieldsNamed(doc, name) {
  const out = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'fieldBlock') return false;
    if (n.type.name !== 'field') return true;
    const f = parseField(n.attrs.code);
    if (f.name === name) out.push({ pos, f });
    return false;
  });
  return out;
}

// The page a position is on as the builders want it: index for sorting, the shown label (page 1 without pagination).
// A hidden XE or TA has no box to measure, so the character before it (the marked text's end) gives its page.
const pageAt = (ctx, pos) => {
  const p = ctx.pageAt(pos > 1 ? pos - 1 : pos);
  return p ? { n: p.index, label: p.label ?? String(p.number) } : { n: 0, label: '1' };
};
// The page range of bookmark `name` (XE and TA \r), or null without the bookmark.
const rangeAt = (ctx, name) => {
  const b = name && ctx.bookmark(name);
  return b ? { page: pageAt(ctx, b.from), to: pageAt(ctx, Math.max(b.from, b.to - 1)) } : null;
};
// The text width of the section holding `pos` (pt): where a right-aligned page number's tab sits.
const widthAt = (doc, pos) => {
  const s = sectionOf(doc, pos)?.sect ?? doc.attrs.sect;
  return (s?.w ?? 595.3) - (s?.margin?.left ?? 72) - (s?.margin?.right ?? 72);
};
// The leader of the right tab style `id` holds (the dialogs' Tab leader writes it there), dots by default.
const leaderOf = (doc, id) => doc.attrs.styles?.list?.[id]?.para?.tabs?.find((x) => x.align === 'right')?.leader ?? 'dot';
// Entries limited to bookmark \b's range.
const within = (ctx, sw, list) => {
  const b = typeof sw.b === 'string' ? ctx.bookmark(sw.b) : null;
  return b ? list.filter(({ pos }) => pos >= b.from && pos <= b.to) : list;
};

// INDEX and TOA \s: a page label prefixed by the count of SEQ fields named \s before the entry, joined by \d ("-" by default).
function chapterOf(f, ctx) {
  const seq = typeof f.sw.s === 'string' ? fieldsNamed(ctx.doc, 'SEQ').filter((s) => String(s.f.args[0]).toLowerCase() === f.sw.s.toLowerCase()) : null;
  return (pos, p) => (seq && p ? { ...p, label: `${seq.filter((s) => s.pos < pos).length}${f.sw.d ?? '-'}${p.label}` } : p);
}

/** INDEX's blocks at ctx: every XE (limited by \b) with its page from ctx.pageAt, chapter-prefixed under \s. */
function indexBlocks(f, ctx) {
  const chapter = chapterOf(f, ctx);
  const entries = within(ctx, f.sw, fieldsNamed(ctx.doc, 'XE')).map(({ pos, f: x }) => {
    const range = typeof x.sw.r === 'string' ? rangeAt(ctx, x.sw.r) : null;
    return {
      levels: levelsOf(x.args[0]), type: typeof x.sw.f === 'string' ? x.sw.f : 'I', yomi: typeof x.sw.y === 'string' ? x.sw.y : null,
      cross: typeof x.sw.t === 'string' ? x.sw.t : null, bold: !!x.sw.b, italic: !!x.sw.i,
      page: chapter(pos, range?.page ?? pageAt(ctx, pos)), to: range ? chapter(pos, range.to) : null,
    };
  });
  return buildIndex(entries, f.sw, { tabPos: widthAt(ctx.doc, ctx.pos), leader: leaderOf(ctx.doc, 'Index1') });
}

/** Every TA of `doc` as the TOA builder reads it, with pages through `ctx` when given. */
export function taEntries(doc, ctx = null) {
  return fieldsNamed(doc, 'TA').map(({ pos, f }) => {
    const range = ctx && typeof f.sw.r === 'string' ? rangeAt(ctx, f.sw.r) : null;
    const str = (v) => (typeof v === 'string' ? v : null);
    return { pos, long: str(f.sw.l), short: str(f.sw.s), category: Number(f.sw.c) || 1, bold: !!f.sw.b, italic: !!f.sw.i,
      page: ctx ? range?.page ?? pageAt(ctx, pos) : null, to: range?.to ?? null };
  });
}

function toaBlocks(f, ctx) {
  const names = wordSettings(getState().settings).toaCategories;
  const chapter = chapterOf(f, ctx);
  const entries = taEntries(ctx.doc, ctx).map((e) => ({ ...e, page: chapter(e.pos, e.page), to: chapter(e.pos, e.to) }));
  return buildToa(within(ctx, f.sw, entries), f.sw,
    { names, tabPos: widthAt(ctx.doc, ctx.pos), leader: leaderOf(ctx.doc, 'TableofAuthorities') });
}

const category = 'Index and Tables';
const FIELDS = {
  XE: { category, updates: 'never', bare: 'bi', compute: () => null },
  TA: { category, updates: 'never', bare: 'bi', compute: () => null },
  INDEX: { category, updates: 'manual', block: true, bare: 'ry', compute: (f, ctx) => ({ blocks: indexBlocks(f, ctx) }) },
  TOA: { category, updates: 'manual', block: true, bare: 'hpf', compute: (f, ctx) => ({ blocks: toaBlocks(f, ctx) }) },
};

// ---------- editing ----------

/** The Document's main editor, which index entries and tables live in. */
export const mainEditor = () => activeSurface()?.editor ?? null;

/** The fieldBlock named `name` holding the selection of `state` → {pos, node} or null. */
function blockAt(state, name) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'fieldBlock' && parseField(n.attrs.code).name === name) return { pos: $from.before(d), node: n };
  }
  return null;
}

/** A FieldCtx on `doc` (the editor's by default) for computing a result now, outside updateFields (the exact page while the view
 * is on screen). */
function ctxNow(editor, pos, doc = editor.state.doc) {
  const { state, view } = editor;
  const geometry = geometryOf(state);
  return fieldCtx({ doc, pos, geometry,
    pageAt: geometry && view?.dom?.isConnected ? (p) => geometry.pages[pageAtPos(view, p)] ?? null : null });
}

/** Writes fieldBlocks for `codes` at the selection of `editor`, replacing the `name` block that holds it, with the styles they use
 * brought in: one undo step. `leader` ({id, leader}) is the dialog's Tab leader, written into style `id` as Word does: a right tab
 * at the text's right edge, which the builders read the leader from. */
export function insertBlocks(editor, codes, name, leader = null) {
  const { state } = editor;
  const { schema } = state;
  const tr = state.tr;
  const old = blockAt(state, name);
  const at = old ? old.pos : state.selection.from;
  let styles = ensureStyles(state.doc, STYLES);
  if (leader) {
    const base = styles ?? state.doc.attrs.styles;
    const s = base.list[leader.id];
    const tabs = [{ pos: Math.round(widthAt(state.doc, at)), align: 'right', leader: leader.leader }];
    styles = { ...base, list: { ...base.list, [leader.id]: { ...s, para: { ...s?.para, tabs } } } };
  }
  if (styles) tr.setDocAttribute('styles', styles);
  const nodes = codes.map((code) => {
    const blocks = computeField(code, ctxNow(editor, at, tr.doc))?.blocks ?? [];
    return schema.nodes.fieldBlock.create({ code }, blocks.map((j) => schema.nodeFromJSON(j)));
  });
  if (old) tr.replaceWith(old.pos, old.pos + old.node.nodeSize, nodes);
  else {
    // An empty paragraph gives its place to the table; otherwise it goes after the paragraph holding the caret.
    const $f = state.selection.$from;
    if ($f.depth && $f.parent.content.size === 0) tr.replaceWith($f.before(), $f.after(), nodes);
    else tr.insert($f.depth ? $f.after() : $f.pos, nodes);
  }
  editor.view.dispatch(closeHistory(tr).scrollIntoView());
  return true;
}

/** Inserts the hidden field `code` (XE, TA) at `pos` of `editor` (after the marked text), keeping the selection. */
export function insertHidden(editor, code, pos, tr = editor.state.tr) {
  const { schema } = editor.state;
  tr.insert(pos, schema.nodes.field.create({ code }, null, HIDDEN.map((m) => schema.markFromJSON(m))));
  return tr;
}

/** Word turns formatting marks on after a Mark so the new hidden field shows. */
export function showMarks() {
  if (!wordSettings(getState().settings).marks?.all && commandOf('home.paragraph.showAll')) run('home.paragraph.showAll');
}

/** Update Index and Update Table: the `name` block holding the caret, else every one, as one undo step. */
function update(ctx, name) {
  const ed = ctx.ed;
  const at = blockAt(ed.state, name);
  return updateFields(ed, at ? { from: at.pos, to: at.pos + at.node.nodeSize } : 'all', 'manual', { names: [name] });
}

const body = (ctx) => !!ctx.ed && ctx.story === 'body';
const reason = (ctx) => (body(ctx) ? null : 'Works in the main text of a document.');
const cmd = (fn) => ({ run: fn, enabled: body, reason });

export default {
  id: 'index-toa',
  fields: FIELDS,
  dialogs: DIALOGS,
  commands: {
    'references.index.markEntry': cmd((ctx) => ctx.dialog('markIndexEntry')),
    'references.index.insertIndex': cmd((ctx) => ctx.dialog('index')),
    'references.index.updateIndex': cmd((ctx) => update(ctx, 'INDEX')),
    'references.tableOfAuthorities.markCitation': cmd((ctx) => ctx.dialog('markCitation')),
    'references.tableOfAuthorities.insertTableOfAuthorities': cmd((ctx) => ctx.dialog('tableOfAuthorities')),
    'references.tableOfAuthorities.updateTable': cmd((ctx) => update(ctx, 'TOA')),
  },
  implements: ['fields.INDEX', 'fields.XE', 'fields.TOA', 'fields.TA', 'keys.markIndexKey', 'keys.markCitationKey'],
};
