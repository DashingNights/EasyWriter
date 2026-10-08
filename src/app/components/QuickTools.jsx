import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { TITLEBAR } from '@/components/ui/bounds';
import { canvasEditor } from '../../canvas.js';
import { activeBoard } from '../../whiteboard.js';
import { closeQuickTools } from '../actions.js';
import { getState, useEditor, useStore } from '../store.js';
import { AlignMenu, BoardTools, RailLayout } from './board/BoardRail.jsx';
import { CHROME, keepFocus, useSnapshot } from './board/controls.jsx';
import { ItemControls } from './board/ItemRibbon.jsx';
import { BlockSelect, Group, GroupRows, PresetsMenu, SizeSelect, SwatchMenu, TableTools, textTools, ToolButton } from './Toolbar.jsx';

// §7d quick tools (Ctrl+Tab): the bottom toolbar island and the §6c rail merged into one island at the pointer, built
// from their own controls. It never takes the focus. Escape, a pointer-down outside it, Ctrl+Tab again and the end of
// the mode it was opened for close it.

const GAP = 6; // px between the pointer and the island
const SWATCH_MID = 17; // px from a tool options card's left edge to the centre of its first control (p-1 + half a size-8)

/** Text mode: the toolbar's controls and the rail's Align, each once, without the font select, Undo, Redo and Add image
 * (keys and paste / drop cover them). */
function TextTools({ anchor }) {
  const ed = useEditor();
  const T = textTools(ed);
  return (
    <GroupRows>
      <Group>
        <BlockSelect T={T} />
        <SizeSelect T={T} />
      </Group>
      <Group>
        <ToolButton {...T.bold} />
        <ToolButton {...T.italic} />
        <ToolButton {...T.underline} />
        <ToolButton {...T.strike} />
        <ToolButton {...T.sub} />
        <ToolButton {...T.sup} />
        <ToolButton {...T.code} />
      </Group>
      <Group>
        <SwatchMenu {...T.color} anchor={anchor} />
        <SwatchMenu {...T.highlight} anchor={anchor} />
      </Group>
      <Group>
        <AlignMenu aligns={[T.alignLeft, T.alignCenter, T.alignRight, T.justify]} />
        <ToolButton {...T.bulletList} />
        <ToolButton {...T.orderedList} />
      </Group>
      <Group>
        <ToolButton {...T.quote} />
        <ToolButton {...T.codeBlock} />
        <ToolButton {...T.rule} />
      </Group>
      <Group>
        <TableTools T={T} ed={ed} />
        <ToolButton {...T.box} />
        <ToolButton {...T.link} />
        <ToolButton {...T.whiteboard} />
        <ToolButton {...T.canvas} />
        <ToolButton {...T.flowchart} />
        <ToolButton {...T.planChart} />
      </Group>
      <Group>
        <PresetsMenu />
        <ToolButton {...T.clear} />
      </Group>
    </GroupRows>
  );
}

/** Board mode: the rail's board tools, then the selected item's ribbon controls in a last row. */
function BoardQuickTools({ board }) {
  const item = useSnapshot(board)?.item;
  return (
    <>
      <GroupRows><BoardTools board={board} /></GroupRows>
      {item && (
        <div className="mt-1 flex flex-wrap items-center gap-1 border-t pt-1">
          <ItemControls board={board} item={item} />
        </div>
      )}
    </>
  );
}

function Island({ open }) {
  const ref = useRef(null);
  const inside = useRef(false); // the current pointer-down is in the island or in a popup of its controls
  const pointerX = useRef(open.x); // anchors the tool options
  // Tool options: a zero-width anchor along the island's top / bottom edge at the pointer's x: where the island was
  // summoned, then where the last click in it was (e.g. on a tool button); kept within the island.
  const [layout] = useState(() => ({
    dir: 'wrap',
    side: 'top',
    anchor: ref,
    toolAnchor: {
      current: {
        getBoundingClientRect() {
          const r = ref.current.getBoundingClientRect();
          return new DOMRect(Math.max(r.left, Math.min(pointerX.current - SWATCH_MID, r.right)), r.top, 0, r.height);
        },
      },
    },
  }));
  const active = useSyncExternalStore(activeBoard.subscribe, activeBoard.get);
  const session = useSyncExternalStore(canvasEditor.subscribe, canvasEditor.get);
  const board = session?.board ?? active; // what Ctrl+Tab would open it for now

  useEffect(() => {
    if (board !== open.board) closeQuickTools(); // its mode ended
  }, [board, open.board]);

  // Window capture: before the boards, canvas edit mode and Radix popups (an open select or flyout closes with it). A
  // pointer-down outside still does its job, except on a board, which it only closes (§6c Dismiss-only clicks); React's
  // capture handler below marks one inside (popups portal, but their events pass through the island in the React tree), so
  // the check waits until the event is dispatched.
  useEffect(() => {
    const onKey = (e) => {
      const s = getState();
      if (e.key !== 'Escape' || s.dialog || s.confirm || s.toolSearch || s.toolOptions) return;
      e.preventDefault();
      e.stopPropagation();
      closeQuickTools();
    };
    const onDown = () => {
      inside.current = false;
      setTimeout(() => !inside.current && closeQuickTools());
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, []);

  // Centred under the pointer, GAP below it (above it when there is no room below), inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    const place = () => {
      const [w, h] = [el.offsetWidth, el.offsetHeight];
      el.style.left = `${Math.max(0, Math.min(open.x - w / 2, innerWidth - w))}px`;
      el.style.top = `${Math.max(TITLEBAR, Math.min(open.y + GAP + h <= innerHeight ? open.y + GAP : open.y - GAP - h, innerHeight - h))}px`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  return (
    <RailLayout.Provider value={layout}>
      <div ref={ref} {...CHROME} data-quick-tools="" role="toolbar" aria-label="Quick tools" onMouseDown={keepFocus}
        onPointerDownCapture={(e) => {
          inside.current = true;
          if (ref.current.contains(e.target)) pointerX.current = e.clientX; // not in its popups (they portal)
        }}
        // Drawn at the pointer from the first frame (the layout effect only corrects it at the window edges) and only fades in:
        // no scale or slide, so it never seems to fly in.
        style={{ left: `calc(${open.x}px - 10rem)`, top: open.y + GAP }}
        className="fixed z-50 w-[20rem] rounded-island border bg-card/70 backdrop-blur-[2px] px-1.5 py-1 text-sm shadow-xl animate-in fade-in-0 duration-100">
        {open.board ? <BoardQuickTools board={open.board} /> : <TextTools anchor={ref} />}
      </div>
    </RailLayout.Provider>
  );
}

/** The quick tools island (one, mounted in App; popups and dialogs portal above it). */
export function QuickTools() {
  const open = useStore((s) => s.quickTools);
  return open ? <Island open={open} /> : null;
}
