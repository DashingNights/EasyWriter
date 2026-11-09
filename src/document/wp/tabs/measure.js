// Tab boxes measured in the DOM (docs/plans/word/plan.md §1.9 Tabs): each tab of a paragraph is an inline box (span[data-tab], or
// a ptab's span[data-ptab]) whose width layout.mjs computes from the pen the box sits at and the width of the text after it. One
// width moves every later pen, so the boxes of all paragraphs are read together, computed, written, and read again until no
// width changes: one forced layout per round, two rounds when typing. Shared by the editor's pass (plugin.js) and static drawings
// (static.js). Rects are client px under #page-wrap's CSS zoom, so they are divided by `zoom`; computed styles are layout px.
import { rangeIn } from '../../geometry.js';
import { decimalAt, numStop, placePtab, placeTab } from './layout.mjs';

const PT = 0.75; // points per CSS px
const px = (v) => parseFloat(v) || 0;
const round = (n) => Math.round(n * 100) / 100;
// Box widths round down, so text that ends on the right margin is not pushed onto the next line by a hundredth of a px.
const floor = (n) => Math.floor(n * 100) / 100;
const sameLine = (a, b) => a.top < b.bottom - 1 && a.bottom > b.top + 1;

let decimal = null;
/** The decimal symbol of the app's locale. Word reads the Windows region's; Electron's Intl reports the app locale, which is the
 * closest the renderer has (recorded in the tabs report). */
export function decimalSymbol() {
  if (decimal == null) {
    try {
      decimal = new Intl.NumberFormat().formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';
    } catch {
      decimal = '.';
    }
  }
  return decimal;
}

let canvas = null;
/** The width in px of `text` in CSS font `font`. */
function textWidth(text, font) {
  canvas ??= document.createElement('canvas').getContext('2d');
  canvas.font = font;
  return canvas.measureText(text).width;
}

/** The canvas font of computed style `cs`. Built from its parts: the `font` shorthand reads '' when a longhand such as ligatures
 * has no shorthand form, as the Document's run defaults set. */
