// What a drag between a page and the board shows (docs/plans/board/briefs/bd-dragout.md): a dashed box the size of what is dragged,
// or for text a pill with its first words (the chip a draft row carries from the sidebar: one drag look for the app), and a 2 px
// outline on the page that would take the drop. A screen-plane overlay, so it keeps its size at any zoom.
import { Type } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { CHIP_CLASS } from '../app/components/dragChip.js';
import { planeMap } from './Selection.jsx';

const ACCENT = 'var(--primary, #0d99ff)';
const NONE = { position: 'absolute', pointerEvents: 'none' };

/** The overlay of one board, drawing that board's drag `state` (tools/dragout.js: an observable of what to draw, in world points). */
export const ghostFor = (state) => function DragGhost({ viewport: vp }) {
  useSyncExternalStore(state.subscribe, state.version);
  useSyncExternalStore(vp.watch, vp.version);
  const g = state.current;
  if (!g || !vp) return null;
  const m = planeMap(vp);
  const out = [];
  if (g.over) {
    const a = m.at(g.over);
    out.push(<div key="page" data-board-drop-page="" style={{ ...NONE, left: a.x, top: a.y, width: g.over.w * m.k, height: g.over.h * m.k,
      outline: `2px solid ${ACCENT}`, outlineOffset: -1 }} />);
  }
  if (g.box) {
    const a = m.at(g.box);
    out.push(<div key="box" data-board-drag-box="" style={{ ...NONE, left: a.x, top: a.y, width: g.box.w * m.k, height: g.box.h * m.k,
      border: `2px dashed ${ACCENT}`, background: `color-mix(in srgb, ${ACCENT} 8%, transparent)` }} />);
  }
  if (g.label) {
    const a = m.at(g.pointer);
    out.push(
      <div key="pill" data-drag-chip="" className={`absolute ${CHIP_CLASS}`} style={{ left: a.x + 14, top: a.y + 10, borderColor: ACCENT }}>
        <Type />
        <span className="truncate">{g.label}</span>
      </div>,
    );
  }
  return <div data-board-dragout="" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{out}</div>;
};
