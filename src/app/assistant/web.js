import { fail } from '../commands/define.mjs';
import { MAX_TABS, newTab, searchUrl, views } from '../browser.js';
import { getState, setState } from '../store.js';

// The browser work of web.search and browser.read (commands/web.mjs, SPEC §7j Agent tabs): each agent source gets one tab of its
// own (browser.js newTab with `agent`), which a search or a page to read navigates; the tabs show in the browser island and take no
// focus. The readers below run inside the page (webview.executeJavaScript), so each is self-contained: it goes as source text.

const state = getState();
const LOAD_MS = 20000; // a page that is still loading after this is read as it is
const RESULTS_MS = 5000; // how long a search waits for results to appear once its page has loaded
const SCRIPT_MS = 8000; // a reader that does not answer in this time (a page busy in a loop) fails the call

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stopped = (signal) => signal?.aborted && fail('cancelled', 'The call was cancelled');

/** The value of `fn()` (it may be async) once it is truthy, checked every `step` ms, else null after `ms`. */
async function until(fn, ms, signal, step = 150) {
  for (const end = Date.now() + ms; ;) {
    stopped(signal);
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(step);
  }
}

/** Whether `v` is done loading: not loading on two checks in a row, since a redirect can start just after one. A webview that is
 * not attached yet throws, which counts as loading. */
function settle(v, signal, ms = LOAD_MS) {
  let quiet = 0;
  return until(() => {
    let busy = true;
    try { busy = v.isLoading(); } catch { /* not attached yet */ }
    quiet = busy ? 0 : quiet + 1;
    return quiet >= 2;
  }, ms, signal);
}

const viewOf = async (id, signal) => (await until(() => views.get(id), 5000, signal)) ?? fail('unavailable', 'The browser tab did not open');

/** `p`, or a timeout error after `ms`. */
const timed = (p, ms, what) => Promise.race([p, sleep(ms).then(() => fail('timeout', `${what} did not answer within ${ms / 1000} s`))]);

/** `fn` run in tab `id`'s page with argument `arg` → its answer. */
const inPage = (v, fn, arg) => timed(v.executeJavaScript(`(${fn})(${JSON.stringify(arg ?? null)})`), SCRIPT_MS, 'The page');

// One navigation at a time in an agent's tab (an MCP client may send calls together): source → the work queued last.
const queues = new Map();
function serial(source, fn) {
  const run = (queues.get(source) ?? Promise.resolve()).then(fn, fn);
  queues.set(source, run.catch(() => {}));
  return run;
}

/** `fn` while the island shows that an agent works in the browser. */
async function working(fn) {
  setState({ agentBrowsing: (state.agentBrowsing ?? 0) + 1 });
  try {
    return await fn();
  } finally {
    setState({ agentBrowsing: state.agentBrowsing - 1 });
  }
}

/** `source`'s own tab at `url` once loaded → its id. A new tab starts on about:blank, so every page loads through loadURL, whose
 * promise rejects when the page fails; its error reaches the renderer as a message only, "ERR_NAME (-n) loading '<url>'", and
 * ERR_ABORTED (-3) is a navigation another one replaced, not a failure. */
async function goTo(source, url, signal) {
  let id = state.browser.tabs.find((t) => t.agent === source)?.id;
  if (!id) {
    id = newTab('about:blank', source) ?? fail('refused', `The browser has ${MAX_TABS} tabs, the most it holds. Ask the user to close one.`);
    await settle(await viewOf(id, signal), signal);
  }
  const v = await viewOf(id, signal);
  let error = '';
  await Promise.race([v.loadURL(url).catch((e) => { if (!/\(-3\)/.test(e?.message)) error = /ERR_[A-Z_]+/.exec(e?.message)?.[0] ?? String(e?.message ?? e); }), sleep(LOAD_MS)]);
  if (error) fail('unreachable', `The page did not load (${error})`, { url });
  await settle(v, signal);
  return id;
}

/** Tab `id`'s page as pageText reads it, once it is done loading. */
async function readView(id, signal) {
  const v = await viewOf(id, signal);
  await settle(v, signal, 10000);
  return inPage(v, pageText);
}

export const tabOf = (id) => state.browser.tabs.find((t) => t.id === id) ?? null;
export const activeTab = () => state.browser.active;

