// .docx import (docs/plans/document.md # interop, Phase 2): a WordprocessingML package back into a Document's TipTap JSON, the
// inverse of export.mjs element by element. Pure, with a small XML reader instead of DOMParser so Node tests run it; Word, Google
// Docs and LibreOffice all write the standard prefixes (w:, r:, wp:, a:, pic:, m:), which it reads by name. What the model cannot
// hold goes into `dropped`, which the caller shows as one notice.
import { BORDER_STYLES, shadingCss } from '../../office.mjs';
import { newDocumentJson } from '../defaults.mjs';
import { boxLook as textBoxLook, dmlColor, fmtOf, pictureLook, pictureSource, PLAIN_FMT } from './dml.mjs';
import { canvasOf, isTextBox } from './shapes-in.mjs';
import { COVER, CPP, FOCUS, MERGE_TYPES, PROP_BINDINGS, STASH, WORD_PATTERNS, packageHash, sig } from './export.mjs';
import { color as vmlColor, isWatermark, vmlDrawings, watermarkOf } from './vml.mjs';
import { readZip, text } from './zip.mjs';
import { chartOf } from '../chart/parts.mjs';
import { GRADIENT_PRESETS, PATTERNS, TEXTURES } from '../wp/page-background/model.mjs';
import { resultRuns } from '../wp/fields-core/runs.mjs';
import { drawMetafiles, METAFILE } from '../../tooling/metafile.mjs';
import { base64 } from '../../tooling/base64.mjs';
import { linearText, readOmml } from '../wp/equations/omml.mjs';
import { print } from '../wp/equations/unicodemath.mjs';
import { objectDefaultsOf } from '../wp/design/model.mjs';

// ---------- XML ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m));

/** The element tree of `xml`: {name, attrs, kids} with text as strings among kids → the root element. */
export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const re = /<!--[^]*?-->|<!\[CDATA\[([^]*?)\]\]>|<\?[^]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    const top = stack.at(-1);
    if (m[1] != null) top.kids.push(m[1]);
    else if (m[6] != null) { if (top !== root) top.kids.push(unesc(m[6])); }
    else if (m[3]) {
      if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unesc(a[2] ?? a[3]);
      const node = { name: m[3], attrs, kids: [] };
      top.kids.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  return root.kids.find((k) => typeof k === 'object') ?? null;
}
const escXml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** An element of parseXml's tree back to XML (comments and declarations are not kept). */
const toXml = (n) => (typeof n === 'string' ? escXml(n)
  : `<${n.name}${Object.entries(n.attrs).map(([k, x]) => ` ${k}="${escXml(x)}"`).join('')}${n.kids.length ? `>${n.kids.map(toXml).join('')}</${n.name}>` : '/>'}`);
// Markup compatibility (ECMA-376 Part 3): the namespaces this importer reads, which a mc:Choice may require. Ink (wpi, aink), 3D
// models (am3d), w14 and the rest are not among them, so their mc:Fallback (a picture, as Word writes it) is read instead.
const MCE = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const UNDERSTOOD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://schemas.openxmlformats.org/drawingml/2006/picture', 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  'http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  'http://schemas.microsoft.com/office/drawing/2008/diagram', 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup', 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing', 'urn:schemas-microsoft-com:vml', 'urn:schemas-microsoft-com:office:office',
  'urn:schemas-microsoft-com:office:word']);
// The chartex namespaces (cx, and cx1 to cx8 that Word requires): http://schemas.microsoft.com/office/drawing/2014/chartex and later.
const understood = (uri) => UNDERSTOOD.has(uri) || /^http:\/\/schemas\.microsoft\.com\/office\/drawing\/20\d\d\/[\d/]*chartex$/.test(uri ?? '');

/** Markup compatibility on the element tree `root` of a part (ECMA-376 Part 3 §10.2), in place: each mc:AlternateContent becomes
 * the content of its first mc:Choice whose Requires prefixes all name namespaces this importer reads (declared on the Choice, the
 * AlternateContent or the root), else of its mc:Fallback, else nothing. The markup-compatibility prefix is mc or any the root
 * binds to its namespace. → root */
export function selectAlternates(root) {
  if (!root) return root;
  const pre = new Set(['mc', ...Object.entries(root.attrs).filter(([k, x]) => k.startsWith('xmlns:') && x === MCE).map(([k]) => k.slice(6))]);
  const is = (n, local) => typeof n === 'object' && n.name.endsWith(`:${local}`) && pre.has(n.name.slice(0, -local.length - 1));
  const uri = (p, ...els) => els.map((e) => e.attrs[`xmlns:${p}`]).find((x) => x != null);
  const takes = (c, ac) => { const req = (c.attrs.Requires ?? '').trim(); return !!req && req.split(/\s+/).every((p) => understood(uri(p, c, ac, root))); };
  const expand = (k) => {
    if (!is(k, 'AlternateContent')) return [k];
    const pick = k.kids.find((c) => is(c, 'Choice') && takes(c, k)) ?? k.kids.find((c) => is(c, 'Fallback'));
    const out = (pick?.kids ?? []).flatMap(expand);
    // Ink: the picture Word falls back to carries the r:id and EMU size of the ink part its unread Choice draws ('#ink': 'rId cx
    // cy'), which the reader keeps on that picture (image ink).
    const ink = is(pick, 'Fallback') && k.kids.map((c) => is(c, 'Choice') && deep(c, 'w14:contentPart')[0]).find(Boolean);
    const ext = ink && deep(ink, 'a:ext')[0];
    if (ink) for (const o of out) if (typeof o === 'object') o.attrs['#ink'] = [at(ink, 'r:id'), at(ext, 'cx'), at(ext, 'cy')].join(' ');
    return out;
  };
  const walk = (n) => {
    n.kids = n.kids.flatMap(expand);
    for (const k of n.kids) if (typeof k === 'object') walk(k);
  };
  walk(root);
  return root;
}
const kids = (n, name) => (n?.kids ?? []).filter((k) => typeof k === 'object' && (!name || k.name === name));
const kid = (n, name) => (n?.kids ?? []).find((k) => typeof k === 'object' && k.name === name) ?? null;
const deep = (n, name, out = []) => {
  for (const k of kids(n)) (k.name === name ? out.push(k) : deep(k, name, out));
  return out;
};
const textOf = (n) => (n?.kids ?? []).map((k) => (typeof k === 'string' ? k : textOf(k))).join('');
const at = (n, a) => n?.attrs?.[a] ?? null;
const v = (n, name) => at(kid(n, name), 'w:val');
const num = (s) => (s == null || s === '' || Number.isNaN(+s) ? null : +s);
const pt = (twips) => (twips == null ? null : Math.round((+twips / 20) * 100) / 100);
// An on/off property: present without w:val, or with a true value, is on; '0', 'false', 'off' is off; absent is null.
const flag = (n, name) => {
  const e = kid(n, name);
  if (!e) return null;
  const x = at(e, 'w:val');
  return x == null || !/^(0|false|off|none)$/i.test(x);
};
const clean = (o) => {
  const out = Object.fromEntries(Object.entries(o).filter(([, x]) => x != null && !(typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length)));
  return Object.keys(out).length ? out : null;
};
const hexOf = (c) => (!c || c === 'auto' ? null : `#${c.toUpperCase()}`);
// An on/off attribute (ST_OnOff): true, false, or null when absent.
const onAt = (e, a) => (at(e, a) == null ? null : /^(1|true|on)$/i.test(at(e, a)));

// ---------- equations ----------
// Only XML in the prefixes that every part export writes declares is kept.
const MATH_XML = /^(m|w|w14|xml):/;
const keepable = (n) => typeof n === 'string' || ([n.name, ...Object.keys(n.attrs)].every((k) => MATH_XML.test(k)) && n.kids.every(keepable));
/** m:oMath or m:oMathPara → an equation: its linear form (equations omml.mjs), shown as text when Word saved it in linear form,
 * and its own m:oMath XML with the form it reads as (omml), which export writes back while the equation keeps that form. */
function equationOf(n) {
  const display = n.name === 'm:oMathPara';
  const lin = linearText(n);
  const math = lin ?? print(readOmml(n));
  const jc = display ? at(kid(kid(n, 'm:oMathParaPr'), 'm:jc'), 'm:val') : null;
  const maths = display ? kids(n, 'm:oMath') : [n];
  return { type: 'equation', attrs: { math, display, ...(lin != null && { linear: true }), ...(jc && { align: jc }),
    ...(maths.length && maths.every(keepable) && { omml: { xml: maths.map(toXml).join(''), math, ...(lin != null && { linear: true }) } }) } };
}

// ---------- properties ----------
const SLOT = { text1: 'dk1', background1: 'lt1', text2: 'dk2', background2: 'lt2', dark1: 'dk1', light1: 'lt1', dark2: 'dk2', light2: 'lt2', hyperlink: 'hlink', followedHyperlink: 'folHlink' };
// The theme link {slot, lum} of an element's colour attributes, lum to three places so Word's tint or shade byte comes back.
const themeLink = (e, color, tint, shade) => {
  const lum = at(e, shade) ? parseInt(at(e, shade), 16) / 255 - 1 : at(e, tint) ? 1 - parseInt(at(e, tint), 16) / 255 : 0;
  return at(e, color) ? { slot: SLOT[at(e, color)] ?? at(e, color), lum: Math.round(lum * 1000) / 1000 } : null;
};
const edge = (e) => (!e || at(e, 'w:val') === 'nil' || at(e, 'w:val') === 'none' ? null : clean({ style: at(e, 'w:val'), width: num(at(e, 'w:sz')) == null ? null : num(at(e, 'w:sz')) / 8,
  space: num(at(e, 'w:space')) ?? 0, color: hexOf(at(e, 'w:color')), themeColor: themeLink(e, 'w:themeColor', 'w:themeTint', 'w:themeShade'),
  shadow: /^(1|true|on)$/.test(at(e, 'w:shadow') ?? '') || null, frame: /^(1|true|on)$/.test(at(e, 'w:frame') ?? '') || null }));
const edges = (n, names) => (!n ? null : clean(Object.fromEntries(names.map((k) => [k, edge(kid(n, `w:${k}`))]))));
const shd = (e) => (!e ? null : clean({ val: at(e, 'w:val'), color: at(e, 'w:color') === 'auto' ? 'auto' : hexOf(at(e, 'w:color')), fill: at(e, 'w:fill') === 'auto' ? 'auto' : hexOf(at(e, 'w:fill')),
  themeFill: themeLink(e, 'w:themeFill', 'w:themeFillTint', 'w:themeFillShade') }));
// A cell's shading is one colour (plan.md §1.8, what the Shading button writes): w:shd drawn as Word does (shadingCss), a stripe
// or cross pattern as its fill.
const cellFill = (s) => {
  const bg = shadingCss(s);
  return bg?.startsWith('#') ? bg : s?.fill && s.fill !== 'auto' ? s.fill : null;
};

/** Run properties of w:rPr → the model's run keys (textStyle's, with b, i, strike, u, vertAlign for the marks); the theme's `colors`
 * resolve a text effect's theme colour. */
export function runProps(r, colors = null) {
  if (!r) return {};
  const f = kid(r, 'w:rFonts');
  // A theme font (which wins over the named one) reads as +major or +minor, for each script as the Font dialog holds it.
  const theme = (...k) => { const t = k.map((x) => at(f, x)).find(Boolean); return t ? `+${t.startsWith('major') ? 'major' : 'minor'}` : null; };
  const c = kid(r, 'w:color');
  const tc = at(c, 'w:themeColor');
  const tint = at(c, 'w:themeTint');
  const shade = at(c, 'w:themeShade');
  const raw = shade ? -(1 - parseInt(shade, 16) / 255) : tint ? 1 - parseInt(tint, 16) / 255 : 0;
  // Two places (the palette's 0.8, -0.25) unless that would not come back as the same tint or shade (D8, A5 need four).
  const two = Math.round(raw * 100) / 100;
  const lum = Math.round((1 - Math.abs(two)) * 255) === parseInt(shade ?? tint ?? 'FF', 16) ? two : Math.round(raw * 10000) / 10000;
  const u = kid(r, 'w:u');
  const sz = num(v(r, 'w:sz'));
  const lang = kid(r, 'w:lang');
  const fit = kid(r, 'w:fitText');
  const eal = kid(r, 'w:eastAsianLayout');
  const out = {
    charStyle: v(r, 'w:rStyle'), font: theme('w:asciiTheme', 'w:hAnsiTheme') ?? at(f, 'w:ascii') ?? at(f, 'w:hAnsi'),
    fontEA: theme('w:eastAsiaTheme') ?? at(f, 'w:eastAsia'), fontCS: theme('w:cstheme') ?? at(f, 'w:cs'), hint: at(f, 'w:hint'), b: flag(r, 'w:b'), i: flag(r, 'w:i'), caps: flag(r, 'w:caps'), smallCaps: flag(r, 'w:smallCaps'),
    strike: flag(r, 'w:strike'), dstrike: flag(r, 'w:dstrike'), outline: flag(r, 'w:outline'), shadow: flag(r, 'w:shadow'), emboss: flag(r, 'w:emboss'),
    imprint: flag(r, 'w:imprint'), noProof: flag(r, 'w:noProof'), vanish: flag(r, 'w:vanish'), webHidden: flag(r, 'w:webHidden'),
    color: hexOf(at(c, 'w:val')), themeColor: tc ? { slot: SLOT[tc] ?? tc, lum } : null,
    spacing: pt(v(r, 'w:spacing')), scale: num(v(r, 'w:w')), kern: num(v(r, 'w:kern')) == null ? null : num(v(r, 'w:kern')) / 2,
    position: num(v(r, 'w:position')) == null ? null : num(v(r, 'w:position')) / 2, size: sz == null ? null : sz / 2,
    sizeCS: num(v(r, 'w:szCs')) != null && num(v(r, 'w:szCs')) !== sz ? num(v(r, 'w:szCs')) / 2 : null,
    highlight: v(r, 'w:highlight') && v(r, 'w:highlight') !== 'none' ? v(r, 'w:highlight') : null,
    u: u && at(u, 'w:val') !== 'none' ? { val: at(u, 'w:val') ?? 'single', color: hexOf(at(u, 'w:color')) } : null,
    border: edge(kid(r, 'w:bdr')), shading: shd(kid(r, 'w:shd')), vertAlign: v(r, 'w:vertAlign'), rtl: flag(r, 'w:rtl'), cs: flag(r, 'w:cs'), em: v(r, 'w:em'),
    lang: lang ? clean({ val: at(lang, 'w:val'), eastAsia: at(lang, 'w:eastAsia'), bidi: at(lang, 'w:bidi') }) : null,
    // Runs that share a Fit Text or an Asian layout id are one unit, so the id stays.
    fitText: fit ? clean({ w: pt(at(fit, 'w:val')), id: num(at(fit, 'w:id')) }) : null,
    eastAsianLayout: eal ? clean({ id: num(at(eal, 'w:id')), combine: onAt(eal, 'w:combine'), combineBrackets: at(eal, 'w:combineBrackets'), vert: onAt(eal, 'w:vert'),
      vertCompress: onAt(eal, 'w:vertCompress') }) : null,
    typography: clean({ ligatures: at(kid(r, 'w14:ligatures'), 'w14:val'), numForm: at(kid(r, 'w14:numForm'), 'w14:val'), numSpacing: at(kid(r, 'w14:numSpacing'), 'w14:val'),
      stylisticSet: num(at(kid(kid(r, 'w14:stylisticSets'), 'w14:styleSet'), 'w14:id')), contextual: kid(r, 'w14:cntxtAlts') ? onAt(kid(r, 'w14:cntxtAlts'), 'w14:val') ?? true : null }),
    effects: effectsOf(r, colors),
  };
  return Object.fromEntries(Object.entries(out).filter(([, x]) => x != null));
}

const DASH_IN = { lgDash: 'longDash' };
/** Word 2010's text effects (w14 in w:rPr) → textStyle effects {fill, outline, shadow, glow, reflection}: lengths in pt, colours
 * '#RRGGBB' (a transparent fill '#RRGGBBAA') with alpha the opacity, as w14:alpha holds the transparency. A theme colour resolves
 * through `colors`; an effect whose colour does not is left out. */
