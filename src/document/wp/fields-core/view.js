// The field node views and the field plugin (docs/plans/word/plan.md §1.10, briefs/fields-core.md Word behaviour): a field draws
// its result, or `{ code }` with the code editable in place; Shift+F9 flips single fields (view state, mapped through
// transactions, never stored), Alt+F9 all of them (#editor-area[data-field-codes], set by the ribbon mount); shading follows
// settings.word.fieldShading on the editor root; Backspace and Delete select a field before removing it, the arrows cross it in
// one press, and a text selection ending inside a fieldBlock grows over it.
import { closeHistory } from '@tiptap/pm/history';
import { Extension } from '@tiptap/core';
import { DOMSerializer, Fragment } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getState } from '../../../app/store.js';
import { run } from '../../../tooling/registry.js';
import { baseOf, computeField, ctxAt, fieldViews, textOf } from '../../fields/engine.js';
import { fieldType, parseField } from '../../fields/registry.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { isError } from './format.mjs';
import { drawnRuns, ownMarks } from './runs.mjs';

export const fieldsKey = new PluginKey('fieldsCore');

/** The field plugin's state: `flip`, the node decorations of the fields Shift+F9 turned to their other view. */
const EMPTY = { flip: DecorationSet.empty };

/** A transaction meta for the field plugin: {flip: [pos]} toggles those fields' view; {redraw: true} re-reads the settings. */
export const fieldsMeta = (tr, meta) => tr.setMeta(fieldsKey, meta).setMeta('addToHistory', false);

/** Whether the field at `pos` shows its other view now (Shift+F9). */
export const flipped = (state, pos) => !!fieldsKey.getState(state)?.flip.find(pos, pos + 1).length;

/** Whether field codes show for the field at `pos` of `state`: Alt+F9's setting flipped by Shift+F9. */
export const codeShown = (state, pos) => !!wordSettings(getState().settings).fieldCodes !== flipped(state, pos);

/** Whether `node` carries hidden text (XE, TC and TA are inserted with textStyle vanish). */
const hidden = (node) => node.marks.some((m) => m.type.name === 'textStyle' && m.attrs.vanish);

const el = (tag, attrs = {}, text) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};

/** Writes the code typed into a field's code box at `pos` as one undo step. → whether it changed. */
function writeCode(view, pos, code) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.attrs.code === code) return false;
  view.dispatch(closeHistory(view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, code }, node.marks)));
  return true;
}

/** The editable `{ code }` part of a field or fieldBlock view: Enter, Tab and leaving the box write the code in one step; F9 also
 * updates the field and Shift+F9 also turns it back to its result; Ctrl+F9 inserts a nested pair of braces; Esc drops the edit. */
