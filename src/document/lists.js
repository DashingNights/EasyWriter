// Flat lists in a Document (docs/plans/document.md Lists, docs/plans/word plan.md §3 lists): a list item is an ordinary paragraph (or
// heading) whose numbering attribute {numId, ilvl} points into doc.attrs.numbering, as Word's w:numPr does, or whose paragraph
// style holds para.numbering (List Bullet, headings linked to a multilevel list). The commands keep TipTap's list command names
// (toggleBulletList, toggleOrderedList) so the shared text keys and doc.command reach them; a node decoration writes each label
// (numbering.mjs) into data-label, and document.css with the lists package's style.css draws it in the hanging indent. Also
// Word's Enter, Tab and Backspace rules, the AutoFormat list triggers, the Markdown of list paragraphs and the paste pre-pass
// (paste.js) for lists and quotes.
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { AttrStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { fontStack } from '../office.mjs';
import { DEFAULT_NUMBERING } from './defaults.mjs';
import {
  addNum, autoFormatList, backspaceStep, enterEmpty, firstLevelAs, kindOf, levelOf, listLabels, MAX_LEVEL, newListKey, numOf, patchLevels,
  setListFormat, setListLevels, settle, tabIndentStep,
} from './numbering.mjs';
import { normaliseHtml } from './paste.js';

export const numberingOf = (doc) => doc.attrs.numbering ?? DEFAULT_NUMBERING; // a Document made before step 4 may lack it

// The Word settings the keys and triggers read, bound by the lists package (src/document/wp/lists) to the app's settings; the
// defaults are Word's, so node tests and hidden session editors behave as a new install does.
let settingsNow = () => ({ autoformat: { tabIndent: true, bulletedLists: true, numberedLists: true }, editing: { normalForLists: false } });
/** Binds `fn` → the current settings.word (wordSettings of the app's settings). */
export const bindListSettings = (fn) => {
  settingsNow = fn;
};

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

/** Every numbered paragraph of `doc` in order: {node, pos, n} with n its numbering, its own or its style's (numOf). */
export function listItems(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const n = numOf(doc, node);
    if (n) out.push({ node, pos, n });
    return false;
  });
  return out;
}

/** The numId for new list paragraphs of `abstract` whose first one follows `above`: above's when it is in a list of that
 * definition (Word continues it), else a new num added to doc.attrs.numbering in `tr`, which restarts at 1. */
function numIdFor(tr, abstract, above, reuse = true) {
  const prev = above && numOf(tr.doc, above);
  if (reuse && prev && numberingOf(tr.doc).nums[prev.numId]?.abstract === abstract) return prev.numId;
  const { numbering, numId } = addNum(numberingOf(tr.doc), abstract);
  tr.setDocAttribute('numbering', numbering);
  return numId;
}

/** A transaction giving the lists that a paste, drop or insert brought into `state` (numbering holding `abstract`: newListKey,
 * or a copy from a Document, transformCopied) their nums, or null. A copy keeps its num when this Document has that num on
 * the same definition (a copy or move inside one Document stays in its list; a copy from another Document comes with keys
 * instead, transformPasted); any other list gets a new num, or merges into the list of its kind (bullet or number) directly above
 * it, as Word's "Merge pasted lists with surrounding lists" does. */
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
      const prev = above && numOf(tr.doc, above);
      const nb = numberingOf(tr.doc);
      const kind = (n.abstract === 'bullet' || nb.abstract[n.abstract]?.levels[0].fmt === 'bullet') ? 'bullet' : 'number';
      // A paragraph numbered through its style (a heading linked to a multilevel list, List Bullet) takes only a list of its own
      // definition, so a list pasted under a numbered heading never counts on from the heading numbers.
      const joins = prev && ![...made.values()].includes(prev.numId) && (above.attrs.numbering
        ? kindOf(nb, prev.numId) === kind : nb.nums[prev.numId]?.abstract === n.abstract);
      numId = joins ? prev.numId : numIdFor(tr, n.abstract, null);
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

/** Sets paragraph `node` at `pos` into a list as `numbering` in `tr`; a new list item of the Normal style takes List Paragraph, as
 * Word's do (unless settings.word.editing.normalForLists), and one leaving a list drops it again. */
