// Small popovers the content controls open from the text (plan.md §3 content-controls): a drop-down's list, the date picker's
// calendar, a title tab's menu. One at a time; a click outside or Esc closes it. Drawn with the app's tokens through Tailwind
// classes, so no package stylesheet rule reaches outside the Document scope.
import { createRoot } from 'react-dom/client';
import { cn } from 'cn';

let current = null;

/** Closes the open popover, if any. */
export function closePop() {
  current?.();
  current = null;
}

/** Opens `render(close)` under `anchor` (an element or a DOMRect). → close. */
export function popover(anchor, render) {
  closePop();
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
  const host = document.createElement('div');
  host.setAttribute('data-cc-pop', '');
  host.style.cssText = `position:fixed;left:${Math.round(r.left)}px;top:${Math.round(r.bottom + 2)}px;z-index:60`;
  document.body.append(host);
  const root = createRoot(host);
  const outside = (e) => !host.contains(e.target) && close();
  const esc = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  };
  function close() {
    if (current === close) current = null;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', esc, true);
    queueMicrotask(() => root.unmount());
    host.remove();
  }
  current = close;
  root.render(<div className="rounded-md border bg-popover text-sm text-popover-foreground shadow-md">{render(close)}</div>);
  // After this mousedown has finished, so the click that opened it does not close it.
  setTimeout(() => {
    if (current !== close) return;
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', esc, true);
  });
  return close;
}

/** A pick list: `items` [{label, active?}], `onPick(index)`. Arrow keys are not needed: Word's list is mouse driven, and the
 * keyboard path (Alt+Down on a form field) opens the same list. */
export function PickList({ items, onPick, empty = 'No items' }) {
  if (!items.length) return <div className="px-3 py-1.5 text-muted-foreground">{empty}</div>;
  return (
    <div role="listbox" className="flex max-h-64 min-w-40 flex-col overflow-auto py-1">
      {items.map((it, i) => (
        <button key={i} type="button" role="option" aria-selected={!!it.active} data-cc-item={i} onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(i)} className={cn('px-3 py-1 text-left hover:bg-accent', it.active && 'bg-accent')}>{it.label}</button>
      ))}
    </div>
  );
}
