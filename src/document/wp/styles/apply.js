// The styles work package against the editor (docs/plans/word/plan.md §3 styles): reading the selection's style and formatting,
// applying paragraph, character and linked styles, writing the styles attribute, and the update and prompt flows. The decisions
// themselves are in model.mjs; this file only reads and writes ProseMirror state.
import { closeHistory } from '@tiptap/pm/history';
import { deepPatch } from '../../../office.mjs';
import { styleIdOf } from '../../model/styles.mjs';
import { charRun, resolved } from '../../stylesheet.js';
import { ctxOf } from '../../../tooling/registry.js';
import {
  CHAR_STYLES, charHalfOf, formattingOf, linkedParaOf, linkedPart, matchedStyle, needs, PARA_KEYS, patchStyle, usage, withStyle,
} from './model.mjs';

const RUN_MARKS = ['bold', 'italic', 'underline', 'strike', 'subscript', 'superscript'];

/** The styles attribute of `state`'s document. */
export const stylesOf = (state) => state?.doc.attrs.styles ?? {};

/** The paragraphs and headings the selection of `state` touches → [{node, pos, from, to}] (from and to: their text). */
export function blocksOf(state) {
  const out = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name === 'paragraph' || node.type.name === 'heading') out.push({ node, pos, from: pos + 1, to: pos + 1 + node.content.size });
    return false;
  });
  return out;
}

/** The marks at the start of `state`'s selection (the caret's stored marks). */
function marksAt(state) {
  const { $from, empty } = state.selection;
  return empty ? state.storedMarks ?? $from.marks() : state.doc.resolve(Math.min($from.pos + 1, $from.end())).marks();
}

/** The character style at the start of `state`'s selection, or null. */
const charStyleAt = (state) => marksAt(state).find((m) => m.type.name === 'textStyle')?.attrs.charStyle ?? null;

/** The current style of `state`'s selection: a character style at its start (a linked half shows as its paragraph style, as
 * Word's gallery does), else the paragraph's style. */
export function currentStyle(state) {
  if (!state) return null;
  const cs = charStyleAt(state);
  if (cs) return linkedParaOf(stylesOf(state).list ?? {}, cs) ?? cs;
  const { $from } = state.selection;
  return $from.parent.isTextblock ? styleIdOf($from.parent) : null;
}

const counts = new WeakMap(); // doc → usage counts

/** How often `doc` uses each style ({[styleId]: n}: paragraphs and runs), memoised per doc. */
export function usageOf(doc) {
  if (!counts.has(doc)) {
    const blocks = [];
    doc.descendants((node) => {
      if (!node.isTextblock) return true;
      const chars = [];
      node.forEach((child) => chars.push(child.marks.find((m) => m.type.name === 'textStyle')?.attrs.charStyle ?? null));
      blocks.push({ styleId: styleIdOf(node), chars });
      return false;
    });
    counts.set(doc, usage(blocks));
  }
  return counts.get(doc);
}

/** The direct formatting of `state`'s selection → {run, para}: its first run's marks (the caret's stored marks) and the first
 * paragraph's own attributes. */
export function selectionFormatting(state) {
  const block = blocksOf(state)[0]?.node ?? state.selection.$from.parent;
  return formattingOf(marksAt(state).map((m) => ({ type: m.type.name, attrs: m.attrs })), block.attrs ?? {});
}

/** Whether `state`'s selected paragraphs carry direct formatting: their own paragraph attributes or a run mark with a value. */
export function hasDirect(state) {
  return blocksOf(state).some(({ node }) => PARA_KEYS.some((k) => node.attrs[k] != null) || (() => {
    let found = false;
    node.forEach((child) => {
      found ||= child.marks.some((m) => RUN_MARKS.includes(m.type.name)
        || (m.type.name === 'textStyle' && Object.entries(m.attrs).some(([k, v]) => k !== 'charStyle' && v != null)));
    });
    return found;
  })());
}

/** Writes styles attribute `next` into the target editor of `ctx` in one step (meant to be chained before an apply). */
const setStylesStep = (next) => ({ tr }) => {
  if (next) tr.setDocAttribute('styles', next);
  return true;
};

