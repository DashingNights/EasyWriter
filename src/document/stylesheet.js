// The Document's style definitions as CSS (docs/plans/document.md Document-level data): one <style> per editor, scoped by a
// data-doc id on its .ProseMirror, so the assistant's background session editors keep their own. Built from doc.attrs styles
// (docDefaults and styles.xml) and theme, and rebuilt when a transaction changes either. Direct formatting is inline style on
// the nodes and marks (schema.js), so it wins over these rules. Every v2 run and paragraph property a style holds draws through
// the same CSS mapping as direct formatting (model/attrs.js RUN_CSS, PARA_CSS; docs/plans/word/plan.md §1.8), and every border
// and shading through office.mjs borderCss and shadingCss.
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { borderCss, edgesPt, fontStack, HIGHLIGHTS, shadingCss } from '../office.mjs';
import { PARA_CSS, RUN_CSS, UNDERLINE_CSS } from './model/attrs.js';
import { charRun, resolved, resolvedAll } from './model/resolved.mjs';

// Style resolution is pure (model/resolved.mjs, shared with the layout predictor's worker); re-exported for the editor's modules.
export { charRun, resolved, resolvedAll };

const HEADINGS = [1, 2, 3, 4, 5, 6];
const TAGS = ['p', ...HEADINGS.map((n) => `h${n}`)]; // the text blocks (TEXT below as tags)
const decl = (props) => Object.entries(props).filter(([, v]) => v != null).map(([k, v]) => `${k}:${v}`).join(';');

const fontCss = (font) => (!font ? null : font.startsWith('+') ? `var(--doc-${font.slice(1)})` : fontStack(font));

// Each property's CSS from its mapping in model/attrs.js, for the keys of `props` that have one.
const mapped = (map, props) => Object.assign({}, ...Object.entries(props).filter(([k, v]) => v != null && map[k]).map(([k, v]) => map[k](v, props)));
// Run properties that draw a box behind or around the text (highlight too, below), and vanish false (display: inline): on a
// paragraph or cell rule they would draw on, or unblock, the whole block. rtl too: Word sets a paragraph's direction from its
// bidi only, so a style's run rtl must not turn the paragraph.
// ponytail: so a paragraph or table style's run highlight, shading, border, raise and rtl draw nothing, and its vanish hides
// the whole block (a run inside with direct vanish false stays hidden, Word shows it); a rule on its runs would miss text that
// has no textStyle span, so drawing them needs every run wrapped.
const BLOCK_SKIP = new Set(['border', 'shading', 'position', 'vanish', 'rtl']);

/** The CSS of a style's run properties (v1's names and every textStyle attribute): a character style's on its runs, else
 * (`block`) a paragraph's, a heading's or a table cell's, which leaves out the BLOCK_SKIP properties. */
export function runCss(run = {}, block = false) {
  const u = run.underline && typeof run.underline === 'object' ? run.underline.val : run.underline;
  const own = block ? Object.fromEntries(Object.entries(run).filter(([k]) => !BLOCK_SKIP.has(k))) : run;
  return {
    'font-family': fontCss(run.font),
    'font-size': run.size ? `${run.size}pt` : null,
    color: run.color ?? null,
    'font-weight': run.bold == null ? null : run.bold ? 'bold' : 'normal',
    'font-style': run.italic == null ? null : run.italic ? 'italic' : 'normal',
    'text-decoration-line': u == null ? null : u === 'none' ? 'none' : 'underline',
    ...(u && UNDERLINE_CSS(u)),
    'letter-spacing': run.charSpacing ? `${run.charSpacing}pt` : null, // v1's name for spacing
    ...mapped(RUN_CSS, own),
    // Underline and double strike both draw, as in Word. ponytail: CSS has one decoration style, so the underline is double too.
    ...(u && u !== 'none' && run.dstrike && { 'text-decoration-line': 'underline line-through' }),
    'background-color': block ? null : HIGHLIGHTS[run.highlight] ?? null, // after shading's background: highlight wins, as in Word
    ...(run.vanish && { display: 'none' }), // direct hidden text hides through document.css [data-vanish]
  };
}

/** The CSS of a style's paragraph properties (textAlign or v1's align, borders or v1's border, and every paragraph attribute that
 * CSS can draw). */