/** Tab `id`'s page (pageText); an agent's tab waits for that agent's navigation to end. */
export function read(id, signal) {
  const owner = tabOf(id)?.agent;
  return working(() => (owner ? serial(owner, () => readView(id, signal)) : readView(id, signal)));
}

/** `url` opened in `source`'s tab and read → {tab, page}. */
export function readUrl(source, url, signal) {
  return working(() => serial(source, async () => {
    const tab = await goTo(source, url, signal);
    return { tab, page: await readView(tab, signal) };
  }));
}

/** `q` on the search engine in `source`'s tab → {tab, results} (searchResults), waiting up to RESULTS_MS for a results page that
 * fills itself in. */
export function search(source, q, count, signal) {
  return working(() => serial(source, async () => {
    const tab = await goTo(source, searchUrl(q), signal);
    const v = views.get(tab);
    const results = await until(async () => {
      const r = await inPage(v, searchResults, count).catch(() => []);
      return Array.isArray(r) && r.length ? r : null;
    }, RESULTS_MS, signal, 300);
    return { tab, url: v.getURL(), title: v.getTitle(), results: results ?? [] };
  }));
}

// ---------------------------------------------------------------------------------------------
// Readers, run inside the page

/** The page's readable text and its links: the text of its main element (main, else role main, else its one article, else the
 * body) as the browser lays it out (innerText: no scripts, styles or hidden parts), whitespace tidied, and that element's links
 * with text, once each. Capped well above what an answer shows (commands/web.mjs pageAnswer cuts it). */
export function pageText() {
  const articles = document.querySelectorAll('article');
  const root = document.querySelector('main, [role=main]') ?? (articles.length === 1 ? articles[0] : document.body);
  const text = (root?.innerText ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const links = [];
  const seen = new Set();
  for (const a of root?.querySelectorAll('a[href]') ?? []) {
    const t = (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!t || !/^https?:/i.test(a.href) || seen.has(a.href)) continue;
    seen.add(a.href);
    links.push({ text: t.slice(0, 200), url: a.href });
    if (links.length >= 200) break;
  }
  return { title: document.title, url: location.href, text: text.slice(0, 500000), links };
}

/** A results page's results, at most `max`: [{title, url, snippet}]. Google titles each result with a heading inside its link (Bing
 * and DuckDuckGo with a link inside a heading), so those links are the results; a page with fewer than two of them is an engine
 * this does not know, and any link off the engine's own host with two words or more counts. A redirect link (/url?q=) gives its
 * target. The snippet is the text of the largest box around the result that holds no other result, less its title and URL lines. */
export function searchResults(max) {
  const own = location.host;
  const target = (href) => {
    try {
      const u = new URL(href, location.href);
      const to = u.pathname === '/url' ? u.searchParams.get('q') || u.searchParams.get('url') : null;
      return to ? new URL(to).href : u.href;
    } catch {
      return null;
    }
  };
  const away = (url) => { try { return /^https?:$/.test(new URL(url).protocol) && new URL(url).host !== own; } catch { return false; } };
  const words = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const headed = [...document.querySelectorAll('a h3, a h2, h3 a, h2 a')].map((e) => {
    const a = e.closest('a') ?? e;
    return { a, title: words((a.contains(e) && e.tagName !== 'A' ? e : a).innerText) };
  });
  const known = headed.filter((r) => away(target(r.a.href))).length >= 2;
  const picks = known ? headed : [...document.querySelectorAll('a[href]')].map((a) => ({ a, title: words(a.innerText) })).filter((r) => r.title.split(' ').length >= 2);
  const results = [];
  const seen = new Set();
  for (const { a, title } of picks) {
    const url = target(a.href);
    if (!url || !title || !away(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({ a, title, url });
  }
  const anchors = results.map((r) => r.a);
  const others = (box, a) => anchors.some((x) => x !== a && box.contains(x));
  return results.slice(0, max).map(({ a, title, url }) => {
    let box = a;
    for (let i = 0; i < 8 && box.parentElement && box.parentElement !== document.body && !others(box.parentElement, a); i++) box = box.parentElement;
    const lines = (box.innerText || '').split('\n').map((l) => words(l.replace(title, ''))).filter((l) => l && !/^https?:\/\/|›/.test(l));
    return { title, url, snippet: lines.join(' ').slice(0, 600) };
  });
}