function effectsOf(r, colors) {
  const dml = (e) => ({ name: e.name.replace(/^w14:/, 'a:'), attrs: Object.fromEntries(Object.entries(e.attrs).map(([k, x]) => [k.replace(/^w14:/, ''), x])),
    kids: kids(e).filter((k) => k.name !== 'w14:alpha').map(dml) });
  const clr = (n) => {
    const c = kids(n).find((k) => /^w14:\w+Clr$/.test(k.name));
    const color = c && dmlColor(dml(c), colors);
    return color && { color, alpha: Math.round(100 - (num(at(kid(c, 'w14:alpha'), 'w14:val')) ?? 0) / 1000) / 100 };
  };
  const emu = (e, k) => (num(at(e, k)) == null ? null : Math.round(num(at(e, k)) / 127) / 100);
  const [tf, to, sh, gl, rf] = ['textFill', 'textOutline', 'shadow', 'glow', 'reflection'].map((k) => kid(r, `w14:${k}`));
  const solid = clr(kid(tf, 'w14:solidFill'));
  const grad = kid(tf, 'w14:gradFill');
  const stops = kids(kid(grad, 'w14:gsLst'), 'w14:gs').map((g) => ({ pos: (num(at(g, 'w14:pos')) ?? 0) / 1000, color: clr(g)?.color }));
  const line = clr(kid(to, 'w14:solidFill'));
  const [shc, glc] = [clr(sh), clr(gl)];
  const dash = at(kid(to, 'w14:prstDash'), 'w14:val');
  return clean({
    fill: kid(tf, 'w14:noFill') ? { type: 'none' } : solid ? { type: 'solid', color: solid.alpha < 1 ? `${solid.color}${Math.round(solid.alpha * 255).toString(16).padStart(2, '0').toUpperCase()}` : solid.color }
      : stops.length && stops.every((x) => x.color) ? { type: 'gradient', angle: Math.round((num(at(kid(grad, 'w14:lin'), 'w14:ang')) ?? 0) / 60000), stops } : null,
    outline: line ? { color: line.color, width: emu(to, 'w14:w') ?? 0.75, dash: DASH_IN[dash] ?? dash ?? 'solid' } : null,
    shadow: shc ? { ...shc, blur: emu(sh, 'w14:blurRad') ?? 0, dist: emu(sh, 'w14:dist') ?? 0, angle: Math.round((num(at(sh, 'w14:dir')) ?? 0) / 60000) } : null,
    glow: glc ? { ...glc, size: emu(gl, 'w14:rad') ?? 0 } : null,
    // stA, the reflection's start, is an opacity; endPos is its size.
    reflection: rf ? { size: (num(at(rf, 'w14:endPos')) ?? 100000) / 1000, dist: emu(rf, 'w14:dist') ?? 0, alpha: (num(at(rf, 'w14:stA')) ?? 100000) / 100000 } : null,
  });
}

/** The marks of run properties `p` (runProps) → TipTap marks. */
function marksOf(p) {
  const out = [];
  const { b, i, strike, u, vertAlign, ...rest } = p;
  if (b) out.push({ type: 'bold' });
  if (i) out.push({ type: 'italic' });
  if (strike) out.push({ type: 'strike' });
  if (u) out.push({ type: 'underline', attrs: { val: u.val, color: u.color ?? null } });
  if (vertAlign === 'subscript') out.push({ type: 'subscript' });
  if (vertAlign === 'superscript') out.push({ type: 'superscript' });
  // A false b or i (switching off what a style turns on) has no mark; the style draws it.
  if (Object.keys(rest).length) out.push({ type: 'textStyle', attrs: rest });
  return out;
}

const JC = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'distribute' };
/** Paragraph properties of w:pPr → the model's paragraph attributes (without styleId and numbering). */
export function paraProps(p) {
  if (!p) return {};
  const s = kid(p, 'w:spacing');
  const ind = kid(p, 'w:ind');
  const rule = at(s, 'w:lineRule') ?? (at(s, 'w:line') ? 'auto' : null);
  const line = at(s, 'w:line') == null ? null : rule === 'auto' ? { rule: 'auto', value: Math.round((+at(s, 'w:line') / 240) * 10000) / 10000 } : { rule, value: pt(at(s, 'w:line')) };
  const hanging = at(ind, 'w:hanging');
  const first = at(ind, 'w:firstLine');
  const fr = kid(p, 'w:framePr');
  const out = {
    keepNext: flag(p, 'w:keepNext'), keepLines: flag(p, 'w:keepLines'), pageBreakBefore: flag(p, 'w:pageBreakBefore'), widowControl: flag(p, 'w:widowControl'),
    suppressLineNumbers: flag(p, 'w:suppressLineNumbers'), suppressAutoHyphens: flag(p, 'w:suppressAutoHyphens'), bidi: flag(p, 'w:bidi'),
    snapToGrid: flag(p, 'w:snapToGrid'), contextual: flag(p, 'w:contextualSpacing'), mirrorIndents: flag(p, 'w:mirrorIndents'),
    borders: edges(kid(p, 'w:pBdr'), ['top', 'left', 'bottom', 'right', 'between', 'bar']), shading: shd(kid(p, 'w:shd')),
    tabs: kid(p, 'w:tabs') ? kids(kid(p, 'w:tabs'), 'w:tab').map((t) => ({ pos: pt(at(t, 'w:pos')), align: at(t, 'w:val') === 'start' ? 'left' : at(t, 'w:val') === 'end' ? 'right' : at(t, 'w:val'), leader: at(t, 'w:leader') ?? 'none' })) : null,
    spacing: s ? clean({ before: pt(at(s, 'w:before')), after: pt(at(s, 'w:after')), line, beforeLines: num(at(s, 'w:beforeLines')), afterLines: num(at(s, 'w:afterLines')),
      beforeAuto: at(s, 'w:beforeAutospacing') == null ? null : /^(1|true|on)$/.test(at(s, 'w:beforeAutospacing')), afterAuto: at(s, 'w:afterAutospacing') == null ? null : /^(1|true|on)$/.test(at(s, 'w:afterAutospacing')) }) : null,
    indent: ind ? clean({ left: pt(at(ind, 'w:left') ?? at(ind, 'w:start')), right: pt(at(ind, 'w:right') ?? at(ind, 'w:end')), firstLine: hanging != null ? -pt(hanging) : pt(first),
      leftChars: num(at(ind, 'w:leftChars')), firstLineChars: num(at(ind, 'w:firstLineChars')) }) : null,
    textAlign: JC[v(p, 'w:jc')] ?? null, outline: num(v(p, 'w:outlineLvl')), tightWrap: v(p, 'w:textboxTightWrap'),
    asian: clean({ kinsoku: flag(p, 'w:kinsoku'), wordWrap: flag(p, 'w:wordWrap'), overflowPunct: flag(p, 'w:overflowPunct'), topLinePunct: flag(p, 'w:topLinePunct'),
      autoSpaceDE: flag(p, 'w:autoSpaceDE'), autoSpaceDN: flag(p, 'w:autoSpaceDN'), adjustRightInd: flag(p, 'w:adjustRightInd'), textAlignment: v(p, 'w:textAlignment') }),
    frame: fr ? clean({ dropCap: at(fr, 'w:dropCap'), lines: num(at(fr, 'w:lines')), w: pt(at(fr, 'w:w')), h: pt(at(fr, 'w:h')), hRule: at(fr, 'w:hRule'), hSpace: pt(at(fr, 'w:hSpace')),
      vSpace: pt(at(fr, 'w:vSpace')), wrap: at(fr, 'w:wrap'), hAnchor: at(fr, 'w:hAnchor'), vAnchor: at(fr, 'w:vAnchor'), x: pt(at(fr, 'w:x')), xAlign: at(fr, 'w:xAlign'), y: pt(at(fr, 'w:y')), yAlign: at(fr, 'w:yAlign') }) : null,
  };
  return Object.fromEntries(Object.entries(out).filter(([, x]) => x != null));
}

// The theme's script (a:font script) for a document's East Asian language, as Word picks the East Asian theme font when the
// theme's a:ea is empty: Simplified and Traditional Chinese, Japanese, Korean.
const EA_SCRIPT = { 'zh-CN': 'Hans', 'zh-SG': 'Hans', 'zh-TW': 'Hant', 'zh-HK': 'Hant', 'zh-MO': 'Hant', ja: 'Jpan', ko: 'Hang' };
const scriptOf = (lang) => (lang ? EA_SCRIPT[lang] ?? EA_SCRIPT[lang.split('-')[0]] ?? null : null);

/** A parsed theme1.xml `theme` → the model's theme {name, fonts, colors} over `base` for what it lacks. `eaLang`: the document's East
 * Asian language (settings' themeFontLang, else the default run's), whose script font stands in for an empty a:ea. */
function themeOf(theme, base, eaLang = null) {
  const els = kid(theme, 'a:themeElements');
  const scheme = kid(els, 'a:clrScheme');
  const colors = {};
  for (const c of kids(scheme)) {
    const slot = c.name.replace('a:', '');
    const srgb = kid(c, 'a:srgbClr');
    const sys = kid(c, 'a:sysClr');
    const hex = at(srgb, 'val') ?? at(sys, 'lastClr');
    if (hex) colors[slot] = `#${hex.toUpperCase()}`;
  }
  const fs = kid(els, 'a:fontScheme');
  // The East Asian fonts (a:ea) where the scheme names them; Word writes an empty typeface for none.
  const ea = (k) => at(kid(kid(fs, k), 'a:ea'), 'typeface') || null;
  // The script font Word falls back to (not written back: export keeps the theme's own a:ea).
  const script = scriptOf(eaLang);
  const byScript = (k) => (script && at(kids(kid(fs, k), 'a:font').find((f) => at(f, 'script') === script), 'typeface')) || null;
  return { name: at(theme, 'name') ?? at(scheme, 'name') ?? base.name, fonts: clean({ major: at(kid(kid(fs, 'a:majorFont'), 'a:latin'), 'typeface') ?? base.fonts.major,
    minor: at(kid(kid(fs, 'a:minorFont'), 'a:latin'), 'typeface') ?? base.fonts.minor, majorEA: ea('a:majorFont'), minorEA: ea('a:minorFont'),
    majorEAScript: byScript('a:majorFont'), minorEAScript: byScript('a:minorFont') }), colors: { ...base.colors, ...colors } };
}

/** Design > Themes > Browse for Themes: the theme of an Office theme (.thmx), a Word file (.docx, .dotx) or a theme1.xml in
 * `buffer` (`name` tells which) over `base` → the model's theme, or null when it holds none. */
export async function readThemeFile(name, buffer, base) {
  let xml;
  if (/\.xml$/i.test(name)) xml = text(buffer);
  else {
    const files = await readZip(buffer);
    xml = text(files.get('theme/theme/theme1.xml') ?? files.get('word/theme/theme1.xml'));
  }
  const root = xml && parseXml(xml);
  return root && kid(root, 'a:themeElements') ? themeOf(root, base) : null;
}

// ---------- the reader ----------
/** The model's id for the default style of each type (export.mjs writes w:default on these). */
const DEFAULT_IDS = { paragraph: 'Normal', character: 'DefaultParagraphFont', table: 'TableNormal', numbering: 'NoList' };
const DOC_PR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const MIME = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', emf: 'image/x-emf', wmf: 'image/x-wmf' };
const resolve = (from, target) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const seg of target.split('/')) (seg === '..' ? parts.pop() : seg !== '.' && parts.push(seg));
  return parts.join('/');
};

/**
 * Reads .docx `buffer` → {doc (TipTap JSON), title, dropped: string[]}. `settings` (the app's) gives the new Document's defaults
 * under what the file holds. In a file this app wrote and nobody changed, the pictures of its canvases and plan charts open as
 * those again from STASH (export.mjs), unless `fresh`.
 */
