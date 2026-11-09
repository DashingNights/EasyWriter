// The board's selection (docs/plans/board/briefs/bd-select.md): the selection itself, and the screen-plane overlay that draws it
// above every item. One item gets a turned accent box, eight handles and a size label; several get one box round the union. A
// marquee and the hover outline draw here too, since a turned box is not a vp.marks rect. The chrome takes no pointer: pointer.js
// reads the zones from the item's box, so a handle works at any zoom.
import { useSyncExternalStore } from 'react';
import { kOf } from '../engine/view/camera.mjs';
import { boxOf, turnedBox, turnedCorners, unionBox } from './gestures.mjs';
import { toPx } from './look.mjs';
import { sectionRect } from './sections.mjs';
import { dragOffset } from './tools/section.js';

const ACCENT = '#0d99ff';

/** The selection: ids, the hovered item, the marquee rect and a drag's preview fields per item. React reads it through
 * subscribe/version; `ids` answers a fresh array, so a caller never mutates the set. `page` ({id, page}) is the one page of a
 * document Ctrl+click picked (bd-section). */
export function createSelection() {
  const ids = new Set();
  let page = null;
  let hover = null;
  let marquee = null;
  let preview = null;
  let version = 0;
  const subs = new Set();
  const bump = () => {
    version++;
    for (const fn of [...subs]) fn();
  };
  const sel = {
    get ids() {
      return [...ids];
    },
    has: (id) => ids.has(id),
    set(next) {
      const hadPage = page != null;
      page = null;
      const want = new Set(next ?? []);
      if (want.size === ids.size && [...want].every((id) => ids.has(id))) {
        if (hadPage) bump();
        return;
      }
      ids.clear();
      for (const id of want) ids.add(id);
      bump();
    },
    add(next) {
      let changed = false;
      for (const id of next ?? []) if (!ids.has(id)) { ids.add(id); changed = true; }
      if (changed) bump();
    },
    toggle(id) {
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      bump();
    },
    clear() {
      if (!ids.size && !page) return;
      ids.clear();
      page = null;
      bump();
    },
    get page() {
      return page;
    },
    /** The one page of a document Ctrl+click picked, or null. */
    setPage(next) {
      page = next ?? null;
      bump();
    },
    get hover() {
      return hover;
    },
    setHover(id) {
      if ((id ?? null) === hover) return;
      hover = id ?? null;
      bump();
    },
    get marquee() {
      return marquee;
    },
    setMarquee(rect) {
      marquee = rect ?? null;
      bump();
    },
    get preview() {
      return preview;
    },
    setPreview(fields) {
      preview = fields;
      bump();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    version: () => version,
  };
  return sel;
}

/** The eight handles of a box: corners and edge midpoints, as fractions of its size from -1 to 1. */
const HANDLES = [['nw', -1, -1], ['n', 0, -1], ['ne', 1, -1], ['e', 1, 0], ['se', 1, 1], ['s', 0, 1], ['sw', -1, 1], ['w', -1, 0]];

/** The sizer's map of world points as shown: the settled camera's, or a zoom gesture's while one runs (the world plane's own
 * transform, Viewport gestureTransform), so an overlay outside the world plane moves with the items it marks. → {k, at(p)} */
export function planeMap(vp) {
  const e = vp.extent;
  const g = vp.gestureTransform?.();
  const k = kOf(vp.camera.zoom) * (g?.s ?? 1);
  return { k, at: (p) => ({ x: (p.x - e.x) * k + (g?.x ?? 0), y: (p.y - e.y) * k + (g?.y ?? 0) }) };
}

function point(vp, p) {
  const s = planeMap(vp).at(p);
  return { left: s.x, top: s.y };
}

function polygon(points) {
  return points.map((p) => `${p.left},${p.top}`).join(' ');
}

const BOX = { position: 'absolute', pointerEvents: 'none' };

/** Selection chrome for `ctx`, mounted as the viewport's screen-plane overlay `board-selection`. */
export function BoardSelection({ ctx }) {
  const sel = ctx.selection;
  useSyncExternalStore(sel.subscribe, sel.version);
  useSyncExternalStore(dragOffset.subscribe, dragOffset.version);
  const vp = ctx.vp;
  useSyncExternalStore(vp ? vp.watch : EMPTY_SUB, vp ? vp.version : ZERO);
  if (!vp) return null;
  const items = sel.ids.map((id) => ctx.store.get(id)).filter((item) => item && !item.gone);
  const live = sel.preview;
  const boxes = items.map((item) => {
    const f = live?.[item.id];
    const base = boxOf(item, ctx.store);
    const box = f && base ? { ...base, ...f } : base;
    return box ? { item, box, rot: f?.rot ?? item.rot ?? 0 } : null;
  }).filter(Boolean); // a group a merge left with no live children has no box to outline
  const hover = sel.hover != null ? ctx.store.get(sel.hover) : null;
  const hoverBox = hover && !hover.gone ? boxOf(hover, ctx.store) : null;
  const marquee = sel.marquee && { x: Math.min(sel.marquee.x, sel.marquee.x + sel.marquee.w), y: Math.min(sel.marquee.y, sel.marquee.y + sel.marquee.h),
    w: Math.abs(sel.marquee.w), h: Math.abs(sel.marquee.h) };
  const a = marquee && point(vp, marquee);
  // A document is outlined as its section (2 px, no handles): the box its pages take plus PAD. Ctrl+click's one page is
  // outlined alone. A drag's offset moves the outline with the pages it moved.
  const off = dragOffset.current;
  const shifted = (item, rects) => (off.id !== item.id ? rects : rects.map((r, i) =>
    (off.page == null || off.page === i ? { ...r, x: r.x + off.dx, y: r.y + off.dy } : r)));
  const pageOf = (() => {
    const p = sel.page;
    const item = p ? ctx.store.get(p.id) : null;
    const box = item && !item.gone ? ctx.instances?.rectsFor(item)?.[p.page] : null;
    if (!box) return null;
    const moved = off.id === item.id && off.page === p.page ? { ...box, x: box.x + off.dx, y: box.y + off.dy } : box;
    return { item, box: moved };
  })();
  const single = boxes.length === 1 ? boxes[0] : null;
  const docRects = !pageOf && single?.item.type === 'doc' ? ctx.instances?.rectsFor(single.item) : null;
  const docBox = docRects?.length ? sectionRect(shifted(single.item, docRects)) : null;

  return (
    <div data-board-selection="" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {hoverBox && (
        <svg style={{ ...BOX, inset: 0, overflow: 'visible' }} width="100%" height="100%">
          <polygon points={polygon(turnedCorners(hoverBox, hover.rot ?? 0).map((p) => point(vp, p)))} fill="none" stroke={ACCENT}
            strokeWidth="1" />
        </svg>
      )}
      {marquee && marquee.w > 0 && marquee.h > 0 && (
        <div data-board-marquee="" style={{ ...BOX, left: a.left, top: a.top, width: marquee.w * planeMap(vp).k,
          height: marquee.h * planeMap(vp).k, border: `1px solid ${ACCENT}`,
          background: 'color-mix(in srgb, #0d99ff 10%, transparent)' }} />
      )}
      {pageOf && <Outline vp={vp} box={pageOf.box} />}
      {docBox && <Outline vp={vp} box={docBox} />}
      {!pageOf && !docBox && boxes.length === 1 && <One vp={vp} box={boxes[0].box} rot={boxes[0].rot} connector={boxes[0].item.type === 'connector'} />}
      {!pageOf && !docBox && boxes.length > 1 && <Many vp={vp} boxes={boxes} />}
    </div>
  );
}

/** A document's section, or the one page picked in it: a 2 px accent outline with no handles. */
function Outline({ vp, box }) {
  const a = point(vp, box);
  const k = planeMap(vp).k;
  return (
    <svg style={{ ...BOX, inset: 0, overflow: 'visible' }} width="100%" height="100%">
      <rect data-board-doc-outline="" x={a.left} y={a.top} width={box.w * k} height={box.h * k} fill="none" stroke={ACCENT}
        strokeWidth="2" />
    </svg>
  );
}

const EMPTY_SUB = () => () => {};
const ZERO = () => 0;

/** One item: its turned box, eight handles and the size label under it. A connector keeps its outline only: its own end and
 * segment handles are the connector tool's (bd-connect). */
function One({ vp, box, rot, connector = false }) {
  const corners = turnedCorners(box, rot).map((p) => point(vp, p));
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const a = (rot * Math.PI) / 180;
  const [cs, sn] = [Math.cos(a), Math.sin(a)];
  const handles = HANDLES.map(([name, fx, fy]) => {
    const dx = (fx * box.w) / 2;
    const dy = (fy * box.h) / 2;
    const t = point(vp, { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs });
    return { name, left: t.left - 4, top: t.top - 4 };
  });
  const lowest = Math.max(...corners.map((p) => p.top));
  const left = (Math.min(...corners.map((p) => p.left)) + Math.max(...corners.map((p) => p.left))) / 2;
  return (
    <>
      <svg style={{ ...BOX, inset: 0, overflow: 'visible' }} width="100%" height="100%">
        <polygon points={polygon(corners)} fill="none" stroke={ACCENT} strokeWidth="1" />
      </svg>
      {!connector && handles.map((h) => (
        <div key={h.name} data-board-handle={h.name} style={{ ...BOX, left: h.left, top: h.top, width: 8, height: 8,
          background: '#ffffff', border: `1px solid ${ACCENT}`, transform: `rotate(${rot}deg)` }} />
      ))}
      {!connector && (
        <div data-board-size="" style={{ ...BOX, left, top: lowest + 8, transform: 'translateX(-50%)', padding: '1px 4px', borderRadius: 2,
          background: ACCENT, color: '#ffffff', font: '11px system-ui, sans-serif', whiteSpace: 'nowrap' }}>
          {Math.round(toPx(box.w))} x {Math.round(toPx(box.h))}
        </div>
      )}
    </>
  );
}

/** Several items: one box round the union, turned about its centre by the press that rotates them. */
function Many({ vp, boxes }) {
  const union = unionBox(boxes.map((b) => turnedBox(b.box, b.rot)));
  if (!union) return null;
  const a = point(vp, union);
  return <div data-board-selection-many="" style={{ ...BOX, left: a.left, top: a.top, width: union.w * planeMap(vp).k,
    height: union.h * planeMap(vp).k, outline: `1px solid ${ACCENT}` }} />;
}
