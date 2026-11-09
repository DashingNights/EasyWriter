// The content controls plugin (plan.md §1.2, §1.8, §3 content-controls): node views for sdtInline and sdtBlock, the locks
// (filterTransaction), placeholders, temporary controls and the two-way property bindings (appendTransaction), typing rules per
// control type, Design Mode and the tags view, and the legacy form fields' input under forms protection.
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ctxOf } from '../../../tooling/registry.js';
import { formFieldOptions } from './commands.js';
import { editFormText, formsProtected, kindOf, moveField, openFormDrop, toggleFormCheck } from './forms.jsx';
import { controlAt, flags, KEY, sdtOf, selectContent, toggleCheck } from './ops.js';
import { follow, lockCheck, typeInto, typingTarget } from './rules.js';
import { openList, SdtView } from './view.jsx';

const toast = (text) => ctxOf().toast(text);

// A double-click on a form field opens its options; fields-core's node view may also call the type's click, so one open per burst.
let lastOptions = 0;
/** Opens the options of the form field at `pos` in `view` unless the form is protected (then the field takes input instead). */
export function openFieldOptions(view) {
  return (pos) => {
    if (formsProtected(view.state.doc) || Date.now() - lastOptions < 500) return false;
    lastOptions = Date.now();
    formFieldOptions(ctxOf(), view.dom.editor, pos);
    return true;
  };
}

// One toast per refused burst of typing, not one per key.
let lastRefusal = 0;
const refuse = (message) => {
  if (Date.now() - lastRefusal > 1500) toast(message);
  lastRefusal = Date.now();
};

/** In a story editor (a header or footer: view.dom carries data-story), keeps doc.attrs.props the same as the main editor's, which
 * owns them: story docs share styles and settings but not props, so a bound control there would read nothing and write into a
 * doc nobody saves. Main's props come in outside the story's undo history (follow then rewrites the bound controls), and a
 * change the story makes (a bound control typed into) goes to main. → the plugin view (empty outside a story). */
function storyProps(view) {
  if (!view.dom.hasAttribute('data-story')) return {};
  const main = ctxOf().ed;
  if (!main || main.view === view) return {};
  let synced = view.state.doc.attrs.props;
  const pull = () => {
    if (main.isDestroyed || view.isDestroyed) return;
    const props = main.state.doc.attrs.props;
    if (props === synced) return;
    synced = props;
    view.dispatch(view.state.tr.setDocAttribute('props', props).setMeta('addToHistory', false).setMeta('wordStoryRefresh', true));
  };
  main.on('transaction', pull);
  queueMicrotask(pull);
  return {
    update() {
      const props = view.state.doc.attrs.props;
      if (props === synced || main.isDestroyed) return;
      synced = props;
      main.view.dispatch(main.state.tr.setDocAttribute('props', props));
    },
    destroy: () => main.off('transaction', pull),
  };
}

const formCache = new WeakMap(); // doc → its form field decorations, so a selection change does not walk the document

/** Form field shading (Legacy Tools > Form Field Shading) and check box sizes (Exactly N pt) of `doc`. */
function formDecos(doc) {
  if (formCache.has(doc)) return formCache.get(doc);
  const out = [];
  const shading = doc.attrs.settings?.formShading !== false;
  doc.descendants((node, pos) => {
    const kind = kindOf(node);
    if (!kind) return !node.isLeaf;
    const size = kind === 'checkBox' && node.attrs.ff?.size;
    out.push(Decoration.node(pos, pos + node.nodeSize, { class: shading ? 'cc-ff cc-ff-shaded' : 'cc-ff', ...(size ? { style: `font-size:${size}pt` } : {}) }));
    return false;
  });
  formCache.set(doc, out);
  return out;
}

