// fields-core's commands (docs/plans/word/plan.md §1.3, §1.13 F9 rows; briefs/fields-core.md Commands): update, toggle, insert,
// browse, lock, unlink and click fields, the date, time and page field keys, the Field and Date and Time dialogs and the shading
// option. Each acts on the target editor (the story holding the focus, else the main editor).
import { Extension } from '@tiptap/core';
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history';
import { Fragment } from '@tiptap/pm/model';
import { NodeSelection, Plugin } from '@tiptap/pm/state';
import { Mapping, RemoveMarkStep, RemoveNodeMarkStep } from '@tiptap/pm/transform';
import { baseOf, ctxAt, computeField, drawnOf, insertField, textOf, updateFields } from '../../fields/engine.js';
import { fieldType, parseField } from '../../fields/registry.mjs';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { hasDate } from './format.mjs';
import { afterUpdate, drawnRuns, FORMAT_MARKS, runMarks, stripRuns, without } from './runs.mjs';
import { DEFAULT_DATE, DEFAULT_TIME } from './types.mjs';
import { fieldsMeta, focusCode } from './view.js';

const FIELD_NODES = new Set(['field', 'fieldBlock']);

/** The fields a command acts on in `state` → [{node, pos}]: the selected ones, else the field at the caret (beside it, node-selected
 * or the fieldBlock around it). A selected fieldBlock stands for the fields inside it: listing those too would make unlink, lock
 * and Shift+F9 act on them twice (unlink would then replace the block over a range its inner edits already changed). */
export function fieldsAt(state) {
  const sel = state.selection;
  if (sel instanceof NodeSelection && FIELD_NODES.has(sel.node.type.name)) return [{ node: sel.node, pos: sel.from }];
  const out = [];
  if (!sel.empty) {
    state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
      if (FIELD_NODES.has(node.type.name)) out.push({ node, pos });
      return !FIELD_NODES.has(node.type.name);
    });
    return out;
  }
  const { $from } = sel;
  for (const [node, pos] of [[$from.nodeAfter, sel.from], [$from.nodeBefore, sel.from - ($from.nodeBefore?.nodeSize ?? 0)]]) {
    if (node?.type.name === 'field') return [{ node, pos }];
  }
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'fieldBlock') return [{ node: $from.node(d), pos: $from.before(d) }];
  return out;
}

/** The range the update covers: the selection when it holds text, else the fields at the caret. */
const rangeOf = (state) => {
  const list = fieldsAt(state);
  if (!list.length) return null;
  const sel = state.selection;
  return sel.empty || sel instanceof NodeSelection
    ? { from: list[0].pos, to: list[list.length - 1].pos + list[list.length - 1].node.nodeSize }
    : { from: sel.from, to: sel.to };
};

/** Sets `locked` on the fields `ctx` acts on, in one step. Locking freezes what the field shows: an open or layout field (DATE,
 * TIME, PAGE) draws a value it never stored, so that drawn value becomes its result in the same step. */
function lock(ctx, locked) {
  const ed = ctx.target;
  if (!ed) return false;
  const { state } = ed;
  const drawn = locked ? drawnOf(ed) : new Map();
  const tr = state.tr;
  for (const { node, pos } of fieldsAt(state)) {
    if (node.attrs.locked === locked) continue;
    const result = drawn.has(pos) ? textOf(drawn.get(pos)) : node.attrs.result;
    // A frozen value other than the result takes the formatting an update would give it (runs.mjs).
    const next = result === node.attrs.result ? null : afterUpdate(node, result ?? '');
    tr.setNodeMarkup(pos, null, { ...node.attrs, locked, result, ...(next && { runs: next.runs }) }, next?.marks ?? node.marks);
  }
  if (tr.docChanged) ed.view.dispatch(closeHistory(tr));
  return true;
}

/** Field `node` at `pos`, unlinked → the nodes that replace it: a field becomes the text it shows (`drawn`, Map pos → FieldResult
 * from drawnOf, else its stored result) with its marks, each of its result runs with its own formatting too (runs.mjs), a
 * fieldBlock its blocks with the fields inside unlinked the same way. */
export function unlinkNodes(node, pos, drawn, schema) {
  if (node.type.name === 'field') {
    const shown = drawn.has(pos) ? textOf(drawn.get(pos)) : node.attrs.result ?? '';
    const runs = shown ? drawnRuns(node.attrs, shown) : null;
    const marks = node.marks.map((m) => m.toJSON());
    if (runs) return runs.map((r) => schema.text(r.text, runMarks(marks, r).map((m) => schema.markFromJSON(m))));
    return shown ? [schema.text(shown, node.marks)] : [];
  }
  const kids = [];
  node.forEach((child, offset) => kids.push(...(child.isText || (child.isLeaf && child.type.name !== 'field')
    ? [child] : unlinkNodes(child, pos + 1 + offset, drawn, schema))));
  return node.type.name === 'fieldBlock' ? kids : [node.copy(Fragment.from(kids))];
}

