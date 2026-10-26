// The Font list of a Document (docs/plans/document.md Ribbon): the curated list (office.mjs FONTS), then the families installed
// on this machine from window.queryLocalFonts(). main grants the local-fonts permission, so the query needs no user gesture:
// actions.js start() runs it once in the background when the app is idle (the user, 2026-10-26: no lag spike when the list
// first opens), and the result is cached. Where it fails (no permission, another browser) the curated list is the whole list.
import { FONTS } from '../office.mjs';

let installed = null;
let ready = null; // the whole list once the query has finished

/** The font families to offer: the curated ones first, then the installed ones not among them. */
export function listFonts() {
  installed ??= Promise.resolve()
    .then(() => window.queryLocalFonts())
    .then((fonts) => [...new Set(fonts.map((f) => f.family))].filter((f) => !FONTS.includes(f)).sort((a, b) => a.localeCompare(b)))
    .catch(() => [])
    .then((more) => (ready = [...FONTS, ...more]));
  return installed;
}

/** The whole list when it is loaded, else the curated list (a Font box mounting after the startup query starts complete). */
export const fontsNow = () => ready ?? FONTS;
