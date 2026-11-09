// Page geometry, page layers and layout passes (docs/plans/word/plan.md §1.9): what the pagination plugin publishes, read the same
// way whichever engine fills it, so page-engine replaces engine 1 without touching this file. Layers draw per page (headers, page
// borders, watermarks, note areas); passes measure inside pagination's frame (tabs, hyphenation, line numbers). The pure parts are
// in geometry.mjs.
import { PluginKey } from '@tiptap/pm/state';
import { indexAt, pageOfPos } from './geometry.mjs';
import { drawAll } from './lazy.mjs';
import { sectionAt } from './model/sections.mjs';

/** The pagination plugin's key; its state is {counts, page, pages, geo, draw} (pagination.js). */
export const paginationKey = new PluginKey('pagination');

let layerList = [];
let passList = [];
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

/** Calls `fn` whenever a layer or a pass comes or goes (pagination views schedule a frame) → unsubscribe. */
export function onLayoutChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const memo = new WeakMap();

/** The Geometry of `state` (§1.9): the plugin's geo with pageOf(pos) and sectionOf(pos), memoised on geo; null without pagination.
 * Engine 1 replaces geo in the plugin state at the end of each measure, without a transaction, so read it inside a layout pass, a
 * page layer or after the frame: a transaction that changes the page count carries the new `pages` while geo still lists the
 * old pages. */
export function geometryOf(state) {
  const geo = paginationKey.getState(state)?.geo;
  if (!geo) return null;
  let g = memo.get(geo);
  if (!g) {
    const { blocks, starts, sections } = geo;
    g = {
      ...geo,
      pageOf: (pos) => pageOfPos(blocks, starts, pos),
      sectionOf: (pos) => sectionAt(sections, pos),
    };
    memo.set(geo, g);
  }
  return g;
}

/** The layout px scale of `view` (the page zoom is a CSS zoom on #page-wrap): the element's effective CSS zoom. Rendered height
 * over offsetHeight (a whole number) moved with the fraction of the text's height, so a spacer redrawn a tenth of a pixel
 * taller changed every position read through it and pagination never settled; the ratio stays as the fallback. */
export const scaleOf = (view) => view.dom.currentCSSZoom || view.dom.getBoundingClientRect().height / view.dom.offsetHeight || 1;

/** The layout y of `pos` in `view` (the page zoom divided out): its line's top with edge 'top', else the line's middle. Throws
 * for a position without coordinates. */
export function layoutY(view, pos, edge) {
  const c = view.coordsAtPos(pos);
  return ((edge === 'top' ? c.top : (c.top + c.bottom) / 2) - view.dom.getBoundingClientRect().top) / scaleOf(view);
}

const ranges = new WeakMap(); // document → its one reused Range

/** One Range per document, reused for every measurement: each Range lives in its document until garbage collected, and the browser
 * updates every live one on each DOM removal, so the tens of thousands a long document's layout made slowed every removal. */
export function rangeIn(d) {
  let r = ranges.get(d);
  if (!r) ranges.set(d, (r = d.createRange()));
  return r;
}

/** Every non-text node's DOM in `view` by its position (what view.nodeDOM(pos) returns), from one walk over the view's node
 * descriptions. view.nodeDOM walks the top-level blocks from the start on each call, so a pass calling it per paragraph of a long
 * document cost blocks squared (seconds). Read it within one frame: the DOM changes with the next transaction. With `desc`, a
 * node description of the view at position `base` (a top-level block), only that node and what it holds. */
export function nodeDOMs(view, desc = view.docView, base = 0) {
  const out = new Map();
  const walk = (d, pos) => {
    for (const c of d.children) {
      if (c.node) {
        if (!c.node.isText) out.set(pos, c.nodeDOM ?? c.dom);
        if (c.contentDOM && c.children.length) walk(c, pos + c.border);
      } else if (c.children?.length) walk(c, pos); // a mark: its children start where it does
      pos += c.size;
    }
  };
  if (desc === view.docView) walk(desc, 0);
  else if (desc) {
    out.set(base, desc.nodeDOM ?? desc.dom);
    if (desc.contentDOM && desc.children.length) walk(desc, base + desc.border);
  }
  return out;
}

/** The DOM of the nodes at `positions` in `view` (Map pos → DOM), walking only the top-level blocks that hold them, so a pass with a
 * few objects in a long document reads a few blocks instead of every node (nodeDOMs). Read it within one frame. */
