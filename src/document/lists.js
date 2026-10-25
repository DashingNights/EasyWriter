// Flat lists in a Document (docs/plans/document.md Lists): a list item is an ordinary paragraph (or heading) whose numbering
// attribute {numId, ilvl} points into doc.attrs.numbering, as Word's w:numPr does. The commands keep TipTap's list command
// names (toggleBulletList, toggleOrderedList) so the shared text keys and doc.command reach them; a node decoration writes each
// label (numbering.mjs) into data-label, and document.css draws it in the hanging indent. Also the Markdown of list paragraphs
// and the paste pre-pass (paste.js) for lists and quotes.
import { Extension, InputRule } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { AttrStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { DEFAULT_NUMBERING } from './defaults.mjs';
import { addNum, kindOf, levelOf, listLabels, newListKey, setListFormat } from './numbering.mjs';
import { normaliseHtml } from './paste.js';

const MAX_LEVEL = 8;
const numberingOf = (doc) => doc.attrs.numbering ?? DEFAULT_NUMBERING; // a Document made before step 4 may lack it

/** The paragraphs and headings the selection touches, with their positions (table cells included). */
export function textblocks(state) {
  const out = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (node.attrs.numbering !== undefined) out.push({ node, pos });
    return false;
  });
  return out;
}

/** The numId for new list paragraphs of `abstract` whose first one follows `above`: above's when it is in a list of that
 * definition (Word continues it), else a new num added to doc.attrs.numbering in `tr`, which restarts at 1. */
function numIdFor(tr, abstract, above, reuse = true) {
  const prev = above?.attrs.numbering;
  if (reuse && prev && numberingOf(tr.doc).nums[prev.numId]?.abstract === abstract) return prev.numId;
  const { numbering, numId } = addNum(numberingOf(tr.doc), abstract);
  tr.setDocAttribute('numbering', numbering);
  return numId;
}

/** A transaction giving the lists that a paste, drop or insert brought into `state` (numbering holding `abstract`: newListKey,
 * or a copy from a Document, transformCopied) their nums, or null. A copy keeps its num when this Document has that num on
 * the same definition (a copy or move inside one Document stays in its list; a copy from another Document comes with keys
 * instead, transformPasted); any other list gets a new num, or continues
 * an older list of its definition directly above it, as Word merges a pasted list into the list it lands under. */
function numberNewLists(state) {
  let tr = null;
  const made = new Map(); // key:abstract → numId
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const n = node.attrs.numbering;
    if (!n?.abstract) return false;
    tr ??= state.tr;
    const key = `${n.numId}:${n.abstract}`;
    let numId = numberingOf(tr.doc).nums[n.numId]?.abstract === n.abstract ? n.numId : made.get(key);
    if (numId == null) {
      const above = tr.doc.resolve(pos).nodeBefore;
      numId = numIdFor(tr, n.abstract, above, ![...made.values()].includes(above?.attrs.numbering?.numId));
      made.set(key, numId);
    }
    tr.setNodeAttribute(pos, 'numbering', { numId, ilvl: n.ilvl });
    return false;
  });
  return tr;
}

/** `frag` with each list paragraph's numbering n replaced by f(n) where that is not null (table cells included). */
function mapLists(frag, f) {
  const out = [];
  frag.forEach((node) => {
    const n = node.attrs.numbering && f(node.attrs.numbering);
    if (n) out.push(node.type.create({ ...node.attrs, numbering: n }, node.content, node.marks));
    else out.push(node.isTextblock || node.isLeaf ? node : node.copy(mapLists(node.content, f)));
  });
  return Fragment.from(out);
}

// The Document (docKey) whose copy or cut is on the clipboard. A tagged list pasted into any other Document gets new keys
// (transformPasted), so it never joins a list there that has the same numId: every new Document numbers its first list 3. Set
// by the copy and cut events only, since a drag serialises its slice too (transformCopied) but leaves the clipboard alone.
// ponytail: one record per renderer, so a copy from a second EasyWriter process pasted into the Document that copied last keeps
// its numIds; a copy key in the HTML would need a schema.js change.
let copiedFrom = null;

/** Bullets or Numbering on the selected paragraphs: off when every one is already in a list of that kind, else each joins one
 * list (the paragraph above's, or a new one) at its own level. */
const toggleList = (kind, abstract) => () => ({ state, tr, dispatch }) => {
  const paras = textblocks(state);
  if (!paras.length) return false;
  if (!dispatch) return true;
  const numbering = numberingOf(state.doc);
  if (paras.every(({ node }) => node.attrs.numbering && kindOf(numbering, node.attrs.numbering.numId) === kind)) {
    for (const { pos } of paras) tr.setNodeAttribute(pos, 'numbering', null);
    return true;
  }
  return applyList(abstract)({ state, tr, dispatch });
};

