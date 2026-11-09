// The board's flat paper (docs/plans/board/briefs/bd-instance.md, design section 5): one canvas under every slot, before the
// sizer, so pages too small for a tile show as white paper with a darker edge, never a stale picture. It also draws the grey
// section of an instance whose draft cannot open, with the reason. Redrawn on each camera and placement change at the device
// pixel ratio.
import { useEffect, useRef } from 'react';
import { kOf } from '../engine/view/camera.mjs';
import { useViewport } from '../engine/view/Viewport.jsx';
import { PAPER_PX } from './instance.js';
import { rectsOf, sectionRect } from './sections.mjs';
import { dragOffset } from './tools/section.js';

const PAPER = '#ffffff';
const EDGE = '#d4d4d4';
/** The section fill's colours: the muted tone its slot uses, as canvas paints it. */
const SECTION_FILL = 'rgba(128,128,128,0.14)';
const SECTION_EDGE = 'rgba(140,140,140,0.5)';
const GREY = '#e5e5e5';
const GREY_EDGE = '#c4c4c4';
const LABEL = '#5c5c5c';

/** Draws the view's paper into `canvas` for viewport `vp` and the board `ctx` (`getCtx()` while its sessions open). */
function paint(vp, canvas, ctx) {
  if (!canvas) return;
  const w = vp.root.clientWidth;
  const h = vp.root.clientHeight;
  const dpr = globalThis.devicePixelRatio || 1;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!ctx) return;
  const view = vp.view(); // a zoom gesture's while one runs, so its scale too
  const k = kOf((vp.gesture ?? vp.camera).zoom);
  const sx = (x) => (x - view.x) * k;
  const sy = (y) => (y - view.y) * k;
  const right = view.x + view.w;
  const bottom = view.y + view.h;
  const box = (x, y, bw, bh, fill, stroke) => {
    g.fillStyle = fill;
    g.fillRect(sx(x), sy(y), bw * k, bh * k);
    g.strokeStyle = stroke;
    g.lineWidth = 1;
    g.strokeRect(sx(x) + 0.5, sy(y) + 0.5, Math.max(0, bw * k - 1), Math.max(0, bh * k - 1));
  };
  for (const item of ctx.store.live()) {
    if (item.type !== 'doc' || item.gone || item.hidden) continue;
    const x = item.x ?? 0;
    const y = item.y ?? 0;
    const why = ctx.instances?.whyOf(item.id);
    if (why) {
      const bw = item.w || 360;
      const bh = item.h || 240;
      box(x, y, bw, bh, GREY, GREY_EDGE);
      // The label at a size that reads at this zoom, inside the section.
      const px = Math.min(Math.max(11, 0.9 / k), 40);
      if (bw * k > 60 && bh * k > 24) {
        g.save();
        g.beginPath();
        g.rect(sx(x), sy(y), bw * k, bh * k);
        g.clip();
        g.fillStyle = LABEL;
        g.font = `${px}px system-ui, sans-serif`;
        g.textBaseline = 'top';
        g.fillText(why, sx(x) + 8, sy(y) + 8, Math.max(20, bw * k - 16));
        g.restore();
      }
      continue;
    }
    const pages = ctx.instances?.pagesOf(item.id) ?? [];
    if (!pages.length) continue;
    const rects = rectsOf(item, pages);
    // A drag of the pages shows here too: at this zoom they have no placements to nudge.
    const off = dragOffset.current;
    const shift = (i) => (off.id === item.id && (off.page == null || off.page === i) ? { x: off.dx, y: off.dy } : { x: 0, y: 0 });
    const far = pages.some((page) => page.w * k < PAPER_PX);
    if (far) {
      // No page placement, so no section slot either: its fill is drawn under the pages here, as the placement draws it above
      // PAPER_PX.
      const moved = rects.map((r, i) => ({ ...r, x: r.x + shift(i).x, y: r.y + shift(i).y }));
      const fill = sectionRect(moved);
      if (fill && fill.x <= right && fill.y <= bottom && fill.x + fill.w >= view.x && fill.y + fill.h >= view.y) {
        g.fillStyle = SECTION_FILL;
        g.fillRect(sx(fill.x), sy(fill.y), fill.w * k, fill.h * k);
        g.strokeStyle = SECTION_EDGE;
        g.lineWidth = 1;
        g.strokeRect(sx(fill.x) + 0.5, sy(fill.y) + 0.5, Math.max(0, fill.w * k - 1), Math.max(0, fill.h * k - 1));
      }
    }
    // Only the pages under PAPER_PX wide: a bigger one has a placement (a tile, or a plain paper slot).
    rects.forEach((slot, i) => {
      if (pages[i].w * k >= PAPER_PX) return;
      const [dx, dy] = [shift(i).x, shift(i).y];
      const [x0, y0] = [slot.x + dx, slot.y + dy];
      if (x0 > right || y0 > bottom || x0 + slot.w < view.x || y0 + slot.h < view.y) return;
      box(x0, y0, slot.w, slot.h, PAPER, EDGE);
    });
  }
}

/** The paper layer of the board around it; `ctx` is a getter for the board's context (null until its sessions open). */
export function PaperLayer({ ctx }) {
  const vp = useViewport();
  const ref = useRef(null);
  useEffect(() => {
    if (!vp) return;
    const draw = () => paint(vp, ref.current, ctx?.() ?? null);
    draw();
    const offs = [vp.subscribe('camera', draw), vp.subscribe('placements', draw), vp.watch(draw), dragOffset.subscribe(draw)];
    return () => {
      for (const off of offs) off();
    };
  }, [vp]);
  return <canvas ref={ref} data-board-paper="" aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
    pointerEvents: 'none' }} />;
}
