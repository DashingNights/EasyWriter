// The Font list of a Document (docs/plans/document.md Ribbon): the curated list (office.mjs FONTS), then the families installed
// on this machine from window.queryLocalFonts(). main grants the local-fonts permission, so the query needs no user gesture:
// actions.js start() runs it once in the background when the app is idle (the user, 2026-10-26: no lag spike when the list
// first opens), and the result is cached. Where it fails (no permission, another browser) the curated list is the whole list.
// The same query gives each installed face's file (FontData.blob()), from which fonts/metrics.mjs reads Word's line heights.
// The open fonts that stand in for missing ones (fonts/provider.mjs) join document.fonts here, when this module loads.
import { FONTS } from '../office.mjs';
import { entryOf, faceOf, fetchFamily, fontEvents, fontLabel as labelOf, install, loadFamily, standsFor } from './fonts/provider.mjs';

let faces = null; // the installed faces (FontData), from one query
let names = null; // their family and full names (Calibri Light is the full name of a Calibri face), once the query is in; null
// while it runs and after it fails (no permission; a plain browser that wants a user gesture), when nothing is known about them
let installed = null;
let ready = null; // the whole list once the query has finished

/** The harness's switch (plan.md §1.16): families the provider treats as not installed, drawn by their open substitutes. */
const hidden = () => globalThis.__wordTest?.fontsHidden ?? [];

if (typeof document !== 'undefined' && typeof FontFace !== 'undefined') {
  install(document.fonts, document.baseURI, hidden());
  // A download is network use the user sees: announced as it starts, and when it fails.
  const say = (msg, err) => import('../app/actions.js').then((m) => m.toast(msg, err));
  fontEvents.addEventListener('download', ({ detail: d }) => {
    const mb = Math.round(d.bytes / 1e6);
    say(`Downloading the open font ${d.family} (${standsFor(d.family)[0] ?? d.family}), ${mb} MB, from ${d.host}.`);
  });
  fontEvents.addEventListener('downloadFailed', ({ detail: d }) => say(`The font ${d.family} could not be downloaded. Text keeps its current font.`, true));
}

const query = () => (faces ??= Promise.resolve().then(() => window.queryLocalFonts()).then((all) => {
  names = new Set(all.flatMap((f) => [f.family, f.fullName]));
  return all;
}, () => []));

/** The font families to offer: the curated ones first, then the installed ones not among them. */
export function listFonts() {
  installed ??= query()
    .then((fonts) => [...new Set(fonts.map((f) => f.family))].filter((f) => !FONTS.includes(f)).sort((a, b) => a.localeCompare(b)))
    .then((more) => (ready = [...FONTS, ...more]));
  return installed;
}

/** The whole list when it is loaded, else the curated list (a Font box mounting after the startup query starts complete). */
export const fontsNow = () => ready ?? FONTS;

/** Whether the installed fonts are known: the query has succeeded. */
export const fontsKnown = () => names != null;

/** Whether `family` is installed here (false until the query is in, when it failed, and for a family the harness hides). */
export const isInstalled = (family) => !!names?.has(family) && !hidden().includes(family);

/** How lists and boxes name `family`: "Carlito (Calibri)" where an open font draws it (fonts/provider.mjs fontLabel), plainly while
 * the installed fonts are not known (the CSS stack still draws an installed font first). */
export const fontLabel = (family) => (names ? labelOf(family, isInstalled) : family);

const REGULAR = /^(regular|normal|roman|book)$/i;

/** The face of `family` in `style` (FontData.style, 'Regular' by default) whose file holds its metrics: the installed one (a FontData
 * whose blob() is the font file), else, for an open font of the provider's catalogue, its regular face, which this loads (and on its
 * first need downloads) so that the editor draws it; null where neither exists. A CSS family that names one face of a larger family
 * (Calibri Light, whose FontData.family is Calibri) is that face, by its full name. */
export async function localFace(family, style = 'Regular') {
  const all = await query();
  if (!hidden().includes(family)) {
    const own = all.filter((f) => f.family === family);
    const face = own.length
      ? own.find((f) => f.style === style) ?? (style === 'Regular' ? own.find((f) => REGULAR.test(f.style)) : null) ?? own[0]
      : all.find((f) => f.fullName === family);
    if (face) return face;
  }
  const e = entryOf(family);
  if (!e || (e.kind === 'download' && !(await fetchFamily(e)))) return null;
  loadFamily(family);
  return faceOf(e);
}