export async function importDocx(buffer, { settings = null, fresh = false, metafiles = globalThis.window?.api?.word?.metafiles } = {}) {
  const files = await readZip(buffer);
  // Every part is read after markup compatibility (selectAlternates), so no reader below meets an mc:AlternateContent.
  const xmlOf = (p) => (files.has(p) ? selectAlternates(parseXml(text(files.get(p)))) : null);
  const docXmlText = text(files.get('word/document.xml')) ?? (() => { throw new Error('This file has no Word document inside.'); })();
  const core = xmlOf('docProps/core.xml');
  const title = textOf(kids(core).find((k) => k.name === 'dc:title')) || '';
  let kept = null; // docPr id → canvas or plan chart, when every other part is as export wrote it (an old whole-Document stash has no nodes)
  if (!fresh && files.has(STASH)) {
    try {
      const stash = JSON.parse(text(files.get(STASH)));
      if (stash.nodes && stash.hash === await packageHash(files)) kept = stash.nodes;
    } catch { /* a damaged stash: the pictures stay pictures */ }
  }
  const dropped = new Set();
  // Word's page hints: the blocks of paragraphs holding a w:lastRenderedPageBreak (where its last layout started a page), as the
  // layout cache's first guess (props.breaks below).
  const hinted = new Set();
  const linked = []; // the text boxes of linked stories (storyOf); the last box's link to a box after it goes at the end
  // Their ids start with the file's own mark, so the boxes of a second file brought into the same Document get ids of their own.
  const storyTag = `tx${sig(docXmlText)}`;
  const relsPath = (part) => `${part.replace(/[^/]+$/, '')}_rels/${part.split('/').pop()}.rels`;
  const relsOf = (part) => {
    const x = xmlOf(relsPath(part));
    return new Map(kids(x, 'Relationship').map((r) => [at(r, 'Id'), { type: at(r, 'Type')?.replace(DOC_PR, '').split('/').pop(), target: at(r, 'Target'), mode: at(r, 'TargetMode') }]));
  };
  // What the model does not hold of each part, kept beside it for export.mjs (sigs are added once the model is complete, at the end).
  const beside = { styles: null, numbering: null };
  const base = newDocumentJson(settings);
  const attrs = base.attrs;

  // Styles, theme, numbering and settings.
  const styles = xmlOf('word/styles.xml');
  // The default style of each type (w:default="1") reads as the model's id for it, which a block without a style resolves to and
  // export.mjs marks default again: Normal, DefaultParagraphFont, TableNormal (German Word's "Standard" becomes Normal). An id the
  // file already uses for another style keeps its own.
  const alias = {};
  const fileIds = new Set(kids(styles, 'w:style').map((s) => at(s, 'w:styleId')));
  for (const s of kids(styles, 'w:style')) {
    const to = DEFAULT_IDS[at(s, 'w:type') ?? 'paragraph'];
    const id = at(s, 'w:styleId');
    if (to && id && id !== to && /^(1|true|on)$/i.test(at(s, 'w:default') ?? '') && !fileIds.has(to)) alias[id] = to;
  }
  const sid = (id) => (id == null ? null : alias[id] ?? id);
  if (styles) {
    const dd = kid(styles, 'w:docDefaults');
    const run = styleRun(runProps(kid(kid(dd, 'w:rPrDefault'), 'w:rPr')));
    const para = styleParaOf(paraProps(kid(kid(dd, 'w:pPrDefault'), 'w:pPr')));
    // What the file leaves out takes Word's own fallbacks, not a new Document's (Aptos 12 pt, ligatures): 10 pt and Times New
    // Roman when no style sets them (the user, 2026-10-28: a résumé at 10 pt opened at 12). Only the proofing language stays ours.
    attrs.styles.defaults = { ...attrs.styles.defaults, run: { lang: attrs.styles.defaults.run.lang, font: 'Times New Roman', size: 10, ...run }, para: { ...para } };
    // Kept for export: the root's declarations, the latent styles, and the defaults' and each style's own XML under the model's ids.
    beside.styles = { root: { ...styles.attrs }, latent: kid(styles, 'w:latentStyles') && toXml(kid(styles, 'w:latentStyles')), defaults: dd && toXml(dd), styles: {} };
    for (const s of kids(styles, 'w:style')) {
      const id = sid(at(s, 'w:styleId'));
      const type = at(s, 'w:type') ?? 'paragraph';
      if (!id) continue;
      s.attrs['w:styleId'] = id;
      for (const e of ['w:basedOn', 'w:next', 'w:link'].map((n) => kid(s, n))) if (alias[at(e, 'w:val')]) e.attrs['w:val'] = alias[at(e, 'w:val')];
      beside.styles.styles[id] = toXml(s);
      if (type === 'character' && ['DefaultParagraphFont', 'FootnoteReference', 'EndnoteReference', 'CommentReference'].includes(id) && !attrs.styles.list[id]) continue;
      const pp = kid(s, 'w:pPr');
      const numPr = kid(pp, 'w:numPr');
      const tp = kid(s, 'w:tblPr');
      const tc = kid(s, 'w:tcPr');
      const style = clean({
        type, name: v(s, 'w:name') ?? id, aliases: v(s, 'w:aliases'), basedOn: sid(v(s, 'w:basedOn')), next: sid(v(s, 'w:next')), link: sid(v(s, 'w:link')),
        autoRedefine: flag(s, 'w:autoRedefine') || null, uiPriority: num(v(s, 'w:uiPriority')),
        qFormat: flag(s, 'w:qFormat') || null, hidden: flag(s, 'w:hidden') || null, semiHidden: flag(s, 'w:semiHidden') || null, unhideWhenUsed: flag(s, 'w:unhideWhenUsed') || null,
        locked: flag(s, 'w:locked') || null, para: clean({ ...styleParaOf(paraProps(pp)), ...(numPr && { numbering: { numId: v(numPr, 'w:numId'), ilvl: num(v(numPr, 'w:ilvl')) ?? 0 } }) }),
        run: clean(styleRun(runProps(kid(s, 'w:rPr')))),
        table: tp || tc ? clean({ rowBandSize: num(v(tp, 'w:tblStyleRowBandSize')), colBandSize: num(v(tp, 'w:tblStyleColBandSize')), borders: styleEdges(kid(tp, 'w:tblBorders')),
          shading: shd(kid(tc, 'w:shd')), vAlign: v(tc, 'w:vAlign'), cellMargin: margins(kid(tp, 'w:tblCellMar')),
          cond: clean(Object.fromEntries(kids(s, 'w:tblStylePr').map((c) => [at(c, 'w:type'), clean({ para: clean(styleParaOf(paraProps(kid(c, 'w:pPr')))), run: clean(styleRun(runProps(kid(c, 'w:rPr')))),
            cell: clean({ borders: styleEdges(kid(kid(c, 'w:tcPr'), 'w:tcBorders')), shading: shd(kid(kid(c, 'w:tcPr'), 'w:shd')), vAlign: v(kid(c, 'w:tcPr'), 'w:vAlign') }) })]))) }) : null,
      });
      attrs.styles.list[id] = style;
    }
  }
  const theme = xmlOf('word/theme/theme1.xml');
  if (theme) {
    const eaLang = at(kid(xmlOf('word/settings.xml'), 'w:themeFontLang'), 'w:eastAsia') ?? attrs.styles.defaults?.run?.lang?.eastAsia ?? null;
    attrs.theme = themeOf(theme, attrs.theme, eaLang);
    // The whole theme as Word wrote it, with what the model read from it, so export writes it back with only Design's changes.
    const { name, fonts, colors } = structuredClone(attrs.theme);
    attrs.theme.kept = { xml: text(files.get('word/theme/theme1.xml')), name, fonts, colors };
  }
  // What drawings resolve their colours and style references against (dml.mjs): the theme's colours, fonts and format scheme.
  const dml = { colors: attrs.theme?.colors, fonts: attrs.theme?.fonts, fmt: theme ? fmtOf(theme) : PLAIN_FMT };
  // The theme's object defaults (Word's Set as Default Shape, Line and Text Box), with what was read kept so export can tell a change.
  const od = theme && objectDefaultsOf(kid(theme, 'a:objectDefaults'), dml);
  if (od) Object.assign(attrs.theme, { objectDefaults: od, kept: { ...attrs.theme.kept, objectDefaults: structuredClone(od) } });
  // A shape's text takes the document's Normal run where its runs say nothing (shapes-in.mjs).
  const normal = { ...attrs.styles.defaults.run, ...attrs.styles.list.Normal?.run };
  const shapeCtx = { dml, fonts: dml.fonts, drop: (what) => dropped.add(what),
    text: { size: normal.size ?? 11, color: normal.color ?? '#000000', font: /^\+(major|minor)$/.test(normal.font ?? '') ? dml.fonts?.[normal.font.slice(1)] : normal.font ?? null } };
  const numbering = xmlOf('word/numbering.xml');
  if (numbering) {
    // Picture bullets (w:numPicBullet, a VML or DrawingML picture through numbering.xml's relationships) as data URLs by id.
    const nrels = relsOf('word/numbering.xml');
    const pics = {};
    for (const b of kids(numbering, 'w:numPicBullet')) {
      const img = deep(b, 'v:imagedata')[0] ?? deep(b, 'a:blip')[0];
      const r = nrels.get(at(img, 'r:id') ?? at(img, 'r:embed'));
      const path = r && resolve('word/numbering.xml', r.target);
      if (files.get(path)) pics[at(b, 'w:numPicBulletId')] = `data:${MIME[path.split('.').pop().toLowerCase()] ?? 'image/png'};base64,${base64(files.get(path))}`;
    }
    const abstract = {};
    for (const a of kids(numbering, 'w:abstractNum')) {
      abstract[at(a, 'w:abstractNumId')] = { ...(v(a, 'w:name') && { name: v(a, 'w:name') }), levels: kids(a, 'w:lvl').map((l) => {
        const ind = paraProps(kid(l, 'w:pPr')).indent ?? {};
        const tab = kids(kid(kid(l, 'w:pPr'), 'w:tabs'), 'w:tab').find((t) => at(t, 'w:val') === 'num');
        const text = v(l, 'w:lvlText') ?? '';
        const bullet = v(l, 'w:numFmt') === 'bullet';
        // The label's own font takes the style objects' keys (bold, italic), as the list dialogs hold it.
        return clean({ fmt: v(l, 'w:numFmt') ?? 'decimal', text, ...(bullet && { glyph: text }), pic: bullet ? pics[v(l, 'w:lvlPicBulletId')] : null, start: num(v(l, 'w:start')) ?? 0,
          left: ind.left ?? 0, hanging: ind.firstLine < 0 ? -ind.firstLine : 0, suff: v(l, 'w:suff'), jc: v(l, 'w:lvlJc'), restart: num(v(l, 'w:lvlRestart')),
          pStyle: sid(v(l, 'w:pStyle')), isLgl: flag(l, 'w:isLgl') || null, tab: tab ? pt(at(tab, 'w:pos')) : null, run: clean(styleRun(runProps(kid(l, 'w:rPr')))) });
      }) };
    }
    const nums = {};
    for (const n of kids(numbering, 'w:num')) {
      nums[at(n, 'w:numId')] = clean({ abstract: v(n, 'w:abstractNumId'), overrides: clean(Object.fromEntries(kids(n, 'w:lvlOverride').map((o) => [at(o, 'w:ilvl'), clean({ start: num(v(o, 'w:startOverride')) })]))) });
    }
    // A list made from a list style (w:numStyleLink) has no levels of its own: its nums take the definition of the num the style
    // numbers with (ECMA-376 §17.9.21).
    for (const a of kids(numbering, 'w:abstractNum')) {
      const link = v(a, 'w:numStyleLink');
      const to = link && nums[attrs.styles.list[sid(link)]?.para?.numbering?.numId]?.abstract;
      if (to != null && abstract[to]?.levels.length) for (const n of Object.values(nums)) if (n?.abstract === at(a, 'w:abstractNumId')) n.abstract = to;
    }
    // The built-in bullet and decimal definitions stay, for the Home tab's list buttons; the file's lists use its own ids.
    attrs.numbering = { abstract: { ...abstract, bullet: attrs.numbering.abstract.bullet, decimal: attrs.numbering.abstract.decimal }, nums };
    // Kept for export: each list's own attributes, nsid, type, template and style links, each level's and num's XML (a num's
    // without the ids export renumbers), Word's picture bullets by their picture, and what follows the nums.
    const inner = (n, keep) => kids(n).filter(keep).map(toXml).join('');
    const HEAD_EL = ['w:nsid', 'w:multiLevelType', 'w:tmpl'];
    beside.numbering = {
      root: { ...numbering.attrs },
      bullets: kids(numbering, 'w:numPicBullet').filter((b) => pics[at(b, 'w:numPicBulletId')])
        .map((b) => ({ id: at(b, 'w:numPicBulletId'), sig: sig(pics[at(b, 'w:numPicBulletId')]), xml: inner(b, () => true) })),
      abstract: Object.fromEntries(kids(numbering, 'w:abstractNum').map((a) => {
        const { 'w:abstractNumId': id, ...own } = a.attrs;
        const lvls = kids(a, 'w:lvl').map((l) => {
          const ps = kid(l, 'w:pStyle');
          if (alias[at(ps, 'w:val')]) ps.attrs['w:val'] = alias[at(ps, 'w:val')];
          return toXml(l);
        });
        return [id, { attrs: own, pre: inner(a, (k) => HEAD_EL.includes(k.name)), post: inner(a, (k) => ![...HEAD_EL, 'w:name', 'w:lvl'].includes(k.name)), lvls }];
      })),
      nums: Object.fromEntries(kids(numbering, 'w:num').map((n) => {
        const { 'w:numId': id, ...own } = n.attrs;
        return [id, { attrs: own, abstract: v(n, 'w:abstractNumId'), inner: inner(n, (k) => k.name !== 'w:abstractNumId') }];
      })),
      tail: inner(numbering, (k) => !['w:numPicBullet', 'w:abstractNum', 'w:num'].includes(k.name)),
    };
  }
  const settingsXml = xmlOf('word/settings.xml');
  if (settingsXml) {
    const s = settingsXml;
    const on = (name) => !!flag(s, name);
    const yes = (x) => /^(1|true|on)$/.test(x ?? '');
    const dp = kid(s, 'w:documentProtection');
    const wp = kid(s, 'w:writeProtection');
    const m = kid(s, 'm:mathPr');
    const mv = (name) => at(kid(m, `m:${name}`), 'm:val');
    const mOn = (name) => (kid(m, `m:${name}`) ? !/^(0|false|off)$/.test(mv(name) ?? '') : null);
    attrs.settings = { ...attrs.settings, defaultTabStop: pt(v(s, 'w:defaultTabStop')) ?? attrs.settings.defaultTabStop,
      trackRevisions: on('w:trackRevisions'), evenAndOddHeaders: on('w:evenAndOddHeaders'), mirrorMargins: on('w:mirrorMargins'), gutterAtTop: on('w:gutterAtTop'),
      autoHyphenation: on('w:autoHyphenation'), hyphenationZone: pt(v(s, 'w:hyphenationZone')) ?? attrs.settings.hyphenationZone,
      consecutiveHyphenLimit: num(v(s, 'w:consecutiveHyphenLimit')) ?? 0, doNotHyphenateCaps: on('w:doNotHyphenateCaps'), printTwoOnOne: on('w:printTwoOnOne'),
      // Word writes Sheets per booklet n as 4n - 4, All (0) as -4 (checked in Word 2026-10-29).
      bookFold: on('w:bookFoldPrinting') || on('w:bookFoldRevPrinting') ? { sheets: Math.max(0, ((num(v(s, 'w:bookFoldPrintingSheets')) ?? -4) + 4) / 4), reverse: on('w:bookFoldRevPrinting') } : null,
      footnotePr: notePr(kid(s, 'w:footnotePr')), endnotePr: notePr(kid(s, 'w:endnotePr')),
      // Restrict Editing without Word's password hash, which the app's (protect/hash.mjs) cannot check.
      protection: dp ? { edit: at(dp, 'w:edit') ?? 'none', formatting: yes(at(dp, 'w:formatting')), enforcement: yes(at(dp, 'w:enforcement')),
        autoFormatOverride: on('w:autoFormatOverride'), lockTheme: on('w:styleLockTheme'), lockQFSet: on('w:styleLockQFSet') } : null,
      writeProtection: wp ? { recommended: yes(at(wp, 'w:recommended')) } : null, updateFields: on('w:updateFields'), displayBackground: on('w:displayBackgroundShape'),
      formShading: !on('w:doNotShadeFormData'), linkStyles: on('w:linkStyles'),
      grid: clean({ h: pt(v(s, 'w:drawingGridHorizontalSpacing')), v: pt(v(s, 'w:drawingGridVerticalSpacing')), useMargins: on('w:doNotUseMarginsForDrawingGridOrigin') ? false : null,
        x: pt(v(s, 'w:drawingGridHorizontalOrigin')), y: pt(v(s, 'w:drawingGridVerticalOrigin')), everyH: num(v(s, 'w:displayHorizontalDrawingGridEvery')),
        everyV: num(v(s, 'w:displayVerticalDrawingGridEvery')) }),
      bordersDoNotSurroundHeader: on('w:bordersDoNotSurroundHeader'), bordersDoNotSurroundFooter: on('w:bordersDoNotSurroundFooter'), alignBordersAndEdges: on('w:alignBordersAndEdges'),
      compat: { ...attrs.settings.compat, htmlAutoSpacing: !flag(kid(s, 'w:compat'), 'w:doNotUseHTMLParagraphAutoSpacing') },
      mathPr: m ? clean({ font: mv('mathFont'), brkBin: mv('brkBin'), brkBinSub: mv('brkBinSub'), smallFrac: mOn('smallFrac'), dispDef: mOn('dispDef'), lMargin: pt(mv('lMargin')),
        rMargin: pt(mv('rMargin')), defJc: mv('defJc'), wrapIndent: pt(mv('wrapIndent')), wrapRight: mOn('wrapRight'), intLim: mv('intLim'), naryLim: mv('naryLim') }) : null };
    const vars = kids(kid(s, 'w:docVars'), 'w:docVar');
    if (vars.length) attrs.vars = Object.fromEntries(vars.map((d) => [at(d, 'w:name'), at(d, 'w:val') ?? '']));
    // A mail merge main document's type (its data source stays outside the document, as the app keeps it).
    const mergeType = Object.keys(MERGE_TYPES).find((k) => MERGE_TYPES[k] === v(kid(s, 'w:mailMerge'), 'w:mainDocumentType'));
    if (mergeType) attrs.merge = { type: mergeType };
    // Kept for export: every setting as Word wrote it (export writes back those the model does not write), the compatibility
    // options one by one, and the external relationships settings name (the attached template).
    const compat = kid(s, 'w:compat');
    attrs.settings.kept = { root: { ...s.attrs }, items: kids(s).filter((k) => k !== compat).map((k) => [k.name, toXml(k)]),
      compat: compat ? kids(compat).map((k) => [k.name, toXml(k)]) : null,
      rels: kids(xmlOf(relsPath('word/settings.xml')), 'Relationship').filter((r) => at(r, 'TargetMode') === 'External')
        .map((r) => ({ id: at(r, 'Id'), type: at(r, 'Type'), target: at(r, 'Target'), mode: 'External' })) };
  }
  const coreText = (name) => textOf(kid(core, name)) || null;
  const coreProps = clean({ title: title || null, subject: coreText('dc:subject'), creator: coreText('dc:creator'), keywords: coreText('cp:keywords'),
    description: coreText('dc:description'), category: coreText('cp:category'), contentStatus: coreText('cp:contentStatus') });
  // The app (extended) properties the user types, and the custom ones: text, number, date (its day) or yes or no.
  const app = xmlOf('docProps/app.xml');
  const appProps = clean(Object.fromEntries([['company', 'Company'], ['manager', 'Manager'], ['hyperlinkBase', 'HyperlinkBase'], ['template', 'Template']].map(([k, n]) => [k, textOf(kid(app, n)) || null])));
  const custom = kids(xmlOf('docProps/custom.xml'), 'property').map((p) => {
    const x = kids(p)[0];
    const type = { 'vt:lpwstr': 'text', 'vt:lpstr': 'text', 'vt:bstr': 'text', 'vt:filetime': 'date', 'vt:date': 'date', 'vt:bool': 'bool' }[x?.name]
      ?? (/^vt:(u?i[1248]|u?int|r[48]|decimal)$/.test(x?.name ?? '') ? 'number' : null);
    const t = textOf(x);
    return type && { name: at(p, 'name'), type, value: type === 'number' ? +t : type === 'bool' ? /^(1|true)$/i.test(t) : type === 'date' ? t.slice(0, 10) : t };
  }).filter(Boolean);
  // Word's page count when it last saved the file: the opening card's estimate while the pages lay out (open-worker).
  const pages = Math.round(+textOf(kid(app, 'Pages'))) || null;
  const props = clean({ core: coreProps, app: appProps, custom: custom.length ? custom : null, pages: pages > 0 ? pages : null });
  if (props) attrs.props = { ...(attrs.props ?? {}), ...props };

  // Parts the model does not read, kept as Word wrote them with every file they relate to (settings.parts, which export.mjs writes
  // back): web settings, the font table with its embedded fonts, custom XML data and the glossary's own settings. The cover page's
  // custom XML part is read into props.cover instead, which the Document Property controls show and export writes back.
  const types = xmlOf('[Content_Types].xml');
  const extOf = (path) => path.split('.').pop().toLowerCase();
  const ctOf = (path) => at(kids(types, 'Override').find((o) => at(o, 'PartName')?.toLowerCase() === `/${path}`.toLowerCase()), 'ContentType')
    ?? (/^(xml|rels)$/.test(extOf(path)) ? null : at(kids(types, 'Default').find((d) => at(d, 'Extension')?.toLowerCase() === extOf(path)), 'ContentType'));
  const filesOf = (path, seen) => {
    const rp = relsPath(path);
    if (!files.has(rp) || seen.has(rp)) return [];
    seen.add(rp);
    return [[rp, base64(files.get(rp)), null], ...kids(xmlOf(rp), 'Relationship').flatMap((r) => {
      const to = at(r, 'TargetMode') === 'External' ? null : resolve(path, at(r, 'Target') ?? '');
      if (!to || seen.has(to) || !files.has(to)) return [];
      seen.add(to);
      return [[to, base64(files.get(to)), ctOf(to)], ...filesOf(to, seen)];
    })];
  };
  const keptParts = [];
  const keepFrom = (from, wanted) => {
    for (const r of kids(xmlOf(relsPath(from)), 'Relationship')) {
      const type = at(r, 'Type') ?? '';
      const path = resolve(from, at(r, 'Target') ?? '');
      // Ink is a custom XML relationship too, which the drawings read.
      if (!wanted.test(type) || at(r, 'TargetMode') === 'External' || !files.has(path) || (/\/customXml$/.test(type) && !path.startsWith('customXml/'))) continue;
      const item = /\/customXml$/.test(type) ? xmlOf(path) : null;
      if (item?.name.replace(/^[\w.-]+:/, '') === 'CoverPageProperties' && Object.values(item.attrs).includes(CPP)) {
        const cover = clean(Object.fromEntries(COVER.map(([key, name]) => [key, textOf(kids(item).find((k) => k.name.replace(/^[\w.-]+:/, '') === name)) || null])));
        if (cover) attrs.props = { ...(attrs.props ?? {}), cover };
        continue;
      }
      keptParts.push({ path, from, type, target: at(r, 'Target'), ct: ctOf(path), data: base64(files.get(path)), files: filesOf(path, new Set([path])) });
    }
  };
  keepFrom('word/document.xml', /\/(webSettings|fontTable|customXml)$/);
  if (files.has('word/glossary/document.xml')) keepFrom('word/glossary/document.xml', /\/(settings|webSettings|fontTable)$/);
  if (keptParts.length) attrs.settings = { ...attrs.settings, parts: keptParts };

  // Notes and comments are read when a reference meets them.
  const noteParts = {};
  for (const kind of ['footnote', 'endnote']) {
    const x = xmlOf(`word/${kind}s.xml`);
    noteParts[kind] = new Map(kids(x, `w:${kind}`).filter((n) => !at(n, 'w:type') || at(n, 'w:type') === 'normal').map((n) => [at(n, 'w:id'), n]));
  }
  const commentsXml = xmlOf('word/comments.xml');
  const commentEls = new Map(kids(commentsXml, 'w:comment').map((c) => [at(c, 'w:id'), c]));
  const comments = {};
  // commentsExtended (w15): by the w14:paraId of a comment's last paragraph, whether it is resolved and the thread it replies to.
  const cxRel = [...relsOf('word/document.xml').values()].find((r) => r.type === 'commentsExtended');
  const commentEx = new Map(kids(cxRel && xmlOf(resolve('word/document.xml', cxRel.target)), 'w15:commentEx').map((e) => [at(e, 'w15:paraId'), e]));
  const commentByPara = new Map([...commentEls].map(([id, c]) => [at(kids(c, 'w:p').at(-1), 'w14:paraId'), id]).filter(([p]) => p));
  // commentsIds (w16cid) gives a comment its durable id by the same paraId, and commentsExtensible (w16cex) that id its UTC date.
  const partOf = (type) => { const r = [...relsOf('word/document.xml').values()].find((x) => x.type === type); return r ? xmlOf(resolve('word/document.xml', r.target)) : null; };
  const durable = new Map(kids(partOf('commentsIds'), 'w16cid:commentId').map((e) => [at(e, 'w16cid:paraId'), at(e, 'w16cid:durableId')]));
  const utc = new Map(kids(partOf('commentsExtensible'), 'w16cex:commentExtensible').map((e) => [at(e, 'w16cex:durableId'), at(e, 'w16cex:dateUtc')]));

  /** A reader of one part's blocks (document, header, footer, note, comment), with that part's relationships. */
  function reader(part) {
    const rels = relsOf(part);
    let active = new Set(); // comment ids open here
    let field = null; // the complex field being read: {code, result, state: 'code' | 'result', locked, dirty, depth, spans}
    const spanning = new WeakSet(); // the w:fldChar begins of fields that run past their paragraph (paragraph() marks them)
    const shapeTypes = new Map(); // this part's VML shapetypes by id: Word defines each once, at its first use
    const header = /^word\/header/.test(part);
    let watermark = null; // a header's watermark (vml.mjs watermarkOf), which is its section's, not a drawing in the header

    const picture = (rid) => {
      const r = rels.get(rid);
      const path = r && resolve(part, r.target);
      const bytes = path && files.get(path);
      if (!bytes) return null;
      const ext = path.split('.').pop().toLowerCase();
      return `data:${MIME[ext] ?? 'image/png'};base64,${base64(bytes)}`;
    };
    /** w:drawing → inline nodes, and the blocks to put around its paragraph: a text box goes before it (after.before), so the
     * paragraph is the block after the box, which float-layout anchors it to; a kept canvas or plan chart goes after it. */
    function drawingOf(d, marks, after, props = {}) {
      const box = kid(d, 'wp:inline') ?? kid(d, 'wp:anchor');
      if (!box) return [];
      const ext = kid(box, 'wp:extent');
      // Its size in EMU: a relative size where it has one, else its extent (null when missing).
      const rel = relSizeOf(box, page, attrs.settings?.gutterAtTop);
      const cx = rel.cx ?? num(at(ext, 'cx'));
      const cy = rel.cy ?? num(at(ext, 'cy'));
      const ptOf = (e, d) => (e == null ? d : Math.round((e / 12700) * 100) / 100);
      // A zero extent stays zero (Word draws such a picture at no size); only a missing one falls back to 100 px. Four decimals keep
      // the extent to the EMU on export.
      const w = cx == null ? 100 : Math.round((cx / 9525) * 10000) / 10000;
      const h = cy == null ? 100 : Math.round((cy / 9525) * 10000) / 10000;
      const pr = kid(box, 'wp:docPr');
      // What the drawing holds directly: a picture, a text box, or a shape, group, drawing canvas or diagram (shapes-in.mjs). A
      // picture in a text box's text or in a group is theirs, not the drawing's.
      const gd = kid(kid(box, 'a:graphic'), 'a:graphicData');
      const wsp = kid(gd, 'wps:wsp');
      // A box a linked story flows into holds no text of its own (wps:linkedTxbx): the first box holds the story.
      const txbx = wsp && isTextBox(wsp) && (deep(wsp, 'w:txbxContent')[0] ?? kid(wsp, 'wps:linkedTxbx'));
      const blip = !txbx && deep(kid(gd, 'pic:pic'), 'a:blip')[0];
      const layout = box.name === 'wp:anchor' ? { ...anchorLayout(box), ...(rel.keep && { relSize: rel.keep }) } : null;
      // The drawing run's own properties (Word's noProof), which a block (a text box, a canvas) cannot hold as marks.
      const run = Object.keys(props).length ? { run: props } : null;
      const own = kept?.[at(pr, 'id')];
      if (!blip && !txbx && own?.type === 'canvas') return placeShapes({ type: 'canvas', attrs: { ...own.attrs, ...run } }, layout, after); // exported as Word shapes
      if (blip && (own?.type === 'canvas' || own?.type === 'planChart')) {
        const { suggest, ...attrs } = own.attrs ?? {};
        after.push({ type: own.type, attrs });
        after.kept = true; // its paragraph held only this picture
        return [];
      }
      if (blip) {
        const shown = pictureSource(blip, picture); // an SVG shows itself and keeps Word's PNG as its fallback
        if (!shown) { dropped.add('pictures that could not be read'); return []; }
        const xfrm = deep(box, 'a:xfrm')[0];
        return [{ type: 'image', attrs: { ...shown, alt: at(pr, 'descr') ?? '', title: at(pr, 'title') ?? null, name: at(pr, 'name') ?? null, width: w, height: h,
          ...(layout && { layout }), ...(num(at(xfrm, 'rot')) && { rotate: num(at(xfrm, 'rot')) / 60000 }), ...(at(xfrm, 'flipH') === '1' && { flipH: true }), ...(at(xfrm, 'flipV') === '1' && { flipV: true }),
          ...pictureLook(kid(gd, 'pic:pic'), dml.colors), ...(decorative(pr) && { decorative: true }) }, ...(marks.length && { marks }) }];
      }
      if (txbx) {
        const content = blocks(kids(txbx));
        const node = { type: 'textBox', attrs: { w: ptOf(cx, 75), h: ptOf(cy, 75), layout: layout ?? { wrap: 'inline' }, alt: at(pr, 'descr') ?? '', name: at(pr, 'name'),
          ...(decorative(pr) && { decorative: true }), ...boxLook(box, dml, picture), ...storyOf(wsp, storyTag), ...run }, content: content.length ? content : [{ type: 'paragraph' }] };
        if (node.attrs.link) linked.push(node);
        (after.before ??= []).push(node);
        return [];
      }
      // A chart (c:chart, or a chartex cx:chart) shows from its part's cached data and keeps its parts for export (chart/parts.mjs).
      const ref = gd && (kid(gd, 'c:chart') ?? kid(gd, 'cx:chart'));
      if (ref) {
        const r = rels.get(at(ref, 'r:id'));
        const chart = r && chartOf(files, resolve(part, r.target), parseXml, attrs.theme);
        if (!chart) { dropped.add('charts'); return []; }
        if (chart.model.other) dropped.add(`drawings of ${chart.model.other.toLowerCase()} charts`);
        return [{ type: 'chart', attrs: { w: ptOf(cx, 360), h: ptOf(cy, 216), layout, name: at(pr, 'name'), alt: at(pr, 'descr') ?? '', ...chart }, ...(marks.length && { marks }) }];
      }
      const shapes = gd && canvasOf(gd, cx ?? 0, cy ?? 0, { ...shapeCtx, picture, partXml }, layout);
      if (shapes) {
        const docPr = clean({ ...shapes.attrs.docPr, name: at(pr, 'name'), alt: at(pr, 'descr'), decorative: decorative(pr) || null });
        return placeShapes({ type: 'canvas', attrs: { ...shapes.attrs, layout: shapes.layout, ...(docPr && { docPr }), ...run } }, layout, after);
      }
      dropped.add('shapes and drawings');
      return [];
    }
    /** A canvas of Word shapes: a floating one before its paragraph, which float-layout anchors it to (as a text box); an inline one
     * after it, and its paragraph goes when it held only the drawing. */
    function placeShapes(node, layout, after) {
      if (layout) (after.before ??= []).push(node);
      else { after.push(node); after.kept = true; }
      return [];
    }
    const partXml = (rid) => { const r = rels.get(rid); return r ? xmlOf(resolve(part, r.target)) : null; };
    /** The pictures in `nodes` with the ink part that element `c` falls back from (selectAlternates' '#ink') as their ink, at the
     * ink's size (the fallback picture's frame is a little larger). */
    const inked = (c, nodes) => {
      const [rid, cx, cy] = (at(c, '#ink') ?? '').split(' ');
      const r = rels.get(rid);
      const ink = r && text(files.get(resolve(part, r.target)));
      const px = (emu) => (num(emu) ? Math.round((num(emu) / 9525) * 10000) / 10000 : null); // four places: the EMU come back exact
      if (ink) for (const n of nodes) if (n.type === 'image') n.attrs = { ...n.attrs, ink, ...(px(cx) && px(cy) && { width: px(cx), height: px(cy) }) };
      return nodes;
    };

    /** The inline nodes of a paragraph's children `list`, with `marks` from enclosing hyperlinks and revisions. */
    function inlines(list, marks, out, after, breaks) {
      for (const n of list) {
        if (typeof n === 'string') continue;
        switch (n.name) {
          case 'w:r': run(n, marks, out, after, breaks); break;
          case 'w:hyperlink': {
            const r = rels.get(at(n, 'r:id'));
            const link = { type: 'link', attrs: clean({ href: r?.target ?? null, anchor: at(n, 'w:anchor'), tooltip: at(n, 'w:tooltip'), frame: at(n, 'w:tgtFrame') }) ?? {} };
            inlines(kids(n), [...marks, link], out, after, breaks);
            break;
          }
          case 'w:ins': case 'w:moveTo': case 'w:del': case 'w:moveFrom': {
            const del = n.name === 'w:del' || n.name === 'w:moveFrom';
            const m = { type: del ? 'deletion' : 'insertion', attrs: { id: at(n, 'w:id'), author: at(n, 'w:author') ?? 'Unknown', date: at(n, 'w:date'), move: n.name.startsWith('w:move') ? at(n, 'w:id') : null } };
            inlines(kids(n), [...marks, m], out, after, breaks);
            break;
          }
          case 'w:smartTag': case 'w:customXml': case 'w:dir': case 'w:bdo': inlines(kids(n), marks, out, after, breaks); break;
          case 'w:sdt': {
            const content = [];
            inlines(kids(kid(n, 'w:sdtContent')), marks, content, after, breaks);
            out.push({ type: 'sdtInline', attrs: { sdt: sdtOf(kid(n, 'w:sdtPr'), placeholders, kid(n, 'w:sdtEndPr'), dml.colors) }, ...(content.length && { content }) });
            break;
          }
          case 'w:fldSimple': {
            // The field draws in its result's formatting, its first run's, and keeps each run's own (fields-core runs.mjs).
            const m = withComments([...marksOf(runProps(kid(kid(n, 'w:r'), 'w:rPr'), dml.colors)), ...marks]);
            const result = textOf(n);
            const parts = kids(n, 'w:r').map((r) => ({ text: kids(r).map((k) => (k.name === 'w:t' ? textOf(k) : k.name === 'w:tab' ? '\t' : '')).join(''),
              marks: withComments([...marksOf(runProps(kid(r, 'w:rPr'), dml.colors)), ...marks]) }));
            const own = parts.map((x) => x.text).join('') === result ? resultRuns(parts) : null;
            const mk = own ? own.marks : m;
            out.push({ type: 'field', attrs: { code: (at(n, 'w:instr') ?? '').trim(), result, locked: at(n, 'w:fldLock') === '1', dirty: at(n, 'w:dirty') === '1', ...(own && { runs: own.runs }) },
              ...(mk.length && { marks: mk }) });
            break;
          }
          case 'w:bookmarkStart': if (at(n, 'w:name') !== '_GoBack') { out.push({ type: 'bookmark', attrs: { name: at(n, 'w:name'), id: `b${at(n, 'w:id')}`, end: false } }); bookmarks.add(at(n, 'w:id')); } break;
          case 'w:bookmarkEnd': if (bookmarks.has(at(n, 'w:id'))) out.push({ type: 'bookmark', attrs: { name: '', id: `b${at(n, 'w:id')}`, end: true } }); break;
          // A reply (commentsExtended) has no mark of its own: its thread's mark holds the range.
          case 'w:commentRangeStart': readComment(at(n, 'w:id')); if (!comments[`c${at(n, 'w:id')}`]?.parent) active.add(at(n, 'w:id')); break;
          case 'w:commentRangeEnd': active.delete(at(n, 'w:id')); break;
          case 'm:oMath': case 'm:oMathPara': out.push(equationOf(n)); break;
          default: break; // proofErr, permStart, permEnd and the like
        }
      }
    }
    const withComments = (marks) => (active.size ? [...marks, ...[...active].map((id) => ({ type: 'comment', attrs: { id: `c${id}` } }))] : marks);
    const push = (out, node) => {
      const last = out.at(-1);
      if (node.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) last.text += node.text;
      else out.push(node);
    };
    /** A complex field from its w:fldChar begin `c`, in a run of marks `m`, with a legacy form field's options (w:ffData) as ff. */
    const openField = (c, m) => ({ code: '', result: '', parts: [], state: 'code', depth: 0, locked: at(c, 'w:fldLock') === '1', dirty: at(c, 'w:dirty') === '1', m,
      ff: kid(c, 'w:ffData') ? ffOf(kid(c, 'w:ffData')) : null });
    // A field draws in its result's formatting (its first result run's), else its begin run's; a result whose runs differ keeps
    // each run's formatting in runs, and the node the formatting they share (fields-core runs.mjs).
    const fieldNode = (f) => {
      const own = f.state === 'result' ? resultRuns(f.parts) : null;
      return { type: 'field', attrs: { code: f.code.trim(), result: f.state === 'result' ? f.result : null, locked: f.locked, dirty: f.dirty, ...(f.ff && { ff: f.ff }),
        ...(own && { runs: own.runs }) }, ...(own ? own.marks.length && { marks: own.marks } : f.rm ?? f.m) };
    };
    /** One w:r. Complex fields (begin, code, separate, result, end) collect into one field node. */
    function run(r, outer, out, after, breaks) {
      const rp = kid(r, 'w:rPr');
      const props = runProps(rp, dml.colors);
      // Tracked formatting (w:rPrChange) holds the run's properties before the change.
      const ch = kid(rp, 'w:rPrChange');
      const fmt = ch ? [{ type: 'formatChange', attrs: { id: at(ch, 'w:id'), author: at(ch, 'w:author') ?? 'Unknown', date: at(ch, 'w:date'), old: marksOf(runProps(kid(ch, 'w:rPr'), dml.colors)) } }] : [];
      const marks = withComments([...marksOf(props), ...fmt, ...outer]);
      const m = marks.length ? { marks } : {};
      for (const c of kids(r)) {
        if (field) {
          // A field begun in the result of one that runs past its paragraph (a contents entry's PAGEREF) is a field of its own.
          const f = field.sub ?? field;
          const spans = f === field && (f.block || f.spans);
          if (c.name === 'w:fldChar') {
            const t = at(c, 'w:fldCharType');
            if (t === 'begin' && spans && f.state === 'result' && !f.depth) field.sub = openField(c, m);
            else if (t === 'begin') f.depth++;
            else if (t === 'separate' && f.depth === 0) f.state = 'result';
            else if (t === 'end') {
              if (f.depth) f.depth--;
              else if (f !== field) { field.sub = null; out.push(fieldNode(f)); }
              else {
                field = null;
                if (f.block) f.block.end = true;
                else out.push(fieldNode(f));
              }
            }
          } else if (c.name === 'w:instrText' && f.state === 'code' && !f.depth) f.code += textOf(c);
          // A field that runs past its paragraph keeps its result as blocks, from the part in the paragraph it begins in.
          else if (f.state === 'result' && spans) runPart(c, m, out, after, breaks, props);
          else if (f.state === 'result' && (c.name === 'w:t' || c.name === 'w:tab')) {
            if (!f.depth) f.rm ??= m;
            const s = c.name === 'w:t' ? textOf(c) : '\t';
            f.result += s;
            f.parts.push({ text: s, marks: m.marks ?? [] });
          }
          continue;
        }
        if (c.name === 'w:fldChar' && at(c, 'w:fldCharType') === 'begin') {
          field = { ...openField(c, m), spans: spanning.has(c) };
          continue;
        }
        runPart(c, m, out, after, breaks, props);
      }
    }
    function runPart(c, m, out, after, breaks, props) {
      switch (c.name) {
        case 'w:t': case 'w:delText': { const s = textOf(c); if (s) push(out, { type: 'text', text: s, ...m }); break; }
        case 'w:tab': push(out, { type: 'text', text: '\t', ...m }); break;
        case 'w:noBreakHyphen': push(out, { type: 'text', text: '‑', ...m }); break;
        case 'w:softHyphen': push(out, { type: 'text', text: '­', ...m }); break;
        case 'w:sym': {
          // The character keeps its symbol font (Wingdings, Symbol), whose glyph it is.
          const ts = (m.marks ?? []).find((k) => k.type === 'textStyle');
          const marks = at(c, 'w:font') ? [...(m.marks ?? []).filter((k) => k !== ts), { type: 'textStyle', attrs: { ...ts?.attrs, font: at(c, 'w:font') } }] : m.marks;
          push(out, { type: 'text', text: String.fromCharCode(parseInt(at(c, 'w:char') ?? '20', 16) & 0xFFF ? parseInt(at(c, 'w:char'), 16) : 32), ...(marks?.length && { marks }) });
          break;
        }
        case 'w:cr': out.push({ type: 'hardBreak', ...m }); break;
        case 'w:br': {
          const t = at(c, 'w:type');
          if (t === 'page' || t === 'column') breaks.push({ at: out.length, type: t === 'page' ? 'pageBreak' : 'columnBreak' });
          else out.push({ type: 'hardBreak', ...(at(c, 'w:clear') && at(c, 'w:clear') !== 'none' && { attrs: { clear: at(c, 'w:clear') } }), ...m });
          break;
        }
        case 'w:drawing': out.push(...inked(c, drawingOf(c, m.marks ?? [], after, props))); break;
        // VML reads as the DrawingML it means (vml.mjs), on drawingOf's one path. An OLE object (w:object) shows its preview.
        case 'w:pict': case 'w:object': {
          const wms = header ? kids(c).filter(isWatermark) : [];
          for (const k of wms) watermark ??= watermarkOf(k, picture, { w: page.w - page.margin.left - page.margin.right - page.margin.gutter, h: page.h - page.margin.top - page.margin.bottom });
          for (const d of vmlDrawings(wms.length ? { ...c, kids: c.kids.filter((k) => !wms.includes(k)) } : c, shapeTypes)) {
            if (d) out.push(...inked(c, drawingOf(d, m.marks ?? [], after, props)));
            else dropped.add('older drawing objects (VML)');
          }
          break;
        }
        case 'w:footnoteReference': case 'w:endnoteReference': {
          const kind = c.name === 'w:endnoteReference' ? 'endnote' : 'footnote';
          const el = noteParts[kind].get(at(c, 'w:id'));
          const content = el ? reader(`word/${kind}s.xml`).note(el) : [{ type: 'paragraph' }];
          out.push({ type: 'noteRef', attrs: { kind, id: `${kind[0]}${at(c, 'w:id')}`, content, mark: null }, ...m });
          if (at(c, 'w:customMarkFollows') === '1') out.customMark = out.at(-1);
          break;
        }
        case 'w:ruby': {
          const rp = kid(c, 'w:rubyPr');
          const rt = runProps(kid(kid(kid(c, 'w:rt'), 'w:r'), 'w:rPr'));
          const base = runProps(kid(kid(kid(c, 'w:rubyBase'), 'w:r'), 'w:rPr'));
          out.push({ type: 'ruby', attrs: { base: textOf(kid(c, 'w:rubyBase')), text: textOf(kid(c, 'w:rt')), align: v(rp, 'w:rubyAlign') ?? 'distributeSpace',
            size: num(v(rp, 'w:hps')) == null ? null : num(v(rp, 'w:hps')) / 2, offset: num(v(rp, 'w:hpsRaise')) == null ? null : num(v(rp, 'w:hpsRaise')) / 2,
            font: rt.fontEA ?? rt.font ?? null, lang: v(rp, 'w:lid'), hint: rt.hint ?? base.hint ?? null }, ...m });
          break;
        }
        case 'w:ptab': out.push({ type: 'ptab', attrs: { align: at(c, 'w:alignment') ?? 'center', relativeTo: at(c, 'w:relativeTo') ?? 'margin', leader: at(c, 'w:leader') ?? 'none' }, ...m }); break;
        case 'w:lastRenderedPageBreak': (out.hints ??= []).push(out.length); break;
        default: break; // rPr, annotationRef, footnoteRef, separators
      }
    }

    /** A w:p → the blocks it makes: a paragraph or heading, split around page and column breaks, then what follows it. */
    /** `alone`: the paragraph is the first block of its section (see the section's properties below). */
    function paragraph(p, alone = false) {
      const pp = kid(p, 'w:pPr');
      const a = paraProps(pp);
      // Collapsed by default (w15:collapsed): a paragraph's own, as styles.xml writes no w15.
      if (flag(pp, 'w15:collapsed') != null) a.collapsed = flag(pp, 'w15:collapsed');
      const style = sid(v(pp, 'w:pStyle'));
      const numPr = kid(pp, 'w:numPr');
      if (numPr && v(numPr, 'w:numId') && v(numPr, 'w:numId') !== '0') a.numbering = { numId: v(numPr, 'w:numId'), ilvl: num(v(numPr, 'w:ilvl')) ?? 0 };
      // The paragraph mark's own run properties: Word sizes an empty paragraph, and the last line of any, by its font.
      const markRun = runProps(kid(pp, 'w:rPr'), dml.colors);
      if (Object.keys(markRun).length) a.markRun = markRun;
      const mark = kid(kid(pp, 'w:rPr'), 'w:ins') || kid(kid(pp, 'w:rPr'), 'w:del');
      if (mark) a.markRev = { [mark.name === 'w:ins' ? 'ins' : 'del']: { id: at(mark, 'w:id'), author: at(mark, 'w:author') ?? 'Unknown', date: at(mark, 'w:date') } };
      // Tracked paragraph formatting (w:pPrChange): the properties before the change.
      const pc = kid(pp, 'w:pPrChange');
      const op = kid(pc, 'w:pPr');
      const on = kid(op, 'w:numPr');
      if (pc) a.pChange = { id: at(pc, 'w:id'), author: at(pc, 'w:author') ?? 'Unknown', date: at(pc, 'w:date'), old: clean({ ...paraProps(op), styleId: sid(v(op, 'w:pStyle')),
        numbering: v(on, 'w:numId') ? { numId: v(on, 'w:numId'), ilvl: num(v(on, 'w:ilvl')) ?? 0 } : null }) ?? {} };
      const heading = /^Heading([1-6])$/.exec(style ?? '') ?? /^heading ([1-6])$/i.exec(styleName(style) ?? '');
      const node = (content) => ({ type: heading ? 'heading' : 'paragraph', attrs: heading ? { ...a, level: +heading[1], styleId: null } : { ...a, styleId: !style || style === 'Normal' ? null : style }, ...(content.length && { content }) });
      const out = [];
      const after = [];
      const breaks = [];
      const startField = field;
      if (!startField) {
        // An outer field begun here and still open at the paragraph's end spans paragraphs (a table of contents).
        let depth = 0;
        let open = null;
        for (const c of deep(p, 'w:fldChar')) {
          const t = at(c, 'w:fldCharType');
          if (t === 'begin' && !depth++) open = c;
          else if (t === 'end' && depth) depth--;
        }
        if (depth) spanning.add(open);
      }
      inlines(kids(p), [], out, after, breaks);
      if (out.customMark) {
        const i = out.indexOf(out.customMark);
        const next = out[i + 1];
        if (next?.type === 'text') { out.customMark.attrs.mark = next.text; out.splice(i + 1, 1); }
      }
      // A paragraph that only holds a section's properties is that section's break. Word gives such an empty paragraph no room
      // (its spacing and font ignored) unless it is the only paragraph of its section, where it takes an empty line (probe
      // fixture/out/probe/nbhyphen/sectpara: two section paragraphs in a row add one line, one after text adds none).
      const sect = kid(pp, 'w:sectPr');
      const res = [];
      let from = 0;
      const hint = out.hints?.[0]; // the page Word started in this paragraph begins at the block after the last page break before it
      let hintAt = 0;
      breaks.forEach((b, k) => {
        const part = out.slice(from, b.at);
        // Bookmark starts alone before the break (a heading's _Toc bookmark) stay with the text after it, where a TOC link lands.
        // With nothing but bookmarks after the break (the heading is the next paragraph) they stay before it: an empty paragraph
        // on the break's page, as Word 2013 and later lay out a paragraph mark after a page break.
        const starts = part.length && part.every((n) => n.type === 'bookmark' && !n.attrs.end)
          && out.slice(b.at, breaks[k + 1]?.at ?? out.length).some((n) => n.type !== 'bookmark');
        if (part.length && !starts) res.push(node(part));
        res.push({ type: b.type });
        if (hint >= b.at) hintAt = res.length;
        if (!starts) from = b.at;
      });
      const rest = out.slice(from);
      if (rest.length || (!breaks.length && (!sect || alone) && !after.kept)) res.push(node(rest));
      if (hint != null && res[hintAt]) hinted.add(res[hintAt]);
      if (field && !startField && !field.block) {
        // A field that runs past its paragraph (a table of contents) holds the blocks up to its end.
        field.block = { code: field.code.trim(), locked: field.locked, dirty: field.dirty, content: [], end: false };
      }
      return { blocks: [...(after.before ?? []), ...res, ...after], sect };
    }

    function table(t) {
      const tp = kid(t, 'w:tblPr');
      const look = kid(tp, 'w:tblLook');
      const lookOf = (k, bit) => (at(look, `w:${k}`) != null ? /^(1|true|on)$/.test(at(look, `w:${k}`)) : look && at(look, 'w:val') ? !!(parseInt(at(look, 'w:val'), 16) & bit) : null);
      const tw = kid(tp, 'w:tblW');
      const grid = kids(kid(t, 'w:tblGrid'), 'w:gridCol').map((g) => num(at(g, 'w:w')));
      // A content control around rows or a cell (a repeating section, a check box filling a cell) holds them in w:sdtContent, at
      // any depth (a repeating section holds an item control per row): rows are read as rows (ponytail: their control is dropped,
      // so a repeating section's rows stay as plain rows), and a cell's innermost control wraps its content as a block control.
      const inSdt = (list, name, sdt) => list.flatMap((n) => (n.name === name ? [{ el: n, sdt }] : n.name === 'w:sdt' ? inSdt(kids(kid(n, 'w:sdtContent')), name, n) : []));
      const rows = inSdt(kids(t), 'w:tr').map((r) => r.el);
      // Each cell's grid column, to count the w:vMerge continuations below a restart.
      const layout = rows.map((tr) => {
        let col = 0;
        return inSdt(kids(tr), 'w:tc').map(({ el: tc, sdt }) => {
          const span = num(v(kid(tc, 'w:tcPr'), 'w:gridSpan')) ?? 1;
          const vm = kid(kid(tc, 'w:tcPr'), 'w:vMerge');
          const cell = { tc, sdt, col, span, merge: vm ? (at(vm, 'w:val') === 'restart' ? 'restart' : 'cont') : null };
          col += span;
          return cell;
        });
      });
      const content = rows.map((tr, r) => {
        const trp = kid(tr, 'w:trPr');
        const h = kid(trp, 'w:trHeight');
        const cells = layout[r].filter((c) => c.merge !== 'cont').map((c) => {
          let rowspan = 1;
          if (c.merge === 'restart') while (layout[r + rowspan]?.some((x) => x.col === c.col && x.merge === 'cont')) rowspan++;
          const tcp = kid(c.tc, 'w:tcPr');
          const tcw = kid(tcp, 'w:tcW');
          const widthTw = at(tcw, 'w:type') === 'dxa' ? num(at(tcw, 'w:w')) : grid.slice(c.col, c.col + c.span).reduce((s, x) => s + (x ?? 0), 0);
          // px to two decimals (15 twips a px), as the app writes them, so a column's twips come back exact.
          const colwidth = widthTw ? Array.from({ length: c.span }, (_, k) => Math.round((grid[c.col + k] ?? widthTw / c.span) / 0.15) / 100) : null;
          const own = blocks(kids(c.tc).filter((k) => k.name !== 'w:tcPr'));
          const body = c.sdt ? [{ type: 'sdtBlock', attrs: { sdt: sdtOf(kid(c.sdt, 'w:sdtPr'), placeholders, kid(c.sdt, 'w:sdtEndPr'), dml.colors) }, content: own.length ? own : [{ type: 'paragraph' }] }] : own;
          return { type: 'tableCell', attrs: clean({ colspan: c.span > 1 ? c.span : null, rowspan: rowspan > 1 ? rowspan : null, colwidth, vAlign: v(tcp, 'w:vAlign'),
            borders: tableEdges(kid(tcp, 'w:tcBorders'), ['top', 'left', 'bottom', 'right', 'tl2br', 'tr2bl']), shading: cellFill(shd(kid(tcp, 'w:shd'))), noWrap: flag(tcp, 'w:noWrap'),
            margins: margins(kid(tcp, 'w:tcMar')), textDir: v(tcp, 'w:textDirection'), fitText: flag(tcp, 'w:tcFitText'), hideMark: flag(tcp, 'w:hideMark') }) ?? {},
          content: body.length ? body : [{ type: 'paragraph' }] };
        });
        // An inserted or deleted row (w:ins, w:del in w:trPr) is the row's rev, as tracking records it.
        const rev = (n) => n && { id: at(n, 'w:id'), author: at(n, 'w:author') ?? 'Unknown', date: at(n, 'w:date') };
        return { type: 'tableRow', attrs: clean({ cantSplit: flag(trp, 'w:cantSplit'), header: flag(trp, 'w:tblHeader'), tblPrEx: tblPrExOf(kid(tr, 'w:tblPrEx')),
          height: h ? { value: pt(at(h, 'w:val')), rule: at(h, 'w:hRule') === 'exact' ? 'exact' : at(h, 'w:hRule') === 'auto' ? 'auto' : 'atLeast' } : null,
          rev: clean({ ins: rev(kid(trp, 'w:ins')), del: rev(kid(trp, 'w:del')) }) }) ?? {}, content: cells };
      }).filter((r) => r.content.length);
      if (!content.length) return [];
      const jc = v(tp, 'w:jc');
      // A floating table (w:tblpPr): its anchors, position and distance from text, as export writes them.
      const fp = kid(tp, 'w:tblpPr');
      const float = fp && (clean({ hAnchor: at(fp, 'w:horzAnchor'), vAnchor: at(fp, 'w:vertAnchor'), x: pt(at(fp, 'w:tblpX')), y: pt(at(fp, 'w:tblpY')), xAlign: at(fp, 'w:tblpXSpec'),
        yAlign: at(fp, 'w:tblpYSpec'), dist: clean({ t: pt(at(fp, 'w:topFromText')), r: pt(at(fp, 'w:rightFromText')), b: pt(at(fp, 'w:bottomFromText')), l: pt(at(fp, 'w:leftFromText')) }),
        overlap: v(tp, 'w:tblOverlap') === 'never' ? false : null }) ?? { x: 0 });
      return [{ type: 'table', attrs: clean({ styleId: sid(v(tp, 'w:tblStyle')) ?? 'TableNormal', align: jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : null,
        width: tblWidth(tw),
        layout: at(kid(tp, 'w:tblLayout'), 'w:type') === 'fixed' ? 'fixed' : null, indent: pt(at(kid(tp, 'w:tblInd'), 'w:w')) || null,
        borders: tableEdges(kid(tp, 'w:tblBorders'), ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']), cellMargin: margins(kid(tp, 'w:tblCellMar')), float,
        cellSpacing: pt(at(kid(tp, 'w:tblCellSpacing'), 'w:w')) || null, caption: v(tp, 'w:tblCaption'), description: v(tp, 'w:tblDescription'), bidiVisual: flag(tp, 'w:bidiVisual'),
        look: look ? { firstRow: !!lookOf('firstRow', 0x20), lastRow: !!lookOf('lastRow', 0x40), firstColumn: !!lookOf('firstColumn', 0x80), lastColumn: !!lookOf('lastColumn', 0x100),
          noHBand: !!lookOf('noHBand', 0x200), noVBand: !!lookOf('noVBand', 0x400) } : null }) ?? {}, content }];
    }

    /** A list of body-level elements → blocks; a section's w:sectPr becomes a sectionBreak holding it (the caller sets its kind). */
    function blocks(list) {
      const out = [];
      const sink = () => (field?.block && !field.block.end ? field.block.content : out);
      for (const n of list) {
        if (typeof n === 'string') continue;
        if (n.name === 'w:p') {
          // A field that spans paragraphs takes every block from the one it starts in to the one it ends in.
          const open = field?.block ?? null;
          const { blocks: bs, sect } = paragraph(n, list === top && (!out.length || out.at(-1).type === 'sectionBreak'));
          const blk = open ?? field?.block ?? null;
          if (blk) {
            blk.content.push(...bs);
            if (blk.end) out.push({ type: 'fieldBlock', attrs: { code: blk.code, locked: blk.locked, dirty: blk.dirty }, content: blk.content.length ? blk.content : [{ type: 'paragraph' }] });
          } else out.push(...bs);
          if (sect) {
            out.push({ type: 'sectionBreak', attrs: { kind: 'nextPage', sect: sectOf(sect) }, sectEl: sect });
            page = pageBox(sectEls[sectEls.indexOf(sect) + 1] ?? sect);
          }
        } else if (n.name === 'w:tbl') sink().push(...table(n));
        // Word's watermark gallery wraps a watermark in a Watermarks building block, which goes with it.
        else if (n.name === 'w:sdt' && header && v(kid(kid(n, 'w:sdtPr'), 'w:docPartObj'), 'w:docPartGallery') === 'Watermarks') sink().push(...blocks(kids(kid(n, 'w:sdtContent'))));
        else if (n.name === 'w:sdt') {
          const content = blocks(kids(kid(n, 'w:sdtContent')));
          sink().push({ type: 'sdtBlock', attrs: { sdt: sdtOf(kid(n, 'w:sdtPr'), placeholders, kid(n, 'w:sdtEndPr'), dml.colors) }, content: content.length ? content : [{ type: 'paragraph' }] });
        } else if (n.name === 'w:customXml' || n.name === 'w:smartTag') sink().push(...blocks(kids(n)));
        else if (n.name === 'w:sectPr') out.push({ type: 'sectionBreak', final: true, attrs: { kind: 'nextPage', sect: sectOf(n) }, sectEl: n });
      }
      if (field?.block && !field.block.end && list === top) {
        out.push({ type: 'fieldBlock', attrs: { code: field.block.code }, content: field.block.content });
        field = null;
      }
      return out;
    }
    let top = null;
    return {
      body(list) { top = list; return blocks(list); },
      blocks: (list) => blocks(list),
      get watermark() { return watermark; },
      /** A footnote or endnote element → its blocks, without the reference mark at its start. */
      note: (el) => {
        const bs = blocks(kids(el));
        const first = bs[0]?.content;
        if (first?.[0]?.type === 'text') first[0].text = first[0].text.replace(/^\s/, '');
        if (first?.[0]?.type === 'text' && !first[0].text) first.shift();
        return bs.length ? bs.map((b) => (b.type === 'paragraph' && b.attrs?.styleId && /^(Foot|End)noteText$/.test(b.attrs.styleId) ? { ...b, attrs: { ...b.attrs, styleId: null } } : b)) : [{ type: 'paragraph' }];
      },
    };
  }
  const bookmarks = new Set();
  const styleName = (id) => attrs.styles.list[id]?.name ?? null;
  function readComment(id) {
    const key = `c${id}`;
    if (comments[key] || !commentEls.has(id)) return;
    const c = commentEls.get(id);
    const para = at(kids(c, 'w:p').at(-1), 'w14:paraId');
    const ex = commentEx.get(para);
    const parent = commentByPara.get(at(ex, 'w15:paraIdParent'));
    const durableId = durable.get(para) ?? null;
    comments[key] = { author: at(c, 'w:author') ?? 'Unknown', initials: at(c, 'w:initials') ?? '', date: at(c, 'w:date') ?? null,
      done: /^(1|true|on)$/.test(at(ex, 'w15:done') ?? ''), parent: parent != null ? `c${parent}` : null, content: [],
      ...(durableId && { durableId, dateUtc: utc.get(durableId) ?? null }) };
    comments[key].content = reader('word/comments.xml').blocks(kids(c));
  }
  /** w:sectPr → the model's sect. Headers and footers read their parts. */
  /** A w:sectPr's page: {w, h, margin} in pt. A file that gives no page size (pandoc writes none) gets Word's own, Letter, not the
   * app's default page: Word lays such a file out on 8.5 x 11 in with 1 in margins. */
  function pageBox(s) {
    const sz = kid(s, 'w:pgSz');
    const mar = kid(s, 'w:pgMar');
    return { w: pt(at(sz, 'w:w')) ?? 612, h: pt(at(sz, 'w:h')) ?? 792,
      margin: { top: pt(at(mar, 'w:top')) ?? 72, right: pt(at(mar, 'w:right')) ?? 72, bottom: pt(at(mar, 'w:bottom')) ?? 72, left: pt(at(mar, 'w:left')) ?? 72,
        header: pt(at(mar, 'w:header')) ?? 35.4, footer: pt(at(mar, 'w:footer')) ?? 35.4, gutter: pt(at(mar, 'w:gutter')) ?? 0 } };
  }
  const wmOf = { default: null, first: null, even: null }; // the watermark of each kind of header in force, as sections link them
  function sectOf(s) {
    const sz = kid(s, 'w:pgSz');
    const pg = kid(s, 'w:pgNumType');
    const ln = kid(s, 'w:lnNumType');
    const pb = kid(s, 'w:pgBorders');
    const cols = kid(s, 'w:cols');
    const grid = kid(s, 'w:docGrid');
    const sect = {
      ...structuredClone(attrs.sect), type: v(s, 'w:type') ?? 'nextPage', ...pageBox(s), orient: at(sz, 'w:orient') === 'landscape' ? 'landscape' : 'portrait',
      pgNum: { fmt: at(pg, 'w:fmt') ?? 'decimal', start: num(at(pg, 'w:start')), chapStyle: num(at(pg, 'w:chapStyle')), chapSep: at(pg, 'w:chapSep') ?? 'hyphen' },
      titlePg: !!flag(s, 'w:titlePg'), vAlign: v(s, 'w:vAlign') ?? 'top', textDir: v(s, 'w:textDirection') ?? 'lrTb', bidi: !!flag(s, 'w:bidi'), formProt: !!flag(s, 'w:formProt'),
      noEndnote: !!flag(s, 'w:noEndnote'), lnNum: ln ? clean({ countBy: num(at(ln, 'w:countBy')), start: num(at(ln, 'w:start')), distance: pt(at(ln, 'w:distance')), restart: at(ln, 'w:restart') }) : null,
      // An art border's w:sz is in points, not the eighths edge() reads (ECMA-376 §17.3.4); Word offers art borders for pages only.
      pgBorders: pb ? { offsetFrom: at(pb, 'w:offsetFrom') ?? 'text', display: at(pb, 'w:display') ?? 'allPages', zOrder: at(pb, 'w:zOrder') ?? 'front',
        ...Object.fromEntries(Object.entries(edges(pb, ['top', 'left', 'bottom', 'right']) ?? {}).map(([k, e]) => [k, isArt(e) ? { ...e, width: e.width * 8 } : e])) } : null,
      // A grid without w:type (no grid) keeps its pitch, which Page Setup shows.
      docGrid: grid ? clean({ type: at(grid, 'w:type'), linePitch: pt(at(grid, 'w:linePitch')), charSpace: num(at(grid, 'w:charSpace')) }) : null,
      // Note properties; Word 2019's footnote columns are w15:footnoteColumns in the section.
      footnotePr: clean({ ...notePr(kid(s, 'w:footnotePr')), columns: num(v(s, 'w15:footnoteColumns')) }), endnotePr: notePr(kid(s, 'w:endnotePr')),
      // w:sep (Line between) is an attribute of w:cols.
      hdr: null, ftr: null, cols: cols && num(at(cols, 'w:num')) > 1 ? { count: num(at(cols, 'w:num')), space: pt(at(cols, 'w:space')) ?? 36, sep: /^(1|true|on)$/.test(at(cols, 'w:sep') ?? ''),
        equal: at(cols, 'w:equalWidth') !== '0', widths: kids(cols, 'w:col').length ? kids(cols, 'w:col').map((c) => ({ w: pt(at(c, 'w:w')), space: pt(at(c, 'w:space')) ?? 0 })) : null } : null,
      // One column keeps Word's spacing (its 708 twips default), the gap a later change to more columns starts from.
      ...(cols && !(num(at(cols, 'w:num')) > 1) && at(cols, 'w:space') != null && { colSpace: pt(at(cols, 'w:space')) }),
    };
    const docRels = relsOf('word/document.xml');
    for (const [tag, key] of [['header', 'hdr'], ['footer', 'ftr']]) {
      for (const ref of kids(s, `w:${tag}Reference`)) {
        const r = docRels.get(at(ref, 'r:id'));
        if (!r) continue;
        const path = resolve('word/document.xml', r.target);
        const x = xmlOf(path);
        if (!x) continue;
        const held = page; // a header's drawings size from the page of the section that holds it
        page = pageBox(s);
        const part = reader(path);
        const content = part.blocks(kids(x));
        page = held;
        if (tag === 'header') wmOf[at(ref, 'w:type') ?? 'default'] = part.watermark;
        sect[key] = { ...(sect[key] ?? { default: null, first: null, even: null }), [at(ref, 'w:type') ?? 'default']: content.length ? content : [{ type: 'paragraph' }] };
      }
    }
    // The watermark of the headers the section shows: its own, or through a linked header the one before it.
    const wm = wmOf.default ?? (sect.titlePg ? wmOf.first : null) ?? (attrs.settings?.evenAndOddHeaders ? wmOf.even : null);
    if (wm) sect.watermark = wm;
    return sect;
  }

  // The document's own building blocks (word/glossary/document.xml), kept for export; a content control shows the text of the
  // placeholder docPart it names.
  const placeholders = new Map();
  // The page each drawing sizes from (relSizeOf): the body's sections in order, from the first.
  const docXml = selectAlternates(parseXml(docXmlText));
  const body = kid(docXml, 'w:body');
  // Page colour (w:background) with its theme colour, and Word's fill effects (its v:background).
  const bg = kid(docXml, 'w:background');
  const docRels = relsOf('word/document.xml');
  const fill = kid(bg, 'v:background') && pageFillOf(kid(bg, 'v:background'), (rid) => {
    const r = docRels.get(rid);
    const path = r && resolve('word/document.xml', r.target);
    const bytes = path && files.get(path);
    return bytes ? { bytes, src: `data:${MIME[path.split('.').pop().toLowerCase()] ?? 'image/png'};base64,${base64(bytes)}` } : null;
  });
  if (hexOf(at(bg, 'w:color')) || fill) {
    const [tc, tint, shade] = ['w:themeColor', 'w:themeTint', 'w:themeShade'].map((k) => at(bg, k));
    const lum = shade ? -(1 - parseInt(shade, 16) / 255) : tint ? 1 - parseInt(tint, 16) / 255 : 0;
    attrs.background = { color: hexOf(at(bg, 'w:color')), themeColor: tc ? { slot: SLOT[tc] ?? tc, lum: Math.round(lum * 100) / 100 } : null, fill: fill ?? null };
  }
  const sectEls = deep(body, 'w:sectPr');
  let page = pageBox(sectEls[0] ?? null);
  const glossary = xmlOf('word/glossary/document.xml');
  if (glossary) {
    const g = reader('word/glossary/document.xml');
    const textIn = (n) => n.text ?? (n.content ?? []).map(textIn).join('');
    attrs.settings.glossary = deep(glossary, 'w:docPart').map((d) => {
      const pr = kid(d, 'w:docPartPr');
      const cat = kid(pr, 'w:category');
      const content = g.blocks(kids(kid(d, 'w:docPartBody')));
      const part = clean({ name: v(pr, 'w:name'), gallery: v(cat, 'w:gallery'), category: v(cat, 'w:name'), description: v(pr, 'w:description'),
        behaviors: kids(kid(pr, 'w:behaviors'), 'w:behavior').map((b) => at(b, 'w:val')), types: kids(kid(pr, 'w:types'), 'w:type').map((t) => at(t, 'w:val')),
        guid: v(pr, 'w:guid'), content: content.length ? content : [{ type: 'paragraph' }] });
      if (part.gallery === 'placeholder') placeholders.set(part.name, part.content.map(textIn).join(' '));
      return part;
    });
  }

  const main = reader('word/document.xml');
  const raw = main.body(kids(body));

  // Sections: each break holds the section it ends, and takes its kind from how the next section starts. A section of more than
  // one column becomes a columns node, and a continuous break around it goes, as export.mjs writes it.
  const out = [];
  let final = null;
  const sections = [];
  let cur = [];
  for (const b of raw) {
    if (b.type === 'sectionBreak') { sections.push({ blocks: cur, sect: b.attrs.sect, final: !!b.final }); cur = []; if (b.final) final = b.attrs.sect; } else cur.push(b);
  }
  if (cur.length) sections.push({ blocks: cur, sect: final ?? attrs.sect, final: true });
  if (!sections.some((s) => s.final)) sections.push({ blocks: [], sect: attrs.sect, final: true });
  // A section whose break goes passes its headers and footers on: the next section's parts that link to the previous one (null,
  // ECMA-376 §17.10.5) take them, or a header that only the first section holds is lost with its break.
  const link = (own, prev) => (!prev ? own : !own ? prev : Object.fromEntries(['default', 'first', 'even'].map((k) => [k, own[k] ?? prev[k] ?? null])));
  let carry = null;
  sections.forEach((s, i) => {
    const next = sections[i + 1];
    const { cols, ...sect } = s.sect;
    if (carry) Object.assign(sect, { hdr: link(sect.hdr, carry.hdr), ftr: link(sect.ftr, carry.ftr) });
    const kept = s.final || (cols ? next?.sect?.type !== 'continuous' : !(next?.sect?.cols && next.sect.type === 'continuous'));
    carry = kept ? null : { hdr: sect.hdr, ftr: sect.ftr };
    if (cols) {
      out.push({ type: 'columns', attrs: { count: cols.count, space: cols.space, sep: cols.sep, equal: cols.equal, widths: cols.equal ? null : cols.widths }, content: s.blocks.length ? s.blocks : [{ type: 'paragraph' }] });
    } else out.push(...s.blocks);
    // The section break around a columns run goes when both sides start continuous.
    if (s.final) attrs.sect = sect;
    else if (kept) out.push({ type: 'sectionBreak', attrs: { kind: next.sect.type ?? 'nextPage', sect } });
  });
  if (Object.keys(comments).length) attrs.comments = { ...(attrs.comments ?? {}), ...comments };
  // people.xml: each author's sign-in (w15:presenceInfo), which Word shows beside their comments and changes.
  const people = kids(partOf('people'), 'w15:person').map((e) => {
    const pi = kid(e, 'w15:presenceInfo');
    return { name: at(e, 'w15:author'), initials: Object.values(comments).find((c) => c.author === at(e, 'w15:author'))?.initials ?? '',
      ...(pi && { presence: { providerId: at(pi, 'w15:providerId'), userId: at(pi, 'w15:userId') } }) };
  }).filter((p) => p.name);
  if (people.length) attrs.people = people;
  const ids = new Set(linked.map((n) => n.attrs.id));
  for (const n of linked) if (!ids.has(n.attrs.link)) n.attrs.link = null;
  const content = out.length ? out : [{ type: 'paragraph' }];
  // Word's page hints as the top-level blocks they fall in (a page can start inside a table or a columns node): only a guess, since
  // Word may have saved before its layout finished. The layout cache uses them until the predictor's first layout.
  if (hinted.size) {
    const holds = (n) => hinted.has(n) || (n.content ?? []).some(holds);
    const breaksAt = content.flatMap((n, i) => (holds(n) ? [i] : []));
    if (breaksAt.length) attrs.props = { ...(attrs.props ?? {}), breaks: breaksAt };
  }
  const doc = { type: 'doc', attrs, content };
  await showMetafiles(doc, metafiles);
  // The model is complete: each kept piece of styles and numbering is signed with the model value it stands for, which export.mjs
  // compares before writing it back. A style the model does not hold (the reference styles the app defines) signs as null.
  if (beside.styles) {
    attrs.styles.kept = { ...beside.styles, defaults: beside.styles.defaults && { xml: beside.styles.defaults, sig: sig(attrs.styles.defaults) },
      styles: Object.fromEntries(Object.entries(beside.styles.styles).map(([id, xml]) => [id, { xml, sig: attrs.styles.list[id] ? sig(attrs.styles.list[id]) : null }])) };
  }
  if (beside.numbering) {
    const { abstract, nums } = attrs.numbering;
    attrs.numbering.kept = { ...beside.numbering, nums: Object.fromEntries(Object.entries(beside.numbering.nums).map(([id, n]) => [id, { ...n, sig: sig(nums[id]) }])),
      abstract: Object.fromEntries(Object.entries(beside.numbering.abstract).map(([id, a]) => [id, { ...a, lvls: a.lvls.map((xml, i) => ({ xml, sig: sig(abstract[id]?.levels?.[i]) })) }])) };
  }
  return { doc, title, dropped: [...dropped] };
}

// ---------- page fill effects ----------
/** A GIF's first image → '1' for each light pixel and '0' for each dark one, row by row, or null. */
function gifBits(b) {
  if (b?.[0] !== 0x47 || b[1] !== 0x49) return null;
  const table = (f) => (f & 0x80 ? 3 << ((f & 7) + 1) : 0);
  let pal = b.subarray(13, 13 + table(b[10]));
  let i = 13 + pal.length;
  while (b[i] === 0x21) for (i += 2; b[i++];) i += b[i - 1];
  if (b[i] !== 0x2c) return null;
  if (b[i + 9] & 0x80) pal = b.subarray(i + 10, i + 10 + table(b[i + 9]));
  i += 10 + table(b[i + 9]);
  const min = b[i++];
  const data = [];
  for (; b[i]; i += b[i] + 1) data.push(...b.subarray(i + 1, i + 1 + b[i]));
  // LZW: codes of `size` bits, least significant first; the dictionary starts over at each clear code.
  const clear = 1 << min;
  let dict;
  let size;
  let prev;
  const reset = () => { dict = Array.from({ length: clear + 2 }, (_, k) => [k]); size = min + 1; prev = null; };
  reset();
  const out = [];
  for (let bit = 0; bit + size <= data.length * 8;) {
    let code = 0;
    for (let k = 0; k < size; k++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << k;
    if (code === clear) { reset(); continue; }
    if (code === clear + 1) break;
    const e = dict[code] ?? (prev && [...prev, prev[0]]);
    if (!e) return null;
    out.push(...e);
    if (prev) dict.push([...prev, e[0]]);
    prev = e;
    if (dict.length === 1 << size && size < 12) size++;
  }
  return out.map((p) => (pal[p * 3] + pal[p * 3 + 1] + pal[p * 3 + 2] > 382 ? '1' : '0')).join('');
}

const LINEAR = { 0: 'horizontal', 270: 'vertical', 225: 'diagonalUp', 315: 'diagonalDown' };
const flat = (s) => (s ?? '').toLowerCase().replace(/\s/g, '');

/**
 * A page's v:background → its background.fill (page-background/model.mjs), or null for a plain colour. `image(rid)` → {bytes, src}.
 * The v:fill type picks the Fill Effects tab: gradient and gradientRadial, pattern, tile (a texture) and frame (a picture).
 * Gradient: the angle picks the shading style (the opposite angle runs the colours the other way), the focus the variant
 * (FOCUS); radial: focusposition in the middle is From center (variant by focus), else From corner (variant by corner).
 * Colours: fillcolor and color2; 'fill darken(n)' or 'fill lighten(n)' is one colour (n of 255 toward black or white); a list
 * of more colours is one of our presets when it is one, else its first and last colour. Pattern: Word's tile (WORD_PATTERNS)
 * nearest its tile's light pixels (which take fillcolor; the dark ones take color2), or by o:title when the tile is no GIF.
 */
function pageFillOf(bg, image) {
  const f = kid(bg, 'v:fill');
  const type = at(f, 'type');
  const c1 = `#${vmlColor(at(bg, 'fillcolor')) ?? 'FFFFFF'}`;
  const c2 = `#${vmlColor(at(f, 'color2')) ?? 'FFFFFF'}`;
  const pic = image(at(f, 'r:id') ?? at(f, 'o:relid'));
  if (type === 'gradient' || type === 'gradientRadial') {
    const stops = (at(f, 'colors') ?? '').split(';').map((s) => vmlColor(s.trim().split(/\s+/)[1])).filter(Boolean).map((c) => `#${c}`);
    const preset = GRADIENT_PRESETS.find(([, , p]) => p.join() === stops.join());
    const one = /^\s*fill\b(?:\s*(darken|lighten)\((\d+)\))?/i.exec(at(f, 'color2') ?? '');
    const colors = preset ? { colors: 'preset', preset: preset[0] } : stops.length > 1 ? { colors: 'two', color1: stops[0], color2: stops.at(-1) }
      : one ? { colors: 'one', color1: c1, shade: Math.round((!one[1] ? 0.5 : /darken/i.test(one[1]) ? +one[2] / 510 : 1 - +one[2] / 510) * 100) / 100 } : { colors: 'two', color1: c1, color2: c2 };
    const focus = parseFloat(at(f, 'focus')) || 0;
    if (type === 'gradientRadial') {
      const [x = 0, y = 0] = (at(f, 'focusposition') ?? '').split(',').map((n) => parseFloat(n) || 0);
      const center = x > 0.25 && x < 0.75 && y > 0.25 && y < 0.75;
      return { kind: 'gradient', ...colors, style: center ? 'fromCenter' : 'fromCorner', variant: center ? (focus >= 50 ? 0 : 1) : (x > 0.5 ? 1 : 0) + (y > 0.5 ? 2 : 0) };
    }
    const a = (((Math.round((parseFloat(at(f, 'angle')) || 0) / 45) * 45) % 360) + 360) % 360;
    const style = LINEAR[a] ?? LINEAR[(a + 180) % 360];
    const want = LINEAR[a] ? focus : focus >= 0 ? 100 - focus : -100 - focus;
    return { kind: 'gradient', ...colors, style, variant: FOCUS.reduce((b, x, i) => (Math.abs(x - want) < Math.abs(FOCUS[b] - want) ? i : b), 0) };
  }
  const title = flat(at(f, 'o:title'));
  if (type === 'pattern') {
    const bits = gifBits(pic?.bytes);
    const off = (hex) => [...hex].reduce((n, h, i) => n + [...(parseInt(h, 16) | 16).toString(2).slice(1)].filter((b, k) => b !== bits[i * 4 + k]).length, 0);
    const pattern = bits?.length === 64 ? Object.keys(WORD_PATTERNS).reduce((b, id) => (off(WORD_PATTERNS[id]) < off(WORD_PATTERNS[b]) ? id : b))
      : PATTERNS.find(([, l]) => flat(l) === title)?.[0] ?? PATTERNS[0][0];
    return { kind: 'pattern', pattern, fg: c1, bg: c2 };
  }
  if (type === 'tile' && (pic || TEXTURES.some(([, l]) => flat(l) === title))) return { kind: 'texture', texture: TEXTURES.find(([, l]) => flat(l) === title)?.[0] ?? null, src: pic?.src ?? null };
  if (type === 'frame' && pic) return { kind: 'picture', src: pic.src, lockAspect: /^at(least|most)$/i.test(at(f, 'aspect') ?? '') };
  return null;
}

// ---------- EMF and WMF ----------
/** Every EMF and WMF picture of `doc` that picture() read keeps that file (export writes it back) and shows what
 * src/tooling/metafile.mjs drew of it: the SVG of WordCraft's metafile reader at its size, else for the ones the reader cannot
 * draw (EMF+ only, unreadable) `convert`'s PNG ([{data (base64), w, h}] → [PNG data URL | null], api.word.metafiles: GDI+ on the
 * desktop, absent in the web app), else a placeholder of its size. A picture keeps it in `metafile`, and its orig is its size, so
 * Reset Picture & Size does not take the drawing's doubled natural size. A canvas's picture (shapes-in.mjs) keeps it in `metafile`.
 * A picture bullet's level keeps it with the drawing it shows ({src, pic}), so export writes it only while the level still
 * shows that picture: the list tools carry a level's other keys when they give it another picture. */
async function showMetafiles(doc, convert) {
  const found = []; // {src, w, h, label, set(shown)}
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      const a = o.attrs;
      if (o.type === 'image' && METAFILE.test(a?.src ?? '')) {
        found.push({ src: a.src, w: a.width, h: a.height, label: a.alt,
          set: (src) => Object.assign(a, { metafile: a.src, src }, a.width != null && a.height != null && { orig: { w: a.width, h: a.height } }) });
      } else if (o.type === 'image' && METAFILE.test(o.src ?? '')) found.push({ src: o.src, w: o.w, h: o.h, set: (src) => Object.assign(o, { metafile: o.src, src }) });
      else if (o.fmt === 'bullet' && METAFILE.test(o.pic ?? '')) found.push({ src: o.pic, w: 0, h: 0, set: (pic) => Object.assign(o, { metafile: { src: o.pic, pic }, pic }) });
      else Object.values(o).forEach(walk);
    }
  };
  walk(doc);
  if (!found.length) return;
  const shown = await drawMetafiles(found.map((f) => ({ data: f.src.slice(f.src.indexOf(',') + 1), w: f.w ?? 0, h: f.h ?? 0,
    label: f.label || `Picture (${METAFILE.exec(f.src)[1].toUpperCase()})` })), convert);
  found.forEach((f, i) => f.set(shown[i]));
}

