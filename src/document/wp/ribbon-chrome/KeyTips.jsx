// KeyTips and the ribbon's keys at window level (docs/plans/word briefs/ribbon-chrome.md). One keydown and keyup listener in
// capture phase, added by the module's setup and removed by its cleanup: an Alt tap (no key between, no pointer press, no
// blur) or F10 shows KeyTips; Alt with a letter is Alt then that letter, Alt with a digit presses that Quick Access Toolbar
// button; F6, Shift+F6, F10 and Ctrl+F1 work where the focus is in neither Document text nor the chrome (WordKeys and
// actions.js run them there); Ctrl+Space in a pane opens its menu; the ribbon's arrow keys and Tab move its focus. While
// KeyTips show, every key goes to them. Badges are read from the DOM's [data-keytip] elements, so whatever renders that
// attribute (the backstage, menus, a collapsed group's drop-down) takes part. KeyTips are off on a Mac (plan.md §1.13).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { refocusEditor } from '../../../app/actions.js';
import { isMac } from '../../../app/keys.mjs';
import { getState } from '../../../app/store.js';
import { ctxOf, run } from '../../../tooling/registry.js';
import { setWord } from '../../../tooling/ribbon/contexts.js';
import { wordKeyWins } from '../../word/keys.js';
import { activeTab, pressEl, ribbonKey, visible } from './focus.js';
import { back, enter, IDLE, matching, press, resolveKeytips, tokens, top } from './keytips.mjs';
import { openPaneMenu, paneMenuKey, paneMenuOpen } from './PaneMenu.jsx';

let m = IDLE;
let entries = []; // the top level's entries: [{keys, label, el, derived}]
let version = 0;
const subs = new Set();
const emit = () => {
  version++;
  for (const f of subs) f();
};
const subscribe = (f) => {
  subs.add(f);
  return () => subs.delete(f);
};

/** Whether KeyTips show. */
export const keytipsOn = () => m.levels.length > 0;

// What KeyTips and Alt+digit pressed, newest last, for harness cases (window.__word.keytips).
const pressed = [];

const MENU_ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

const labelOf = (el) => el.getAttribute('aria-label') ?? el.textContent.trim();

/** The entries of `level`: the tab row (with the display options' Z R), the active tab's body (only a collapsed group's own
 * KeyTip), or the controls and items of an open menu, drop-down or the backstage. Items without a KeyTip get a derived one. */
function collect(level) {
  const ribbon = document.querySelector('[data-ribbon]');
  let els = [];
  if (level.root) {
    if (level.root.isConnected) els = [...level.root.querySelectorAll(`[data-keytip], ${MENU_ITEM}`)];
  } else if (ribbon && level.kind === 'top') {
    els = [...ribbon.querySelectorAll('[data-keytip]')].filter((el) => !el.closest('[data-ribbon-body]') || el.dataset.keytipLevel === 'top');
  } else if (ribbon) {
    els = [...ribbon.querySelectorAll('[data-ribbon-body] [data-keytip]')].filter((el) => el.dataset.keytipLevel !== 'top');
  }
  // A group's own KeyTip works only collapsed (on its button); in a sub menu's parent only the open sub menu counts.
  els = els.filter((el) => !el.matches('[data-group]') && visible(el));
  els = els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
  return resolveKeytips(els.map((el) => ({ keys: el.dataset.keytip ?? '', label: labelOf(el), el })));
}

function setM(next) {
  m = next;
  const level = top(m)?.id;
  entries = level ? collect(level) : [];
  if (!!getState().word?.keytips !== keytipsOn()) setWord({ keytips: keytipsOn() });
  emit();
}

/** Shows KeyTips at the tab row (or over the open backstage's navigation). → whether they show. */
export function startKeytips() {
  if (isMac() || !document.querySelector('[data-ribbon]')) return false;
  const stage = document.querySelector('[data-backstage]');
  setM(enter(IDLE, stage ? { kind: 'popup', root: stage } : { kind: 'top' }));
  return true;
}

/** Hides KeyTips. */
export function endKeytips() {
  if (keytipsOn()) setM(IDLE);
}

/** F10 and the Alt tap: shows KeyTips, or hides them. */
export const toggleKeytips = () => (keytipsOn() ? (endKeytips(), refocusEditor(), true) : startKeytips());

// Our own presses dispatch pointer events; only other presses end KeyTips.
let acting = false;
const act = (el) => {
  acting = true;
  try {
    pressEl(el);
  } finally {
    acting = false;
  }
};

/** Calls `then(found)` once `get()` finds something and two more frames have drawn (a new tab measures and fits its groups
 * first), polling a frame at a time; KeyTips end if it never does. */
function waitFor(get, then, frames = 30) {
  const found = get();
  if (found) return requestAnimationFrame(() => requestAnimationFrame(() => keytipsOn() && then(get() || found)));
  if (frames <= 0) return endKeytips();
  requestAnimationFrame(() => waitFor(get, then, frames - 1));
}

const openMenus = () => [...document.querySelectorAll('[role="menu"][data-state="open"]')];

