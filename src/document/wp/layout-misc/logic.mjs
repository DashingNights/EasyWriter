// The pure parts of line numbers, hyphenation and drop caps (briefs/layout-misc.md): which line gets which number, where the
// automatic hyphenation breaks a paragraph, and the attributes the dialogs write. The editor side (index.js) measures and draws.

const clamp = (v, lo, hi, d) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, +v)) : d);

// ---------- line numbers ----------

/** What Word turns on from the menu (m): Start at 1, From text Auto, Count by 1, Restart each page. */
export const LN_DEFAULTS = Object.freeze({ countBy: 1, start: 1, distance: 0, restart: 'newPage' });
export const RESTARTS = ['newPage', 'newSection', 'continuous'];

/** sect.lnNum from the Line Numbers dialog's values ({on, start, distance (pt, null or 0 = Auto), countBy, restart}), clamped to Word's
 * limits (Start at 1 to 32767, From text 0 to 1584 pt, Count by 1 to 100) → the object, or null when Add line numbering is off. */
export function lnNumOf(v) {
  if (!v?.on) return null;
  return {
    countBy: Math.round(clamp(v.countBy, 1, 100, 1)),
    start: Math.round(clamp(v.start, 1, 32767, 1)),
    distance: clamp(v.distance, 0, 1584, 0),
    restart: RESTARTS.includes(v.restart) ? v.restart : 'newPage',
  };
}

/** The number of each line. `lines` in document order: {page, section, suppressed}; `lnNums[section]` is that section's lnNum or null.
 * → per line {n, show} or null (not counted: no numbering in its section, or a suppressed paragraph). A count restarts at `start`
 * on the first counted line of a section that restarts each section, of a page that restarts each page, and on the first counted
 * line overall; `show` is true for multiples of countBy. */
export function numberLines(lines, lnNums) {
  let n = 0;
  let prev = null; // the last counted line
  return lines.map((line) => {
    const ln = lnNums[line.section];
    if (!ln || line.suppressed) return null;
    const restart = !prev || (ln.restart === 'newPage' && line.page !== prev.page)
      || (ln.restart !== 'continuous' && line.section !== prev.section);
    n = restart ? ln.start ?? 1 : n + 1;
    prev = line;
    return { n, show: n % (ln.countBy || 1) === 0 };
  });
}

/** From text in px for a section: its distance, or Word's Auto (0.25 in, 0.13 in with columns). */
export const lnDistancePx = (ln, columns = false) => (ln?.distance > 0 ? ln.distance : columns ? 9.36 : 18) * (96 / 72);

// ---------- hyphenation ----------

/** The letters of `token` and where they start: a word with leading and trailing punctuation keeps only its letters; a token with
 * other characters inside (digits, hyphens, apostrophes) → null, since Word leaves those alone. */
export function coreOf(token) {
  const m = /^([^A-Za-z]*)([A-Za-z]+)([^A-Za-z]*)$/.exec(token);
  return m && !/[A-Za-z0-9]/.test(m[1] + m[3]) ? { at: m[1].length, word: m[2] } : null;
}

/** Whether a word may be hyphenated under the document's CAPS rule (Hyphenate words in CAPS off skips all-capital words). */
export const capsAllowed = (word, caps) => caps || word !== word.toUpperCase();

/** Where automatic hyphenation breaks one paragraph, from its words measured without hyphens (greedy line filling, as the browser
 * lays text out). `words`: [{w (px), space (px after it), breaks: [{k (letter offset in the token), w (px before the break)}]}];
 * `widths`: [first line px, other lines px]; `hyphen`: the hyphen's px; `zone`: px; `limit`: the consecutive hyphen limit (0 = none).
 * A word that does not fit is hyphenated only when the gap it leaves at the right edge is wider than the zone, the limit allows another
 * hyphenated line, and some break fits with its hyphen; it takes the last such break. → {breaks: [{word, k, line (the one it ends)}], lines} */
export function planBreaks(words, { widths, hyphen = 0, zone = 0, limit = 0 }) {
  const out = [];
  let line = 0;
  let used = 0; // px on the current line, without the trailing space
  let run = 0; // hyphenated lines in a row up to this one
  let gapBefore = 0; // the space after the previous word on this line
  const avail = () => (line ? widths[1] : widths[0]);
  words.forEach((wd, i) => {
    const sp = used ? gapBefore : 0;
    if (!used || used + sp + wd.w <= avail() + 0.01) {
      used += sp + wd.w;
    } else {
      const gap = avail() - used;
      const fit = gap > zone && (!limit || run < limit)
        ? wd.breaks.filter((b) => used + sp + b.w + hyphen <= avail() + 0.01).at(-1) : null;
      line++;
      if (fit) {
        out.push({ word: i, k: fit.k, line: line - 1 });
        run++;
        used = wd.w - fit.w;
      } else {
        run = 0;
        used = wd.w;
      }
    }
    gapBefore = wd.space;
  });
  return { breaks: out, lines: line + 1 };
}

// ---------- drop caps ----------

export const DROP_KINDS = { none: null, dropped: 'drop', inMargin: 'margin' };

/** The frame patch the Drop Cap dialog's values write ({position: 'none'|'drop'|'margin', lines, distance (pt)}): Lines to drop 1 to 10
 * (default 3), Distance from text 0 to 1584 pt (default 0). None clears the drop cap keys and keeps any other frame keys (float-layout's).
 * → a patch for setParaProps' frame merge. */
export function dropCapPatch({ position, lines, distance } = {}) {
  if (position !== 'drop' && position !== 'margin') return { dropCap: null, lines: null, hSpace: null };
  return { dropCap: position, lines: Math.round(clamp(lines, 1, 10, 3)), hSpace: clamp(distance, 0, 1584, 0) };
}

/** The frame attribute after `patch` (null keys removed; nothing left → null), as setParaProps merges it. */
export function patchFrame(old, patch) {
  const next = { ...(old ?? {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
  return Object.keys(next).length ? next : null;
}
