import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal,
  AlignStartVertical, AlignVerticalDistributeCenter, BringToFront, Copy, Eraser, FoldVertical, Frame, ImagePlus, Magnet, MousePointer2,
  MoveHorizontal, MoveVertical, PaintBucket, Pen, Redo2, SendToBack, Shapes, Spline, SquareX, Trash2, Type, Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Toggle } from '@/components/ui/toggle';
import { BG_OPTIONS, resolveBg } from '../../../whiteboard.js';
import { keyLabel, withKey } from '../../keybinds.js';
import { refocusEditor } from '../../actions.js';
import { can } from '../../gates.mjs';
import { useEditor, useStore } from '../../store.js';
import { Group as ToolGroup, SwatchMenu, textTools } from '../Toolbar.jsx';
import { Tip } from '../Tip.jsx';
import {
  CHROME, ConnectorControls, keepFocus, OptionSelect, PresetRow, refocus, ShapeControls, StrokeControls, useBoard, useSnapshot,
} from './controls.jsx';

const ACTIVE = 'size-8 data-[state=on]:bg-(--ui-accent) data-[state=on]:text-white hover:data-[state=on]:bg-(--ui-accent) hover:data-[state=on]:text-white';
const SNAP_RULES = [['items', 'Other items'], ['board', 'Board edges and centre'], ['grid', '10 px grid', 'board.grid']]; // the third: its keybind (§7k)
const CHECKER = 'repeating-conic-gradient(#8a8ca0 0 25%, #d0d0da 0 50%) 0 0 / 8px 8px';

/** How the rail's controls are laid out: `dir` 'col' (the vertical rail) or 'wrap' (the quick tools island, §7d: groups
 * wrap in rows); tooltips and popups open on `side` of their button, except that in the island the popovers open beside
 * the whole island (`anchor`, a ref to it) and the tool options at the pointer's x along it (`toolAnchor`). */
const VERTICAL = { dir: 'col', side: 'right', anchor: null, toolAnchor: null };
export const RailLayout = createContext(VERTICAL);

/** Placement props of a rail popup. */
function usePopup() {
  const { side, anchor } = useContext(RailLayout);
  return anchor ? { side: 'bottom', align: 'start' } : { side, align: 'start', sideOffset: 10 };
}

/** One fixed rail slot: an icon button, or a toggle when `active` is given. `slot` (PopoverAnchor / PopoverTrigger /
 * DropdownMenuTrigger) wraps the button for its flyout. */
function RailButton({ title, active, disabled, onClick, slot: Slot, children }) {
  const { side, anchor, toolAnchor } = useContext(RailLayout);
  const props = { 'aria-label': title, disabled };
  let button = active === undefined
    ? <Button variant="ghost" size="icon-sm" onClick={onClick} {...props}>{children}</Button>
    : <Toggle size="sm" className={ACTIVE} pressed={active} onPressedChange={() => onClick()} {...props}>{children}</Toggle>;
  // In the island a popover is anchored to the whole island instead of the button.
  const island = anchor && (Slot === PopoverAnchor || Slot === PopoverTrigger);
  if (Slot && !(island && Slot === PopoverAnchor)) button = <Slot asChild>{button}</Slot>;
  button = <Tip title={title} side={side} {...CHROME}>{button}</Tip>;
  return island ? <>{button}<PopoverAnchor virtualRef={Slot === PopoverAnchor ? toolAnchor ?? anchor : anchor} /></> : button;
}

/** Options of the active tool while the tool is on. Beside its rail button: stacked in a narrow column (selects full
 * width) so they cover little of the board. In the quick tools island: rows on top of the island (below it when there is
 * no room), the first row next to the island and so the pointer. Focus stays on the board. Persistent chrome: a board
 * click while only it is open still draws (`data-tool-flyout`, §6c Dismiss-only clicks). */
function ToolFlyout({ board, children }) {
  const island = !!useContext(RailLayout).anchor;
  const popup = usePopup();
  return (
    <PopoverContent {...CHROME} data-tool-flyout="" {...(island ? { side: 'top', align: 'start', sideOffset: 4 } : popup)}
      className={island
        ? 'flex w-max max-w-[25rem] flex-wrap items-center gap-1 p-1 data-[side=top]:flex-wrap-reverse'
        // left edge at the pointer (toolAnchor), so the first control, the line colour, is right above / below it
        : 'flex w-max min-w-40 flex-col gap-1 p-1 [&_[data-slot=select-trigger]]:w-full [&_[data-slot=select-trigger]]:min-w-0 [&_span:has(>[data-slot=select-trigger])]:min-w-0 [&_span:has(>[data-slot=select-trigger])]:flex-1'}
      onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}
      onEscapeKeyDown={() => board.setMode(null)}>
      {children}
    </PopoverContent>
  );
}

