// Linked text boxes (Create Link, a .docx's wps:linkedTxbx; briefs/textbox-link-autofit.md): Word flows one story through a chain of
// boxes. The first box holds the story and each box after it holds its own text, empty unless typed into, as export writes them
// (export.mjs storiesOf). CSS cannot flow text from one box into another, so after each change this draws what a box cannot fit into
// the next box's flow layer (the node view's [data-textbox-flow]), laid out at that box's width: a copy of the story from the first
// line that did not fit. Every box in a chain clips its text, and a press on the copy puts the caret at that point of the story. The
// caret and the selection in story text a box clips are drawn over the copy that shows it (markSelection), as Word moves them on.
import { TextSelection } from '@tiptap/pm/state';
import { chainsOf } from './boxes.mjs';

const copies = new WeakMap(); // flow layer → {to: copy node → story node, cut: copy text → characters cut from its start}
const chains = new WeakMap(); // box in a chain → the chain, as last drawn

/** The content box's bottom of text box element `box` in client px. */
function bottomOf(box) {
  const r = box.getBoundingClientRect();
  const cs = getComputedStyle(box);
  const s = r.height / box.offsetHeight || 1;
  return r.bottom - (parseFloat(cs.borderBottomWidth) + parseFloat(cs.paddingBottom)) * s;
}

/** Where the text in `root` stops fitting above `limit` (client px): the first block below it, or the first character of the first
 * line that passes it → {node, offset, top (that line's top, client px)}, or null when it all fits. A block with no text on that
 * line (a picture) moves on whole. */
function cutOf(root, limit) {
  const range = document.createRange();
  const past = (r) => r.bottom > limit + 0.5;
  for (const [i, block] of [...root.childNodes].entries()) {
    const r = block.nodeType === 1 ? block.getBoundingClientRect() : (range.selectNodeContents(block), range.getBoundingClientRect());
    if (!past(r)) continue;
    if (r.top >= limit - 0.5) return { node: root, offset: i, top: r.top };
    const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let t; (t = walk.nextNode());) {
      range.selectNodeContents(t);
      if (!past(range.getBoundingClientRect())) continue;
      let [lo, hi] = [0, t.length]; // the first character whose line passes the limit
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        range.setStart(t, mid);
        range.setEnd(t, mid + 1);
        if (past(range.getBoundingClientRect())) hi = mid;
        else lo = mid + 1;
      }
      range.setStart(t, lo);
      range.setEnd(t, Math.min(lo + 1, t.length));
      return { node: t, offset: lo, top: range.getBoundingClientRect().top };
    }
    return { node: root, offset: i, top: r.top };
  }
  return null;
}

/** Hides what `el` draws from client y `top` down (the lines the next box shows, or that no box has room for); null shows it all. */
function clipAt(el, top) {
  if (top == null) return el.style.removeProperty('clip-path');
  const r = el.getBoundingClientRect();
  el.style.clipPath = `inset(0 0 ${Math.max(0, (r.bottom - top) / (r.height / el.offsetHeight || 1))}px 0)`;
}

/** Appends to `into` a copy of `root` from point `from` on, recording in `m` the story node each copied node stands for (through
 * the copy `root` itself is, `src`) and how many characters each copied text lost from its start. */
function copyFrom(into, root, from, m, src = null) {
  const copy = root.cloneNode(true);
  const a = document.createTreeWalker(root);
  const b = document.createTreeWalker(copy);
  let end = copy;
  for (let x = a.currentNode, y = b.currentNode; x && y; x = a.nextNode(), y = b.nextNode()) {
    m.to.set(y, src?.to.get(x) ?? x);
    if (src?.cut.has(x)) m.cut.set(y, src.cut.get(x));
    if (x === from.node) end = y;
  }
  const r = document.createRange();
  r.setStart(copy, 0);
  r.setEnd(end, from.offset);
  r.deleteContents(); // a text cut in two keeps its node, shortened from the start
  if (end.nodeType === Node.TEXT_NODE) m.cut.set(end, (m.cut.get(end) ?? 0) + from.offset);
  into.append(...copy.childNodes);
}

const textOf = (box) => box.querySelector(':scope > [data-textbox-text]');
const flowOf = (box) => box.querySelector(':scope > [data-textbox-flow]');
const empty = (el) => !el.textContent && !el.querySelector('img, svg, math, canvas, [data-canvas]');

