import { useLayoutEffect, useRef } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowLeftRight, Bold, Captions, Crop, Palette, RouteOff, Scaling, SquarePen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { NOTE_COLORS, TEXT_SIZES } from '../../../whiteboard.js';
import { Tip } from '../Tip.jsx';
import {
  CHROME, ColorSwatch, ConnectorControls, FillSelect, keepFocus, LabelControls, LabelsPanel, OptionSelect, PopoverButton, PresetRow, RotateControls,
  ShapePicker, StrokeControls, useBoard, useSnapshot, withValue,
} from './controls.jsx';
import { placeRibbon } from './place.mjs';

const ALIGNS = [['left', 'Align left', AlignLeft], ['center', 'Align centre', AlignCenter], ['right', 'Align right', AlignRight]];
const FIRST = 17; // px from the ribbon's left edge to the centre of its first control (border, p-1, half a size-8)
const HANDLES = ':scope > .wb-sel > :is(.wb-handle, .wb-rot, .wb-qc, .wb-end, .wb-mid, .wb-wp)';
const grow = (r, d) => ({ left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d });

/** The selection's chrome on `board` as drawn (client px): [its box, the handle rects]. The box spans the selected items'
 * outlines (3 px beyond their elements), the group box's (6 px beyond) and the handles, rotate handle and quick-connect
 * dots (children of the item's element: they turn with a turned shape). */
function chrome(board) {
  const handles = [...board.layer.querySelectorAll(HANDLES)].map((h) => h.getBoundingClientRect());
  const rects = [...board.layer.querySelectorAll(':scope > .wb-sel')].map((el) => grow(el.getBoundingClientRect(), 3));
  if (!board.groupEl.hidden) rects.push(grow(board.groupEl.getBoundingClientRect(), 6));
  rects.push(...handles);
  const box = { left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) };
  return [box, handles];
}

/** §6c item ribbon: the selected item's properties in a translucent bar of wrapping rows, fixed-positioned so it keeps its
 * size at any page zoom. Above the selection's chrome (outline, handles, rotate handle, quick-connect dots), below it when
 * there is no room, else beside it, never over a handle, inside the visible area (placeRibbon), the first row nearest the
 * selection. After a pointer selection (a click, a selection rectangle, a spawn) its first control is at the pointer's x;
 * after a keyboard selection its left edge at the item's. Hidden while the pointer is pressed on the board (a drag).
 * Serves the active board of the document. */
