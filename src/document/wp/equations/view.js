// The equation node view and its inline editor (docs/plans/word plan.md §3 equations, briefs/equations.md Editing). The view
// draws the cached MathML (professional form) or the UnicodeMath text (linear form). Opening an equation swaps in a one-line
// box holding its linear text over a live professional preview; Esc, Enter or leaving commits one undo step. While the box is
// open the story is 'equation', with a stand-in for the main editor whose focus() returns to the box, so the ribbon's menus
// and dialogs hand the focus back to the equation (registry setStory, actions.js focusMain).
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { getState, setState } from '../../../app/store.js';
import { clearStory, setStory } from '../../../tooling/registry.js';
import { wordSettings } from '../../word/settings.mjs';
import { autoCorrect, fromInput, isTrigger, mathPrOf, mmlOf, optionsOf, toInput } from './linear.mjs';
import { PH } from './unicodemath.mjs';

export const equationKey = new PluginKey('wordEquations');
const EMPTY = 'Type equation here.';

/** settings.word.math now, and its parser options. */
export const mathSettings = () => wordSettings(getState().settings).math;
const optsNow = () => optionsOf(mathSettings());

/** The MathML for UnicodeMath `math` in `doc`, or null; a parse failure draws nothing rather than breaking the view. */
export function mmlFor(math, display, doc) {
  try {
    return mmlOf(math, { display, mathPr: mathPrOf(doc.attrs.settings), opts: optsNow() });
  } catch {
    return null;
  }
}

/** Whether the inline node at `pos` of `doc` is the only content of its paragraph (Word's display math). */
export function aloneAt(doc, pos) {
  const $p = doc.resolve(pos);
  return $p.parent.isTextblock && $p.parent.childCount === 1;
}

/** Whether `step` on `doc` only swaps one equation for another (setNodeMarkup on the leaf): it leaves every paragraph's
 * content as it was, so an explicit Change to Inline on an equation alone in its paragraph survives it. */
function attrsOnly(step, doc) {
  if (!(step instanceof ReplaceStep) || step.slice.openStart || step.slice.content.childCount !== 1) return false;
  const old = doc.nodeAt(step.from);
  return old?.type.name === 'equation' && step.slice.content.firstChild.type === old.type && step.to - step.from === old.nodeSize;
}

/** Keeps each equation's display in step with its paragraph after edits (Word: text beside an equation makes it inline, an
 * equation left alone becomes display) → the patch transaction, or null. Walks only the ranges the edits touched. */
function syncDisplay(trs, state) {
  let ranges = [];
  for (const tr of trs) {
    ranges = ranges.map(([a, b]) => [tr.mapping.map(a, -1), tr.mapping.map(b, 1)]);
    tr.steps.forEach((step, i) => {
      if (attrsOnly(step, tr.docs[i])) return;
      const rest = tr.mapping.slice(i + 1);
      step.getMap().forEach((_a, _b, from, to) => ranges.push([rest.map(from, -1), rest.map(to, 1)]));
    });
  }
  const { doc } = state;
  const tr = state.tr;
  const seen = new Set();
  for (const [a, b] of ranges) {
    doc.nodesBetween(Math.max(0, a - 1), Math.min(doc.content.size, b + 1), (n, pos, parent) => {
      if (n.type.name !== 'equation' || seen.has(pos)) return true;
      seen.add(pos);
      const display = parent.isTextblock && parent.childCount === 1;
      if (display !== n.attrs.display) tr.setNodeMarkup(pos, null, { ...n.attrs, display, mml: mmlFor(n.attrs.math, display, doc) });
      return false;
    });
  }
  return tr.docChanged ? tr : null;
}

// One open equation per main editor view: {nv, view, editor, input, proxy}.
const sessions = new WeakMap();
/** The open equation box of `editor`, or null. */
export const sessionOf = (editor) => (editor?.view ? sessions.get(editor.view) ?? null : null);