export function nodeDOMsAt(view, positions) {
  const { doc } = view.state;
  const descs = view.docView.children.filter((d) => d.node);
  if (descs.length !== doc.childCount) return nodeDOMs(view); // mid-update: the descriptions do not match the doc
  // One pass over the top-level blocks with the positions sorted (doc.resolve scans the blocks from the start for each position).
  const want = [...positions].sort((a, b) => a - b);
  const out = new Map();
  let k = 0;
  doc.forEach((node, start, i) => {
    while (k < want.length && want[k] < start) k++;
    if (k >= want.length || want[k] >= start + node.nodeSize) return;
    for (const [p, el] of nodeDOMs(view, descs[i], start)) out.set(p, el);
  });
  return out;
}

/** The top-level blocks of `view` in order → [{pos, el}]: nodeDOMs for the top level only, which the page wrap pass walks once per
 * pass without the cost of every nested node (widgets have no node and no size). */
export function topBlocks(view) {
  const out = [];
  let pos = 0;
  for (const c of view.docView.children) {
    if (c.node) out.push({ pos, el: c.dom });
    pos += c.size;
  }
  return out;
}

const bodyTops = new WeakMap(); // geometry pages → their body tops (a field or note per page lookup would map 200 pages each)

/** The exact 0-based page of `pos` from its coordinates (layout px), for fields inside long paragraphs; 0 when it has none. */
export function pageAtPos(view, pos) {
  const pages = geometryOf(view.state)?.pages;
  if (!pages?.length) return 0;
  try {
    const y = layoutY(view, pos);
    let tops = bodyTops.get(pages);
    if (!tops) bodyTops.set(pages, (tops = pages.map((p) => p.bodyTop)));
    return pages[indexAt(tops, y)].index;
  } catch {
    return 0;
  }
}

/** Adds a page layer (§1.9 PageLayer: {id, z, key(state, page), render(el, page, view), reserve?}) → unregister. A layer with the
 * id of a registered one replaces it. */
export function registerPageLayer(layer) {
  layerList = [...layerList.filter((l) => l.id !== layer.id), layer].sort((a, b) => a.z - b.z);
  changed();
  return () => {
    if (!layerList.includes(layer)) return;
    layerList = layerList.filter((l) => l !== layer);
    changed();
  };
}

/** The registered page layers in z order, for the engine. */
export const layers = () => layerList;

/** Adds a layout pass ({id, phase: 'before'|'after', run(view) → true when it moved text}) → unregister. */
export function registerLayoutPass(pass) {
  passList = [...passList.filter((p) => p.id !== pass.id), pass];
  changed();
  return () => {
    if (!passList.includes(pass)) return;
    passList = passList.filter((p) => p !== pass);
    changed();
  };
}

/** The registered layout passes of `phase`, in registration order. */
export const passes = (phase) => passList.filter((p) => p.phase === phase);

/** A box the size of page `index`'s paper (overflow hidden) holding a clone of view.dom shifted to that page's top: no
 * contenteditable, no ids, page layers kept and <canvas> bitmaps copied. Read Mode, Multiple Pages, print preview and the Pages
 * pane draw pages with it. `near` clones only the top-level blocks from two pages above this one to a page below (a spacer
 * holds the place of those above), so printing every page costs pages, not pages squared; the slack keeps floats and break
 * widgets drawn across a page end. `match` lays the copy out at the editor's page zoom and scales the rest with a transform: text
 * laid out at another zoom can wrap and round differently, and the page ends the engine wrote for the editor then miss by a few
 * px a page, so later pages show a strip of the gap or of the next page. A number is the zoom to lay the copy out at (print, which
 * has no screen pixels: the editor's zoom times the screen's pixel ratio). A page the progressive layout has not drawn yet is a
 * blank paper marked data-pending (the views draw it again as the pages come, a few frames later), unless `now` lays the pages up
 * to it out at once (print and PDF, after pagesReady). → the box, or null for a page that does not exist. */