export function paraCss(para = {}) {
  const { spacing: s = {}, indent: i = {} } = para;
  const align = para.textAlign ?? para.align; // v1 built-ins name it align
  const line = s.line && (s.line.rule === 'auto' ? String(s.line.value) : `${s.line.value}pt`);
  return {
    'margin-top': s.before != null ? `${s.before}pt` : null,
    'margin-bottom': s.after != null ? `${s.after}pt` : null,
    'line-height': line ?? null,
    'margin-left': i.left != null ? `${i.left}pt` : null,
    'margin-right': i.right != null ? `${i.right}pt` : null,
    'text-indent': i.firstLine != null ? `${i.firstLine}pt` : null,
    'text-align': align === 'distribute' ? 'justify' : align === 'both' ? 'justify' : align ?? null,
    'text-align-last': align === 'distribute' ? 'justify' : null,
    ...mapped(PARA_CSS, { ...para, borders: para.borders ?? para.border }), // v1's built-ins name it border
  };
}

// The conditional formats of a table style (w:tblStylePr) in the order Word applies them, later ones winning: each selects the
// cells it covers through the table's data-look flags (schema v2 table look). :where keeps every one at the specificity of
// the table style's own cell rule, so this order decides.
const ODD = 'nth-child(odd)';
const EVEN = 'nth-child(even)';
const ROWS = (look, nth) => `table${look} > tbody > tr:${nth}`;
const COLS = (look, nth) => `table${look} > tbody > tr > :${nth}`;
// The header row: the first row, and every repeating header row (w:tblHeader, data-header) from the top, as Word formats them all
// as its first row (the Word fixture's Calendar 2: its second header row, the weekdays, in the first row's blue).
const HEAD = ':is(tr:first-child, tr[data-header]:not(tr:not([data-header]) ~ tr))';
const COND = [
  ['band1Vert', ':not([data-look~="noVBand"])', `:is(${COLS('[data-look~="firstColumn"]', EVEN)}, ${COLS(':not([data-look~="firstColumn"])', ODD)})`],
  ['band2Vert', ':not([data-look~="noVBand"])', `:is(${COLS('[data-look~="firstColumn"]', `${ODD}:not(:first-child)`)}, ${COLS(':not([data-look~="firstColumn"])', EVEN)})`],
  ['band1Horz', ':not([data-look~="noHBand"])', `:is(${ROWS('[data-look~="firstRow"]', EVEN)}, ${ROWS(':not([data-look~="firstRow"])', ODD)}) > *`],
  ['band2Horz', ':not([data-look~="noHBand"])', `:is(${ROWS('[data-look~="firstRow"]', `${ODD}:not(:first-child)`)}, ${ROWS(':not([data-look~="firstRow"])', EVEN)}) > *`],
  ['firstCol', '[data-look~="firstColumn"]', 'tr > :first-child'],
  ['lastCol', '[data-look~="lastColumn"]', 'tr > :last-child'],
  ['firstRow', '[data-look~="firstRow"]', `${HEAD} > *`],
  ['lastRow', '[data-look~="lastRow"]', 'tr:last-child > *'],
  ['neCell', '[data-look~="firstRow"][data-look~="lastColumn"]', `${HEAD} > :last-child`],
  ['nwCell', '[data-look~="firstRow"][data-look~="firstColumn"]', `${HEAD} > :first-child`],
  ['seCell', '[data-look~="lastRow"][data-look~="lastColumn"]', 'tr:last-child > :last-child'],
  ['swCell', '[data-look~="lastRow"][data-look~="firstColumn"]', 'tr:last-child > :first-child'],
];

/** The region a conditional format covers: rows, columns or one corner cell. */
const regionOf = (key) => (/Row|Horz/.test(key) ? 'row' : /Col|Vert/.test(key) ? 'col' : 'cell');

/** A table style's or a conditional format's cell borders: one edge object for all sides (v1's Table Grid) or {top, left,
 * bottom, right, insideH, insideV}. → [selector suffix, css] pairs. The edges are the region's, as Word draws a tblStylePr's
 * tcBorders: the whole table's, a row's (every cell takes top and bottom, the row's ends left and right, insideV between), a
 * column's (the transpose) or a corner cell's (all four on the cell). */
