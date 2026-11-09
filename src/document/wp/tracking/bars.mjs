// Change bars (Display for Review): each paragraph with a tracked change gets data-changed through a node decoration, so the markup
// sheet draws its bar with a plain attribute selector. A :has() rule did the same in CSS but cost the style engine about 8 ms a
// keypress in a 50-page document. Only the paragraphs a transaction touched are read again. Pure: Node tests run it.
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { REV_MARKS as REV } from './record.mjs';

export const barsKey = new PluginKey('wordTrackingBars');

/** Whether textblock `node` holds a tracked change: changed text in it, a changed paragraph mark or changed properties. */
export function changedBlock(node) {
  if (node.attrs.markRev || node.attrs.pChange) return true;
  let found = false;
  node.forEach((child) => {
    if (!found && child.marks.some((m) => REV.has(m.type.name))) found = true;
  });
  return found;
}

// The bar decorations of the textblocks between `from` and `to` of `doc`.
function barsIn(doc, from, to) {
  const out = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (changedBlock(node)) out.push(Decoration.node(pos, pos + node.nodeSize, { 'data-changed': '' }));
    return false;
  });
  return out;
}

export function barsPlugin() {
  return new Plugin({
    key: barsKey,
    state: {
      init: (_, state) => DecorationSet.create(state.doc, barsIn(state.doc, 0, state.doc.content.size)),
      apply(tr, set) {
        if (!tr.docChanged) return set;
        let next = set.map(tr.mapping, tr.doc);
        const size = tr.doc.content.size;
        // Reads again the top-level blocks around [from, to] of step `i`'s output, mapped to the final doc.
        const redo = (i, from, to) => {
          const tail = tr.mapping.slice(i + 1);
          const a = tr.doc.resolve(Math.min(tail.map(from, -1), size));
          const b = tr.doc.resolve(Math.min(tail.map(to, 1), size));
          const lo = a.depth ? a.before(1) : a.pos;
          const hi = b.depth ? b.after(1) : Math.min(b.pos + (b.nodeAfter?.nodeSize ?? 0), size);
          next = next.remove(next.find(lo, hi).filter((d) => d.from >= lo && d.to <= hi)).add(tr.doc, barsIn(tr.doc, lo, hi));
        };
        // Replace steps name their written range in the map; mark and attribute steps write none, so their own from/to or pos.
        tr.steps.forEach((step, i) => {
          tr.mapping.maps[i].forEach((_a, _b, from, to) => redo(i, from, to));
          const j = step.toJSON();
          const from = j.from ?? j.pos;
          if (from != null && j.stepType !== 'replace' && j.stepType !== 'replaceAround') redo(i, from, j.to ?? from);
        });
        return next;
      },
    },
    props: { decorations: (state) => barsKey.getState(state) },
  });
}
