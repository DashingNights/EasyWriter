// Word shapes into the app's model of a Word shape (docs/plans/word/left-out.md package 1): a canvas node holding board items, as
// Insert > Shapes makes one. A wps:wsp that is not a text box, a wpg:wgp group, a wpc:wpc drawing canvas and a SmartArt diagram
// (its pre-drawn dsp:drawing part) become one canvas each: shapes as board shape items (the kind that draws the preset, with its adjust
// values, or the 'path' kind for custom geometry), lines as free connectors, pictures as image items (an SVG with Word's PNG of it),
// ink as pen strokes, the app's text labels (text boxes with no line) as text items, groups as item groups (canvas-native-export).
// Pure: import.mjs hands in the drawing (wp:inline or wp:anchor, the DrawingML that VML translates into too) and a context.
import { dmlColor, fillEl, hiddenOf, linkOf, pathGet, pictureSource, shapeLook, xmlOf } from './dml.mjs';
import { normalizeGroups, smoothPath } from '../../flow/model.mjs';
import { builtins, evalGuides, pathWriter } from '../../flow/presets.mjs';
import { drawnBox, presetKind, rotatePoint, rotBox } from '../../flow/shapes.mjs';
import { penToBoard } from '../wp/draw/pens.mjs';

const loc = (n) => (typeof n?.name === 'string' ? n.name.slice(n.name.indexOf(':') + 1) : null);
const lkids = (n, name) => (n?.kids ?? []).filter((k) => typeof k === 'object' && (!name || loc(k) === name));
const lkid = (n, name) => lkids(n, name)[0] ?? null;
const at = (n, a) => n?.attrs?.[a] ?? null;
const num = (s) => (s == null || s === '' || Number.isNaN(+s) ? null : +s);
const on = (s) => s === '1' || s === 'true' || s === 'on';
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
export const EMU_PX = 9525; // EMU per board px (a CSS px at the canvas's own scale)
export const PX = 96 / 72; // board px per point
/** InkML units per canvas px in the ink export writes: tenths, the pen's own grid (flow/model.mjs smoothPath), so they are whole. */
export const INK_RES = 10;
export const URI = {
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape', wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  wpc: 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas', dgm: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
};

// ---------- geometry ----------
/** The presets that are lines: they import as free connectors with their route. */
export const LINE_ROUTE = { line: 'straight', straightConnector1: 'straight', bentConnector2: 'ortho', bentConnector3: 'ortho', bentConnector4: 'ortho',
  bentConnector5: 'ortho', curvedConnector2: 'curve', curvedConnector3: 'curve', curvedConnector4: 'curve', curvedConnector5: 'curve' };

/** The preset a connector `c` writes as when it names none: a straight line with heads is straightConnector1, without them line. */
export const lineGeometry = (c) => ({ ortho: 'bentConnector3', curve: 'curvedConnector3' }[c.route]
  ?? (c.heads?.start !== 'none' || c.heads?.end !== 'none' ? 'straightConnector1' : 'line'));

/** a:avLst → {name: value} of its 'val n' guides. */
const adjustOf = (av) => Object.fromEntries(lkids(av, 'gd').map((g) => [at(g, 'name'), num(String(at(g, 'fmla') ?? '').replace(/^\s*val\s+/, ''))]).filter(([, v]) => v != null));

/** A shape's geometry (spPr's a:prstGeom or a:custGeom, its extent in EMU) → the item fields that draw it: the kind that draws the
 * preset (src/flow/shapes.mjs: a board kind or the preset's own, by its guide maths) with the file's adjust values, so export writes
 * the same prstGeom back; custom geometry as the 'path' kind; a name no preset has as a rectangle that keeps the name. */
export function geometryOf(spPr, cx, cy) {
  const pg = lkid(spPr, 'prstGeom');
  const cg = lkid(spPr, 'custGeom');
  if (cg) return { shape: 'path', path: customPath(cg, cx, cy) };
  const prst = at(pg, 'prst') ?? 'rect';
  const av = adjustOf(lkid(pg, 'avLst'));
  const kind = presetKind(prst);
  return kind ? { shape: kind, ...(Object.keys(av).length && { av }) } : { shape: 'rect', prst };
}

/** a:custGeom in a shape cx × cy EMU → path parts [{d (unit square), fill, stroke}]; guides and points may name guides. */
export function customPath(cg, cx, cy) {
  const vars = evalGuides([...lkids(lkid(cg, 'avLst'), 'gd'), ...lkids(lkid(cg, 'gdLst'), 'gd')].map((g) => [at(g, 'name'), at(g, 'fmla')]), builtins(cx || 1, cy || 1));
  const v = (s) => (s in vars ? vars[s] : num(s) ?? 0);
  return lkids(lkid(cg, 'pathLst'), 'path').map((p) => {
    const [pw, ph] = [num(at(p, 'w')) || cx || 1, num(at(p, 'h')) || cy || 1];
    const w = pathWriter((x, y) => `${r4(x / pw)} ${r4(y / ph)}`);
    for (const c of lkids(p)) {
      const pts = lkids(c, 'pt').flatMap((q) => [v(at(q, 'x')), v(at(q, 'y'))]);
      switch (loc(c)) {
        case 'moveTo': w.move(...pts); break;
        case 'lnTo': w.line(...pts); break;
        case 'quadBezTo': w.quad(...pts); break;
        case 'cubicBezTo': w.cubic(...pts); break;
        case 'arcTo': w.arc(v(at(c, 'wR')), v(at(c, 'hR')), v(at(c, 'stAng')) / 60000, v(at(c, 'swAng')) / 60000); break;
        case 'close': w.close(); break;
        default: break;
      }
    }
    const fill = at(p, 'fill') ?? 'norm';
    return { d: w.d, ...(fill !== 'norm' && { fill }), ...(at(p, 'stroke') != null && !on(at(p, 'stroke')) && { stroke: false }) };
  }).filter((p) => p.d);
}

