// EMF and WMF pictures drawn by WordCraft's metafile reader (vendored here, README.md) built as WebAssembly. Plain web APIs
// only, so it runs in the Word reader's worker, on a page and in Node alike; any editor that shows a metafile can use it. The
// module's bytes are inlined (wasm-bytes.mjs), so it loads from file:// in Electron and from a web server the same way.
import * as glue from './wcmeta_bg.mjs';
import WASM from './wasm-bytes.mjs';

let ready = null;

/** The module's exports once instantiated, or null where WebAssembly cannot run (a page whose Content-Security-Policy lacks
 * 'wasm-unsafe-eval', say): the caller then treats every picture as one the reader cannot draw. */
function load() {
  ready ??= (async () => {
    const bytes = Uint8Array.from(atob(WASM), (c) => c.charCodeAt(0));
    // The module imports its glue under wasm-bindgen's name for it.
    const { instance } = await WebAssembly.instantiate(bytes, { './wcmeta_bg.js': glue });
    glue.__wbg_set_wasm(instance.exports);
    instance.exports.__wbindgen_start();
    return glue;
  })().catch((e) => {
    console.warn('The metafile reader could not start, so EMF and WMF pictures go to the fallback.', e);
    return null;
  });
  return ready;
}

/** True for an EMF whose drawing is in EMF+ records only: the record after its header is the EMF+ header (an EMR_COMMENT
 * holding "EMF+" and record 0x4001) without the dual flag (MS-EMFPLUS 2.3.3.3), so its GDI records do not hold the picture.
 * The reader reads GDI records only. */
export function emfPlusOnly(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 88 || v.getUint32(0, true) !== 1 || v.getUint32(40, true) !== 0x464d4520) return false;
  const at = v.getUint32(4, true);
  if (at + 20 > bytes.length || v.getUint32(at, true) !== 70 || v.getUint32(at + 12, true) !== 0x2b464d45) return false;
  return v.getUint16(at + 16, true) === 0x4001 && (v.getUint16(at + 18, true) & 1) === 0;
}

/** "ok WxH items paths bitmaps texts" (the picture's size in its own units, points for an EMF or placeable WMF) or "err <why>". */
export async function summary(bytes) {
  return (await load())?.summary(bytes) ?? 'err no WebAssembly';
}

/** `bytes` (an EMF or WMF) as an SVG data URL drawn over `w` x `h` CSS px (0: the picture's own size), stretched as Word
 * stretches a picture to its frame. Its natural size is twice that within 4096 px a side, as the system's PNGs had: crisp at
 * 200% and in a crop. Null when the reader cannot draw it (EMF+ only, unreadable) or WebAssembly cannot run here. */
export async function drawMetafile(bytes, w, h) {
  if (emfPlusOnly(bytes)) return null;
  const wc = await load();
  try {
    return wc?.svg_url(bytes, w, h, Math.min(2, 4096 / Math.max(w, h, 1))) ?? null;
  } catch {
    return null;
  }
}
