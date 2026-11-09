// Preview Results and Highlight Merge Fields on the page (docs/plans/word/plan.md §1.10: merge values are view state). Preview runs
// updateFields(ed, 'all', 'merge', {names}) for the store's record, which fills the engine's drawn values without a doc write, and
// draws each merge field's drawn value as a widget in front of the field, which it hides; fields-core's node view, when it draws
// drawn values itself, is hidden the same way, so a value never shows twice. Highlight shades every merge field. Both come from
// decorations set by meta-only transactions, so they add no undo step and never mark the draft dirty.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { subscribe } from '../../../app/store.js';
import { parseField } from '../../fields/registry.mjs';
import { drawnOf, updateFields } from '../../fields/engine.js';
import { isMergeName, MERGE_NAMES, resultText } from './fields.mjs';
import { highlightOf, previewOf, sourceOf } from './state.js';

export const previewKey = new PluginKey('mailingsPreview');

/** The merge fields of `doc` → [{pos, node}]. */
function mergeFields(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'field' && isMergeName(parseField(node.attrs.code).name)) out.push({ pos, node });
    return node.type.name !== 'field';
  });
  return out;
}

/** Decorations for `doc`: `values` (Map pos → text) while previewing, the shading while highlighting. */
function decorate(doc, { values, highlight }) {
  const decos = [];
  for (const { pos, node } of mergeFields(doc)) {
    const shown = values?.has(pos);
    const attrs = { ...(shown && { 'data-merge-hidden': '' }), ...(highlight && { 'data-merge-highlight': '' }) };
    if (Object.keys(attrs).length) decos.push(Decoration.node(pos, pos + node.nodeSize, attrs));
    const text = shown ? values.get(pos) : '';
    if (text) {
      decos.push(Decoration.widget(pos, () => {
        const span = document.createElement('span');
        span.setAttribute('data-merge-preview', '');
        if (highlight) span.setAttribute('data-merge-highlight', '');
        span.textContent = text;
        return span;
      }, { side: -1, key: `merge:${pos}:${highlight ? 1 : 0}:${text}` }));
    }
  }
  return DecorationSet.create(doc, decos);
}

/** The editor plugin: decorations from the last refresh, mapped through edits until the next one. */
export const MailingsView = Extension.create({
  name: 'mailingsView',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: previewKey,
      state: {
        init: () => ({ values: null, highlight: false, set: DecorationSet.empty }),
        apply(tr, old, _, state) {
          const meta = tr.getMeta(previewKey);
          if (meta) return { ...meta, set: decorate(state.doc, meta) };
          if (!tr.docChanged) return old;
          // Values follow their fields until the next refresh; the shading is redrawn for fields typed or pasted meanwhile.
          const values = old.values && new Map([...old.values].map(([p, v]) => [tr.mapping.map(p), v]));
          return { ...old, values, set: old.highlight || values ? decorate(state.doc, { values, highlight: old.highlight }) : old.set };
        },
      },
      props: { decorations: (state) => previewKey.getState(state)?.set },
    })];
  },
});

/** Recomputes the preview of editor `ed` for the store's record and redraws it (a meta-only transaction). */
export async function refresh(ed) {
  if (!ed?.view?.dom?.isConnected) return;
  const highlight = highlightOf();
  let values = null;
  if (previewOf() != null && sourceOf()) {
    const doc = ed.state.doc;
    await updateFields(ed, 'all', 'merge', { names: MERGE_NAMES });
    if (ed.isDestroyed || ed.state.doc !== doc) return refresh(ed); // edited meanwhile: positions moved
    values = new Map();
    const drawn = drawnOf(ed);
    for (const { pos } of mergeFields(doc)) if (drawn.has(pos)) values.set(pos, resultText(drawn.get(pos)));
  }
  if (ed.isDestroyed) return;
  ed.view.dispatch(ed.state.tr.setMeta(previewKey, { values, highlight }).setMeta('addToHistory', false));
}

/** Keeps editor `ed`'s preview in step with the store (record, preview on or off, highlight, the recipient list) and with edits
 * while previewing. → cleanup. */
export function watch(ed) {
  let last = [];
  let timer = 0;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => refresh(ed), 120);
  };
  const off = subscribe(() => {
    // The list is replaced whole when it changes (setSource), so its identity tells an edit.
    const now = [previewOf(), highlightOf(), sourceOf()];
    if (now.every((v, i) => v === last[i])) return;
    last = now;
    later();
  });
  const onUpdate = () => previewOf() != null && later(); // a doc change while previewing: new fields, a changed filter
  ed.on('update', onUpdate);
  return () => {
    off();
    clearTimeout(timer);
    ed.off('update', onUpdate);
  };
}
