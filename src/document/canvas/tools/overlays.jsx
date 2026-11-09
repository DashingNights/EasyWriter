// What the page area draws over the tiles beside the pointer tools (docs/plans/engine/stage2b.md, engine-page-tools): the drawing
// grid (View > Gridlines: settings.word.guides.gridlines, its spacing, origin and every-n lines from document.settings), the table gridlines (Table Layout >
// View Gridlines: settings.word.tableGridlines, the cells from layout.cells) and the Draw tab's stencil ruler. All three are
// screen only, never painted into the pages, printed or saved, as in Word.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useStore } from '../../../app/store.js';
import { gridLines } from '../../wp/arrange/order.mjs';
import { ruler } from './ink.js';

const LAYER = { position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' };
const GRID = 'rgb(0 0 0 / 0.18)';
const CELL = 'rgb(0 120 212 / 0.55)';
const RULER_W = 54; // points: the stencil ruler's width

/** The value of pure query `id` with `args` on `client`, read again when `version` changes; null until it answers. */
function useQuery(client, id, args, version, on = true) {
  const [v, setV] = useState(null);
  const key = JSON.stringify(args);
  useEffect(() => {
    if (!on) return undefined;
    let dead = false;
    Promise.resolve(client.query(id, args)).then((r) => !dead && setV(r?.value ?? null), () => {});
    return () => {
      dead = true;
    };
  }, [client, id, key, version, on]);
  return on ? v : null;
}

/** The drawing grid over the page's text area. */
function Grid({ client, surface, k, placement }) {
  const on = useStore((s) => !!s.settings?.word?.guides?.gridlines);
  const page = useQuery(client, 'layout.page', { page: surface }, placement.version, on);
  const g = useQuery(client, 'document.settings', {}, placement.version, on);
  if (!on || !page) return null;
  const b = page.body;
  const box = { left: b.x, top: b.y, w: page.w, h: page.h, right: page.w - b.x - b.w, bottom: page.h - b.y - b.h };
  const { xs, ys } = gridLines(box, { ...g?.gridShow, h: g?.gridH ?? 9, v: g?.gridV ?? 9 }); // gridShow: origin, every-n lines
  return (
    <svg data-drawing-grid={surface} style={LAYER} width="100%" height="100%">
      {ys.map((y) => <line key={`y${y}`} x1={b.x * k} x2={(b.x + b.w) * k} y1={y * k} y2={y * k} stroke={GRID} strokeWidth={1} />)}
      {xs.map((x) => <line key={`x${x}`} y1={b.y * k} y2={(b.y + b.h) * k} x1={x * k} x2={x * k} stroke={GRID} strokeWidth={1} />)}
    </svg>
  );
}

/** Each table cell's outline, dotted, as Word's View Gridlines draws them. */
function Cells({ client, surface, k, placement }) {
  const on = useStore((s) => !!s.settings?.word?.tableGridlines);
  const cells = useQuery(client, 'layout.cells', { page: surface }, placement.version, on);
  if (!on || !cells?.length) return null;
  return (
    <svg data-table-gridlines={surface} style={LAYER} width="100%" height="100%">
      {cells.map((c, i) => <rect key={i} x={c.x * k} y={c.y * k} width={c.w * k} height={c.h * k} fill="none" stroke={CELL} strokeWidth={1} strokeDasharray="1 2" />)}
    </svg>
  );
}

/** The stencil ruler: a band on its page, its top edge the line pen strokes snap to. A drag moves it, the wheel turns it. */
function Stencil({ surface, k }) {
  useSyncExternalStore(ruler.subscribe, ruler.version);
  const r = ruler.at;
  if (!r || r.surface !== surface) return null;
  const drag = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const [x0, y0, rx, ry] = [e.clientX, e.clientY, r.x, r.y];
    const move = (m) => ruler.set({ ...ruler.at, x: rx + (m.clientX - x0) / k, y: ry + (m.clientY - y0) / k });
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  };
  const turn = (e) => {
    e.preventDefault();
    e.stopPropagation();
    ruler.set({ ...ruler.at, deg: (ruler.at.deg + (e.deltaY > 0 ? 1 : -1) + 360) % 360 });
  };
  const ticks = [];
  for (let t = 0; t <= r.len; t += 9) ticks.push(t);
  return (
    <div data-stencil-ruler={r.deg} onMouseDown={drag} onWheel={turn} title="Drag to move the ruler, turn it with the mouse wheel"
      style={{ position: 'absolute', left: r.x * k, top: r.y * k, width: r.len * k, height: RULER_W * k, transformOrigin: '0 0',
        transform: `rotate(${r.deg}deg)`, pointerEvents: 'auto', cursor: 'move', background: 'rgb(255 255 255 / 0.85)',
        border: '1px solid rgb(0 0 0 / 0.45)', boxShadow: '0 2px 6px rgb(0 0 0 / 0.25)' }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
        {ticks.map((t) => <line key={t} x1={t * k} x2={t * k} y1={0} y2={(t % 72 === 0 ? 14 : t % 36 === 0 ? 10 : 6) * k} stroke="#404040" strokeWidth={1} />)}
      </svg>
      <span style={{ position: 'absolute', left: '50%', top: '55%', transform: 'translate(-50%, -50%)', font: '12px system-ui, sans-serif', color: '#404040' }}>
        {`${Math.round(r.deg)}°`}
      </span>
    </div>
  );
}

/** Draws the grid, the table gridlines and the stencil ruler on viewport `vp` for `client`'s pages → off(). */
export function pageOverlays(vp, client) {
  const on = (p) => p.session === client.id;
  vp.overlays.register('page-grid', (p) => (on(p) ? <Grid client={client} {...p} /> : null));
  vp.overlays.register('page-cells', (p) => (on(p) ? <Cells client={client} {...p} /> : null));
  vp.overlays.register('page-stencil', (p) => (on(p) ? <Stencil {...p} /> : null));
  return () => {
    for (const id of ['page-grid', 'page-cells', 'page-stencil']) vp.overlays.register(id, null);
  };
}
