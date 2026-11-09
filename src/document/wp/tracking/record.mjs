// Track Changes recording (docs/plans/word/briefs/tracking.md): with doc settings trackRevisions on, each user round's root steps
// become revisions in one appended transaction, so the root and its record are one undo step. Inserted text gets an insertion
// mark, deleted text comes back with a deletion mark (your own insertions really go), paragraph marks record in markRev, rows and
// block objects in rev, formatting in formatChange and paragraph properties in pChange. Only each step's changed range is read.
// Pure: Node tests build the plugin with a fixed author and clock.
import { Fragment, Mark, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { AddMarkStep, AttrStep, Mapping, RemoveMarkStep, ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import { authorColor } from './colors.mjs';

export const trackKey = new PluginKey('wordTracking');
/** Marks that are not formatting: a format change never records or restores them. */
/** The marks of a tracked text change. */
export const REV_MARKS = new Set(['insertion', 'deletion', 'formatChange']);
export const NOT_FORMAT = new Set([...REV_MARKS, 'comment', 'permission']);
// Paragraph attributes that are records, not properties: a change to them is no pChange.
const NOT_PROPS = new Set(['markRev', 'pChange', 'suggest']);

/** Whether doc settings `s` force recording: Restrict Editing to tracked changes, enforced (protect writes it). */
export const forcedOn = (s) => s?.protection?.edit === 'trackedChanges' && !!s.protection.enforcement;
/** Whether recording is on in `doc` (a v1 document has settings null: off). */
export const trackingOn = (doc) => !!doc.attrs.settings?.trackRevisions || forcedOn(doc.attrs.settings);

/** A random 8-character id. */
export const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

const revOf = (node, name) => node.marks.find((m) => m.type.name === name) ?? null;
const ownIns = (node, me) => {
  const m = revOf(node, 'insertion');
  return !!m && m.attrs.author === me && !revOf(node, 'deletion');
};
/** The formatting marks of `marks` as JSON (the old value of a format change). */
export const formatJson = (marks) => marks.filter((m) => !NOT_FORMAT.has(m.type.name)).map((m) => m.toJSON());
const propsOf = (node) => Object.fromEntries(Object.entries(node.attrs).filter(([k]) => !NOT_PROPS.has(k)));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The next free move name of `doc` ('move1', 'move2', ...). */
export function nextMoveName(doc) {
  let n = 0;
  doc.descendants((node) => {
    for (const m of node.marks) {
      const k = /^move(\d+)$/.exec(m.attrs.move ?? '');
      if (k) n = Math.max(n, Number(k[1]));
    }
  });
  return `move${n + 1}`;
}

// The changes a step-level reading of `root` found, in newState positions: inserted ranges, deleted slices to restore, format
// pieces and paragraph property changes.
function readRound(root, rest, me) {
  const after = new Mapping();
  for (const t of rest) after.appendMapping(t.mapping);
  const out = { ins: [], del: [], fmt: [], para: [], joins: [] };
  root.steps.forEach((step, i) => {
    const doc = root.docs[i];
    const tail = root.mapping.slice(i + 1);
    const map = (pos, assoc) => after.map(tail.map(pos, assoc), assoc);
    if (step instanceof ReplaceStep) {
      const { from, to, slice } = step;
      if (slice.size) out.ins.push({ from: map(from, 1), to: map(from + slice.size, -1) });
      if (to > from) {
        // Cells removed from a row (a column deleted or cells merged) are not recorded: column and cell revisions are out of scope.
        if (doc.resolve(from).parent.type.name === 'tableRow') return;
        out.del.push({ at: map(from, -1), slice: doc.slice(from, to), from, to, step: i, doc, inserted: slice.size > 0 });
      }
      return;
    }
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      if (NOT_FORMAT.has(step.mark.type.name)) return;
      doc.nodesBetween(step.from, step.to, (node, pos) => {
        if (!node.isInline) return true;
        if (ownIns(node, me)) return false;
        const from = Math.max(pos, step.from);
        const to = Math.min(pos + node.nodeSize, step.to);
        out.fmt.push({ from: map(from, 1), to: map(to, -1), old: formatJson(node.marks) });
        return false;
      });
      return;
    }
    let pos = null;
    if (step instanceof AttrStep && !NOT_PROPS.has(step.attr)) pos = step.pos;
    // setNodeMarkup and setBlockType: one node's type or attributes replaced around its unchanged content.
    if (step instanceof ReplaceAroundStep && step.structure && step.insert === 1 && step.gapFrom === step.from + 1 && step.gapTo === step.to - 1
      && step.slice.openStart === 0 && step.slice.openEnd === 0 && step.slice.content.childCount === 1) pos = step.from;
    const node = pos == null ? null : doc.nodeAt(pos);
    if (node?.isTextblock) out.para.push({ pos: map(pos, 1), old: { type: node.type.name, attrs: propsOf(node) } });
  });
  return out;
}

// `slice` with each inline node marked deleted by `rev`; your own insertions go, text already deleted stays as it is. → {slice,
// kept} where kept counts the inline nodes left.
function deletedSlice(slice, rev, me, schema) {
  let kept = 0;
  const walk = (frag) => {
    const nodes = [];
    frag.forEach((node) => {
      if (node.isInline) {
        if (ownIns(node, me)) return;
        kept++;
        nodes.push(revOf(node, 'deletion') ? node : node.mark(schema.marks.deletion.create(rev).addToSet(node.marks)));
      } else nodes.push(node.copy(walk(node.content)));
    });
    return Fragment.fromArray(nodes);
  };
  return { slice: new Slice(walk(slice.content), slice.openStart, slice.openEnd), kept };
}

// The textblocks whose paragraph mark lies inside [from, to) of `doc` (never the last block of its parent: that mark has nothing to
// join) and the nodes carrying `rev` that lie wholly inside it.
function blocksIn(doc, from, to, fn) {
  doc.nodesBetween(from, to, (node, pos, parent, index) => {
    if (node.isTextblock) {
      const end = pos + node.nodeSize - 1;
      if (end >= from && end < to && index < parent.childCount - 1) fn('mark', node, pos);
      return false;
    }
    if ('rev' in node.type.spec.attrs && pos >= from && pos + node.nodeSize <= to) fn('rev', node, pos);
    return !node.isInline;
  });
}

/** Marks [from, to) of `tr` as inserted by `who` (a revision {id, author, date, move}); a run typed against the same author's
 * insertion takes its mark. Paragraph marks in the range get markRev.ins, rows and block objects rev.ins. */
export function markInserted(tr, from, to, who, joinable = true) {
  if (to <= from) return;
  const { insertion, deletion, formatChange } = tr.doc.type.schema.marks;
  for (const type of [insertion, deletion, formatChange]) tr.removeMark(from, to, type);
  let rev = who;
  if (joinable) {
    const near = [tr.doc.resolve(from).nodeBefore, tr.doc.resolve(to).nodeAfter].map((n) => n?.isInline && !revOf(n, 'deletion') && revOf(n, 'insertion'))
      .find((m) => m && m.attrs.author === who.author && !m.attrs.move);
    if (near) rev = near.attrs;
  }
  tr.addMark(from, to, insertion.create(rev));
  const by = { id: who.id, author: who.author, date: who.date };
  blocksIn(tr.doc, from, to, (kind, node, pos) => {
    const key = kind === 'mark' ? 'markRev' : 'rev';
    tr.setNodeAttribute(pos, key, { ...(node.attrs[key] ?? {}), ins: by });
  });
}

/** Puts deleted `d` ({at, slice, from, to, doc}: the slice [from, to) of `doc`, deleted at `at` of tr's doc before tr's steps) back
 * with a deletion mark: `fresh()` gives the revision unless `joinable` and the same author's deletion is beside it. Your own
 * insertions, paragraph marks, rows and objects go for real. → {at, end} of the restored range, or null when nothing came back. */
function restoreDeleted(tr, d, me, fresh, joinable) {
  const schema = tr.doc.type.schema;
  const at = tr.mapping.map(d.at, -1);
  // A run deleted beside the same author's deletion takes its mark, so Backspace after Backspace stays one revision.
  const near = joinable && [tr.doc.resolve(at).nodeBefore, tr.doc.resolve(at).nodeAfter].map((n) => n && n.isInline && revOf(n, 'deletion'))
    .find((m) => m && m.attrs.author === me && !m.attrs.move);
  const rev = near ? { ...near.attrs } : fresh();
  const { slice, kept } = deletedSlice(d.slice, rev, me, schema);
  // Every paragraph mark in the range is your own insertion too: nothing is restored.
  let marksToKeep = 0;
  let ownMarks = 0;
  blocksIn(d.doc, d.from, d.to, (kind, node) => {
    if (kind === 'mark' && node.attrs.markRev?.ins?.author === me && !node.attrs.markRev?.del) ownMarks++;
    else marksToKeep++;
  });
  if (!kept && !marksToKeep) {
    // Your own paragraph mark went with the join: the joined paragraph takes the mark that stayed, the second paragraph's.
    if (ownMarks) {
      const $at = tr.doc.resolve(at);
      if ($at.parent.isTextblock) tr.setNodeAttribute($at.before(), 'markRev', d.doc.resolve(d.to).parent.attrs.markRev ?? null);
    }
    return null;
  }
  const size = tr.doc.content.size;
  tr.replace(at, at, slice);
  let end = at + (tr.doc.content.size - size);
  const by = { id: rev.id, author: rev.author, date: rev.date };
  const gone = []; // your own new rows and objects go for real, from the end so positions hold
  blocksIn(tr.doc, at, end, (kind, node, pos) => {
    if (kind === 'mark') {
      if (!node.attrs.markRev?.del) tr.setNodeAttribute(pos, 'markRev', { ...(node.attrs.markRev ?? {}), del: by });
    } else if (!node.attrs.rev?.del) {
      if (node.attrs.rev?.ins?.author === me) gone.push([pos, pos + node.nodeSize]);
      else tr.setNodeAttribute(pos, 'rev', { ...(node.attrs.rev ?? {}), del: by });
    }
  });
  for (const [a, b] of gone.reverse()) tr.delete(a, b);
  end = tr.mapping.slice(tr.mapping.maps.length - gone.length).map(end, -1);
  return { at, end };
}

/** Records `root` (the round's root transaction; `rest` the transactions appended after it so far) on `state` (the state they
 * produced) → the appended transaction, or null when there is nothing to record. `o`: {user: {name, initials}, date, id(),
 * moves, formatting}. `back`: the deletion was a Backspace, so the caret goes before the deleted text. */
export function recordRound(root, rest, state, o) {
  const me = o.user.name;
  const schema = state.schema;
  const read = readRound(root, rest, me);
  if (!read.ins.length && !read.del.length && !read.fmt.length && !read.para.length) return null;
  const tr = state.tr;
  const who = (extra) => ({ id: o.id(), author: me, date: o.date, move: null, ...extra });
  const moving = o.moves && root.getMeta('uiEvent') === 'drop' && read.ins.length > 0 && read.del.length > 0;
  const move = moving ? nextMoveName(state.doc) : null;

  // Deletions first: each comes back where it was, before any text the same step inserted.
  let caret = null;
  let restored = false;
  for (const d of read.del) {
    const r = restoreDeleted(tr, d, me, () => who(move ? { move } : {}), !move);
    if (!r) continue;
    restored = true;
    if (!d.inserted && read.del.length === 1) caret = o.back ? r.at : r.end; // the later steps only change marks and attributes
  }

  for (const r of read.ins) {
    const from = tr.mapping.map(r.from, 1);
    const to = tr.mapping.map(r.to, -1);
    markInserted(tr, from, to, who(move && restored ? { move } : {}), !move);
  }

  // Formatting: the first record of a run keeps the marks it had before; a run back at its old marks loses its record.
  if (o.formatting) {
    const fmt = schema.marks.formatChange;
    const ranges = read.fmt.map((f) => ({ ...f, from: tr.mapping.map(f.from, 1), to: tr.mapping.map(f.to, -1) }));
    const { id, author, date } = who();
    for (const f of ranges) {
      tr.doc.nodesBetween(f.from, f.to, (node, pos) => {
        if (!node.isInline || revOf(node, 'formatChange') || ownIns(node, me)) return !node.isInline;
        tr.addMark(Math.max(pos, f.from), Math.min(pos + node.nodeSize, f.to), fmt.create({ id, author, date, old: f.old }));
        return false;
      });
    }
    for (const f of ranges) {
      tr.doc.nodesBetween(f.from, f.to, (node, pos) => {
        const m = node.isInline && revOf(node, 'formatChange');
        if (!m) return !node.isInline;
        const old = Mark.setFrom((m.attrs.old ?? []).map((j) => schema.markFromJSON(j)));
        if (sameJson(formatJson(node.marks), old.map((x) => x.toJSON()))) tr.removeMark(pos, pos + node.nodeSize, m);
        return false;
      });
    }
  }

  // Paragraph properties: the first change keeps the old type and attributes; going back to them drops the record.
  for (const p of read.para) {
    const pos = tr.mapping.map(p.pos, 1);
    const node = tr.doc.nodeAt(pos);
    if (!node?.isTextblock) continue;
    const had = node.attrs.pChange;
    const old = had?.old ?? p.old;
    const now = { type: node.type.name, attrs: propsOf(node) };
    if (sameJson(now.type, old.type) && sameJson(now.attrs, Object.fromEntries(Object.keys(now.attrs).map((k) => [k, old.attrs?.[k] ?? null])))) {
      if (had) tr.setNodeAttribute(pos, 'pChange', null);
    } else if (!had) {
      const { id, author, date } = who();
      tr.setNodeAttribute(pos, 'pChange', { id, author, date, old });
    }
  }

  if (!tr.docChanged) return null;
  if (caret != null) tr.setSelection(Selection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size)), o.back ? -1 : 1));
  // A new author joins doc.attrs.people (patched, never rebuilt: comments writes it too).
  const people = state.doc.attrs.people ?? [];
  if ('people' in state.doc.attrs && !people.some((p) => p.name === me)) {
    tr.setDocAttribute('people', [...people, { name: me, initials: o.user.initials ?? '', color: authorColor(people, me) }]);
  }
  return tr.setMeta(trackKey, 'record').setMeta('track', true).setMeta('wordEngine', true);
}

