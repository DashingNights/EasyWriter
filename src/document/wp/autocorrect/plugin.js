// AutoCorrect and AutoFormat As You Type in a Document (docs/plans/word plan.md §3 autocorrect, §1.3 wordAuto). Only typed input
// fires a rule (handleTextInput, Enter and Tab): pastes, drops and agent edits never reach these handlers, and a forum post's kit
// carries none of this. Each automatic change is its own undo step right after the typed text (closeHistory before it, and an empty
// closeHistory after it so the next typing starts a step of its own), so Ctrl+Z restores what was typed, as in Word.
import { Extension } from '@tiptap/core';
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history';
import { Mark } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { AddMarkStep } from '@tiptap/pm/transform';
import { getState } from '../../../app/store.js';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { drawButton } from './button.js';
import { autoFormatPlan, columnWidths, correct, enterRule, headingOf, optionsOf } from './rules.mjs';

export const autoKey = new PluginKey('wordAutocorrect');
/** The Word settings now (settings.word with defaults). */
export const word = () => wordSettings(getState().settings);

/** A textblock's characters up to offset `end` with the document position of each → {text, at}. A hard break reads as a line
 * break and any other inline leaf as U+FFFC, one character each, so offsets map to positions one to one. */
export function charsOf(block, base, end = block.content.size) {
  let text = '';
  const at = [];
  block.descendants((node, p) => {
    if (p >= end) return false;
    if (node.isText) {
      const t = node.text.slice(0, end - p);
      for (let i = 0; i < t.length; i++) at.push(base + p + i);
      text += t;
      return false;
    }
    if (node.isLeaf) {
      text += node.type.name === 'hardBreak' ? '\n' : '￼';
      at.push(base + p);
      return false;
    }
    return true;
  });
  return { text, at };
}

/** Applies edit `e` (rules.mjs) to `tr`, `pos(k)` giving the document position of text offset k → the edit's new end position. */
export function applyEdit(tr, e, pos) {
  const { schema } = tr.doc.type;
  const from = pos(e.from);
  const to = pos(e.to - 1) + 1;
  if (e.insert != null) {
    const base = e.marks ? e.marks.map((m) => Mark.fromJSON(schema, m)) : tr.doc.nodeAt(from)?.marks ?? [];
    const marks = e.mark ? schema.marks[e.mark.type].create(e.mark.attrs).addToSet(base) : base;
    if (e.insert) tr.replaceWith(from, to, schema.text(e.insert, marks));
    else tr.delete(from, to);
    return from + e.insert.length;
  }
  if (e.mark) tr.addMark(from, to, schema.marks[e.mark.type].create(e.mark.attrs));
  return to;
}

/** Dispatches the automatic change `fill(tr)` as its own undo step with meta wordAuto `meta`, then closes it. */
function dispatchAuto(view, meta, fill) {
  const tr = closeHistory(view.state.tr);
  const end = fill(tr);
  if (!tr.docChanged) return false;
  tr.setMeta('wordAuto', { ...meta, to: end ?? meta.to }).setMeta('preventAutolink', true);
  view.dispatch(tr);
  view.dispatch(closeHistory(view.state.tr));
  return true;
}

const spell = () => globalThis.__wordTest?.spell ?? globalThis.window?.api?.word?.spell ?? null;
const inCell = ($pos) => {
  for (let d = $pos.depth; d > 0; d--) if (/^table(Cell|Header)$/.test($pos.node(d).type.name)) return true;
  return false;
};

let capsLock = false; // the Caps Lock state at the last key press (a text input event carries none)

/** Applies `edits` of the text before the caret (positions `pos`) as one automatic change; the first edit names its kind. */
function applyEdits(view, edits, pos) {
  if (!edits.length) return false;
  const first = edits[0];
  return dispatchAuto(view, { kind: first.kind, rule: first.rule, prev: first.prev, from: pos(first.from), to: pos(first.to - 1) + 1, before: first.label, label: first.label },
    (tr) => {
      let end = null;
      let steps = 0;
      for (const e of [...edits].sort((a, b) => b.from - a.from)) {
        const at = applyEdit(tr, e, pos);
        if (e === first) [end, steps] = [at, tr.steps.length];
      }
      // Edits left of the first one, applied after it, shift its end.
      return tr.mapping.slice(steps).map(end);
    });
}

/** The edits that a word finished at the caret by `ch` makes in `state` → {edits, pos}. */
function editsAt(state, from, ch) {
  const $from = state.doc.resolve(from);
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return { edits: [] };
  const { text, at } = charsOf($from.parent, $from.start(), $from.parentOffset);
  const pos = (k) => (k < at.length ? at[k] : from + (k - at.length));
  const ctx = { inCell: inCell($from), capsLock, spell: spell(),
    linked: (a, b) => b > a && state.doc.rangeHasMark(pos(a), pos(b - 1) + 1, state.schema.marks.link) };
  return { edits: correct(text + ch, optionsOf(word()), ctx), pos };
}

