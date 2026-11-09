// The style area (views.styleArea, docs/plans/word briefs/style-panes.md): with settings.word.display.styleArea above 0 (points),
// Draft and Outline views draw a column left of the text naming each paragraph's style. Its right edge drags to resize it and
// writes the setting; dragging it to the left edge hides it (0), as Word does. Story editors and hidden session editors draw none.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getState, subscribe } from '../../../app/store.js';
import { styleIdOf } from '../../model/styles.mjs';
import { overlayOf } from '../../geometry.js';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { infoOf, nameOf } from './model.mjs';

const key = new PluginKey('wordStyleArea');
const VIEWS = new Set(['draft', 'outline']);

/** The style area width now in points: 0 outside Draft and Outline or while the setting is 0. */
function widthNow() {
  const s = getState();
  const w = wordSettings(s.settings).display?.styleArea ?? 0;
  return VIEWS.has(s.word?.view) && w > 0 ? w : 0;
}

function names(doc) {
  const list = doc.attrs.styles?.list ?? {};
  const decos = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const id = styleIdOf(node);
    decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-style-name': nameOf(infoOf(id, list[id])) }));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/** The right edge of the style area in the page overlay: dragging it sets the width. */
function edgeView(view) {
  if (view.dom.hasAttribute('data-story')) return {};
  let edge = null;
  let last = widthNow();
  const place = (w) => {
    if (!view.dom.isConnected) return;
    if (!w) return edge?.remove();
    edge ??= Object.assign(document.createElement('div'), { title: 'Drag to resize the style area' });
    edge.dataset.styleAreaEdge = '';
    edge.style.cssText = `position:absolute;top:0;width:6px;cursor:col-resize;pointer-events:auto;left:calc(${w}pt - 3px);height:${view.dom.offsetHeight}px`;
    if (!edge.isConnected) overlayOf(view)?.append(edge);
  };
  const off = subscribe(() => {
    const w = widthNow();
    if (w === last || !view.dom.isConnected) return;
    last = w;
    view.dispatch(view.state.tr.setMeta(key, w));
    place(w);
  });
  // Dragging: the width follows the pointer (layout px over the page zoom, as points) and is saved on release.
  const down = (e) => {
    if (!e.target.closest?.('[data-style-area-edge]')) return;
    e.preventDefault();
    const rect = view.dom.getBoundingClientRect();
    const zoom = rect.width / (view.dom.offsetWidth || rect.width) || 1;
    let w = last;
    const move = (m) => {
      w = Math.max(0, Math.round(((m.clientX - rect.left) / zoom) * 0.75));
      view.dom.style.setProperty('--style-area', `${w}pt`);
      edge.style.left = `calc(${w}pt - 3px)`;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      saveWord({ display: { styleArea: w < 6 ? 0 : w } });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  addEventListener('pointerdown', down, true);
  place(last);
  return {
    update: () => place(last),
    destroy: () => {
      off();
      removeEventListener('pointerdown', down, true);
      edge?.remove();
    },
  };
}

/** The style area: style names as decorations, the width as a CSS variable on the editor, the edge in the page overlay. */
export const StyleArea = Extension.create({
  name: 'wordStyleArea',
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        init: (_c, state) => {
          const w = widthNow();
          return { w, names: w ? names(state.doc) : null };
        },
        // ponytail: every block renamed per edit while the area shows; map the set and rename touched blocks if long drafts lag.
        apply(tr, old, _o, state) {
          const w = tr.getMeta(key) ?? old.w;
          if (!w) return { w, names: null };
          return { w, names: old.names && !tr.docChanged && w === old.w ? old.names : names(state.doc) };
        },
      },
      props: {
        decorations: (state) => key.getState(state).names,
        attributes: (state) => {
          const { w } = key.getState(state);
          return w ? { 'data-style-area': '', style: `--style-area: ${w}pt` } : {};
        },
      },
      view: edgeView,
    })];
  },
});
