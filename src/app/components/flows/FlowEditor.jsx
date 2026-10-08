import { useLayoutEffect, useRef, useState } from 'react';
import { flowSource } from '../../../canvas.js';
import { Board } from '../../../whiteboard.js';
import { canRedoFlow, canUndoFlow, commitLibrary, getFlow, redoFlow, undoFlow } from '../../flows.js';
import { bindPanZoom, zoomAround } from '../../panzoom.js';
import { backgroundClick } from '../../viewport.js';
import { ShapePanel } from './ShapePanel.jsx';

const HOME = { side: 48, top: 24 }; // room the opening view keeps around the artboard (px)

/** The library editor (flowchart plan §5.10): one fixed Board on the record's board in a pannable, zoomable area (middle
 * drag, Ctrl + wheel 10–400 %), committing through the record's own undo stack; window pastes go to it. It follows writes
 * made elsewhere (agents; the workspace replaces the editor column, so no synced canvas is edited meanwhile). The shape
 * panel is docked on its left, after room for the §6c rail; a tile dropped anywhere on the area lands on the board. Mounted
 * per flowchart (`key`); `onBoard(board | null)` hands the Board to the header. */
export function FlowEditor({ id, onBoard }) {
  const areaRef = useRef(null);
  const wrapRef = useRef(null);
  const [board, setBoard] = useState(null);
  useLayoutEffect(() => {
    const [area, wrap] = [areaRef.current, wrapRef.current];
    const zoom = () => Number(wrap.style.zoom) || 1;
    const board = new Board(getFlow(id).board, {
      commit: (attrs, newGroup) => commitLibrary(id, attrs, newGroup),
      undo: () => undoFlow(id),
      redo: () => redoFlow(id),
      canUndo: () => canUndoFlow(id),
      canRedo: () => canRedoFlow(id),
      emptyClick: () => board.dom.focus({ preventScroll: true }),
      deleteBoard: () => {},
      dropArea: () => area,
      // The artboard grew or shrank on the left / top: scroll by as much, so the content stays put on screen.
      shift: (dx, dy) => {
        const [z, left, top] = [zoom(), area.scrollLeft, area.scrollTop];
        area.scrollLeft += dx * z;
        area.scrollTop += dy * z;
        return { x: dx - (area.scrollLeft - left) / z, y: dy - (area.scrollTop - top) / z };
      },
    }, { fixed: true, unit: 1 });
    wrap.append(board.dom);
    const zoomTo = (percent, anchor) => {
      zoomAround(area, wrap, Math.min(400, Math.max(10, percent)) / 100, anchor);
      board.refreshScale(); // handles keep their on-screen size
    };
    bindPanZoom(area, wrap, zoomTo);
    // A click on the area around the artboard deselects, as one on empty board area does (§7 Background clicks).
    area.addEventListener('pointerdown', (e) => {
      if (!backgroundClick(e, (t) => t === area || t === area.firstElementChild || t === wrap)) return;
      e.preventDefault(); // the focus stays on the board
      board.finishEdit();
      board.select(null);
      board.focus();
    });
    // Opening view: the artboard fitted to the area's width (at most 1 : 1), centred, its top just below the top.
    zoomTo((100 * (area.clientWidth - 2 * HOME.side)) / Math.max(board.size().w, area.clientWidth - 2 * HOME.side));
    const a = area.getBoundingClientRect();
    const b = board.dom.getBoundingClientRect();
    area.scrollLeft += b.left - a.left - (area.clientWidth - b.width) / 2;
    area.scrollTop += b.top - a.top - HOME.top;
    const unsubscribe = flowSource.subscribe((changed) => changed === id && getFlow(id) && board.setAttrs(getFlow(id).board));
    window.addEventListener('paste', board.pasteEvent, true); // outside ProseMirror, as a canvas being edited
    onBoard(board);
    setBoard(board);
    requestAnimationFrame(() => requestAnimationFrame(() => board.focus())); // after openWorkspace focused the workspace
    return () => {
      unsubscribe();
      window.removeEventListener('paste', board.pasteEvent, true);
      onBoard(null);
      board.destroy();
      board.dom.remove();
    };
  }, [id]);
  // The §6c rail floats at the board view's left edge (App.jsx Rail), so the view keeps a wider left padding for it.
  return (
    <div className="flex min-h-0 flex-1">
      <ShapePanel board={board} />
      <div ref={areaRef} id="flow-area" data-viewport className="min-h-0 min-w-0 flex-1 overflow-auto bg-(--pg-bg) [container-type:size] [scrollbar-gutter:stable]">
        <div className="w-max p-[calc(100cqh-var(--keep))_calc(100cqw-var(--keep))] [--keep:120px]">
          <div ref={wrapRef} className="[&>.wb]:shadow-[0_4px_24px_rgba(0,0,0,.55)]" />
        </div>
      </div>
    </div>
  );
}
