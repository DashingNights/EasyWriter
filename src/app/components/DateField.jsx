import { useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// YYYY-MM-DD ↔ a local Date (the calendar works in local days).
const toDate = (s) => (/^\d{4}-\d\d-\d\d$/.test(s) ? new Date(+s.slice(0, 4), s.slice(5, 7) - 1, +s.slice(8)) : undefined);
const fromDate = (d) => `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A date box: the native date input for typing (dd/mm/yyyy; YYYY-MM-DD values; its own picker button hidden) and a calendar
 * button (or Alt+↓ / F4) that opens the shadcn Calendar: Monday first, today and the selected day marked, `calendar`'s
 * non-working days and holidays muted, month and year menus. A picked day runs `onPick(date)` and closes it; the focus goes
 * back to the box. `contentProps` go to the popover; other props go to the input; an uncontrolled
 * box (`defaultValue`) is reset when that changes. `onBlur` waits while the focus is on the button or in the calendar and runs
 * once it leaves the field. */
export function DateField({ onPick, onBlur, onKeyDown, calendar, contentProps, className, defaultValue, ...props }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState();
  const wrap = useRef(null);
  const input = () => wrap.current?.querySelector('input');
  const show = (on) => {
    if (on) setSelected(toDate(input()?.value ?? ''));
    setOpen(on);
  };
  const year = (selected ?? new Date()).getFullYear();
  const off = calendar && ((d) => !calendar.workdays.includes(d.getDay()) || calendar.holidays.includes(fromDate(d)));
  return (
    <Popover open={open} onOpenChange={show}>
      <div ref={wrap} className="flex items-center">
        <Input type="date" key={defaultValue} defaultValue={defaultValue} className={cn(className, 'pr-6 [&::-webkit-calendar-picker-indicator]:hidden')} {...props}
          onBlur={(e) => !open && !wrap.current?.contains(e.relatedTarget) && onBlur?.(e)}
          onKeyDown={(e) => {
            if (!(e.altKey && e.key === 'ArrowDown') && e.key !== 'F4') return onKeyDown?.(e);
            e.preventDefault(); // not Chromium's own picker
            return show(true);
          }} />
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" tabIndex={-1} disabled={props.disabled} aria-label="Choose date" title="Choose date (Alt+Down)"
            className="-ml-6 shrink-0 text-muted-foreground"><CalendarDays /></Button>
        </PopoverTrigger>
      </div>
      {/* The day to start from (selected, else today, else the 1st) once the popover's focus scope is up: focused earlier, inside a
          dialog, the dialog's scope would take the focus back. */}
      <PopoverContent {...contentProps} align="end" className="w-auto p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          e.target.querySelector('td button[tabindex="0"]')?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const el = input();
          const at = document.activeElement;
          if (!el || at === el) return;
          // Picked, Escape or a click on nothing focusable: back to the box; focus moved elsewhere: the field was left.
          if (!at || at === document.body || at.contains(el)) el.focus();
          else onBlur?.({ target: el, currentTarget: el, relatedTarget: at });
        }}>
        <Calendar mode="single" required selected={selected} defaultMonth={selected} weekStartsOn={1} captionLayout="dropdown"
          startMonth={new Date(year - 10, 0)} endMonth={new Date(year + 10, 11)}
          modifiers={off ? { off } : undefined} modifiersClassNames={{ off: 'text-muted-foreground' }}
          onSelect={(d) => {
            setOpen(false);
            onPick(fromDate(d));
          }} />
      </PopoverContent>
    </Popover>
  );
}