/** A stand-in for `editor` whose view.focus() focuses `input`, given to setStory so focus returns to the box. */
function proxyOf(editor, input) {
  const bind = (o, v) => (typeof v === 'function' ? v.bind(o) : v);
  const view = new Proxy(editor.view, {
    get: (v, p) => (p === 'focus' ? () => input.focus() : p === 'hasFocus' ? () => input.ownerDocument.activeElement === input : bind(v, Reflect.get(v, p))),
  });
  return new Proxy(editor, { get: (e, p) => (p === 'view' ? view : bind(e, Reflect.get(e, p))) });
}

class EquationView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = view.dom.ownerDocument.createElement('span');
    this.dom.dataset.equation = '';
    this.dom.eqView = this;
    this.input = null;
    this.render();
  }

  render() {
    const { math, display, align, linear } = this.node.attrs;
    const d = this.dom.dataset;
    d.math = math;
    if (display) d.display = 'true';
    else delete d.display;
    if (align !== 'center') d.align = align;
    else delete d.align;
    if (linear) d.linear = 'true';
    else delete d.linear;
    if (this.input) return;
    this.closeMenu();
    const mml = !linear && math ? mmlFor(math, display, this.view.state.doc) : null;
    if (mml) this.dom.innerHTML = mml;
    else this.dom.textContent = math || EMPTY;
    this.dom.classList.toggle('eq-empty', !math);
    if (this.dom.classList.contains('ProseMirror-selectednode')) this.addMenu();
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode() {
    this.dom.classList.add('ProseMirror-selectednode');
    this.addMenu();
  }

  deselectNode() {
    this.dom.classList.remove('ProseMirror-selectednode');
    this.closeMenu();
    if (!this.input) this.dom.querySelector(':scope > .eq-arrow')?.remove();
  }

  /** The small arrow at the right edge that opens the equation's own menu. */
  addMenu() {
    if (this.dom.querySelector(':scope > .eq-arrow')) return;
    const b = this.dom.ownerDocument.createElement('button');
    b.type = 'button';
    b.className = 'eq-arrow';
    b.setAttribute('aria-label', 'Equation options');
    b.contentEditable = 'false';
    b.textContent = '▾';
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMenu(b);
    });
    this.dom.append(b);
  }

  /** Closes the equation's menu → true when one was open. */
  closeMenu() {
    const off = this.menuOff;
    this.menuOff = null;
    off?.();
    return !!off;
  }

  toggleMenu(anchor) {
    if (this.closeMenu()) return;
    const doc = this.dom.ownerDocument;
    const menu = doc.createElement('span');
    menu.className = 'eq-menu';
    menu.setAttribute('role', 'menu');
    const { linear, display, align } = this.node.attrs;
    const add = (label, attrs, checked) => {
      const it = doc.createElement('button');
      it.type = 'button';
      it.setAttribute('role', 'menuitem');
      it.textContent = label;
      if (checked) it.setAttribute('aria-checked', 'true');
      it.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closeMenu();
        this.setAttrs(attrs);
      });
      menu.append(it);
    };
    add('Professional', { linear: false }, !linear);
    add('Linear', { linear: true }, linear);
    add(display ? 'Change to Inline' : 'Change to Display', { display: !display });
    const head = doc.createElement('span');
    head.className = 'eq-menu-head';
    head.textContent = 'Justification';
    menu.append(head);
    for (const [v, label] of [['left', 'Left'], ['right', 'Right'], ['center', 'Center'], ['centerGroup', 'Centered as Group']]) add(label, { align: v }, align === v);
    anchor.after(menu);
    // A press anywhere else or Esc closes it, as Word's menus do; the arrow's own press toggles it.
    const onDown = (e) => {
      if (!menu.contains(e.target) && !anchor.contains(e.target)) this.closeMenu();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.closeMenu();
    };
    doc.addEventListener('mousedown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
    this.menuOff = () => {
      doc.removeEventListener('mousedown', onDown, true);
      doc.removeEventListener('keydown', onKey, true);
      menu.remove();
    };
  }

  /** Patches this equation's attributes in one undo step, the MathML cache with them. Change to Display splits the paragraph
   * around an equation that shares it, as Word does, so it stands alone. */
  setAttrs(patch) {
    let pos = this.getPos();
    if (pos == null) return;
    const s = sessions.get(this.view);
    if (s?.nv === this) commit(this.view, 'keep');
    const tr = closeHistory(this.view.state.tr);
    if (patch.display && !aloneAt(tr.doc, pos)) {
      const $p = tr.doc.resolve(pos);
      const end = pos + tr.doc.nodeAt(pos).nodeSize;
      if (end < $p.end()) tr.split(end);
      if ($p.parentOffset > 0) {
        tr.split(pos);
        pos += 2;
      }
    }
    const attrs = { ...tr.doc.nodeAt(pos).attrs, ...patch };
    attrs.mml = mmlFor(attrs.math, attrs.display, tr.doc);
    tr.setNodeMarkup(pos, null, attrs);
    this.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)));
  }

  stopEvent(e) {
    return !!(this.input && this.dom.contains(e.target) && e.target.closest?.('.eq-input')) || !!e.target.closest?.('.eq-arrow, .eq-menu');
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.closeMenu();
    const s = sessions.get(this.view);
    if (s?.nv === this) drop(this.view);
  }
}

