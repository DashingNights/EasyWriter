// The picked pen's options (panel 'draw.pen', docs/plans/word briefs/draw.md): thickness, 16 colours, More Colors and Delete.
import { cn } from 'cn';
import { keepFocus } from '../../../app/components/Toolbar.jsx';
import { COLORS, thicknessOf } from './pens.mjs';

const BTN = 'rounded-sm px-1.5 py-0.5 text-[12px] hover:bg-accent aria-pressed:bg-accent aria-pressed:ring-1 aria-pressed:ring-[var(--ui-accent)]';

/** `pen` ({kind, color, width}); `onChange(patch)`, `onDelete()` (null: the last pen stays), `onMore()` opens the Colors dialog. */
export function PenPanel({ pen, onChange, onDelete, onMore, close }) {
  const set = (patch) => {
    onChange(patch);
    close();
  };
  return (
    <div data-draw-pen className="flex w-56 flex-col gap-1.5 p-1 text-[12px]">
      <div className="font-medium">Thickness</div>
      <div className="flex flex-wrap gap-1">
        {thicknessOf(pen.kind).map((mm) => (
          <button key={mm} type="button" data-thickness={mm} aria-pressed={pen.width === mm} onMouseDown={keepFocus} onClick={() => set({ width: mm })} className={BTN}>
            {mm} mm
          </button>
        ))}
      </div>
      <div className="font-medium">Colours</div>
      <div className="grid grid-cols-8 gap-1">
        {COLORS.map(([hex, name]) => (
          <button key={hex} type="button" aria-label={name} title={name} data-color={hex} aria-pressed={pen.color === hex} onMouseDown={keepFocus}
            onClick={() => set({ color: hex })} style={{ background: hex }}
            className={cn('size-5 rounded-xs ring-1 ring-foreground/20 ring-inset', pen.color === hex && 'outline-2 outline-[var(--ui-accent)]')} />
        ))}
      </div>
      <button type="button" onMouseDown={keepFocus} onClick={() => { close(); onMore(); }} className={cn(BTN, 'text-left')}>More Colors...</button>
      {onDelete && <button type="button" onMouseDown={keepFocus} onClick={() => { close(); onDelete(); }} className={cn(BTN, 'text-left')}>Delete</button>}
    </div>
  );
}
