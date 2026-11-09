// Word's fonts from legal sources (docs/plans/word/briefs/font-provider.md). A family a document names draws with the installed font
// when this computer has it, else with an open font whose metrics match it, so lines and pages break as in Word. office.mjs
// FALLBACKS is the order the CSS stack tries; this catalogue says where each open font comes from, its licence and version, and the
// Word fonts it matches. The matches were checked on 2026-10-30 against the installed fonts: the same advance widths over Latin,
// Greek and Cyrillic and the same single line (fonts/metrics.mjs).
// No Microsoft font is bundled, served or downloaded here. Aptos reaches the user only through Microsoft's own page (VENDOR), which
// the app opens for them; the app uses it once it is installed.
// Plain web APIs (FontFace, fetch, Cache Storage), so the page, the layout worker and the later web app share it.
import { FALLBACKS } from '../../office.mjs';
import { BUNDLED, CATALOGUE } from '../../engine/fonts/catalogue.mjs';

// The open fonts' catalogue lives with the engine's font sources, which may not import from here: the engine stays plain web code
// that runs without the app (viewport-design.md section 3).
export { BUNDLED, CATALOGUE };

/** The vendor's own download page for fonts it gives away but does not let others share: Microsoft's Aptos Fonts (Download Center
 * 106087, "for use in applications that do not have access to the Office Font Service"). */
export const VENDOR = [{ test: /^Aptos( |$)/, name: 'Microsoft Aptos Fonts', url: 'https://www.microsoft.com/download/details.aspx?id=106087' }];

const byFamily = new Map(CATALOGUE.map((e) => [e.family, e]));
/** The catalogue entry of open font `family`, or null. */
export const entryOf = (family) => byFamily.get(family) ?? null;
/** The vendor page that offers `family`, or null. */
export const vendorOf = (family) => VENDOR.find((v) => v.test.test(family)) ?? null;
/** The families tried for `family`, in office.mjs fontStack's order. */
export const chainOf = (family) => [family, ...(FALLBACKS[family] ?? [])];
/** The Word fonts open font `family` stands in for (whose FALLBACKS name it). */
export const standsFor = (family) => Object.keys(FALLBACKS).filter((k) => FALLBACKS[k].includes(family));

/** What draws `family` on this computer, `installed(f)` saying whether family f is installed: {font (the family that draws, or null:
 * the browser's generic font), kind ('installed', 'bundled', 'download' or null), entry (the open font's), metric (whether lines
 * break as with `family` itself)}. */
export function resolve(family, installed) {
  for (const f of chainOf(family)) {
    if (installed(f)) return { font: f, kind: 'installed', entry: null, metric: f === family };
    const entry = entryOf(f);
    if (entry) return { font: f, kind: entry.kind, entry, metric: entry.matches.includes(family) };
  }
  return { font: null, kind: null, entry: null, metric: false };
}

/** How the app names `family` (the user, 2026-10-30): the font that draws it first and the one it stands in for in brackets,
 * "Carlito (Calibri)"; an installed font, or one nothing stands in for, plainly. The document keeps the family it names. */
export function fontLabel(family, installed) {
  const { font } = resolve(family, installed);
  return font && font !== family ? `${font} (${family})` : family;
}

/** The fonts doc names (a ProseMirror doc), as Word's Font Substitution lists them: its theme's (Latin and East Asian), and its
 * styles' and runs' Latin, East Asian and complex-script fonts (font, fontEA, fontCS), theme references resolved. */
export function docFonts(doc) {
  const fonts = doc.attrs.theme?.fonts ?? {};
  const major = fonts.major ?? 'Aptos Display';
  const minor = fonts.minor ?? 'Aptos';
  const out = new Set([major, minor]);
  // An East Asian theme reference names the theme's East Asian font where it has one (an empty typeface: none).
  const add = (f, ea) => f && out.add(f === '+major' ? (ea && fonts.majorEA) || major : f === '+minor' ? (ea && fonts.minorEA) || minor : f);
  const run = (r) => { add(r?.font); add(r?.fontEA, true); add(r?.fontCS); };
  add(fonts.majorEA);
  add(fonts.minorEA);
  const styles = doc.attrs.styles;
  for (const s of [styles?.defaults, ...Object.values(styles?.list ?? {})]) run(s?.run);
  doc.descendants((n) => {
    run(n.attrs?.markRun);
    for (const m of n.marks) if (m.type.name === 'textStyle') run(m.attrs);
  });
  return [...out];
}

// ---------- Loading (FontFace) ----------
/** 'faces' once more of the provider's faces have loaded (the layout worker follows); 'download' {family, bytes, host} as a download
 * starts, 'downloadFailed' {family} when one fails. */