export function borderRules(b, region = 'table') {
  if (!b) return [];
  const all = b.style ? { top: b, right: b, bottom: b, left: b, insideH: b, insideV: b } : b;
  const css = (e) => (e ? borderCss(e) : null);
  // A side whose region spans cells that way: its outer edge on the cells at that end, the inside edge on the rest.
  const side = (prop, outer, inside, end, spans) => (spans
    ? [[`:where(${end})`, { [prop]: css(outer) }], [`:where(:not(${end}))`, { [prop]: css(inside) }]] : [['', { [prop]: css(outer) }]]);
  const rows = region === 'table' || region === 'col';
  const cols = region === 'table' || region === 'row';
  return [
    ...side('border-top', all.top, all.insideH, 'tr:first-child > *', rows),
    ...side('border-bottom', all.bottom, all.insideH, 'tr:last-child > *', rows),
    ...side('border-left', all.left, all.insideV, 'tr > :first-child', cols),
    ...side('border-right', all.right, all.insideV, 'tr > :last-child', cols),
  ];
}

/** The class a table of style `id` carries (table-view.js, and drawings made through DOMSerializer by classTables), which the
 * table style's rules select it by: the browser's ancestor filter knows classes and not attribute values, so with [data-style]
 * every cell was matched against every table style's rules (seconds per restyle with Word's 133 built-in table styles). Same
 * specificity as the attribute. */
export const tableStyleClass = (id) => `ts-${String(id).replace(/[^A-Za-z0-9-]/g, (c) => `_${c.codePointAt(0).toString(36)}_`)}`;

/** Gives every table[data-style] inside `root` its style's class: a static drawing (a header, a note) has no table view to. */
export function classTables(root) {
  for (const t of root?.querySelectorAll?.('table[data-style]') ?? []) t.classList.add(tableStyleClass(t.getAttribute('data-style')));
}