/** Ends `view`'s session without writing it. */
function drop(view) {
  const s = sessions.get(view);
  if (!s) return;
  sessions.delete(view);
  s.off();
  s.nv.input = null;
  clearStory(s.proxy);
  if (s.nv.getPos() != null) s.nv.render();
}

/** Opens the equation drawn by node view `nv` for typing; `caret` is 'start', 'end' or 'all'. */
export function openView(nv, caret = 'end') {
  const { view } = nv;
  const editor = view.dom.editor;
  if (!editor || !view.dom.isConnected) return null;
  const current = sessions.get(view);
  if (current?.nv === nv) return current;
  if (current) commit(view, 'keep');
  const doc = nv.dom.ownerDocument;
  const input = doc.createElement('input');
  input.className = 'eq-input';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Equation');
  const m = mathSettings();
  input.value = toInputSafe(nv.node.attrs.math, m.input);
  input.size = Math.max(4, input.value.length + 2);
  const preview = doc.createElement('span');
  preview.className = 'eq-preview';
  nv.input = input;
  nv.dom.classList.add('eq-open');
  nv.dom.replaceChildren(input, preview);
  nv.addMenu();
  const proxy = proxyOf(editor, input);
  const s = { nv, view, editor, input, preview, proxy };
  const onInput = (e) => typed(s, e);
  const onKey = (e) => keyed(s, e);
  const onMain = () => commit(view, 'keep');
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  editor.on('focus', onMain);
  s.off = () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKey);
    editor.off('focus', onMain);
    nv.dom.classList.remove('eq-open');
  };
  sessions.set(view, s);
  showPreview(s);
  input.focus();
  const end = input.value.length;
  if (caret === 'start') input.setSelectionRange(0, 0);
  else if (caret === 'all') input.setSelectionRange(0, end);
  else input.setSelectionRange(end, end);
  setStory('equation', proxy);
  // Word brings the Equation tab forward when an equation opens.
  setState((st) => ({ word: { ...st.word, tab: 'equation' } }));
  return s;
}

const toInputSafe = (math, input) => {
  try {
    return toInput(math, input, optsNow());
  } catch {
    return math;
  }
};

/** The box's text as UnicodeMath; LaTeX that does not parse stays as typed. */
function mathOfBox(s) {
  try {
    return fromInput(s.input.value, mathSettings().input);
  } catch {
    return s.input.value.trim();
  }
}

/** Builds the box's text up into the preview (Word's build-up after a space or an operator). */
function showPreview(s) {
  const math = mathOfBox(s);
  const mml = math ? mmlFor(math, s.nv.node.attrs.display, s.view.state.doc) : null;
  if (mml) s.preview.innerHTML = mml;
  else s.preview.textContent = math ? '' : EMPTY;
}