function codeBox(owner) {
  const wrap = el('span', { class: 'fld-code', contenteditable: 'false' });
  const box = el('span', { class: 'fld-c', contenteditable: 'true', spellcheck: 'false' });
  wrap.append('{ ', box, ' }');
  const commit = () => {
    const pos = owner.getPos();
    if (pos == null) return;
    writeCode(owner.view, pos, box.textContent.replace(/ /g, ' ').trim());
  };
  const back = () => {
    owner.view.focus();
    const pos = owner.getPos();
    if (pos != null) owner.view.dispatch(owner.view.state.tr.setSelection(NodeSelection.create(owner.view.state.doc, pos)));
  };
  box.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (e.key === 'Escape') {
      box.textContent = owner.node.attrs.code;
      back();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && plain && !e.shiftKey) {
      commit();
      back();
    } else if (e.key === 'F9' && plain) {
      commit();
      back();
      if (e.shiftKey) run('fieldsUi.toggle');
      else {
        if (flipped(owner.view.state, owner.getPos())) owner.view.dispatch(fieldsMeta(owner.view.state.tr, { flip: [owner.getPos()] }));
        run('fieldsUi.update');
      }
    } else if (e.key === 'F9' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      // Word's Ctrl+F9 inside a code: a nested field, the caret between its braces.
      document.execCommand('insertText', false, '{  }');
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const r = sel.getRangeAt(0);
        if (r.startContainer.nodeType === 3 && r.startOffset >= 2) r.setStart(r.startContainer, r.startOffset - 2);
        r.collapse(true);
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  box.addEventListener('blur', commit);
  return { wrap, box };
}

/** Puts the caret at the end of the code box of the field view at `pos` in `view` (Ctrl+F9). */
export function focusCode(view, pos) {
  for (const v of fieldViews(view)) {
    if (v.getPos() !== pos) continue;
    const box = v.dom.querySelector('.fld-c');
    if (!box) return;
    box.focus();
    const r = document.createRange();
    r.selectNodeContents(box);
    r.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(r);
  }
}

const serializers = new WeakMap(); // schema → its DOMSerializer, which draws a field's result runs as the editor draws text
const serializerOf = (schema) => serializers.get(schema) ?? serializers.set(schema, DOMSerializer.fromSchema(schema)).get(schema);

// The drawn value of each open field (DATE, TIME, SAVEDATE) per field node. ProseMirror keeps a field's node when it rebuilds the
// paragraph around it (a split, a join) but makes a new view, which reuses this value: Word refreshes these fields on open and
// print only, so a TIME field never moves on while being edited around.
const opened = new WeakMap();

/** A field's node view: the result (or the drawn value a refresh set) in `.fld-res`, the code in `.fld-code`; CSS shows one of
 * them (data-fld-flip from the plugin, data-field-codes on #editor-area). */
class FieldView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.over = undefined;
    this.dom = el('span', { 'data-field': '' });
    this.res = el('span', { class: 'fld-res' });
    const { wrap, box } = codeBox(this);
    this.code = box;
    this.dom.append(this.res, wrap);
    fieldViews(view).add(this);
    this.read();
    // Open and layout fields draw a fresh value on mount: DATE, TIME and SAVEDATE as Word shows them after an open, the page
    // fields from the layout. The stored result stays until a manual update.
    if (this.type && !node.attrs.locked && (this.layout || this.type.updates === 'open')) this.over = opened.has(node) ? opened.get(node) : this.compute();
    this.keep();
    this.render();
  }

  /** Records an open field's drawn value for its node (undefined: its stored result after a manual update). */
  keep() {
    if (this.type?.updates === 'open') opened.set(this.node, this.over);
  }

  /** Reads the code's parse and type. */
  read() {
    this.f = parseField(this.node.attrs.code);
    this.type = fieldType(this.f.name);
    this.layout = this.type?.updates === 'layout';
  }

  compute() {
    const pos = this.getPos();
    if (pos == null) return undefined;
    const r = computeField(this.node.attrs.code, ctxAt(baseOf(this.view.state, this.view), pos));
    return r ?? undefined;
  }

  /** Sets the drawn value (undefined: the stored result again) and redraws. */
  set(r) {
    this.over = r;
    this.keep();
    this.render();
  }

  render() {
    const { node } = this;
    if (document.activeElement !== this.code) this.code.textContent = node.attrs.code;
    // A locked field never updates, so it draws its stored result even when an open refresh computed one before Ctrl+3.
    const r = this.over !== undefined && !node.attrs.locked ? this.over : node.attrs.result;
    const text = r == null ? null : textOf(r);
    this.res.classList.toggle('fld-err', typeof r === 'object' && r?.error != null ? true : isError(text));
    if (this.type?.draw) {
      const pos = this.getPos();
      const ctx = ctxAt(baseOf(this.view.state, this.view), pos ?? 0);
      try {
        this.type.draw(this.f, ctx, this.res, { editor: this.view.dom.editor, getPos: this.getPos, setAttrs: (patch) => this.setAttrs(patch) });
        return;
      } catch (e) {
        console.warn(`Field ${this.f.name} could not draw`, e);
      }
    }
    // A field with no result draws nothing, as in Word (its code shows in code view); an empty hidden one (XE, TC, TA) draws its
    // code, so it shows exactly when hidden text shows.
    const showCode = !text && hidden(node);
    if (!showCode && text && this.drawRuns(drawnRuns(node.attrs, text))) return;
    this.res.textContent = showCode ? `{ ${node.attrs.code} }` : text ?? '';
  }

  /** Draws a result's `runs` (runs.mjs) inside the field's own marks, each with the formatting the node does not set; false when
   * there are none or a run's marks do not fit the schema (a hand-made runs value), so the plain text draws instead. */
  drawRuns(runs) {
    if (!runs) return false;
    const { schema } = this.view.state;
    const marks = this.node.marks.map((m) => m.toJSON());
    try {
      const nodes = runs.map((r) => schema.text(r.text, ownMarks(r, marks).map((m) => schema.markFromJSON(m))));
      this.res.replaceChildren(serializerOf(schema).serializeFragment(Fragment.fromArray(nodes)));
      return true;
    } catch {
      return false;
    }
  }

  setAttrs(patch) {
    const pos = this.getPos();
    if (pos == null) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, ...patch }, this.node.marks));
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    const prev = this.node;
    this.node = node;
    if (prev.attrs.code !== node.attrs.code) {
      this.read();
      this.over = this.layout || this.type?.updates === 'open' ? this.compute() : undefined;
    } else if (prev.attrs.result !== node.attrs.result && prev.attrs.locked === node.attrs.locked) {
      // A manual update or its undo: draw the stored result. Ctrl+3 writes the drawn value as the result in the same step as
      // `locked`, so a lock and its undo or redo keep the drawn value (render ignores it while the field is locked).
      this.over = undefined;
    }
    // An open field mounted while locked never drew a value: unlocking it draws one, as the opening refresh would have.
    const unlocked = prev.attrs.locked && !node.attrs.locked && this.type?.updates === 'open';
    if ((this.layout || unlocked) && this.over === undefined && !node.attrs.locked) this.over = this.compute();
    this.keep();
    this.render();
    return true;
  }

  // Events inside the code box are the box's own: typing, IME composition and selection there never reach ProseMirror.
  stopEvent(e) {
    return this.code.contains(e.target);
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    fieldViews(this.view).delete(this);
  }
}