export function ItemRibbon() {
  const board = useBoard();
  const snap = useSnapshot(board);
  const group = snap?.item ? null : snap?.group; // several selected: their common controls (whiteboard.js groupProps)
  const item = snap?.item ?? group?.item;
  const ref = useRef(null);
  const shown = !!item;

  // Follows the item every frame while shown: drags, typing, scrolling, page zoom and window resizes all move it.
  useLayoutEffect(() => {
    if (!shown) return undefined;
    let frame;
    const place = () => {
      const el = ref.current;
      const r = board.itemRect();
      if (el && r) {
        const v = board.viewRect();
        const view = { left: Math.max(v.left, 0), top: Math.max(v.top, 0), right: Math.min(v.right, innerWidth), bottom: Math.min(v.bottom, innerHeight) };
        const [box, handles] = chrome(board);
        const bars = [...document.querySelectorAll('[data-ribbon-avoid]')].map((b) => b.getBoundingClientRect()); // the canvas edit bar
        const size = { w: el.offsetWidth, h: el.offsetHeight };
        const a = board.ribbonAnchor();
        const p = placeRibbon(box, size, view, [...handles, ...bars], a ? { x: a.x - FIRST, y: a.y } : { x: r.left });
        el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
        el.style.flexWrap = p.y < (a ? Math.min(Math.max(a.y, box.top), box.bottom) : box.top) ? 'wrap-reverse' : 'wrap'; // the first row nearest the selection / pointer
        // Hidden during a press or drag on the board and while the item is scrolled out of view.
        const seen = r.right > view.left && r.left < view.right && r.bottom > view.top && r.top < view.bottom;
        el.style.visibility = seen && !board.gesture ? '' : 'hidden';
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [board, shown]);

  if (!item) return null;
  return (
    <div ref={ref} {...CHROME} role="toolbar" aria-label="Item properties" onMouseDown={keepFocus}
      className="fixed top-0 left-0 z-40 flex max-w-[24rem] flex-wrap items-center gap-1 rounded-island border bg-card/70 p-1 text-sm shadow-xl backdrop-blur-[2px]">
      <ItemControls board={board} item={item} group={group?.type} mixed={group?.mixed} />
    </div>
  );
}

/** The properties of the selected `item` (the snapshot's) of `board`, most used first (the main colour first): the ribbon's
 * controls, also the quick tools' item row and the tool search's options. `group` (several items selected, whiteboard.js
 * groupProps): their type, or 'lines' for shapes, connectors and pen strokes together; `item` is then the first one's and a
 * change goes to each (board.setItem → setItems). Controls that act on one item (rotate, labels of an arrow, reverse,
 * straighten) are left out then; 'lines' shows colour, width and line style. */
export function ItemControls({ board, item, group, mixed = [] }) {
  const set = (patch) => {
    board.setItem(patch);
    board.focus(); // mid-edit setItem already put the caret back; otherwise the board's shortcuts keep working
  };
  const one = !group;
  let controls;
  if (group === 'lines') {
    controls = <StrokeControls board={board} value={item} set={set} />;
  } else if (item.type === 'text') {
    controls = (
      <>
        <ColorSwatch board={board} title="Text colour" value={item.color} onChange={(color) => set({ color })} />
        <OptionSelect board={board} title="Text size" className="w-22" value={item.size}
          options={withValue(TEXT_SIZES, item.size).map((s) => [s, `${s} px`])} onChange={(v) => set({ size: Number(v) })} />
        <Tip title="Bold" {...CHROME}>
          <Toggle size="sm" aria-label="Bold" pressed={!!item.bold} onPressedChange={() => set({ bold: !item.bold })}><Bold /></Toggle>
        </Tip>
        <ToggleGroup type="single" size="sm" value={item.align} onValueChange={(align) => align && set({ align })}>
          {ALIGNS.map(([value, title, Icon]) => (
            <Tip key={value} title={title} {...CHROME}>
              <ToggleGroupItem value={value} aria-label={title} className="px-1.5"><Icon /></ToggleGroupItem>
            </Tip>
          ))}
        </ToggleGroup>
        <OptionSelect board={board} title="Note colour" className="w-36" value={item.bg || 'none'}
          options={NOTE_COLORS.map(([v, label]) => [v || 'none', label, v])} onChange={(v) => set({ bg: v === 'none' ? null : v })} />
      </>
    );
  } else if (item.type === 'stroke') {
    controls = <StrokeControls board={board} value={item} set={set} />;
  } else if (item.type === 'shape') {
    controls = (
      <>
        <ColorSwatch board={board} title="Fill colour" value={item.fillColor} onChange={(fillColor) => set({ fillColor })} />
        <StrokeControls board={board} value={item} set={set} />
        <FillSelect board={board} value={item} set={set} />
        <PopoverButton board={board} title="Label (double-click, Enter, F2 to edit)" icon={<Captions />}>
          <LabelControls board={board} value={item} set={set} align />
        </PopoverButton>
        {!mixed.includes('shape') && <ShapePicker board={board} value={item.shape} onChange={(shape) => set({ shape })} />}
        <PopoverButton board={board} title="Style presets" icon={<Palette />}><PresetRow set={set} /></PopoverButton>
        {one && <RotateControls board={board} value={item.rot ?? 0} />}
      </>
    );
  } else if (item.type === 'connector') {
    const act = (fn) => () => {
      fn();
      board.focus();
    };
    controls = (
      <>
        <ConnectorControls board={board} value={item} set={set} strokeFirst headsFirst />
        {one && (
          <PopoverButton board={board} title="Labels (double-click the line, Enter, F2)" icon={<Captions />}>
            <LabelsPanel board={board} item={item} />
          </PopoverButton>
        )}
        <PopoverButton board={board} title="Style presets" icon={<Palette />}><PresetRow set={set} connector /></PopoverButton>
        {one && (
          <>
            <Tip title="Reverse" {...CHROME}>
              <Button variant="ghost" size="icon-sm" aria-label="Reverse" onClick={act(() => board.reverseConnector())}><ArrowLeftRight /></Button>
            </Tip>
            <Tip title="Straighten (remove the bends)" {...CHROME}>
              <Button variant="ghost" size="icon-sm" aria-label="Straighten" disabled={!item.points?.length} onClick={act(() => board.straighten())}><RouteOff /></Button>
            </Tip>
          </>
        )}
      </>
    );
  } else if (item.type === 'canvas') {
    // Edit hands focus to the canvas being edited, so no board.focus() after it.
    controls = (
      <>
        <Tip title="Edit the canvas (double-click, Enter)" {...CHROME}>
          <Button variant="ghost" size="sm" onClick={() => board.editCanvas()}><SquarePen />Edit</Button>
        </Tip>
        <Tip title="Artboard size, capped to the board" {...CHROME}>
          <Button variant="ghost" size="sm" onClick={() => { board.resetSize(); board.focus(); }}><Scaling />Reset size</Button>
        </Tip>
      </>
    );
  } else {
    controls = (
      <>
        <Tip title="Natural size of the visible part, capped to the board" {...CHROME}>
          <Button variant="ghost" size="sm" onClick={() => { board.resetSize(); board.focus(); }}><Scaling />Reset size</Button>
        </Tip>
        <Tip title="Show the whole image again" {...CHROME}>
          <Button variant="ghost" size="sm" disabled={!item.cropped} onClick={() => { board.resetCrop(); board.focus(); }}><Crop />Reset crop</Button>
        </Tip>
      </>
    );
  }
  return controls;
}
