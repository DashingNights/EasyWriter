// Crop mode, Set Transparent Color's pick and Screen Clipping (plan.md §3 picture-format, §1.7 page overlay). Crop shows the
// whole picture dimmed in the page overlay with black handles at the corners and edge midpoints of the crop: dragging a handle
// crops (image.crop fractions of each side), dragging inside moves the picture under the crop, and Enter, Esc or a click outside
// ends it. The picture's width and height stay the drawn crop box; the uncropped size is width / (1 - l - r).
import { overlayOf, scaleOf } from '../../geometry.js';
import { cropShare } from './pictures.mjs';
import { loaded, merged, setAttrs } from './edit.js';

let mode = null; // {editor, pos, el, off}
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());
/** Calls `fn` when crop mode starts or ends → unsubscribe. */
export const onCropChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));

/** Whether crop mode is on (for `editor`, when given). */
export const cropping = (editor) => !!mode && (!editor || mode.editor === editor);

const imgAt = (view, pos) => {
  const dom = view.nodeDOM(pos);
  return dom?.tagName === 'IMG' ? dom : dom?.querySelector?.('img') ?? null;
};

const HANDLES = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

/** The crop and size after dragging `kind` ('move' or a handle) by dx, dy layout px, from `attrs` → {crop, width, height}. */
export function dragCrop(attrs, kind, dx, dy) {
  const c = { t: 0, r: 0, b: 0, l: 0, ...(attrs.crop ?? {}) };
  const [fw, fh] = cropShare(c);
  const W = attrs.width / fw;
  const H = attrs.height / fh;
  const min = 0.02;
  const clamp = (v, hi) => Math.min(Math.max(v, 0), Math.max(0, hi));
  if (kind === 'move') {
    const ddx = Math.max(-c.r, Math.min(c.l, dx / W)); // the picture moves right: less is cut on the left
    const ddy = Math.max(-c.b, Math.min(c.t, dy / H));
    Object.assign(c, { l: c.l - ddx, r: c.r + ddx, t: c.t - ddy, b: c.b + ddy });
  } else {
    if (kind.includes('w')) c.l = clamp(c.l + dx / W, 1 - c.r - min);
    if (kind.includes('e')) c.r = clamp(c.r - dx / W, 1 - c.l - min);
    if (kind.includes('n')) c.t = clamp(c.t + dy / H, 1 - c.b - min);
    if (kind.includes('s')) c.b = clamp(c.b - dy / H, 1 - c.t - min);
  }
  const r4 = (n) => Math.round(n * 10000) / 10000;
  for (const k of ['t', 'r', 'b', 'l']) c[k] = r4(c[k]);
  const [nw, nh] = cropShare(c);
  return { crop: c, width: Math.round(W * nw * 100) / 100, height: Math.round(H * nh * 100) / 100 };
}

