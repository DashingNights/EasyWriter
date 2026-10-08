import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { ArrowLeft, ArrowRight, Check, ExternalLink, GripHorizontal, Minus, Plus, RotateCw, Scaling, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { anchorPanel, dragPanel, placePanel } from '../assistant/panel.mjs';
import { withKey } from '../keybinds.js';
import {
  activateTab, browserKey, closePane, closeTab, DEFAULT_ZOOM, defaultPlace, HOME, newTab, openPane, openPanes, placePane, raisePane, toUrl, updateTab, views,
  zoomOf, zoomTab,
} from '../browser.js';
import { getState, useStore } from '../store.js';
import { useViewportBox } from '../viewport.js';
import { closeWorkspace } from '../views.js';
import { SidebarButton } from './Sidebar.jsx';
import { Tip } from './Tip.jsx';
import { keepFocus } from './Toolbar.jsx';

const label = (t) => t.title || t.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') || 'New tab';
const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 13;
const CORNER = 10; // px from a corner of the pane that resizes it
const NOTCH = 2; // the notch's height (rem): the pane's controls
const NOTCH_FLOOR = 40; // the unfocused notch's least opacity (percent) while settings.browserNotchFloor
// The notch's inverse curves: a concave fillet of FLARE px at each foot, where the notch meets the pane's top edge. The card
// fills the square outside a circle centred on its outer top corner and the border ring (translucent, as the pane's own border
// over its card) runs along that circle, so the pane's top edge sweeps up into the notch's side.
const FLARE = 10;
const flare = (side) => {
  const at = `circle at ${side === 'left' ? '0 0' : '100% 0'}`;
  const R = FLARE;
  return {
    position: 'absolute', bottom: 0, [side]: -R, width: R, height: R, pointerEvents: 'none',
    background: `radial-gradient(${at}, transparent ${R - 1.5}px, var(--border) ${R - 0.5}px, var(--border) ${R}px, transparent ${R + 0.75}px),`
      + ` radial-gradient(${at}, transparent ${R - 1.5}px, var(--card) ${R - 0.5}px)`,
  };
};
// Resize mode's handles, as a canvas item's (whiteboard.js .wb-handle): [id, position, cursor]; corners 12 px, edges 10 px.
const HANDLES = [['nw', 'top-0 left-0', 'cursor-nwse-resize'], ['n', 'top-0 left-1/2', 'cursor-ns-resize'], ['ne', 'top-0 left-full', 'cursor-nesw-resize'],
  ['e', 'top-1/2 left-full', 'cursor-ew-resize'], ['se', 'top-full left-full', 'cursor-nwse-resize'], ['s', 'top-full left-1/2', 'cursor-ns-resize'],
  ['sw', 'top-full left-0', 'cursor-nesw-resize'], ['w', 'top-1/2 left-0', 'cursor-ew-resize']];

/** One tab's page: a <webview> in the persistent browser session. `src` is set once at mount (a re-render setting it again
 * would reload the page); an inactive tab is hidden, not unmounted, so it keeps running. Its zoom follows `tab.zoom` once the
 * page is ready (a webview takes no zoom before its first dom-ready). */
function WebTab({ tab, shown }) {
  const ref = useRef(null);
  const [src] = useState(tab.url);
  const [ready, setReady] = useState(false);
  const zoom = zoomOf(tab);
  useEffect(() => {
    const el = ref.current;
    views.set(tab.id, el);
    const url = (e) => updateTab(tab.id, { url: e.url });
    const title = (e) => updateTab(tab.id, { title: e.title });
    const onReady = () => setReady(true);
    el.addEventListener('did-navigate', url);
    el.addEventListener('did-navigate-in-page', url);
    el.addEventListener('page-title-updated', title);
    el.addEventListener('dom-ready', onReady);
    return () => {
      views.delete(tab.id);
      el.removeEventListener('did-navigate', url);
      el.removeEventListener('did-navigate-in-page', url);
      el.removeEventListener('page-title-updated', title);
      el.removeEventListener('dom-ready', onReady);
    };
  }, [tab.id]);
  useEffect(() => {
    if (ready) ref.current.setZoomFactor(zoom);
  }, [ready, zoom]);
  return <webview ref={ref} src={src} partition="persist:browser" allowpopups="" className={cn('absolute inset-0', !shown && 'invisible')} />;
}

/** The address bar: the tab's URL, or the text being typed; Enter loads it (a search when it is no URL), Escape restores the
 * URL (and goes no further: a canvas being edited would close). `compact` (the pane's notch): only the domain shows until the box
 * is clicked, then the whole URL, in the same width. */
function AddressBar({ tab, compact = false, className }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const url = tab?.url ?? '';
  useEffect(() => {
    if (!editing) setText(url);
  }, [url, editing]);
  const go = (e) => {
    const target = toUrl(text);
    if (tab) views.get(tab.id)?.loadURL(target);
    else newTab(target);
    e.target.blur();
    requestAnimationFrame(() => views.get(tab?.id)?.focus()); // the page gets the keys again (a new tab's view mounts first)
  };
  return (
    <Input data-browser-address aria-label="Address" spellCheck={false} value={compact && !editing ? hostOf(url) || url : text} title={compact ? url : undefined}
      className={cn('min-w-0 text-xs', compact ? 'h-6 px-2 md:text-xs' : 'h-7 flex-1', className)} placeholder={compact ? 'Search or URL' : 'Search Google or type a URL'}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => {
        setEditing(true);
        setText(url);
        requestAnimationFrame(() => e.target.select());
      }}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') go(e);
        else if (e.key === 'Escape') {
          e.preventDefault();
          setText(url);
          e.target.blur();
        }
      }} />
  );
}

