// Field updates (docs/plans/word/plan.md §1.10): the API every field package calls. computeField evaluates one code with nested
// fields inside out and the general switches (\* \# \@); updateFields updates the fields of a range; insertField puts a field in.
// The rule every package keeps: derived values are view state. Only a manual update (F9, Update Field, Update Table, unlink) or an
// explicit command writes a stored result, as one undo step; layout, open, print and merge refresh the drawn values only (the
// field node views of fields-core draw them), because a doc write there would add to the saved undo log, mark the draft dirty and
// stamp a v1 Document as v2 without a user edit.
import { closeHistory } from '@tiptap/pm/history';
import { getState } from '../../app/store.js';
import { activeSurface } from '../../tooling/surface.js';
import { geometryOf, nodeDOMs, pageAtPos } from '../geometry.js';
import { indexAt } from '../geometry.mjs';
import { deepPatch } from '../../office.mjs';
import { applySwitches } from '../wp/fields-core/format.mjs';
import { afterUpdate } from '../wp/fields-core/runs.mjs';
import { fieldCtx, fieldType, parseField, registerField, updateState } from './registry.mjs';

const FIELD_NODES = new Set(['field', 'fieldBlock']);

// ---------- live field views ----------
// The field node views on screen per ProseMirror view (fields-core's view.js adds and removes them): {getPos, node, over, set(r)}.
// A refresh sets `over`, the drawn value, without touching the document.
const live = new WeakMap();
/** The live field views of ProseMirror view `pmView` → a Set (fields-core's node views add themselves). */
export function fieldViews(pmView) {
  let s = live.get(pmView);
  if (!s) live.set(pmView, (s = new Set()));
  return s;
}

// The values the last open, print or merge refresh computed per editor (pos → FieldResult), for editors without views.
const refreshed = new WeakMap();

/** The drawn values of `editor`'s fields: Map pos → FieldResult, from the last refresh and the live views that hold one. */
export function drawnOf(editor) {
  if (!editor?.view) return new Map();
  const out = new Map(refreshed.get(editor));
  for (const v of fieldViews(editor.view)) {
    const pos = v.getPos();
    if (pos != null && v.over !== undefined) out.set(pos, v.over);
  }
  return out;
}

// ---------- context ----------
/** The DOM root of `pmView`, or null for an editor without a mounted view (TipTap's placeholder view throws on dom). */
const domOf = (pmView) => {
  try {
    return pmView?.dom ?? null;
  } catch {
    return null;
  }
};

/** The story an editor view writes: its data-story ('header', 'footer', 'footnote'...) or 'body'. */
const storyOf = (pmView) => domOf(pmView)?.closest?.('[data-story]')?.dataset.story ?? 'body';

/** What every field of one update or draw shares for ProseMirror view `pmView` with `state`: the doc, the main document's geometry,
 * the draft record and the user. Story editors read the main editor's geometry. */
export function baseOf(state, pmView) {
  const app = getState();
  const story = storyOf(pmView);
  const main = story === 'body' ? pmView : activeSurface()?.editor?.view ?? null;
  const geometry = main ? geometryOf(main.state) : geometryOf(state);
  const d = app.draft ?? {};
  return {
    doc: state.doc,
    story,
    geometry,
    now: new Date(),
    draft: { title: d.title ?? '', created: d.created ?? 0, saved: d.updated ?? 0, savedBy: d.savedBy ?? '', printed: d.printed ?? null,
      editMinutes: d.editMinutes ?? 0, revision: d.revision ?? 0 },
    user: app.settings?.word?.user ?? null,
    // The exact page while the main view is on screen; fieldCtx falls back to the page whose range holds the position.
    pageAt: geometry && story === 'body' && domOf(pmView)?.isConnected ? exactPage(geometry, pmView) : null,
  };
}

/** The exact page of a body position: engine 2 starts each page's range at a line (page.from), so a field inside a long paragraph
 * finds its own line's page there without a DOM read (the layout pass asks for every layout field after each keypress); other
 * engines read the coordinates. */
function exactPage(geometry, view) {
  if (geometry.engine !== 2) return (p) => geometry.pages[pageAtPos(view, p)] ?? null;
  const real = geometry.pages.filter((pg) => !pg.blank);
  const froms = real.map((pg) => pg.from);
  return (p) => real[indexAt(froms, p)] ?? null;
}

