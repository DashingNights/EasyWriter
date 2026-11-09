// bd-snap's guides (docs/plans/board/briefs/bd-snap.md): the screen-plane overlay showing what a drag lined up with, from
// flow/snap.mjs's guides(). Board px in, points through look.mjs, screen px through the camera, so a label keeps its size at
// any zoom. Editor only: nothing in an export draws them.
import { useSyncExternalStore } from 'react';
import { kOf } from '../engine/view/camera.mjs';
import { guides as guidesOf } from '../flow/snap.mjs';
import { toPt } from './look.mjs';
import { guideState } from './tools/snap.js';

const PINK = '#ff4d9d';
const LINE = { stroke: PINK, strokeWidth: 1 };
const LABEL = { position: 'absolute', padding: '1px 4px', borderRadius: 2, background: PINK, color: '#ffffff',
  font: '11px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none' };

/** A board px point on screen: points through look.mjs, then the camera (a zoom gesture's while one runs). */
function at(vp, x, y) {
  const cam = vp.gesture ?? vp.camera;
  const k = kOf(cam.zoom);
  return { x: (toPt(x) - cam.x) * k, y: (toPt(y) - cam.y) * k };
}

// A guide's two ends on screen: axis 'x' runs along x at cross position `at` (a vertical line), 'y' the other way.
const ends = (vp, it) => (it.axis === 'x' ? [at(vp, it.at, it.a), at(vp, it.at, it.b)] : [at(vp, it.a, it.at), at(vp, it.b, it.at)]);

const value = (px) => Math.round(toPt(px));

/** The guides of the gesture in hand; `viewport` is the Viewport it draws on (a screen-plane overlay). */
export function Guides({ viewport: vp }) {
  useSyncExternalStore(guideState.subscribe, guideState.version);
  const g = guideState.current;
  if (!vp || !g) return null;
  const list = guidesOf(g.box, g.q, g.hits, { level: g.level, kind: g.kind });
  const lines = [];
  const labels = [];
  list.forEach((it, i) => {
    if (it.type === 'line') {
      const [a, b] = ends(vp, it);
      lines.push(<line key={i} data-board-guide="line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} style={LINE} />);
    } else if (it.type === 'mark') {
      const p = at(vp, it.x, it.y);
      lines.push(<path key={i} data-board-guide="mark" style={LINE} fill="none"
        d={`M${p.x - 3} ${p.y - 3}L${p.x + 3} ${p.y + 3}M${p.x + 3} ${p.y - 3}L${p.x - 3} ${p.y + 3}`} />);
    } else if (it.type === 'gap' || it.type === 'distance') {
      const [a, b] = ends(vp, it);
      lines.push(<line key={i} data-board-guide={it.type} x1={a.x} y1={a.y} x2={b.x} y2={b.y} style={LINE} />);
      labels.push(<div key={i} data-board-guide={it.type} style={{ ...LABEL, transform: 'translate(-50%, -130%)',
        left: (a.x + b.x) / 2, top: (a.y + b.y) / 2 }}>{value(it.value)}</div>);
    } else if (it.type === 'size') {
      const p = at(vp, it.x + it.w, it.y + it.h);
      labels.push(<div key={i} data-board-guide="size" style={{ ...LABEL, transform: 'translateX(-50%)', left: p.x,
        top: p.y + 8 }}>{value(it.w)} x {value(it.h)}</div>);
    }
  });
  if (!lines.length && !labels.length) return null;
  return (
    <div data-board-guides="" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <svg style={{ position: 'absolute', inset: 0, overflow: 'visible' }} width="100%" height="100%">{lines}</svg>
      {labels}
    </div>
  );
}
