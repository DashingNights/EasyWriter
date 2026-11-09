// A picture as every editor takes one in: what draws, its own size and an EMF's or WMF's original (metafile.mjs), and the smart
// canvas a pasted or downloaded picture becomes. pictureCanvas is plain data and runs anywhere; pictureOfUrl needs a page (Image).
import { metafileOfUrl } from './metafile.mjs';

/** A picture's data URL `src` → {src (what draws), w, h (its own size), metafile?}, or null when it does not decode. An EMF or WMF
 * (told from its header) shows the metafile reader's drawing at its own size and keeps its original. `opts`: metafilePicture's. */
export async function pictureOfUrl(src, opts) {
  const meta = await metafileOfUrl(src, opts);
  const img = new Image();
  img.src = meta?.src ?? src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  if (!img.naturalWidth || !img.naturalHeight) return null;
  return { src: meta?.src ?? src, w: meta?.w || img.naturalWidth, h: meta?.h || img.naturalHeight, ...(meta && { metafile: meta.metafile }) };
}

/** A smart canvas holding picture `src` (natural size `w` × `h`, at most 8000 px a side) at 0,0, shown at most `width` wide:
 * what pasting a picture makes (whiteboard.js addImages). An EMF's or WMF's `metafile` (its original) stays with the item. */
export function pictureCanvas({ src, w, h, metafile }, width) {
  const k = Math.min(1, 8000 / Math.max(w, h));
  const [W, H] = [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
  const id = Math.random().toString(36).slice(2, 9).padEnd(7, '0');
  return { type: 'canvas', attrs: { w: W, h: H, dw: Math.min(W, width), frame: { x: 0, y: 0, w: W, h: H, item: id }, bg: 'post',
    items: [{ id, type: 'image', src, x: 0, y: 0, w: W, h: H, ...(metafile && { metafile }) }] } };
}
