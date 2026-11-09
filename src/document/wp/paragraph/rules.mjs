// Word's paragraph rules as pure functions (docs/plans/word/briefs/paragraph.md; index-layout.md "Spacing and line spacing" and
// "Indents"): line height from the font's single line, the gap between paragraphs, Don't add space between paragraphs of the
// same style, Special and By to an indent and back, the indent steps of Increase Indent and Ctrl+T, and the Paragraph dialog's
// typed lengths. No DOM: the extension measures each font's single line and hands the ratio in, and Node tests load this file.
import { deepPatch } from '../../../office.mjs';
import { LIMITS, formatLength, parseLength } from '../../../tooling/kit/units.mjs';
import { styleChain, styleIdOf } from '../../model/styles.mjs';

export const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, [min, max]) => Math.min(max, Math.max(min, v));

/** Space Word draws for Auto before or after (HTML-style spacing; measured 13.6, Word documents 14). */
export const AUTO_SPACE = 14;
/** One line in a spacing box ('1 li'), which Word counts as 12 pt. */
export const LINE_PT = 12;

/** The line pitch in points of a paragraph with line rule `line` ({rule: 'auto'|'exact'|'atLeast', value} or null for Single),
 * given `single`, the font's own single line height in points: Multiple n is n x Single (0.06 to 132), At least is never less
 * than Single, Exactly is the value (0.7 to 1584) whatever the font. */
export function linePitch(line, single) {
  if (!line) return single;
  if (line.rule === 'exact') return clamp(line.value, LIMITS.lineExact);
  if (line.rule === 'atLeast') return Math.max(single, clamp(line.value, LIMITS.lineExact));
  return clamp(line.value, LIMITS.lineMultiple) * single;
}

/** A section's line grid pitch in points (sect.docGrid: Page Setup's Document Grid, any type with a line grid: lines, linesAndChars,
 * snapToChars), or null where it has none. */
export function gridOf(sect) {
  const g = sect?.docGrid;
  return g && /^(lines|linesAndChars|snapToChars)$/.test(g.type ?? '') && g.linePitch > 0 ? g.linePitch : null;
}

/** The line pitch in points of a paragraph that snaps to a line grid of `pitch` pt, for line rule `line` and `single` (as linePitch):
 * a line takes as many grid lines as its single line needs, Multiple n is n grid lines (Single one), At least is never less than the
 * grid lines, Exactly keeps its value. Word's PDF of the snap-grid-asian probe (fixture/walk/grid_probe_docx.py, grid.docx, at
 * pitches of 23.25, 18 and 15.6 pt): 12 pt Aptos single is one pitch, 1.16 and 1.5 lines are 1.16 and 1.5 pitches, a 20 or 28 pt
 * run takes two (three at 15.6), DengXian's 16.25 pt CJK line at 1.16 takes two 15.6 pt pitches and no more, at least 20 pt is 20
 * on 18 and 15.6 and 23.25 on 23.25, exactly 15 pt is 15. Space before and after stays as it is. */
export function gridPitch(line, single, pitch) {
  const lines = Math.max(1, Math.ceil(single / pitch - 1e-6)) * pitch;
  if (line?.rule === 'exact') return linePitch(line, single);
  if (line?.rule === 'atLeast') return Math.max(clamp(line.value, LIMITS.lineExact), lines);
  return Math.max(lines, (line?.rule === 'auto' ? clamp(line.value, LIMITS.lineMultiple) : 1) * pitch);
}

/** The room Multiple spacing adds to a line above Single (pt): the multiple's share of the line's font's single line, `single` pt.
 * Word puts it under the text, and under an inline picture whose line the picture sets (its own height stands for Single). Measured at 1.16, 1.5 and 2 times, pictures 30 to
 * 120 pt, Aptos 12 and 24 pt and Calibri 11 pt (.smoke-data/word/fixture/walk/picline_docx.py): 0 at Single and under Exactly and
 * At least. ponytail: multiples under 1 give none; probe them if a document uses one under a picture. */
export function lineExtra(line, single) {
  return line?.rule === 'auto' ? Math.max(0, clamp(line.value, LIMITS.lineMultiple) - 1) * single : 0;
}

