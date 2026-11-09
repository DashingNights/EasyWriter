// What the style panes and their dialogs do to the document (docs/plans/word briefs/style-panes.md): apply a style (through
// styles' command once it merges, else setStyle and setRunProps), select and restyle every instance, read the formatting at the
// selection in layers (defaults, style, character style, direct), and write style list changes as one undoable step.
import { openDialog } from '../../../app/actions.js';
import { REASONS } from '../../../tooling/reasons.mjs';
import { commandOf, ownerOf } from '../../../tooling/registry.js';
import { styleIdOf } from '../../model/styles.mjs';
import {
  DEFAULT_FONT, directPara, infoOf, instancesOf, isBuiltIn, kindOf, layered, nameOf, paraV2, resolvedPara, resolvedRun, runV2, withoutStyle,
} from './model.mjs';

/** Opens dialog `id` with `props` through ctx.dialog, or toasts the pending reason while no package registers it (an unknown id
 * would leave an empty entry on the dialog stack). → the dialog's result, or null. */
export async function openDlg(ctx, id, props) {
  // On a canvas draft the style dialogs and the property dialogs open through their canvas rows, which read the engine first.
  if (ctx.engine && CANVAS_ROWS[id]) return ctx.run(CANVAS_ROWS[id], props?.styleId);
  const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js'); // at call time: the dialog registry imports every module
  if (!WORD_DIALOGS[id]) {
    ctx.toast(REASONS.pending);
    return null;
  }
  return ctx.dialog(id, props);
}
const CANVAS_ROWS = { modifyStyle: 'styles.modify', createNewStyleFromFormatting: 'home.styles.styles.createAStyle', font: 'home.font.launcher',
  paragraph: 'home.paragraph.launcher', defineNewNumberFormat: 'home.paragraph.numbering.defineNewNumberFormat' };

const multi = (ed) => ed.state.selection.ranges.length > 1;

/** The ranges of `selection` → [{from, to}]. */
const rangesOf = (selection) => selection.ranges.map((r) => ({ from: r.$from.pos, to: r.$to.pos }));

/** Runs `step(chain, range)` for each range of `ctx`'s multi-range selection in one transaction (one undo step), then selects the
 * same ranges again through editing-keys' x.selection.multi. Commands such as setStyle read only from and to, so each range gets
 * its own pass; the ranges keep their positions because the steps change only node markup and marks. → whether it ran. */
function applyToRanges(ctx, step) {
  const ranges = rangesOf(ctx.target.state.selection);
  let c = ctx.target.chain().focus(undefined, { scrollIntoView: false });
  for (const r of ranges) c = step(c.setTextSelection(r), r);
  const ok = c.run();
  if (ok) ctx.run('x.selection.multi', ranges);
  return ok;
}

/** Whether the selection covers part of one paragraph's text (a linked style then applies as its character style). */
function partOfParagraph(state) {
  const { from, to, $from, $to, empty } = state.selection;
  return !empty && $from.sameParent($to) && (from > $from.start() || to < $from.end());
}

/** Applies style `id` ('clear' for Clear All) to the selection of `ctx`'s target: every range of a multi-range selection in one
 * step. A character style (or a linked one on part of a paragraph, unless Disable Linked Styles is on) goes on the runs. */
export function applyStyle(ctx, id) {
  const ed = ctx.target;
  if (!ed) return false;
  if (id === 'clear') return multi(ed) ? applyToRanges(ctx, (c) => c.clearFormatting()) : ctx.run('home.styles.styles.clearFormatting');
  const list = ed.state.doc.attrs.styles?.list ?? {};
  const s = infoOf(id, list[id] ?? (id === DEFAULT_FONT.id ? DEFAULT_FONT : undefined));
  const kind = kindOf(s, { noLinked: ctx.settings?.word?.stylesPane?.noLinked });
  const charStyle = kind === 'character' ? (id === DEFAULT_FONT.id ? null : id) : kind === 'linked' && partOfParagraph(ed.state) ? s.link : undefined;
  if (multi(ed)) return applyToRanges(ctx, (c) => (charStyle !== undefined ? c.setRunProps({ charStyle }) : c.setStyle(id)));
  // styles' command handles character and linked styles itself once it merges; base's knows paragraph styles only.
  if (commandOf('home.styles.styles') && ownerOf('home.styles.styles') !== 'base') return ctx.run('home.styles.styles', id);
  if (charStyle !== undefined) return ctx.chain((c) => c.setRunProps({ charStyle }));
  return ctx.run('home.styles.styles', id);
}

/** Selects every instance of style `id` in `ctx`'s target as one selection (editing-keys' x.selection.multi). → the number of
 * ranges, 0 when the style is not used. */
export function selectInstances(ctx, id) {
  const ed = ctx.target;
  if (!ed) return 0;
  const ranges = instancesOf(ed.state.doc, id);
  if (!ranges.length) {
    ctx.toast('No text uses this style.');
    return 0;
  }
  ed.commands.focus(undefined, { scrollIntoView: false });
  ctx.run('x.selection.multi', ranges);
  return ranges.length;
}

/** Clear Formatting of n Instance(s): every instance of `id` back to Normal (a character style's runs lose it), in one step. */
export function clearInstances(ctx, id) {
  if (!selectInstances(ctx, id)) return false;
  const kind = kindOf(infoOf(id, ctx.target.state.doc.attrs.styles?.list?.[id]));
  return applyToRanges(ctx, (c) => (kind === 'character' ? c.setRunProps({ charStyle: null }) : c.setStyle('Normal')));
}

/** Writes `styles` (a whole doc.attrs.styles built by patching the current one) into `ed` as one undoable step. */
export const writeStyles = (ed, styles) => ed.chain().command(({ tr }) => {
  tr.setDocAttribute('styles', styles);
  return true;
}).run();

