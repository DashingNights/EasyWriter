// .docx export (docs/plans/document.md # interop, Phase 2): a Document's TipTap JSON to a WordprocessingML package. The model
// mirrors OOXML one to one (plan.md §1.8), so each node, mark and attribute writes its element; lengths are points in the model and
// twips, half-points, eighths or EMU here (office.mjs). Pure, with the pictures read through `media` so Node tests run it.
// What has no Word form goes into `dropped`, which the caller shows as one notice. Canvases and plan charts, which Word holds only
// as pictures, also ride along in docProps/easywriter.json (STASH), keyed by their picture's wp:docPr id, with a hash of every
// other part, so a file that comes back unchanged reopens them as canvases and plan charts (import.mjs).
import { BORDER_STYLES, HIGHLIGHTS, ptToEighths, ptToEmu, ptToHalfPoints, ptToTwips, toWordColor } from '../../office.mjs';
import { boxSpXml, decorativeXml, heldFallback, pictureXml, refsXml } from './dml.mjs';
import { bodyPrXml, floatingShapes, pictureSrc, shapeCanvas, shapeDrawing, SVG_PICTURE } from './shapes-out.mjs';
import { writeZip } from './zip.mjs';
import { writeChart } from '../chart/parts.mjs';
import { imageSize } from './vml.mjs';
import { autoWatermarkSize, GRADIENT_PRESETS, PATTERNS, TEXTURES, textureCss } from '../wp/page-background/model.mjs';
import { runMarks, validRuns } from '../wp/fields-core/runs.mjs';
import { writeOmml } from '../wp/equations/omml.mjs';
import { objectDefaultsInto } from '../wp/design/model.mjs';
import { chainsOf } from '../wp/textbox/boxes.mjs';
import { parse as parseMath } from '../wp/equations/unicodemath.mjs';
import { bytesOf } from '../../tooling/base64.mjs';

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  wpc: 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
  wp14: 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  doc: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
const ROOT_NS = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}" xmlns:m="${NS.m}" xmlns:wps="${NS.wps}" xmlns:wpg="${NS.wpg}" xmlns:wpc="${NS.wpc}" xmlns:wp14="${NS.wp14}" xmlns:mc="${NS.mc}"`
  + ` xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" mc:Ignorable="wp14 w14 w15"`
  + ' xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w10="urn:schemas-microsoft-com:office:word"'
  + ' xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"';
// A text box's direction as wps:bodyPr vert, and the layout a text box has when it holds none (model/nodes.js TEXTBOX_DEFAULTS).
const VERT_OUT = { tbRl: 'vert', btLr: 'vert270', stacked: 'wordArtVert' };
const TEXTBOX_LAYOUT = { wrap: 'front', h: { rel: 'column', offset: 0 }, v: { rel: 'paragraph', offset: 0 } };
/** A layout's relSize (import.mjs relSizeOf) as wp14:sizeRelH and wp14:sizeRelV for a drawing of cx by cy EMU, each axis only
 * while its size is still the one it resolved to at import (within 1 pt): a drawing resized here goes out at its own size. */
const relSizeXml = (rs, cx, cy) => [['h', 'H', 'Width', cx], ['v', 'V', 'Height', cy]].map(([k, A, W, e]) => (rs?.[k] && Math.abs(e - rs[k].emu) <= 12700
  ? `<wp14:sizeRel${A} relativeFrom="${rs[k].from}"><wp14:pct${W}>${rs[k].pct}</wp14:pct${W}></wp14:sizeRel${A}>` : '')).join('');
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ---------- what a .docx kept beside the model ----------
// The XML of theme1.xml, styles.xml, numbering.xml and settings.xml that the model does not hold rides along in the attribute that
// holds the rest (import.mjs): theme.kept, styles.kept, numbering.kept and settings.kept, and the parts the model does not read in
// settings.parts. A kept piece goes back as Word wrote it while the model value it was read with is unchanged (its sig), so what
// the user changes is written from the model instead.

/** A short signature of model value `v`, the same for equal values whatever their key order and null keys (cyrb53, 53 bits). */
export function sig(v) {
  const s = JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] != null).map((k) => [k, x[k]])) : x)) ?? '';
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A part's root attributes: ours (`ns`, as attribute text) over the ones Word wrote (`kept`), so every prefix kept XML uses stays
 * declared; mc:Ignorable lists the declared prefixes either side names. */
