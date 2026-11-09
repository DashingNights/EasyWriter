// The style panes' pure logic (docs/plans/word plan.md §3 style-panes, briefs/style-panes.md): which styles the Styles pane and
// Manage Styles list and in what order, each style's type mark and description, the Reveal Formatting rows and their compare
// diff, the Recommend and Restrict edits, and the instances of a style in a document. Pure: Node tests load it.
import { deepPatch, isPlain } from '../../../office.mjs';
import { styleChain, styleIdOf } from '../../model/styles.mjs';
import { formatLength } from '../../../tooling/kit/units.mjs';

// Word's latent style data for the built-ins our documents carry (uiPriority, gallery and visibility), as a blank document's
// styles.xml and latentStyles give them (Word 16.0.20527). A style's own keys win. (v) for the ones the probe did not show.
const QF = { qFormat: true };
const HIDE = { semiHidden: true, unhideWhenUsed: true };
export const LATENT = {
  Normal: { uiPriority: 0, ...QF },
  DefaultParagraphFont: { uiPriority: 1, ...HIDE },
  NoSpacing: { uiPriority: 1, ...QF },
  Heading1: { uiPriority: 9, ...QF },
  ...Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`Heading${n}`, { uiPriority: 9, ...QF, ...HIDE }])),
  Title: { uiPriority: 10, ...QF },
  Subtitle: { uiPriority: 11, ...QF },
  Quote: { uiPriority: 29, ...QF },
  IntenseQuote: { uiPriority: 30, ...QF },
  ListParagraph: { uiPriority: 34, ...QF },
  Hyperlink: { uiPriority: 99, ...HIDE },
  TableNormal: { uiPriority: 99, ...HIDE },
  TableGrid: { uiPriority: 39 },
};
/** Word's built-in character style every run has when it has none: drawn in the lists, never stored. */
export const DEFAULT_FONT = { id: 'DefaultParagraphFont', type: 'character', name: 'Default Paragraph Font', ...LATENT.DefaultParagraphFont };
const CUSTOM_PRIORITY = 99; // a style without uiPriority sorts last, as Word's default (v)

/** Whether style `id` is one of Word's built-ins (they cannot be deleted). */
export const isBuiltIn = (id) => Object.hasOwn(LATENT, id);

/** Style `id` with its definition `s` and the latent data under it: {id, type, name, uiPriority, ...}. */
export function infoOf(id, s = {}) {
  const out = { id, ...LATENT[id], ...s };
  out.type ??= 'paragraph';
  out.uiPriority ??= CUSTOM_PRIORITY;
  return out;
}

/** The name the lists show for `s`: Word capitalises its built-in heading names ('heading 1' → 'Heading 1'). */
export const nameOf = (s) => (s?.name ?? s?.id ?? '').replace(/^heading (\d)$/, 'Heading $1');

/** Every style of `styles` (doc.attrs.styles) as infoOf entries, with Default Paragraph Font added. */
export function allStyles(styles) {
  const list = styles?.list ?? {};
  // styles links a paragraph style to '<id>Char' by name when it has no link key; the lists treat both the same.
  const out = Object.entries(list).map(([id, s]) => infoOf(id, s.type !== 'character' && !s.link && list[`${id}Char`] ? { ...s, link: `${id}Char` } : s));
  if (!list.DefaultParagraphFont) out.push({ ...DEFAULT_FONT });
  return out;
}

/** The type of `s` as the lists mark it: 'paragraph', 'character', 'linked', 'table' or 'numbering'. With `noLinked` (Disable
 * Linked Styles) a linked style is a paragraph style. */
export function kindOf(s, { noLinked = false } = {}) {
  if (s.type === 'paragraph' && s.link && !noLinked) return 'linked';
  return s.type === 'numbering' ? 'numbering' : s.type ?? 'paragraph';
}
/** The mark drawn at the right of a style's row, by kindOf (table and list marks are lucide icons in the pane; these are their text). */
export const MARKS = { paragraph: '¶', character: 'a', linked: '¶a', table: '▦', numbering: '☰' };
export const typeMark = (s, opts) => MARKS[kindOf(s, opts)];

/** The paragraphs and runs of each style in `doc` (a ProseMirror doc): {styleId: count}. A character style counts its runs, a
 * run being one stretch of text with that charStyle. */
