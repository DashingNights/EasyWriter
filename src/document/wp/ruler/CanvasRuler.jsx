// The rulers on a canvas draft (docs/plans/engine/stage2b.md, engine-page-tools; plan.md §3 ruler): the same strip and column as
// the DOM editor's (Ruler.jsx), drawn from the engine. The caret's page gives the paper and its text area (layout.page), the caret
// paragraph its indents and tab stops (para.state), and the page area's viewport where the page shows. A marker drag writes on
// release through the engine, one undo step: the indents (para.indents), a tab stop (para.tabs) and the margins (layout.margins).
// engine-tools-2 adds Word's other parts: in a table the ruler rules the caret's cell, with a Move Table Column marker at each
// column edge of its row (table.resizeDrag); in section columns the caret's column, with the gaps between them dragged to set
// them (layout.columns); and the tab selector, whose kind a click on the ruler sets.
import { memo, useEffect, useReducer, useRef, useState } from 'react';
import { useViewportInset } from '../../../app/viewport.js';
import { useUnit } from '../../../tooling/kit/controls.jsx';
import { formatLength } from '../../../tooling/kit/units.mjs';
import { areaViewports } from '../../canvas/overlay.jsx';
import { cellAround, indentMarkers, indentPatch, nextSelector, sectionColumns, sectionColumnsDrag, snap, ticks, TIPS } from './ruler.mjs';

const CELL_MARGIN = 5.4; // Word's default left and right cell margin (108 twips)
// The selector's kind lives outside React so it stays for the session, as Word keeps it.
let selector = 'left';

const H = 24;
const BAND = [4, 20];
const W = 18;
const C = {
  strip: 'var(--background)', grey: 'var(--muted)', white: 'var(--card)', ink: 'var(--foreground)', faint: 'var(--muted-foreground)',
  line: 'var(--border)',
};
const abs = (s) => ({ position: 'absolute', ...s });

/** The page area's viewport for `client` and a re-render whenever its camera or placements move. A layout that laid pages out
 * again where they were (a typed letter: their placements are new, in the same places) leaves the ruler as it is. */
function useArea(client) {
  const [, bump] = useReducer((n) => n + 1, 0);
  const vp = client ? areaViewports(client.id)[0] ?? null : null;
  useEffect(() => {
    if (!vp) return undefined;
    let was = vp.placements;
    const placed = () => {
      const now = vp.placements;
      const moved = now.length !== was.length
        || now.some((p, i) => p !== was[i] && (p.x !== was[i].x || p.y !== was[i].y || p.w !== was[i].w || p.h !== was[i].h));
      was = now;
      if (moved) bump();
    };
    const offs = [vp.subscribe('camera', bump), vp.subscribe('placements', placed)];
    return () => offs.forEach((off) => off());
  }, [vp]);
  return vp;
}

/** The caret's page and its area ({page, w, h, body, caret}) on `client`, and the table cell around the caret
 * ({cell, row, text: {x, w}}: the cell's text area within its margins), read again after each 'selection' event, at most once
 * an animation frame and one read at a time, so the ruler follows the caret as Word's does (afterTyping's shared 100 ms timer,
 * which each caret move restarted, held it still until the moves stopped). The worker posts one after any change to the
 * selection or the layout, which is what the read draws from: a key of the caret paragraph's state missed a table inserted in
 * an empty paragraph (the same state in its first cell) and a column the ruler itself resized. The event's caret saves the
 * read two calls, and a page and layout version read before saves it the page's area and cells. */
