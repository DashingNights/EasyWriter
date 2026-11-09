// Input for the canvas document editor (docs/plans/engine/plan.md sections 1 and 3, viewport-design.md section 6): typing and
// input methods (text.js), keys (keys.mjs), the pointer (pointer.js) and the clipboard (clipboard.js) on one element, all sent
// to one engine session through its client. The engine holds the document and the selection; this module keeps only what the
// overlay draws (the caret, the selection's rectangles and a composition's underlines, in surface points) and tells the input
// method where the caret and the composition's characters are on screen, so the candidate window opens at the caret. It reads
// them from the session's selection events (the worker sends one after any change to the selection or its layout), so a
// typed letter costs no engine call besides the edit. viewport.js attaches it to a viewport's focused session.
//
// Every engine call goes through one queue, so a fast typist's keys reach the engine in order while the worker is still busy.
import { clipboardOf, webClipboard } from './clipboard.js';
import { underlines, unitBoxes } from './compose.mjs';
import { pointerOf } from './pointer.js';
import { textSource } from './text.js';

// beforeinput types that reach the element without a key it handled: the native Edit menu's Undo, an on-screen keyboard's
// Enter, an input method's deletes.
const INPUTS = {
  historyUndo: ['undo'],
  historyRedo: ['redo'],
  insertParagraph: ['exec', 'text.newParagraph'],
  insertLineBreak: ['exec', 'text.lineBreak'],
  deleteContentBackward: ['deleteBackward', 'character'],
  deleteContentForward: ['deleteForward', 'character'],
  deleteWordBackward: ['deleteBackward', 'word'],
  deleteWordForward: ['deleteForward', 'word'],
};

/** Keys a content kind takes before its keymap, each `(keydown event, client)` → the engine call to make (a function) or null:
 * the Document's Enter after F2 or Shift+F2 and the letter after an accent prefix (src/document/canvas/rows/home.mjs canvasKey). */
export const keyHooks = new Set();

const now = () => performance.now();
const frame = (fn) => (globalThis.requestAnimationFrame ?? setTimeout)(() => setTimeout(fn, 0));

/**
 * Attaches input for session `client` to element `el` → the input's handle.
 * - `client`: the session's client (src/engine/client.js SessionClient): its calls, and its 'selection' events.
 * - `locate(clientX, clientY)` → {page, x, y} in points, or null off the pages; `toClient(page, x, y)` → {x, y} in client pixels
 *   (both from the viewport).
 * - `reveal(caret)`: scrolls the caret ({page, x, y, h}) into view after keys and typing (the viewport).
 * - `scrollBy(dx, dy)`: scrolls the view by client pixels, for a drag past its edge (the viewport); none, no auto-scroll.
 * - `keymap(keydown event)` → the engine action ({call, args} or {run}) or null (keys.mjs createKeymap, from the
 *   host).
 * - `clipboard`: {write({text, html, rtf})}, the browser's by default.
 * - `pasteHtml(html)` and `pasteFiles(files)`: the host's own paste for a draft whose content is not the engine's (a forum
 *   post, document/canvas/post.js); left out for a Document, which pastes through the engine.
 * - `editContext`: false forces the hidden textarea (tests; browsers without EditContext get it anyway).
 * The handle: subscribe(fn) and snapshot() → {focused, caret, rects, found, comp} for the overlay; focus(); place() (the view moved:
 * the candidate window follows); copy(), cut() and paste({text, html, rtf, docx}, textOnly) for the ribbon and menus; timings
 * (ms from an input to the frame after its selection event, the last 500); idle(); destroy({drop}).
 */
