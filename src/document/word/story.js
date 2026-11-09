// Story editors (docs/plans/word plan.md §1.7): a header, footer, note, comment, text box or equation edited in its own TipTap
// editor of the Document kit, mounted where its owner draws it (usually the page overlay). Its doc takes the main doc's styles,
// numbering, theme, settings and people (never sect, comments or suggest), refreshed when the main doc's change, so the story
// draws with the main doc's styles and its list labels find their definitions. Its edits come back to the owner as
// onChange({content, attrs}), one call per edit batch; the owner writes both in one main-editor transaction (writeBack), so one
// main undo step undoes the batch. The sub-editor keeps its own undo while it is open.
import { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { getState } from '../../app/store.js';
import { kitOf } from '../../editors.js';
import { clearStory, setStory } from '../../tooling/registry.js';
import { activeSurface } from '../../tooling/surface.js';

/** The doc attributes a story shares with its main doc. */
export const SHARED = ['styles', 'numbering', 'theme', 'settings', 'people'];
const BATCH_MS = 300; // edits closer together than this report as one batch

const shared = (doc) => Object.fromEntries(SHARED.filter((k) => k in doc.attrs && doc.attrs[k] != null).map((k) => [k, doc.attrs[k]]));

/** Mounts a story editor of `kind` in `host` on `content` (block JSON) → {editor, focus(), destroy()}. `onChange({content, attrs})`
 * gets the story's blocks and the shared attributes it changed (a new list definition, a style ensureStyles added); `onExit` runs
 * on Esc. The editor root carries data-story, which pagination and page layers skip. */
export function mountStory({ kind, host, content, onChange, onExit }) {
  const main = activeSurface()?.editor ?? getState().editor;
  const editor = new Editor({
    element: host,
    extensions: kitOf('document').extensions(getState().settings?.historyLimit || 50),
    content: { type: 'doc', attrs: main ? shared(main.state.doc) : {}, content: content?.length ? content : [{ type: 'paragraph' }] },
    editorProps: {
      attributes: { 'data-story': kind, spellcheck: 'true' },
      handleKeyDown: (_view, e) => {
        if (e.key !== 'Escape') return false;
        flush();
        clearStory(editor);
        onExit?.();
        return true;
      },
    },
  });

  // The shared attributes as the story last agreed them with main (at mount, after each flush and each refresh). A key that
  // differs from this is the story's own unreported change, which refresh must not overwrite with main's older value.
  let synced = { ...editor.state.doc.attrs };
  let timer = null;
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    if (editor.isDestroyed) return;
    const doc = editor.state.doc;
    const base = main && !main.isDestroyed ? main.state.doc.attrs : {};
    const attrs = Object.fromEntries(SHARED.filter((k) => k in doc.attrs && doc.attrs[k] !== base[k] && JSON.stringify(doc.attrs[k]) !== JSON.stringify(base[k]))
      .map((k) => [k, doc.attrs[k]]));
    synced = { ...doc.attrs };
    onChange?.({ content: editor.getJSON().content, attrs });
  };
  editor.on('transaction', ({ transaction }) => {
    if (!transaction.docChanged || transaction.getMeta('wordStoryRefresh')) return;
    clearTimeout(timer);
    timer = setTimeout(flush, BATCH_MS);
  });
  editor.on('focus', () => setStory(kind, editor));

  // The main doc's shared attributes changed (a style edit, a list made elsewhere, undo): the story follows, outside its history.
  const refresh = () => {
    if (editor.isDestroyed || main.isDestroyed) return;
    const from = main.state.doc.attrs;
    const tr = editor.state.tr;
    const own = editor.state.doc.attrs;
    for (const k of SHARED) {
      if (!(k in own) || from[k] === undefined || from[k] === own[k] || own[k] !== synced[k]) continue;
      tr.setDocAttribute(k, from[k]);
      synced[k] = from[k];
    }
    if (tr.steps.length) editor.view.dispatch(tr.setMeta('addToHistory', false).setMeta('wordStoryRefresh', true));
  };
  main?.on('transaction', refresh);

  return {
    editor,
    focus: () => editor.commands.focus(),
    destroy() {
      flush();
      main?.off('transaction', refresh);
      clearStory(editor);
      editor.destroy();
    },
  };
}

/** Writes a story's batch back into `main` in one transaction with meta 'wordEngine': the shared `attrs` it changed, then
 * `write(tr)` for the owner's own part (the content into its attribute). One main undo step undoes the batch. */
export function writeBack(main, attrs, write) {
  const tr = closeHistory(main.state.tr); // its own undo step, never merged into the typing before it
  for (const [k, v] of Object.entries(attrs ?? {})) tr.setDocAttribute(k, v);
  write?.(tr);
  if (tr.steps.length) main.view.dispatch(tr.setMeta('wordEngine', true));
}