function useCaretPage(client) {
  const [v, setV] = useState(null);
  useEffect(() => {
    if (!client) return undefined;
    let dead = false;
    let event = null; // the last selection event, or null before the first
    let due = true; // an event came since the running read began
    let reading = false;
    let frame = 0;
    let known = null; // {key, area, all}: the page's area and cells at a layout version
    const read = async (e) => {
      let c = e?.caret ?? null;
      if (!e) {
        const s = await client.selection();
        c = s && (await client.caret(s.head));
      }
      const page = c?.page ?? 0;
      const key = e?.version != null ? `${page} ${e.version}` : null;
      if (!key || known?.key !== key) {
        const area = (await client.query('layout.page', { page }))?.value;
        const all = c ? (await client.query('layout.cells', { page }))?.value ?? [] : [];
        known = { key, area, all };
      }
      const { area, all } = known;
      let cell = null;
      if (c) {
        cell = cellAround(all, c);
        if (cell) {
          // The caret table's rows on this page, top to bottom: {y, bottom} (the vertical ruler's Adjust Table Row markers).
          const t0 = JSON.stringify(cell.cell.table);
          const rows = new Map();
          for (const q of all.filter((x) => JSON.stringify(x.table) === t0)) {
            const r = rows.get(q.row) ?? { y: q.y, bottom: q.y + q.h, x: q.x + q.w / 2 };
            rows.set(q.row, { ...r, bottom: Math.max(r.bottom, q.y + q.h) });
          }
          cell.rows = [...rows.values()].sort((a, b) => a.y - b.y);
          const t = (await client.query('table.get', {}))?.value;
          const m = t?.rows?.[t.row]?.cells?.[t.cell]?.props?.margins ?? t?.props?.cellMargins ?? [0, CELL_MARGIN, 0, CELL_MARGIN];
          cell.text = { x: cell.cell.x + m[1], w: Math.max(0, cell.cell.w - m[1] - m[3]) };
        }
      }
      return area ? { page, ...area, caret: c, cell } : null;
    };
    const next = () => {
      frame = 0;
      if (dead || reading || !due) return;
      due = false;
      reading = true;
      // A read that finds the same page, caret line and cell keeps the last value, so the rulers do not draw again.
      const keep = (r) => setV((was) => (was && JSON.stringify(was) === JSON.stringify(r) ? was : r));
      read(event).then((r) => !dead && r && keep(r), () => {}).finally(() => {
        reading = false;
        if (due && !dead) frame ||= requestAnimationFrame(next);
      });
    };
    const poke = (e) => {
      if (e) event = e;
      due = true;
      frame ||= requestAnimationFrame(next);
    };
    poke(null);
    const off = client.on('selection', poke);
    return () => {
      dead = true;
      off?.();
      cancelAnimationFrame(frame);
    };
  }, [client]);
  return v;
}

/** A pointer drag from `e` along `axis` ('x' | 'y'): `to(clientPos, alt)` → the marker's place in points while it moves, and
 * `commit(pt, off)` on release (`off`: dragged away from the ruler). */
function dragFrom(e, axis, { to, set, commit, away }) {
  e.preventDefault();
  e.stopPropagation();
  const move = (m) => set({ at: to(axis === 'x' ? m.clientX : m.clientY, m.altKey), off: away(m) });
  const up = (m) => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    const at = to(axis === 'x' ? m.clientX : m.clientY, m.altKey);
    set(null);
    commit(at, away(m));
  };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
}

const Glyph = ({ shape }) => {
  const d = { down: 'M0 0 H9 L4.5 5 Z', up: 'M4.5 0 L9 5 H0 Z' }[shape];
  return d ? <svg width="9" height="6" style={{ display: 'block' }}><path d={d} fill={C.white} stroke={C.ink} strokeWidth="1" /></svg>
    : <div style={{ width: 9, height: 4, background: C.white, border: `1px solid ${C.ink}`, boxSizing: 'border-box' }} />;
};

/** The horizontal ruler's ticks and numbers from its 0 at strip px `x`; kept while a keystroke changes nothing they show. */
const Ticks = memo(function Ticks({ unit, from, to, k, x }) {
  return ticks(unit, from, to, k).map((t) => (
    <div key={t.pos} style={abs({ left: x + t.pos * k, top: t.label ? 7 : t.kind === 'mid' ? 10 : 11, height: t.label ? 10 : t.kind === 'mid' ? 4 : 2, width: 1,
      background: t.label ? 'none' : C.faint, pointerEvents: 'none' })}>
      {t.label && <span style={abs({ left: -8, width: 16, top: -1, font: '9px system-ui, sans-serif', color: C.ink, textAlign: 'center' })}>{t.label}</span>}
    </div>
  ));
});

