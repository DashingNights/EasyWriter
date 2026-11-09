// Section breaks and page setup (docs/plans/word/plan.md §1.8 sect v2, §3 sections; briefs/sections.md). Every change goes into one
// transaction the caller dispatches, so one Ctrl+Z undoes a menu pick or the Page Setup dialog. Pure: node tests load it.
import { TextSelection } from '@tiptap/pm/state';
import { Transform } from '@tiptap/pm/transform';
import { deepPatch, MARGIN_PRESETS as OFFICE_MARGINS, PAPER_SIZES } from '../../../office.mjs';
import { formatLength, LIMITS } from '../../../tooling/kit/units.mjs';
import { defaultSect } from '../../defaults.mjs';
import { sectionAt, sectionsOf } from '../../model/sections.mjs';
import { MIN_TEXT } from '../../pages.mjs';

const SIDES = ['top', 'bottom', 'left', 'right'];
const near = (a, b) => Math.abs(a - b) < 0.5;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// ---------- margins, sizes and orientation ----------

// The agents' doc.pageSetup names the same presets and papers from office.mjs (normal, a4, ...), so the shared values come from there.
const sides = ({ top, bottom, left, right }) => ({ top, bottom, left, right });
const office = (key) => [PAPER_SIZES[key].label, PAPER_SIZES[key].w, PAPER_SIZES[key].h];

/** Layout > Margins presets in points, keyed by their menu item's id segment (index-layout.md 151). Mirrored is inside 1.25 in and
 * outside 1 in, with settings.mirrorMargins on; the others clear it. */
export const MARGIN_PRESETS = {
  normalMargins: sides(OFFICE_MARGINS.normal),
  narrowMargins: sides(OFFICE_MARGINS.narrow),
  moderateMargins: sides(OFFICE_MARGINS.moderate),
  wideMargins: sides(OFFICE_MARGINS.wide),
  mirroredMargins: { top: 72, bottom: 72, left: 90, right: 72, mirror: true },
};

/** A margins item's second line in `unit` ('Top: 2.54 cm Bottom: 2.54 cm Left: 2.54 cm Right: 2.54 cm'; Inside and Outside when mirrored). */
export function marginDesc(m, unit, mirror = false) {
  const f = (pt) => formatLength(pt, unit);
  return `Top: ${f(m.top)} Bottom: ${f(m.bottom)} ${mirror ? 'Inside' : 'Left'}: ${f(m.left)} ${mirror ? 'Outside' : 'Right'}: ${f(m.right)}`;
}

/** The MARGIN_PRESETS key `sect`'s margins and the document's `mirror` flag match, or null. */
export const presetOf = (sect, mirror) => Object.keys(MARGIN_PRESETS)
  .find((k) => !!MARGIN_PRESETS[k].mirror === !!mirror && SIDES.every((s) => near(sect.margin[s], MARGIN_PRESETS[k][s]))) ?? null;

// Points from millimetres through whole twips, as Word stores paper sizes (A4 is 11906 x 16838 twips).
const mm = (x) => Math.round((x * 1440) / 25.4) / 20;
const inch = (x) => x * 72;
/** Layout > Size: the common sizes of Word's printer list in its order and labels (layout.size.json), portrait, in points: [label, w, h].
 * Letter, Legal, Executive, A4 and A5 are office.mjs PAPER_SIZES' under the same keys (doc.pageSetup's names). */
export const PAPERS = {
  letter: office('letter'), tabloid: ['Tabloid', inch(11), inch(17)], legal: office('legal'),
  statement: ['Statement', inch(5.5), inch(8.5)], executive: office('executive'),
  a3: ['A3', mm(297), mm(420)], a4: office('a4'), a5: office('a5'),
  b4jis: ['B4 (JIS)', mm(257), mm(364)], b5jis: ['B5 (JIS)', mm(182), mm(257)],
  envelope10: ['Envelope #10', inch(4.125), inch(9.5)], envelopeDL: ['Envelope DL', mm(110), mm(220)],
  c5: ['Envelope C5', mm(162), mm(229)], c4: ['Envelope C4', mm(229), mm(324)], b5: ['Envelope B5', mm(176), mm(250)],
  monarch: ['Envelope Monarch', inch(3.875), inch(7.5)], a6: ['A6', mm(105), mm(148)],
};

