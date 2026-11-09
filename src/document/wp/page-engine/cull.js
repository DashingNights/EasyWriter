// Culling (briefs/perf-settle.md Goal 3): a top-level block far from the view takes content-visibility: auto at the size it was
// laid out at, so the browser's style and layout passes skip its text while it is off screen. A page end that moves then restyles
// and lays out the blocks near the view only: on the Word fixture one page end widget's move cost about 470 ms with every block
// drawn, 150 ms with the far blocks culled, tables included (400 ms with paragraphs only).
//
// perf-core's constraints, and how they hold. content-visibility contains layout and paint, so:
// - a block a page end crosses would move below that page end whole: the blocks from each page end widget to the block its cut
//   falls in are never culled (`keep`), and one culled where a new page end falls is drawn again before that page end is;
// - a float or an absolutely placed object could not leave its block, a margin of a block's first or last child that collapses
//   through it would stay inside, and the margins around a block of no height (a page break) collapse through it: such blocks,
//   flowing columns and blocks that are not block-level are never culled;
// - a block is culled only after the browser laid it out, at its size as drawn (contain-intrinsic-size in px), so the text keeps
//   its place and the page ends equal a whole layout's. The size is rounded up by less than a layout unit: the browser truncates a
//   length to 1/64 px under zoom, and contain-intrinsic-size's 'auto' (the size remembered) drifted by that much;
// - whatever may change a culled block's size draws it again first: a change inside it (a MutationObserver), another node at its
//   place, a picture loading in it, and (clear) a change of zoom, width, fonts, styles or display options.
// 'auto' rather than 'hidden': a culled block scrolled into view before the engine draws it renders itself, and its text stays in
// find in page and the accessibility tree. Its labels outside the box (list numbers) are clipped by paint containment, which is why
// blocks near the view are never culled. Blocks never laid out have no size here: the layout predictor's heights are for those,
// which layout-cache wires in (briefs/layout-cache.md).
// Off by default for now (pagination.js CULL says why and what turns it on). Plain web APIs; imports no app module.

const CV = 'content-visibility';
const CIS = 'contain-intrinsic-size';
/** Objects that leave their block's box (float-layout's wraps, a Text Wrapping break) or fit themselves each round. */
const PINNED = '[data-fl], [data-fl-cont], [data-columns]';
/** Less than a layout unit (1/64 px) at any device scale up to 4: the culled size truncates to the drawn one, never below it. */
const UP = 1 / 300;

const ranges = new WeakMap(); // document → one Range reused (each live Range costs every DOM change until it is collected)

/** The client rects of the lines of text in `el` (contentRects, screen px). A culled block answers from the copy taken when it
 * was culled, moved with its box: read inside it, the browser lays the block out on its own, a few ms each, and the page engine's
 * page ends and the line numbers read hundreds of them. */
export function textRects(el) {
  const c = el.pgRects;
  if (c && el.pgCull && c.node === el.pgCull) {
    const b = el.getBoundingClientRect();
    return c.rel.map((r) => ({ top: b.top + r.top, bottom: b.top + r.bottom, left: b.left + r.left, right: b.left + r.right, width: r.width, height: r.height }));
  }
  const d = el.ownerDocument;
  let range = ranges.get(d);
  if (!range) ranges.set(d, (range = d.createRange()));
  const out = contentRects(el, range);
  range.collapse(true);
  return out;
}

/** The client rects of the lines inside block `el`. range.getClientRects() over its contents gives the border box of each child
 * element: a content control's body box grouped every line of a table of contents into one line taller than the page, and a
 * heading's collapse triangle (absolutely placed at the heading's top) made a line on the page before when the heading's text
 * started the next. So a block container inside gives its own lines, recursively; any other block-level box (a table, an object,
 * a formatting context) moves whole and stays one rect; a box out of the flow gives none; inline content gives its rects.
 * A phonetic guide's reading (ruby rt) sits above its base in the base's line, so its rects reach down to the base: read alone
 * they made a line of their own, and a page end planned between the reading and its base moved the whole line below it (the
 * Word fixture's 1,638 pt reading put 2,221 px of text below its sheet). → [DOMRect]. */
