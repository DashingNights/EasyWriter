import { Extension, getHTMLFromFragment } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { NodeSelection, Plugin } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { toast } from 'sonner';
import { getState } from './app/store.js';
import { flowSource } from './canvas.js';
import { validFlow } from './flow/library.mjs';
import { drawTheme } from './formats.mjs';
import { rasterizePlanChart } from './plan-chart.js';
import { rasterizeWhiteboard } from './whiteboard.js';

export { draftTitle, wordCount } from './doc-utils.mjs';

/** The picture of `board` (a canvas's or plan chart's attrs plus `kind`) drawn `width` post px wide → {blob, height}. `n`: a
 * plan chart's number in the post. */
export async function boardPicture(board, width, theme, n) {
  if (board.kind === 'canvas') {
    // The artboard is rendered at its own size, at the pixel ratio that gives 2× its drawn size in the document.
    const scale = Math.min(4, Math.max(0.25, (2 * width) / board.w));
    const { blob } = await rasterizeWhiteboard({ height: board.h, bg: board.bg, items: board.items }, { width: board.w, theme, scale });
    return { blob, height: Math.round((width * board.h) / board.w) };
  }
  // A plan chart: laid out at the width the readability rules need, shown at the drawn width (SPEC §6e).
  return rasterizePlanChart(board, { width, theme, n });
}

// Copying (or cutting) a node-selected canvas, plan chart, picture or video also puts its picture on the clipboard (a video:
// the frame shown), next to the HTML the editor pastes back as the block, so other apps paste the picture.
const PICTURED = ['canvas', 'planChart', 'media'];

async function nodePicture(node, dom) {
  if (node.type.name === 'media') {
    const el = dom.querySelector('video, img');
    const c = new OffscreenCanvas(el.videoWidth || el.naturalWidth, el.videoHeight || el.naturalHeight);
    c.getContext('2d').drawImage(el, 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }
  let board = { ...node.attrs, kind: node.type.name };
  const live = board.kind === 'canvas' && validFlow(board.flow) ? await flowSource.load(board.flow.id) : null; // as push draws it
  if (live) board = { ...board, ...live.board };
  return (await boardPicture(board, dom.offsetWidth, drawTheme(getState().draft, getState().settings), 1)).blob; // as drawn
}

export const CopyPicture = Extension.create({
  name: 'copyPicture',
  addProseMirrorPlugins() {
    // Before ProseMirror's own copy (a cut deletes the block); it still fills the event's clipboard, which this write replaces.
    const copy = (view) => {
      const sel = view.state.selection;
      if (!(sel instanceof NodeSelection) || !PICTURED.includes(sel.node.type.name)) return false;
      const html = getHTMLFromFragment(Fragment.from(sel.node), view.state.schema);
      const picture = nodePicture(sel.node, view.nodeDOM(sel.from));
      navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'image/png': picture })])
        .catch((e) => toast.error(`Could not copy the picture: ${e.message || e}`));
      return false;
    };
    return [new Plugin({ props: { handleDOMEvents: { copy, cut: copy } } })];
  },
});

/** The drawn width of each column of the `table` node at `pos` (the first row's cells; one spanning columns splits evenly),
 * or null when the table is not drawn. */
export function drawnColumnWidths(view, table, pos) {
  const map = TableMap.get(table);
  const widths = [];
  for (let col = 0; col < map.width; col++) {
    const { left, right } = map.findCell(map.map[col]);
    widths.push(Math.round((view.nodeDOM(pos + 1 + map.map[col])?.offsetWidth ?? 0) / (right - left)));
  }
  return widths.every(Boolean) ? widths : null;
}

/** Adds to `tr` every cell of the `table` node at `pos` taking its columns' `widths` (attrs only: no position moves). */
export function setColumnWidths(tr, table, pos, widths) {
  const map = TableMap.get(table);
  for (const rel of new Set(map.map)) {
    const { left, right } = map.findCell(rel);
    tr.setNodeMarkup(pos + 1 + rel, null, { ...table.nodeAt(rel).attrs, colwidth: widths.slice(left, right) });
  }
  return tr;
}
