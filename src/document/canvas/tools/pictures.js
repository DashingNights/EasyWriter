// Pictures on the page (docs/plans/engine/stage2b.md, engine-page-tools): the crop handles (Picture Format > Crop, Graphics
// Format > Crop: picture.crop) and Set Transparent Color's click (the pixel under it, then picture.transparentColor, which
// engine-gaps-pictures builds). On a turned or flipped picture the handles sit where the picture is drawn (engine-tools-2): the
// pointer is turned back into the upright frame, and the crop's sides swap with a flip.
import { frameOf } from './shapes.js';

const MIN = 0.05; // the least of the source an axis keeps, as picture.crop does
const REACH = 6; // screen px from a handle that still grabs it

/** The picture's source rect on the page from its visible frame `f` and crop `c` ([left, top, right, bottom] fractions). */
export function sourceOf(f, c) {
  const fw = f.w / Math.max(MIN, 1 - c[0] - c[2]);
  const fh = f.h / Math.max(MIN, 1 - c[1] - c[3]);
  return { x: f.x - c[0] * fw, y: f.y - c[1] * fh, w: fw, h: fh };
}

/** The crop after dragging edges `edges` ({l, t, r, b}: which move) of visible frame `f` to point `at`, over source `s`. */
export function dragCrop(f, s, edges, at) {
  let [x0, y0, x1, y1] = [f.x, f.y, f.x + f.w, f.y + f.h];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if (edges.l) x0 = clamp(at.x, s.x, x1 - MIN * s.w);
  if (edges.r) x1 = clamp(at.x, x0 + MIN * s.w, s.x + s.w);
  if (edges.t) y0 = clamp(at.y, s.y, y1 - MIN * s.h);
  if (edges.b) y1 = clamp(at.y, y0 + MIN * s.h, s.y + s.h);
  return {
    frame: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    crop: [(x0 - s.x) / s.w, (y0 - s.y) / s.h, (s.x + s.w - x1) / s.w, (s.y + s.h - y1) / s.h],
  };
}

const HANDLES = [
  { l: 1, t: 1 }, { t: 1 }, { r: 1, t: 1 }, { r: 1 }, { r: 1, b: 1 }, { b: 1 }, { l: 1, b: 1 }, { l: 1 },
];
const handleAt = (f, h) => [h.l ? f.x : h.r ? f.x + f.w : f.x + f.w / 2, h.t ? f.y : h.b ? f.y + f.h : f.y + f.h / 2];

/** The turn of `deg` degrees about point `c` ([x, y]) as a function of a point [x, y]. */
export const turn = (c, deg) => {
  const t = (deg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(t), Math.sin(t)];
  return ([x, y]) => [c[0] + (x - c[0]) * cos - (y - c[1]) * sin, c[1] + (x - c[0]) * sin + (y - c[1]) * cos];
};

/** Crop `c` ([left, top, right, bottom] of the source) as the drawn picture shows it, sides swapped by its flips; the same call
 * maps it back. */
export const flipCrop = (c, flipH, flipV) => [flipH ? c[2] : c[0], flipV ? c[3] : c[1], flipH ? c[0] : c[2], flipV ? c[1] : c[3]];

/** Rect `r` as a preview item: itself upright, else its corners turned by `rot` as a closed path. */
const box = (r, rot, deg) => (deg % 360 ? { path: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(rot), closed: true } : { rect: r });

/** Crop mode on the selected picture: eight black handles on the visible part, the rest of the source dimmed and dashed. A
 * handle drag crops (one undo step, the display size following), a press away from the picture or Esc ends it. */