// ---------- look ----------
const DASH = { solid: 'solid', dot: 'dotted', sysDot: 'dotted' };
/** The DrawingML dash export writes for each board dash; another one the file had rides along as prstDash. */
export const DASH_OUT = { solid: 'solid', dashed: 'dash', dotted: 'sysDot' };
const HEAD = { triangle: 'triangle', stealth: 'triangle', arrow: 'arrow', diamond: 'diamond', oval: 'circle' };

/** Fill of shapeLook → item fields: solid, none, a gradient over its middle colour (with what Word says of its tile, path, focus
 * and flip, dml.mjs gradientOf), or a pattern over its foreground colour, which the board draws as an SVG pattern while
 * fillColor is still that colour. ponytail: a picture or texture fill draws and exports as none; keep its picture (and a
 * relationship for it in shapes-out.mjs) when a board item can hold one. */
export const fillFields = (f) => {
  if (f.type === 'solid') return { fill: 'solid', fillColor: f.color };
  if (f.type === 'gradient') {
    const { type, link, color, stops, ...g } = f;
    return { fill: 'solid', fillColor: color, gradient: { ...g, stops: stops.map(({ pos, color: c }) => ({ pos, color: c })) } };
  }
  if (f.type === 'pattern') return { fill: 'solid', fillColor: f.fg, pattern: { prst: f.prst, fg: f.fg, bg: f.bg } };
  return { fill: 'none', fillColor: '#FFFFFF' };
};
/** The theme links of a look's fill (shapeLook), by the item field each colour went to. */
export const fillLinks = (f) => (f.type === 'solid' ? { fillColor: f.link }
  : f.type === 'gradient' ? Object.fromEntries(f.stops.map((s, i) => [`gradient.stops.${i}.color`, s.link]))
    : f.type === 'pattern' ? { fillColor: f.links.fg, 'pattern.fg': f.links.fg, 'pattern.bg': f.links.bg } : {});
/** `item` with the links of its colours (`links`: item field → link or null) as themeColors and its style references `refs`
 * as styleRefs (dml.mjs): what Design > Colors re-resolves and export writes back. */
export function themed(item, links, refs) {
  const held = {};
  for (const [p, l] of Object.entries(links)) {
    const v = pathGet(item, p);
    if (l && HEX.test(v ?? '')) held[p] = { ...l, color: v };
  }
  if (Object.keys(held).length) item.themeColors = held;
  if (refs) item.styleRefs = refs;
  return item;
}
/** Line of shapeLook → item fields (width in board px, to four decimals so export gives back Word's EMU). */
export function lineFields(ln) {
  if (!ln) return { color: 'transparent', width: 0 };
  const dash = DASH[ln.dash] ?? 'dashed';
  return { color: ln.fill.color, width: r4(ln.width / EMU_PX), ...(dash !== 'solid' && { dash }), ...(DASH_OUT[dash] !== ln.dash && { prstDash: ln.dash }) };
}

// ---------- text ----------
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const HEX = /^#[0-9A-F]{6}([0-9A-F]{2})?$/i;
const ALIGN = { left: 'left', start: 'left', l: 'left', center: 'center', ctr: 'center', right: 'right', end: 'right', r: 'right', both: 'left', just: 'left' };
// The prefixes kept paragraph XML may use: ones every part export.mjs writes declares (ROOT_NS). Others, such as w16du:dateUtc on a
// tracked change (a copy of its date that Word does without), are left out, or the part would not parse.
const DECLARED = /^(w|w14|w15|xml):|^[^:]*$/;
const declared = (n) => (typeof n === 'string' ? n : { name: n.name, attrs: Object.fromEntries(Object.entries(n.attrs ?? {}).filter(([k]) => DECLARED.test(k))),
  kids: (n.kids ?? []).filter((k) => typeof k === 'string' || DECLARED.test(k.name)).map(declared) });
