// The pointer in the canvas editor (briefs/engine-input.md): click places the caret (the engine's hit), drag selects, Shift+click
// extends, double-click selects a word, triple-click a paragraph and Ctrl+click a sentence, as in Word; a drag after a double or
// triple click grows by words or paragraphs (the engine's select.dragUnit); with Ctrl held each of these adds a range to the
// selection instead of replacing it (engine-multi-select); and Alt+drag selects a column (select.column) once
// the pointer moves: Alt+click alone places the caret and starts no block (Word opens its Search pane there, which this app
// has not). A drag past the view's edge scrolls the view (`scrollBy`, the viewport's camera) and goes on selecting. Mouse
// events cover pen and touch taps through the browser's compatibility events. ponytail: no click in the left margin (Word's
// selection bar).

const UNITS = { 2: 'word', 3: 'paragraph' };
// Controls the viewport puts inside the scroll element (a zoom badge): their clicks are theirs, not the pages'.
const CONTROLS = 'button, a, input, select, textarea, [role="button"]';
/** Px inside the view's edge where a drag starts to scroll, and the most px a frame scrolls. */
const EDGE = 8;
const STEP = 40;

/** How far client point `e` is past the edge band of `el`'s visible box, each way (negative: left or up) → {dx, dy} px. */
export function pastEdge(el, e) {
  const r = el.getBoundingClientRect();
  const x0 = r.left + el.clientLeft + EDGE;
  const y0 = r.top + el.clientTop + EDGE;
  const x1 = r.left + el.clientLeft + el.clientWidth - EDGE;
  const y1 = r.top + el.clientTop + el.clientHeight - EDGE;
  const by = (v, lo, hi) => (v < lo ? v - lo : v > hi ? v - hi : 0);
  return { dx: by(e.clientX, x0, x1), dy: by(e.clientY, y0, y1) };
}

/** What runs once a mouse selection ends, each `(client) => promise` in the input's queue after the selection's own calls: the
 * Document's highlighter pen and Format Painter add theirs (src/document/wp/font, clipboard), as Word applies them on release. */
export const afterMouseSelect = new Set();

/** The editing options a press reads, set by the format host: `autoWordSelect()` is Word's Options > Advanced "When selecting,
 * automatically select entire word" (the Document's editing.autoWordSelect, off unless the user turns it on). */
export const pointerOptions = {
  autoWordSelect: () => false,
  /** A host that lets a selection, or an object under the pointer, be dragged somewhere else (the board's drag out of a page) sets
   * this to `{press(client, at, pos, e) → promise of what a press on that selection or object arms or null, begin({client, armed, e})
   * → {move(e), up(e), cancel()} | null}`. A press with no modifier that `press` arms keeps the selection until the pointer has moved
   * 4 px, then hands the drag to `begin`; released sooner, it is a click and puts the caret there. Null (the default): no text drag. */
  textDrag: null,
};
/** Px a press on a selection moves before it is a drag of that selection. */
const DRAG_PX = 4;

/** What a single click may do instead of placing the caret or selecting a sentence (Ctrl), each `(client, pos, e, at) => promise
 * of whether it took the click`, `at` being the press's {page, x, y} in points: the Document follows the link there
 * (src/document/wp/fields-ref) on a Ctrl+click, or on a plain click when Word's "Use Ctrl+Click to follow hyperlink" is off;
 * a diagram or chart is selected where the press lands. */
export const clickHooks = new Set();

/** Pointer handling on page area `el` → off(). `locate(clientX, clientY)` → {page, x, y} in points or null (the viewport).
 * `beforeDown()` runs before a click moves the caret (index.js ends an open composition there, as Word commits it).
 * `scrollBy(dx, dy)` scrolls the view by px during a drag past its edge; none, no auto-scroll. `takes(e)` says whether this
 * session's press is the session's: false passes the press on (a board's text box being edited ends its edit on a press
 * outside). */
