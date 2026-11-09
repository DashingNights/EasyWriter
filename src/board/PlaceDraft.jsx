// Place a draft on a board (docs/plans/board/briefs/bd-instance.md): a searchable list of the drafts that can be placed, one row
// each with its format icon, Place and Cancel. A draft the board already holds, or a whiteboard, shows disabled with the reason
// behind Help.
import { useState } from 'react';
import { File, FileText, MessageSquareText, Shapes } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { openDialog, refocusEditor } from '../app/actions.js';
import { getState } from '../app/store.js';
import { Help } from '../app/components/Tip.jsx';

const FORMAT_ICONS = { document: FileText, 'forum-post': MessageSquareText, page: File, board: Shapes };
const FormatIcon = ({ format }) => {
  const Icon = FORMAT_ICONS[format ?? 'forum-post'] ?? File;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
};

/** Why draft `d` cannot be placed on board `board`, or null. */
function refusal(d, board) {
  if (d.format === 'board' || d.id === board?.id) return 'A whiteboard cannot hold a whiteboard yet.';
  if ((board?.store?.live() ?? []).some((item) => item.type === 'doc' && item.draft === d.id && !item.gone)) {
    return 'This draft is on this whiteboard already.';
  }
  return null;
}

/** The drafts the board can hold: every draft on the engine (a developer's old DOM draft is left out). */
export const placeable = () => (getState().drafts ?? []).filter((d) => d.engine);

/** Opens the Place a draft dialog for `board` → the chosen draft's id, or null. */
export async function chooseDraft(board) {
  const drafts = placeable().map((d) => ({ id: d.id, title: d.title || 'Untitled draft', format: d.format, why: refusal(d, board) }));
  const r = await openDialog('placeDraft', { drafts, title: board?.draft?.title ?? '' });
  return r?.draftId ?? null;
}

/** The dialog: search over the draft titles, one row each; Place is off until a placeable row is picked. */
export function PlaceDraft({ drafts = [], onClose }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(null);
  const match = query.trim().toLowerCase();
  const shown = match ? drafts.filter((d) => d.title.toLowerCase().includes(match)) : drafts;
  const choice = drafts.find((d) => d.id === picked && !d.why) ?? null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(null)}>
      <DialogContent aria-describedby={undefined} className="gap-2 p-3 text-sm" onCloseAutoFocus={refocusEditor}
        onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader><DialogTitle>Place a draft</DialogTitle></DialogHeader>
        <Input autoFocus aria-label="Search drafts" className="h-8" placeholder="Search drafts" value={query}
          onChange={(e) => setQuery(e.target.value)} />
        <div role="listbox" aria-label="Drafts" className="max-h-72 overflow-y-auto rounded-md border">
          {shown.map((d) => (
            <div key={d.id} role="option" tabIndex={0} aria-selected={picked === d.id} data-place-draft={d.id}
              className={`flex min-h-8 items-center gap-2 px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${d.why ? 'cursor-default opacity-50'
                : 'cursor-pointer hover:bg-accent/60'} ${picked === d.id ? 'bg-accent/60' : ''}`}
              onClick={() => !d.why && setPicked(d.id)} onDoubleClick={() => !d.why && onClose({ draftId: d.id })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !d.why) {
                  e.preventDefault();
                  onClose({ draftId: d.id });
                } else if (e.key === ' ' && !d.why) {
                  e.preventDefault();
                  setPicked(d.id);
                }
              }}>
              <FormatIcon format={d.format} />
              <span className="min-w-0 flex-1 truncate">{d.title}</span>
              {d.why && <Help label="Why this draft cannot be placed">{d.why}</Help>}
            </div>
          ))}
          {!shown.length && <p className="px-2 py-2 text-xs text-muted-foreground">{drafts.length ? 'No drafts match.' : 'No drafts to place.'}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onClose(null)}>Cancel</Button>
          <Button type="button" size="sm" disabled={!choice} onClick={() => onClose({ draftId: choice.id })}>Place</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
