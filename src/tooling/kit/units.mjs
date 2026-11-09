// Lengths in the dialog kit (docs/plans/word/plan.md §1.6). Pure: the model keeps points; a dialog shows and reads them in the
// user's unit, as Word does (Options > Advanced > Show measurements in units of), and accepts any unit typed with its suffix.

/** Points per unit. */
export const UNITS = { in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pt: 1, pi: 12 };

// Word's limits in points for each kind of length box (plan.md §1.6).
export const LIMITS = { indent: [-1584, 1584], spacing: [0, 1584], lineExact: [0.7, 1584], lineMultiple: [0.06, 132], page: [7.2, 1584],
  margin: [-1584, 1584], gutter: [0, 1584], tab: [-1584, 1584] };

// Word follows the Windows region, not the paper: inches in the United States, Liberia and Myanmar, centimetres elsewhere.
const INCH_REGIONS = /(^|[-_])(US|LR|MM)$/i;

/** The unit dialogs show: `settings`.word.units, else `profile`.defaults.units, else the region's ('in' or 'cm', api.word.region();
 * a locale such as 'en-US' works too). */
export function unitOf(settings, profile, region) {
  const own = settings?.word?.units ?? profile?.defaults?.units;
  if (own in UNITS) return own;
  return region === 'in' || INCH_REGIONS.test(region ?? '') ? 'in' : 'cm';
}

// A typed suffix → its unit. Word also takes "li" (lines) in the spacing boxes and the inch mark.
const SUFFIX = { '"': 'in', in: 'in', inch: 'in', inches: 'in', cm: 'cm', mm: 'mm', pt: 'pt', pi: 'pi', li: 'li', line: 'li', lines: 'li' };

/** Typed `text` ('2.54 cm', '1"', '12', '1.5 li') read as points, a bare number in `unit`. With `lines`, a length in lines comes back as
 * {lines: n}. → points, {lines}, or null when it is no length. */
export function parseLength(text, unit, { lines = false } = {}) {
  const m = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*("|[a-z]+)?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2] ? SUFFIX[m[2].toLowerCase()] : unit;
  if (u === 'li') return lines ? { lines: n } : null;
  return u in UNITS ? n * UNITS[u] : null;
}

/** Points `pt` in `unit` as Word shows them, rounded to `digits` places: '2.54 cm', '1"', '12 pt'. */
export function formatLength(pt, unit, digits = 2) {
  const n = Number((pt / UNITS[unit]).toFixed(digits));
  return unit === 'in' ? `${n}"` : `${n} ${unit}`;
}
