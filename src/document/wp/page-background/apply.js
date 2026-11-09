// Writes the page background: watermarks into the sections' sect (plan.md §1.8 sect.watermark), the page colour, fill and rule
// lines into doc.attrs.background, and Word's displayBackground setting. Every write patches (unknown keys survive) and is one
// undo step. The commands and both dialogs go through these.
import { deepPatch } from '../../../office.mjs';
import { sectionsOf } from '../../model/sections.mjs';
import { watermarkPatch, watermarkSections } from './model.mjs';

/** The 0-based section holding `ed`'s selection. */
export const sectionIndex = (ed) => {
  const list = sectionsOf(ed.state.doc);
  const pos = ed.state.selection.from;
  return Math.max(0, list.findIndex((s) => pos < s.to || s === list.at(-1)));
};

/** The watermark of the selection's section, or null. */
export const watermarkNow = (ed) => (ed ? sectionsOf(ed.state.doc)[sectionIndex(ed)]?.sect.watermark ?? null : null);

/** Whether any section of `ed`'s document has a watermark. */
export const anyWatermark = (ed) => !!ed && sectionsOf(ed.state.doc).some((s) => s.sect.watermark);

/** The theme's body font name, the default watermark font (the probe's Calibri is Word's theme font). */
export const bodyFont = (ed) => ed?.state.doc.attrs.theme?.fonts?.minor ?? 'Aptos';

/** Writes watermark `wm` to the selection's section and every following section whose header is linked; null removes every
 * section's watermark (Remove Watermark, No watermark). → whether it ran. */
export function setWatermark(ed, wm) {
  if (!ed) return false;
  const list = sectionsOf(ed.state.doc);
  const targets = wm ? watermarkSections(list, sectionIndex(ed)) : list.filter((s) => s.sect.watermark).map((s) => s.index);
  if (!targets.length) return false;
  let chain = ed.chain();
  for (const section of targets) chain = chain.setSectionProps(wm ? watermarkPatch(wm) : { watermark: null }, { section });
  return chain.run();
}

/** Patches doc.attrs.background with `patch` (null removes a key; an empty result stores null) and turns displayBackground on,
 * as Word sets w:displayBackgroundShape when a page colour is picked. */
export function setBackground(ed, patch) {
  if (!ed) return false;
  const next = deepPatch(ed.state.doc.attrs.background ?? {}, patch);
  return ed.chain()
    .command(({ tr }) => {
      tr.setDocAttribute('background', Object.keys(next).length ? next : null);
      return true;
    })
    .setDocSettings({ displayBackground: true })
    .run();
}

/** The stored page background, or {}. */
export const backgroundOf = (ed) => ed?.state.doc.attrs.background ?? {};