/** Does what pressing `entry` means: a tab shows its controls' KeyTips, File opens the backstage, a collapsed group drops
 * down, a control with a menu opens it and shows its items' KeyTips; a box takes the focus, a check box toggles, anything
 * else is pressed and KeyTips end. */
function pressEntry(entry) {
  const el = entry.el;
  pressed.push(el.dataset.feature ?? el.dataset.tab ?? el.dataset.groupButton ?? entry.label);
  if (el.getAttribute('aria-disabled') === 'true' || el.disabled) {
    endKeytips();
    if (el.dataset.reason) ctxOf().toast(el.dataset.reason); // a click shows it in the tooltip; a KeyTip has no tooltip
    return;
  }
  if (el.dataset.tab === 'file') {
    act(el);
    waitFor(() => document.querySelector('[data-backstage]'), (root) => setM(enter(m, { kind: 'popup', root })));
    return;
  }
  if (el.matches('[role="tab"]')) {
    act(el);
    const shown = () => document.querySelector('[data-ribbon] [role="tab"][aria-selected="true"]')?.dataset.tab === el.dataset.tab
      && !document.querySelector('[data-ribbon] [data-measure]') && document.querySelector('[data-ribbon-body]');
    waitFor(shown, () => setM(enter(m, { kind: 'tab' })));
    return;
  }
  if (el.dataset.groupButton) {
    act(el);
    waitFor(() => document.querySelector(`[data-group-popup="${CSS.escape(el.dataset.groupButton)}"]`), (root) => setM(enter(m, { kind: 'popup', root })));
    return;
  }
  const trigger = el.matches('[aria-haspopup="menu"]') ? el : el.querySelector('[data-gallery-more][aria-haspopup="menu"], [aria-haspopup="menu"]');
  if (trigger) {
    const before = openMenus();
    act(trigger);
    waitFor(() => openMenus().find((x) => !before.includes(x)), (root) => setM(enter(m, { kind: 'popup', root })));
    return;
  }
  const check = el.matches('input[type="checkbox"]') ? el : el.querySelector('input[type="checkbox"]');
  const box = el.matches('input, [role="combobox"]') ? el : el.querySelector('input, [role="combobox"]');
  endKeytips();
  if (check) check.click();
  else if (box) {
    box.focus({ preventScroll: true });
    box.select?.();
  } else act(el.querySelector('[data-part="main"]') ?? el);
}

/** The character a key event types for KeyTips: a letter or digit by its key position (any layout), else its key. */
function charOf(e) {
  const code = /^(?:Key([A-Z])|Digit(\d)|Numpad(\d))$/.exec(e.code ?? '');
  if (code) return code[1] ?? code[2] ?? code[3];
  return e.key?.length === 1 ? e.key.toUpperCase() : null;
}

const swallow = (e) => {
  e.preventDefault();
  e.stopPropagation();
};

/** Key `e` while KeyTips show (every key goes to them). */
function keytipKey(e) {
  if (['Shift', 'Control', 'Meta', 'CapsLock', 'Alt', 'AltGraph'].includes(e.key)) return;
  const level = top(m).id;
  if (e.key === 'Escape') {
    const r = back(m);
    // An open menu, drop-down or the backstage closes on its own Escape, so the key goes on to it.
    if (r.act !== 'clear' && level.root) {
      setM(r.m);
      if (r.act === 'end') refocusEditor();
      requestAnimationFrame(() => keytipsOn() && setM(m));
      return;
    }
    swallow(e);
    setM(r.m);
    if (r.act === 'end') refocusEditor();
    return;
  }
  const ch = !e.ctrlKey && !e.metaKey ? charOf(e) : null;
  if (ch && ch !== ' ') {
    swallow(e);
    const r = press(m, ch, entries);
    if (r.act === 'miss') return endKeytips();
    setM(r.m);
    if (r.act === 'press') pressEntry(r.entry);
    return;
  }
  // Any other key ends KeyTips; the arrows and Tab go on as the ribbon's keyboard navigation (in an open menu, its own).
  endKeytips();
  if (/^(Arrow|Tab$)/.test(e.key) && !e.ctrlKey && !e.altKey) {
    if (level.root) return;
    if (!document.activeElement?.closest('[data-ribbon]')) {
      swallow(e);
      activeTab()?.focus({ preventScroll: true });
    }
    return;
  }
  swallow(e);
}

const dialogOpen = () => (getState().dialogs?.length ?? 0) > 0
  || !!document.querySelector('[role="dialog"][data-state="open"]:not([data-backstage]):not([data-group-popup]), [role="alertdialog"]');
const menuOpen = () => openMenus().length > 0 || !!document.querySelector('[data-group-popup]');