/** Whether a root transaction is never recorded: undo and redo, the Suggestions plugin's own, one kept out of history, tracking's
 * own, a story write-back or refresh, and whatever `skip` adds (agent rounds, the comment story). */
export function skipRound(tr, skip) {
  return tr.getMeta('history$') != null || tr.getMeta('suggest') != null || tr.getMeta('addToHistory') === false || tr.getMeta('track') != null
    || tr.getMeta('wordEngine') != null || tr.getMeta('wordStoryRefresh') != null || !!skip?.(tr);
}

// The recording plugin's state when nothing waits for a composition to end.
const NONE = Object.freeze({ ranges: Object.freeze([]), cut: null });

/** The recording plugin. `opts`: {user() → {name, initials}, now() → ISO date, id() → string, settings() → {moves, formatting},
 * skip(tr) → true for rounds that are not the user's, on(doc) → whether recording is on (a story editor reads the main doc)}. While an IME composes, nothing changes the doc: the composed ranges wait
 * and are marked once composition ends, and a selection the composition replaced comes back then as a deletion. */
export function trackingPlugin(opts = {}) {
  const o = { user: () => ({ name: 'Author', initials: 'A' }), now: () => new Date().toISOString(), id: newId, settings: () => ({}), on: trackingOn, ...opts };
  let view = null;
  let timer = null;
  const options = (extra) => {
    const s = o.settings() ?? {};
    return { user: o.user(), date: o.now(), id: o.id, moves: s.moves !== false, formatting: s.formatting !== false, ...extra };
  };
  // Marks the composed ranges that waited and puts back the selection the composition replaced (`tr` on `state`, or a new
  // transaction) → the transaction or null.
  const flush = (state, tr) => {
    const { ranges, cut } = trackKey.getState(state) ?? NONE;
    if (!ranges.length && !cut) return tr ?? null;
    const t = tr ?? state.tr;
    const opt = options();
    const who = () => ({ id: opt.id(), author: opt.user.name, date: opt.date, move: null });
    const marks = [...ranges];
    // The selection comes back as a deletion before the composed text, unless the composition left it as it was.
    const gone = cut && cut.doc.slice(cut.from, cut.to);
    if (gone && !gone.content.eq(state.doc.slice(cut.a, Math.max(cut.a, cut.b)).content)) {
      restoreDeleted(t, { at: cut.a, slice: gone, from: cut.from, to: cut.to, doc: cut.doc }, opt.user.name, who, true);
      marks.push({ from: cut.a, to: cut.b });
    }
    for (const r of marks) markInserted(t, t.mapping.map(r.from, 1), t.mapping.map(r.to, -1), who());
    return t.setMeta(trackKey, 'flush').setMeta('track', true).setMeta('wordEngine', true);
  };
  // Set at compositionstart: the composition's first change replaces the selection, which flush puts back as a deletion. The
  // doc is never changed while an IME composes (Chromium writes the composition where the selection was before the change).
  let starting = false;
  return new Plugin({
    key: trackKey,
    state: {
      init: () => NONE,
      // {ranges: composed ranges waiting for their mark, cut: {from, to, doc, a, b}: the selection [from, to) of doc that the
      // composition replaced, and [a, b) where the composed text is now}.
      apply(tr, prev, old, state) {
        if (tr.getMeta(trackKey) === 'flush') return NONE;
        if (!tr.docChanged || (prev === NONE && !view?.composing)) return prev;
        const m = tr.mapping;
        const ranges = prev.ranges.map((r) => ({ from: m.map(r.from, 1), to: m.map(r.to, -1) })).filter((r) => r.to > r.from);
        let cut = prev.cut && { ...prev.cut, a: m.map(prev.cut.a, -1), b: m.map(prev.cut.b, 1) };
        if (view?.composing && o.on(state.doc) && !skipRound(tr, o.skip)) {
          if (starting) {
            starting = false;
            const { from, to, empty } = old.selection;
            if (!empty) cut = { from, to, doc: old.doc, a: m.map(from, -1), b: m.map(to, 1) };
          }
          tr.steps.forEach((step, i) => {
            if (!(step instanceof ReplaceStep) || !step.slice.size) return;
            const tail = m.slice(i + 1);
            ranges.push({ from: tail.map(step.from, 1), to: tail.map(step.from + step.slice.size, -1) });
          });
        }
        return { ranges, cut };
      },
    },
    view(v) {
      view = v;
      return { destroy: () => { view = null; clearTimeout(timer); } };
    },
    props: {
      handleDOMEvents: {
        compositionstart: (v) => {
          starting = !v.composing;
          return false;
        },
        compositionend: () => {
          starting = false;
          clearTimeout(timer);
          // After ProseMirror's own flush of the composition, unless a transaction has marked the ranges already.
          timer = setTimeout(() => {
            if (!view || view.composing || view.isDestroyed) return;
            const tr = flush(view.state, null);
            if (tr) view.dispatch(tr); // a flush that changes nothing still clears what waited
          }, 50);
          return false;
        },
      },
    },
    appendTransaction(trs, oldState, newState) {
      const at = trs.findIndex((t) => !t.getMeta('appendedTransaction'));
      if (at < 0 || view?.composing) return null;
      const root = trs[at];
      if (!root.docChanged || !o.on(newState.doc) || skipRound(root, o.skip)) return null;
      const sel = oldState.selection;
      const back = sel.empty && root.steps.length === 1 && root.steps[0] instanceof ReplaceStep && root.steps[0].to === sel.head && root.steps[0].from < sel.head;
      const tr = recordRound(root, trs.slice(at + 1), newState, options({ back }));
      return flush(newState, tr) ?? tr;
    },
  });
}
