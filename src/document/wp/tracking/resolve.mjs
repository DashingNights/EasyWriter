// Accept and Reject of tracked changes (docs/plans/word/briefs/tracking.md): one transform over the picked revisions, applied from
// the end of the doc so every position read before stays right. Accept keeps inserted text, removes deleted text, drops format and
// paragraph property records, clears inserted paragraph marks, joins paragraphs whose mark was deleted, clears inserted rows and
// removes deleted ones; Reject is the inverse. Stories (headers, footers, notes, comments) are rewritten in their attributes through
// writeStory. Pure: Node tests run it.
import { Mark } from '@tiptap/pm/model';
import { canJoin, Transform } from '@tiptap/pm/transform';
import { storiesOf, storyDoc } from '../../model/blocks.mjs';
import { NOT_FORMAT, REV_MARKS } from './record.mjs';

const REV = [...REV_MARKS];
const who = (r) => ({ id: r.id, author: r.author });

/** Whether `doc` holds a tracked change (the body only; stories through hasStoryRevisions). */
export function hasRevisions(doc) {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    const a = node.attrs;
    if (node.marks.some((m) => REV.includes(m.type.name)) || a.markRev || a.pChange || a.rev) found = true;
    return !found;
  });
  return found;
}

/** Resolves the revisions `pick({kind, id, author, move})` selects in `tr` (a Transform or Transaction): `action` 'accept' or
 * 'reject'. With `range` {from, to} only that part resolves, as Word does for a selection: text is cut to it, and a paragraph mark
 * counts when it lies inside it. → the number of revisions resolved. */
export function resolveIn(tr, action, pick = () => true, range = null) {
  const accept = action === 'accept';
  const schema = tr.doc.type.schema;
  const ops = []; // {pos, prio, fn}; applied by descending pos, then descending prio (attribute changes before joins at one pos)
  const ids = new Set();
  const take = (kind, r) => {
    if (!r || !pick({ kind, ...r })) return false;
    ids.add(r.id);
    return true;
  };
  const visit = (node, pos) => {
    const end = pos + node.nodeSize;
    if (node.isInline) {
      // With a range only the covered part of the text resolves; the rest keeps its mark.
      const lo = range ? Math.max(pos, range.from) : pos;
      const hi = range ? Math.min(end, range.to) : end;
      if (lo >= hi) return false;
      const m = Object.fromEntries(REV.map((n) => [n, node.marks.find((x) => x.type.name === n)?.attrs ?? null]));
      const ins = take('insert', m.insertion);
      const del = take('delete', m.deletion);
      const fmt = take('format', m.formatChange);
      if ((accept && del) || (!accept && ins)) {
        ops.push({ pos: lo, prio: 0, fn: () => tr.delete(lo, hi) });
        return false;
      }
      const markOf = (name) => node.marks.find((x) => x.type.name === name);
      if (ins) ops.push({ pos: lo, prio: 0, fn: () => tr.removeMark(lo, hi, markOf('insertion')) });
      if (del) ops.push({ pos: lo, prio: 0, fn: () => tr.removeMark(lo, hi, markOf('deletion')) });
      if (fmt) {
        ops.push({ pos: lo, prio: 0, fn: () => {
          if (!accept) {
            for (const x of node.marks) if (!NOT_FORMAT.has(x.type.name)) tr.removeMark(lo, hi, x);
            for (const x of Mark.setFrom((m.formatChange.old ?? []).map((j) => schema.markFromJSON(j)))) tr.addMark(lo, hi, x);
          }
          tr.removeMark(lo, hi, markOf('formatChange'));
        } });
      }
      return false;
    }
    const a = node.attrs;
    if (node.isTextblock) {
      // A paragraph mark sits at end - 1; with a range it resolves only when the range holds it.
      const mr = range && (end - 1 < range.from || end - 1 >= range.to) ? {} : a.markRev ?? {};
      const insM = take('paraMark', mr.ins && who(mr.ins));
      const delM = take('paraMark', mr.del && who(mr.del));
      if (insM || delM) {
        const rest = { ...mr };
        if (insM) delete rest.ins;
        if (delM) delete rest.del;
        const clear = () => tr.setNodeAttribute(pos, 'markRev', Object.keys(rest).length ? rest : null);
        // The paragraph mark goes (an accepted deletion, a rejected insertion): this paragraph joins the next, which keeps its own mark.
        if ((accept && delM) || (!accept && insM)) {
          ops.push({ pos: end, prio: 0, fn: () => {
            if (!canJoin(tr.doc, end)) return clear();
            const next = tr.doc.nodeAt(end);
            tr.join(end);
            tr.setNodeAttribute(pos, 'markRev', next?.attrs.markRev ?? null);
          } });
        } else ops.push({ pos, prio: 1, fn: clear });
      }
      if (a.pChange && take('paraProps', who(a.pChange))) {
        const old = a.pChange.old;
        ops.push({ pos, prio: 1, fn: () => {
          const type = !accept && old?.type ? schema.nodes[old.type] : null;
          if (!type) return tr.setNodeAttribute(pos, 'pChange', null);
          const cur = tr.doc.nodeAt(pos).attrs;
          const attrs = Object.fromEntries(Object.keys(type.spec.attrs ?? {}).map((k) => [k, k in (old.attrs ?? {}) ? old.attrs[k] : cur[k] ?? null]));
          tr.setNodeMarkup(pos, type, { ...attrs, pChange: null, markRev: cur.markRev ?? null });
        } });
      }
      return true;
    }
    if (a.rev) {
      const insR = take(node.type.name === 'tableRow' ? 'row' : 'insert', a.rev.ins && who(a.rev.ins));
      const delR = take(node.type.name === 'tableRow' ? 'row' : 'delete', a.rev.del && who(a.rev.del));
      if ((accept && delR) || (!accept && insR)) {
        ops.push({ pos, prio: 1, fn: () => {
          const $p = tr.doc.resolve(pos);
          // The table's last row going takes the table with it.
          if (node.type.name === 'tableRow' && $p.parent.childCount === 1) tr.delete($p.before(), $p.after());
          else tr.delete(pos, pos + node.nodeSize);
        } });
        return false;
      }
      if (insR || delR) {
        const rest = { ...a.rev };
        if (insR) delete rest.ins;
        if (delR) delete rest.del;
        ops.push({ pos, prio: 1, fn: () => tr.setNodeAttribute(pos, 'rev', Object.keys(rest).length ? rest : null) });
      }
    }
    return true;
  };
  if (range) tr.doc.nodesBetween(range.from, range.to, visit);
  else tr.doc.descendants(visit);
  ops.sort((x, y) => y.pos - x.pos || y.prio - x.prio);
  for (const op of ops) op.fn();
  return ids.size;
}

