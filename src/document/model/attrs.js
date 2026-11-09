// Schema v2 attributes (docs/plans/word/plan.md §1.8): the run, paragraph, table, row, cell, picture and hard break attributes,
// and the global layout, docPr and rev attributes, each with its parse (our data attributes, and Word's clipboard CSS where the
// plan names it) and its render (inline style where CSS can say it, else a data attribute). Shapes follow OOXML (w:rPr, w:pPr,
// w:tblPr names) with lengths in points, so docx maps one to one. RUN_CSS and PARA_CSS are the one CSS mapping: the inline render
// here and the style definitions (stylesheet.js) both draw through them, so a property looks the same from a style or direct.
// Pure apart from TipTap's Extension: Node tests load it. The behaviour owners add commands and drawing; this file only
// defines, parses and renders.
import { Extension } from '@tiptap/core';
import { borderCss, deepPatch, EDGES, edgesPt, readJson, shadingCss } from '../../office.mjs';


// ---------- CSS values (Word clipboard HTML and our own rendered HTML) ----------
const PT_PER = { pt: 1, px: 0.75, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12 };
export const round2 = (n) => Math.round(n * 100) / 100;

/** A CSS length in points, or null. */
export function cssPt(v) {
  const m = /^(-?[\d.]+)(pt|px|in|cm|mm|pc)$/.exec(String(v ?? '').trim());
  return m ? round2(parseFloat(m[1]) * PT_PER[m[2]]) : null;
}

// The 16 basic colour names, which Word writes for its basic colours (color:red).
const BASIC = { black: '#000000', silver: '#C0C0C0', gray: '#808080', white: '#FFFFFF', maroon: '#800000', red: '#FF0000', purple: '#800080',
  fuchsia: '#FF00FF', green: '#008000', lime: '#00FF00', olive: '#808000', yellow: '#FFFF00', navy: '#000080', blue: '#0000FF', teal: '#008080',
  aqua: '#00FFFF' };

/** A CSS colour (#rgb, #rrggbb, rgb(), a basic name) as '#RRGGBB', or null (other names and transparent too). */
export function cssHex(v) {
  const s = String(v ?? '').trim();
  if (BASIC[s.toLowerCase()]) return BASIC[s.toLowerCase()];
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) return `#${(m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]).toUpperCase()}`;
  m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(s);
  if (!m || m[4] === '0') return null;
  return `#${m.slice(1, 4).map((x) => (+x).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** Word's mso-* property `prop` of `el`, which survives only in the style attribute's text (the CSSOM drops it), or null. */
export const mso = (el, prop) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(el.getAttribute('style') ?? '')?.[1].trim() ?? null;

/** The style attribute of `props` ({css property: value | null}), or null when every value is null. */
export const style = (props) => {
  const s = Object.entries(props ?? {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`).join('; ');
  return s || null;
};

// ---------- attribute builders ----------
// A data attribute holds JSON (objects and arrays), 'true'/'false' (booleans, where false switches off what a style turns on), a
// number or a string. `css(v, attrs)` gives the inline style; `html(v, attrs)` extra HTML attributes (lang, dir); `word(el)` the
// parse of Word's clipboard CSS, tried when our data attribute is absent. `attrs` is every attribute of the node or mark.
const toData = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
const fromData = (s, kind) => (s == null ? null : kind === 'json' ? readJson(s) : kind === 'bool' ? s !== 'false'
  : kind === 'num' ? (Number.isFinite(+s) ? +s : null) : s);

/** TipTap attribute specs from `defs` {name: {data, kind ('json' | 'bool' | 'num' | 'str'), css?, html?, word?, def?}}. */
export function specs(defs) {
  return Object.fromEntries(Object.entries(defs).map(([name, d]) => [name, {
    default: d.def ?? null,
    ...(d.keepOnSplit === false && { keepOnSplit: false }),
    parseHTML: (el) => fromData(el.getAttribute(d.data), d.kind) ?? d.word?.(el) ?? d.def ?? null,
    renderHTML: (a) => {
      const v = a[name];
      if (v == null) return {};
      return { [d.data]: toData(v), ...d.html?.(v, a), ...(d.css && { style: style(d.css(v, a)) }) };
    },
  }]));
}

