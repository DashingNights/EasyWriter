import { CircleAlert } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useViewportBox } from '../viewport.js';

// The opening card (docs/plans/word/briefs/open-worker.md): while a Word file or a large draft opens, its name, the stage and
// the pages laid out so far, with Cancel; when an open fails, the reason, with Close. Centred across the page area's viewport, a
// third of the way down, it leaves the sidebar, the menus and the other drafts working. It keeps its own small store: the layout's progress updates it
// four times a second, and every app store update re-renders each Word control (registry ctxOf).

let card = null; // {key, name, stage, done, estimate, cancel} or {key, name, error, close}
const listeners = new Set();
const subscribe = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};
const show = (next) => {
  card = next;
  listeners.forEach((f) => f());
};

/** Shows the card for opening `name` at `patch` ({stage, cancel}) → its key for stepOpening and endOpening. */
export function startOpening(name, patch) {
  const key = {};
  show({ key, name, ...patch });
  return key;
}

/** Updates the card of `key` with `patch` ({stage, done, estimate, cancel}) while it shows. */
export const stepOpening = (key, patch) => key && card?.key === key && show({ ...card, ...patch });

/** Ends the card of `key` while it shows. */
export const endOpening = (key) => key && card?.key === key && show(null);

/** Shows why `name` could not open (`reason`) in place of any card; Close runs `close`. */
export const failOpening = (name, reason, close = null) => show({ key: {}, name, error: reason || 'Something went wrong.', close });

/** Resolves once the card has painted (a frame, or 100 ms in a window that draws none): before a long synchronous step. */
export const painted = () => Promise.race([new Promise((r) => requestAnimationFrame(() => setTimeout(r))), new Promise((r) => setTimeout(r, 100))]);

export function OpenProgress() {
  const c = useSyncExternalStore(subscribe, () => card);
  const box = useViewportBox(!!c);
  if (!c || !box) return null;
  const pages = c.done != null && `Laying out pages: ${c.done}${c.estimate ? ` of about ${c.estimate}` : ''}`;
  // Either button takes the card away first: Cancel's and Close's work may open another draft, which takes a moment.
  const act = (f) => () => {
    show(null);
    f?.();
  };
  // Anchored at its top, so the line that changes never moves the Cancel button (the size of every progress state is the same).
  return (
    <div className="pointer-events-none absolute z-30 grid justify-items-center"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height, paddingTop: Math.round(box.height * 0.3) }}>
      <div data-open-card={c.error ? 'error' : 'progress'} role={c.error ? 'alert' : 'status'}
        className="pointer-events-auto h-max w-80 max-w-[calc(100%-32px)] rounded-island border bg-island p-4 text-sm shadow-xl">
        <div className="flex items-center gap-2 font-medium">
          {c.error ? <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" /> : <Spinner />}
          <span className="truncate">{c.error ? 'This document could not be opened' : `Opening ${c.name}`}</span>
        </div>
        {c.error ? (
          <>
            <p className="mt-1 truncate">{c.name}</p>
            <p data-open-reason className="mt-1 break-words text-muted-foreground">{c.error}</p>
          </>
        ) : (
          <>
            <p data-open-stage className="mt-1 truncate text-muted-foreground">{pages || c.stage}</p>
            <div className={cn('mt-3 h-1 overflow-hidden rounded-full bg-muted', !(c.estimate && c.done != null) && 'invisible')}>
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (100 * (c.done ?? 0)) / (c.estimate || 1))}%` }} />
            </div>
          </>
        )}
        <div className="mt-3 flex justify-end">
          {/* While the pages draw the page cannot answer a click: Cancel stays, disabled */}
          <Button variant="outline" size="sm" disabled={!c.error && !c.cancel} onClick={act(c.error ? c.close : c.cancel)}>{c.error ? 'Close' : 'Cancel'}</Button>
        </div>
      </div>
    </div>
  );
}
