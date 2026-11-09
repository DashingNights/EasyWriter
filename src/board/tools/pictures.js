// Pictures on a board (docs/plans/board/briefs/bd-pictures.md): dropped, picked with I or the rail's Add image, or pasted,
// they are one undo step behind a content-hashed key in the board's media table. A double-click crops, as Word does, and the
// engine paints the picture from its model (bd-paint): the bytes are hashed, so two items with one key share one picture.
import { keyAmong } from '../../app/keybinds.js';
import { dragCrop, flipCrop, sourceOf, turn } from '../../document/canvas/tools/pictures.js';
import { kOf } from '../../engine/view/camera.mjs';
import { METAFILE_NAME, PICTURE_ACCEPT, metafileSize } from '../../tooling/metafile.mjs';
import { toast } from 'sonner';
import { boxOf } from '../gestures.mjs';
import { placementsOf } from '../surfaces.mjs';
import { registerTool } from './registry.js';

const ACCENT = '#0d99ff';
const MAX_PICTURE_BYTES = 96 * 1024 * 1024;
const MAX_SVG_BYTES = 10 * 1024 * 1024; // an SVG is parsed as text on the page's thread, not in the worker
const MAX_PIXELS = 100e6;
const MAX_FIT = 600; // points: the longest side of a placed picture
const GAP = 16; // points between the pictures of one row
const PT = 0.75; // points per CSS px
const REACH = 6; // CSS px from a crop handle that still grabs it
const r6 = (n) => Math.round(n * 1e6) / 1e6;

const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  emf: 'image/x-emf', wmf: 'image/x-wmf', bmp: 'image/bmp', tiff: 'image/tiff' };
const FROM_MIME = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/emf': 'emf', 'image/x-emf': 'emf', 'image/wmf': 'wmf', 'image/x-wmf': 'wmf', 'image/bmp': 'bmp',
  'image/x-bmp': 'bmp', 'image/x-ms-bmp': 'bmp', 'image/tiff': 'tiff', 'image/x-tiff': 'tiff' };
const FROM_NAME = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', svg: 'svg', emf: 'emf', wmf: 'wmf',
  bmp: 'bmp', tif: 'tiff', tiff: 'tiff' };

/** The extension a picture's key ends in, from its type, else its name. */
export function extOf(mime, name) {
  const tail = /([^./\\]+)$/.exec(String(name ?? ''))?.[1]?.toLowerCase();
  return FROM_MIME[String(mime ?? '').toLowerCase()] ?? FROM_NAME[tail] ?? 'png';
}

/** `${sha256 hex}.${ext}` of the picture's bytes, through WebCrypto: equal bytes are one media key. */
export async function mediaKey(bytes, ext) {
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}.${ext}`;
}

const pt = ({ w, h }) => ({ w: r6(w * PT), h: r6(h * PT) });

/** An SVG's own width and height, or its viewBox's, in points; null when neither gives a positive, finite size. The names are
 * matched whole (`stroke-width` is not a width) and the values read as numbers, so `24px` is 24 and `1e10` is 1e10. */
function svgSize(text) {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  const num = (v) => (Number.isFinite(v) ? v : null);
  const attr = (name) => {
    const m = new RegExp(`(?<![\\w-])${name}\\s*=\\s*["']?\\s*([^"'\\s>]+)`, 'i').exec(tag);
    return m ? parseFloat(m[1]) : null;
  };
  const box = (/\bviewBox\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '').trim().split(/[\s,]+/).map(Number);
  const view = box.length === 4 ? { w: box[2], h: box[3] } : {};
  // ponytail: a percent width reads as its number; the viewBox is the fallback, as every writer gives one.
  const w = num(attr('width')) ?? num(view.w) ?? 200;
  const h = num(attr('height')) ?? num(view.h) ?? 150;
  return w > 0 && h > 0 ? pt({ w, h }) : null;
}

/** A raster's pixel size from its own header (PNG, GIF, BMP, JPEG), or null for a format read by decoding it. Read before any
 * pixel is decoded, so a picture of a hundred million pixels is refused without its bitmap. */
