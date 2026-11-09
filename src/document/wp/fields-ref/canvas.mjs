// Links on a canvas draft (docs/plans/engine/stage2/gaps.md fields-ref): Ctrl+click follows the link under the pointer, as the
// DOM editor's follow (edit.js), and Web Go Back and Forward (Alt+Left, Alt+Right) walk the places a followed link left, per
// session. Pure: node tests load it; the app's browser pane comes in through linkHooks.open.
// ponytail: the places are engine positions kept as they were, not moved by later edits (the engine clamps a stale one); keep
// them in the engine if edits between follows make that wrong often.

/** The app's side: open a web address in the browser pane; show a message; whether Word's "Use Ctrl+Click to follow hyperlink"
 * is on. fields-ref/index.js sets them. */
export const linkHooks = { open: () => false, toast: () => {}, ctrlClick: () => true };

// By the session's id: since engine-session-release the page area's client and a reader's watcher of the same session are
// different objects (the click follows through one, Alt+Left goes back through the other). ponytail: a closed session's stack
// stays until the window closes, at most MAX places a session.
const stacks = new Map(); // session id → {back: [{anchor, head}], fwd: [...]}
const stackOf = (client) => {
  const key = client.id ?? client;
  let st = stacks.get(key);
  if (!st) stacks.set(key, (st = { back: [], fwd: [] }));
  return st;
};
const MAX = 50;

/** Whether Web Go Back (dir -1) or Forward (+1) has a place to go on `client`. */
export const canGo = (client, dir) => !!client && (dir < 0 ? stackOf(client).back : stackOf(client).fwd).length > 0;

/** Goes back (dir -1) or forward (+1) on `client` → whether it went. */
export async function webGo(client, dir) {
  if (!canGo(client, dir)) return false;
  const st = stackOf(client);
  const here = await client.selection();
  const to = (dir < 0 ? st.back : st.fwd).pop();
  (dir < 0 ? st.fwd : st.back).push(here);
  await client.select(to.anchor, to.head);
  return true;
}

/** Follows link `link` ({url} | {bookmark}, document.context's) on `client`: a place in the document goes there and the place
 * left joins Web Go Back; a web address opens in the browser pane. → whether it was a link. */
export async function follow(client, link) {
  const place = link?.bookmark ?? (link?.url?.startsWith('#') ? decodeURIComponent(link.url.slice(1)) : null);
  if (place != null) {
    const here = await client.selection();
    const r = await client.exec('edit.goto', { bookmark: place });
    if (!r?.ok) {
      linkHooks.toast(`This document has no bookmark named ${place}.`);
      return true;
    }
    const st = stackOf(client);
    st.back = [...st.back, here].slice(-MAX);
    st.fwd = [];
    return true;
  }
  const url = link?.url;
  if (/^https?:/i.test(url ?? '')) return linkHooks.open(url), true;
  if (url) linkHooks.toast(/^mailto:/i.test(url) ? 'E-mail links cannot open from here yet.' : 'Links to files cannot open from here yet.');
  return !!url;
}

/** A click at `pos` on `client` with key event `e` (src/engine/input/pointer.js clickHooks): follows the link there on a Ctrl+click,
 * or on a plain click with the Ctrl+click option off (a Ctrl+click then selects the sentence, as in Word) → whether it did. */
export async function followAt(client, pos, e = {}) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (linkHooks.ctrlClick() ? !ctrl : ctrl || e.shiftKey || e.altKey) return false;
  const c = await client.exec('document.context', { pos });
  const link = c?.value?.link;
  return link ? follow(client, link) : false;
}
