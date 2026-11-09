// Word's multiple and column (block) selection (briefs/editing-keys.md): one Selection holding several ranges. ProseMirror draws
// one DOM selection, so the last range (the head range) is the DOM one and the others are decorations (plugin.js). Mark commands
// iterate selection.ranges, so Bold and the other run formats reach every range; copy joins the ranges in document order, one
// paragraph per range.
// ponytail: formatting only per range; typing, deleting and every other edit act on the head range alone. Per-range edits
// would need each command to loop the ranges (plan.md §6 Risks).
import { Fragment, Slice } from '@tiptap/pm/model';
import { Selection, SelectionRange, TextSelection } from '@tiptap/pm/state';

export class MultiSelection extends Selection {
  /** `ranges` as [SelectionRange]; the last is the head range, which the DOM shows. */
  constructor(ranges) {
    const head = ranges.at(-1);
    super(head.$from, head.$to, ranges);
  }

  map(doc, mapping) {
    const ranges = this.ranges.map((r) => new SelectionRange(doc.resolve(mapping.map(r.$from.pos)), doc.resolve(mapping.map(r.$to.pos))))
      .filter((r) => r.$from.pos < r.$to.pos);
    if (!ranges.length) return TextSelection.create(doc, mapping.map(this.head));
    return ranges.length === 1 ? TextSelection.create(doc, ranges[0].$from.pos, ranges[0].$to.pos) : new MultiSelection(ranges);
  }

  /** Every range's content in document order, one paragraph per range (copy joins them with line breaks). */
  content() {
    const doc = this.$from.doc;
    const sorted = [...this.ranges].sort((a, b) => a.$from.pos - b.$from.pos);
    const paras = sorted.flatMap((r) => {
      const c = doc.slice(r.$from.pos, r.$to.pos).content;
      if (c.childCount > 1) return c.content; // a range across paragraphs keeps its blocks as they are
      const block = r.$from.parent.isTextblock ? r.$from.parent : doc.type.schema.nodes.paragraph.create();
      return [block.type.create(block.attrs, c.firstChild?.isTextblock ? c.firstChild.content : c)];
    });
    return new Slice(Fragment.from(paras), 1, 1);
  }

  /** Typing or pasting over it replaces the head range only. */
  replace(tr, content = Slice.empty) {
    TextSelection.create(tr.doc, this.$from.pos, this.$to.pos).replace(tr, content);
  }

  replaceWith(tr, node) {
    TextSelection.create(tr.doc, this.$from.pos, this.$to.pos).replaceWith(tr, node);
  }

  eq(other) {
    return other instanceof MultiSelection && other.ranges.length === this.ranges.length
      && other.ranges.every((r, i) => r.$from.pos === this.ranges[i].$from.pos && r.$to.pos === this.ranges[i].$to.pos);
  }

  toJSON() {
    return { type: 'wordMulti', ranges: this.ranges.map((r) => ({ from: r.$from.pos, to: r.$to.pos })) };
  }

  static fromJSON(doc, json) {
    return MultiSelection.of(doc, json.ranges);
  }

  /** A selection of `doc` over `list` ([{from, to}]): a MultiSelection for two or more ranges, a TextSelection for one. */
  static of(doc, list) {
    const ok = list.map(({ from, to }) => [Math.min(from, to), Math.max(from, to)]).filter(([a, b]) => a < b && b <= doc.content.size);
    if (ok.length < 2) return ok.length ? TextSelection.create(doc, ok[0][0], ok[0][1]) : null;
    return new MultiSelection(ok.map(([a, b]) => new SelectionRange(doc.resolve(a), doc.resolve(b))));
  }
}

// One registration per page: a module reloaded in place would throw on the second.
try {
  Selection.jsonID('wordMulti', MultiSelection);
} catch { /* already registered */ }