/** CSS line-height for rule `line` on a paragraph whose font has single-line `ratio` (line-height normal over the size) at `size`
 * pt. Multiples stay unitless, so a larger run on the line grows it as in Word; Exactly and an At least above Single are fixed.
 * ponytail: a fixed height does not grow for a larger run, as At least does in Word. */
export function lineCss(line, ratio, size) {
  const single = ratio * size;
  if (line?.rule === 'exact' || (line?.rule === 'atLeast' && linePitch(line, single) > single + 1e-6)) return `${round2(linePitch(line, single))}pt`;
  const m = line?.rule === 'auto' ? clamp(line.value, LIMITS.lineMultiple) : 1;
  return String(Math.round(ratio * m * 10000) / 10000);
}

/** How far from its column's left edge Word lets a line reach: 22 in., its largest page. A negative right indent widens the
 * lines only up to there, while a negative left indent still moves their start out (Word's PDFs of the para-indents probe,
 * .smoke-data/word/fixture/out/probe/para-indents: right -1200 to -1584 pt wrap at the same 1584 pt on A4, on Letter and with
 * 36/108 pt margins; left -1584 with right -1584 runs from 1584 pt left of the margin to this edge). Indents that leave no width
 * set one character per line from the line's start, off the page where that is past its edge, which CSS draws as it is. */
export const LINE_REACH = 1584;

/** The right indent (pt) a paragraph with right indent `right` draws with in a column `col` pt wide. */
export const reachRight = (right, col) => Math.max(right ?? 0, col - LINE_REACH);

/** The space between two paragraphs: the larger of `after` (the first's space after) and `before` (the next one's space before), or
 * their sum in the compatibility mode that adds them (settings.compat.htmlAutoSpacing false). */
export const gap = (after, before, { sum = false } = {}) => (sum ? after + before : Math.max(after, before));

/** Whether paragraph `p`'s own space next to paragraph `q` drops to 0 under Don't add space between paragraphs of the same style:
 * `p` has contextual on and both use one style. Each side is {style, contextual}. */
export const dropsNext = (p, q) => !!(p?.contextual && q && p.style === q.style);

/** The gap between paragraph `a` and the next one `b` ({style, contextual, after or before}), with contextual spacing applied. */
export function gapBetween(a, b, opts) {
  const after = dropsNext(a, b) ? 0 : a.after ?? 0;
  const before = dropsNext(b, a) ? 0 : b.before ?? 0;
  return gap(after, before, opts);
}

/** The Paragraph dialog's Special and By as indent.firstLine: Hanging is negative, First line positive, (none) null. */
export function firstLineOf(special, by) {
  if (special === 'hanging') return -Math.abs(by ?? 0);
  if (special === 'firstLine') return Math.abs(by ?? 0);
  return null;
}

/** indent.firstLine `firstLine` as the dialog's {special, by}. */
export function specialOf(firstLine) {
  if (!firstLine) return { special: 'none', by: null };
  return firstLine < 0 ? { special: 'hanging', by: -firstLine } : { special: 'firstLine', by: firstLine };
}

/** By's value when Special is first picked: 1.27 cm, or half an inch (0.5", the same 36 pt). */
export const DEFAULT_BY = 36;

/** The next multiple of `step` (the default tab stop) above `left`, as Increase Indent moves the left indent. */
export const nextStop = (left, step = 36) => (Math.floor(round2(left) / step + 1e-6) + 1) * step;

/** The previous multiple of `step` below `left`, never below 0, as Decrease Indent moves it. A negative indent stays where it is
 * (v): stepping it to 0 would move it right. */
export const prevStop = (left, step = 36) => (left < 0 ? left : Math.max(0, (Math.ceil(round2(left) / step - 1e-6) - 1) * step));

/** Ctrl+T (`on`) or Ctrl+Shift+T: the left indent moves one stop of `step` right or left while the first line stays where it starts,
 * so the hanging indent grows or shrinks by one interval; un-hanging stops where the first line starts. → {left, firstLine}. */
export function hang({ left = 0, firstLine = 0 } = {}, step = 36, on = true) {
  const start = left + (firstLine ?? 0);
  const next = on ? nextStop(left, step) : Math.max(start, prevStop(left, step));
  const hanging = round2(start - next);
  return { left: round2(next), firstLine: hanging || null };
}

