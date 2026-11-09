import { useLayoutEffect, useRef } from 'react';
import { ArrowLeftRight, Baseline, Captions, Crop, MoveHorizontal, PaintBucket, Palette, RouteOff, Scaling, UnfoldVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { turns } from '../../../flow/shapes.mjs';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { run } from '../../../tooling/registry.js';
import { fillable, TEXT_BACKGROUNDS } from '../../../whiteboard.js';
import { IconButton, Tip } from '../Tip.jsx';
import {
  ALIGNS, BOLD, BoardColor, BoardFont, CHROME, ConnectorControls, FillSelect, keepFocus, LabelControls, LabelsPanel, PopoverButton, PresetRow, refocus,
  RotateControls, ShapePicker, SizeSelect, StrokeControls, Toggles, useBoard, useSnapshot,
} from './controls.jsx';
import { placeRibbon } from './place.mjs';

const FIRST = 17; // px from the ribbon's left edge to the centre of its first control (border, p-1, half a size-8)
const HANDLES = ':scope > .wb-sel > :is(.wb-handle, .wb-rot, .wb-tip, .wb-qc, .wb-end, .wb-mid, .wb-wp)';
const grow = (r, d) => ({ left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d });

/** The selection's chrome on `board` as drawn (client px): [its box, the handle rects]. The box spans the selected items'
 * outlines (3 px beyond their elements), the group box's (1 px beyond) and the handles, rotate handle and quick-connect
 * dots (children of the item's element: they turn with a turned shape). */
function chrome(board) {
  const group = board.groupEl.hidden ? [] : [...board.groupEl.children]; // its resize handles and rotate zones
  const handles = [...board.layer.querySelectorAll(HANDLES), ...group].map((h) => h.getBoundingClientRect());
  const rects = [...board.layer.querySelectorAll(':scope > .wb-sel')].map((el) => grow(el.getBoundingClientRect(), 3));
  if (!board.groupEl.hidden) rects.push(grow(board.groupEl.getBoundingClientRect(), 1));
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
      className="fixed top-0 left-0 z-40 flex max-w-[24rem] flex-wrap items-center gap-1 rounded-island border bg-island p-1 text-sm shadow-xl">
      <ItemControls board={board} item={item} group={group?.type} mixed={group?.mixed} />
    </div>
  );
}

/** A text item's background colour (field `bg`; null: none): the flat presets (TEXT_BACKGROUNDS), the board's recent colours, a
 * typed hex, the eyedropper and More Colors, whose picker gives any colour with transparency. The ribbon, the Text tool's options
 * and the tool search show it. */
export function TextBackground({ board, value, onChange }) {
  return (
    <ColorPick format="board" standard={TEXT_BACKGROUNDS} theme={null} automatic="None" eyedropper alpha value={value || null} icon={<PaintBucket />}
      label="Background colour" contentProps={{ ...CHROME, onOpenAutoFocus: (e) => e.preventDefault(), onCloseAutoFocus: refocus(board) }}
      onChange={(bg) => onChange(bg)} />
  );
}

/** The properties of the selected `item` (the snapshot's) of `board`, most used first (the main colour first): the ribbon's
 * controls, also the tool search's options. `group` (several items selected, whiteboard.js groupProps): their type, or
 * 'lines' for shapes, connectors and pen strokes together; `item` is then the first one's and a change goes to each
 * (board.setItem → setItems); `mixed` names the fields they differ in. Controls that act on one item (rotate, labels of an
 * arrow, reverse, straighten) are left out then; 'lines' shows colour, width and opacity. Every item with a line or a fill has
 * its opacity (0 to 100 %) beside its colours. The kit draws the colours, font, sizes and toggles; the item actions are the
 * board's pool commands (pool-board.js). */