export function usage(doc) {
  const out = {};
  const add = (id) => {
    out[id] = (out[id] ?? 0) + 1;
  };
  // ponytail: one walk per call over every inline node, memoised by the caller per doc; a counter kept by a plugin if it shows.
  doc.descendants((node) => {
    if (node.isTextblock) {
      add(styleIdOf(node));
      let last = null;
      node.forEach((child) => {
        const cs = child.marks?.find((m) => m.type.name === 'textStyle')?.attrs.charStyle ?? null;
        if (cs && cs !== last) add(cs);
        last = cs;
      });
      return false;
    }
    return true;
  });
  return out;
}

/** The ranges of style `id` in `doc` → [{from, to}] in document order: the text of each paragraph in that paragraph style (its
 * whole content, so an empty paragraph gives an empty range), and each stretch of text with that charStyle. */
export function instancesOf(doc, id) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (styleIdOf(node) === id) out.push({ from: pos + 1, to: pos + node.nodeSize - 1 });
    else {
      let open = null;
      node.forEach((child, offset) => {
        const at = pos + 1 + offset;
        const hit = child.marks?.some((m) => m.type.name === 'textStyle' && m.attrs.charStyle === id);
        if (hit && open && open.to === at) open.to = at + child.nodeSize;
        else if (hit) out.push((open = { from: at, to: at + child.nodeSize }));
        else open = null;
      });
    }
    return false;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Filters and sorts (Style Pane Options, Manage Styles)

/** Style Pane Options' defaults (doc.attrs.settings.stylePaneFormatFilter; Word keeps a bit mask, we keep the names). */
export const PANE_FILTER = { show: 'recommended', para: false, font: false, numbering: false, nextHeading: true, hideBuiltInAlt: false };
export const SHOW = [['recommended', 'Recommended'], ['inUse', 'In use'], ['inDocument', 'In current document'], ['all', 'All styles']];
export const SORTS = [['name', 'Alphabetical'], ['recommended', 'As Recommended'], ['font', 'Font'], ['basedOn', 'Based on'], ['type', 'By type']];

/** Whether `s` (infoOf) is recommended: shown unless semi-hidden, and a hide-until-used style once it is used. */
export const recommended = (s, used) => !s.hidden && (!s.semiHidden || (s.unhideWhenUsed && used > 0));

/** The styles of `styles` that list `show` holds ('recommended', 'inUse', 'inDocument' or 'all') given `counts` (usage); `pane`
 * leaves out table and list styles, which the Styles pane never shows. Show next heading: Heading n+1 counts as recommended
 * once Heading n is used. */
export function filterStyles(styles, counts, { show = 'recommended', nextHeading = true, pane = false } = {}) {
  const used = (id) => counts?.[id] ?? 0;
  const all = allStyles(styles);
  // A linked style's character half ('Heading 2 Char') never has its own row in the pane: the linked row stands for both.
  const halves = new Set(all.map((s) => s.type !== 'character' && s.link).filter(Boolean));
  return all.filter((s) => {
    if (pane && (s.type === 'table' || s.type === 'numbering' || halves.has(s.id))) return false;
    if (s.hidden) return false;
    const h = /^Heading(\d)$/.exec(s.id);
    if (show === 'recommended') return recommended(s, used(s.id)) || (nextHeading && h && +h[1] > 1 && used(`Heading${+h[1] - 1}`) > 0);
    if (show === 'inUse') return used(s.id) > 0 || s.id === 'Normal';
    // In current document: the ones used or written into it (our custom ones), Word's latent built-ins left out until used.
    if (show === 'inDocument') return used(s.id) > 0 || s.id === 'Normal' || !isBuiltIn(s.id);
    return true;
  });
}

const TYPE_ORDER = { paragraph: 0, linked: 0, character: 1, table: 2, numbering: 3 };
const byName = (a, b) => nameOf(a).localeCompare(nameOf(b));

/** `list` (infoOf entries) in sort order `sort` (SORTS ids); `styles` resolves fonts and base names. */
export function sortStyles(list, sort = 'recommended', styles = null) {
  const font = (s) => resolvedRun(styles, s.id).font ?? styles?.defaults?.run?.font ?? '';
  const base = (s) => nameOf(styles?.list?.[s.basedOn] ?? { id: s.basedOn ?? '' });
  const keys = {
    name: () => 0,
    recommended: (a, b) => a.uiPriority - b.uiPriority,
    font: (a, b) => font(a).localeCompare(font(b)),
    basedOn: (a, b) => base(a).localeCompare(base(b)),
    type: (a, b) => TYPE_ORDER[kindOf(a)] - TYPE_ORDER[kindOf(b)],
  };
  const k = keys[sort] ?? keys.recommended;
  return [...list].sort((a, b) => k(a, b) || byName(a, b));
}

