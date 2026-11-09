// The canvas editor's accessibility copy (docs/plans/engine/plan.md section 1, viewport-design.md section 7, briefs/engine-a11y.md
// and engine-a11y-route.md): the pages are pixels, so NVDA and Narrator read a DOM copy of the visible pages and the caret's page,
// in the role="document" region the viewport's accessibility root (index.js) gives a session. Each laid-out line is an element
// of its own, laid over the painted line in transparent text: with the copy clipped to 1 px Magnifier did not follow the caret
// and Narrator's box sat at the page's corner, laid over the lines both followed (the user's hand check, measure.md). The DOM
// selection is set to the engine's, so a screen reader reads by character, word and line where the caret is. Focus stays with
// the page area: the copy never takes it. Plain web code, no bare imports.
import { blocksOf, rpc, textBlocks } from './blocks.js';

// CSS px a point at 100 %. A line is laid out at 100 % and scaled by the zoom (index.js sets var(--k), CSS px a point), so a
// zoom moves and scales the copy without laying it out again.
const PX = 4 / 3;

const PARTS = { header: 'Header', footer: 'Footer', footnote: 'Footnote', endnote: 'Endnote', comment: 'Comment', textbox: 'Text box' };

/** The signature of source blocks `src` without their line boxes: an unchanged block keeps its DOM, so a screen reader keeps its
 * place, and only moves. */
const sig = (src) => JSON.stringify(src, (k, v) => (k === 'boxes' ? undefined : v));

/** Inline object `o` (blocks.js) at offset `i` → its piece: a field's result as text, a mark with nothing to read hidden, anything
 * else an image named by its alt text. Each is a piece of its own, so the offsets of the text after it hold whatever it holds. */
function objectPiece(o, i) {
  if (o?.text) return { tag: 'span', attrs: { 'data-o': i }, kids: [o.text] };
  if (o?.hidden) return { tag: 'span', attrs: { 'data-o': i, 'aria-hidden': 'true' }, kids: ['￼'] };
  return { tag: 'span', attrs: { 'data-o': i, role: 'img', 'aria-label': o?.alt || 'Picture' }, kids: ['￼'] };
}

/** The children of text block `b`: one [data-line] span for each laid-out line, holding its text cut at inline objects (each
 * piece a [data-o] span holding its first offset, an object as objectPiece makes it), the list marker in the first. */
function textKids(b) {
  const text = b.text ?? '';
  const objects = new Map((b.objects ?? []).map((o) => [o.offset, o]));
  const at = [0, ...(b.lines ?? [])].map((o) => Math.min(o, text.length));
  return at.map((from, li) => {
    const to = li + 1 < at.length ? Math.max(at[li + 1], from) : text.length;
    const kids = li === 0 && b.list?.marker ? [{ tag: 'span', attrs: { 'data-m': '' }, kids: [`${b.list.marker} `] }] : [];
    let s = from;
    const flush = (e) => {
      if (e > s) kids.push({ tag: 'span', attrs: { 'data-o': s }, kids: [text.slice(s, e)] });
      s = e;
    };
    for (let i = from; i < to; i++) {
      if (text[i] !== '￼') continue;
      flush(i);
      kids.push(objectPiece(objects.get(i), i));
      s = i + 1;
    }
    flush(to);
    // An empty line still needs a place for the caret.
    if (!kids.some((k) => k.attrs && 'data-o' in k.attrs)) kids.push({ tag: 'span', attrs: { 'data-o': from }, kids: [''] });
    return { tag: 'span', attrs: { 'data-line': li }, kids };
  });
}

/** Text block `b` → its element: a heading at its level, a list item, or a paragraph. */
function textNode(b) {
  const level = b.level;
  const tag = b.list ? 'li' : level >= 1 && level <= 6 ? `h${level}` : 'p';
  const attrs = { 'data-id': String(b.id) };
  if (!b.list && level > 6) Object.assign(attrs, { role: 'heading', 'aria-level': level });
  return { tag, attrs, kids: textKids(b) };
}

/** Table block `b` → a table of its rows in order, each cell holding its own blocks. The roles are explicit: Chromium takes a
 * small table without headers for a layout table and hides it from screen readers, and a Word table is data. */