export const fontEvents = new EventTarget();
const emit = (type, detail) => fontEvents.dispatchEvent(new CustomEvent(type, { detail }));
const faces = new Map(); // family|weight|style → {face, desc: {family, src, weight, style}}
let set = null; // the FontFaceSet the faces go into
let root = ''; // the app's base URL

const keyOf = (d) => `${d.family}|${d.weight}|${d.style}`;
// The bundled fonts cover Latin, Greek and Cyrillic, so they claim nothing from the CJK blocks on (U+2E80) or the full-width forms:
// Chinese text in a Calibri run then falls back past Carlito without loading it.
const WESTERN = 'U+0000-2E7F, U+A640-A7FF, U+FB00-FB4F, U+FE00-FE2F, U+FFF0-FFFF';
const urlOf = (f) => f.url ?? new URL(BUNDLED + f.file, root).href;

function add(family, f, source = `url("${urlOf(f)}")`) {
  const desc = { family, src: urlOf(f), weight: f.weight, style: f.style, unicodeRange: f.file ? WESTERN : 'U+0-10FFFF' };
  if (faces.has(keyOf(desc))) return faces.get(keyOf(desc)).face;
  const face = new FontFace(family, source, { weight: f.weight, style: f.style, unicodeRange: desc.unicodeRange });
  set.add(face);
  faces.set(keyOf(desc), { face, desc });
  // The browser loads a face when text first needs it; its family's other faces follow, so the worker can measure bold and italic
  // runs the editor has not drawn yet.
  face.loaded.then(() => Promise.allSettled(loadFamily(family)).then(() => emit('faces')), () => {});
  return face;
}

/** Adds every bundled face to FontFaceSet `fontSet` (document.fonts), sourced from the app's base URL `base`; nothing is read until
 * text needs a face. `hidden`, the harness's switch: families treated as not installed, each drawn under its own name by the first
 * open font of its chain (only where every family before that font is hidden too). */
export function install(fontSet, base, hidden = []) {
  set = fontSet;
  root = base;
  for (const e of CATALOGUE) if (e.kind === 'bundled') for (const f of e.faces) add(e.family, f);
  for (const h of hidden) {
    const chain = chainOf(h);
    const at = chain.findIndex((f) => entryOf(f));
    if (at < 0 || chain.slice(0, at).some((f) => !hidden.includes(f)) || entryOf(chain[at]).kind !== 'bundled') continue;
    for (const f of entryOf(chain[at]).faces) add(h, f).load().catch(() => {});
  }
}

/** Starts loading every added face of `family` → their loaded promises. */
export function loadFamily(family) {
  const out = [];
  for (const { face, desc } of faces.values()) {
    if (desc.family !== family) continue;
    if (face.status === 'unloaded') face.load().catch(() => {});
    out.push(face.loaded);
  }
  return out;
}

/** The provider's faces that have loaded, as the layout worker adds them: [{family, src, weight, style}]. */
export const loadedFaces = () => [...faces.values()].filter(({ face }) => face.status === 'loaded').map(({ desc }) => desc);

const CACHE = 'easywriter-fonts';
const downloads = new Map(); // family → a promise of whether its faces are in

/** Fetches download-kind entry `e` on its first need: from Cache Storage (the same in Electron and a browser) when an earlier session
 * downloaded it, else from its official source, announced by fontEvents 'download'. → a promise of true once its faces are in the
 * set, false when the download fails (the browser's own fallback keeps drawing). */
export function fetchFamily(e) {
  let p = downloads.get(e.family);
  if (!p) {
    p = (async () => {
      const cache = await caches.open(CACHE);
      for (const f of e.faces) {
        let res = await cache.match(f.url);
        if (!res) {
          emit('download', { family: e.family, bytes: f.bytes, host: new URL(f.url).host });
          res = await fetch(f.url);
          if (!res.ok) throw new Error(`${f.url}: ${res.status}`);
          await cache.put(f.url, res.clone());
        }
        await add(e.family, f, await res.arrayBuffer()).load(); // add() announces 'faces'
      }
      return true;
    })().catch((err) => {
      downloads.delete(e.family); // a later need tries again
      emit('downloadFailed', { family: e.family, error: String(err?.message ?? err) });
      return false;
    });
    downloads.set(e.family, p);
  }
  return p;
}

/** The regular face of open font `e` as fonts/metrics.mjs reads an installed one (a FontData's postscriptName and blob()). */
export function faceOf(e) {
  const f = e.faces.find((x) => x.style === 'normal') ?? e.faces[0];
  const src = urlOf(f);
  return { postscriptName: src, blob: () => (e.kind === 'download' ? caches.match(src) : fetch(src)).then((r) => r.blob()) };
}