const flag = (v, on, off = 'normal') => (v == null ? null : v ? on : off);

// ---------- run properties (textStyle) ----------
const LIGATURES = { none: 'none', standard: 'common-ligatures', contextual: 'contextual', historical: 'historical-ligatures', discretional: 'discretionary-ligatures' };
// w14:ligatures holds a combination such as 'standardContextual'; 'all' is every kind.
const ligatures = (v) => (v === 'all' ? Object.values(LIGATURES).slice(1).join(' ') : v.split(/(?=[A-Z])/).map((p) => LIGATURES[p.toLowerCase()]).filter(Boolean).join(' ') || null);
const EMPHASIS = { dot: 'filled dot', comma: 'filled sesame', circle: 'open circle', underDot: 'filled dot' };

// Shadow, emboss and imprint all draw text-shadow: a false one resets it only when none of the others is on in the same run.
const noShadow = (run, ...others) => (others.some((k) => run?.[k]) ? {} : { 'text-shadow': 'none' });

/** CSS of each run property a style or a run can hold, by its textStyle name, given the run's other properties: the inline
 * render and stylesheet.js both use it. A false draws the reset where CSS has one, so it switches off what a style turns on.
 * ponytail: dstrike false draws nothing, as resetting text-decoration-line would also drop an underline the style sets. */
export const RUN_CSS = {
  caps: (v) => ({ 'text-transform': flag(v, 'uppercase', 'none') }),
  smallCaps: (v) => ({ 'font-variant-caps': flag(v, 'small-caps') }),
  dstrike: (v) => (v ? { 'text-decoration-line': 'line-through', 'text-decoration-style': 'double' } : {}),
  // document.css hides [data-vanish="true"], so Formatting marks can show it; false shows text a style hides.
  vanish: (v) => (v ? { 'mso-hide': 'all' } : { display: 'inline' }),
  outline: (v) => (v ? { '-webkit-text-stroke': '0.04em currentColor', '-webkit-text-fill-color': 'var(--page-color, #ffffff)' }
    : { '-webkit-text-stroke': '0', '-webkit-text-fill-color': 'currentColor' }),
  shadow: (v, run) => (v ? { 'text-shadow': '0.06em 0.06em 0.04em rgb(0 0 0 / 0.45)' } : noShadow(run, 'emboss', 'imprint')),
  emboss: (v, run) => (v ? { 'text-shadow': '-0.04em -0.04em 0 rgb(0 0 0 / 0.35)', color: '#ffffff' } : noShadow(run, 'shadow', 'imprint')),
  imprint: (v, run) => (v ? { 'text-shadow': '0.04em 0.04em 0 rgb(0 0 0 / 0.35)', color: '#ffffff' } : noShadow(run, 'shadow', 'emboss')),
  spacing: (v) => ({ 'letter-spacing': `${v}pt` }),
  position: (v) => ({ 'vertical-align': v ? `${v}pt` : null }),
  kern: (v) => ({ 'font-kerning': v ? 'normal' : null }), // ponytail: kerns at every size, not only from the threshold up
  border: (v) => ({ border: borderCss(v), padding: v.space ? `0 ${v.space}pt` : null }),
  shading: (v) => ({ background: shadingCss(v) }),
  typography: (v) => ({
    'font-variant-ligatures': v.ligatures ? ligatures(v.ligatures) : null,
    'font-variant-numeric': [{ lining: 'lining-nums', oldStyle: 'oldstyle-nums' }[v.numForm], { proportional: 'proportional-nums', tabular: 'tabular-nums' }[v.numSpacing]].filter(Boolean).join(' ') || null,
    'font-feature-settings': [v.stylisticSet && `"ss${String(v.stylisticSet).padStart(2, '0')}"`, v.contextual === false && '"calt" 0'].filter(Boolean).join(', ') || null,
  }),
  em: (v) => ({ 'text-emphasis': EMPHASIS[v] ?? null, 'text-emphasis-position': v === 'underDot' ? 'under right' : null }),
  rtl: (v) => ({ direction: flag(v, 'rtl', 'ltr'), 'unicode-bidi': v ? 'embed' : null }),
  eastAsianLayout: (v) => ({ 'text-combine-upright': v.combine ? 'all' : null }),
};