/** A fieldBlock's node view: its blocks, or `{ code }` on one line in code view. */
class FieldBlockView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = el('div', { 'data-field-block': '' });
    const { wrap, box } = codeBox(this);
    this.code = box;
    this.line = el('div', { class: 'fld-line', contenteditable: 'false' });
    this.line.append(wrap);
    this.contentDOM = el('div', { class: 'fld-blocks' });
    this.dom.append(this.line, this.contentDOM);
    this.code.textContent = node.attrs.code;
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (document.activeElement !== this.code) this.code.textContent = node.attrs.code;
    return true;
  }

  stopEvent(e) {
    return this.code.contains(e.target);
  }

  ignoreMutation(m) {
    return this.line.contains(m.target);
  }
}

/** The fields and fieldBlocks the selection of `state` touches → [pos]: a caret beside a field touches it. */
function touched(state) {
  const { from, to } = state.selection;
  const out = [];
  state.doc.nodesBetween(Math.max(0, from - 1), Math.min(state.doc.content.size, to + 1), (node, pos) => {
    if (node.type.name === 'field' && pos + node.nodeSize >= from && pos <= to) out.push(pos);
    if (node.type.name === 'fieldBlock') out.push(pos);
    return node.type.name !== 'field';
  });
  return out;
}

/** The field before (dir -1) or after (dir 1) an empty selection, or null. */
function besideField(state, dir) {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const node = dir < 0 ? selection.$from.nodeBefore : selection.$from.nodeAfter;
  return node?.type.name === 'field' ? { node, pos: dir < 0 ? selection.from - node.nodeSize : selection.from } : null;
}

/** Word's keys around a field: Backspace and Delete select it first and remove it on the next press; Left and Right cross it in one
 * press (ProseMirror would stop on it as a node selection). */
