import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { findEnd, findReplace, findReplaceAll, findState, findStep, findText } from '../../find.js';
import { getState, setState, useEditor, useStore } from '../store.js';
import { useViewportBox } from '../viewport.js';
import { notify } from './Notices.jsx';
import { Tip } from './Tip.jsx';

// Opens the find bar, or focuses it again; a one-line text selection becomes its query. `replace`: with its replace row
// (null: as it was).
function open(replace) {
  const { state } = getState().editor;
  const text = state.selection.empty ? '' : state.doc.textBetween(state.selection.from, state.selection.to, '\n');
  const find = getState().find;
  setState({ find: {
    n: (find?.n ?? 0) + 1,
    seed: text && !text.includes('\n') && text.length <= 200 ? text : null,
    replace: replace ?? find?.replace ?? false,
  } });
}

/** Find in the draft (Ctrl+F, tool search). */
export const openFind = () => open(null);
/** Find and replace (Ctrl+H, tool search). */
export const openReplace = () => open(true);

/** Find and replace in the draft (find.js): at the top right of the page's viewport. Enter in the find box finds the next match,
 * Shift+Enter the previous one; Enter in the replace box replaces the current match. Replace and Replace all are one undo step
 * each. Escape or the close button ends it with the current match selected in the draft. The texts stay while the bar is open,
 * also across drafts. */
export function FindBar() {
  const find = useStore((s) => s.find);
  const editor = useEditor(); // re-renders on every transaction, so the count follows edits
  const box = useViewportBox(!!find);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const findBox = useRef(null);
  const replaceBox = useRef(null);
  useEffect(() => {
    if (!find) return;
    if (find.seed) setQuery(find.seed);
    // Ctrl+H with a query goes to the replace box; otherwise the find box.
    requestAnimationFrame(() => ((find.replace && (find.seed || findBox.current?.value) ? replaceBox : findBox).current?.select()));
  }, [find?.n]);
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
  const replacing = () => replaceBox.current?.value ?? replacement; // the box itself: an Enter can come before its state updates
  const replaceOne = () => findReplace(editor, replacing());
  const replaceAll = () => {
    const n = findReplaceAll(editor, replacing());
    notify({ text: `Replaced ${n} ${n === 1 ? 'match' : 'matches'}` });
  };
  const keys = (map) => (e) => {
    const fn = map[`${e.shiftKey ? 'Shift+' : ''}${e.key}`] ?? (e.key === 'Escape' && close);
    if (!fn) return;
    e.preventDefault();
    fn();
  };
  const icon = (title, Icon, onClick, enabled = matches.length > 0) => (
    <Tip title={title} side="bottom">
      <Button variant="ghost" size="icon-xs" aria-label={title} disabled={!enabled} onClick={onClick}><Icon /></Button>
    </Tip>
  );
  const field = 'h-7 w-60 text-xs shadow-none md:text-xs focus-visible:ring-1';
  // p-2 around the h-7 fields, so their corners sit evenly inside the island's rounder ones
  return (
    <div role="search" className="absolute z-[26] flex -translate-x-full flex-col gap-2 rounded-island border bg-island p-2 text-xs shadow-xl"
      style={{ left: box.left + box.width - 8, top: box.top + 8 }}>
      <div className="flex items-center gap-1">
        {icon(find.replace ? 'Hide replace' : 'Replace (Ctrl+H)', find.replace ? ChevronDown : ChevronRight,
          () => setState({ find: { ...find, replace: !find.replace } }), true)}
        <div className="relative">
          <Input ref={findBox} aria-label="Find in draft" placeholder="Find in draft" spellCheck={false} className={cn(field, 'pr-20')}
            value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={keys({ Enter: () => findStep(editor, 1), 'Shift+Enter': () => findStep(editor, -1) })} />
          {/* the count at the box's right end, as browsers' find bars show it */}
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground tabular-nums">
            {matches.length ? `${index + 1} of ${matches.length}` : query && 'No results'}
          </span>
        </div>
        {/* at the bar's right edge, also when the replace row is the wider one */}
        <div className="ml-auto flex items-center gap-1">
          {icon('Previous match (Shift+Enter)', ChevronUp, () => findStep(editor, -1))}
          {icon('Next match (Enter)', ChevronDown, () => findStep(editor, 1))}
          {icon('Close (Esc)', X, close, true)}
        </div>
      </div>
      {find.replace && (
        <div className="flex items-center gap-1 pl-7">
          <Input ref={replaceBox} aria-label="Replace with" placeholder="Replace with" spellCheck={false} className={field}
            value={replacement} onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={keys({ Enter: replaceOne })} />
          <Button variant="ghost" size="xs" disabled={!matches.length} onClick={replaceOne}>Replace</Button>
          <Button variant="ghost" size="xs" disabled={!matches.length} onClick={replaceAll}>Replace all</Button>
        </div>
      )}
    </div>
  );
}