/** w:txbxContent's paragraphs → [{align, runs: [{text, b, i, u, color, size (pt), font}], pPr (its w:pPr's children as XML)}]. */
function wordParas(content, ctx) {
  const paras = [];
  const walk = (n) => {
    for (const k of lkids(n)) {
      if (k.name === 'w:p') paras.push(wordPara(k, ctx));
      else if (k.name !== 'w:pPr') walk(k);
    }
  };
  walk(content);
  return paras;
}
function wordPara(p, ctx) {
  const pPr = lkid(p, 'pPr');
  const runs = [];
  const walk = (n) => {
    for (const k of lkids(n)) {
      if (k.name === 'w:r') {
        const rp = lkid(k, 'rPr');
        const flag = (name) => { const e = lkid(rp, name); return !!e && !/^(0|false|off|none)$/i.test(at(e, 'w:val') ?? ''); };
        const f = lkid(rp, 'rFonts');
        const theme = at(f, 'w:asciiTheme') ?? at(f, 'w:hAnsiTheme');
        const c = at(lkid(rp, 'color'), 'w:val');
        const sz = num(at(lkid(rp, 'sz'), 'w:val'));
        const style = { b: flag('b'), i: flag('i'), u: flag('u'), color: c && c !== 'auto' ? `#${c.toUpperCase()}` : null, size: sz ? sz / 2 : null,
          font: theme ? ctx.fonts?.[theme.startsWith('major') ? 'major' : 'minor'] ?? null : at(f, 'w:ascii') ?? at(f, 'w:hAnsi') };
        let text = '';
        for (const t of lkids(k)) text += t.name === 'w:t' ? t.kids.filter((x) => typeof x === 'string').join('') : t.name === 'w:tab' ? '\t' : t.name === 'w:br' || t.name === 'w:cr' ? '\n' : '';
        if (text) runs.push({ text, ...style });
      } else if (['w:hyperlink', 'w:ins', 'w:smartTag', 'w:sdt', 'w:sdtContent', 'w:fldSimple', 'w:customXml'].includes(k.name)) walk(k);
    }
  };
  walk(p);
  const sp = lkid(pPr, 'spacing');
  const own = lkids(pPr).filter((k) => DECLARED.test(k.name));
  return { align: ALIGN[at(lkid(pPr, 'jc'), 'w:val')] ?? null, runs, pPr: own.map((k) => xmlOf(declared(k))).join(''), jc: at(lkid(pPr, 'jc'), 'w:val'),
    spacing: sp && { before: num(at(sp, 'w:before')) ?? 0, after: num(at(sp, 'w:after')), line: num(at(sp, 'w:line')), rule: at(sp, 'w:lineRule') ?? 'auto' },
    others: own.filter((k) => !['w:spacing', 'w:jc', 'w:rPr'].includes(k.name)).length };
}
/** a:p paragraphs (SmartArt's dsp:txBody) → the same shape. */
function drawingParas(body, ctx) {
  return lkids(body, 'p').map((p) => {
    const runs = [];
    for (const k of lkids(p)) {
      const rp = lkid(k, 'rPr');
      const text = loc(k) === 'br' ? '\n' : ['r', 'fld'].includes(loc(k)) ? (lkid(k, 't')?.kids ?? []).filter((x) => typeof x === 'string').join('') : '';
      if (!text) continue;
      const fill = fillEl(rp);
      const sz = num(at(rp, 'sz'));
      runs.push({ text, b: on(at(rp, 'b')), i: on(at(rp, 'i')), u: !!at(rp, 'u') && at(rp, 'u') !== 'none',
        color: fill?.name === 'a:solidFill' ? ctx.color(fill) : null, size: sz ? sz / 100 : null, font: at(lkid(rp, 'latin'), 'typeface') });
    }
    return { align: ALIGN[at(lkid(p, 'pPr'), 'algn')] ?? null, runs };
  });
}
/** Paragraphs → label fields: html (escaped text, b/i/u and spans where a run differs), size (px), textColor, bold, font, align;
 * null with no text to show. A Word text body (`word`) stays even empty, as Word writes one, centred, into every callout for the
 * text to come, and keeps each paragraph's own properties: pPr {align (the label's as read), xml: [w:pPr's children, per
 * paragraph]}, which shapes-out.mjs writes back. Text the app wrote (appPara in every paragraph, `atLeast` for a text item's
 * line spacing) reads back as the app's. */
function labelOf(paras, base, word = false, atLeast = false) {
  const runs = paras.flatMap((p) => p.runs);
  const shown = runs.some((r) => r.text.trim());
  if (!shown && !(word && paras.length)) return null;
  const first = runs.find((r) => r.text.trim()) ?? {};
  const size = first.size ?? base.size;
  const color = first.color ?? base.color;
  const font = first.font ?? base.font;
  const bold = shown && runs.every((r) => r.b || !r.text.trim());
  const html = paras.map((p) => p.runs.map((r) => {
    let s = esc(r.text).replace(/\n/g, '<br>');
    const css = [r.color && r.color !== color && HEX.test(r.color) ? `color:${r.color}` : '', (r.size ?? base.size) !== size ? `font-size:${r2((r.size ?? base.size) * PX)}px` : ''].filter(Boolean);
    if (css.length) s = `<span style="${css.join(';')}">${s}</span>`;
    if (r.u) s = `<u>${s}</u>`;
    if (r.i) s = `<i>${s}</i>`;
    if (r.b && !bold) s = `<b>${s}</b>`;
    return s;
  }).join('')).join('<br>');
  const align = (paras.find((p) => p.runs.length) ?? paras[0]).align ?? 'left';
  return { html, size: r2(size * PX), textColor: HEX.test(color ?? '') ? color : '#000000', bold, ...(font && { font }), align,
    ...(word && !paras.every((p) => appPara(p, atLeast) && (p.align ?? 'left') === align) && { pPr: { align, xml: paras.map((p) => p.pPr) } }) };
}
const VALIGN = { t: 'top', ctr: 'middle', b: 'bottom' };
/** The paragraph properties shapes-out.mjs writes for text made in the app, aligned `align`: no space after and single spacing (a
 * shape's label), or lines at least `line` twips high (a text item, at the board's line height). */
export const appPPr = (align, line = null) => `<w:spacing w:after="0" w:line="${line ?? 240}" w:lineRule="${line ? 'atLeast' : 'auto'}"/><w:jc w:val="${align}"/>`;
/** Whether paragraph `p` (wordPara) has properties appPPr writes: no space before or after, single spacing (or, with `atLeast`, an
 * at-least line height), left, centred or right, and nothing else but the paragraph mark's run properties. The values count, not
 * their order or form, so a paragraph Word rewrites as the text is edited in Word still reads as the app's. */
