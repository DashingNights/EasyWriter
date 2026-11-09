// The dialog kit's frame (docs/plans/word/plan.md §1.6): Word's dialog layout in the app's tokens. Every package dialog is
// `({...props, onClose}) => <WordDialog ...>`, opened with actions.js openDialog(id, props), which stacks it over an open dialog.
import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { XIcon } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { dialogStack, refocusEditor } from '../../app/actions.js';
import { isMac } from '../../app/keys.mjs';
import { Help } from '../../app/components/Tip.jsx';
import { accessOf } from './access.mjs';

const SIZES = { fit: 'w-fit', sm: 'w-[28rem]', md: 'w-[38rem]', wide: 'w-[44rem]', lg: 'w-[52rem]' }; // fit: as wide as its content (the colour picker)
// Where a bare letter types instead of pressing an access key (Windows dialogs press it everywhere else).
const TEXT = 'input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable]:not([contenteditable=false])';

/** Label `label` with its "&" access key underlined; a Mac draws no underline (Option types characters there, so the kit handles
 * no access keys). */
export function AccessText({ label }) {
  const { text, at } = accessOf(label);
  if (at < 0 || isMac()) return text;
  // One span: in a flex row with a gap (a check box's label, a button) loose pieces would each take the gap and split the word.
  return <span>{text.slice(0, at)}<u>{text[at]}</u>{text.slice(at + 1)}</span>;
}

/** The data-access attribute for the element labelled `label` (a <label>, a button or a tab), which WordDialog's keys find. */
export function accessProps(label) {
  const { key } = accessOf(label);
  return key && !isMac() ? { 'data-access': key } : {};
}

/** Keeps a dialog where it opened, centred in the window: once placed, content that grows or shrinks (More >>, a tab of another
 * height) moves only its bottom edge, as Word's dialogs do, so the title bar and tabs stay under the pointer.
 * → [ref callback for the dialog's root, its style, its classes]. */
export function useAnchor() {
  const [top, setTop] = useState(null);
  // offsetHeight, not the bounding box: the open animation scales the box for its first frames.
  const ref = (el) => { if (el && top == null) setTop(Math.round((window.innerHeight - el.offsetHeight) / 2)); };
  return top == null
    ? [ref, null, 'max-h-[calc(100%-4rem)]']
    : [ref, { top, maxHeight: `calc(100% - ${top}px - 2rem)` }, 'translate-y-0'];
}

/** The open tab `shown` of `tabs` ({ id, render }), held to the tallest tab's height so that switching tabs never moves what lies
 * below it (OK and Cancel). The first draw stacks every tab in one cell to measure them, then only the open tab stays. */
export function TabStack({ tabs, shown }) {
  const [floor, setFloor] = useState(null);
  const ref = useRef(null);
  // ResizeObserver, not the bounding box: the open animation scales the rect, and this reports the layout size exactly, fractions included.
  useEffect(() => {
    if (floor != null || !ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setFloor(e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height));
    ro.observe(ref.current, { box: 'border-box' });
    return () => ro.disconnect();
  }, [floor]);
  return (
    <div ref={ref} className="grid flex-1" style={{ minHeight: floor ?? undefined }}>
      {(floor == null ? tabs : [shown]).map((t) => (
        <div key={t.id} inert={t !== shown} className={cn('col-start-1 row-start-1 flex flex-col gap-3', t !== shown && 'invisible')}>{t.render()}</div>
      ))}
    </div>
  );
}

/** Presses access key `key` inside `root`: a <label> focuses its control (a check box or radio is also pressed), any other element
 * is pressed. → whether an element holds the key. */
export function pressAccess(root, key) {
  const el = [...root.querySelectorAll('[data-access]')].find((x) => x.dataset.access === key);
  if (!el) return false;
  if (el.tagName !== 'LABEL') {
    if (!el.disabled) el.click();
    el.focus();
    return true;
  }
  const c = el.control;
  if (!c || c.disabled) return true;
  c.focus();
  if (c.type === 'checkbox' || c.type === 'radio') c.click();
  else c.select?.();
  return true;
}

/** The tab strip: `tabs` [{id, label, disabled?, attrs?}], `value` the open tab's id, `onChange(id)`. onClick as well as Radix's mousedown:
 * an access key and a script press a tab with click(). */
