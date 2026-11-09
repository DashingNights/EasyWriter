// Agent edits as suggestions (docs/wiki/suggestions.md dataModel): an agent's change is applied to the draft as usual, and the
// same dispatch records on the changed top-level blocks how to take it back (attrs.suggest). Pure: ProseMirror and digest.mjs
// only, so Node tests and both editor kits (extension.js) share it.
//   block: null | {ins?: {id, g, by, at, note?, n, sig, old?: [block JSON]}, del?: [{id, g, by, at, note?, side, up?, old}]}
//   doc:   null | {attrs: [{id, g, by, at, note?, key, parts?: [{k, old?}], old?, sig}]}
// ins marks a block a change proposed (old, the blocks it replaced, on the run's first block only); del holds blocks a change
// removed next to this block (side 'before' or 'after' it, or `up` open wrappers further out: a block deleted next to a columns node
// sits outside it, though the record is on the wrapper's edge child); a doc record holds, for one doc attribute (key 'sect',
// 'styles'), the old value of each key agents changed in it (parts: k 'margin', 'list.Heading1'; old left out when the key was
// absent), so a reject restores those keys together and keeps the user's own changes to the others; a value that was or becomes no
// object is recorded whole (old).
// The blocks that carry records (units) are the top-level blocks, and the children of a columns, sdtBlock or fieldBlock wrapper that
// carries no record itself (docs/plans/word/plan.md §1.8 Wrapper nodes): an agent edit inside a three-page columns node is one
// changed paragraph.
import { ChangeSet, simplifyChanges } from '@tiptap/pm/changeset';
import { closeHistory } from '@tiptap/pm/history';
import { EditorState } from '@tiptap/pm/state';
import { StepMap, Transform } from '@tiptap/pm/transform';
import { cyrb53 } from '../app/digest.mjs';
import { WRAPPERS } from '../document/model/blocks.mjs';
import { newId as revId, recordRound, trackingOn } from '../document/wp/tracking/record.mjs';

/** The meta key of the extension's own transactions (conversion, normalize, accept, reject, the active change). */
export const META = 'suggest';
/** Hunks with more middle blocks than this on either side are one hunk (no LCS). */
const LCS_MAX = 300;
const NOTE_MAX = 140;

// The label of a block shown as a whole (a new or deleted object, the deleted-block widget's placeholders).
export const LABELS = { canvas: 'Smart canvas', planChart: 'Plan chart', table: 'Table', image: 'Picture', media: 'Video', pageBreak: 'Page break',
  box: 'Titled box', horizontalRule: 'Line', sectionBreak: 'Section break', columnBreak: 'Column break', columns: 'Columns', textBox: 'Text box',
  fieldBlock: 'Field', sdtBlock: 'Content control' };
/** The label of block JSON or a node (type and attrs): a linked canvas is a Flowchart, a still media file a Picture. */
export function labelOf(type, attrs) {
  if (type === 'canvas' && attrs?.flow) return 'Flowchart';
  if (type === 'media' && !String(attrs?.src ?? '').startsWith('data:video/')) return 'Picture';
  return LABELS[type] ?? null;
}

const rec = (node) => node.attrs.suggest ?? null;
const pack = (ins, del) => (ins || del?.length ? { ...(ins && { ins }), ...(del?.length && { del }) } : null);
const kidsOf = (node, start = 0) => {
  const out = [];
  node.forEach((n, off) => out.push({ n, pos: start + off }));
  return out;
};
// A wrapper with no record of its own: its children carry the records.
const opens = (n, r) => WRAPPERS.has(n.type.name) && !r;
/** The place a del record of unit `n` at `pos` in `doc` stands for: before or after the unit, or before or after its wrapper `up`
 * levels out. */
function placeOf(doc, pos, n, side, up) {
  if (!up) return side === 'before' ? pos : pos + n.nodeSize;
  const $p = doc.resolve(pos);
  const d = Math.max(1, $p.depth - up + 1);
  return side === 'before' ? $p.before(d) : $p.after(d);
}
// How many wrappers around the unit at `pos` place `m` lies outside of, on `side` of the unit.
function upOf(doc, pos, side, m) {
  const $p = doc.resolve(pos);
  let up = 0;
  while (up < $p.depth && (side === 'before' ? $p.before($p.depth - up) >= m : $p.after($p.depth - up) <= m)) up++;
  return up;
}
// Del record `d` placed on `side`, `up` levels out.
const delAt = (d, side, up) => {
  const { up: _u, ...rest } = d;
  return { ...rest, side, ...(up && { up }) };
};

/** The units of `node`'s content starting at `start` (the doc: 0), in order: [{n, pos}]. `over` (pos → record) stands in for the
 * records a transaction being built has set. */
