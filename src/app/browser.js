import { saveSettings } from './actions.js';
import { keyAmong } from './keybinds.js';
import { getState, setState } from './store.js';
import { openWorkspace } from './views.js';

// The in-app browser (SPEC §7j): tabs in the persistent `persist:browser` session (cookies and logins survive restarts), the
// tab list kept in `settings.browser` {tabs: [{id, url, title, zoom?, place?}], active}, the floating pane's state in `settings.browserPane`
// {open, place}. The browser page, the tab strip and the pane are components/BrowserPage.jsx.

const state = getState();
export const HOME = 'https://www.google.com/';
const EMPTY = { tabs: [], active: null };

/** The address bar's text as a URL: a scheme or a host → that URL, anything else → a Google search. */
export function toUrl(text) {
  const t = text.trim();
  if (!t) return HOME;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  if (/^(localhost|[^\s/?#]+\.[^\s/?#]+)(:\d+)?([/?#]|$)/i.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

let timer = null;
function set(browser) {
  setState({ browser });
  clearTimeout(timer); // ponytail: trailing 300 ms write; a close inside it loses the last title or URL change
  timer = setTimeout(() => saveSettings({ browser: state.browser }), 300);
}

/** A new tab at `url` (Google by default), made active; returns its id. */
export function newTab(url = HOME) {
  const id = crypto.randomUUID();
  set({ tabs: [...state.browser.tabs, { id, url, title: '' }], active: id });
  return id;
}

/** Closes tab `id`; the one after it (else before) becomes active. */
export function closeTab(id) {
  const { tabs, active } = state.browser;
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const rest = tabs.filter((t) => t.id !== id);
  set({ tabs: rest, active: active === id ? (rest[i] ?? rest[i - 1])?.id ?? null : active });
  if (state.settings.browserPanes?.some((p) => p.tab === id)) setPanes(openPanes()); // its pane goes with it
}

export const activateTab = (id) => set({ ...state.browser, active: id });
export const updateTab = (id, patch) => set({ ...state.browser, tabs: state.browser.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

// Page zoom per tab (`tab.zoom`, kept with the tabs; none: DEFAULT_ZOOM), in Chrome's steps. Ctrl+wheel, Ctrl+= / Ctrl+- / Ctrl+0.
export const DEFAULT_ZOOM = 0.75;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const zoomOf = (tab) => tab?.zoom ?? DEFAULT_ZOOM;

/** Tab `id` zoomed one step in (`dir` 1) or out (-1), or back to the default (0); its page follows (WebTab). */
export function zoomTab(id, dir) {
  const tab = state.browser.tabs.find((t) => t.id === id);
  if (!tab) return;
  const z = zoomOf(tab);
  const next = dir === 0 ? DEFAULT_ZOOM
    : dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) ?? z : ZOOM_STEPS.findLast((s) => s < z - 0.001) ?? z;
  updateTab(id, { zoom: next });
}

/** The tabs' <webview> elements by tab id, registered by BrowserPage. */
export const views = new Map();

// The browser's commands by binding (§7k keybinds; defaults Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+R / F5, Alt+Left / Alt+Right, and
// Ctrl+= / Ctrl+- / Ctrl+0 for the tab's zoom), on tab `id`: the browser page's, or the pane's the key came from. A new tab
// opens where the key was pressed: on the browser page, or in a new pane over another page.
const KEYS = {
  'browser.newTab': () => (state.view.type === 'browser' ? newTab() : openPane(null, HOME)),
  'browser.closeTab': (id) => closeTab(id),
  'browser.address': (id) => document.querySelector(state.view.type === 'browser' ? '[data-browser-page] [data-browser-address]'
    : `[data-tab-frame="${id}"] [data-browser-address]`)?.focus(),
  'browser.reload': (id) => views.get(id)?.reload(),
  'browser.back': (id) => views.get(id)?.goBack(),
  'browser.forward': (id) => views.get(id)?.goForward(),
  'browser.zoomIn': (id) => zoomTab(id, 1),
  'browser.zoomOut': (id) => zoomTab(id, -1),
  'browser.zoomReset': (id) => zoomTab(id, 0),
};

/** A browser key on tab `tab` (default: the active one): a key event on the browser page or a pane, or a chord a page forwarded
 * (main.js). Returns whether it was one. */
export function browserKey(e, tab = state.browser.active) {
  const id = keyAmong(Object.keys(KEYS), e);
  if (id) KEYS[id](tab);
  return !!id;
}

/** The tab whose page is web contents `wcId` (a forwarded key or wheel zoom), else the active one. */
function tabOfContents(wcId) {
  for (const [id, v] of views) {
    try {
      if (v.getWebContentsId() === wcId) return id;
    } catch { /* not attached yet */ }
  }
  return state.browser.active;
}

/** The Browser tab or Ctrl+Alt+B: shows the browser page; `url` opens a new tab. With no tabs the page stays empty (its New tab
 * button), unless settings.browserAutoTab opens one on Google. */
export function openBrowser(url, opts) {
  if (url) newTab(url);
  else if (!state.browser.tabs.length && state.settings.browserAutoTab) newTab();
  return openWorkspace({ type: 'browser' }, opts);
}

// The floating panes (§7j): settings.browserPanes = [{tab, place}], one per tab shown over a page, in stacking order (the last on
// top); place as the assistant panel's (panel.mjs), null for the default. An old settings.browserPane ({open, place}: one pane
// on the active tab) counts as one until the list is first saved.

const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 13;

/** A new pane's place: the viewport's top-right below the tab strip, 48 × 40 rem. */
export const defaultPlace = () => ({ x: 'right', dx: 0.5 * rem(), y: 'top', dy: 2.75 * rem(), w: 48 * rem(), h: 40 * rem() });

/** The open panes, on tabs that exist, bottom to top. */
export function openPanes() {
  const s = state.settings ?? {}; // the first render comes before the settings load
  const list = Array.isArray(s.browserPanes) ? s.browserPanes
    : s.browserPane?.open && state.browser.active ? [{ tab: state.browser.active, place: s.browserPane.place ?? null }] : [];
  return list.filter((p) => state.browser.tabs.some((t) => t.id === p.tab));
}
const setPanes = (list) => saveSettings({ browserPanes: list });

/** Pane of tab `tab` brought to the top (a press or the focus in it). */
export function raisePane(tab) {
  const list = openPanes();
  const own = list.find((p) => p.tab === tab);
  if (own && list.at(-1) !== own) setPanes([...list.filter((p) => p !== own), own]);
}
/** Minimizes the pane of tab `tab`; its place stays on the tab (`tab.place`), so the pane reopens there at the same size. */
export function closePane(tab) {
  const own = openPanes().find((p) => p.tab === tab);
  if (own?.place) updateTab(tab, { place: own.place });
  return setPanes(openPanes().filter((p) => p !== own));
}
export const closePanes = () => setPanes([]);
export const placePane = (tab, place) => setPanes(openPanes().map((p) => (p.tab === tab ? { ...p, place } : p)));

/** A tab over a page other than the browser page (the strip's tab or +, a page's new-tab link, New browser window): tab `id`,
 * else a new one at `url` (else the active one, else a new one on Google), in its pane, on top and with the focus in the page.
 * A tab without a pane gets one at the place it was minimized at (placePanel fits it to the viewport), else 2 rem down and in
 * from the top pane (or at the default place). */
export async function openPane(id = null, url = null) {
  if (url) newTab(url);
  else if (id) activateTab(id);
  else if (!state.browser.tabs.length) newTab();
  const tab = state.browser.active;
  const list = openPanes();
  const own = list.find((p) => p.tab === tab);
  const top = list.at(-1);
  const step = 2 * rem();
  const from = top && (top.place ?? defaultPlace());
  const saved = state.browser.tabs.find((t) => t.id === tab)?.place;
  const pane = own ?? { tab, place: saved ?? (from ? { ...from, dx: from.dx + step, dy: from.dy + step } : null) };
  if (top !== pane) await setPanes([...list.filter((p) => p !== own), pane]);
  requestAnimationFrame(() => views.get(tab)?.focus());
}

/** Startup: the tabs of the last session, and the events of the pages (a new-tab link, a key pressed in a page). */
export function initBrowser() {
  const b = state.settings.browser;
  const tabs = (Array.isArray(b?.tabs) ? b.tabs : []).filter((t) => typeof t?.id === 'string' && typeof t.url === 'string')
    .map((t) => ({ id: t.id, url: t.url, title: typeof t.title === 'string' ? t.title : '', ...(Number.isFinite(t.zoom) && { zoom: t.zoom }),
      ...(t.place && typeof t.place === 'object' && { place: t.place }) }));
  setState({ browser: tabs.length ? { tabs, active: tabs.some((t) => t.id === b.active) ? b.active : tabs[0].id } : EMPTY });
  window.api.browser.onEvent((ev) => {
    if (ev.type === 'key') browserKey(ev.chord, tabOfContents(ev.wcId));
    else if (ev.type === 'zoom') zoomTab(tabOfContents(ev.wcId), ev.dir);
    else if (state.view.type === 'browser') newTab(ev.url); // 'open': a new-tab link
    else openPane(null, ev.url); // never leaves the page shown
  });
}