/** Unlink (Ctrl+6, Ctrl+Shift+F9): each field becomes the text it shows with the field's marks; a fieldBlock unwraps into its
 * blocks with the fields inside unlinked. One undo step. */
function unlink(ctx) {
  const ed = ctx.target;
  if (!ed) return false;
  const { state } = ed;
  const drawn = drawnOf(ed);
  const tr = state.tr;
  // fieldsAt never nests, so the ranges are disjoint and replacing from the end keeps the earlier positions valid.
  for (const { node, pos } of fieldsAt(state).reverse()) tr.replaceWith(pos, pos + node.nodeSize, unlinkNodes(node, pos, drawn, state.schema));
  if (tr.docChanged) ed.view.dispatch(closeHistory(tr));
  return true;
}

/** Node-selects the next (dir 1) or previous (dir -1) field or fieldBlock and scrolls to it (F11, Shift+F11). */
function browse(ctx, dir) {
  const ed = ctx.target;
  if (!ed) return false;
  const { state } = ed;
  const { from, to } = state.selection;
  let hit = null;
  state.doc.descendants((node, pos) => {
    if (dir > 0 && hit) return false;
    if (FIELD_NODES.has(node.type.name)) {
      if (dir > 0 ? pos >= to && !(pos === from && state.selection.node === node) : pos < from) hit = pos;
    }
    return node.type.name !== 'field';
  });
  if (hit == null) return true;
  ed.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, hit)).scrollIntoView());
  ed.view.focus();
  return true;
}

/** Inserts a field with `code` at the target's selection and computes its result now (Alt+Shift+D, T and P). */
function quickField(ctx, code) {
  if (!ctx.target) return false;
  insertField(ctx.target, code);
  return true;
}

/** The Word settings' date and time keys. */
const dateTime = (ctx) => wordSettings(ctx.settings ?? {}).dateTime ?? {};

/** Ctrl+F9: an empty field around the selection, the selected text becoming its code, opened in code view with the caret in the
 * code. */
function insertBraces(ctx) {
  const ed = ctx.target;
  if (!ed?.state.schema.nodes.field) return false;
  const { state } = ed;
  const code = state.selection.empty ? '' : state.doc.textBetween(state.selection.from, state.selection.to, ' ', ' ').trim();
  const pos = insertField(ed, code, { result: null });
  if (pos === false) return false;
  ed.view.dispatch(fieldsMeta(ed.state.tr, { flip: [pos] }));
  focusCode(ed.view, pos);
  return true;
}

/** Opens the Field dialog, for the selected field when one is selected (Edit Field...), and writes its code: a new field at the
 * selection, or the edited field's code and result in one step. */
async function fieldDialog(ctx, arg) {
  const ed = ctx.target;
  if (!ed) return false;
  const sel = ed.state.selection;
  const pos = arg?.pos ?? (sel instanceof NodeSelection && sel.node.type.name === 'field' ? sel.from : null);
  const node = pos == null ? null : ed.state.doc.nodeAt(pos);
  const r = await ctx.dialog('field', node ? { pos, code: node.attrs.code } : {});
  if (!r?.code) return false;
  const { state } = ed;
  const at = pos == null ? null : state.doc.nodeAt(pos);
  if (at?.type.name === 'field') {
    const value = computeField(r.code, ctxAt(baseOf(state, ed.view), pos));
    // The edit updates the field, so its result runs follow the new code's \* MERGEFORMAT as F9's do (runs.mjs).
    const edited = at.type.create({ ...at.attrs, code: r.code }, null, at.marks);
    const next = value == null ? null : afterUpdate(edited, textOf(value));
    ed.view.dispatch(closeHistory(state.tr.setNodeMarkup(pos, null, { ...edited.attrs, result: value == null ? at.attrs.result : textOf(value),
      ...(next && { runs: next.runs }) }, next?.marks ?? at.marks)));
  } else insertField(ed, r.code);
  ed.view.focus();
  return true;
}

/** Opens Date and Time and inserts what it returns: a DATE (or TIME) field, or plain text. */
async function dateTimeDialog(ctx) {
  const ed = ctx.target;
  if (!ed) return false;
  const r = await ctx.dialog('dateAndTime', {});
  if (!r) return false;
  if (r.code) insertField(ed, r.code);
  else if (r.text) ed.chain().focus().insertContent(r.text).run();
  ed.view.focus();
  return true;
}

/** The DATE code Alt+Shift+D and the dialog write for `picture` (TIME for a picture without a date; unverified). */
export const dateCode = (picture) => `${hasDate(picture) ? 'DATE' : 'TIME'} \\@ "${picture}"`;

const target = (ctx) => !!ctx.target;