/** The selected paragraphs join one list of definition `abstract` (the Numbering library, doc.format's list), each at its own
 * level: the list of the paragraph above when it has that definition, else a new one. When every one is already in a list at a
 * level of the same kind (bullet or number), that level of those whole lists takes the definition's format instead, as Word's
 * Numbering library changes the list (setListFormat). */
const applyList = (abstract) => ({ state, tr, dispatch }) => {
  const paras = textblocks(state);
  if (!paras.length) return false;
  if (!dispatch) return true;
  const next = setListFormat(numberingOf(state.doc), paras.map(({ node }) => node.attrs.numbering), abstract);
  if (next) {
    tr.setDocAttribute('numbering', next);
    return true;
  }
  const numId = numIdFor(tr, abstract, state.doc.resolve(paras[0].pos).nodeBefore);
  for (const { node, pos } of paras) tr.setNodeAttribute(pos, 'numbering', { numId, ilvl: node.attrs.numbering?.ilvl ?? 0 });
  return true;
};

/** Moves the selected list paragraphs `d` levels (Tab and Shift+Tab, Word's Demote and Promote); false outside a list. */
const shiftLevel = (d) => () => ({ state, tr, dispatch }) => {
  const paras = textblocks(state).filter(({ node }) => node.attrs.numbering);
  if (!paras.length) return false;
  if (dispatch) {
    for (const { node, pos } of paras) {
      const n = node.attrs.numbering;
      const ilvl = Math.min(MAX_LEVEL, Math.max(0, n.ilvl + d));
      if (ilvl !== n.ilvl) tr.setNodeAttribute(pos, 'numbering', { ...n, ilvl });
    }
  }
  return true;
};

const inTable = ($pos) => {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.spec.tableRole === 'cell' || $pos.node(d).type.spec.tableRole === 'header_cell') return true;
  return false;
};

// ---------- labels ----------
const labelsKey = new PluginKey('listLabels');

/** The label decorations of `doc`: data-label and the level's indents (CSS variables) on every numbered paragraph. */
function labelDecos(doc) {
  const numbering = numberingOf(doc);
  const paras = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.attrs.numbering) paras.push({ node, pos });
    return false;
  });
  const labels = listLabels(paras.map(({ node }) => node.attrs.numbering), numbering);
  return DecorationSet.create(doc, paras.flatMap(({ node, pos }, i) => {
    const { numId, ilvl } = node.attrs.numbering;
    const lvl = levelOf(numbering, numId, ilvl);
    return labels[i] == null ? [] : [Decoration.node(pos, pos + node.nodeSize,
      { 'data-label': labels[i], style: `--list-left: ${lvl.left}pt; --list-hanging: ${lvl.hanging}pt` })];
  }));
}

const numberedIn = (doc, from, to) => {
  let hit = false;
  doc.nodesBetween(from, Math.min(to, doc.content.size), (node) => {
    if (hit) return false;
    if (node.attrs.numbering) hit = true;
    return !node.isTextblock;
  });
  return hit;
};

/** Whether `tr` can change a label: it changes doc.attrs.numbering, a node attribute, or a range holding a numbered paragraph
 * before or after the step. Typing outside lists and mark changes keep the labels (docs/plans/document.md Risks). */
function touchesList(tr) {
  if (tr.before.attrs.numbering !== tr.doc.attrs.numbering) return true;
  return tr.steps.some((step, i) => {
    if (step instanceof AttrStep) return true;
    const before = tr.docs[i];
    const after = tr.docs[i + 1] ?? tr.doc;
    let hit = false;
    step.getMap().forEach((os, oe, ns, ne) => {
      hit ||= numberedIn(before, os, oe) || numberedIn(after, ns, ne);
    });
    return hit;
  });
}

// ---------- markdown ----------
/** The paragraphs of a marked list token: one per item at its level (nested lists one level deeper), numbered as a new list
 * (newListKey: `key` for the whole list, its nested lists included); an item's later paragraphs stay out of the list,
 * indented to its text. */
