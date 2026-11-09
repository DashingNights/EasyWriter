// Picture Format's editing helpers: the picture the tools act on (ctx.obj, plan.md §1.3), attribute writes that keep it selected
// (AttrStep, so a NodeSelection survives), JSON attributes patched rather than rebuilt (§1.8), picture sources (the IPC file pick
// and clipboard, §1.17) and inserting a picture from a data URL through the app's own picture insert.
import { NodeSelection } from '@tiptap/pm/state';
import { resolveColor } from '../../../office.mjs';
import { addImageFilesToEditor, columnWidth, dataUrlOf, pictureSize } from '../../../whiteboard.js';
import { THEME } from '../../defaults.mjs';
import { readTheme } from '../styles/engine.mjs';
import { metafilePicture } from '../../../tooling/metafile.mjs';

/** The picture or graphic the contextual tabs act on → {kind, pos, node} or null. */
export const picOf = (ctx) => (ctx?.obj && (ctx.obj.kind === 'picture' || ctx.obj.kind === 'graphic') ? ctx.obj : null);
export const hasPic = (ctx) => !!picOf(ctx);
export const noPic = (ctx) => (hasPic(ctx) ? null : 'Select a picture first.');

/** Sets `attrs` ({name: value}) on the node at `pos` of `editor` in one transaction (one undo step), keeping it selected. */
export function setAttrs(editor, pos, attrs) {
  if (!editor || editor.isDestroyed) return false;
  const { state } = editor.view;
  const node = state.doc.nodeAt(pos);
  if (!node) return false;
  const tr = state.tr;
  for (const [k, v] of Object.entries(attrs)) if (k in node.attrs) tr.setNodeAttribute(pos, k, v);
  if (!tr.docChanged) return false;
  if (state.selection instanceof NodeSelection && state.selection.from === pos) tr.setSelection(NodeSelection.create(tr.doc, pos));
  editor.view.dispatch(tr);
  return true;
}

/** `old` with `patch` merged in: null values remove their key, and an object left empty is null. */
export function merged(old, patch) {
  const out = { ...(old ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) delete out[k];
    else out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Patches the JSON attribute `key` of the selected picture with `patch` (null values remove keys). */
export function patchPic(ctx, key, patch) {
  const p = picOf(ctx);
  if (!p) return false;
  return setAttrs(ctx.target, p.pos, { [key]: merged(p.node.attrs[key], patch) });
}

/** Sets plain attributes of the selected picture. */
export function setPic(ctx, attrs) {
  const p = picOf(ctx);
  return !!p && setAttrs(ctx.target, p.pos, attrs);
}

/** The document theme's colour of `slot` (with `lum`) → '#RRGGBB': on a canvas draft the draft's own (document.settings), the one
 * canvas/rows/objects.mjs applies the picked colour in, so a swatch shows the colour it gives. */
export function themeHex(ctx, slot, lum = 0) {
  if (ctx?.engine) return resolveColor(readTheme(ctx), { slot, lum });
  const t = ctx?.state?.doc.attrs.theme;
  return resolveColor(t?.colors ? t : THEME, { slot, lum });
}

/** A loaded HTMLImageElement of `src`. */
export const loaded = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

/** A picture's natural size → Promise {w, h} (0 x 0 when it does not load). */
export const natural = (src) => loaded(src).then((img) => ({ w: img.naturalWidth, h: img.naturalHeight }), () => ({ w: 0, h: 0 }));

/** Picture `src` drawn as a PNG data URL of `w` x `h` px, for a model that holds only pictures a page and Word both show (a
 * watermark, a page fill, a picture bullet): a metafile's drawing goes in this way. */
export async function pngOf(src, w, h) {
  const img = await loaded(src);
  const c = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

/** Picture file `file` → {src (a data URL a page and Word both show), metafile (an EMF or WMF's original, else null)}, or null
 * when it cannot be read. A metafile (told from its header) becomes a PNG of the reader's drawing at its own size, at most `max`
 * px a side; any other picture stays the file it is. */
export async function shownPicture(file, max = Infinity) {
  try {
    const m = await metafilePicture(new Uint8Array(await file.arrayBuffer()), { name: file.name });
    if (!m) return { src: await dataUrlOf(file), metafile: null };
    const n = m.w ? m : await natural(m.src);
    const s = Math.min(1, max / Math.max(n.w, n.h));
    return { src: await pngOf(m.src, n.w * s, n.h * s), metafile: m.metafile };
  } catch {
    return null;
  }
}

/** `n` ({w, h}) at most the text width at `editor`'s selection wide, as an inserted picture is (whiteboard.js pictureSize). */
export function capped(n, editor) {
  const s = pictureSize(n, editor?.view ? columnWidth(editor.view) : Infinity);
  return { w: s.width, h: s.height };
}

// Services a harness case may stub (plan.md §1.16): window.api from contextBridge cannot be overwritten in the page.
const word = () => window.api?.word ?? {};
export const clipboardApi = () => globalThis.__wordTest?.clipboard ?? word().clipboard;
export const openFileApi = (opts) => (globalThis.__wordTest?.openFile ?? word().openFile)?.(opts) ?? Promise.resolve(null);
export const captureApi = (opts) => (globalThis.__wordTest?.captureSources ?? word().captureSources)?.(opts) ?? Promise.resolve([]);

// EMF and WMF come in as themselves (image/x-emf, image/x-wmf, as a .docx keeps them): the insert draws them (whiteboard.js readImage).
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
  ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif', emf: 'image/x-emf', wmf: 'image/x-wmf' };
export const PICTURE_FILTERS = [{ name: 'Pictures', extensions: Object.keys(MIME) }];

/** Asks for a picture file through the main process (api.word.openFile) → {src, name} or null. `svg` limits it to SVG files. */
export async function pickPicture({ svg = false } = {}) {
  const filters = svg ? [{ name: 'SVG pictures', extensions: ['svg'] }] : PICTURE_FILTERS;
  const r = await openFileApi({ filters, as: 'base64' });
  if (!r?.data) return null;
  const ext = String(r.name ?? '').split('.').pop().toLowerCase();
  return { src: `data:${MIME[ext] ?? 'image/png'};base64,${r.data}`, name: r.name ?? null };
}

/** Inserts the picture `src` at the caret of `editor` through the app's picture insert (capped to the text width, never replacing a
 * node-selected block), then records its size as orig and gives it `wrap` (settings.word.paste.pictures) when that is not inline. */
export async function insertPicture(editor, src, { name = 'Picture', wrap = 'inline' } = {}) {
  if (!editor || editor.isDestroyed) return false;
  // Decoded by hand: the page's content security policy refuses fetch() of data URLs.
  const [, type = 'image/png', b64, data = ''] = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src) ?? [];
  const bytes = b64 ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(data));
  const file = new File([bytes], name, { type });
  await addImageFilesToEditor(editor, [file]);
  const { state } = editor;
  const $h = state.selection.$head;
  const node = $h.nodeBefore;
  if (node?.type.name !== 'image') return true;
  const pos = $h.pos - node.nodeSize;
  setAttrs(editor, pos, { orig: { w: node.attrs.width, h: node.attrs.height }, ...(wrap && wrap !== 'inline' && { layout: { wrap } }) });
  return true;
}
