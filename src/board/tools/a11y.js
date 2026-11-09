// bd-a11y fills this tool (docs/plans/board/design.md section 8): the board as a screen reader walks it. attachA11y reads the
// sessions in view (a document instance, the item session a text is typed in), the BoardReader lists the items in reading order,
// Tab walks that list, Enter enters a selected document and Esc leaves it, and a polite line says what changed. The board
// session is not a document, so clientOf answers null for it.
import { createElement } from 'react';
import { getState, subscribe } from '../../app/store.js';
import { PROOFING } from '../../document/canvas/proofing.mjs';
import { attachA11y } from '../../engine/a11y/index.js';
import { rpc } from '../../engine/a11y/blocks.js';
import { watchForcedColors } from '../../engine/a11y/forced.js';
import { kOf } from '../../engine/view/camera.mjs';
import { readingList } from '../a11y.mjs';
import { boxOf } from '../gestures.mjs';
import { registerTool } from './registry.js';

const MARGIN = 24; // px kept between a revealed item and the view's edge

// Selection chrome keeps its accent look in forced colours, where the system's own two colours are what a screen reader's user
// asked for: the box, handles, size label, marquee and a document's label. A selected label is the accent colour, so the rule
// for it matches the label's own inline colour.
const FORCED = `@media (forced-colors: active){
[data-board-selection] polygon,[data-board-selection] rect{stroke:Highlight}
[data-board-selection-many]{outline-color:Highlight!important}
[data-board-handle]{background:Canvas!important;border-color:Highlight!important}
[data-board-size]{background:Highlight!important;color:HighlightText!important}
[data-board-marquee]{border-color:Highlight!important}
[data-board-section-label]{color:CanvasText!important}
[data-board-section-label][data-selected]{color:Highlight!important}
}`;

function addStyle(doc) {
  if (doc.querySelector('style[data-board-a11y-style]')) return;
  const style = doc.createElement('style');
  style.setAttribute('data-board-a11y-style', '');
  style.textContent = FORCED;
  doc.head.append(style);
}

/** The polite live line of one board: `say` replaces it and `subscribe` hears each new one. BoardReader renders it into the
 * viewport's status region. The same line twice clears first, so a second delete or move is read too. */
