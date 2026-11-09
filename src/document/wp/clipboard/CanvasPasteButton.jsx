// The Paste Options button on a canvas draft (docs/plans/engine/stage2/gaps.md clipboard, G29): at the end of the last paste
// while the engine keeps it (edit.pasteOptions), as the DOM editor's button.js draws it there. A click, or the paste.optionsButton
// row (hooks.pasteMenu), opens its menu; a pick runs paste.optionsButton with that choice, so the engine pastes again in one undo
// step. Letters pick while the menu is open; Esc closes it.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ctxOf, run, useWordValue } from '../../../tooling/registry.js';
import { REPASTE, hooks } from '../../canvas/rows/home.mjs';
import { LABELS, LETTERS } from './modes.mjs';

const MORE = { nestTable: ['Nest Table', 'N'], insertAsNewRows: ['Insert as New Rows', 'R'], overwriteCells: ['Overwrite Cells', 'O'],
  continue: ['Continue List', 'C'], new: ['New List', 'N'] };
const MENU_ID = Object.fromEntries(Object.entries(REPASTE).map(([dom, eng]) => [eng, dom])); // edit.repaste's option → the menu id

let open = false;
let version = 0;
const fns = new Set();
const setOpen = (v) => {
  open = v;
  version++;
  for (const fn of fns) fn();
  return true;
};
hooks.pasteMenu = () => setOpen(!open);

/** The menu rows of the last paste `lp` → [{id, label, letter}]. */
const rowsOf = (lp) => lp.options.map((o) => {
  const id = MENU_ID[o] ?? o;
  const [label, letter] = MORE[id] ?? [LABELS[id] ?? id, LETTERS[id] ?? id[0].toUpperCase()];
  return { id, label, letter };
});

/** Drawn over each page of the focused canvas draft; shows on the page holding the last paste's end. */
export function CanvasPasteButton({ session, page, k }) {
  // Only the last paste re-renders it (as text, so a new snapshot with the same paste does not): a keystroke's snapshot reaches
  // every visible page's copy.
  const pasted = useWordValue((ctx) => {
    const e = ctx.engine?.id === session ? ctx.stateOf('edit.pasteOptions') : null;
    return e?.checked ? JSON.stringify(e.value) : '';
  });
  useSyncExternalStore((fn) => (fns.add(fn), () => fns.delete(fn)), () => version);
  const lp = useMemo(() => (pasted ? JSON.parse(pasted) : null), [pasted]);
  const [at, setAt] = useState(null);
  const endKey = JSON.stringify(lp?.end ?? null);
  useEffect(() => {
    let live = true;
    if (!lp) {
      setAt(null);
      if (open) setOpen(false);
      return undefined;
    }
    Promise.resolve(ctxOf().engine?.caret(lp.end)).then((c) => live && setAt(c ?? null));
    return () => {
      live = false;
    };
  }, [endKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = lp ? rowsOf(lp) : [];
  useEffect(() => {
    if (!open || !lp || at?.page !== page) return undefined;
    const keys = (ev) => {
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        setOpen(false);
        return;
      }
      const row = ev.key.length === 1 && rows.find((r) => r.letter === ev.key.toUpperCase());
      if (row) {
        ev.preventDefault();
        ev.stopPropagation();
        setOpen(false);
        run('paste.optionsButton', row.id);
      } else setOpen(false);
    };
    document.addEventListener('keydown', keys, true);
    return () => document.removeEventListener('keydown', keys, true);
  });
  if (!lp || !at || at.page !== page) return null;
  return (
    <div data-paste-options="" className="absolute flex flex-col items-start" style={{ left: at.x * k + 2, top: (at.y + at.h) * k + 2, pointerEvents: 'auto' }}>
      <button type="button" aria-label="Paste Options" aria-haspopup="menu" aria-expanded={open} title="Paste Options (Ctrl)"
        className="flex h-5 items-center rounded-sm border bg-card px-1 text-xs text-card-foreground shadow-sm hover:bg-accent"
        onMouseDown={(ev) => ev.preventDefault()} onClick={() => setOpen(!open)}>Paste Options</button>
      {open && (
        <div role="menu" aria-label="Paste Options" className="mt-0.5 flex min-w-52 flex-col rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-lg">
          {rows.map((r) => (
            <button key={r.id} type="button" role="menuitem" data-item={r.id} data-letter={r.letter}
              aria-checked={MENU_ID[lp.option] === r.id || lp.option === r.id}
              className="flex items-center justify-between gap-4 rounded-sm px-2 py-1 text-left hover:bg-accent"
              onMouseDown={(ev) => ev.preventDefault()} onClick={() => (setOpen(false), run('paste.optionsButton', r.id))}>
              <span>{r.label}</span><kbd className="text-xs text-muted-foreground">{r.letter}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
