// Word's tab stop rules as pure functions (docs/plans/word/plan.md §3 tabs, index-layout.md "Tab stops"). Every length is in
// points in the text column's coordinates: 0 is the column's left edge (the left margin, a column's or a table cell's text edge),
// never the paragraph's indent, as Word measures stops. The DOM pass (measure.js) reads pens and segment widths and asks these
// functions where each tab ends; Node tests drive them with the measured cases. Pure: no DOM.

// Word compares positions in twips; a measured pen lands a hair either side of the stop it was set to, so "strictly past the pen"
// allows this much.
const EPS = 0.1;

/** The Tabs dialog's five leaders in order (probe/dialogs/tabs.json: 1 None, 2 dots, 3 hyphens, 4 underscore, 5 middle dots). */
export const DIALOG_LEADERS = ['none', 'dot', 'hyphen', 'underscore', 'middleDot'];

/** The stops a tab can go to: `stops` without bar and clear entries (a bar is drawn, never a stop). */
const realStops = (stops) => (stops ?? []).filter((s) => s.align !== 'bar' && s.align !== 'clear');

/** The stop a tab at `pen` goes to on a line: the first custom stop past the pen; on a first line that starts left of the left
 * indent, the left indent (the hanging stop, with the default stops before it ignored); else the next default stop after the pen
 * and after the last custom stop (a custom stop removes the defaults to its left).
 * `c` = {stops, def, left, lineStart, first}. → {pos, align, leader, kind: 'custom'|'hanging'|'default'} */
export function nextStop(pen, { stops, def, left = 0, lineStart = left, first = false }) {
  const custom = realStops(stops);
  let best = null;
  for (const s of custom) {
    if (s.pos > pen + EPS) {
      best = { pos: s.pos, align: s.align ?? 'left', leader: s.leader ?? 'none', kind: 'custom' };
      break;
    }
  }
  const hanging = first && lineStart < left - EPS;
  if (hanging && left > pen + EPS && (!best || left < best.pos - EPS)) best = { pos: left, align: 'left', leader: 'none', kind: 'hanging' };
  if (def > 0) {
    let from = Math.max(pen, custom.length ? custom[custom.length - 1].pos : -Infinity);
    if (hanging) from = Math.max(from, left);
    const d = (Math.floor((from + EPS) / def) + 1) * def;
    if (!best || d < best.pos - EPS) best = { pos: d, align: 'default', leader: 'none', kind: 'default' };
  }
  return best ?? { pos: pen, align: 'default', leader: 'none', kind: 'default' };
}

/** Where the text after an aligned stop starts: `stop` less the following text's width for right, half of it for center, the width
 * up to the decimal symbol for decimal (right without one); never left of `pen` (wide text starts right after the text before). */
function alignedEnd(pen, stop, align, f = {}) {
  // `f` may measure lazily (getters), so only the alignment that needs a width reads it.
  const end = align === 'right' ? stop - (f.w ?? 0) : align === 'center' ? stop - (f.w ?? 0) / 2
    : align === 'decimal' ? stop - (f.dec ?? f.w ?? 0) : stop;
  return Math.max(pen, end);
}

/** Where a stop past the right indent leaves a tab, as Word 2013 and later do it (probe .smoke-data/word/fixture/walk/tabs_docx.py;
 * LibreOffice's TabOverSpacing): a right, centre or decimal stop acts as a right stop on the right indent; a left stop before the
 * column's right edge (`c.width`) is honoured and its line runs into the margin; a left stop at or past that edge and a default stop
 * do not fit, so the tab goes to the next line. → 'right' | 'keep' | 'wrap' | null when the stop is not past the right indent */
function pastRight(s, c) {
  if (s.pos <= c.right + EPS) return null;
  if (s.kind !== 'custom') return 'wrap';
  if (s.align !== 'left') return 'right';
  return s.pos < (c.width ?? Infinity) - EPS ? 'keep' : 'wrap';
}

/** The tab at `pen` once it is on its line: the stop `s` past the pen, aligned against `follow`. */
function onLine(pen, s, c, follow) {
  const past = pastRight(s, c);
  if (past === 'right') return { w: alignedEnd(pen, c.right, 'right', follow) - pen, align: 'right', leader: s.leader, stop: c.right };
  const align = s.kind === 'custom' ? s.align : s.kind === 'hanging' ? 'left' : 'default';
  return { w: alignedEnd(pen, s.pos, align, follow) - pen, align, leader: s.leader, stop: s.pos };
}

/** The width of a tab character at `pen` on its line. `c` = {stops, def, left, right, width, lineStart, first}: right is the right
 * indent's position, width the column's; `follow` = {w, dec}: the width of the text after the tab up to the next tab or the line
 * end, and up to its decimal point (null without one, see decimalAt). A tab that does not fit (pastRight) wraps to the next line
 * and lays out there, or fills the line when it starts it. → {w, align ('left'...'decimal' or 'default'), leader, stop, wrap}; with
 * wrap, w is the box's width at the start of the next line. */
