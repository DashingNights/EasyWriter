// The Comments pane (docs/plans/word plan.md §3 comments, pane id comments, right): every thread the filter shows in document
// order with its replies and the card actions, a New button and the filter. A click on a thread selects its anchor.
import { useSyncExternalStore } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { commentState, newComment, setFilter, shownThreads } from './actions.js';
import { ThreadCard } from './Card.jsx';
import { CanvasCommentsPane } from './CanvasCards.jsx';

/** The main editor's state, re-read on each of its transactions (the pane's ctx follows the story editor while one is open). */
function useMainState(ed) {
  return useSyncExternalStore((fn) => {
    ed?.on('transaction', fn);
    return () => ed?.off('transaction', fn);
  }, () => ed?.state ?? null);
}

export function CommentsPane({ ctx }) {
  // A canvas draft's threads are the engine's (canvas.js).
  return ctx.engine ? <CanvasCommentsPane session={ctx.engine} /> : <DomCommentsPane ctx={ctx} />;
}

function DomCommentsPane({ ctx }) {
  const ed = ctx.ed;
  const state = useMainState(ed);
  if (!state) return null;
  const ps = commentState(state);
  const threads = shownThreads(state);
  return (
    <div data-comments-pane="" className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-2">
        <Button size="xs" variant="outline" data-comment-action="new" onMouseDown={(e) => e.preventDefault()} onClick={() => newComment(ed)}>
          <MessageSquarePlus /> New
        </Button>
        <select aria-label="Filter comments" value={ps.filter ?? ''} onChange={(e) => setFilter(e.target.value || null)}
          className="h-6 rounded-md border bg-background px-1 text-xs">
          <option value="">All comments</option>
          <option value="active">Active only</option>
          <option value="resolved">Resolved only</option>
        </select>
      </div>
      {threads.length ? threads.map((c) => <ThreadCard key={c.id} thread={c} editing={ps.editing} active={ps.active === c.id} inPane />)
        : <p className="px-1 text-muted-foreground">No comments to show.</p>}
    </div>
  );
}