function listParagraphs(token, h, ilvl = 0, key = newListKey()) {
  const numbering = { numId: key, abstract: token.ordered ? 'decimal' : 'bullet' };
  const out = [];
  for (const item of token.items ?? []) {
    let first = true;
    for (const t of item.tokens ?? []) {
      if (t.type === 'list') {
        out.push(...listParagraphs(t, h, Math.min(MAX_LEVEL, ilvl + 1), key));
        continue;
      }
      const blocks = t.type === 'text' ? [{ type: 'paragraph', content: h.parseInline(t.tokens ?? [{ type: 'text', raw: t.text, text: t.text }]) }]
        : [h.parseChildren([t])].flat().filter(Boolean);
      for (const b of blocks) {
        if (b.type === 'paragraph' || b.type === 'heading') {
          b.attrs = { ...b.attrs, ...(first ? { numbering: { ...numbering, ilvl } } : { indent: { left: 36 * (ilvl + 1) } }) };
          first = false;
        }
        out.push(b);
      }
    }
    if (first) out.push({ type: 'paragraph', attrs: { numbering: { ...numbering, ilvl } }, content: [] });
  }
  return out;
}

/** What goes between Markdown blocks `prev` and `next` (JSON): one line inside a list, so the list stays one Markdown list; a
 * blank line elsewhere and where another list starts at the first level. */
function blockGap(prev, next) {
  const a = prev?.attrs?.numbering;
  const b = next?.attrs?.numbering;
  return a && b && !(b.ilvl === 0 && a.ilvl === 0 && a.numId !== b.numId) ? '\n' : '\n\n';
}

/** The doc's Markdown (DocNode renderMarkdown): blocks apart by blockGap, a list paragraph as '- ' or '1. ' (Markdown counts
 * the items) indented under its parent item's text (two spaces under a bullet, three under '1. '). */
export function docMarkdown(node, h) {
  const numbering = node.attrs?.numbering ?? DEFAULT_NUMBERING;
  const widths = []; // marker width per level of the list being written
  let out = '';
  (node.content ?? []).forEach((child, i) => {
    let text = h.renderChild(child, i);
    const n = child.attrs?.numbering;
    if (n) {
      const marker = kindOf(numbering, n.numId) === 'bullet' ? '- ' : '1. ';
      text = `${' '.repeat(Array.from({ length: n.ilvl }, (_, k) => widths[k] ?? 2).reduce((s, w) => s + w, 0))}${marker}${text}`;
      widths[n.ilvl] = marker.length;
      widths.length = n.ilvl + 1;
    } else widths.length = 0;
    if (i) out += blockGap(node.content[i - 1], child);
    out += text;
  });
  return out;
}

