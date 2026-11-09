// Edits shared by layout-misc's commands and dialogs: line numbers per section, the drop cap of the selection's paragraph.
import { sectionAt, sectionsOf } from '../../model/sections.mjs';
import { ensureStyles } from '../../model/styles.mjs';
import { dropCapPatch, patchFrame } from './logic.mjs';

/** Runs `fn(tr)` on the main editor in one transaction (one undo step) → true; false without a Document. */
export const edit = (ctx, fn) => !!ctx.ed && ctx.ed.chain().focus().command(({ tr }) => fn(tr) !== false).run();

/** The indices of the sections the selection of `tr` touches. */
function touched(tr) {
  const secs = sectionsOf(tr.doc);
  const { from, to } = tr.selection;
  const a = sectionAt(secs, from).index;
  const b = sectionAt(secs, to > from ? to - 1 : to).index;
  return secs.slice(a, b + 1).map((s) => s.index);
}

// Word's Line Number character style, which the margin numbers are drawn in (added on first use).
const LN_STYLE = { LineNumber: { type: 'character', name: 'Line Number', semiHidden: true, unhideWhenUsed: true, uiPriority: 99, run: {} } };

/** Sets each listed section's lnNum to fn(old lnNum) (sections the selection touches, or `section`) in one undo step. */
export function setLineNumbers(ctx, fn, section) {
  return edit(ctx, (tr) => {
    const list = section != null ? [section] : touched(tr);
    for (const i of list) {
      const secs = sectionsOf(tr.doc);
      const sec = secs[i];
      if (!sec) continue;
      const next = fn(sec.sect.lnNum);
      if (JSON.stringify(next) === JSON.stringify(sec.sect.lnNum)) continue;
      // The sect is its break's, or doc.attrs.sect for the last section; a patch keeps keys a newer build wrote (plan.md §1.8).
      const raw = sec.holder == null ? tr.doc.attrs.sect : tr.doc.nodeAt(sec.holder).attrs.sect;
      const sect = { ...(raw ?? {}), lnNum: next && raw?.lnNum ? { ...raw.lnNum, ...next } : next };
      if (sec.holder == null) tr.setDocAttribute('sect', sect);
      else tr.setNodeAttribute(sec.holder, 'sect', sect);
    }
    const styles = ensureStyles(tr.doc, LN_STYLE);
    if (styles && sectionsOf(tr.doc).some((s) => s.sect.lnNum)) tr.setDocAttribute('styles', styles);
  });
}

/** The paragraph holding the selection's start. */
export const paraOf = (state) => state?.selection.$from.parent ?? null;

/** The drop cap of the selection's paragraph → {position, lines, distance, font}. */
export function dropCapOf(state) {
  const p = paraOf(state);
  const f = p?.attrs.frame;
  const ts = p?.firstChild?.marks.find((m) => m.type.name === 'textStyle');
  return { position: f?.dropCap ?? 'none', lines: f?.lines ?? 3, distance: f?.hSpace ?? 0, font: f?.dropCap ? ts?.attrs.fontFamily ?? '' : '' };
}

/** Applies Drop Cap values ({position, lines, distance, font: '' = +Body}) to the selection's paragraph in one undo step. */
export function applyDropCap(ed, v) {
  if (!ed) return false;
  return ed.chain().focus().command(({ tr }) => {
    const { $from } = tr.selection;
    const node = $from.parent;
    if (!node.isTextblock || !node.content.size) return false;
    const pos = $from.before($from.depth);
    tr.setNodeAttribute(pos, 'frame', patchFrame(node.attrs.frame, dropCapPatch(v)));
    const ts = tr.doc.type.schema.marks.textStyle;
    if (v.font && v.position !== 'none' && ts && node.firstChild?.isText) {
      const old = ts.isInSet(node.firstChild.marks)?.attrs ?? {};
      tr.addMark(pos + 1, pos + 2, ts.create({ ...old, fontFamily: v.font }));
    }
    return true;
  }).run();
}