/** The CSS of a Document's `styles` and `theme` (doc.attrs) under `scope`. */
export function styleSheetCss(scope, styles, theme) {
  const list = styles?.list ?? {};
  const defaults = styles?.defaults ?? {};
  const out = [];
  const rule = (sel, props) => {
    const d = decl(props);
    if (d) out.push(`${sel}{${d}}`);
  };
  rule(scope, {
    '--doc-major': fontStack('+major', theme),
    '--doc-minor': fontStack('+minor', theme),
    color: theme?.colors?.dk1 ?? '#000000',
    ...runCss(defaults.run, true),
  });
  const TEXT = ':is(p,h1,h2,h3,h4,h5,h6)';
  rule(`${scope} ${TEXT}`, { 'margin-top': '0', 'margin-bottom': '0', ...paraCss(defaults.para) });
  // Headings first: a paragraph style on a heading ([data-style], more specific) wins over its implied HeadingN.
  for (const n of HEADINGS) {
    const s = resolved(list, `Heading${n}`);
    rule(`${scope} h${n}`, { ...paraCss(s.para), ...runCss(s.run, true) });
  }
  for (const [id, s] of Object.entries(list)) {
    // Heading 1 to 6 are heading nodes (above); Heading 7 to 9 are paragraphs with the styleId. A paragraph without one takes
    // Normal, the default paragraph style, as a Word paragraph without w:pStyle does; a table style's paragraph rule still wins.
    if (s.type !== 'paragraph' || /^Heading[1-6]$/.test(id)) continue;
    const r = resolved(list, id);
    rule(id === 'Normal' ? `${scope} p:not([data-style])` : `${scope} [data-style="${id}"]`, { ...paraCss(r.para), ...runCss(r.run, true) });
  }
  // Word suppresses the Hyperlink style on the entries of a hyperlinked table of contents (\h): they keep their paragraph's look.
  const notToc = ':not(:where(div[data-field-block] a[data-anchor], div[data-field-block] a[data-anchor] *))';
  if (list.Hyperlink) rule(`${scope} a${notToc}`, runCss(list.Hyperlink.run));
  // Character styles (a run's charStyle, data-cstyle) after the paragraph styles: Word draws them over the paragraph's.
  for (const [id, s] of Object.entries(list)) if (s.type === 'character') rule(`${scope} [data-cstyle="${id}"]${id === 'Hyperlink' ? notToc : ''}`, runCss(charRun(list, id)));
  // A table style's cells as a selector list, one selector per cell tag and, for their paragraphs, per text tag: the browser files
  // a rule under its last compound's tag, and one ending in :is(td,th) or TEXT went on the list every element is matched against
  // (the Word fixture's 133 table styles made a full style recalc take 8 s, 1.7 s split). Same matches and specificity.
  const cellsOf = (pre, post = '', text = false) => ['td', 'th'].flatMap((c) => (text ? TAGS : [''])
    .map((tag) => `${pre} ${c}${post}${tag && ` ${tag}`}`)).join(',');
  for (const [id, s] of Object.entries(list)) {
    if (s.type !== 'table') continue;
    const { table = {}, para, run } = resolved(list, id);
    const m = table.cellMargin;
    const b = table.borders;
    const t = `${scope} table.${tableStyleClass(id)}`;
    // A table's own cell margins (table-view.js --tbl-cell-margin) win over these in document.css.
    rule(cellsOf(t), { padding: m ? edgesPt(m) : null, background: shadingCss(table.shading), ...runCss(run, true) });
    for (const [sel, css] of borderRules(b)) rule(cellsOf(t, sel), css);
    rule(cellsOf(t, '', true), paraCss(para));
    for (const [key, look, where] of COND) {
      const c = table.cond?.[key];
      if (!c) continue;
      const pre = `${t}:where(${look})`;
      const w = `:where(${where})`;
      rule(cellsOf(pre, w), { ...runCss(c.run, true), background: shadingCss(c.cell?.shading) });
      for (const [suffix, css] of borderRules(c.cell?.borders, regionOf(key))) rule(cellsOf(pre, `${w}${suffix}`), css);
      rule(cellsOf(pre, w, true), paraCss(c.para));
    }
    // The row grids overlap by one border (document.css), so a row moved to the next page keeps its top border.
    const inner = b?.style ? b : b?.insideH;
    rule(t, { '--cell-border': inner?.width ? `${inner.width}pt` : null });
  }
  // In a cell, a paragraph style other than Normal wins over the table style's paragraph properties where it sets its own (values
  // that differ from Normal's): Word's order is table style, then paragraph style. The Word fixture's With Subheads quick tables
  // (Medium Shading 2 with spacing after 0, cells in Decimal Aligned with 10 pt after) keep Decimal Aligned's spacing in Word's PDF.
  // Doubled attribute: more specific than every table style rule above, conditional ones included.
  const normal = paraCss(resolved(list, 'Normal').para);
  for (const [id, s] of Object.entries(list)) {
    if (s.type !== 'paragraph' || id === 'Normal' || /^Heading[1-6]$/.test(id)) continue;
    const own = Object.fromEntries(Object.entries(paraCss(resolved(list, id).para)).filter(([k, v]) => v != null && normal[k] !== v));
    rule(['td', 'th'].map((c) => `${scope} ${c} [data-style="${id}"][data-style]`).join(','), own);
  }
  return out.join('\n');
}

let ids = 0;

/** Renders the open doc's styles into its own <style> element, scoped by data-doc on the editor's .ProseMirror. */
export const StyleSheet = Extension.create({
  name: 'styleSheet',
  addProseMirrorPlugins() {
    const id = `d${++ids}`;
    const scope = `.ProseMirror[data-doc="${id}"]`;
    return [new Plugin({
      props: { attributes: { 'data-doc': id } },
      view(view) {
        const el = view.dom.ownerDocument.createElement('style');
        el.dataset.docStyles = id;
        view.dom.ownerDocument.head.append(el);
        const render = ({ styles, theme }) => {
          el.textContent = styleSheetCss(scope, styles, theme);
        };
        render(view.state.doc.attrs);
        return {
          update(v, prev) {
            const a = v.state.doc.attrs;
            if (a.styles !== prev.doc.attrs.styles || a.theme !== prev.doc.attrs.theme) render(a);
          },
          destroy: () => el.remove(),
        };
      },
    })];
  },
});
