import { createContext, useContext, useRef, useState } from 'react';
import { cn } from 'cn';
import { CircleQuestionMark } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { withKey } from '../keybinds.js';

/** The side a Tip opens on when it names none (the Document island: right, docs/plans/document.md step 10). */
export const TipSide = createContext(undefined);

/** Whether a control inside `el` has its list, menu or popover open: a Radix menu, popover or select trigger's data-state, a
 * combobox's aria-expanded. A disclosure button's aria-expanded (Assistant, Show replace) opens no list, so its tooltip stays. */
const expanded = (el) => !!el?.querySelector('[data-state="open"], [role="combobox"][aria-expanded="true"]');

/** Tooltip around one trigger element (icon buttons: the action and its shortcut). The trigger is a wrapper span: as
 * asChild trigger the tooltip's data-state would replace the child's own (a pressed Toggle's "on"), and a disabled
 * button gets no pointer events. `wrap`: more classes for that span (`flex-1` to let a button fill a row). Other props go
 * to the content. `stop`: the click stops at the span (after the tooltip's own close), so the element holding it gets none.
 * It never opens while the control it wraps is expanded, so it never covers that control's open list or menu. */
export function Tip({ title, side, wrap, stop, children, ...props }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const fallback = useContext(TipSide);
  return (
    <Tooltip open={open && !expanded(ref.current)} onOpenChange={(o) => setOpen(o && !expanded(ref.current))}>
      <TooltipTrigger asChild><span ref={ref} className={wrap ? `inline-flex ${wrap}` : 'inline-flex'} onClick={stop ? (e) => e.stopPropagation() : undefined}>{children}</span></TooltipTrigger>
      <TooltipContent side={side ?? fallback} {...props}>{title}</TooltipContent>
    </Tooltip>
  );
}

/** An icon-only button with its tooltip. `label` is the tooltip and the accessible name, with the key of `keybind` (a keys.mjs
 * id) after it as withKey writes it ("Undo (Ctrl+Z)"); a fixed key (Esc, Enter, Alt+Down) is part of the label. `size`
 * 'compact' (h-6: rows, row actions, header and bar controls, inline fields) or 'regular' (h-8: island tool buttons, dialog
 * and Settings forms). `pressed`: a toggle (aria-pressed; bg-accent while on). `reveal`: hidden until its row (a Tailwind
 * `group`) is hovered or holds the focus, and while its menu is open. `slot`: the Radix trigger that wraps it
 * (DropdownMenuTrigger, PopoverTrigger). `tip`: more Tip props (side, wrap, CHROME). `variant`: 'destructive-ghost' for a
 * delete. type="button" unless given; its click stops at its Tip, so the row, card or menu item holding it gets none. */
export function IconButton({ label, keybind, size = 'compact', pressed, reveal, slot: Slot, tip, variant = 'ghost', className, children, ...props }) {
  const text = withKey(label, keybind);
  let button = (
    <Button type="button" variant={variant} size={size === 'regular' ? 'icon-sm' : 'icon-xs'} aria-label={text} aria-pressed={pressed}
      className={cn(pressed && 'bg-accent hover:bg-accent', reveal && 'invisible group-focus-within:visible group-hover:visible data-[state=open]:visible', className)} {...props}>
      {children}
    </Button>
  );
  if (Slot) button = <Slot asChild>{button}</Slot>;
  return <Tip title={text} stop {...tip}>{button}</Tip>;
}

/** The (?) beside a title or control: what would be a line of small print under it, in a tooltip on hover or keyboard focus.
 * A dialog that focuses it on opening (after a click) leaves it shut: the preventDefault skips Radix's own focus handler.
 * `tipClassName`: more classes for the tooltip (the tutorial's card raises it over the tutorial's dim). */
export function Help({ children, label = 'More information', className, tipClassName }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} data-help onFocus={(e) => !e.currentTarget.matches(':focus-visible') && e.preventDefault()}
          className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50', className)}>
          <CircleQuestionMark className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className={cn('max-w-72 text-left text-pretty', tipClassName)}>{children}</TooltipContent>
    </Tooltip>
  );
}