// A span border from Word's clipboard CSS (border:solid windowtext 1.0pt).
const BORDER_STYLE = { solid: 'single', double: 'double', dotted: 'dotted', dashed: 'dashed', groove: 'threeDEngrave', ridge: 'threeDEmboss', inset: 'inset', outset: 'outset' };
const wordBorder = (el, side = 'Top') => {
  const s = BORDER_STYLE[el.style[`border${side}Style`]];
  return s ? { style: s, width: cssPt(el.style[`border${side}Width`]) ?? 0.5, space: 0, color: cssHex(el.style[`border${side}Color`]) } : null;
};
const ownCss = (prop, re) => (el) => (re.test(el.style[prop] ?? '') ? true : null);

/** textStyle's v2 attributes (schema.js RunProps adds them to font, size, color, themeColor and highlight, with the inheritance
 * from enclosing spans). Each null inherits from the style. */
export const RUN_ATTRS_V2 = specs({
  caps: { data: 'data-caps', kind: 'bool', css: RUN_CSS.caps, word: ownCss('textTransform', /^uppercase$/) },
  smallCaps: { data: 'data-small-caps', kind: 'bool', css: RUN_CSS.smallCaps, word: (el) => (/small-caps/.test(el.style.fontVariant + el.style.fontVariantCaps) || null) },
  dstrike: { data: 'data-dstrike', kind: 'bool', css: RUN_CSS.dstrike },
  vanish: { data: 'data-vanish', kind: 'bool', css: RUN_CSS.vanish, word: (el) => (/^all$/i.test(mso(el, 'mso-hide') ?? '') || el.style.display === 'none' || null) },
  outline: { data: 'data-outline', kind: 'bool', css: RUN_CSS.outline },
  shadow: { data: 'data-shadow', kind: 'bool', css: RUN_CSS.shadow },
  emboss: { data: 'data-emboss', kind: 'bool', css: RUN_CSS.emboss },
  imprint: { data: 'data-imprint', kind: 'bool', css: RUN_CSS.imprint },
  spacing: { data: 'data-spacing', kind: 'num', css: RUN_CSS.spacing, word: (el) => cssPt(el.style.letterSpacing) },
  scale: { data: 'data-scale', kind: 'num', word: (el) => +(mso(el, 'mso-text-width') ?? mso(el, 'mso-font-width') ?? '').replace('%', '') || null },
  position: { data: 'data-position', kind: 'num', css: RUN_CSS.position, word: (el) => cssPt(mso(el, 'mso-text-raise')) ?? cssPt(el.style.verticalAlign) },
  kern: { data: 'data-kern', kind: 'num', css: RUN_CSS.kern, word: (el) => cssPt(mso(el, 'mso-font-kerning')) },
  fitText: { data: 'data-fit-text', kind: 'json' },
  border: { data: 'data-border', kind: 'json', css: RUN_CSS.border, word: (el) => wordBorder(el) },
  shading: { data: 'data-shading', kind: 'json', css: RUN_CSS.shading,
    word: (el) => (mso(el, 'mso-shading') ? { val: 'clear', color: 'auto', fill: cssHex(el.style.backgroundColor) ?? 'auto' } : null) },
  // Only our own: Word writes lang on nearly every span, which would give every pasted run a mark.
  lang: { data: 'data-lang', kind: 'json', html: (v) => (v.val ? { lang: v.val } : {}) },
  noProof: { data: 'data-no-proof', kind: 'bool', html: (v) => (v ? { spellcheck: 'false' } : {}), word: (el) => (/^yes$/i.test(mso(el, 'mso-no-proof') ?? '') || null) },
  effects: { data: 'data-effects', kind: 'json' },
  typography: { data: 'data-typography', kind: 'json', css: RUN_CSS.typography },
  em: { data: 'data-em', kind: 'str', css: RUN_CSS.em },
  fontEA: { data: 'data-font-ea', kind: 'str' },
  fontCS: { data: 'data-font-cs', kind: 'str' },
  // w:rFonts w:hint: which script's font draws the characters several scripts share ('eastAsia', 'cs'). Kept for Word; not drawn.
  hint: { data: 'data-font-hint', kind: 'str' },
  // w:webHidden: hidden in Web Layout (a table of contents' page numbers). Kept for Word; not drawn.
  webHidden: { data: 'data-web-hidden', kind: 'bool' },
  // w:szCs: the size a complex-script run draws at. Word takes a run flagged right-to-left (w:rtl) or complex script (w:cs) at its
  // complex-script size (the Word fixture's 1,638 pt alef holds a page of its own in Word's PDF); after size, so it wins there.
  sizeCS: { data: 'data-size-cs', kind: 'num', css: (v, a) => (a.rtl || a.cs ? { 'font-size': `${v}pt` } : {}) },
  rtl: { data: 'data-rtl', kind: 'bool', css: RUN_CSS.rtl, html: (v) => (v ? { dir: 'rtl' } : {}) },
  cs: { data: 'data-cs', kind: 'bool' },
  charStyle: { data: 'data-cstyle', kind: 'str' },
  eastAsianLayout: { data: 'data-eal', kind: 'json', css: RUN_CSS.eastAsianLayout },
});

