// proofing's strip under the ribbon (slots.belowRibbon, plan.md §1.7): the Read Aloud bar while it reads, with its controls at the
// right end (Word puts them at the top right of the window; ours stay inside the page area, direction.md section 6), and the small
// menu Alt+F7 opens at the next flagged word.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Pause, Play, Settings, X } from 'lucide-react';
import { IconButton } from '../../../app/components/Tip.jsx';
import { keepFocus } from '../../../app/components/Toolbar.jsx';
import { tell } from './plugin.js';
import { configure, onRead, RATES, readState, step, stop, toggle } from './readaloud.js';
import { addWord, ignoreWord } from './spell.js';

const speech = () => globalThis.__wordTest?.speech ?? globalThis.speechSynthesis ?? null;

/** The Read Aloud bar: Previous, Play or Pause, Next, Settings (reading speed and voice), Close. */
function ReadAloudBar() {
  const st = useSyncExternalStore(onRead, readState);
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState([]);
  useEffect(() => {
    if (!open) return undefined;
    const load = () => setVoices(speech()?.getVoices?.() ?? []);
    load();
    const S = speech();
    S?.addEventListener?.('voiceschanged', load);
    return () => S?.removeEventListener?.('voiceschanged', load);
  }, [open]);
  if (!st.active) return null;
  return (
    <div data-read-aloud-bar="" data-paused={st.paused || undefined} className="relative flex h-8 items-center justify-end gap-0.5 border-b bg-card px-2">
      <span className="mr-auto text-xs text-muted-foreground">Reading paragraph {st.index + 1} of {st.count}</span>
      <IconButton label="Previous paragraph" data-read-aloud="prev" onMouseDown={keepFocus} onClick={() => step(-1)}><ChevronLeft /></IconButton>
      <IconButton label={st.paused ? 'Play' : 'Pause'} data-read-aloud="play" onMouseDown={keepFocus} onClick={toggle}>{st.paused ? <Play /> : <Pause />}</IconButton>
      <IconButton label="Next paragraph" data-read-aloud="next" onMouseDown={keepFocus} onClick={() => step(1)}><ChevronRight /></IconButton>
      <IconButton label="Settings" data-read-aloud="settings" pressed={open} onMouseDown={keepFocus} onClick={() => setOpen(!open)}><Settings /></IconButton>
      <IconButton label="Close" data-read-aloud="close" onMouseDown={keepFocus} onClick={stop}><X /></IconButton>
      {open && (
        <div data-read-aloud-settings="" className="absolute top-full right-2 z-30 mt-1 flex w-64 flex-col gap-2 rounded-md border bg-popover p-3 text-xs text-popover-foreground shadow-md">
          <label className="flex flex-col gap-1">
            <span>Reading speed</span>
            <input type="range" min={RATES.min} max={RATES.max} step={RATES.step} value={st.rate} className="accent-primary"
              onChange={(e) => configure({ rate: Number(e.target.value) })} />
          </label>
          <label className="flex flex-col gap-1">
            <span>Voice</span>
            <select value={st.voice ?? ''} onChange={(e) => configure({ voice: e.target.value || null })}
              className="h-6 rounded-md border border-input bg-background px-1">
              <option value="">Default voice</option>
              {voices.map((v) => <option key={v.voiceURI ?? v.name} value={v.name}>{v.name}</option>)}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

// The Alt+F7 menu: {word, suggestions, x, y, replace(w), ignoreAll(), add(), done()} or null; the DOM editor's and a canvas draft's
// (canvas.js) differ only in those actions.
let menu = null;
const menuListeners = new Set();
const setMenu = (m) => {
  menu = m;
  for (const fn of menuListeners) fn();
};
/** Opens the Alt+F7 menu for flagged `item` of editor `ed` with `suggestions`, under the word. */
export function openSpellMenu(ed, item, suggestions) {
  const c = ed.view.coordsAtPos(item.from);
  const done = () => ed.commands.focus();
  setMenu({
    word: item.word, suggestions, x: c.left, y: c.bottom + 2, done,
    replace: (w) => ed.view.dispatch(ed.state.tr.insertText(w, item.from, item.to)),
    ignoreAll: () => ignoreWord(ed, item.word),
    add: async () => {
      await addWord(item.word);
      tell(ed.view, { refresh: true });
    },
  });
}

/** Opens the Alt+F7 menu at client point (x, y) with `actions` ({word, suggestions, replace, ignoreAll, add, done}): a canvas draft's. */
export const openSpellMenuAt = (x, y, actions) => setMenu({ ...actions, x, y });

/** The Alt+F7 menu: the suggestions, Ignore All and Add to Dictionary. Esc or a click elsewhere closes it. */
function SpellMenu() {
  const m = useSyncExternalStore((fn) => {
    menuListeners.add(fn);
    return () => menuListeners.delete(fn);
  }, () => menu);
  const root = useRef(null);
  useEffect(() => {
    if (!m) return undefined;
    root.current?.querySelector('[role="menuitem"]')?.focus();
    const away = (e) => !root.current?.contains(e.target) && setMenu(null);
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [m]);
  if (!m) return null;
  const done = () => {
    setMenu(null);
    m.done?.();
  };
  const replace = async (w) => {
    setMenu(null);
    await m.replace(w);
    m.done?.();
  };
  const ignoreAll = () => {
    m.ignoreAll();
    done();
  };
  const add = () => {
    m.add();
    done();
  };
  const keys = (e) => {
    const items = [...root.current.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') done();
    else if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
    else return;
    e.preventDefault();
  };
  const row = 'cursor-default rounded-sm px-2 py-1 text-left outline-none hover:bg-accent focus:bg-accent';
  return createPortal(
    <div ref={root} role="menu" data-proofing-menu="" data-word={m.word} onKeyDown={keys} style={{ left: m.x, top: m.y }}
      className="fixed z-50 flex min-w-40 flex-col rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md">
      {m.suggestions.length
        ? m.suggestions.map((w) => <button key={w} type="button" role="menuitem" className={`${row} font-medium`} onClick={() => replace(w)}>{w}</button>)
        : <span className="px-2 py-1 text-muted-foreground">No suggestions</span>}
      <div className="my-1 h-px bg-border" />
      <button type="button" role="menuitem" data-spell-act="ignoreAll" className={row} onClick={ignoreAll}>Ignore All</button>
      <button type="button" role="menuitem" data-spell-act="add" className={row} onClick={add}>Add to Dictionary</button>
    </div>,
    document.body,
  );
}

/** The belowRibbon slot: the Read Aloud bar and the Alt+F7 menu. */
export function ProofingBar() {
  return (
    <>
      <ReadAloudBar />
      <SpellMenu />
    </>
  );
}