function units(node, start = 0, over = null) {
  const out = [];
  const walk = (parent, from) => parent.forEach((n, off) => {
    const pos = from + off;
    if (opens(n, over?.has(pos) ? over.get(pos) : rec(n))) walk(n, pos + 1);
    else out.push({ n, pos });
  });
  walk(node, start);
  return out;
}

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
const sameNode = (x, y) => x === y || x.eq(y);

/** The runs of top-level blocks that differ between docs `a` and `b`, [{a: [i, j), b: [p, q)}]: a common prefix and suffix, then
 * an LCS on Node.eq in the middle. */
export function hunks(a, b) {
  const A = [];
  const B = [];
  a.forEach((n) => A.push(n));
  b.forEach((n) => B.push(n));
  return runs(A, B);
}

// The differing runs of node lists `A` and `B` (hunks), nodes matching by `same`.
function runs(A, B, same = sameNode) {
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

// Doc attributes no agent command writes (and numbering, which lists.js grows with nums; an unused one is harmless): never recorded.
const SKIP_ATTRS = new Set(['suggest', 'numbering', 'comments', 'people', 'props', 'settings', 'vars', 'merge', 'background']);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The value at dotted `key` ('sect.margin') of doc attrs `attrs`, or undefined. */
export const attrAt = (attrs, key) => key.split('.').reduce((o, k) => (isObj(o) ? o[k] : undefined), attrs);

// Object `obj` with `value` at path `keys`, copying the objects on the path; undefined removes the key.
function putAt(obj, [k, ...rest], value) {
  const out = { ...(isObj(obj) ? obj : {}) };
  const v = rest.length ? putAt(out[k], rest, value) : value;
  if (v === undefined) delete out[k];
  else out[k] = v;
  return out;
}

// Attribute value `value` with each of `parts` put back to its old value.
const restore = (value, parts) => parts.reduce((v, x) => putAt(v, x.k.split('.'), 'old' in x ? x.old : undefined), value);
// The signature of the values doc record `r` covers in doc attrs `attrs`.
const recSig = (attrs, r) => valueSig(r.parts ? r.parts.map((x) => attrAt(attrs[r.key], x.k)) : attrs[r.key]);

// The changed keys between attribute values `x` and `y` at `path`: one level into each attribute, two into styles.list (one key per
// style); a whole value where either side is no object.
function changedKeys(x, y, path, out) {
  if (JSON.stringify(x ?? null) === JSON.stringify(y ?? null)) return;
  const deeper = path.length === 1 || (path.length === 2 && path[0] === 'styles' && path[1] === 'list');
  if (!deeper || !isObj(x) || !isObj(y)) {
    out.push(path.join('.'));
    return;
  }
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) changedKeys(x[k], y[k], [...path, k], out);
}

/** The transaction recording one agent round (oldState → newState) as suggestions of `call` {g, by, at, note?, ids}, or null.
 * Every changed unit gets ins (the first also old, the units it replaced); units removed with nothing in their place become a del
 * record on the next unit (the previous one at the end); a changed key of a doc attribute a doc record. Pushes each id to call.ids. */