function appPara(p, atLeast = false) {
  const s = p.spacing;
  return !!s && s.before === 0 && s.after === 0 && ((s.rule === 'auto' && s.line === 240) || (atLeast && s.rule === 'atLeast' && s.line > 0))
    && ['left', 'center', 'right', null].includes(p.jc) && p.others === 0;
}

// ---------- items ----------
const rotate = (p, c, deg) => {
  if (!deg) return p;
  const a = (deg * Math.PI) / 180;
  const [dx, dy] = [p.x - c.x, p.y - c.y];
  return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
};
const boxOfXfrm = (x) => {
  const off = lkid(x, 'off');
  const ext = lkid(x, 'ext');
  return { x: num(at(off, 'x')) ?? 0, y: num(at(off, 'y')) ?? 0, w: num(at(ext, 'cx')) ?? 0, h: num(at(ext, 'cy')) ?? 0, rot: (num(at(x, 'rot')) ?? 0) / 60000,
    flipH: on(at(x, 'flipH')), flipV: on(at(x, 'flipV')) };
};
/** The map of a group (its xfrm, with off, ext, chOff, chExt, rot, flipH, flipV) from its children's space into `outer`'s. */
function groupMap(xfrm, outer, root = null) {
  const b = root ?? boxOfXfrm(xfrm);
  const chOff = lkid(xfrm, 'chOff');
  const chExt = lkid(xfrm, 'chExt');
  const [ox, oy] = [num(at(chOff, 'x')) ?? 0, num(at(chOff, 'y')) ?? 0];
  const sx = num(at(chExt, 'cx')) ? b.w / num(at(chExt, 'cx')) : 1;
  const sy = num(at(chExt, 'cy')) ? b.h / num(at(chExt, 'cy')) : 1;
  const gc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return (c) => {
    const [w, h] = [c.w * sx, c.h * sy];
    let p = { x: b.x + (c.x - ox) * sx + w / 2, y: b.y + (c.y - oy) * sy + h / 2 };
    let { rot, flipH, flipV } = c;
    if (b.flipH) { p = { x: 2 * gc.x - p.x, y: p.y }; flipH = !flipH; rot = -rot; }
    if (b.flipV) { p = { x: p.x, y: 2 * gc.y - p.y }; flipV = !flipV; rot = -rot; }
    if (b.rot) { p = rotate(p, gc, b.rot); rot += b.rot; }
    return outer({ x: p.x - w / 2, y: p.y - h / 2, w, h, rot, flipH, flipV });
  };
}
// The canvas: EMU to board px.
const toPx = (c) => ({ x: c.x / EMU_PX, y: c.y / EMU_PX, w: c.w / EMU_PX, h: c.h / EMU_PX, rot: ((c.rot % 360) + 360) % 360, flipH: c.flipH, flipV: c.flipV });

/** One shape (wps:wsp, dsp:sp, a connector) at canvas box `b` → its board item. */
function shapeItem(sp, b, ctx, groups, grpFill) {
  const spPr = lkid(sp, 'spPr');
  const look = shapeLook(spPr, lkid(sp, 'style'), ctx.dml, grpFill);
  const xb = boxOfXfrm(lkid(spPr, 'xfrm'));
  const prst = at(lkid(spPr, 'prstGeom'), 'prst');
  const id = ctx.nextId();
  const g = groups.length ? { groups: [...groups] } : {};
  if (LINE_ROUTE[prst]) {
    const [x1, x2] = b.flipH ? [b.x + b.w, b.x] : [b.x, b.x + b.w];
    const [y1, y2] = b.flipV ? [b.y + b.h, b.y] : [b.y, b.y + b.h];
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const [p, q] = [rotate({ x: x1, y: y1 }, c, b.rot), rotate({ x: x2, y: y2 }, c, b.rot)].map((o) => ({ x: r2(o.x), y: r2(o.y) }));
    const ln = lineFields(look.line);
    const heads = { start: HEAD[look.line?.head?.type] ?? 'none', end: HEAD[look.line?.tail?.type] ?? 'none' };
    return themed({ id, type: 'connector', from: p, to: q, points: [], labels: {}, route: LINE_ROUTE[prst], corner: 8, heads, dash: ln.dash ?? 'solid', jump: 'none',
      color: ln.color, width: ln.width, opacity: 1, ...(ln.prstDash && { prstDash: ln.prstDash }), ...(prst !== lineGeometry({ route: LINE_ROUTE[prst], heads }) && { prst }), ...g },
    { color: look.line?.fill.link }, look.refs);
  }
  const geo = geometryOf(spPr, xb.w, xb.h);
  const item = { id, type: 'shape', ...geo, x: r2(b.x), y: r2(b.y), w: Math.max(0.01, r2(b.w)), h: Math.max(0.01, r2(b.h)), ...fillFields(look.fill), ...lineFields(look.line), opacity: 1, ...g };
  const links = { ...fillLinks(look.fill), color: look.line?.fill.link, 'shadow.color': look.links.shadow };
  const rot = (((geo.rot ?? 0) + b.rot) % 360 + 360) % 360;
  if (rot) item.rot = r2(rot); else delete item.rot;
  if (!!geo.mirrorX !== !!b.flipH) item.mirrorX = true; else delete item.mirrorX;
  if (!!geo.mirrorY !== !!b.flipV) item.mirrorY = true; else delete item.mirrorY;
  if (look.shadow) item.shadow = look.shadow;
  const hidden = hiddenOf(spPr); // a line or fill turned off, which Word keeps
  if (hidden) item.hidden = hidden;
  // Its text: a Word text box's paragraphs or SmartArt's DrawingML text, in the body's internal margins and anchor.
  const body = lkid(sp, 'bodyPr') ?? lkid(lkid(sp, 'txBody'), 'bodyPr');
  const content = lkid(lkid(sp, 'txbx'), 'txbxContent');
  const paras = content ? wordParas(content, ctx) : lkid(sp, 'txBody') ? drawingParas(lkid(sp, 'txBody'), ctx) : [];
  const label = labelOf(paras, { size: ctx.text?.size ?? 11, color: look.font?.color ?? ctx.text?.color ?? '#000000', font: look.font?.face ?? ctx.text?.font ?? null }, !!content);
  // A Word shape keeps its size as text is typed (autoFit false) unless its body says a:spAutoFit, Resize shape to fit text.
  if (body) item.autoFit = !!lkid(body, 'spAutoFit');
  if (label) {
    const ins = (k, d) => r2((num(at(body, k)) ?? d) / EMU_PX);
    Object.assign(item, label, { valign: VALIGN[at(body, 'anchor')] ?? 'top', inset: { t: ins('tIns', 45720), r: ins('rIns', 91440), b: ins('bIns', 45720), l: ins('lIns', 91440) } });
    // The text takes the font reference's colour where its runs give none.
    if (look.font?.color && item.textColor === look.font.color) links.textColor = look.links.font;
  }
  return themed(item, links, look.refs);
}