/** Typed `text` in a length box read as points, a bare number in `unit`; in a spacing box (`lines`) 'li' counts 12 pt. → pt or null. */
export function readLength(text, unit, { lines = false } = {}) {
  const v = parseLength(text, unit, { lines });
  return v?.lines != null ? v.lines * LINE_PT : v;
}

/** Word's message for `pt` outside `range` ([min, max] in points), shown in `unit`; null when it fits. */
export function rangeMessage(pt, range, unit) {
  if (pt == null || (pt >= range[0] - 1e-6 && pt <= range[1] + 1e-6)) return null;
  return `The value must be between ${formatLength(range[0], unit)} and ${formatLength(range[1], unit)}.`;
}

/** Line spacing {rule, value} as the dialog's Line spacing pick and its At value: Single, 1.5 lines and Double are the auto
 * multiples 1, 1.5 and 2. */
export function lineRuleOf(line) {
  if (!line) return { rule: 'single', at: null };
  if (line.rule === 'exact' || line.rule === 'atLeast') return { rule: line.rule, at: line.value };
  const m = line.value;
  if (Math.abs(m - 1) < 0.005) return { rule: 'single', at: null };
  if (Math.abs(m - 1.5) < 0.005) return { rule: 'onePt5', at: null };
  if (Math.abs(m - 2) < 0.005) return { rule: 'double', at: null };
  return { rule: 'multiple', at: round2(m) };
}

/** The dialog's Line spacing pick `rule` and At `at` as spacing.line. */
export function lineOf(rule, at) {
  if (rule === 'single') return { rule: 'auto', value: 1 };
  if (rule === 'onePt5') return { rule: 'auto', value: 1.5 };
  if (rule === 'double') return { rule: 'auto', value: 2 };
  if (rule === 'multiple') return { rule: 'auto', value: at ?? 3 };
  return { rule, value: at ?? 12 };
}

/** At's value when a rule is first picked in the dialog: Multiple 3, At least and Exactly 12 pt. */
export const DEFAULT_AT = { multiple: 3, atLeast: 12, exact: 12 };

// ---------- effective properties ----------
// The paragraph attributes Ctrl+Q clears and the dialog reads (plan.md §1.8): every direct paragraph property but the style, the
// list, the drop cap or frame, the style separator and tracking's records.
export const DIRECT = ['textAlign', 'spacing', 'indent', 'tabs', 'keepNext', 'keepLines', 'widowControl', 'pageBreakBefore', 'outline', 'contextual',
  'borders', 'shading', 'bidi', 'mirrorIndents', 'suppressLineNumbers', 'suppressAutoHyphens', 'snapToGrid', 'asian', 'collapsed', 'tightWrap'];
// v1 style keys read as v2 (plan.md §1.6 value mode).
export const ALIAS = { align: 'textAlign', border: 'borders' };
const OBJECTS = new Set(['spacing', 'indent', 'asian']);

const merged = new WeakMap(); // styles attr → Map(style id → {run, para})

/** Style `id` of `doc` with docDefaults and its basedOn chain merged, nearest winning: {run, para} with v2 paragraph names. In a
 * table (`table` its style id) Word lays the table style's paragraph and run properties over docDefaults and Normal, and under any
 * other paragraph style: a TableGrid cell is single spaced with no space after, though docDefaults give 1.08 and 8 pt. */
export function styleProps(doc, id, table = null) {
  const styles = doc.attrs.styles ?? {};
  let byId = merged.get(styles);
  if (!byId) merged.set(styles, (byId = new Map()));
  const key = table ? `${id}
${table}` : id;
  if (!byId.has(key)) {
    let run = { ...styles.defaults?.run };
    let para = { ...styles.defaults?.para };
    const chain = styleChain(doc, id);
    const layers = table ? [...chain.filter((s) => s.id === 'Normal'), ...styleChain(doc, table), ...chain.filter((s) => s.id !== 'Normal')] : chain;
    for (const s of layers) {
      run = deepPatch(run, s.run ?? {});
      for (const [k0, v] of Object.entries(s.para ?? {})) {
        const k = ALIAS[k0] ?? k0;
        para[k] = OBJECTS.has(k) && para[k] ? { ...para[k], ...v } : v;
      }
    }
    byId.set(key, { run, para });
  }
  return byId.get(key);
}

/** The paragraph properties paragraph or heading `node` of `doc` shows: its style's (over table style `table`'s in a table),
 * then its own (null inherits). */
