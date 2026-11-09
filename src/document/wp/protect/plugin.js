// The enforcement filter in every Document kit editor (main, story and the assistant's session editors): filterTransaction
// asks filter.mjs about each transaction, and the regions the user may edit are shaded while Highlight the regions I can edit
// is on. Returns at once when nothing is enforced, so it costs one doc attribute read per transaction.
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { toast } from '../../../app/actions.js';
import { getState } from '../../../app/store.js';
import { protectKey, userName } from './act.js';
import { isFinal, judge, regionsOf, rulesOf } from './filter.mjs';

let lastToast = 0;

/** Why `state` blocks edits, in our words, for the toast. */
function why(final, viewing, session) {
  if (final) return 'This document is marked as final. Choose Edit Anyway to change it.';
  if (session) return 'This document is open read-only. Choose Edit Anyway to change it.';
  if (viewing) return 'Viewing mode is on. Switch to Editing to change the document.';
  return 'This part of the document is protected. Restrict Editing shows what you can change.';
}

const decoMemo = new WeakMap(); // doc → DecorationSet of the user's regions

export const ProtectFilter = Extension.create({
  name: 'wordProtect',
  addProseMirrorPlugins() {
    let view = null;
    return [new Plugin({
      key: protectKey,
      state: {
        init: () => ({ session: false, highlight: true }),
        apply: (tr, v) => {
          const m = tr.getMeta(protectKey);
          return m ? { ...v, ...m } : v;
        },
      },
      view: (v) => {
        view = v;
        return { destroy: () => { view = null; } };
      },
      filterTransaction(tr, state) {
        if (!tr.docChanged) return true;
        const viewing = getState().word?.mode === 'viewing';
        // A story editor (header, footer, note) has no props and no session of its own: the main editor's count.
        const main = view?.dom.hasAttribute('data-story') ? getState().editor : null;
        const live = main && !main.isDestroyed ? main.state : null;
        const final = isFinal(state.doc) || (!!live && isFinal(live.doc));
        const session = !!protectKey.getState(state)?.session || (!!live && !!protectKey.getState(live)?.session);
        const rules = rulesOf(state.doc, { viewing, session, final, user: userName() });
        if (judge(tr, rules)) return true;
        // One toast per 3 seconds, and only for an editor on screen (never the assistant's hidden sessions).
        if (view?.dom.isConnected && Date.now() - lastToast > 3000) {
          lastToast = Date.now();
          toast(why(final, viewing, session));
        }
        return false;
      },
      props: {
        decorations(state) {
          const p = state.doc.attrs.settings?.protection;
          if (!p?.enforcement || !protectKey.getState(state)?.highlight) return null;
          let set = decoMemo.get(state.doc);
          if (!set) {
            set = DecorationSet.create(state.doc, regionsOf(state.doc, userName()).map((r) => Decoration.inline(r.from, r.to, { class: 'protect-region' })));
            decoMemo.set(state.doc, set);
          }
          return set;
        },
      },
    })];
  },
});
