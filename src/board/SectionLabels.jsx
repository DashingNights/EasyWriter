// A document's title above its section (docs/plans/board/briefs/bd-section.md, design section 6): the draft list's own title,
// so a rename shows here, muted and accent while the document is selected. A double-click renames the draft through the app's
// rename action. A screen-plane overlay, so the label keeps its size at any zoom; under 6 % it is not drawn.
import { useState, useSyncExternalStore } from 'react';
import { renameDraft } from '../app/actions.js';
import { useStore } from '../app/store.js';
import { planeMap } from './Selection.jsx';
import { rectsOf, sectionRect } from './sections.mjs';
import { dragOffset, sectionBoard } from './tools/section.js';

const MIN_K = 0.06;
const ACCENT = '#0d99ff';
const MUTED = 'var(--muted-foreground, #6b6b6b)';
const FONT = '11px system-ui, sans-serif';
const EMPTY_SUB = () => () => {};
const ZERO = () => 0;

export function SectionLabels({ viewport: vp }) {
  const ctx = sectionBoard.ctx;
  const sel = ctx?.selection;
  const drafts = useStore((s) => s.drafts) ?? [];
  useSyncExternalStore(sel ? sel.subscribe : EMPTY_SUB, sel ? sel.version : ZERO);
  useSyncExternalStore(dragOffset.subscribe, dragOffset.version);
  useSyncExternalStore(vp.watch, vp.version);
  const [edit, setEdit] = useState(null); // {id, draft, value}: the title being typed
  if (!ctx || !vp) return null;
  const m = planeMap(vp); // the zoom gesture's while one runs, so the label moves with its pages

  if (vp.camera.zoom < MIN_K) return null;
  const off = dragOffset.current;
  const rows = [];
  for (const item of ctx.store.live()) {
    if (item.type !== 'doc' || item.gone || item.hidden) continue;
    const pages = ctx.instances?.pagesOf(item.id) ?? [];
    const box = pages.length ? sectionRect(rectsOf(item, pages)) : null;
    if (!box) continue;
    // A drag of the whole section takes the label with it (a dragged page leaves it where the section is).
    const [dx, dy] = off.id === item.id && off.page == null ? [off.dx, off.dy] : [0, 0];
    rows.push({ item, title: drafts.find((d) => d.id === item.draft)?.title ?? item.name ?? 'Document',
      left: m.at({ x: box.x + dx, y: box.y }).x, top: m.at({ x: box.x, y: box.y + dy }).y, selected: ctx.selection.has(item.id) });
  }
  if (!rows.length) return null;

  const commit = () => {
    const e = edit;
    if (!e) return;
    setEdit(null);
    const was = drafts.find((d) => d.id === e.draft)?.title;
    const title = e.value.trim();
    if (title && title !== was) renameDraft(e.draft, title).catch(() => {});
  };

  return (
    <div data-board-section-labels="" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {rows.map((row) => (edit?.id === row.item.id ? (
        <input key={row.item.id} autoFocus aria-label="Document title" value={edit.value}
          onChange={(e) => setEdit({ ...edit, value: e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); setEdit(null); }
          }}
          onBlur={commit}
          style={{ position: 'absolute', left: row.left, top: row.top - 20, width: 180, font: FONT, pointerEvents: 'auto' }} />
      ) : (
        <button key={row.item.id} type="button" data-board-section-label={row.item.id} data-selected={row.selected ? '' : undefined}
          onDoubleClick={(e) => { e.stopPropagation(); setEdit({ id: row.item.id, draft: row.item.draft, value: row.title }); }}
          style={{ position: 'absolute', left: row.left, top: row.top, transform: 'translateY(-100%)', padding: 0, border: 0,
            background: 'none', font: FONT, color: row.selected ? ACCENT : MUTED, whiteSpace: 'nowrap', pointerEvents: 'auto' }}>
          {row.title}
        </button>
      )))}
    </div>
  );
}
