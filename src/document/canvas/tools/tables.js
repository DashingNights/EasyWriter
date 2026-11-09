// Tables on the page (docs/plans/engine/stage2b.md, engine-page-tools; stage2.md G51): Draw Table (table.draw: a rectangle makes
// a table, a line splits cells), the Eraser (table.eraser), Border Painter on the one edge under the pointer (table.paintEdge) and
// Border Sampler (table.borderAt, then the painter with that border). They follow the app's store as the DOM editor's do:
// word.tableTool ('draw' | 'erase' | 'paint') and the pen word.pen ({style, width, color '#rrggbb' | null}), so the Table Design
// pen galleries arm the painter here too. Each stroke or click is one undo step.
import { getState, setState, subscribe } from '../../../app/store.js';
import { activeTool } from './state.mjs';
import { endTool, startTool } from './index.js';

const pen = () => getState().word?.pen ?? { style: 'single', width: 0.5, color: null };
const setWord = (patch) => setState((s) => ({ word: { ...s.word, ...patch } }));
const hex = (c) => (c && /^#?[0-9a-f]{6}$/i.test(c) ? c.replace('#', '').toUpperCase() : undefined);

/** The edge under the pointer as the engine sees it (table.borderAt), drawn as a highlight while the tool hovers. */
function edgeHover(env) {
  let edge = null;
  let ask = 0;
  return {
    get: () => edge,
    async at(at) {
      const n = ++ask;
      const b = await env.query('table.borderAt', { page: at.surface, x: at.x, y: at.y });
      if (n !== ask) return;
      edge = b && { surface: at.surface, ...b };
      env.redraw();
    },
    items: (surface, stroke) => (edge && edge.surface === surface ? [{ path: [edge.from, edge.to], stroke, width: 3 }] : []),
  };
}

/** Draw Table: a drag draws a dashed rectangle (a new table) or a line (cells split) and table.draw takes it. */
const drawTool = (env) => {
  let a = null;
  let b = null;
  return {
    cursor: 'crosshair',
    down(at) {
      a = at;
      b = at;
    },
    move(at) {
      if (!a || at.surface !== a.surface) return;
      b = at;
      env.redraw();
    },
    async up() {
      if (!a) return;
      const [s, e] = [a, b];
      a = null;
      env.redraw();
      await env.exec('table.draw', { page: s.surface, x0: s.x, y0: s.y, x1: e.x, y1: e.y });
    },
    preview(surface) {
      if (!a || a.surface !== surface) return [];
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      // A thin drag is a line, as table.draw reads it.
      if (Math.min(w, h) <= Math.max(12, Math.max(w, h) * 0.2)) return [{ path: w >= h ? [[a.x, a.y], [b.x, a.y]] : [[a.x, a.y], [a.x, b.y]], dash: true }];
      return [{ rect: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w, h }, dash: true }];
    },
  };
};

/** Eraser: the border between two cells under a click or a drag goes (cells merge where they can). */
const eraseTool = (env) => {
  const hover = edgeHover(env);
  let on = false;
  let busy = Promise.resolve();
  const erase = (at) => {
    busy = busy.then(() => env.exec('table.eraser', { page: at.surface, x: at.x, y: at.y }));
  };
  return {
    cursor: 'cell',
    hover: (at) => hover.at(at),
    down(at) {
      on = true;
      erase(at);
    },
    move(at) {
      if (on) erase(at);
      hover.at(at);
    },
    up() {
      on = false;
    },
    preview: (surface) => hover.items(surface, '#c00000'),
  };
};

/** Border Painter: the pen's border on each edge a click or a drag touches. */
const paintTool = (env) => {
  const hover = edgeHover(env);
  let on = false;
  let busy = Promise.resolve();
  let last = null;
  const paint = (at) => {
    const p = pen();
    busy = busy.then(async () => {
      const b = await env.query('table.borderAt', { page: at.surface, x: at.x, y: at.y });
      const key = b && JSON.stringify([at.surface, b.from, b.to]);
      if (!b || key === last) return; // each edge once a drag
      last = key;
      await env.exec('table.paintEdge', { page: at.surface, x: at.x, y: at.y, style: p.style, width: p.width, color: hex(p.color) });
    });
  };
  return {
    cursor: 'crosshair',
    hover: (at) => hover.at(at),
    down(at) {
      on = true;
      last = null;
      paint(at);
    },
    move(at) {
      if (on) paint(at);
      hover.at(at);
    },
    up() {
      on = false;
    },
    preview: (surface) => hover.items(surface, pen().color ?? '#000000'),
  };
};

/** Border Sampler: a click on a border takes its style, width and colour as the pen, and the painter arms, as in Word. */
const sampleTool = (env) => {
  const hover = edgeHover(env);
  return {
    cursor: 'copy',
    hover: (at) => hover.at(at),
    async down(at) {
      const b = await env.query('table.borderAt', { page: at.surface, x: at.x, y: at.y });
      if (!b || b.style === 'none') return;
      env.done();
      setWord({ pen: { style: b.style, width: b.width, color: b.color ? `#${b.color}` : null }, tableTool: 'paint' });
    },
    preview: (surface) => hover.items(surface, '#0078d4'),
  };
};

const TOOLS = { draw: drawTool, erase: eraseTool, paint: paintTool };

/** A row's run: table tool `name` on, or off when it is on; `arg.pen` arms it with that pen (table-design's pen picks). */
export function tableTool(name, arg) {
  if (arg?.pen) setWord({ pen: { ...pen(), ...arg.pen } });
  setWord({ tableTool: arg?.pen || getState().word?.tableTool !== name ? name : null });
  return true;
}

/** Border Sampler's run: the sampler on the page areas of ctx.engine. */
export const startSampler = (ctx) => startTool(ctx, 'table:sample', sampleTool);

/** Keeps the page tools of `client` (a canvas draft's session) in step with store word.tableTool → stop(). */
export function watchTableTool(client) {
  let was = null;
  const sync = () => {
    const want = getState().word?.tableTool ?? null;
    if (want === was) return;
    was = want;
    const now = activeTool();
    if (want && TOOLS[want]) {
      if (now !== `table:${want}`) startTool({ engine: client }, `table:${want}`, TOOLS[want]);
    } else if (now?.startsWith('table:') && now !== 'table:sample') endTool(now);
  };
  sync();
  const off = subscribe(sync);
  return off;
}
