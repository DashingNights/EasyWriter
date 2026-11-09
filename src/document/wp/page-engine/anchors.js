// Where a document position's line sits, in layout px from the text's top, for what is placed beside the text (margin cards,
// footnote references): the top-level block holding the position comes from a binary search over the view's blocks, and the
// line's offset inside that block is kept per block while its node and its box's size stay. A block's lines move inside it only
// with its node, its width or a page end crossing it at another line; a crossed block (a page end's widget right before it) also
// keys on its top, since the page ends stand still on the paper. Reading every anchor through coordsAtPos cost 50 to 70 ms per
// render of the Word fixture's comment cards, while the pages settle.
// ponytail: a float of another block that moves into this block's lines leaves the kept offsets as they were until the block
// changes; key on the floats' places if that shows. Plain web APIs.

import { scaleOf } from '../../geometry.js';

const starts = new WeakMap(); // doc → the top-level blocks' start positions
const lists = new WeakMap(); // the doc the view draws → the view's top-level node descriptions (a redrawn one is detached)
const kept = new WeakMap(); // block element → {key, offs: Map(`offset:side` → {top, bottom} from the block's top, left)}

/** The rect of position `pos`'s line in `view` (layout px from the text's top and left edge, the zoom divided out; `side` as for
 * coordsAtPos) → {top, bottom, left}. Throws as coordsAtPos does for a position without coordinates. */
export function anchorRect(view, pos, side = 1) {
  const { doc } = view.state;
  let s = starts.get(doc);
  if (!s) {
    s = [];
    doc.forEach((_, p) => s.push(p));
    starts.set(doc, s);
  }
  // ProseMirror changes its children array in place, so the list is kept per doc drawn; a block it drew again since has a
  // new description, and the old one's DOM is no longer connected (checked below).
  const dv = view.docView;
  let descs = dv?.node === doc ? lists.get(doc) : null;
  if (dv?.node === doc && !descs) lists.set(doc, (descs = dv.children.filter((d) => d.node)));
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  const d = descs?.length === s.length ? descs[lo] : null;
  if (!d || d.node !== doc.child(lo) || !d.dom?.isConnected) return read(view, pos, side, 0);
  const el = d.dom;
  const top = el.offsetTop;
  const crossed = !!el.previousElementSibling?.classList.contains('pg-end');
  const key = `${el.offsetHeight}|${el.offsetWidth}|${el.offsetLeft}|${crossed ? top : ''}`;
  let k = kept.get(el);
  if (!k || k.node !== d.node || k.key !== key) kept.set(el, (k = { node: d.node, key, offs: new Map() }));
  const at = `${pos - s[lo]}:${side}`;
  let r = k.offs.get(at);
  if (!r) k.offs.set(at, (r = read(view, pos, side, top)));
  return { top: top + r.top, bottom: top + r.bottom, left: r.left };
}

/** coordsAtPos's rect of `pos` in layout px from the text's top, less `base`. */
function read(view, pos, side, base) {
  const c = view.coordsAtPos(pos, side);
  const r0 = view.dom.getBoundingClientRect();
  const z = scaleOf(view);
  return { top: (c.top - r0.top) / z - base, bottom: (c.bottom - r0.top) / z - base, left: (c.left - r0.left) / z };
}