export function placeTab(pen, c, follow = {}) {
  const s = nextStop(pen, c);
  if (pastRight(s, c) !== 'wrap') return { ...onLine(pen, s, c, follow), wrap: false };
  const fill = (at) => ({ w: Math.max(0, c.right - at), align: 'default', leader: 'none', stop: c.right });
  if (pen <= c.lineStart + EPS) return { ...fill(pen), wrap: false };
  const n = nextStop(c.left, { ...c, first: false, lineStart: c.left });
  return { ...(pastRight(n, c) === 'wrap' ? fill(c.left) : onLine(c.left, n, c, follow)), wrap: true };
}

/** The width of an alignment tab (w:ptab) {align, relativeTo, leader} at `pen`: its stop is recomputed from the margins (0 and the
 * column width `c.width`) or the indents (`c.left`, `c.right`) on every layout. When the text after it cannot start at its place
 * because the pen is past that, it goes to the next line and aligns there (Word, probe tabs_docx.py J and L). → {w, align, leader,
 * stop, wrap} */
export function placePtab(pen, { align = 'center', relativeTo = 'margin', leader = 'none' }, c, follow = {}) {
  const [a, b] = relativeTo === 'indent' ? [c.left, c.right] : [0, c.width];
  const stop = align === 'right' ? b : align === 'center' ? (a + b) / 2 : a;
  const start = alignedEnd(-Infinity, stop, align, follow);
  const lineStart = c.lineStart ?? c.left;
  if (start < pen - EPS && pen > lineStart + EPS) return { w: Math.max(0, alignedEnd(c.left, stop, align, follow) - c.left), align, leader, stop, wrap: true };
  return { w: alignedEnd(pen, stop, align, follow) - pen, align, leader, stop, wrap: false };
}

/** Where a decimal tab aligns in `text` (the text after the tab), as Word does: on the first decimal symbol `sym`, else on the first
 * character that is not a digit after a run of digits (thousand separators inside the run count as digits); null when there is
 * neither, and the text then aligns as on a right stop ("12345 (note" aligns on the space after 12345, "text only" right-aligns).
 * `state` carries the digit run across text nodes. → the index, or null */
export function decimalAt(text, sym, state = { num: false }) {
  const [sep, sep2] = sym === ',' ? ['.', '.'] : [',', "'"];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === sym) return i;
    if ((ch >= '0' && ch <= '9') || (state.num && (ch === sep || ch === sep2))) state.num = true;
    else if (state.num) return i;
  }
  return null;
}

/** The stop the tab after a list number reaches (G3): the first past the label's end `labelEnd` of the level's tab (lists' "Add tab
 * stop at"), the hanging indent `left`, the next custom stop, the next default stop. */
export function numStop(labelEnd, { levelTab = null, left, stops, def }) {
  if (levelTab != null && levelTab > labelEnd + EPS) return levelTab;
  if (left > labelEnd + EPS) return left;
  return nextStop(labelEnd, { stops, def, left, lineStart: left, first: false }).pos;
}

/** Lays out one paragraph of `items` ({text: width, dec?} or {tab: true} or {ptab: {align, relativeTo, leader}}) on lines from
 * `c` = {stops, def, left, firstLine, right, width}, wrapping only at tabs and whole text items as the DOM does for these cases.
 * For tests and static checks. → [{x, line}] per item: where it starts. */
export function layoutLine(items, c) {
  const out = [];
  let line = 0;
  const startOf = (l) => (l === 0 ? c.left + (c.firstLine ?? 0) : c.left);
  let pen = startOf(0);
  let reach = c.right; // a left stop past the right indent lets its line run into the margin, up to the column's edge
  items.forEach((it, i) => {
    if (it.text != null) {
      if (pen + it.text > reach + EPS && pen > startOf(line) + EPS) {
        pen = startOf(++line);
        reach = c.right;
      }
      out.push({ x: pen, line });
      pen += it.text;
      return;
    }
    // The text after the tab, up to the next tab: its width and the width before its first decimal symbol.
    const follow = { w: 0, dec: null };
    for (let j = i + 1; j < items.length && items[j].text != null; j++) {
      if (follow.dec == null && items[j].dec != null) follow.dec = follow.w + items[j].dec;
      follow.w += items[j].text;
    }
    const lc = { ...c, lineStart: startOf(line), first: line === 0 };
    const r = it.ptab ? placePtab(pen, it.ptab, lc, follow) : placeTab(pen, lc, follow);
    if (r.wrap) {
      pen = startOf(++line);
      reach = c.right;
    } else if (r.stop > c.right + EPS) reach = c.width ?? Infinity;
    out.push({ x: pen, line, w: r.w });
    pen += r.w;
  });
  return out;
}