function tableNode(b) {
  const rows = [...(b.rows ?? [])].sort((x, y) => x.index - y.index);
  const cell = (c) => ({ tag: 'td', attrs: { role: 'cell' }, kids: copyTree(c.blocks).map((x) => x.node) });
  return {
    tag: 'table', attrs: { 'data-id': String(b.id), role: 'table' }, kids: [{
      tag: 'tbody', kids: rows.map((r) => ({ tag: 'tr', key: `row:${r.index}`, attrs: { role: 'row' }, kids: (r.cells ?? []).map(cell) })),
    }],
  };
}

/** Object block `b` → a text box as a group of its blocks, anything else as an image named by its alt text. */
function objectNode(b) {
  const attrs = { 'data-id': String(b.id) };
  if (b.blocks?.length) return { tag: 'div', attrs: { ...attrs, role: 'group', 'aria-label': b.alt || 'Text box' }, kids: copyTree(b.blocks).map((x) => x.node) };
  return { tag: 'div', attrs: { ...attrs, role: 'img', 'aria-label': b.alt || 'Picture' }, kids: [] };
}

/** Container block `b` (a quote, code block or titled box, blocks.js) → a blockquote, or a group named by its role. */
function containerNode(b) {
  const attrs = { 'data-id': String(b.id) };
  const kids = copyTree(b.blocks).map((x) => x.node);
  if (b.role === 'quote') return { tag: 'blockquote', attrs, kids };
  const label = b.role === 'code' ? (b.language ? `Code, ${b.language}` : 'Code') : (b.titled && b.blocks?.[0]?.text) || 'Box';
  return { tag: 'div', attrs: { ...attrs, role: 'group', 'aria-label': label }, kids };
}

/** Part block `b` (a header, footer, note or text box) → a group named by its kind, holding its blocks. */
const partNode = (b) => ({
  tag: 'div', attrs: { 'data-id': String(b.id), role: 'group', 'aria-label': PARTS[b.part] ?? 'Part' }, kids: copyTree(b.blocks).map((x) => x.node),
});

/** Blocks `blocks` (blocksOf) → [{key, sig, node}]: the copy's top-level elements as plain nodes {tag, attrs, kids}, list
 * paragraphs grouped into nested lists (ol or ul by their numbering) and keyed by their first item. Pure. */
export function copyTree(blocks) {
  const out = [];
  let stack = []; // the open lists, outermost first: {node, ordered}
  let group = null; // the top-level entry of the list being built
  for (const b of blocks ?? []) {
    if (b.kind === 'p' && b.list) {
      const level = Math.max(0, b.list.level ?? 0);
      const ordered = !!b.list.ordered;
      stack.length = Math.min(stack.length, level + 1);
      if (stack.length === level + 1 && stack[level].ordered !== ordered) stack.length = level;
      while (stack.length < level + 1) {
        const list = { node: { tag: ordered ? 'ol' : 'ul', attrs: { style: 'list-style:none' }, kids: [] }, ordered };
        const above = stack.at(-1);
        // The last item of the list above holds a deeper list (the list itself when a level is skipped and it has none yet).
        if (above) (above.node.kids.at(-1) ?? above.node).kids.push(list.node);
        else {
          group = { key: `list:${b.id}`, src: [], node: list.node };
          out.push(group);
        }
        stack.push(list);
      }
      stack.at(-1).node.kids.push(textNode(b));
      group.src.push(b);
      continue;
    }
    stack = [];
    group = null;
    const node = b.kind === 'table'
      ? tableNode(b)
      : b.kind === 'part'
        ? partNode(b)
        : b.kind === 'object'
          ? objectNode(b)
          : b.kind === 'container'
            ? containerNode(b)
            : textNode(b);
    out.push({ key: String(b.id), src: b, node });
  }
  return out.map(({ key, src, node }) => ({ key, sig: sig(src), node }));
}

/** Plain node `n` → a DOM node of document `doc`. */
function toDom(doc, n) {
  if (typeof n === 'string') return doc.createTextNode(n);
  const el = doc.createElement(n.tag);
  for (const [k, v] of Object.entries(n.attrs ?? {})) el.setAttribute(k, String(v));
  for (const k of n.kids ?? []) el.append(toDom(doc, k));
  return el;
}

/** The places in `seq` (old places, -1 for new) of a longest run that rises → a Set. */
function rising(seq) {
  const tails = []; // the place in seq ending the best run of each length
  const prev = [];
  seq.forEach((v, i) => {
    if (v < 0) return;
    let lo = 0;
    for (let hi = tails.length; lo < hi;) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  });
  const out = new Set();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]) out.add(i);
  return out;
}