/** The horizontal ruler of a canvas draft's caret page. */
export function CanvasHorizontalRuler({ ctx }) {
  const client = ctx.engine;
  const unit = useUnit();
  const ref = useRef(null);
  const [drag, setDrag] = useState(null); // {kind, at, off}
  const [kind, setKind] = useState(selector);
  const vp = useArea(client);
  const para = ctx.stateOf?.('para.state')?.value ?? null;
  const colState = ctx.stateOf?.('layout.columns')?.value ?? null;
  const area = useCaretPage(client);
  const strip = ref.current?.getBoundingClientRect();
  const o = vp && area && vp.toClient({ session: client.id, surface: area.page, x: 0, y: 0 });
  const ready = !!(o && strip);
  const k = vp ? vp.camera.zoom * (4 / 3) : 4 / 3;
  const x0 = ready ? o.x - strip.left : 0; // the paper's left in the strip
  const body = area?.body ?? { x: 72, w: 468 };
  const cols = area?.cell ? null : sectionColumns(colState, body);
  const caretX = area?.caret?.x ?? body.x;
  // The ruler's 0 and width: the caret's cell text, else its section column, else the page's text column.
  const col = cols?.find((c, i) => caretX < c.x + c.w + c.space / 2 || i === cols.length - 1);
  const text = area?.cell?.text ?? (col ? { x: col.x, w: col.w } : { x: body.x, w: body.w });
  const Z = text.x;
  const sx = (pt) => x0 + pt * k;
  const toPt = (cx) => (cx - (strip?.left ?? 0) - x0) / k;
  const p = para ?? {}; // the caret paragraph's resolved ParaProps
  const indent = { left: p.indentLeft ?? 0, right: p.indentRight ?? 0, firstLine: p.indentFirst ?? 0 };
  const marks = indentMarkers(indent, text.w);
  const tabs = (p.tabs ?? []).filter((t) => t.align !== 'clear');
  const live = (m, x) => (drag?.kind === m ? drag.at : x);
  const away = (m) => m.clientY > (strip?.bottom ?? 0) + 16;

  const write = async (m, at, off, from) => {
    const rel = at - Z;
    if (['firstLine', 'hanging', 'left', 'right'].includes(m)) await client.exec('para.indents', indentPatch(m, indent, rel, text.w));
    else if (m === 'marginLeft') await client.exec('layout.margins', { left: Math.max(0, at) });
    else if (m === 'marginRight') await client.exec('layout.margins', { right: Math.max(0, area.w - at) });
    else if (m.startsWith('stop:')) {
      const stop = tabs[Number(m.slice(5))];
      await client.exec('para.tabs', off ? { clear: [stop.pos] } : { clear: [stop.pos], set: [{ ...stop, pos: Math.max(0, rel) }] });
    } else if (m.startsWith('tableCol:')) {
      const c = area.cell.row[Number(m.slice(9))];
      const y = c.y + c.h / 2;
      await client.exec('table.resizeDrag', { page: area.page, x: c.x + c.w, y, toX: at, toY: y });
    } else if (m.startsWith('colGap:')) {
      const [, i, part] = m.split(':');
      const own = colState.widths?.length > 0;
      const next = sectionColumnsDrag(cols, Number(i), part, at - from, !own);
      await client.exec('layout.columns', own
        ? { widths: next.map((c) => [c.w, c.space]), separator: !!colState.separator, apply: 'section' }
        : { count: cols.length, space: next[0].space, separator: !!colState.separator, apply: 'section' });
    }
  };
  const marker = (m, x, y, glyph, tip) => (
    <div key={m} data-marker={m} title={tip} onMouseDown={(e) => dragFrom(e, 'x', {
      to: (cx, alt) => Z + snap(toPt(cx) - Z, unit, alt), set: (s) => setDrag(s && { kind: m, ...s }), commit: (at, off) => write(m, at, off), away,
    })} style={abs({ left: sx(live(m, x)) - 4.5, top: y, cursor: 'default', zIndex: 1 })}>
      {glyph}
    </div>
  );
  /** A marker dragged on the page's grid (snapped from the left margin): a table column edge or a section column gap's part. */
  const edge = (m, x, tip, width = 6) => (
    <div key={m} data-marker={m.split(':')[0]} data-i={m.split(':')[1]} data-part={m.split(':')[2]} title={tip} onMouseDown={(e) => dragFrom(e, 'x', {
      to: (cx, alt) => body.x + snap(toPt(cx) - body.x, unit, alt), set: (st) => setDrag(st && { kind: m, ...st }), commit: (at) => write(m, at, false, x),
      away: () => false,
    })} style={abs({ left: sx(live(m, x)) - width / 2, top: BAND[0], width, height: BAND[1] - BAND[0], cursor: 'ew-resize', zIndex: 2 })} />
  );
  // A click on the band adds a stop of the selector's kind there, or moves the First Line or Hanging marker when the selector
  // holds one (Word).
  const addTab = (e) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const pos = snap(toPt(e.clientX) - Z, unit, e.altKey);
    if (kind === 'firstLine' || kind === 'hanging') client.exec('para.indents', indentPatch(kind, indent, pos, text.w));
    else if (pos > 0 && pos < text.w) client.exec('para.tabs', { set: [{ pos, align: kind }] });
  };
  const cycle = () => {
    selector = nextSelector(kind);
    setKind(selector);
  };
  const root = vp?.root?.getBoundingClientRect();
  return (
    <div ref={ref} data-ruler="h" data-canvas-ruler="" style={{ position: 'relative', height: H, background: C.strip, borderBottom: `1px solid ${C.line}`, overflow: 'hidden' }}>
      {ready && (
        <>
          <div data-ruler-band="" onMouseDown={addTab} style={abs({ left: sx(0), top: BAND[0], width: area.w * k, height: BAND[1] - BAND[0], background: C.grey })}>
            <div data-text-area="" onMouseDown={addTab} style={abs({ left: (area.cell ? text.x : live('marginLeft', body.x)) * k, top: 0, bottom: 0,
              width: Math.max(0, (area.cell ? text.w : live('marginRight', body.x + body.w) - live('marginLeft', body.x)) * k), background: C.white })} />
            {cols?.slice(0, -1).map((c, i) => (
              <div key={'gap' + i} data-col-gap={i} style={abs({ left: (c.x + c.w) * k, top: 0, bottom: 0, width: c.space * k, background: C.grey })} />
            ))}
          </div>
          <Ticks unit={unit} from={-Z} to={area.w - Z} k={k} x={x0 + Z * k} />
          {cols?.slice(0, -1).flatMap((c, i) => [
            edge('colGap:' + i + ':start', c.x + c.w, TIPS.marginRight),
            edge('colGap:' + i + ':move', c.x + c.w + c.space / 2, TIPS.column),
            edge('colGap:' + i + ':end', c.x + c.w + c.space, TIPS.marginLeft),
          ])}
          {area.cell?.row.map((c, i) => edge('tableCol:' + i, c.x + c.w, TIPS.tableCol, 7))}
          {['marginLeft', 'marginRight'].map((m) => {
            const x = live(m, m === 'marginLeft' ? body.x : body.x + body.w);
            return (
              <div key={m} data-marker={m} title={TIPS[m]} onMouseDown={(e) => dragFrom(e, 'x', {
                to: (cx, alt) => snap(toPt(cx), unit, alt), set: (s) => setDrag(s && { kind: m, ...s }), commit: (at) => write(m, at), away: () => false,
              })} style={abs({ left: sx(x) - 3, top: BAND[0], width: 6, height: BAND[1] - BAND[0], cursor: 'ew-resize' })} />
            );
          })}
          {marker('firstLine', Z + marks.firstLine, 1, <Glyph shape="down" />, TIPS.firstLine)}
          {marker('hanging', Z + marks.hanging, 14, <Glyph shape="up" />, TIPS.hanging)}
          {marker('left', Z + marks.left, 19, <Glyph shape="box" />, TIPS.leftIndent)}
          {marker('right', Z + marks.right, 14, <Glyph shape="up" />, TIPS.rightIndent)}
          {tabs.map((t, i) => marker(`stop:${i}`, Z + t.pos, 11, <SelectorGlyph kind={t.align} />,
            `${TIPS[t.align] ?? TIPS.left}: ${formatLength(t.pos, unit)}`))}
        </>
      )}
      {root && strip && (
        <button type="button" data-tab-selector={kind} title={TIPS[kind]} aria-label={TIPS[kind]} onClick={cycle}
          style={abs({ left: Math.max(0, root.left - strip.left), top: 0, width: W, height: H, display: 'grid', placeItems: 'center', padding: 0,
            background: C.strip, border: 'none', borderRight: '1px solid ' + C.line, zIndex: 5 })}>
          <SelectorGlyph kind={kind} />
        </button>
      )}
    </div>
  );
}