// ---------------------------------------------------------------------------------------------
// Recommend and Restrict (Manage Styles)

/** Word's priority box shows uiPriority + 1 (Normal 1, Heading 1 10). */
export const shownPriority = (s) => s.uiPriority + 1;

/** The style list patch ({id: fields}) one Recommend button gives `ids` of `styles`: 'up', 'down', 'last', 'show', 'hideUntilUsed',
 * 'hide', or {value: n} (Assign Value, n as shown, 1 to 100). */
export function recommendPatch(styles, ids, op) {
  const out = {};
  for (const id of ids) {
    const p = infoOf(id, styles?.list?.[id]).uiPriority;
    if (op === 'up') out[id] = { uiPriority: Math.max(0, p - 1) };
    else if (op === 'down') out[id] = { uiPriority: Math.min(99, p + 1) };
    else if (op === 'last') out[id] = { uiPriority: 99 };
    else if (op === 'show') out[id] = { semiHidden: false, unhideWhenUsed: false };
    else if (op === 'hideUntilUsed') out[id] = { semiHidden: true, unhideWhenUsed: true };
    else if (op === 'hide') out[id] = { semiHidden: true, unhideWhenUsed: false };
    else if (op?.value != null) out[id] = { uiPriority: Math.min(99, Math.max(0, Math.round(op.value) - 1)) };
  }
  return out;
}

/** Restrict's Permit and Restrict for `ids` → the list patch setting locked. */
export const restrictPatch = (ids, locked) => Object.fromEntries(ids.map((id) => [id, { locked }]));

/** `styles` with the list `patch` ({id: fields}) merged into each style, which keeps the keys the patch does not name. A style
 * the list lacks (Default Paragraph Font) is written with its latent data. */
export function patchStyles(styles, patch) {
  const list = { ...styles?.list };
  for (const [id, fields] of Object.entries(patch)) list[id] = { ...(list[id] ?? (id === DEFAULT_FONT.id ? { type: 'character', name: DEFAULT_FONT.name } : {})), ...fields };
  return { ...styles, list };
}

/** The visibility label Manage Styles appends, after two spaces as the probe shows: '  (Hide Until Used)', '  (Hide)' or ''. */
export const visibilityOf = (s) => (!s.semiHidden ? '' : s.unhideWhenUsed ? '  (Hide Until Used)' : '  (Hide)');

/** The style list after deleting `id`: styles based on it or followed by it take its own basedOn (Normal when it has none). */
export function withoutStyle(styles, id) {
  const list = { ...styles?.list };
  const heir = list[id]?.basedOn ?? 'Normal';
  delete list[id];
  for (const [k, s] of Object.entries(list)) {
    if (s.basedOn === id || s.next === id || s.link === id) {
      list[k] = { ...s };
      if (s.basedOn === id) list[k].basedOn = heir;
      if (s.next === id) list[k].next = k;
      if (s.link === id) delete list[k].link;
    }
  }
  return { ...styles, list };
}

/** The style list after copying `copies` ({id: style} from another document) into `styles` (the Organizer): a copied style whose
 * base or next style is missing here falls back to Normal (v). */
export function withCopies(styles, copies) {
  const list = { ...styles?.list, ...copies };
  for (const id of Object.keys(copies)) {
    const s = { ...list[id] };
    if (s.basedOn && !list[s.basedOn]) s.basedOn = 'Normal';
    if (s.next && !list[s.next]) s.next = 'Normal';
    if (s.link && !list[s.link]) delete s.link;
    list[id] = s;
  }
  return { ...styles, list };
}

// ---------------------------------------------------------------------------------------------
// Properties and their descriptions

// v1 style keys read as v2 (plan.md §1.6 Props).
export const runV2 = ({ charSpacing, ...r } = {}) => (charSpacing != null && r.spacing == null ? { ...r, spacing: charSpacing } : r);
export const paraV2 = ({ align, border, ...p } = {}) => ({ ...p, ...(align != null && p.textAlign == null && { textAlign: align }), ...(border != null && p.borders == null && { borders: border }) });

const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) if (v != null) out[k] = isPlain(v) && isPlain(out[k]) ? deepPatch(out[k], v) : v;
  return out;
};

