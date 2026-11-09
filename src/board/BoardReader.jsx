// bd-a11y (docs/plans/board/briefs/bd-a11y.md): the board as a list a screen reader can walk. The rows follow the board's
// reading order, rebuilt 300 ms after a change and capped at the 500 items nearest the view; the root says which row is
// selected and the polite status line says what just happened. Both are visually hidden: the board itself takes the eyes.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getState } from '../app/store.js';
import { describe, readingList } from './a11y.mjs';
import { boxOf } from './gestures.mjs';
import { nameOf } from './tools/layers.js';

const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' };
const CAP = 500; // items with a row
const REBUILD_MS = 300;

/** How far box `b` sits from view rect `v` (0 when they meet), points. */
function gap(b, v) {
  if (!v || !b) return 0;
  const dx = b.x > v.x + v.w ? b.x - (v.x + v.w) : v.x > b.x + b.w ? v.x - (b.x + b.w) : 0;
  const dy = b.y > v.y + v.h ? b.y - (v.y + v.h) : v.y > b.y + b.h ? v.y - (b.y + b.h) : 0;
  return Math.hypot(dx, dy);
}

/** The rows for `ctx` now → {rows: [{id, text}], more}: the 500 items nearest the view of the reading order, `more` the rest. */
function rowsFor(ctx) {
  const store = ctx.store;
  const ids = readingList(store);
  const titleOf = (id) => {
    const item = store.get(id);
    if (item) return nameOf(item);
    return (getState().drafts ?? []).find((draft) => draft.id === id)?.title ?? null;
  };
  let kept = ids;
  let more = 0;
  if (ids.length > CAP) {
    const order = new Map(ids.map((id, i) => [id, i]));
    const boxes = new Map(ids.map((id) => [id, boxOf(store.get(id), store)]));
    const view = ctx.vp?.view?.() ?? null;
    kept = [...ids]
      .sort((a, b) => gap(boxes.get(a), view) - gap(boxes.get(b), view) || order.get(a) - order.get(b))
      .slice(0, CAP)
      .sort((a, b) => order.get(a) - order.get(b));
    more = ids.length - kept.length;
  }
  return { rows: kept.map((id) => ({ id, text: describe(store.get(id), titleOf, store) })).filter((row) => row.text), more };
}

/** The board's reading list and live line for `ctx`, mounted as the viewport's screen overlay `board-a11y-reader`. */
export function BoardReader({ ctx }) {
  const vp = ctx.vp;
  const live = ctx.a11yLive;
  const title = ctx.draft?.title ?? '';
  const [list, setList] = useState(() => rowsFor(ctx));
  const [line, setLine] = useState('');
  useSyncExternalStore(ctx.selection.subscribe, ctx.selection.version);
  const ids = ctx.selection.ids;

  useEffect(() => {
    let timer = 0;
    const build = () => {
      timer = 0;
      setList(rowsFor(ctx));
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(build, REBUILD_MS);
    };
    build();
    const offs = [ctx.store.subscribe(later), vp?.subscribe?.('camera', later), vp?.subscribe?.('placements', later)];
    return () => {
      clearTimeout(timer);
      for (const off of offs) off?.();
    };
  }, [ctx, vp]);

  useEffect(() => (live ? live.subscribe(setLine) : undefined), [live]);

  // The selected row says where the board is: the root points at it while it has a row, and names the board.
  const active = ids.length === 1 && list.rows.some((row) => row.id === ids[0]) ? `board-item-${ids[0]}` : null;
  useEffect(() => {
    if (!vp?.root) return;
    if (active) vp.root.setAttribute('aria-activedescendant', active);
    else vp.root.removeAttribute('aria-activedescendant');
  }, [active, vp]);

  useEffect(() => {
    const root = vp?.root;
    if (!root) return;
    const was = root.getAttribute('aria-label');
    root.setAttribute('aria-label', title ? `Whiteboard, ${title}` : 'Whiteboard');
    return () => {
      if (was == null) root.removeAttribute('aria-label');
      else root.setAttribute('aria-label', was);
    };
  }, [title, vp]);

  return (
    <>
      <ul role="list" aria-label="Items on this whiteboard" style={VISUALLY_HIDDEN} data-board-a11y="">
        {list.rows.map((row) => (
          <li key={row.id} id={`board-item-${row.id}`} role="listitem">{row.text}</li>
        ))}
        {list.more > 0 && <li role="listitem">{`and ${list.more} more`}</li>}
      </ul>
      <div role="status" aria-live="polite" style={VISUALLY_HIDDEN} data-board-a11y-live="">{line}</div>
    </>
  );
}