/** The tab selector's glyph for `kind`: a stop's L, T or bar, or an indent marker's triangle. */
function SelectorGlyph({ kind }) {
  if (kind === 'firstLine') return <Glyph shape="down" />;
  if (kind === 'hanging') return <Glyph shape="up" />;
  const d = { left: 'M2 0V8H8', right: 'M7 0V8H1', center: 'M4.5 0V8M0.5 8H8.5', decimal: 'M4.5 0V8M0.5 8H8.5M7 4H8', bar: 'M4.5 0V9' }[kind] ?? 'M2 0V8H8';
  return <svg width="9" height="9" viewBox="0 0 9 9" style={{ display: 'block' }}><path d={d} stroke={C.ink} strokeWidth="1.6" fill="none" /></svg>;
}

/** The vertical ruler of a canvas draft's caret page: its top and bottom margins, each dragged to set it, and in a table an
 * Adjust Table Row marker at each row's bottom (table.resizeDrag: the row's height). */
export function CanvasVerticalRuler({ ctx }) {
  useViewportInset(true); // the islands placed by the viewport's box keep clear of this column
  const client = ctx.engine;
  const unit = useUnit();
  const ref = useRef(null);
  const [drag, setDrag] = useState(null);
  const vp = useArea(client);
  const area = useCaretPage(client);
  const col = ref.current?.getBoundingClientRect();
  const o = vp && area && vp.toClient({ session: client.id, surface: area.page, x: 0, y: 0 });
  const k = vp ? vp.camera.zoom * (4 / 3) : 4 / 3;
  const y0 = o && col ? o.y - col.top : 0;
  const sy = (pt) => y0 + pt * k;
  const toPt = (cy) => (cy - (col?.top ?? 0) - y0) / k;
  const b = area?.body;
  const live = (kind, y) => (drag?.kind === kind ? drag.at : y);
  const write = (kind, at) => {
    if (kind.startsWith('tableRow:')) {
      const r = area.cell.rows[Number(kind.slice(9))];
      return client.exec('table.resizeDrag', { page: area.page, x: r.x, y: r.bottom, toX: r.x, toY: Math.max(r.y + 1, at) });
    }
    return client.exec('layout.margins', kind === 'marginTop' ? { top: Math.max(0, at) } : { bottom: Math.max(0, area.h - at) });
  };
  return (
    <div ref={ref} data-ruler="v" data-canvas-ruler="" data-viewport-inset="left" style={abs({ left: 0, top: 0, bottom: 0, width: W, background: C.strip, borderRight: `1px solid ${C.line}`, overflow: 'hidden', zIndex: 6 })}>
      {o && col && b && (
        <>
          <div style={abs({ left: 3, width: W - 6, top: sy(0), height: area.h * k, background: C.grey })} />
          <div style={abs({ left: 3, width: W - 6, top: sy(live('marginTop', b.y)), height: Math.max(0, (live('marginBottom', b.y + b.h) - live('marginTop', b.y)) * k), background: C.white })} />
          {ticks(unit, -b.y, area.h - b.y, k).filter((t) => !t.label).map((t) => (
            <div key={t.pos} style={abs({ top: sy(b.y + t.pos), left: t.kind === 'mid' ? 7 : 8, width: t.kind === 'mid' ? 4 : 2, height: 1, background: C.faint })} />
          ))}
          {['marginTop', 'marginBottom'].map((kind) => (
            <div key={kind} data-marker={kind} title={TIPS[kind]} onMouseDown={(e) => dragFrom(e, 'y', {
              to: (cy, alt) => snap(toPt(cy), unit, alt), set: (s) => setDrag(s && { kind, ...s }), commit: (at) => write(kind, at), away: () => false,
            })} style={abs({ left: 0, width: W, top: sy(live(kind, kind === 'marginTop' ? b.y : b.y + b.h)) - 3, height: 6, cursor: 'ns-resize' })} />
          ))}
          {area.cell?.rows?.map((r, i) => {
            const m = 'tableRow:' + i;
            return (
              <div key={m} data-marker="tableRow" data-i={i} title={TIPS.tableRow} onMouseDown={(e) => dragFrom(e, 'y', {
                to: (cy, alt) => b.y + snap(toPt(cy) - b.y, unit, alt), set: (s) => setDrag(s && { kind: m, ...s }), commit: (at) => write(m, at), away: () => false,
              })} style={abs({ left: 3, width: W - 6, top: sy(live(m, r.bottom)) - 3, height: 6, cursor: 'ns-resize', background: C.grey,
                border: '1px solid ' + C.faint, boxSizing: 'border-box', zIndex: 1 })} />
            );
          })}
        </>
      )}
    </div>
  );
}