/** The Document's list commands, keys, input rules, labels, Markdown list parsing and paste pre-pass. */
export const Lists = Extension.create({
  name: 'lists',
  priority: 102, // its Enter and Backspace run before ParaProps' (101) and TipTap's
  markdownTokenName: 'list',
  parseMarkdown: (token, h) => listParagraphs(token, h),

  addCommands() {
    return {
      toggleBulletList: toggleList('bullet', 'bullet'),
      toggleOrderedList: toggleList('number', 'decimal'),
      applyList,
      sinkListLevel: shiftLevel(1),
      liftListLevel: shiftLevel(-1),
    };
  },

  addKeyboardShortcuts() {
    const para = () => this.editor.state.selection.$from.parent;
    const atStart = () => this.editor.state.selection.empty && this.editor.state.selection.$from.parentOffset === 0;
    return {
      // Word: Tab at the start of a list item demotes it; over several paragraphs it is Increase Indent (list items demote,
      // other paragraphs indent when none is in a list); elsewhere it types a tab. Tables keep Tab for moving between cells.
      Tab: () => {
        const { selection } = this.editor.state;
        if (inTable(selection.$from) || !selection.$from.parent.isTextblock || !selection.$to.parent.isTextblock) return false; // a selected canvas stays
        if (!selection.$from.sameParent(selection.$to)) return this.editor.commands.increaseIndent();
        if (para().attrs.numbering && atStart()) return this.editor.commands.sinkListLevel();
        return this.editor.commands.command(({ tr }) => !!tr.insertText('\t'));
      },
      'Shift-Tab': () => !inTable(this.editor.state.selection.$from) && this.editor.commands.liftListLevel(),
      // Enter on an empty list item ends the list.
      Enter: () => {
        const p = para();
        if (!this.editor.state.selection.empty || !p.attrs.numbering || p.content.size) return false;
        return this.editor.commands.updateAttributes(p.type.name, { numbering: null });
      },
      // Backspace at the start of a list item removes its number and keeps the text where it was; at the start of an indented
      // paragraph it removes the indent; then it joins as usual.
      Backspace: () => {
        if (!atStart()) return false;
        const p = para();
        const n = p.attrs.numbering;
        if (n) {
          const lvl = levelOf(numberingOf(this.editor.state.doc), n.numId, n.ilvl);
          return this.editor.commands.updateAttributes(p.type.name, { numbering: null, indent: lvl ? { ...p.attrs.indent, left: p.attrs.indent?.left ?? lvl.left } : p.attrs.indent });
        }
        const { left, firstLine, right } = p.attrs.indent ?? {};
        if (left || firstLine) return this.editor.commands.updateAttributes(p.type.name, { indent: right != null ? { right } : null });
        return false;
      },
    };
  },

  addInputRules() {
    // Word's AutoFormat: '- ' or '* ' starts bullets (joining a bulleted paragraph above), '1. ' and 'a) ' a new numbered list.
    const rule = (find, abstract, reuse) => new InputRule({
      find,
      handler: ({ state, range }) => {
        const $from = state.doc.resolve(range.from);
        const p = $from.parent;
        if (p.attrs.numbering !== null) return null;
        const { tr } = state;
        tr.delete(range.from, range.to);
        const numId = numIdFor(tr, abstract, state.doc.resolve($from.before()).nodeBefore, reuse);
        tr.setNodeAttribute($from.before(), 'numbering', { numId, ilvl: 0 });
      },
    });
    return [rule(/^\s*[-*]\s$/, 'bullet', true), rule(/^1\.\s$/, 'decimal', false), rule(/^a\)\s$/, 'lowerLetterParen', false)];
  },

  addProseMirrorPlugins() {
    let external = false; // the HTML being pasted has no data-pm-slice: it comes from outside ProseMirror (Word, a web page)
    let dropping = false; // a drop is being handled (its slice comes from this editor only when view.dragging is set)
    const owner = {}; // this editor
    // The open Document: its draft id when the editor's element names it (data-doc-id, actions.js makeEditor), so a reopened
    // Document is the same one; else this editor.
    const docKey = (view) => view.dom.getAttribute('data-doc-id') || owner;
    const copied = (view) => {
      if (!view.state.selection.empty) copiedFrom = docKey(view); // an empty selection copies nothing
      return false;
    };
    return [new Plugin({
      key: labelsKey,
      state: {
        init: (_, state) => labelDecos(state.doc),
        apply: (tr, set) => (!tr.docChanged ? set : touchesList(tr) ? labelDecos(tr.doc) : set.map(tr.mapping, tr.doc)),
      },
      appendTransaction: (trs, _, state) => (trs.some((tr) => tr.docChanged && touchesList(tr)) ? numberNewLists(state) : null),
      props: {
        decorations: (state) => labelsKey.getState(state),
        handleDOMEvents: {
          copy: copied,
          cut: copied,
          drop: () => {
            dropping = true;
            setTimeout(() => { dropping = false; }); // a drop another handler took never reaches transformPasted
            return false;
          },
        },
        transformPastedHTML: (html, view) => {
          external = !/data-pm-slice/.test(html);
          return normaliseHtml(html, numberingOf(view.state.doc));
        },
        // A paste opens its first paragraph into the one at the cursor, which keeps the cursor paragraph's attributes, so a
        // pasted list would lose its first number. A slice that starts with a list paragraph and holds a paragraph end (or
        // comes from outside) pastes it whole instead (into an empty paragraph it replaces it), as Word keeps the pasted list's
        // numbering; a few words copied from inside one list item still paste inline. Drops run this too.
        transformPasted: (slice, view) => {
          // A drop from this editor (view.dragging), or a paste of this Document's copy, keeps its lists' nums.
          const same = view.dragging ? true : !dropping && copiedFrom === docKey(view);
          dropping = false;
          if (!same) {
            // From another Document: each of its lists gets a key of its own, so numberNewLists numbers it here as a new list.
            const keys = new Map(); // its numId → key
            slice = new Slice(mapLists(slice.content, (n) => n.abstract && { ...n, numId: keys.get(n.numId) ?? keys.set(n.numId, newListKey()).get(n.numId) }),
              slice.openStart, slice.openEnd);
          }
          const first = slice.content.firstChild;
          const whole = external || slice.content.childCount > 1;
          external = false;
          return whole && slice.openStart === 1 && first?.isTextblock && first.attrs.numbering ? new Slice(slice.content, 0, slice.openEnd) : slice;
        },
        // A copy or drag names each list paragraph's definition, so a paste into another Document makes the same kind of list.
        transformCopied: (slice, view) => {
          const { nums } = numberingOf(view.state.doc);
          return new Slice(mapLists(slice.content, (n) => nums[n.numId]?.abstract && { ...n, abstract: nums[n.numId].abstract }), slice.openStart, slice.openEnd);
        },
      },
    })];
  },
});