export function ItemControls({ board, item, group, mixed = [] }) {
  const set = (patch) => {
    board.setItem(patch);
    board.focus(); // mid-edit setItem already put the caret back; otherwise the board's shortcuts keep working
  };
  const one = !group;
  let controls;
  if (group === 'lines') {
    controls = <StrokeControls board={board} value={item} set={set} opacity />;
  } else if (item.type === 'text') {
    controls = (
      <>
        <BoardColor board={board} title="Text colour" icon={<Baseline />} value={item.color} byTheme onChange={(color) => set({ color })} />
        <BoardFont board={board} value={item.font} mixed={mixed.includes('font')} onChange={(font) => set({ font })} />
        <SizeSelect board={board} title="Text size" className="w-22" value={item.size} onChange={(size) => set({ size })} />
        <Toggles label="Bold" items={BOLD} value={!!item.bold} onChange={() => set({ bold: !item.bold })} />
        <Toggles label="Alignment" items={ALIGNS} value={item.align} onChange={(align) => set({ align })} />
        <IconButton size="regular" label="Fit the width to the text" pressed={!!item.fit} tip={CHROME} onClick={() => set({ fit: !item.fit })}>
          <MoveHorizontal />
        </IconButton>
        <TextBackground board={board} value={item.bg} onChange={(bg) => set({ bg })} />
      </>
    );
  } else if (item.type === 'stroke') {
    controls = <StrokeControls board={board} value={item} set={set} opacity />;
  } else if (item.type === 'shape') {
    controls = (
      <>
        {fillable(item.shape) && <BoardColor board={board} title="Fill colour" icon={<PaintBucket />} value={item.fillColor} transparent onChange={(fillColor) => set({ fillColor })} />}
        <StrokeControls board={board} value={item} set={set} opacity noLine />
        {fillable(item.shape) && <FillSelect board={board} value={item} set={set} />}
        <PopoverButton board={board} title="Label (double-click, Enter, F2 to edit)" icon={<Captions />}>
          <LabelControls board={board} value={item} set={set} mixed={mixed} align />
          <IconButton size="regular" label="Resize shape to fit text" tip={CHROME} disabled={board.can?.('fitText') === false}
            pressed={board.can?.('fitText') !== false && board.fitsText(item)} onClick={() => run('board.items.fitText')}>
            <UnfoldVertical />
          </IconButton>
        </PopoverButton>
        {!mixed.includes('shape') && <ShapePicker board={board} value={item.shape} onChange={(shape) => set({ shape })} />}
        <PopoverButton board={board} title="Style presets" icon={<Palette />}><PresetRow set={set} /></PopoverButton>
      </>
    );
  } else if (item.type === 'connector') {
    controls = (
      <>
        <ConnectorControls board={board} value={item} set={set} strokeFirst headsFirst opacity />
        {one && (
          <PopoverButton board={board} title="Labels (double-click the line, Enter, F2)" icon={<Captions />}>
            <LabelsPanel board={board} item={item} />
          </PopoverButton>
        )}
        <PopoverButton board={board} title="Style presets" icon={<Palette />}><PresetRow set={set} connector /></PopoverButton>
        {one && (
          <>
            <IconButton size="regular" label="Reverse" tip={CHROME} onClick={() => run('board.items.reverse')}><ArrowLeftRight /></IconButton>
            {!item.free && (
              <IconButton size="regular" label="Straighten (remove the bends)" tip={CHROME} disabled={!item.points?.length} onClick={() => run('board.items.straighten')}>
                <RouteOff />
              </IconButton>
            )}
          </>
        )}
      </>
    );
  } else {
    controls = (
      <>
        <Tip title="Natural size of the visible part, capped to the board" {...CHROME}>
          <Button variant="ghost" size="sm" onClick={() => run('board.items.resetSize')}><Scaling />Reset size</Button>
        </Tip>
        <Tip title="Show the whole image again" {...CHROME}>
          <Button variant="ghost" size="sm" disabled={!item.cropped} onClick={() => run('board.items.resetCrop')}><Crop />Reset crop</Button>
        </Tip>
      </>
    );
  }
  return one && turns(item) ? <>{controls}<RotateControls board={board} value={item.rot ?? 0} /></> : controls; // §6d: every item but a connector turns
}