export const COMMANDS = {
  'fieldsUi.update': {
    enabled: target,
    run: (ctx) => {
      const range = rangeOf(ctx.target.state);
      if (range) updateFields(ctx.target, range, 'manual');
      return true;
    },
  },
  'fieldsUi.toggle': {
    enabled: target,
    run: (ctx) => {
      const ed = ctx.target;
      const list = fieldsAt(ed.state);
      if (list.length) ed.view.dispatch(fieldsMeta(ed.state.tr, { flip: list.map((x) => x.pos) }));
      return true;
    },
  },
  'fieldsUi.toggleAll': {
    active: (ctx) => !!wordSettings(ctx.settings ?? {}).fieldCodes,
    run: (ctx) => {
      saveWord({ fieldCodes: !wordSettings(ctx.settings ?? {}).fieldCodes });
      return true;
    },
  },
  'fieldsUi.insertField': { enabled: target, run: insertBraces },
  'fieldsUi.next': { enabled: target, run: (ctx) => browse(ctx, 1) },
  'fieldsUi.prev': { enabled: target, run: (ctx) => browse(ctx, -1) },
  'fieldsUi.lock': { enabled: target, run: (ctx) => lock(ctx, true) },
  'fieldsUi.unlock': { enabled: target, run: (ctx) => lock(ctx, false) },
  'fieldsUi.unlink': { enabled: target, run: unlink },
  'fieldsUi.doFieldClick': {
    enabled: target,
    run: (ctx) => {
      const ed = ctx.target;
      const [hit] = fieldsAt(ed.state);
      if (!hit || hit.node.type.name !== 'field') return true;
      const f = parseField(hit.node.attrs.code);
      const type = fieldType(f.name);
      if (!type?.click) return true;
      const node = hit.node;
      type.click(f, ctxAt(baseOf(ed.state, ed.view), hit.pos), {
        editor: ed, getPos: () => hit.pos,
        setAttrs: (patch) => ed.view.dispatch(ed.state.tr.setNodeMarkup(hit.pos, null, { ...node.attrs, ...patch }, node.marks)),
      });
      return true;
    },
  },
  'fieldsUi.dateField': { enabled: target, run: (ctx) => quickField(ctx, dateCode(dateTime(ctx).format ?? DEFAULT_DATE)) },
  'fieldsUi.timeField': { enabled: target, run: (ctx) => quickField(ctx, `TIME \\@ "${DEFAULT_TIME}"`) },
  'fieldsUi.pageField': { enabled: target, run: (ctx) => quickField(ctx, 'PAGE') },
  'fieldsUi.dialog': { enabled: target, run: fieldDialog },
  'fieldsUi.shading': {
    value: (ctx) => wordSettings(ctx.settings ?? {}).fieldShading,
    run: (ctx, arg) => {
      if (!['never', 'always', 'selected'].includes(arg)) return false;
      saveWord({ fieldShading: arg });
      return true;
    },
  },
  'insert.text.quickParts.field': { enabled: target, run: (ctx) => fieldDialog(ctx, {}) },
  'headerFooter.insert.documentInfo.field': { enabled: target, run: (ctx) => fieldDialog(ctx, {}) },
  'insert.text.dateTime': { enabled: target, run: dateTimeDialog },
};

/** A formatting mark the transactions `trs` took off a field with result runs reaches the runs too (runs.mjs stripRuns): the second
 * Ctrl+I takes the italic the first gave the whole field, and with it the italic of the run that had it, so the result ends with
 * none, as in Word. Only what the field no longer holds afterwards counts: setMark replacing a textStyle or an underline removes
 * the old mark and adds the new one. Undo and redo carry their own run changes, and tracking's own transactions (an accept or a
 * reject puts a field's old marks back by removing and adding them) never un-format. → the transaction that strips them, or null. */
export function stripRemoved(trs, state) {
  const map = new Mapping();
  const hits = [];
  for (const t of trs) {
    const own = !isHistoryTransaction(t) && t.getMeta('track') == null;
    for (const step of t.steps) {
      map.appendMap(step.getMap());
      if (!own || !(step instanceof RemoveMarkStep || step instanceof RemoveNodeMarkStep) || !FORMAT_MARKS.has(step.mark.type.name)) continue;
      hits.push({ mark: step.mark, from: step.from ?? step.pos, to: step.to ?? step.pos + 1, at: map.maps.length });
    }
  }
  if (!hits.length) return null;
  const tr = state.tr;
  for (const { mark, from, to, at } of hits) {
    const rest = map.slice(at);
    state.doc.nodesBetween(rest.map(from, -1), rest.map(to, 1), (node, pos) => {
      if (node.type.name !== 'field' || !node.attrs.runs) return;
      const now = node.marks.find((m) => m.type === mark.type);
      if (mark.type.name !== 'textStyle') {
        if (!now) stripRuns(tr, pos, pos + node.nodeSize, without([mark.type.name]));
        return;
      }
      const keys = Object.keys(mark.attrs).filter((k) => mark.attrs[k] != null && now?.attrs[k] == null);
      if (keys.length) stripRuns(tr, pos, pos + node.nodeSize, without([], keys));
    });
  }
  return tr.docChanged ? tr : null;
}

/** The editor extension that runs stripRemoved after every transaction. */
export const FieldRunMarks = Extension.create({
  name: 'fieldRunMarks',
  addProseMirrorPlugins: () => [new Plugin({ appendTransaction: (trs, _old, state) => stripRemoved(trs, state) })],
});