// Style objects keep the first schema's names (bold, italic, underline, charSpacing; para align and border), as defaults.mjs has them.
function styleRun(p) {
  const { b, i, u, spacing, ...rest } = p;
  return { ...rest, ...(b != null && { bold: b }), ...(i != null && { italic: i }), ...(u && { underline: u.val }), ...(spacing != null && { charSpacing: spacing }) };
}
function styleParaOf(p) {
  const { textAlign, borders, ...rest } = p;
  return { ...rest, ...(textAlign && { align: textAlign }), ...(borders && { border: borders }) };
}
// A table style's nil or none edges stay (as Table Design's styles hold them): they take away a border the table's own edges draw.
const styleEdges = (n) => (!n ? null : clean(Object.fromEntries(['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((k) => {
  const e = kid(n, `w:${k}`);
  return [k, /^(nil|none)$/.test(at(e, 'w:val') ?? '') ? { style: at(e, 'w:val') } : edge(e)];
}))));
function margins(n) {
  if (!n) return null;
  return clean(Object.fromEntries(['top', 'left', 'bottom', 'right'].map((k) => [k, pt(at(kid(n, `w:${k}`) ?? kid(n, `w:${k === 'left' ? 'start' : k === 'right' ? 'end' : k}`), 'w:w'))])));
}
/** Whether border edge `e` is an art border (a style beyond BORDER_STYLES' lines) with a width. */
const isArt = (e) => e?.width != null && !BORDER_STYLES.includes(e.style ?? 'single');
/** A w:tblW → the table's width {w, type: 'pct' (percent) or 'dxa' (pt)}, or null for auto. */
const tblWidth = (tw) => (at(tw, 'w:type') === 'pct' ? { w: num(String(at(tw, 'w:w')).replace('%', '')) / (String(at(tw, 'w:w')).includes('%') ? 1 : 50), type: 'pct' }
  : at(tw, 'w:type') === 'dxa' && num(at(tw, 'w:w')) ? { w: pt(at(tw, 'w:w')), type: 'dxa' } : null);
