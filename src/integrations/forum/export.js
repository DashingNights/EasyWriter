import { generateHTML } from '@tiptap/core';
import { flowSource } from '../../canvas.js';
import { PX_PER_PT } from '../../engine/view/camera.mjs';
import { boardPicture, drawnColumnWidths, setColumnWidths, shownWidth, VECTOR_PICTURE, vectorMediaPicture } from '../../export.js';
import { validFlow } from '../../flow/library.mjs';
import { formatOf, pageOf } from '../../formats.mjs';
import { pendingCount } from '../../suggest/core.mjs';
import { WB_BG } from '../../whiteboard.js';
import { renderPost } from './html.mjs';
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

/** A post session's saved model: the post the push sends ({doc, pending}, post-write A3). */
export async function postModel(session) {
  return JSON.parse(new TextDecoder().decode(await session.save('post')));
}

/** The width an object is shown at in the post, px, from its saved `shown` (points, post-write A3): the drawn width a DOM post's
 * push reads off the page. */
const shownPx = (board) => Math.round(Number(board.shown ?? 0) * PX_PER_PT);

/** Builds `{html, images}` of `draft` for api.forum.push (SPEC §5). `post`: the model a post session saves ({doc, pending}) when
 * the canvas engine hosts the post, else its DOM editor. The engine path writes its own html (html.mjs renderPost) and takes each
 * object's width from its `shown`; the DOM path is the one the push sent before the engine. */
export async function buildPayload(post, settings, draft) {
  const model = post?.state ? null : post; // an editor has a state; a saved model has the post's doc
  // A suggestion waiting in the draft would go out with no record of it (docs/wiki/suggestions.md, gate draft.settled).
  if ((model ? (model.pending ?? 0) > 0 : pendingCount(post.state.doc) > 0)) {
    throw new Error('Suggestions wait in this draft. Accept or reject them in the draft first.');
  }
  const { doc, boards: nodes } = model
    ? replaceWhiteboards(applyBaseStyles(model.doc, settings))
    : replaceWhiteboards(applyBaseStyles(sizedTablesJSON(post), settings));
  const html = model ? renderPost(doc) : generateHTML(doc, post.extensionManager.extensions);
  // A synced canvas exports what it shows: its library flowchart's live board; a missing record, its own attrs (the cache).
  const live = await Promise.all(nodes.map((b) => (b.kind === 'canvas' && validFlow(b.flow) ? flowSource.load(b.flow.id) : null)));
  const boards = nodes.map((b, i) => (live[i] ? { ...b, ...live[i].board } : b));

  // Boards nested in a list, quote, box or table are narrower than the page; use the width they are shown at.
  // A DOM post's NodeView DOM order matches replaceWhiteboards' document order, and offsetWidth ignores CSS zoom; the engine
  // writes each object's shown width with its post. A picture the page cannot draw (an EMF in a media block) has no drawn width:
  // it takes its own, at most the page's.
  const widths = model
    ? nodes.map(shownPx)
    : [...post.view.dom.querySelectorAll('.sc, .pc, [data-media] > :is(video, img)')].map(shownWidth);
  // A format whose output is raster (formats.mjs rasterOutput: the forum's) never passes a vector picture on.
  const raster = !!formatOf(draft, settings)?.rasterOutput;
  const page = pageOf(draft, settings).width;
  const images = [];
  let charts = 0;
  for (const [i, board] of boards.entries()) {
    const vector = board.kind === 'media' && raster && VECTOR_PICTURE.test(board.src ?? '');
    if (board.kind === 'media' && !vector) { // a video or GIF goes up as it is
      const m = board.src?.match(/^data:([^;]+);base64,/);
      if (!m) throw new Error(`The file of ${board.name} is missing`);
      images.push({ name: board.name, base64: board.src.slice(m[0].length), width: widths[i], type: m[1] });
      continue;
    }
    // A vector picture outside a canvas (a pasted media block): rendered as a canvas of it would be (export.js vectorMediaPicture).
    let blob, width, height;
    if (vector) ({ blob, width, height } = await vectorMediaPicture(board, widths[i], page, settings.theme));
    else {
      width = widths[i] || Math.min(board.dw ?? page, page);
      ({ blob, height } = await boardPicture(board, width, settings.theme, board.kind === 'planChart' ? ++charts : 0));
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
