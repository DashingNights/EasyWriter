// A canvas draft's styles and theme in the DOM editor's form (docs/plans/engine/stage2b.md, engine-gaps-styles): the style
// panes and dialogs read doc.attrs.styles ({defaults: {run, para}, list: {id: style}}) and doc.attrs.theme, so on a canvas draft
// they read the engine's sheet (styles.get with no style) and settings (document.settings) through these conversions, and write
// a style back as styles.define's params. Pure: node tests load it.
import { THEME } from '../../defaults.mjs';
import { charPropsOf, engineHex, hexOf, LIGATURE_FLAGS } from '../font/run.mjs';
import { paraPropsOf } from '../paragraph/rules.mjs';

// ---------- colours ----------
export { hexOf };

// The engine's highlight names (props Highlight) and the app's (OOXML ST_HighlightColor), both ways.
const HIGHLIGHT = { yellow: 'yellow', brightGreen: 'green', turquoise: 'cyan', pink: 'magenta', blue: 'blue', red: 'red', darkBlue: 'darkBlue',
  teal: 'darkCyan', green: 'darkGreen', violet: 'darkMagenta', darkRed: 'darkRed', darkYellow: 'darkYellow', gray50: 'darkGray', gray25: 'lightGray',
  black: 'black', white: 'white' };
const HIGHLIGHT_IN = Object.fromEntries(Object.entries(HIGHLIGHT).map(([k, v]) => [v, k]));

const LIG_ID = { standard: 'standard', 'standard,contextual': 'standardContextual', 'historical,discretional': 'historicalDiscretional',
  'standard,contextual,historical,discretional': 'all' };
const LINE_IN = { multiple: 'auto', atLeast: 'atLeast', exactly: 'exact' };

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

// ---------- engine → DOM ----------
/** The engine's CharProps (its serde names, unset keys absent or null) → the DOM editor's run object (v2 names). */
export function runOfChr(c) {
  if (!c) return {};
  const u = c.underline;
  const lig = c.ligatures && ['standard', 'contextual', 'historical', 'discretional'].filter((k) => c.ligatures[k]).join(',');
  const typography = clean({
    ligatures: c.ligatures ? (lig ? LIG_ID[lig] ?? null : 'none') : undefined,
    numForm: c.numForm ?? undefined, numSpacing: c.numSpacing ?? undefined, stylisticSet: c.stylisticSet ?? undefined,
    contextual: c.contextualAlternates ?? undefined,
  });
  return clean({
    font: c.font, fontEA: c.fontEa, fontCS: c.fontCs, size: c.size, sizeCS: c.sizeCs, bold: c.bold, italic: c.italic,
    underline: u == null ? undefined : u === 'none' ? { val: 'none' } : { val: u, ...(c.underlineColor && { color: hexOf(c.underlineColor) }) },
    strike: c.strike, dstrike: c.doubleStrike, color: c.color == null ? undefined : hexOf(c.color) ?? undefined,
    highlight: c.highlight && c.highlight !== 'none' ? HIGHLIGHT[c.highlight] : undefined,
    superscript: c.vertAlign ? c.vertAlign === 'superscript' : undefined, subscript: c.vertAlign ? c.vertAlign === 'subscript' : undefined,
    caps: c.caps, smallCaps: c.smallCaps, vanish: c.hidden, spacing: c.spacing, scale: c.scale, position: c.position, kern: c.kern,
    em: c.em ?? undefined, lang: c.lang ? { val: c.lang } : undefined, shading: c.shading ? { val: 'clear', color: 'auto', fill: hexOf(c.shading) } : undefined,
    typography: Object.keys(typography).length ? typography : undefined,
  });
}

/** The engine's ParaProps (its own, unset keys absent or null) → the DOM editor's para object (v2 names). */
export function paraOfProps(p) {
  if (!p) return {};
  const ls = p.lineSpacing;
  const indent = clean({ left: p.indentLeft, right: p.indentRight, firstLine: p.indentFirst });
  const spacing = clean({ before: p.spaceBefore, after: p.spaceAfter, beforeAuto: p.spaceBeforeAuto, afterAuto: p.spaceAfterAuto,
    line: ls ? { rule: LINE_IN[ls.rule] ?? 'auto', value: ls.value } : undefined });
  const side = (b) => (b ? clean({ style: b.style && typeof b.style === 'object' ? b.style.art : b.style, width: b.width, space: b.space, color: hexOf(b.color) }) : undefined);
  const borders = p.borders ? clean({ top: side(p.borders.top), left: side(p.borders.left), bottom: side(p.borders.bottom), right: side(p.borders.right),
    between: side(p.borders.between) }) : undefined;
  return clean({
    textAlign: p.align, outline: p.outlineLevel, contextual: p.contextualSpacing, keepNext: p.keepNext, keepLines: p.keepLines,
    pageBreakBefore: p.pageBreakBefore, widowControl: p.widowControl, mirrorIndents: p.mirrorIndents,
    indent: Object.keys(indent).length ? indent : undefined, spacing: Object.keys(spacing).length ? spacing : undefined,
    shading: p.shading ? { val: 'clear', color: 'auto', fill: hexOf(p.shading) } : undefined, borders: borders && Object.keys(borders).length ? borders : undefined,
    tabs: p.tabs?.length ? p.tabs.map((t) => clean({ pos: t.pos, align: t.align, leader: t.leader })) : undefined,
    suppressAutoHyphens: p.suppressHyphens, suppressLineNumbers: p.suppressLineNumbers,
  });
}