// ST_Underline to CSS: the line style and whether it is heavy (the underline mark in schema.js and style definitions).
export const UNDERLINE_CSS = (val) => ({
  'text-decoration-style': /^double|wavyDouble$/.test(val) ? 'double' : /^dotted/.test(val) ? 'dotted' : /^dash|dotDash|dotDotDash/.test(val) ? 'dashed' : /^wav/.test(val) ? 'wavy' : null,
  'text-decoration-thickness': /thick|Heavy/.test(val) ? '2px' : null,
});

// ---------- paragraph properties ----------
/** CSS of each paragraph property a style or a paragraph can hold, by its attribute name (stylesheet.js uses it too). */
export const PARA_CSS = {
  keepNext: (v) => ({ 'page-break-after': v ? 'avoid' : null }),
  keepLines: (v) => ({ 'page-break-inside': v ? 'avoid' : null }),
  pageBreakBefore: (v) => ({ 'page-break-before': v ? 'always' : null }),
  borders: (v) => Object.fromEntries(EDGES.flatMap((e) => (v[e] ? [[`border-${e}`, borderCss(v[e])], [`padding-${e}`, `${v[e].space ?? 0}pt`]] : []))),
  shading: (v) => ({ background: shadingCss(v) }),
  bidi: (v) => ({ direction: flag(v, 'rtl', 'ltr') }),
  asian: (v) => ({ 'line-break': v.kinsoku === false ? 'anywhere' : null, 'word-break': v.wordWrap === false ? 'break-all' : null }),
};

/** paragraph's and heading's v2 attributes (each null inherits from the style). */
export const PARA_ATTRS_V2 = specs({
  tabs: { data: 'data-tabs', kind: 'json' },
  keepNext: { data: 'data-keep-next', kind: 'bool', css: PARA_CSS.keepNext, word: ownCss('pageBreakAfter', /^avoid$/) },
  keepLines: { data: 'data-keep-lines', kind: 'bool', css: PARA_CSS.keepLines, word: ownCss('pageBreakInside', /^avoid$/) },
  widowControl: { data: 'data-widow-control', kind: 'bool', word: (el) => ({ 'widow-orphan': true, none: false }[mso(el, 'mso-pagination')?.toLowerCase()] ?? null) },
  pageBreakBefore: { data: 'data-page-break-before', kind: 'bool', css: PARA_CSS.pageBreakBefore, word: ownCss('pageBreakBefore', /^always$/) },
  outline: { data: 'data-outline', kind: 'num', word: (el) => (mso(el, 'mso-outline-level') ? +mso(el, 'mso-outline-level') - 1 : null) },
  contextual: { data: 'data-contextual', kind: 'bool' },
  borders: { data: 'data-borders', kind: 'json', css: PARA_CSS.borders },
  shading: { data: 'data-shading', kind: 'json', css: PARA_CSS.shading,
    word: (el) => (cssHex(el.style.backgroundColor) ? { val: 'clear', color: 'auto', fill: cssHex(el.style.backgroundColor) } : null) },
  bidi: { data: 'data-bidi', kind: 'bool', css: PARA_CSS.bidi, html: (v) => (v ? { dir: 'rtl' } : {}), word: (el) => (el.getAttribute('dir') === 'rtl' || null) },
  mirrorIndents: { data: 'data-mirror-indents', kind: 'bool' },
  suppressLineNumbers: { data: 'data-suppress-line-numbers', kind: 'bool' },
  suppressAutoHyphens: { data: 'data-suppress-auto-hyphens', kind: 'bool' },
  snapToGrid: { data: 'data-snap-to-grid', kind: 'bool' },
  asian: { data: 'data-asian', kind: 'json', css: PARA_CSS.asian },
  frame: { data: 'data-frame', kind: 'json' },
  collapsed: { data: 'data-collapsed', kind: 'bool' },
  specVanish: { data: 'data-spec-vanish', kind: 'bool' },
  tightWrap: { data: 'data-tight-wrap', kind: 'str' },
  markRun: { data: 'data-mark-run', kind: 'json' },
  markRev: { data: 'data-mark-rev', kind: 'json', keepOnSplit: false },
  pChange: { data: 'data-p-change', kind: 'json' },
});