export function convert(oldState, newState, call) {
  const a = oldState.doc;
  const b = newState.doc;
  if (a === b) return null;
  const tr = newState.tr;
  const ids = new Set();

  // Doc attributes (page setup, styles): one record per attribute, keeping each key's first old value; a later group takes the
  // record over as it takes a pending block change over.
  const list = [...(b.attrs.suggest?.attrs ?? [])];
  let attrChanged = false;
  for (const top of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) {
    if (SKIP_ATTRS.has(top)) continue;
    const keys = [];
    changedKeys(a.attrs[top], b.attrs[top], [top], keys);
    if (!keys.length) continue;
    attrChanged = true;
    const subs = keys.map((key) => key.slice(top.length + 1)); // '' for the whole value
    const k = list.findIndex((r) => r.key === top);
    const prev = list[k];
    let r;
    if (subs.includes('') || (prev && !prev.parts) || prev?.parts.some((x) => subs.some((sub) => x.k.startsWith(`${sub}.`)))) {
      r = { key: top, old: (prev ? (prev.parts ? restore(a.attrs[top], prev.parts) : prev.old) : a.attrs[top]) ?? null };
    } else {
      const parts = [...(prev?.parts ?? [])];
      for (const sub of subs) {
        if (parts.some((x) => sub === x.k || sub.startsWith(`${x.k}.`))) continue;
        const old = attrAt(a.attrs[top], sub);
        parts.push(old === undefined ? { k: sub } : { k: sub, old });
      }
      r = { key: top, parts };
    }
    const back = r.parts ? restore(b.attrs[top], r.parts) : r.old;
    if (valueSig(back) === valueSig(b.attrs[top])) {
      if (k >= 0) list.splice(k, 1); // back to its old value
      continue;
    }
    const id = prev?.g === call.g ? prev.id : newId('s');
    const entry = { ...metaOf(id, call), ...r, sig: recSig(b.attrs, r) }; // only the base carries over, never the old note
    if (k >= 0) list[k] = entry;
    else list.push(entry);
    ids.add(id);
  }
  if (attrChanged) tr.setDocAttribute('suggest', list.length ? { attrs: list } : null);

  // Units: hunks of each container's children; a wrapper kept with its attributes is entered, so its changed children are the units.
  const set = new Map(); // pos in b → its new record
  const touched = new Set(); // ids whose units this round changed or removed, for n
  const recAt = (u) => (set.has(u.pos) ? set.get(u.pos) : rec(u.n));
  // The unit carrying a del record on `side` of block `u`: an open wrapper's edge child, `up` levels in.
  const edge = (u, side) => {
    let up = 0;
    while (opens(u.n, recAt(u))) {
      const kids = kidsOf(u.n, u.pos + 1);
      u = side === 'before' ? kids[0] : kids[kids.length - 1];
      up++;
    }
    return { u, up };
  };
  // Two open wrappers of one type and attributes pair up like equal blocks, and their children are compared inside them.
  const shell = (x, y) => sameNode(x, y) || (x.type === y.type && opens(x, rec(x)) && opens(y, rec(y)) && blockAttrs(x) === blockAttrs(y));
  const walk = (aParent, bParent, bStart) => {
    const A = kidsOf(aParent);
    const B = kidsOf(bParent, bStart);
    const hs = runs(A.map((x) => x.n), B.map((x) => x.n), shell);
    // The pairs between the hunks: a wrapper whose children changed is entered.
    let i = 0;
    let j = 0;
    for (const h of [...hs, { a: [A.length, A.length], b: [B.length, B.length] }]) {
      for (; i < h.a[0]; i++, j++) if (!sameNode(A[i].n, B[j].n)) walk(A[i].n, B[j].n, B[j].pos + 1);
      i = h.a[1];
      j = h.b[1];
    }
    for (const h of hs) {
      const olds = A.slice(h.a[0], h.a[1]).map((x) => x.n);
      const news = B.slice(h.b[0], h.b[1]);
      for (const n of olds) for (const u of [{ n }, ...units(n)]) if (rec(u.n)?.ins) touched.add(rec(u.n).ins.id);
      const base = baseOf(olds);
      const first = olds.length ? rec(olds[0])?.ins : null;
      // A later call of the same group over its own pending change keeps that change's id.
      const reuse = news.length && first?.g === call.g && olds.every((n) => rec(n)?.ins?.id === first.id && !rec(n).del?.length);
      const id = reuse ? first.id : newId('s');
      if (news.length) {
        news.forEach((u, k) => {
          set.set(u.pos, { ins: { ...metaOf(id, call), sig: sigOf(u.n), ...(k === 0 && base.length && { old: base }) } });
          // Records below this unit (a wrapped suggested paragraph, a wrapper's children) belong to this change now.
          u.n.descendants((c, p) => {
            if (c.attrs.suggest) tr.setNodeAttribute(u.pos + 1 + p, 'suggest', null);
          });
        });
        ids.add(id);
      } else if (base.length && B.length) {
        const end = h.b[0] >= B.length;
        const side = end ? 'after' : 'before';
        const { u: c, up } = edge(end ? B[B.length - 1] : B[h.b[0]], side);
        const cur = recAt(c);
        set.set(c.pos, { ...cur, del: [...(cur?.del ?? []), delAt({ ...metaOf(id, call), old: base }, side, up)] });
        ids.add(id);
      }
    }
  };
  walk(a, b, 0);
  // n: the units carrying each touched id (this call's, and any whose units it changed or removed), its units outside these hunks
  // included.
  for (const id of ids) touched.add(id);
  const all = units(b, 0, set);
  const count = new Map();
  for (const u of all) {
    const id = recAt(u)?.ins?.id;
    if (touched.has(id)) count.set(id, (count.get(id) ?? 0) + 1);
  }
  for (const u of all) {
    const r = recAt(u);
    if (r?.ins && count.has(r.ins.id) && r.ins.n !== count.get(r.ins.id)) set.set(u.pos, { ...r, ins: { ...r.ins, n: count.get(r.ins.id) } });
  }
  for (const [pos, r] of set) tr.setNodeAttribute(pos, 'suggest', pack(r.ins, r.del));
  if (!tr.steps.length) return null;
  for (const id of ids) if (!call.ids?.includes(id)) call.ids?.push(id);
  return tr.setMeta(META, 'convert');
}