const tip = (title, button) => <Tip title={title}>{button}</Tip>;

/** Back, Forward and Reload for `tab`. */
function NavButtons({ tab }) {
  const view = () => views.get(tab?.id);
  return (
    <>
      {tip(withKey('Back', 'browser.back'), <Button variant="ghost" size="icon-xs" aria-label="Back" onMouseDown={keepFocus} onClick={() => view()?.goBack()}><ArrowLeft /></Button>)}
      {tip(withKey('Forward', 'browser.forward'), <Button variant="ghost" size="icon-xs" aria-label="Forward" onMouseDown={keepFocus} onClick={() => view()?.goForward()}><ArrowRight /></Button>)}
      {tip(withKey('Reload', 'browser.reload'), <Button variant="ghost" size="icon-xs" aria-label="Reload" onMouseDown={keepFocus} onClick={() => view()?.reload()}><RotateCw /></Button>)}
    </>
  );
}

/** The zoom (while it is not the default: Reset zoom) and Open in default browser, for `tab`. */
function PageButtons({ tab }) {
  return (
    <>
      {tab && zoomOf(tab) !== DEFAULT_ZOOM && tip(withKey('Reset zoom', 'browser.zoomReset'), (
        <Button variant="ghost" size="xs" className="h-6 px-1.5 tabular-nums" aria-label="Reset zoom" onMouseDown={keepFocus} onClick={() => zoomTab(tab.id, 0)}>
          {Math.round(zoomOf(tab) * 100)}%
        </Button>
      ))}
      {tip('Open this page in your default browser', <Button variant="ghost" size="icon-xs" aria-label="Open in default browser" disabled={!tab} onMouseDown={keepFocus} onClick={() => window.open(tab.url)}><ExternalLink /></Button>)}
    </>
  );
}

/** The browser page's second header row: Back, Forward, Reload, the address bar, the zoom and Open in default browser. */
function NavBar({ tab }) {
  return (
    <>
      <NavButtons tab={tab} />
      <AddressBar tab={tab} />
      <PageButtons tab={tab} />
    </>
  );
}

/** The browser's tabs (SPEC §7j). `shown`: the browser page's header row, the active tab highlighted. Otherwise the strip
 * over another page's viewport (App.jsx): a tab shows its floating pane, or minimizes it while shown (then highlighted), + opens
 * a new tab there. */
export function TabStrip({ shown = false }) {
  const { tabs, active } = useStore((s) => s.browser);
  useStore((s) => s.settings?.browserPanes);
  const inPane = new Set(openPanes().map((p) => p.tab));
  return (
    <div role="tablist" aria-label="Browser tabs" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
      {tabs.map((t) => {
        const on = shown ? t.id === active : inPane.has(t.id);
        return (
          <div key={t.id} role="tab" aria-selected={on} title={t.url} onMouseDown={keepFocus}
            onClick={() => (shown ? activateTab(t.id) : on ? closePane(t.id) : openPane(t.id))}
            onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
            className={cn('flex h-7 w-44 shrink-0 cursor-default items-center gap-1 rounded-md pl-2 pr-0.5', on ? 'bg-accent' : 'hover:bg-accent/50')}>
            <span className="min-w-0 flex-1 truncate">{label(t)}</span>
            <Button variant="ghost" size="icon-xs" aria-label="Close tab" onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}><X /></Button>
          </div>
        );
      })}
      <Tip title={withKey('New tab', 'browser.newTab')}>
        <Button variant="ghost" size="icon-xs" aria-label="New tab" onMouseDown={keepFocus} onClick={() => (shown ? newTab() : openPane(null, HOME))}><Plus /></Button>
      </Tip>
    </div>
  );
}