/** Draws chain `boxes` (elements, the first holding the story). */
function flowChain(chain) {
  const [head, ...rest] = chain;
  for (const b of chain) chains.set(b, chain);
  head.setAttribute('data-chain', 'first');
  flowOf(head)?.replaceChildren();
  // Vertical text runs in columns, which this cuts by height: such a story stays in its first box (ponytail: cut by width there).
  const level = head.dataset.dir === 'lrTb';
  clipAt(textOf(head), null);
  const cut = level && cutOf(textOf(head), bottomOf(head));
  clipAt(textOf(head), cut ? cut.top : null);
  // What the next box shows: the first box's text from its cut, then each later box's own text, in the story's order.
  const own = rest.map(textOf).filter((t) => t && !empty(t)).map((t) => ({ root: t, from: { node: t, offset: 0 } }));
  let parts = level ? [...(cut ? [{ root: textOf(head), from: cut }] : []), ...own] : [];
  for (const box of rest) {
    box.setAttribute('data-chain', 'next');
    const flow = flowOf(box);
    if (!flow) continue;
    const m = { to: new WeakMap(), cut: new WeakMap() };
    flow.replaceChildren();
    clipAt(flow, null);
    for (const p of parts) copyFrom(flow, p.root, p.from, m, p.src);
    copies.set(flow, m);
    const more = level && cutOf(flow, bottomOf(box));
    clipAt(flow, more ? more.top : null);
    parts = more ? [{ root: flow, from: more, src: m }] : [];
  }
}

/** The point in flow layer `flow` (copy map `m`) standing for story point (`node`, `offset`), or null when the copy does not show it:
 * a text point at or past the copy's cut, an element point past the children cut from its start. */
function copyPoint(flow, m, node, offset) {
  const walk = document.createTreeWalker(flow);
  for (let y = walk.nextNode(); y; y = walk.nextNode()) {
    if (m.to.get(y) !== node) continue;
    const text = y.nodeType === Node.TEXT_NODE;
    const o = offset - (text ? m.cut.get(y) ?? 0 : node.childNodes.length - y.childNodes.length);
    return o >= 0 && o <= (text ? y.length : y.childNodes.length) ? { node: y, offset: o } : null;
  }
  return null;
}

/** The client rect of the caret at point (`node`, `offset`): one line tall. An element point (a paragraph's end) takes the end of the
 * text before it, else the start of the text after it, else the line its neighbour (an empty paragraph's break) draws. */
function caretRect(node, offset) {
  const r = document.createRange();
  if (node.nodeType !== Node.TEXT_NODE) {
    const textIn = (n, last) => {
      if (n.nodeType === Node.TEXT_NODE) return n;
      const walk = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
      let t = null;
      for (let x = walk.nextNode(); x; x = walk.nextNode()) {
        t = x;
        if (!last) break;
      }
      return t;
    };
    const [before, after] = [node.childNodes[offset - 1], node.childNodes[offset]];
    const t = before ? textIn(before, true) : null;
    const u = !t && after ? textIn(after, false) : null;
    if (!t && !u) return (before ?? after ?? node).getBoundingClientRect?.() ?? null;
    [node, offset] = t ? [t, t.length] : [u, 0];
  }
  r.setStart(node, offset);
  return r.getClientRects()[0] ?? null;
}

/** Draws client rects `rects` into flow layer `flow` as marks of class `kind` ('caret', 'sel'). */
function mark(flow, rects, kind) {
  const f = flow.getBoundingClientRect();
  const s = f.width / flow.offsetWidth || 1;
  for (const r of rects) {
    const el = document.createElement('div');
    el.setAttribute('data-flow-mark', kind);
    Object.assign(el.style, { left: `${(r.left - f.left) / s}px`, top: `${(r.top - f.top) / s}px`, width: `${r.width / s}px`, height: `${r.height / s}px` });
    flow.append(el);
  }
}

/** Marks the selection in `view` where a later linked box shows it: the story's own text there is clipped out of sight, so the caret
 * goes over the copy in the last box whose copy holds its point (a line's end and the next line's start are one point: the later
 * box wins), and selected text is shaded in every box that shows part of it. */
