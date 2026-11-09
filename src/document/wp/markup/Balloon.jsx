// Revision balloons in the margin column (docs/plans/word plan.md §1.7 cards, §3 markup): one balloon per deletion and formatting
// change that Show Markup > Balloons puts there, as card source 'revisions'. A balloon is active while the selection is in its
// change, a click selects the change, Accept and Reject select it and run tracking's commands. Width is settings.word.tracking
// balloonWidth (points, or a percent of the sheet), capped at the margin column's width so balloons keep one edge with the comment
// and suggestion cards (ceiling: Word's default 9.4 cm is wider than MarginCards' w-64 column, which tooling owns); a dotted line
// runs to the text while balloonLines is on.
import { useLayoutEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { IconButton } from '../../../app/components/Tip.jsx';
import { keepFocus } from '../../../app/components/Toolbar.jsx';
import { getState } from '../../../app/store.js';
import { run } from '../../../tooling/registry.js';
import { revisionsOf } from '../../model/review.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { anchorRect } from '../page-engine/anchors.js';
import { balloons, clock } from './balloons.mjs';


/** The zoom of `view`'s page: screen px per layout px (the page wrap's CSS zoom). */
export function zoomOf(view) {
  const box = view.dom.getBoundingClientRect();
  return box.height / (view.dom.offsetHeight || box.height || 1) || 1;
}

/** The top of position `pos` in `view`, in .ProseMirror layout px (a margin card's top), kept per block (page-engine/anchors.js). */
export function anchorTop(view, pos) {
  try {
    return anchorRect(view, Math.min(pos, view.state.doc.content.size)).top;
  } catch {
    return 0;
  }
}

/** Selects revision `rev` in the main editor. */
function selectRev(rev) {
  const ed = getState().editor;
  if (!ed || ed.isDestroyed) return;
  ed.chain().focus().setTextSelection({ from: rev.from, to: rev.to }).run();
}

// The balloons' line widths, written after every balloon of a render has read its places: a write between two balloons' reads
// laid the whole text out again for each balloon (about 60 ms a render on the Word fixture).
const writes = [];
function writeLater(fn) {
  if (!writes.length) queueMicrotask(() => { for (const w of writes.splice(0)) w(); });
  writes.push(fn);
}

/** One balloon (a MarginCards card Component). */
function Balloon({ card, active, activate }) {
  const { b, view } = card;
  const t = wordSettings(getState().settings).tracking;
  const line = useRef(null);
  const box = useRef(null);
  const sheet = view.dom.closest('.page');
  const width = t.balloonUnit === 'pct' ? ((sheet?.offsetWidth ?? 794) * t.balloonWidth) / 100 : (t.balloonWidth * 4) / 3;
  // The dotted line from the change to the balloon's left edge, measured after layout (layout px, the zoom divided out).
  useLayoutEffect(() => {
    if (!line.current || !box.current || !view.dom.isConnected) return;
    try {
      const x = anchorRect(view, b.rev.from).left;
      const width = `${Math.max(0, (box.current.getBoundingClientRect().left - view.dom.getBoundingClientRect().left) / zoomOf(view) - x)}px`;
      const el = line.current;
      writeLater(() => { if (el.style.width !== width) el.style.width = width; });
    } catch { /* the change left the doc before this render */ }
  });
  const pick = () => {
    selectRev(b.rev);
    activate();
  };
  const decide = (id) => () => {
    selectRev(b.rev);
    run(id);
  };
  const who = b.rev.author || 'Unknown author';
  return (
    <div ref={box} data-balloon={b.rev.kind} data-rev-id={b.rev.id} role="region" aria-label={`${who}, ${b.label}`} onMouseDown={keepFocus} onClick={pick}
      style={{ width, maxWidth: '100%' }} data-agent-deny="" data-board-chrome=""
      className={`relative rounded-md border bg-card px-2 py-1 text-xs text-card-foreground shadow-sm ${active ? 'border-ring ring-1 ring-ring' : 'border-border'}`}>
      {t.balloonLines && <span ref={line} aria-hidden data-balloon-line="" className="pointer-events-none absolute top-3 right-full border-t border-dotted border-muted-foreground" />}
      <div className="flex items-center gap-1">
        <span className="truncate font-medium">{who}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{clock(b.rev.date)}</span>
        <span className="ml-auto flex shrink-0" onClick={(e) => e.stopPropagation()}>
          <IconButton label="Accept" onClick={decide('review.tracking.accept.acceptThisChange')}><Check /></IconButton>
          <IconButton label="Reject" onClick={decide('review.tracking.reject.rejectChange')}><X /></IconButton>
        </span>
      </div>
      <p className="break-words">{b.label}</p>
    </div>
  );
}

// The marks of a formatting change: the formatChange mark's `old` and the marks the text has now, read at the change's start.
function withMarks(doc, r) {
  if (r.kind !== 'format') return r;
  const node = doc.nodeAt(r.from);
  const m = node?.marks.find((x) => x.type.name === 'formatChange' && x.attrs.id === r.id);
  return m ? { ...r, old: m.attrs.old ?? [], now: node.marks.map((x) => x.toJSON()) } : r;
}

let last = { doc: null, t: null, list: [] };

/** Card source 'revisions' (plan.md §1.7): the balloons of the main editor's doc under the current tracking settings. */
export const revisionCards = {
  cards(state, view) {
    if (!view?.dom?.isConnected) return [];
    const t = wordSettings(getState().settings).tracking;
    if (last.doc !== state.doc || last.t !== t) last = { doc: state.doc, t, list: balloons(revisionsOf(state.doc).map((r) => withMarks(state.doc, r)), t) };
    const at = state.selection.from;
    return last.list.map((b) => ({ id: b.id, top: anchorTop(view, b.rev.from), active: at >= b.rev.from && at <= b.rev.to, b, view, Component: Balloon }));
  },
};