/** Adds the window listeners → their cleanup. Runs from the module's setup while a Document's main editor is mounted. */
export function installKeys() {
  let armed = false; // an Alt press with nothing after it yet
  const down = (e) => {
    if (keytipsOn()) {
      if (e.key === 'Alt') armed = !e.repeat;
      else armed = false;
      keytipKey(e);
      return;
    }
    if (paneMenuOpen()) {
      paneMenuKey(e);
      return;
    }
    if (e.key === 'Alt') {
      // Not AltGr (it arrives as AltGraph, or with Ctrl), not a held repeat.
      armed = !e.repeat && !e.ctrlKey && !e.metaKey && !e.getModifierState?.('AltGraph');
      return;
    }
    armed = false;
    if (e.defaultPrevented || wordKeyWins(e) || isMac()) return;
    const inBackstage = !!e.target.closest?.('[data-backstage]');
    if (dialogOpen() || menuOpen()) return;
    const mods = e.ctrlKey || e.altKey || e.metaKey;
    if (e.ctrlKey && e.code === 'Space' && !e.altKey && !e.shiftKey && !e.metaKey && e.target.closest?.('[data-pane]')) {
      swallow(e);
      openPaneMenu(e.target.closest('[data-pane]').dataset.pane);
      return;
    }
    if (e.key === 'F6' && !mods) {
      swallow(e);
      run(e.shiftKey ? 'panes.prevPane' : 'panes.nextPane');
      return;
    }
    if (e.key === 'F10' && !mods && !e.shiftKey) {
      swallow(e);
      startKeytips();
      return;
    }
    if (e.key === 'F1' && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      swallow(e);
      run('frame.tabRow.collapse');
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !/^Numpad/.test(e.code ?? '')) {
      const ch = charOf(e);
      if (!ch) return;
      if (/^[1-9]$/.test(ch) && !inBackstage) {
        const el = document.querySelector(`[data-ribbon] [data-qat] [data-keytip="${ch}"]`);
        if (!el) return;
        swallow(e);
        pressed.push(el.dataset.feature);
        act(el.querySelector('[data-part="main"]') ?? el);
        return;
      }
      if (!startKeytips()) return;
      const r = press(m, ch, entries);
      if (r.act === 'miss') {
        endKeytips();
        return;
      }
      swallow(e);
      setM(r.m);
      if (r.act === 'press') pressEntry(r.entry);
      return;
    }
    if (e.target.closest?.('[data-ribbon]') && ribbonKey(e)) e.stopPropagation();
  };
  const up = (e) => {
    if (e.key !== 'Alt') return;
    const tap = armed;
    armed = false;
    if (!tap || isMac() || (!keytipsOn() && (dialogOpen() || menuOpen()))) return;
    e.preventDefault();
    toggleKeytips();
  };
  const reset = () => {
    armed = false;
  };
  const pointer = (e) => {
    armed = false;
    if (!acting && keytipsOn()) endKeytips();
  };
  const relayout = () => keytipsOn() && setM(m);
  window.addEventListener('keydown', down, true);
  window.addEventListener('keyup', up, true);
  window.addEventListener('blur', reset);
  window.addEventListener('pointerdown', pointer, true);
  window.addEventListener('resize', relayout);
  return () => {
    window.removeEventListener('keydown', down, true);
    window.removeEventListener('keyup', up, true);
    window.removeEventListener('blur', reset);
    window.removeEventListener('pointerdown', pointer, true);
    window.removeEventListener('resize', relayout);
    endKeytips();
  };
}

/** Where a badge sits for `el`: under a tab or button, centred; at the left of a menu item. */
function spot(el) {
  const r = el.getBoundingClientRect();
  if (el.closest('[role="menu"]')) return { left: r.left + 6, top: r.top + r.height / 2 - 8, x: '0' };
  return { left: r.left + r.width / 2, top: r.bottom - 9, x: '-50%' };
}

/** The badges, drawn over everything while KeyTips show; those that no longer match what was typed dim. */
export function KeyTipsLayer() {
  useSyncExternalStore(subscribe, () => version);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!keytipsOn()) return undefined;
    const t = setTimeout(() => tick((n) => n + 1), 120); // after the tab's controls settle (adaptive groups)
    return () => clearTimeout(t);
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!keytipsOn()) return null;
  const live = new Set(matching(m, entries));
  return createPortal(
    <div data-keytips="" className="pointer-events-none fixed inset-0 z-[100]">
      {entries.filter((e) => e.el.isConnected).map((e, i) => {
        const at = spot(e.el);
        return (
          <span key={i} data-keytip-badge={e.keys} data-for={e.el.dataset.feature ?? e.el.dataset.tab ?? e.el.dataset.groupButton ?? undefined}
            data-derived={e.derived || undefined} style={{ left: at.left, top: at.top, transform: `translateX(${at.x})` }}
            className={`absolute rounded-xs border border-foreground/30 bg-popover px-1 text-[11px] leading-[15px] font-semibold text-popover-foreground shadow-sm ${live.has(e) ? '' : 'opacity-30'}`}>
            {tokens(e.keys).join('')}
          </span>
        );
      })}
    </div>,
    document.body,
  );
}

// Harness cases read what KeyTips show and pressed.
if (typeof window !== 'undefined') {
  window.__word = Object.assign(window.__word ?? {}, {
    keytips: { on: keytipsOn, shown: () => entries.map((e) => [e.keys, e.el.dataset.feature ?? e.el.dataset.tab ?? e.el.dataset.groupButton ?? e.label]), pressed: () => [...pressed], start: startKeytips, end: endKeytips },
  });
}