export function pageClone(view, index, { scale = 1, near = false, match = false, now = false } = {}) {
  // The engine draws the sheets and layers near the view only, and a long document's pages progressively (pagination.js): this
  // page's sheet and layers are drawn now, and the copy shows every sheet it holds.
  const drawn = view.dom.pgEngine?.ensurePage?.(index, now) ?? true;
  const page = geometryOf(view.state)?.pages[index];
  if (!page) return null;
  const d = view.dom.ownerDocument;
  const { box } = page;
  // The blank page of an Odd or Even Page break is an empty paper: Word prints it with no header, footer or page border (probe
  // .smoke-data/word/fixture/out/probe/odd-even/probe_docx.py). It has no text of its own, and its place in the flow is the next
  // page's, so a copy of the text there showed a strip of the gap and the page before.
  if (!drawn || page.blank) {
    const paper = d.createElement('div');
    paper.className = 'pg-clone';
    if (!drawn) paper.dataset.pending = '';
    paper.style.cssText = `position:relative;width:${box.w * scale}px;height:${box.h * scale}px;background:var(--page-color, #ffffff)`;
    return paper;
  }
  drawAll(view, { top: page.top, bottom: page.top + box.h }); // its objects that wait to draw (lazy.mjs) draw before the copy
  const outer = d.createElement('div');
  outer.className = 'pg-clone';
  outer.style.cssText = `position:relative;overflow:hidden;width:${box.w * scale}px;height:${box.h * scale}px;background:var(--page-color, #ffffff)`;
  // The page's own .page keeps the Document's scoped rules and sheet variables; its own box is reset.
  const sheet = view.dom.closest('.page')?.cloneNode(false) ?? d.createElement('div');
  sheet.removeAttribute('id');
  const zoom = typeof match === 'number' ? match : match ? scaleOf(view) : 1;
  sheet.style.cssText += `;position:absolute;left:0;top:0;margin:0;padding:0;min-height:0;width:${box.w}px;height:${box.h}px;`
    + `box-shadow:none;background:transparent;zoom:${zoom};transform:scale(${scale / zoom});transform-origin:0 0`;
  const copy = near ? nearCopy(view, page) : view.dom.cloneNode(true);
  copy.removeAttribute('contenteditable');
  copy.classList.remove('ProseMirror-focused');
  // The text's exact width (offsetWidth rounds it: 603 for 603.18 px wrapped a line that just fitted), and the line breaking the
  // editable text gets from contenteditable, which the copy drops: either one differing moves the copy's text off the page ends.
  copy.style.cssText += `;position:absolute;left:${box.left}px;top:${-page.top}px;width:${getComputedStyle(view.dom).width};margin:0;`
    + '-webkit-line-break:after-white-space';
  for (const el of [copy, ...copy.querySelectorAll('[id], [contenteditable]')]) {
    el.removeAttribute('id');
    el.removeAttribute('contenteditable');
  }
  // Sheets and culled blocks far from the view (page-engine/cull.js) draw in the copy.
  for (const el of copy.querySelectorAll(':scope > *, .pg-page')) el.style.removeProperty('content-visibility');
  if (!near) copyCanvases(view.dom, copy);
  fxOffPage(view, copy, index);
  sheet.append(copy);
  outer.append(sheet);
  return outer;
}

/** Turns off, in `copy` (the copy of page `index` of `view`), the text effects of every run whose top-level block has no line on
 * that page: Word clips a run's outline, shadow, glow and reflection to its own page, and the copy holds the pages beside it too
 * (a 1,584 pt outline painted the page before its own red). A block runs from the page of its first line to the page the next
 * block starts on (the live layout can't tell: blocks far from the view are culled). Runs carry their position (data-w-fx,
 * wp/font/extension.js). */
function fxOffPage(view, copy, index) {
  const runs = copy.querySelectorAll('[data-w-fx]');
  const geo = runs.length && paginationKey.getState(view.state)?.geo;
  if (!geo?.blocks?.length) return;
  const { blocks, starts } = geo;
  for (const el of runs) {
    const i = indexAt(starts, Number(el.getAttribute('data-w-fx')));
    if (index < blocks[i] || index > (blocks[i + 1] ?? Infinity)) el.classList.add('w-fx-off');
  }
}

/** Resolves once every page of `view` is laid out and drawn (print and PDF wait on it before their page copies): the engine lays
 * the rest out a frame at a time, so the window keeps answering. At once without page-engine. */
export function pagesReady(view) {
  return view.dom.pgEngine?.whenDrawn?.() ?? Promise.resolve();
}

/** Draws each <canvas> of `src` into the same canvas of its clone `dst`. */
function copyCanvases(src, dst) {
  const from = src.querySelectorAll('canvas');
  dst.querySelectorAll('canvas').forEach((c, i) => {
    const el = from[i];
    if (!el?.width || !el.height) return;
    c.width = el.width;
    c.height = el.height;
    try { c.getContext('2d')?.drawImage(el, 0, 0); } catch { /* a WebGL or tainted canvas stays blank */ }
  });
}

/** view.dom's clone with only the top-level blocks from two pages above `page` to a page below it, read in layout px (view.dom is
 * their offset parent). Zero-height children are pagination's float stacks (.pg-pages, one per page end): those in range stay,
 * and so does the last run of them above, whose floats push the text of the pages after it. Spacers put the first kept child
 * where it was. Two pages: an object floating beside the text (no taller than a page) shapes the lines of the blocks after it,
 * and with one, a block that started on the page above kept those lines but lost the float (a framed paragraph moved a page's
 * text up 52 px in print). */
