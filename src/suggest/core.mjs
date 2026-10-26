// Agent edits as suggestions (docs/plans/suggestions.md dataModel): an agent's change is applied to the draft as usual, and the
// same dispatch records on the changed top-level blocks how to take it back (attrs.suggest). Pure: ProseMirror and digest.mjs
// only, so Node tests and both editor kits (extension.js) share it.
//   block: null | {ins?: {id, g, by, at, note?, n, sig, old?: [block JSON]}, del?: [{id, g, by, at, note?, side, old}]}
//   doc:   null | {attrs: [{id, g, by, at, note?, key, old, sig}]}
// ins marks a block a change proposed (old, the blocks it replaced, on the run's first block only); del holds blocks a change
// removed next to this block (side 'before' or 'after' it); the doc record holds a doc attribute's old value (page setup).
import { ChangeSet, simplifyChanges } from '@tiptap/pm/changeset';
import { closeHistory } from '@tiptap/pm/history';
import { StepMap } from '@tiptap/pm/transform';
import { cyrb53 } from '../app/digest.mjs';

/** The meta key of the extension's own transactions (conversion, normalize, accept, reject, the active change). */
export const META = 'suggest';
/** Hunks with more middle blocks than this on either side are one hunk (no LCS). */
const LCS_MAX = 300;
const NOTE_MAX = 140;

// The label of a block shown as a whole (a new or deleted object, the deleted-block widget's placeholders).
export const LABELS = { canvas: 'Smart canvas', planChart: 'Plan chart', table: 'Table', image: 'Picture', media: 'Video', pageBreak: 'Page break',
  box: 'Titled box', horizontalRule: 'Line' };
/** The label of block JSON or a node (type and attrs): a linked canvas is a Flowchart, a still media file a Picture. */
export function labelOf(type, attrs) {
  if (type === 'canvas' && attrs?.flow) return 'Flowchart';
  if (type === 'media' && !String(attrs?.src ?? '').startsWith('data:video/')) return 'Picture';
  return LABELS[type] ?? null;
}

const rec = (node) => node.attrs.suggest ?? null;
const pack = (ins, del) => (ins || del?.length ? { ...(ins && { ins }), ...(del?.length && { del }) } : null);
const children = (doc) => {
  const out = [];
  doc.forEach((n, pos) => out.push({ n, pos }));
  return out;
};