// The base (the blocks before any pending change) of sibling nodes `nodes` as JSON: a record's old blocks in place of its own, a
// wrapper without a record with its children's base, a del record `up` levels out beside its wrapper.
function baseOf(nodes) {
  const { out, pre, post } = baseParts(nodes);
  // ponytail: a del record stepping out of the hunk's own parent lands at the edge of the base, one level in; carry it to the new
  // units if agents rewrite a wrapper's first or last child over a pending deletion beside the wrapper.
  return [...pre.flatMap((d) => d.old), ...out, ...post.flatMap((d) => d.old)];
}
// → {out, pre, post}: pre and post are the del records stepping out of the parent of `nodes`, with `up` one less.
function baseParts(nodes) {
  const out = [];
  const pre = [];
  const post = [];
  for (const n of nodes) {
    const r = rec(n);
    const after = [];
    const put = (d, here) => (d.up ? (d.side === 'before' ? pre : post).push({ ...d, up: d.up - 1 }) : here.push(...d.old));
    for (const d of r?.del ?? []) put(d, d.side === 'before' ? out : after);
    if (r?.ins) {
      if (r.ins.old) out.push(...r.ins.old); // an ins block without old never existed in the base
    } else if (opens(n, r)) {
      const kids = [];
      n.forEach((c) => kids.push(c));
      const inner = baseParts(kids);
      for (const d of inner.pre) put(d, out);
      const { content: _c, ...shell } = plainJSON(n.type.create(n.attrs));
      out.push({ ...shell, content: inner.out });
      for (const d of inner.post) put(d, after);
    } else out.push(plainJSON(n));
    out.push(...after);
  }
  return { out, pre, post };
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
    // An open wrapper: only its units the range touches.
    if (opens(n, rec(n))) out.push(...units(n, pos + 1).filter((u) => u.pos < to && u.pos + u.n.nodeSize > from));
    else out.push({ n, pos });
    pos += n.nodeSize;
  }
  return out;
}

/** The unit of units `list` (of `doc`) holding position `m` and the side a moved record takes there: a unit that starts before `m`
 * holds it after; at a unit boundary the next unit holds it before; at the end the last unit holds it after; `up`, the wrappers
 * around that unit that `m` lies outside of. → {i, side, up}, i in `list`. */
