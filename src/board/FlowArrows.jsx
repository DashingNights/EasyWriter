// A section's reading order (docs/plans/board/briefs/bd-section.md, design section 6): faint arrows from each page's right
// middle to the next page in reading order's left middle, hidden under 12 % zoom. A screen-plane overlay, never part of an
// export.
import { useSyncExternalStore } from 'react';
import { planeMap } from './Selection.jsx';
import { arrows, rectsOf } from './sections.mjs';
import { dragOffset, sectionBoard } from './tools/section.js';

const MIN_K = 0.12;
const HEAD = 6; // px

/** The path of an arrow's head at `b`, 6 px back along the line from `a`. */
function head(a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const [ux, uy] = [(b.x - a.x) / len, (b.y - a.y) / len];
  const [bx, by] = [b.x - ux * HEAD, b.y - uy * HEAD];
  return `M${bx - uy * 3} ${by + ux * 3}L${b.x} ${b.y}L${bx + uy * 3} ${by - ux * 3}`;
}

export function FlowArrows({ viewport: vp }) {
  const ctx = sectionBoard.ctx;
  useSyncExternalStore(dragOffset.subscribe, dragOffset.version);
  useSyncExternalStore(vp.watch, vp.version);
  if (!ctx || !vp) return null;
  const m = planeMap(vp); // the zoom gesture's while one runs

  if (vp.camera.zoom < MIN_K) return null;
  const off = dragOffset.current;
  const at = m.at;
  const lines = [];
  for (const item of ctx.store.live()) {
    if (item.type !== 'doc' || item.gone || item.hidden) continue;
    const pages = ctx.instances?.pagesOf(item.id) ?? [];
    if (pages.length < 2) continue;
    const rects = rectsOf(item, pages).map((r, i) => (off.id === item.id && (off.page == null || off.page === i)
      ? { ...r, x: r.x + off.dx, y: r.y + off.dy } : r));
    for (const [i, a] of arrows(rects).entries()) {
      const [from, to] = [at(a.from), at(a.to)];
      lines.push(<line key={`${item.id}:${i}`} data-board-section-arrow="" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />);
      lines.push(<path key={`${item.id}:${i}:head`} data-board-section-head="" d={head(from, to)} />);
    }
  }
  if (!lines.length) return null;
  return (
    <div data-board-section-arrows="" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <svg style={{ position: 'absolute', inset: 0, overflow: 'visible', color: 'var(--foreground, #333333)', opacity: 0.25 }}
        width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="1">{lines}</svg>
    </div>
  );
}