/** Separator between rail slots; in the island the groups carry them. */
function Sep() {
  const { dir } = useContext(RailLayout);
  if (dir === 'wrap') return null;
  return <Separator className="my-1 data-[orientation=horizontal]:w-6" />;
}

/** Rail slots after a separator (none before the `first`); in the island a toolbar group, kept together in a row. */
function Group({ first, children }) {
  const { dir } = useContext(RailLayout);
  if (dir === 'wrap') return <ToolGroup>{children}</ToolGroup>;
  return <>{!first && <Sep />}{children}</>;
}

/** Arrange (§6d): align, distribute and same size, each one Board call (the tool search has the same entries). */
export const ARRANGE = [
  [
    ['align-left', 'Align left', AlignStartVertical, (b) => b.align('left')],
    ['align-centre', 'Align centre', AlignCenterVertical, (b) => b.align('centre')],
    ['align-right', 'Align right', AlignEndVertical, (b) => b.align('right')],
    ['align-top', 'Align top', AlignStartHorizontal, (b) => b.align('top')],
    ['align-middle', 'Align middle', AlignCenterHorizontal, (b) => b.align('middle')],
    ['align-bottom', 'Align bottom', AlignEndHorizontal, (b) => b.align('bottom')],
  ],
  [
    ['distribute-h', 'Distribute horizontally', AlignHorizontalDistributeCenter, (b) => b.distribute('h')],
    ['distribute-v', 'Distribute vertically', AlignVerticalDistributeCenter, (b) => b.distribute('v')],
  ],
  [
    ['same-width', 'Same width', MoveHorizontal, (b) => b.sameSize('w')],
    ['same-height', 'Same height', MoveVertical, (b) => b.sameSize('h')],
  ],
];

/** Snapping: the master toggle and one checkbox per rule (`snap` = the snapshot's rules). Also the tool search's options. */
export function SnapControls({ board, snap }) {
  return (
    <div className="flex w-58 flex-col gap-2">
      <Label className="justify-between">
        <span>Snapping <span className="ml-1 text-xs font-normal text-muted-foreground">{keyLabel('board.snap')}</span></span>
        <Switch checked={snap.on} onCheckedChange={(on) => board.setSnap({ on })} />
      </Label>
      <Separator />
      {SNAP_RULES.map(([key, label, keys]) => (
        <Label key={key} className="font-normal">
          <Checkbox checked={snap[key]} disabled={!snap.on} onCheckedChange={(v) => board.setSnap({ [key]: v === true })} />
          {label}
          {keys && keyLabel(keys) && <span className="ml-auto text-xs text-muted-foreground">{keyLabel(keys)}</span>}
        </Label>
      ))}
    </div>
  );
}

/** The rail's Background choices as a select, for the tool search's options. */
export function BgSelect({ board, bg }) {
  const theme = document.documentElement.dataset.theme;
  return (
    <OptionSelect board={board} title="Background" className="w-36" value={bg} onChange={(v) => board.setBg(v)}
      options={BG_OPTIONS.map(([value, label]) => [value, label, resolveBg(value, theme) ?? CHECKER])} />
  );
}

/** Text mode Align slot (also in the quick tools island): the current alignment's icon; its flyout holds the toolbar's
 * four alignment controls. */
export function AlignMenu({ aligns }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <RailButton title="Align" slot={PopoverTrigger}>{(aligns.find((a) => a.active) ?? aligns[0]).children}</RailButton>
      <PopoverContent {...usePopup()} className="flex w-auto gap-0.5 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={refocusEditor}>
        {aligns.map((a) => <RailButton key={a.title} {...a} onClick={() => { setOpen(false); a.onClick(); }} />)}
      </PopoverContent>
    </Popover>
  );
}

/** Text mode (no active board): duplicates of toolbar controls, from the toolbar's own definitions. Nothing here takes
 * focus and the popups refocus the editor when they close, so the document keeps its selection. */
function TextRail() {
  const t = textTools(useEditor());
  return (
    <>
      <RailButton {...t.undo} />
      <RailButton {...t.redo} />
      <RailButton {...t.image} />
      <RailButton {...t.canvas} />
      <Sep />
      <RailButton {...t.bold} />
      <RailButton {...t.italic} />
      <RailButton {...t.underline} />
      <RailButton {...t.strike} />
      <Sep />
      <SwatchMenu {...t.color} side="right" />
      <SwatchMenu {...t.highlight} side="right" />
      <Sep />
      <AlignMenu aligns={[t.alignLeft, t.alignCenter, t.alignRight, t.justify]} />
      <RailButton {...t.bulletList} />
      <RailButton {...t.orderedList} />
      <Sep />
      <RailButton {...t.link} />
      <RailButton {...t.clear} />
      <Sep />
      <RailButton {...t.whiteboard} />
    </>
  );
}