/** The styles of `list` after adding `add` and applying `patch` ({[id]: patch}) to `styles`. */
function prepared(styles, { add, patch }) {
  let next = add ? { ...styles, list: { ...styles.list, ...add } } : styles;
  for (const [id, p] of Object.entries(patch ?? {})) next = withStyle(next, id, p);
  return next === styles ? null : next;
}

/** The word around the caret of `state` → {from, to}, or null when the caret is not inside a word (Word applies a character
 * style to that word). */
function wordAt(state) {
  const { $from } = state.selection;
  const text = $from.parent.textBetween(0, $from.parent.content.size, '\0', '\0');
  const at = $from.parentOffset;
  const w = /[\p{L}\p{N}_'’]/u;
  if (!w.test(text[at - 1] ?? '') || !w.test(text[at] ?? '')) return null;
  let a = at;
  let b = at;
  while (a > 0 && w.test(text[a - 1])) a--;
  while (b < text.length && w.test(text[b])) b++;
  const start = $from.start();
  return { from: start + a, to: start + b };
}

/** Applies character style `id` to the selection of `ctx` (the word at a caret inside one), first adding what `n` needs. */
function applyChar(ctx, id, n) {
  const next = prepared(stylesOf(ctx.state), n);
  const word = ctx.state.selection.empty ? wordAt(ctx.state) : null;
  const caret = ctx.state.selection.from;
  return ctx.chain((c) => {
    let ch = c.command(setStylesStep(next));
    if (word) ch = ch.setTextSelection(word);
    ch = ch.setRunProps({ charStyle: id });
    return word ? ch.setTextSelection(caret) : ch;
  });
}

/** Applies style `id` of the active document to the selection of `ctx` (the Styles gallery, a style's shortcut key): a paragraph
 * style through setStyle, a character style as the runs' charStyle, a linked style's character half on part of one paragraph
 * (linkedPart). Reapplying a paragraph style over direct formatting asks first while Options' Prompt to update style is on. */
export function applyStyle(ctx, id) {
  const { state } = ctx;
  if (!state || !id) return false;
  const list = stylesOf(state).list ?? {};
  const def = list[id] ?? CHAR_STYLES[id];
  if (!def) return false;
  if (def.type === 'character') return applyChar(ctx, id, needs(list, id));
  if (def.type !== 'paragraph') return false;
  const blocks = blocksOf(state);
  const sel = { empty: state.selection.empty, from: state.selection.from, to: state.selection.to, blocks };
  if (charHalfOf(list, id) && linkedPart(sel, ctx.settings?.word?.stylesPane?.noLinked) === 'char') {
    const n = needs(list, id, true);
    return applyChar(ctx, charHalfOf({ ...list, ...n.add, [id]: { ...list[id], ...n.patch?.[id] } }, id), n);
  }
  const again = blocks.length && blocks.every((b) => styleIdOf(b.node) === id);
  if (again && ctx.settings?.word?.editing?.promptUpdateStyle && hasDirect(state)) {
    promptUpdate(ctx, id);
    return true;
  }
  return ctx.chain((c) => c.setStyle(id));
}

/** Word's question on reapplying a style over direct formatting: update the style from the selection, or reapply the style. */
async function promptUpdate(ctx, id) {
  const r = await ctx.dialog('styleUpdatePrompt', { styleId: id });
  if (!r) return;
  const now = ctxOf();
  if (r.choice === 'update') updateToMatch(now, id, r.auto ? { autoRedefine: true } : null);
  else {
    clearDirect(now);
    if (r.auto) writeStyle(ctxOf(), id, { autoRedefine: true });
  }
}

/** Removes the selection's direct formatting in `ctx`: the keys of `fmt` ({run, para}) when given, else all of it. A caret
 * covers its whole paragraph. */
export function clearDirect(ctx, fmt = null) {
  const { state } = ctx;
  const blocks = blocksOf(state);
  if (!blocks.length) return false;
  const range = state.selection.empty ? { from: blocks[0].from, to: blocks.at(-1).to } : { from: state.selection.from, to: state.selection.to };
  const runKeys = fmt ? Object.keys(fmt.run ?? {}) : null;
  const paraKeys = fmt ? Object.keys(fmt.para ?? {}).filter((k) => PARA_KEYS.includes(k)) : PARA_KEYS;
  const textStyle = state.schema.marks.textStyle;
  return ctx.chain((c) => c.command(({ tr }) => {
    for (const name of RUN_MARKS) if (!runKeys || runKeys.includes(name)) tr.removeMark(range.from, range.to, state.schema.marks[name]);
    // textStyle: every key but charStyle (a character style is not direct formatting), or the keys of fmt.
    state.doc.nodesBetween(range.from, range.to, (node, pos) => {
      const m = node.isInline && textStyle.isInSet(node.marks);
      if (!m) return true;
      const attrs = Object.fromEntries(Object.entries(m.attrs).map(([k, v]) => [k, k !== 'charStyle' && (!runKeys || runKeys.includes(k)) ? null : v]));
      const a = Math.max(range.from, pos);
      const b = Math.min(range.to, pos + node.nodeSize);
      tr.removeMark(a, b, textStyle);
      if (Object.values(attrs).some((v) => v != null)) tr.addMark(a, b, textStyle.create(attrs));
      return true;
    });
    for (const { node, pos } of blocks) for (const k of paraKeys) if (node.attrs[k] != null) tr.setNodeAttribute(pos, k, null);
    return true;
  }));
}

/** Patches style `id` of the target document of `ctx` with `patch` (whole keys), adding a quick character style first if the
 * document lacks it. → whether it wrote. */
export function writeStyle(ctx, id, patch) {
  const styles = stylesOf(ctx.state);
  const base = styles.list?.[id] ? styles : prepared(styles, needs(styles.list ?? {}, id)) ?? styles;
  if (!base.list?.[id]) return false;
  return ctx.chain((c) => c.command(setStylesStep(withStyle(base, id, patch))));
}

/** Writes the whole styles attribute `next` into the target of `ctx` as one undo step. */
export const setStyles = (ctx, next) => ctx.chain((c) => c.command(({ tr }) => {
  closeHistory(tr);
  tr.setDocAttribute('styles', next);
  return true;
}));

/** Update <style> to Match Selection. When the selection already has style `id`, the style takes its direct formatting (a
 * character style only the run part). Otherwise the style takes the selection's effective formatting (its paragraph style,
 * character style and direct formatting) and the selection then takes the style, as Word does. Either way the direct formatting
 * leaves the selection, all in one undo step, and the style takes `extra` keys. A linked style's character half keeps the same run. */
export function updateToMatch(ctx, id, extra = null) {
  const { state } = ctx;
  const styles = stylesOf(state);
  const base = styles.list?.[id] ? styles : prepared(styles, needs(styles.list ?? {}, id)) ?? styles;
  const list = base.list ?? {};
  const old = list[id];
  if (!old) return false;
  const fmt = selectionFormatting(state);
  const char = old.type === 'character';
  if (char) fmt.para = {};
  const cs = charStyleAt(state);
  const pid = styleIdOf(blocksOf(state)[0]?.node ?? state.selection.$from.parent);
  const has = char ? cs === id : pid === id || linkedParaOf(list, cs) === id;
  let def;
  if (has) def = patchStyle(old, fmt);
  else {
    const csRun = cs ? charRun(list, cs) : {};
    const d = base.defaults ?? {};
    const under = (sid) => { // a style's chain over the document defaults, without resolved's v1 align mirror
      const r = sid ? resolved(list, sid) : {};
      const { align, ...para } = deepPatch(d.para ?? {}, r.para ?? {});
      return { run: deepPatch(d.run ?? {}, r.run ?? {}), para };
    };
    const sel = under(pid);
    def = char ? matchedStyle(old, { run: { ...csRun, ...fmt.run } }, { run: {} })
      : matchedStyle(old, { run: { ...sel.run, ...csRun, ...fmt.run }, para: deepPatch(sel.para, fmt.para) }, under(old.basedOn));
  }
  // The whole definition, so v2 names replace v1's (patchStyle and matchedStyle keep every other key).
  let next = { ...base, list: { ...list, [id]: { ...def, ...extra } } };
  const half = charHalfOf(next.list, id);
  if (half && next.list[half]) next = withStyle(next, half, { run: next.list[id].run });
  setStyles(ctx, next);
  clearDirect(ctxOf(), fmt);
  return has || applyStyle(ctxOf(), id);
}
