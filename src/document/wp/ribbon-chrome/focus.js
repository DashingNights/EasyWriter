// Keyboard focus in the Document's chrome (docs/plans/word briefs/ribbon-chrome.md): F6 and Shift+F6 cycle the document, the
// task panes, the status bar and the ribbon (nav.mjs has the order); inside the ribbon the arrow keys, Tab and Ctrl+arrows move
// a roving focus over the tab row and the body's controls. Readers go through the DOM markers of plan.md §1.7 and §1.12.
import { refocusEditor } from '../../../app/actions.js';
import { nextRegion, regionOrder } from './nav.mjs';

/** Whether `el` is drawn: in the DOM, with a box, and not inside an inert or hidden copy (the ribbon's measuring copy). */
export function visible(el) {
  if (!el?.isConnected || el.closest('[inert], [data-measure], [aria-hidden="true"]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** A full pointer press on `el` (pointer and mouse down and up, then click), as a click with the mouse sends it: Radix menu
 * triggers open on pointerdown, items select on click, and keepFocus keeps the editor's selection. */
export function pressEl(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
    buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('click', { ...o, buttons: 0 }));
  return true;
}

const FOCUSABLE = 'button, input, select, textarea, [role="combobox"], [tabindex]';

/** The controls of `root` the keyboard can reach, in document order: drawn, enabled, and not opted out with tabindex -1
 * (the spinners' arrows) unless `all` (the tab row, whose roving tabindex leaves one tab stop). */
export function focusables(root, all = false) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
    && (all || el.tabIndex >= 0) && !el.closest('[data-measure]'));
}

const ribbonOf = () => document.querySelector('[data-ribbon]');

/** The tab row's tab that holds the ribbon's focus: the selected tab, else the first. */
export const activeTab = () => ribbonOf()?.querySelector('[role="tab"][aria-selected="true"]') ?? ribbonOf()?.querySelector('[role="tab"]');

/** Focuses `el` without scrolling the page, so Ctrl+Shift+F10 and the focus ring show it. */
const focusEl = (el) => {
  if (!el) return false;
  el.focus({ preventScroll: true });
  return document.activeElement === el;
};

// ---------------------------------------------------------------------------------------------
// F6 and Shift+F6

/** The region holding the focus now: 'pane:<id>', 'statusbar', 'ribbon' or 'document'. */
export function currentRegion() {
  const el = document.activeElement;
  const pane = el?.closest?.('[data-pane]');
  if (pane) return `pane:${pane.dataset.pane}`;
  if (el?.closest?.('[data-statusbar]')) return 'statusbar';
  if (el?.closest?.('[data-ribbon]')) return 'ribbon';
  return 'document';
}

/** The regions shown now, in F6 order. */
export function regionsNow() {
  const panes = [...document.querySelectorAll('[data-pane]')].filter(visible).map((el) => ({ id: el.dataset.pane, side: el.dataset.paneSide }));
  return regionOrder({ panes, statusbar: visible(document.querySelector('[data-statusbar]')), ribbon: visible(ribbonOf()) });
}

/** Moves the focus into `region`: the editor, a pane's first control (else the pane itself), the status bar's first item (else
 * the bar), or the ribbon's active tab. */
export function focusRegion(region) {
  if (!region || region === 'document') return refocusEditor();
  if (region === 'ribbon') return focusEl(activeTab());
  const box = region === 'statusbar' ? document.querySelector('[data-statusbar]')
    : document.querySelector(`[data-pane="${CSS.escape(region.slice(5))}"]`);
  if (!box) return false;
  const first = focusables(box.querySelector('[data-pane-body]') ?? box)[0] ?? focusables(box)[0];
  if (first) return focusEl(first);
  if (box.tabIndex < 0) box.tabIndex = -1;
  return focusEl(box);
}

/** F6 (`dir` 1) or Shift+F6 (-1): the next region that is shown. */
export function cycleFocus(dir) {
  return focusRegion(nextRegion(regionsNow(), currentRegion(), dir));
}

// ---------------------------------------------------------------------------------------------
// The ribbon's own keys

/** The item `by` places from `from` in `list`, wrapping at the ends; from outside the list, the first or the last. */
const move = (list, from, by) => {
  if (!list.length) return null;
  const i = list.indexOf(from);
  const start = i < 0 ? (by > 0 ? -1 : list.length) : i;
  return list[(start + by + list.length) % list.length];
};

const opener = (el) => (el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-haspopup') === 'dialog' ? el : null);

/** Key event `e` with the focus inside the ribbon (no menu open): → true when used. Left and Right move along the tab row or
 * between the body's items, Down enters the body or opens a focused control's list, Up goes back, Tab and Shift+Tab move
 * between controls, Ctrl+Left and Ctrl+Right between groups, Alt+Down opens a menu, Esc returns to the document, and
 * Ctrl+Shift+F10 shows the focused control's tooltip. Space and Enter press through the button's own handling. */
export function ribbonKey(e) {
  const ribbon = ribbonOf();
  const el = document.activeElement;
  if (!ribbon || !el || !ribbon.contains(el)) return false;
  const typing = el.matches('input, textarea, select, [role="combobox"]');
  const row = ribbon.querySelector('[role="tablist"]');
  const inRow = row?.contains(el);
  const body = ribbon.querySelector('[data-ribbon-body]');
  const items = focusables(body);
  const go = (target) => {
    if (target) focusEl(target);
    e.preventDefault();
    return true;
  };
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    refocusEditor();
    return true;
  }
  if (e.key === 'F10' && e.ctrlKey && e.shiftKey) {
    // Ctrl+Shift+F10: the focused control's tooltip, which opens on keyboard focus.
    el.blur();
    return go(el);
  }
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    // One stop per control: a split button's arrow is reached with Down, not Tab.
    const mine = el.closest('[data-feature]');
    const seen = new Set();
    const stops = items.filter((x) => {
      const f = x.closest('[data-feature]') ?? x;
      if (x !== el && (f === mine || seen.has(f))) return false;
      seen.add(f);
      return true;
    });
    const all = [...focusables(row, true).filter((x) => x === el || x.matches('[role="tab"][aria-selected="true"]') || !x.matches('[role="tab"]')), ...stops];
    return go(move(all, el, e.shiftKey ? -1 : 1));
  }
  if (typing) return false; // the boxes keep their arrows
  if (e.key === 'ArrowDown' && e.altKey) {
    const o = opener(el) ?? el.closest('[data-feature]')?.querySelector('[aria-haspopup="menu"]');
    if (!o) return false;
    e.preventDefault();
    pressEl(o);
    return true;
  }
  if (e.altKey || e.metaKey) return false;
  if (inRow) {
    const list = focusables(row, true);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return go(move(list, el, e.key === 'ArrowRight' ? 1 : -1));
    if (e.key === 'ArrowDown') return go(items[0]);
    return false;
  }
  if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const groups = [...body.querySelectorAll('[data-group]')].filter(visible);
    const g = groups.indexOf(el.closest('[data-group]'));
    const next = groups[Math.min(groups.length - 1, Math.max(0, g + (e.key === 'ArrowRight' ? 1 : -1)))];
    return go(focusables(next)[0]);
  }
  if (e.ctrlKey) return false;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return go(move(items, el, e.key === 'ArrowRight' ? 1 : -1));
  if (e.key === 'ArrowDown') {
    const o = opener(el);
    if (o) {
      e.preventDefault();
      pressEl(o);
      return true;
    }
    return go(move(items, el, 1));
  }
  if (e.key === 'ArrowUp') return go(items.indexOf(el) <= 0 ? activeTab() : move(items, el, -1));
  return false;
}