/** The page a field at `pos` is drawn on: its block's page in the body, the selection's page in a story editor (headers and
 * footers draw per page through their layers with their own page), null without pagination. */
export const pageOf = (base, pos) => {
  const g = base.geometry;
  if (!g) return null;
  return base.story === 'body' ? g.pages[g.pageOf(pos)] ?? null : g.pages[g.page] ?? null;
};

/** The exact page of a position of `editor` from coordinates while its view is on screen, else null (callers fall back to geometry). */
export const exactPageAt = (editor, geometry = geometryOf(editor.state)) =>
  (geometry?.pages?.length && editor.view?.dom?.isConnected ? exactPage(geometry, editor.view) : null);

/** A FieldCtx for the field at `pos` from `base` (baseOf), sharing `shared` (updateState) across one update. */
export const ctxAt = (base, pos, extra = {}) => fieldCtx({ ...base, pos, page: pageOf(base, pos), ...extra });

// ---------- computing ----------
/** Field `f`'s result through its type, or null when compute throws (the stored result stays). */
function run(type, f, ctx) {
  try {
    return type.compute(f, ctx) ?? null;
  } catch (e) {
    console.warn(`Field ${f.name} failed`, e);
    return null;
  }
}

/** The text a field node stores for result `r`. */
export const textOf = (r) => (typeof r === 'string' ? r : r?.error ?? r?.text ?? '');

/** A SEQ counter's current number from ctx.seq (its value may be a number or {n}). */
const seqNumber = (ctx) => (name) => {
  const v = ctx.seq.get(name) ?? ctx.seq.get(String(name).toUpperCase()) ?? ctx.seq.get(String(name).toLowerCase());
  return typeof v === 'number' ? v : v?.n ?? v?.value ?? 0;
};

/** The result of one field code in `ctx` (a FieldCtx): nested fields computed first, inside out, each result spliced in as one
 * argument; then the type's compute; then the general switches (\@, \#, each \* in order) unless the result is raw, blocks or an
 * error. → FieldResult, or null when no type is registered. Pure and allocation-light: headers and footers call it per page.
 * ponytail: \! (keep nested results) has nothing to keep, since nested fields live only as code text; a nested result also loses
 * its own run formatting (one mark set per atom). */
export function computeField(code, ctx) {
  const f = parseField(code, (inner) => {
    const r = computeField(inner, ctx);
    return r == null ? '' : textOf(r);
  });
  const type = fieldType(f.name);
  if (!type) return null;
  const r = run(type, f, ctx);
  if (r == null || (typeof r === 'object' && (r.blocks || r.error != null || r.raw))) return r;
  const text = typeof r === 'string' ? r : r.text ?? '';
  const lang = ctx.get?.('dateLang') ?? 'en-US';
  return applySwitches(text, f, { seqOf: seqNumber(ctx), lang, datedAlready: !!type.picture });
}

/** Block JSON `blocks` with every field inside computed in `ctx` (TOC's PAGEREF fields compute in the TOC's own update). */
function fillBlocks(blocks, ctx) {
  const walk = (j) => {
    if (j.type === 'field' && j.attrs?.code && !j.attrs.locked) {
      const r = computeField(j.attrs.code, ctx);
      return r == null ? j : { ...j, attrs: { ...j.attrs, result: textOf(r) } };
    }
    return j.content ? { ...j, content: j.content.map(walk) } : j;
  };
  return blocks.map(walk);
}

// ---------- updating ----------
// The fields and fieldBlocks of `doc` in `range` ({from, to} or 'all'), in document order, limited to `names` (upper case) when
// given; `block` is the index of the fieldBlock an entry sits in.
function fieldsIn(doc, range, names) {
  const want = names?.length ? new Set(names.map((n) => String(n).toUpperCase())) : null;
  const from = range === 'all' || !range ? 0 : Math.max(0, range.from);
  const to = range === 'all' || !range ? doc.content.size : Math.min(doc.content.size, range.to);
  const out = [];
  const blocks = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!FIELD_NODES.has(node.type.name)) return true;
    while (blocks.length && pos >= blocks[blocks.length - 1].end) blocks.pop();
    const f = parseField(node.attrs.code);
    const block = blocks.length ? blocks[blocks.length - 1].i : -1;
    if (!want || want.has(f.name)) out.push({ node, pos, f, block });
    if (node.type.name === 'fieldBlock') blocks.push({ end: pos + node.nodeSize, i: out.length - 1 });
    return node.type.name === 'fieldBlock'; // a fieldBlock's own fields update with it
  });
  return out;
}