/** Puts `doms` in `parent` as its children in order, moving as few as it can: an element taken out and put back is laid out
 * again. Those that go are taken out first, the longest run already in order stays, and the rest move (the footer a page set
 * shares, when a page above scrolls away: engine-main-thread-2, where moving the blocks past it took the fixture's page 298 out
 * and back). */
function setKids(parent, doms) {
  const stay = new Set(doms);
  for (const c of [...parent.childNodes]) if (!stay.has(c)) c.remove();
  const was = new Map([...parent.childNodes].map((c, i) => [c, i]));
  const keep = rising(doms.map((d) => was.get(d) ?? -1));
  for (let i = doms.length - 1; i >= 0; i--) if (!keep.has(i)) parent.insertBefore(doms[i], doms[i + 1] ?? null);
}

/** A plain node's key among its siblings: its block id, its row, else its place. */
const keyOf = (n, i) => n?.attrs?.['data-id'] ?? n?.key ?? `#${i}`;

/** DOM node `dom`, built from plain node `a`, made to match plain node `b` → the node that now does (`dom`, or a new one). A laid-out
 * line is the unit: one whose text or pieces changed is built again, so its width is fitted again (place); the paragraphs, tables,
 * rows and cells round the lines stay, and an unchanged line keeps its element, so only what a key changed is built and read. */
function patch(doc, dom, a, b) {
  if (typeof a === 'string' || typeof b === 'string') return a === b ? dom : toDom(doc, b);
  if (a.tag !== b.tag) return toDom(doc, b);
  if (b.attrs && 'data-line' in b.attrs) return JSON.stringify(a) === JSON.stringify(b) ? dom : toDom(doc, b);
  for (const [k, v] of Object.entries(b.attrs ?? {})) if (String(a.attrs?.[k]) !== String(v)) dom.setAttribute(k, String(v));
  for (const k of Object.keys(a.attrs ?? {})) if (!(k in (b.attrs ?? {}))) dom.removeAttribute(k);
  const old = new Map((a.kids ?? []).map((k, i) => [keyOf(k, i), [k, dom.childNodes[i]]]));
  setKids(dom, (b.kids ?? []).map((k, i) => {
    const o = old.get(keyOf(k, i));
    return o ? patch(doc, o[1], o[0], k) : toDom(doc, k);
  }));
  return dom;
}

const PIECES = ':scope > [data-line] > [data-o]';

/** Resolves in the task after the next frame (a timer where there are no frames). */
const afterFrame = () => new Promise((r) => (globalThis.requestAnimationFrame ? requestAnimationFrame(() => setTimeout(r, 0)) : setTimeout(r, 0)));

/** The DOM point at `offset` of the text of block element `el` → [node, offset]: in the piece that starts at or before it, so an
 * offset on a line start lands at the start of the new line. */
export function domPoint(el, offset) {
  const pieces = [...el.querySelectorAll(PIECES)];
  let piece = pieces[0];
  for (const p of pieces) if (Number(p.dataset.o) <= offset) piece = p;
  const node = piece.firstChild ?? piece;
  const len = node.nodeType === 3 ? node.length : 0;
  return [node, Math.min(Math.max(offset - Number(piece.dataset.o), 0), len)];
}

/** The text block elements of `root` in order. */
const textEls = (root) => [...root.querySelectorAll('[data-id]')].filter((e) => e.querySelector(PIECES));

/** Lays line span `span` over box `x` ({surface, x, y, w, h, size} in points): its place counts from the region's surface
 * offsets (var(--s<surface>x), var(--s<surface>y), in points, which index.js sets) times the zoom (var(--k)). */
function placeLine(span, x) {
  const at = (axis, v) => `calc((var(--s${x.surface}${axis}, 0) + ${v}) * var(--k, 1) * 1px)`;
  const s = span.style;
  s.left = at('x', x.x);
  s.top = at('y', x.y);
  s.fontSize = `${(x.size > 0 ? x.size : x.h * 0.8) * PX}px`;
  s.lineHeight = s.height = `${x.h * PX}px`;
}