/** The PAPERS key `sect`'s paper matches in either orientation, or null (custom). */
export const paperOf = (sect) => Object.keys(PAPERS).find((k) => {
  const [, w, h] = PAPERS[k];
  return (near(sect.w, w) && near(sect.h, h)) || (near(sect.w, h) && near(sect.h, w));
}) ?? null;

/** A size's second line: '21 cm x 29.7 cm'. */
export const paperDesc = (key, unit) => `${formatLength(PAPERS[key][1], unit)} x ${formatLength(PAPERS[key][2], unit)}`;

// A sect stored without `orient` takes it from its shape.
const orientOf = (sect) => sect.orient ?? (sect.w > sect.h ? 'landscape' : 'portrait');

/** `sect` on paper `w` x `h`, keeping its orientation (Word's Size menu). */
export function sizeSect(sect, w, h) {
  const [a, b] = [Math.min(w, h), Math.max(w, h)];
  return orientOf(sect) === 'landscape' ? { ...sect, w: b, h: a } : { ...sect, w: a, h: b };
}

/** `sect` turned to `orient`: width and height swap and the margins rotate with the paper (index-layout.md 157: portrait T10 B20 L30
 * R40 becomes landscape T30 B40 L20 R10, and back). Header, footer and gutter stay. pages.mjs sectFor keeps the margins instead. */
export function orientSect(sect, orient) {
  if (orientOf(sect) === orient) return sect;
  const m = sect.margin;
  const margin = orient === 'landscape'
    ? { ...m, top: m.left, bottom: m.right, left: m.bottom, right: m.top }
    : { ...m, top: m.right, bottom: m.left, left: m.top, right: m.bottom };
  return { ...sect, orient, w: sect.h, h: sect.w, margin };
}

// ---------- validation ----------

/** Why page values `v` ({w, h, margin, gutterAtTop}) break Word's limits (index-layout.md 17) or leave no text area, in `unit`, or null. */
export function checkSetup(v, unit) {
  const f = (pt) => formatLength(pt, unit);
  const bad = (x, [a, b]) => !(x >= a - 1e-6 && x <= b + 1e-6); // NaN is bad too
  const m = v.margin;
  if (bad(v.w, LIMITS.page)) return `The page width must be between ${f(LIMITS.page[0])} and ${f(LIMITS.page[1])}.`;
  if (bad(v.h, LIMITS.page)) return `The page height must be between ${f(LIMITS.page[0])} and ${f(LIMITS.page[1])}.`;
  for (const s of SIDES) if (bad(m[s], LIMITS.margin)) return `The ${s} margin must be between ${f(LIMITS.margin[0])} and ${f(LIMITS.margin[1])}.`;
  for (const [k, name] of [['gutter', 'gutter'], ['header', 'header distance'], ['footer', 'footer distance']]) {
    if (m[k] != null && bad(m[k], LIMITS.gutter)) return `The ${name} must be between ${f(LIMITS.gutter[0])} and ${f(LIMITS.gutter[1])}.`;
  }
  // A negative margin keeps the text off the edge by its size, as Word measures it.
  const g = m.gutter ?? 0;
  if (v.w - Math.abs(m.left) - Math.abs(m.right) - (v.gutterAtTop ? 0 : g) < MIN_TEXT) return 'The left and right margins leave no room for text.';
  if (v.h - Math.abs(m.top) - Math.abs(m.bottom) - (v.gutterAtTop ? g : 0) < MIN_TEXT) return 'The top and bottom margins leave no room for text.';
  return null;
}

// ---------- sections in a transaction ----------

/** The stored sect of section `sec` of `doc`: its break's, or doc.attrs.sect for the last; `fallback` for a missing one. */
export function storedSect(doc, sec, fallback) {
  const stored = sec.holder == null ? doc.attrs.sect : doc.nodeAt(sec.holder)?.attrs.sect;
  return stored ?? (sec.holder == null ? fallback ?? defaultSect() : sec.sect);
}

/** The indices of the sections `from`..`to` touches (a range ending right after a break stays in the break's section). */
export function touched(doc, from, to = from) {
  const list = sectionsOf(doc);
  return range(sectionAt(list, from).index, sectionAt(list, to > from ? to - 1 : to).index);
}

