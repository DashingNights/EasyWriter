import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Copy, Pencil, SquarePlus, Trash2, Workflow } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { flowRefs } from '../../../doc-utils.mjs';
import { rasterizeWhiteboard, resolveBg } from '../../../whiteboard.js';
import { duplicateFlow, flowList, insertFlowchartDialog, loadFlow, openFlows, removeFlow, updateFlow, useFlows } from '../../flows.js';
import { useEditor, useStore } from '../../store.js';
import { InlineInput } from '../InlineInput.jsx';
import { Tip } from '../Tip.jsx';
import { keepFocus } from '../Toolbar.jsx';

const root = () => document.getElementById('workspace-root');
let lastSel = null; // the selected flowchart, kept while one is open in the editor

/** A row's or card's hover action. */
function Act({ title, onClick, children }) {
  return (
    <Tip title={title}>
      <Button variant="ghost" size="icon-xs" aria-label={title} onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); onClick(); }}>
        {children}
      </Button>
    </Tip>
  );
}

function Actions({ id, onRename, className }) {
  return (
    <div className={cn('invisible flex shrink-0 items-center group-focus-within:visible group-hover:visible', className)}>
      <Act title="Insert into draft..." onClick={() => insertFlowchartDialog(id)}><SquarePlus /></Act>
      <Act title="Rename" onClick={onRename}><Pencil /></Act>
      <Act title="Duplicate" onClick={() => duplicateFlow(id)}><Copy /></Act>
      <Act title="Delete..." onClick={() => removeFlow(id)}><Trash2 /></Act>
    </div>
  );
}

// Grid previews: the flowchart's board through the export rasterizer, at most THUMB px on its long side, one at a time.
// Cached in memory per flowchart, keyed by its rev and the theme; a new key renders again and frees the old picture.
const THUMB = 480;
const previews = new Map(); // id → {key, url: Promise<object URL | null>}
let queue = Promise.resolve();

function preview(r, theme) {
  const key = `${r.rev}:${theme}`;
  const had = previews.get(r.id);
  if (had?.key === key) return had.url;
  const { w, h, bg, items } = r.board;
  const url = (queue = queue.then(() => rasterizeWhiteboard({ height: h, bg, items }, { width: w, theme, scale: Math.min(1, THUMB / Math.max(w, h)) }))
    .then(({ blob }) => URL.createObjectURL(blob), () => null));
  previews.set(r.id, { key, url });
  if (had) url.then(() => had.url.then((u) => u && URL.revokeObjectURL(u)));
  return url;
}

/** A card's preview area (16:9; the picture fitted inside on the board's background): rendered once the card is on screen. */
function Preview({ s, theme }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  const [shown, setShown] = useState(null); // {bg, url}
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true));
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!seen || !s.items) return undefined;
    let live = true;
    loadFlow(s.id).then(async (r) => {
      const v = r && { bg: resolveBg(r.board.bg, theme), url: await preview(r, theme) };
      if (live) setShown(v);
    });
    return () => { live = false; };
  }, [seen, s.id, s.rev, s.items, theme]);
  return (
    <div ref={ref} data-preview={s.items ? (shown?.url ? 'ready' : 'pending') : 'empty'} style={s.items && shown?.bg ? { background: shown.bg } : undefined}
      className="flex aspect-video items-center justify-center overflow-hidden rounded-t-md border-b bg-muted text-xs text-muted-foreground">
      {!s.items ? 'Empty' : shown?.url && <img src={shown.url} alt="" draggable={false} className="size-full object-contain" />}
    </div>
  );
}

/** The flowchart library (flowchart plan §5.10): the flowcharts `inScope`, filtered by `filter`, newest first, as a grid of
 * preview cards or as rows (`view`); a click or Enter opens one in the editor. Arrows, Home and End move the selection. */