function draw() {
  const { editor, pos, el } = mode;
  const view = editor.view;
  const node = view.state.doc.nodeAt(pos);
  const img = node?.type.name === 'image' ? imgAt(view, pos) : null;
  if (!img) return endCrop();
  const s = scaleOf(view);
  const pm = view.dom.getBoundingClientRect();
  const r = img.getBoundingClientRect();
  const box = { x: (r.left - pm.left) / s, y: (r.top - pm.top) / s, w: r.width / s, h: r.height / s };
  const c = { t: 0, r: 0, b: 0, l: 0, ...(node.attrs.crop ?? {}) };
  const [fw, fh] = cropShare(c);
  const W = box.w / fw;
  const H = box.h / fh;
  const ghost = el.querySelector('[data-crop-ghost]');
  ghost.src = node.attrs.src;
  Object.assign(ghost.style, { left: `${box.x - c.l * W}px`, top: `${box.y - c.t * H}px`, width: `${W}px`, height: `${H}px` });
  const frame = el.querySelector('[data-crop-frame]');
  Object.assign(frame.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  mode.box = box;
}

/** Starts crop mode on the picture at `pos` of `editor`. */
export function startCrop(editor, pos) {
  endCrop();
  const host = overlayOf(editor.view);
  if (!host) return false;
  const el = document.createElement('div');
  el.setAttribute('data-crop-overlay', '');
  el.innerHTML = '<img data-crop-ghost alt="" style="position:absolute;opacity:0.35;pointer-events:none;max-width:none"><div data-crop-frame style="position:absolute;pointer-events:auto;cursor:move;box-shadow:0 0 0 1px #000"></div>';
  const frame = el.querySelector('[data-crop-frame]');
  for (const [k, [x, y]] of Object.entries(HANDLES)) {
    const h = document.createElement('div');
    h.dataset.cropHandle = k;
    h.style.cssText = `position:absolute;left:calc(${x * 100}% - 5px);top:calc(${y * 100}% - 5px);width:10px;height:10px;background:#000;border:1px solid #fff;cursor:${CURSOR[k]};pointer-events:auto`;
    frame.append(h);
  }
  host.append(el);
  mode = { editor, pos, el };
  const view = editor.view;

  let drag = null;
  frame.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    frame.setPointerCapture(e.pointerId);
    drag = { kind: e.target.dataset.cropHandle ?? 'move', x: e.clientX, y: e.clientY };
  });
  frame.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const s = scaleOf(view);
    const node = view.state.doc.nodeAt(mode.pos);
    const next = dragCrop(node.attrs, drag.kind, (e.clientX - drag.x) / s, (e.clientY - drag.y) / s);
    // Preview: the frame follows; the picture changes on release.
    const c = node.attrs.crop ?? {};
    const [fw, fh] = cropShare(c);
    const W = mode.box.w / fw;
    const H = mode.box.h / fh;
    Object.assign(frame.style, { left: `${mode.box.x - (c.l ?? 0) * W + next.crop.l * W}px`, top: `${mode.box.y - (c.t ?? 0) * H + next.crop.t * H}px`,
      width: `${next.width}px`, height: `${next.height}px` });
  });
  const up = (e) => {
    if (!drag) return;
    const s = scaleOf(view);
    const node = view.state.doc.nodeAt(mode.pos);
    const next = dragCrop(node.attrs, drag.kind, (e.clientX - drag.x) / s, (e.clientY - drag.y) / s);
    drag = null;
    setAttrs(editor, mode.pos, { crop: merged(node.attrs.crop, next.crop), width: next.width, height: next.height });
  };
  frame.addEventListener('pointerup', up);
  frame.addEventListener('pointercancel', () => { drag = null; draw(); });

  const key = (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      endCrop();
    }
  };
  // The ribbon and its menus stay usable while cropping (Word): the Crop button then toggles crop off, and the Crop menu's
  // Aspect Ratio, Fill and Fit act on the picture being cropped.
  const outside = (e) => {
    if (el.contains(e.target) || e.target === imgAt(view, mode.pos) || e.target.closest?.('[data-ribbon], [role="menu"]')) return;
    endCrop();
  };
  const tx = ({ transaction }) => {
    if (!mode) return;
    mode.pos = transaction.mapping.map(mode.pos);
    requestAnimationFrame(() => mode && draw());
  };
  window.addEventListener('keydown', key, true);
  document.addEventListener('pointerdown', outside, true);
  editor.on('transaction', tx);
  editor.on('destroy', endCrop);
  mode.off = () => {
    window.removeEventListener('keydown', key, true);
    document.removeEventListener('pointerdown', outside, true);
    editor.off('transaction', tx);
    editor.off('destroy', endCrop);
  };
  draw();
  changed();
  return true;
}

/** Ends crop mode. */
export function endCrop() {
  if (!mode) return;
  mode.off?.();
  mode.el.remove();
  mode = null;
  changed();
}

// ---------- Set Transparent Color ----------