export function attachInput(el, { client, locate, toClient, reveal = () => {}, scrollBy, edge, keymap = () => null, clipboard = webClipboard, pasteHtml, pasteFiles, editContext, takes } = {}) {
  const listeners = new Set();
  let state = { focused: false, caret: null, rects: [], found: [], comp: [] };
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };

  let queue = Promise.resolve();
  const run = (fn) => {
    queue = queue.then(() => fn()).catch((e) => console.error('engine input:', e));
    return queue;
  };

  // `keys`: the change came from keys or typing, so the next selection event scrolls its caret into view.
  let fromKeys = false;
  const changed = (keys = false) => {
    fromKeys ||= keys;
  };

  const timings = [];
  let since = null;
  const mark = (e) => {
    since ??= e?.timeStamp || now();
  };

  // A selection event ({anchor, head, version, caret, rects, found, comp}, the wrapper crate's selectionEvent).
  // ponytail: a key that changes nothing sends no event, so its time counts toward the next input's; the timings are a
  // harness measure, not shown anywhere.
  function apply(ev) {
    if (!ev) return;
    set({ caret: ev.caret ?? null, rects: ev.rects ?? [], found: ev.found ?? [] });
    if (comp && ev.comp?.text === comp.text) {
      comp.boxes = unitBoxes(comp.text, ev.comp.boxes);
      draw(comp);
    }
    place();
    if (fromKeys) reveal(ev.caret);
    fromKeys = false;
    if (since != null) {
      const t0 = since;
      since = null;
      frame(() => {
        timings.push(now() - t0);
        if (timings.length > 500) timings.shift();
      });
    }
  }

  const rectOf = (b, w = b.w ?? 0) => {
    const a = toClient(b.page, b.x, b.y);
    const z = toClient(b.page, b.x + w, b.y + b.h);
    return new DOMRect(a.x, a.y, z.x - a.x, z.y - a.y);
  };
  function place() {
    if (state.caret) src.place(el.getBoundingClientRect(), rectOf(state.caret, 0));
    pushChars();
  }

  // The composition: its text, its format ranges and one box per UTF-16 unit (from the selection event's comp boxes).
  let comp = null;
  function pushChars() {
    if (comp?.boxes.length && state.caret) src.chars(0, comp.boxes.map((b) => rectOf(b ?? state.caret, b ? b.w : 0)));
  }
  function draw(c) {
    if (c === comp) set({ comp: underlines(c.boxes, c.formats, c.text.length) });
  }

  function commit() {
    comp = null;
    run(() => client.commit());
    set({ comp: [] });
    changed(true);
  }
  // A click while composing commits the composition where it is, as in Word, before the caret moves. The text source forgets its
  // composition first (and makes the browser end the input method's), so a late compositionend commits nothing twice.
  const endComposition = () => {
    if (!comp) return;
    src.finish();
    commit();
  };

  const src = textSource(el, {
    insert(text, e) {
      mark(e);
      run(() => client.insertText(text));
      changed(true);
    },
    compose(text, selStart, selEnd) {
      comp ??= { formats: [], boxes: [], seq: 0 };
      const c = comp;
      const seq = ++c.seq;
      c.text = text;
      mark();
      // Only the latest update of a composition matters: the engine replaces the whole composition each time. Its boxes come
      // with the selection event that follows.
      run(() => seq === c.seq && client.compose(text, selStart, selEnd));
      changed(true);
    },
    commit,
    formats(list) {
      if (!comp) return;
      comp.formats = list;
      draw(comp);
    },
    bounds: pushChars,
  }, { editContext });

  const focus = () => src.target.focus({ preventScroll: true });
  // `call`: a client call's name, or a function (a key's registry command, keys.mjs {run}).
  const act = (e, call, args) => {
    e.preventDefault();
    mark(e);
    run(() => (typeof call === 'function' ? call() : client[call](...args)));
    changed(true);
  };
  const handlers = {
    keydown: (e) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return; // the input method owns keys while it composes
      for (const hook of keyHooks) {
        const fn = hook(e, client);
        if (fn) return act(e, fn);
      }
      const a = keymap(e);
      if (a) act(e, a.run ?? a.call, a.args);
    },
    beforeinput: (e) => {
      const a = !e.isComposing && INPUTS[e.inputType];
      if (a) act(e, a[0], a.slice(1));
    },
    focusin: () => set({ focused: true }),
    focusout: (e) => {
      if (!el.contains(e.relatedTarget)) set({ focused: false });
    },
    scroll: place,
  };
  for (const [k, fn] of Object.entries(handlers)) el.addEventListener(k, fn, k === 'scroll');
  const win = el.ownerDocument?.defaultView;
  win?.addEventListener('resize', place);

  const clip = clipboardOf({ el, client, run, changed, writer: clipboard, pasteHtml, pasteFiles });
  const offPointer = pointerOf({ el, client, run, changed, locate, focus, scrollBy, takes, beforeDown: endComposition });
  const offSelection = client.on?.('selection', apply);
  if (el.tabIndex < 0) el.tabIndex = 0;
  // An EditContext's element is an editing host, so Chromium draws its own caret at the DOM selection; the overlay draws ours.
  const caretColor = el.style.caretColor;
  el.style.caretColor = 'transparent';
  if (el.contains(el.ownerDocument?.activeElement)) set({ focused: true });
  // The caret and selection as they are now; every change after this comes as an event.
  run(async () => apply(await client.call('selectionEvent')));

  return {
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot: () => state,
    timings,
    focus,
    place,
    copy: () => run(clip.copy),
    cut: () => (run(clip.cut), changed(true)),
    paste: (data, textOnly) => (run(() => clip.paste(data, textOnly)), changed(true)),
    /** Ctrl+Alt+PageUp (end false) and PageDown (true), Shift with `extend`: the caret to the start of the first line wholly in
     * the window, or the end of the last one (`edge(end)` → {page, top, bottom} in points, the viewport's visible part of the
     * first or last page in view). */
    windowEdge: (end, extend) => run(async () => {
      const e = edge?.(end);
      if (!e) return false;
      const lineAt = async (y) => {
        const pos = (await client.hit(e.page, end ? 1e5 : 0, y))?.pos;
        return pos ? { pos, c: await client.caret(pos) } : null;
      };
      let at = await lineAt(end ? e.bottom - 1 : e.top + 1);
      // A line the window cuts is not wholly in it: the next line in.
      if (at?.c && !end && at.c.y < e.top - 0.5) at = (await lineAt(at.c.y + at.c.h + 1)) ?? at;
      if (at?.c && end && at.c.y + at.c.h > e.bottom + 0.5) at = (await lineAt(at.c.y - 1)) ?? at;
      if (!at) return false;
      const s = extend ? await client.selection() : null;
      await client.select(s?.anchor ?? at.pos, at.pos);
      return true;
    }),
    /** Resolves once every queued engine call is done and the events they caused have arrived: the round trip after them
     * comes back behind those events (tests). */
    idle: () => queue.then(() => client.selection()).then(() => {}),
    /** Detaches. `drop`: an open composition goes from the document, as when the focus moves to another session in the middle
     * of one (section 6): the input method leaves its unfinished text (the radicals) behind, so it is removed here. */
    destroy({ drop = false } = {}) {
      for (const [k, fn] of Object.entries(handlers)) el.removeEventListener(k, fn, k === 'scroll');
      win?.removeEventListener('resize', place);
      clip.off();
      offPointer();
      offSelection?.();
      // The source's listeners go before its EditContext leaves the element, so the compositionend Chromium sends then
      // commits nothing.
      src.destroy();
      if (drop && comp) {
        comp = null;
        run(() => client.compose('', 0, 0)); // empty text takes the composition away and ends it
      }
      el.style.caretColor = caretColor;
    },
  };
}