/** Sets section `index`'s sect to fn(old sect) in `tr`; no step when nothing changes. `fallback` stands in for a null doc.attrs.sect. */
export function updateSect(tr, index, fn, fallback) {
  const sec = sectionsOf(tr.doc)[index];
  if (!sec) return;
  const old = storedSect(tr.doc, sec, fallback);
  const next = fn(old);
  const raw = sec.holder == null ? tr.doc.attrs.sect : tr.doc.nodeAt(sec.holder).attrs.sect;
  if (next === old || JSON.stringify(next) === JSON.stringify(raw)) return;
  if (sec.holder == null) tr.setDocAttribute('sect', next);
  else tr.setNodeAttribute(sec.holder, 'sect', next);
}

/** Patches doc.attrs.settings with `patch` in `tr` (keys a newer build wrote survive); no step when nothing changes. */
export function patchSettings(tr, patch) {
  const old = tr.doc.attrs.settings ?? {};
  const next = deepPatch(old, patch);
  if (JSON.stringify(next) !== JSON.stringify(old)) tr.setDocAttribute('settings', next);
}

/** Section `index` starts as `kind` ('nextPage', 'continuous', 'evenPage', 'oddPage', 'nextColumn'): the kind of the break before it
 * decides, and its sect.type mirrors it for export (§1.8). The first section has no break before it and always starts a page. */
export function setStart(tr, index, kind, fallback) {
  if (index < 1) return;
  const prev = sectionsOf(tr.doc)[index - 1];
  if (tr.doc.nodeAt(prev.holder)?.attrs.kind !== kind) tr.setNodeAttribute(prev.holder, 'kind', kind);
  updateSect(tr, index, (old) => (old.type === kind ? old : { ...old, type: kind }), fallback);
}

/** Where a break goes for a caret at `pos`, as setPageBreak decides (index-layout.md 177): the paragraph splits at the caret, or the
 * break goes before it at its start (or always with `split` false); in a table, a text box or another wrapper it goes before the
 * top-level block. A columns node never holds a break: it splits there and both halves keep its columns. Changes `tr` → the position. */
function breakAt(tr, pos, split = true) {
  const $p = tr.doc.resolve(pos);
  const inCols = $p.depth >= 2 && $p.node(1).type.name === 'columns';
  let at = pos;
  if ($p.parent.isTextblock && ($p.depth === 1 || ($p.depth === 2 && inCols))) {
    if (!split || $p.parentOffset === 0) at = $p.before();
    else {
      // At a paragraph's end the new empty paragraph never takes the suggestion record, as with Enter.
      const end = $p.parentOffset === $p.parent.content.size;
      tr.split(pos, 1, end ? [{ type: $p.parent.type, attrs: { ...$p.parent.attrs, suggest: null } }] : undefined);
      at = pos + 1;
    }
  } else if ($p.depth >= (inCols ? 2 : 1) && !($p.depth === 1 && $p.parent.type.name === 'columns')) at = $p.before(inCols ? 2 : 1);
  const $a = tr.doc.resolve(at);
  if ($a.depth === 1 && $a.parent.type.name === 'columns') {
    if ($a.index() === 0) return $a.before(1);
    if ($a.index() === $a.parent.childCount) return $a.after(1);
    tr.split(at, 1);
    return at + 1;
  }
  return at;
}

/** Inserts a section break of `kind` for a caret at `pos` (breakAt's rules). It ends the caret's section with a copy of that section's
 * sect, and the section after it gets sect.type = kind in the same transaction. → the break's position. */
export function insertSectionBreak(tr, pos, kind, { split = true, fallback } = {}) {
  const sec = sectionAt(sectionsOf(tr.doc), pos);
  const sect = structuredClone(storedSect(tr.doc, sec, fallback));
  const at = breakAt(tr, pos, split);
  tr.insert(at, tr.doc.type.schema.nodes.sectionBreak.create({ kind, sect }));
  updateSect(tr, sec.index + 1, (old) => (old.type === kind ? old : { ...old, type: kind }), fallback);
  return at;
}

/** After a deletion merged sections, the merged section keeps the later one's start type (Word), so the break before each section
 * takes its stored sect.type: layout reads the kind and export reads sect.type. Nothing else is copied. → a transaction or null. */