/** Board mode: the anchored slots acting on `board`, then its tools. In the quick tools island the mode tools come first
 * (nearest the pointer) and Undo, Redo, Add image and Snapping are left out (keys, paste / drop cover them). */
export function BoardTools({ board }) {
  const snap = useSnapshot(board);
  const popup = usePopup();
  const [open, setOpen] = useState(null); // 'snap' | 'bg' | 'arrange' | null
  const { mode, count } = snap; // count: selected items; the item actions act on all of them
  const act = (fn) => () => {
    fn();
    board.focus(); // the 6c shortcuts keep working right after a click here
  };
  const tool = (m) => act(() => board.setMode(mode === m ? null : m));
  const flyout = (key) => ({ open: open === key, onOpenChange: (o) => setOpen(o ? key : null) });
  const strokes = <StrokeControls board={board} value={snap.pen} set={(p) => board.setPen(p)} live />;
  const theme = document.documentElement.dataset.theme;
  // A tool's options show once: under the quick tools island while it is open for this board, else beside the rail.
  const inIsland = !!useContext(RailLayout).anchor;
  const quickHere = useStore((s) => s.quickTools?.board === board);
  const showTool = (m) => mode === m && (inIsland || !quickHere);

  // Text, canvas and image are placement tools: a click on the board places the item there (§6c). Canvases do not nest.
  const addCanvas = <RailButton title={withKey('Add canvas', 'board.canvas')} disabled={snap.kind !== 'whiteboard'} active={mode === 'canvas'} onClick={tool('canvas')}><Frame /></RailButton>;
  const background = (
    <DropdownMenu {...flyout('bg')}>
      <RailButton title="Background" slot={DropdownMenuTrigger}><PaintBucket /></RailButton>
      <DropdownMenuContent {...CHROME} {...popup} className="w-44" onCloseAutoFocus={refocus(board)}>
        <DropdownMenuLabel>Background</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={snap.bg} onValueChange={(bg) => board.setBg(bg)}>
          {BG_OPTIONS.map(([value, label]) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <span className="size-4 rounded-sm border" style={{ background: resolveBg(value, theme) ?? CHECKER }} />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {!inIsland && (
        <Group first>
          <RailButton title={withKey('Undo', 'edit.undo')} disabled={!snap.canUndo} onClick={act(() => board.undo())}><Undo2 /></RailButton>
          <RailButton title={withKey('Redo', 'edit.redo')} disabled={!snap.canRedo} onClick={act(() => board.redo())}><Redo2 /></RailButton>
          <RailButton title={withKey('Add image', 'board.image')} active={mode === 'image'} onClick={act(() => (mode === 'image' ? board.setMode(null) : board.pickImages()))}><ImagePlus /></RailButton>
          {addCanvas}
        </Group>
      )}
      <Group first={inIsland}>
        <RailButton title={withKey('Select', 'board.select')} active={!mode} onClick={act(() => mode && board.setMode(null))}><MousePointer2 /></RailButton>
        <RailButton title={withKey('Add text', 'board.text')} active={mode === 'text'} onClick={tool('text')}><Type /></RailButton>
        <Popover open={showTool('pen')}>
          <RailButton title={withKey('Pen', 'board.pen')} active={mode === 'pen'} onClick={tool('pen')} slot={PopoverAnchor}><Pen /></RailButton>
          <ToolFlyout board={board}>{strokes}</ToolFlyout>
        </Popover>
        {/* The eraser removes whole strokes it crosses: it has no settings, so no options flyout. */}
        <RailButton title={withKey('Eraser', 'board.eraser')} active={mode === 'eraser'} onClick={tool('eraser')}><Eraser /></RailButton>
        <Popover open={showTool('shape')}>
          <RailButton title={withKey('Shape', 'board.shape')} active={mode === 'shape'} onClick={tool('shape')} slot={PopoverAnchor}><Shapes /></RailButton>
          <ToolFlyout board={board}>
            <ShapeControls board={board} value={snap.shape} set={(p) => board.setShapeTool(p)} live strokeFirst={inIsland} />
            <PresetRow set={(p) => board.setShapeTool(p)} />
          </ToolFlyout>
        </Popover>
        <Popover open={showTool('connector')}>
          <RailButton title={withKey('Connector', 'board.connector')} active={mode === 'connector'} onClick={tool('connector')} slot={PopoverAnchor}><Spline /></RailButton>
          <ToolFlyout board={board}>
            <ConnectorControls board={board} value={snap.conn} set={(p) => board.setConnTool(p)} live strokeFirst={inIsland} />
            <PresetRow set={(p) => board.setConnTool(p)} connector />
          </ToolFlyout>
        </Popover>
      </Group>
      <Group>
        <RailButton title={withKey('Duplicate', 'board.duplicate')} disabled={!count} onClick={act(() => board.duplicate())}><Copy /></RailButton>
        <RailButton title={withKey('Bring to front', 'board.front')} disabled={!count} onClick={act(() => board.arrange('front'))}><BringToFront /></RailButton>
        <RailButton title={withKey('Send to back', 'board.back')} disabled={!count} onClick={act(() => board.arrange('back'))}><SendToBack /></RailButton>
        <DropdownMenu {...flyout('arrange')}>
          <RailButton title="Arrange (two or more items)" disabled={!can('board.selectionMany', snap)} slot={DropdownMenuTrigger}><AlignStartVertical /></RailButton>
          <DropdownMenuContent {...CHROME} {...popup} className="w-52" onCloseAutoFocus={refocus(board)}>
            {ARRANGE.flatMap((group, k) => [
              ...(k ? [<DropdownMenuSeparator key={k} />] : []),
              ...group.map(([id, label, Icon, run]) => <DropdownMenuItem key={id} onSelect={() => run(board)}><Icon />{label}</DropdownMenuItem>),
            ])}
          </DropdownMenuContent>
        </DropdownMenu>
        <RailButton title={withKey('Delete', 'board.delete')} disabled={!count} onClick={act(() => board.removeItem())}><Trash2 /></RailButton>
      </Group>
      {inIsland ? (
        <Group>{addCanvas}{background}</Group>
      ) : (
        <Group>
          <Popover {...flyout('snap')}>
            <RailButton title={withKey('Snapping', 'board.snap')} slot={PopoverTrigger}><Magnet /></RailButton>
            <PopoverContent {...CHROME} {...popup} className="w-auto p-3" onCloseAutoFocus={refocus(board)}>
              <SnapControls board={board} snap={snap.snap} />
            </PopoverContent>
          </Popover>
          <Sep />
          {background}
        </Group>
      )}
      <Group>
        <RailButton title="Fit height" disabled={snap.kind !== 'whiteboard'} onClick={act(() => board.fitHeight())}><FoldVertical /></RailButton>
        <RailButton title="Delete board" disabled={snap.kind !== 'whiteboard'} onClick={act(() => board.deleteBoard())}><SquareX /></RailButton>
      </Group>
    </>
  );
}

// Tallest rail seen (px). The rail's top is placed as if a rail of this height were centred, so the anchored zone at the
// top never moves when the mode changes; only the bottom edge does. Kept across sessions so it is stable from the start.
const RAIL_KEY = 'daf-writer.railHeight';
let tallest = 0;
try {
  tallest = Number(localStorage.getItem(RAIL_KEY)) || 0;
} catch {}

/** §6c tool rail ("island") with its flyouts, at the left edge of the closest positioned ancestor (the editor area),
 * around its vertical centre; it scrolls (wheel, no scrollbar) when that ancestor is shorter than the rail. Serves the
 * active board of the document (also a canvas being edited); with none it is in text mode. It is always shown, and the
 * anchored zone (Undo, Redo, Add image, Add canvas) has the same slots in both modes. Its height follows the mode's
 * slots with a quick transition. `className` can cap its height further (App: room for the sidebar button below it). */
export function BoardRail({ className }) {
  const board = useBoard();
  const inner = useRef(null);
  const [size, setSize] = useState(null); // px along the rail, border included
  const [cap, setCap] = useState('100% - 1rem'); // its max-height (`className` may lower it)
  useLayoutEffect(() => {
    const el = inner.current;
    const max = getComputedStyle(el.parentElement).maxHeight;
    if (max !== 'none') setCap(max);
    const measure = () => {
      const s = el.offsetHeight + 2; // + the 1 px border on both ends
      setSize(s);
      if (s > tallest) {
        tallest = s;
        try {
          localStorage.setItem(RAIL_KEY, String(s));
        } catch {}
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Centred as the tallest rail, but never so low that the tallest would end below its cap's end (0.5rem + cap: in a short
  // area the buttons App keeps below it would cover the last slots).
  const x = Math.max(tallest, size ?? 0);
  const style = { top: `max(0.5rem, min(calc(50% - ${x / 2}px), calc(0.5rem + ${cap} - ${x}px)))`, height: size ?? undefined };
  return (
    <RailLayout.Provider value={VERTICAL}>
      <div {...CHROME} role="toolbar" aria-label={board ? 'Board tools' : 'Text tools'} aria-orientation="vertical"
        onMouseDown={keepFocus} style={style}
        className={cn('absolute left-2 z-30 max-h-[calc(100%-1rem)] overflow-y-auto rounded-island border bg-card shadow-lg transition-[height] duration-150 ease-out [scrollbar-width:none]', className)}>
        <div ref={inner} className="flex flex-col items-center gap-0.5 p-1">
          {board ? <BoardTools board={board} /> : <TextRail />}
        </div>
      </div>
    </RailLayout.Provider>
  );
}
