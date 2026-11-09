// The Design tab's data and pure logic (docs/plans/word/plan.md §3 design, briefs/design.md): our own themes, colour sets, font
// sets, effect sets and style sets, Word's Paragraph Spacing presets, and the functions that write them into doc.attrs.theme and
// doc.attrs.styles. Every name and design here is our own: none is Microsoft's (codemap.md §7 No Microsoft branding), and
// test/word-design.test.mjs checks the names against Word's menus. Pure: no DOM or app import, so node tests load it.
import { deepPatch, resolveColor } from '../../../office.mjs';
import { BUILTIN_STYLES, DOC_DEFAULTS, THEME } from '../../defaults.mjs';
import { boxLook, boxSpXml, refsXml, rethemeItems, shapeLook } from '../../docx/dml.mjs';
import { fillFields, fillLinks, lineFields, themed } from '../../docx/shapes-in.mjs';
import { fillXml, lineXml, shadowXml } from '../../docx/shapes-out.mjs';

const C = (dk2, lt2, a1, a2, a3, a4, a5, a6, hlink, folHlink) => ({
  dk1: '#000000', lt1: '#FFFFFF', dk2, lt2, accent1: a1, accent2: a2, accent3: a3, accent4: a4, accent5: a5, accent6: a6, hlink, folHlink,
});

/** Effect sets: a name stored as theme.effects. Nothing in a Document draws them yet; shapes may read the name. */
export const EFFECTS = [
  { id: 'plain', name: 'Plain' },
  { id: 'softShadow', name: 'Soft Shadow' },
  { id: 'raised', name: 'Raised' },
  { id: 'thinOutline', name: 'Thin Outline' },
  { id: 'gentleGlow', name: 'Gentle Glow' },
  { id: 'chiselled', name: 'Chiselled' },
];

/** The built-in themes: Default (a new Document's THEME) and our own, each {id, name, fonts, colors, effects}. */
export const THEMES = [
  { id: 'default', ...THEME, effects: 'Plain' },
  { id: 'harbour', name: 'Harbour', fonts: { major: 'Georgia', minor: 'Segoe UI' }, effects: 'Soft Shadow',
    colors: C('#1B2A3A', '#E9EEF2', '#1F4E79', '#2A9D8F', '#E9C46A', '#E76F51', '#5C6B7A', '#3D8EB9', '#1F6FB2', '#6B4C9A') },
  { id: 'meadow', name: 'Meadow', fonts: { major: 'Candara', minor: 'Corbel' }, effects: 'Plain',
    colors: C('#23331F', '#EEF3E6', '#4F7942', '#A3B18A', '#D4A373', '#6B8F71', '#C9A227', '#7A5C3E', '#2E7D32', '#6D4C41') },
  { id: 'ember', name: 'Ember', fonts: { major: 'Bahnschrift', minor: 'Segoe UI' }, effects: 'Gentle Glow',
    colors: C('#2B1B17', '#F6ECE6', '#C0392B', '#E67E22', '#F1C40F', '#8E44AD', '#7F8C8D', '#D35400', '#B03A2E', '#7D3C98') },
  { id: 'dusk', name: 'Dusk', fonts: { major: 'Constantia', minor: 'Calibri' }, effects: 'Raised',
    colors: C('#2E2240', '#ECE8F3', '#5B3E96', '#B5446E', '#E08E45', '#3E7CB1', '#8C9A3B', '#4A4E69', '#3E5FB1', '#8A4F7D') },
  { id: 'granite', name: 'Granite', fonts: { major: 'Tahoma', minor: 'Verdana' }, effects: 'Chiselled',
    colors: C('#262626', '#EDEDED', '#4D4D4D', '#7F7F7F', '#A6A6A6', '#2F5D8A', '#8A2F2F', '#3F7F4F', '#2F5D8A', '#6A4F8A') },
  { id: 'citrus', name: 'Citrus', fonts: { major: 'Trebuchet MS', minor: 'Calibri' }, effects: 'Plain',
    colors: C('#1F3B2D', '#F7F4E3', '#F28C28', '#F6C445', '#9BC53D', '#5BC0EB', '#E55934', '#3B8EA5', '#0B7A75', '#8E5572') },
  { id: 'lagoon', name: 'Lagoon', fonts: { major: 'Segoe UI', minor: 'Sitka Text' }, effects: 'Thin Outline',
    colors: C('#0B3C49', '#E3F2F5', '#0E7C86', '#2EC4B6', '#3A86FF', '#8338EC', '#FF6B6B', '#FFBE0B', '#0E6BA8', '#7A4CA0') },
  { id: 'ink', name: 'Ink', fonts: { major: 'Cambria', minor: 'Georgia' }, effects: 'Soft Shadow',
    colors: C('#1C1C2E', '#F2F0EB', '#1C3D5A', '#8C2F39', '#B08D57', '#3D5A3C', '#5E5E7A', '#A65E2E', '#1C3D5A', '#5E3D6E') },
];

