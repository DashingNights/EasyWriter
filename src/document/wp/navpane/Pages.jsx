// The Navigation pane's Pages tab: one thumbnail per page in a single column scaled to the pane's width, the caret's page outlined,
// only the pages with hits while a search holds. Thumbnails are page clones (geometry.js pageClone), drawn only once in view and
// cached per editor and geometry version.
import { useEffect, useRef, useState } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { cn } from 'cn';
import { geometryOf, pageClone, scaleOf } from '../../geometry.js';
import { reveal } from './plugin.js';
import { pagesWithHits } from './results.mjs';

// view → { version, boxes }: boxes maps `${index}:${width}:${zoom}` → the clone box. Each editor counts its own geometry versions from 0,
// so the cache is per view; a view's boxes are dropped when its version moves on or the tab unmounts.
const caches = new WeakMap();

function Thumb({ view, page, version, width, current, onPick }) {
  const box = useRef(null);
  const [seen, setSeen] = useState(false);
  const scale = width / page.box.w;
  const zoom = scaleOf(view); // the clone lays out at the editor's zoom (match), so a new zoom is a new clone
  useEffect(() => {
    const el = box.current;
    if (!el || seen) return undefined;
    const io = new IntersectionObserver((list) => list.some((e) => e.isIntersecting) && setSeen(true));
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  useEffect(() => {
    const el = box.current;
    if (!seen || !el) return;
    let c = caches.get(view);
    if (c?.version !== version) caches.set(view, (c = { version, boxes: new Map() }));
    const key = `${page.index}:${width}:${zoom}`;
    let clone = c.boxes.get(key);
    if (!clone) {
      clone = pageClone(view, page.index, { scale, match: true });
      if (clone) c.boxes.set(key, clone);
    }
    if (clone && clone.parentNode !== el) el.replaceChildren(clone);
  }, [seen, view, version, width, zoom, page.index]);
  return (
    <button type="button" data-nav-page={page.index} aria-label={`Page ${page.label ?? page.index + 1}`} aria-current={current || undefined}
      onClick={() => onPick(page)} className={cn('block shrink-0 overflow-hidden bg-white outline-offset-2', current ? 'outline-2 outline-primary' : 'outline-1 outline-border hover:outline-ring')}
      style={{ width, height: page.box.h * scale }}>
      <div ref={box} className="pointer-events-none" />
    </button>
  );
}

export function Pages({ ed, matches, searching }) {
  const { view } = ed;
  const [host, setHost] = useState(null); // a callback ref: the tab swaps its note for the thumbnail column
  const [width, setWidth] = useState(0);
  // ponytail: pagination replaces geometry without a transaction, so the tab looks for a new version twice a second; a layout
  // event from the engine would let it listen instead.
  const [, tick] = useState(0);
  const geo = geometryOf(ed.state);
  useEffect(() => {
    let last = geo?.version;
    const id = setInterval(() => {
      const v = geometryOf(view.state)?.version;
      if (v !== last) {
        last = v;
        tick((n) => n + 1);
      }
    }, 500);
    return () => clearInterval(id);
  }, [view]);
  useEffect(() => () => caches.delete(view), [view]);
  useEffect(() => {
    if (!host) return undefined;
    const ro = new ResizeObserver(() => setWidth(Math.max(40, Math.floor(host.clientWidth - 32))));
    ro.observe(host);
    return () => ro.disconnect();
  }, [host]);
  const pick = (page) => {
    const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(Math.min(page.from, view.state.doc.content.size))));
    view.dispatch(tr);
    view.focus();
    reveal(view, view.state.selection.from);
  };
  if (!geo?.pages?.length) return <p ref={setHost} className="px-3 py-1 text-muted-foreground">Pages show in Print Layout.</p>;
  const shown = searching ? new Set(pagesWithHits(matches, geo.pageOf)) : null;
  return (
    <div ref={setHost} data-nav-pages="" className="flex flex-col items-center gap-3 px-4 pt-1 pb-14">
      {width > 0 && geo.pages.filter((p) => !shown || shown.has(p.index)).map((p) => (
        <div key={p.index} className="flex flex-col items-center gap-1">
          <Thumb view={view} page={p} version={geo.version} width={width} current={p.index === geo.page} onPick={pick} />
          <span className="text-xs text-muted-foreground">{p.label ?? p.index + 1}</span>
        </div>
      ))}
    </div>
  );
}