/** Marks for a character typed at `$from` that continue the previous list item's formatted lead-in (Format beginning of list item
 * like the one before it), or null. */
function leadMarks($from) {
  const p = $from.parent;
  const num = p.attrs.numbering;
  if (!num) return null;
  const prev = $from.doc.resolve($from.before()).nodeBefore;
  const lead = prev?.firstChild;
  if (prev?.attrs?.numbering?.numId !== num.numId || !lead?.isText || !lead.marks.length || prev.childCount < 2) return null;
  const off = $from.parentOffset;
  const mine = p.firstChild;
  const same = (n) => !!n && n.isText && Mark.sameSet(n.marks, lead.marks);
  if (off === 0 && !p.content.size) return lead.marks;
  if (off < lead.text.length && same(mine) && mine.text.length >= off) return lead.marks;
  if (off === lead.text.length && same(mine) && mine.text.length === off) return prev.child(1).marks;
  return null;
}

/** handleTextInput: a typed character that finishes a rule is inserted here as ordinary typing, then the change follows. */
function onText(view, from, to, text) {
  if (view.composing || text.length !== 1) return false;
  const { state } = view;
  const $from = state.doc.resolve(from);
  if (!$from.parent.isTextblock) return false;
  const af = word().autoformat;
  // Formatting the user just switched on or off (stored marks) wins over the previous item's lead-in.
  const marks = af.listLead && from === to && !state.storedMarks ? leadMarks($from) : null;
  const { edits, pos } = editsAt(state, from, text);
  if (!edits.length && !marks) return false;
  const tr = state.tr;
  if (marks) tr.replaceWith(from, to, state.schema.text(text, marks));
  else tr.insertText(text, from, to);
  // The link rule makes a link of its own (with the button); TipTap's autolink would make a second one in the typing step.
  if (edits.some((e) => e.kind === 'link')) tr.setMeta('preventAutolink', true);
  view.dispatch(tr);
  applyEdits(view, edits, pos);
  return true;
}

/** Enter: a border line or +---+ table from the paragraph, a heading from the line above, else the word Enter finishes. */
function onEnter(editor) {
  const { view, state } = editor;
  const { selection } = state;
  if (!selection.empty || view.composing) return false;
  const $from = selection.$from;
  const p = $from.parent;
  const af = word().autoformat;
  if (p.type.name === 'paragraph' && $from.parentOffset === p.content.size && !p.attrs.numbering) {
    const r = enterRule(p.textContent, af);
    const start = $from.before();
    const { paragraph, table, tableRow, tableCell } = state.schema.nodes;
    if (r?.kind === 'border') {
      return dispatchAuto(view, { kind: 'border', from: start, to: start, before: r.label, label: r.label }, (tr) => {
        tr.delete($from.start(), $from.end());
        tr.setNodeAttribute(start, 'borders', { ...(p.attrs.borders ?? {}), bottom: r.border });
        const after = start + tr.doc.nodeAt(start).nodeSize;
        tr.insert(after, paragraph.create({ styleId: p.attrs.styleId }));
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
        return after;
      });
    }
    if (r?.kind === 'table' && table && !inCell($from)) {
      const total = view.nodeDOM(start)?.clientWidth || 600;
      const cells = columnWidths(r.widths, total).map((w) => tableCell.createAndFill({ colwidth: [w] }));
      return dispatchAuto(view, { kind: 'table', from: start, to: start, before: r.label, label: r.label }, (tr) => {
        tr.replaceWith(start, $from.after(), [table.create(null, tableRow.create(null, cells)), paragraph.create()]);
        tr.setSelection(TextSelection.near(tr.doc.resolve(start + 4)));
        return start + 1;
      });
    }
    // Built-in Heading styles: Enter in an empty paragraph under a short line makes that line Heading 1 (a tab per level below).
    const above = state.doc.resolve(start).nodeBefore;
    if (af.headings && !p.content.size && above?.type.name === 'paragraph' && !above.attrs.styleId && !above.attrs.numbering) {
      const h = headingOf(above.textContent);
      if (h) {
        const at = start - above.nodeSize;
        return dispatchAuto(view, { kind: 'heading', from: at, to: start, before: above.textContent, label: above.textContent }, (tr) => {
          if (h.tabs) tr.delete(at + 1, at + 1 + h.tabs);
          tr.setNodeMarkup(at, state.schema.nodes.heading, { ...above.attrs, level: h.level, styleId: null });
          return start;
        });
      }
    }
  }
  const { edits, pos } = editsAt(state, $from.pos, '\n');
  if (edits?.length) applyEdits(view, edits, pos);
  return false;
}

/** Tab finishes a word too; the Tab itself goes on to the list, table and tab handlers. */
function onTab(editor) {
  const { view, state } = editor;
  if (!state.selection.empty || view.composing) return false;
  const { edits, pos } = editsAt(state, state.selection.from, '\t');
  if (edits?.length) applyEdits(view, edits, pos);
  return false;
}

