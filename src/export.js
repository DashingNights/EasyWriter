import { generateHTML } from '@tiptap/core';
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

/** Builds `{html, images}` for api.forum.push (SPEC §5). */
export async function buildPayload(editor, settings) {
  const { doc, boards: nodes } = replaceWhiteboards(applyBaseStyles(editor.getJSON(), settings));
  const html = generateHTML(doc, editor.extensionManager.extensions);
  // A synced canvas exports what it shows: its library flowchart's live board; a missing record, its own attrs (the cache).
  const live = await Promise.all(nodes.map((b) => (b.kind === 'canvas' && validFlow(b.flow) ? flowSource.load(b.flow.id) : null)));
  const boards = nodes.map((b, i) => (live[i] ? { ...b, ...live[i].board } : b));

  // Boards nested in a list, quote, box or table are narrower than the page; use the drawn width.
  // NodeView DOM order matches replaceWhiteboards' document order. offsetWidth ignores CSS zoom.
  const widths = [...editor.view.dom.querySelectorAll('.wb, .sc, .pc')].map((el) => el.offsetWidth);
  const images = [];
  let charts = 0;
  for (const [i, board] of boards.entries()) {
    let width;
    let height;
    let blob;
    if (board.kind === 'canvas') {
      // The artboard is rendered at its own size, at the pixel ratio that gives 2× its drawn size in the document.
      width = widths[i] || Math.min(board.dw, settings.forumWidth);
      height = Math.round((width * board.h) / board.w);
      const scale = Math.min(4, Math.max(0.25, (2 * width) / board.w));
      ({ blob } = await rasterizeWhiteboard({ height: board.h, bg: board.bg, items: board.items }, { width: board.w, theme: settings.theme, scale }));
    } else if (board.kind === 'planChart') {
      // Laid out at the width the readability rules need, shown at the drawn width (SPEC §6e).
      width = widths[i] || Math.min(board.dw ?? settings.forumWidth, settings.forumWidth);
      ({ blob, height } = await rasterizePlanChart(board, { width, theme: settings.theme, n: ++charts }));
    } else {
      width = widths[i] || settings.forumWidth;
      height = board.height;
      ({ blob } = await rasterizeWhiteboard(board, { width, theme: settings.theme, scale: 2 }));
    }
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