export function setNum(tr, pos, node, numbering) {
  tr.setNodeAttribute(pos, 'numbering', numbering);
  if (node.type.name !== 'paragraph' || node.attrs.styleId === undefined) return;
  if (numbering && !node.attrs.styleId && !settingsNow().editing?.normalForLists) tr.setNodeAttribute(pos, 'styleId', 'ListParagraph');
  if (!numbering && node.attrs.styleId === 'ListParagraph') tr.setNodeAttribute(pos, 'styleId', null);
}

/** Bullets or Numbering on the selected paragraphs: off when every one is already in a list of that kind, else each joins one
 * list (the paragraph above's, or a new one) at its own level. */
const toggleList = (kind, abstract) => () => ({ state, tr, dispatch }) => {
  const paras = textblocks(state);
  if (!paras.length) return false;
  if (!dispatch) return true;
  const numbering = numberingOf(state.doc);
  if (paras.every(({ node }) => numOf(state.doc, node) && kindOf(numbering, numOf(state.doc, node).numId) === kind)) {
    for (const { node, pos } of paras) setNum(tr, pos, node, node.attrs.numbering || !numOf(state.doc, node) ? null : { numId: 0, ilvl: 0 });
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
  const next = setListFormat(numberingOf(state.doc), paras.map(({ node }) => numOf(state.doc, node)), abstract);
  if (next) {
    tr.setDocAttribute('numbering', next);
    return true;
  }
  const numId = numIdFor(tr, abstract, state.doc.resolve(paras[0].pos).nodeBefore);
  for (const { node, pos } of paras) setNum(tr, pos, node, { numId, ilvl: numOf(state.doc, node)?.ilvl ?? 0 });
  return true;
};

/** A library pick of level object `pick` (a bullet glyph or picture, a number format) over definition `base` ('bullet' or
 * 'decimal'): the selected lists' levels change when every paragraph is in a list of that kind, else the paragraphs start (or
 * join the list above of the same look) a list whose first level is `pick`. */
const applyListLevel = (pick, base) => ({ state, tr, dispatch }) => {
  const paras = textblocks(state);
  if (!paras.length) return false;
  if (!dispatch) return true;
  const numbering = numberingOf(state.doc);
  const next = setListLevels(numbering, paras.map(({ node }) => numOf(state.doc, node)), pick);
  if (next) {
    tr.setDocAttribute('numbering', next);
    return true;
  }
  const s = settle(numbering, firstLevelAs(pick, base));
  tr.setDocAttribute('numbering', s.numbering);
  const numId = numIdFor(tr, s.abstract, state.doc.resolve(paras[0].pos).nodeBefore);
  for (const { node, pos } of paras) setNum(tr, pos, node, { numId, ilvl: numOf(state.doc, node)?.ilvl ?? 0 });
  return true;
};

/** Runs list operation `op` ({numbering, all, sel, items, doc} → {numbering?, set: Map index → numbering, styles?} | null) over every
 * numbered paragraph (numbering.mjs restartAt, continueAt...): `all` their numbering in order, `sel` the indices the selection
 * touches. False when it declines. */
const listOp = (op) => ({ state, tr, dispatch }) => {
  const items = listItems(state.doc);
  const { from, to } = state.selection;
  const sel = items.map((it, k) => (it.pos + it.node.nodeSize > from && it.pos <= to ? k : -1)).filter((k) => k >= 0);
  const numbering = numberingOf(state.doc);
  const r = op({ numbering, all: items.map((it) => it.n), sel, items, doc: state.doc });
  if (!r) return false;
  if (!dispatch) return true;
  if (r.numbering && r.numbering !== numbering) tr.setDocAttribute('numbering', r.numbering);
  if (r.styles) tr.setDocAttribute('styles', r.styles);
  for (const [k, n] of r.set ?? []) tr.setNodeAttribute(items[k].pos, 'numbering', n);
  return true;
};

/** Moves the selected list paragraphs `d` levels (Tab and Shift+Tab, Word's Demote and Promote); false outside a list. */
const shiftLevel = (d) => () => ({ state, tr, dispatch }) => {
  const paras = textblocks(state).map((p) => ({ ...p, n: numOf(state.doc, p.node) })).filter((p) => p.n);
  if (!paras.length) return false;
  if (dispatch) {
    for (const { pos, n } of paras) {
      const ilvl = Math.min(MAX_LEVEL, Math.max(0, n.ilvl + d));
      if (ilvl !== n.ilvl) tr.setNodeAttribute(pos, 'numbering', { numId: n.numId, ilvl });
    }
  }
  return true;
};

const inTable = ($pos) => {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.spec.tableRole === 'cell' || $pos.node(d).type.spec.tableRole === 'header_cell') return true;
  return false;
};