export function pointerOf({ el, client, run, changed, locate, focus, scrollBy, takes, beforeDown = () => {} }) {
  const win = el.ownerDocument?.defaultView ?? globalThis;
  let drag = null;
  let raf = 0;
  const posAt = async (e) => {
    const p = locate(e.clientX, e.clientY);
    return p ? (await client.hit(p.page, p.x, p.y)).pos : null;
  };

  // locate() answers the nearest page for any point, so a press on the scroll element's own scrollbar (outside its client box)
  // or on a control inside it has to be told apart here; Word never moves the caret for its scrollbar.
  const offPages = (e) => {
    if (e.target === el && (e.offsetX >= el.clientWidth || e.offsetY >= el.clientHeight)) return true;
    const c = e.target !== el && e.target?.closest?.(CONTROLS);
    return !!c && el.contains(c);
  };

  const down = (e) => {
    if (e.button !== 0 || takes?.(e) === false || offPages(e) || !locate(e.clientX, e.clientY)) return;
    e.preventDefault(); // the engine owns the selection and the focus stays on the page area
    beforeDown();
    focus();
    const n = Math.min(e.detail || 1, 3);
    const extend = n === 1 && e.shiftKey;
    // The column block's corner, used once the pointer moves.
    const column = n === 1 && e.altKey && !e.ctrlKey && !e.shiftKey ? locate(e.clientX, e.clientY) : null;
    // A plain press the host may arm as a drag of the selection or of the object under it.
    const arm = n === 1 && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey ? pointerOptions.textDrag : null;
    // Ctrl with a click, drag, double or triple click adds a range to the selection there is (Word's multiple selection, the
    // engine's select.add): every later call of the press passes `keep`, so it moves the new range and leaves the others.
    const add = e.ctrlKey && !e.altKey && !extend;
    // A Ctrl press that adds no range (Ctrl+Alt) selects a sentence; one that adds decides once it knows the selection there is.
    const d = (drag = { unit: n === 1 && e.ctrlKey && !add ? 'sentence' : UNITS[n] ?? null, column, keep: add ? { keep: true } : {}, anchor: null,
      start: null, end: null, at: null, queued: false, sentence: false,
      // A plain drag under "automatically select entire word" goes by whole words once it leaves the word it began in (Word, and
      // the DOM editor's dragRange in src/document/wp/editing-keys/plugin.js).
      fromWord: n === 1 && !e.ctrlKey && !e.altKey && !extend && pointerOptions.autoWordSelect() });
    run(async () => {
      const pos = await posAt(e);
      if (pos == null) return;
      if (extend) {
        d.anchor = (await client.selection()).anchor;
        return client.select(d.anchor, pos);
      }
      if (n === 1 && !column) {
        for (const hook of clickHooks) {
          if (await hook(client, pos, e, locate(e.clientX, e.clientY))) {
            // A hook takes the click; a drag from there still selects as before (it starts where the press landed).
            d.anchor = pos;
            changed();
            win.addEventListener('mousemove', move);
            win.addEventListener('mouseup', up);
            return;
          }
        }
      }
      if (arm) {
        const armed = await arm.press(client, locate(e.clientX, e.clientY), pos, e);
        if (armed) {
          // Released while the host decided: a click, which puts the caret where it landed unless an object was taken.
          if (drag !== d) return armed.kind === 'selection' ? client.select(pos, pos) : undefined;
          d.armed = { ...armed, x: e.clientX, y: e.clientY, pos, drag: null };
          changed();
          return stepArmed(d);
        }
      }
      d.anchor = pos;
      if (!add) await client.select(pos, pos);
      // A double or triple click's first press added the range already: its later presses move that one.
      else if (n > 1) await client.exec('select.range', { anchor: pos, focus: pos, ...d.keep });
      else {
        // Word: Ctrl held before the first selection selects the whole sentence, and a drag then grows by sentences. With a
        // selection made, Ctrl+drag adds a range that grows as a plain drag does, and a Ctrl+click that drags nothing adds the
        // sentence (up() selects it). Sources: thewordoflaw.blogspot.com/2009/11/discontinuous-selection.html, Microsoft's
        // KB 286789 ("press and hold CTRL while you select the next item"), and a test of Word reported in a pull request from WordCraft
        // (number 2616: "Ctrl+click adds a sentence to the existing selection").
        const s = await client.selection();
        const made = s.ranges > 1 || JSON.stringify(s.anchor) !== JSON.stringify(s.head);
        await client.exec('select.add', { anchor: pos, focus: pos });
        if (made) d.sentence = true;
        else d.unit = 'sentence';
      }
      if (!d.unit) return;
      await client.exec(`select.${d.unit}`, d.keep);
      const s = await client.selection();
      [d.start, d.end] = [s.anchor, s.head];
    });
    changed();
    win.addEventListener('mousemove', move);
    win.addEventListener('mouseup', up);
  };

  // A press the host armed waits for the pointer to move DRAG_PX, then the host's drag has every move.
  const stepArmed = (d) => {
    const a = d.armed;
    if (!a || !d.at) return;
    if (!a.drag && Math.hypot(d.at.clientX - a.x, d.at.clientY - a.y) >= DRAG_PX) {
      a.drag = pointerOptions.textDrag?.begin({ client, armed: a, e: d.at }) ?? false;
    }
    a.drag?.move?.(d.at);
  };

  // Moves faster than the engine answers collapse into one step at the latest point.
  const select = () => {
    const d = drag;
    if (!d || d.queued) return;
    d.queued = true;
    run(async () => {
      d.queued = false;
      if (d.column) {
        const to = locate(d.at.clientX, d.at.clientY);
        return to && client.exec('select.column', { from: d.column, to });
      }
      const pos = await posAt(d.at);
      if (pos == null || d.anchor == null) return;
      if (d.unit && d.start != null) return client.exec('select.dragUnit', { unit: d.unit, start: d.start, end: d.end, pos, ...d.keep });
      if (d.fromWord) return client.exec('select.dragUnit', { unit: 'word', start: d.anchor, end: d.anchor, pos, fromWord: true });
      // A Ctrl+drag that adds a range moves that range alone.
      return d.keep.keep ? client.exec('select.range', { anchor: d.anchor, focus: pos, keep: true }) : client.select(d.anchor, pos);
    });
    changed();
  };

  // Past the view's edge the view scrolls a step a frame, further the further out the pointer is, and the selection follows
  // the pages that come under the pointer.
  const scroll = () => {
    raf = 0;
    const d = drag;
    if (!d?.at || !scrollBy || d.armed) return; // a drag of a selection to somewhere else never scrolls the view
    const { dx, dy } = pastEdge(el, d.at);
    if (!dx && !dy) return;
    const step = (v) => Math.sign(v) * Math.min(STEP, Math.ceil(Math.abs(v) / 2));
    scrollBy(step(dx), step(dy));
    select();
    raf = requestAnimationFrame(scroll);
  };

  const move = (e) => {
    const d = drag;
    if (!d) return;
    if (e.buttons === 0) return up(e); // the mouseup went elsewhere (another window, a dialog): the drag is over
    d.at = e;
    if (d.armed) return stepArmed(d);
    select();
    if (!raf && scrollBy) raf = requestAnimationFrame(scroll);
  };

  const up = (ev) => {
    const d = drag;
    drag = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    win.removeEventListener('mousemove', move);
    win.removeEventListener('mouseup', up);
    if (d?.armed) {
      const a = d.armed;
      if (a.drag) a.drag.up?.(ev?.clientX != null ? ev : d.at);
      else if (a.kind === 'selection') run(() => client.select(a.pos, a.pos));
      return;
    }
    // A Ctrl+click beside a selection: the added range takes the sentence when the press dragged nothing (queued after the
    // press's own calls, which decide `sentence`).
    if (d && d.keep.keep) run(async () => {
      if (!d.sentence) return;
      const s = await client.selection();
      if (JSON.stringify(s.anchor) === JSON.stringify(s.head)) await client.exec('select.sentence', d.keep);
    });
    if (d && afterMouseSelect.size) run(async () => {
      for (const fn of afterMouseSelect) await fn(client);
    });
  };

  el.addEventListener('mousedown', down);
  return () => {
    up();
    el.removeEventListener('mousedown', down);
  };
}
