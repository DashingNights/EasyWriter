// The views on a canvas draft (docs/plans/engine/stage2b.md, engine-gaps-views): which engine view shows each store view, and
// the room each continuous view flows to (the engine's view.window) from the page area's size and zoom. Read Mode's screen pages
// are columns with the engine's 18 pt reflow margins, so two pages side by side are READ_GAP apart in text. Pure: node tests
// load it.
import { IMMERSIVE_WIDTHS, readColumns } from './views.mjs';

const PX_PER_PT = 4 / 3;
const MARGINS = 36; // pt: the engine's reflow page puts 18 pt either side of the text
export const PAD = 24; // px the page area keeps round its pages (canvas/layout.mjs PAD)
export const READ_BAR = 32; // px: Read Mode's top bar, over the page area
export const SIDE_BAR = 32; // px: Side to Side's Thumbnails bar, over the page area
export const READ_GAP = 48; // px between Read Mode's columns of text, as the DOM Reader's (the margins make it)
const READ_PAD = 32; // px round Read Mode's text, as the DOM Reader's
const ARROWS = 64; // px Read Mode's previous and next buttons take beside the text
// ponytail: the Reader's widths are in ch of 11 pt text (a digit is about 5.5 pt) and Read Mode's Paper Layout a Letter page's
// 6.5 in of text; the engine's own text width per section if a document looks off.
export const CH_PT = 5.5;
const PAPER_PX = 624;

/** The mounted canvas page area's input handle (engine/input/viewport.js inputOnViewport's), whose `input` has the caret: Side to
 * Side opens at the caret's page. The page area sets it. */
export const pageInput = { current: null };

/** The caret of the canvas page area's draft ({page, x, y, h} in points), or null. */
export const canvasCaret = () => pageInput.current?.input?.snapshot()?.caret ?? null;

/** The engine command and its arguments that show store view `view` ('print', 'outline', 'web', 'draft', 'read', 'immersive',
 * 'focus'): Focus shows Print Layout. */
export function engineView(view) {
  if (view === 'immersive') return ['view.immersiveReader', { value: true }];
  const id = { outline: 'view.outline', web: 'view.webLayout', draft: 'view.draft', read: 'view.readMode' }[view] ?? 'view.printLayout';
  return [id, {}];
}

/** Whether store view `view` shows the engine's continuous layout (one surface as wide as the room it is given). */
export const flows = (view) => view === 'web' || view === 'draft' || view === 'immersive';

/** Read Mode's columns for a page area `size` ({w, h} px) at Read Mode's settings `opts` ({columnWidth, layout}): how many a
 * screen shows and each one's page in points, margins included → {count, w, h}. Read Mode shows at 100 %. */
export function readPages(size, opts = {}) {
  const W = Math.max(100, size.w - 2 * READ_PAD - ARROWS);
  const H = Math.max(100, size.h - READ_BAR - 2 * READ_PAD);
  const cols = readColumns(W, opts.columnWidth, READ_GAP, opts.layout === 'paper' ? PAPER_PX : null);
  return { count: cols.count, w: cols.width / PX_PER_PT + MARGINS, h: H / PX_PER_PT };
}

/** view.window's arguments for a page area `size` ({w, h} px) at `zoom` (1 = 100 %) and the Word settings `word`: Web Layout's
 * window, Read Mode's screen pages, the Reader's column (null keeps the page's text width) and Draft's wrap to window. */
export function windowOf(size, zoom, word) {
  const r = readPages(size, word.readMode);
  const ch = IMMERSIVE_WIDTHS[word.immersive?.columnWidth];
  const round = (n) => Math.round(n * 100) / 100;
  return {
    web: round(Math.max(144, (size.w - 2 * PAD) / (zoom * PX_PER_PT))),
    read: [round(r.w), round(r.h)],
    reader: ch ? ch * CH_PT + MARGINS : null,
    wrap: !!word.display?.wrapToWindow,
  };
}

/** The Reader settings the engine follows in store view `view`: Read Mode's or Immersive Reader's page colour, text spacing and
 * syllables; in any other view none of them shows. */
export function readerOf(view, word) {
  const o = view === 'read' ? word.readMode : view === 'immersive' ? word.immersive : null;
  return { pageColor: o?.pageColor ?? 'none', spacing: !!o?.textSpacing, syllables: !!o?.syllables };
}