function holder(doc, list, m) {
  const i = list.findIndex((u) => u.pos < m && m < u.pos + u.n.nodeSize);
  if (i >= 0) return { i, side: 'after', up: 0 };
  const j = list.findIndex((u) => u.pos >= m);
  const k = j >= 0 ? j : list.length - 1;
  const side = j >= 0 ? 'before' : 'after';
  return { i: k, side, up: upOf(doc, list[k].pos, side, m) };
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
    for (const d of r?.del ?? []) before.set(`del:${d.id}`, { del: d, at: placeOf(a, pos, n, d.side, d.up) });
  }
  // The user's own block joined into a suggested one (Backspace at its start keeps the first block's attrs): the merged block is
  // the user's now, so it leaves the run, and an old it held comes back below (on the run's next block, else as a del record
  // beside it). An empty block (Enter at a run's end, then Backspace) just rejoins the run.
  for (const { n, pos } of A) {
    if (rec(n) || !n.content.size) continue;
    const m = mapping.map(pos + 1, -1);
    const s = cur.find((x) => x.pos < m && m < x.pos + x.n.nodeSize);
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
  const carrierOf = new Map();
  for (const s of cur) {
    for (const d of s.del) {
      const prev = carrierOf.get(d.id);
      if (!prev) carrierOf.set(d.id, s);
      else if (d.side !== 'before') {
        prev.del = prev.del.filter((x) => x.id !== d.id); // side after: the last carrier keeps it
        prev.dirty = true;
        carrierOf.set(d.id, s);
      } else {
        s.del = s.del.filter((x) => x !== d);
        s.dirty = true;
      }
    }
  }
  const all = units(b);
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
    const { i, side, up } = holder(b, all, m);
    const s = slot(all[i]);
    s.del.push(delAt(record, side, up));
    s.dirty = true;
  };
  // Payloads that vanished come back.
  for (const e of before.values()) {
    if (e.del) {
      if (!carrierOf.has(e.del.id)) placeDel(e.del, mapping.map(e.at, e.del.side === 'before' ? 1 : -1));
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

/** Accepting changes `ids`: their records go, the blocks stay; with `track` (Track Changes on) the changed words become Word
 * revisions by ASSISTANT (revise). One undo step. Null when none is in the doc. */
export function accept(state, ids, track = trackingOn(state.doc)) {
  const drop = new Set(ids);
  const tr = state.tr;
  for (const { n, pos } of units(state.doc)) {
    const r = rec(n);
    if (!r) continue;
    const next = filterRec(r, drop);
    if (JSON.stringify(next) !== JSON.stringify(r)) tr.setNodeAttribute(pos, 'suggest', next);
  }
  const list = state.doc.attrs.suggest?.attrs ?? [];
  const keep = list.filter((x) => !drop.has(x.id));
  if (keep.length !== list.length) tr.setDocAttribute('suggest', keep.length ? { attrs: keep } : null);
  if (track) revise(tr, piecesOf(entries(state.doc).filter((e) => drop.has(e.id)), state.schema));
  return tr.steps.length ? closeHistory(tr.setMeta(META, 'accept')) : null;
}

// ---------- as Word revisions ----------
/** The author of revisions an accepted or saved suggestion becomes. */
export const ASSISTANT = 'Assistant';

// Changes `list` (entries() rows) as revise() pieces, one per changed run of words (the word diff). A change one of whose word
// runs spans blocks the user put between its own blocks is left out.
function piecesOf(list, schema) {
  const out = [];
  for (const e of list) {
    if (e.kind === 'attr') continue;
    const { A, changes } = wordChanges(oldNodesOf(e, schema), e.nodes, schema);
    const offs = [];
    let o = 0;
    for (const n of e.nodes) {
      offs.push(o);
      o += n.nodeSize;
    }
    // A joined-blocks offset as a doc position, through the block it falls in (`side` -1: an end, so a block's own end).
    const at = (x, side) => {
      const k = offs.findIndex((s, i) => (side < 0 ? x <= s + e.nodes[i].nodeSize : x < s + e.nodes[i].nodeSize));
      const i = k < 0 ? offs.length - 1 : k;
      return i < 0 ? e.from + x : x + e.starts[i] - offs[i];
    };
    const mine = changes.map((c) => ({ from: at(c.fromB, 1), to: at(c.toB, -1), old: A.slice(c.fromA, c.toA), len: c.toB - c.fromB }));
    if (mine.every((p) => p.to - p.from === p.len)) out.push(...mine);
  }
  return out;
}

/** Writes `pieces` ([{from, to, old}]: range [from, to) of tr.doc holds a suggestion's words, `old` the Slice they replaced) into
 * `tr` as Word revisions by ASSISTANT: each range goes back to its old words and changes again in one round the Track Changes
 * engine records, so the old words come back marked deleted and the new ones marked inserted. → the Mapping of the steps it
 * added, or null (tr unchanged) when there is nothing to record or the round would not give tr.doc back exactly. */
function revise(tr, pieces) {
  if (!pieces.length) return null;
  const doc = tr.doc;
  const back = [...pieces].sort((a, b) => b.from - a.from);
  let steps;
  try {
    const rev = new Transform(doc);
    for (const p of back) rev.replace(p.from, p.to, p.old);
    const fwd = new Transform(rev.doc);
    for (const p of back) fwd.replace(rev.mapping.map(p.from, -1), rev.mapping.map(p.to, 1), doc.slice(p.from, p.to));
    if (!fwd.doc.eq(doc)) return null;
    const user = { name: ASSISTANT, initials: 'A' };
    const rec = recordRound(fwd, [], EditorState.create({ doc: fwd.doc }), { user, date: new Date().toISOString(), id: revId, moves: false, formatting: false });
    if (!rec) return null;
    steps = [...rev.steps, ...fwd.steps, ...rec.steps];
  } catch {
    return null;
  }
  const start = tr.steps.length;
  for (const s of steps) tr.step(s);
  return tr.mapping.slice(start);
}

/** Rejecting changes `ids`: each change's blocks are deleted one by one and its old blocks put back at the first one's place
 * (a one-node run of an atom over one old node of its type keeps the node: setNodeMarkup, so a canvas keeps its view), each
 * del record's blocks go back beside its carrier, each doc record's value goes back. One undo step. Null when none is here. */
export function reject(state, ids) {
  const want = new Set(ids);
  const tr = state.tr;
  const { schema } = state;
  const first = new Map();
  for (const { n, pos } of units(state.doc)) {
    const r = rec(n);
    for (const id of [r?.ins?.id, ...(r?.del ?? []).map((d) => d.id)]) if (want.has(id) && !first.has(id)) first.set(id, pos);
  }
  for (const id of [...first.keys()].sort((x, y) => first.get(y) - first.get(x))) rejectOne(tr, id, schema);
  const list = tr.doc.attrs.suggest?.attrs ?? [];
  const keep = list.filter((x) => !want.has(x.id));
  if (keep.length !== list.length) {
    // Each record puts back only its keys.
    for (const x of list) if (want.has(x.id)) tr.setDocAttribute(x.key, x.parts ? restore(tr.doc.attrs[x.key], x.parts) : x.old ?? null);
    tr.setDocAttribute('suggest', keep.length ? { attrs: keep } : null);
  }
  return tr.steps.length ? closeHistory(tr.setMeta(META, 'reject')) : null;
}

function rejectOne(tr, id, schema) {
  // Del records, from the last: the record goes, its blocks go back before or after the carrier.
  const dels = [];
  for (const { n, pos } of units(tr.doc)) for (const d of rec(n)?.del ?? []) if (d.id === id) dels.push({ n, pos, d });
  for (const { n, pos, d } of dels.reverse()) {
    const r = rec(tr.doc.nodeAt(pos));
    tr.setNodeAttribute(pos, 'suggest', pack(r?.ins ?? null, (r?.del ?? []).filter((x) => x.id !== id)));
    tr.insert(placeOf(tr.doc, pos, n, d.side, d.up), d.old.map((j) => schema.nodeFromJSON(j)));
  }
  const carriers = [];
  let old = null;
  for (const { n, pos } of units(tr.doc)) {
    const r = rec(n);
    if (r?.ins?.id !== id) continue;
    carriers.push({ n, pos, r });
    if (r.ins.old && !old) old = r.ins.old;
  }
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
  // The draft or a wrapper would be empty: one empty block stays.
  const parent = tr.doc.resolve(start).parent;
  const empty = !oldNodes.length && carriers.length === parent.childCount && carriers.every((c) => tr.doc.resolve(c.pos).parent === parent);
  const put = empty ? [parent.type.contentMatch.defaultType.create()] : oldNodes;
  const size = put.reduce((s, n) => s + n.nodeSize, 0);
  if (put.length) tr.insert(start, put);
  for (const { n, pos } of [...carriers].reverse()) tr.delete(pos + size, pos + size + n.nodeSize);
  if (!others.length) return;
  // A before-record goes on the first block at the place, an after-record on the block ending there.
  for (const d of others) {
    const list = units(tr.doc);
    const m = d.side === 'before' ? start : start + size;
    let { i, side, up } = holder(tr.doc, list, m);
    const j = d.side !== 'before' && m > 0 ? list.findLastIndex((u) => u.pos + u.n.nodeSize <= m) : -1;
    if (j >= 0) {
      i = j;
      side = 'after';
      up = upOf(tr.doc, list[j].pos, side, m);
    }
    const { n, pos } = list[i];
    const r = rec(n);
    tr.setNodeAttribute(pos, 'suggest', pack(r?.ins ?? null, [...(r?.del ?? []), delAt(d, side, up)]));
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
  for (const { n, pos } of units(doc)) {
    const r = rec(n);
    if (!r) continue;
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
        e.from = e.to = placeOf(doc, pos, n, d.side, d.up);
        e.side = d.side;
      }
    }
  }
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
  for (const { n: b } of units(doc)) {
    if (rec(b)?.del?.some((d) => d.id === id && d.edited)) diff = true;
    const ins = rec(b)?.ins;
    if (ins?.id !== id) continue;
    count++;
    n = ins.n ?? n;
    if (ins.sig !== sigOf(b)) diff = true;
  }
  if (count || diff) return diff || count < n;
  const a = doc.attrs.suggest?.attrs?.find((x) => x.id === id);
  return a ? recSig(doc.attrs, a) !== a.sig : false;
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
  const scan = (b) => {
    if (b?.attrs?.suggest?.ins?.old) replaced.add(b.attrs.suggest.ins.id);
    if (Array.isArray(b?.content)) b.content.forEach(scan);
  };
  (json?.content ?? []).forEach(scan);
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
// The word changes from blocks `olds` to blocks `nodes`, each list joined in a doc: {A, B, changes: [{fromA, toA, fromB, toB}]}.
function wordChanges(olds, nodes, schema) {
  const A = schema.topNodeType.create(null, olds);
  const B = schema.topNodeType.create(null, nodes);
  const set = ChangeSet.create(A, (x) => x, ENCODER).addSteps(B, [new StepMap([0, A.content.size, B.content.size])], null);
  return { A, B, changes: simplifyChanges(set.changes, B) };
}

/** The word changes of replace change `e` (an entries() row of `doc`) as [{kind: 'add' | 'del' | 'fmt', from, to, text}], doc
 * positions: added and reformatted ranges in the doc, deleted text at the place it was (from = to). Through prosemirror-changeset,
 * widened to whole words; a run past its 2,500 tokens is one change. Memoized per proposed block. */
export function diff(e, doc, schema) {
  if (e.kind !== 'replace' || !e.nodes.length) return [];
  const key = e.nodes[0];
  let hit = diffCache.get(key);
  if (!hit || hit.old !== e.old || hit.last !== e.nodes[e.nodes.length - 1] || hit.count !== e.nodes.length) {
    const { A, B, changes } = wordChanges(oldNodesOf(e, schema), e.nodes, schema);
    const rel = [];
    for (const c of changes) {
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

// ---------- places: one decision per word change ----------
// The user, 2026-10-26, on an agent's rewrite of a paragraph: "there are many inline edits but agent as opted to group them all
// into one, i cant individually decide on them." A change whose blocks pair one to one with its old blocks (text blocks of the
// same type and block attributes) is decided place by place: accepting a place writes its words into the change's old blocks,
// rejecting one writes the old words back into the text, and a change left with no difference goes.
const placeCache = new WeakMap();
const pairs = (e, olds) => olds.length === e.nodes.length
  && e.nodes.every((n, k) => n.isTextblock && olds[k].type === n.type && blockAttrs(olds[k]) === blockAttrs(n));
const fragMarks = (frag) => {
  const s = new Set();
  frag.descendants((c) => void c.marks.forEach((m) => s.add(m.type.name)));
  return s;
};

/** The row text of a place in old block `o` and new block `n` (one of places()' rows before ids). */
function placeText(p, o, n) {
  if (p.kind === 'fmt') {
    const was = fragMarks(o.slice(p.fromA, p.toA).content);
    const now = fragMarks(n.slice(p.fromB, p.toB).content);
    const names = (l) => [...new Set(l.map((m) => MARK_NAMES[m] ?? m))].join(' and ');
    const added = [...now].filter((m) => !was.has(m));
    const gone = [...was].filter((m) => !now.has(m));
    return added.length ? `Format ${names(added)}` : gone.length ? `Remove ${names(gone)}` : 'Change formatting';
  }
  if (p.kind === 'add') return `Add ${q(p.added)}`;
  if (p.kind === 'del') return `Delete ${q(p.gone)}`;
  return p.gone.trim() && p.added.trim() ? `Replace ${q(p.gone)} with ${q(p.added)}` : 'Change spacing';
}

/** The word changes of replace change `e` (an entries() row) as decisions of their own, when its blocks pair one to one with its
 * old blocks and it changes two places or more: [{id, change, k, fromA, toA, fromB, toB, from, to, kind: 'replace' | 'add' | 'del'
 * | 'fmt', gone, added, text}] in document order; fromA/toA in old block k, fromB/toB in its block k, from/to the doc positions of
 * the proposed words (from = to for a deletion). [] when the change is one decision: an insert, a delete, an object, a block type
 * or attribute change, a split or joined block, a change the user edited, or a single place (whose decision is the change's). Ids are `<change>-<n>` by
 * order, so they shift when a place is decided. Memoized per proposed block. */
export function places(e, schema) {
  if (e.kind !== 'replace' || !e.nodes.length) return [];
  const key = e.nodes[0];
  let hit = placeCache.get(key);
  if (!hit || hit.old !== e.old || hit.nodes.length !== e.nodes.length || hit.nodes.some((n, k) => n !== e.nodes[k])) {
    const olds = oldNodesOf(e, schema);
    const list = [];
    // A change the user edited is one decision again: their own words would otherwise show as the agent's places.
    const mine = e.nodes.some((n) => rec(n)?.ins?.sig !== sigOf(n));
    if (!mine && pairs(e, olds)) {
      e.nodes.forEach((n, k) => {
        const o = olds[k];
        if (o.content.eq(n.content)) return;
        const set = ChangeSet.create(o, (x) => x, ENCODER).addSteps(n, [new StepMap([0, o.content.size, n.content.size])], null);
        for (const c of simplifyChanges(set.changes, n)) {
          const gone = o.textBetween(c.fromA, c.toA, ' ', ' ');
          const added = n.textBetween(c.fromB, c.toB, ' ', ' ');
          const kind = c.toA > c.fromA && c.toB > c.fromB && gone === added ? 'fmt'
            : gone.trim() && added.trim() ? 'replace' : added.trim() ? 'add' : gone.trim() ? 'del' : 'replace';
          const p = { k, fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB, kind, gone, added };
          list.push({ ...p, text: placeText(p, o, n) });
        }
      });
    }
    hit = { old: e.old, nodes: e.nodes.slice(), list: list.length > 1 ? list : [] };
    placeCache.set(key, hit);
  }
  return hit.list.map((p, i) => ({ ...p, id: `${e.id}-${i}`, change: e.id, from: e.starts[p.k] + 1 + p.fromB, to: e.starts[p.k] + 1 + p.toB }));
}

/** What the user decides on in `doc`, in document order: each place of a change that has places, else the change. [{id, e, place?}]
 * (`place`: a places() row). */
export function items(doc, schema) {
  return entries(doc).flatMap((e) => {
    const ps = places(e, schema);
    return ps.length ? ps.map((place) => ({ id: place.id, e, place })) : [{ id: e.id, e }];
  });
}

// The places `pids` picks in `doc`, by change: Map id → {e, list}.
function pickPlaces(doc, schema, pids) {
  const want = new Set(pids);
  const out = new Map();
  for (const e of entries(doc)) {
    const list = places(e, schema).filter((p) => want.has(p.id));
    if (list.length) out.set(e.id, { e, list });
  }
  return out;
}

// After some of change `id`'s places were decided in `tr`: a change whose blocks now match its old ones goes (the blocks stay as
// they are, other changes' del records with them); otherwise a block whose text the decision changed takes its new signature,
// unless the user had edited the change (`keepSig`), which then still counts as edited.
function settle(tr, id, schema, keepSig) {
  const carriers = units(tr.doc).filter(({ n }) => rec(n)?.ins?.id === id);
  if (!carriers.length) return;
  const old = carriers.map(({ n }) => rec(n).ins.old).find(Boolean) ?? [];
  let olds;
  try {
    olds = old.map((j) => schema.nodeFromJSON(j));
  } catch {
    olds = [];
  }
  const done = olds.length === carriers.length
    && carriers.every(({ n }, k) => olds[k].type === n.type && blockAttrs(olds[k]) === blockAttrs(n) && olds[k].content.eq(n.content));
  for (const { n, pos } of carriers) {
    const r = rec(n);
    if (done) tr.setNodeAttribute(pos, 'suggest', pack(null, (r.del ?? []).filter((d) => d.id !== id)));
    else if (!keepSig && r.ins.sig !== sigOf(n)) tr.setNodeAttribute(pos, 'suggest', pack({ ...r.ins, sig: sigOf(n) }, r.del));
  }
}

/** Accepting places `pids` (places() ids): each one's proposed words go into its change's old blocks, so only the rest of that
 * change still differs; a change left with no difference goes. The text stays; with `track` each place becomes Word revisions
 * (revise), which go into the old blocks with it. One undo step. Null when none is in the doc. */
export function acceptPlaces(state, pids, track = trackingOn(state.doc)) {
  const { schema } = state;
  const tr = state.tr;
  const picked = pickPlaces(state.doc, schema, pids);
  const oldOf = new Map([...picked].map(([id, { e }]) => [id, oldNodesOf(e, schema)]));
  const map = track && revise(tr, [...picked].flatMap(([id, { list }]) => list.map((p) => ({ from: p.from, to: p.to, old: oldOf.get(id)[p.k].slice(p.fromA, p.toA) }))));
  for (const [id, { e, list }] of picked) {
    const olds = oldOf.get(id);
    const now = (p) => {
      if (!map) return e.nodes[p.k].slice(p.fromB, p.toB);
      const at = map.map(e.starts[p.k], 1);
      return tr.doc.nodeAt(at).slice(map.map(p.from, -1) - at - 1, map.map(p.to, 1) - at - 1);
    };
    // From the end of each block, so the earlier places' old positions still hold.
    for (const p of [...list].sort((a, b) => b.k - a.k || b.fromA - a.fromA)) olds[p.k] = olds[p.k].replace(p.fromA, p.toA, now(p));
    const at = units(tr.doc).find(({ n }) => rec(n)?.ins?.id === id && rec(n).ins.old)?.pos ?? -1;
    if (at < 0) continue;
    const r = rec(tr.doc.nodeAt(at));
    tr.setNodeAttribute(at, 'suggest', pack({ ...r.ins, old: olds.map(plainJSON) }, r.del));
    settle(tr, id, schema, !map || edited(state.doc, id)); // the revisions changed the text: its signature follows
  }
  return tr.steps.length ? closeHistory(tr.setMeta(META, 'accept')) : null;
}

/** Rejecting places `pids`: each one's old words go back into the text, so only the rest of its change still differs; a change left
 * with no difference goes. One undo step. Null when none is in the doc. */
export function rejectPlaces(state, pids) {
  const { schema } = state;
  const tr = state.tr;
  const picked = pickPlaces(state.doc, schema, pids);
  const edits = [];
  const was = new Map();
  for (const [id, { e, list }] of picked) {
    was.set(id, edited(state.doc, id));
    const olds = oldNodesOf(e, schema);
    for (const p of list) edits.push({ from: p.from, to: p.to, slice: olds[p.k].slice(p.fromA, p.toA) });
  }
  for (const x of edits.sort((a, b) => b.from - a.from)) tr.replace(x.from, x.to, x.slice);
  for (const id of picked.keys()) settle(tr, id, schema, was.get(id));
  return tr.steps.length ? closeHistory(tr.setMeta(META, 'reject')) : null;
}

// ---------- row text ----------
/** `s` in quotes for a row, cut at a word near 40 characters (the cards of a canvas draft use it too, cards.mjs). */
export const q = (s) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= 40) return `“${t}”`;
  const cut = t.slice(0, 40);
  const sp = cut.lastIndexOf(' ');
  return `“${(sp > 20 ? cut.slice(0, sp) : cut).trim()}…”`;
};
/** The text of block JSON `j`: inline content joined as is, blocks with a space. */
export const jsonText = (j) => (j?.type === 'text' ? j.text ?? '' : (j?.content ?? []).map(jsonText).join(j?.content?.every((c) => c.type === 'text' || c.type === 'hardBreak') ? '' : ' '));
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
  if (e.kind === 'attr') {
    const top = e.key.split('.')[0];
    return top === 'sect' ? 'Change page setup' : top === 'styles' ? 'Change styles' : `Change ${top}`;
  }
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
