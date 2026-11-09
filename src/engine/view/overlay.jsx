// A viewport's overlays (docs/plans/engine/viewport-design.md section 4.5; moved from src/document/canvas/overlay.jsx): React draws
// here, over the tiles, never the content itself. Each Viewport has its own set (no module globals), so two viewports on two
// sessions keep their own marks. Two planes:
//   world: moves and scales with the tiles; one layer per shown surface, in surface points times the zoom (selection rectangles,
//     squiggles, object frames, boxes, comment anchors);
//   screen: positioned, never scaled, so its things keep their size at any zoom and follow a zoom gesture each frame (the caret,
//     the composition underline, handles).
// Other packages draw three ways:
//   marks.set(owner, kind, items): items [{session, surface, x, y, w, h}] in points (`page` reads as `surface`); each owner keeps
//     its own list per kind, and an empty list or null clears it;
//   frameKinds.register(kind, Component): drawn at each frame of that kind ({frame, session, surface, page, k}); null removes it;
//   overlays.register(id, Component, {plane}): world ({session, surface, page, k, frames, placement}) on every shown surface, or
//     screen ({viewport}) once; null removes it.
// The layers let the pointer through; a component that takes it sets pointer-events itself.
import { useSyncExternalStore } from 'react';

const SCREEN_KINDS = new Set(['caret', 'composition']);
/** The plane mark kind `kind` draws in. */
export const planeOf = (kind) => (SCREEN_KINDS.has(kind) ? 'screen' : 'world');

/** A viewport's overlay registries → {marks, frameKinds, overlays, subscribe(fn), version()}. */
export function createOverlays() {
  const marks = new Map(); // owner + kind → {kind, items}
  const kinds = new Map(); // frame kind → Component
  const layers = new Map(); // id → {Component, plane}
  const fns = new Set();
  let version = 0;
  const changed = () => {
    version++;
    for (const fn of fns) fn();
  };
  return {
    subscribe(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    version: () => version,
    marks: {
      set(owner, kind, items) {
        const key = `${owner}\n${kind}`;
        if (!items?.length && !marks.has(key)) return;
        if (items?.length) marks.set(key, { kind, items });
        else marks.delete(key);
        changed();
      },
      /** The mark lists of `plane` → [{kind, items}]. */
      list: (plane) => [...marks.values()].filter((m) => planeOf(m.kind) === plane),
    },
    frameKinds: {
      register(kind, Component) {
        if (Component) kinds.set(kind, Component);
        else kinds.delete(kind);
        changed();
      },
      get: (kind) => kinds.get(kind),
    },
    overlays: {
      register(id, Component, { plane = 'world' } = {}) {
        if (Component) layers.set(id, { Component, plane });
        else layers.delete(id);
        changed();
      },
      /** The overlays of `plane` → [[id, Component]]. */
      list: (plane) => [...layers].filter(([, l]) => l.plane === plane).map(([id, l]) => [id, l.Component]),
    },
  };
}

/** The style that places box `r` ({x, y, w, h} in points) at `k` CSS px per point. */
export const ptBox = (r, k) => ({ position: 'absolute', left: r.x * k, top: r.y * k, width: (r.w ?? 0) * k, height: r.h * k });

const LAYER = { position: 'absolute', inset: 0, pointerEvents: 'none' };
// A red wave under misspelt words, as Word's.
const WAVE = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='3'%3E%3Cpath d='M0 2.5 L1 0.5 L3 2.5 L4 0.5' fill='none' stroke='%23e00000' stroke-width='0.8'/%3E%3C/svg%3E\") repeat-x left bottom";
const MARK_STYLE = {
  selection: { background: 'color-mix(in srgb, Highlight 35%, transparent)' },
  composition: { borderBottom: '1px solid #000000' },
  squiggle: { background: WAVE },
  frame: { outline: '1px dashed color-mix(in srgb, Highlight 70%, transparent)' },
};

/** One mark of `kind` at CSS box `box` ({position, left, top, width, height}). Pages are paper, so the caret is black in either
 * theme, as in Word; a caret's width is ignored. */
export function Mark({ kind, box }) {
  if (kind === 'caret') return <div data-mark="caret" style={{ ...box, width: 1, marginLeft: -0.5, background: '#000000' }} />;
  if (kind === 'squiggle') return <div data-mark={kind} style={{ ...box, top: box.top + box.height - 3, height: 3, ...MARK_STYLE.squiggle }} />;
  return <div data-mark={kind} style={{ ...box, ...MARK_STYLE[kind] }} />;
}

const on = (p) => (m) => (m.surface ?? m.page) === p.surface && (m.session ?? null) === (p.session ?? null);

/** The world plane's layer over placement `placement` at `k` CSS px per point: its `frames`' components, the world overlays and the
 * world marks addressed to its surface. */
export function SurfaceLayer({ ov, placement: p, k, frames }) {
  useSyncExternalStore(ov.subscribe, ov.version);
  const page = p.surface;
  return (
    <div data-surface-overlay={page} style={LAYER}>
      {(frames ?? []).map((f) => {
        const Kind = ov.frameKinds.get(f.kind);
        return Kind && <div key={f.id} data-frame={f.id} style={ptBox(f, k)}><Kind frame={f} session={p.session} surface={page} page={page} k={k} /></div>;
      })}
      {ov.overlays.list('world').map(([id, Overlay]) => <Overlay key={id} session={p.session} surface={page} page={page} k={k} frames={frames ?? []} placement={p} />)}
      {ov.marks.list('world').flatMap(({ kind, items }, j) => items.filter(on(p)).map((m, i) => <Mark key={`${j}.${i}`} kind={kind} box={ptBox(m, k)} />))}
    </div>
  );
}

/** The screen plane of viewport `vp`: the screen overlays, and the screen marks placed by vp.rectOf, unscaled. */
export function ScreenLayer({ vp }) {
  const ov = vp.overlayHost;
  useSyncExternalStore(ov.subscribe, ov.version);
  return (
    <div data-plane-layer="screen" style={LAYER}>
      {ov.overlays.list('screen').map(([id, Overlay]) => <Overlay key={id} viewport={vp} />)}
      {ov.marks.list('screen').flatMap(({ kind, items }, j) => items.map((m, i) => {
        const box = vp.rectOf(m, 'screen');
        return box && <Mark key={`${j}.${i}`} kind={kind} box={{ position: 'absolute', ...box }} />;
      }))}
    </div>
  );
}
