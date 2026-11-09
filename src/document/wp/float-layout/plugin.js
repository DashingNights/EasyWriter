// The float layout plugin (docs/plans/word/plan.md §3 float-layout): draws every picture, text box, canvas, plan chart and framed
// paragraph whose layout is not In Line. Node decorations carry data-fl (the wrap), data-fl-side and CSS variables; style.css turns
// them into absolute boxes (Behind and In Front of Text), CSS floats (Square and Tight under engine 2 or outside Print Layout) or
// blocks with a measured margin (Top and Bottom, and Square and Tight under engine 1, where a float inside the text would land at
// the end of its page run, §1.9). Node DOM is never reparented, so text boxes stay editable.
//
// Placement needs the anchor's place on the page, so the plugin view measures after each update (one frame later) and stores the
// result with a meta-only transaction when it changed; the decorations follow it. Absolute objects are re-placed on every relayout
// because the pagination plugin's meta transactions reach update() too.
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getState } from '../../../app/store.js';
import { readJson } from '../../../office.mjs';
import { geometryOf, layers, nodeDOMsAt, overlayOf, paginationKey, scaleOf, topBlocks } from '../../geometry.js';
import { wordSettings } from '../../word/settings.mjs';
import { columnBoxAt, flowPos } from '../columns/model.mjs';
import {
  FLOATABLE, floatSide, frameLayout, frameOf, full, hBand, marginsOf, newFloat, offsetOf, pageFrom, pageWraps, placement, pointsOf, PT, round,
  shapeOf, vBand, WRAPS_BESIDE,
} from './place.mjs';

export const floatKey = new PluginKey('floatLayout');

const TEXTBOX_LAYOUT = { wrap: 'front', h: { rel: 'column', offset: 0 }, v: { rel: 'paragraph', offset: 0 } };
const ABSOLUTE = new Set(['behind', 'front']);

/** The kind of object `node` is for float layout ('picture', 'graphic', 'textbox', 'canvas', 'planChart', 'frame'), or null. With
 * `doc`, a paragraph framed by its style is a frame too. */
export function kindOf(node, doc = null) {
  const n = node.type.name;
  if (n === 'image') return /^data:image\/svg/i.test(node.attrs.src ?? '') ? 'graphic' : 'picture';
  if (n === 'textBox') return 'textbox';
  if (n === 'canvas' || n === 'planChart') return n;
  if (n === 'chart') return 'chart'; // a chart from a .docx (chart/node.js): inline like a picture
  if (n === 'paragraph' || n === 'heading') {
    const f = frameOf(node, doc);
    return f && !f.dropCap ? 'frame' : null;
  }
  return null;
}

/** The stored layout of `node` (null = In Line), as its kind reads it. A framed paragraph's layout comes from its frame. */
export function layoutOf(node, doc = null) {
  const kind = kindOf(node, doc);
  if (kind === 'frame') return frameLayout(frameOf(node, doc));
  if (kind === 'textbox') return node.attrs.layout ?? TEXTBOX_LAYOUT;
  return kind ? node.attrs.layout ?? null : null;
}

const PAGE_RELS = new Set(['page', 'margin', 'topMargin', 'bottomMargin', 'insideMargin', 'outsideMargin']);

/** Whether layout `l` is Square, Tight or Through and placed down its page by the page or its margins, not by the text: such an
 * object is drawn where its page puts it and the text wraps round it there (measure's paged), not as a CSS float in the text. */
export const pageWrapped = (l) => !!l && (l.wrap === 'square' || l.wrap === 'tight' || l.wrap === 'through') && PAGE_RELS.has(l.v?.rel);

/** Whether `node` is a block object that floats (a text box, canvas or plan chart not In Line). */
const floatingBlock = (node) => !node.isInline && kindOf(node) !== 'frame' && !!full(layoutOf(node));

/** The position of the paragraph `node` at `pos` anchors to: a picture its own paragraph, a block object the first block after
 * it that does not float itself (two text boxes anchored in one paragraph both sit before it), or itself when none follows; a
 * frame itself. */
export function anchorOf(doc, pos, node) {
  const kind = kindOf(node, doc);
  const $p = doc.resolve(pos);
  if (kind === 'frame') return pos;
  if (node.isInline) return $p.before($p.depth);
  let at = pos + node.nodeSize;
  for (let i = $p.index() + 1; i < $p.parent.childCount; i++) {
    const next = $p.parent.child(i);
    if (!floatingBlock(next)) return at;
    at += next.nodeSize;
  }
  return pos;
}

const floatsByDoc = new WeakMap(); // doc → its floats: the measure, the overlay and the decorations each walked the whole doc per frame

/** Every floating object of `doc` → [{pos, node, kind, layout (full), anchor, cont}], kept per doc (read only). cont marks a framed
 * paragraph that continues the frame of the paragraph before it (Word joins neighbours with the same frame into one). */
export function floatsOf(doc) {
  let out = floatsByDoc.get(doc);
  if (out) return out;
  floatsByDoc.set(doc, (out = []));
  let prevFrame = null;
  doc.descendants((node, pos) => {
    const kind = kindOf(node, doc);
    if (kind) {
      const layout = full(layoutOf(node, doc));
      const frame = kind === 'frame' ? frameOf(node, doc) : null;
      if (layout) {
        const same = kind === 'frame' && prevFrame && prevFrame.end === pos && JSON.stringify(prevFrame.frame) === JSON.stringify(frame);
        out.push({ pos, node, kind, layout, anchor: anchorOf(doc, pos, node), cont: !!same, ...(frame && { frame }) });
      }
      if (kind === 'frame') prevFrame = { end: pos + node.nodeSize, frame };
      return kind === 'textbox'; // a text box's paragraphs may hold pictures; nothing else nests
    }
    if (node.isTextblock) prevFrame = null;
    return !node.isLeaf;
  });
  return out;
}

/** The floating-capable object a command acts on (ctx.obj in ctx.target: the body, or a story editor that draws on a page, which
 * is the header or footer being edited), or null. A note or comment story has no page to place a float on, and Word keeps
 * objects there inline, so the float tools are off in it. */
export function floatObj(ctx) {
  const o = ctx.obj;
  const view = ctx.target?.view;
  return o && FLOATABLE.has(o.kind) && view && ctx.state && (ctx.target === ctx.ed || storyPages.has(view)) ? o : null;
}

/** The floating object at `pos` in `state`, or null. */
export const floatAt = (state, pos) => floatsOf(state.doc).find((o) => o.pos === pos) ?? null;

/** The measured placement of the object at `pos` (layout px: x, y, w, h, hStart, vStart, anchorTop, page), or null. */
export const measOf = (state, pos) => floatKey.getState(state)?.meas.get(pos) ?? null;

// ---------------------------------------------------------------------------------------------
// Decorations

const px = (n) => `${round(n ?? 0)}px`;