export function TabStrip({ tabs, value, onChange }) {
  return (
    <Tabs value={value} onValueChange={onChange} className="shrink-0">
      <TabsList className="max-w-full flex-wrap">
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id} disabled={t.disabled} {...accessProps(t.label)} {...t.attrs} onClick={() => t.id !== value && onChange(t.id)}>
            <AccessText label={t.label} />
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** A Word dialog: title, optional tabs (Word's tab strip), body, footer with left buttons (Set As Default, Tabs...) and OK and Cancel
 * at the right. Enter is OK, Escape is Cancel; OK closes with result() unless validate() returns a message (shown in the footer).
 * Keys: Alt+letter (and the bare letter while the focus is not in a text box, as Windows dialogs do) focuses the box or presses the
 * button, check box or radio whose label holds that access key, or switches to the tab whose label does; Ctrl+Tab and
 * Ctrl+Shift+Tab switch tabs. On a Mac the kit draws no underline and handles no Alt+letter; Ctrl+Tab still switches tabs.
 * modeless: no overlay and no focus trap, the text behind stays clickable and editable, Esc closes while the focus is inside.
 * The dialog stays where it opens: a drag on the title bar does not move it (owner's decision 2026-10-29). The root carries
 * data-word-dialog. `id` is the root's data-word-dialog value. `buttons` [{label, onClick, disabled, primary}] replaces OK, Cancel and `left`; [] draws no
 * footer. `onEnter` replaces what Enter does (default OK, or the primary button). `cancelText` null hides Cancel. `help` is a (?) at the
 * footer's left. A `tabs` entry without `render` leaves the body to `children`. `rootRef` receives the root. */
export function WordDialog({ id = '', title, tabs, tab, onTab, size = 'md', left = [], okText = 'OK', cancelText = 'Cancel', buttons, onEnter, help, rootRef, validate, result, onClose, modeless = false, children }) {
  const [own, setOwn] = useState(tabs?.[0]?.id);
  const [error, setError] = useState('');
  const mine = useRef(null);
  const root = rootRef ?? mine;
  const [anchor, placed, centred] = useAnchor();
  // Opened from a board (it mounts on top of the stack): the board's chrome mark, so its text edit stays open and the board stays
  // the one its chrome serves while the dialog has the focus; closing gives the focus back to it (actions.js refocusEditor).
  const [chrome] = useState(() => !!dialogStack().at(-1)?.board);
  const current = tab ?? own;
  const setTab = (next) => (onTab ? onTab(next) : setOwn(next));
  const shown = tabs?.find((t) => t.id === current) ?? tabs?.[0];

  const ok = () => {
    const message = validate?.();
    if (message) setError(message);
    else onClose(result ? result() : true);
  };
  const enter = onEnter ?? (buttons ? () => buttons.find((b) => b.primary && !b.disabled)?.onClick() : ok);
  const onKeyDown = (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Tab' && e.ctrlKey && tabs?.length > 1) {
      e.preventDefault();
      const i = tabs.indexOf(shown);
      setTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id);
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.target.closest('button, textarea, a, [role=menu]')) {
      e.preventDefault();
      enter();
    } else if (!isMac() && e.key.length === 1 && !e.ctrlKey && !e.metaKey && (e.altKey || !e.target.closest(TEXT))) {
      if (pressAccess(root.current, e.key.toLowerCase())) e.preventDefault();
    }
  };
  const footButton = (label, onClick, { key = label, primary, disabled, access } = {}) => (
    <Button key={key} type="button" variant={primary ? 'default' : 'outline'} size="sm" className="min-w-20" disabled={disabled} onClick={onClick} {...(access && accessProps(label))}>
      {access ? <AccessText label={label} /> : label}
    </Button>
  );

  return (
    <Dialog open modal={!modeless} onOpenChange={(open) => !open && onClose(null)}>
      {/* A modeless dialog leaves the dialog-content slot: whiteboard.js counts that slot as a popup a board click dismisses. */}
      <DialogContent ref={(el) => { root.current = el; anchor(el); }} showCloseButton={false} data-word-dialog={id} data-modeless={modeless || undefined}
        {...(modeless && { 'data-slot': 'word-dialog-modeless' })} aria-describedby={undefined} data-board-chrome={chrome ? '' : undefined}
        onKeyDown={onKeyDown} onCloseAutoFocus={refocusEditor} onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => modeless && !root.current?.contains(document.activeElement) && e.preventDefault()}
        style={placed} className={cn('flex flex-col gap-2 p-3 text-sm sm:max-w-[calc(100%-2rem)]', centred, SIZES[size] ?? SIZES.md)}>
        <DialogHeader className="shrink-0 pr-7 text-left select-none"><DialogTitle>{title}</DialogTitle></DialogHeader>
        {/* tabIndex -1: the dialog opens on its first control, as Word's do, not on the close button */}
        <DialogClose asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Close" tabIndex={-1} className="absolute top-2 right-2 text-muted-foreground"><XIcon /></Button>
        </DialogClose>
        {tabs && <TabStrip tabs={tabs} value={shown.id} onChange={setTab} />}
        {/* -m-1 p-1: room for the 3 px focus ring of controls at the edge, which the scroll box would clip */}
        <div role={tabs ? 'tabpanel' : undefined} className="-m-1 flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-1">
          {shown?.render ? <TabStack tabs={tabs} shown={shown} /> : children}
        </div>
        {buttons?.length !== 0 && (
          <DialogFooter className="shrink-0 flex-row items-center justify-end">
            {help && <Help>{help}</Help>}
            {!buttons && left.map((b) => (
              <Button key={b.label} type="button" variant="outline" size="sm" disabled={b.disabled} onClick={b.onClick} {...accessProps(b.label)}>
                <AccessText label={b.label} />
              </Button>
            ))}
            <p role="alert" className="min-w-0 flex-1 truncate text-destructive">{error}</p>
            {buttons ? buttons.map((b) => footButton(b.label, b.onClick, { primary: b.primary, disabled: b.disabled, access: true })) : (
              <>
                {cancelText != null && footButton(cancelText, () => onClose(null), { key: 'cancel' })}
                {footButton(okText, ok, { key: 'ok', primary: true, access: true })}
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