/** The browser page (SPEC §7j): the tab strip, the address row, then the slot the web layer covers with the active tab's page.
 * Always mounted like the editor page, hidden and inert behind the other pages. */
export function BrowserPage({ shown }) {
  const { tabs, active } = useStore((s) => s.browser);
  const tab = tabs.find((t) => t.id === active);
  useEffect(() => {
    if (shown) requestAnimationFrame(() => views.get(active)?.focus()); // after openWorkspace's own focus of the page
  }, [shown, active]);
  return (
    <div id={shown ? 'workspace-root' : undefined} data-browser-page data-viewport={shown ? '' : undefined} tabIndex={-1} inert={!shown}
      className={cn('absolute inset-0 z-10 flex flex-col bg-background outline-none', !shown && 'invisible pointer-events-none')}
      onKeyDown={(e) => browserKey(e) && e.preventDefault()}>
      <header className="shrink-0 border-b text-xs">
        <div className="flex min-h-9 items-start gap-1 px-1 py-0.5">
          <SidebarButton />
          <TabStrip shown />
          <Tip title="Back to the open draft">
            <Button variant="outline" size="xs" onMouseDown={keepFocus} onClick={() => closeWorkspace()}>Back to editor</Button>
          </Tip>
        </div>
        <div className="flex h-9 items-center gap-1 px-1">
          <NavBar tab={tab} />
        </div>
      </header>
      <div data-web-slot className="relative min-h-0 flex-1">
        {!tabs.length && (
          <div className="flex h-full items-center justify-center">
            <Button variant="outline" size="sm" onClick={() => newTab()}><Plus />New tab</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The browser page's slot ([data-web-slot]) relative to the main column's area while `on`, following its resizes. */
function useSlotBox(on) {
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    if (!on) return undefined;
    const area = document.querySelector('main > div');
    const slot = document.querySelector('[data-web-slot]');
    const measure = () => {
      const a = area.getBoundingClientRect();
      const s = slot.getBoundingClientRect();
      setBox({ left: s.left - a.left, top: s.top - a.top, width: s.width, height: s.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [area, slot]) ro.observe(el);
    return () => ro.disconnect();
  }, [on]);
  return on ? box : null;
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
/** A signed-in tab's next stop: its `continue` URL only when that is https on Google or YouTube (a javascript: URL would run in
 * the page, any other site is an open redirect), else null (reload). */
const safeContinue = (url) => {
  try {
    const to = new URL(new URL(url).searchParams.get('continue'));
    return to.protocol === 'https:' && /(^|\.)(google|youtube)\.com$/.test(to.hostname) ? to.href : null;
  } catch {
    return null;
  }
};

// Sign in with Chrome (SPEC §7j): the running state lives here, not in the bar, so a remounted bar still shows it.
let signingIn = false;
const signInSubs = new Set();
const setSigningIn = (v) => { signingIn = v; for (const fn of signInSubs) fn(); };
const useSigningIn = () => useSyncExternalStore((fn) => { signInSubs.add(fn); return () => signInSubs.delete(fn); }, () => signingIn);

/** Runs the flow (main.js browser.chromeSignIn) for tab `id`. After the import the tab moves on only if it is still on
 * accounts.google.com: to a safe `continue` URL, else a reload. */
async function signInWithChrome(id) {
  if (signingIn) return;
  setSigningIn(true);
  try {
    const r = await window.api.browser.chromeSignIn();
    if (!r.ok) return void toast.error(r.error);
    if (!r.google) return void toast(`No Google sign-in found in ${r.browser}.`);
    toast.success('Signed in to Google');
    const tab = getState().browser.tabs.find((t) => t.id === id);
    if (!tab || hostOf(tab.url) !== 'accounts.google.com') return;
    const to = safeContinue(tab.url);
    if (to) views.get(id)?.loadURL(to);
    else views.get(id)?.reload();
  } catch (e) {
    toast.error(String(e.message || e));
  } finally {
    setSigningIn(false);
  }
}

/** Google refuses sign-in inside embedded browsers, so on an accounts.google.com tab a slim bar above the page hands sign-in to
 * a real Chrome or Edge. In the floating pane it is a box of its own, so it does not double the page's border. */
function GoogleSignInBar({ tab, floating }) {
  const running = useSigningIn();
  return (
    <div className={cn('flex shrink-0 items-center gap-2 bg-muted/50 px-3 py-1.5 text-xs', floating ? 'mb-1.5 rounded-md border' : 'border-b')}>
      <span className="min-w-0 flex-1 text-muted-foreground">
        {running ? 'Waiting for the sign-in window. Close it when you have signed in.' : 'Google does not allow sign-in inside apps.'}
      </span>
      <Button size="xs" disabled={running} onMouseDown={keepFocus} onClick={() => signInWithChrome(tab.id)}>Sign in with Chrome</Button>
    </div>
  );
}

/** Where the tabs' pages show (SPEC §7j): a frame per tab, each holding the tab's <webview>, never moved in the DOM (a moved
 * webview reloads its page). The layer is a stacking context over the main column: under the chrome on the browser page (z 11,
 * the active tab's frame covering the page's slot), over all of it elsewhere (z 44, below menus and dialogs), where every tab with
 * an open pane (settings.browserPanes) is a floating pane, stacked in that list's order. Other frames are hidden and inert, their
 * pages still running. */
export function WebLayer() {
  const page = useStore((s) => s.view.type === 'browser');
  const { tabs, active } = useStore((s) => s.browser);
  useStore((s) => s.settings?.browserPanes);
  useStore((s) => s.settings?.browserPane);
  const panes = openPanes();
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: page ? 11 : 44 }}>
      {tabs.map((t) => {
        const i = panes.findIndex((p) => p.tab === t.id);
        const mode = page ? (t.id === active ? 'page' : 'hidden') : i >= 0 ? 'pane' : 'hidden';
        return <TabFrame key={t.id} tab={t} mode={mode} place={panes[i]?.place ?? null} z={i + 1} />;
      })}
    </div>
  );
}

/** One tab's frame. `mode` 'page' (the browser page's slot), 'pane' (floating at `place`, stacked at `z`) or 'hidden'. The pane
 * is the page under a notch on its top edge: Back, Forward, Reload and the compact address bar at the notch's left, the grip in
 * the middle (the notch and the pane's border move it), the zoom, Open in default browser, the resize mode toggle and the yellow
 * minimize button (closes the pane; the tab stays in the strip) at its right. Resizable from its corners like the assistant's
 * panel, its place kept in settings.browserPanes; without the focus it is drawn at settings.browserIdleOpacity (no blur; the
 * notch at NOTCH_FLOOR or more while settings.browserNotchFloor) and click-through except for its notch. */
function TabFrame({ tab, mode, place, z }) {
  const floating = mode === 'pane';
  const shown = mode !== 'hidden';
  const idle = useStore((s) => s.settings?.browserIdleOpacity) ?? 70;
  const notchFloor = useStore((s) => s.settings?.browserNotchFloor) !== false;
  const vp = useViewportBox(floating);
  const slot = useSlotBox(mode === 'page');
  const [live, setLive] = useState(null); // the pane's rect while dragged or resized, until its place is saved
  const [focused, setFocused] = useState(false);
  const [resizing, setResizing] = useState(false); // resize mode: the outline and handles, the page covered
  const ref = useRef(null);
  const drag = useRef(null);
  const last = useRef({ inset: 0 }); // the box kept while hidden, so the page keeps its size
  const focusPage = () => views.get(tab.id)?.focus();
  useEffect(() => { // whether the focus is in this pane (its page included): a press elsewhere takes it out, and after any
    // focus change the focused element decides (a page taking the focus fires no focusin here, only the window's blur)
    if (!floating) return undefined;
    // While the strip's tabs are held the pane keeps its look: the tab's click decides (openPane focuses, closePane minimizes),
    // and the page's lost focus would make it see-through until then.
    let strip = false;
    const check = () => requestAnimationFrame(() => !strip && setFocused(!!ref.current?.contains(document.activeElement)));
    const press = (e) => {
      strip = !!e.target.closest?.('[data-browser-tabs]');
      if (!strip && !ref.current.contains(e.target)) setFocused(false);
    };
    const release = () => { strip = false; };
    check();
    const on = [['pointerdown', press, true], ['pointerup', release, true], ['focusin', check, true], ['focusout', check, true], ['blur', check], ['focus', check]];
    for (const [type, fn, capture] of on) addEventListener(type, fn, capture);
    return () => {
      for (const [type, fn, capture] of on) removeEventListener(type, fn, capture);
    };
  }, [floating]);
  useEffect(() => { // the focused pane goes on top
    if (floating && focused) raisePane(tab.id);
  }, [floating, focused]);

  useEffect(() => { // resize mode ends with Enter or Escape (the pane holds the focus meanwhile) or a press outside the pane
    if (!floating || !resizing) return undefined;
    ref.current.focus();
    const key = (e) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation(); // a canvas being edited keeps Canvas Mode
      setResizing(false);
      focusPage();
    };
    const press = (e) => !ref.current.contains(e.target) && setResizing(false);
    addEventListener('keydown', key, true);
    addEventListener('pointerdown', press, true);
    return () => {
      removeEventListener('keydown', key, true);
      removeEventListener('pointerdown', press, true);
    };
  }, [floating, resizing]);
  useEffect(() => {
    if (!floating) setResizing(false);
  }, [floating]);

  useEffect(() => { // Ctrl+wheel on the pane's chrome zooms its page, as on the page itself (main.js zoom-changed); not passive,
    // so the window gets no wheel zoom of its own
    const el = ref.current;
    const wheel = (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.deltaY) return;
      e.preventDefault();
      zoomTab(tab.id, -Math.sign(e.deltaY));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const r0 = rem();
  const m = 0.5 * r0; // kept to every viewport edge
  const min = { w: 26 * r0, h: 14 * r0 };
  // The pane is placed in the viewport less the notch's height at its top, so the notch above the pane stays in view.
  const notch = NOTCH * r0;
  const area = vp && { left: vp.left, top: vp.top + notch, width: vp.width, height: vp.height - notch };
  const r = floating && area ? live ?? placePanel(place ?? defaultPlace(), area, min, m) : null;
  if (r) last.current = { left: area.left + r.left, top: area.top + r.top, width: r.width, height: r.height };
  else if (mode === 'page' && slot) last.current = slot;
  // Without the focus the pane is see-through (settings.browserIdleOpacity) and click-through: only its notch takes a press,
  // which gives it the focus again (or starts a move). The notch keeps NOTCH_FLOOR percent or more while
  // settings.browserNotchFloor (default on), so its controls stay findable over the page.
  const idleNow = floating && !focused && !live && !resizing;
  // The frame fades to the notch's opacity and the card further, to the idle opacity: one group, so where the notch covers the
  // card's top edge the two do not stack into a darker line.
  const notchIdle = notchFloor ? Math.max(idle, NOTCH_FLOOR) : idle;
  const style = { ...last.current, opacity: idleNow ? notchIdle / 100 : undefined, zIndex: floating ? z : undefined };

  const cornerAt = (e) => {
    if (e.target.closest('button, input, [data-notch]')) return null;
    const b = ref.current.getBoundingClientRect();
    const h = e.clientX - b.left < CORNER ? 'w' : b.right - e.clientX < CORNER ? 'e' : '';
    const v = e.clientY - b.top < CORNER ? 'n' : b.bottom - e.clientY < CORNER ? 's' : '';
    return h && v ? v + h : null;
  };
  // Corners and resize mode's handles resize; the notch and the pane's border (not their buttons or address bar) move it.
  const onPointerDownCapture = (e) => {
    if (!r || e.button) return;
    if (!resizing && !e.target.closest('input, [data-resize-toggle]')) focusPage(); // a press on the chrome focuses the page
    const corner = e.target.closest('[data-handle]')?.dataset.handle ?? cornerAt(e);
    const grip = e.target === ref.current || e.target.hasAttribute('data-card') || (e.target.closest('[data-grip]') && !e.target.closest('button, input'));
    if (!corner && !grip) return;
    e.preventDefault();
    ref.current.setPointerCapture(e.pointerId);
    drag.current = { corner, x: e.clientX, y: e.clientY, r, last: null };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (d) return setLive((d.last = dragPanel(d.r, d.corner, e.clientX - d.x, e.clientY - d.y, area, min, m)));
    if (!r) return undefined;
    const corner = cornerAt(e);
    ref.current.style.cursor = corner ? (corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize') : '';
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.last) placePane(tab.id, anchorPanel(d.last, area)).finally(() => setLive(null)); // a click moves nothing
  };

  return (
    <div ref={ref} data-tab-frame={tab.id} data-browser-pane={floating ? '' : undefined} role={floating ? 'region' : undefined}
      aria-label={floating ? `Browser: ${label(tab)}` : undefined} inert={!shown} style={style} tabIndex={-1}
      className={cn('absolute', floating && 'text-xs',
        resizing ? 'outline-2 outline-offset-1 outline-[#3d99f5]' : 'outline-none', shown && !idleNow ? 'pointer-events-auto' : 'pointer-events-none',
        !shown && 'invisible')}
      onPointerDownCapture={onPointerDownCapture} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onLostPointerCapture={onPointerUp}
      onKeyDown={(e) => browserKey(e, tab.id) && e.preventDefault()}>
      {/* The card: the pane's box and its page. It comes first, so the notch paints over its top border. */}
      <div data-card style={{ opacity: idleNow && idle < notchIdle ? idle / notchIdle : undefined }}
        className={cn('absolute inset-0 flex flex-col', floating && 'rounded-island border bg-card p-1.5 shadow-xl')}>
        {shown && hostOf(tab.url) === 'accounts.google.com' && <GoogleSignInBar tab={tab} floating={floating} />}
        {/* While the pane is dragged its page takes no pointer events, so the drag never stops over it. */}
        <div className={cn('relative min-h-0 flex-1 overflow-hidden', floating && 'rounded-md border', (live || resizing || idleNow) && 'pointer-events-none')}>
          <WebTab tab={tab} shown={shown} />
          {resizing && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#3d99f5]/15 text-sm font-medium select-none">
              <span className="rounded-md bg-card px-3 py-1.5 shadow">Drag the blue squares to resize. Press Enter or Esc when done.</span>
            </div>
          )}
        </div>
      </div>
      {floating && (
        // The notch: a tab on the pane's top edge with the pane's controls; its empty middle (the grip) moves the pane.
        // Its feet keep a corner radius plus a flare from the pane's sides, so on a narrow pane the flares stay on the straight
        // top edge and never stick out past the rounded corners. It overlaps the card by 2 px: the card's border and 1 px in.
        <div data-grip data-notch
          style={{ height: `${NOTCH}rem`, width: `min(44rem, calc(100% - 2 * (var(--radius-island) + ${FLARE}px)))` }}
          className="pointer-events-auto absolute bottom-[calc(100%-2px)] left-1/2 flex -translate-x-1/2 cursor-move items-center gap-0.5 rounded-t-lg border border-b-0 bg-card px-1 select-none">
          <span aria-hidden style={flare('left')} />
          <span aria-hidden style={flare('right')} />
          <NavButtons tab={tab} />
          <AddressBar tab={tab} compact className="w-[clamp(5rem,30%,14rem)] shrink" />
          <span className="flex min-w-6 flex-1 justify-center"><GripHorizontal className="size-4 text-muted-foreground" /></span>
          <PageButtons tab={tab} />
          <Tip title={resizing ? 'Done resizing (Enter)' : 'Resize the pane'}>
            <Button variant="ghost" size="icon-xs" data-resize-toggle aria-label={resizing ? 'Done resizing' : 'Resize the pane'} aria-pressed={resizing}
              className={cn(resizing && 'bg-[#3d99f5] text-white hover:bg-[#3d99f5]/90 hover:text-white')} onMouseDown={keepFocus}
              onClick={() => {
                setResizing(!resizing);
                if (resizing) focusPage();
              }}>
              {resizing ? <Check /> : <Scaling />}
            </Button>
          </Tip>
          <Tip title="Minimize (the tab stays in the strip)">
            <button type="button" aria-label="Minimize pane" onMouseDown={keepFocus} onClick={() => closePane(tab.id)}
              className="mx-1 grid size-3.5 shrink-0 place-items-center rounded-full bg-[#febc2e] text-[#8a5300] ring-1 ring-black/15 hover:brightness-95">
              <Minus className="size-2.5" strokeWidth={3} />
            </button>
          </Tip>
        </div>
      )}
      {floating && resizing && HANDLES.map(([id, at, cursor]) => (
        <div key={id} data-handle={id} className={cn('absolute z-10 box-border rounded-[2px] border-2 border-white bg-[#3d99f5]', at, cursor,
          id.length === 2 ? 'size-[12px] -m-[6px]' : 'size-[10px] -m-[5px]')} />
      ))}
    </div>
  );
}