function createLive() {
  let line = '';
  let timer = 0;
  const subs = new Set();
  const emit = (text) => {
    line = text;
    for (const fn of [...subs]) fn(text);
  };
  return {
    say(next) {
      if (!next) return;
      clearTimeout(timer);
      if (next !== line) return emit(next);
      emit('');
      timer = setTimeout(() => emit(next), 100);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

// A store step's line: a move in any form says Moved, a delete Deleted, a resize Resized; anything else says nothing.
const LINES = { Move: 'Moved', Nudge: 'Moved', 'Move document': 'Moved', 'Move page': 'Moved', Resize: 'Resized',
  Delete: 'Deleted', 'Remove document': 'Deleted' };

const titleOfDraft = (session) => (getState().drafts ?? []).find((draft) => draft.id === session)?.title ?? '';

/** Moves the camera as little as it can to show the whole of item `id`: both axes are the item's own far edges, so a wide item
 * off to the right comes in with its right edge. */
function reveal(ctx, id) {
  const vp = ctx.vp;
  const item = ctx.store.get(id);
  const box = item ? boxOf(item, ctx.store) : null;
  if (!vp || !box) return;
  const k = kOf(vp.camera.zoom);
  const m = MARGIN / k;
  const view = { x: vp.camera.x, y: vp.camera.y, w: vp.size.w / k, h: vp.size.h / k };
  let { x, y } = view;
  if (box.y - m < y) y = box.y - m;
  else if (box.y + box.h + m > y + view.h) y = box.y + box.h + m - view.h;
  if (box.x - m < x) x = box.x - m;
  else if (box.x + box.w + m > x + view.w) x = box.x + box.w + m - view.w;
  if (x !== view.x || y !== view.y) vp.setCamera({ x, y });
}

export default registerTool({
  id: 'a11y',

  mount(ctx) {
    const vp = ctx.vp;
    if (!vp) return;
    const doc = vp.root.ownerDocument;
    addStyle(doc);
    const live = createLive();
    ctx.a11yLive = live;

    // One region per session in view: a document instance under its draft's id, the item session under its own. The board
    // session paints every item, not a document, so it gets none.
    const a11y = attachA11y(vp, {
      clientOf: (session) => (session === ctx.item.id ? ctx.item : ctx.instances?.clientOf(session) ?? null),
      title: (session) => (session === ctx.item.id ? ctx.draft?.title : titleOfDraft(session)) || 'Document',
      proofing: PROOFING, subscribe,
    });

    // Forced colours for the board session's stamps, as attachA11y gives the sessions it shows.
    let colors = null;
    const paint = () => Promise.resolve(rpc(ctx.client, 'colors', colors)).catch(() => {});
    const offColors = watchForcedColors(doc, (c) => {
      colors = c;
      paint();
    });
    const offReopen = ctx.client.on?.('reopened', paint) ?? null;

    // A journal undo or redo writes through the store too: its own line says Undo or Redo, so the store's is left out there.
    let stepping = false;
    const offStore = ctx.store.subscribe(({ step }) => {
      if (step && !stepping) live.say(LINES[step.label] ?? '');
    });

    // A selection made by a click or the chrome is where the reading carries on from, as a Tab's own selection is.
    const offSelection = ctx.selection.subscribe(() => {
      const ids = ctx.selection.ids;
      if (ids.length === 1) {
        const at = readingList(ctx.store).indexOf(ids[0]);
        if (at >= 0) ctx.a11yCursor = at;
      }
      if (ids.length > 1) live.say(`${ids.length} selected`);
      else if (ids.length === 1 && ctx.store.get(ids[0])?.type === 'doc') live.say('Document selected. Press Enter to edit.');
    });

    // Where the keys are: the board, a document instance or a text being typed.
    let where = 'board';
    const offFocus = vp.subscribe('focus', () => {
      const session = vp.focus.session;
      if (session != null && session !== ctx.client.id) {
        if (session === ctx.item.id) {
          where = 'text';
          live.say('Text editing. Press Escape to finish.');
        } else {
          where = 'doc';
          live.say(`Editing ${titleOfDraft(session) || ctx.draft?.title || 'document'}. Press Escape to go back.`);
        }
        return;
      }
      if (where !== 'board') live.say('Back on the whiteboard.');
      where = 'board';
    });

    // The journal's undo and redo carry the step's label: the line says which change went back or came again. Its refusals go
    // to the app's own status notice, not here.
    const journal = ctx.journal;
    const undo = journal?.undo;
    const redo = journal?.redo;
    const labelOf = (entry) => entry?.parts?.find((part) => part.step?.label)?.step?.label ?? 'change';
    if (journal) {
      journal.undo = function (...args) {
        const entry = journal.entries.at(-1);
        stepping = true;
        return Promise.resolve(undo.apply(this, args)).then((ok) => {
          if (ok) live.say(`Undo ${labelOf(entry)}`);
          return ok;
        }).finally(() => {
          stepping = false;
        });
      };
      journal.redo = function (...args) {
        const entry = journal.redos.at(-1);
        stepping = true;
        return Promise.resolve(redo.apply(this, args)).then((ok) => {
          if (ok) live.say(`Redo ${labelOf(entry)}`);
          return ok;
        }).finally(() => {
          stepping = false;
        });
      };
    }

    ctx.a11yCursor = -1; // the reading index last tabbed to, kept when the selected item goes
    let dead = false;
    let offReader = null;
    import('../BoardReader.jsx').then(({ BoardReader }) => {
      if (dead || !vp.overlays) return;
      vp.overlays.register('board-a11y-reader', () => createElement(BoardReader, { ctx }), { plane: 'screen' });
      offReader = () => vp.overlays.register('board-a11y-reader', null);
    }, () => {});

    return () => {
      dead = true;
      offReader?.();
      offColors?.();
      offReopen?.();
      offStore();
      offSelection();
      offFocus();
      if (journal) [journal.undo, journal.redo] = [undo, redo];
      a11y.destroy();
      if (ctx.a11yLive === live) ctx.a11yLive = null;
    };
  },

  // Tab walks the reading order while the board itself has the keys; bd-layers' Tab steps inside a group. Off the last item
  // (Shift+Tab off the first) the selection clears and the browser moves focus on. The index last read is kept, so the next
  // Tab after a delete carries on where the row was.
  keydown(ctx, e) {
    const vp = ctx.vp;
    // Inside a group bd-layers owns Tab; with the whole group selected it leaves the key alone too.
    if (!vp || e.ctrlKey || e.metaKey || e.altKey || e.code !== 'Tab' || ctx.selection.scope != null || e.target !== vp.root) return false;
    const ids = readingList(ctx.store);
    if (!ids.length) return false;
    const selected = ctx.selection.ids;
    const found = selected.length === 1 ? ids.indexOf(selected[0]) : -1;
    const cursor = Number.isInteger(ctx.a11yCursor) ? ctx.a11yCursor : -1;
    const next = found >= 0 ? found + (e.shiftKey ? -1 : 1)
      : cursor >= 0 ? Math.min(cursor, ids.length - 1)
        : e.shiftKey ? ids.length - 1 : 0;
    if (next < 0 || next >= ids.length) {
      ctx.a11yCursor = -1;
      ctx.selection.clear();
      return false;
    }
    ctx.a11yCursor = next;
    ctx.selection.set([ids[next]]);
    reveal(ctx, ids[next]);
    return true;
  },
});