/** The run properties style `id` gives, its basedOn chain merged base first (v2 names). */
export const resolvedRun = (styles, id) => styleChain({ styles }, id).reduce((r, s) => merge(r, runV2(s.run)), {});
/** The paragraph properties style `id` gives (v2 names). */
export const resolvedPara = (styles, id) => styleChain({ styles }, id).reduce((p, s) => merge(p, paraV2(s.para)), {});

/** Layers [[source, props]] merged in order → {props, src: {key: the source of the layer that set it}}. */
export function layered(layers) {
  const props = {};
  const src = {};
  for (const [source, obj] of layers) {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v == null) continue;
      props[k] = isPlain(v) && isPlain(props[k]) ? deepPatch(props[k], v) : v;
      src[k] = source;
    }
  }
  return { props, src };
}

const SLOTS = { dk1: 'Text 1', lt1: 'Background 1', dk2: 'Text 2', lt2: 'Background 2', hlink: 'Hyperlink', folHlink: 'Followed Hyperlink' };
/** A colour as Word names it: the theme slot with its tint or shade ('Accent 1, Darker 25%'), else the hex. */
export function colorName(color, themeColor) {
  if (themeColor?.slot) {
    const slot = SLOTS[themeColor.slot] ?? themeColor.slot.replace(/^accent(\d)$/, 'Accent $1');
    const lum = Math.round((themeColor.lum ?? 0) * 100);
    return lum < 0 ? `${slot}, Darker ${-lum}%` : lum > 0 ? `${slot}, Lighter ${lum}%` : slot;
  }
  return color ?? 'Automatic';
}

/** A font as Word names it: '+Body (Aptos)', '+Headings (Aptos Display)' or the family. */
export function fontName(font, theme) {
  if (font === '+minor') return `+Body${theme?.fonts?.minor ? ` (${theme.fonts.minor})` : ''}`;
  if (font === '+major') return `+Headings${theme?.fonts?.major ? ` (${theme.fonts.major})` : ''}`;
  return font;
}

const ALIGN = { left: 'Left', center: 'Centered', right: 'Right', justify: 'Justified', distribute: 'Distributed' };
const n2 = (v) => Number(v.toFixed(2));

/** Line spacing `line` ({rule, value}) as Word writes it: 'Single', '1.5 lines', 'Double', 'Multiple 1.16 li', 'At least 12 pt',
 * 'Exactly 12 pt'. */
export function lineName(line) {
  if (!line) return null;
  if (line.rule === 'exact') return `Exactly ${n2(line.value)} pt`;
  if (line.rule === 'atLeast') return `At least ${n2(line.value)} pt`;
  return { 1: 'Single', 1.5: '1.5 lines', 2: 'Double' }[n2(line.value)] ?? `Multiple ${n2(line.value)} li`;
}

const underlineOf = (u) => (u == null || u === false ? null : typeof u === 'object' ? u.val : u);

/** Run properties `run` as rows [{key, label, value}] in Word's order, lengths in `unit`; `theme` names the theme fonts. */
export function runRows(run, { theme } = {}) {
  const r = runV2(run);
  const rows = [];
  const add = (key, label, value) => value != null && value !== false && rows.push({ key, label, value: String(value) });
  add('font', 'Font', r.font && fontName(r.font, theme));
  add('size', 'Size', r.size != null && `${n2(r.size)} pt`);
  add('bold', 'Bold', r.bold === true ? 'Bold' : r.bold === false ? 'Not Bold' : null);
  add('italic', 'Italic', r.italic === true ? 'Italic' : r.italic === false ? 'Not Italic' : null);
  const u = underlineOf(r.underline);
  add('underline', 'Underline', u && u !== 'none' ? (u === 'single' ? 'Underline' : `Underline ${u}`) : null);
  add('color', 'Font color', (r.color || r.themeColor) && colorName(r.color, r.themeColor));
  add('highlight', 'Highlight', r.highlight);
  add('strike', 'Strikethrough', r.strike && 'Strikethrough');
  add('dstrike', 'Double strikethrough', r.dstrike && 'Double strikethrough');
  add('superscript', 'Superscript', r.superscript && 'Superscript');
  add('subscript', 'Subscript', r.subscript && 'Subscript');
  add('caps', 'All caps', r.caps && 'All caps');
  add('smallCaps', 'Small caps', r.smallCaps && 'Small caps');
  add('vanish', 'Hidden', r.vanish && 'Hidden');
  add('spacing', 'Character spacing', r.spacing ? `${r.spacing > 0 ? 'Expanded' : 'Condensed'} by ${n2(Math.abs(r.spacing))} pt` : null);
  add('scale', 'Scale', r.scale != null && r.scale !== 100 && `${r.scale}%`);
  add('position', 'Position', r.position ? `${r.position > 0 ? 'Raised' : 'Lowered'} by ${n2(Math.abs(r.position))} pt` : null);
  add('kern', 'Kerning', r.kern && `Kern at ${n2(r.kern)} pt`);
  add('lang', 'Language', r.lang?.val);
  return rows;
}