/** Whether `pos` holds the first item of its list (Tab there moves the whole list in Word). */
function firstOfList(doc, pos, n) {
  for (const it of listItems(doc)) if (it.n.numId === n.numId) return it.pos === pos;
  return false;
}

// ---------- labels ----------
const labelsKey = new PluginKey('listLabels');

/** The run properties Word draws a number with: the paragraph mark's own (a .docx's markRun), then the level's (Define New Bullet
 * and Number Format's Font...: lvl.run); the paragraph's style gives the rest through CSS inheritance. */
export const labelRun = (node, lvl) => {
  const mark = node.attrs.markRun;
  return mark || lvl?.run ? { ...mark, ...lvl?.run } : null;
};

/** CSS variables for a label's own font (labelRun): {font, size, bold, italic, color}, a theme font through the doc's theme. */
const runVars = (run, theme) => (!run ? '' : [
  run.font && `--list-font: ${fontStack(run.font, theme)}`,
  run.size && `--list-size: ${run.size}pt`, run.bold != null && `--list-weight: ${run.bold ? 'bold' : 'normal'}`,
  run.italic != null && `--list-style: ${run.italic ? 'italic' : 'normal'}`, run.color && /^#[\da-f]{3,8}$/i.test(run.color) && `--list-color: ${run.color}`,
].filter(Boolean).map((s) => `; ${s}`).join(''));

/** The label decorations of `doc`: data-label (with the space a 'space' suffix adds), data-suff, data-jc and data-pic, and the level's
 * indents and label font as CSS variables, on every numbered paragraph. */
function labelDecos(doc) {
  const numbering = numberingOf(doc);
  const paras = listItems(doc);
  const labels = listLabels(paras.map((p) => p.n), numbering);
  return DecorationSet.create(doc, paras.flatMap(({ node, pos, n }, i) => {
    const lvl = levelOf(numbering, n.numId, n.ilvl);
    if (labels[i] == null) return [];
    const suff = lvl.suff ?? 'tab';
    const pic = lvl.fmt === 'bullet' && /^data:image\//.test(lvl.pic ?? '') ? lvl.pic : null;
    const attrs = { 'data-label': (pic ? '' : labels[i]) + (suff === 'space' ? ' ' : ''),
      style: `--list-left: ${lvl.left}pt; --list-hanging: ${lvl.hanging}pt${runVars(labelRun(node, lvl), doc.attrs.theme)}${pic ? `; --list-pic: url("${pic}")` : ''}` };
    if (suff !== 'tab') attrs['data-suff'] = suff;
    if (lvl.jc && lvl.jc !== 'left') attrs['data-jc'] = lvl.jc;
    if (pic) attrs['data-pic'] = '';
    return [Decoration.node(pos, pos + node.nodeSize, attrs)];
  }));
}

const numberedIn = (doc, from, to) => {
  let hit = false;
  doc.nodesBetween(from, Math.min(to, doc.content.size), (node) => {
    if (hit) return false;
    if (node.isTextblock && numOf(doc, node)) hit = true;
    return !node.isTextblock;
  });
  return hit;
};

/** Whether `tr` can change a label: it changes doc.attrs.numbering or styles (a style's numbering numbers its paragraphs), a node
 * attribute, or a range holding a numbered paragraph before or after the step. Typing outside lists and mark changes keep the
 * labels (docs/plans/document.md Risks). */
