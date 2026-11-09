// The kit's font and size boxes for any toolbar (the ribbon's Font and Font Size combos, the Document's quick boxes, a forum
// post's toolbar): an editable field over a list. The surface hands in its own option lists; nothing here knows a format.
import { cn } from 'cn';
import { Combobox } from '@/components/ui/combobox';
import { refocusEditor } from '../../app/actions.js';

/** The rows a Combobox draws for `options`: a group heading inside the first row of its run, each row in its own `css` font
 * family (or its `preview`). ponytail: headings ride in the rows (Combobox lists rows only); real sections when a long list
 * needs keyboard groups. */
const rows = (options) => options.map((o, i) => [o.id, (
  <span key={o.id} className="flex min-w-0 flex-col">
    {o.group && o.group !== options[i - 1]?.group && <span className="pb-1 text-xs font-medium text-muted-foreground">{o.group}</span>}
    <span className="truncate" title={o.label} style={o.css ? { fontFamily: o.css } : undefined}>{o.preview ?? o.label}</span>
  </span>
), o.label]);

/** A font box: `options` [{id, label, css, group?}], each row drawn in its font. Typing searches the list; Enter takes the font
 * the text names or starts. `onChange(id)` on a pick, or the typed name (a label's id when it names one). `value` is an id;
 * the field shows its label. `size` 'xs' or 'sm'; `onOpen` runs each time the list opens (a late font list); `onDone` hands the
 * focus back (default: to the editor). Other props (aria-label, disabled) go to the field. */
export function FontPick({ value, onChange, options, placeholder, size = 'xs', className, onOpen, onDone = () => refocusEditor(), contentProps, ...props }) {
  const shown = options.find((o) => o.id === value)?.label ?? (value == null ? '' : String(value));
  const commit = (text) => {
    const t = text.trim();
    if (t) onChange(options.find((o) => o.label.toLowerCase() === t.toLowerCase())?.id ?? t);
  };
  return (
    <Combobox size={size} aria-label="Font" {...props} className={cn('w-48', className)} value={value} text={shown} placeholder={placeholder}
      options={rows(options)} filter onOpen={onOpen} onCommit={commit} onPick={onChange} onDone={onDone}
      contentProps={{ ...contentProps, className: cn('max-h-80 w-64 overflow-y-auto', contentProps?.className) }} />
  );
}

/** A size box: `options` (numbers, or [{id, label}]), a typed value, and `unit` shown in the field when given ('pt', '%').
 * `onChange(id)` on a pick, or the typed text (the caller parses it). The rest as FontPick, without the search. */
export function SizePick({ value, onChange, options, unit, placeholder, size = 'xs', className, onDone = () => refocusEditor(), contentProps, ...props }) {
  const list = options.map((o) => (typeof o === 'object' ? o : { id: o, label: String(o) }));
  const shown = list.find((o) => o.id === value)?.label ?? (value == null ? '' : String(value));
  return (
    <Combobox size={size} aria-label="Font size" {...props} className={cn('w-16', className)} value={value} text={shown} placeholder={placeholder}
      unit={unit} options={rows(list)} onCommit={(t) => t.trim() && onChange(t.trim())} onPick={onChange} onDone={onDone}
      contentProps={{ ...contentProps, className: cn('max-h-80 w-20 overflow-y-auto', contentProps?.className) }} />
  );
}
