import { polylinePoint, resolveConnectors } from '../../flow/route.mjs';
import { rotBox } from '../../flow/shapes.mjs';
import { rasterizeWhiteboard } from '../../whiteboard.js';

// Numbered marks on the pictures the assistant's model gets (SPEC §7i Vision; plan assistant-reliability.md wave 2): a badge
// per item, numbered 1, 2, ... in the order of the legend that goes with the picture (an attachment's numbered item lines,
// attach.mjs itemLines, or view_render's legend), so the picture and the text share handles. markSpots and markCentres are pure
// (test/assistant-marks.test.mjs); drawMarks and boardPicture run in the renderer.

export const PICTURE_SIDE = 1600; // px, the long side of a picture for the model (1280 before Gemini, 2026-10-07: a 1,454 px post fits 1:1)
export const BADGE = 22; // px, a badge's height at the picture's own scale, readable at 1 280 px
const R = BADGE / 2;
const INSET = 2; // px between a box's top-left corner and its badge
const FILL = '#d6336c';

// A connector's middle label covers its midpoint: the badge goes along the path past the label's estimated half width (route.mjs
// labelBox: 0.6 of the font size a character, 4 px padding) and this much more, about a badge's radius in board px.
const PAST_LABEL = 14;

/** Where each of `items` gets its mark, in board px and in order → [{id, x, y, mid}]: a box's top-left corner (a turned shape: its
 * bounding box's); a connector's midpoint on its routed path (route.mjs polylinePoint at 0.5; `all`, the board's items, gives its
 * ends), or with a middle label just past that label along the path, so "yes" stays readable beside its number; `mid` true. */
export function markSpots(items, all = items) {
  const conns = new Set(items.filter((i) => i.type === 'connector').map((i) => i.id));
  const geo = conns.size ? resolveConnectors(all, undefined, conns).geo : new Map();
  return items.map((i) => {
    if (i.type !== 'connector') {
      const b = i.type === 'shape' && i.rot ? rotBox(i) : i;
      return { id: i.id, x: b.x ?? 0, y: b.y ?? 0, mid: false };
    }
    const pts = geo.get(i.id)?.pts;
    if (!pts?.length) return { id: i.id, x: (i.x ?? 0) + (i.w ?? 0) / 2, y: (i.y ?? 0) + (i.h ?? 0) / 2, mid: true };
    const l = i.labels?.mid;
    const chars = Math.max(0, ...String(l?.html ?? '').replace(/<[^>]*>/g, '\n').split('\n').map((s) => s.trim().length));
    const len = pts.slice(1).reduce((n, q, k) => n + Math.hypot(q.x - pts[k].x, q.y - pts[k].y), 0);
    const t = (l?.t ?? 0.5) + (chars && len ? (chars * (l.size ?? 14) * 0.3 + 4 + PAST_LABEL) / len : 0);
    const p = polylinePoint(pts, chars ? Math.min(t, 1) : 0.5);
    return { id: i.id, x: p.x, y: p.y, mid: true };
  });
}

/** Badge centres in picture px for `spots` (markSpots), numbered from 1 in order: `toPx(p)` maps a board point to the picture; a
 * corner's badge sits inside the box (its radius and 2 px in from the corner), a midpoint's on the point → [{n, id, x, y}]. */
export const markCentres = (spots, toPx) => spots.map((s, k) => {
  const p = toPx(s);
  const d = s.mid ? 0 : R + INSET;
  return { n: k + 1, id: s.id, x: p.x + d, y: p.y + d };
});

/** The size line of a picture for the model (wave 2b): its own `width` x `height` px and the size `w` x `h` of what it shows,
 * "1280 x 512 of a 1000 x 400 board", so the model knows the scale (the legend keeps board px). */
export const sizeText = (width, height, w, h, what = 'board') => `${width} x ${height} of a ${Math.round(w)} x ${Math.round(h)} ${what}`;

/** A PNG data URL of Blob `blob`. */
export const dataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/** Picture `blob` (`crop`: the part {x, y, w, h} of it, in its px) drawn at `width` x `height` (default: its size) with the badges
 * `marks` (markCentres, in output px) → a PNG data URL. A badge is a filled circle with a white ring and a white number (a pill for
 * three digits). */
export async function drawMarks(blob, marks, { crop = null, width, height } = {}) {
  if (!marks.length && !crop && !width) return dataUrl(blob);
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(width ?? bmp.width, height ?? bmp.height);
  const g = c.getContext('2d');
  if (crop) g.drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  else g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const m of marks) {
    const text = String(m.n);
    g.font = `bold ${text.length > 2 ? 11 : 13}px Arial, sans-serif`;
    const w = Math.max(BADGE, g.measureText(text).width + 8);
    g.beginPath();
    g.roundRect(m.x - w / 2, m.y - R, w, BADGE, R);
    g.fillStyle = FILL;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = '#ffffff';
    g.stroke();
    g.fillStyle = '#ffffff';
    g.fillText(text, m.x, m.y + 1);
  }
  return dataUrl(await c.convertToBlob({ type: 'image/png' }));
}

/** Board {w, h, bg, items} as the export rasterizes it (src/export.js; a transparent background as the post colour, since
 * llama.cpp drops the alpha channel), at a scale of at most 2 and at most 1 280 px on the long side, with a badge per item of
 * `order` (default: its items; [] for none), numbered in that order → {url (PNG data URL), width, height, size (sizeText; `what`
 * names the board: 'image' for an image block)}. */
export async function boardPicture({ w, h, bg, items }, { theme, order = items, what = 'board' }) {
  const scale = Math.min(1, PICTURE_SIDE / Math.max(w, h, 1)); // 1:1 up to PICTURE_SIDE (2026-10-07: picture pixels are board pixels)
  const { blob } = await rasterizeWhiteboard({ height: h, bg: bg === 'transparent' ? 'post' : bg, items }, { width: w, theme, scale });
  const marks = markCentres(markSpots(order, items), (p) => ({ x: p.x * scale, y: p.y * scale }));
  const ihdr = new DataView(await blob.slice(16, 24).arrayBuffer()); // the PNG's own pixel size
  const [width, height] = [ihdr.getUint32(0), ihdr.getUint32(4)];
  return { url: await drawMarks(blob, marks), width, height, size: sizeText(width, height, w, h, what) };
}