export function FlowLibrary({ inScope, filter, view }) {
  useFlows();
  const editor = useEditor();
  const theme = useStore((s) => (s.settings?.theme === 'light' ? 'light' : 'dark'));
  const [renaming, setRenaming] = useState(null);
  const [sel, setSel] = useState(lastSel);

  // On #workspace-root (the list's focus target) and the cards, before the page's own keys.
  useEffect(() => {
    const el = root();
    const onKey = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const card = e.target.closest?.('[data-flow]');
      if (e.target !== el && e.target !== card) return; // an input or a button handles its own keys
      const cur = card ?? el.querySelector('[data-flow][aria-selected="true"]');
      if (e.key === 'Enter' && cur) {
        e.preventDefault();
        openFlows(cur.dataset.flow);
        return;
      }
      const cards = [...el.querySelectorAll('[data-flow]')];
      const at = cards.indexOf(cur);
      const cols = cards.filter((c) => c.offsetTop === cards[0]?.offsetTop).length; // 1 in rows
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
      let to = e.key === 'Home' ? 0 : e.key === 'End' ? cards.length - 1 : step == null ? null : at < 0 ? 0 : at + step;
      if (to == null || !cards.length) return;
      e.preventDefault();
      to = Math.max(0, Math.min(cards.length - 1, to));
      cards[to].focus(); // its onFocus selects it
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  const used = {};
  for (const r of editor ? flowRefs(editor.getJSON()) : []) used[r.flowId] = (used[r.flowId] ?? 0) + 1;
  const q = filter.trim().toLowerCase();
  const rows = flowList().filter((s) => inScope(s) && s.title.toLowerCase().includes(q));
  if (!rows.length) {
    return (
      <p className="m-auto px-4 text-center text-sm text-muted-foreground">
        {q ? 'No flowchart matches the filter.' : 'No flowcharts for this thread. New flowchart, or Insert flowchart in the editor.'}
      </p>
    );
  }
  const rename = (id, title) => {
    setRenaming(null);
    if (title != null) updateFlow(id, { title });
    root()?.focus();
  };
  const current = rows.some((s) => s.id === sel) ? sel : rows[0].id; // the one Tab reaches
  const itemProps = (s) => ({
    'data-flow': s.id, title: s.title, role: 'button', tabIndex: s.id === current ? 0 : -1, 'aria-selected': s.id === sel,
    onClick: () => renaming !== s.id && openFlows(s.id),
    onFocus: (e) => e.target === e.currentTarget && setSel((lastSel = s.id)),
  });
  const title = (s, className) => (renaming === s.id
    ? <InlineInput value={s.title} maxLength={120} className={cn('h-6 flex-1', className)} aria-label="Title" onClick={(e) => e.stopPropagation()} onDone={(t) => rename(s.id, t)} />
    : <span className={cn('min-w-0 flex-1 truncate', className)}>{s.title}</span>);
  const items = (s) => `${s.items} item${s.items === 1 ? '' : 's'}`;

  if (view === 'list') {
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-0.5 p-3 text-sm">
          {rows.map((s) => (
            <div key={s.id} {...itemProps(s)} className={cn('group flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 outline-none hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring',
              s.id === sel && 'bg-accent/60')}>
              <Workflow className="size-4 shrink-0 text-muted-foreground" />
              {title(s)}
              {used[s.id] > 0 && <Badge variant="secondary" title="Synced canvases of it in this draft">used here ({used[s.id]})</Badge>}
              <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{items(s)}</span>
              <Actions id={s.id} onRename={() => setRenaming(s.id)} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] content-start gap-3 p-3 text-sm">
        {rows.map((s) => (
          <div key={s.id} {...itemProps(s)} className={cn('group relative cursor-pointer rounded-md border bg-card shadow-xs outline-none select-none hover:border-ring/60',
            s.id === sel && 'border-primary ring-1 ring-primary')}>
            <Preview s={s} theme={theme} />
            <div className="flex flex-col gap-0.5 px-2 py-1.5">
              <div className="flex h-6 items-center">{title(s, 'font-medium')}</div>
              <span className="flex gap-2 truncate text-xs text-muted-foreground tabular-nums">
                {used[s.id] > 0 && <span title="Synced canvases of it in this draft">used here ({used[s.id]})</span>}<span>{items(s)}</span>
              </span>
            </div>
            <Actions id={s.id} onRename={() => setRenaming(s.id)} className="absolute top-1 right-1 rounded-md border bg-card shadow-xs" />
          </div>
        ))}
      </div>
    </div>
  );
}
