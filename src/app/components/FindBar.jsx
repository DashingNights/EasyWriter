import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { findEnd, findReplace, findReplaceAll, findState, findStep, findText } from '../../find.js';
import { run } from '../../tooling/registry.js';
import { activeSurface } from '../../tooling/surface.js';
import { getState, setState, useEditor, useStore } from '../store.js';
import { useViewportBox } from '../viewport.js';
import { notify } from './Notices.jsx';
import { IconButton } from './Tip.jsx';

/** The canvas post the bar searches, or null in the DOM editor: a canvas draft's own doc is stale, so the engine's find
 * (edit.find, edit.findNext, edit.replace, edit.replaceAll; cmd/edit.rs) searches the document the user sees. */
const sessionOf = () => activeSurface()?.session ?? null;

/** A position as one string, to compare the caret with the engine's matches. */
const posOf = (p) => (p ? JSON.stringify([p.story, p.path, p.off]) : '');
const NO_ENGINE_FIND = { count: 0, index: -1 };
/** The engine's find options the bar sends: the query as typed, never Word's ^ codes (a post's text is not a Word document). */
const FIND_OPTS = { special: false };

/** Whether engine position `a` is before `b` in document order: the story, then the path, then the offset. */
function before(a, b) {
  if (!a || !b) return false;
  if (a.story !== b.story) return String(a.story) < String(b.story);
  const pa = a.path ?? [];
  const pb = b.path ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? -1;
    const y = pb[i] ?? -1;
    if (x !== y) return x < y;
  }
  return (a.off ?? 0) < (b.off ?? 0);
}

/** Where the caret of `matches` (in document order) puts the engine's current match: edit.find selects the first one at or after
 * the caret and starts again at the first when none is, and counting from the caret stays right past the first 200 matches the
 * answer lists. */
function indexAt(matches, caret, count) {
  const n = matches.filter((m) => before(m.start, caret)).length;
  return n >= count ? 0 : n;
}

/** The engine's find of `query` → {count, index}. */
async function engineFind(session, query) {
  const at = await session.selection();
  const r = await session.exec('edit.find', { text: query, ...FIND_OPTS });
  const v = (r?.ok && r.value) || {};
  const count = v.count ?? 0;
  if (!count) return NO_ENGINE_FIND;
  return { count, index: indexAt(v.matches ?? [], at?.head, count) };
}

/** Opens the find bar, or focuses it again; a one-line text selection becomes its query. `replace`: with its replace row
 * (null: as it was). */
function open(replace) {
  const session = sessionOf();
  const find = getState().find;
  const n = (find?.n ?? 0) + 1;
  const seedWith = (seed) => setState({ find: { n, seed, replace: replace ?? find?.replace ?? false } });
  if (session) {
    seedWith(null);
    // The selected words become the query, as in the DOM editor. A Ctrl+F opened since has its own n, so this seed is dropped.
    Promise.resolve(session.selection()).then(async (sel) => {
      if (!sel || posOf(sel.anchor) === posOf(sel.head)) return;
      const text = await session.text(sel.anchor, sel.head);
      if (text && !text.includes('\n') && text.length <= 200 && getState().find?.n === n) setState({ find: { ...getState().find, seed: text } });
    }).catch(() => {});
    return;
  }
  const ed = getState().editor;
  if (!ed) return;
  const { state } = ed;
  const text = state.selection.empty ? '' : state.doc.textBetween(state.selection.from, state.selection.to, '\n');
  seedWith(text && !text.includes('\n') && text.length <= 200 ? text : null);
}

/** Find in the draft (Ctrl+F, tool search). A Document finds through Word's Home > Find (the Navigation pane's search). */
export const openFind = () => (activeSurface()?.format === 'document' ? run('home.editing.find') : open(null));
/** Find and replace (Ctrl+H, tool search). A Document opens Word's Find and Replace dialog. */
export const openReplace = () => (activeSurface()?.format === 'document' ? run('home.editing.replace') : open(true));

/** Find and replace in the draft (find.js): at the top right of the page's viewport. Enter in the find box finds the next match,
 * Shift+Enter the previous one; Enter in the replace box replaces the current match. Replace and Replace all are one undo step
 * each. Escape or the close button ends it with the current match selected in the draft. The texts stay while the bar is open,
 * also across drafts. On a canvas post the same bar searches the engine. */