/** A new change or group id: 's' or 'g' and 6 base-36 characters. */
export function newId(prefix) {
  let s = prefix;
  for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

// Block JSON without any record, its own or one below it (a wrapped suggested paragraph). strip copies, since toJSON shares attrs.
const plainJSON = (node) => strip(node.toJSON());
const sigs = new WeakMap();
/** cyrb53 of a block's JSON without records: what the edited check compares. */
export function sigOf(node) {
  let s = sigs.get(node);
  if (s === undefined) sigs.set(node, (s = cyrb53(JSON.stringify(plainJSON(node)))));
  return s;
}
const valueSig = (v) => cyrb53(JSON.stringify(v ?? null));

// ---------- hunks ----------
const same = (x, y) => x === y || x.eq(y);

/** The runs of top-level blocks that differ between docs `a` and `b`, [{a: [i, j), b: [p, q)}]: a common prefix and suffix, then
 * an LCS on Node.eq in the middle. */
export function hunks(a, b) {
  const A = [];
  const B = [];
  a.forEach((n) => A.push(n));
  b.forEach((n) => B.push(n));
  let s = 0;
  while (s < A.length && s < B.length && same(A[s], B[s])) s++;
  let ea = A.length;
  let eb = B.length;
  while (ea > s && eb > s && same(A[ea - 1], B[eb - 1])) {
    ea--;
    eb--;
  }
  const n = ea - s;
  const m = eb - s;
  if (!n && !m) return [];
  // ponytail: a middle over 300 blocks on a side is one hunk (one change); a real diff (Myers) if agents rewrite long drafts piecewise.
  if (!n || !m || n > LCS_MAX || m > LCS_MAX) return [{ a: [s, ea], b: [s, eb] }];
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = same(A[s + i], B[s + j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  let hi = 0;
  let hj = 0;
  const flush = () => {
    if (i > hi || j > hj) out.push({ a: [s + hi, s + i], b: [s + hj, s + j] });
  };
  while (i < n && j < m) {
    if (same(A[s + i], B[s + j])) {
      flush();
      i++;
      j++;
      hi = i;
      hj = j;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  i = n;
  j = m;
  flush();
  return out;
}

// ---------- conversion ----------
const metaOf = (id, call) => ({ id, g: call.g, by: call.by, at: call.at, ...(call.note && { note: String(call.note).slice(0, NOTE_MAX) }) });

/** The transaction recording one agent round (oldState → newState) as suggestions of `call` {g, by, at, note?, ids}, or null.
 * Every changed top-level block gets ins (the first also old, the blocks it replaced); blocks removed with nothing in their place
 * become a del record on the next block (the previous one at the end); a changed doc attribute a doc record. Pushes each id to
 * call.ids. */
export function convert(oldState, newState, call) {
  const a = oldState.doc;
  const b = newState.doc;
  if (a === b) return null;
  const tr = newState.tr;
  const ids = new Set();

  // Doc attributes (a Document's page setup): one record per key, keeping the first old value.
  const list = [...(b.attrs.suggest?.attrs ?? [])];
  let docChanged = false;
  for (const key of Object.keys(b.attrs)) {
    if (key === 'suggest' || key === 'numbering') continue; // numbering: lists.js adds nums, an unused one is harmless
    const nv = JSON.stringify(b.attrs[key] ?? null);
    if (nv === JSON.stringify(a.attrs[key] ?? null)) continue;
    docChanged = true;
    const k = list.findIndex((r) => r.key === key);
    if (k < 0) {
      const id = newId('s');
      list.push({ ...metaOf(id, call), key, old: a.attrs[key] ?? null, sig: cyrb53(nv) });
      ids.add(id);
    } else if (JSON.stringify(list[k].old ?? null) === nv) list.splice(k, 1); // back to its old value
    else {
      const id = list[k].g === call.g ? list[k].id : newId('s');
      list[k] = { ...metaOf(id, call), key, old: list[k].old, sig: cyrb53(nv) }; // only the base carries over, never the old note
      ids.add(id);
    }
  }
  if (docChanged) tr.setDocAttribute('suggest', list.length ? { attrs: list } : null);

  // Blocks.
  const kids = children(b);
  const set = new Map(); // index in b → its new record
  const touched = new Set(); // ids whose blocks this round changed or removed, for n
  for (const h of hunks(a, b)) {
    const olds = [];
    for (let i = h.a[0]; i < h.a[1]; i++) olds.push(a.child(i));
    for (const n of olds) if (rec(n)?.ins) touched.add(rec(n).ins.id);
    const base = [];
    for (const n of olds) {
      const r = rec(n);
      for (const d of r?.del ?? []) if (d.side === 'before') base.push(...d.old);
      if (r?.ins) {
        if (r.ins.old) base.push(...r.ins.old); // an ins block without old never existed in the base
      } else base.push(plainJSON(n));
      for (const d of r?.del ?? []) if (d.side !== 'before') base.push(...d.old);
    }
    const news = h.b[1] - h.b[0];
    const first = olds.length ? rec(olds[0])?.ins : null;
    // A later call of the same group over its own pending change keeps that change's id.
    const reuse = news && first?.g === call.g && olds.every((n) => rec(n)?.ins?.id === first.id && !rec(n).del?.length);
    const id = reuse ? first.id : newId('s');
    if (news) {
      for (let k = 0; k < news; k++) {
        const { n } = kids[h.b[0] + k];
        set.set(h.b[0] + k, { ins: { ...metaOf(id, call), sig: sigOf(n), ...(k === 0 && base.length && { old: base }) } });
        // Records below the top level (a wrapped suggested paragraph) belong to this change now.
        n.descendants((c, p) => {
          if (c.attrs.suggest) tr.setNodeAttribute(kids[h.b[0] + k].pos + 1 + p, 'suggest', null);
        });
      }
      ids.add(id);
    } else if (base.length) {
      const end = h.b[0] >= kids.length;
      const ci = end ? kids.length - 1 : h.b[0];
      const cur = set.has(ci) ? set.get(ci) : rec(kids[ci].n);
      set.set(ci, { ...cur, del: [...(cur?.del ?? []), { ...metaOf(id, call), side: end ? 'after' : 'before', old: base }] });
      ids.add(id);
    }
  }
  // n: the blocks carrying each touched id (this call's, and any whose blocks it changed or removed), its blocks outside these
  // hunks included.
  for (const id of ids) touched.add(id);
  const count = new Map();
  kids.forEach(({ n }, i) => {
    const id = (set.has(i) ? set.get(i) : rec(n))?.ins?.id;
    if (touched.has(id)) count.set(id, (count.get(id) ?? 0) + 1);
  });
  kids.forEach(({ n }, i) => {
    const r = set.has(i) ? set.get(i) : rec(n);
    if (r?.ins && count.has(r.ins.id) && r.ins.n !== count.get(r.ins.id)) set.set(i, { ...r, ins: { ...r.ins, n: count.get(r.ins.id) } });
  });
  for (const [i, r] of set) tr.setNodeAttribute(kids[i].pos, 'suggest', pack(r.ins, r.del));
  if (!tr.steps.length) return null;
  for (const id of ids) if (!call.ids?.includes(id)) call.ids?.push(id);
  return tr.setMeta(META, 'convert');
}

// ---------- normalize ----------
/** The top-level blocks of `doc` that range [from, to] touches, [{n, pos, i}]. */
function blocksIn(doc, from, to) {
  const $f = doc.resolve(from);
  const $t = doc.resolve(to);
  const i0 = $f.index(0);
  const i1 = $t.depth ? $t.index(0) + 1 : Math.max($t.index(0), i0);
  const out = [];
  let pos = $f.posAtIndex(i0, 0);
  for (let i = i0; i < i1 && i < doc.childCount; i++) {
    const n = doc.child(i);
    out.push({ n, pos, i });
    pos += n.nodeSize;
  }
  return out;
}

/** The top-level block holding position `m` of `doc` and the side a moved record takes there: a block that starts before `m`
 * holds it after; at a block boundary the next block holds it before; at the doc end the last block holds it after. */
function holder(doc, m) {
  const $m = doc.resolve(Math.min(m, doc.content.size));
  if ($m.depth) return { i: $m.index(0), side: 'after' };
  const i = $m.index(0);
  return i < doc.childCount ? { i, side: 'before' } : { i: doc.childCount - 1, side: 'after' };
}

/** Attribute fixes [{pos, value}] that keep records whole after a round of the user's (or any unconverted) edits from doc `a` to
 * `b` (`mapping` a → b): a record below the top level moves to its top-level block (a wrap); each id's old and each del record
 * stay on one block (a split copies them to both halves); a payload that vanished (a join, an unwrap, a drag-move, a delete)
 * comes back, on blocks lying inside its mapped range or as a del record at its mapped place. Reads only the changed blocks. */
export function normalize(a, b, mapping) {
  const start = a.content.findDiffStart(b.content);
  if (start == null) return [];
  let { a: endA, b: endB } = a.content.findDiffEnd(b.content);
  const over = start - Math.min(endA, endB);
  if (over > 0) {
    endA += over;
    endB += over;
  }
  const A = blocksIn(a, start, endA);
  const B = blocksIn(b, start, endB);
  const fixes = new Map(); // pos in b → value
  // The changed new blocks: their own record plus any record below them.
  const cur = B.map(({ n, pos }) => {
    const r = rec(n);
    const s = { pos, n, ins: r?.ins ?? null, del: [...(r?.del ?? [])], spare: [], dirty: false };
    n.descendants((c, p) => {
      const cr = c.attrs.suggest;
      if (!cr) return true;
      fixes.set(pos + 1 + p, null);
      s.dirty = true;
      if (cr.ins && !s.ins) s.ins = cr.ins;
      else if (cr.ins?.old) s.spare.push(cr.ins); // a second change inside one block: its old comes back as a del record
      s.del.push(...(cr.del ?? []));
      return true;
    });
    return s;
  });
  const before = new Map(); // id → {ins (with old) | del, from, to, carrier} from the changed old blocks
  for (const { n, pos } of A) {
    const r = rec(n);
    if (r?.ins) {
      const e = before.get(r.ins.id) ?? { id: r.ins.id, from: pos, to: pos + n.nodeSize };
      e.to = pos + n.nodeSize;
      if (r.ins.old) e.ins = r.ins;
      before.set(r.ins.id, e);
    }
    for (const d of r?.del ?? []) before.set(`del:${d.id}`, { del: d, from: pos, to: pos + n.nodeSize });
  }
  // The user's own block joined into a suggested one (Backspace at its start keeps the first block's attrs): the merged block is
  // the user's now, so it leaves the run, and an old it held comes back below (on the run's next block, else as a del record
  // beside it). An empty block (Enter at a run's end, then Backspace) just rejoins the run.
  for (const { n, pos } of A) {
    if (rec(n) || !n.content.size) continue;
    const $m = b.resolve(mapping.map(pos + 1, -1));
    const s = $m.depth ? cur.find((x) => x.pos === $m.before(1)) : null;
    if (!s?.ins) continue;
    s.ins = null;
    s.dirty = true;
  }
  if (!before.size && !cur.some((s) => s.dirty)) return [];

  // Each id's old on its first block, each del record on one block.
  const oldAt = new Map();
  for (const s of cur) {
    if (!s.ins?.old) continue;
    if (oldAt.has(s.ins.id)) {
      const { old, ...rest } = s.ins;
      s.ins = rest;
      s.dirty = true;
    } else oldAt.set(s.ins.id, s);
  }
  const delAt = new Map();
  for (const s of cur) {
    for (const d of s.del) {
      const prev = delAt.get(d.id);
      if (!prev) delAt.set(d.id, s);
      else if (d.side !== 'before') {
        prev.del = prev.del.filter((x) => x.id !== d.id); // side after: the last carrier keeps it
        prev.dirty = true;
        delAt.set(d.id, s);
      } else {
        s.del = s.del.filter((x) => x !== d);
        s.dirty = true;
      }
    }
  }
  const all = children(b);
  const at = new Map(cur.map((s) => [s.pos, s]));
  const slot = ({ n, pos }) => {
    if (!at.has(pos)) {
      const s = { pos, n, ins: rec(n)?.ins ?? null, del: [...(rec(n)?.del ?? [])], spare: [], dirty: false };
      cur.push(s);
      at.set(pos, s);
    }
    return at.get(pos);
  };
  const placeDel = (record, m) => {
    const { i, side } = holder(b, m);
    const s = slot(all[i]);
    s.del.push({ ...record, side });
    s.dirty = true;
  };
  // Payloads that vanished come back.
  for (const e of before.values()) {
    if (e.del) {
      if (!delAt.has(e.del.id)) placeDel(e.del, mapping.map(e.del.side === 'before' ? e.from : e.to, e.del.side === 'before' ? 1 : -1));
      continue;
    }
    if (!e.ins || oldAt.has(e.id)) continue;
    // The id's first remaining block anywhere in the doc takes its old (the run's next block after a join).
    const hit = all.find((x) => (at.has(x.pos) ? at.get(x.pos).ins : rec(x.n)?.ins)?.id === e.id);
    if (hit) {
      const s = slot(hit);
      s.ins = { ...s.ins, old: e.ins.old };
      s.dirty = true;
      continue;
    }
    // New blocks lying entirely inside its mapped range join the run (an unwrapped list's paragraph).
    const mf = mapping.map(e.from, 1);
    const mt = mapping.map(e.to, -1);
    const inside = cur.filter((s) => !s.ins && s.pos >= mf && s.pos + s.n.nodeSize <= mt);
    if (inside.length) {
      inside.forEach((s, k) => {
        const { old, ...rest } = e.ins;
        s.ins = k === 0 ? e.ins : rest;
        s.dirty = true;
      });
      continue;
    }
    const { n: _n, sig: _s, old, ...meta } = e.ins;
    placeDel({ ...meta, old, edited: true }, mapping.map(e.from, -1)); // the user joined, moved or deleted its blocks
  }
  for (const s of cur) {
    for (const ins of s.spare) {
      const { n: _n, sig: _s, old, ...meta } = ins;
      s.del.push({ ...meta, side: 'after', old });
      s.dirty = true;
    }
  }
  for (const s of cur) if (s.dirty) fixes.set(s.pos, pack(s.ins, s.del));
  // Only real changes.
  const out = [];
  for (const [pos, value] of fixes) {
    const node = b.nodeAt(pos);
    if (node && JSON.stringify(node.attrs.suggest ?? null) !== JSON.stringify(value)) out.push({ pos, value });
  }
  return out;
}

// ---------- accept and reject ----------
const filterRec = (r, drop) => pack(r?.ins && !drop.has(r.ins.id) ? r.ins : null, (r?.del ?? []).filter((d) => !drop.has(d.id)));

/** Accepting changes `ids`: their records go, the blocks stay. One undo step. Null when none is in the doc. */
export function accept(state, ids) {
  const drop = new Set(ids);
  const tr = state.tr;
  state.doc.forEach((n, pos) => {
    const r = rec(n);
    if (!r) return;
    const next = filterRec(r, drop);
    if (JSON.stringify(next) !== JSON.stringify(r)) tr.setNodeAttribute(pos, 'suggest', next);
  });
  const list = state.doc.attrs.suggest?.attrs ?? [];
  const keep = list.filter((x) => !drop.has(x.id));
  if (keep.length !== list.length) tr.setDocAttribute('suggest', keep.length ? { attrs: keep } : null);
  return tr.steps.length ? closeHistory(tr.setMeta(META, 'accept')) : null;
}

/** Rejecting changes `ids`: each change's blocks are deleted one by one and its old blocks put back at the first one's place
 * (a one-node run of an atom over one old node of its type keeps the node: setNodeMarkup, so a canvas keeps its view), each
 * del record's blocks go back beside its carrier, each doc record's value goes back. One undo step. Null when none is here. */
export function reject(state, ids) {
  const want = new Set(ids);
  const tr = state.tr;
  const { schema } = state;
  const first = new Map();
  state.doc.forEach((n, pos) => {
    const r = rec(n);
    for (const id of [r?.ins?.id, ...(r?.del ?? []).map((d) => d.id)]) if (want.has(id) && !first.has(id)) first.set(id, pos);
  });
  for (const id of [...first.keys()].sort((x, y) => first.get(y) - first.get(x))) rejectOne(tr, id, schema);
  const list = tr.doc.attrs.suggest?.attrs ?? [];
  const keep = list.filter((x) => !want.has(x.id));
  if (keep.length !== list.length) {
    for (const x of list) if (want.has(x.id)) tr.setDocAttribute(x.key, x.old);
    tr.setDocAttribute('suggest', keep.length ? { attrs: keep } : null);
  }
  return tr.steps.length ? closeHistory(tr.setMeta(META, 'reject')) : null;
}

function rejectOne(tr, id, schema) {
  // Del records, from the last: the record goes, its blocks go back before or after the carrier.
  const dels = [];
  tr.doc.forEach((n, pos) => {
    for (const d of rec(n)?.del ?? []) if (d.id === id) dels.push({ n, pos, d });
  });
  for (const { n, pos, d } of dels.reverse()) {
    const r = rec(tr.doc.nodeAt(pos));
    tr.setNodeAttribute(pos, 'suggest', pack(r?.ins ?? null, (r?.del ?? []).filter((x) => x.id !== id)));
    tr.insert(d.side === 'before' ? pos : pos + n.nodeSize, d.old.map((j) => schema.nodeFromJSON(j)));
  }
  const carriers = [];
  let old = null;
  tr.doc.forEach((n, pos) => {
    const r = rec(n);
    if (r?.ins?.id !== id) return;
    carriers.push({ n, pos, r });
    if (r.ins.old && !old) old = r.ins.old;
  });
  if (!carriers.length) return;
  const oldNodes = (old ?? []).map((j) => schema.nodeFromJSON(j));
  // Other changes' del records on these blocks stay in the draft.
  const others = carriers.flatMap(({ r }) => (r.del ?? []).filter((d) => d.id !== id));
  const one = carriers[0];
  if (carriers.length === 1 && oldNodes.length === 1 && oldNodes[0].type === one.n.type && (one.n.isLeaf || oldNodes[0].content.eq(one.n.content))) {
    tr.setNodeMarkup(one.pos, null, { ...oldNodes[0].attrs, suggest: pack(null, others) }, oldNodes[0].marks);
    return;
  }
  const start = one.pos;
  const empty = !oldNodes.length && carriers.length === tr.doc.childCount; // the draft would be empty: one empty block stays
  const put = empty ? [schema.topNodeType.contentMatch.defaultType.create()] : oldNodes;
  const size = put.reduce((s, n) => s + n.nodeSize, 0);
  if (put.length) tr.insert(start, put);
  for (const { n, pos } of [...carriers].reverse()) tr.delete(pos + size, pos + size + n.nodeSize);
  if (!others.length) return;
  // A before-record goes on the first block at the place, an after-record on the block ending there.
  for (const d of others) {
    const m = d.side === 'before' ? start : start + size;
    let { i, side } = holder(tr.doc, m);
    if (d.side !== 'before' && m > 0) {
      i = tr.doc.resolve(m).index(0) - 1;
      side = 'after';
    }
    let pos = 0;
    for (let k = 0; k < i; k++) pos += tr.doc.child(k).nodeSize;
    const r = rec(tr.doc.child(i));
    tr.setNodeAttribute(pos, 'suggest', pack(r?.ins ?? null, [...(r?.del ?? []), { ...d, side }]));
  }
}

// ---------- reading ----------
const entryCache = new WeakMap();

/** The waiting changes of `doc` in doc order (a doc attribute's first): [{id, g, by, at, note, kind: 'insert' | 'replace' |
 * 'delete' | 'attr', from, to, old, nodes, starts, side?, key?, draft?}]; nodes: the blocks carrying the change, starts: their
 * positions (the user's own blocks may lie between them). */
export function entries(doc) {
  let out = entryCache.get(doc);
  if (out) return out;
  const map = new Map();
  out = [];
  const get = (m) => {
    let e = map.get(m.id);
    if (!e) {
      e = { id: m.id, g: m.g, by: m.by, at: m.at, note: m.note ?? null, kind: null, from: null, to: null, old: null, nodes: [], starts: [] };
      map.set(m.id, e);
      out.push(e);
    }
    return e;
  };
  doc.forEach((n, pos) => {
    const r = rec(n);
    if (!r) return;
    if (r.ins) {
      const e = get(r.ins);
      e.nodes.push(n);
      e.starts.push(pos);
      e.from ??= pos;
      e.to = pos + n.nodeSize;
      if (r.ins.old) e.old = r.ins.old;
      if (r.ins.draft) e.draft = true;
    }
    for (const d of r.del ?? []) {
      const e = get(d);
      e.old ??= d.old;
      if (e.from == null) {
        e.from = e.to = d.side === 'before' ? pos : pos + n.nodeSize;
        e.side = d.side;
      }
    }
  });
  for (const e of out) e.kind = e.nodes.length ? (e.old ? 'replace' : 'insert') : 'delete';
  const attrs = (doc.attrs.suggest?.attrs ?? []).map((x) => ({ id: x.id, g: x.g, by: x.by, at: x.at, note: x.note ?? null, kind: 'attr', from: 0, to: 0,
    old: x.old, nodes: [], starts: [], key: x.key }));
  out = [...attrs, ...out];
  entryCache.set(doc, out);
  return out;
}

/** The number of waiting changes in `doc`. */
export const pendingCount = (doc) => entries(doc).length;

/** The changes of `doc` by group (one request of the user), in order of their first change: [{g, by, at, note, changes}]. */
export function groups(doc) {
  const m = new Map();
  for (const e of entries(doc)) {
    let g = m.get(e.g);
    if (!g) m.set(e.g, (g = { g: e.g, by: e.by, at: e.at, note: e.note, changes: [] }));
    g.at = Math.max(g.at ?? 0, e.at ?? 0);
    g.note ??= e.note;
    g.changes.push(e);
  }
  return [...m.values()];
}

/** Whether the user changed change `id` since it was made: a block's signature differs, fewer blocks carry it than it made, its
 * blocks were joined, moved or deleted (a del record normalize made, edited: true), or a doc attribute's value differs from the
 * proposed one. */
export function edited(doc, id) {
  let count = 0;
  let n = 0;
  let diff = false;
  doc.forEach((b) => {
    if (rec(b)?.del?.some((d) => d.id === id && d.edited)) diff = true;
    const ins = rec(b)?.ins;
    if (ins?.id !== id) return;
    count++;
    n = ins.n ?? n;
    if (ins.sig !== sigOf(b)) diff = true;
  });
  if (count || diff) return diff || count < n;
  const a = doc.attrs.suggest?.attrs?.find((x) => x.id === id);
  return a ? valueSig(doc.attrs[a.key]) !== a.sig : false;
}

/** Content JSON (one node, or an array of them) without any record: what agents write never carries or forges one. Copies only
 * the changed path. */
export function strip(json) {
  if (Array.isArray(json)) {
    let changed = false;
    const out = json.map((x) => {
      const y = strip(x);
      changed ||= y !== x;
      return y;
    });
    return changed ? out : json;
  }
  if (!json || typeof json !== 'object') return json;
  let out = json;
  if (json.attrs && 'suggest' in json.attrs) {
    const { suggest, ...attrs } = json.attrs;
    out = { ...json, attrs };
  }
  if (Array.isArray(json.content)) {
    const c = strip(json.content);
    if (c !== json.content) out = { ...out, content: c };
  }
  return out;
}

/** Doc JSON for agents: a record becomes {id, kind} (kind 'insert', 'replace', 'delete' or 'attr'), an empty one goes, and old
 * blocks stay out. Copies only the changed path; never writes into `json`. */
export function brief(json) {
  const replaced = new Set();
  for (const b of json?.content ?? []) if (b?.attrs?.suggest?.ins?.old) replaced.add(b.attrs.suggest.ins.id);
  const one = (node, top) => {
    if (!node || typeof node !== 'object') return node;
    let out = node;
    if (node.attrs && 'suggest' in node.attrs) {
      const { suggest: r, ...attrs } = node.attrs;
      const b = !r ? null : r.attrs ? { id: r.attrs[0]?.id, kind: 'attr' } : r.ins ? { id: r.ins.id, kind: replaced.has(r.ins.id) ? 'replace' : 'insert' }
        : r.del?.length ? { id: r.del[0].id, kind: 'delete' } : null;
      out = { ...node, attrs: b ? { ...attrs, suggest: b } : attrs };
    }
    if (Array.isArray(node.content)) {
      let changed = false;
      const c = node.content.map((x) => {
        const y = one(x, false);
        changed ||= y !== x;
        return y;
      });
      if (changed) out = { ...out, content: c };
    }
    return out;
  };
  return one(json, true);
}

/** What changed on a canvas, by item id: {added, changed, removed} (arrays of ids). */
export function boardDiff(oldItems = [], items = []) {
  const was = new Map(oldItems.map((i) => [i.id, i]));
  const now = new Set(items.map((i) => i.id));
  const added = [];
  const changed = [];
  for (const i of items) {
    const o = was.get(i.id);
    if (!o) added.push(i.id);
    else if (JSON.stringify(o) !== JSON.stringify(i)) changed.push(i.id);
  }
  return { added, changed, removed: oldItems.filter((i) => !now.has(i.id)).map((i) => i.id) };
}

// ---------- word diff ----------
const markKeys = new WeakMap();
const markKey = (m) => {
  let k = markKeys.get(m);
  if (k === undefined) markKeys.set(m, (k = Object.keys(m.attrs).length ? `${m.type.name}${JSON.stringify(m.attrs)}` : m.type.name));
  return k;
};
// Characters with their marks, so a format change is a change; atoms with their attrs.
const ENCODER = {
  encodeCharacter: (c, marks) => (marks.length ? `${c}|${marks.map(markKey).join('|')}` : c),
  encodeNodeStart: (n) => (n.isLeaf ? `${n.type.name}${JSON.stringify({ ...n.attrs, suggest: null })}` : n.type.name),
  encodeNodeEnd: (n) => `/${n.type.name}`,
  compareTokens: (a, b) => a === b,
};
const oldNodesOf = (e, schema) => {
  try {
    return (e.old ?? []).map((j) => schema.nodeFromJSON(j));
  } catch {
    return [];
  }
};
const diffCache = new WeakMap();

/** The word changes of replace change `e` (an entries() row of `doc`) as [{kind: 'add' | 'del' | 'fmt', from, to, text}], doc
 * positions: added and reformatted ranges in the doc, deleted text at the place it was (from = to). Through prosemirror-changeset,
 * widened to whole words; a run past its 2,500 tokens is one change. Memoized per proposed block. */
export function diff(e, doc, schema) {
  if (e.kind !== 'replace' || !e.nodes.length) return [];
  const key = e.nodes[0];
  let hit = diffCache.get(key);
  if (!hit || hit.old !== e.old || hit.last !== e.nodes[e.nodes.length - 1] || hit.count !== e.nodes.length) {
    const olds = oldNodesOf(e, schema);
    const A = schema.topNodeType.create(null, olds);
    const B = schema.topNodeType.create(null, e.nodes);
    const set = ChangeSet.create(A, (x) => x, ENCODER).addSteps(B, [new StepMap([0, A.content.size, B.content.size])], null);
    const rel = [];
    for (const c of simplifyChanges(set.changes, B)) {
      const gone = A.textBetween(c.fromA, c.toA, ' ', ' ');
      const added = B.textBetween(c.fromB, c.toB, ' ', ' ');
      if (c.toA > c.fromA && c.toB > c.fromB && gone === added) rel.push({ kind: 'fmt', from: c.fromB, to: c.toB, text: added });
      else {
        if (gone.trim()) rel.push({ kind: 'del', from: c.fromB, to: c.fromB, text: gone });
        if (c.toB > c.fromB && added.trim()) rel.push({ kind: 'add', from: c.fromB, to: c.toB, text: added });
      }
    }
    const offs = [];
    let o = 0;
    for (const n of e.nodes) {
      offs.push(o);
      o += n.nodeSize;
    }
    hit = { old: e.old, last: e.nodes[e.nodes.length - 1], count: e.nodes.length, rel, offs };
    diffCache.set(key, hit);
  }
  // Offsets in the joined blocks become doc positions through the block each falls in, since the user may have put blocks
  // between the run's blocks: a point (deleted words) in its block, at a boundary the next one; a range cut at each block's edges.
  const { offs } = hit;
  const out = [];
  for (const c of hit.rel) {
    for (let k = 0; k < offs.length; k++) {
      const s = offs[k];
      const end = s + e.nodes[k].nodeSize;
      const d = e.starts[k] - s;
      if (c.from === c.to) {
        if (c.from < end || k === offs.length - 1) {
          out.push({ ...c, from: c.from + d, to: c.to + d });
          break;
        }
      } else if (c.from < end && c.to > s) out.push({ ...c, from: Math.max(c.from, s) + d, to: Math.min(c.to, end) + d });
    }
  }
  return out;
}

// ---------- row text ----------
const q = (s) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= 40) return `“${t}”`;
  const cut = t.slice(0, 40);
  const sp = cut.lastIndexOf(' ');
  return `“${(sp > 20 ? cut.slice(0, sp) : cut).trim()}…”`;
};
const jsonText = (j) => (j?.type === 'text' ? j.text ?? '' : (j?.content ?? []).map(jsonText).join(j?.content?.every((c) => c.type === 'text' || c.type === 'hardBreak') ? '' : ' '));
const MARK_NAMES = { textStyle: 'font', fontSize: 'font size', textColor: 'colour', fontFamily: 'font', strike: 'strikethrough', code: 'code' };
const TYPE_NAMES = { paragraph: 'normal text', bulletList: 'bulleted list', orderedList: 'numbered list', blockquote: 'quote', codeBlock: 'code block' };
const typeName = (n) => (n.type.name === 'heading' ? `heading ${n.attrs.level}` : TYPE_NAMES[n.type.name] ?? labelOf(n.type.name, n.attrs)?.toLowerCase() ?? n.type.name);
const isEmptyDefault = (n, schema) => n.type === schema.topNodeType.contentMatch.defaultType && !n.content.size;
const marksIn = (nodes) => {
  const s = new Set();
  for (const n of nodes) n.descendants((c) => void c.marks.forEach((m) => s.add(m.type.name)));
  return s;
};
const blockAttrs = (n) => {
  const { suggest, ...a } = n.attrs;
  return JSON.stringify(a);
};
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

/** The row text of change `e` (an entries() row) in `schema`: Add “...”, Delete “...”, Replace “...” with “...”, Format bold,
 * Change to heading 2, Add smart canvas, Add 3 items, change 1, remove 2, Change 3 places in “...”, Change page setup. Empty
 * default paragraphs (TrailingNode's) are left out; a change of only them is "Add empty line". */
export function describe(e, schema) {
  if (e.kind === 'attr') return e.key === 'sect' ? 'Change page setup' : `Change ${e.key}`;
  const deleted = () => {
    const old = (e.old ?? []).filter((j) => jsonText(j).trim() || labelOf(j.type, j.attrs) || j.type !== schema.topNodeType.contentMatch.defaultType.name);
    if (!old.length) return 'Delete empty line';
    const label = old.length === 1 && labelOf(old[0].type, old[0].attrs);
    return label ? `Delete ${label.toLowerCase()}` : `Delete ${q(old.map(jsonText).join(' '))}`;
  };
  if (e.kind === 'delete') return deleted();
  const nodes = e.nodes.filter((n) => !isEmptyDefault(n, schema));
  // A replace of empty lines only (writing into an empty paragraph) reads as an add, and one that leaves only empty lines
  // (TrailingNode's, after the last block is deleted) as a delete.
  const olds = e.kind === 'replace' ? oldNodesOf(e, schema).filter((n) => !isEmptyDefault(n, schema)) : [];
  if (!olds.length) {
    if (!nodes.length) return 'Add empty line';
    const label = nodes.length === 1 && labelOf(nodes[0].type.name, nodes[0].attrs);
    return label ? `Add ${label.toLowerCase()}` : `Add ${q(nodes.map((n) => n.textContent).join(' '))}`;
  }
  if (!nodes.length) return deleted();
  if (olds.length === 1 && nodes.length === 1 && olds[0].type.name === 'canvas' && nodes[0].type.name === 'canvas') {
    const d = boardDiff(olds[0].attrs.items, nodes[0].attrs.items);
    const parts = [d.added.length && `add ${plural(d.added.length, 'item', 'items')}`, d.changed.length && `change ${d.changed.length}`,
      d.removed.length && `remove ${d.removed.length}`].filter(Boolean);
    const s = parts.length ? parts.join(', ') : `change ${labelOf('canvas', nodes[0].attrs).toLowerCase()}`;
    return s[0].toUpperCase() + s.slice(1);
  }
  const oldText = olds.map((n) => n.textContent).join(' ');
  const newText = nodes.map((n) => n.textContent).join(' ');
  if (oldText === newText) {
    if (olds.length === 1 && nodes.length === 1 && typeName(olds[0]) !== typeName(nodes[0])) return `Change to ${typeName(nodes[0])}`;
    const was = marksIn(olds);
    const now = marksIn(nodes);
    const added = [...now].filter((m) => !was.has(m));
    const gone = [...was].filter((m) => !now.has(m));
    const names = (l) => [...new Set(l.map((m) => MARK_NAMES[m] ?? m))].join(' and ');
    if (added.length) return `Format ${names(added)}`;
    if (gone.length) return `Remove ${names(gone)}`;
    if (olds.length === 1 && nodes.length === 1 && blockAttrs(olds[0]) !== blockAttrs(nodes[0])) return 'Change paragraph formatting';
    return 'Change formatting';
  }
  if (olds.length === 1 && nodes.length === 1 && nodes[0].isTextblock) {
    const words = diff(e, null, schema).filter((c) => c.kind !== 'fmt');
    const places = [];
    for (const c of words) {
      const last = places[places.length - 1];
      if (last && c.kind === 'add' && last.at === c.from && !last.add) last.add = c.text;
      else places.push({ at: c.from, ...(c.kind === 'del' ? { del: c.text } : { add: c.text }) });
    }
    if (places.length === 1) {
      const [p] = places;
      return p.del && p.add ? `Replace ${q(p.del)} with ${q(p.add)}` : p.add ? `Add ${q(p.add)}` : `Delete ${q(p.del)}`;
    }
    if (places.length > 1) return `Change ${places.length} places in ${q(newText)}`;
  }
  return `Replace ${q(oldText || olds.map((n) => labelOf(n.type.name, n.attrs) ?? '').join(' '))} with ${q(newText)}`;
}

// ---------- attribution ----------
/** The trusted input events that make a dispatch during them the user's (One converter, rule 3). */
export const INPUT_EVENTS = new Set(['keydown', 'keyup', 'beforeinput', 'input', 'compositionend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup',
  'click', 'dblclick', 'contextmenu', 'paste', 'drop']);
const RECENT_MS = 50;

/** Whose a dispatch is inside an agent scope of `kind` ('exact', 'ui', 'computer'): under 'ui', one during an untrusted event is the
 * agent's, one during a trusted input event the user's, and otherwise the agent's unless the user's input in that editor
 * (`lastEditorInput`, ms) came within 50 ms of `now`. The other kinds are always the agent's. */
export function attribute(kind, event, lastEditorInput, now) {
  if (kind !== 'ui') return 'agent';
  if (event && !event.isTrusted) return 'agent';
  if (event && INPUT_EVENTS.has(event.type)) return 'user';
  // ponytail: a dispatch outside any event within 50 ms of the user's input in the editor counts as theirs; per-dispatch tagging if presses get async.
  return now - lastEditorInput < RECENT_MS ? 'user' : 'agent';
}
