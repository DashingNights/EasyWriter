// ph-smartart-2: the diagram's shapes on the page, so a click picks one. Word keeps a shape picked inside the selected diagram;
// the engine's commands take an item index, so the pick lives in state.mjs and a press here sets it. The layer follows the
// object's frame, which the layout may have shrunk.
import { useSyncExternalStore } from 'react';
import { setState } from '../../../app/store.js';
import { useWordCtx } from '../../../tooling/registry.js';
import { diagramOf, pickItem, pickedOf, pickVersion, subscribePick } from './state.mjs';

export function ShapesLayer({ session, page, k, frames }) {
  const ctx = useWordCtx();
  useSyncExternalStore(subscribePick, pickVersion);
  const d = ctx.engine?.id === session ? diagramOf(ctx) : null;
  const f = d && frames.find((x) => x.pos && JSON.stringify(x.pos) === JSON.stringify(d.pos));
  if (!f) return null;
  const sx = (f.w / d.w) * k;
  const sy = (f.h / d.h) * k;
  const picked = pickedOf(d);
  const pick = (item) => { pickItem(d.pos, item); setState({}); };
  return (
    <div data-smart-art-shapes={page} style={{ position: 'absolute', left: f.x * k, top: f.y * k, width: f.w * k, height: f.h * k,
      pointerEvents: 'none', ...(d.rotation ? { transform: `rotate(${d.rotation}deg)` } : {}) }}>
      {/* role=button keeps the press off the caret: the page's pointer layer leaves a control's clicks to it (pointer.js CONTROLS). */}
      {d.shapes.map(({ item, rect }) => (
        <div key={item} data-smart-art-item={item} role="button" tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); pick(item); }}
          // The pane takes the focus on the picked row as it mounts (TextPane).
          onDoubleClick={() => { pick(item); ctx.pane('smartArtText', true); }}
          style={{ position: 'absolute', left: rect[0] * sx, top: rect[1] * sy, width: rect[2] * sx, height: rect[3] * sy,
            pointerEvents: 'auto', cursor: 'pointer', ...(item === picked ? { outline: '2px solid var(--ui-accent)', outlineOffset: '1px' } : {}) }} />
      ))}
    </div>
  );
}