/** Writes story `s` (storiesOf: {at, content, holder}) back with `content` (block JSON) in `tr`, in the shape its attribute had. */
export function writeStory(tr, s, content) {
  const shaped = (v) => (Array.isArray(v) ? content : { ...v, content });
  const { at, holder } = s;
  if (at.story === 'header' || at.story === 'footer') {
    const key = at.story === 'header' ? 'hdr' : 'ftr';
    const sect = holder == null ? tr.doc.attrs.sect : tr.doc.nodeAt(holder).attrs.sect;
    const next = { ...sect, [key]: { ...sect[key], [at.part]: shaped(sect[key][at.part]) } };
    if (holder == null) tr.setDocAttribute('sect', next);
    else tr.setNodeAttribute(holder, 'sect', next);
  } else if (at.story === 'note') {
    tr.setNodeAttribute(holder, 'content', shaped(tr.doc.nodeAt(holder).attrs.content));
  } else if (at.story === 'comment') {
    const all = tr.doc.attrs.comments ?? {};
    tr.setDocAttribute('comments', { ...all, [at.id]: { ...all[at.id], content: shaped(all[at.id].content) } });
  }
}

/** Resolves the picked revisions of every story of `tr`'s doc, each written back through writeStory. → the number resolved.
 * Runs before any body change, so the holders' positions are still right. */
export function resolveStories(tr, action, pick = () => true) {
  let n = 0;
  for (const s of storiesOf(tr.doc)) {
    let sd;
    try {
      sd = storyDoc(tr.doc.type.schema, s.content);
    } catch {
      continue;
    }
    if (!hasRevisions(sd)) continue;
    const t = new Transform(sd);
    const k = resolveIn(t, action, pick);
    if (!k || !t.docChanged) continue;
    n += k;
    writeStory(tr, s, t.doc.toJSON().content);
  }
  return n;
}

/** Accept or reject (`action`) the picked tracked changes of `state` in the body and, with `stories`, every story → a transaction
 * marked as tracking's own (never recorded), or null when nothing was picked. */
export function resolveTr(state, action, pick = () => true, { stories = false, range = null } = {}) {
  const tr = state.tr;
  const n = (stories ? resolveStories(tr, action, pick) : 0) + resolveIn(tr, action, pick, range);
  if (!n) return null;
  return tr.setMeta('track', action).setMeta('wordEngine', true);
}
