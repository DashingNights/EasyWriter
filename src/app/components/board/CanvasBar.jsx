import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BookPlus, Check, Shrink, SquarePen, Trash2, Unlink, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { activeCanvas, canvasEditor, flowSource } from '../../../canvas.js';
import { validFlow } from '../../../flow/library.mjs';
import { openFlows, saveToLibrary } from '../../flows.js';
import { can } from '../../gates.mjs';
import { useStore } from '../../store.js';
import { Tip } from '../Tip.jsx';
import { CHROME, keepFocus as keepBoardFocus } from './controls.jsx';

const keepFocus = (e) => e.preventDefault(); // buttons never take focus: the document keeps its selection

/** Runs `place(el)` for the bar in `ref` every frame while `key` is set: it follows its canvas through drags, scrolling
 * and zoom. */
function useFollow(ref, key, place) {
  useLayoutEffect(() => {
    if (!key) return undefined;
    let frame;
    const tick = () => {
      if (ref.current) place(ref.current);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [key]);
}

const editorArea = () => document.getElementById('editor-area').getBoundingClientRect();

/** §6b document canvas bar at the top-right of the node-selected canvas (one instance in App; hovering never shows it), fixed-positioned
 * and following the canvas every frame; pinned to the top of the editor area while the canvas top is scrolled away. A synced
 * canvas (flowchart plan §5.11) offers Open in library and Unlink, any other Save to library…. */
export function CanvasBar() {
  const snap = useSyncExternalStore(activeCanvas.subscribe, activeCanvas.get);
  const view = snap?.view;
  const ref = useRef(null);
  // Only over the editor: the canvas stays selected while another page is shown.
  const editorShown = useStore((s) => can('view.editor', { view: s.view }));

  useFollow(ref, view, (el) => {
    const r = view.dom.getBoundingClientRect();
    const a = editorArea();
    // A canvas too small to hold the bar gets it above its top edge, clear of the corner handles.
    const above = r.width < el.offsetWidth + 16 || r.height < el.offsetHeight + 16;
    const x = Math.max(a.left + 8, r.right - (above ? 0 : 8) - el.offsetWidth);
    const y = above ? Math.max(a.top + 8, r.top - 12 - el.offsetHeight)
      : Math.max(r.top + 8, Math.min(a.top + 8, r.bottom - 8 - el.offsetHeight));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.style.visibility = r.bottom > a.top + 8 && r.top < a.bottom - 8 ? '' : 'hidden';
  });

  if (!snap || !editorShown) return null;
  const { dw, w, h, flow } = snap;
  const tip = (title, button) => <Tip title={title}>{button}</Tip>;
  const node = { type: 'canvas', attrs: view.node.attrs };
  return (
    <div ref={ref} role="toolbar" aria-label="Canvas" onMouseDown={keepFocus}
      className="fixed top-0 left-0 z-30 flex items-center gap-0.5 rounded-island border bg-card p-0.5 text-xs shadow-lg">
      {tip('Edit the canvas (double-click, Enter)', <Button variant="ghost" size="xs" onClick={() => view.open()}><SquarePen />Edit</Button>)}
      <span className="px-1.5 text-muted-foreground tabular-nums">{`${dw} x ${Math.round((dw * h) / w)}`}</span>
      {tip('Artboard size (at most the page width)', <Button variant="ghost" size="xs" onClick={() => view.setDw(Math.min(w, view.maxWidth()))}>Actual size</Button>)}
      {tip('Page width', <Button variant="ghost" size="xs" onClick={() => view.setDw(view.maxWidth())}>Full width</Button>)}
      {flow && can('flow.synced', node) && (
        <>
          {tip(flow.missing ? 'Flowchart missing from the library, unlinked view' : `Open "${flow.title ?? 'Flowchart'}" in the flowchart library`,
            <Button variant="ghost" size="xs" disabled={!can('flow.present', flowSource.get(flow.id))} onClick={() => openFlows(flow.id)}><Workflow />Open in library</Button>)}
          {tip('Make it an independent canvas holding this picture', <Button variant="ghost" size="xs" onClick={() => view.unlink()}><Unlink />Unlink</Button>)}
        </>
      )}
      {can('flow.unsynced', node) && tip('Make it a library flowchart this canvas shows synced',
        <Button variant="ghost" size="xs" onClick={() => saveToLibrary(view)}><BookPlus />Save to library...</Button>)}
      {tip('Delete canvas', <Button variant="ghost" size="icon-xs" aria-label="Delete canvas" onClick={() => view.remove()}><Trash2 /></Button>)}
    </div>
  );
}

/** Artboard side of fixed board `board`; commits on Enter or blur (sets the frame, 40…8000; the artboard still holds the
 * content plus padding: the board sizes it). Escape reverts. Also in the flowchart library editor's header. */
export function SizeInput({ board, label, value, onCommit }) {
  const [draft, setDraft] = useState(null); // text being typed; null = show the value
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    onCommit(Number(draft));
  };
  return (
    <Label className="gap-1 pl-1 text-xs text-muted-foreground">
      {label}
      <Input type="number" min={40} max={8000} step={1} aria-label={`Artboard ${label === 'W' ? 'width' : 'height'}`}
        className="h-6 w-16 px-1.5 text-xs text-foreground md:text-xs" value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            board.focus();
          } else if (e.key === 'Escape' && draft !== null) {
            e.preventDefault(); // a second Escape returns to the board
            setDraft(null);
          }
        }} />
    </Label>
  );
}

