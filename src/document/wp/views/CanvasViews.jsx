// The views on a canvas draft (docs/plans/engine/stage2b.md, engine-gaps-views): what the canvas page area shows of them beside
// its placements. Side to Side's Thumbnails bar, its turns by the wheel and Page Up and Down, a click on a thumbnail and a
// double-click back to Vertical, and Immersive Reader's Line Focus over the engine's caret. Unlike the DOM editor's page copies,
// the pages here are the engine's own, so the caret and editing work on them.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { LayoutGrid } from 'lucide-react';
import { useStore } from '../../../app/store.js';
import { screenStart } from '../../../engine/view/arrange.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { setMove } from './state.js';
import { focusBand } from './views.mjs';

const NO_INPUT = { subscribe: () => () => {}, snapshot: () => null };

/** Side to Side's bar over the page area: the Thumbnails switch and which pages show (`first`, `per` a screen, of `count`). */
export function CanvasSideBar({ thumbs, first, per, count }) {
  const last = Math.min(first + per, count);
  return (
    <div style={{ position: 'sticky', top: 0, left: 0, height: 0, zIndex: 6 }}>
      <div data-thumbs-bar="" className="pointer-events-auto absolute inset-x-0 top-0 flex h-8 items-center gap-2 border-b bg-card px-2 text-xs">
        <button type="button" data-thumbs-toggle="" aria-pressed={thumbs} onClick={() => setMove('side', { thumbs: !thumbs })}
          className={cn('flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent', thumbs && 'bg-accent')}>
          <LayoutGrid className="size-3.5" />Thumbnails
        </button>
        <span className="text-muted-foreground">
          {!count || thumbs ? '' : last - first > 1 ? `Pages ${first + 1} to ${last} of ${count}` : `Page ${first + 1} of ${count}`}
        </span>
      </div>
    </div>
  );
}

/** Puts `client`'s caret at the top of page `page` (a turn in Side to Side moves it to the first page shown, as the DOM path's). */
async function caretTo(client, page) {
  const r = await client.hit(page, 0, 0);
  if (r?.pos) await client.select(r.pos, r.pos);
}

/** Side to Side and Thumbnails on viewport `vp` of `client` while `arr` is 'side' or 'thumbs': the wheel and Page Up and Down turn
 * a screen of `per` pages of `count` (Ctrl+wheel goes between the pages and their thumbnails, Word's); a click on a thumbnail
 * shows its screen; a double-click on a page returns to Vertical there; a caret moved off the screen (typing, Find) brings its
 * screen. `input()` → the focused session's input handle (its caret). */
export function useCanvasSide(vp, client, { arr, first, per, count, input }) {
  const rest = useRef(0); // when the wheel last turned: a trackpad's stream of small deltas turns once
  useEffect(() => {
    if (!vp || (arr !== 'side' && arr !== 'thumbs')) return undefined;
    const root = vp.root;
    const turn = (to) => {
      const f = screenStart(Math.max(0, to), per, count);
      if (f === first) return;
      setMove('side', { first: f });
      caretTo(client, f).catch(() => {});
    };
    const onWheel = (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.deltaY && Date.now() - rest.current > 250) {
          rest.current = Date.now();
          setMove('side', { thumbs: e.deltaY > 0 });
        }
        return;
      }
      if (arr === 'thumbs') return; // the thumbnails scroll
      e.preventDefault();
      e.stopImmediatePropagation();
      if (Date.now() - rest.current < 250 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
      rest.current = Date.now();
      turn(first + ((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? per : -per));
    };
    const onKey = (e) => {
      if (arr !== 'side' || (e.key !== 'PageDown' && e.key !== 'PageUp') || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      turn(first + (e.key === 'PageDown' ? per : -per));
    };
    const onClick = (e) => {
      const t = arr === 'thumbs' && vp.fromClient(e.clientX, e.clientY).target;
      if (t) setMove('side', { thumbs: false, first: t.surface });
    };
    const onDouble = (e) => {
      if (arr === 'side' && vp.fromClient(e.clientX, e.clientY).target) setMove('vertical');
    };
    // A caret that moves to a page off the screen brings its screen (only a move: a turn puts the caret on the screen first).
    let was = input()?.snapshot()?.caret?.page;
    const follow = () => {
      const page = input()?.snapshot()?.caret?.page;
      if (page == null || page === was) return;
      was = page;
      if (arr === 'side' && (page < first || page >= first + per)) setMove('side', { first: screenStart(page, per, count) });
    };
    const off = input()?.subscribe(follow);
    root.addEventListener('wheel', onWheel, { capture: true, passive: false });
    root.addEventListener('keydown', onKey, true);
    root.addEventListener('click', onClick);
    root.addEventListener('dblclick', onDouble);
    return () => {
      off?.();
      root.removeEventListener('wheel', onWheel, { capture: true });
      root.removeEventListener('keydown', onKey, true);
      root.removeEventListener('click', onClick);
      root.removeEventListener('dblclick', onDouble);
    };
  }, [vp, client, arr, first, per, count, input]);
}

/** Immersive Reader's Line Focus on a canvas draft, a screen plane overlay: the rest of the page area dimmed round a band of 1, 3
 * or 5 lines at the caret of `input` (session `session`'s input handle), which follows it. */
export function CanvasLineFocus({ viewport: vp, input, session }) {
  const n = useStore((s) => wordSettings(s.settings).immersive.lineFocus);
  const snap = useSyncExternalStore((input ?? NO_INPUT).subscribe, (input ?? NO_INPUT).snapshot);
  const c = snap?.caret;
  if (!n || !c) return null;
  const line = vp.rectOf({ session, surface: c.page, x: c.x, y: c.y, w: 0, h: c.h }, 'screen');
  const p = vp.placements.find((q) => q.surface === c.page && q.session === session);
  const page = p && vp.rectOf({ session, surface: c.page, x: 0, y: 0, w: p.w, h: p.h }, 'screen');
  if (!line || !page) return null;
  const b = focusBand({ top: line.top, bottom: line.top + line.height }, n, { top: page.top, bottom: page.top + page.height });
  return (
    <div data-line-focus={n} style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      <div data-dim="" className="absolute inset-x-0 top-0 bg-black/60" style={{ height: Math.max(0, b.top) }} />
      <div data-line-band="" className="absolute inset-x-0" style={{ top: b.top, height: b.bottom - b.top }} />
      <div data-dim="" className="absolute inset-x-0 bottom-0 bg-black/60" style={{ top: b.bottom }} />
    </div>
  );
}