/** The decorations: the control holding the caret (its title tab and box show), form field shading and check box sizes. */
function decorationsOf(state) {
  const deco = [];
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'sdtInline' || n.type.name === 'sdtBlock') deco.push(Decoration.node($from.before(d), $from.after(d), { class: 'cc-in' }));
  }
  const sel = state.selection.node;
  if (sel && (sel.type.name === 'sdtInline' || sel.type.name === 'sdtBlock')) deco.push(Decoration.node(state.selection.from, state.selection.to, { class: 'cc-in' }));
  return DecorationSet.create(state.doc, [...deco, ...formDecos(state.doc)]);
}

export const ContentControls = Extension.create({
  name: 'contentControls',
  priority: 1000, // ahead of the Word keys, so Tab under forms protection and Space on a check box reach us first
  addProseMirrorPlugins() {
    return [new Plugin({
      key: KEY,
      filterTransaction(tr, state) {
        const reason = lockCheck(tr, state);
        if (reason) refuse(reason);
        return !reason;
      },
      appendTransaction: follow,
      view: storyProps,
      props: {
        nodeViews: {
          sdtInline: (node, view, getPos) => new SdtView(node, view, getPos),
          sdtBlock: (node, view, getPos) => new SdtView(node, view, getPos),
        },
        attributes: () => ({ ...(flags.design && { 'data-cc-design': '' }), ...(flags.tags && { 'data-cc-tags': '' }) }),
        decorations: decorationsOf,
        handleTextInput(view, from, to, text) {
          const r = typeInto(view.state, text);
          if (r && r !== true) view.dispatch(r.scrollIntoView());
          return !!r;
        },
        handleClick(view, pos) {
          // A click on a placeholder picks it whole, so typing replaces it (Word's).
          const c = controlAt(view.state.doc.resolve(pos));
          if (!c || flags.design) return false;
          const s = sdtOf(c.node);
          if (!s.showingPlaceholder || s.type === 'picture') return false;
          selectContent(view, c.pos);
          return true;
        },
        handleClickOn(view, pos, node, nodePos) {
          if (!formsProtected(view.state.doc)) return false;
          const kind = kindOf(node);
          if (kind === 'checkBox') return toggleFormCheck(view, nodePos);
          if (kind === 'text') {
            editFormText(view, nodePos, toast);
            return true;
          }
          if (kind === 'dropDown') return openFormDrop(view, nodePos);
          return false;
        },
        handleDoubleClickOn(view, pos, node, nodePos) {
          return !!kindOf(node) && openFieldOptions(view)(nodePos);
        },
        handleKeyDown(view, e) {
          const { state } = view;
          if (formsProtected(state.doc)) {
            const sel = state.selection.node;
            const kind = kindOf(sel);
            if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return moveField(view, e.shiftKey ? -1 : 1, toast);
            if (kind === 'checkBox' && e.key === ' ') return toggleFormCheck(view, state.selection.from);
            if (kind === 'dropDown' && e.key === 'ArrowDown' && e.altKey) return openFormDrop(view, state.selection.from);
            if (kind && e.key === 'F1') {
              toast(sel.attrs.ff?.help || 'This field has no help text.');
              return true;
            }
            if (kind === 'text' && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
              editFormText(view, state.selection.from, toast);
              return false;
            }
          }
          const c = typingTarget(state);
          if (!c) return false;
          const { s } = c;
          if (s.type === 'checkbox' && e.key === ' ' && !flags.design) return toggleCheck(view, c.pos);
          if ((s.type === 'comboBox' || s.type === 'dropDown' || s.type === 'date') && e.key === 'ArrowDown' && e.altKey) {
            openList(view, c.pos, view.nodeDOM(c.pos));
            return true;
          }
          if (s.showingPlaceholder && !flags.design && (e.key === 'Backspace' || e.key === 'Delete')) return true; // a placeholder is not text
          if (e.key === 'Enter' && s.type === 'text' && !s.multiLine) return true; // Allow carriage returns is off
          return false;
        },
      },
    })];
  },
});