let skipException = false; // the button's own undo adds no exception (only Ctrl+Z straight after a correction does)
/** Undoes the last automatic change from the AutoCorrect Options button. */
export function undoAuto(editor) {
  skipException = true;
  editor.commands.undo();
  skipException = false;
}

/** The exception list and entry that undoing automatic change `auto` adds ("Automatically add words to list") → [list, word] or null. */
function exceptionOf(auto) {
  if (auto.kind === 'replace' || auto.kind === 'spelling') return ['other', auto.label];
  if (auto.kind !== 'capital') return null;
  if (auto.rule === 'twoCaps') return ['initialCaps', auto.label];
  if (auto.rule === 'sentences' && auto.prev) return ['firstLetter', auto.prev];
  return null;
}

/** Adds `entry` to exception list `list` in settings.word.autocorrect.exceptions unless its auto-add box is off. */
function addException([list, entry]) {
  const ac = word().autocorrect;
  const ex = ac.exceptions ?? {};
  if (ex.autoAdd?.[list] === false) return;
  const cur = list === 'firstLetter' ? optionsOf(word()).firstLetter : new Set(ex[list] ?? []);
  if (cur.has(entry)) return;
  saveWord({ autocorrect: { exceptions: { ...ex, [list]: [...cur, entry] } } });
}

/** The extension: the rules on typed input, Enter and Tab, the AutoCorrect Options button and the autolink gate. */
export const AutoCorrect = Extension.create({
  name: 'wordAutocorrect',
  priority: 1100, // before the Markdown input rules and lists' rules (100 and 102), after WordKeys (1200)
  addKeyboardShortcuts() {
    return { Enter: ({ editor }) => onEnter(editor), Tab: ({ editor }) => onTab(editor) };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key: autoKey,
      state: {
        init: () => ({ auto: null, add: null }),
        apply(tr, value) {
          const auto = tr.getMeta('wordAuto');
          if (auto) return { auto, add: null };
          if (isHistoryTransaction(tr)) {
            const add = value.auto && !skipException ? exceptionOf(value.auto) : null;
            return { auto: null, add };
          }
          return tr.docChanged ? { auto: null, add: null } : value;
        },
      },
      // TipTap's autolink (schema.js StarterKit) links typed URLs in a step it appends; while Internet and network paths with
      // hyperlinks is off, the links it added on typing come off again in the same step. Pastes and drops keep theirs.
      appendTransaction(trs, old, state) {
        if (word().autoformat.links !== false) return null;
        const link = state.schema.marks.link;
        let tr = null;
        for (const t of trs) {
          const root = t.getMeta('appendedTransaction');
          if (!root || root.getMeta('uiEvent') || isHistoryTransaction(root)) continue;
          for (const step of t.steps) {
            if (step instanceof AddMarkStep && step.mark.type === link) (tr ??= state.tr).removeMark(step.from, step.to, link);
          }
        }
        return tr;
      },
      props: {
        handleTextInput: onText,
        handleKeyDown(view, e) {
          capsLock = !!e.getModifierState?.('CapsLock');
          return false;
        },
      },
      view: (view) => {
        let shown = null;
        return {
          update(v) {
            const st = autoKey.getState(v.state);
            if (st.add) {
              const add = st.add;
              st.add = null;
              addException(add);
            }
            if (st.auto !== shown) {
              shown = st.auto;
              drawButton(editor, v, word().autocorrect.buttons ? shown : null, undoAuto);
            }
          },
          destroy: () => drawButton(editor, view, null, undoAuto),
        };
      },
    })];
  },
});

/** AutoFormat now (Ctrl+Alt+K): the AutoFormat tab's set (settings.word.autoformatNow) over the whole document of `ed`, in one
 * undo step → whether anything changed. */
export function autoFormatNow(ed) {
  const { state } = ed;
  const blocks = [];
  state.doc.descendants((node, pos, parent) => {
    if (!node.isTextblock) return true;
    const chars = charsOf(node, pos + 1);
    // Text that already carries a link keeps its address.
    const linked = (a, b) => b > a && state.doc.rangeHasMark(chars.at[a], chars.at[b - 1] + 1, state.schema.marks.link);
    blocks.push({ node, pos, ...chars, linked, styled: node.type.name !== 'paragraph' || !!node.attrs.styleId,
      list: !!node.attrs.numbering, inTable: parent.type.name !== 'doc' });
    return false;
  });
  const plan = autoFormatPlan(blocks, word().autoformatNow);
  const tr = closeHistory(state.tr);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { pos, at } = blocks[i];
    for (const e of [...plan[i].edits].reverse()) applyEdit(tr, e, (k) => at[k]);
    if (plan[i].heading) tr.setNodeMarkup(pos, state.schema.nodes.heading, { ...tr.doc.nodeAt(pos).attrs, level: plan[i].heading, styleId: null });
  }
  if (!tr.docChanged) return false;
  ed.view.dispatch(tr.setMeta('preventAutolink', true));
  ed.view.dispatch(closeHistory(ed.state.tr));
  return true;
}