/** Asks `text` in the kit's styleQuestion box (Yes and Cancel), stacked over any open dialog. → whether Yes was pressed. */
export const askStyle = async (text) => !!(await openDialog('styleQuestion', { text }));

/** The node type and attributes a paragraph or heading takes when it is set to paragraph style `id`, as setStyle builds them:
 * Heading 1 to 6 are heading nodes, everything else a paragraph (Normal with no styleId). */
function restyled(schema, attrs, id) {
  const level = /^Heading([1-6])$/.exec(id ?? '')?.[1];
  if (level) return [schema.nodes.heading, { ...attrs, level: Number(level), styleId: null }];
  return [schema.nodes.paragraph, { ...attrs, styleId: !id || id === 'Normal' ? null : id }];
}

/** Delete <name>...: asks, then removes style `id` from `ed`'s document in one step; its paragraphs take its base style and its
 * runs lose it, as Word does. Built-in styles cannot be deleted. → whether it was deleted. */
export async function deleteStyle(ed, id) {
  const styles = ed?.state.doc.attrs.styles;
  if (!ed || isBuiltIn(id) || !styles?.list?.[id]) return false;
  const name = nameOf(infoOf(id, styles.list[id]));
  if (!(await askStyle(`Do you want to delete style ${name}?`))) return false;
  // A canvas draft's stand-in (canvas-ed.mjs): the engine restyles the paragraphs and runs itself (styles.delete).
  if (ed.engine) return writeStyles(ed, withoutStyle(styles, id));
  const heir = styles.list[id].basedOn ?? null;
  const runs = [];
  return ed.chain().command(({ tr }) => {
    tr.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      if (node.type.name === 'paragraph' && node.attrs.styleId === id) {
        const [type, attrs] = restyled(tr.doc.type.schema, node.attrs, heir);
        tr.setNodeMarkup(pos, type, attrs);
      }
      return false;
    });
    // The paragraphs no longer hold the style, so what is left are its character runs.
    runs.push(...instancesOf(tr.doc, id).filter((r) => r.to > r.from));
    tr.setDocAttribute('styles', withoutStyle(styles, id));
    return true;
  }).command(({ tr }) => {
    const type = tr.doc.type.schema.marks.textStyle;
    for (const r of runs) {
      tr.doc.nodesBetween(r.from, r.to, (node, pos) => {
        const m = node.isText && type.isInSet(node.marks);
        if (m?.attrs.charStyle === id) tr.addMark(Math.max(pos, r.from), Math.min(pos + node.nodeSize, r.to), type.create({ ...m.attrs, charStyle: null }));
      });
    }
    return true;
  }).run();
}

const MARK_PROPS = { bold: () => true, italic: () => true, strike: () => true, subscript: () => true, superscript: () => true, underline: (a) => ({ val: a.val ?? 'single', color: a.color ?? null }) };

/** The marks the selection of `state` formats with: stored marks, the caret's, else the first text's in the selection. */
function marksAt(state) {
  const { empty, $from, from, to } = state.selection;
  if (state.storedMarks) return state.storedMarks;
  if (empty) return $from.marks();
  let marks = null;
  state.doc.nodesBetween(from, to, (n) => {
    if (!marks && n.isText) marks = n.marks;
    return !marks;
  });
  return marks ?? $from.marks();
}

/** The formatting at the selection of `state` in layers: {styleId, charStyle, run: {props, src}, para: {props, src}, list,
 * paraNode, directRun}; src names the layer that set each key ('default', 'style', 'charStyle' or 'direct'). */
export function formatAt(state) {
  const { doc, selection } = state;
  const styles = doc.attrs.styles ?? {};
  const node = selection.$from.parent.isTextblock ? selection.$from.parent : null;
  const styleId = node ? styleIdOf(node) : 'Normal';
  const directRun = {};
  let charStyle = null;
  for (const m of marksAt(state)) {
    if (m.type.name === 'textStyle') {
      const { charStyle: cs, ...rest } = m.attrs;
      charStyle = cs ?? null;
      for (const [k, v] of Object.entries(rest)) if (v != null) directRun[k] = v;
    } else if (MARK_PROPS[m.type.name]) directRun[m.type.name] = MARK_PROPS[m.type.name](m.attrs);
  }
  const run = layered([['default', runV2(styles.defaults?.run)], ['style', resolvedRun(styles, styleId)],
    ['charStyle', charStyle && resolvedRun(styles, charStyle)], ['direct', directRun]]);
  const directP = node ? directPara(node.attrs) : {};
  const para = layered([['default', paraV2(styles.defaults?.para)], ['style', resolvedPara(styles, styleId)], ['direct', directP]]);
  const num = node?.attrs.numbering;
  const abs = num && doc.attrs.numbering?.abstract?.[doc.attrs.numbering?.nums?.[num.numId]?.abstract];
  const list = num ? { numId: num.numId, ilvl: num.ilvl ?? 0, fmt: abs?.levels?.[num.ilvl ?? 0]?.fmt ?? null } : null;
  return { styleId, charStyle, run, para, list, directRun, directPara: directP };
}

/** The text of the selection of `state` for a sample, at most `max` characters; the word at a caret. */
export function sampleText(state, max = 40) {
  const { empty, from, to, $from } = state.selection;
  if (!empty) return state.doc.textBetween(from, to, ' ').slice(0, max);
  const text = $from.parent.textContent;
  const at = $from.parentOffset;
  const start = text.slice(0, at).search(/\S+$/);
  const end = text.slice(at).search(/\s|$/);
  return text.slice(start < 0 ? at : start, at + end).slice(0, max);
}