/** Fills region `el` with the accessibility copy of engine `client` → {pages, setPages, refresh, destroy}. `owner` is the element
 * that holds focus while the page area is being edited (the viewport's root): the DOM selection only follows the engine's
 * while focus is inside it, so a field elsewhere keeps its own. setPages(list) gives the page indexes in view; layout and
 * selection events keep the copy current. `onBuilt(pages)` hears each rebuild, so the region's surface offsets follow. `say(text)`
 * puts text in the viewport's status, outside the copy, where browse mode does not read it as the document's text. */
export function createA11yCopy({ client, el, owner, onBuilt = () => {}, say = () => {} }) {
  const doc = el.ownerDocument;
  let visible = [];
  let shown = []; // the pages the copy holds now
  const kept = new Map(); // key → {sig, node, dom}: each top-level block as built, and the plain node it was built from
  const fitted = new WeakMap(); // line span → the box its width was fitted to
  const placed = new WeakMap(); // line span → the box it was laid over
  let chain = Promise.resolve();
  let queued = null;
  let dead = false;
  const offs = [];
  // Each page's blocks as the engine gave them, until a layout event changes the page: a typed letter asks again for its own
  // page only. Block ids are stable (viewport-design.md section 10), so the pages after an edit that look as they did hold the
  // same blocks.
  const cache = new Map();
  // The last selection event ({anchor, head, caret}): the copy reads the selection and the caret's page from it rather than
  // asking the engine after every key.
  let last = null;
  // Several ranges selected at once (Ctrl+drag, Select All Instances): the DOM selection holds one range only (the active one), so
  // the viewport's status (`say`, index.js) says how many there are, and nothing with one range.
  const announce = (ev) => say(ev?.ranges > 1 ? `${ev.ranges} selections` : '');

  /** Queues a rebuild (`full`) or a selection update; jobs run one at a time and queued ones merge. A job starts after the
   * next frame: a rebuild lays the copy out (3 to 4 ms a key on a table page of the fixture, engine-main-thread), which held up
   * the frame that shows the key's tiles and the next key's handling, and the keys of one frame merge into one job. */
  function kick(full) {
    if (queued) {
      queued.full ||= full;
      return queued.done;
    }
    const job = { full };
    queued = job;
    job.done = chain = chain.then(afterFrame).then(() => {
      queued = null;
      if (dead) return undefined;
      return job.full ? rebuild() : mirror();
    }).catch((e) => console.warn('accessibility copy:', e)); // a failed call leaves the last copy in place
    return job.done;
  }

  async function rebuild() {
    const sel = last ?? (await rpc(client, 'selection'));
    const caret = last ? last.caret : sel ? await rpc(client, 'caret', sel.head) : null;
    const pages = [...new Set([...visible, ...(caret ? [caret.page] : [])])].sort((a, b) => a - b);
    const blocks = await blocksOf(client, pages, cache);
    if (dead) return;
    // Only the pages shown stay cached: scrolling through a long document would otherwise keep every page it passed.
    for (const p of cache.keys()) if (!pages.includes(p)) cache.delete(p);
    // An unchanged block keeps its element; a changed one is patched (a key in a table cell builds that cell's changed line only,
    // engine-main-thread-2: the whole table again took 643 elements and a width read for each line on the fixture's page 300).
    const nodes = copyTree(blocks).map(({ key, sig: s, node }) => {
      const old = kept.get(key);
      return [key, { sig: s, node, dom: !old ? toDom(doc, node) : old.sig === s ? old.dom : patch(doc, old.dom, old.node, node) }];
    });
    kept.clear();
    for (const [k, v] of nodes) kept.set(k, v);
    setKids(el, nodes.map(([, v]) => v.dom));
    shown = pages;
    place(blocks);
    onBuilt(pages);
    await mirror(true, sel);
  }

  /** Lays every line of `blocks` over its painted line, a kept one too (its paragraph may have moved), and fits the width of
   * each line whose text or box is new to the painted line's: one layout read for them all. A line already where its box says
   * is left alone. */
  function place(blocks) {
    const fit = [];
    const els = new Map([...el.querySelectorAll('[data-id]')].map((e) => [e.getAttribute('data-id'), e]));
    for (const b of textBlocks(blocks)) {
      const bel = els.get(String(b.id));
      const boxes = b.boxes ?? [];
      if (!bel || !boxes.length) continue;
      for (const span of bel.querySelectorAll(':scope > [data-line]')) {
        const li = Number(span.dataset.line);
        // A line on a page the copy does not hold sits on its nearest line that it does.
        const x = boxes.reduce((a, c) => (Math.abs(c.line - li) < Math.abs(a.line - li) ? c : a));
        const at = `${x.surface}|${x.x}|${x.y}|${x.h}|${x.size}`;
        if (placed.get(span) !== at) {
          placeLine(span, x);
          placed.set(span, at);
        }
        const key = `${x.w}|${x.size}|${x.line === li}`;
        if (fitted.get(span) !== key) fit.push([span, x, key]);
      }
    }
    const widths = fit.map(([span]) => span.offsetWidth); // laid out at 100 %: transforms leave offsetWidth alone
    fit.forEach(([span, x, key], i) => {
      span.style.setProperty('--f', widths[i] > 0 && x.w > 0 && x.line === Number(span.dataset.line) ? String((x.w * PX) / widths[i]) : '1');
      fitted.set(span, key);
    });
  }

  // Focus is the page area's own: its root, its text input or the copy. A frame component over the pages (a canvas being edited,
  // a video's controls) is inside the root but has the focus of its own: the DOM selection set under it would take the focus away.
  const holds = () => owner.contains(doc.activeElement) && !doc.activeElement.closest('[data-surface-overlay]');

  /** Sets the DOM selection to the engine's (`sel`, asked for when not given). A caret outside the copy rebuilds it, once
   * (`rebuilt`). */
  async function mirror(rebuilt = false, sel = null) {
    if (!holds()) return;
    sel ??= last ?? (await rpc(client, 'selection'));
    if (!sel) return;
    const head = await rpc(client, 'locate', sel.head);
    const headEl = blockEl(head?.id);
    if (!headEl) return rebuilt ? undefined : rebuild();
    const same = sel.anchor === sel.head || JSON.stringify(sel.anchor) === JSON.stringify(sel.head);
    const anchor = same ? head : await rpc(client, 'locate', sel.anchor);
    let a = blockEl(anchor?.id) ? domPoint(blockEl(anchor.id), anchor.offset) : null;
    if (!a) {
      // The anchor's paragraph is off the copy's pages: start the DOM selection at the copy's near end instead.
      const [ca, ch] = await Promise.all([rpc(client, 'caret', sel.anchor), rpc(client, 'caret', sel.head)]);
      const before = ca.page !== ch.page ? ca.page < ch.page : ca.y !== ch.y ? ca.y < ch.y : ca.x <= ch.x;
      const all = textEls(el);
      const edge = before ? all[0] : all.at(-1);
      a = domPoint(edge, before ? 0 : Infinity);
    }
    const h = domPoint(headEl, head.offset);
    // Again after the engine's answers: a DOM selection set here once the focus has left (a comment card's text box took it
    // meanwhile) would pull the focus back into the page area.
    if (!dead && holds()) doc.getSelection()?.setBaseAndExtent(a[0], a[1], h[0], h[1]);
  }

  const blockEl = (id) => (id == null ? null : el.querySelector(`[data-id="${CSS.escape(String(id))}"]`));

  offs.push(client.on?.('layout', (e) => {
    const from = e?.from;
    if (from == null) {
      cache.clear();
      kick(true);
      return;
    }
    const changed = (p) => (p >= from && p < e.to) || p >= (e.count ?? e.pages?.length ?? Infinity);
    for (const p of [...cache.keys()]) if (changed(p)) cache.delete(p);
    if ([...shown, ...visible].some(changed)) kick(true);
  }));
  offs.push(client.on?.('selection', (ev) => {
    last = ev?.head != null ? ev : null;
    announce(ev);
    kick(false);
  }));
  const onFocus = () => kick(false);
  owner.addEventListener('focusin', onFocus);

  return {
    /** The pages the copy holds: the visible ones and the caret's. */
    get pages() {
      return shown;
    },
    /** The page indexes in view now. */
    setPages(list) {
      const next = [...new Set(list)].sort((a, b) => a - b);
      if (next.join() === visible.join()) return chain;
      visible = next;
      return kick(true);
    },
    /** Rebuilds the copy from the engine now (after open). */
    refresh: () => (cache.clear(), kick(true)),
    destroy() {
      dead = true;
      for (const off of offs) off?.();
      owner.removeEventListener('focusin', onFocus);
      el.replaceChildren();
      say('');
    },
  };
}