/** Paragraph properties `para` as rows [{key, label, value}], lengths in `unit` ('cm', 'in', 'pt'...). */
export function paraRows(para, { unit = 'cm' } = {}) {
  const p = paraV2(para);
  const rows = [];
  const add = (key, label, value) => value != null && value !== false && value !== '' && rows.push({ key, label, value: String(value) });
  const len = (v) => formatLength(v, unit);
  add('textAlign', 'Alignment', p.textAlign && (ALIGN[p.textAlign] ?? p.textAlign));
  add('outline', 'Outline level', p.outline != null && (p.outline >= 9 ? 'Body Text' : `Level ${p.outline + 1}`));
  const ind = p.indent ?? {};
  add('indent', 'Indentation', [ind.left != null && `Left: ${len(ind.left)}`, ind.right != null && `Right: ${len(ind.right)}`,
    ind.firstLine > 0 && `First line: ${len(ind.firstLine)}`, ind.firstLine < 0 && `Hanging: ${len(-ind.firstLine)}`].filter(Boolean).join(', '));
  const sp = p.spacing ?? {};
  add('spaceBefore', 'Space before', sp.before != null && `${n2(sp.before)} pt`);
  add('spaceAfter', 'Space after', sp.after != null && `${n2(sp.after)} pt`);
  add('line', 'Line spacing', lineName(sp.line));
  add('keepNext', 'Keep with next', p.keepNext && 'Keep with next');
  add('keepLines', 'Keep lines together', p.keepLines && 'Keep lines together');
  add('pageBreakBefore', 'Page break before', p.pageBreakBefore && 'Page break before');
  add('widowControl', 'Widow/Orphan control', p.widowControl === false ? 'No widow/orphan control' : null);
  add('contextual', 'Contextual spacing', p.contextual && "Don't add space between paragraphs of the same style");
  const sides = Object.entries(p.borders ?? {}).filter(([, b]) => b && b.style && b.style !== 'none').map(([k]) => k[0].toUpperCase() + k.slice(1));
  add('borders', 'Border', sides.length ? sides.join(', ') : null);
  add('shading', 'Shading', p.shading?.fill && p.shading.fill !== 'auto' ? p.shading.fill : null);
  return rows;
}

/** One line joining `rows` as Word's descriptions do ('Font: +Body (Aptos), Size: 12 pt'). */
export const joinRows = (rows) => rows.map((r) => `${r.label}: ${r.value}`).join(', ');

/** The description Word shows for style `id` of `styles` (the Styles pane tooltip, Manage Styles): its own properties over its
 * base, then the style's settings. `unit` for lengths; `theme` names the theme fonts. */