/** A group member the board cannot draw (a chart, an embedded object, ink, SmartArt without its drawing) at canvas box `b` → a
 * framed box with its name, as a chart of a type the app does not draw shows. */
function framedItem(k, b, ctx, groups, what, label) {
  ctx.drop(`drawings of ${what}`);
  const name = at(deepFind(k, 'cNvPr'), 'name') || label;
  return { id: ctx.nextId(), type: 'shape', shape: 'rect', x: r2(b.x), y: r2(b.y), w: Math.max(0.01, r2(b.w)), h: Math.max(0.01, r2(b.h)),
    fill: 'solid', fillColor: '#FFFFFF', color: '#D9D9D9', width: 1, opacity: 1, html: esc(name), size: 12, textColor: '#595959', bold: false, align: 'center',
    valign: 'middle', inset: { t: 4, r: 4, b: 4, l: 4 }, placeholder: what, ...(groups.length && { groups: [...groups] }) };
}

/** A picture (pic:pic) at canvas box `b` → an image item, or null when its picture cannot be read. An SVG (asvg:svgBlip) shows
 * itself and keeps Word's PNG of it as its fallback, which export writes back while the SVG is unchanged. */
function pictureItem(pic, b, ctx, groups) {
  const fill = lkid(pic, 'blipFill');
  const shown = pictureSource(lkid(fill, 'blip'), ctx.picture);
  if (!shown) return null;
  const sr = lkid(fill, 'srcRect');
  const f = (k) => (num(at(sr, k)) ?? 0) / 100000;
  const crop = sr && { x: f('l'), y: f('t'), w: 1 - f('l') - f('r'), h: 1 - f('t') - f('b') };
  return { id: ctx.nextId(), type: 'image', ...shown, x: r2(b.x), y: r2(b.y), w: Math.max(0.01, r2(b.w)), h: Math.max(0.01, r2(b.h)),
    ...(b.rot && { rot: r2(b.rot) }), ...(b.flipH && { mirrorX: true }), ...(b.flipV && { mirrorY: true }),
    ...(crop && crop.w > 0 && crop.h > 0 && (crop.x || crop.y || crop.w < 1 || crop.h < 1) && { crop }), ...(groups.length && { groups: [...groups] }) };
}

/** Whether wps:wsp `sp` (its look `look`, its paragraphs `paras`) in a group or drawing canvas is a board text item, as
 * shapes-out.mjs textXml writes one: a text box (txBox) in a rectangle with no line and no fill but a plain colour, no effects, its
 * text at the top, every paragraph the app's (appPara). A text box Word made keeps Word's
 * margins and paragraph spacing as a shape, which holds them all. */
function isTextItem(sp, look, paras) {
  const body = lkid(sp, 'bodyPr');
  return !lkid(lkid(sp, 'spPr'), 'custGeom') && (at(lkid(lkid(sp, 'spPr'), 'prstGeom'), 'prst') ?? 'rect') === 'rect' && !look.line && !look.shadow
    && ['none', 'solid'].includes(look.fill.type) && (at(body, 'anchor') ?? 't') === 't' && !on(at(body, 'upright')) && ['horz', null].includes(at(body, 'vert'))
    && paras.length > 0 && paras.every((p) => appPara(p, true));
}
/** Text box `sp` (its paragraphs `paras`) at canvas box `b` → a board text item: its text as a label's (its own colour, else the
 * document's), its fill as a sticky note's colour, fitted to its text's width when Word does not wrap it. */
function textItem(sp, paras, b, ctx, groups, look) {
  const base = { size: ctx.text?.size ?? 11, color: ctx.text?.color ?? '#000000', font: null };
  const { html = '', size = r2(base.size * PX), textColor: color = base.color, bold = false, align = 'left', font, pPr } = labelOf(paras, base, true, true) ?? {};
  return { id: ctx.nextId(), type: 'text', html, x: r2(b.x), y: r2(b.y), w: Math.max(0.01, r2(b.w)), h: Math.max(0.01, r2(b.h)), size, color, bold, align,
    bg: look.fill.type === 'solid' ? look.fill.color : null, ...(font && { font }), ...(pPr && { pPr }), ...(b.rot && { rot: r2(b.rot) }),
    ...(at(lkid(sp, 'bodyPr'), 'wrap') === 'none' && { fit: true }), ...(groups.length && { groups: [...groups] }) };
}