function contentRects(el, range, out = []) {
  let first = null;
  let last = null;
  const ruby = !!el.querySelector('rt');
  const flush = () => {
    if (!first) return;
    range.setStartBefore(first);
    range.setEndAfter(last);
    const rects = [...range.getClientRects()];
    out.push(...(ruby ? withReadings(rects, first, last) : rects));
    first = last = null;
  };
  for (const c of el.childNodes) {
    const cs = c.nodeType === 1 ? getComputedStyle(c) : null;
    if (cs && (cs.position === 'absolute' || cs.position === 'fixed')) {
      flush();
      continue;
    }
    const d = cs ? cs.display : 'inline';
    if (d === 'block' || d === 'list-item') {
      flush();
      contentRects(c, range, out);
    } else if (/^(flow-root|table|flex|grid|block |list-item )/.test(d)) {
      flush();
      out.push(c.getBoundingClientRect());
    } else {
      first ??= c;
      last = c;
    }
  }
  flush();
  return out;
}

/** `rects` of the inline run from `first` to `last` (siblings) with each rect of a ruby reading (rt) stretched down to its base's
 * bottom, so the reading and its base group as one line. */
function withReadings(rects, first, last) {
  const reads = [];
  for (let n = first; n; n = n === last ? null : n.nextSibling) {
    if (n.nodeType !== 1) continue;
    for (const rb of n.matches('ruby') ? [n] : n.querySelectorAll('ruby')) {
      const base = rb.getBoundingClientRect();
      for (const rt of rb.querySelectorAll('rt')) reads.push([rt.getBoundingClientRect(), base.bottom]);
    }
  }
  if (!reads.length) return rects;
  // A reading's text crosses the middle of its box: the box has no height where the reading's line height is 0 (font/style.css).
  const over = (r, b) => r.top <= (b.top + b.bottom) / 2 + 0.5 && r.bottom >= (b.top + b.bottom) / 2 - 0.5 && r.left >= b.left - 0.5
    && r.right <= b.right + 0.5;
  return rects.map((r) => {
    const hit = reads.find(([b]) => over(r, b));
    return hit && hit[1] > r.bottom ? { top: r.top, bottom: hit[1], left: r.left, right: r.right, width: r.width, height: hit[1] - r.top } : r;
  });
}

/** Whether `el`'s first or last in-flow child has a block margin, which collapses through `el` while it is drawn. */
function edgeMargins(el) {
  const edge = (first) => {
    let c = el;
    do c = first ? c.firstElementChild : c.lastElementChild;
    while (c && getComputedStyle(c).display === 'contents');
    return c;
  };
  const a = edge(true);
  const b = edge(false);
  return (!!a && parseFloat(getComputedStyle(a).marginTop) !== 0) || (!!b && parseFloat(getComputedStyle(b).marginBottom) !== 0);
}

export class Culler {
  constructor(view) {
    this.view = view;
    this.culled = new Set();
    this.z = 0; // the zoom the culled sizes were read at
    this.mo = null; // watching the editor's DOM only while a block is culled (each change to it queues a record)
    this.onLoad = (e) => this.touched([{ target: e.target }]);
  }

  /** Watches the editor for changes inside culled blocks (`on`) or stops. */
  watch(on) {
    const { dom } = this.view;
    if (on && !this.mo) {
      this.mo = new MutationObserver((rs) => this.touched(rs));
      this.mo.observe(dom, { subtree: true, childList: true, characterData: true, attributes: true });
      dom.addEventListener('load', this.onLoad, true); // a picture's size arrives with it
    } else if (!on && this.mo) {
      this.mo.disconnect();
      this.mo = null;
      dom.removeEventListener('load', this.onLoad, true);
    }
  }

  destroy() {
    this.watch(false);
  }

  /** Writes `fn` into the editor's DOM: ProseMirror must not read it as an edit, nor this culler as a change. */
  write(fn) {
    const { domObserver } = this.view;
    if (this.mo) this.touched(this.mo.takeRecords());
    domObserver?.stop?.();
    try {
      fn();
    } finally {
      domObserver?.start?.();
      this.mo?.takeRecords();
      this.watch(this.culled.size > 0);
    }
  }

