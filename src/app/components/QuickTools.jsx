import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { TITLEBAR } from '@/components/ui/bounds';
import { canvasEditor } from '../../canvas.js';
import { activeBoard } from '../../whiteboard.js';
import { closeQuickTools } from '../actions.js';
import { motion } from '../motion.js';
import { useWordCtx } from '../../tooling/registry.js';
import { getState, useStore } from '../store.js';
import { AlignMenu, BoardTools, RailLayout } from './board/BoardRail.jsx';
import { CHROME, keepFocus } from './board/controls.jsx';
import { MiniBar } from '../../document/wp/context-menu/MiniToolbar.jsx';
import {
  BlockSelect, Group, GroupRows, PresetsMenu, SelectRow, SizeBox, TableTools, TextColors, textTools, Toggles, ToolButton, useBox,
} from './Toolbar.jsx';

// §7d quick tools (Ctrl+Tab): the bottom toolbar island and the §6c rail merged into one island at the pointer, built
// from their own controls. It never takes the focus. Escape, a pointer-down outside it, Ctrl+Tab again and the end of
// the mode it was opened for close it; after a board tool pick, so does the pointer leaving it.

const GAP = 6; // px between the pointer and the island
const SWATCH_MID = 17; // px from a tool options card's left edge to the centre of its first control (p-1 + half a size-8)

/** Text mode: the toolbar's controls and the rail's Align, each once, without the font select, Undo, Redo and Add image
 * (keys and paste / drop cover them). */
function TextTools({ anchor }) {
  useWordCtx(); // the controls follow the editor's transactions
  const T = textTools();
  const box = useBox();
  return (
    <GroupRows>
      <Group>
        <SelectRow>
          <BlockSelect T={T} />
          <SizeBox T={T} />
        </SelectRow>
      </Group>
      <Group>
        <Toggles label="Text formatting" items={[T.bold, T.italic, T.underline, T.strike, T.sub, T.sup, T.code]} />
      </Group>
      <Group>
        <TextColors T={T} anchor={anchor} />
      </Group>
      <Group>
        <AlignMenu aligns={[T.alignLeft, T.alignCenter, T.alignRight, T.justify]} />
        <Toggles label="Lists" items={[T.bulletList, T.orderedList]} />
      </Group>
      <Group>
        <Toggles label="Blocks" items={[T.quote, T.codeBlock]} />
        <ToolButton {...T.rule} />
      </Group>
      <Group>
        <ToolButton {...T.cite} />
        <ToolButton {...T.references} />
      </Group>
      <Group>
        <TableTools T={T} />
        {box && <ToolButton {...T.box} />}
        <ToolButton {...T.link} />
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

/** Board mode: the rail's board tools and the basic shapes, one fixed layout. Opening it never changes the board: the
 * selection, the ribbon and a text edit stay (§7d). */
function BoardQuickTools({ board }) {
  return <GroupRows><BoardTools board={board} /></GroupRows>;
}

function Island({ open }) {
  const ref = useRef(null);
  const inside = useRef(false); // the current pointer-down is in the island or in a popup of its controls
  const pointerX = useRef(open.x); // anchors the tool options
  const picked = useRef(false); // a board tool was picked in it: from then on the pointer leaving it hides it
  const [hiding, setHiding] = useState(false); // fading out (app.css [data-hiding]), closed at the end unless the pointer comes back
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
  const isDocument = useStore((s) => s.draft?.format === 'document'); // the mini toolbar's rows (registry commands)
  const session = useSyncExternalStore(canvasEditor.subscribe, canvasEditor.get);
  const board = session?.board ?? active; // what Ctrl+Tab would open it for now

  useEffect(() => {
    if (board !== open.board) closeQuickTools(); // its mode ended
  }, [board, open.board]);

  useEffect(() => {
    if (!hiding) return undefined;
    const t = setTimeout(closeQuickTools, motion('hide')); // 0 when the hide animation does not play
    return () => clearTimeout(t);
  }, [hiding]);

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
      <div ref={ref} {...CHROME} data-quick-tools="" role="toolbar" aria-label="Quick access menu" onMouseDown={keepFocus}
        onPointerDownCapture={(e) => {
          inside.current = true;
          if (ref.current.contains(e.target)) pointerX.current = e.clientX; // not in its popups (they portal)
        }}
        onClickCapture={(e) => { if (e.target.closest('[data-board-tool]')) picked.current = true; }}
        // React's enter and leave follow its own tree, so its popups (the tool options card, a select's list, a colour menu)
        // count as inside although they portal. Crossing the gap to the card starts the fade, and entering the card ends it.
        onPointerLeave={() => picked.current && setHiding(true)} onPointerEnter={() => setHiding(false)} data-hiding={hiding ? '' : undefined}
        // Drawn at the pointer from the first frame (the layout effect only corrects it at the window edges) and only fades in:
        // no scale or slide, so it never seems to fly in. The length is the fade's only: a duration-* class would also time a
        // transition of every property, sliding the island when the layout effect corrects its left.
        style={{ left: `calc(${open.x}px - 10rem)`, top: open.y + GAP }} data-mini-quick={isDocument && !open.board ? '' : undefined}
        // Board mode hugs its widest group (min-content: wrapped groups count one at a time, where max-content is one long row),
        // so the 7-button rows have the same gap on both sides and the actions and Background share the last row.
        className={cn('fixed z-50 rounded-island', open.board ? 'w-min' : isDocument ? 'w-auto' : 'w-[20rem]', 'border bg-island px-1.5 py-1 text-sm shadow-xl animate-in fade-in-0 [animation-duration:var(--motion-menus)]')}>
        {open.board ? <BoardQuickTools board={open.board} /> : isDocument ? <MiniBar /> : <TextTools anchor={ref} />}
      </div>
    </RailLayout.Provider>
  );
}

/** The quick tools island (one, mounted in App; popups and dialogs portal above it). */
export function QuickTools() {
  const open = useStore((s) => s.quickTools);
  return open ? <Island open={open} /> : null;
}