export function syncKinds(state) {
  const list = sectionsOf(state.doc);
  let tr = null;
  for (let i = 1; i < list.length; i++) {
    const type = storedSect(state.doc, list[i])?.type;
    const at = list[i - 1].holder;
    if (type && state.doc.nodeAt(at).attrs.kind !== type) (tr ??= state.tr).setNodeAttribute(at, 'kind', type);
  }
  return tr;
}

/** Insert > Blank Page: two page breaks at the caret with an empty paragraph between, the caret on the new blank page. */
export function insertBlankPage(tr, pos) {
  const { pageBreak, paragraph } = tr.doc.type.schema.nodes;
  const at = breakAt(tr, pos);
  tr.insert(at, [pageBreak.create(), paragraph.create(), pageBreak.create()]);
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  return at;
}

// ---------- Apply to ----------

/** Apply to's labels (index-layout.md 162; probe page-setup.json). */
export const APPLY_LABELS = { whole: 'Whole document', section: 'This section', sections: 'Selected sections', forward: 'This point forward', selected: 'Selected text' };

/** Apply to's choices for `doc` and selection `sel` {from, to, empty} → {options, value} (the first is the default). */
export function applyToOptions(doc, sel) {
  const n = sectionsOf(doc).length;
  const spans = touched(doc, sel.from, sel.to).length > 1;
  const options = n === 1 ? (sel.empty ? ['whole', 'forward'] : ['whole', 'selected'])
    : sel.empty ? ['section', 'forward', 'whole']
      : spans ? ['sections', 'whole'] : ['section', 'selected', 'whole'];
  return { options, value: options[0] };
}

/** The sections Apply to `apply` reaches for selection `sel`, adding breaks of `kind` first where it needs them: This point forward puts
 * one before the caret's paragraph and reaches the new section; Selected text puts one before and after the top-level blocks the
 * selection covers (so never inside a list, a table or columns) and reaches the section between. → section indices. */
export function applyTargets(tr, apply, sel, kind = 'nextPage', fallback) {
  if (apply === 'whole') return range(0, sectionsOf(tr.doc).length - 1);
  if (apply === 'forward') {
    // A caret at the section's first block needs no break (it would leave an empty section): the change goes to that section.
    const sec = sectionAt(sectionsOf(tr.doc), sel.from);
    if (breakAt(new Transform(tr.doc), sel.from, false) === sec.from) return [sec.index];
    const at = insertSectionBreak(tr, sel.from, kind, { split: false, fallback });
    return [sectionAt(sectionsOf(tr.doc), at + 1).index];
  }
  if (apply === 'selected') {
    const $f = tr.doc.resolve(sel.from);
    const $t = tr.doc.resolve(sel.to);
    const start = $f.depth ? $f.before(1) : sel.from;
    const end = $t.depth ? $t.after(1) : sel.to;
    const sec = sectionAt(sectionsOf(tr.doc), start);
    // No empty section: no break where the selection already meets a section's edge or the document's end.
    if (end < tr.doc.content.size && end !== sec.holder && end !== sec.to) insertSectionBreak(tr, end, kind, { fallback });
    if (start > sec.from) {
      const at = insertSectionBreak(tr, start, kind, { fallback });
      return [sectionAt(sectionsOf(tr.doc), at + 1).index];
    }
    return [sec.index];
  }
  return touched(tr.doc, sel.from, sel.to);
}

/** The Page Setup dialog's change in `tr`: `apply` and `sel` choose the sections (applyTargets), `sect` patches each one's sect, `start`
 * sets how each starts (setStart) and the kind of any break Apply to adds, `settings` patches the document settings. → section indices. */
export function applyPageSetup(tr, { apply = 'whole', sel, sect, start, settings }, fallback) {
  const targets = applyTargets(tr, apply, sel, start ?? 'nextPage', fallback);
  // `orient` turns each target and `paper` ({w, h}) sizes it in its own orientation; the other keys patch it as they are.
  const { orient, paper, ...rest } = sect ?? {};
  const change = (old) => {
    let next = orient ? orientSect(old, orient) : old;
    if (paper) next = sizeSect(next, paper.w, paper.h);
    return deepPatch(next, rest);
  };
  for (const i of targets) {
    if (sect && Object.keys(sect).length) updateSect(tr, i, change, fallback);
    if (start) setStart(tr, i, start, fallback);
  }
  if (settings && Object.keys(settings).length) patchSettings(tr, settings);
  return targets;
}