/** One style of styles.get's sheet → the DOM editor's style entry. */
export function styleOfEngine(st) {
  const linked = st.type === 'linked';
  return clean({
    type: linked ? 'paragraph' : st.type, name: st.name, aliases: st.aliases ?? undefined, basedOn: st.basedOn ?? undefined, next: st.next ?? undefined,
    link: st.linked ?? undefined, run: Object.keys(runOfChr(st.chr)).length ? runOfChr(st.chr) : undefined,
    para: Object.keys(paraOfProps(st.para)).length ? paraOfProps(st.para) : undefined,
    qFormat: st.quick || undefined, semiHidden: st.hidden || undefined, unhideWhenUsed: (st.hidden && st.unhideWhenUsed !== false) || undefined,
    uiPriority: st.priority ?? undefined, locked: st.locked || undefined, builtIn: st.builtIn || undefined,
  });
}

/** styles.get {}'s value (the whole sheet) → doc.attrs.styles' form {defaults: {run, para}, list: {id: style}}, or null. */
export function stylesOfSheet(sheet) {
  if (!sheet?.styles) return null;
  return {
    defaults: { run: runOfChr(sheet.defaults?.chr), para: paraOfProps(sheet.defaults?.para) },
    list: Object.fromEntries(sheet.styles.map((st) => [st.id, styleOfEngine(st)])),
  };
}

const SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
/** document.settings' value → doc.attrs.theme's form {name, fonts: {major, minor}, colors: {dk1, ...}}. */
export function themeOfSettings(s) {
  if (!s) return THEME;
  const colors = Array.isArray(s.themeColors) && s.themeColors.length === 12
    ? Object.fromEntries(SLOTS.map((k, i) => [k, hexOf(s.themeColors[i]) ?? THEME.colors[k]])) : THEME.colors;
  return { name: s.themeName ?? THEME.name, fonts: { major: s.majorFont ?? THEME.fonts.major, minor: s.minorFont ?? THEME.fonts.minor }, colors };
}
/** A theme's colours ({dk1, ...}) → design.theme's and design.themeColors' twelve 'RRGGBB'. */
export const themeColorList = (colors) => SLOTS.map((k) => engineHex(colors?.[k] ?? THEME.colors[k]) ?? '000000');

// ---------- DOM → engine ----------
const defined = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null));

/** The DOM editor's run object → the engine's CharProps (format.set's and styles.define's props). */
export function chrOfRun(run) {
  const r = defined(run);
  const out = charPropsOf(r);
  // charPropsOf takes a dialog's changes; a style names only what it sets, so the vertical position stays unset unless named.
  if (!r.superscript && !r.subscript && !('superscript' in r) && !('subscript' in r)) delete out.vertAlign;
  if (r.highlight) out.highlight = HIGHLIGHT_IN[r.highlight] ?? 'none';
  if (r.shading?.fill && r.shading.fill !== 'auto') out.shading = engineHex(r.shading.fill);
  if (r.lang?.val) out.lang = r.lang.val;
  if (r.color && typeof r.color === 'string') out.color = engineHex(r.color) ?? 'auto';
  if (r.themeColor && !r.color) delete out.color;
  return out;
}

/** The DOM editor's para object → the engine's ParaProps (para.set's and styles.define's props). */
export function ppOfPara(para) {
  const p = defined(para);
  const out = paraPropsOf(p);
  if (p.shading?.fill && p.shading.fill !== 'auto') out.shading = engineHex(p.shading.fill);
  if (p.tabs?.length) out.tabs = p.tabs.map((t) => defined({ pos: t.pos, align: t.align ?? 'left', leader: t.leader ?? 'none' }));
  if (p.borders) {
    const side = (b) => (b && b.style && b.style !== 'none' && b.style !== 'nil'
      ? defined({ style: b.style, width: b.width ?? 0.5, space: b.space ?? 0, color: engineHex(b.color) }) : null);
    out.borders = defined({ top: side(p.borders.top), left: side(p.borders.left), bottom: side(p.borders.bottom), right: side(p.borders.right),
      between: side(p.borders.between) });
  }
  return out;
}

/** A DOM style entry `s` with id `id` → styles.define's params for a new style (whole run and para). `name` is the shown name: on a
 * built-in style the engine keeps its own name and takes this one as its alias. */