  /** The top-level blocks that changed inside (mutation records `rs`) and are culled draw again. */
  touched(rs) {
    if (!this.culled.size) return;
    const { dom } = this.view;
    const out = [];
    for (const r of rs) {
      let el = r.target;
      if (el === dom) continue;
      while (el && el.parentNode !== dom) el = el.parentNode;
      if (el && this.culled.has(el)) out.push(el);
    }
    if (out.length) this.write(() => out.forEach((el) => this.show(el)));
  }

  show(el) {
    el.style.removeProperty(CV);
    el.style.removeProperty(CIS);
    el.pgCull = null;
    this.culled.delete(el);
  }

  /** Every culled block draws again (its size may have changed with no change inside it). */
  clear() {
    if (this.culled.size) this.write(() => [...this.culled].forEach((el) => this.show(el)));
  }

  /** Before the blocks `els` (the editor's top-level elements, in order) are read for `doc`: a culled one whose place now holds
   * another node, and every one when the zoom moved, draws again. Writes only. */
  check(els, doc, z) {
    if (!this.culled.size) return;
    if (z !== this.z) return this.clear();
    const stale = els.filter((el, i) => el.pgCull && el.pgCull !== doc.child(i));
    if (stale.length) this.write(() => stale.forEach((el) => this.show(el)));
  }

  /** Draws the culled blocks among `kids` ({el} per top-level block) for which `want(i)` holds. Writes only. */
  release(kids, want) {
    if (!this.culled.size) return;
    const out = [];
    kids.forEach((k, i) => {
      if (k.el.pgCull && want(i)) out.push(k.el);
    });
    if (out.length) this.write(() => out.forEach((el) => this.show(el)));
  }

  /** Culls the blocks of `kids` ({el, node, top, bottom} in layout px, from the last read) outside `band` ({top, bottom}) but for
   * those in `keep` (top-level indices), at most `max` per call, reading their size and their text's rects first (textRects).
   * Call it while the layout is clean (a frame's start). */
  cull(kids, keep, band, z, max = Infinity) {
    if (this.culled.size && z !== this.z) this.clear();
    const pick = [];
    kids.forEach((k, i) => {
      const { el, node } = k;
      if (el.pgCull || keep.has(i) || (k.bottom >= band.top && k.top <= band.bottom) || el.pmViewDesc?.node !== node || !el.isConnected) return;
      if (pick.length < max && this.ok(el, node)) pick.push(k);
    });
    if (!pick.length) return;
    const sizes = pick.map((k) => k.el.getBoundingClientRect());
    pick.forEach((k, i) => {
      if (!k.node.isTextblock) return;
      const b = sizes[i];
      k.el.pgRects = { node: k.node, rel: textRects(k.el).map((r) => ({ top: r.top - b.top, bottom: r.bottom - b.top, left: r.left - b.left, right: r.right - b.left,
        width: r.width, height: r.height })) };
    });
    this.z = z;
    this.write(() => pick.forEach((k, i) => {
      const r = sizes[i];
      if (!r.height) return;
      k.el.style.setProperty(CIS, `${(r.width + UP) / z}px ${(r.height + UP) / z}px`);
      k.el.style.setProperty(CV, 'auto');
      k.el.pgCull = k.node;
      this.culled.add(k.el);
    }));
  }

  /** Whether block `el` (holding `node`) can be culled without moving anything (the constraints above), kept per node. */
  ok(el, node) {
    if (el.pgCullOk?.node === node) return el.pgCullOk.ok;
    const d = getComputedStyle(el).display;
    const ok = /^(block|flow-root|flex|grid|table|list-item)$/.test(d) && !el.matches(PINNED) && !el.querySelector(PINNED)
      && (d !== 'block' && d !== 'list-item' || node.isTextblock || !edgeMargins(el));
    el.pgCullOk = { node, ok };
    return ok;
  }
}