export function styleDescription(styles, id, { unit = 'cm', theme } = {}) {
  const s = infoOf(id, styles?.list?.[id] ?? (id === DEFAULT_FONT.id ? DEFAULT_FONT : {}));
  const own = id === 'Normal' ? layered([['defaults', styles?.defaults?.run], ['style', runV2(s.run)]]).props : runV2(s.run);
  const ownPara = id === 'Normal' ? layered([['defaults', paraV2(styles?.defaults?.para)], ['style', paraV2(s.para)]]).props : paraV2(s.para);
  const parts = [joinRows(runRows(own, { theme })), joinRows(paraRows(ownPara, { unit }))].filter(Boolean);
  const style = [s.qFormat && 'Show in the Styles gallery', s.semiHidden && (s.unhideWhenUsed ? 'Hide until used' : 'Hidden'), s.link && 'Linked',
    s.locked && 'Restricted', `Priority: ${shownPriority(s)}`].filter(Boolean);
  if (s.basedOn) parts.push(`Based on: ${nameOf(infoOf(s.basedOn, styles?.list?.[s.basedOn]))}`);
  if (s.next && s.next !== id) parts.push(`Following style: ${nameOf(infoOf(s.next, styles?.list?.[s.next]))}`);
  parts.push(`Style: ${style.join(', ')}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------------------------
// Reveal Formatting

/** The Reveal Formatting sections of a selection: [{id, title, dialog, rows: [{key, label, value, source}]}]. `fmt` holds the
 * layered run and paragraph ({props, src}, from layered), `styleId`, `charStyle`, `list` ({numId, ilvl, fmt} or null) and `sect`;
 * `unit` and `theme` as for paraRows and runRows. */
export function revealSections(fmt, { unit = 'cm', theme, styles } = {}) {
  const tag = (rows, src) => rows.map((r) => ({ ...r, source: src?.[r.key] ?? src?.[KEY_SRC[r.key]] ?? 'style' }));
  const name = (id) => nameOf(infoOf(id, styles?.list?.[id]));
  const font = [
    ...(fmt.charStyle ? [{ key: 'charStyle', label: 'Character style', value: name(fmt.charStyle), source: 'direct' }] : []),
    ...tag(runRows(fmt.run.props, { theme }), fmt.run.src),
  ];
  const para = [{ key: 'style', label: 'Paragraph style', value: name(fmt.styleId), source: 'style' }, ...tag(paraRows(fmt.para.props, { unit }), fmt.para.src)];
  const list = fmt.list ? [{ key: 'list', label: 'List', value: `Level ${fmt.list.ilvl + 1}, ${fmt.list.fmt ?? 'bullet'}`, source: 'direct' }]
    : [{ key: 'list', label: 'List', value: 'None', source: 'style' }];
  const m = fmt.sect?.margin ?? {};
  const len = (v) => formatLength(v ?? 0, unit);
  const sect = fmt.sect ? [
    { key: 'margins', label: 'Margins', value: `Left: ${len(m.left)}, Right: ${len(m.right)}, Top: ${len(m.top)}, Bottom: ${len(m.bottom)}` },
    { key: 'orient', label: 'Orientation', value: fmt.sect.orient === 'landscape' ? 'Landscape' : 'Portrait' },
    { key: 'paper', label: 'Paper', value: `Width: ${len(fmt.sect.w)}, Height: ${len(fmt.sect.h)}` },
    { key: 'start', label: 'Section start', value: { nextPage: 'New page', continuous: 'Continuous', evenPage: 'Even page', oddPage: 'Odd page', nextColumn: 'New column' }[fmt.sect.type ?? 'nextPage'] },
  ].map((r) => ({ ...r, source: 'direct' })) : [];
  return [
    { id: 'font', title: 'Font', dialog: 'font', rows: font },
    { id: 'paragraph', title: 'Paragraph', dialog: 'paragraph', rows: para },
    { id: 'list', title: 'Bullets and Numbering', dialog: 'defineNewNumberFormat', rows: list },
    { id: 'section', title: 'Section', dialog: 'pageSetup', rows: sect },
  ];
}
// Rows built from several keys take the source of one of them.
const KEY_SRC = { spaceBefore: 'spacing', spaceAfter: 'spacing', line: 'spacing' };

/** Compare: sections `b` (the current selection) against `a` (the first) → the same sections holding only the rows that differ,
 * each value 'old -> new' ('(none)' where one side lacks the row). */
export function diffSections(a, b) {
  return b.map((sec) => {
    const old = new Map((a.find((x) => x.id === sec.id)?.rows ?? []).map((r) => [r.key, r.value]));
    const now = new Map(sec.rows.map((r) => [r.key, r]));
    const keys = [...new Set([...old.keys(), ...now.keys()])];
    const rows = keys.filter((k) => old.get(k) !== now.get(k)?.value).map((k) => {
      const label = now.get(k)?.label ?? a.flatMap((x) => x.rows).find((r) => r.key === k)?.label ?? k;
      return { key: k, label, value: `${old.get(k) ?? '(none)'} -> ${now.get(k)?.value ?? '(none)'}`, source: now.get(k)?.source ?? 'direct' };
    });
    return { ...sec, rows };
  });
}

// The paragraph attributes that are not formatting (identity, lists, review data), left out of "direct formatting".
const NOT_FORMAT = new Set(['styleId', 'level', 'numbering', 'suggest', 'id', 'collapsed', 'markRev', 'pChange', 'rev', 'specVanish']);
/** The direct paragraph formatting of `attrs` (a paragraph or heading node's) → {key: value} of the keys set. */
export const directPara = (attrs) => Object.fromEntries(Object.entries(attrs ?? {}).filter(([k, v]) => v != null && !NOT_FORMAT.has(k)));