/** The colour of the picture `img` (with `attrs`) under client point x, y → '#RRGGBB', or null. */
async function colourAt(img, attrs, x, y) {
  const r = img.getBoundingClientRect();
  const c = { t: 0, r: 0, b: 0, l: 0, ...(attrs.crop ?? {}) };
  const [fw, fh] = cropShare(c);
  const fx = c.l + ((x - r.left) / r.width) * fw;
  const fy = c.t + ((y - r.top) / r.height) * fh;
  const src = await loaded(attrs.src);
  const cv = document.createElement('canvas');
  cv.width = src.naturalWidth;
  cv.height = src.naturalHeight;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0);
  const px = g.getImageData(Math.min(cv.width - 1, Math.max(0, Math.floor(fx * cv.width))), Math.min(cv.height - 1, Math.max(0, Math.floor(fy * cv.height))), 1, 1).data;
  return `#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

let picking = null;

/** Arms Set Transparent Color on `editor`: the next click on a picture makes the colour under it transparent; Esc disarms. */
export function armTransparentColor(editor, onPick) {
  picking?.();
  const dom = editor.view.dom;
  const down = (e) => {
    const img = e.target.closest?.('img');
    const pos = img ? editor.view.posAtDOM(img, 0) : null;
    const node = pos == null ? null : editor.state.doc.nodeAt(pos);
    picking?.();
    if (node?.type.name !== 'image') return;
    e.preventDefault();
    e.stopPropagation();
    colourAt(img, node.attrs, e.clientX, e.clientY).then((hex) => hex && onPick(pos, hex), () => {});
  };
  const key = (e) => { if (e.key === 'Escape') picking?.(); };
  dom.addEventListener('pointerdown', down, true);
  window.addEventListener('keydown', key, true);
  dom.style.cursor = 'crosshair';
  picking = () => {
    dom.removeEventListener('pointerdown', down, true);
    window.removeEventListener('keydown', key, true);
    dom.style.cursor = '';
    picking = null;
  };
}

// ---------- Screen Clipping ----------

/** Shows the screen picture `src` over the page area (direction.md section 6: never the whole window); a dragged rectangle resolves
 * with that part as a PNG data URL, Esc or a click without a drag with null. Word hides its window first; ours stays (deviation). */
export function clipScreen(src) {
  return new Promise((resolve) => {
    const area = document.querySelector('#editor-area') ?? document.querySelector('[data-viewport]') ?? document.body;
    const el = document.createElement('div');
    el.setAttribute('data-screen-clipping', '');
    el.style.cssText = 'position:absolute;inset:0;z-index:60;background:#000;cursor:crosshair;user-select:none';
    el.innerHTML = '<img alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0.6;pointer-events:none"><div style="position:absolute;display:none;box-shadow:0 0 0 1px #fff, 0 0 0 9999px rgba(0,0,0,0.3)"></div>';
    const [pic, band] = el.children;
    pic.src = src;
    const oldPosition = area.style.position;
    if (getComputedStyle(area).position === 'static') area.style.position = 'relative';
    area.append(el);
    el.tabIndex = -1;
    el.focus();
    let start = null;
    const finish = (v) => {
      window.removeEventListener('keydown', key, true);
      el.remove();
      area.style.position = oldPosition;
      resolve(v);
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    window.addEventListener('keydown', key, true);
    const rectOf = (e) => {
      const r = el.getBoundingClientRect();
      const x = [start.x, e.clientX - r.left].sort((a, b) => a - b);
      const y = [start.y, e.clientY - r.top].sort((a, b) => a - b);
      return { x: x[0], y: y[0], w: x[1] - x[0], h: y[1] - y[0] };
    };
    el.addEventListener('pointerdown', (e) => {
      const r = el.getBoundingClientRect();
      start = { x: e.clientX - r.left, y: e.clientY - r.top };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      const b = rectOf(e);
      Object.assign(band.style, { display: 'block', left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
    });
    el.addEventListener('pointerup', (e) => {
      if (!start) return;
      const b = rectOf(e);
      if (b.w < 3 || b.h < 3) return finish(null);
      // The drawn picture's box inside the overlay (object-fit: contain) maps the band to the screen picture's pixels.
      const r = el.getBoundingClientRect();
      const k = Math.min(r.width / pic.naturalWidth, r.height / pic.naturalHeight);
      const ox = (r.width - pic.naturalWidth * k) / 2;
      const oy = (r.height - pic.naturalHeight * k) / 2;
      const sx = Math.max(0, (b.x - ox) / k);
      const sy = Math.max(0, (b.y - oy) / k);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(Math.min(b.w / k, pic.naturalWidth - sx)));
      cv.height = Math.max(1, Math.round(Math.min(b.h / k, pic.naturalHeight - sy)));
      cv.getContext('2d').drawImage(pic, sx, sy, cv.width, cv.height, 0, 0, cv.width, cv.height);
      finish(cv.toDataURL('image/png'));
    });
  });
}