function touchesList(tr) {
  if (tr.before.attrs.numbering !== tr.doc.attrs.numbering || tr.before.attrs.styles !== tr.doc.attrs.styles) return true;
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

// ---------- AutoFormat ----------
/** The transaction that turns the paragraph at `$from` (whose text before the caret is the trigger) into the list the trigger
 * starts, or null: settings.word.autoformat bulletedLists and numberedLists gate it, and the trigger text goes. It is its own
 * undo step (closeHistory) and carries Word's 'wordAuto' meta (plan.md §1.3). */
function autoList(state, $from) {
  const p = $from.parent;
  if (p.attrs.numbering !== null || numOf(state.doc, p) || inTable($from)) return null;
  const typed = p.textBetween(0, $from.parentOffset, '', '￼').replace(/ $/, ''); // after handleTextInput typed the space
  const pick = autoFormatList(typed);
  const af = settingsNow().autoformat ?? {};
  if (!pick || (pick.kind === 'bullets' ? af.bulletedLists === false : af.numberedLists === false)) return null;
  const tr = closeHistory(state.tr);
  const start = $from.start();
  tr.delete(start, $from.pos);
  const numbering = numberingOf(tr.doc);
  const s = settle(numbering, firstLevelAs(pick, pick.kind === 'bullets' ? 'bullet' : 'decimal'));
  tr.setDocAttribute('numbering', s.numbering);
  const numId = numIdFor(tr, s.abstract, state.doc.resolve($from.before()).nodeBefore, pick.kind === 'bullets');
  setNum(tr, $from.before(), p, { numId, ilvl: 0 });
  return tr.setMeta('wordAuto', { kind: pick.kind, from: start, to: start, before: typed, label: pick.kind === 'bullets' ? 'Automatic bullets' : 'Automatic numbering' });
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

/** The list numbering block `b` (JSON) writes as a Markdown list item: its own or its style's (List Bullet), but a heading only its
 * own, since a heading linked to a multilevel list stays a Markdown heading. */
const mdNum = (doc, b) => (!b ? null : b.type === 'heading' ? b.attrs?.numbering : numOf(doc, b));

/** What goes between Markdown blocks `prev` and `next` (JSON): one line inside a list, so the list stays one Markdown list; a
 * blank line elsewhere and where another list starts at the first level. */
function blockGap(doc, prev, next) {
  const a = mdNum(doc, prev);
  const b = mdNum(doc, next);
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
    const n = mdNum(node, child);
    if (n && kindOf(numbering, n.numId)) {
      const marker = kindOf(numbering, n.numId) === 'bullet' ? '- ' : '1. ';
      text = `${' '.repeat(Array.from({ length: n.ilvl }, (_, k) => widths[k] ?? 2).reduce((s, w) => s + w, 0))}${marker}${text}`;
      widths[n.ilvl] = marker.length;
      widths.length = n.ilvl + 1;
    } else widths.length = 0;
    if (i) out += blockGap(node, node.content[i - 1], child);
    out += text;
  });
  return out;
}

/** The position of the first list paragraph the last paste brought in (Paste Options' Continue List and New List act on it). */
export const pastedListOf = (state) => labelsKey.getState(state)?.pasted ?? null;

/** The range a transaction's steps replaced, in its final doc → {from, to} or null. */
function changedRange(tr) {
  let from = Infinity;
  let to = -Infinity;
  tr.mapping.maps.forEach((map, i) => map.forEach((os, oe, ns, ne) => {
    const rest = tr.mapping.slice(i + 1);
    from = Math.min(from, rest.map(ns, -1));
    to = Math.max(to, rest.map(ne, 1));
  }));
  return from <= to ? { from, to } : null;
}

