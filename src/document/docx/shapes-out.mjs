// The app's canvases back out as Word drawings (docs/plans/word/left-out.md package 1, canvas-native-export): a canvas of board
// items Word has a form for (a Word shape, group, drawing canvas or diagram from the import, Insert > Shapes, the Draw tab's pens,
// the board's text and pictures) writes as DrawingML, so Word can still edit it: one shape or line as a wps:wsp, several in one
// group as a wpg:wgp, otherwise a wpc:wpc drawing canvas, with fill, line, effects, text, position and wrap; its pictures as pic:pic
// (a metafile as the original, an SVG beside a PNG of it), pen strokes as Word ink (w14:contentPart and an InkML part, as the Draw
// tab makes) and text items as text boxes with no line. shapes-in.mjs reads each back into the same items. A canvas holding an item
// Word has no form for (wordItem), or only one picture outside a Word drawing canvas, stays a picture (export.mjs). Pure.
import { normalizeGroups, TEXT_LINE, TEXT_PAD, units } from '../../flow/model.mjs';
import { hasPreset } from '../../flow/presets.mjs';
import { fillable, isLineish, kindOf, rotatePoint, upgradedShape } from '../../flow/shapes.mjs';
import { clrXml, colorXml, decorativeXml, gradFillEl, heldGradient, heldLink, heldPattern, hiddenXml, pattFillEl, pictureXml, refsXml, srgbXml, xmlOf } from './dml.mjs';
import { appPPr, DASH_OUT, EMU_PX, HIGHLIGHTER, INK_RES, lineGeometry, PENCIL, PX, r1, URI } from './shapes-in.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const el = (name, attrs = {}, inner = '') => {
  const a = Object.entries(attrs).filter(([, v]) => v != null && v !== false).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return inner ? `<${name}${a}>${inner}</${name}>` : `<${name}${a}/>`;
};
const R = Math.round;
const HEAD_OUT = { arrow: 'arrow', triangle: 'triangle', diamond: 'diamond', circle: 'oval' };
const DASH_IN = { solid: 'solid', dot: 'dotted', sysDot: 'dotted' };
// The board's kinds that draw no preset (src/flow/shapes.mjs) → the nearest one they write as; the reversed Data writes flipped.
const KIND_PRESET = { 'lean-l': 'flowChartInputOutput', 'trap-b': 'trapezoid', 'notch-pent': 'snip2SameRect', speech: 'wedgeRectCallout',
  thought: 'cloudCallout', brace: 'leftBrace', line: 'line', arrow: 'line', fork: 'rect', lane: 'rect', frame: 'rect', path: 'rect' };

const free = (e) => typeof e?.item !== 'string' && Number.isFinite(e?.x) && Number.isFinite(e?.y);
// The picture types Word shows from a plain a:blip, and an SVG, which goes out beside a PNG of it (asvg:svgBlip, export.mjs).
const WORD_PICTURE = /^data:image\/(png|jpeg|gif|bmp|tiff|x-emf|x-wmf)[;,]/;
export const SVG_PICTURE = /^data:image\/svg\+xml[;,]/;
/** Board item `it`'s picture as export writes it: the original of a metafile, else its own. */
export const pictureSrc = (it) => it.metafile ?? it.src;
/**
 * Whether board item `it` has a Word form: a shape; a free connector with no waypoints or labels and heads Word draws; a picture
 * Word shows (an SVG with a PNG of it); a pen stroke (Word ink); a text item (a text box with no line). The kinds left, which keep
 * their canvas a picture: a connector bound to an item or with waypoints or labels (the board routes it and Word's connectors hold
 * no labels; glued connectors are not written), a picture in a type Word does not show (WebP and the like), and a canvas item
 * (Word's drawing canvases do not nest).
 */
const wordItem = (it) => (it?.type === 'shape' && !!kindOf(it.shape))
  || (it?.type === 'connector' && free(it.from) && free(it.to) && !it.points?.length && !Object.keys(it.labels ?? {}).length
    && [it.heads?.start ?? 'none', it.heads?.end ?? 'arrow'].every((h) => h === 'none' || HEAD_OUT[h]))
  || (it?.type === 'image' && (WORD_PICTURE.test(pictureSrc(it) ?? '') || SVG_PICTURE.test(pictureSrc(it) ?? '')))
  || (it?.type === 'stroke' && strokeLines(it).length > 0)
  || it?.type === 'text';
/** Whether canvas attrs `a` write as Word shapes. An empty one does when it came from a Word drawing canvas (docPr.canvas); a lone
 * picture outside one stays the picture it is. */
