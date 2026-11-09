// The Undo list (frame.qat.undo's menu, probe/menus/frame.undo-move-resize-object.json): undo steps newest first; hovering a step
// marks it and every newer one, the footer counts them ("Undo 3 Actions") and a click undoes that many. On a canvas draft the
// steps are the engine's (edit.undoHistory) and a click runs edit.undoTo, one call however many.
import { useState } from 'react';
import { cn } from 'cn';
import { undoLabels } from './plugin.js';

export function UndoList({ ctx, close }) {
  const ed = ctx?.target;
  const [hover, setHover] = useState(-1);
  const engine = ctx?.engine;
  const labels = engine ? (ctx.read('edit.undoHistory')?.undo ?? []).map((s) => (typeof s === 'string' ? s : s?.label ?? '')) : ed ? undoLabels(ed.state) : [];
  const undo = (n) => {
    if (engine) engine.exec('edit.undoTo', { count: n });
    else for (let i = 0; i < n; i++) ed.commands.undo();
    close?.();
  };
  return (
    <div data-undo-list="" className="flex w-60 flex-col" onMouseLeave={() => setHover(-1)}>
      <div className="max-h-72 overflow-y-auto">
        {labels.map((label, i) => (
          <button key={i} type="button" data-undo-step={i} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHover(i)}
            onClick={() => undo(i + 1)}
            className={cn('block w-full truncate rounded-sm px-2 py-1 text-left text-sm outline-none', i <= hover && 'bg-accent')}>
            {label}
          </button>
        ))}
      </div>
      <div data-undo-footer="" className="border-t px-2 py-1 text-center text-xs text-muted-foreground">
        {hover < 0 ? 'Cancel' : `Undo ${hover + 1} Action${hover ? 's' : ''}`}
      </div>
    </div>
  );
}
UndoList.engine = true; // reads ctx.read on a canvas draft