export const cropTool = (env) => {
  let frame = null;
  let src = null;
  let grab = null;
  let live = null; // {frame, crop} while a handle moves
  let rot = (p) => p; // upright frame → where it is drawn
  let back = (p) => p;
  let flips = [false, false];
  const load = async () => {
    frame = await frameOf(env);
    if (!frame?.obj?.picture) return env.done();
    flips = [!!frame.obj.flipH, !!frame.obj.flipV];
    src = sourceOf(frame, flipCrop(frame.obj.picture.crop ?? [0, 0, 0, 0], ...flips));
    const c = [frame.x + frame.w / 2, frame.y + frame.h / 2];
    rot = turn(c, frame.rotation ?? 0);
    back = turn(c, -(frame.rotation ?? 0));
    env.redraw();
  };
  load();
  const k = () => env.vp.camera.zoom * (4 / 3);
  const upright = (at) => {
    const [x, y] = back([at.x, at.y]);
    return { ...at, x, y };
  };
  return {
    cursor: 'default',
    down(at) {
      if (!frame || at.surface !== frame.surface) return env.done();
      const p = upright(at);
      grab = HANDLES.find((h) => {
        const [x, y] = handleAt(frame, h);
        return Math.hypot(x - p.x, y - p.y) * k() <= REACH;
      }) ?? null;
      if (!grab) env.done(); // Word leaves crop mode at a press elsewhere
    },
    move(at) {
      if (!grab) return;
      live = dragCrop(frame, src, grab, upright(at));
      env.redraw();
    },
    async up() {
      const moved = live;
      grab = null;
      live = null;
      if (!moved) return;
      const { frame: f, crop: c } = moved;
      const [left, top, right, bottom] = flipCrop(c, ...flips);
      await env.exec('picture.crop', { left, top, right, bottom, width: f.w, height: f.h });
      await load(); // where the picture now is: an inline one stays in its line, a floating one keeps its visible part in place
    },
    preview(surface) {
      if (!frame || frame.surface !== surface) return [];
      const f = live?.frame ?? frame;
      return [
        { ...box(src, rot, frame.rotation ?? 0), dash: true, fill: 'rgb(0 0 0 / 0.25)' },
        { ...box(f, rot, frame.rotation ?? 0), stroke: '#000000' },
        ...HANDLES.map((h) => ({ handle: rot(handleAt(f, h)), fill: '#000000', stroke: '#ffffff' })),
      ];
    },
  };
};

/** The colour 'RRGGBB' of the pixel at (u, v) (0..1 across) of picture data `d` ({mime, base64}), or null. */
async function pixelOf(d, u, v) {
  if (!d?.base64) return null;
  const bytes = Uint8Array.from(atob(d.base64), (ch) => ch.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: d.mime || 'image/png' }));
  const px = Math.min(bmp.width - 1, Math.max(0, Math.floor(u * bmp.width)));
  const py = Math.min(bmp.height - 1, Math.max(0, Math.floor(v * bmp.height)));
  const c = new OffscreenCanvas(1, 1).getContext('2d');
  c.drawImage(bmp, px, py, 1, 1, 0, 0, 1, 1);
  bmp.close();
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Set Transparent Color: a click on the selected picture makes the colour under it transparent (one undo step), and the tool
 * ends, as Word's does. A click off the picture ends it. */
export const transparentTool = (env) => ({
  cursor: 'crosshair',
  async down(at) {
    const f = await frameOf(env);
    env.done();
    if (!f?.obj?.picture || at.surface !== f.surface || at.x < f.x || at.y < f.y || at.x > f.x + f.w || at.y > f.y + f.h) return;
    const c = f.obj.picture.crop ?? [0, 0, 0, 0];
    let u = (at.x - f.x) / f.w;
    let v = (at.y - f.y) / f.h;
    if (f.obj.flipH) u = 1 - u;
    if (f.obj.flipV) v = 1 - v;
    // The stored pixel: the engine matches the transparent colour before any recolour.
    const color = await pixelOf(await env.query('picture.data', { stored: true }), c[0] + u * (1 - c[0] - c[2]), c[1] + v * (1 - c[1] - c[3])).catch(() => null);
    if (color) await env.exec('picture.transparentColor', { color });
  },
});
