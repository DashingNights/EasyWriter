import { generateHTML } from '@tiptap/core';
import { flowSource } from '../../canvas.js';
import { boardPicture, drawnColumnWidths, setColumnWidths } from '../../export.js';
import { validFlow } from '../../flow/library.mjs';
import { pageOf } from '../../formats.mjs';
import { WB_BG } from '../../whiteboard.js';
import { applyBaseStyles, replaceWhiteboards } from './post.mjs';

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

/** The document JSON with every table cell's `colwidth` set to its columns' drawn widths. The forum lays tables out fixed at
 * the widths they carry (SPEC §1), so a table with none would shrink to its minimum. A table not drawn keeps its own. */
function sizedTablesJSON(editor) {
  const { state, view } = editor;
  const tr = state.tr; // never dispatched
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    const widths = drawnColumnWidths(view, node, pos);
    if (widths) setColumnWidths(tr, node, pos, widths);
    return true; // a table inside a cell gets its own widths
  });
  return tr.doc.toJSON();
}

/** Builds `{html, images}` of `draft`, shown in `editor`, for api.forum.push (SPEC §5). */
export async function buildPayload(editor, settings, draft) {
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
    const page = pageOf(draft, settings).width;
    const width = widths[i] || Math.min(board.dw ?? page, page);
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