// ---------- tables ----------
const LOOK = ['firstRow', 'lastRow', 'firstColumn', 'lastColumn', 'noHBand', 'noVBand'];
const LOOK_DEFAULT = { firstRow: true, lastRow: false, firstColumn: true, lastColumn: false, noHBand: false, noVBand: true };
const tableWidth = (w) => (!w || w.type === 'auto' ? null : w.type === 'pct' ? `${w.w}%` : `${w.w}pt`);

/** table's v2 attributes. look renders as the list of its flags that are on (data-look="firstRow firstColumn noVBand"), which
 * the table style's conditional formats select (stylesheet.js); align and indent also go on the editor's wrapper (table-view.js). */
export const TABLE_ATTRS_V2 = {
  look: {
    default: LOOK_DEFAULT,
    parseHTML: (el) => (el.hasAttribute('data-look') ? Object.fromEntries(LOOK.map((k) => [k, el.getAttribute('data-look').split(' ').includes(k)])) : LOOK_DEFAULT),
    renderHTML: ({ look }) => ({ 'data-look': LOOK.filter((k) => look?.[k]).join(' ') }),
  },
  ...specs({
    width: { data: 'data-width', kind: 'json', css: (v) => ({ width: tableWidth(v) }) },
    layout: { data: 'data-layout', kind: 'str', css: (v) => ({ 'table-layout': v === 'fixed' ? 'fixed' : null }) },
    align: { data: 'data-align', kind: 'str', css: (v) => ({ 'margin-left': v === 'center' || v === 'right' ? 'auto' : null, 'margin-right': v === 'center' ? 'auto' : null }),
      word: (el) => ({ center: 'center', right: 'right' }[el.getAttribute('align')] ?? null) },
    indent: { data: 'data-indent', kind: 'num', word: (el) => cssPt(el.style.marginLeft) || null },
    borders: { data: 'data-borders', kind: 'json' },
    cellMargin: { data: 'data-cell-margin', kind: 'json' },
    cellSpacing: { data: 'data-cell-spacing', kind: 'num', css: (v) => ({ 'border-spacing': `${v}pt`, 'border-collapse': v ? 'separate' : null }) },
    float: { data: 'data-float', kind: 'json' },
    caption: { data: 'data-caption', kind: 'str' },
    description: { data: 'data-description', kind: 'str' },
    bidiVisual: { data: 'data-bidi-visual', kind: 'bool' },
  }),
};

/** tableRow's attributes: height {value, rule}, cantSplit, header (repeat as header row), rev (an inserted or deleted row) and
 * tblPrEx (w:tblPrEx, the row's table property exceptions {width, align, cellSpacing, indent, borders, layout, cellMargin}: kept for
 * the round trip, not drawn yet). */