/** Whether a non-manual `reason` refreshes a field of `type` (dirty fields refresh on open too). */
function refreshes(type, reason, dirty) {
  const u = type.updates;
  if (u === 'never') return false;
  if (u === 'layout') return true;
  if (reason === 'open') return u === 'open' || dirty;
  if (reason === 'print') return u === 'open' || u === 'print';
  return u === reason;
}

/** Updates the fields of `editor` in `range` ({from, to} or 'all') for `reason` ('manual', 'open', 'layout', 'print', 'merge').
 * `names` limits it to fields with those names; `mode` reaches compute as ctx.mode. 'manual' computes every unlocked field in
 * document order with one shared context (prompts awaited, inner fields first) and writes the results in one transaction, one
 * undo step; the other reasons only refresh the drawn values (merge awaits prompts too). → Promise of the number computed. */
export async function updateFields(editor, range = 'all', reason = 'manual', { names, mode } = {}) {
  const start = editor.state.doc;
  const list = fieldsIn(start, range, names);
  const base = baseOf(editor.state, editor.view);
  const prompts = reason === 'manual' || reason === 'merge';
  if (reason !== 'manual') {
    const shared = updateState();
    const views = [...fieldViews(editor.view)];
    const map = new Map(refreshed.get(editor));
    let count = 0;
    for (const { node, pos, f } of list) {
      const type = fieldType(f.name);
      if (!type || node.attrs.locked || !refreshes(type, reason, node.attrs.dirty)) continue;
      let answer = null;
      if (prompts && type.prompt) {
        answer = await type.prompt(f, ctxAt(base, pos, { shared, mode }));
        if (answer == null) continue;
      }
      const r = computeField(node.attrs.code, ctxAt(base, pos, { shared, mode, answer }));
      if (r == null) continue;
      views.find((v) => v.getPos() === pos)?.set(r);
      map.set(pos, r);
      count++;
    }
    refreshed.set(editor, map);
    return count;
  }
  const shared = updateState({ props: [] });
  const results = [];
  const rebuilt = new Set(); // fieldBlocks whose new blocks replace the fields inside them
  for (let i = 0; i < list.length; i++) {
    const { node, pos, f, block } = list[i];
    if (block >= 0 && rebuilt.has(block)) continue;
    const type = fieldType(f.name);
    if (!type || node.attrs.locked || type.updates === 'never') continue;
    let answer = null;
    if (type.prompt) {
      answer = await type.prompt(f, ctxAt(base, pos, { shared, mode }));
      if (answer == null) continue; // Cancel keeps the old result
    }
    const ctx = ctxAt(base, pos, { shared, mode, answer });
    const r = computeField(node.attrs.code, ctx);
    if (r == null) continue;
    if (node.type.name === 'fieldBlock' && r.blocks) {
      rebuilt.add(i);
      results.push({ i, code: node.attrs.code, r: { blocks: fillBlocks(r.blocks, ctx) } });
    } else results.push({ i, code: node.attrs.code, r });
  }
  if (!results.length) return 0;
  // A prompt may have let the user edit meanwhile: each result goes to the field at the same place in the list with the same code.
  const { state } = editor;
  const now = state.doc === start ? list : fieldsIn(state.doc, range, names);
  const tr = state.tr;
  const written = [];
  for (const { i, code, r } of [...results].reverse()) {
    const at = now[i];
    if (!at || at.node.attrs.code !== code) continue;
    if (at.node.type.name === 'fieldBlock') {
      if (!r.blocks) continue;
      tr.replaceWith(at.pos + 1, at.pos + at.node.nodeSize - 1, r.blocks.map((j) => state.schema.nodeFromJSON(j)));
      if (at.node.attrs.dirty) tr.setNodeAttribute(at.pos, 'dirty', false);
    } else {
      written.push(at.pos);
      // The result's runs follow \* MERGEFORMAT, or give way to the first run's formatting (fields-core runs.mjs).
      const next = afterUpdate(at.node, textOf(r));
      if (at.node.attrs.result !== textOf(r) || at.node.attrs.dirty || next.changed) {
        tr.setNodeMarkup(at.pos, null, { ...at.node.attrs, result: textOf(r), runs: next.runs, dirty: false }, next.marks);
      }
    }
  }
  if (shared.props.length) {
    let props = tr.doc.attrs.props ?? {};
    for (const { path, value } of shared.props) props = deepPatch(props, String(path).split('.').reduceRight((v, k) => ({ [k]: v }), value));
    tr.setDocAttribute('props', props);
  }
  // The updated fields draw their new stored results, not an older refresh.
  for (const v of fieldViews(editor.view)) if (written.includes(v.getPos())) v.set(undefined);
  refreshed.delete(editor);
  if (tr.docChanged) editor.view.dispatch(closeHistory(tr.setMeta('wordEngine', true)));
  return results.length;
}