export function effectivePara(doc, node, table = null) {
  const { para } = styleProps(doc, styleIdOf(node), table);
  const out = { ...para };
  for (const k of DIRECT) {
    const v = node.attrs[k];
    if (v == null) continue;
    out[k] = OBJECTS.has(k) && para[k] ? { ...para[k], ...v } : v;
  }
  return out;
}

// ---------- canvas drafts ----------
// The Paragraph dialog on a canvas draft reads the engine's resolved paragraph (para.state, the doc crate's ResolvedPara in its
// serde names) as a para object and writes its patch as para.set's ParaProps.
const LINE_IN = { multiple: 'auto', atLeast: 'atLeast', exactly: 'exact' };
const LINE_OUT = { auto: 'multiple', atLeast: 'atLeast', exact: 'exactly' };

/** para.state's value `rp` → the dialog's para object (v2 names, as effectivePara gives them). */
export function paraOfEngine(rp) {
  if (!rp) return {};
  const ls = rp.lineSpacing;
  return {
    textAlign: rp.align ?? 'left', outline: rp.outlineLevel ?? 9, mirrorIndents: !!rp.mirrorIndents,
    indent: { left: rp.indentLeft ?? 0, right: rp.indentRight ?? 0, firstLine: rp.indentFirst || null },
    spacing: { before: rp.spaceBefore ?? 0, after: rp.spaceAfter ?? 0, beforeAuto: !!rp.beforeAuto, afterAuto: !!rp.afterAuto,
      line: ls ? { rule: LINE_IN[ls.rule] ?? 'auto', value: ls.value } : null },
    contextual: !!rp.contextualSpacing, snapToGrid: rp.snapToGrid ?? true, widowControl: rp.widowControl ?? true, keepNext: !!rp.keepNext,
    keepLines: !!rp.keepLines, pageBreakBefore: !!rp.pageBreakBefore, suppressLineNumbers: !!rp.suppressLineNumbers,
    suppressAutoHyphens: !!rp.suppressHyphens,
    asian: { kinsoku: rp.kinsoku ?? true, wordWrap: rp.wordWrap ?? true, overflowPunct: rp.overflowPunct ?? true, topLinePunct: !!rp.topLinePunct,
      autoSpaceDE: rp.autoSpaceDe ?? true, autoSpaceDN: rp.autoSpaceDn ?? true },
  };
}

/** The dialog's patch `p` (patchOf) → para.set's props. Collapsed by default, tight wrap and the Asian text alignment have no engine
 * property (stage2.md's single-command gaps). */
export function paraPropsOf(p) {
  const out = {};
  const put = (k, v) => v !== undefined && (out[k] = v);
  put('align', p.textAlign);
  put('outlineLevel', p.outline);
  put('mirrorIndents', p.mirrorIndents);
  put('indentLeft', p.indent?.left);
  put('indentRight', p.indent?.right);
  if (p.indent && 'firstLine' in p.indent) out.indentFirst = p.indent.firstLine ?? 0;
  const sp = p.spacing ?? {};
  put('spaceBefore', sp.before ?? undefined);
  put('spaceAfter', sp.after ?? undefined);
  if ('beforeAuto' in sp) out.spaceBeforeAuto = !!sp.beforeAuto;
  if ('afterAuto' in sp) out.spaceAfterAuto = !!sp.afterAuto;
  if (sp.line) out.lineSpacing = { rule: LINE_OUT[sp.line.rule] ?? 'multiple', value: sp.line.value };
  put('contextualSpacing', p.contextual);
  put('snapToGrid', p.snapToGrid);
  put('widowControl', p.widowControl);
  put('keepNext', p.keepNext);
  put('keepLines', p.keepLines);
  put('pageBreakBefore', p.pageBreakBefore);
  put('suppressLineNumbers', p.suppressLineNumbers);
  put('suppressHyphens', p.suppressAutoHyphens);
  const a = p.asian ?? {};
  for (const [from, to] of [['kinsoku', 'kinsoku'], ['wordWrap', 'wordWrap'], ['overflowPunct', 'overflowPunct'], ['topLinePunct', 'topLinePunct'],
    ['autoSpaceDE', 'autoSpaceDe'], ['autoSpaceDN', 'autoSpaceDn']]) put(to, a[from]);
  return out;
}