export const ROW_ATTRS = specs({
  height: { data: 'data-height', kind: 'json',
    // At least: min-height for a split table's row grid, and --row-min that document.css gives a whole table's row as height
    // (a table row grows past its height, and table layout ignores min-height).
    css: (v) => (v.rule === 'auto' || !v.value ? {} : v.rule === 'exact' ? { height: `${v.value}pt` } : { 'min-height': `${v.value}pt`, '--row-min': `${v.value}pt` }),
    word: (el) => (cssPt(el.style.height) ? { value: cssPt(el.style.height), rule: mso(el, 'mso-height-rule') === 'exactly' ? 'exact' : 'atLeast' } : null) },
  cantSplit: { data: 'data-cant-split', kind: 'bool', word: ownCss('pageBreakInside', /^avoid$/) },
  header: { data: 'data-header', kind: 'bool' },
  rev: { data: 'data-rev', kind: 'json' },
  tblPrEx: { data: 'data-tbl-pr-ex', kind: 'json' },
});

// btLr reads bottom to top: sideways-lr turns the text only, where a rotated cell would swap its borders and shading.
const WRITING = { tbRl: 'vertical-rl', btLr: 'sideways-lr' };

/** tableCell's and tableHeader's v2 attributes, drawn inline on the cell (direct formatting beats the table style). */
export const CELL_ATTRS_V2 = specs({
  borders: { data: 'data-borders', kind: 'json', css: (v) => Object.fromEntries(EDGES.filter((e) => v[e]).map((e) => [`border-${e}`, borderCss(v[e])])) },
  margins: { data: 'data-margins', kind: 'json', css: (m) => ({ padding: edgesPt(m) }) },
  textDir: { data: 'data-text-dir', kind: 'str', css: (v) => ({ 'writing-mode': WRITING[v] ?? null }),
    word: (el) => (/vertical/.test(mso(el, 'layout-flow') ?? '') ? 'tbRl' : null) },
  noWrap: { data: 'data-no-wrap', kind: 'bool', css: (v) => ({ 'white-space': v ? 'nowrap' : null }), word: (el) => (el.hasAttribute('nowrap') || null) },
  fitText: { data: 'data-fit-text', kind: 'bool' },
  hideMark: { data: 'data-hide-mark', kind: 'bool' },
});

// ---------- pictures ----------
const pct = (n) => `${round2((n ?? 0) * 100)}%`;
/** image's v2 attributes. Picture data renders as data attributes and CSS variables that document.css applies; layout renders
 * as data attributes that the Picture view moves to its outer wrapper (schema.js), never as a CSS float. */
export const IMAGE_ATTRS_V2 = specs({
  layout: { data: 'data-layout', kind: 'json', html: (v) => ({ 'data-wrap': v.wrap ?? 'inline', ...(v.z != null && { 'data-z': String(v.z) }) }) },
  crop: { data: 'data-crop', kind: 'json', css: (v) => ({ '--pic-crop': `inset(${pct(v.t)} ${pct(v.r)} ${pct(v.b)} ${pct(v.l)})` }) },
  adjust: { data: 'data-adjust', kind: 'json', css: (v) => ({
    '--pic-filter': [v.brightness != null && `brightness(${1 + v.brightness / 100})`, v.contrast != null && `contrast(${1 + v.contrast / 100})`,
      v.saturation != null && `saturate(${v.saturation / 100})`].filter(Boolean).join(' ') || null,
    '--pic-opacity': v.transparency != null ? String(1 - v.transparency / 100) : null,
  }) },
  border: { data: 'data-pic-border', kind: 'json', css: (v) => ({ '--pic-border': `${v.width ?? 0.75}pt ${/dash|dot/i.test(v.dash ?? '') ? 'dashed' : 'solid'} ${v.color ?? 'currentColor'}` }) },
  effects: { data: 'data-effects', kind: 'json' },
  style: { data: 'data-pic-style', kind: 'str' },
  rotate: { data: 'data-rotate', kind: 'num', css: (v) => ({ '--pic-rotate': `${v}deg` }) },
  flipH: { data: 'data-flip-h', kind: 'bool', css: (v) => ({ '--pic-flip-h': v ? '-1' : null }) },
  flipV: { data: 'data-flip-v', kind: 'bool', css: (v) => ({ '--pic-flip-v': v ? '-1' : null }) },
  orig: { data: 'data-orig', kind: 'json' },
  decorative: { data: 'data-decorative', kind: 'bool' },
  name: { data: 'data-name', kind: 'str' },
  // An EMF or WMF from a .docx (data URL, image/x-emf or image/x-wmf): src shows a PNG drawn from it, export writes this back.
  metafile: { data: 'data-metafile', kind: 'str' },
  // Ink from a .docx (the InkML of its w14:contentPart): the picture shows Word's fallback drawing of it, export writes both back.
  ink: { data: 'data-ink', kind: 'str' },
  // An SVG from a .docx shows itself; this is Word's PNG of it ({src, of: the key of the SVG it shows}), written back beside it.
  fallback: { data: 'data-fallback', kind: 'json' },
  // DrawingML a .docx gives that no tool edits, written back as it came (docx/dml.mjs): the theme links of the picture's colours
  // (Design > Colors re-resolves them) and a:blip's cstate.
  themeColors: { data: 'data-theme-colors', kind: 'json' },
  cstate: { data: 'data-cstate', kind: 'str' },
});

