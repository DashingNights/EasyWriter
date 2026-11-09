// The whiteboard's slot over the editor area's viewport (docs/plans/board/design.md section 3): shown while the editor view
// holds a whiteboard draft, which has an id once its first save wrote it. BoardArea draws the board.
import { useStore } from '../app/store.js';
import { useViewportBox } from '../app/viewport.js';
import { boardOpens } from '../tooling/surface.js';
import { BoardArea } from './BoardArea.jsx';

export function BoardSlot() {
  const open = useStore(boardOpens);
  const draft = useStore((s) => (boardOpens(s) ? s.draft : null));
  const box = useViewportBox(open, true);
  return draft?.id && box ? (
    <div data-board-slot="" data-viewport-slots="" tabIndex={-1} className="absolute z-[10] bg-background outline-none" style={box}>
      <BoardArea key={draft.id} draft={draft} />
    </div>
  ) : null;
}