/** Colour sets: each theme's colours under the theme's name. */
export const COLOR_SETS = THEMES.map(({ id, name, colors }) => ({ id, name, colors }));

/** Font sets: each theme's pair, named after its fonts as Word names its own ("Heading-Body"), the default one 'Default'. */
export const FONT_SETS = THEMES.map(({ id, fonts }) => ({ id, name: id === 'default' ? 'Default' : `${fonts.major}-${fonts.minor}`, ...fonts }));

// ---------- Style sets ----------

/** The styles a style set redefines (Word: Normal, Heading 1 to 9, Title, Subtitle, Quote, Intense Quote); user styles stay. */
export const SET_STYLES = ['Normal', ...Array.from({ length: 9 }, (_, i) => `Heading${i + 1}`), 'Title', 'Subtitle', 'Quote', 'IntenseQuote'];
// The document default keys a style set owns; the rest (the proofing language, ligatures) stay as the Document has them.
const SET_RUN = ['font', 'size', 'color', 'themeColor'];
const SET_PARA = ['spacing'];

const tc = (slot, lum = 0) => ({ themeColor: { slot, lum } }); // colour resolved against the Document's theme when applied
const HEADINGS = (patch) => Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Heading${i + 1}`, patch(i + 1)]));
const line = (value) => ({ rule: 'auto', value });

// Each set is {id, name, defaults: {run, para} (the keys of SET_RUN and SET_PARA), styles: {id: patch over BUILTIN_STYLES}}; a null
// in a patch removes that key (deepPatch).
const SET_DEFS = [
  { id: 'default', name: 'Default', defaults: DOC_DEFAULTS, styles: {} },
  { id: 'cleanLines', name: 'Clean Lines', defaults: { run: { font: '+minor', size: 11 }, para: { spacing: { after: 6, line: line(1.15) } } },
    styles: { ...HEADINGS((n) => ({ run: { bold: n <= 3, italic: null, ...tc('dk1', n <= 2 ? 0 : 0.25) } })), Title: { run: { size: 26, bold: true } } } },
  { id: 'classicSerif', name: 'Classic Serif', defaults: { run: { font: '+minor', size: 12 }, para: { spacing: { after: 10, line: line(1.15) } } },
    styles: { ...HEADINGS((n) => ({ run: { font: '+major', ...tc('dk2') } })), Title: { para: { align: 'center' }, run: { size: 30, ...tc('dk2') } },
      Subtitle: { para: { align: 'center' }, run: { italic: true } } } },
  { id: 'strongHeadings', name: 'Strong Headings', defaults: { run: { font: '+minor', size: 11 }, para: { spacing: { after: 8, line: line(1.15) } } },
    styles: { ...HEADINGS((n) => ({ run: { bold: true, ...tc(n % 2 ? 'accent1' : 'accent2', n <= 2 ? 0 : -0.25) } })),
      Heading1: { run: { size: 22, caps: true, bold: true, ...tc('accent1') } }, Title: { run: { size: 32, bold: true, ...tc('accent1', -0.25) } } } },
  { id: 'ruled', name: 'Ruled', defaults: { run: { font: '+minor', size: 11 }, para: { spacing: { after: 8, line: line(1.1583) } } },
    styles: {
      Heading1: { para: { borders: { bottom: { style: 'single', width: 1, space: 2, color: '#156082', ...tc('accent1') } } } },
      Title: { para: { borders: { bottom: { style: 'single', width: 2, space: 4, color: '#156082', ...tc('accent1') } } } },
    } },
  { id: 'airy', name: 'Airy', defaults: { run: { font: '+minor', size: 11 }, para: { spacing: { after: 12, line: line(1.3) } } },
    styles: { ...HEADINGS((n) => ({ para: { spacing: { before: n <= 2 ? 24 : 12, after: 6 } } })), Title: { run: { size: 36, charSpacing: 0 } } } },
  { id: 'dense', name: 'Dense', defaults: { run: { font: '+minor', size: 10 }, para: { spacing: { after: 3, line: line(1) } } },
    styles: { ...HEADINGS((n) => ({ para: { spacing: { before: n <= 2 ? 10 : 6, after: 2 } }, run: { size: Math.max(10, 16 - 2 * n) } })),
      Title: { run: { size: 22 } } } },
  { id: 'banner', name: 'Banner', defaults: { run: { font: '+minor', size: 11 }, para: { spacing: { after: 8, line: line(1.15) } } },
    styles: {
      Heading1: { para: { shading: { fill: '#156082', val: 'clear' }, indent: { left: 4 } }, run: { ...tc('lt1') } },
      Title: { para: { shading: { fill: '#0E2841', val: 'clear' } }, run: { ...tc('lt1') } },
    } },
  { id: 'quiet', name: 'Quiet', defaults: { run: { font: '+minor', size: 11, ...tc('dk1', 0.25) }, para: { spacing: { after: 8, line: line(1.15) } } },
    styles: { ...HEADINGS((n) => ({ run: { smallCaps: n <= 2, italic: null, ...tc('dk1', 0.35) } })), Title: { run: { smallCaps: true, ...tc('dk1', 0.35) } } } },
];

/** The built-in style sets → [{id, name, defaults, list}] with every SET_STYLES definition whole (colours not yet resolved). */
export const STYLE_SETS = SET_DEFS.map(({ id, name, defaults, styles }) => ({
  id, name,
  defaults: { run: pick(defaults.run, SET_RUN), para: pick(defaults.para, SET_PARA) },
  list: Object.fromEntries(SET_STYLES.map((s) => [s, deepPatch(BUILTIN_STYLES[s], styles[s])])),
}));

function pick(o, keys) {
  return Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, structuredClone(o[k])]));
}
const omit = (o, keys) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !keys.includes(k)));

// ---------- Paragraph Spacing ----------

/** Word's Paragraph Spacing presets {before, after, line} in pt and line multiples, from Word's tooltips.
 * ponytail: unverified (codemap.md §7 Unverified constants); check each against one Word observation of styles.xml after a pick. */
export const SPACING = {
  noParagraphSpace: { before: 0, after: 0, line: 1 },
  compact: { before: 0, after: 4, line: 1 },
  tight: { before: 0, after: 6, line: 1.15 },
  open: { before: 0, after: 10, line: 1.15 },
  relaxed: { before: 0, after: 6, line: 1.5 },
  double: { before: 0, after: 8, line: 2 },
};
const spacingOf = ({ before, after, line: l }) => ({ before, after, line: line(l) });

// ---------- Colours ----------

const plain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** `value` with every `{color, themeColor: {slot, lum}}` inside it (style runs, border edges) re-resolved against `theme`: the same
 * object when nothing changed, else copies along the changed paths. */
export function rethemeValue(value, theme) {
  if (Array.isArray(value)) {
    const out = value.map((v) => rethemeValue(v, theme));
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (!plain(value)) return value;
  let out = value;
  for (const [k, v] of Object.entries(value)) {
    const nv = rethemeValue(v, theme);
    if (nv !== v) out = out === value ? { ...value, [k]: nv } : Object.assign(out, { [k]: nv });
  }
  const link = value.themeColor;
  if (plain(link) && theme?.colors?.[link.slot]) {
    const color = resolveColor(theme, link);
    if (out.color !== color) out = out === value ? { ...value, color } : Object.assign(out, { color });
  }
  return out;
}

/** Re-resolves in `tr` every textStyle mark with a themeColor against `theme` (renderHTML reads only color) → the number changed. */
export function rethemeMarks(tr, theme) {
  const type = tr.doc.type.schema.marks.textStyle;
  if (!type) return 0;
  const hits = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const m = type.isInSet(node.marks);
    const link = m?.attrs.themeColor;
    if (!link?.slot || !theme?.colors?.[link.slot]) return;
    const color = resolveColor(theme, link);
    if (m.attrs.color !== color) hits.push([pos, pos + node.nodeSize, type.create({ ...m.attrs, color })]);
  });
  for (const [from, to, mark] of hits) tr.addMark(from, to, mark);
  return hits.length;
}

/** Writes `theme` into `tr` with everything that stores a resolved theme colour (marks, styles, the page background) re-resolved,
 * in that one transaction → tr. */
export function setTheme(tr, theme) {
  tr.setDocAttribute('theme', theme);
  const { styles, background } = tr.doc.attrs;
  const s = rethemeValue(styles, theme);
  if (s !== styles) tr.setDocAttribute('styles', s);
  const b = rethemeValue(background, theme);
  if (b !== background) tr.setDocAttribute('background', b);
  rethemeMarks(tr, theme);
  // Canvas items, pictures and text boxes keep DrawingML theme links beside their colours (docx/dml.mjs).
  tr.doc.descendants((n, pos) => {
    if (n.type.name === 'image' || n.type.name === 'textBox') {
      const [attrs] = rethemeItems([n.attrs], theme?.colors);
      if (attrs !== n.attrs) tr.setNodeMarkup(pos, undefined, attrs);
      return;
    }
    if (n.type.name !== 'canvas') return;
    const items = rethemeItems(n.attrs.items, theme?.colors);
    if (items !== n.attrs.items) tr.setNodeAttribute(pos, 'items', items);
  });
  return tr;
}

/** `old` theme with built-in or custom `parts` ({name, fonts, colors, effects}, any of them) patched in. */
export const themeWith = (old, parts) => deepPatch(old ?? THEME, structuredClone(parts));

// ---------- Object defaults ----------
// theme.objectDefaults {spDef?, lnDef?, txDef?}: the looks Set as Default Shape, Line and Text Box give the document's new shapes,
// lines and text boxes (theme1.xml a:objectDefaults; shapes/map.mjs defaultLooks reads them, defaultOf takes them from an object).
// A Design > Themes pick keeps them, as their colours are theme links.

/** `theme` with default `key` ('spDef', 'lnDef' or 'txDef') set to `look`. */
export const withObjectDefault = (theme, key, look) => ({ ...(theme ?? THEME), objectDefaults: { ...theme?.objectDefaults, [key]: structuredClone(look) } });

const odKid = (n, name) => (n?.kids ?? []).find((k) => typeof k === 'object' && k.name === name) ?? null;

/** A theme part's a:objectDefaults element `el` (import.mjs's parseXml tree) with `ctx` (dml.mjs shapeLook's {colors, fmt, fonts})
 * → objectDefaults, or null when it sets none. */
export function objectDefaultsOf(el, ctx) {
  const out = {};
  const look = (def) => def && shapeLook(odKid(def, 'a:spPr'), odKid(def, 'a:style'), ctx);
  const sp = look(odKid(el, 'a:spDef'));
  if (sp) {
    out.spDef = themed({ ...fillFields(sp.fill), ...lineFields(sp.line), opacity: 1, ...(sp.font?.color && { textColor: sp.font.color }), ...(sp.shadow && { shadow: sp.shadow }) },
      { ...fillLinks(sp.fill), color: sp.line?.fill.link, textColor: sp.links.font, 'shadow.color': sp.links.shadow }, sp.refs);
  }
  const ln = look(odKid(el, 'a:lnDef'));
  if (ln) {
    const f = lineFields(ln.line);
    out.lnDef = themed({ color: f.color, width: f.width, opacity: 1, dash: f.dash ?? 'solid' }, { color: ln.line?.fill.link }, ln.refs);
  }
  const tx = odKid(el, 'a:txDef');
  if (tx) out.txDef = boxLook(odKid(tx, 'a:spPr'), odKid(tx, 'a:style'), ctx);
  return Object.keys(out).length ? out : null;
}

const defXml = (tag, look, spPr) => (look ? `<a:${tag}><a:spPr>${spPr(look)}</a:spPr><a:bodyPr/><a:lstStyle/>${refsXml(look.styleRefs).replace(/wps:style/g, 'a:style')}</a:${tag}>` : '');

/** objectDefaults → a:objectDefaults (each default's spPr, an empty body and its style references), or '' when it holds none. */
export function objectDefaultsXml(od) {
  const inner = defXml('spDef', od?.spDef, (l) => {
    const it = { type: 'shape', shape: 'rect', ...l };
    return fillXml(it) + lineXml(it, 1) + shadowXml(it, 1);
  }) + defXml('lnDef', od?.lnDef, (l) => lineXml({ type: 'connector', ...l, heads: { start: 'none', end: 'none' } }, 1))
    + defXml('txDef', od?.txDef, (l) => boxSpXml(l));
  return inner ? `<a:objectDefaults>${inner}</a:objectDefaults>` : '';
}

const OBJECT_DEFAULTS = /<a:objectDefaults\s*\/>|<a:objectDefaults\b[^>]*>[^]*?<\/a:objectDefaults>/;

/** theme1.xml text `xml` (export.mjs's) with `theme`'s objectDefaults written in: a .docx's own stay as Word wrote them until one is
 * set here (theme.kept.objectDefaults: what import read from them). */
export function objectDefaultsInto(xml, theme) {
  const od = theme?.objectDefaults ?? null;
  const kept = theme?.kept ? theme.kept.objectDefaults ?? null : null;
  if (!xml || JSON.stringify(od) === JSON.stringify(kept)) return xml;
  const out = objectDefaultsXml(od) || '<a:objectDefaults/>';
  return OBJECT_DEFAULTS.test(xml) ? xml.replace(OBJECT_DEFAULTS, () => out) : xml.replace('</a:themeElements>', () => `</a:themeElements>${out}`);
}

// ---------- Style sets on a Document ----------

/** `styles` (doc.attrs.styles) with style set `set` ({id?, name, defaults, list}) applied: its document defaults and SET_STYLES
 * definitions replace the Document's (each style keeps keys the set does not define, such as qFormat), user styles stay, and the
 * theme colours resolve against `theme`. */
export function withStyleSet(styles, set, theme) {
  const old = styles ?? {};
  const d = old.defaults ?? {};
  const list = { ...old.list };
  for (const [id, def] of Object.entries(set.list ?? {})) {
    const { run, para, ...rest } = def;
    list[id] = { ...omit(list[id], ['run', 'para']), ...structuredClone(rest), ...(para && { para: structuredClone(para) }), ...(run && { run: structuredClone(run) }) };
  }
  const defaults = {
    ...d,
    run: { ...omit(d.run, SET_RUN), ...structuredClone(set.defaults?.run ?? {}) },
    para: { ...omit(d.para, SET_PARA), ...structuredClone(set.defaults?.para ?? {}) },
  };
  return rethemeValue({ ...old, defaults, list, styleSet: set.id ?? set.name }, theme);
}

/** The current style set of `styles` as a saved set {name, styles: {defaults, list}} (Save as a New Style Set, Set as Default). */
export function savedSet(name, styles) {
  const d = styles?.defaults ?? {};
  return {
    name,
    styles: {
      defaults: { run: pick(d.run, SET_RUN), para: pick(d.para, SET_PARA) },
      list: Object.fromEntries(SET_STYLES.filter((s) => styles?.list?.[s]).map((s) => [s, structuredClone(styles.list[s])])),
    },
  };
}

/** A saved set {name, styles} as a style set withStyleSet takes, with id 'custom:<name>'. */
export const customSet = (saved) => ({ id: `custom:${saved.name}`, name: saved.name, ...saved.styles });

/** The style set `id` names: a built-in id or 'custom:<name>' from `saved` (the word store's styleSets) → the set or null. */
export function styleSetOf(id, saved = []) {
  if (String(id).startsWith('custom:')) {
    const s = saved.find((x) => `custom:${x.name}` === id);
    return s ? customSet(s) : null;
  }
  return STYLE_SETS.find((s) => s.id === id) ?? null;
}

/** `styles` with Paragraph Spacing preset `key` (a SPACING key): the defaults' spacing, and Normal's own spacing cleared. */
export function withSpacing(styles, key) {
  const old = styles ?? {};
  const d = old.defaults ?? {};
  const list = { ...old.list };
  if (list.Normal?.para?.spacing) list.Normal = { ...list.Normal, para: omit(list.Normal.para, ['spacing']) };
  return { ...old, defaults: { ...d, para: { ...d.para, spacing: spacingOf(SPACING[key]) } }, list };
}

/** The spacing `styles`' style set gives (Paragraph Spacing > Default): the set it records, else the default set's. */
export function setSpacing(styles, saved = []) {
  return (styleSetOf(styles?.styleSet ?? 'default', saved) ?? STYLE_SETS[0]).defaults.para.spacing;
}

/** `styles` with its style set's own spacing back (Paragraph Spacing > Default). */
export const withSetSpacing = (styles, saved = []) => {
  const d = styles?.defaults ?? {};
  return { ...styles, defaults: { ...d, para: { ...d.para, spacing: structuredClone(setSpacing(styles, saved)) } } };
};

/** The Paragraph Spacing item checked for `styles`: 'default' while the defaults equal the style set's, else the preset key they
 * equal, else null. */
export function spacingKey(styles, saved = []) {
  const s = JSON.stringify(styles?.defaults?.para?.spacing ?? null);
  if (styles?.list?.Normal?.para?.spacing) return null;
  if (s === JSON.stringify(setSpacing(styles, saved))) return 'default';
  return Object.keys(SPACING).find((k) => JSON.stringify(spacingOf(SPACING[k])) === s) ?? null;
}

/** The new-document defaults Set as Default saves (settings.word.newDocument {styles, theme}): the style set and the theme. */
export function newDocumentOf(attrs) {
  return { styles: savedSet('', attrs.styles).styles, theme: structuredClone(attrs.theme ?? THEME) };
}

/** `styles` with the attached template's `tpl` styles copied over (Automatically update document styles: each template style
 * replaces the Document's of its id), theme colours resolved against `theme` → styles, or null when nothing changes. */
export function withTemplate(styles, tpl, theme) {
  if (!tpl?.list) return null;
  const next = rethemeValue({ ...styles, list: { ...styles?.list, ...structuredClone(tpl.list) } }, theme);
  return JSON.stringify(next.list) === JSON.stringify(styles?.list) ? null : next;
}

/** The first free "Custom N" name among `names`. */
export function nextCustom(names) {
  for (let n = 1; ; n++) if (!names.includes(`Custom ${n}`)) return `Custom ${n}`;
}

/** Whether `languages` (settings.word.proofing.languages) holds an East Asian language, so Customize Fonts shows Asian fonts. */
export const eastAsian = (languages = []) => languages.some((l) => /^(zh|ja|ko)\b/i.test(l));

// ---------- Gallery rows (index.js adds the drawings) ----------

const json = (v) => JSON.stringify(v);

/** The Colors gallery for `theme` with `custom` sets (settings.word.themeColors) → [{id, label, group, active, set}], Custom first. */
export function colorItems(theme, custom = []) {
  const row = (set, id, group) => ({ id, label: set.name, group, active: json(set.colors) === json(theme?.colors), set });
  return [...custom.map((s) => row(s, `custom:${s.name}`, 'Custom')), ...COLOR_SETS.map((s) => row(s, s.id, 'Built-In'))];
}

/** The Fonts gallery for `theme` with `custom` sets (settings.word.themeFonts), labelled as Word reads them ("Name, Heading Font: X,
 * Body Font: Y") → [{id, label, group, active, set}], Custom first. */
export function fontItems(theme, custom = []) {
  const row = (set, id, group) => ({
    id, label: `${set.name}, Heading Font: ${set.major}, Body Font: ${set.minor}`, group, set,
    active: theme?.fonts?.major === set.major && theme?.fonts?.minor === set.minor,
  });
  return [...custom.map((s) => row(s, `custom:${s.name}`, 'Custom')), ...FONT_SETS.map((s) => row(s, s.id, 'Built-In'))];
}