/** The node decoration attributes of float `o` with its measure `m` (`story`: in a header or footer being edited). */
function attrsOf(o, m, story = false) {
  const l = o.layout;
  const a = { 'data-fl': l.wrap, 'data-fl-kind': o.kind };
  const vars = [`--fl-z:${ABSOLUTE.has(l.wrap) ? (l.wrap === 'behind' ? -1000 : 1) + (l.z ?? 0) : 'auto'}`];
  if (l.hidden) a['data-fl-hidden'] = '';
  if (o.cont) a['data-fl-cont'] = '';
  if (o.kind === 'frame') {
    const f = o.frame;
    if (f.w) vars.push(`--fl-w:${px(f.w * PT)}`);
    if (f.h && f.hRule === 'exact') vars.push(`--fl-h:${px(f.h * PT)}`);
    if (f.h && f.hRule === 'atLeast') vars.push(`--fl-minh:${px(f.h * PT)}`);
  }
  if (m) {
    const shape = shapeOf(l, o.node.attrs.src, { w: m.w, h: m.h, m, side: m.side });
    if (shape) vars.push(`--fl-shape:${shape}`);
    a['data-fl-side'] = m.side;
    // Only Behind and In Front of Text place by x and y (style.css), and Top and Bottom in a header or footer being edited
    // (headers-footers style.css); the others by margins, which stay while the page ends above them move, so their decorations
    // stay too (apply's key).
    if (m.paged) a['data-fl-page'] = ''; // placed on its page (measure): drawn absolutely, the text wraps round its page wrap
    if (ABSOLUTE.has(l.wrap) || m.paged || (story && l.wrap === 'topBottom')) vars.push(`--fl-x:${px(m.left)}`, `--fl-y:${px(m.top)}`);
    vars.push(`--fl-mt:${px(m.mt)}`, `--fl-mb:${px(m.mb)}`, `--fl-ml:${px(m.ml)}`, `--fl-mr:${px(m.mr)}`);
  } else {
    a['data-fl-side'] = l.h?.align === 'right' ? 'right' : 'left';
  }
  a.style = `${vars.join(';')};`;
  return a;
}

/** A page's wrap float (pageWraps) as its widget's DOM: an empty CSS float the page's first lines wrap round. */
function wrapDOM(view, w) {
  const el = view.dom.ownerDocument.createElement('div');
  el.dataset.flPageWrap = w.side;
  el.contentEditable = 'false';
  el.style.cssText = w.css;
  return el;
}

/** What the float decorations of `doc` with `meas` draw, so a new measure that draws the same keeps the set (and the view its DOM). */
const decoKey = (doc, meas, story) => floatsOf(doc).map((o) => JSON.stringify(attrsOf(o, meas.get(o.pos), story))).join('|');