const TBL_JC = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right' };
/** A row's table property exceptions (w:tblPrEx: what this row has apart from its table, such as its own cell margins) → the
 * row's tblPrEx, or null. */
const tblPrExOf = (x) => (!x ? null : clean({ width: tblWidth(kid(x, 'w:tblW')), align: TBL_JC[v(x, 'w:jc')] ?? null, cellSpacing: pt(at(kid(x, 'w:tblCellSpacing'), 'w:w')),
  indent: pt(at(kid(x, 'w:tblInd'), 'w:w')), borders: tableEdges(kid(x, 'w:tblBorders'), ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']),
  layout: at(kid(x, 'w:tblLayout'), 'w:type'), cellMargin: margins(kid(x, 'w:tblCellMar')) }));
/** w:footnotePr or w:endnotePr (in a section or the settings) → the notes package's {pos, numFmt, numStart, numRestart}, or null. */
const notePr = (n) => (n ? clean({ pos: v(n, 'w:pos'), numFmt: v(n, 'w:numFmt'), numStart: num(v(n, 'w:numStart')), numRestart: v(n, 'w:numRestart') }) : null);
/** A table's or cell's borders: an edge set to none or nil stays ({style}), since it takes away the table style's edge. */
function tableEdges(n, names) {
  return !n ? null : clean(Object.fromEntries(names.map((k) => {
    const e = kid(n, `w:${k}`);
    return [k, /^(nil|none)$/.test(at(e, 'w:val') ?? '') ? { style: at(e, 'w:val') } : edge(e)];
  })));
}
/**
 * The relative size of drawing `box` (wp14:sizeRelH and wp14:sizeRelV: pctWidth and pctHeight in thousandths of a percent of the
 * area relativeFrom names) on page `pg` ({w, h, margin} pt; the gutter widens the left margin, or the top with `gutterAtTop`) →
 * {cx, cy} in EMU where it has one, and `keep` ({h, v}: {from, pct, emu}) for the layout, so export writes it back. Word sizes
 * only floating drawings so, from the page even in a table cell, and ignores both on an inline one (checked in Word 2026-10-29);
 * a VML horizontal line (o:hr, vml.mjs) is sized so inline.
 */
function relSizeOf(box, pg, gutterAtTop) {
  const out = { cx: null, cy: null, keep: null };
  if (!pg || (box.name !== 'wp:anchor' && !at(box, 'o:hr'))) return out;
  const m = pg.margin;
  const [gl, gt] = gutterAtTop ? [0, m.gutter ?? 0] : [m.gutter ?? 0, 0];
  const area = {
    h: { page: pg.w, margin: pg.w - m.left - m.right - gl, leftMargin: m.left + gl, rightMargin: m.right, insideMargin: m.left + gl, outsideMargin: m.right },
    v: { page: pg.h, margin: pg.h - m.top - m.bottom - gt, topMargin: m.top + gt, bottomMargin: m.bottom, insideMargin: m.top + gt, outsideMargin: m.bottom },
  };
  const ext = kid(box, 'wp:extent');
  for (const [axis, tag, pctTag, key] of [['h', 'wp14:sizeRelH', 'wp14:pctWidth', 'cx'], ['v', 'wp14:sizeRelV', 'wp14:pctHeight', 'cy']]) {
    const e = kid(box, tag);
    const pct = num(textOf(kid(e, pctTag)));
    const from = at(e, 'relativeFrom') ?? 'margin';
    if (!pct || area[axis][from] == null) continue;
    const emu = Math.round((area[axis][from] * 12700 * pct) / 100000);
    // A relative size larger than the page draws at the drawing's own size (Word's PDF of the Word fixture: width and height
    // 1000 % of margin both draw 160 x 100 pt). It still goes back to the file as it came.
    const own = num(at(ext, key));
    const fits = emu <= (axis === 'h' ? pg.w : pg.h) * 12700 || own == null;
    if (fits) out[key] = emu;
    (out.keep ??= {})[axis] = { from, pct, emu: fits ? emu : own };
  }
  return out;
}
/** Whether wp:docPr `pr` marks its drawing decorative (Word's adec:decorative in its a:extLst). */
const decorative = (pr) => at(deep(pr, 'adec:decorative')[0], 'val') === '1';
/** The float layout of a wp:anchor. */
function anchorLayout(a) {
  const pos = (axis) => {
    const p = kid(a, `wp:position${axis}`);
    const align = textOf(kid(p, 'wp:align'));
    const off = kid(p, 'wp:posOffset');
    // A relative position (Word's Layout dialog, Relative position: thousandths of a percent of the area relativeFrom names).
    const pct = kid(p, `wp14:pctPos${axis}Offset`);
    return clean({ rel: at(p, 'relativeFrom'), align: align || null, offset: off ? Math.round((num(textOf(off)) / 12700) * 100) / 100 : null,
      pct: pct && !align ? num(textOf(pct)) / 1000 : null });
  };
  const wrap = kid(a, 'wp:wrapSquare') ? 'square' : kid(a, 'wp:wrapTight') ? 'tight' : kid(a, 'wp:wrapThrough') ? 'through' : kid(a, 'wp:wrapTopAndBottom') ? 'topBottom'
    : at(a, 'behindDoc') === '1' ? 'behind' : 'front';
  const side = at(kid(a, 'wp:wrapSquare') ?? kid(a, 'wp:wrapTight') ?? kid(a, 'wp:wrapThrough'), 'wrapText');
  const emu = (k) => Math.round((num(at(a, k)) ?? 0) / 12700 * 100) / 100;
  // Tight and Through wrap round Word's polygon: fractions of the box (21600 a side; six places come back to the unit), without the
  // closing point, which export adds again; edited is whether the user moved its points (Edit Wrap Points).
  const wp = kid(kid(a, 'wp:wrapTight') ?? kid(a, 'wp:wrapThrough'), 'wp:wrapPolygon');
  const poly = [kid(wp, 'wp:start'), ...kids(wp, 'wp:lineTo')].filter(Boolean).map((q) => ['x', 'y'].map((k) => Math.round(((num(at(q, k)) ?? 0) / 21600) * 1e6) / 1e6));
  if (poly.length > 1 && poly[0].join() === poly.at(-1).join()) poly.pop();
  return clean({ wrap, side: side === 'bothSides' ? 'both' : side, h: pos('H'), v: pos('V'), dist: { t: emu('distT'), r: emu('distR'), b: emu('distB'), l: emu('distL') },
    z: num(at(a, 'relativeHeight')) != null ? Math.max(0, num(at(a, 'relativeHeight')) - 251658240) : null, allowOverlap: at(a, 'allowOverlap') !== '0', lockAnchor: at(a, 'locked') === '1',
    poly: poly.length >= 3 ? poly : null, polyEdited: (poly.length >= 3 && at(wp, 'edited') === '1') || null,
    // behindDoc beside another wrap: Word keeps it from an earlier Behind Text, and it decides which side of the text the drawing is drawn.
    behindDoc: (wrap !== 'behind' && at(a, 'behindDoc') === '1') || null });
}
const emuPt = (emu) => Math.round((num(emu) / 12700) * 100) / 100;
const VERT = { vert: 'tbRl', eaVert: 'tbRl', mongolianVert: 'tbRl', vert270: 'btLr', wordArtVert: 'stacked', wordArtVertRtl: 'stacked' };
/** A wps:wsp text box's look → textBox attrs: fill, line, effects and what export writes back of them (dml.mjs boxLook, with
 * `picture(rid)` for a texture's or a picture fill's picture), and from wps:bodyPr the internal margins, Align Text, text
 * direction, Resize shape to fit text (a:spAutoFit), Wrap text in shape, Do not rotate text and vertOverflow (overflow shows text
 * past the box; clip and ellipsis clip it). */
function boxLook(box, dml, picture) {
  const sp = deep(box, 'wps:spPr')[0];
  const body = deep(box, 'wps:bodyPr')[0];
  const ins = (k, d) => emuPt(at(body, k) ?? d);
  const rot = num(at(kid(sp, 'a:xfrm'), 'rot'));
  return {
    ...textBoxLook(sp, deep(box, 'wps:style')[0], dml, picture),
    inset: { t: ins('tIns', 45720), r: ins('rIns', 91440), b: ins('bIns', 45720), l: ins('lIns', 91440) },
    vAlign: { ctr: 'center', b: 'bottom' }[at(body, 'anchor')] ?? 'top', dir: VERT[at(body, 'vert')] ?? 'lrTb', autoFit: !!kid(body, 'a:spAutoFit'),
    noWrap: at(body, 'wrap') === 'none', upright: at(body, 'upright') === '1', rotate: rot ? rot / 60000 : 0, overflow: at(body, 'vertOverflow'),
  };
}
/** A text box's place in a linked story (Create Link) → its id and link, or null: Word names the story on its first box (wps:txbx
 * id) and on each box after it with its place (wps:linkedTxbx id and seq), so each box gets an id from the story's and links to
 * the next one, each starting with `tag`. importDocx drops the last box's link, to a box the file does not have. */
function storyOf(wsp, tag) {
  const l = kid(wsp, 'wps:linkedTxbx');
  const s = at(l ?? kid(wsp, 'wps:txbx'), 'id');
  if (s == null) return null;
  const seq = num(at(l, 'seq')) ?? 0;
  return { id: seq ? `${tag}.${s}.${seq}` : `${tag}.${s}`, link: `${tag}.${s}.${seq + 1}` };
}
/** w:sdtPr → the sdt object; `placeholders` maps the document's placeholder docParts (word/glossary) to their text; `end` (its
 * w:sdtEndPr) gives endRun, the run properties of the control's end mark, its theme colours resolved against `colors` as a run's are. */
function sdtOf(p, placeholders, end = null, colors = null) {
  const type = kid(p, 'w:text') ? 'text' : kid(p, 'w:picture') ? 'picture' : kid(p, 'w:date') ? 'date' : kid(p, 'w:comboBox') ? 'comboBox' : kid(p, 'w:dropDownList') ? 'dropDown'
    : kid(p, 'w:docPartObj') || kid(p, 'w:docPartList') ? 'docPart' : kid(p, 'w:citation') ? 'citation' : kid(p, 'w:bibliography') ? 'bibliography' : kid(p, 'w:group') ? 'group'
      : kid(p, 'w14:checkbox') ? 'checkbox' : kid(p, 'w15:repeatingSection') ? 'repeating' : kid(p, 'w15:repeatingSectionItem') ? 'repeatingItem' : 'richText';
  const list = kid(p, 'w:comboBox') ?? kid(p, 'w:dropDownList');
  const date = kid(p, 'w:date');
  const part = kid(p, 'w:docPartObj') ?? kid(p, 'w:docPartList');
  const ph = v(kid(p, 'w:placeholder'), 'w:docPart');
  const box = kid(p, 'w14:checkbox');
  const sym = (e, d) => (at(e, 'w14:val') ? String.fromCodePoint(parseInt(at(e, 'w14:val'), 16)) : d);
  const rs = kid(p, 'w15:repeatingSection');
  return { id: v(p, 'w:id') ?? String(Math.random()).slice(2, 10), tag: v(p, 'w:tag'), title: v(p, 'w:alias'), type, lock: v(p, 'w:lock') ?? 'none',
    placeholder: placeholders?.get(ph) ?? null, ...(ph && { placeholderPart: ph }),
    showingPlaceholder: !!kid(p, 'w:showingPlcHdr'), appearance: at(kid(p, 'w15:appearance'), 'w15:val') ?? 'boundingBox', color: hexOf(v(p, 'w15:color')),
    style: v(kid(p, 'w:rPr'), 'w:rStyle'),
    items: list ? kids(list, 'w:listItem').map((i) => ({ display: at(i, 'w:displayText') ?? at(i, 'w:value'), value: at(i, 'w:value') })) : [],
    date: date ? { format: v(date, 'w:dateFormat'), lang: v(date, 'w:lid'), full: at(date, 'w:fullDate'), store: v(date, 'w:storeMappedDataAs') ?? 'dateTime',
      calendar: v(date, 'w:calendar') ?? 'gregorian' } : null,
    repeat: rs ? { title: v(rs, 'w15:sectionTitle'), allowAddRemove: !flag(rs, 'w15:doNotAllowInsertDeleteSection') } : null,
    checked: !!onAt(kid(box, 'w14:checked'), 'w14:val'), checkedChar: sym(kid(box, 'w14:checkedState'), '☒'), uncheckedChar: sym(kid(box, 'w14:uncheckedState'), '☐'),
    multiLine: !!onAt(kid(p, 'w:text'), 'w:multiLine'), temporary: !!flag(p, 'w:temporary'), binding: bindingOf(kid(p, 'w:dataBinding')),
    docPart: part ? { gallery: v(part, 'w:docPartGallery'), category: v(part, 'w:docPartCategory') } : null, ...(end && { endRun: runProps(kid(end, 'w:rPr'), colors) }) };
}
/** A w:dataBinding → {prop} when it binds a Document Property (export.mjs PROP_BINDINGS), by the namespaces its XPath steps name;
 * else null (a binding to a custom XML part has no form here). */
function bindingOf(b) {
  if (!b) return null;
  const ns = Object.fromEntries([...(at(b, 'w:prefixMappings') ?? '').matchAll(/xmlns:([\w.-]+)\s*=\s*['"]([^'"]*)['"]/g)].map((m) => [m[1], m[2]]));
  const steps = [...(at(b, 'w:xpath') ?? '').matchAll(/\/(?:([\w.-]+):)?([\w.-]+)(?:\[\d+\])?/g)].map((m) => [ns[m[1]] ?? null, m[2]]);
  const prop = steps.length === 2 && Object.keys(PROP_BINDINGS).find((k) => {
    const [root, uri, name] = PROP_BINDINGS[k];
    return steps[0][0] === root && steps[1][0] === uri && steps[1][1] === name;
  });
  return prop ? { prop } : null;
}
/** A legacy form field's w:ffData → its ff (content-controls' ffDefaults keys); a check box's size is in points, null for Auto. */
function ffOf(d) {
  const box = kid(d, 'w:checkBox');
  const list = kid(d, 'w:ddList');
  const input = kid(d, 'w:textInput');
  const common = { name: v(d, 'w:name') ?? '', help: v(d, 'w:helpText'), status: v(d, 'w:statusText'), enabled: flag(d, 'w:enabled') ?? true, calcOnExit: !!flag(d, 'w:calcOnExit') };
  if (box) return { ...common, default: !!flag(box, 'w:default'), checked: flag(box, 'w:checked'), size: num(v(box, 'w:size')) == null ? null : num(v(box, 'w:size')) / 2 };
  if (list) return { ...common, items: kids(list, 'w:listEntry').map((e) => at(e, 'w:val') ?? ''), result: num(v(list, 'w:result')) ?? num(v(list, 'w:default')) ?? 0 };
  return { ...common, type: v(input, 'w:type') ?? 'regular', default: v(input, 'w:default') ?? '', maxLength: num(v(input, 'w:maxLength')) ?? 0, format: v(input, 'w:format') ?? '' };
}