/** The Document's list commands, keys, AutoFormat triggers, labels, Markdown list parsing and paste pre-pass. */
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
      applyListLevel,
      listOp,
      sinkListLevel: shiftLevel(1),
      liftListLevel: shiftLevel(-1),
    };
  },

  addKeyboardShortcuts() {
    const para = () => this.editor.state.selection.$from.parent;
    const atStart = () => this.editor.state.selection.empty && this.editor.state.selection.$from.parentOffset === 0;
    const set = (attrs) => this.editor.commands.command(({ tr, state }) => {
      const pos = state.selection.$from.before();
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'numbering') setNum(tr, pos, state.doc.nodeAt(pos), v);
        else tr.setNodeAttribute(pos, k, v);
      }
      return true;
    });
    return {
      // Word: Tab at the start of a list item demotes it, and at the first item of a list moves the whole list one stop (U); over
      // several paragraphs it is Increase Indent; with autoformat.tabIndent, at the start of a paragraph with text it sets a
      // first-line indent and then raises the left indent; after an AutoFormat trigger it starts that list; elsewhere it types a
      // tab. Tables keep Tab for moving between cells.
      Tab: () => {
        const { state } = this.editor;
        const { selection } = state;
        if (inTable(selection.$from) || !selection.$from.parent.isTextblock || !selection.$to.parent.isTextblock) return false; // a selected canvas stays
        if (!selection.$from.sameParent(selection.$to)) return this.editor.commands.increaseIndent();
        const p = para();
        const n = numOf(state.doc, p);
        const tabIndent = settingsNow().autoformat?.tabIndent !== false;
        const stop = state.doc.attrs.settings?.defaultTabStop ?? 36;
        if (n && atStart()) {
          const pos = selection.$from.before();
          if (tabIndent && n.ilvl === 0 && firstOfList(state.doc, pos, n)) {
            return this.editor.commands.command(({ tr }) => !!tr.setDocAttribute('numbering',
              patchLevels(numberingOf(state.doc), n.numId, (levels) => levels.map((l) => ({ ...l, left: l.left + stop })))));
          }
          return this.editor.commands.sinkListLevel();
        }
        if (selection.empty) {
          const tr = autoList(state, selection.$from);
          if (tr) {
            this.editor.view.dispatch(tr);
            return true;
          }
        }
        if (!n && tabIndent && atStart() && p.content.size) return set({ indent: tabIndentStep(p.attrs.indent, stop) });
        return this.editor.commands.command(({ tr }) => !!tr.insertText('\t'));
      },
      'Shift-Tab': () => !inTable(this.editor.state.selection.$from) && this.editor.commands.liftListLevel(),
      // Enter on an empty list item promotes it one level, and at the first level ends the list (U).
      Enter: () => {
        const p = para();
        const n = numOf(this.editor.state.doc, p);
        if (!this.editor.state.selection.empty || !n || p.content.size) return false;
        const next = enterEmpty(n);
        return set({ numbering: next ?? (p.attrs.numbering ? null : { numId: 0, ilvl: 0 }) });
      },
      // Backspace at the start of a list item removes its number and keeps the text where it was; then it removes the indent;
      // then it joins as usual.
      Backspace: () => {
        if (!atStart()) return false;
        const p = para();
        const { doc } = this.editor.state;
        const n = numOf(doc, p);
        const step = backspaceStep({ numbered: !!n, indent: p.attrs.indent, level: n && levelOf(numberingOf(doc), n.numId, n.ilvl) },
          settingsNow().autoformat?.tabIndent !== false);
        if (!step) return false;
        if ('numbering' in step && !p.attrs.numbering) step.numbering = { numId: 0, ilvl: 0 }; // over a numbered style
        return set(step);
      },
    };
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
        init: (_, state) => ({ decos: labelDecos(state.doc), pasted: null }),
        apply: (tr, v) => {
          if (!tr.docChanged) return v;
          const decos = touchesList(tr) ? labelDecos(tr.doc) : v.decos.map(tr.mapping, tr.doc);
          let pasted = v.pasted == null ? null : tr.mapping.mapResult(v.pasted);
          pasted = pasted && !pasted.deleted ? pasted.pos : null;
          if (tr.getMeta('uiEvent') === 'paste') {
            const r = changedRange(tr);
            pasted = null;
            if (r) {
              tr.doc.nodesBetween(r.from, Math.min(r.to, tr.doc.content.size), (node, pos) => {
                if (pasted != null) return false;
                if (node.isTextblock && node.attrs.numbering) pasted = pos;
                return !node.isTextblock;
              });
            }
          }
          return { decos, pasted };
        },
      },
      appendTransaction: (trs, _, state) => (trs.some((tr) => tr.docChanged && touchesList(tr)) ? numberNewLists(state) : null),
      props: {
        decorations: (state) => labelsKey.getState(state).decos,
        // AutoFormat: a space typed after a trigger at a paragraph start ('1.', '(1)', '*', '->'...) starts the list. The space
        // is typed first, so Ctrl+Z gives back exactly what was typed.
        handleTextInput: (view, from, to, text) => {
          if (text !== ' ' || from !== to || !view.dom.isConnected) return false;
          const $from = view.state.doc.resolve(from);
          if (!$from.parent.isTextblock || !autoList(view.state, $from)) return false;
          const before = view.state.doc;
          view.dispatch(view.state.tr.insertText(' ', from, to));
          // A filter (protection, tracking) can drop or change the space: then the list waits, and the space stays as it went.
          const { doc } = view.state;
          if (doc === before || from + 1 > doc.content.size || doc.textBetween(from, from + 1) !== ' ') return true;
          const tr = autoList(view.state, doc.resolve(from + 1));
          if (!tr) return true;
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(from))).scrollIntoView());
          return true;
        },
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