function handleKeyDown(view, e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const { state } = view;
  const dir = e.key === 'Backspace' || e.key === 'ArrowLeft' ? -1 : e.key === 'Delete' || e.key === 'ArrowRight' ? 1 : 0;
  if (!dir) return false;
  const sel = state.selection;
  if (e.key.startsWith('Arrow')) {
    if (e.shiftKey) return false;
    if (sel instanceof NodeSelection && sel.node.type.name === 'field') {
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, dir < 0 ? sel.from : sel.to)));
      return true;
    }
    const hit = besideField(state, dir);
    if (!hit) return false;
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, dir < 0 ? hit.pos : hit.pos + hit.node.nodeSize)));
    return true;
  }
  const hit = besideField(state, dir);
  if (!hit) return false;
  view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, hit.pos)));
  return true;
}

/** A text selection whose head ends inside a fieldBlock its anchor is outside of grows to cover the whole block (Word selects
 * a TOC whole). → the transaction that does it, or null. */
function growOverBlocks(state) {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || sel.empty) return null;
  const { $head, $anchor } = sel;
  for (let d = $head.depth; d > 0; d--) {
    if ($head.node(d).type.name !== 'fieldBlock') continue;
    const start = $head.before(d);
    const end = $head.after(d);
    if ($anchor.pos >= start && $anchor.pos <= end) return null;
    const head = $head.pos > $anchor.pos ? end : start;
    const next = TextSelection.between($anchor, state.doc.resolve(head), $head.pos > $anchor.pos ? 1 : -1);
    return next.eq(sel) ? null : state.tr.setSelection(next);
  }
  return null;
}

/** The fields-core editor extension: node views for field and fieldBlock, the flip state, shading and the key behaviours. */
export const FieldsCore = Extension.create({
  name: 'fieldsCore',
  // Ahead of the app's text keys (1100), so Backspace beside a field selects it before a join runs; WordKeys (1200) stays first.
  priority: 1150,
  addProseMirrorPlugins() {
    return [new Plugin({
      key: fieldsKey,
      state: {
        init: () => EMPTY,
        apply(tr, value) {
          const meta = tr.getMeta(fieldsKey);
          let flip = tr.docChanged ? value.flip.map(tr.mapping, tr.doc) : value.flip;
          if (meta?.flip) {
            for (const pos of meta.flip) {
              const on = flip.find(pos, pos + 1);
              const node = tr.doc.nodeAt(pos);
              if (on.length) flip = flip.remove(on);
              else if (node) flip = flip.add(tr.doc, [Decoration.node(pos, pos + node.nodeSize, { 'data-fld-flip': '' })]);
            }
          }
          if (flip === value.flip && !meta?.redraw) return value;
          return { flip };
        },
      },
      appendTransaction: (trs, old, state) => (trs.some((t) => t.selectionSet) ? growOverBlocks(state) : null),
      props: {
        nodeViews: {
          field: (node, view, getPos) => new FieldView(node, view, getPos),
          fieldBlock: (node, view, getPos) => new FieldBlockView(node, view, getPos),
        },
        attributes: () => ({ 'data-field-shading': wordSettings(getState().settings).fieldShading ?? 'selected' }),
        decorations(state) {
          const { flip } = fieldsKey.getState(state);
          if (wordSettings(getState().settings).fieldShading !== 'selected') return flip;
          const sel = touched(state).map((pos) => Decoration.node(pos, pos + state.doc.nodeAt(pos).nodeSize, { 'data-fld-sel': '' }));
          return sel.length ? flip.add(state.doc, sel) : flip;
        },
        handleKeyDown,
        handleDoubleClick(view, pos, e) {
          const node = view.state.doc.nodeAt(pos);
          if (node?.type.name !== 'field') return false;
          const f = parseField(node.attrs.code);
          const type = fieldType(f.name);
          if (!type?.click) return false;
          const ctx = ctxAt(baseOf(view.state, view), pos);
          return !!type.click(f, ctx, { editor: view.dom.editor, getPos: () => pos, setAttrs: (patch) => view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, ...patch }, node.marks)), event: e });
        },
      },
    })];
  },
});
