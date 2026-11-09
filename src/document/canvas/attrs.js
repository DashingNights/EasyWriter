// A canvas draft's document attributes in the DOM editor's form, so the commands that save or edit a whole definition (Set as
// Default, a style set, Save Current Theme) work on both editors with the same dialogs and the same saved form. The styles and
// the theme come from the engine's queries (styles.get's whole sheet and document.settings, converted by styles/engine.mjs),
// not from a .docx of the whole document (docs/plans/engine/stage2b.md, engine-gaps-styles).
import { getState } from '../../app/store.js';
import { readWordFile } from '../docx/reader.js';
import { stylesOfSheet, themeOfSettings } from '../wp/styles/engine.mjs';

/** The attributes ({styles, theme}) of ctx's Document: the DOM editor's, or the canvas draft's from the engine. */
export async function docAttrs(ctx) {
  if (!ctx.engine) return ctx.ed?.state.doc.attrs ?? null;
  const [sheet, settings] = await Promise.all([ctx.engine.exec('styles.get', {}), ctx.engine.exec('document.settings', {})]);
  const styles = stylesOfSheet(sheet?.value);
  return styles ? { styles, theme: themeOfSettings(settings?.value) } : null;
}

/** docAttrs through a .docx the engine writes: the table styles' parts in the DOM editor's form, which the engine's sheet does
 * not give (table-design's Modify Table Style). */
// ponytail: saves the whole document once per Modify Table Style; convert the engine's table style parts when that shows.
export async function docxAttrs(ctx) {
  if (!ctx.engine) return ctx.ed?.state.doc.attrs ?? null;
  const bytes = await ctx.engine.save('docx');
  const { doc } = await readWordFile('Document.docx', bytes, { settings: getState().settings });
  return doc?.attrs ?? null;
}
