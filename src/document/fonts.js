// The Font list of a Document (docs/plans/document.md Ribbon): the curated list (office.mjs FONTS), then the families installed
// on this machine from window.queryLocalFonts(). That needs a user gesture, so it runs on the first open of the list (a press)
// and is cached; where it fails (no permission, another browser) the curated list is the whole list.
import { FONTS } from '../office.mjs';

let installed = null;

/** The font families to offer: the curated ones first, then the installed ones not among them. */
export function listFonts() {
  installed ??= Promise.resolve()
    .then(() => window.queryLocalFonts())
    .then((fonts) => [...new Set(fonts.map((f) => f.family))].filter((f) => !FONTS.includes(f)).sort((a, b) => a.localeCompare(b)))
    .catch(() => []);
  return installed.then((more) => [...FONTS, ...more]);
}