function nearCopy(view, page) {
  const d = view.dom.ownerDocument;
  const copy = view.dom.cloneNode(false);
  const lo = page.top - 2 * page.box.h;
  const hi = page.top + 2 * page.box.h;
  const pad = parseFloat(getComputedStyle(view.dom).paddingTop) || 0;
  let y = pad; // where the flow of the copy ends so far, before any pending margin
  let skipped = false; // children above were left out and nothing is placed yet
  let cover = []; // the last run of float stacks above, at one place
  let run = false; // the last child looked at was such a stack
  // Moves the flow down by `h`: a height, or a negative bottom margin that collapses with the next child's top margin.
  const gap = (h) => {
    const el = d.createElement('div');
    el.style.cssText = h >= 0 ? `height:${h}px;margin:0` : `height:0;margin:0 0 ${h}px`;
    copy.append(el);
  };
  const add = (el) => {
    const c = el.cloneNode(true);
    copyCanvases(el, c);
    copy.append(c);
  };
  for (const el of view.dom.children) {
    const top = el.offsetTop;
    const h = el.offsetHeight;
    if (!h && top < lo) {
      // A block that crosses several page ends has a stack for each before it, one after another at one place: the whole run
      // stays, so each stack's floats start below the last one's, as they did.
      if (!run) cover = [];
      cover.push(el);
      run = true;
      skipped = true;
      continue;
    }
    run = false;
    if (top > hi || (h && top + h < lo)) {
      if (!copy.firstChild) skipped = true;
      continue;
    }
    if (skipped) {
      if (cover.length) {
        // The run's floats start where they did, below those of stacks further up that the copy leaves out (a line taller than
        // the page, a block that crosses page ends): a float of no width down to there holds them, and moves no line.
        const at = cover[0].offsetTop;
        const f = [...cover[0].children].find((c) => c.offsetParent === view.dom && getComputedStyle(c).float !== 'none');
        if (f && f.offsetTop > at) {
          const hold = d.createElement('div');
          hold.style.cssText = `float:left;clear:both;width:0;height:${f.offsetTop - pad}px;margin:0`;
          copy.append(hold);
        }
        gap(at - pad);
        for (const c of cover) {
          add(c);
          copy.lastChild.style.margin = '0'; // placed here exactly; the margins it trims (pagination.js) applied above it
        }
        y = at;
      }
      gap(top - (h ? marginAbove(el) : 0) - y);
      skipped = false;
    }
    add(el);
  }
  return copy;
}

/** The top margin `el` takes: its own collapsed with those of its first children that reach its top (a content control's first
 * paragraph's space before goes through the control's box, CSS 2.1 §8.3.1). */
function marginAbove(el) {
  let most = 0;
  let least = 0;
  for (let e = el; e;) {
    const cs = getComputedStyle(e);
    const m = parseFloat(cs.marginTop) || 0;
    [most, least] = [Math.max(most, m), Math.min(least, m)];
    if ((parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.borderTopWidth) || 0) > 0 || cs.display !== 'block' || cs.overflow !== 'visible') break;
    // Its first child in the flow: a block's margin goes through, an inline one starts a line and stops it.
    let next = null;
    for (const c of e.children) {
      const k = getComputedStyle(c);
      if (k.display === 'none' || /absolute|fixed/.test(k.position) || k.float !== 'none') continue;
      next = /^(block|list-item)$/.test(k.display) ? c : null;
      break;
    }
    e = next;
  }
  return most + least;
}

/** The #page-overlay element of `view`'s parent, created when missing (no reads). Pagination creates it with the editor, before the
 * document's first style pass: added later, it changed the text's place among its siblings (:last-child), and the browser then
 * restyled the whole document (seconds on a long one). */
export function overlayElement(view) {
  const host = view.dom.parentElement;
  if (!host) return null;
  let el = host.querySelector(':scope > #page-overlay');
  if (!el) {
    el = host.ownerDocument.createElement('div');
    el.id = 'page-overlay';
    el.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:3';
    host.append(el);
  }
  return el;
}

/** `#page-overlay` (§1.7): a div inside the editor's parent (#editor, made position relative), absolutely placed at the .ProseMirror
 * origin in layout px, pointer-events none (children opt in); created on first use and re-placed on every call. */
export function overlayOf(view) {
  const host = view.dom.parentElement;
  if (!host) return null;
  if (!host.pgPlaced) {
    host.pgPlaced = true; // a style read: once per host, since each one pays for whatever the document has pending
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  }
  const el = overlayElement(view);
  if (!el) return null;
  let x = 0;
  let y = 0;
  // host is positioned, so the offsetParent chain from .ProseMirror ends at it.
  for (let n = view.dom; n && n !== host; n = n.offsetParent) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  return el;
}

// Harness cases reach these through window.__word (scaffold-core) once it exists; this hook needs no app module.
globalThis.__wordPages = { geometryOf, pageAtPos, registerPageLayer, layers, registerLayoutPass, passes, pageClone, pagesReady, overlayOf };