function headerSize(bytes, ext) {
  if (bytes.length < 26) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ext === 'png' && v.getUint32(12) === 0x49484452) return { w: v.getUint32(16), h: v.getUint32(20) }; // IHDR
  if (ext === 'gif' && v.getUint32(0) === 0x47494638) return { w: v.getUint16(6, true), h: v.getUint16(8, true) };
  if (ext === 'bmp' && v.getUint16(0, true) === 0x4d42) return { w: Math.abs(v.getInt32(18, true)), h: Math.abs(v.getInt32(22, true)) };
  if (ext === 'jpeg') {
    for (let i = 2; i + 9 < bytes.length;) {
      if (v.getUint8(i) !== 0xff) {
        i++;
        continue;
      }
      const marker = v.getUint8(i + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = v.getUint16(i + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return { w: v.getUint16(i + 7), h: v.getUint16(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** A raster's size: px x 0.75 and its pixel count, from the header where there is one, else from decoding it. */
async function rasterSize(bytes, ext) {
  const head = headerSize(bytes, ext);
  if (head) return { ...pt(head), pixels: head.w * head.h };
  const bitmap = await createImageBitmap(new Blob([bytes], { type: MIME[ext] ?? 'image/png' }));
  const size = { ...pt({ w: bitmap.width, h: bitmap.height }), pixels: bitmap.width * bitmap.height };
  bitmap.close?.();
  return size;
}

/** A picture's own size in points: px x 0.75 for rasters (with their pixel count), a metafile's own size, an SVG's width and
 * height. Null when it cannot be read or sized: a metafile the reader cannot parse, a corrupt raster, an unusable SVG. */
export async function naturalSize(bytes, ext) {
  if (ext === 'svg') return svgSize(new TextDecoder().decode(bytes));
  if (ext === 'emf' || ext === 'wmf') {
    const own = await metafileSize(bytes).catch(() => null);
    return own ? pt(own) : null;
  }
  return rasterSize(bytes, ext);
}

/** Size scaled down so its longest side is at most `max`, never up. */
export function fitted({ w, h }, max = MAX_FIT) {
  const s = Math.min(1, max / Math.max(w || 0, h || 0) || 1);
  return { w: r6(w * s), h: r6(h * s) };
}

/** The top-lefts of a row of `sizes` centred on world point `at`, `gap` between them. */
export function rowAt(sizes, at, gap = GAP) {
  const total = sizes.reduce((n, s) => n + s.w, 0) + gap * Math.max(0, sizes.length - 1);
  let x = at.x - total / 2;
  return sizes.map((s) => {
    const spot = { x: r6(x), y: r6(at.y - s.h / 2) };
    x += s.w + gap;
    return spot;
  });
}

const base64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const dataUrl = (bytes, mime) => `data:${mime};base64,${base64(bytes)}`;

/** A media key's bytes back from the board's data URL, or null. */
function mediaBytes(media, key) {
  const url = media?.[key];
  const at = typeof url === 'string' ? /^data:[^,]*;base64,/.exec(url)?.[0].length : 0;
  if (!at) return null;
  const bin = atob(url.slice(at));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const isPicture = (file) => String(file?.type ?? '').startsWith('image/') || METAFILE_NAME.test(String(file?.name ?? ''));
const fileOf = async (file) => ({ name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });

/** A picture file's size, or null when it cannot be read: a raster must decode, an SVG must parse. */
async function measure({ bytes }, ext) {
  if (ext === 'svg') {
    const bad = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml').querySelector('parsererror');
    return bad ? null : naturalSize(bytes, ext);
  }
  return naturalSize(bytes, ext).catch(() => null);
}

/** Adds `files` ([{name, type, bytes}]) as pictures in one row centred on world point `at`, one step `Add picture`. A file that
 * is too large, holds too many pixels or cannot be read is skipped with a toast. Returns the new ids. */
export async function addPictures(api, files, at) {
  const pictures = [];
  for (const file of files) {
    const ext = extOf(file.type, file.name);
    if (file.bytes.length > MAX_PICTURE_BYTES || (ext === 'svg' && file.bytes.length > MAX_SVG_BYTES)) {
      toast('This picture is too large.');
      continue;
    }
    const size = await measure(file, ext);
    if (!size) {
      toast('This picture could not be read.');
      continue;
    }
    if (size.pixels > MAX_PIXELS) {
      toast('This picture is too large.');
      continue;
    }
    const key = await mediaKey(file.bytes, ext);
    if (!api.store.board.media[key]) api.store.board.media[key] = dataUrl(file.bytes, String(file.type ?? '').startsWith('image/') ? file.type : MIME[ext]);
    bytesMap?.set(key, file.bytes); // the stamps' bytes, so resetSize reads them even once the record holds the reference form
    pictures.push({ key, name: file.name, size: fitted(size) });
  }
  if (!pictures.length) return [];
  const spots = rowAt(pictures.map((p) => p.size), at);
  const ids = [];
  api.store.change('Add picture', (tx) => {
    pictures.forEach((p, i) => ids.push(tx.create({ type: 'picture', media: p.key, crop: [0, 0, 0, 0],
      alt: p.name.replace(/\.[^.]+$/, ''), look: {}, x: spots[i].x, y: spots[i].y, w: p.size.w, h: p.size.h,
      at: [null, api.store.orderKey(null, api.store.children(null).length, tx)] })));
  });
  api.selection?.set(ids);
  return ids;
}

// The eight crop handles, as the document's picture tool names them.
const EDGES = [{ l: 1, t: 1 }, { t: 1 }, { r: 1, t: 1 }, { r: 1 }, { r: 1, b: 1 }, { b: 1 }, { l: 1, b: 1 }, { l: 1 }];
const handleAt = (f, h) => ({ x: h.l ? f.x : h.r ? f.x + f.w : f.x + f.w / 2, y: h.t ? f.y : h.b ? f.y + f.h : f.y + f.h / 2 });
const inside = (f, p) => p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h;

let picked = []; // the files the next click places ('image' mode)
let badge = null; // the placing count on the cursor
let bytesMap = null; // the board's media as bytes (BoardArea's map), for size reads after a save stores references
let crop = null; // {id, frame, src, crop, flips, rot, centre, drag} while cropping
let overlay = null; // its frame, handles and dimming, in the screen plane

/** World point `p` in the viewport's own pixels. */
function screenPoint(ctx, p) {
  const v = ctx.vp;
  const k = kOf(v.camera.zoom);
  return { left: (p.x - v.camera.x) * k, top: (p.y - v.camera.y) * k };
}

/** The styled rect of the upright `r` as the crop shows it: turned about the crop's centre, as the engine turns the stamp. */
function screenRect(ctx, r) {
  const k = kOf(ctx.vp.camera.zoom);
  const turnOf = turn([crop.centre.x, crop.centre.y], crop.rot);
  const [x, y] = turnOf([r.x + r.w / 2, r.y + r.h / 2]);
  const p = screenPoint(ctx, { x, y });
  return { left: `${p.left - (r.w * k) / 2}px`, top: `${p.top - (r.h * k) / 2}px`, width: `${r.w * k}px`, height: `${r.h * k}px`,
    transform: `rotate(${crop.rot}deg)` };
}

const div = (style) => {
  const el = document.createElement('div');
  Object.assign(el.style, { position: 'absolute', pointerEvents: 'none' }, style);
  return el;
};

function showOverlay(ctx) {
  const root = ctx.vp?.root;
  if (!root) return;
  const wrap = div({ inset: '0', zIndex: 6 });
  wrap.dataset.boardCrop = '';
  const dims = [0, 1, 2, 3].map(() => div({ background: 'rgba(0, 0, 0, 0.35)' }));
  const frame = div({ boxSizing: 'border-box', border: `1px solid ${ACCENT}` });
  const handles = EDGES.map(() => div({ width: '8px', height: '8px', marginLeft: '-4px', marginTop: '-4px',
    background: '#ffffff', border: `1px solid ${ACCENT}` }));
  wrap.append(...dims, frame, ...handles);
  root.append(wrap);
  overlay = { wrap, dims, frame, handles };
  paintOverlay(ctx);
}

function hideOverlay() {
  overlay?.wrap.remove();
  overlay = null;
}

/** The dimmed source, the visible frame and its handles, all turned as the picture is drawn. */
function paintOverlay(ctx) {
  if (!overlay || !crop || !ctx.vp) return;
  const s = crop.src;
  const f = crop.frame;
  const bands = [
    { x: s.x, y: s.y, w: s.w, h: Math.max(0, f.y - s.y) },
    { x: s.x, y: f.y + f.h, w: s.w, h: Math.max(0, s.y + s.h - (f.y + f.h)) },
    { x: s.x, y: f.y, w: Math.max(0, f.x - s.x), h: f.h },
    { x: f.x + f.w, y: f.y, w: Math.max(0, s.x + s.w - (f.x + f.w)), h: f.h },
  ];
  overlay.dims.forEach((el, i) => Object.assign(el.style, screenRect(ctx, bands[i])));
  Object.assign(overlay.frame.style, screenRect(ctx, f));
  const turnOf = turn([crop.centre.x, crop.centre.y], crop.rot);
  overlay.handles.forEach((el, i) => {
    const h = handleAt(f, EDGES[i]);
    const [x, y] = turnOf([h.x, h.y]);
    const p = screenPoint(ctx, { x, y });
    Object.assign(el.style, { left: `${p.left}px`, top: `${p.top}px` });
  });
}

/** The crop handle under world point `p`, in screen px, or null: the point is turned back into the picture's own frame, and a
 * turn keeps distances. */
function edgesAt(ctx, p) {
  const k = kOf(ctx.vp.camera.zoom);
  const at = upright(p);
  return EDGES.find((h) => {
    const corner = handleAt(crop.frame, h);
    return Math.hypot(corner.x - at.x, corner.y - at.y) * k <= REACH;
  }) ?? null;
}

/** World point `p` in the picture's own (unrotated) frame: the crop drags there, as the document's crop tool does. */
function upright(p) {
  const [x, y] = turn([crop.centre.x, crop.centre.y], -crop.rot)([p.x, p.y]);
  return { x, y };
}

/** Crop mode on picture `item`: its full source stamped un-cropped behind a dimmed surround, the visible box with handles.
 * The crop reads and writes in the picture's drawn orientation (flips swap its sides, flipCrop), and every turn is about the
 * visible box's centre, so the picture does not jump when the mode opens or the crop is committed. */
async function startCrop(ctx, item) {
  if (!ctx.vp) return;
  const box = boxOf(item, ctx.store);
  const frame = { x: box.x, y: box.y, w: box.w, h: box.h };
  const centre = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
  const flips = [!!item.flipX, !!item.flipY];
  const drawn = flipCrop(item.crop ?? [0, 0, 0, 0], ...flips);
  const src = sourceOf(frame, drawn);
  crop = { id: item.id, frame, src, crop: [...drawn], flips, rot: item.rot ?? 0, centre, drag: null,
    offCam: ctx.vp.subscribe?.('camera', () => paintOverlay(ctx)) };
  if (ctx.api.mode) ctx.api.setMode(null); // a double-click with a tool armed crops the picture, it does not place
  ctx.selection.set([item.id]);
  showOverlay(ctx);
  // The full picture is a stamp whose drawn box is centred on the rotation centre (the engine turns it about its page centre).
  const list = await ctx.surfaces.preview(item.id, { w: src.w, h: src.h, crop: [0, 0, 0, 0] }).catch(() => []);
  const stamp = list.find((s) => s?.ok);
  const place = stamp ? { x: r6(centre.x - stamp.ox - stamp.w / 2), y: r6(centre.y - stamp.oy - stamp.h / 2) } : { x: r6(src.x), y: r6(src.y) };
  const v = ctx.vp;
  if (v) v.setPlacements(placementsOf(ctx.store, ctx.surfaces, ctx.client.id, ctx, { [item.id]: place }));
}

/** Ends crop mode: `commit` writes the visible frame and crop in one step `Crop`, else the frame is dropped. */
async function endCrop(ctx, commit) {
  const c = crop;
  if (!c) return;
  crop = null;
  c.offCam?.();
  hideOverlay();
  if (commit) {
    const [left, top, right, bottom] = flipCrop(c.crop, c.flips[0], c.flips[1]);
    const { w, h } = c.frame;
    // The engine turns a box about its own centre; keeping that centre on the one the crop showed leaves the picture still.
    const at = c.rot % 360 ? { x: c.centre.x - w / 2, y: c.centre.y - h / 2 } : { x: c.frame.x, y: c.frame.y };
    ctx.store.change('Crop', (tx) => tx.patch(c.id, { x: r6(at.x), y: r6(at.y), w: r6(w), h: r6(h), crop: [left, top, right, bottom].map(r6) }));
  }
  const item = ctx.store.get(c.id);
  if (item && !item.gone) await ctx.surfaces.preview(c.id, {}).catch(() => {});
  const v = ctx.vp;
  if (v) v.setPlacements(placementsOf(ctx.store, ctx.surfaces, ctx.client.id, ctx));
}

/** The placing badge: `Place image` or the count, on the cursor while 'image' mode holds files. */
function showBadge(ctx) {
  const n = picked.length;
  const on = ctx.api?.mode === 'image' && n > 0 && !!ctx.vp;
  if (!on) {
    badge?.remove();
    badge = null;
    return;
  }
  badge ??= (() => {
    const el = div({ zIndex: 7, padding: '2px 6px', borderRadius: '4px', background: 'rgba(0, 0, 0, 0.75)', color: '#ffffff',
      font: '12px system-ui, sans-serif', whiteSpace: 'nowrap' });
    el.dataset.boardPlace = '';
    ctx.vp.root.append(el);
    return el;
  })();
  badge.textContent = n === 1 ? 'Place image' : `Place ${n} images`;
}

export default registerTool({
  id: 'pictures',
  modes: ['image'], // the placing tool PlaneBoard.setMode arms

  mount(ctx) {
    const follow = (e) => {
      const root = ctx.vp?.root;
      if (!root || !badge) return;
      const r = root.getBoundingClientRect();
      badge.style.transform = `translate(${e.clientX - r.left + 16}px, ${e.clientY - r.top + 16}px)`;
    };
    bytesMap = ctx.media ?? null;
    const offApi = ctx.api?.subscribe(() => {
      if (ctx.api.mode !== 'image') picked = []; // another tool armed: the files picked for placing are dropped
      showBadge(ctx);
    });
    const offStore = ctx.store.subscribe(() => {
      if (!crop) return;
      const item = ctx.store.get(crop.id);
      if (!item || item.gone || item.hidden) endCrop(ctx, false);
    });
    document.addEventListener('pointermove', follow);
    return () => {
      document.removeEventListener('pointermove', follow);
      offApi?.();
      offStore();
      crop?.offCam?.();
      crop = null;
      picked = [];
      bytesMap = null;
      hideOverlay();
      badge?.remove();
      badge = null;
    };
  },

  // Crop mode owns every press; 'image' mode arms the next click to place the picked files.
  pick(ctx) {
    if (crop) return { kind: 'crop' };
    if (ctx.api.mode === 'image' && picked.length) return { kind: 'picture-place' };
    return null;
  },

  down(ctx, hit, e) {
    if (hit?.kind !== 'picture-place' && (hit?.kind !== 'crop' || !crop)) return false; // not this tool's press
    const world = ctx.vp.fromClient(e.clientX, e.clientY).world;
    if (hit?.kind === 'picture-place') {
      const files = picked;
      picked = [];
      showBadge(ctx);
      ctx.api.setMode(null);
      addPictures(ctx.api, files, world).catch((err) => console.warn('The pictures were not placed', err));
      return true;
    }
    const edges = edgesAt(ctx, world);
    if (edges) {
      crop.drag = { edges, frame: crop.frame };
      return true;
    }
    if (inside(crop.frame, upright(world))) return true; // a press in the picture keeps the mode for Enter
    endCrop(ctx, true); // a click outside commits
    return true;
  },

  move(ctx, e) {
    if (!crop?.drag) return;
    const world = ctx.vp.fromClient(e.clientX, e.clientY).world;
    const { frame, crop: c } = dragCrop(crop.drag.frame, crop.src, crop.drag.edges, upright(world));
    crop.frame = frame;
    crop.crop = c;
    paintOverlay(ctx);
  },

  up() {
    if (crop) crop.drag = null;
  },

  cancel() {
    if (!crop) return;
    crop.drag = null;
  },

  dblclick(ctx, hit) {
    if (hit?.item?.type !== 'picture') return false;
    startCrop(ctx, hit.item).catch((err) => console.warn('The picture would not crop', err));
    return true;
  },

  keydown(ctx, e) {
    if (crop) {
      if (e.code === 'Escape') {
        endCrop(ctx, false);
        return true;
      }
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        endCrop(ctx, true);
        return true;
      }
      return false;
    }
    if (e.code === 'Escape' && ctx.api.mode === 'image') { // the picked files stay in memory with no tool to place them otherwise
      picked = [];
      showBadge(ctx);
      ctx.api.setMode(null);
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (keyAmong(['board.image'], e)) {
      ctx.api.pickImages();
      return true;
    }
    return false;
  },

  // Picture files dropped on the board's root; anything else (a .docx, say) is left to its own tool.
  drop(ctx, e) {
    const files = [...(e.dataTransfer?.files ?? [])].filter(isPicture);
    if (!files.length) return false;
    const v = ctx.vp;
    if (!v) return false;
    const at = v.fromClient(e.clientX, e.clientY).world;
    Promise.all(files.map(fileOf)).then((list) => addPictures(ctx.api, list, at)).catch((err) => console.warn('The pictures were not dropped', err));
    return true;
  },

  // A pasted screenshot or copied picture centred in the view (bd-clip hands over what carries no board token).
  paste(ctx, data) {
    const files = [...(data?.files ?? [])].filter(isPicture);
    if (!files.length) return false;
    Promise.all(files.map(fileOf)).then((list) => addPictures(ctx.api, list, ctx.api.visibleCentre()))
      .catch((err) => console.warn('The pictures were not pasted', err));
    return true;
  },

  methods: {
    /** The Add image dialog the rail uses; the picked files wait in 'image' mode for a click that places them. */
    pickImages() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = PICTURE_ACCEPT;
      input.multiple = true;
      input.addEventListener('change', async () => {
        const files = [...(input.files ?? [])].filter(isPicture);
        if (!files.length) {
          if (this.mode === 'image') this.setMode(null);
          return;
        }
        picked = await Promise.all(files.map(fileOf));
        this.setMode('image');
      });
      input.click();
    },

    /** The picture's own size (its visible region's, with a crop) at the same centre. */
    async resetSize() {
      const item = this.store.get(this.selection.ids[0]);
      if (!item || item.type !== 'picture') return;
      const bytes = bytesMap?.get(item.media) ?? mediaBytes(this.store.board.media, item.media);
      const size = bytes && await naturalSize(bytes, extOf('', item.media)).catch(() => null);
      if (!size) return;
      const [l, t, r, b] = item.crop ?? [0, 0, 0, 0];
      const w = r6(size.w * Math.max(1e-6, 1 - l - r));
      const h = r6(size.h * Math.max(1e-6, 1 - t - b));
      const cx = (item.x ?? 0) + (item.w ?? 0) / 2;
      const cy = (item.y ?? 0) + (item.h ?? 0) / 2;
      this.store.change('Reset size', (tx) => tx.patch(item.id, { x: r6(cx - w / 2), y: r6(cy - h / 2), w, h }));
    },

    /** The whole picture again at the current scale, anchored where its visible part was. */
    resetCrop() {
      const item = this.store.get(this.selection.ids[0]);
      if (!item || item.type !== 'picture') return;
      const [l, t, r, b] = item.crop ?? [0, 0, 0, 0];
      if (!l && !t && !r && !b) return;
      const w = r6((item.w ?? 0) / Math.max(1e-6, 1 - l - r));
      const h = r6((item.h ?? 0) / Math.max(1e-6, 1 - t - b));
      this.store.change('Reset crop', (tx) => tx.patch(item.id, { x: r6((item.x ?? 0) - l * w), y: r6((item.y ?? 0) - t * h), w, h, crop: [0, 0, 0, 0] }));
    },
  },
});