function rootAttrs(ns, kept) {
  const own = Object.fromEntries([...ns.matchAll(/([\w:.-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const out = { ...kept, ...own };
  const ignorable = [...new Set(`${kept?.['mc:Ignorable'] ?? ''} ${own['mc:Ignorable'] ?? ''}`.split(/\s+/))].filter((p) => p && out[`xmlns:${p}`]).join(' ');
  delete out['mc:Ignorable'];
  if (ignorable) Object.assign(out, { 'xmlns:mc': out['xmlns:mc'] ?? NS.mc, 'mc:Ignorable': ignorable });
  return Object.entries(out).map(([k, x]) => ` ${k}="${esc(x)}"`).join('');
}

/** `own` ([name, xml] the model writes, '' for off) with the kept children of the same parent that the model does not write, in
 * schema order (`rank`: name → position; a name it lacks goes at `unknown`, kept ones in their own order) → XML. */
function mergeKept(own, kept = [], rank, unknown) {
  const names = new Set(own.map(([n]) => n));
  const at = (n) => rank.get(n) ?? unknown;
  return [...own.filter(([, x]) => x), ...kept.filter(([n]) => !names.has(n))].sort((a, b) => at(a[0]) - at(b[0])).map(([, x]) => x).join('');
}
const ranks = (names) => new Map(names.split(/\s+/).map((n, i) => [n.includes(':') ? n : `w:${n}`, i]));
// CT_Settings' sequence (ECMA-376 Part 1 §17.15.1.78); extensions (w14, w15) follow it.
const SETTINGS_ORDER = ranks(`writeProtection view zoom removePersonalInformation removeDateAndTime doNotDisplayPageBoundaries displayBackgroundShape
  printPostScriptOverText printFractionalCharacterWidth printFormsData embedTrueTypeFonts embedSystemFonts saveSubsetFonts saveFormsData mirrorMargins
  alignBordersAndEdges bordersDoNotSurroundHeader bordersDoNotSurroundFooter gutterAtTop hideSpellingErrors hideGrammaticalErrors activeWritingStyle proofState
  formsDesign attachedTemplate linkStyles stylePaneFormatFilter stylePaneSortMethod documentType mailMerge revisionView trackRevisions doNotTrackMoves
  doNotTrackFormatting documentProtection autoFormatOverride styleLockTheme styleLockQFSet defaultTabStop autoHyphenation consecutiveHyphenLimit hyphenationZone
  doNotHyphenateCaps showEnvelope summaryLength clickAndTypeStyle defaultTableStyle evenAndOddHeaders bookFoldRevPrinting bookFoldPrinting bookFoldPrintingSheets
  drawingGridHorizontalSpacing drawingGridVerticalSpacing displayHorizontalDrawingGridEvery displayVerticalDrawingGridEvery doNotUseMarginsForDrawingGridOrigin
  drawingGridHorizontalOrigin drawingGridVerticalOrigin doNotShadeFormData noPunctuationKerning characterSpacingControl printTwoOnOne strictFirstAndLastChars
  noLineBreaksAfter noLineBreaksBefore savePreviewPicture doNotValidateAgainstSchema saveInvalidXml ignoreMixedContent alwaysShowPlaceholderText
  doNotDemarcateInvalidXml saveXmlDataOnly useXSLTWhenSaving saveThroughXslt showXMLTags alwaysMergeEmptyNamespace updateFields hdrShapeDefaults footnotePr
  endnotePr compat docVars rsids m:mathPr attachedSchema themeFontLang clrSchemeMapping doNotIncludeSubdocsInStats doNotAutoCompressPictures forceUpgrade captions
  readModeInkLockDown smartTagType sl:schemaLibrary shapeDefaults doNotEmbedSmartTags decimalSymbol listSeparator`);
// CT_Compat from the one flag the model writes on (§17.15.3): the flags before it keep their place, compatSetting comes last.
const COMPAT_ORDER = ranks(`doNotUseHTMLParagraphAutoSpacing layoutRawTableWidth layoutTableRowsApart useWord97LineBreakRules doNotBreakWrappedTables
  doNotSnapToGridInCell selectFldWithFirstOrLastChar applyBreakingRules doNotWrapTextWithPunct doNotUseEastAsianBreakRules useWord2002TableStyleRules growAutofit
  useFELayout useNormalStyleForList doNotUseIndentAsNumberingTabStop useAltKinsokuLineBreakRules allowSpaceOfSameStyleInTable doNotSuppressIndentation
  doNotAutofitConstrainedTables autofitToFirstFixedWidthCell underlineTabInNumList displayHangulFixedWidth splitPgBreakAndParaMark doNotVertAlignCellWithSp
  doNotBreakConstrainedForcedTable doNotVertAlignInTxbx useAnsiKerningPairs cachedColBalance compatSetting`);

/** XML text with &, <, > and quotes escaped. */
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// An element with attributes ({name: value}; null and undefined left out) and optional inner XML.
const el = (name, attrs = {}, inner = '') => {
  const a = Object.entries(attrs).filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return inner ? `<${name}${a}>${inner}</${name}>` : `<${name}${a}/>`;
};
const val = (name, v) => (v == null ? '' : el(name, { 'w:val': v }));
const onOff = (name, v) => (v == null ? '' : el(name, v ? {} : { 'w:val': '0' }));
const hex = (c) => (!c || c === 'auto' ? 'auto' : String(c).replace('#', '').toUpperCase());
const tw = (pt) => (pt == null ? null : ptToTwips(pt));
// Table properties a table, a row's exceptions (w:tblPrEx) and a table style share.
const tblW = (w) => el('w:tblW', w?.type === 'pct' ? { 'w:w': Math.round(w.w * 50), 'w:type': 'pct' } : w?.type === 'dxa' ? { 'w:w': tw(w.w), 'w:type': 'dxa' } : { 'w:w': 0, 'w:type': 'auto' });
// Transitional values (left, center, right), as Word writes them: Word 2007 does not read ISO 29500's start and end.
const tblJc = (align) => val('w:jc', align);
const cellMar = (m) => (m ? el('w:tblCellMar', {}, ['top', 'left', 'bottom', 'right'].map((k) => (m[k] == null ? '' : el(`w:${k}`, { 'w:w': tw(m[k]), 'w:type': 'dxa' }))).join('')) : '');
const emptyP = (sect = '') => `<w:p>${sect ? el('w:pPr', {}, sect) : ''}</w:p>`;
// Blocks that write into the paragraph after them or are one: a text box and a floating canvas of Word shapes wait for it.
const waits = (n) => ['paragraph', 'heading', 'textBox'].includes(n.type) || floatingShapes(n);

// An edge's or a fill's theme link ({slot, lum}, which Table Design's styles hold) goes out as Word's theme attributes.
const themeAttrs = (color, link, [c, t, s]) => {
  const w = link ? toWordColor(color && color !== 'auto' ? color : '#000000', link) : {};
  return { [c]: w.themeColor ?? null, [t]: w.themeTint ?? null, [s]: w.themeShade ?? null };
};
/** A border edge {style, width, space, color, themeColor, shadow, frame} as `name`. */
const border = (name, e) => (!e ? '' : el(name, { 'w:val': e.style ?? 'single', 'w:sz': e.width == null ? null : ptToEighths(e.width),
  'w:space': e.space == null ? 0 : Math.round(e.space), 'w:color': hex(e.color), ...themeAttrs(e.color, e.themeColor, ['w:themeColor', 'w:themeTint', 'w:themeShade']),
  'w:shadow': e.shadow ? 1 : null, 'w:frame': e.frame ? 1 : null }));
const borders = (name, b, sides) => (!b ? '' : el(name, {}, sides.map(([k, tag]) => border(`w:${tag ?? k}`, b[k])).join('')) || '');
const shading = (s) => (!s ? '' : el('w:shd', { 'w:val': s.val ?? 'clear', 'w:color': hex(s.color), 'w:fill': hex(s.fill),
  ...themeAttrs(s.fill, s.themeFill, ['w:themeFill', 'w:themeFillTint', 'w:themeFillShade']) }));
const colorEl = (color, themeColor) => {
  if (!color && !themeColor) return '';
  const c = toWordColor(color ?? '#000000', themeColor);
  return el('w:color', { 'w:val': c.val, 'w:themeColor': c.themeColor, 'w:themeTint': c.themeTint, 'w:themeShade': c.themeShade });
};
// A theme font ('+major', '+minor') goes out as its theme attribute; a Latin theme font with no East Asian or complex script font of
// its own sets those to the same theme, as Word writes it.
const fonts = (font, ea, cs, hint) => {
  if (!font && !ea && !cs && !hint) return '';
  const theme = (f) => /^\+(major|minor)$/.exec(f ?? '')?.[1] ?? null;
  const t = theme(font);
  const [te, tc] = [theme(ea) ?? (ea ? null : t), theme(cs) ?? (cs ? null : t)];
  return el('w:rFonts', { 'w:ascii': t ? null : font, 'w:hAnsi': t ? null : font, 'w:eastAsia': theme(ea) ? null : ea, 'w:cs': theme(cs) ? null : cs,
    'w:asciiTheme': t && `${t}HAnsi`, 'w:hAnsiTheme': t && `${t}HAnsi`, 'w:eastAsiaTheme': te && `${te}EastAsia`, 'w:cstheme': tc && `${tc}Bidi`, 'w:hint': hint || null });
};

// ---------- run properties ----------
/** w:rPr of run properties `p` (textStyle's keys plus b, i, strike, u {val, color}, vertAlign), in the schema's order. */
export function rPr(p, extra = '') {
  if (!p) return extra ? el('w:rPr', {}, extra) : '';
  const hl = p.highlight && (HIGHLIGHTS[p.highlight] ? p.highlight : Object.keys(HIGHLIGHTS).find((k) => HIGHLIGHTS[k] === String(p.highlight).toUpperCase()));
  const inner = [
    val('w:rStyle', p.charStyle), fonts(p.font, p.fontEA, p.fontCS, p.hint), onOff('w:b', p.b), onOff('w:bCs', p.b), onOff('w:i', p.i), onOff('w:iCs', p.i),
    onOff('w:caps', p.caps), onOff('w:smallCaps', p.smallCaps), onOff('w:strike', p.strike), onOff('w:dstrike', p.dstrike),
    onOff('w:outline', p.outline), onOff('w:shadow', p.shadow), onOff('w:emboss', p.emboss), onOff('w:imprint', p.imprint),
    onOff('w:noProof', p.noProof), onOff('w:vanish', p.vanish), onOff('w:webHidden', p.webHidden), onOff('w:specVanish', p.specVanish), colorEl(p.color, p.themeColor),
    val('w:spacing', tw(p.spacing)), val('w:w', p.scale), val('w:kern', p.kern == null ? null : ptToHalfPoints(p.kern)),
    val('w:position', p.position == null ? null : ptToHalfPoints(p.position)), val('w:sz', p.size == null ? null : ptToHalfPoints(p.size)),
    val('w:szCs', (p.sizeCS ?? p.size) == null ? null : ptToHalfPoints(p.sizeCS ?? p.size)), val('w:highlight', hl || null),
    p.u ? el('w:u', { 'w:val': p.u.val ?? 'single', 'w:color': p.u.color ? hex(p.u.color) : null }) : '',
    border('w:bdr', p.border), shading(p.shading ?? (p.highlight && !hl ? { val: 'clear', fill: p.highlight } : null)),
    p.fitText?.w ? el('w:fitText', { 'w:val': tw(p.fitText.w), 'w:id': p.fitText.id }) : '',
    val('w:vertAlign', p.vertAlign), onOff('w:rtl', p.rtl), onOff('w:cs', p.cs), val('w:em', p.em),
    p.lang ? el('w:lang', { 'w:val': p.lang.val, 'w:eastAsia': p.lang.eastAsia, 'w:bidi': p.lang.bidi }) : '', eastAsianLayout(p.eastAsianLayout), textEffects(p.effects), typography(p.typography), extra,
  ].join('');
  return inner ? el('w:rPr', {}, inner) : '';
}
const bit = (v) => (v == null ? null : v ? 1 : 0);
// Text effects (textStyle effects, lengths in pt, alpha the opacity) as Word 2010's w14 run properties, in Word's order. w14:alpha is
// the transparency, in whole percent as Word sets it. A reflection mirrors below the text with Word's presets' blur and end, which the model does not hold.
const DASH_OUT = { longDash: 'lgDash' };
const w14Color = (c, alpha = 1) => {
  const h = hex(c);
  const a = h.length === 8 ? alpha * (parseInt(h.slice(6), 16) / 255) : alpha;
  return el('w14:srgbClr', { 'w14:val': h === 'auto' ? '000000' : h.slice(0, 6) }, a < 0.995 ? el('w14:alpha', { 'w14:val': Math.round((1 - a) * 100) * 1000 }) : '');
};
const textEffects = (e) => {
  if (!e) return '';
  const { fill, outline: o, shadow: s, glow: g, reflection: r } = e;
  const deg = (x) => Math.round(((((x ?? 0) % 360) + 360) % 360) * 60000);
  return (g?.size ? el('w14:glow', { 'w14:rad': ptToEmu(g.size) }, w14Color(g.color, g.alpha ?? 0.6)) : '')
    + (s ? el('w14:shadow', { 'w14:blurRad': ptToEmu(s.blur ?? 0), 'w14:dist': ptToEmu(s.dist ?? 0), 'w14:dir': deg(s.angle) }, w14Color(s.color, s.alpha ?? 0.6)) : '')
    + (r ? el('w14:reflection', { 'w14:blurRad': 6350, 'w14:stA': Math.round((r.alpha ?? 0.5) * 100000), 'w14:stPos': 0, 'w14:endA': 300, 'w14:endPos': Math.round((r.size ?? 50) * 1000),
      'w14:dist': ptToEmu(r.dist ?? 0), 'w14:dir': 5400000, 'w14:fadeDir': 5400000, 'w14:sx': 100000, 'w14:sy': -100000, 'w14:kx': 0, 'w14:ky': 0, 'w14:algn': 'bl' }) : '')
    + (o?.color ? el('w14:textOutline', { 'w14:w': ptToEmu(o.width ?? 0.75), 'w14:cap': 'rnd', 'w14:cmpd': 'sng', 'w14:algn': 'ctr' },
      el('w14:solidFill', {}, w14Color(o.color)) + el('w14:prstDash', { 'w14:val': DASH_OUT[o.dash] ?? o.dash ?? 'solid' }) + '<w14:bevel/>') : '')
    + (fill?.type === 'none' ? '<w14:textFill><w14:noFill/></w14:textFill>' : fill?.type === 'solid' && fill.color ? el('w14:textFill', {}, el('w14:solidFill', {}, w14Color(fill.color)))
      : fill?.type === 'gradient' && fill.stops?.length ? el('w14:textFill', {}, el('w14:gradFill', {}, el('w14:gsLst', {}, fill.stops.map((x) => el('w14:gs', { 'w14:pos': Math.round(x.pos * 1000) }, w14Color(x.color))).join(''))
        + el('w14:lin', { 'w14:ang': deg(fill.angle), 'w14:scaled': 0 }))) : '');
};
// OpenType features (Font > Advanced) as Word 2010's w14 run properties: the parts that hold rPr declare w14 (ROOT_NS, W14).
const typography = (t) => (!t ? '' : (t.ligatures ? el('w14:ligatures', { 'w14:val': t.ligatures }) : '') + (t.numForm ? el('w14:numForm', { 'w14:val': t.numForm }) : '')
  + (t.numSpacing ? el('w14:numSpacing', { 'w14:val': t.numSpacing }) : '') + (t.stylisticSet ? el('w14:stylisticSets', {}, el('w14:styleSet', { 'w14:id': t.stylisticSet })) : '')
  + (t.contextual != null ? el('w14:cntxtAlts', t.contextual ? {} : { 'w14:val': 0 }) : ''));
const W14 = `xmlns:mc="${NS.mc}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"`;
// Combine Characters (combineChars) has no form here: Word writes it as an EQ field.
const eastAsianLayout = (e) => (e && (e.combine != null || e.vert != null || e.vertCompress != null)
  ? el('w:eastAsianLayout', { 'w:id': e.id, 'w:combine': bit(e.combine), 'w:combineBrackets': e.combine ? e.combineBrackets : null, 'w:vert': bit(e.vert), 'w:vertCompress': bit(e.vertCompress) }) : '');

/** Run properties from a text node's marks → {props, link, comments, ins, del, fmt}. */
function runOf(marks = []) {
  const props = {};
  const out = { props, link: null, comments: [], ins: null, del: null, fmt: null };
  for (const m of marks) {
    const a = m.attrs ?? {};
    switch (m.type) {
      case 'bold': props.b = true; break;
      case 'italic': props.i = true; break;
      case 'strike': props.strike = true; break;
      case 'underline': props.u = { val: a.val ?? 'single', color: a.color ?? null }; break;
      case 'subscript': props.vertAlign = 'subscript'; break;
      case 'superscript': props.vertAlign = 'superscript'; break;
      case 'textStyle': for (const [k, v] of Object.entries(a)) if (v != null) props[k] = v; break;
      case 'link': out.link = a; break;
      case 'comment': out.comments.push(a.id); break;
      case 'insertion': out.ins = a; break;
      case 'deletion': out.del = a; break;
      case 'formatChange': out.fmt = a; break;
      default: break;
    }
  }
  return out;
}

// The Document Property bindings of content controls (sdt.binding.prop, content-controls' DOC_PROPS paths): [the store's namespace,
// the property's namespace, its element], and each store's root element and Word's id for it.
const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
const DC = 'http://purl.org/dc/elements/1.1/';
const EP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
const CPP = 'http://schemas.microsoft.com/office/2006/coverPageProps';
export const PROP_BINDINGS = {
  'core.title': [CP, DC, 'title'], 'core.subject': [CP, DC, 'subject'], 'core.creator': [CP, DC, 'creator'], 'core.description': [CP, DC, 'description'],
  'core.keywords': [CP, CP, 'keywords'], 'core.category': [CP, CP, 'category'], 'core.contentStatus': [CP, CP, 'contentStatus'],
  'app.company': [EP, EP, 'Company'], 'app.manager': [EP, EP, 'Manager'],
  'cover.abstract': [CPP, CPP, 'Abstract'], 'cover.address': [CPP, CPP, 'CompanyAddress'], 'cover.email': [CPP, CPP, 'CompanyEmail'], 'cover.fax': [CPP, CPP, 'CompanyFax'],
  'cover.phone': [CPP, CPP, 'CompanyPhone'], 'cover.publishDate': [CPP, CPP, 'PublishDate'],
};
const STORES = { [CP]: ['coreProperties', '{6C3C8BC8-F283-45AE-878A-BAB7291924A1}'], [EP]: ['Properties', '{6668398D-A668-4E3E-A5EB-62B293D839F1}'],
  [CPP]: ['CoverPageProperties', '{55AF091B-3C7A-41E3-B477-F2FDAA23CFDA}'] };
/** The cover page properties (props.cover keys) in the order of their part's schema, which import.mjs reads them by. */
export const COVER = [['publishDate', 'PublishDate'], ['abstract', 'Abstract'], ['address', 'CompanyAddress'], ['phone', 'CompanyPhone'], ['fax', 'CompanyFax'],
  ['email', 'CompanyEmail']];
export { CPP };
const GLOSSARY = 'word/glossary/document.xml';
/** A control's binding {prop} as the w:dataBinding Word's Quick Parts > Document Property writes, or '' for none. */
function dataBinding(b) {
  const [store, uri, name] = PROP_BINDINGS[b?.prop] ?? [];
  if (!store) return '';
  const pre = store === CP ? { [DC]: 'ns0', [CP]: 'ns1' } : { [store]: 'ns0' };
  return el('w:dataBinding', { 'w:prefixMappings': Object.entries(pre).map(([u, p]) => `xmlns:${p}='${u}'`).join(' '),
    'w:xpath': `/${pre[store]}:${STORES[store][0]}[1]/${pre[uri]}:${name}[1]`, 'w:storeItemID': STORES[store][1] });
}

/** A legacy form field's options `ff` (field ff) as w:ffData, its kind from the field `code`: a check box's size in half-points,
 * Auto without one. */
function ffData(ff, code) {
  if (!ff) return '';
  const say = (name, s) => (s ? el(name, { 'w:type': 'text', 'w:val': s }) : '');
  const kind = /^\s*FORMCHECKBOX\b/i.test(code ?? '') ? el('w:checkBox', {}, (ff.size ? val('w:size', Math.round(ff.size * 2)) : '<w:sizeAuto/>') + val('w:default', ff.default ? 1 : 0)
    + onOff('w:checked', ff.checked))
    : /^\s*FORMDROPDOWN\b/i.test(code ?? '') ? el('w:ddList', {}, (ff.result ? val('w:result', ff.result) : '') + (ff.items ?? []).map((i) => val('w:listEntry', i)).join(''))
      : el('w:textInput', {}, (ff.type && ff.type !== 'regular' ? val('w:type', ff.type) : '') + (ff.default ? val('w:default', ff.default) : '')
        + (ff.maxLength ? val('w:maxLength', ff.maxLength) : '') + (ff.format ? val('w:format', ff.format) : ''));
  return el('w:ffData', {}, val('w:name', ff.name ?? '') + onOff('w:enabled', ff.enabled !== false) + onOff('w:calcOnExit', !!ff.calcOnExit) + say('w:helpText', ff.help)
    + say('w:statusText', ff.status) + kind);
}

// ---------- paragraph properties ----------
const JC = { left: 'left', center: 'center', right: 'right', justify: 'both', distribute: 'distribute' };
/** w:spacing of {before, after, line, beforeAuto, afterAuto, beforeLines, afterLines}. */
function spacingEl(s) {
  if (!s) return '';
  const line = typeof s.line === 'number' ? { rule: 'auto', value: s.line } : s.line;
  return el('w:spacing', { 'w:before': tw(s.before), 'w:beforeLines': s.beforeLines, 'w:beforeAutospacing': s.beforeAuto == null ? null : s.beforeAuto ? 1 : 0,
    'w:after': tw(s.after), 'w:afterLines': s.afterLines, 'w:afterAutospacing': s.afterAuto == null ? null : s.afterAuto ? 1 : 0,
    'w:line': !line ? null : line.rule === 'auto' ? Math.round(line.value * 240) : tw(line.value), 'w:lineRule': line?.rule ?? null });
}
function indEl(i) {
  if (!i) return '';
  const fl = i.firstLine;
  return el('w:ind', { 'w:left': tw(i.left), 'w:right': tw(i.right), 'w:leftChars': i.leftChars, 'w:firstLineChars': i.firstLineChars,
    'w:firstLine': fl != null && fl >= 0 ? tw(fl) : null, 'w:hanging': fl != null && fl < 0 ? tw(-fl) : null });
}
const tabsEl = (tabs) => (!tabs?.length ? '' : el('w:tabs', {}, tabs.map((t) => el('w:tab', { 'w:val': t.align ?? 'left', 'w:leader': t.leader && t.leader !== 'none' ? t.leader : null, 'w:pos': tw(t.pos) })).join('')));
const framePr = (f) => (!f ? '' : el('w:framePr', { 'w:dropCap': f.dropCap, 'w:lines': f.lines, 'w:w': tw(f.w), 'w:h': tw(f.h), 'w:hRule': f.hRule, 'w:hSpace': tw(f.hSpace),
  'w:vSpace': tw(f.vSpace), 'w:wrap': f.wrap, 'w:hAnchor': f.hAnchor, 'w:vAnchor': f.vAnchor, 'w:x': tw(f.x), 'w:xAlign': f.xAlign, 'w:y': tw(f.y), 'w:yAlign': f.yAlign }));
const ASIAN = ['kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN'];
const PBDR = [['top'], ['left'], ['bottom'], ['right'], ['between'], ['bar']];

/** w:pPr of paragraph properties `a` (the node's attrs or a style's para), `sect` the sectPr to end it with, `markRun` its mark's rPr. */
export function pPr(a, { styleId = a?.styleId, sect = '', markRun = '', numId } = {}) {
  if (!a && !styleId && !sect && !markRun) return '';
  a = a ?? {};
  const num = a.numbering;
  const inner = [
    val('w:pStyle', styleId), onOff('w:keepNext', a.keepNext), onOff('w:keepLines', a.keepLines), onOff('w:pageBreakBefore', a.pageBreakBefore),
    framePr(a.frame), onOff('w:widowControl', a.widowControl),
    num ? el('w:numPr', {}, val('w:ilvl', num.ilvl ?? 0) + val('w:numId', numId ? numId(num.numId) : num.numId)) : '',
    onOff('w:suppressLineNumbers', a.suppressLineNumbers), borders('w:pBdr', a.borders, PBDR), shading(a.shading), tabsEl(a.tabs),
    onOff('w:suppressAutoHyphens', a.suppressAutoHyphens), ...ASIAN.map((k) => onOff(`w:${k}`, a.asian?.[k])), onOff('w:bidi', a.bidi),
    onOff('w:adjustRightInd', a.asian?.adjustRightInd), onOff('w:snapToGrid', a.snapToGrid), spacingEl(a.spacing), indEl(a.indent),
    onOff('w:contextualSpacing', a.contextual), onOff('w:mirrorIndents', a.mirrorIndents), val('w:jc', JC[a.textAlign] ?? null),
    val('w:textAlignment', a.asian?.textAlignment), val('w:textboxTightWrap', a.tightWrap), val('w:outlineLvl', a.outline), onOff('w15:collapsed', a.collapsed), markRun, sect,
  ].join('');
  return inner ? el('w:pPr', {}, inner) : '';
}

// ---------- the writer ----------
const PIC_TYPES = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', emf: 'image/x-emf', wmf: 'image/x-wmf' };
const PX = 9525; // EMU per CSS px

/** Picture bytes of `src` (a data URL or any fetchable URL) → {bytes: Uint8Array, ext} or null. */
export async function fetchMedia(src) {
  // A data URL decodes here: the app's content security policy may refuse fetch for it.
  const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src ?? '');
  if (data) {
    const ext = Object.entries(PIC_TYPES).find(([, t]) => t === data[1])?.[0] ?? 'png';
    const bytes = data[2] ? Uint8Array.from(atob(data[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(data[3]));
    return { bytes, ext: ext === 'jpg' ? 'jpeg' : ext };
  }
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? (/^data:([^;,]+)/.exec(src)?.[1] ?? '');
    const ext = Object.entries(PIC_TYPES).find(([, t]) => t === type.split(';')[0])?.[0] ?? 'png';
    return { bytes: new Uint8Array(await res.arrayBuffer()), ext: ext === 'jpg' ? 'jpeg' : ext };
  } catch {
    return drawnMedia(src);
  }
}

/** A picture the page can show but not fetch, drawn to a canvas → {bytes, ext: 'png'} or null (no DOM in Node). */
async function drawnMedia(src) {
  if (typeof Image === 'undefined') return null;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    [c.width, c.height] = [img.naturalWidth, img.naturalHeight];
    c.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'png' } : null;
  } catch {
    return null;
  }
}

/** The part that keeps a file's canvases and plan charts: {hash: packageHash of the other parts, nodes: {docPr id: node}}. */
export const STASH = 'docProps/easywriter.json';

/** SHA-256 of a package's parts (Map or [name, string | bytes] pairs) but STASH: each name and its bytes, by name → hex. */
export async function packageHash(parts) {
  const enc = new TextEncoder();
  const list = [...parts].filter(([n]) => n !== STASH).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const chunks = list.flatMap(([n, d]) => { const b = typeof d === 'string' ? enc.encode(d) : d; return [enc.encode(`${n}\0${b.length}\0`), b]; });
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await new Blob(chunks).arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The chains of linked text boxes in Document JSON `doc` (textBox.link names the next box's id: Create Link) as Word's stories →
 * Map(box → {id, seq, after}): each chain numbered from 1, `seq` the box's place in it (0 for the first), and on the first box
 * `after`, the boxes that follow it. A chain ends at a link to no box or back into a chain; of boxes sharing an id, the first one
 * met counts. */
function storiesOf(doc) {
  const boxes = [];
  const walk = (v) => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === 'object') {
      if (v.type === 'textBox' && v.attrs) boxes.push(v);
      for (const k in v) if (v[k] && typeof v[k] === 'object') walk(v[k]);
    }
  };
  walk(doc);
  const out = new Map();
  chainsOf(boxes, (b) => b.attrs.id, (b) => b.attrs.link).forEach(([head, ...after], i) => {
    out.set(head, { id: i + 1, seq: 0, after });
    after.forEach((b, k) => out.set(b, { id: i + 1, seq: k + 1 }));
  });
  return out;
}
// Whether text box node `n` holds nothing: one empty paragraph, as Create Link wants of the box it links to.
const emptyBox = (n) => n.content?.length === 1 && ['paragraph', 'heading'].includes(n.content[0].type) && !n.content[0].content?.length;

/**
 * Writes `doc` (a Document's TipTap JSON) as a .docx → {bytes: Uint8Array, dropped: string[]}.
 * media(src) → {bytes, ext} | null reads a picture (fetchMedia by default); picture(node) → {bytes, ext, w, h (px)} | null draws a
 * canvas or plan chart; title names the file in its properties when doc.attrs.props has none.
 */
// Word's page hints (w:lastRenderedPageBreak): where the app's own layout starts each page after the first, as Word writes them
// where its last layout broke pages. Readers take them as a first guess of page starts (docx/import.mjs props.breaks). A marker
// node of this type goes into a copy of the doc JSON at each page start and writes as an empty run holding the hint.
const RENDERED = 'lastRenderedPageBreak';
const INLINE_PARENTS = new Set(['paragraph', 'heading', 'sdtInline', 'boxTitle']);

/** Doc JSON `doc` with a marker before each page start of `starts` ([[top-level block, characters into it]], layout-cache.mjs
 * pageStartsOf: text counts its length, every other inline leaf one, in document order through nested blocks), a text node split
 * where one falls inside it. The blocks it changes are copies: `doc` stays as it was. */
export function withRenderedBreaks(doc, starts) {
  if (!starts?.length || !doc?.content) return doc;
  const content = [...doc.content];
  for (const [b, chars] of starts) if (content[b]) content[b] = markAt(content[b], chars);
  return { ...doc, content };
}

/** Block JSON `node` with the marker at `chars` characters into it (at the next text block's start when it falls on one's end). */
function markAt(node, chars) {
  let left = chars;
  let done = false;
  const MARK = { type: RENDERED };
  const walk = (n) => {
    const inline = INLINE_PARENTS.has(n.type);
    const kids = n.content ?? [];
    if (inline && n.type !== 'sdtInline' && !kids.length && left <= 0) {
      done = true;
      return { ...n, content: [MARK] };
    }
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const put = (...xs) => {
        done = true;
        return { ...n, content: [...kids.slice(0, i), ...xs, ...kids.slice(i + 1)] };
      };
      if (inline && left <= 0) return put(MARK, k);
      if (inline && k.type === 'text') {
        const len = k.text?.length ?? 0;
        if (left > 0 && left < len) return put({ ...k, text: k.text.slice(0, left) }, MARK, { ...k, text: k.text.slice(left) });
        left -= len;
      } else if (k.content || !inline) {
        const w = walk(k);
        if (done) return put(w);
      } else left -= 1;
    }
    return n;
  };
  return walk(node);
}

export async function exportDocx(doc, { media = fetchMedia, picture = async () => null, title = '', pageStarts = null } = {}) {
  doc = withRenderedBreaks(doc, pageStarts);
  const attrs = doc.attrs ?? {};
  const dropped = new Set();
  const rels = [];
  const parts = new Map(); // path → xml or bytes
  const types = new Map(); // override part name → content type
  const defaults = new Map(); // extension → content type
  const rel = (type, target, mode) => {
    const id = `rId${rels.length + 1}`;
    rels.push({ id, type: /^https?:/.test(type) ? type : RT + type, target, mode });
    return id;
  };

  // Numbering ids: Word's are integers, which keep their number; ours may be names, numbered after them.
  const abstractKeys = Object.keys(attrs.numbering?.abstract ?? {});
  let nextAbstract = Math.max(-1, ...abstractKeys.filter((k) => /^\d+$/.test(k)).map(Number)) + 1;
  const abstractIds = new Map(abstractKeys.map((k) => [k, /^\d+$/.test(k) ? +k : nextAbstract++]));
  const numIds = new Map(Object.keys(attrs.numbering?.nums ?? {}).map((k, i) => [k, /^\d+$/.test(k) && +k > 0 ? +k : 1000 + i]));
  const numId = (id) => numIds.get(String(id)) ?? null;

  // Notes, comments, bookmarks and the rest number from 1 in the order they are met.
  const notes = { footnote: [], endnote: [] };
  const comments = new Map(); // our id → Word id
  const commentId = (id) => (comments.has(id) ? comments.get(id) : (comments.set(id, comments.size), comments.size - 1));
  // A reply has no mark: it spans its thread's range, as Word writes it, and commentsExtended links it to the thread.
  const replies = new Map();
  for (const [id, c] of Object.entries(attrs.comments ?? {})) if (c?.parent) replies.set(c.parent, [...(replies.get(c.parent) ?? []), id]);
  const marks = new Map();
  const markId = (key) => (marks.has(key) ? marks.get(key) : (marks.set(key, marks.size + 1), marks.size));
  // A control keeps its own id (Word's and ours are 32-bit integers) the first time it is met; a copy gets a new one.
  const sdtIds = new Set();
  const sdtId = (id) => (/^-?\d{1,10}$/.test(id ?? '') && Math.abs(+id) < 2 ** 31 && !sdtIds.has(id) ? (sdtIds.add(id), id) : markId(`sdt:${id ?? Math.random()}`));
  let docPr = 0;
  const stories = storiesOf(doc);
  const kept = {}; // docPr id → the canvas or plan chart drawn as that picture, without its suggestion record (STASH)
  let revId = 0;
  let images = 0;
  let inks = 0;
  const imageCache = new Map();
  const hrefs = new Map();

  /** The relationship id of picture bytes, for the part `owner` (rels of that part). */
  const addImage = (owner, pic) => {
    images += 1;
    const name = `media/image${images}.${pic.ext}`;
    parts.set(`word/${name}`, pic.bytes);
    defaults.set(pic.ext, PIC_TYPES[pic.ext] ?? 'image/png');
    return owner.rel('image', name);
  };
  /** The relationship id of an ink part holding InkML `xml`, for the part `owner`. */
  const inkPart = (owner, xml) => {
    inks += 1;
    parts.set(`word/ink/ink${inks}.xml`, xml);
    types.set(`/word/ink/ink${inks}.xml`, 'application/inkml+xml');
    return owner.rel('customXml', `ink/ink${inks}.xml`);
  };
  /** Canvas picture item `it`'s bytes {pic, png}: its own (a metafile's original), and for an SVG a PNG of it, Word's kept one
   * while it still belongs to the SVG, else one drawn here → null when either cannot be had. */
  const canvasPicture = async (it) => {
    const pic = await media(pictureSrc(it));
    if (!pic || !SVG_PICTURE.test(pictureSrc(it))) return pic && { pic };
    const fb = heldFallback(it);
    const png = fb ? await media(fb) : await drawnMedia(it.src);
    return png && { pic, png };
  };
  // A zero size stays zero, as Word writes a picture drawn at no size. Its crop, border, live colour adjustments and effects come
  // from dml.mjs pictureXml; the app always keeps a picture's aspect ratio, so the frame says so (noChangeAspect).
  // `ink`: the relationship id of an ink part, drawn as a w14:contentPart instead of the picture (Word 2010's ink).
  // `svg`: the relationship id of the SVG the picture shows, when `rid` is its PNG fallback.
  const drawing = (rid, w, h, a = {}, ink = null, svg = null) => {
    const cx = Math.max(0, Math.round(w * PX));
    const cy = Math.max(0, Math.round(h * PX));
    docPr += 1;
    const look = pictureXml(a, { svg });
    const pr = { id: docPr, name: a.name ?? `Picture ${docPr}`, descr: a.alt || null, title: a.title || null };
    if (ink) {
      return placed(cx, cy, el('wp:docPr', pr), '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingInk">'
        + `<w14:contentPart bwMode="auto" r:id="${ink}"><w14:nvContentPartPr><w14:cNvContentPartPr/></w14:nvContentPartPr><w14:xfrm><a:off x="0" y="0"/>${el('a:ext', { cx, cy })}</w14:xfrm></w14:contentPart></a:graphicData></a:graphic>`, a.layout);
    }
    const graphic = `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:nvPicPr>${el('pic:cNvPr', pr)}<pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill>${el('a:blip', { 'r:embed': rid, ...look.blipAttrs }, look.blip)}${look.crop}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm${a.rotate ? ` rot="${Math.round(a.rotate * 60000)}"` : ''}${a.flipH ? ' flipH="1"' : ''}${a.flipV ? ' flipV="1"' : ''}><a:off x="0" y="0"/>${el('a:ext', { cx, cy })}</a:xfrm>${look.geom}${look.sp}</pic:spPr></pic:pic></a:graphicData></a:graphic>`;
    return placed(cx, cy, el('wp:docPr', pr, decorativeXml(a.decorative)), graphic, a.layout,
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>');
  };
  /** A text box (textBox attrs `a`, its blocks' XML `inner`) as a w:drawing of a wps:wsp: its fill, line and effects as dml.mjs
   * boxSpXml writes them (`rid`: the relationship id of a texture's or a picture fill's picture), its style references, and its
   * internal margins, Align Text, direction, Resize shape to fit text and vertOverflow in wps:bodyPr among Word's defaults. A box in
   * a chain of linked boxes (`story`, storiesOf) holds the story's text when it is the first, else names the story and its place. */
  const textBoxDrawing = (a, inner, rid = null, story = null) => {
    const cx = ptToEmu(a.w ?? 144);
    const cy = ptToEmu(a.h ?? 72);
    docPr += 1;
    const ins = a.inset ?? {};
    const body = bodyPrXml({ vertOverflow: a.overflow ?? null, vert: VERT_OUT[a.dir] ?? 'horz', wrap: a.noWrap ? 'none' : 'square',
      lIns: ptToEmu(ins.l ?? 7.2), tIns: ptToEmu(ins.t ?? 3.6), rIns: ptToEmu(ins.r ?? 7.2), bIns: ptToEmu(ins.b ?? 3.6),
      anchor: { center: 'ctr', bottom: 'b' }[a.vAlign] ?? 't', upright: a.upright ? 1 : null }, a.autoFit ? '<a:spAutoFit/>' : '<a:noAutofit/>');
    const graphic = `<a:graphic><a:graphicData uri="${NS.wps}"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm${a.rotate ? ` rot="${Math.round(a.rotate * 60000)}"` : ''}><a:off x="0" y="0"/>${el('a:ext', { cx, cy })}</a:xfrm>`
      + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${boxSpXml(a, rid)}</wps:spPr>${refsXml(a.styleRefs)}`
      + `${story?.seq ? el('wps:linkedTxbx', { id: story.id, seq: story.seq }) : el('wps:txbx', { id: story?.id }, `<w:txbxContent>${inner}</w:txbxContent>`)}${body}</wps:wsp></a:graphicData></a:graphic>`;
    return placed(cx, cy, el('wp:docPr', { id: docPr, name: a.name ?? `Text Box ${docPr}`, descr: a.alt || null }, decorativeXml(a.decorative)), graphic, a.layout ?? TEXTBOX_LAYOUT);
  };
  /** A w:drawing of `graphic` (a:graphic) at cx by cy EMU with docPr `pr` and frame properties `frame`: inline, or anchored as layout
   * `L` says. Tight and Through wrap around the layout's wrap points (poly, fractions of the box, Word's 21600 a side, closed as Word
   * closes them; polyEdited is Word's edited flag), else around the drawing's box (wp:wrapPolygon is required). behindDoc beside a
   * wrap keeps Word's flag from an earlier Behind Text; In Front of Text clears it, as in Word. */
  const placed = (cx, cy, pr, graphic, L, frame = '<wp:cNvGraphicFramePr/>') => {
    if (!L || !L.wrap || L.wrap === 'inline') return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">${el('wp:extent', { cx, cy })}${pr}${frame}${graphic}</wp:inline></w:drawing>`;
    const d = L.dist ?? {};
    const pos = (axis, p = {}) => el(`wp:position${axis}`, { relativeFrom: p.rel ?? (axis === 'H' ? 'column' : 'paragraph') },
      p.align ? el('wp:align', {}, p.align) : p.pct != null ? el(`wp14:pctPos${axis}Offset`, {}, String(Math.round(p.pct * 1000)))
        : el('wp:posOffset', {}, String(ptToEmu(p.offset ?? 0))));
    const side = (L.side === 'both' ? 'bothSides' : L.side) ?? 'bothSides';
    const poly = L.poly?.length >= 3 ? L.poly : [[0, 0], [0, 1], [1, 1], [1, 0]];
    const points = [...poly, poly[0]].map(([x, y], i) => el(i ? 'wp:lineTo' : 'wp:start', { x: Math.round(x * 21600), y: Math.round(y * 21600) })).join('');
    const around = (tag) => `<${tag} wrapText="${esc(side)}">${el('wp:wrapPolygon', { edited: L.polyEdited ? 1 : 0 }, points)}</${tag}>`;
    const wrap = { square: `<wp:wrapSquare wrapText="${esc(side)}"/>`, tight: around('wp:wrapTight'), through: around('wp:wrapThrough'), topBottom: '<wp:wrapTopAndBottom/>' }[L.wrap] ?? '<wp:wrapNone/>';
    return `<w:drawing>${el('wp:anchor', { distT: ptToEmu(d.t ?? 0), distB: ptToEmu(d.b ?? 0), distL: ptToEmu(d.l ?? 9), distR: ptToEmu(d.r ?? 9), simplePos: 0,
      relativeHeight: 251658240 + (L.z ?? 0), behindDoc: L.wrap === 'behind' || (L.wrap !== 'front' && L.behindDoc) ? 1 : 0, locked: L.lockAnchor ? 1 : 0, layoutInCell: 1, allowOverlap: L.allowOverlap === false ? 0 : 1 },
    `<wp:simplePos x="0" y="0"/>${pos('H', L.h)}${pos('V', L.v)}${el('wp:extent', { cx, cy })}<wp:effectExtent l="0" t="0" r="0" b="0"/>${wrap}${pr}${frame}${graphic}${relSizeXml(L.relSize, cx, cy)}`)}</w:drawing>`;
  };

  /** A writer for one part (document, header, footer, notes, comments): its rels and its block XML. */
  function writer(relsOf) {
    const own = [];
    const w = {
      rel: (type, target, mode) => {
        const id = `rId${own.length + 1}`;
        own.push({ id, type: /^https?:/.test(type) ? type : RT + type, target, mode });
        return id;
      },
      rels: own,
    };
    if (relsOf === 'document') w.rel = rel, w.rels = rels;
    let open = new Set(); // comments open at this point of the text
    // Text box runs waiting for the paragraph after them, which they anchor to (import.mjs reads a box before its paragraph).
    let boxes = '';
    const flushBoxes = () => {
      const x = boxes;
      boxes = '';
      return x ? `<w:p>${x}</w:p>` : '';
    };

    const t = (s) => esc(s).split('\t').map((p) => (p ? `<w:t xml:space="preserve">${p}</w:t>` : '')).join('<w:tab/>');
    const delT = (s) => esc(s).split('\t').map((p) => (p ? `<w:delText xml:space="preserve">${p}</w:delText>` : '')).join('<w:tab/>');
    const rev = (r) => ({ 'w:id': ++revId, 'w:author': r.author ?? 'EasyWriter', 'w:date': r.date ?? null });

    /** A run of `inner` with the run properties of `marks`, wrapped in its revision and hyperlink. */
    const run = (inner, marks, { deleted } = {}) => {
      const r = runOf(marks);
      const change = r.fmt ? el('w:rPrChange', rev(r.fmt), rPr(runOf(r.fmt.old ?? []).props) || '<w:rPr/>') : '';
      let xml = `<w:r>${rPr(r.props, change)}${deleted && r.del ? inner.replace(/<w:t /g, '<w:delText ').replace(/<\/w:t>/g, '</w:delText>') : inner}</w:r>`;
      if (r.ins) xml = el(r.ins.move ? 'w:moveTo' : 'w:ins', rev(r.ins), xml);
      if (r.del) xml = el(r.del.move ? 'w:moveFrom' : 'w:del', rev(r.del), xml);
      if (r.link && (r.link.href || r.link.anchor)) {
        if (r.link.href && !hrefs.has(`${relsOf}:${r.link.href}`)) hrefs.set(`${relsOf}:${r.link.href}`, w.rel('hyperlink', r.link.href, 'External'));
        // w:history: Word puts every link it inserts in the list of visited links, and writes so on each one.
        xml = el('w:hyperlink', { 'r:id': r.link.href ? hrefs.get(`${relsOf}:${r.link.href}`) : null, 'w:anchor': r.link.anchor, 'w:tgtFrame': r.link.frame,
          'w:tooltip': r.link.tooltip, 'w:history': 1 }, xml);
      }
      return xml;
    };
    // Comment ranges: a start before the first run that carries the comment, an end and the reference after its last.
    const commentsAt = (marks) => {
      const now = new Set((marks ?? []).filter((m) => m.type === 'comment').flatMap((m) => [m.attrs.id, ...(replies.get(m.attrs.id) ?? [])]));
      let out = '';
      for (const id of open) if (!now.has(id)) out += close(id);
      for (const id of now) if (!open.has(id)) out += el('w:commentRangeStart', { 'w:id': commentId(id) });
      open = now;
      return out;
    };
    const close = (id) => `${el('w:commentRangeEnd', { 'w:id': commentId(id) })}<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>${el('w:commentReference', { 'w:id': commentId(id) })}</w:r>`;
    const closeAll = () => {
      const out = [...open].map(close).join('');
      open = new Set();
      return out;
    };

    async function inline(n) {
      const m = n.marks ?? [];
      switch (n.type) {
        case 'text': return commentsAt(m) + run(runOf(m).del ? delT(n.text) : t(n.text), m);
        case 'hardBreak': return commentsAt(m) + run(el('w:br', { 'w:clear': n.attrs?.clear ?? null }), m);
        case RENDERED: return '<w:r><w:lastRenderedPageBreak/></w:r>';
        case 'image': {
          const a = n.attrs ?? {};
          // A metafile from a .docx goes back out as itself, not as the PNG it shows.
          const src = a.metafile ?? a.src;
          const pic = src ? (imageCache.get(src) ?? await media(src)) : null;
          if (!pic) { dropped.add('pictures that could not be read'); return ''; }
          imageCache.set(src, pic);
          const [pw, ph] = [a.width ?? a.orig?.w ?? 200, a.height ?? a.orig?.h ?? 150];
          // An SVG goes out beside a PNG of it, as Word writes one: Word's own while it still belongs to this SVG, else one drawn here
          // (none in Node, where it goes alone).
          const fb = heldFallback(a);
          const png = /^data:image\/svg\+xml/.test(src) && (fb ? imageCache.get(fb) ?? await media(fb) : await drawnMedia(src));
          if (png && fb) imageCache.set(fb, png);
          const picture = png ? drawing(addImage(w, png), pw, ph, a, null, addImage(w, pic)) : drawing(addImage(w, pic), pw, ph, a);
          if (!a.ink) return commentsAt(m) + run(picture, m);
          // Ink goes back as Word writes it: its ink part for Word 2010 and later, the picture for older readers.
          const choice = drawing(null, pw, ph, a, inkPart(w, a.ink));
          return commentsAt(m) + run(`<mc:AlternateContent><mc:Choice Requires="wpi">${choice}</mc:Choice><mc:Fallback>${picture}</mc:Fallback></mc:AlternateContent>`, m);
        }
        case 'field': {
          const a = n.attrs ?? {};
          const begin = el('w:fldChar', { 'w:fldCharType': 'begin', 'w:fldLock': a.locked ? 1 : null, 'w:dirty': a.dirty ? 1 : null }, ffData(a.ff, a.code));
          // A result whose runs differ writes each with its own formatting under the field's (fields-core runs.mjs).
          const runs = validRuns(a);
          const result = runs ? runs.map((r) => run(t(r.text), runMarks(m, r))).join('') : a.result ? run(t(a.result), m) : '';
          return commentsAt(m) + run(begin, m) + run(`<w:instrText xml:space="preserve"> ${esc(a.code)} </w:instrText>`, m)
            // A field with no result has no separator, as Word writes one never updated.
            + (a.result == null ? '' : run('<w:fldChar w:fldCharType="separate"/>', m) + result) + run('<w:fldChar w:fldCharType="end"/>', m);
        }
        case 'bookmark': {
          const a = n.attrs ?? {};
          const id = markId(`bm:${a.id || a.name}`);
          return a.end ? el('w:bookmarkEnd', { 'w:id': id }) : el('w:bookmarkStart', { 'w:id': id, 'w:name': a.name });
        }
        case 'noteRef': {
          const a = n.attrs ?? {};
          const kind = a.kind === 'endnote' ? 'endnote' : 'footnote';
          const id = notes[kind].length + 1;
          notes[kind].push({ id, content: a.content ?? [], mark: a.mark });
          const ref = el(`w:${kind}Reference`, { 'w:id': id, 'w:customMarkFollows': a.mark ? 1 : null });
          const style = `<w:rPr><w:rStyle w:val="${kind === 'endnote' ? 'EndnoteReference' : 'FootnoteReference'}"/></w:rPr>`;
          return commentsAt(m) + `<w:r>${style}${ref}</w:r>` + (a.mark ? `<w:r>${style}${t(a.mark)}</w:r>` : '');
        }
        case 'equation': {
          const a = n.attrs ?? {};
          // A .docx equation's own OMML goes back while it keeps the form it came in (import.mjs equationOf). Else one shown in
          // linear form is its text, as Word saves it, and any other is built from its math (equations omml.mjs).
          const o = a.omml;
          const math = o?.xml && o.math === a.math && !o.linear === !a.linear ? o.xml
            : a.linear ? `<m:oMath><m:r><m:t xml:space="preserve">${esc(a.math)}</m:t></m:r></m:oMath>` : writeOmml(parseMath(a.math ?? ''));
          // The model's default 'center' is a paragraph without m:jc (Word centres it as a group), so only another value writes one.
          const jc = a.align && a.align !== 'center' ? `<m:oMathParaPr><m:jc m:val="${esc(a.align)}"/></m:oMathParaPr>` : '';
          return commentsAt(m) + (a.display ? `<m:oMathPara>${jc}${math}</m:oMathPara>` : math);
        }
        case 'ruby': {
          const a = n.attrs ?? {};
          const size = ptToHalfPoints(a.size ?? 5);
          // The base text's size: its own, else the Normal style's (Word's 10 pt when nothing sets one). The guide's font is for every script.
          const base = runOf(m).props.size ?? attrs.styles?.list?.Normal?.run?.size ?? attrs.styles?.defaults?.run?.size ?? 10;
          return commentsAt(m) + run(`<w:ruby><w:rubyPr>${val('w:rubyAlign', a.align ?? 'distributeSpace')}${val('w:hps', size)}${val('w:hpsRaise', ptToHalfPoints(a.offset ?? 10))}${val('w:hpsBaseText', ptToHalfPoints(base))}${val('w:lid', a.lang ?? 'ja-JP')}</w:rubyPr>`
            // ponytail: one hint for the guide and base runs, which Word gives the same one; a file whose runs differ keeps the guide's.
            + `<w:rt><w:r>${rPr({ size: size / 2, font: a.font, fontEA: a.font, hint: a.hint })}${t(a.text)}</w:r></w:rt><w:rubyBase><w:r>${rPr(a.hint ? { hint: a.hint } : null)}${t(a.base)}</w:r></w:rubyBase></w:ruby>`, m);
        }
        case 'ptab': {
          const a = n.attrs ?? {};
          return commentsAt(m) + run(el('w:ptab', { 'w:alignment': a.align ?? 'center', 'w:relativeTo': a.relativeTo ?? 'margin', 'w:leader': a.leader ?? 'none' }), m);
        }
        case 'sdtInline': return commentsAt(m) + el('w:sdt', {}, sdtPr(n.attrs?.sdt) + el('w:sdtContent', {}, await inlines(n.content)));
        case 'chart': { // its parts go back as they came (chart/parts.mjs), a chartex inside the mc:AlternateContent Word writes
          const a = n.attrs ?? {};
          const c = writeChart(a.parts, (p) => parts.has(p), (p, bytes, type) => { parts.set(p, bytes); if (type) types.set(`/${p}`, type); });
          if (!c) { dropped.add('charts'); return ''; }
          docPr += 1;
          const rid = w.rel(c.rel, c.target.startsWith('word/') ? c.target.slice(5) : `../${c.target}`);
          const xml = placed(ptToEmu(a.w ?? 360), ptToEmu(a.h ?? 216), el('wp:docPr', { id: docPr, name: a.name ?? `Chart ${docPr}`, descr: a.alt || null }), c.graphic(rid), a.layout);
          return commentsAt(m) + run(a.parts.kind === 'cx' ? `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" Requires="cx">${xml}</mc:Choice></mc:AlternateContent>` : xml, m);
        }
        default: dropped.add(n.type); return '';
      }
    }
    async function inlines(list = []) {
      let out = '';
      for (const n of list) out += await inline(n);
      return out;
    }
    const sdtPr = (s = {}) => {
      const sym = (c) => (c ?? '').codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0');
      const kind = { text: el('w:text', { 'w:multiLine': s.multiLine ? 1 : null }), picture: '<w:picture/>',
        date: el('w:date', { 'w:fullDate': s.date?.full ?? null }, val('w:dateFormat', s.date?.format) + val('w:lid', s.date?.lang) + val('w:storeMappedDataAs', s.date?.store)
          + val('w:calendar', s.date?.calendar)),
        comboBox: el('w:comboBox', {}, (s.items ?? []).map((i) => el('w:listItem', { 'w:displayText': i.display, 'w:value': i.value })).join('')),
        dropDown: el('w:dropDownList', {}, (s.items ?? []).map((i) => el('w:listItem', { 'w:displayText': i.display, 'w:value': i.value })).join('')),
        docPart: el('w:docPartObj', {}, val('w:docPartGallery', s.docPart?.gallery) + (s.docPart?.category ? val('w:docPartCategory', s.docPart.category) : '') + '<w:docPartUnique/>'),
        citation: '<w:citation/>', bibliography: '<w:bibliography/>', group: '<w:group/>',
        checkbox: el('w14:checkbox', {}, el('w14:checked', { 'w14:val': s.checked ? 1 : 0 }) + el('w14:checkedState', { 'w14:val': sym(s.checkedChar ?? '☒') })
          + el('w14:uncheckedState', { 'w14:val': sym(s.uncheckedChar ?? '☐') })),
        repeating: el('w15:repeatingSection', {}, val('w15:sectionTitle', s.repeat?.title) + (s.repeat?.allowAddRemove === false ? val('w15:doNotAllowInsertDeleteSection', 1) : '')),
        repeatingItem: '<w15:repeatingSectionItem/>' }[s.type] ?? '';
      return el('w:sdtPr', {}, (s.style ? el('w:rPr', {}, val('w:rStyle', s.style)) : '') + val('w:alias', s.title) + val('w:tag', s.tag) + val('w:id', sdtId(s.id))
        + (s.lock && s.lock !== 'none' ? val('w:lock', s.lock) : '') + (s.placeholderPart ? el('w:placeholder', {}, val('w:docPart', s.placeholderPart)) : '')
        + (s.temporary ? '<w:temporary/>' : '') + (s.showingPlaceholder ? '<w:showingPlcHdr/>' : '') + dataBinding(s.binding) + (s.color ? val('w15:color', hex(s.color)) : '')
        + (s.appearance && s.appearance !== 'boundingBox' ? el('w15:appearance', { 'w15:val': s.appearance }) : '') + kind)
        // The control's end mark's run properties (w:sdtEndPr), as Word wrote them.
        + (s.endRun ? el('w:sdtEndPr', {}, rPr(s.endRun)) : '');
    };

    /** A paragraph or heading node → w:p. `pre` and `post` are runs added at its start and end (a fieldBlock's field characters). */
    async function paragraph(n, { pre = '', post = '', sect = '' } = {}) {
      const a = n.attrs ?? {};
      const styleId = n.type === 'heading' ? a.styleId ?? `Heading${a.level ?? 1}` : a.styleId;
      const mr = rPr(a.markRun ?? null, a.markRev ? (a.markRev.ins ? el('w:ins', rev(a.markRev.ins)) : '') + (a.markRev.del ? el('w:del', rev(a.markRev.del)) : '') : '');
      const change = a.pChange ? el('w:pPrChange', rev(a.pChange), pPr(a.pChange.old ?? {}, { numId }) || '<w:pPr/>') : '';
      const props = pPr(a, { styleId, sect, markRun: mr, numId });
      const withChange = change ? (props ? props.replace(/<\/w:pPr>$/, `${change}</w:pPr>`) : el('w:pPr', {}, change)) : props;
      const lead = boxes;
      boxes = '';
      return `<w:p>${withChange}${lead}${pre}${await inlines(n.content)}${post}</w:p>`;
    }

    /** A row's table property exceptions (tableRow tblPrEx) as w:tblPrEx, in the schema's order. */
    const tblPrEx = (x) => (!x ? '' : el('w:tblPrEx', {}, (x.width ? tblW(x.width) : '') + tblJc(x.align)
      + (x.cellSpacing != null ? el('w:tblCellSpacing', { 'w:w': tw(x.cellSpacing), 'w:type': 'dxa' }) : '') + (x.indent != null ? el('w:tblInd', { 'w:w': tw(x.indent), 'w:type': 'dxa' }) : '')
      + borders('w:tblBorders', x.borders, [['top'], ['left'], ['bottom'], ['right'], ['insideH'], ['insideV']]) + (x.layout ? el('w:tblLayout', { 'w:type': x.layout }) : '')
      + cellMar(x.cellMargin)));

    async function table(n) {
      const a = n.attrs ?? {};
      const rows = n.content ?? [];
      // Lay the cells on a grid: a rowspan covers the rows below, where Word writes a continuing w:vMerge cell.
      const covered = new Map(); // `${row}:${col}` → {colspan, cell}
      const grid = [];
      const widths = [];
      rows.forEach((row, r) => {
        let c = 0;
        const out = [];
        for (const cell of row.content ?? []) {
          while (covered.has(`${r}:${c}`)) { const x = covered.get(`${r}:${c}`); out.push({ cont: x }); c += x.colspan; }
          const ca = cell.attrs ?? {};
          const span = ca.colspan ?? 1;
          (ca.colwidth ?? []).forEach((wd, k) => { if (wd && !widths[c + k]) widths[c + k] = wd; });
          out.push({ cell, colspan: span, rowspan: ca.rowspan ?? 1 });
          for (let k = 1; k < (ca.rowspan ?? 1); k++) covered.set(`${r + k}:${c}`, { colspan: span, cell });
          c += span;
        }
        while (covered.has(`${r}:${c}`)) { const x = covered.get(`${r}:${c}`); out.push({ cont: x }); c += x.colspan; }
        grid.push(out);
      });
      const cols = Math.max(0, ...grid.map((row) => row.reduce((s, x) => s + (x.cont ? x.cont.colspan : x.colspan), 0)));
      const cellPr = (ca, span, merge) => {
        const w = ca.colwidth?.length ? ca.colwidth.reduce((s, x) => s + (x ?? 0), 0) : 0;
        return el('w:tcPr', {}, (w ? el('w:tcW', { 'w:w': ptToTwips(w * 0.75), 'w:type': 'dxa' }) : '') + (span > 1 ? val('w:gridSpan', span) : '') + merge
          + borders('w:tcBorders', ca.borders, [['top'], ['left'], ['bottom'], ['right'], ['tl2br'], ['tr2bl']]) + shading(typeof ca.shading === 'string' ? { fill: ca.shading } : ca.shading) + onOff('w:noWrap', ca.noWrap)
          + (ca.margins ? el('w:tcMar', {}, ['top', 'left', 'bottom', 'right'].map((k) => (ca.margins[k] == null ? '' : el(`w:${k}`, { 'w:w': tw(ca.margins[k]), 'w:type': 'dxa' }))).join('')) : '')
          + val('w:textDirection', ca.textDir) + onOff('w:tcFitText', ca.fitText) + val('w:vAlign', ca.vAlign) + onOff('w:hideMark', ca.hideMark));
      };
      let body = '';
      const colTw = (i) => (widths[i] ? ptToTwips(widths[i] * 0.75) : Math.round(9026 / Math.max(1, cols)));
      for (const [r, row] of rows.entries()) {
        const ra = row.attrs ?? {};
        // A row short of the grid ends in w:gridAfter columns of w:wAfter twips, and each row repeats its table's cell spacing and
        // its centre or right alignment (w:jc), as Word writes them.
        const used = grid[r].reduce((s, x) => s + (x.cont ? x.cont.colspan : x.colspan), 0);
        const after = used < cols ? val('w:gridAfter', cols - used) + el('w:wAfter', { 'w:w': Array.from({ length: cols - used }, (_, k) => colTw(used + k)).reduce((s, x) => s + x, 0), 'w:type': 'dxa' }) : '';
        const trPr = after + onOff('w:cantSplit', ra.cantSplit) + (ra.height?.value ? el('w:trHeight', { 'w:val': tw(ra.height.value), 'w:hRule': ra.height.rule === 'exact' ? 'exact' : 'atLeast' }) : '')
          + onOff('w:tblHeader', ra.header || (r === 0 && row.content?.every((c) => c.type === 'tableHeader')) || null)
          + (a.cellSpacing ? el('w:tblCellSpacing', { 'w:w': tw(a.cellSpacing), 'w:type': 'dxa' }) : '') + (a.align === 'center' || a.align === 'right' ? val('w:jc', a.align) : '')
          + (ra.rev?.ins ? el('w:ins', rev(ra.rev.ins)) : '') + (ra.rev?.del ? el('w:del', rev(ra.rev.del)) : '');
        let cells = '';
        for (const x of grid[r]) {
          if (x.cont) cells += `<w:tc>${cellPr(x.cont.cell.attrs ?? {}, x.cont.colspan, '<w:vMerge/>')}<w:p/></w:tc>`;
          else cells += `<w:tc>${cellPr(x.cell.attrs ?? {}, x.colspan, x.rowspan > 1 ? '<w:vMerge w:val="restart"/>' : '')}${await blocks(x.cell.content, { cell: true })}</w:tc>`;
        }
        body += `<w:tr>${tblPrEx(ra.tblPrEx)}${trPr ? el('w:trPr', {}, trPr) : ''}${cells}</w:tr>`;
      }
      const look = a.look ?? {};
      const f = a.float;
      // tblLook's flags also as w:val, the bit mask Word writes beside them (ECMA-376 1st edition).
      const bits = (look.firstRow ? 0x20 : 0) | (look.lastRow ? 0x40 : 0) | (look.firstColumn ? 0x80 : 0) | (look.lastColumn ? 0x100 : 0) | (look.noHBand ? 0x200 : 0) | (look.noVBand === false ? 0 : 0x400);
      const tblPr = el('w:tblPr', {}, val('w:tblStyle', a.styleId) + (f ? el('w:tblpPr', { 'w:leftFromText': tw(f.dist?.l), 'w:rightFromText': tw(f.dist?.r), 'w:topFromText': tw(f.dist?.t),
        'w:bottomFromText': tw(f.dist?.b), 'w:horzAnchor': f.hAnchor, 'w:vertAnchor': f.vAnchor, 'w:tblpX': tw(f.x), 'w:tblpY': tw(f.y), 'w:tblpXSpec': f.xAlign, 'w:tblpYSpec': f.yAlign })
        + (f.overlap === false ? val('w:tblOverlap', 'never') : '') : '')
        + onOff('w:bidiVisual', a.bidiVisual)
        + tblW(a.width) + tblJc(a.align) + (a.cellSpacing ? el('w:tblCellSpacing', { 'w:w': tw(a.cellSpacing), 'w:type': 'dxa' }) : '')
        + (a.indent ? el('w:tblInd', { 'w:w': tw(a.indent), 'w:type': 'dxa' }) : '')
        + borders('w:tblBorders', a.borders, [['top'], ['left'], ['bottom'], ['right'], ['insideH'], ['insideV']]) + (a.layout === 'fixed' ? '<w:tblLayout w:type="fixed"/>' : '')
        + cellMar(a.cellMargin)
        + el('w:tblLook', { 'w:val': bits.toString(16).toUpperCase().padStart(4, '0'), 'w:firstRow': look.firstRow ? 1 : 0, 'w:lastRow': look.lastRow ? 1 : 0, 'w:firstColumn': look.firstColumn ? 1 : 0, 'w:lastColumn': look.lastColumn ? 1 : 0,
          'w:noHBand': look.noHBand ? 1 : 0, 'w:noVBand': look.noVBand === false ? 0 : 1 })
        + val('w:tblCaption', a.caption) + val('w:tblDescription', a.description));
      const gridXml = el('w:tblGrid', {}, Array.from({ length: cols }, (_, i) => el('w:gridCol', { 'w:w': colTw(i) })).join(''));
      return `<w:tbl>${tblPr}${gridXml}${body}</w:tbl>`;
    }

    /** Block list → XML. In a cell the list must end with a paragraph. `sections` writes each section break's sectPr. A text box
     * left at the list's end gets a paragraph of its own. */
    async function blocks(list = [], { cell = false } = {}) {
      let out = '';
      for (const n of list) out += await block(n);
      out += flushBoxes();
      // A cell, header or note ends with a paragraph.
      if (cell && !out.endsWith('</w:p>') && !out.endsWith('<w:p/>')) out += '<w:p/>';
      return out;
    }
    async function block(n) {
      const a = n.attrs ?? {};
      if (boxes && !waits(n)) return flushBoxes() + await block(n);
      switch (n.type) {
        case 'paragraph': case 'heading': return await paragraph(n);
        case 'table': return await table(n);
        case 'pageBreak': return emptyRun('<w:br w:type="page"/>');
        case 'columnBreak': return emptyRun('<w:br w:type="column"/>');
        // A section's own sectPr: its w:type is how it starts, which the break before it holds (the model mirrors it in sect.type).
        case 'sectionBreak': return emptyP(await sectPr(a.sect));
        case 'columns': return await columns(n);
        case 'sdtBlock': return el('w:sdt', {}, sdtPr(a.sdt) + el('w:sdtContent', {}, await blocks(n.content)));
        case 'fieldBlock': {
          const kids = n.content ?? [];
          const begin = `<w:r>${el('w:fldChar', { 'w:fldCharType': 'begin', 'w:fldLock': a.locked ? 1 : null, 'w:dirty': a.dirty ? 1 : null })}</w:r><w:r><w:instrText xml:space="preserve"> ${esc(a.code)} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`;
          const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
          let out = '';
          for (const [i, k] of kids.entries()) {
            const isP = k.type === 'paragraph' || k.type === 'heading';
            const pre = i === 0 ? begin : '';
            const post = i === kids.length - 1 ? end : '';
            out += isP ? await paragraph(k, { pre, post }) : (pre ? `<w:p>${pre}</w:p>` : '') + await block(k) + (post ? `<w:p>${post}</w:p>` : '');
          }
          return out || `<w:p>${begin}${end}</w:p>`;
        }
        case 'textBox': {
          const held = boxes; // its own paragraphs must not take the boxes before it
          boxes = '';
          // Word keeps a linked story in its first box: this box's text, then each later box's own (empty unless typed into).
          const story = stories.get(n);
          let inner = story?.seq ? '' : await blocks(n.content, { cell: true });
          for (const b of story?.after ?? []) if (!emptyBox(b)) inner += await blocks(b.content, { cell: true });
          // A texture or picture fill's picture (one of our own textures drawn here, as the page background's is).
          const f = a.fill;
          const fp = f?.kind === 'texture' || f?.kind === 'picture' ? (f.src ? await media(f.src) : f.kind === 'texture' ? await drawnMedia(textureCss(f).image.slice(5, -2)) : null) : null;
          boxes = held + drawRun(textBoxDrawing(a, inner, fp ? addImage(w, fp) : null, story), a.run);
          return '';
        }
        case 'canvas': case 'planChart': {
          // A canvas goes out as Word shapes (shapes-out.mjs): its shapes, its pictures as themselves (a metafile as the original,
          // an SVG beside a PNG of it), its pen strokes as Word ink and its text items as text boxes. It rides in STASH too so this
          // app reopens it whole. A canvas holding an item Word has no form for (shapes-out.mjs wordItem), a picture that cannot
          // be read, or an SVG no PNG can be made of (outside a browser, with no PNG kept from Word), goes out as a picture.
          const pics = new Map();
          for (const it of n.type === 'canvas' && shapeCanvas(a) ? a.items : []) if (it.type === 'image') pics.set(it.id, await canvasPicture(it));
          const image = (it) => { const p = pics.get(it.id); return { rid: addImage(w, p.png ?? p.pic), svg: p.png ? addImage(w, p.pic) : null }; };
          const shapes = n.type === 'canvas' && [...pics.values()].every(Boolean) && shapeDrawing(a, { id: () => ++docPr, placed, image, ink: (xml) => inkPart(w, xml) });
          if (shapes) {
            const { suggest, ...attrs } = a;
            kept[shapes.id] = { type: n.type, attrs };
            if (shapes.floating) { boxes += drawRun(shapes.xml, a.run); return ''; }
            return `<w:p>${drawRun(shapes.xml, a.run)}</w:p>`;
          }
          const pic = await picture(n);
          if (!pic) { dropped.add(n.type === 'canvas' ? 'canvases' : 'plan charts'); return ''; }
          const xml = drawing(addImage(w, pic), pic.w, pic.h, { name: n.type === 'canvas' ? 'Canvas' : 'Plan chart', alt: a.docPr?.alt, decorative: a.docPr?.decorative, layout: a.layout });
          const { suggest, ...attrs } = a;
          kept[docPr] = { type: n.type, attrs };
          return `<w:p>${drawRun(xml, a.run)}</w:p>`;
        }
        default: dropped.add(n.type); return '';
      }
    }
    const emptyRun = (inner) => `<w:p><w:r>${inner}</w:r></w:p>`;
    // The run of a block's drawing (a text box, a canvas) with the run properties the block keeps (import.mjs drawingOf).
    const drawRun = (xml, props) => `<w:r>${rPr(props ?? null)}${xml}</w:r>`;
    // Comments still open at a paragraph's end stay open into the next one; closeAll ends the rest at the end of the part.
    w.paragraph = paragraph;
    w.blocks = blocks;
    w.block = block;
    w.flushBoxes = flushBoxes;
    w.closeAll = closeAll;
    /** Runs that open the part's first paragraph (a header's watermark), as waiting text boxes do. */
    w.lead = (x) => { boxes += x; };
    return w;
  }

  // ---------- watermarks ----------
  let watermarks = 0;
  /**
   * Watermark `wm` (sect.watermark) of section `s` as the run Word's Printed Watermark dialog puts in a header (written by `wr`):
   * a VML shape centred on the margins and behind the text. Text: a text path PowerPlusWaterMarkObject as high as the size (Auto:
   * the size the page draws) and as wide as the text, turned 315 degrees when diagonal, 50 % opaque when semitransparent.
   * Picture: WordPictureWatermark at its scale of its own size at 96 dpi (Auto: fitted to the margins), with Word's washout.
   */
  async function watermarkXml(wm, s, wr) {
    const m = s.margin ?? {};
    const box = { w: (s.w ?? 595.3) - (m.left ?? 72) - (m.right ?? 72) - (m.gutter ?? 0), h: (s.h ?? 841.9) - (m.top ?? 72) - (m.bottom ?? 72) };
    const r2 = (x) => Math.round(x * 100) / 100;
    const style = (w, h, rot = '') => `position:absolute;margin-left:0;margin-top:0;width:${r2(w)}pt;height:${r2(h)}pt;${rot}z-index:-251657216;`
      + 'mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin';
    const shape = (id, type, a, inner) => `<w:r><w:rPr><w:noProof/></w:rPr><w:pict>${type}${el('v:shape', { id: `${id}${++watermarks}`, 'o:spid': `_x0000_s${2048 + watermarks}`,
      type: `#${/id="([^"]+)"/.exec(type)[1]}`, ...a, 'o:allowincell': 'f' }, `${inner}<w10:wrap anchorx="margin" anchory="margin"/>`)}</w:pict></w:r>`;
    if (wm.kind === 'picture') {
      const pic = wm.src ? await media(wm.src) : null;
      if (!pic) { dropped.add('watermark pictures that could not be read'); return ''; }
      const px = imageSize(pic.bytes) ?? { w: box.w, h: box.h };
      const k = wm.scale ? (wm.scale / 100) * 0.75 : Math.min(box.w / px.w, box.h / px.h);
      const wash = wm.washout !== false;
      return shape('WordPictureWatermark', PICTURE_TYPE, { style: style(px.w * k, px.h * k) },
        el('v:imagedata', { 'r:id': addImage(wr, pic), 'o:title': '', gain: wash ? '19661f' : null, blacklevel: wash ? '22938f' : null }));
    }
    if (!wm.text) return '';
    const theme = /^\+(major|minor)$/.exec(wm.font ?? '+minor')?.[1];
    const font = theme ? attrs.theme?.fonts?.[theme] ?? 'Calibri' : wm.font;
    const per = textWidth(wm.text, font);
    const layout = wm.layout === 'horizontal' ? 'horizontal' : 'diagonal';
    const size = wm.size ?? autoWatermarkSize(per, box.w, box.h, layout);
    return shape('PowerPlusWaterMarkObject', TEXT_TYPE, { style: style(size * per, size, layout === 'diagonal' ? 'rotation:315;' : ''), fillcolor: wm.color || '#000000', stroked: 'f' },
      (wm.semi === false ? '' : '<v:fill opacity=".5"/>') + el('v:textpath', { style: `font-family:"${font}";font-size:1pt`, string: wm.text }));
  }

  // ---------- sections ----------
  const hfParts = [];
  // The header of each kind in force with its watermark ([content, watermark]), as sections link them: a section whose watermark
  // differs from the one a linked header would show gets that header's content as its own, with its own watermark.
  const linked = { default: [null, null], first: [null, null], even: [null, null] };
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  /** w:sectPr of `sect`, starting as `kind` (its own type). Headers and footers become their parts; a watermark goes in each header. */
  async function sectPr(sect, kind, cols = null) {
    const s = sect ?? {};
    let refs = '';
    // In Word's order (even, default, then first), which is also the order Word numbers the parts in, so a file that comes back
    // keeps each header and footer under its own part name.
    for (const [key, part] of [['hdr', 'even'], ['hdr', 'default'], ['ftr', 'even'], ['ftr', 'default'], ['hdr', 'first'], ['ftr', 'first']]) {
      const tag = key === 'hdr' ? 'header' : 'footer';
      const v = s[key]?.[part];
      let content = Array.isArray(v) ? v : v?.content;
      const wm = key === 'hdr' ? s.watermark ?? null : null;
      if (key === 'hdr') {
        const shown = part === 'default' || (part === 'first' ? s.titlePg : attrs.settings?.evenAndOddHeaders);
        if (!content && shown && !same(wm, linked[part][1])) content = linked[part][0] ?? [{ type: 'paragraph' }];
        if (content) linked[part] = [content, wm];
      }
      if (!content) continue;
      const n = hfParts.filter((h) => h.tag === tag).length + 1;
      const name = `${tag}${n}.xml`;
      const wr = writer(name);
      if (wm) wr.lead(await watermarkXml(wm, s, wr));
      const xml = await wr.blocks(content, { cell: true }) + '';
      hfParts.push({ tag, name, xml: xml.replace(/<\/w:p>$/, `${wr.closeAll()}</w:p>`), rels: wr.rels });
      refs += el(`w:${tag}Reference`, { 'w:type': part, 'r:id': rel(tag, name) });
      types.set(`/word/${name}`, `${CT}${tag}+xml`);
    }
    const m = s.margin ?? {};
    const pg = s.pgNum ?? {};
    const ln = s.lnNum;
    const colsXml = cols ? el('w:cols', { 'w:num': cols.count ?? 2, 'w:space': tw(cols.space ?? 36), 'w:sep': cols.sep ? 1 : null, 'w:equalWidth': cols.equal === false ? 0 : 1 },
      cols.equal === false && cols.widths ? cols.widths.map((c) => el('w:col', { 'w:w': tw(c.w), 'w:space': tw(c.space ?? 0) })).join('') : '')
      // One column keeps the spacing Word wrote for it (sect.colSpace), the gap a later change to more columns starts from.
      : s.colSpace != null ? el('w:cols', { 'w:space': tw(s.colSpace) }) : '';
    const pb = s.pgBorders;
    // An art border's w:sz is in points (ECMA-376 §17.3.4): its width goes to border() in eighths' terms.
    const pageEdge = (e) => (e?.width != null && !BORDER_STYLES.includes(e.style ?? 'single') ? { ...e, width: e.width / 8 } : e);
    // Word 2019's footnote columns (w15) go in a section that declares w15 ignorable, as older readers do not know it.
    return el('w:sectPr', s.footnotePr?.columns ? { 'xmlns:w15': NS.w15, 'mc:Ignorable': 'w15' } : {}, refs + notePrXml('footnote', s.footnotePr) + notePrXml('endnote', s.endnotePr) + val('w:type', kind ?? s.type ?? null)
      + el('w:pgSz', { 'w:w': tw(s.w ?? 595.3), 'w:h': tw(s.h ?? 841.9), 'w:orient': s.orient === 'landscape' ? 'landscape' : null })
      + el('w:pgMar', { 'w:top': tw(m.top ?? 72), 'w:right': tw(m.right ?? 72), 'w:bottom': tw(m.bottom ?? 72), 'w:left': tw(m.left ?? 72), 'w:header': tw(m.header ?? 35.4), 'w:footer': tw(m.footer ?? 35.4), 'w:gutter': tw(m.gutter ?? 0) })
      + (pb ? el('w:pgBorders', { 'w:offsetFrom': pb.offsetFrom, 'w:display': pb.display, 'w:zOrder': pb.zOrder }, ['top', 'left', 'bottom', 'right'].map((k) => border(`w:${k}`, pageEdge(pb[k]))).join('')) : '')
      + (ln ? el('w:lnNumType', { 'w:countBy': ln.countBy, 'w:start': ln.start, 'w:distance': tw(ln.distance), 'w:restart': ln.restart }) : '')
      + ((pg.fmt && pg.fmt !== 'decimal') || pg.start != null || pg.chapStyle ? el('w:pgNumType', { 'w:fmt': pg.fmt && pg.fmt !== 'decimal' ? pg.fmt : null, 'w:start': pg.start, 'w:chapStyle': pg.chapStyle, 'w:chapSep': pg.chapStyle ? pg.chapSep : null }) : '')
      + colsXml + onOff('w:formProt', s.formProt || null) + (s.vAlign && s.vAlign !== 'top' ? val('w:vAlign', s.vAlign) : '') + onOff('w:noEndnote', s.noEndnote || null)
      + onOff('w:titlePg', s.titlePg || null) + (s.textDir && s.textDir !== 'lrTb' ? val('w:textDirection', s.textDir) : '') + onOff('w:bidi', s.bidi || null)
      + (s.docGrid ? el('w:docGrid', { 'w:type': s.docGrid.type, 'w:linePitch': tw(s.docGrid.linePitch), 'w:charSpace': s.docGrid.charSpace }) : '')
      + (s.footnotePr?.columns ? val('w15:footnoteColumns', s.footnotePr.columns) : ''));
  }

  // The body: each top-level block, a columns node as its own continuous section. The section before it ends in an empty paragraph,
  // and the section after starts continuous.
  const main = writer('document');
  const top = doc.content ?? [];
  const sectAfter = []; // the sect of the section holding each top-level block
  let cur = attrs.sect;
  for (let i = top.length - 1; i >= 0; i--) {
    if (top[i].type === 'sectionBreak') cur = top[i].attrs?.sect ?? cur;
    sectAfter[i] = cur;
  }
  let continuousNext = false;
  async function columns(n) {
    const i = top.indexOf(n);
    const sect = sectAfter[i] ?? attrs.sect;
    const prev = top[i - 1];
    const before = i > 0 && prev?.type !== 'sectionBreak' && prev?.type !== 'columns' ? emptyP(await sectPr(sect, continuousNext ? 'continuous' : sect?.type ?? 'nextPage')) : '';
    continuousNext = false;
    const inner = await main.blocks(n.content);
    const a = n.attrs ?? {};
    const end = emptyP(await sectPr({ ...sect, hdr: null, ftr: null }, 'continuous', { count: a.count, space: a.space, sep: a.sep, equal: a.equal, widths: a.widths }));
    continuousNext = true;
    return before + inner + end;
  }
  let body = '';
  for (const n of top) {
    // A text box waits for the next top-level paragraph; anything else first gives the waiting ones a paragraph of their own.
    if (!waits(n)) body += main.flushBoxes();
    if (n.type === 'sectionBreak' && continuousNext) {
      continuousNext = false;
      body += emptyP(await sectPr(n.attrs?.sect, 'continuous'));
      continue;
    }
    body += await (n.type === 'columns' ? columns(n) : mainBlock(n));
  }
  async function mainBlock(n) {
    return main.block(n);
  }
  body += main.flushBoxes();
  const lastSect = await sectPr(attrs.sect, continuousNext ? 'continuous' : null);
  const tail = main.closeAll();
  if (tail) body += `<w:p>${tail}</w:p>`;
  // Page colour (w:background) and fill effects (its v:background, pageFillXml).
  const bgc = attrs.background?.color ? toWordColor(attrs.background.color, attrs.background.themeColor) : null;
  const pf = attrs.background?.fill ? await pageFillXml(attrs.background.fill, attrs.background.color, (pic) => addImage(main, pic), media) : null;
  if (attrs.background?.fill && !pf) dropped.add('page fill effects');
  const background = bgc || pf ? el('w:background', { 'w:color': bgc?.val ?? pf.color, 'w:themeColor': bgc?.themeColor, 'w:themeTint': bgc?.themeTint, 'w:themeShade': bgc?.themeShade }, pf?.xml) : '';
  const documentXml = `${HEAD}<w:document ${ROOT_NS}>${background}<w:body>${body}${lastSect}</w:body></w:document>`;

  // ---------- notes and comments ----------
  for (const kind of ['footnote', 'endnote']) {
    if (!notes[kind].length) continue;
    const name = `${kind}s.xml`;
    const wr = writer(name);
    let xml = `<w:${kind} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${kind}>`
      + `<w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`;
    for (let k = 0; k < notes[kind].length; k++) {
      const note = notes[kind][k];
      const style = kind === 'endnote' ? 'EndnoteReference' : 'FootnoteReference';
      const ref = note.mark ? '' : `<w:r><w:rPr><w:rStyle w:val="${style}"/></w:rPr><w:${kind}Ref/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>`;
      const content = Array.isArray(note.content) && note.content.length ? note.content : [{ type: 'paragraph' }];
      let inner = '';
      for (const [i, b] of content.entries()) {
        if (i === 0 && (b.type === 'paragraph' || b.type === 'heading')) inner += await wr.paragraph({ ...b, attrs: { ...b.attrs, styleId: b.attrs?.styleId ?? `${kind === 'endnote' ? 'Endnote' : 'Footnote'}Text` } }, { pre: ref });
        else inner += await wr.blocks([b]);
      }
      xml += `<w:${kind} w:id="${note.id}">${inner.replace(/<\/w:p>$/, `${wr.closeAll()}</w:p>`)}</w:${kind}>`;
    }
    parts.set(`word/${name}`, `${HEAD}<w:${kind}s ${ROOT_NS}>${xml}</w:${kind}s>`);
    if (wr.rels.length) parts.set(`word/_rels/${name}.rels`, relsXml(wr.rels));
    rel(`${kind}s`, name);
    types.set(`/word/${name}`, `${CT}${kind}s+xml`);
  }
  const cmap = attrs.comments ?? {};
  if (comments.size) {
    const wr = writer('comments.xml');
    let xml = '';
    // Each comment's last paragraph gets a w14:paraId, by which commentsExtended gives its resolved state and its thread.
    const paraId = (wid) => (wid + 1).toString(16).toUpperCase().padStart(8, '0');
    let ex = '';
    let ids = '';
    let ext = '';
    for (const [id, wid] of comments) {
      const c = cmap[id] ?? {};
      const content = Array.isArray(c.content) && c.content.length ? c.content : [{ type: 'paragraph' }];
      const ref = '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>';
      let inner = '';
      for (const [i, b] of content.entries()) inner += i === 0 && (b.type === 'paragraph' || b.type === 'heading') ? await wr.paragraph(b, { pre: ref }) : await wr.blocks([b]);
      const last = Math.max(inner.lastIndexOf('<w:p>'), inner.lastIndexOf('<w:p/>'));
      if (last >= 0) inner = `${inner.slice(0, last + 4)} w14:paraId="${paraId(wid)}"${inner.slice(last + 4)}`;
      xml += el('w:comment', { 'w:id': wid, 'w:author': c.author ?? 'EasyWriter', 'w:date': c.date ?? null, 'w:initials': c.initials ?? null }, inner);
      if (last >= 0) ex += el('w15:commentEx', { 'w15:paraId': paraId(wid), 'w15:paraIdParent': comments.has(c.parent) ? paraId(comments.get(c.parent)) : null, 'w15:done': c.done ? 1 : 0 });
      // A comment from a .docx keeps its durable id (commentsIds) and UTC date (commentsExtensible); Word gives new ones their own.
      if (last >= 0 && c.durableId) {
        ids += el('w16cid:commentId', { 'w16cid:paraId': paraId(wid), 'w16cid:durableId': c.durableId });
        if (c.dateUtc) ext += el('w16cex:commentExtensible', { 'w16cex:durableId': c.durableId, 'w16cex:dateUtc': c.dateUtc });
      }
    }
    const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
    parts.set('word/comments.xml', `${HEAD}<w:comments ${ROOT_NS.replace('mc:Ignorable="wp14"', `xmlns:w14="${W14}" mc:Ignorable="wp14 w14"`)}>${xml}</w:comments>`);
    if (wr.rels.length) parts.set('word/_rels/comments.xml.rels', relsXml(wr.rels));
    rel('comments', 'comments.xml');
    types.set('/word/comments.xml', `${CT}comments+xml`);
    parts.set('word/commentsExtended.xml', `${HEAD}<w15:commentsEx xmlns:w15="${NS.w15}">${ex}</w15:commentsEx>`);
    rel('http://schemas.microsoft.com/office/2011/relationships/commentsExtended', 'commentsExtended.xml');
    types.set('/word/commentsExtended.xml', `${CT}commentsExtended+xml`);
    const extra = [['commentsIds', ids, 'w16cid', 'http://schemas.microsoft.com/office/word/2016/wordml/cid', 'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds'],
      ['commentsExtensible', ext, 'w16cex', 'http://schemas.microsoft.com/office/word/2018/wordml/cex', 'http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible']];
    for (const [name, xml, pre, ns, type] of extra) {
      if (!xml) continue;
      parts.set(`word/${name}.xml`, `${HEAD}<${pre}:${name} xmlns:${pre}="${ns}">${xml}</${pre}:${name}>`);
      rel(type, `${name}.xml`);
      types.set(`/word/${name}.xml`, `${CT}${name}+xml`);
    }
  }
  // people.xml: the sign-in of each author that has one (a .docx author's w15:presenceInfo, doc.attrs.people).
  const persons = (attrs.people ?? []).filter((p) => p?.name && p.presence?.providerId);
  if (persons.length) {
    parts.set('word/people.xml', `${HEAD}<w15:people xmlns:w15="${NS.w15}">${persons.map((p) => el('w15:person', { 'w15:author': p.name },
      el('w15:presenceInfo', { 'w15:providerId': p.presence.providerId, 'w15:userId': p.presence.userId ?? p.name }))).join('')}</w15:people>`);
    rel('http://schemas.microsoft.com/office/2011/relationships/people', 'people.xml');
    types.set('/word/people.xml', `${CT}people+xml`);
  }
  for (const h of hfParts) {
    parts.set(`word/${h.name}`, `${HEAD}<w:${h.tag === 'header' ? 'hdr' : 'ftr'} ${ROOT_NS}>${h.xml}</w:${h.tag === 'header' ? 'hdr' : 'ftr'}>`);
    if (h.rels.length) parts.set(`word/_rels/${h.name}.rels`, relsXml(h.rels));
  }

  // Parts the model does not read (settings.parts, import.mjs keepFrom): each with the files it relates to and the part it hangs
  // from, the document's or the glossary's.
  const glossary = attrs.settings?.glossary ?? [];
  const keptParts = (attrs.settings?.parts ?? []).filter((p) => p?.path && p.data != null && (p.from !== GLOSSARY || glossary.length));
  for (const p of keptParts) {
    for (const [path, data, ct] of [[p.path, p.data, p.ct], ...(p.files ?? [])]) {
      parts.set(path, bytesOf(data));
      if (ct) types.set(`/${path}`, ct);
    }
    if (p.from === 'word/document.xml') rel(p.type, p.target);
  }
  // The cover page's properties (props.cover) in the custom XML part Word keeps them in, which its bound controls show.
  const cover = attrs.props?.cover;
  if (cover && COVER.some(([key]) => cover[key])) {
    let n = 1;
    while (parts.has(`customXml/item${n}.xml`) || parts.has(`customXml/itemProps${n}.xml`)) n++;
    parts.set(`customXml/item${n}.xml`, `${HEAD}<CoverPageProperties xmlns="${CPP}">${COVER.map(([key, name]) => (cover[key] ? `<${name}>${esc(cover[key])}</${name}>` : `<${name}/>`)).join('')}</CoverPageProperties>`);
    parts.set(`customXml/itemProps${n}.xml`, `${HEAD}<ds:datastoreItem ds:itemID="${STORES[CPP][1]}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml">`
      + `<ds:schemaRefs><ds:schemaRef ds:uri="${CPP}"/></ds:schemaRefs></ds:datastoreItem>`);
    parts.set(`customXml/_rels/item${n}.xml.rels`, relsXml([{ id: 'rId1', type: `${RT}customXmlProps`, target: `itemProps${n}.xml` }]));
    types.set(`/customXml/itemProps${n}.xml`, 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml');
    rel('customXml', `../customXml/item${n}.xml`);
  }

  // ---------- the document's own building blocks (settings.glossary, from word/glossary/document.xml) ----------
  if (glossary.length) {
    const wr = writer('glossary');
    // The glossary part sits in word/glossary/, so its pictures (word/media) are one folder up.
    const own = wr.rel;
    wr.rel = (type, target, mode) => own(type, mode ? target : `../${target}`, mode);
    let xml = '';
    for (const d of glossary) {
      const list = (tag, vals) => (vals?.length ? el(`w:${tag}s`, {}, vals.map((x) => val(`w:${tag}`, x)).join('')) : '');
      const pr = val('w:name', d.name) + el('w:category', {}, val('w:name', d.category ?? 'General') + val('w:gallery', d.gallery ?? 'default'))
        + list('type', d.types) + list('behavior', d.behaviors) + val('w:description', d.description) + val('w:guid', d.guid);
      xml += el('w:docPart', {}, el('w:docPartPr', {}, pr) + el('w:docPartBody', {}, await wr.blocks(d.content?.length ? d.content : [{ type: 'paragraph' }])));
    }
    parts.set('word/glossary/document.xml', `${HEAD}<w:glossaryDocument ${ROOT_NS}><w:docParts>${xml}</w:docParts></w:glossaryDocument>`);
    // Its own styles part, so the docParts' styles (Placeholder Text) resolve there as they do in the document.
    parts.set('word/glossary/styles.xml', stylesXml(attrs.styles, numId));
    types.set('/word/glossary/styles.xml', `${CT}styles+xml`);
    const grels = [...wr.rels, { type: `${RT}styles`, target: 'styles.xml' }, ...keptParts.filter((p) => p.from === GLOSSARY)];
    parts.set('word/glossary/_rels/document.xml.rels', relsXml(grels.map((r, i) => ({ id: r.id ?? `rId${i + 1}`, type: r.type, target: r.target, mode: r.mode }))));
    rel('glossaryDocument', 'glossary/document.xml');
    types.set('/word/glossary/document.xml', `${CT}document.glossary+xml`);
  }

  // ---------- styles, numbering, settings, theme, properties ----------
  parts.set('word/styles.xml', stylesXml(attrs.styles, numId));
  rel('styles', 'styles.xml');
  types.set('/word/styles.xml', `${CT}styles+xml`);
  if (numIds.size) {
    // Picture bullets, each picture once, through numbering.xml's own relationships.
    const nw = writer('numbering');
    const pics = new Map();
    for (const ab of Object.values(attrs.numbering.abstract ?? {})) for (const l of ab.levels ?? []) {
      // A picture bullet from a .docx writes its original back while the level still shows its drawing (import.mjs showMetafiles).
      const src = l.pic && l.metafile?.pic === l.pic ? l.metafile.src : l.pic;
      const pic = l.fmt === 'bullet' && l.pic && !pics.has(l.pic) && await media(src);
      if (pic) pics.set(l.pic, [pics.size, addImage(nw, pic), src]);
    }
    parts.set('word/numbering.xml', numberingXml(attrs.numbering, abstractIds, numIds, pics));
    if (nw.rels.length) parts.set('word/_rels/numbering.xml.rels', relsXml(nw.rels));
    rel('numbering', 'numbering.xml');
    types.set('/word/numbering.xml', `${CT}numbering+xml`);
  }
  parts.set('word/settings.xml', settingsXml(attrs.settings, notes, attrs));
  // The relationships kept settings name by id (the attached template's path).
  if (attrs.settings?.kept?.rels?.length) parts.set('word/_rels/settings.xml.rels', relsXml(attrs.settings.kept.rels));
  rel('settings', 'settings.xml');
  types.set('/word/settings.xml', `${CT}settings+xml`);
  parts.set('word/theme/theme1.xml', themeXml(attrs.theme));
  rel('theme', 'theme/theme1.xml');
  types.set('/word/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml');
  parts.set('word/document.xml', documentXml);
  types.set('/word/document.xml', `${CT}document.main+xml`);
  parts.set('word/_rels/document.xml.rels', relsXml(rels));

  const core = attrs.props?.core ?? {};
  parts.set('docProps/core.xml', `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${esc(core.title || title)}</dc:title>${core.subject ? `<dc:subject>${esc(core.subject)}</dc:subject>` : ''}${core.creator ? `<dc:creator>${esc(core.creator)}</dc:creator>` : ''}`
    + `${core.keywords ? `<cp:keywords>${esc(core.keywords)}</cp:keywords>` : ''}${core.description ? `<dc:description>${esc(core.description)}</dc:description>` : ''}${core.category ? `<cp:category>${esc(core.category)}</cp:category>` : ''}`
    + `${core.contentStatus ? `<cp:contentStatus>${esc(core.contentStatus)}</cp:contentStatus>` : ''}</cp:coreProperties>`);
  types.set('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml');

  const pkgRels = [{ id: 'rId1', type: RT + 'officeDocument', target: 'word/document.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' }];
  // The app (extended) properties the user types, and the custom ones with their types (vt:lpwstr, vt:i4 or vt:r8, vt:filetime, vt:bool).
  const VT = 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"';
  const docProp = (name, type, xml) => {
    parts.set(`docProps/${name}.xml`, xml);
    pkgRels.push({ id: `rId${pkgRels.length + 1}`, type: RT + type, target: `docProps/${name}.xml` });
    types.set(`/docProps/${name}.xml`, `application/vnd.openxmlformats-officedocument.${type}+xml`);
  };
  const app = attrs.props?.app ?? {};
  const appXml = [['Template', app.template], ['Manager', app.manager], ['Company', app.company], ['HyperlinkBase', app.hyperlinkBase]].map(([k, x]) => (x ? `<${k}>${esc(x)}</${k}>` : '')).join('');
  if (appXml) docProp('app', 'extended-properties', `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ${VT}>${appXml}</Properties>`);
  const custom = attrs.props?.custom ?? [];
  const vt = (c) => (c.type === 'bool' ? `<vt:bool>${!!c.value}</vt:bool>` : c.type === 'date' ? `<vt:filetime>${esc(c.value)}T00:00:00Z</vt:filetime>`
    : c.type === 'number' ? (Number.isInteger(+c.value) && Math.abs(c.value) < 2 ** 31 ? `<vt:i4>${+c.value}</vt:i4>` : `<vt:r8>${+c.value}</vt:r8>`) : `<vt:lpwstr>${esc(c.value)}</vt:lpwstr>`);
  if (custom.length) {
    docProp('custom', 'custom-properties', `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ${VT}>`
      + custom.map((c, i) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" name="${esc(c.name)}">${vt(c)}</property>`).join('') + '</Properties>');
  }
  const ctXml = `${HEAD}<Types xmlns="${NS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="json" ContentType="application/json"/>`
    + [...defaults].map(([e, c]) => `<Default Extension="${e}" ContentType="${c}"/>`).join('')
    + [...types].map(([p, c]) => `<Override PartName="${p}" ContentType="${c}"/>`).join('') + '</Types>';
  const files = [['[Content_Types].xml', ctXml], ['_rels/.rels', relsXml(pkgRels)], ...parts];
  if (Object.keys(kept).length) files.push([STASH, JSON.stringify({ hash: await packageHash(files), nodes: kept })]);
  return { bytes: await writeZip(files), dropped: [...dropped].filter((d) => !['doc', 'text'].includes(d)) };
}

const relsXml = (list) => `${HEAD}<Relationships xmlns="${NS.rel}">${list.map((r) => el('Relationship', { Id: r.id, Type: r.type, Target: r.target, TargetMode: r.mode ?? null })).join('')}</Relationships>`;

// ---------- watermark and page fill VML ----------
// Word's shapetypes for a watermark's text path (136) and picture frame (75), each written once in the part that uses it.
const TEXT_TYPE = '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e"><v:formulas>'
  + ['sum #0 0 10800', 'prod #0 2 1', 'sum 21600 0 @1', 'sum 0 0 @2', 'sum 21600 0 @3', 'if @0 @3 0', 'if @0 21600 @1', 'if @0 0 @2', 'if @0 @4 21600',
    'mid @5 @6', 'mid @8 @5', 'mid @7 @8', 'mid @6 @7', 'sum @6 0 @5'].map((f) => `<v:f eqn="${f}"/>`).join('')
  + '</v:formulas><v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/>'
  + '<v:textpath on="t" fitshape="t"/><v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles><o:lock v:ext="edit" text="t" shapetype="t"/></v:shapetype>';
const PICTURE_TYPE = '<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f">'
  + '<v:stroke joinstyle="miter"/><v:formulas>' + ['if lineDrawn pixelLineWidth 0', 'sum @0 1 0', 'sum 0 0 @1', 'prod @2 1 2', 'prod @3 21600 pixelWidth',
    'prod @3 21600 pixelHeight', 'sum @0 0 1', 'prod @6 1 2', 'prod @7 21600 pixelWidth', 'sum @8 21600 0', 'prod @7 21600 pixelHeight', 'sum @10 21600 0']
    .map((f) => `<v:f eqn="${f}"/>`).join('') + '</v:formulas><v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype>';

let measurer;
/** The width of `text` at 1 pt in font `family`, in pt: measured on a canvas where there is one. */
function textWidth(text, family) {
  measurer ??= globalThis.document?.createElement('canvas').getContext('2d');
  // ponytail: Node has no canvas, so 0.5 em a character; Word stretches the text to the box, so a wrong guess narrows or widens it
  if (!measurer) return text.length * 0.5;
  measurer.font = `100pt "${family}"`;
  return measurer.measureText(text).width / ((100 * 4) / 3);
}

/** The VML focus (%) of a linear gradient's variants 0 to 3: color2 sits that share of the way along (negative: the colours swap),
 * so 100 runs the colours forward, 0 back, 50 and -50 there and back, as the page draws each variant. */
export const FOCUS = [100, 0, 50, -50];
const ANGLE = { vertical: -90, diagonalUp: -135, diagonalDown: -45 };

/** Word's 8 x 8 pattern tiles (a row a byte, the high bit leftmost, 1 for the foreground) by our pattern ids. Word draws a VML
 * pattern fill only as one of these: any other tile draws as some other pattern (checked in Word), so a pattern goes out as Word's
 * tile and reads back by it. The page draws our own tiles (page-background/model.mjs PATTERNS). */
export const WORD_PATTERNS = {
  pct5: '8000000008000000', pct10: '8000080080000800', pct20: '8800220088002200', pct25: '8822882288228822', pct30: 'aa44aa11aa44aa11',
  pct40: 'aa55aa51aa55aa15', pct50: 'aa55aa55aa55aa55', pct60: 'ee55bb55ee55bb55', pct70: '77dd77dd77dd77dd', pct75: '77ffddff77ffddff',
  pct80: 'effffeffeffffeff', pct90: 'fffffff7ffffff7f', ltDnDiag: '8844221188442211', ltUpDiag: '1122448811224488', dkDnDiag: 'cc663399cc663399',
  dkUpDiag: '3366cc993366cc99', wdDnDiag: 'c1e070381c0e0783', wdUpDiag: '83070e1c3870e0c1', ltVert: '8888888888888888', ltHorz: 'ff000000ff000000',
  narVert: '5555555555555555', narHorz: 'ff00ff00ff00ff00', dkVert: 'cccccccccccccccc', dkHorz: 'ffff0000ffff0000', dashDnDiag: '0000884422110000',
  dashUpDiag: '0000112244880000', dashHorz: 'f00000000f000000', dashVert: '8080808008080808', smConfetti: '8008400210012004', lgConfetti: 'b130031bd8c00c8d',
  zigZag: '8142241881422418', wave: '001825c0001825c0', diagBrick: '0102040818244281', horzBrick: 'ff808080ff080808', weave: '8854224588142251',
  plaid: 'aa55aa55f0f0f0f0', divot: '0010081000800180', dotGrid: 'aa00800080008000', dotDmnd: '8000220008002200', shingle: '038448300c020101',
  trellis: 'ff66ff99ff66ff99', sphere: '77898f8f7798f8f8', smGrid: 'ff888888ff888888', lgGrid: 'ff80808080808080', smCheck: '9966669999666699',
  lgCheck: 'f0f0f0f00f0f0f0f', openDmnd: '8244281028448201', solidDmnd: '10387cfe7c381000',
};

/** Pattern `id` as Word's two-colour GIF of its tile: white for the foreground (VML gives it fillcolor), black for the rest. Its
 * LZW codes stay 3 bits wide: each two pixels follow a clear code. */
function patternGif(id) {
  const codes = [];
  [...WORD_PATTERNS[id]].flatMap((h) => [...(parseInt(h, 16) | 16).toString(2).slice(1)]).forEach((b, i) => codes.push(...(i % 2 ? [] : [4]), b === '1' ? 0 : 1));
  codes.push(5);
  const data = [];
  codes.forEach((c, i) => { for (let k = 0; k < 3; k++) data[(i * 3 + k) >> 3] = (data[(i * 3 + k) >> 3] ?? 0) | (((c >> k) & 1) << ((i * 3 + k) & 7)); });
  return Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 8, 0, 8, 0, 0x80, 1, 0, 255, 255, 255, 0, 0, 0, 0x2c, 0, 0, 0, 0, 8, 0, 8, 0, 0, 2, data.length, ...data, 0, 0x3b]);
}

/**
 * Page fill `f` (background.fill) as Word writes it in w:background → {xml (its v:background), color (w:color when the page has
 * none: the fill's first colour)}, or null when its picture cannot be read. Gradient: the angle Word gives its style, the focus
 * of its variant (FOCUS), From center and From corner radial with their focus position, one colour as 'fill darken(n)' or
 * 'fill lighten(n)', a preset as its colour list. Pattern: Word's tile of its id as a GIF with fillcolor and color2. Texture:
 * its picture, or our tile drawn to a PNG, tiled. Picture: framed. `color`: the page colour; `image(pic)` → its relationship id;
 * `media(src)` reads a picture.
 */
async function pageFillXml(f, color, image, media) {
  const kind = f.kind ?? f.type;
  const fillEl = (fillcolor, a, inner = '') => ({ color: (fillcolor ?? color ?? '#FFFFFF').slice(1).toUpperCase(),
    xml: el('v:background', { id: '_x0000_s1025', 'o:bwmode': 'white', fillcolor: fillcolor ?? color, 'o:targetscreensize': /gradient|frame/.test(a.type) ? '1024,768' : null },
      el('v:fill', a, inner)) });
  if (kind === 'gradient') {
    const v = f.variant ?? 0;
    const stops = f.colors === 'preset' ? (GRADIENT_PRESETS.find(([id]) => id === f.preset) ?? GRADIENT_PRESETS[0])[2] : null;
    const shade = f.shade ?? 0.5;
    const radial = f.style === 'fromCenter' || f.style === 'fromCorner';
    const focus = f.style === 'fromCenter' ? [100, 0][v] : radial ? 100 : FOCUS[v];
    const at = f.style === 'fromCenter' ? '.5,.5' : f.style === 'fromCorner' && v ? ['0,0', '1,0', '0,1', '1,1'][v] : null;
    return fillEl(stops?.[0] ?? f.color1 ?? '#4472C4', {
      angle: radial ? null : ANGLE[f.style] ?? null, focusposition: at, focussize: at && '',
      color2: stops ? stops.at(-1) : f.colors === 'one' ? (shade === 0.5 ? 'fill' : shade < 0.5 ? `fill darken(${Math.round(shade * 510)})` : `fill lighten(${Math.round((1 - shade) * 510)})`) : f.color2 ?? '#FFFFFF',
      colors: stops?.map((c, i) => `${i === 0 ? 0 : i === stops.length - 1 ? 1 : `${Math.round((i / (stops.length - 1)) * 65536)}f`} ${c}`).join(';'),
      method: stops ? 'none' : f.colors === 'one' ? 'linear sigma' : null, focus: focus ? `${focus}%` : null, type: radial ? 'gradientRadial' : 'gradient',
    }, f.style === 'fromCorner' ? '<o:fill v:ext="view" type="gradientCenter"/>' : '');
  }
  if (kind === 'pattern') {
    const id = WORD_PATTERNS[f.pattern] ? f.pattern : 'pct5';
    return fillEl(f.fg ?? '#000000', { 'r:id': image({ bytes: patternGif(id), ext: 'gif' }), 'o:title': PATTERNS.find(([p]) => p === id)[1], color2: f.bg ?? '#FFFFFF', type: 'pattern' });
  }
  const pic = kind === 'texture' ? (f.src ? await media(f.src) : await drawnMedia(textureCss(f).image.slice(5, -2))) : kind === 'picture' && f.src ? await media(f.src) : null;
  if (!pic) return null;
  const title = kind === 'texture' ? TEXTURES.find(([t]) => t === f.texture)?.[1] ?? null : null;
  return fillEl(null, { 'r:id': image(pic), 'o:title': title, aspect: kind === 'picture' && f.lockAspect ? 'atLeast' : null, type: kind === 'texture' ? 'tile' : 'frame' });
}

// Style objects and list levels keep the first schema's run names: bold, italic, underline (a name, or {val} from Define New List
// Style), charSpacing; list levels an older import read hold b and i.
const styleRun = (r) => (r ? { ...r, b: r.bold ?? r.b, i: r.italic ?? r.i, strike: r.strike, u: r.underline ? { val: r.underline === true ? 'single' : r.underline.val ?? r.underline } : r.u,
  spacing: r.spacing ?? r.charSpacing } : null);

/** styles.xml from doc.attrs.styles {defaults {run, para}, list {id: {type, name, basedOn, next, link, para, run, table, ...}}}, with
 * what a .docx kept (styles.kept {root, latent, defaults {xml, sig}, styles {id: {xml, sig}}}): its latent styles, and the defaults
 * and each style as Word wrote them while the model's are unchanged. A kept style the model does not hold (sig null: the
 * reference styles the app defines itself) goes back while the model still has none. */
function stylesXml(styles = {}, numId) {
  const d = styles.defaults ?? {};
  const k = styles.kept ?? {};
  // Para align and border keep the first schema's names too; a table's borders may be one edge for every side.
  const paraProps = (q) => (q ? { ...q, textAlign: q.textAlign ?? q.align, borders: q.borders ?? q.border } : null);
  const sides = (b) => (b?.style ? Object.fromEntries(['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((k) => [k, b])) : b);
  let xml = (k.defaults?.sig === sig(styles.defaults) ? k.defaults.xml
    : `<w:docDefaults><w:rPrDefault>${rPr(styleRun(d.run)) || '<w:rPr/>'}</w:rPrDefault><w:pPrDefault>${pPr(paraProps(d.para), { styleId: null }) || '<w:pPr/>'}</w:pPrDefault></w:docDefaults>`)
    + (k.latent ?? '');
  const list = { ...(styles.list ?? {}) };
  for (const [id, type, name] of [['DefaultParagraphFont', 'character', 'Default Paragraph Font'], ['FootnoteReference', 'character', 'footnote reference'],
    ['EndnoteReference', 'character', 'endnote reference'], ['CommentReference', 'character', 'annotation reference']]) {
    if (!list[id]) list[id] = { type, name, ...(id !== 'DefaultParagraphFont' && { run: id === 'CommentReference' ? { size: 8 } : { vertAlign: 'superscript' } }) };
  }
  for (const [id, s] of Object.entries(list)) {
    if (!s) continue;
    const kept = k.styles?.[id];
    if (kept && kept.sig === (styles.list?.[id] ? sig(styles.list[id]) : null)) {
      xml += kept.xml;
      continue;
    }
    const type = s.type ?? 'paragraph';
    const isDefault = (id === 'Normal' && type === 'paragraph') || (id === 'DefaultParagraphFont') || (id === 'TableNormal' && type === 'table') || (id === 'NoList' && type === 'numbering');
    const t = s.table;
    const tblPr = t ? el('w:tblPr', {}, val('w:tblStyleRowBandSize', t.rowBandSize) + val('w:tblStyleColBandSize', t.colBandSize)
      + borders('w:tblBorders', sides(t.borders), [['top'], ['left'], ['bottom'], ['right'], ['insideH'], ['insideV']])
      + cellMar(t.cellMargin))
      + (t.shading || t.vAlign ? el('w:tcPr', {}, shading(t.shading) + val('w:vAlign', t.vAlign)) : '') : '';
    const cond = t?.cond ? Object.entries(t.cond).map(([k, c]) => el('w:tblStylePr', { 'w:type': k }, (pPr(paraProps(c.para), { styleId: null }) || '') + (rPr(styleRun(c.run)) || '')
      + (c.cell ? el('w:tcPr', {}, borders('w:tcBorders', c.cell.borders, [['top'], ['left'], ['bottom'], ['right'], ['insideH'], ['insideV']]) + shading(c.cell.shading)
        + val('w:vAlign', c.cell.vAlign)) : ''))).join('') : '';
    xml += el('w:style', { 'w:type': type, 'w:default': isDefault ? 1 : null, 'w:styleId': id },
      val('w:name', s.name ?? id) + val('w:aliases', s.aliases) + val('w:basedOn', s.basedOn) + val('w:next', s.next) + val('w:link', s.link) + onOff('w:autoRedefine', s.autoRedefine || null)
      + onOff('w:hidden', s.hidden || null) + val('w:uiPriority', s.uiPriority) + onOff('w:semiHidden', s.semiHidden || null) + onOff('w:unhideWhenUsed', s.unhideWhenUsed || null)
      + onOff('w:qFormat', (s.qFormat ?? (type === 'paragraph' && /^(Normal|Heading\d|Title|Subtitle|Quote|IntenseQuote|NoSpacing|ListParagraph)$/.test(id))) || null)
      + onOff('w:locked', s.locked || null) + (type === 'character' ? '' : pPr(paraProps(s.para), { styleId: null, numId })) + rPr(styleRun(s.run)) + tblPr + cond);
  }
  return `${HEAD}<w:styles${rootAttrs(`xmlns:w="${NS.w}" ${W14}`, k.root)}>${xml}</w:styles>`;
}

/** numbering.xml from doc.attrs.numbering {abstract {id: {name, levels}}, nums {id: {abstract, overrides}}}; `pics` maps a picture
 * bullet's level pic to [its w:numPicBulletId, the rId of its picture, its source]. What a .docx kept (numbering.kept {root,
 * bullets [{id, sig of the source, xml}], abstract {id: {attrs, pre, post, lvls [{xml, sig}]}}, nums {id: {attrs, abstract, inner,
 * sig}}, tail}) comes back with the ids renumbered: each list's own attributes, nsid, type, template and style links, each level
 * and num as Word wrote it while the model's is unchanged, and Word's VML of each picture bullet. */
function numberingXml(numbering = {}, abstractIds, numIds, pics = new Map()) {
  const k = numbering.kept ?? {};
  // Each picture bullet once. Word's own keeps its id and XML; any other is a VML picture with the next id, which Word sizes to the
  // label's font, so its size is nominal. The ids go into `pics` for the levels. Word defines a VML shape type once for the part,
  // so each goes into the first bullet written that uses it.
  const shapeTypes = new Map();
  const own = (k.bullets ?? []).map((b) => ({ ...b, xml: b.xml.replace(/<v:shapetype\b[^>]*\/>|<v:shapetype\b[^]*?<\/v:shapetype>/g, (d) => {
    shapeTypes.set(/\bid="([^"]*)"/.exec(d)?.[1], d);
    return '';
  }) }));
  let next = Math.max(-1, ...own.map((b) => +b.id)) + 1;
  for (const p of pics.values()) { // [id, rid, src]
    const b = own.find((x) => !x.used && x.sig === sig(p[2]));
    if (b) b.used = true;
    p[0] = b ? +b.id : next++;
    p[3] = b ? b.xml.replace(/\br:(id|embed)="[^"]*"/g, `r:$1="${p[1]}"`)
      : `<w:pict><v:shape style="width:9pt;height:9pt" o:bullet="t">${el('v:imagedata', { 'r:id': p[1], 'o:title': '' })}</v:shape></w:pict>`;
  }
  const typed = new Set();
  const typesFor = (inner) => [...inner.matchAll(/\btype="#([^"]+)"/g)].map((m) => m[1]).filter((t) => shapeTypes.has(t) && !typed.has(t))
    .map((t) => (typed.add(t), shapeTypes.get(t))).join('');
  let xml = [...pics.values()].sort((a, b) => a[0] - b[0])
    .map(([id, , , inner]) => el('w:numPicBullet', { 'w:numPicBulletId': id }, inner.replace(/^<w:pict\b[^>]*>/, (start) => start + typesFor(inner)))).join('');
  for (const [key, ab] of Object.entries(numbering.abstract ?? {})) {
    const ka = k.abstract?.[key];
    const levels = (ab.levels ?? []).map((l, i) => (ka?.lvls?.[i]?.sig === sig(l)
      ? ka.lvls[i].xml.replace(/<w:lvlPicBulletId\b[^>]*\/>/, val('w:lvlPicBulletId', l.fmt === 'bullet' ? pics.get(l.pic)?.[0] : null))
      : el('w:lvl', { 'w:ilvl': i }, val('w:start', l.start ?? 1) + val('w:numFmt', l.fmt ?? 'decimal')
      + (l.restart != null ? val('w:lvlRestart', l.restart) : '') + val('w:pStyle', l.pStyle) + onOff('w:isLgl', l.isLgl || null) + val('w:suff', l.suff)
      + val('w:lvlText', l.text ?? '') + val('w:lvlPicBulletId', l.fmt === 'bullet' ? pics.get(l.pic)?.[0] : null) + val('w:lvlJc', l.jc ?? 'left')
      + el('w:pPr', {}, (l.tab != null ? el('w:tabs', {}, el('w:tab', { 'w:val': 'num', 'w:pos': tw(l.tab) })) : '') + indEl({ left: l.left ?? 36 * (i + 1), firstLine: -(l.hanging ?? 18) }))
      + rPr(styleRun(l.run))))).join('');
    xml += el('w:abstractNum', { 'w:abstractNumId': abstractIds.get(key), ...ka?.attrs },
      (ka ? ka.pre : '<w:multiLevelType w:val="hybridMultilevel"/>') + val('w:name', ab.name) + (ka?.post ?? '') + levels);
  }
  for (const [key, n] of Object.entries(numbering.nums ?? {})) {
    const kn = k.nums?.[key];
    // A num as read keeps the list it named, a list style's link among them (import.mjs points the model past it).
    if (kn?.sig === sig(n)) {
      xml += el('w:num', { 'w:numId': numIds.get(key), ...kn.attrs }, val('w:abstractNumId', abstractIds.get(kn.abstract) ?? abstractIds.get(n.abstract) ?? 0) + kn.inner);
      continue;
    }
    const overrides = Object.entries(n.overrides ?? {}).map(([lvl, o]) => el('w:lvlOverride', { 'w:ilvl': lvl }, o?.start != null ? val('w:startOverride', o.start) : '')).join('');
    xml += el('w:num', { 'w:numId': numIds.get(key) }, val('w:abstractNumId', abstractIds.get(n.abstract) ?? 0) + overrides);
  }
  const ns = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" ${W14}`;
  return `${HEAD}<w:numbering${rootAttrs(ns, k.root)}>${xml}${k.tail ?? ''}</w:numbering>`;
}

/** w:footnotePr or w:endnotePr of the notes package's {pos, numFmt, numStart, numRestart}, then `more` (the settings' separators). */
function notePrXml(kind, p, more = '') {
  const inner = val('w:pos', p?.pos) + val('w:numFmt', p?.numFmt) + val('w:numStart', p?.numStart) + val('w:numRestart', p?.numRestart) + more;
  return inner ? el(`w:${kind}Pr`, {}, inner) : '';
}

/** The mail merge types (doc.attrs.merge.type) as w:mainDocumentType. */
export const MERGE_TYPES = { letters: 'formLetters', envelopes: 'envelopes', labels: 'mailingLabels', directory: 'catalog' };

/** settings.xml from doc.attrs.settings, `vars` (w:docVars) and `merge`, in CT_Settings' order, with the settings a .docx kept
 * (settings.kept {root, items [[name, xml]], compat [[name, xml]], rels}) that the model does not write: the view, shape defaults,
 * colour mapping, theme font languages, compatibility options and the rest come back as Word wrote them, the proofing state
 * excepted (the text may have changed since). Restrict Editing goes without its password hash, which is not Word's
 * (protect/hash.mjs); a mail merge without its data source, which stays outside the document. */
function settingsXml(s = {}, notes, { vars, merge } = {}) {
  const k = s.kept;
  const sep = (kind) => notePrXml(kind, s[`${kind}Pr`], notes[kind].length ? `<w:${kind} w:id="-1"/><w:${kind} w:id="0"/>` : '');
  // [name, xml] of each element the model writes, '' while it is off, so a kept copy of it never comes back.
  const on = (name, x) => [name, onOff(name, x || null)];
  const v = (name, x) => [name, val(name, x)];
  const p = s.protection;
  const g = s.grid ?? {};
  const m = s.mathPr;
  const bf = s.bookFold;
  const mv = (name, x) => (x == null ? '' : el(`m:${name}`, { 'm:val': typeof x === 'boolean' ? +x : x }));
  const html = on('w:doNotUseHTMLParagraphAutoSpacing', s.compat?.htmlAutoSpacing === false);
  const own = [
    ['w:writeProtection', s.writeProtection ? el('w:writeProtection', { 'w:recommended': s.writeProtection.recommended ? 1 : null }) : ''], on('w:displayBackgroundShape', s.displayBackground),
    on('w:mirrorMargins', s.mirrorMargins), on('w:alignBordersAndEdges', s.alignBordersAndEdges), on('w:bordersDoNotSurroundHeader', s.bordersDoNotSurroundHeader),
    on('w:bordersDoNotSurroundFooter', s.bordersDoNotSurroundFooter), on('w:gutterAtTop', s.gutterAtTop), on('w:linkStyles', s.linkStyles),
    ['w:mailMerge', MERGE_TYPES[merge?.type] ? el('w:mailMerge', {}, val('w:mainDocumentType', MERGE_TYPES[merge.type]) + val('w:dataType', 'textFile')) : ''],
    on('w:trackRevisions', s.trackRevisions),
    ['w:documentProtection', p ? el('w:documentProtection', { 'w:edit': p.edit && p.edit !== 'none' ? p.edit : null, 'w:formatting': p.formatting ? 1 : null, 'w:enforcement': p.enforcement ? 1 : 0 }) : ''],
    on('w:autoFormatOverride', p?.autoFormatOverride), on('w:styleLockTheme', p?.lockTheme), on('w:styleLockQFSet', p?.lockQFSet),
    v('w:defaultTabStop', tw(s.defaultTabStop ?? 36)), on('w:autoHyphenation', s.autoHyphenation), v('w:consecutiveHyphenLimit', s.consecutiveHyphenLimit || null),
    v('w:hyphenationZone', tw(s.hyphenationZone)), on('w:doNotHyphenateCaps', s.doNotHyphenateCaps), on('w:evenAndOddHeaders', s.evenAndOddHeaders),
    // Sheets per booklet n goes out as 4n - 4, as Word writes it.
    on('w:bookFoldRevPrinting', bf?.reverse), on('w:bookFoldPrinting', bf && !bf.reverse), v('w:bookFoldPrintingSheets', bf ? (bf.sheets ?? 0) * 4 - 4 : null),
    v('w:drawingGridHorizontalSpacing', tw(g.h)), v('w:drawingGridVerticalSpacing', tw(g.v)), v('w:displayHorizontalDrawingGridEvery', g.everyH),
    v('w:displayVerticalDrawingGridEvery', g.everyV), on('w:doNotUseMarginsForDrawingGridOrigin', g.useMargins === false),
    v('w:drawingGridHorizontalOrigin', tw(g.x)), v('w:drawingGridVerticalOrigin', tw(g.y)),
    on('w:doNotShadeFormData', s.formShading === false), on('w:printTwoOnOne', s.printTwoOnOne), on('w:updateFields', s.updateFields),
    ['w:footnotePr', sep('footnote')], ['w:endnotePr', sep('endnote')],
    // Word's compatibility options as it wrote them (the mode among them, which decides how Word lays the file out), else Word 2013's.
    ['w:compat', `<w:compat>${k?.compat ? mergeKept([html], k.compat, COMPAT_ORDER, -1)
      : `${html[1]}<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>`}</w:compat>`],
    ['w:docVars', vars && Object.keys(vars).length ? el('w:docVars', {}, Object.entries(vars).map(([key, x]) => el('w:docVar', { 'w:name': key, 'w:val': x ?? '' })).join('')) : ''],
    ['m:mathPr', m ? el('m:mathPr', {}, mv('mathFont', m.font) + mv('brkBin', m.brkBin) + mv('brkBinSub', m.brkBinSub) + mv('smallFrac', m.smallFrac) + mv('dispDef', m.dispDef)
      + mv('lMargin', tw(m.lMargin)) + mv('rMargin', tw(m.rMargin)) + mv('defJc', m.defJc) + mv('wrapIndent', tw(m.wrapIndent)) + mv('wrapRight', m.wrapRight)
      + mv('intLim', m.intLim) + mv('naryLim', m.naryLim)) : ''],
    ['w:proofState', ''],
  ];
  return `${HEAD}<w:settings${rootAttrs(`xmlns:w="${NS.w}" xmlns:m="${NS.m}"`, k?.root)}>${mergeKept(own, k?.items, SETTINGS_ORDER, 1e9)}</w:settings>`;
}

const SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
/** Design > Themes > Save Current Theme: `theme` as an Office theme file (.thmx) → its bytes. */
export function thmxOf(theme) {
  return writeZip([
    ['[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + '<Default Extension="xml" ContentType="application/xml"/><Override PartName="/theme/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>'],
    ['_rels/.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="theme/theme/theme1.xml"/></Relationships>'],
    ['theme/theme/theme1.xml', themeXml(theme)],
  ]);
}

/** A .docx's own theme1.xml (theme.kept {xml, name, fonts, colors}: the XML and what the model read from it) with what Design has
 * changed since written in: a colour slot as RGB, a heading or body font (Latin or East Asian), the name. The font scripts, format
 * scheme, extra colour schemes and extensions stay as Word wrote them. */
function keptTheme(theme) {
  const k = theme.kept;
  const now = (a, b) => a != null && String(a).toUpperCase() !== String(b ?? '').toUpperCase();
  // The first colour scheme is the theme's own; a:extraClrSchemeLst holds others with the same slot names.
  let xml = k.xml.replace(/<a:clrScheme\b[^]*?<\/a:clrScheme>/, (scheme) => SLOTS.reduce((s, slot) => (now(theme.colors?.[slot], k.colors?.[slot]) && hex(theme.colors[slot]) !== 'auto'
    ? s.replace(new RegExp(`<a:${slot}>[^]*?</a:${slot}>`), () => `<a:${slot}><a:srgbClr val="${hex(theme.colors[slot])}"/></a:${slot}>`) : s), scheme));
  for (const [tag, key] of [['majorFont', 'major'], ['minorFont', 'minor']]) {
    xml = xml.replace(new RegExp(`<a:${tag}>[^]*?</a:${tag}>`), (f) => [['latin', key], ['ea', `${key}EA`]].reduce((s, [script, name]) => (now(theme.fonts?.[name], k.fonts?.[name])
      // A new typeface drops the old one's panose and character set.
      ? s.replace(new RegExp(`<a:${script}\\b[^>]*/>`), () => `<a:${script} typeface="${esc(theme.fonts[name])}"/>`) : s), f));
  }
  return now(theme.name, k.name) ? xml.replace(/(<a:theme\b[^>]*?\bname=")[^"]*"/, (_, start) => `${start}${esc(theme.name)}"`) : xml;
}

/** theme1.xml: a .docx's own as Design left it, else the Document's theme colours and fonts on a plain format scheme; either with
 * the theme's object defaults (Set as Default Shape, Line and Text Box). */
function themeXml(theme = {}) {
  return objectDefaultsInto(themeElementsXml(theme), theme);
}
function themeElementsXml(theme) {
  if (theme.kept?.xml) return keptTheme(theme);
  const c = theme.colors ?? {};
  const DEF = { dk1: '000000', lt1: 'FFFFFF', dk2: '0E2841', lt2: 'E8E8E8', accent1: '156082', accent2: 'E97132', accent3: '196B24', accent4: '0F9ED5', accent5: 'A02B93', accent6: '4EA72E', hlink: '467886', folHlink: '96607D' };
  const colors = SLOTS.map((k) => `<a:${k}><a:srgbClr val="${hex(c[k] ?? DEF[k]) === 'auto' ? DEF[k] : hex(c[k] ?? DEF[k])}"/></a:${k}>`).join('');
  const font = (f, ea) => `<a:latin typeface="${esc(f)}"/><a:ea typeface="${esc(ea ?? '')}"/><a:cs typeface=""/>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (w) => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`;
  return `${HEAD}<a:theme xmlns:a="${NS.a}" name="${esc(theme.name ?? 'Office Theme')}"><a:themeElements><a:clrScheme name="${esc(theme.name ?? 'Office')}">${colors}</a:clrScheme>`
    + `<a:fontScheme name="${esc(theme.name ?? 'Office')}"><a:majorFont>${font(theme.fonts?.major ?? 'Aptos Display', theme.fonts?.majorEA)}</a:majorFont><a:minorFont>${font(theme.fonts?.minor ?? 'Aptos', theme.fonts?.minorEA)}</a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="Office"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>`
    + `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>`
    + `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}