// ---------- ink ----------
const INK_UNITS = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: PX, px: 1 }; // board px per unit
/** The opacities of the Draw tab's highlighter and pencil (pens.mjs), which Word draws with its own highlighter and pencil brushes. */
export const HIGHLIGHTER = penToBoard({ kind: 'highlighter', width: 0 }).opacity;
export const PENCIL = penToBoard({ kind: 'pencil', width: 0 }).opacity;
/** An InkML trace's text → its points as [x, y] (the X and Y channels `xi`, `yi` of its trace format). Values are explicit (!),
 * first differences (') or second differences ("), each mode holding for its channel until another is named (InkML 1.0 §3.2). */
function tracePoints(text, xi, yi) {
  const mode = [];
  const prev = [];
  const vel = [];
  const out = [];
  for (const point of String(text).split(',')) {
    const vals = [...point.matchAll(/([!'"])?\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|[TF*?])/gi)];
    if (!vals.length) continue;
    vals.forEach(([, q, s], c) => {
      if (q) mode[c] = q;
      const n = Number.isFinite(+s) ? +s : 0; // T, F, * and ? say nothing of a position
      const v = mode[c] === "'" ? (prev[c] ?? 0) + n : mode[c] === '"' ? (prev[c] ?? 0) + (vel[c] ?? 0) + n : n;
      vel[c] = prev[c] == null ? 0 : v - prev[c];
      prev[c] = v;
    });
    if (prev[xi] != null && prev[yi] != null) out.push([prev[xi], prev[yi]]);
  }
  return out;
}
/** InkML root `ink` → {lines (each trace's points), brush {width (px), color, opacity}} of its first brush, or null with no trace.
 * The Draw tab's highlighter and pencil brushes read as the board's highlighter and pencil, a transparency as an opacity. */
function readInk(ink) {
  const all = (n, name, out = []) => { for (const k of lkids(n)) (loc(k) === name ? out.push(k) : all(k, name, out)); return out; };
  const names = all(ink, 'channel').map((c) => at(c, 'name'));
  const [xi, yi] = [Math.max(0, names.indexOf('X')), names.indexOf('Y') < 0 ? 1 : names.indexOf('Y')];
  const lines = all(ink, 'trace').map((t) => tracePoints(t.kids.filter((s) => typeof s === 'string').join(''), xi, yi)).filter((l) => l.length);
  if (!lines.length) return null;
  const p = Object.fromEntries(lkids(all(ink, 'brush')[0], 'brushProperty').map((b) => [at(b, 'name'), b]));
  const val = (name) => at(p[name], 'value');
  const t = num(val('transparency'));
  return { lines, brush: { color: /^#[0-9a-f]{6}$/i.test(val('color') ?? '') ? val('color') : '#000000',
    width: r4((num(val('width')) ?? 0.05) * (INK_UNITS[at(p.width, 'units')] ?? INK_UNITS.cm)),
    opacity: val('rasterOp') === 'maskPen' ? HIGHLIGHTER : val('inkEffects') === 'pencil' ? PENCIL : t ? r2(1 - Math.min(255, t) / 255) : 1 } };
}
export const r1 = (n) => Math.round(n * 10) / 10;
const pt1 = ([x, y]) => `${r1(x)} ${r1(y)}`;
/** Points → the board's pen path (flow/model.mjs smoothPath): quadratic curves through their midpoints, one point a dot. Points that
 * are already such a path's numbers (shapes-out.mjs inkml: each second one the midpoint of its neighbours, to the tenths both were
 * rounded to, twice for a turned stroke) give that path back; other points that happen to pass draw the same within that much. */
function penPath(pts) {
  const own = pts.length % 2 === 0 && pts.every((p, i) => i % 2 || !i || i === pts.length - 1
    || Math.hypot(p[0] - (pts[i - 1][0] + pts[i + 1][0]) / 2, p[1] - (pts[i - 1][1] + pts[i + 1][1]) / 2) < 0.3);
  if (own) return `M${pt1(pts[0])}${pts.slice(1, -1).map((p, i) => (i % 2 ? ' ' : 'Q') + pt1(p)).join('')}L${pt1(pts.at(-1))}`;
  return smoothPath(pts.map(([x, y]) => ({ x, y })));
}
/** Ink (w14:contentPart, its InkML part through ctx.partXml) at canvas box `b` → one pen stroke item, or null when its part cannot
 * be read. Word stretches the ink's points' box to the drawing's box, then flips and turns it there; the stroke holds that in its
 * points. Its box is the points' box padded by half its width and 1 px, as the pen makes one. */
function inkItem(k, b, ctx, groups) {
  const ink = readInk(ctx.partXml?.(at(k, 'r:id')));
  if (!ink) return null;
  const all = ink.lines.flat();
  const [x0, y0] = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))];
  const [uw, uh] = [Math.max(...all.map((p) => p[0])) - x0, Math.max(...all.map((p) => p[1])) - y0];
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const lines = ink.lines.map((l) => l.map(([u, v]) => {
    const p = { x: uw ? b.x + ((u - x0) * b.w) / uw : c.x, y: uh ? b.y + ((v - y0) * b.h) / uh : c.y };
    const q = rotatePoint({ x: b.flipH ? 2 * c.x - p.x : p.x, y: b.flipV ? 2 * c.y - p.y : p.y }, c, b.rot);
    return [r1(q.x), r1(q.y)];
  }));
  const pad = ink.brush.width / 2 + 1;
  const flat = lines.flat();
  const x = Math.floor(Math.min(...flat.map((p) => p[0])) - pad);
  const y = Math.floor(Math.min(...flat.map((p) => p[1])) - pad);
  const w = Math.ceil(Math.max(...flat.map((p) => p[0])) + pad) - x;
  const h = Math.ceil(Math.max(...flat.map((p) => p[1])) + pad) - y;
  return { id: ctx.nextId(), type: 'stroke', x, y, w, h, vw: w, vh: h, d: lines.map((l) => penPath(l.map(([px, py]) => [px - x, py - y]))).join(''),
    ...ink.brush, ...(groups.length && { groups: [...groups] }) };
}

/** The children of a group, drawing canvas or SmartArt shape tree → items, each placed through `map` (child box in EMU → canvas box
 * in board px). */
function members(list, map, ctx, groups, grpFill, out) {
  for (const k of list) {
    const name = loc(k);
    const spPr = lkid(k, 'spPr');
    const content = name === 'wsp' && on(at(lkid(k, 'cNvSpPr'), 'txBox')) && lkid(lkid(k, 'txbx'), 'txbxContent');
    const paras = content ? wordParas(content, ctx) : null;
    const look = paras && shapeLook(spPr, lkid(k, 'style'), ctx.dml, grpFill);
    if (look && isTextItem(k, look, paras)) {
      out.push(textItem(k, paras, map(boxOfXfrm(lkid(spPr, 'xfrm'))), ctx, groups, look));
    } else if (name === 'wsp' || name === 'sp' || name === 'cxnSp') {
      out.push(shapeItem(k, map(boxOfXfrm(lkid(spPr, 'xfrm'))), ctx, groups, grpFill));
    } else if (name === 'pic') {
      const it = pictureItem(k, map(boxOfXfrm(lkid(spPr, 'xfrm'))), ctx, groups);
      if (it) out.push(it); // an EMF or WMF keeps its file and shows the reader's drawing (import.mjs showMetafiles)
      else ctx.drop('pictures that could not be read');
    } else if (name === 'grpSp' || name === 'wgp') { // a group, or a whole group inside a drawing canvas
      const gp = lkid(k, 'grpSpPr');
      const fe = fillEl(gp);
      const own = fe && fe.name !== 'a:grpFill' ? shapeLook(gp, null, ctx.dml, grpFill).fill : grpFill;
      members(lkids(k), groupMap(lkid(gp, 'xfrm'), map), ctx, [ctx.groupId(), ...groups], own, out);
    } else if (name === 'graphicFrame') {
      // SmartArt draws its drawing's shapes inside the frame, as one group; a chart or an object is a framed box.
      const gd = lkid(lkid(k, 'graphic'), 'graphicData');
      const b = boxOfXfrm(lkid(k, 'xfrm'));
      const dgm = !!lkid(gd, 'relIds') || at(gd, 'uri') === URI.dgm;
      const tree = dgm && diagramTree(gd, ctx);
      if (tree) members(lkids(tree), (c) => map({ ...c, x: b.x + c.x, y: b.y + c.y }), ctx, [ctx.groupId(), ...groups], null, out);
      else if (dgm) out.push(framedItem(k, map(b), ctx, groups, 'SmartArt graphics without their drawing', 'SmartArt'));
      else if (lkid(gd, 'chart')) out.push(framedItem(k, map(b), ctx, groups, 'charts in groups', 'Chart'));
      else out.push(framedItem(k, map(b), ctx, groups, 'objects in groups', 'Object'));
    } else if (name === 'contentPart') { // ink, a framed box when its part cannot be read
      const b = map(boxOfXfrm(lkid(k, 'xfrm')));
      out.push(inkItem(k, b, ctx, groups) ?? framedItem(k, b, ctx, groups, 'ink in groups', 'Ink'));
    }
  }
  return out;
}
/** SmartArt's graphicData → the shape tree of the drawing Word made of it (dsp:drawing, named by the data part's dsp:dataModelExt
 * relId), or null. */
function diagramTree(gd, ctx) {
  const data = ctx.partXml(at(lkid(gd, 'relIds'), 'r:dm'));
  const relId = at(deepFind(data, 'dataModelExt'), 'relId');
  return deepFind(relId && ctx.partXml(relId), 'spTree');
}

/** Whether wps:wsp `sp` is a text box the textBox node holds: Word text in a rectangle (the box draws a rectangle only), or a
 * rectangle that a linked story flows into (wps:linkedTxbx). */
export const isTextBox = (sp) => (!!lkid(lkid(sp, 'txbx'), 'txbxContent') || !!lkid(sp, 'linkedTxbx')) && ['rect', null].includes(at(lkid(lkid(sp, 'spPr'), 'prstGeom'), 'prst') ?? (lkid(lkid(sp, 'spPr'), 'custGeom') ? 'cust' : null));

/**
 * A drawing's graphicData (a:graphicData of wps, wpg, wpc or a SmartArt diagram) at extent cx × cy EMU → canvas attrs {w, h, dw,
 * frame, bg, items}, or null when it holds none of those. `ctx`: {dml (shapeLook's context), picture(rid) → src, partXml(rid) →
 * root element of a part related to this one, text {size (pt), color, font} (the document's defaults), fonts {major, minor}, drop(what)}.
 * `layout` (a float layout or null) is returned moved by as much as the canvas grew past the drawing's box (a rotated shape's
 * corners, a line's heads), so the shape stays where Word draws it.
 */
export function canvasOf(gd, cx, cy, ctx, layout = null) {
  let n = 0;
  let g = 0;
  const c = { ...ctx, nextId: () => `w${++n}`, groupId: () => `g${++g}`, color: (el) => dmlColor(el, ctx.dml?.colors) };
  const ext = { x: 0, y: 0, w: cx, h: cy, rot: 0, flipH: false, flipV: false };
  const uri = at(gd, 'uri');
  let items = null;
  const wsp = lkid(gd, 'wsp');
  const wgp = lkid(gd, 'wgp');
  const wpc = lkid(gd, 'wpc');
  const rel = lkid(gd, 'relIds');
  if (wsp && !isTextBox(wsp)) {
    // The shape's own xfrm only turns and flips it: the drawing's extent is its box.
    const x = boxOfXfrm(lkid(lkid(wsp, 'spPr'), 'xfrm'));
    items = [shapeItem(wsp, toPx({ ...ext, rot: x.rot, flipH: x.flipH, flipV: x.flipV }), c, [], null)];
  } else if (wgp) {
    const gp = lkid(wgp, 'grpSpPr');
    const x = boxOfXfrm(lkid(gp, 'xfrm'));
    const fill = fillEl(gp) ? shapeLook(gp, null, c.dml).fill : null;
    items = members(lkids(wgp), groupMap(lkid(gp, 'xfrm'), toPx, { ...ext, rot: x.rot, flipH: x.flipH, flipV: x.flipV }), c, [c.groupId()], fill, []);
  } else if (wpc) items = members(lkids(wpc), toPx, c, [], null, []);
  else if (rel || uri === URI.dgm) {
    // SmartArt: the drawing Word made of the diagram, or a framed box when the file has none.
    const tree = diagramTree(gd, c);
    items = tree ? members(lkids(tree), toPx, c, [], null, []) : [framedItem(gd, toPx(ext), c, [], 'SmartArt graphics without their drawing', 'SmartArt')];
    if (items.length > 1) for (const it of items) it.groups = [...(it.groups ?? []), 'g0'];
  }
  // An empty drawing canvas stays one, as Word shows its frame.
  if (!items?.length && !wpc) return null;
  // A group of one is no group (the board keeps a group while two items share it).
  const out = fitted(normalizeGroups(items), cx / EMU_PX, cy / EMU_PX, layout);
  // A drawing canvas stays one on export (docPr.canvas, beside the drawing's other Word properties), with its background colour,
  // which the board does not draw: it shows the page, as Word's white canvas on a white page does.
  if (wpc) {
    const sf = lkid(lkid(wpc, 'bg'), 'solidFill');
    const bg = sf && c.color(sf);
    out.attrs.docPr = { canvas: { bg: bg ? { ...linkOf(sf), color: bg } : null } };
  }
  return out;
}
const deepFind = (n, name) => {
  for (const k of lkids(n)) {
    if (loc(k) === name) return k;
    const f = deepFind(k, name);
    if (f) return f;
  }
  return null;
};

/** Item `it`'s drawn bounds: a shape's turned box and what it draws past it, a connector's ends (with room for its heads). */
function bounds(it) {
  if (it.type === 'connector') {
    const pad = it.heads.start !== 'none' || it.heads.end !== 'none' ? Math.max(6, it.width * 3) : Math.max(0.5, it.width / 2);
    const [x0, x1] = [Math.min(it.from.x, it.to.x) - pad, Math.max(it.from.x, it.to.x) + pad];
    const [y0, y1] = [Math.min(it.from.y, it.to.y) - pad, Math.max(it.from.y, it.to.y) + pad];
    return { x: x0, y: y0, r: x1, b: y1 };
  }
  const d = it.type === 'shape' ? drawnBox(it) : rotBox(it); // a shape's turned box with what it draws past it (a callout's tail)
  return { x: d.x, y: d.y, r: d.x + d.w, b: d.y + d.h };
}
/** Canvas attrs for `items` in a w × h drawing box, grown to what they draw past it; `layout`'s offsets follow the growth. */
function fitted(items, w, h, layout) {
  const bs = items.map(bounds);
  const l = Math.min(0, ...bs.map((b) => b.x));
  const t = Math.min(0, ...bs.map((b) => b.y));
  const W = Math.max(1, r2(Math.max(w, ...bs.map((b) => b.r)) - l));
  const H = Math.max(1, r2(Math.max(h, ...bs.map((b) => b.b)) - t));
  const moved = items.map((it) => (it.type === 'connector'
    ? { ...it, from: { x: r2(it.from.x - l), y: r2(it.from.y - t) }, to: { x: r2(it.to.x - l), y: r2(it.to.y - t) } }
    : { ...it, x: r2(it.x - l), y: r2(it.y - t) }));
  const move = (p, d) => (p && p.offset != null && !p.align && d ? { ...p, offset: r2(p.offset + d / PX) } : p);
  const out = { w: W, h: H, dw: W, frame: { x: 0, y: 0, w: W, h: H, ...(moved.length === 1 && { item: moved[0].id }) }, bg: 'transparent', items: moved };
  return { attrs: out, layout: layout ? { ...layout, h: move(layout.h, l), v: move(layout.v, t) } : null };
}