/** After each edit of the box: Math AutoCorrect on the term a trigger just ended, then build-up. */
function typed(s, e) {
  const { input } = s;
  input.size = Math.max(4, input.value.length + 2);
  if (e.inputType && !e.inputType.startsWith('insert')) return;
  const at = input.selectionStart;
  const last = input.value[at - 1];
  if (!isTrigger(last)) return;
  const m = mathSettings();
  if (m.replace && m.input !== 'latex') {
    const before = input.value.slice(0, at - 1);
    const hit = autoCorrect(before, optsNow().entries);
    if (hit) {
      // A space that ends a control word is used up by the replacement, as in Word; an operator stays.
      const keep = last === ' ' ? '' : last;
      const from = before.length - hit.len;
      input.setRangeText(hit.value + keep, from, at, 'end');
      selectPlaceholder(input, from, from + hit.value.length);
    }
  }
  if (m.autoBuildUp) showPreview(s);
}

/** Selects the first placeholder in input text [from, to), if any. */
function selectPlaceholder(input, from, to) {
  const i = input.value.indexOf(PH, from);
  if (i >= 0 && i < to) input.setSelectionRange(i, i + PH.length);
}

function keyed(s, e) {
  const { input } = s;
  const end = input.value.length;
  const collapsed = input.selectionStart === input.selectionEnd;
  let how = null;
  if (e.key === 'Escape') how = 'select';
  else if (e.key === 'Enter') how = 'after';
  else if (e.key === 'ArrowRight' && collapsed && input.selectionEnd === end) how = 'after';
  else if (e.key === 'ArrowLeft' && collapsed && input.selectionStart === 0) how = 'before';
  else if (e.key === 'Tab') how = e.shiftKey ? 'before' : 'after';
  e.stopPropagation(); // the box's keys are its own, not Word's chords
  if (!how) return;
  e.preventDefault();
  commit(s.view, how);
}

/** Writes `view`'s open equation back as one undo step and closes the box. `how`: 'select' leaves it node-selected, 'after' and
 * 'before' put the caret beside it, 'keep' leaves the selection alone (the focus went elsewhere). */
export function commit(view, how = 'keep') {
  const s = sessions.get(view);
  if (!s) return;
  const math = mathOfBox(s);
  const { nv } = s;
  drop(view);
  const pos = nv.getPos();
  if (pos == null) return;
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  if (node?.type.name !== 'equation') return;
  // Display stays as it is: the paragraph did not change while the box was open, and an explicit Change to Inline must hold.
  const { display } = node.attrs;
  const tr = state.tr;
  if (math !== node.attrs.math || !node.attrs.mml !== !math) {
    closeHistory(tr);
    tr.setNodeMarkup(pos, null, { ...node.attrs, math, mml: mmlFor(math, display, state.doc) });
  }
  if (how === 'select') tr.setSelection(NodeSelection.create(tr.doc, pos));
  else if (how === 'after') tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize));
  else if (how === 'before') tr.setSelection(TextSelection.create(tr.doc, pos));
  if (tr.docChanged || how !== 'keep') view.dispatch(tr);
  if (how !== 'keep') view.focus();
}

/** The open box of `editor`, opening the node-selected equation when none is → session or null. */
export function boxOf(editor) {
  const open = sessionOf(editor);
  if (open) return open;
  const sel = editor?.state.selection;
  if (sel?.node?.type.name !== 'equation') return null;
  const nv = editor.view.nodeDOM(sel.from)?.eqView;
  return nv ? openView(nv, 'end') : null;
}

/** Types `text` at the box's caret (replacing its selection); `placeholder` selects the first ⬚ of what went in. */
export function typeInBox(s, text, { placeholder = false } = {}) {
  const { input } = s;
  const from = input.selectionStart ?? input.value.length;
  input.setRangeText(text, from, input.selectionEnd ?? from, 'end');
  input.focus();
  if (placeholder) selectPlaceholder(input, from, from + text.length);
  input.size = Math.max(4, input.value.length + 2);
  showPreview(s);
}