// ---------- global attributes ----------
/** rev: an inserted or deleted block object ({ins?: {id, author, date}, del?: {...}}), drawn by tracking through data-rev-ins,
 * data-rev-del and data-author. */
export const REV_ATTR = {
  rev: {
    default: null,
    parseHTML: (el) => {
      const ins = readJson(el.getAttribute('data-rev-ins'));
      const del = readJson(el.getAttribute('data-rev-del'));
      return ins || del ? { ...(ins && { ins }), ...(del && { del }) } : null;
    },
    renderHTML: ({ rev }) => (!rev ? {} : {
      ...(rev.ins && { 'data-rev-ins': JSON.stringify(rev.ins) }), ...(rev.del && { 'data-rev-del': JSON.stringify(rev.del) }),
      'data-author': (rev.ins ?? rev.del)?.author ?? '',
    }),
  },
};
// Canvases and plan charts keep every attribute in their data-json (canvas.js, plan-chart.js), so these read it from there.
const fromJson = (key) => ({ default: null, rendered: false, parseHTML: (el) => readJson(el.getAttribute('data-json'))?.[key] ?? null });

const CLEAR = { all: 'all', left: 'left', right: 'right', both: 'all' };

/** The global attributes of schema v2 on nodes and marks this file does not define, and their parse and render. */
export const ModelAttrs = Extension.create({
  name: 'modelAttrs',
  addGlobalAttributes() {
    return [
      { types: ['paragraph', 'heading'], attributes: PARA_ATTRS_V2 },
      { types: ['table'], attributes: TABLE_ATTRS_V2 },
      { types: ['tableRow'], attributes: ROW_ATTRS },
      { types: ['tableCell', 'tableHeader'], attributes: CELL_ATTRS_V2 },
      { types: ['image'], attributes: IMAGE_ATTRS_V2 },
      // w:br w:clear: data-clear only; document.css applies it under engine 2, which places page floats per page (plan.md §1.9).
      { types: ['hardBreak'], attributes: { clear: {
        default: null,
        parseHTML: (el) => CLEAR[el.getAttribute('data-clear') ?? el.getAttribute('clear')] ?? null,
        renderHTML: ({ clear }) => (clear ? { 'data-clear': clear } : {}),
      } } },
      // frame: the window or frame a .docx link opens in (w:tgtFrame), which the HTML target's own default cannot carry.
      { types: ['link'], attributes: specs({ anchor: { data: 'data-anchor', kind: 'str' }, tooltip: { data: 'data-tooltip', kind: 'str' }, frame: { data: 'data-frame', kind: 'str' } }) },
      { types: ['underline'], attributes: specs({ color: { data: 'data-underline-color', kind: 'str', css: (v) => ({ 'text-decoration-color': v }),
        word: (el) => cssHex(el.style.textDecorationColor) } }) },
      { types: ['pageBreak', 'sectionBreak', 'columnBreak', 'columns', 'textBox', 'fieldBlock', 'sdtBlock'], attributes: REV_ATTR },
      // Applied in the kit, where these nodes exist (editors.js).
      { types: ['canvas', 'planChart'], attributes: { layout: fromJson('layout'), docPr: fromJson('docPr'), rev: fromJson('rev') } },
      // The run properties of the run that holds a text box's or a Word canvas's drawing (w:rPr, Word's noProof), in data-json.
      { types: ['textBox', 'canvas'], attributes: { run: fromJson('run') } },
    ];
  },
});