export const shapeCanvas = (a) => Array.isArray(a?.items) && (a.items.length > 0 || !!a.docPr?.canvas) && a.items.every(wordItem)
  && !(a.items.length === 1 && a.items[0].type === 'image' && !a.docPr?.canvas);
/** Resize shape to fit text for a shape with no autoFit in canvas attrs `a`: a Document's own shapes are Word's, which keep their
 * size (Do not Autofit, also what shapes drawn or imported before the setting was kept went out as); a canvas synced with a
 * library flowchart holds a board's shapes, which grow with their text. Format Shape and the canvas editor read it the same way. */
export const fitOf = (a) => !!a?.flow;
/** Whether block node `n` is a floating canvas of Word shapes: it waits for the paragraph it anchors to, as a text box does. */
export const floatingShapes = (n) => n?.type === 'canvas' && !!n.attrs?.layout?.wrap && n.attrs.layout.wrap !== 'inline' && shapeCanvas(n.attrs);

// ---------- text ----------
const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : +e.slice(1))
  : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e] ?? m));
/** A label's html → paragraphs of runs [{text, b, i, u, color, size (px)}]: <br>, <div> and <p> break paragraphs. */
export function htmlParas(html) {
  const paras = [[]];
  const stack = [{}];
  const next = () => { if (paras.at(-1).length) paras.push([]); };
  for (const m of String(html ?? '').matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    if (m[4] != null) { paras.at(-1).push({ text: unesc(m[4]), ...stack.at(-1) }); continue; }
    const tag = m[2].toLowerCase();
    if (tag === 'br') { paras.push([]); continue; }
    if (tag === 'div' || tag === 'p') { next(); continue; }
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const top = { ...stack.at(-1) };
    if (tag === 'b' || tag === 'strong') top.b = true;
    if (tag === 'i' || tag === 'em') top.i = true;
    if (tag === 'u') top.u = true;
    const style = /style\s*=\s*"([^"]*)"/i.exec(m[3])?.[1] ?? '';
    const color = /(?:^|;)\s*color\s*:\s*(#[0-9a-f]{6})/i.exec(style)?.[1];
    const size = /font-size\s*:\s*([\d.]+)px/i.exec(style)?.[1];
    if (color) top.color = color.toUpperCase();
    if (size) top.size = +size;
    stack.push(top);
  }
  while (paras.length > 1 && !paras.at(-1).length) paras.pop();
  return paras;
}
const JC = { left: 'left', center: 'center', right: 'right' };
// The w:pPr children that follow w:jc (ECMA-376 CT_PPr's order).
const AFTER_JC = /<w:(textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b/;
/** Paragraph `i`'s w:pPr children for item `it` aligned `align`. Word's own (it.pPr, shapes-in.mjs) go back as they came while
 * the label keeps the alignment it came with, else with `align` in place of their w:jc. Text made in the app gets appPPr, at least
 * it.paraLine twips high (a text item, textXml). ponytail:
 * paragraphs pair with Word's by index, so text the app splits or joins shifts the later ones' properties; pair them by content if
 * that loses formatting users notice. */
function pPrXml(it, i, align) {
  const kept = it.pPr?.xml;
  if (!Array.isArray(kept) || !kept.length) return appPPr(JC[align] ?? 'center', it.paraLine);
  const x = String(kept[Math.min(i, kept.length - 1)] ?? '');
  if (it.pPr.align === align) return x;
  const cut = AFTER_JC.exec(x)?.index ?? x.length;
  return x.slice(0, cut).replace(/<w:jc\b[^>]*\/>/, '') + el('w:jc', { 'w:val': JC[align] ?? 'center' }) + x.slice(cut);
}
/** Shape item `it`'s label as w:txbxContent paragraphs; sizes × k (the canvas's display scale). Text in the colour its font
 * reference gives (a held textColor link) names no colour, so it follows the reference in Word as it came. */
function txbx(it, k) {
  const base = { size: it.size ?? 16, color: it.textColor ?? '#000000' };
  const align = it.align ?? kindOf(it.shape)?.align ?? 'center';
  const font = it.font ? el('w:rFonts', { 'w:ascii': it.font, 'w:hAnsi': it.font, 'w:cs': it.font }) : '';
  const byRef = !!(it.styleRefs?.fontRef && heldLink(it, 'textColor'));
  const ps = htmlParas(it.html).map((runs, i) => {
    const rs = runs.map((r) => {
      const sz = R(((r.size ?? base.size) * k * 2) / PX);
      const rPr = font + (it.bold || r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') + (byRef && !r.color ? '' : el('w:color', { 'w:val': (r.color ?? base.color).replace('#', '').slice(0, 6).toUpperCase() }))
        + el('w:sz', { 'w:val': sz }) + el('w:szCs', { 'w:val': sz }) + (r.u ? '<w:u w:val="single"/>' : '');
      return r.text.split('\t').map((t) => (t ? `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>` : '')).join(`<w:r><w:rPr>${rPr}</w:rPr><w:tab/></w:r>`);
    }).join('');
    const pPr = pPrXml(it, i, align);
    return `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${rs}</w:p>`;
  });
  return `<wps:txbx><w:txbxContent>${ps.join('')}</w:txbxContent></wps:txbx>`;
}

// ---------- one item ----------
// Colours go out through their theme links while those hold (dml.mjs colorXml), else as themselves.
const solid = (it, path) => `<a:solidFill>${colorXml(it, path)}</a:solidFill>`;
/** Whether item `it` draws a fill. */
const filled = (it) => fillable(it.shape) && it.fill !== 'none' && !!it.fillColor;
export function fillXml(it) {
  if (!filled(it)) return '<a:noFill/>';
  if (heldGradient(it)) return xmlOf(gradFillEl(it));
  if (heldPattern(it)) return xmlOf(pattFillEl(it, 'pattern'));
  if (it.fill === 'hatch') return `<a:pattFill prst="wdUpDiag"><a:fgClr>${colorXml(it, 'fillColor')}</a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:bgClr></a:pattFill>`;
  return solid(it, 'fillColor');
}
/** wps:bodyPr: Word's own defaults (it writes every one of them) under `own` (an attribute set to null is left out), around the
 * plain text warp and `fit` (a:noAutofit or a:spAutoFit). Text boxes (export.mjs) write theirs through it too. Word's third
 * setting, a:normAutofit (Shrink text on overflow), is PowerPoint's: Word's Format Shape offers only the check box, and the import
 * reads it as Do not Autofit. */
export const bodyPrXml = (own, fit = '<a:noAutofit/>') => el('wps:bodyPr', { rot: 0, spcFirstLastPara: 0, vertOverflow: 'overflow', horzOverflow: 'overflow', vert: 'horz', wrap: 'square',
  lIns: 91440, tIns: 45720, rIns: 91440, bIns: 45720, numCol: 1, spcCol: 0, rtlCol: 0, fromWordArt: 0, anchor: 't', anchorCtr: 0, forceAA: 0, compatLnSpc: 1, ...own },
`<a:prstTxWarp prst="textNoShape"><a:avLst/></a:prstTxWarp>${fit}`);
const lined = (it) => !!it.width && !!it.color && it.color !== 'transparent';
export function lineXml(it, k) {
  if (!lined(it)) return hiddenXml(it.hidden, { line: false, fill: true }).ln;
  const dash = it.prstDash && (DASH_IN[it.prstDash] === it.dash || (!DASH_IN[it.prstDash] && it.dash === 'dashed')) ? it.prstDash : DASH_OUT[it.dash ?? 'solid'] ?? 'solid';
  const end = (name, h) => (HEAD_OUT[h] ? el(name, { type: HEAD_OUT[h] }) : '');
  const heads = it.type === 'connector' ? end('a:headEnd', it.heads?.start) + end('a:tailEnd', it.heads?.end ?? 'arrow')
    : it.shape === 'arrow' ? '<a:tailEnd type="triangle"/>' : '';
  return el('a:ln', { w: R(it.width * k * EMU_PX) }, solid(it, 'color') + el('a:prstDash', { val: dash }) + heads);
}
// A held shadow link carries its own transparency (a:alpha), so it goes out as it came. Without a shadow, a shape whose style
// names theme effects says it has none, or Word would draw the style's shadow the board does not show.
// ponytail: that also drops a style's glow or soft edges, which the board has no form for; keep them when items can hold them.
export const shadowXml = (it, k) => {
  const s = it.shadow;
  if (!s || !Number.isFinite(s.dist)) return Number(it.styleRefs?.effectRef?.idx) > 0 ? '<a:effectLst/>' : '';
  return `<a:effectLst>${el('a:outerShdw', { blurRad: R((s.blur ?? 0) * 12700 * k), dist: R(s.dist * 12700 * k), dir: R((((s.angle ?? 45) % 360) + 360) % 360 * 60000), algn: 'ctr', rotWithShape: 0 },
    colorXml(it, 'shadow.color', `${String(s.color ?? '#000000').slice(0, 7)}${R((s.alpha ?? 0.6) * 255).toString(16).padStart(2, '0')}`))}</a:effectLst>`;
};

/** Custom path parts (unit square) → a:custGeom, each path in a 100000 × 100000 space of its own (Word scales it to the shape). */
function custGeom(parts, cx = 100000, cy = 100000) {
  const paths = parts.map((p) => {
    let xml = '';
    for (const [, c, args] of p.d.matchAll(/([MLQCZ])([^MLQCZ]*)/g)) {
      const n = args.split(/[ ,]+/).filter(Boolean).map(Number);
      const pts = Array.from({ length: n.length / 2 }, (_, i) => el('a:pt', { x: R(n[2 * i] * cx), y: R(n[2 * i + 1] * cy) })).join('');
      xml += c === 'M' ? `<a:moveTo>${pts}</a:moveTo>` : c === 'L' ? `<a:lnTo>${pts}</a:lnTo>` : c === 'Q' ? `<a:quadBezTo>${pts}</a:quadBezTo>` : c === 'C' ? `<a:cubicBezTo>${pts}</a:cubicBezTo>` : '<a:close/>';
    }
    return el('a:path', { w: Math.max(1, R(cx)), h: Math.max(1, R(cy)), fill: p.fill && p.fill !== 'norm' ? p.fill : null, stroke: p.stroke === false ? 0 : null }, xml);
  });
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst>${paths.join('')}</a:pathLst></a:custGeom>`;
}

/** Shape item `it`'s geometry: the preset its kind draws with its adjust values (a 'path' item's own preset, or its custom path), the
 * nearest preset for a board kind without one, or the unknown name a rectangle kept. → {xml, flipH, flipV, rot}. */
function geometryXml(it) {
  const k = kindOf(it.shape);
  const own = it.shape === 'path' ? (hasPreset(it.prst) ? it.prst : null) : k?.prst ?? null;
  const prst = own ?? (it.shape === 'path' && Array.isArray(it.path) ? null : it.shape === 'rect' && it.prst ? it.prst : KIND_PRESET[it.shape] ?? 'rect');
  const lineish = isLineish(it.shape);
  const mirrorX = it.shape === 'lean-l' ? !it.mirrorX : !!it.mirrorX; // the reversed Data is Word's flipped one
  const flipH = lineish ? !!it.flipX : mirrorX;
  const flipV = lineish ? !!it.flipY : !!it.mirrorY;
  const rot = (((it.rot ?? 0) % 360) + 360) % 360;
  const av = own && it.av ? Object.entries(it.av).map(([n, v]) => el('a:gd', { name: n, fmla: `val ${R(v)}` })).join('') : '';
  return { xml: prst ? `<a:prstGeom prst="${esc(prst)}"><a:avLst>${av}</a:avLst></a:prstGeom>` : custGeom(it.path), flipH, flipV, rot };
}

/** One item as a wps:wsp: `box` its unrotated box in EMU in its container, `k` the scale for widths and sizes, `id` its cNvPr id
 * (null at the top, where wp:docPr names it), `fit` the Resize shape to fit text of a shape with no autoFit (fitOf). */
function wsp(it, box, k, id, fit = false) {
  const nv = id == null ? '' : el('wps:cNvPr', { id, name: `${it.type === 'connector' ? 'Straight Connector' : 'Shape'} ${id}` });
  const xfrm = (x) => el('a:xfrm', { rot: x.rot ? R(x.rot * 60000) : null, flipH: x.flipH ? 1 : null, flipV: x.flipV ? 1 : null },
    el('a:off', { x: R(box.x), y: R(box.y) }) + el('a:ext', { cx: R(box.w), cy: R(box.h) }));
  if (it.type === 'connector') {
    const g = { flipH: it.from.x > it.to.x, flipV: it.from.y > it.to.y };
    return `<wps:wsp>${nv}<wps:cNvCnPr/><wps:spPr>${xfrm(g)}<a:prstGeom prst="${esc(it.prst ?? lineGeometry(it))}"><a:avLst/></a:prstGeom><a:noFill/>${lineXml(it, k)}</wps:spPr>${refsXml(it.styleRefs)}<wps:bodyPr/></wps:wsp>`;
  }
  const g = geometryXml(upgradedShape(it)); // a draft from before every preset had a kind keeps its preset
  const ins = (s, d) => (Number.isFinite(it.inset?.[s]) ? R(it.inset[s] * k * EMU_PX) : d);
  const text = typeof it.html === 'string' ? txbx(it, k) : ''; // an empty label is a text body still, as Word's callouts have
  const body = bodyPrXml({ lIns: ins('l', 91440), tIns: ins('t', 45720), rIns: ins('r', 91440), bIns: ins('b', 45720),
    anchor: { top: 't', middle: 'ctr', bottom: 'b' }[it.valign ?? kindOf(it.shape)?.valign ?? 'middle'] ?? 'ctr' }, (it.autoFit ?? fit) ? '<a:spAutoFit/>' : '<a:noAutofit/>');
  const ext = hiddenXml(it.hidden, { fill: filled(it), line: lined(it) }).ext;
  return `<wps:wsp>${nv}<wps:cNvSpPr/><wps:spPr>${xfrm(g)}${g.xml}${fillXml(it)}${lineXml(it, k)}${shadowXml(it, k)}${ext}</wps:spPr>${refsXml(it.styleRefs)}${text}${body}</wps:wsp>`;
}
/** Picture item `it` as a pic:pic: `box` its unrotated box in EMU in its container, `id` its cNvPr id, `pic` the relationship ids
 * of its picture {rid, svg} (rid a PNG of it when it is an SVG). Its crop is what a:srcRect cuts from each side, in thousandths of
 * a percent (shapes-in.mjs pictureItem). */
function picXml(it, box, id, pic) {
  const c = it.crop;
  const cut = (v) => (Math.abs(v) > 1e-6 ? R(v * 100000) : null);
  const crop = c ? el('a:srcRect', { l: cut(c.x), t: cut(c.y), r: cut(1 - c.x - c.w), b: cut(1 - c.y - c.h) }) : '';
  const xfrm = el('a:xfrm', { rot: it.rot ? R(it.rot * 60000) : null, flipH: it.mirrorX ? 1 : null, flipV: it.mirrorY ? 1 : null },
    el('a:off', { x: R(box.x), y: R(box.y) }) + el('a:ext', { cx: R(box.w), cy: R(box.h) }));
  return `<pic:pic><pic:nvPicPr>${el('pic:cNvPr', { id, name: `Picture ${id}` })}<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill>${el('a:blip', { 'r:embed': pic.rid }, pictureXml({}, { svg: pic.svg }).blip)}${crop}`
    + `<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`;
}

/** Text item `it` as a text box with no line (its background colour, transparency included, as its fill): `box` its unrotated box in EMU, `id` its cNvPr
 * id. Word sizes it to its text (a:spAutoFit), as the board grows it; a text fitted to its width does not wrap. Its lines are at
 * least the board's line height (TEXT_LINE ems of its size, in twips), which Word's single spacing falls short of. */
function textXml(it, box, k, id) {
  const xfrm = el('a:xfrm', { rot: it.rot ? R(it.rot * 60000) : null }, el('a:off', { x: R(box.x), y: R(box.y) }) + el('a:ext', { cx: R(box.w), cy: R(box.h) }));
  const fill = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(it.bg ?? '') ? `<a:solidFill>${srgbXml(it.bg)}</a:solidFill>` : '<a:noFill/>';
  const ins = (s) => R(TEXT_PAD[s] * k * EMU_PX);
  const body = bodyPrXml({ wrap: it.fit ? 'none' : 'square', lIns: ins('l'), tIns: ins('t'), rIns: ins('r'), bIns: ins('b') }, '<a:spAutoFit/>');
  return `<wps:wsp>${el('wps:cNvPr', { id, name: `Text Box ${id}` })}<wps:cNvSpPr txBox="1"/><wps:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}<a:ln><a:noFill/></a:ln></wps:spPr>`
    + `${txbx({ ...it, textColor: /^#[0-9a-f]{6}$/i.test(it.color ?? '') ? it.color : '#000000', align: it.align ?? 'left', paraLine: R((it.size ?? 20) * k * TEXT_LINE * 20 / PX) }, k)}${body}</wps:wsp>`;
}

// ---------- ink ----------
const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
// The pen's own path (flow/model.mjs smoothPath): M, quadratic curves through the midpoints of the points drawn, then L; a dot is
// "M x y l0 0". Its numbers are the points drawn and the midpoints between them, so the ink goes through every point the pen did
// and shapes-in.mjs inkItem rebuilds the same path.
const PEN_PATH = /^M[^A-Za-z]+(?:Q[^A-Za-z]+)*(?:L[^A-Za-z]+|l0 0)$/;
/** SVG path data `d` → its lines, each a list of [x, y]: the pen's path as its numbers, any other path (an agent's stroke) along
 * its curves, 8 points a curve. ponytail: an arc goes straight to its end; sample it when strokes with arcs matter. */
function pathLines(d) {
  const s = String(d ?? '').trim();
  const pairs = (n) => Array.from({ length: n.length >> 1 }, (_, i) => [n[2 * i], n[2 * i + 1]]);
  if (PEN_PATH.test(s)) return [pairs(s.replace(/l0 0$/, '').match(NUM).map(Number))];
  const lines = [];
  let [p, start, ctl, line] = [[0, 0], [0, 0], null, null];
  const to = (q) => { (line ??= (lines.push([p]), lines.at(-1))).push(q); p = q; };
  const curve = (pts) => { // a Bezier from p through control points `pts` (its end last), sampled
    const all = [p, ...pts];
    for (let i = 1; i <= 8; i++) {
      let q = all;
      while (q.length > 1) q = q.slice(1).map((b, j) => [q[j][0] + (b[0] - q[j][0]) * (i / 8), q[j][1] + (b[1] - q[j][1]) * (i / 8)]);
      to(q[0]);
    }
    ctl = pts.at(-2);
  };
  for (const [, cmd, args] of s.matchAll(/([MLHVQTCSAZ])([^MLHVQTCSAZ]*)/gi)) {
    const n = (args.match(NUM) ?? []).map(Number);
    const C = cmd.toUpperCase();
    const at = (x, y) => (cmd === C ? [x, y] : [p[0] + x, p[1] + y]);
    const mirror = () => (ctl ? [2 * p[0] - ctl[0], 2 * p[1] - ctl[1]] : p); // T and S: the last control point reflected
    if (C === 'Z') { if (line) to(start); [line, p, ctl] = [null, start, null]; continue; }
    const size = { M: 2, L: 2, T: 2, H: 1, V: 1, Q: 4, S: 4, C: 6, A: 7 }[C];
    for (let i = 0; i + size <= n.length; i += size) {
      const v = n.slice(i, i + size);
      if (C === 'Q') curve([at(v[0], v[1]), at(v[2], v[3])]);
      else if (C === 'C') curve([at(v[0], v[1]), at(v[2], v[3]), at(v[4], v[5])]);
      else if (C === 'T') curve([mirror(), at(v[0], v[1])]);
      else if (C === 'S') curve([mirror(), at(v[0], v[1]), at(v[2], v[3])]);
      else {
        ctl = null;
        if (C === 'M' && i === 0) [p, start, line] = [at(v[0], v[1]), at(v[0], v[1]), null];
        else to(C === 'H' ? [cmd === 'H' ? v[0] : p[0] + v[0], p[1]] : C === 'V' ? [p[0], cmd === 'V' ? v[0] : p[1] + v[0]] : C === 'A' ? at(v[5], v[6]) : at(v[0], v[1]));
      }
    }
    if (C === 'M' && !line) lines.push(line = [p]); // a lone M is a dot
  }
  return lines;
}
/** Stroke item `it`'s lines in canvas px, as the board draws it: its path stretched from its viewBox to its box, mirrored and
 * turned about the box's centre, to a tenth of a px (the pen's own grid). [] when its path has no points. */
export function strokeLines(it) {
  const [sx, sy] = [it.w / it.vw, it.h / it.vh];
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return [];
  const c = { x: it.x + it.w / 2, y: it.y + it.h / 2 };
  return pathLines(it.d).map((l) => l.map(([x, y]) => {
    const p = { x: it.x + x * sx, y: it.y + y * sy };
    const q = rotatePoint({ x: it.mirrorX ? 2 * c.x - p.x : p.x, y: it.mirrorY ? 2 * c.y - p.y : p.y }, c, it.rot ?? 0);
    return { x: r1(q.x), y: r1(q.y) };
  }));
}
const bbox = (pts) => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const [x, y] = [Math.min(...xs), Math.min(...ys)];
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
/** Stroke item `it` as an InkML part, as Word's Draw tab writes ink: one trace a line, in tenths of a canvas px from the lines' top
 * left (an integer channel at INK_RES; Word stretches the lines' box to the w14:xfrm's), and a brush of its colour and its width
 * at the canvas's display scale `k` in cm. Its opacity goes out as Word's highlighter or pencil brush where it is theirs, else as
 * the brush's transparency. A colour that is not '#rrggbb' goes out black. */
function inkml(it, lines, k) {
  const b = bbox(lines.flat());
  const trace = (l) => l.map((p) => `${R((p.x - b.x) * INK_RES)} ${R((p.y - b.y) * INK_RES)}`).join(', ');
  const max = Math.max(32767, R(Math.max(b.w, b.h) * INK_RES));
  const prop = (name, value, units) => el('inkml:brushProperty', { name, value, units });
  const cm = Math.round(((it.width ?? 1) * k * 2.54 * 1e6) / 96) / 1e6;
  const o = it.opacity ?? 1;
  const look = o === HIGHLIGHTER ? prop('tip', 'rectangle') + prop('rasterOp', 'maskPen') : o === PENCIL ? prop('inkEffects', 'pencil')
    : o < 1 ? prop('transparency', R((1 - Math.max(0, o)) * 255)) : '';
  const res = Math.round(((INK_RES * 96) / 2.54) * 1e6) / 1e6; // per cm
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<inkml:ink xmlns:inkml="http://www.w3.org/2003/InkML"><inkml:definitions>'
    + '<inkml:context xml:id="ctx0"><inkml:inkSource xml:id="inkSrc0"><inkml:traceFormat>'
    + `${el('inkml:channel', { name: 'X', type: 'integer', max, units: 'cm' })}${el('inkml:channel', { name: 'Y', type: 'integer', max, units: 'cm' })}</inkml:traceFormat>`
    + `<inkml:channelProperties>${el('inkml:channelProperty', { channel: 'X', name: 'resolution', value: res, units: '1/cm' })}${el('inkml:channelProperty', { channel: 'Y', name: 'resolution', value: res, units: '1/cm' })}</inkml:channelProperties>`
    + `</inkml:inkSource></inkml:context><inkml:brush xml:id="br0">${prop('width', cm, 'cm')}${prop('height', cm, 'cm')}${prop('color', /^#[0-9a-f]{6}$/i.test(it.color ?? '') ? it.color : '#000000')}`
    + `${look}${prop('fitToCurve', 1)}</inkml:brush></inkml:definitions>${lines.map((l) => `<inkml:trace contextRef="#ctx0" brushRef="#br0">${trace(l)}</inkml:trace>`).join('')}</inkml:ink>`;
}
/** Stroke item `it` as Word ink in a drawing canvas or group: a w14:contentPart naming its InkML part (`ink(xml)` → relationship
 * id), its box the lines' box (`s` EMU per canvas px). Turns and flips are in the points, so it has none of its own. */
function inkXml(it, s, k, id, ink) {
  const lines = strokeLines(it);
  const b = bbox(lines.flat());
  const xfrm = el('a:off', { x: R(b.x * s), y: R(b.y * s) }) + el('a:ext', { cx: R(b.w * s), cy: R(b.h * s) });
  return `<w14:contentPart bwMode="auto" r:id="${esc(ink(inkml(it, lines, k)))}"><w14:nvContentPartPr>${el('w14:cNvPr', { id, name: `Ink ${id}` })}<w14:cNvContentPartPr/></w14:nvContentPartPr>`
    + `<w14:xfrm>${xfrm}</w14:xfrm></w14:contentPart>`;
}

/** Item `it`'s unrotated box in canvas px: a shape's x, y, w, h; a connector's ends; a text item's with its height as drawn (or
 * its lines' at the board's 1.3 line height before a board has drawn it). */
export const boxOf = (it) => (it.type === 'connector'
  ? { x: Math.min(it.from.x, it.to.x), y: Math.min(it.from.y, it.to.y), w: Math.abs(it.to.x - it.from.x), h: Math.abs(it.to.y - it.from.y) }
  : it.type === 'text' && !Number.isFinite(it.h) ? { x: it.x, y: it.y, w: it.w, h: htmlParas(it.html).length * (it.size ?? 20) * TEXT_LINE + TEXT_PAD.t + TEXT_PAD.b }
    : { x: it.x, y: it.y, w: it.w, h: it.h });
const scaled = (b, s) => ({ x: b.x * s, y: b.y * s, w: b.w * s, h: b.h * s });

/**
 * Canvas attrs `a` as a w:drawing of Word shapes, or null when the canvas holds something else (shapeCanvas). `id()` hands out
 * wp:docPr and cNvPr ids; `placed(cx, cy, docPr, graphic, layout)` wraps the graphic in wp:inline or wp:anchor; `image(it)` gives
 * the relationship ids {rid, svg} of picture item `it`'s picture and, for an SVG, of a PNG of it as rid; `ink(xml)` writes an
 * InkML part and gives its relationship id (export.mjs). → {xml, id (the drawing's wp:docPr id), floating}.
 */
export function shapeDrawing(a, { id, placed, image, ink }) {
  if (!shapeCanvas(a)) return null;
  const fit = fitOf(a);
  const k = a.w > 0 && a.dw > 0 ? a.dw / a.w : 1; // display px per canvas px
  const did = id();
  const L = a.layout?.wrap && a.layout.wrap !== 'inline' ? a.layout : null;
  const items = normalizeGroups(a.items);
  const pr = (name) => el('wp:docPr', { id: did, name: a.docPr?.name ?? `${name} ${did}`, descr: a.docPr?.alt || null }, decorativeXml(a.docPr?.decorative));
  // The drawing's position: the canvas's, moved to where its box starts (a shape the canvas grew around).
  const at = (b) => (!L ? L : { ...L, h: L.h?.offset != null && !L.h.align ? { ...L.h, offset: Math.round((L.h.offset + (b.x * k) / PX) * 100) / 100 } : L.h,
    v: L.v?.offset != null && !L.v.align ? { ...L.v, offset: Math.round((L.v.offset + (b.y * k) / PX) * 100) / 100 } : L.v });
  const graphic = (uri, inner) => `<a:graphic><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic>`;
  // A Word drawing canvas (docPr.canvas, from the import) goes out as one, whatever it holds. A lone stroke or text item does too:
  // Word's ink and text boxes stand alone only as inline ink and the textBox node.
  const wpc = a.docPr?.canvas ?? null;
  if (items.length === 1 && !wpc && (items[0].type === 'shape' || items[0].type === 'connector')) {
    const b = boxOf(items[0]);
    const e = scaled(b, k * EMU_PX);
    return { xml: placed(R(e.w), R(e.h), pr(items[0].type === 'connector' ? 'Straight Connector' : 'Shape'), graphic(URI.wps, wsp(items[0], { ...e, x: 0, y: 0 }, k, null, fit)), at(b)), id: did, floating: !!L };
  }
  // Several: one group (every item in one outer group) as wpg:wgp scaled by its chExt, else a wpc:wpc drawing canvas in display EMU.
  const top = units(items, null);
  const G = !wpc && top.length === 1 ? items[0].groups?.at(-1) : null;
  const s = G ? EMU_PX : k * EMU_PX;
  // A group straight inside a drawing canvas is a wpg:wgp; deeper ones, and those in a group, are wpg:grpSp.
  const tree = (list, scope) => units(list, scope).map((u) => {
    const gs = u[0].groups ?? [];
    const g = gs[(scope ? gs.indexOf(scope) : gs.length) - 1];
    if (u.length === 1 && !g) {
      const it = u[0];
      const box = scaled(boxOf(it), s);
      return it.type === 'image' ? picXml(it, box, id(), image(it)) : it.type === 'stroke' ? inkXml(it, s, k, id(), ink)
        : it.type === 'text' ? textXml(it, box, k, id()) : wsp(it, box, k, id(), fit);
    }
    const bs = u.map((it) => scaled(boxOf(it), s));
    const [x, y] = [Math.min(...bs.map((b) => b.x)), Math.min(...bs.map((b) => b.y))];
    const [w, h] = [Math.max(...bs.map((b) => b.x + b.w)) - x, Math.max(...bs.map((b) => b.y + b.h)) - y];
    const box = el('a:off', { x: R(x), y: R(y) }) + el('a:ext', { cx: R(w), cy: R(h) });
    const gid = id();
    const tag = scope == null && !G ? 'wpg:wgp' : 'wpg:grpSp';
    return `<${tag}>${el('wpg:cNvPr', { id: gid, name: `Group ${gid}` })}<wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm>${box}${box.replace('a:off', 'a:chOff').replace('a:ext', 'a:chExt')}</a:xfrm></wpg:grpSpPr>${tree(u, g)}</${tag}>`;
  }).join('');
  const [cx, cy] = [R(a.w * k * EMU_PX), R(a.h * k * EMU_PX)];
  const bg = wpc?.bg?.color ? `<wpc:bg><a:solidFill>${wpc.bg.el ? clrXml(wpc.bg) : srgbXml(wpc.bg.color)}</a:solidFill></wpc:bg>` : '<wpc:bg/>';
  const inner = G
    ? `<wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/>${el('a:ext', { cx, cy })}<a:chOff x="0" y="0"/>${el('a:chExt', { cx: R(a.w * EMU_PX), cy: R(a.h * EMU_PX) })}</a:xfrm></wpg:grpSpPr>${tree(items, G)}</wpg:wgp>`
    : `<wpc:wpc>${bg}<wpc:whole/>${tree(items, null)}</wpc:wpc>`;
  return { xml: placed(cx, cy, pr(G ? 'Group' : 'Canvas'), graphic(G ? URI.wpg : URI.wpc, inner), at({ x: 0, y: 0 })), id: did, floating: !!L };
}