/** Opens the equation at `pos` of `editor` (after its node view is drawn). */
export function openAt(editor, pos, caret = 'end') {
  const nv = editor.view.nodeDOM(pos)?.eqView;
  return nv ? openView(nv, caret) : null;
}

/** Plain text of a copied slice: each equation as its linear form or its MathML (Equation Options), or undefined when the
 * slice holds no equation so other serializers decide. */
function clipboardText(slice) {
  let has = false;
  slice.content.descendants((n) => {
    if (n.type.name === 'equation') has = true;
    return !has;
  });
  if (!has) return undefined;
  const linear = mathSettings().copyLinear;
  return slice.content.textBetween(0, slice.content.size, '\n\n', (leaf) => {
    if (leaf.type.name !== 'equation') return leaf.type.spec.leafText?.(leaf) ?? '';
    return linear ? leaf.attrs.math : leaf.attrs.mml ?? leaf.attrs.math;
  });
}

/** Math AutoCorrect outside math regions (off by default): a trigger after an entry in body text replaces it. */
function outsideText(view, from, to, text) {
  const m = mathSettings();
  if (!m.outside || !m.replace || !isTrigger(text.at(-1)) || text.length !== 1) return false;
  const $from = view.state.doc.resolve(from);
  if (!$from.parent.isTextblock) return false;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset, null, '\ufffc');
  const hit = autoCorrect(before, optsNow().entries);
  if (!hit) return false;
  const keep = text === ' ' ? '' : text;
  view.dispatch(view.state.tr.insertText(hit.value + keep, from - hit.len, to));
  return true;
}

/** The equation extension: node view, opening by click, arrows and Enter, copies, outside Math AutoCorrect and display sync. */
export const equationExtension = Extension.create({
  name: 'wordEquations',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: equationKey,
      props: {
        nodeViews: { equation: (node, view, getPos) => new EquationView(node, view, getPos) },
        attributes: (state) => {
          const pr = mathPrOf(state.doc.attrs.settings);
          const jc = pr.defJc === 'centerGroup' ? 'center' : pr.defJc;
          return { 'data-math-jc': pr.dispDef === false ? 'center' : jc,
            style: `--math-font: "${String(pr.font).replace(/["\\]/g, '')}"; --math-l: ${Number(pr.lMargin) || 0}pt; --math-r: ${Number(pr.rMargin) || 0}pt` };
        },
        handleClickOn(view, pos, node, nodePos, event, direct) {
          if (!direct || node.type.name !== 'equation' || !view.dom.editor) return false;
          const nv = view.nodeDOM(nodePos)?.eqView;
          if (!nv) return false;
          // After the click settles, so the focus ProseMirror gives the editor on mouseup does not close the box at once.
          setTimeout(() => openView(nv, 'end'), 0);
          return true;
        },
        handleKeyDown(view, e) {
          if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
          const sel = view.state.selection;
          let pos = null;
          let caret = 'end';
          if (e.key === 'Enter' && sel.node?.type.name === 'equation') pos = sel.from;
          else if (sel.empty && e.key === 'ArrowRight' && sel.$from.nodeAfter?.type.name === 'equation') {
            pos = sel.from;
            caret = 'start';
          } else if (sel.empty && e.key === 'ArrowLeft' && sel.$from.nodeBefore?.type.name === 'equation') pos = sel.from - sel.$from.nodeBefore.nodeSize;
          if (pos == null) return false;
          const nv = view.nodeDOM(pos)?.eqView;
          if (!nv || !openView(nv, caret)) return false;
          e.preventDefault();
          return true;
        },
        handleTextInput: outsideText,
        clipboardTextSerializer: clipboardText,
      },
      appendTransaction: (trs, _old, state) => (trs.some((t) => t.docChanged) ? syncDisplay(trs, state) : null),
    })];
  },
});
