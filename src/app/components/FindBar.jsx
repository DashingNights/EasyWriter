import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { findEnd, findState, findStep, findText } from '../../find.js';
import { getState, setState, useEditor, useStore } from '../store.js';
import { useViewportBox } from '../viewport.js';
import { Tip } from './Tip.jsx';

/** Opens the find bar (Ctrl+F, tool search), or focuses it again; a one-line text selection becomes its query. */
export function openFind() {
  const { state } = getState().editor;
  const text = state.selection.empty ? '' : state.doc.textBetween(state.selection.from, state.selection.to, '\n');
  setState({ find: { n: (getState().find?.n ?? 0) + 1, seed: text && !text.includes('\n') && text.length <= 200 ? text : null } });
}

/** Find in the draft (find.js): at the top right of the page's viewport. Enter finds the next match, Shift+Enter the previous
 * one; Escape or the close button ends it with the current match selected in the draft. The query stays while the bar is open,
 * also across drafts. */
export function FindBar() {
  const find = useStore((s) => s.find);
  const editor = useEditor(); // re-renders on every transaction, so the count follows edits
  const box = useViewportBox(!!find);
  const [query, setQuery] = useState('');
  const input = useRef(null);
  useEffect(() => {
    if (!find) return;
    if (find.seed) setQuery(find.seed);
    requestAnimationFrame(() => input.current?.select());
  }, [find]);
  useEffect(() => {
    if (find && editor && findState(editor).query !== query) findText(editor, query);
  }, [find, editor, query]);
  if (!find || !box || !editor) return null;

  const { matches, index } = findState(editor);
  const close = () => {
    setState({ find: null }); // first, so the effect above does not find again
    findEnd(editor);
    editor.commands.focus(null, { scrollIntoView: false });
  };
  const button = (title, Icon, onClick) => (
    <Tip title={title} side="bottom">
      <Button variant="ghost" size="icon-xs" aria-label={title} disabled={!matches.length && Icon !== X} onClick={onClick}><Icon /></Button>
    </Tip>
  );
  return (
    <div role="search" className="absolute z-[26] flex -translate-x-full items-center gap-1 rounded-island border bg-island p-1 text-xs shadow-xl"
      style={{ left: box.left + box.width - 8, top: box.top + 8 }}>
      <Input ref={input} aria-label="Find in draft" placeholder="Find in draft" spellCheck={false} className="h-7 w-56 text-xs md:text-xs"
        value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') findStep(editor, e.shiftKey ? -1 : 1);
          else if (e.key === 'Escape') close();
          else return;
          e.preventDefault();
        }} />
      <span className="w-16 text-center text-muted-foreground tabular-nums">
        {matches.length ? `${index + 1} of ${matches.length}` : query && 'No results'}
      </span>
      {button('Previous match (Shift+Enter)', ChevronUp, () => findStep(editor, -1))}
      {button('Next match (Enter)', ChevronDown, () => findStep(editor, 1))}
      {button('Close (Esc)', X, close)}
    </div>
  );
}
