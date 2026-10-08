import { useEffect, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { keyIs, keyLabel } from '../../keybinds.js';
import { armTile, CHROME, ShapeList, useSnapshot } from '../board/controls.jsx';
import { Tip } from '../Tip.jsx';

// The library editor's shape panel (SPEC §6g; draw.io-like): the shape list docked on the left of the board. Its width,
// collapsed state and closed sections are the user's, kept in localStorage.
const KEY = 'daf-writer.shapePanel';
const [MIN, MAX] = [200, 360]; // px
const root = () => document.getElementById('workspace-root');

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return { w: Math.min(MAX, Math.max(MIN, Number(v.w) || 240)), collapsed: !!v.collapsed, closed: Array.isArray(v.closed) ? v.closed : [] };
  } catch {
    return { w: 240, collapsed: false, closed: [] };
  }
}

/** The shape panel of `board` (the library editor's; laid out before it exists, so the editor's opening view is final): search ( / ), collapsible sections; a tile's click arms the tool, a drag
 * places it where it is released on the board, a double-click adds it at the centre of the view (ShapeList). Escape in it
 * hands the focus back to the board. Its right edge drags its width (200–360 px). */
export function ShapePanel({ board }) {
  const [ui, setUi] = useState(load);
  const [last, setLast] = useState(null); // the connector / text tile last armed (the snapshot does not tell them apart)
  const ref = useRef(null);
  const snap = useSnapshot(board);
  const update = (patch) => setUi((u) => ({ ...u, ...patch }));
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(ui));
    } catch { /* not kept */ }
  }, [ui]);

  // `/` (not typing) opens it and focuses the search; Escape inside it goes back to the board (before the workspace's Escape).
  useEffect(() => {
    const onKey = (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target.isContentEditable;
      if (!keyIs('flows.find', e) || e.defaultPrevented || typing) return; // §7k
      e.preventDefault();
      update({ collapsed: false });
      requestAnimationFrame(() => ref.current?.querySelector('[aria-label="Search shapes"]')?.focus());
    };
    const onEscape = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      board?.focus();
    };
    const el = ref.current;
    root()?.addEventListener('keydown', onKey);
    el?.addEventListener('keydown', onEscape);
    return () => {
      root()?.removeEventListener('keydown', onKey);
      el?.removeEventListener('keydown', onEscape);
    };
  }, [board, ui.collapsed]);

  const resize = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const [x0, w0] = [e.clientX, ui.w];
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => update({ w: Math.min(MAX, Math.max(MIN, Math.round(w0 + ev.clientX - x0))) });
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };

  const toggle = (
    <Tip title={ui.collapsed ? (keyLabel('flows.find') ? `Show shapes ( ${keyLabel('flows.find')} )` : 'Show shapes') : 'Hide shapes'} side="right">
      <Button variant="ghost" size="icon-xs" aria-label={ui.collapsed ? 'Show shapes' : 'Hide shapes'} onMouseDown={(e) => e.preventDefault()}
        onClick={() => update({ collapsed: !ui.collapsed })}>
        {ui.collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </Button>
    </Tip>
  );
  if (ui.collapsed) {
    return <aside ref={ref} {...CHROME} aria-label="Shapes" className="flex w-8 shrink-0 flex-col items-center border-r bg-card pt-1">{toggle}</aside>;
  }
  const s = snap ?? {};
  const current = s.mode === 'shape' ? (s.prefab ? `prefab:${s.prefab}` : `kind:${s.shape?.shape}`)
    : (s.mode === 'connector' && last?.startsWith('conn:')) || (s.mode === 'text' && last?.startsWith('text:')) ? last : null;
  const pick = (r, x) => {
    if (!x || !board) return;
    armTile(board, x);
    setLast(r);
    board.focus(); // the next click on the board places it
  };
  return (
    <aside ref={ref} {...CHROME} aria-label="Shapes" style={{ width: ui.w }} className="relative flex shrink-0 flex-col border-r bg-card text-sm">
      <div className="flex h-8 shrink-0 items-center px-1.5 text-xs font-medium text-muted-foreground">
        <span className="flex-1">Shapes</span>
        {toggle}
      </div>
      {board && (
        <ShapeList board={board} current={current} withPrefabs panel closed={ui.closed} pick={pick}
          toggle={(id) => update({ closed: ui.closed.includes(id) ? ui.closed.filter((c) => c !== id) : [...ui.closed, id] })} />
      )}
      <div role="separator" aria-orientation="vertical" aria-label="Resize the shapes panel" onPointerDown={resize}
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-ring/40" />
    </aside>
  );
}
