// Immersive Reader's Syllables (briefs/views.md; _gaps-page-engine.md gap 11): a middle dot between the syllables of every word
// while the Reader shows with Syllables on, as widget decorations, so the text stays editable. The breaks come from layout-misc's
// hyphenate.mjs (empty until that package fills it).
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getState, subscribe } from '../../../app/store.js';
import { wordSettings } from '../../word/settings.mjs';
import { hyphenate } from '../layout-misc/hyphenate.mjs';
import { SYLLABLE_WORD, syllableBreaks } from './views.mjs';

const key = new PluginKey('wordSyllables');
const wanted = () => getState().word?.view === 'immersive' && !!wordSettings(getState().settings).immersive.syllables;

/** The dots of `doc`. ponytail: the whole document per edit; per-paragraph mapping if long documents feel it. */
function dotsOf(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.text.matchAll(SYLLABLE_WORD)) {
      for (const at of syllableBreaks(m[0], hyphenate)) {
        out.push(Decoration.widget(pos + m.index + at, () => {
          const s = document.createElement('span');
          s.dataset.syllable = '';
          s.textContent = '·';
          return s;
        }, { side: -1, ignoreSelection: true }));
      }
    }
  });
  return DecorationSet.create(doc, out);
}

export const Syllables = Extension.create({
  name: 'wordSyllables',
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        init: () => ({ on: false, set: DecorationSet.empty }),
        apply(tr, old, _prev, state) {
          const on = tr.getMeta(key) ?? old.on;
          if (!on) return { on, set: DecorationSet.empty };
          return { on, set: on !== old.on || tr.docChanged ? dotsOf(state.doc) : old.set };
        },
      },
      props: { decorations: (state) => key.getState(state).set },
      view(view) {
        // A store change can come from inside another transaction's handlers: dispatch after it.
        const sync = () => queueMicrotask(() => {
          if (!view.isDestroyed && view.dom.isConnected && wanted() !== key.getState(view.state).on) view.dispatch(view.state.tr.setMeta(key, wanted()));
        });
        sync();
        return { destroy: subscribe(sync) };
      },
    })];
  },
});
