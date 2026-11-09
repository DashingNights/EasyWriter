// Panes (docs/plans/word plan.md §1.7): one pane per side (left, right, bottom) beside or under the editor area, opened with
// props that reach its Component. The store holds the pane id open on each side (panes); the props live here. Each pane root
// carries data-pane and data-pane-side for F6, the pane menu and harness cases. The user drags the inner edge; the size is kept
// per pane in settings.word.paneWidths. App.jsx places the hosts (Documents only).
import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../app/components/Tip.jsx';
import { keepFocus } from '../app/components/Toolbar.jsx';
import { getState, setState, useStore } from '../app/store.js';
import { saveWord } from '../document/word/settings.mjs';
import { putKeyed, useWordCtx } from './registry.js';

/** @typedef {{title: string, side: 'left'|'right'|'bottom', width?: number, Component: import('react').ComponentType<{ctx: object, close: () => void, props: object}>}} PaneSpec */

const panes = new Map(); // id → {owner, value: PaneSpec}
const paneProps = new Map(); // id → the props it was last opened with

/** Registers `owner`'s panes (PaneSpec by id) under the merge rules of plan.md §1.2. */
export const registerPanes = (owner, specs) => putKeyed(panes, 'pane', owner, specs);

const sideOf = (id) => Object.entries(getState().panes).find(([, open]) => open === id)?.[0] ?? null;

function setSide(side, id) {
  setState({ panes: { ...getState().panes, [side]: id } });
}

/** Opens pane `id` with `props` on its side, replacing the pane open there. */
export function openPane(id, props = {}) {
  const spec = panes.get(id)?.value;
  if (!spec) return;
  paneProps.set(id, props);
  setSide(spec.side, id);
}

/** Closes pane `id` if it is open. */
export function closePane(id) {
  const side = sideOf(id);
  if (side) setSide(side, null);
}

/** Opens pane `id` with `props`, or closes it when it is open. */
export const togglePane = (id, props) => (sideOf(id) ? closePane(id) : openPane(id, props));

/** Whether pane `id` is open. */
export const paneOpen = (id) => !!sideOf(id);

const REM = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 13;

/** The pane open on `side` with its title bar, close button and draggable inner edge, or nothing. */
export function PaneHost({ side }) {
  const id = useStore((s) => s.panes[side]);
  const stored = useStore((s) => (id ? s.settings?.word?.paneWidths?.[id] : null));
  const ctx = useWordCtx();
  const [drag, setDrag] = useState(null); // the size while the edge is dragged, rem
  const start = useRef(null);
  const spec = id ? panes.get(id)?.value : null;
  if (!spec) return null;
  const bottom = side === 'bottom';
  const size = drag ?? stored ?? spec.width ?? (bottom ? 14 : 18);
  const close = () => closePane(id);
  // The inner edge: right of a left pane, left of a right pane, the top of the bottom pane.
  const sign = side === 'left' ? 1 : -1;
  const down = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { at: bottom ? e.clientY : e.clientX, size };
  };
  const move = (e) => {
    if (!start.current) return;
    const d = ((bottom ? start.current.at - e.clientY : (e.clientX - start.current.at) * sign) / REM());
    setDrag(Math.min(60, Math.max(10, Math.round((start.current.size + d) * 4) / 4)));
  };
  const up = () => {
    if (start.current && drag != null) saveWord({ paneWidths: { [id]: drag } });
    start.current = null;
    setDrag(null);
  };
  const Component = spec.Component;
  return (
    <aside data-pane={id} data-pane-side={side} aria-label={spec.title} style={bottom ? { height: `${size}rem` } : { width: `${size}rem` }}
      className={`relative flex shrink-0 flex-col bg-card text-sm text-card-foreground ${bottom ? 'border-t' : side === 'left' ? 'border-r' : 'border-l'}`}>
      <div className="flex items-center justify-between py-1 pr-1 pl-3">
        <span className="font-medium">{spec.title}</span>
        <IconButton label={`Close ${spec.title.toLowerCase()} pane`} onMouseDown={keepFocus} onClick={close}><X /></IconButton>
      </div>
      <div data-pane-body="" className="min-h-0 flex-1 overflow-auto">
        <Component ctx={ctx} close={close} props={paneProps.get(id) ?? {}} />
      </div>
      <div role="separator" aria-orientation={bottom ? 'horizontal' : 'vertical'} aria-label={`Resize ${spec.title.toLowerCase()} pane`}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        className={`absolute z-10 hover:bg-ring/50 ${bottom ? 'inset-x-0 top-0 h-1 cursor-row-resize' : `inset-y-0 w-1 cursor-col-resize ${side === 'left' ? 'right-0' : 'left-0'}`}`} />
    </aside>
  );
}