export function FindBar() {
  const find = useStore((s) => s.find);
  const editor = useEditor(); // re-renders on every transaction, so the count follows edits
  useStore((s) => s.focusedSession); // a canvas draft taking the focus switches the bar to the engine
  useStore((s) => s.draft?.id); // and opening another draft re-renders
  const session = sessionOf();
  // A Document has Word's own Find and Replace; a bar left open on a post closes when one opens.
  const documentOpen = activeSurface()?.format === 'document';
  const box = useViewportBox(!!find);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [eng, setEng] = useState(NO_ENGINE_FIND);
  const findBox = useRef(null);
  const replaceBox = useRef(null);
  useEffect(() => {
    if (documentOpen) setState({ find: null });
  }, [documentOpen]);
  useEffect(() => {
    if (!find) return;
    if (find.seed) setQuery(find.seed);
    // Ctrl+H with a query goes to the replace box; otherwise the find box.
    requestAnimationFrame(() => ((find.replace && (find.seed || findBox.current?.value) ? replaceBox : findBox).current?.select()));
  }, [find?.n, find?.seed]);
  // Keyed on the query, the session and the open (n) alone: showing the replace row is no new search, and must not step the
  // caret on to the next match.
  useEffect(() => {
    if (!find) return undefined;
    if (session) {
      let live = true;
      engineFind(session, query).then((r) => live && setEng(r), () => {});
      return () => {
        live = false;
      };
    }
    if (editor && findState(editor).query !== query) findText(editor, query);
    return undefined;
  }, [find?.n, session, editor, query]);
  // An edit in the post (a layout) changes how many matches there are. The count is read with edit.findCount, a query that only
  // reads: a command here would move the caret into a match under the user's next keystroke and end the typing group an undo
  // takes back (and an input method's join), so nothing but a search the user asked for runs while they type.
  useEffect(() => {
    if (!find || !session || !query) return undefined;
    let live = true;
    let timer = 0;
    const refresh = async () => {
      const r = await session.query('edit.findCount', { text: query, ...FIND_OPTS });
      if (live) setEng(r?.ok ? { count: r.value?.count ?? 0, index: r.value?.index ?? 0 } : NO_ENGINE_FIND);
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh().catch(() => {}), 150);
    };
    const off = session.on?.('layout', later);
    return () => {
      live = false;
      clearTimeout(timer);
      off?.();
    };
  }, [find, session, query]);
  if (!find || !box || (!editor && !session)) return null;

  const dom = session ? null : findState(editor);
  const count = dom ? dom.matches.length : eng.count;
  const index = dom ? dom.index : Math.max(0, eng.index);
  const close = () => {
    setState({ find: null }); // first, so the effect above does not find again
    if (session) {
      session.exec('edit.find', { text: '', ...FIND_OPTS }).catch(() => {});
      document.querySelector('[data-canvas-pages]')?.focus({ preventScroll: true });
      return;
    }
    findEnd(editor);
    editor.commands.focus(null, { scrollIntoView: false });
  };
  const step = (dir) => {
    if (!session) return dir > 0 ? findStep(editor, 1) : findStep(editor, -1);
    const id = dir > 0 ? 'edit.findNext' : 'edit.findPrevious';
    return session.exec(id, { text: query, ...FIND_OPTS }).then((r) => {
      if (r?.ok) setEng({ count: r.value?.count ?? 0, index: r.value?.index ?? 0 });
    });
  };
  const replacing = () => replaceBox.current?.value ?? replacement; // the box itself: an Enter can come before its state updates
  // edit.replace replaces the current match and steps to the next itself: searching again here would step once more and skip a
  // match on every press. Its answer's `remaining` is the new count.
  const replaceOne = () => {
    if (!session) return findReplace(editor, replacing());
    return session.exec('edit.replace', { text: query, with: replacing(), ...FIND_OPTS }).then((r) => {
      if (r?.ok === false) return;
      const left = r.value?.remaining ?? 0;
      setEng((e) => ({ count: left, index: Math.min(Math.max(0, e.index), Math.max(0, left - 1)) }));
    });
  };
  const replaceAll = () => {
    if (!session) {
      const n = findReplaceAll(editor, replacing());
      notify({ text: `Replaced ${n} ${n === 1 ? 'match' : 'matches'}` });
      return;
    }
    return session.exec('edit.replaceAll', { text: query, with: replacing(), ...FIND_OPTS }).then((r) => {
      const n = r?.value?.replaced ?? 0;
      notify({ text: `Replaced ${n} ${n === 1 ? 'match' : 'matches'}` });
      // Every match is gone; searching again would only step the caret for nothing.
      if (n) setEng(NO_ENGINE_FIND);
    });
  };
  const keys = (map) => (e) => {
    const fn = map[`${e.shiftKey ? 'Shift+' : ''}${e.key}`] ?? (e.key === 'Escape' && close);
    if (!fn) return;
    e.preventDefault();
    fn();
  };
  const icon = (label, Icon, onClick, enabled = count > 0, props) => (
    <IconButton label={label} tip={{ side: 'bottom' }} disabled={!enabled} onClick={onClick} {...props}><Icon /></IconButton>
  );
  const field = 'w-60 shadow-none focus-visible:ring-1';
  // p-2 around the h-6 fields, so their corners sit evenly inside the island's rounder ones
  return (
    <div role="search" className="absolute z-[26] flex flex-col gap-2 rounded-island border bg-island p-2 text-xs shadow-xl"
      style={{ right: box.right + 8, top: box.top + 8 }}>
      <div className="flex items-center gap-1">
        {icon(find.replace ? 'Hide replace' : 'Replace', find.replace ? ChevronDown : ChevronRight,
          () => setState({ find: { ...find, replace: !find.replace } }), true, { keybind: find.replace ? undefined : 'app.replace', 'aria-expanded': find.replace })}
        <div className="relative">
          <Input ref={findBox} size="xs" aria-label="Find in draft" placeholder="Find in draft" spellCheck={false} className={cn(field, 'pr-20')}
            value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={keys({ Enter: () => step(1), 'Shift+Enter': () => step(-1) })} />
          {/* the count at the box's right end, as browsers' find bars show it */}
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground tabular-nums">
            {count ? `${index + 1} of ${count}` : query && 'No results'}
          </span>
        </div>
        {/* at the bar's right edge, also when the replace row is the wider one */}
        <div className="ml-auto flex items-center gap-1">
          {icon('Previous match (Shift+Enter)', ChevronUp, () => step(-1))}
          {icon('Next match (Enter)', ChevronDown, () => step(1))}
          {icon('Close (Esc)', X, close, true)}
        </div>
      </div>
      {find.replace && (
        <div className="flex items-center gap-1 pl-7">
          <Input ref={replaceBox} size="xs" aria-label="Replace with" placeholder="Replace with" spellCheck={false} className={field}
            value={replacement} onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={keys({ Enter: replaceOne })} />
          <Button variant="ghost" size="xs" disabled={!count} onClick={replaceOne}>Replace</Button>
          <Button variant="ghost" size="xs" disabled={!count} onClick={replaceAll}>Replace all</Button>
        </div>
      )}
    </div>
  );
}