function EditBar({ session }) {
  const { w, h } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const flow = validFlow(session.target.attrs()?.flow); // a synced document canvas
  const ref = useRef(null);
  useFollow(ref, session, (el) => {
    const r = session.board.dom.getBoundingClientRect();
    const a = editorArea();
    const x = Math.max(a.left + 8, Math.min(r.right - el.offsetWidth, a.right - 8 - el.offsetWidth));
    const y = Math.max(a.top + 8, r.top - 8 - el.offsetHeight);
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.style.visibility = r.bottom > a.top + 8 && r.top < a.bottom - 8 ? '' : 'hidden';
  });
  const tip = (title, button) => <Tip title={title} {...CHROME}>{button}</Tip>;
  return (
    <div ref={ref} {...CHROME} data-ribbon-avoid="" role="toolbar" aria-label="Canvas editing" onMouseDown={keepBoardFocus}
      className="fixed top-0 left-0 z-30 flex items-center gap-1 rounded-island border bg-card p-0.5 text-xs shadow-lg">
      {flow && (
        <span className="flex max-w-56 min-w-0 items-center gap-1 pl-1.5 text-muted-foreground" title="Edits change the library flowchart everywhere it is synced">
          <Workflow className="size-3.5 shrink-0" />
          <span className="truncate text-foreground">{flowSource.title(flow.id) ?? 'Flowchart'}</span>
          {flowSource.isMissing(flow.id) ? '(missing)' : '(synced)'}
        </span>
      )}
      <SizeInput board={session.board} label="W" value={w} onCommit={(v) => session.setSize(v, h)} />
      <SizeInput board={session.board} label="H" value={h} onCommit={(v) => session.setSize(w, v)} />
      {tip('Shrink the artboard to the items', <Button variant="ghost" size="xs" onClick={() => session.fitContent()}><Shrink />Fit to content</Button>)}
      {tip('Back to the document (Escape)', <Button size="xs" onClick={() => session.close(true)}><Check />Done</Button>)}
    </div>
  );
}

/** §6b canvas edit mode bar (one instance in App): the synced flowchart's title (flowchart plan §5.11), W, H, Fit to
 * content and Done, attached above the canvas being edited,
 * fixed-positioned and following it every frame, kept inside the editor area; the item ribbon never covers it. Board
 * chrome: focus in its inputs keeps a text item edit open, and a click on it never ends edit mode. */
export function CanvasEditBar() {
  const session = useSyncExternalStore(canvasEditor.subscribe, canvasEditor.get);
  return session ? <EditBar key={session.id} session={session} /> : null;
}