function decorate(doc, meas, wraps = [], story = false) {
  const floats = floatsOf(doc);
  if (!floats.length && !wraps.length) return DecorationSet.empty;
  return DecorationSet.create(doc, [
    ...floats.map((o) => Decoration.node(o.pos, o.pos + o.node.nodeSize, attrsOf(o, meas.get(o.pos), story))),
    ...wraps.map((w) => Decoration.widget(w.pos, (view) => wrapDOM(view, w), { key: w.key, side: w.at, ignoreSelection: true, marks: [] })),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Measuring

/** `rect` (client px) as layout px in .ProseMirror coordinates of `view`. */
function local(view, rect) {
  const pm = view.dom.getBoundingClientRect();
  const s = scaleOf(view);
  return { left: (rect.left - pm.left) / s, top: (rect.top - pm.top) / s, right: (rect.right - pm.left) / s, bottom: (rect.bottom - pm.top) / s };
}

/** The layout px top of block `dom` that Word measures a position relative to a paragraph, or to its first line, from: the top
 * of its space before, which CSS draws as margin outside the box (the user's letter: a box 22.8 pt below a paragraph with 12 pt
 * before). Word's first line holds the paragraph's space before (measured in Word's PDF, 2026-10-29: a square 20 pt below the
 * line sits 20 pt below the space before's top, in a table cell and outside one). */
function blockTop(view, dom) {
  return local(view, dom.getBoundingClientRect()).top - (parseFloat(getComputedStyle(dom).marginTop) || 0);
}

/** A page without pagination (Web Layout, hidden hosts before their first measure): the column as wide as the editor. */
function loosePage(view) {
  const w = view.dom.offsetWidth || 600;
  return { index: 0, number: 1, top: 0, bodyTop: 0, bodyHeight: 1e6, box: { w, h: 1e6, top: 0, right: 0, bottom: 0, left: 0, text: w, body: 1e6 } };
}

// Story editors drawn over a page (a header or footer being edited) → a function giving that page in the story's own layout px.
// A story editor without one has no geometry to place by, so its floats are not measured.
const storyPages = new WeakMap();

/** Places the floats of story editor `view` on the page `fn()` returns: a geometry page whose top and bodyTop are in the view's
 * layout px, x 0 at the text column (headers-footers edit.js, so a part's floats sit where its page layer draws them). */
export const setStoryPage = (view, fn) => storyPages.set(view, fn);

/** The page `view` draws page `index` on: a story editor's own (setStoryPage), else the geometry's. */
export const pageOf = (view, index) => storyPages.get(view)?.() ?? geometryOf(view.state)?.pages?.[index];

/** The page frame (place.mjs hBand and vBand) of an object anchored at `anchor` with anchor top `anchorTop` and the top of the
 * anchor's first line `lineTop`. dx: the layout px of the frame's x 0 (the text column's left edge, 0, but in a cell). */
export function frameAt(view, anchor, anchorTop, lineTop = anchorTop) {
  const geo = geometryOf(view.state);
  const drawn = view.dom.closest('#editor-area')?.dataset.wordView;
  const paged = geo?.pages?.length && (!drawn || drawn === 'print' || drawn === 'focus');
  const page = storyPages.get(view)?.() ?? (paged ? geo.pages[Math.min(geo.pages.length - 1, Math.max(0, geo.pageOf(anchor)))] : loosePage(view));
  return { page, anchorTop, lineTop, colLeft: 0, colWidth: page.box.text, dx: 0 };
}

/** `frame` with table cell `td` as its page, as Word lays out a float anchored in a cell (measured in Word's PDF, 2026-10-29):
 * column and margin are the cell's text (its edge plus its left margin, where its paragraphs start), page is the cell inside its
 * border; vertically margin and page both start at the cell's text top (below its top margin). The cell's margins stand for the
 * page margins, so the side bands follow. x 0 is the cell's text left, at dx. */
function cellFrame(view, td, frame) {
  const r = local(view, td.getBoundingClientRect());
  const cs = getComputedStyle(td);
  const f = (k) => parseFloat(cs[k]) || 0;
  const left = r.left + f('borderLeftWidth');
  const w = r.right - f('borderRightWidth') - left;
  const top = r.top + f('borderTopWidth') + f('paddingTop');
  const h = Math.max(0, r.bottom - f('borderBottomWidth') - f('paddingBottom') - top);
  const pl = f('paddingLeft');
  const text = Math.max(0, w - pl - f('paddingRight'));
  const box = { w, h, left: pl, right: f('paddingRight'), top: 0, bottom: 0, text, body: h };
  return { ...frame, page: { ...frame.page, top, bodyTop: top, bodyHeight: h, box }, colLeft: 0, colWidth: text, dx: left + pl };
}

/** The frame an object anchored at `anchor` is placed in. `el` is the anchor's block, or the object's own DOM when it has none, and
 * `rect` that block's layout px box when it is not `el`'s. Anchored in a table cell, the cell is its page: Word 2013 and later
 * (compatibility mode 15, the only layout this app has) lay every float in a cell out in it, Layout in table cell or not (a
 * layoutInCell="0" square in Word's PDF, 2026-10-29). In newspaper columns Word's column is the one the anchor's text flowed into
 * (wp/columns columnBoxAt). measure() and moveTo() share it, so a drag to another column or cell measures from the new one. */
function anchorFrame(view, anchor, el, rect, anchorTop, lineTop) {
  const pageFrame = frameAt(view, anchor, anchorTop, lineTop);
  const td = el.closest('td, th');
  if (td && view.dom.contains(td)) return cellFrame(view, td, pageFrame);
  const r = rect ?? local(view, el.getBoundingClientRect());
  const col = columnBoxAt(view.state.doc, anchor, (r.left + r.right) / 2);
  return col ? { ...pageFrame, colLeft: col.left, colWidth: col.width } : pageFrame;
}

/** Measures every float of `view` against the current layout → Map pos → measure. */
function measure(view, prev) {
  const out = new Map();
  let lastFrame = null;
  const floats = floatsOf(view.state.doc);
  // One walk over the blocks the floats and their anchors sit in: view.nodeDOM walks the top-level blocks from the start on each call.
  const doms = floats.length ? nodeDOMsAt(view, floats.flatMap((o) => [o.pos, o.anchor])) : null;
  for (const o of floats) {
    const dom = doms.get(o.pos);
    if (!(dom instanceof HTMLElement) || !dom.isConnected) continue;
    const old = prev.get(o.pos);
    const r = local(view, dom.getBoundingClientRect());
    const w = dom.offsetWidth;
    const h = dom.offsetHeight;
    const cs = getComputedStyle(dom);
    const abs = cs.position === 'absolute';
    const floated = cs.float !== 'none';
    // Where the box would be without the margins this plugin set.
    const nat = { top: r.top - (abs ? 0 : old?.mt ?? 0), left: r.left - (abs ? 0 : old?.ml ?? 0), right: r.right + (abs ? 0 : old?.mr ?? 0) };
    let anchorTop;
    let lineTop;
    const a = o.anchor === o.pos ? null : doms.get(o.anchor);
    if (o.anchor === o.pos) anchorTop = abs ? old?.anchorTop ?? r.top : nat.top;
    else {
      anchorTop = lineTop = a instanceof HTMLElement ? blockTop(view, a) : nat.top;
      // A block in the flow before its anchor (Top and Bottom; Square and Tight under engine 1) pushes that anchor down by its own
      // room, which would move it again each round: the anchor's top without it is where the object itself starts.
      if (!abs && !floated && o.anchor > o.pos) anchorTop = lineTop = nat.top;
    }
    const l = o.layout;
    const frame = anchorFrame(view, o.anchor, a instanceof HTMLElement ? a : dom, a instanceof HTMLElement ? null : nat, anchorTop, lineTop ?? anchorTop);
    // A page whose page ends are not drawn yet has only its plan, nowhere near where its text is drawn: an object placed on it then
    // got the distance between the two as a margin (55,600 px on the Word fixture). It waits at its place in the text until its page is.
    if (frame.page.drawn === false) continue;
    let p = placement(o.layout, { w, h }, frame);
    p = { x: p.x + frame.dx, y: p.y };
    if (o.cont && lastFrame) p = { x: lastFrame.x, y: nat.top };
    // Placed on its page, whatever the text (pageWrapped): drawn there absolutely, the text wrapping round it through the page
    // wrap floats (PAGE_WRAP_PASS), as Word and LibreOffice lay a page-positioned object out. As a CSS float it could not sit above
    // a float earlier in the text (the Word fixture's cover page: its title box fell below the author's box).
    const paged = !storyPages.has(view) && o.kind !== 'frame' && pageWrapped(l) && !(a instanceof HTMLElement ? a : dom).closest('td, th');
    const m = {
      x: p.x, y: p.y, w, h, anchorTop, page: frame.page.index,
      hStart: hBand(l.h?.rel ?? 'column', frame).left + frame.dx, vStart: vBand(l.v?.rel ?? 'paragraph', frame).top,
      side: floatSide(l, p.x, w, frame.colLeft + frame.dx, frame.colWidth), left: p.x, top: p.y, mt: 0, mb: 0, ml: 0, mr: 0, clamped: false, floated,
      paged,
    };
    if (abs || paged) {
      // The containing block is .ProseMirror unless the object sits in a positioned box (a table cell, a text box), whose padding
      // box it is: left and top start inside the box's border.
      const op = dom.offsetParent;
      if (op && op !== view.dom && view.dom.contains(op)) {
        const o2 = local(view, op.getBoundingClientRect());
        const cs = getComputedStyle(op);
        m.left -= o2.left + (parseFloat(cs.borderLeftWidth) || 0);
        m.top -= o2.top + (parseFloat(cs.borderTopWidth) || 0);
      }
    } else {
      // A box in the body cannot rise above the lines before it: clamped is recorded (Word would move those lines). A header or
      // footer being edited lifts it, as the page layer draws it (placePartFloats).
      Object.assign(m, marginsOf(l, floated ? m.side : null, nat, p, w, h, storyPages.has(view)));
    }
    if (o.kind === 'frame') lastFrame = m;
    out.set(o.pos, m);
  }
  return out;
}

const KEYS = ['left', 'top', 'mt', 'mb', 'ml', 'mr', 'x', 'y', 'w', 'h', 'anchorTop', 'hStart', 'vStart'];
function same(a, b) {
  if (a.size !== b.size) return false;
  for (const [pos, m] of a) {
    const n = b.get(pos);
    if (!n || n.side !== m.side || n.page !== m.page || KEYS.some((k) => Math.abs((n[k] ?? 0) - (m[k] ?? 0)) > 0.5)) return false;
  }
  return true;
}

/** Whether measures `a` and `b` draw the objects not in `skip` alike: the side and the margins and size their decorations draw
 * with (attrsOf), to half a pixel. */
function drawsAlike(a, b, skip) {
  if (a.size !== b.size) return false;
  for (const [pos, m] of a) {
    if (skip.has(pos)) continue;
    const n = b.get(pos);
    if (!n || n.side !== m.side || ['mt', 'mb', 'ml', 'mr', 'w', 'h'].some((k) => Math.abs((n[k] ?? 0) - (m[k] ?? 0)) > 0.5)) return false;
  }
  return true;
}

const absByDoc = new WeakMap();
/** The positions of `doc`'s Behind Text and In Front of Text objects (kept per doc). */
function absoluteAt(doc) {
  let out = absByDoc.get(doc);
  if (!out) absByDoc.set(doc, (out = new Set(floatsOf(doc).filter((o) => ABSOLUTE.has(o.layout.wrap)).map((o) => o.pos))));
  return out;
}

/** The height of `root`'s text in layout px (zoom `s`): the bottom of its last block in the flow with that block's space after.
 * Its floats and out-of-flow objects reach past it: a header's or footer's height is its text's, as in Word. */
function flowHeight(root, s) {
  const top = root.getBoundingClientRect().top;
  let h = 0;
  for (const el of root.children) {
    const cs = getComputedStyle(el);
    if (cs.float !== 'none' || cs.position === 'absolute' || cs.display === 'none') continue;
    h = Math.max(h, (el.getBoundingClientRect().bottom - top) / s + (parseFloat(cs.marginBottom) || 0));
  }
  return round(h + (parseFloat(getComputedStyle(root).paddingBottom) || 0));
}

/** Places the floating pictures, text boxes and canvases of a header or footer `part` that the page layer drew for `page` (geometry) as
 * static DOM, which no plugin decorates (headers-footers layer.js). `part` is absolute on the layer, whose origin is the paper's
 * top-left, with its left edge at the text column, as x 0 is in placement(). Square, Tight and Through float at their side with
 * the part's text wrapping round them, as the body draws them (measure, marginsOf, shapeOf); the others leave the flow. Each goes
 * where placement() puts it from its anchor paragraph's top; a few rounds settle floats that move each other's anchors. With any
 * of them floating the part takes its text's height (flowHeight), so a float never moves the body by itself. → the floats text
 * wraps round, Top and Bottom too, as [{x, y, w, h, layout}] px from the text column's left and the paper's top, for the body to
 * wrap round where they reach into it (pageWraps).
 * ponytail: Top and Bottom leaves the part's own text where it is, as the story editor draws it (headers-footers style.css); a
 * block in the flow there would push the part, and the body by its height, down to wherever the picture is placed. */
export function placePartFloats(part, page) {
  const floats = [...part.querySelectorAll('[data-textbox], img[data-layout], div[data-canvas], [data-chart][data-layout]')].filter((el) => !el.parentElement.closest('[data-textbox]')).map((el) => {
    // A text box or a canvas (a Word shape) is a block before the paragraph it anchors to; a picture or a chart sits in its paragraph.
    const box = el.hasAttribute('data-textbox') || el.hasAttribute('data-canvas');
    const json = readJson(el.getAttribute(box ? 'data-json' : 'data-layout'));
    const layout = full(box ? json?.layout ?? (el.hasAttribute('data-textbox') ? TEXTBOX_LAYOUT : null) : json);
    return layout && { el, box, layout, src: el.getAttribute('src'), w: el.offsetWidth, h: el.offsetHeight, abs: !WRAPS_BESIDE.has(layout.wrap) };
  }).filter(Boolean);
  if (!floats.length) return [];
  const s = part.getBoundingClientRect().width / part.offsetWidth || 1;
  const { text } = page.box;
  const pg = pageFrom(page, 0);
  const frame = (anchorTop) => ({ page: pg, anchorTop, lineTop: anchorTop, colLeft: 0, colWidth: text });
  for (const f of floats) {
    f.side = f.abs ? null : floatSide(f.layout, placement(f.layout, f, frame(0)).x, f.w, 0, text);
    f.m = { mt: 0, mr: 0, mb: 0, ml: 0 };
    Object.assign(f.el.style, f.abs ? { position: 'absolute', margin: '0' } : { position: 'static', margin: '0', float: f.side });
  }
  const flows = floats.some((f) => !f.abs);
  for (let pass = 0; pass < (flows ? 4 : 1); pass++) {
    if (flows) part.style.height = `${flowHeight(part, s)}px`;
    const pr = part.getBoundingClientRect();
    const top = part.offsetTop;
    let moved = false;
    for (const f of floats) {
      const r = f.el.getBoundingClientRect();
      // Where the box would be without the margins set here.
      const nat = { top: (r.top - pr.top) / s - f.m.mt, left: (r.left - pr.left) / s - f.m.ml, right: (r.right - pr.left) / s + f.m.mr };
      let a = f.box ? f.el.nextElementSibling : f.el.closest('p, h1, h2, h3, h4, h5, h6');
      while (f.box && a?.matches('[data-textbox], div[data-canvas]')) a = a.nextElementSibling;
      // blockTop: paragraph and line both from the top of the space before.
      const anchorTop = a ? (a.getBoundingClientRect().top - pr.top) / s - (parseFloat(getComputedStyle(a).marginTop) || 0) : nat.top;
      const p = placement(f.layout, f, frame(top + anchorTop));
      const at = { x: p.x, y: p.y - top };
      if (f.abs) {
        Object.assign(f.el.style, { left: `${round(at.x)}px`, top: `${round(at.y)}px` });
        continue;
      }
      const m = marginsOf(f.layout, f.side, nat, at, f.w, f.h, true);
      moved ||= ['mt', 'mr', 'mb', 'ml'].some((k) => Math.abs(m[k] - f.m[k]) > 0.5);
      f.m = m;
      Object.assign(f.el.style, { margin: `${round(m.mt)}px ${round(m.mr)}px ${round(m.mb)}px ${round(m.ml)}px`,
        shapeOutside: (f.side && shapeOf(f.layout, f.src, { w: f.w, h: f.h, m, side: f.side })) || '', shapeImageThreshold: '0.5' });
    }
    if (!moved && pass) break;
  }
  const pr = part.getBoundingClientRect();
  const top = part.offsetTop;
  return floats.filter((f) => !ABSOLUTE.has(f.layout.wrap)).map((f) => {
    const r = f.el.getBoundingClientRect();
    return { x: round((r.left - pr.left) / s), y: round(top + (r.top - pr.top) / s), w: f.w, h: f.h, layout: f.layout };
  });
}

// ---------------------------------------------------------------------------------------------
// Writing

/** Builds the transaction that gives the object at `pos` layout `layout`, patching `node`'s attribute (§1.8). */
export function setLayoutTr(tr, pos, node, layout) {
  return tr.setNodeAttribute(pos, 'layout', layout);
}

/** Where the object at `pos` is drawn now, as offsets in pt from its column and its anchor paragraph (newFloat's `at`). */
export function drawnAt(view, pos) {
  const node = view.state.doc.nodeAt(pos);
  const dom = node && view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return { x: 0, y: 0 };
  const r = local(view, dom.getBoundingClientRect());
  const a = view.nodeDOM(anchorOf(view.state.doc, pos, node));
  const top = a instanceof HTMLElement ? blockTop(view, a) : r.top;
  return { x: round(r.left / PT), y: round((r.top - top) / PT) };
}

/** The textblock under the layout point `x`, `y` → its position, or null. */
function blockAt(view, x, y) {
  const pm = view.dom.getBoundingClientRect();
  const s = scaleOf(view);
  const hit = view.posAtCoords({ left: pm.left + (x + 2) * s, top: pm.top + (y + 2) * s });
  if (!hit) return null;
  const $p = view.state.doc.resolve(hit.pos);
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).isTextblock) return $p.before(d);
  return null;
}

/** Moves float `o` (measure `m`) to the layout point `x`, `y`: offsets are recomputed in their relations, and unless the anchor
 * is locked (or `keepAnchor`) the object moves to the paragraph under its top-left. `copy` drops a copy there instead (Ctrl). */
export function moveTo(view, o, m, x, y, { copy = false, keepAnchor = false } = {}) {
  const l = o.layout;
  const vRel = l.v?.rel ?? 'paragraph';
  const byText = vRel === 'paragraph' || vRel === 'line';
  const hRel = l.h?.rel ?? 'column';
  let anchor = o.anchor;
  let { hStart, vStart } = m;
  if (!l.lockAnchor && !keepAnchor && o.kind !== 'frame') {
    const b = blockAt(view, x, y);
    if (b != null && b !== o.anchor) {
      anchor = b;
      // The offsets are from the new anchor's frame (its column, cell and page), as measure() will draw them.
      const el = view.nodeDOM(b);
      if (el instanceof HTMLElement) {
        const top = blockTop(view, el);
        const frame = anchorFrame(view, b, el, null, top, top);
        hStart = hBand(hRel, frame).left + frame.dx;
        if (byText) vStart = vBand(vRel, frame).top;
      }
    }
  }
  const { pct: _hp, align: _ha, ...h } = l.h ?? {};
  const { pct: _vp, align: _va, ...v } = l.v ?? {};
  const next = { ...l, h: { ...h, rel: hRel, offset: offsetOf(x, hStart) },
    v: { ...v, rel: vRel, offset: offsetOf(y, vStart) } };
  const { state } = view;
  let tr = state.tr;
  const stored = o.kind === 'textbox' && !o.node.attrs.layout ? { ...TEXTBOX_LAYOUT, ...next } : next;
  if (o.kind === 'frame') {
    const f = o.frame; // its style's settings too: the moved frame keeps its width and wrap
    const frame = { ...f, x: next.h.offset, xAlign: null, y: next.v.offset, yAlign: null };
    tr.setNodeAttribute(o.pos, 'frame', frame);
  } else if (anchor === o.anchor && !copy) {
    setLayoutTr(tr, o.pos, o.node, stored);
  } else {
    const made = o.node.type.create({ ...o.node.attrs, layout: stored }, o.node.content, o.node.marks);
    // A picture goes to the start of its new paragraph; a block object before the flow's block that holds the anchor (in newspaper
    // columns, the column's block: wp/columns flowPos).
    let at = made.isInline ? anchor + 1 : flowPos(state.doc.resolve(anchor), true);
    if (!made.isInline && anchor === o.anchor) at = o.pos;
    if (!copy) {
      tr.delete(o.pos, o.pos + o.node.nodeSize);
      at = tr.mapping.map(at, at > o.pos ? 1 : -1);
    }
    tr.insert(at, made);
    tr.setSelection(NodeSelection.create(tr.doc, at));
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

// ---------------------------------------------------------------------------------------------
// Overlay: the anchor mark, the Layout Options button and the drag guides

let menuHandler = null;
/** Sets what the Layout Options button opens: `fn(view, button)` (index.js binds the menu). */
export const onLayoutOptions = (fn) => {
  menuHandler = fn;
};

/** The selected floating object of `state` (node-selected, or the text box holding the selection) → float or null. */
export function selectedFloat(state) {
  const sel = state.selection;
  if (sel instanceof NodeSelection) return floatsOf(state.doc).find((o) => o.pos === sel.from && o.kind !== 'frame') ?? null;
  const { $from } = sel;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'textBox') return floatsOf(state.doc).find((o) => o.pos === $from.before(d)) ?? null;
  }
  return null;
}

function ui(view) {
  const host = overlayOf(view);
  if (!host) return null;
  let root = host.querySelector(':scope > [data-fl-ui]');
  if (!root) {
    root = host.ownerDocument.createElement('div');
    root.dataset.flUi = '';
    root.innerHTML = '<div data-fl-anchor hidden title="Anchor"></div><div data-fl-points></div><button type="button" data-fl-options hidden aria-label="Layout Options" title="Layout Options">'
      + '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 3h12M2 13h12M2 6h4M2 10h4"/>'
      + '<rect x="8" y="5.5" width="6" height="5"/></svg></button><div data-fl-guides></div>';
    root.querySelector('[data-fl-options]').addEventListener('mousedown', (e) => e.preventDefault());
    host.append(root);
  }
  return root;
}

/** Places the anchor mark and the Layout Options button for the selected float of `view`. */
function drawUi(view, meas) {
  const root = ui(view);
  if (!root) return;
  const anchorEl = root.querySelector('[data-fl-anchor]');
  const btn = root.querySelector('[data-fl-options]');
  const o = view.editable && selectedFloat(view.state);
  const m = o && meas.get(o.pos);
  drawPoints(view, root.querySelector('[data-fl-points]'), o, m);
  if (!m) {
    // Only on a change: writing the same attribute on each keypress still restyles the page.
    if (!anchorEl.hidden) anchorEl.hidden = true;
    if (!btn.hidden) btn.hidden = true;
    return;
  }
  const box = pageOf(view, m.page)?.box;
  const marks = wordSettings(getState().settings).marks;
  anchorEl.hidden = !(marks.anchors || marks.all);
  anchorEl.style.cssText = `left:${px(-(box?.left ?? 0) / 2 - 8)};top:${px(m.anchorTop)}`;
  btn.hidden = false;
  btn.style.cssText = `left:${px(m.x + m.w + 6)};top:${px(m.y)}`;
  btn.onclick = () => menuHandler?.(view, btn);
}

// ---------------------------------------------------------------------------------------------
// Edit Wrap Points (Tight and Through): the outline through layout.poly (fractions of the object's box, Word's wrap polygon) with a
// handle at each point, as Word draws it: dragging a point moves it, dragging the outline adds a point there, and Ctrl+click on a
// point removes it. Each change is one undo step and marks the points edited (Word's wrapPolygon edited="1").

/** Starts editing the wrap points of the object at `pos` (Escape or selecting something else ends it). */
export function editWrapPoints(view, pos) {
  view.dispatch(view.state.tr.setMeta(floatKey, { points: pos }));
}

/** A fraction of a box to ten-thousandths (Word keeps 21600 a side). */
const frac = (n) => Math.round(n * 1e4) / 1e4;

function drawPoints(view, host, o, m) {
  if (!host) return;
  const editing = floatKey.getState(view.state).points;
  const on = o && m && editing === o.pos && (o.layout.wrap === 'tight' || o.layout.wrap === 'through');
  if (!on) {
    if (host.firstChild) host.innerHTML = '';
    host.onmousedown = null;
    return;
  }
  const pts = pointsOf(o.layout);
  const at = ([x, y]) => [round(m.x + x * m.w), round(m.y + y * m.h)];
  const render = (list) => {
    const edges = list.map((p, i) => {
      const [[x1, y1], [x2, y2]] = [at(p), at(list[(i + 1) % list.length])];
      return `<line data-fl-edge="${i}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    });
    host.innerHTML = `<svg data-fl-wrap-line width="1" height="1" style="left:0;top:0"><polygon points="${list.map((p) => at(p).join(',')).join(' ')}"/>${edges.join('')}</svg>`
      + list.map((p, i) => `<div data-fl-point="${i}" style="left:${px(at(p)[0] - 4)};top:${px(at(p)[1] - 4)}"></div>`).join('');
  };
  render(pts);
  const write = (poly) => {
    const node = view.state.doc.nodeAt(o.pos);
    if (node) view.dispatch(setLayoutTr(view.state.tr, o.pos, node, { ...(node.attrs.layout ?? o.layout), poly, polyEdited: true }));
  };
  // Drags point `i` of `list` from the mouse event `e`: the outline follows, and the points are written when the button comes up.
  const drag = (e, list, i) => {
    const s = scaleOf(view);
    const [x0, y0] = list[i];
    let next = list;
    const move = (ev) => {
      next = list.map((p, j) => (j === i ? [frac(x0 + (ev.clientX - e.clientX) / s / m.w), frac(y0 + (ev.clientY - e.clientY) / s / m.h)] : p));
      render(next);
    };
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      if (next !== pts) write(next);
      else render(pts);
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  };
  host.onmousedown = (e) => {
    const point = e.target.closest?.('[data-fl-point]');
    const edge = e.target.closest?.('[data-fl-edge]');
    if (e.button !== 0 || (!point && !edge)) return;
    e.preventDefault();
    e.stopPropagation();
    if (point && e.ctrlKey) {
      if (pts.length > 3) write(pts.filter((_, j) => j !== Number(point.dataset.flPoint)));
    } else if (point) drag(e, pts, Number(point.dataset.flPoint));
    else {
      const i = Number(edge.dataset.flEdge) + 1;
      const q = local(view, { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY });
      const list = [...pts.slice(0, i), [frac((q.left - m.x) / m.w), frac((q.top - m.y) / m.h)], ...pts.slice(i)];
      render(list);
      drag(e, list, i);
    }
  };
}

/** Draws green guide lines at layout x `xs` and y `ys` (empty clears). */
function drawGuides(view, xs, ys) {
  const g = ui(view)?.querySelector('[data-fl-guides]');
  if (!g) return;
  g.innerHTML = '';
  for (const x of xs) g.insertAdjacentHTML('beforeend', `<div data-fl-guide="v" style="left:${px(x)}"></div>`);
  for (const y of ys) g.insertAdjacentHTML('beforeend', `<div data-fl-guide="h" style="top:${px(y)}"></div>`);
}

/** The snap lines while dragging (settings.word.guides, G7): page edges and centre, margins, and paragraph tops on the page. */
function guideLines(view, m) {
  const page = pageOf(view, m.page);
  if (!page) return { xs: [], ys: [] };
  const g = wordSettings(getState().settings).guides;
  const { box } = page;
  const xs = [];
  const ys = [];
  if (g.page) {
    xs.push(-box.left, -box.left + box.w / 2, -box.left + box.w);
    ys.push(page.top, page.top + box.h / 2, page.top + box.h);
  }
  if (g.margin) {
    xs.push(0, box.text);
    ys.push(page.bodyTop, page.bodyTop + page.bodyHeight);
  }
  if (g.paragraph) {
    for (const el of view.dom.children) {
      const t = el.offsetTop;
      if (t >= page.top && t <= page.top + box.h && !el.matches('[data-fl]')) ys.push(t);
    }
  }
  return { xs, ys };
}

/** Snaps the box at `x`, `y` (size m.w x m.h) to the nearest guide within `near` px on each axis → {x, y, gx: [], gy: []}. */
function snap(lines, m, x, y, near) {
  const best = (vals, start, size) => {
    let hit = null;
    for (const v of vals) {
      for (const edge of [0, size / 2, size]) {
        const d = v - (start + edge);
        if (Math.abs(d) <= near && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, v };
      }
    }
    return hit;
  };
  const hx = best(lines.xs, x, m.w);
  const hy = best(lines.ys, y, m.h);
  return { x: x + (hx?.d ?? 0), y: y + (hy?.d ?? 0), gx: hx ? [hx.v] : [], gy: hy ? [hy.v] : [] };
}

// ---------------------------------------------------------------------------------------------
// Dragging, nudging and the Insert Frame tool

/** Starts dragging float `o` from the mouse event `e`. Shift keeps one axis, Ctrl drops a copy, Alt skips snapping. */
function drag(view, o, e) {
  const m = measOf(view.state, o.pos);
  const dom = view.nodeDOM(o.pos);
  if (!m || !(dom instanceof HTMLElement)) return false;
  const s = scaleOf(view);
  const sx = e.clientX;
  const sy = e.clientY;
  const settings = wordSettings(getState().settings);
  const lines = settings.guides.display ? guideLines(view, m) : { xs: [], ys: [] };
  const grid = (view.state.doc.attrs.settings?.grid?.h ?? 9) * PT;
  let at = null;
  const move = (ev) => {
    let dx = (ev.clientX - sx) / s;
    let dy = (ev.clientY - sy) / s;
    if (!at && Math.hypot(dx, dy) < 3) return;
    if (ev.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    let x = m.x + dx;
    let y = m.y + dy;
    let gx = [];
    let gy = [];
    if (!ev.altKey) {
      const sn = snap(lines, m, x, y, 6 / s);
      ({ x, y, gx, gy } = sn);
      if (settings.guides.snapGrid && !gx.length) x = Math.round(x / grid) * grid;
      if (settings.guides.snapGrid && !gy.length) y = m.vStart + Math.round((y - m.vStart) / grid) * grid;
    }
    at = { x, y, copy: ev.ctrlKey };
    dom.style.translate = `${round(x - m.x)}px ${round(y - m.y)}px`;
    drawGuides(view, gx, gy);
  };
  const up = (ev) => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    dom.style.translate = '';
    drawGuides(view, [], []);
    if (at) moveTo(view, o, m, at.x, at.y, { copy: at.copy || ev.ctrlKey });
  };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
  return true;
}

/** Nudges the selected float with an arrow key: one drawing grid unit (doc settings grid, 9 pt), or 1 px with Ctrl. */
function nudge(view, e) {
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const d = dirs[e.key];
  if (!d || e.altKey || e.metaKey || e.shiftKey || !(view.state.selection instanceof NodeSelection)) return false;
  const o = selectedFloat(view.state);
  const m = o && measOf(view.state, o.pos);
  if (!m) return false;
  const grid = view.state.doc.attrs.settings?.grid ?? {};
  const step = e.ctrlKey ? 1 : (d[0] ? grid.h ?? 9 : grid.v ?? 9) * PT;
  return moveTo(view, o, m, m.x + d[0] * step, m.y + d[1] * step, { keepAnchor: true });
}

/** Arms the Insert Frame tool on `view`: the next drag on the page draws the frame. */
export function armFrameTool(view) {
  view.dispatch(view.state.tr.setMeta(floatKey, { tool: 'frame' }));
}

/** Draws a frame from the mouse event `e`: a rectangle in the overlay until the button comes up, then an empty framed paragraph
 * there (§1.8 paragraph frame, positioned on the page) before the block where the drag started. */
function drawFrame(view, e) {
  const root = ui(view);
  const pm = view.dom.getBoundingClientRect();
  const s = scaleOf(view);
  const start = { x: (e.clientX - pm.left) / s, y: (e.clientY - pm.top) / s };
  const startPos = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? view.state.selection.from;
  const rect = root?.ownerDocument.createElement('div');
  if (rect) {
    rect.dataset.flFrameRect = '';
    root.append(rect);
  }
  let end = start;
  const box = () => ({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) });
  const move = (ev) => {
    end = { x: (ev.clientX - pm.left) / s, y: (ev.clientY - pm.top) / s };
    const b = box();
    if (rect) rect.style.cssText = `left:${px(b.x)};top:${px(b.y)};width:${px(b.w)};height:${px(b.h)}`;
  };
  const up = (ev) => {
    move(ev);
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    rect?.remove();
    const b = box();
    let tr = view.state.tr.setMeta(floatKey, { tool: null });
    if (b.w >= 8 && b.h >= 8) {
      const geo = geometryOf(view.state);
      const pages = geo?.pages ?? [];
      const page = [...pages].reverse().find((p) => p.top <= b.y) ?? pages[0] ?? loosePage(view);
      const frame = { dropCap: null, lines: null, w: round(b.w / PT), h: round(b.h / PT), hRule: 'exact', hSpace: 9, vSpace: 0, wrap: 'around',
        hAnchor: 'page', vAnchor: 'page', x: round((b.x + page.box.left) / PT), xAlign: null, y: round((b.y - page.top) / PT), yAlign: null };
      const $p = view.state.doc.resolve(startPos);
      const at = $p.depth ? $p.before(1) : startPos;
      tr = tr.insert(at, view.state.schema.nodes.paragraph.create({ frame }));
      tr.setSelection(TextSelection.create(tr.doc, at + 1));
    }
    view.dispatch(tr);
    view.focus();
  };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
  return true;
}

// ---------------------------------------------------------------------------------------------
// New pictures take the default layout (Set as Default Layout, settings.word.paste.pictures)

const hasImage = (slice) => {
  let found = false;
  slice?.content.descendants((n) => {
    found ||= n.type.name === 'image';
    return !found;
  });
  return found;
};

function defaultLayout(trs, state) {
  const wrap = wordSettings(getState().settings).paste.pictures;
  if (!wrap || wrap === 'inline') return null;
  const ranges = [];
  trs.forEach((tr, i) => {
    if (!tr.docChanged || tr.getMeta('history$') || tr.getMeta('wordEngine') || tr.getMeta('preventUpdate') || tr.getMeta('addToHistory') === false
      || tr.getMeta('uiEvent') === 'drop') return;
    tr.steps.forEach((step, j) => {
      if (!hasImage(step.slice)) return;
      step.getMap().forEach((_a, _b, from, to) => {
        let f = tr.mapping.slice(j + 1).map(from, -1);
        let t = tr.mapping.slice(j + 1).map(to, 1);
        for (const later of trs.slice(i + 1)) {
          f = later.mapping.map(f, -1);
          t = later.mapping.map(t, 1);
        }
        ranges.push([f, t]);
      });
    });
  });
  if (!ranges.length) return null;
  const tr = state.tr;
  for (const [f, t] of ranges) {
    state.doc.nodesBetween(f, Math.min(t, state.doc.content.size), (n, pos) => {
      if (n.type.name === 'image' && !n.attrs.layout) tr.setNodeAttribute(pos, 'layout', newFloat(wrap));
    });
  }
  return tr.docChanged ? tr : null;
}

// ---------------------------------------------------------------------------------------------
// Headers and footers: their text wraps round their floats, and the body round those reaching into it

/** A story editor's text height (flowHeight) while one of its floats wraps the text at a side, else null: the editor (a flow
 * root in style.css) takes that height, so the part being edited keeps its text's height as the layer draws it. */
function storyFlow(view, meas) {
  if (!storyPages.has(view) || ![...meas.values()].some((m) => m.floated)) return null;
  return flowHeight(view.dom, scaleOf(view));
}

/** The start of the top-level block holding `pos`, where the page widgets sit. */
function topBlock(doc, pos) {
  const $p = doc.resolve(Math.min(pos, doc.content.size));
  return $p.depth ? $p.before(1) : $p.pos;
}

/** The layout pass that makes the body wrap round the floats of headers and footers that reach into it (§1.9 LayoutPass, after
 * the page measure): each page layer with floats(page, state, view) → [{x, y, w, h, layout}] (paper px, headers-footers layer.js)
 * gives them, and pageWraps turns each page's into CSS floats, at most two a side, each ending by the page's cut (geometry cut):
 * the page end's spacer floats below them (clear), so a wrap reaching past the cut would push the page end down. A header's go
 * in a widget at the page's start right after its page widget (pagination.js: side -2 at 0 for the first page, -1 or 2 at the
 * page's anchor), so it lies below the page's pusher, at the top of its text (geometry textTop). A footer's reaching up go in a
 * widget before the first block on the page whose box reaches below their top, or before the page end when none does, so
 * blocks that avoid a float's whole box above it (whole tables, Top and Bottom pictures, Text Wrapping breaks) stay where they
 * are. CSS puts that float below the previous block's space after and above its block's space before (Chrome, 2026-10-30), so
 * its top is worked out from the previous block, never read back off the widget (a widget kept across an edit keeps stale
 * attributes). Engine 2 only: engine 1 has no page starts in the flow.
 * ponytail: the part of an outline above the text's top (repeated header rows) is lost, a page end inside flowing columns puts
 * the widget before the columns' block, and a Text Wrapping break in the block a footer's float goes before, above the float's
 * top, still clears it; a previous block that floats itself, or whose last child's space after collapses through it, puts the
 * worked out top off. */
export const PAGE_WRAP_PASS = {
  id: 'float-layout.pageWraps',
  phase: 'after',
  run(view) {
    if (!view.dom.isConnected || view.dom.closest('[data-story]')) return false;
    const st = floatKey.getState(view.state);
    if (!st) return false;
    const geo = geometryOf(view.state);
    const pg = paginationKey.getState(view.state);
    const sources = layers().filter((l) => typeof l.floats === 'function');
    // The body's own objects placed on their page (measure's paged), by page: in paper px from the text column's left and the
    // paper's top, as the layers give theirs.
    const own = new Map();
    if (geo?.engine === 2) {
      for (const o of floatsOf(view.state.doc)) {
        const m = st.meas.get(o.pos);
        const page = m?.paged ? geo.pages[m.page] : null;
        if (!page) continue;
        if (!own.has(m.page)) own.set(m.page, []);
        own.get(m.page).push({ x: m.x, y: m.y - page.top, w: m.w, h: m.h, layout: o.layout, src: o.node.attrs.src });
      }
    }
    const wraps = [];
    if (geo?.engine === 2 && pg?.draw && (sources.length || own.size)) {
      let blocks = null;
      let r = -1; // the page's index among the pages that are not blank, which the anchors count
      geo.pages.forEach((page, i) => {
        if (page.blank) return;
        r++;
        const pos = r === 0 ? 0 : pg.anchors[r - 1];
        if (pos == null) return;
        const rects = [...sources.flatMap((l) => l.floats(page, view.state, view) ?? []), ...(own.get(i) ?? [])];
        if (!rects.length) return;
        const top = page.textTop ?? page.bodyTop;
        // Whole pixels: a cut that moves by a fraction between rounds would re-key the widget, and lay the page out again, each time.
        const body = { top: top - page.top, height: Math.floor((page.cut ?? page.bodyTop + page.bodyHeight) - top), width: page.box.text };
        const end = pg.anchors[r] ?? view.state.doc.content.size;
        // Where a float for outlines from `y` (px below the text's top) goes: before the first block of the page reaching below
        // y, or at the page end (the page's last block can sit there while the page's end is still being worked out); null at
        // the page's start. Its top in whole px, so a fraction never re-keys the widget.
        const slotAt = (y) => {
          blocks ??= topBlocks(view);
          const i = blocks.findIndex((b) => b.pos >= pos && b.pos < end && local(view, b.el.getBoundingClientRect()).bottom - top > y);
          if (blocks[i]?.pos === pos) return null;
          const next = i >= 0 ? i : blocks.findIndex((b) => b.pos >= end);
          const prev = blocks[(next < 0 ? blocks.length : next) - 1]?.el;
          const y0 = prev ? local(view, prev.getBoundingClientRect()).bottom + (parseFloat(getComputedStyle(prev).marginBottom) || 0) : top;
          return { ...(i >= 0 ? { pos: blocks[i].pos, at: 0 } : { pos: end, at: -2 }), top: Math.round(y0 - top) };
        };
        for (const w of pageWraps(rects, body, slotAt)) {
          const css = `float:${w.side};width:${w.w}px;height:${w.h}px;margin:0;padding:0;shape-outside:${w.shape};pointer-events:none`;
          const at = w.slot ?? { pos, at: r === 0 ? -1 : pg.after?.[r - 1] ? 3 : 0 };
          wraps.push({ pos: at.pos, at: at.at, side: w.side, key: `fl-wrap${i}:${css}`, css });
        }
      });
    }
    const sig = (list) => list.map((w) => `${w.pos}/${w.at}/${w.key}`).join('|');
    if (sig(wraps) === sig(st.wraps)) return false;
    view.dispatch(view.state.tr.setMeta(floatKey, { wraps }).setMeta('addToHistory', false));
    return true;
  },
};

// ---------------------------------------------------------------------------------------------

/** The plugin (index.js adds it to the Document kit). */
export function floatLayoutPlugin() {
  return new Plugin({
    key: floatKey,
    state: {
      // wraps: the page wrap widgets (PAGE_WRAP_PASS); flowH: a story editor's text height while a float in it wraps (storyFlow).
      init: (_, state) => ({ meas: new Map(), wraps: [], flowH: null, deco: decorate(state.doc, new Map()), tool: null, points: null }),
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(floatKey);
        let { meas, tool, points, wraps, flowH } = prev;
        if (meta && 'wraps' in meta) wraps = meta.wraps;
        else if (tr.docChanged && wraps.length) wraps = wraps.map((w) => ({ ...w, pos: topBlock(tr.doc, tr.mapping.map(w.pos, -1)) }));
        if (meta && 'flowH' in meta) flowH = meta.flowH;
        if (meta && 'tool' in meta) tool = meta.tool;
        if (meta && 'points' in meta) points = meta.points;
        else if (points != null && tr.selectionSet) {
          // Editing ends when the object is no longer the selection.
          const r = tr.mapping.mapResult(points, 1);
          points = !r.deleted && tr.selection instanceof NodeSelection && tr.selection.from === r.pos ? r.pos : null;
        } else if (points != null && tr.docChanged) points = tr.mapping.mapResult(points, 1).deleted ? null : tr.mapping.map(points, 1);
        if (meta?.meas) meas = meta.meas;
        else if (tr.docChanged) {
          const next = new Map();
          for (const [pos, m] of meas) {
            const r = tr.mapping.mapResult(pos, 1);
            if (!r.deleted) next.set(r.pos, m);
          }
          meas = next;
        }
        if (meas === prev.meas && !tr.docChanged && tool === prev.tool && points === prev.points && wraps === prev.wraps && flowH === prev.flowH) return prev;
        if (meas === prev.meas && wraps === prev.wraps && !tr.docChanged) return { ...prev, meas, tool, points, wraps, flowH };
        const story = meta?.story ?? prev.story ?? false;
        // Only a new measure of the same doc can keep the set: an edit maps and redraws it (and a keypress pays no key).
        const sameDoc = wraps === prev.wraps && !tr.docChanged;
        const key = sameDoc ? decoKey(state.doc, meas, story) : null;
        const keep = sameDoc && key === (prev.key ?? decoKey(state.doc, prev.meas, prev.story ?? false));
        return { meas, tool, points, wraps, flowH, deco: keep ? prev.deco : decorate(state.doc, meas, wraps, story), key, story };
      },
    },
    appendTransaction: (trs, _old, state) => defaultLayout(trs, state),
    props: {
      decorations: (state) => floatKey.getState(state).deco,
      attributes: (state) => {
        const st = floatKey.getState(state);
        return { ...(st.tool ? { 'data-fl-tool': st.tool } : {}), ...(st.flowH != null ? { style: `height:${px(st.flowH)}` } : {}) };
      },
      handleKeyDown(view, e) {
        const st = floatKey.getState(view.state);
        if (e.key === 'Escape' && (st.tool || st.points != null)) {
          view.dispatch(view.state.tr.setMeta(floatKey, { tool: null, points: null }));
          return true;
        }
        return nudge(view, e);
      },
      handleDOMEvents: {
        mousedown(view, e) {
          if (e.button !== 0) return false;
          if (floatKey.getState(view.state).tool === 'frame') {
            e.preventDefault();
            return drawFrame(view, e);
          }
          if (!view.editable || e.target.closest?.('[data-resize-handle]')) return false;
          const o = floatsOf(view.state.doc).find((f) => f.kind !== 'frame' && view.nodeDOM(f.pos)?.contains?.(e.target));
          if (!o) return false;
          const sel = view.state.selection;
          const selected = sel instanceof NodeSelection && sel.from === o.pos;
          // Pictures drag at once; a text box, canvas or plan chart keeps its own clicks until it is selected.
          if (o.kind !== 'picture' && o.kind !== 'graphic' && !selected) return false;
          e.preventDefault();
          if (!selected) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, o.pos)));
          view.focus();
          return drag(view, floatAt(view.state, o.pos) ?? o, e);
        },
        dragstart(view, e) {
          // A floating picture moves by the drag above, never by the browser's drag and drop of its node.
          const o = selectedFloat(view.state);
          if (o && view.nodeDOM(o.pos)?.contains?.(e.target)) {
            e.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
    view(view) {
      let frame = 0;
      let rounds = 0; // measures in a row that changed something, so two layouts that feed each other stop
      const run = () => {
        frame = 0;
        if (!view.dom.isConnected || (view.dom.closest('[data-story]') && !storyPages.has(view)) || view.isDestroyed) return;
        const st = floatKey.getState(view.state);
        const meas = measure(view, st.meas);
        drawUi(view, meas);
        const flowH = storyFlow(view, meas);
        if ((same(meas, st.meas) && Math.abs((flowH ?? -1) - (st.flowH ?? -1)) < 0.5) || rounds > 6) return;
        // While the pages are still being laid out, a new measure that draws the other objects as they are (to half a pixel)
        // waits for the last page: page ends drawn above Behind and In Front of Text objects move them on most frames, the others'
        // margins drift by hundredths of a pixel, and each redraw laid the text out again (about 50 ms a frame on the Word
        // fixture). Pagination's progress update when it settles runs this again.
        const progress = paginationKey.getState(view.state)?.progress;
        if (progress && !progress.settled && flowH === st.flowH && drawsAlike(meas, st.meas, absoluteAt(view.state.doc))) return;
        rounds++;
        view.dispatch(view.state.tr.setMeta(floatKey, { meas, flowH, story: storyPages.has(view) }).setMeta('addToHistory', false));
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(run);
      };
      const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
      ro?.observe(view.dom);
      schedule();
      return {
        update(v, prevState) {
          // The pages' layout settling starts a new count: the guard stops two layouts feeding each other within one, and on the
          // Word fixture an open used its rounds up while the pages were drawn, so objects measured then kept those measures. Objects
          // on pages not drawn yet are not measured (measure), so a count per drawing step only relaid the document out more often.
          const was = paginationKey.getState(prevState)?.progress;
          const now = paginationKey.getState(v.state)?.progress;
          if (prevState.doc !== v.state.doc || prevState.selection !== v.state.selection || (now?.settled && !was?.settled)) rounds = 0;
          if (floatKey.getState(prevState).points !== floatKey.getState(v.state).points) drawUi(v, floatKey.getState(v.state).meas);
          schedule();
        },
        destroy() {
          if (frame) cancelAnimationFrame(frame);
          ro?.disconnect();
          view.dom.parentElement?.querySelector(':scope > #page-overlay > [data-fl-ui]')?.remove();
        },
      };
    },
  });
}
