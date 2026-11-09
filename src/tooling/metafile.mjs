// EMF and WMF pictures wherever a picture comes in (docs/plans/word/briefs/metafile-everywhere.md): the .docx import (pictures,
// picture bullets, pictures in drawing canvases and groups) and a file inserted, pasted or dropped in a Document, a forum post, a
// canvas, a board or a flowchart. Each draws through WordCraft's metafile reader (src/vendor/wordcraft-metafile, WebAssembly); one
// the reader cannot draw (EMF+ only, unreadable) goes to the system's renderer (window.api.word.metafiles: GDI+ on the desktop),
// and where there is none it shows a box of its size naming it. The caller keeps the original where its model can hold it, so
// export writes it back. Plain web APIs: it runs in the import's worker, on a page and in Node.
import { drawMetafile, summary } from '../vendor/wordcraft-metafile/index.mjs';
import { base64, bytesOf } from './base64.mjs';

/** A metafile's data URL, as the import and the insert paths keep the original. */
export const METAFILE = /^data:image\/x-(emf|wmf);base64,/;

/** File name endings of metafiles, for pickers and drops whose system gives such a file no image type. */
export const METAFILE_NAME = /\.(emf|wmf)$/i;

/** What a picture file input accepts: every image type, and metafiles by name. */
export const PICTURE_ACCEPT = 'image/*,.emf,.wmf';

/** 'emf' or 'wmf' when `bytes` (at least their first 44) start as one, read from the header rather than a name or type: an EMF
 * header record with its " EMF" signature, a placeable WMF's key, or a WMF header in memory or on disk (9 words, version 1 or 3). */
export function metafileKind(bytes) {
  if (!(bytes?.length >= 18)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 44 && v.getUint32(0, true) === 1 && v.getUint32(40, true) === 0x464d4520) return 'emf';
  if (v.getUint32(0, true) === 0x9ac6cdd7) return 'wmf';
  return [1, 2].includes(v.getUint16(0, true)) && v.getUint16(2, true) === 9 && [0x100, 0x300].includes(v.getUint16(4, true)) ? 'wmf' : null;
}

const xmlEsc = (s) => String(s).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** A light box of `w` x `h` px naming `label`: a metafile nothing could draw. */
export const placeholder = (w, h, label) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
  + `<rect x="0.5" y="0.5" width="${Math.max(0, w - 1)}" height="${Math.max(0, h - 1)}" fill="#f4f4f4" stroke="#c8c8c8"/>`
  + `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="12" fill="#707070">${xmlEsc(label)}</text></svg>`)}`;


/**
 * Metafiles `items` ([{data (base64), w, h (CSS px; 0: the picture's own size), label}]) → what each shows, in order: the reader's
 * SVG; else `convert`'s PNG ([{data, w, h}] → [PNG data URL | null]: GDI+ through window.api on the desktop, absent in the web
 * app and in Node); else a placeholder of its size (200 x 150 px without one) naming `label`.
 */
export async function drawMetafiles(items, convert) {
  const drawn = await Promise.all(items.map((it) => drawMetafile(bytesOf(it.data), it.w, it.h)));
  const rest = items.filter((_, i) => !drawn[i]);
  let pngs = [];
  try {
    if (rest.length) pngs = (await convert?.(rest.map(({ data, w, h }) => ({ data, w, h })))) ?? [];
  } catch { /* the placeholders below */ }
  let j = 0;
  return items.map((it, i) => {
    if (drawn[i]) return drawn[i];
    const png = pngs[j++];
    return typeof png === 'string' && png.startsWith('data:image/png;base64,') ? png : placeholder(it.w || 200, it.h || 150, it.label);
  });
}

/** A metafile's bytes, from the bytes themselves or any base64 data URL whose header is one (a server or a drop may type it
 * image/emf, image/x-emf or something else); null for anything else. Only the head is decoded to tell. */
const bytesFrom = (src) => {
  if (typeof src !== 'string') return src ?? null;
  const at = /^data:[^,]*;base64,/.exec(src)?.[0].length;
  return at && metafileKind(bytesOf(src.slice(at, at + 60))) ? bytesOf(src.slice(at)) : null;
};

/**
 * Metafile `src` (its bytes or data URL) → its own size in CSS px ({w, h}), or null when the reader cannot read it. An EMF's frame
 * and a placeable WMF's box are in points, at 96 dpi. A WMF without the placeable header names no unit, so its logical units count
 * as px, as GDI's default mapping (MM_TEXT) plays them; the inserts cap such a picture to the width they have.
 */
export async function metafileSize(src) {
  const bytes = bytesFrom(src);
  const kind = bytes && metafileKind(bytes);
  const size = kind && /^ok ([\d.]+)x([\d.]+)/.exec(await summary(bytes));
  if (!size) return null;
  const inPoints = kind === 'emf' || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === 0x9ac6cdd7;
  const [w, h] = [size[1], size[2]].map((n) => Math.round(n * (inPoints ? 400 / 3 : 100)) / 100);
  return { w, h };
}

/**
 * Picture file `bytes` → {src (what shows), w, h (the picture's own size in CSS px, metafileSize; 0 when the reader cannot read
 * it), metafile (the original as a data URL)} when they are an EMF or WMF, else null.
 */
export async function metafilePicture(bytes, { name = '', convert = globalThis.window?.api?.word?.metafiles } = {}) {
  const kind = metafileKind(bytes);
  if (!kind) return null;
  const { w, h } = (await metafileSize(bytes)) ?? { w: 0, h: 0 };
  const data = base64(bytes);
  const [src] = await drawMetafiles([{ data, w, h, label: name || `Picture (${kind.toUpperCase()})` }], convert);
  return { src, w, h, metafile: `data:image/x-${kind};base64,${data}` };
}

/** A picture's data URL → its metafilePicture when it is an EMF or WMF, else null. */
export const metafileOfUrl = (src, opts) => {
  const bytes = bytesFrom(src ?? '');
  return bytes ? metafilePicture(bytes, opts) : Promise.resolve(null);
};
