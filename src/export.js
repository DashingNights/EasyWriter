import { Extension, generateHTML, getHTMLFromFragment } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { NodeSelection, Plugin } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { toast } from 'sonner';
import { getState } from './app/store.js';
import { flowSource } from './canvas.js';
import { validFlow } from './flow/library.mjs';
import { rasterizePlanChart } from './plan-chart.js';
import { rasterizeWhiteboard, WB_BG } from './whiteboard.js';
import { applyBaseStyles, replaceWhiteboards } from './doc-utils.mjs';

export { applyBaseStyles, replaceWhiteboards, draftTitle, wordCount } from './doc-utils.mjs';

// Forum limit is 20 MiB; stay below it with some headroom.
const MAX_PNG_BYTES = 19 * 1024 * 1024;

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// JPEG has no alpha: paint the post background under transparent areas so they match the forum.
async function toJpeg(blob, theme) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = WB_BG.post[theme] ?? WB_BG.post.dark;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
}

/** The picture of `board` (a canvas's or plan chart's attrs plus `kind`) drawn `width` post px wide → {blob, height}. `n`: a
 * plan chart's number in the post. */
async function boardPicture(board, width, theme, n) {
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
  return (await boardPicture(board, dom.offsetWidth, getState().settings.theme, 1)).blob;
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

/** The document JSON with every table cell's `colwidth` set to its columns' drawn widths. The forum lays tables out fixed at
 * the widths they carry (SPEC §1), so a table with none would shrink to its minimum. A table not drawn keeps its own. */
function sizedTablesJSON(editor) {
  const { state, view } = editor;
  const tr = state.tr; // never dispatched
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    const map = TableMap.get(node);
    const cellAt = (rel) => ({ ...map.findCell(rel), cell: node.nodeAt(rel), dom: view.nodeDOM(pos + 1 + rel) });
    const widths = [];
    for (let col = 0; col < map.width; col++) { // the first row's cells; one spanning columns splits evenly
      const { left, right, dom } = cellAt(map.map[col]);
      widths.push(Math.round((dom?.offsetWidth ?? 0) / (right - left)));
    }
    if (widths.some((w) => !w)) return true;
    for (const rel of new Set(map.map)) {
      const { left, right, cell } = cellAt(rel);
      tr.setNodeMarkup(pos + 1 + rel, null, { ...cell.attrs, colwidth: widths.slice(left, right) });
    }
    return true; // a table inside a cell gets its own widths
  });
  return tr.doc.toJSON();
}

/** Builds `{html, images}` for api.forum.push (SPEC §5). */
export async function buildPayload(editor, settings) {
  const { doc, boards: nodes } = replaceWhiteboards(applyBaseStyles(sizedTablesJSON(editor), settings));
  const html = generateHTML(doc, editor.extensionManager.extensions);
  // A synced canvas exports what it shows: its library flowchart's live board; a missing record, its own attrs (the cache).
  const live = await Promise.all(nodes.map((b) => (b.kind === 'canvas' && validFlow(b.flow) ? flowSource.load(b.flow.id) : null)));
  const boards = nodes.map((b, i) => (live[i] ? { ...b, ...live[i].board } : b));

  // Boards nested in a list, quote, box or table are narrower than the page; use the drawn width.
  // NodeView DOM order matches replaceWhiteboards' document order. offsetWidth ignores CSS zoom.
  const widths = [...editor.view.dom.querySelectorAll('.sc, .pc, [data-media] > :is(video, img)')].map((el) => el.offsetWidth);
  const images = [];
  let charts = 0;
  for (const [i, board] of boards.entries()) {
    if (board.kind === 'media') { // a video or GIF goes up as it is
      const m = board.src?.match(/^data:([^;]+);base64,/);
      if (!m) throw new Error(`The file of ${board.name} is missing`);
      images.push({ name: board.name, base64: board.src.slice(m[0].length), width: widths[i], type: m[1] });
      continue;
    }
    const width = widths[i] || Math.min(board.dw ?? settings.forumWidth, settings.forumWidth);
    let { blob, height } = await boardPicture(board, width, settings.theme, board.kind === 'planChart' ? ++charts : 0);
    if (!blob) throw new Error(`Could not render ${board.kind} ${i + 1}`);
    let type = 'image/png';
    let name = `${board.kind === 'planChart' ? 'plan' : board.kind}-${i + 1}.png`;
    if (blob.size > MAX_PNG_BYTES) {
      blob = await toJpeg(blob, settings.theme);
      type = 'image/jpeg';
      name = name.replace(/\.png$/, '.jpg');
    }
    images.push({ name, base64: await blobToBase64(blob), width, height, type });
  }
  return { html, images };
}