/** Inserts a field with `code` over the selection of `editor`: `result` as given, else computed now; `marks` (mark JSON) go on the
 * node (textStyle vanish for XE, TC and TA), else it takes the marks at the caret. One undo step. → the field's position, or false
 * when the schema has no field node. */
export function insertField(editor, code, { result, marks } = {}) {
  const { state } = editor;
  const type = state.schema.nodes.field;
  if (!type) return false;
  const pos = state.selection.from;
  const value = result !== undefined ? result : computeField(code, ctxAt(baseOf(state, editor.view), pos));
  const own = marks ? marks.map((m) => state.schema.markFromJSON(m)) : state.storedMarks ?? state.selection.$from.marks();
  const node = type.create({ code, result: value == null ? null : textOf(value) }, null, own);
  const tr = state.tr.replaceSelectionWith(node, false);
  editor.view.dispatch(closeHistory(tr).scrollIntoView());
  return tr.mapping.map(pos, -1);
}

// ---------- the after layout pass ----------
const passState = new WeakMap(); // pmView → {version, n}

/** The 'after' layout pass (plan.md §1.9, §1.10): when the geometry's version changes it recomputes the drawn values of layout
 * fields (PAGE, NUMPAGES, SECTION, SECTIONPAGES, the AUTONUM types) and reports a change only when a drawn width moved, at most
 * three times per version so NUMPAGES cannot loop (pageGuard's rule). Writes nothing to the document. */
export const layoutPass = {
  id: 'fields-core.layout',
  phase: 'after',
  run(pmView) {
    if (!pmView.dom.isConnected || pmView.dom.closest('[data-story]')) return false;
    const geometry = geometryOf(pmView.state);
    const views = live.get(pmView);
    if (!geometry || !views?.size) return false;
    const st = passState.get(pmView) ?? { version: -1, n: 0 };
    if (st.version === geometry.version && st.n >= 3) return false;
    st.n = st.version === geometry.version ? st.n + 1 : 1;
    st.version = geometry.version;
    passState.set(pmView, st);
    const base = baseOf(pmView.state, pmView);
    const shared = updateState();
    // Every value first, then every write: a page lookup after a write would lay the whole document out again, once per field.
    const due = [];
    // Every field's position from one walk where there are many: getPos sums the sizes of the blocks before its own, per field
    // (seconds on a long document with thousands of fields); a few fields find theirs faster one by one.
    const at = new Map();
    if (views.size > 64) for (const [p, el] of nodeDOMs(pmView)) at.set(el, p);
    for (const v of views) {
      if (!v.layout || v.node.attrs.locked) continue;
      const pos = at.get(v.dom) ?? v.getPos();
      if (pos == null) continue;
      const r = computeField(v.node.attrs.code, ctxAt(base, pos, { shared }));
      if (r != null && textOf(r) !== textOf(v.over)) due.push({ v, r });
    }
    if (!due.length) return false;
    const widths = due.map(({ v }) => v.dom.offsetWidth);
    for (const { v, r } of due) v.set(r);
    return due.some(({ v }, i) => v.dom.offsetWidth !== widths[i]);
  },
};

// The harness's hook (docs/plans/word/plan.md §1.16): cases register field types and update through the bundle's own registry.
if (typeof window !== 'undefined') window.__fields = { computeField, insertField, updateFields, drawnOf, registerField, parseField, baseOf, ctxAt };