export function markSelection(view) {
  if (!chained.has(view)) return; // most documents have no linked boxes: no scans on every selection change
  for (const old of view.dom.querySelectorAll('[data-flow-mark]')) old.remove();
  const flows = [...view.dom.querySelectorAll('[data-chain="next"] > [data-textbox-flow]')].filter((f) => copies.has(f));
  const sel = view.state.selection;
  if (!flows.length || sel.node) return;
  let a;
  let b;
  try { [a, b] = [view.domAtPos(sel.from), view.domAtPos(sel.to)]; } catch { return; }
  if (sel.empty) {
    let at = null;
    for (const f of flows) at = ((p) => p && { f, p })(copyPoint(f, copies.get(f), a.node, a.offset)) ?? at;
    if (!at) return;
    const box = caretRect(at.p.node, at.p.offset);
    if (box) mark(at.f, [{ left: box.left, top: box.top, width: 0, height: box.height }], 'caret');
    return;
  }
  const story = document.createRange();
  story.setStart(a.node, a.offset);
  story.setEnd(b.node, b.offset);
  const r = document.createRange();
  for (const f of flows) {
    const m = copies.get(f);
    const walk = document.createTreeWalker(f, NodeFilter.SHOW_TEXT);
    for (let y = walk.nextNode(); y; y = walk.nextNode()) {
      const x = m.to.get(y);
      if (!x) continue;
      // The story characters of x the selection covers, then the part of them this copy holds (it starts `cut` characters in).
      const from = story.startContainer === x ? story.startOffset : 0;
      const to = story.endContainer === x ? story.endOffset : x.length;
      if (story.comparePoint(x, from) !== 0 || story.comparePoint(x, to) !== 0) continue;
      const cut = m.cut.get(y) ?? 0;
      const [lo, hi] = [Math.max(from, cut), Math.min(to, cut + y.length)];
      if (lo >= hi) continue;
      r.setStart(y, lo - cut);
      r.setEnd(y, hi - cut);
      mark(f, [...r.getClientRects()], 'sel');
    }
  }
}

// The views flowBoxes last drew a chain in (markSelection skips the rest).
const chained = new WeakSet();

/** Draws every chain of linked text boxes in ProseMirror `view` and clears boxes that left one. */
export function flowBoxes(view) {
  if (view.isDestroyed || !view.dom.isConnected || !view.dom.querySelector('[data-textbox][data-link], [data-chain]')) return void chained.delete(view);
  const boxes = [...view.dom.querySelectorAll('[data-textbox]')];
  const seen = new Set();
  for (const chain of chainsOf(boxes, (b) => b.dataset.id, (b) => b.dataset.link)) {
    chain.forEach((b) => seen.add(b));
    flowChain(chain);
  }
  if (seen.size) chained.add(view);
  else chained.delete(view);
  for (const b of boxes) {
    if (seen.has(b) || !b.hasAttribute('data-chain')) continue;
    b.removeAttribute('data-chain');
    flowOf(b)?.replaceChildren();
    clipAt(textOf(b), null);
  }
  markSelection(view);
}

const pending = new WeakSet();
/** Draws the chains in `view` before the next frame (once however often it is asked). */
export function scheduleFlow(view) {
  if (pending.has(view)) return;
  pending.add(view);
  requestAnimationFrame(() => {
    pending.delete(view);
    flowBoxes(view);
  });
}

/** A press on later box `box` of a chain in `view` past the story it shows: the caret goes to the end of the story, the end of the
 * last box holding text of its own (the first box holds the story), as Word puts it. → whether it did. */
export function pressEnd(view, box) {
  const chain = chains.get(box);
  const last = chain && [...chain].reverse().find((b) => b === chain[0] || (textOf(b) && !empty(textOf(b))));
  const text = last && textOf(last);
  if (!text) return false;
  let pos;
  try { pos = view.posAtDOM(text, text.childNodes.length); } catch { return false; }
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos), -1)));
  view.focus();
  return true;
}

/** A press at client point `e` on box flow layer `flow` in `view`: the caret goes to that point of the story. → whether it did. */
export function pressFlow(view, flow, e) {
  const m = copies.get(flow);
  const at = document.caretPositionFromPoint?.(e.clientX, e.clientY);
  const node = at && m?.to.get(at.offsetNode);
  if (!node || !view.dom.contains(node)) return false;
  const text = at.offsetNode.nodeType === Node.TEXT_NODE;
  let pos;
  try { pos = view.posAtDOM(node, text ? at.offset + (m.cut.get(at.offsetNode) ?? 0) : 0); } catch { return false; }
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
  view.focus();
  return true;
}
