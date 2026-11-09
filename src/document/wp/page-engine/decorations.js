// Decoration sets at the top level of a long document (briefs/perf-settle.md). prosemirror-view 1.42 keeps a set's widgets between
// top-level blocks and its node decorations on them in one flat list at the set's own level. Two of its loops then cost blocks
// times decorations:
// - DecorationSet.forChild scans that list for each top-level child on every redraw. Only an inline decoration (a range across
//   blocks) can reach into a child, so a set without one answers from its children alone, by a binary search. The Word fixture's
//   8,400 children against its page ends, section breaks, list labels and section widths took 0.2 to 0.3 s per transaction.
//   Patched once on the prototype, so every plugin's set in every editor takes it; the answer is the same.
// - DecorationSet.create offers every decoration to every child and checks each node decoration with a walk over the children.
//   topLevelSet builds a set whose decorations all sit at the top level directly.
// endKeys keeps a page end's widget key while the page end stays where it was, so ProseMirror keeps its widget.
// ponytail: both read the set's `local` and `children` fields (prosemirror-view internals); a version without them falls back
// to its own forChild, and topLevelSet to create. Recheck on a prosemirror-view upgrade.
import { DecorationSet } from '@tiptap/pm/view';

const proto = DecorationSet.prototype;
const inline = new WeakMap(); // set → whether its own level holds an inline decoration

if (!proto.pgForChild) {
  const own = proto.forChild;
  proto.pgForChild = own;
  proto.forChild = function forChild(offset, node) {
    const { local, children } = this;
    if (!Array.isArray(local) || !Array.isArray(children) || node.isLeaf) return own.call(this, offset, node);
    let has = inline.get(this);
    if (has === undefined) inline.set(this, (has = local.some((d) => d.inline)));
    if (has) return own.call(this, offset, node);
    // children: [from, to, set] per child holding decorations, ascending: the first whose from is not below offset.
    let lo = 0;
    let hi = children.length / 3;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (children[mid * 3] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo * 3 < children.length && children[lo * 3] === offset ? children[lo * 3 + 2] : DecorationSet.empty;
  };
}

const byPos = (a, b) => a.from - b.from || a.to - b.to; // prosemirror-view's own order (a stable sort keeps equal ones in turn)

/** A DecorationSet of `decos` for `doc`, every one a widget at a top-level block boundary or a node decoration covering exactly
 * one top-level block (the caller's guarantee: nothing is checked). Same set as DecorationSet.create(doc, decos). */
export function topLevelSet(doc, decos) {
  if (!decos.length) return DecorationSet.empty;
  if (!Array.isArray(DecorationSet.empty.local)) return DecorationSet.create(doc, decos);
  return new DecorationSet([...decos].sort(byPos), []); // (local, children): the constructor prosemirror-view itself calls
}

let lastKey = 0;

/** The widget keys of page ends at `anchors` (with `after`), given the ends drawn before at `was` (their anchors mapped through
 * the change, with `wasAfter`) under `keys`: an end that stays at its place keeps its key, so ProseMirror keeps its widget. Keyed
 * by page, a page more or less near the top re-created every widget below it, and a document holding MathML restyles every
 * element of the text for each widget that comes or goes (Chromium's MathML sheet has a sibling rule with :nth-child, about half
 * a second on the Word fixture). The engine numbers the widgets by their order after each change (pagination.js layout: dataset.k). */
export function endKeys(was, wasAfter, keys, anchors, after) {
  const free = new Map();
  was.forEach((pos, k) => {
    const at = `${pos}${wasAfter[k] ? 'a' : ''}`;
    if (keys[k]) free.set(at, [...(free.get(at) ?? []), keys[k]]);
  });
  return anchors.map((pos, k) => free.get(`${pos}${after[k] ? 'a' : ''}`)?.shift() ?? `pg-end:${++lastKey}${after[k] ? 'a' : ''}`);
}

/** Whether decoration sources `a` and `b` hold the same decorations. A plugin may build an equal set anew on every call (from the
 * selection, say), and pagination's cycle history, which starts again when another plugin's decorations change, then started
 * again on every update. */
export function sameSet(a, b) {
  if (a === b) return true;
  if (typeof a?.find !== 'function' || typeof b?.find !== 'function') return false;
  const x = a.find();
  const y = b.find();
  return x.length === y.length && x.every((d, i) => d.eq(y[i]));
}

/** `set` (for `doc`) changed to hold exactly `decos`: only the decorations that differ are removed and added, so a rebuild where
 * most stay (a font's line height read from its file, the spelling languages loaded) does not pay DecorationSet.create, which
 * offers every decoration to every top-level block (230 ms in one task on the Word fixture). Past `max` changes one new set
 * costs less, since each add also scans per top-level block. */
export function changedSet(doc, set, decos, max = 500) {
  const old = new Map();
  for (const d of set.find()) {
    const k = `${d.from}:${d.to}`;
    if (!old.has(k)) old.set(k, []);
    old.get(k).push(d);
  }
  const add = [];
  for (const d of decos) {
    const list = old.get(`${d.from}:${d.to}`);
    const i = list ? list.findIndex((o) => o.eq(d)) : -1;
    if (i >= 0) list.splice(i, 1);
    else add.push(d);
  }
  const gone = [...old.values()].flat();
  if (!add.length && !gone.length) return set;
  if (add.length + gone.length > max) return DecorationSet.create(doc, decos);
  return set.remove(gone).add(doc, add);
}