const fontOf = (cs) => `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

/** The text nodes of `el` in order with the tab box each follows (-1 before the first): the text after each tab, up to the next tab
 * or the line end (a line break ends it, so the next line's text does not align this tab). */
function segmentsOf(el, spans) {
  const segs = spans.map(() => []);
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let first = null;
  let closed = false;
  for (let n = walk.nextNode(), k = -1; n; n = walk.nextNode()) {
    if (n.nodeType === 3 && !n.data.length) continue;
    while (k + 1 < spans.length && (spans[k + 1].contains(n) || spans[k + 1].compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      k++;
      closed = false;
    }
    if (n.nodeType === 1) {
      if (n.tagName === 'BR' && !n.hasAttribute('data-tab-break')) closed = true;
      continue;
    }
    first ??= n;
    if (k >= 0 && !closed && !spans[k].contains(n)) segs[k].push(n);
  }
  return { segs, first };
}

/** The line break the tabs pass put before box `span` (a tab that wrapped to the next line), or null: the element right before it in
 * document order, inside `el`. */
function breakBefore(span, el) {
  let n = span;
  while (n !== el && !n.previousSibling) n = n.parentNode;
  if (n === el) return null;
  let p = n.previousSibling;
  while (p?.nodeType === 1 && p.tagName !== 'BR' && p.lastChild) p = p.lastChild;
  return p?.nodeType === 1 && p.hasAttribute('data-tab-break') ? p : null;
}

/** The client rect of character `i` of text node `n`. */
function charRect(n, i) {
  const r = rangeIn(n.ownerDocument);
  r.setStart(n, i);
  r.setEnd(n, i + 1);
  const rs = r.getClientRects();
  return rs[rs.length - 1] ?? r.getBoundingClientRect();
}

/** Reads paragraph job `j`'s geometry (layout.mjs coordinates, in pt): its column edge, indents, right indent and column width.
 * A job is {el, spans, stops, def, num: {label, levelTab} | null, width?: pt}. */
function read(j, zoom) {
  const { el } = j;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const ext = px(el.style.getPropertyValue('--w-tab-ext'));
  const ml = px(cs.marginLeft);
  const mr = px(cs.marginRight) + (el.hasAttribute('data-tab-ext') ? ext : 0); // the right indent before our own extension
  const inL = px(cs.borderLeftWidth) + px(cs.paddingLeft);
  j.colLeft = r.left - ml * zoom;
  j.elLeft = r.left;
  j.width = j.width ?? (r.width / zoom + ml + px(cs.marginRight)) * PT;
  j.ml = ml + px(cs.borderLeftWidth);
  j.mr = mr;
  j.left = (ml + inL) * PT;
  j.right = j.width - (mr + px(cs.borderRightWidth) + px(cs.paddingRight)) * PT;
  j.firstLine = px(cs.textIndent) * PT;
  j.ext = el.hasAttribute('data-tab-ext') ? ext : 0;
  j.dec = el.hasAttribute('data-tab-dec') ? px(el.style.getPropertyValue('--w-dec-x')) : 0;
  Object.assign(j, segmentsOf(el, j.spans));
  j.numTab = null;
  if (j.num) {
    // The tab after the list number (G3): the label (lists' ::before) from the first line's start to the stop it reaches.
    const start = j.left + j.firstLine;
    const end = start + textWidth(j.num.label, fontOf(getComputedStyle(el, '::before'))) * PT;
    const stop = numStop(end, { levelTab: j.num.levelTab, left: j.left, stops: j.stops, def: j.def });
    const w = (stop - start) / PT;
    if (Math.abs(w - -j.firstLine / PT) > 0.5) j.numTab = round(w);
  }
}

/** The shift in px that puts the decimal point of cell paragraph job `j` (no tab, a decimal stop at `j.cellDec` pt) on its stop, as
 * Word aligns numbers in a table cell (briefs/tabs.md): the hook decimalAt finds, or the end of the text without one. The text never
 * starts left of the left indent. */
function cellShift(j, zoom) {
  if (!j.first) return 0;
  const walk = j.el.ownerDocument.createTreeWalker(j.el, NodeFilter.SHOW_TEXT);
  const state = { num: false };
  let end = null;
  let last = null;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.data.length) continue;
    last = n;
    const at = decimalAt(n.data, decimalSymbol(), state);
    if (at != null) {
      end = charRect(n, at).left;
      break;
    }
  }
  end ??= charRect(last, last.data.length - 1).right;
  const start = charRect(j.first, 0).left;
  // The column edge from the paragraph's box now: the shift drawn moves both.
  const pen = (start - (j.el.getBoundingClientRect().left - (j.elLeft - j.colLeft))) / zoom * PT;
  const x = Math.max(j.left - pen, j.cellDec - pen - (end - start) / zoom * PT);
  return round(x / PT);
}

/** One round over job `j`: each box's width from where it sits now. Pushes [span, px] writes for boxes that must change and returns
 * the paragraph's results. */
function compute(j, zoom, writes) {
  if (j.cellDec != null) {
    const x = cellShift(j, zoom);
    if (Math.abs(x - (j.dec ?? 0)) > 0.05) writes.push([j.el, x, 'dec']);
    j.dec = x;
    j.items = [];
    j.ext = 0;
    return;
  }
  const firstBottom = j.first ? charRect(j.first, 0).bottom : Infinity;
  let delta = 0;
  let deltaTop = null;
  let reach = -Infinity; // how far a stop at or past the right indent takes the line; none leaves the paragraph alone
  j.items = j.spans.map((span, i) => {
    // A box that wrapped sits after its line break: its pen is where the break sits, at the end of the line before, which the box's
    // own width does not move, so the wrap decision is the same every round.
    const brk = breakBefore(span, j.el);
    const wrapped = !!brk && !brk.hasAttribute('data-off');
    const r = (wrapped ? brk : span).getBoundingClientRect();
    const cur = px(span.style.width);
    // Earlier boxes on this line that change this round move this one by as much.
    const pen = ((r.left - j.colLeft) / zoom + (deltaTop != null && Math.abs(r.top - deltaTop) < 1 ? delta : 0)) * PT;
    const first = r.top < firstBottom - 1;
    const c = { stops: j.stops, def: j.def, left: j.left, right: j.right, width: j.width, lineStart: first ? j.left + j.firstLine : j.left, first };
    const follow = followOf(j, i, r, zoom);
    const ptab = span.hasAttribute('data-ptab')
      ? { align: span.dataset.align ?? 'center', relativeTo: span.dataset.relativeTo ?? 'margin', leader: span.dataset.leader ?? 'none' } : null;
    const res = ptab ? placePtab(pen, ptab, c, follow) : placeTab(pen, c, follow);
    const w = floor(res.w / PT);
    if (!!res.wrap !== wrapped) writes.push([span, !!res.wrap, 'wrap', brk]);
    if (Math.abs(w - cur) > 0.05) {
      writes.push([span, w]);
      if (!res.wrap) {
        delta += w - cur;
        deltaTop = r.top;
      }
    }
    // A stop past the right indent lets this line run into the margin (Word honours custom stops there). A stop on the right indent
    // gets 1 px of room too, so text that ends exactly there is not wrapped by subpixel rounding.
    if (!res.wrap && res.stop > j.right - 0.1) {
      const a = ptab ? ptab.align : res.align;
      const tail = a === 'right' ? 0 : a === 'center' ? follow.w / 2 : a === 'decimal' ? follow.w - (follow.dec ?? follow.w) : follow.w;
      // Text after a left stop past the right indent runs up to the column's right edge, no further (Word wraps it there).
      reach = Math.max(reach, Math.min(res.stop + (Number.isFinite(tail) ? tail : 0), j.width));
    }
    const item = { w, align: ptab ? ptab.align : res.align, leader: res.leader ?? 'none', x: round((res.wrap ? j.left : pen) / PT) };
    if (res.wrap) item.wrap = true;
    return item;
  });
  const ext = reach > j.right - 0.1 ? Math.ceil((reach - j.right) / PT) + 1 : 0;
  if (ext !== j.ext) writes.push([j.el, ext, 'ext', j.mr]);
  j.ext = ext;
}

/** The summed width in px of text nodes `nodes`, the last one up to offset `end`, wherever their lines fall. */
function textRun(nodes, end) {
  let w = 0;
  const r = nodes[0] && rangeIn(nodes[0].ownerDocument);
  nodes.forEach((n, k) => {
    r.setStart(n, 0);
    r.setEnd(n, k === nodes.length - 1 && end != null ? end : n.data.length);
    for (const x of r.getClientRects()) w += x.width;
  });
  return w;
}

/** The text after box `i` up to the next box or the paragraph end: {w, dec} in pt. Read on the box's line; when the text sits on
 * another line (the box itself can push it there) its own width, so a right box that just fills the line does not flip back to
 * zero. ponytail: the fallback counts text only, not inline pictures. Lazy, so left stops never measure. */
function followOf(j, i, r, zoom) {
  const seg = j.segs[i];
  const next = j.spans[i + 1];
  let w;
  let dec;
  return {
    get w() {
      if (w === undefined) {
        let end = null;
        if (next) {
          const nr = next.getBoundingClientRect();
          end = sameLine(nr, r) ? nr.left : null;
        } else if (seg.length) {
          const last = seg[seg.length - 1];
          const lr = charRect(last, last.data.length - 1);
          end = sameLine(lr, r) ? lr.right : null;
        } else end = r.right;
        w = (end == null ? textRun(seg) : Math.max(0, end - r.right)) / zoom * PT;
      }
      return w;
    },
    get dec() {
      if (dec === undefined) {
        dec = null;
        const sym = decimalSymbol();
        const state = { num: false };
        for (const n of seg) {
          const at = decimalAt(n.data, sym, state);
          if (at == null) continue;
          const dr = charRect(n, at);
          dec = (sameLine(dr, r) ? Math.max(0, dr.left - r.right) : textRun(seg.slice(0, seg.indexOf(n) + 1), at)) / zoom * PT;
          break;
        }
      }
      return dec;
    },
  };
}

/** Writes box width `w` (px) to `span`; with kind 'ext' writes paragraph `span`'s extension into the right margin (over its right
 * indent `mr`) instead; with kind 'wrap' puts a line break before the box (`w` true) or takes it away (the break `mr` found before
 * it). A break the editor drew from a decoration is hidden rather than removed, since ProseMirror owns it; the editor's pass removes
 * the breaks added here (data-tab-temp) once its decorations draw their own. */
function write(span, w, kind, mr) {
  if (kind === 'dec') {
    span.toggleAttribute('data-tab-dec', !!w);
    span.style.setProperty('--w-dec-x', `${w}px`);
    return;
  }
  if (kind === 'wrap') {
    if (w && mr) mr.removeAttribute('data-off');
    else if (w) {
      const br = span.ownerDocument.createElement('br');
      br.setAttribute('data-tab-break', '');
      br.setAttribute('data-tab-temp', '');
      span.before(br);
    } else if (mr?.hasAttribute('data-tab-temp')) mr.remove();
    else mr?.setAttribute('data-off', '');
    return;
  }
  if (kind === 'ext') {
    if (w) {
      span.setAttribute('data-tab-ext', '');
      span.style.setProperty('--w-tab-mr', `${mr}px`);
      span.style.setProperty('--w-tab-ext', `${w}px`);
    } else span.removeAttribute('data-tab-ext');
    return;
  }
  span.style.width = `${w}px`;
  span.style.tabSize = `${w}px`;
}

/** Lays out paragraph `jobs` (see read) under CSS zoom `zoom`, writing box widths straight into the DOM as it goes. → per job
 * {items: [{w, align, leader, x, wrap?}] (px), numTab (px or null), ext (px), mr (px), bars: [px from the padding box], left (px)}. */
export function layoutJobs(jobs, zoom, maxRounds = 8) {
  for (const j of jobs) read(j, zoom);
  // The number tab moves the first line's text, so it goes in before the boxes are read.
  for (const j of jobs) {
    if (j.num) {
      if (j.numTab == null) j.el.style.removeProperty('--w-num-tab');
      else j.el.style.setProperty('--w-num-tab', `${j.numTab}px`);
    }
  }
  // ponytail: rounds stop at maxRounds; a layout that keeps flipping (a tab wrapping back and forth) keeps the last widths.
  for (let i = 0; i < maxRounds; i++) {
    const writes = [];
    for (const j of jobs) compute(j, zoom, writes);
    if (!writes.length) break;
    for (const [el, w, kind, mr] of writes) write(el, w, kind, mr);
  }
  return jobs.map((j) => ({
    items: j.items ?? [],
    numTab: j.numTab,
    ext: j.ext,
    ...(j.dec ? { dec: j.dec } : {}),
    mr: round(j.mr),
    bars: (j.stops ?? []).filter((s) => s.align === 'bar').map((s) => round(s.pos / PT - j.ml)),
  }));
}

/** The CSS of a tab box `it` ({w, x}): its width, a tab advance as wide (so the caret after the tab sits at its end) and the leader's
 * origin at the column edge, so dot leaders on different lines line up. */
export const boxStyle = (it) => `width:${it.w}px;tab-size:${it.w}px;--w-tab-x:${-it.x}px`;

/** The CSS custom properties paragraph result `r` sets on its paragraph: the number tab and the extension into the right margin. */
export function paraStyle(r) {
  let s = '';
  if (r.numTab != null) s += `--w-num-tab:${r.numTab}px;`;
  if (r.ext) s += `--w-tab-mr:${r.mr}px;--w-tab-ext:${r.ext}px;`;
  if (r.dec) s += `--w-dec-x:${r.dec}px;`;
  return s;
}

/** The DOM of paragraph result `r`'s bar tabs: vertical lines through the paragraph, placed from its padding box. */
export function barsDom(doc, bars) {
  const el = doc.createElement('span');
  el.setAttribute('data-tab-bars', '');
  el.contentEditable = 'false';
  for (const x of bars) {
    const b = doc.createElement('span');
    b.setAttribute('data-tab-bar', '');
    b.style.left = `${x}px`;
    el.append(b);
  }
  return el;
}
