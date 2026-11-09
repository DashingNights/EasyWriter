// Collapsible headings on a canvas draft (docs/plans/engine/stage2.md G19): a triangle beside each folded heading, drawn over the
// page from the engine's anchors as the comment cards are (canvas/overlay.jsx registerOverlay). A click opens the heading
// (heading.collapse); the right-click menu, the Navigation pane rows and Collapsed by default fold them.
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { afterTyping } from '../../../app/store.js';
import { registerOverlay } from '../../canvas/overlay.jsx';
import { publish, sessionRecords } from '../../canvas/records.js';

const SIZE = 9; // pt, the triangle
const GAP = 4; // pt between the triangle and the heading's text

async function load(d) {
  const heads = (await Promise.resolve(d.client.query('nav.headings', { folded: true })).catch(() => null))?.value ?? [];
  // In the headings' order, whichever caret answers first, so the same folds compare the same (publish).
  const folds = (await Promise.all(heads.filter((h) => h.folded).map(async (h) => {
    const at = await Promise.resolve(d.client.caret(h.pos)).catch(() => null);
    return at && { id: h.id, page: at.page, x: at.x, y: at.y, h: at.h ?? 12 };
  }))).filter(Boolean);
  d.folds = folds;
  publish(d, folds);
}

// Each session's record {client, folds: [{id, page, x, y, h}], version, fns}, held by its drawn pages (canvas/records.js).
const records = sessionRecords('folds', (client) => {
  const d = { client, folds: [], version: 0, fns: new Set(), busy: false, again: false };
  const refresh = async () => {
    if (d.busy) return void (d.again = true);
    d.busy = true;
    do {
      d.again = false;
      await load(d);
    } while (d.again && !d.gone);
    d.busy = false;
  };
  for (const e of ['layout', 'command', 'reopened']) client.on(e, () => (e === 'layout' ? afterTyping(refresh) : refresh()));
  refresh();
  return d;
});

/** One triangle: a native button, so its press never reaches the page area's input (which listens on an ancestor). */
function Triangle({ d, f, k }) {
  const el = useRef(null);
  useLayoutEffect(() => {
    const b = el.current;
    const stop = (e) => e.stopPropagation();
    const open = (e) => {
      e.stopPropagation();
      e.preventDefault();
      d.client.exec('heading.collapse', { id: f.id, op: 'expand' });
    };
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) b.addEventListener(t, stop);
    b.addEventListener('click', open);
    return () => {
      for (const t of ['pointerdown', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) b.removeEventListener(t, stop);
      b.removeEventListener('click', open);
    };
  }, [d, f.id]);
  const s = SIZE * k;
  return (
    <button ref={el} type="button" data-heading-fold={f.id} aria-label="Expand heading" title="Expand"
      style={{ position: 'absolute', left: (f.x - GAP - SIZE) * k, top: (f.y + (f.h - SIZE) / 2) * k, width: s, height: s, padding: 0,
        pointerEvents: 'auto', cursor: 'pointer', border: 0, background: 'transparent', color: '#737373' }}>
      <svg viewBox="0 0 10 10" width={s} height={s} aria-hidden><path d="M2 1 L8 5 L2 9 Z" fill="currentColor" /></svg>
    </button>
  );
}

/** The world overlay of one page: its folded headings' triangles. */
function PageFolds({ session, page, k }) {
  const d = records.use(session);
  useSyncExternalStore((fn) => (d ? (d.fns.add(fn), () => d.fns.delete(fn)) : () => {}), () => d?.version ?? 0);
  const here = d?.folds.filter((f) => f.page === page) ?? [];
  if (!here.length) return null;
  return <div data-heading-folds={page} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{here.map((f) => <Triangle key={f.id} d={d} f={f} k={k} />)}</div>;
}

registerOverlay('headingFolds', PageFolds);