export function defineOf(id, s, { create = false } = {}) {
  const type = s.type === 'paragraph' && s.link ? 'linked' : s.type ?? 'paragraph';
  return defined({
    style: create ? undefined : id, name: s.aliases ?? s.name, type, basedOn: s.basedOn ?? null, next: type === 'character' ? undefined : s.next ?? null,
    chr: chrOfRun(s.run), para: type === 'character' ? undefined : ppOfPara(s.para),
    quick: s.qFormat === undefined ? undefined : !!s.qFormat, hidden: s.semiHidden === undefined ? undefined : !!s.semiHidden,
    unhideWhenUsed: s.semiHidden ? !!s.unhideWhenUsed : undefined, priority: s.uiPriority ?? undefined, locked: s.locked === undefined ? undefined : !!s.locked,
  });
}

/** Engine props `a` → `b` as styles.define's patch: each property that changed, and null for each one `b` took off. */
function patchOf(a, b) {
  const out = {};
  for (const k of Object.keys(a)) if (!(k in b)) out[k] = null;
  for (const [k, v] of Object.entries(b)) if (JSON.stringify(a[k]) !== JSON.stringify(v)) out[k] = v;
  return out;
}

/** The changes between DOM styles `a` and `b` → styles.define steps for each style `b` adds or changes (execMany: one undo step).
 * A changed style sends only the fields and properties that changed, so what these conversions do not carry (a heading's list
 * numbering, bidi, text effects) survives Modify Style, Manage Styles and the Organizer. A style `b` drops is the caller's
 * (styles.delete). */
export function defineSteps(a, b) {
  const was = a?.list ?? {};
  const out = [];
  for (const [id, s] of Object.entries(b?.list ?? {})) {
    const o = was[id];
    if (o && JSON.stringify(o) === JSON.stringify(s)) continue;
    const full = defineOf(id, s);
    if (!o) {
      out.push(['styles.define', { ...full, style: id, name: s.aliases ?? s.name ?? id }]);
      continue;
    }
    const diff = (...keys) => keys.some((k) => JSON.stringify(o[k]) !== JSON.stringify(s[k]));
    const step = { style: id };
    if (diff('name', 'aliases')) step.name = full.name;
    if (diff('type', 'link')) step.type = full.type;
    if (diff('basedOn')) step.basedOn = full.basedOn ?? null;
    if (diff('next')) step.next = full.next ?? null;
    const chr = diff('run') && patchOf(chrOfRun(o.run), full.chr);
    if (chr && Object.keys(chr).length) step.chr = chr;
    const para = diff('para') && full.para && patchOf(o.type === 'character' ? {} : ppOfPara(o.para), full.para);
    if (para && Object.keys(para).length) step.para = para;
    if (diff('qFormat')) step.quick = !!s.qFormat;
    if (diff('semiHidden', 'unhideWhenUsed')) Object.assign(step, { hidden: !!s.semiHidden, unhideWhenUsed: !!s.unhideWhenUsed });
    if (diff('uiPriority')) step.priority = s.uiPriority ?? null;
    if (diff('locked')) step.locked = !!s.locked;
    if (Object.keys(step).length > 1) out.push(['styles.define', step]);
  }
  return out;
}


// ---------- reading a canvas draft ----------
/** A pure engine query's value through ctx.engine, or null. */
const value = (ctx, id, args = {}) => Promise.resolve(ctx.engine.exec(id, args)).then((r) => (r?.ok === false ? null : r?.value ?? null), () => null);

/** styles.inspect's direct properties ([{prop, value}]) → the props object they make. */
export const directOf = (list) => Object.fromEntries((list ?? []).map((d) => [d.prop, d.value]));

/** What the style dialogs read on a canvas draft, from the engine: {engineStyles (doc.attrs.styles' form), engineTheme,
 * engineFmt: {styleId, charStyle, run, para}} (the selection's styles and its direct formatting, as Create New Style takes them). */
export async function engineStyleProps(ctx) {
  const [sheet, settings, inspect] = await Promise.all([value(ctx, 'styles.get'), value(ctx, 'document.settings'), value(ctx, 'styles.inspect')]);
  return {
    engineStyles: stylesOfSheet(sheet) ?? { defaults: {}, list: {} },
    engineTheme: themeOfSettings(settings),
    engineFmt: {
      styleId: inspect?.paragraph?.style ?? 'Normal', charStyle: inspect?.character?.style ?? null,
      run: runOfChr(directOf(inspect?.character?.direct)), para: paraOfProps(directOf(inspect?.paragraph?.direct)),
    },
  };
}

/** The DOM form of a canvas draft's styles for a pane that renders synchronously: styles.get through ctx.read (null until the
 * engine answers, then the pane draws again). */
export const readStyles = (ctx) => stylesOfSheet(ctx.read?.('styles.get', {}));
/** The canvas draft's theme in the DOM form, through ctx.read. */
export const readTheme = (ctx) => themeOfSettings(ctx.read?.('document.settings', {}));
