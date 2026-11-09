// AutoComplete (docs/plans/word briefs/building-blocks.md, editing.autoComplete): once the text before the caret starts an AutoText
// name with four or more letters, a tip at the caret offers the entry; Enter inserts it, any other key closes the tip (typing on
// shows it again while it still matches). settings.word.autoComplete turns it off. Priority above WordKeys (1200), so Enter
// reaches the tip first.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getState } from '../../../app/store.js';
import { wordSettings } from '../../word/settings.mjs';
import { autoCompleteOf } from './blocks.mjs';
import { allEntries } from './store.js';

const key = new PluginKey('bbAutoComplete');
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** The tip for `state` → {entry, from, to} | null. */
function tipOf(state) {
  if (!wordSettings(getState().settings).autoComplete) return null;
  const { empty, $from } = state.selection;
  if (!empty || !$from.parent.isTextblock) return null;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 80), $from.parentOffset, null, '￼');
  const hit = autoCompleteOf(allEntries(state.doc), before);
  return hit && { entry: hit.entry, from: $from.pos - (before.length - hit.start), to: $from.pos };
}

/** The AutoComplete extension; `accept(tip)` inserts the entry over tip.from to tip.to. */
export const AutoComplete = (accept) => Extension.create({
  name: 'bbAutoComplete',
  priority: 1250,
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        init: () => null,
        apply: (tr, prev, _, state) => {
          if (tr.getMeta(key) === 'close') return null;
          if (tr.docChanged) return tr.getMeta('wordAuto') || tr.getMeta('history$') ? null : tipOf(state);
          return tr.selectionSet ? null : prev;
        },
      },
      props: {
        decorations(state) {
          const tip = key.getState(state);
          if (!tip) return null;
          const el = () => {
            const span = document.createElement('span');
            span.className = 'bb-tip';
            span.setAttribute('data-bb-tip', tip.entry.name);
            span.contentEditable = 'false';
            const bubble = document.createElement('span');
            bubble.textContent = `Press Enter to insert ${tip.entry.name}`;
            span.append(bubble);
            return span;
          };
          return DecorationSet.create(state.doc, [Decoration.widget(tip.to, el, { side: 1, key: `bb-tip:${tip.entry.id}`, ignoreSelection: true })]);
        },
        handleKeyDown(view, e) {
          const tip = key.getState(view.state);
          if (!tip || MODIFIERS.has(e.key)) return false;
          view.dispatch(view.state.tr.setMeta(key, 'close'));
          if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
          accept(tip);
          return true;
        },
      },
    })];
  },
});
