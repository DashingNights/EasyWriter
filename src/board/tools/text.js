// The board's text (docs/plans/board/design.md sections 2, 4 and 8, briefs/bd-text.md): every text on a board is a story
// edited in the one reused item session (the board area's second session), so the caret, an input method, spelling, styles and
// lists are the engine's own. The T tool makes a text item and edits it at once; a double-click, Enter or F2 edits a text item,
// a shape's label or a connector label. While a text is edited the item's own stamp drops it (surfaces.preview) and a placement
// of the item session shows the box instead; a press outside the box, Esc, a tool, the focus leaving the board or the board
// closing ends the edit, which saves the story in one store step (a save made while the box is open takes the text as it is).
import { keyAmong } from '../../app/keybinds.js';
import { getState, setState } from '../../app/store.js';
import { inputOnViewport } from '../../engine/input/viewport.js';
import { presetTextRect } from '../../flow/presets.mjs';
import { planeTools } from '../../whiteboard.js';
import { DRAG_PX } from '../gestures.mjs';
import { rgb, textStory, toPt } from '../look.mjs';
import { modelOf, storyOf } from '../model.mjs';
import { takesDocument } from '../focus.js';
import { derived, placementsOf } from '../surfaces.mjs';
import { registerTool } from './registry.js';

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const ALIGN = { left: 'para.alignLeft', center: 'para.alignCenter', right: 'para.alignRight' };
const LABEL_W = 160; // a connector label's box when the rule gives none, points
const LABEL_H = 24;
// A text box's internal margins (ew_doc TEXT_BOX_INSET: 0.1 in left and right, 0.05 in top and bottom), points. The painted
// label is a text box, so its words sit inside its box by these; the edit box is the box minus them.
const INSET = { x: 7.2, y: 3.6 };
/** Where a connector's labels sit along its route: the start, the middle and the end (bd-connect places them with these). */
export const LABELS = { start: 0.15, mid: 0.5, end: 0.85 };
const WIDE = 16000; // a `fit: 'width'` text lays out unwrapped, so its stamp gives the text's own width

let ctxRef = null; // the mounted board area's context: methods get it here (the chrome calls them on the api)
let edit = null; // {id, slot, kind, fit, new, step, placement, offLayout}
let busy = false; // an edit opening or closing
let gesture = null; // the T tool's drag
let chain = Promise.resolve(); // the item session opens one story at a time

/** Runs `fn` after every earlier item session call. */
export const queued = (fn) => (chain = chain.then(fn, fn));

/** The story of `item` for `slot` (a connector label), or an empty one. */
const storyAt = (item, slot) => (slot ? item?.labels?.[slot] : item?.story) ?? null;

/** Whether a story holds anything: text or an object (a blank text item is removed when its first edit ends). */
const isEmpty = (story) => !(story?.blocks ?? []).some((b) => b.text || b.objects?.length);

/** The item session's `save('engine')` as an object. */
const parseModel = (saved) => (typeof saved === 'string' ? JSON.parse(saved) : saved instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(saved)) : saved);

/**
 * The text box of a shape in points, relative to the item: a DrawingML preset's own text rectangle, else the 7.2 pt side and
 * 3.6 pt top and bottom insets the board drew its labels with.
 */
export function labelRect(item) {
  const w = item.w ?? 0;
  const h = item.h ?? 0;
  const preset = item.extra?.preset;
  if (preset) {
    const { l, t, r, b } = presetTextRect(preset[0], preset[1], w, h);
    return { x: r6(l), y: r6(t), w: r6(r - l), h: r6(b - t) };
  }
  return { x: 7.2, y: 3.6, w: r6(w - 14.4), h: r6(h - 7.2) };
}

/** A connector label's box in the world ({x, y, w, h}): its derived `labelAt` is local to the connector's box (bd-paint's
 * modelOf places the label there), so the item's derived x and y put it in the world. */
function labelBox(item, slot) {
  const at = item.labelAt?.[slot] ?? null;
  const [x, y] = Array.isArray(at) ? at : [at?.x, at?.y];
  const w = at?.w ?? LABEL_W;
  const h = at?.h ?? LABEL_H;
  const ox = item.x ?? 0;
  const oy = item.y ?? 0;
  if (Number.isFinite(x) && Number.isFinite(y)) return { x: r6(ox + x - w / 2), y: r6(oy + y - h / 2), w, h };
  return { x: r6(ox + (item.w ?? 0) / 2 - w / 2), y: r6(oy + (item.h ?? 0) / 2 - h / 2), w, h };
}

/** The width the item session lays `item` out at (the story's page), points. A label is laid out unwrapped so its box can grow
 * with the text while typing; the painted label is a text box sized to the whole text, so neither wraps. */
function layoutWidth(item, slot) {
  if (slot) return WIDE;
  if (item.type === 'shape') return Math.max(1, labelRect(item).w);
  if (item.fit === 'width') return WIDE;
  return Math.max(1, item.w ?? 1);
}

/** The edit box in the world: the text's own size for a fitted text (its stamp), the item's box for a fixed one. A label's
 * edit box is the inside of its box, where the painted text sits. */
function editBox(ctx, item, slot) {
  if (slot) {
    const b = labelBox(item, slot);
    return { x: r6(b.x + INSET.x), y: r6(b.y + INSET.y), w: Math.max(1, r6(b.w - 2 * INSET.x)), h: Math.max(1, r6(b.h - 2 * INSET.y)) };
  }
  if (item.type === 'shape') {
    const r = labelRect(item);
    return { x: r6((item.x ?? 0) + r.x), y: r6((item.y ?? 0) + r.y), w: r.w, h: r.h };
  }
  const stamp = ctx.surfaces.stampOf(item.id);
  const w = item.fit === 'width' ? Math.max(1, stamp?.textW ?? item.w ?? 1) : Math.max(1, item.w ?? stamp?.textW ?? 1);
  const h = item.fit === 'fixed' ? Math.max(1, item.h ?? 1) : Math.max(1, stamp?.textH ?? item.h ?? 1);
  return { x: item.x ?? 0, y: item.y ?? 0, w, h };
}

/** The edit placement of the current edit, on the viewport's placements after every other one. */
function applyPlacements(ctx) {
  const vp = ctx.vp;
  if (!vp) return;
  vp.setPlacements(placementsOf(ctx.store, ctx.surfaces, ctx.client.id, ctx));
}

/** Makes the viewport keep the edit placement last, whichever way it is given a new list (BoardArea's place()). */
function wrapPlacements(ctx) {
  const vp = ctx.vp;
  if (!vp || vp.boardText) return;
  const put = vp.setPlacements.bind(vp);
  vp.boardText = put;
  vp.setPlacements = (list, opts) => put(edit?.placement ? [...list, edit.placement] : list, opts);
}

function unwrapPlacements(ctx) {
  const vp = ctx.vp;
  if (!vp?.boardText) return;
  vp.setPlacements = vp.boardText;
  delete vp.boardText;
}

/** Ends the edit on Esc, captured on the view's root: the board reads no keys while a text is edited, and this runs before
 * the item session's own input (bd-text). An input method's Esc (`isComposing`, keyCode 229) cancels its composition, not the
 * edit. */
const onEscape = (ctx) => (e) => {
  if (!edit || e.code !== 'Escape' || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  e.stopPropagation();
  endEdit(ctx);
};

/** The viewport-side setup an edit needs, once per view: both, whichever of mount or the first edit comes first. */
function attach(ctx) {
  wrapPlacements(ctx);
  const root = ctx.vp?.root;
  if (!root || root.boardTextEsc) return;
  root.boardTextEsc = onEscape(ctx);
  root.addEventListener('keydown', root.boardTextEsc, true);
  // The focus leaving the board (a sidebar click, another panel) ends the edit while the sessions and the store still take it;
  // a press on the board's chrome keeps it (its controls keep the focus, and its own regions are skipped).
  root.boardTextBlur = (e) => {
    if (!edit || !e.relatedTarget) return;
    if (root.contains(e.relatedTarget) || e.relatedTarget.closest?.('[data-board-chrome]')) return;
    endEdit(ctx);
  };
  root.addEventListener('focusout', root.boardTextBlur);
}

/** Whether world point `p` is inside the box being edited. */
const inside = (p) => {
  const b = edit?.placement;
  return !!b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
};

/** Puts the caret where the press landed, selects all of it, or leaves it at the end. */
async function putCaret(ctx, at, all) {
  try {
    if (all) return void (await ctx.item.exec('select.all', {}));
    if (at) {
      const b = edit.placement;
      const { pos } = (await ctx.item.hit(0, at.x - b.x, at.y - b.y)) ?? {};
      if (pos) return void (await ctx.item.select(pos, pos));
    }
    await ctx.item.execMany([['select.all', {}], ['select.collapse', { end: true }]]);
  } catch (e) {
    console.warn('The caret was not placed', e);
  }
}

/**
 * A layout event while editing: the box follows the text's lines (`blocks`, not the page, whose height is the item's page or a
 * tall one for a box that grows). A width-fitted text takes its widest line; a height-fitted one grows to its last line.
 */
function grow(ctx) {
  const b = edit?.placement;
  if (!b) return;
  const grows = !!edit.slot || (edit.kind === 'text' && edit.fit !== 'fixed');
  if (!grows) return applyPlacements(ctx);
  ctx.item.call('blocks', [0]).then((blocks) => {
    if (edit?.placement !== b) return;
    let [w, h] = [0, 0];
    for (const block of blocks ?? []) for (const line of block.boxes ?? []) [w, h] = [Math.max(w, line.x + line.w), Math.max(h, line.y + line.h)];
    if (edit.slot) {
      // The text's own extent: the painted label is sized the same way from its story, so the box keeps up while typing.
      if (w > 0) b.w = Math.max(1, w);
      if (h > 0) b.h = Math.max(1, h);
    } else if (edit.kind === 'text') {
      if (edit.fit === 'width' && w > 0) b.w = w;
      if (h > 0) b.h = h;
    }
    applyPlacements(ctx);
  }, () => {});
}

/**
 * Edits `target` ({id, slot}) in the item session: opens its story, lays it out at the item's own width, drops the item's
 * stamp of that text and places the box; `at` (a world point) puts the caret there, `{all: true}` selects the text.
 */
export async function startEdit(ctx, target, at = null, { all = false, fresh = null } = {}) {
  const { id, slot = null } = target ?? {};
  if (!id || busy) return false;
  if (edit) await endEdit(ctx);
  // A connector's box and its labels' points are derived (bd-connect): read the item as its rule gives it.
  const item = derived(ctx.store.get(id), ctx.store, ctx.surfaces?.stampOf ?? null);
  if (!item || item.gone) return false;
  busy = true;
  const story = storyAt(item, slot) ?? textStory('');
  const box = editBox(ctx, item, slot);
  try {
    edit = { id, slot, kind: item.type, fit: item.fit ?? 'fixed', new: !!fresh, step: fresh?.step ?? null,
      placement: { key: 'edit', session: ctx.item.id, surface: 0, x: box.x, y: box.y, w: box.w, h: box.h } };
    ctx.api.editing = true;
    // A fixed text keeps its box: its page is that box, and the words past its edge are not shown (as the board draws them).
    const h = item.type === 'text' && item.fit === 'fixed' ? item.h : undefined;
    await ctx.item.open(modelOf({ type: 'text', story, w: layoutWidth(item, slot), h, fit: item.fit }, undefined, {}, { allStyles: true }), 'engine');
    await ctx.item.call('itemView', [layoutWidth(item, slot)]);
    attach(ctx);
    applyPlacements(ctx);
    // The board's stamp of this item drops the text the box shows.
    ctx.surfaces.preview(id, slot ? { labels: { ...item.labels, [slot]: null } } : { story: null });
    ctx.vp.setFocus({ session: ctx.item.id, mode: 'text' });
    // The store holds the session's client, as a Document's page area does (PageArea's onFocus).
    setState({ boardFocus: { kind: 'text', session: ctx.item }, focusedSession: ctx.item });
    ctx.vp.root?.focus?.({ preventScroll: true });
    // Each keystroke marks the draft unsaved: its text lives in the item session until the edit ends, so a save or a draft
    // switch (which skips a clean draft) has to run to take it (flushEdits, BoardArea's save).
    edit.offLayout = ctx.item.on('layout', () => {
      ctx.dirty?.();
      grow(ctx);
    });
    grow(ctx); // the box as the text lays out now, before the first keystroke
    await putCaret(ctx, at, all);
    ctx.api.emit();
    return true;
  } catch (err) {
    edit?.offLayout?.();
    edit = null;
    ctx.api.editing = false;
    ctx.vp?.setFocus(null);
    setState({ boardFocus: null, focusedSession: null });
    throw err;
  } finally {
    busy = false;
  }
}

/**
 * Ends the edit: the box's story is saved as one store step (`Edit text`), a new text left empty is removed with no undo
 * step, the item stamps itself again and the board takes the focus. `keep: false` drops what was typed.
 */
export async function endEdit(ctx, { keep = true } = {}) {
  if (!edit || busy) return false;
  // The edit stays open, and so available to `flushEdits`, until its text is taken: a save that starts while this runs
  // still writes the words (BoardArea's save, on its way out).
  const e = edit;
  busy = true;
  try {
    e.offLayout?.();
    await ctx.item.commit().catch(() => {});
    const item = ctx.store.get(e.id);
    if (keep && item && !item.gone) {
      const model = parseModel(await ctx.item.save('engine'));
      const story = storyOf(model);
      // A new label with nothing typed writes nothing (there was no slot before it); a new text item is removed whole.
      if (isEmpty(story) && e.new) {
        if (!e.slot) removeNew(ctx, e);
      } else {
        ctx.store.change('Edit text', (tx) => {
          tx.patch(e.id, e.slot ? { labels: { ...(item.labels ?? {}), [e.slot]: story } } : { story });
          if (model.media && Object.keys(model.media).length) tx.board('media', { ...ctx.store.board.media, ...model.media });
        });
      }
    }
  } finally {
    edit = null; // the box is closed once its text is in the store (or the save failed)
    busy = false;
    if (!ctx.api.destroyed) ctx.api.editing = false;
    ctx.vp?.setFocus(null);
    setState({ boardFocus: null, focusedSession: null });
    // The item's own stamp draws its text again (a story change re-stamps it too); a removed item stamps nothing.
    if (!ctx.store.get(e.id)?.gone) await ctx.surfaces.preview(e.id, {});
    applyPlacements(ctx);
    if (!ctx.api.destroyed) {
      ctx.api.emit();
      ctx.api.focus();
    }
  }
  return true;
}

/** Removes a new text item left empty, and its create's undo step, so nothing of it reaches the undo history. */
function removeNew(ctx, e) {
  if (e.step && ctx.store.steps.at(-1) === e.step) ctx.store.steps.pop();
  ctx.store.change('', (tx) => tx.remove(e.id), { silent: true });
  ctx.selection.clear();
}

/** The engine steps a ribbon patch names (the chrome's own units: a size in px). */
function stepsOf(patch, kind) {
  const steps = [];
  if (patch.font) steps.push(['format.font', { name: patch.font }]);
  if (Number.isFinite(patch.size) && patch.size > 0) steps.push(['format.size', { size: toPt(patch.size) }]);
  if (typeof patch.bold === 'boolean') steps.push(['format.bold', { value: patch.bold }]);
  if (typeof patch.italic === 'boolean') steps.push(['format.italic', { value: patch.italic }]);
  // A text item's colour arrives as `color` (its run colour); a shape's as `textColor` (its label's).
  const color = kind === 'text' ? patch.textColor ?? patch.color : patch.textColor;
  const c = rgb(color);
  if (c) steps.push(['format.color', { color: c.map((v) => v.toString(16).padStart(2, '0')).join('') }]);
  if (patch.align) steps.push([ALIGN[patch.align] ?? 'para.align', ALIGN[patch.align] ? {} : { value: patch.align }]);
  return steps;
}

/** Applies `steps` to the whole text of `ids`, one store step `Text style`, opening each story in the one item session. */
export async function restyle(ctx, ids, steps) {
  if (!steps.length) return false;
  const stories = new Map();
  await queued(async () => {
    for (const id of ids) {
      const item = ctx.store.get(id);
      if (!item || item.gone || (item.type !== 'text' && item.type !== 'shape')) continue;
      try {
        await ctx.item.open(modelOf({ type: 'text', story: storyAt(item) ?? textStory(''), w: WIDE }, undefined, {}, { allStyles: true }), 'engine');
        await ctx.item.execMany([['select.all', {}], ...steps]);
        stories.set(id, storyOf(await ctx.item.save('engine')));
      } catch (e) {
        console.warn('The text was not restyled', e);
      }
    }
  });
  if (!stories.size) return false;
  ctx.store.change('Text style', (tx) => {
    for (const [id, story] of stories) tx.patch(id, { story });
  });
  return true;
}

/** The T tool's press: a click makes a width-fitted text, a drag a height-fitted one at the dragged width. */
async function placeText(ctx, g, box) {
  const api = ctx.api;
  const fields = { type: 'text', story: textStory(''), fit: box ? 'height' : 'width', x: r6(box?.x ?? g.a.x), y: r6(box?.y ?? g.a.y) };
  if (box) fields.w = r6(box.w);
  let id = null;
  const step = ctx.store.change('Add text', (tx) => {
    id = tx.create({ ...fields, at: [null, ctx.store.orderKey(null, ctx.store.children(null).length, tx)] });
  });
  if (api.mode && !planeTools.keep()) api.setMode(null);
  ctx.selection.set(id ? [id] : []);
  const at = box ? { x: g.a.x, y: g.a.y } : g.a;
  await startEdit(ctx, { id }, at, { fresh: { step } });
}

/** What a double-click on `item` at world point `p` edits: the text, the shape's label or the connector label under the point. */
function targetAt(item, p) {
  if (item.type === 'text' || item.type === 'shape') return { id: item.id };
  if (item.type !== 'connector') return null;
  for (const slot of ['mid', 'start', 'end']) {
    if (!storyAt(item, slot)) continue;
    const b = labelBox(item, slot);
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return { id: item.id, slot };
  }
  return null;
}

/** Whether `item`'s text can be edited: a text item, a shape's label, or a connector's `slot` label when it has one. */
const editable = (item, slot = null) =>
  !!item && !item.gone && (item.type === 'text' || item.type === 'shape' || (item.type === 'connector' && !!storyAt(item, slot)));

export default registerTool({
  id: 'text',
  modes: ['text'], // the T tool (PlaneBoard.setMode refuses any other)

  mount(ctx) {
    ctxRef = ctx;
    attach(ctx);
    // The text being typed, for a save that runs while the box is open (a draft switch, an autosave): the story as the item
    // session has it now, which the written board takes without a store change, so the edit keeps its one step for its end.
    ctx.flushEdits = async () => {
      if (!edit) return [];
      try {
        const model = parseModel(await ctx.item.save('engine'));
        const story = storyOf(model);
        // A new text left empty is removed when its edit ends, and a new label left empty leaves the slot out: the written board
        // already says so.
        if (edit.new && isEmpty(story)) return edit.slot ? [] : [[edit.id, { gone: true }]];
        const fields = edit.slot ? { labels: { ...(ctx.store.get(edit.id)?.labels ?? {}), [edit.slot]: story } } : { story };
        return [[edit.id, fields]];
      } catch (e) {
        console.warn('The text was not saved', e);
        return [];
      }
    };
    let dead = false;
    let offInput = null;
    // The item session takes the app's keys and clipboard bridge: PageArea owns them, and its React tree is no node import.
    // A document focused on the board (bd-hud) is a session of the instance layer: it takes the same input, so the board keeps
    // one EditContext and one keymap for both.
    import('../../document/canvas/PageArea.jsx').then(({ KEYMAP, CLIPBOARD }) => {
      if (dead || !ctx.vp) return;
      offInput = inputOnViewport(ctx.vp, { clientOf: (id) => (id === ctx.item.id ? ctx.item : ctx.instances?.clientOf?.(id) ?? null),
        keymap: KEYMAP, clipboard: CLIPBOARD, takes: (e) => takes(ctx, e) });
      // The focused session's input, for the board's Esc (bd-hud): its snapshot's `rects` say whether a selection is there to
      // clear first. `offInput.input` is the handle of the session focused now, updated as the focus moves.
      ctx.input = offInput;
    }, () => {});
    return () => {
      dead = true;
      offInput?.();
      if (ctx.input === offInput) ctx.input = null;
      const root = ctx.vp?.root;
      if (root?.boardTextEsc) root.removeEventListener('keydown', root.boardTextEsc, true);
      if (root?.boardTextBlur) root.removeEventListener('focusout', root.boardTextBlur);
      unwrapPlacements(ctx);
      // Leaving the board mid-edit ends it as Esc does, so the story lands in the store and the board's focus fields clear. The
      // switch's save already wrote the text (flushEdits); a board left otherwise is saved here only when no edit was open.
      const draft = ctx.draft;
      if (edit) endEdit(ctx).catch(() => {});
      else if (getState().draft !== draft) ctx.save?.().catch?.(() => {});
      if (ctxRef === ctx) ctxRef = null;
    };
  },

  /** The tool's press is the tool's; while editing, a press in the box is the item session's and one outside it ends the edit. */
  pick(ctx, world) {
    if (ctx.api.mode === 'text') return { kind: 'text-place' };
    if (edit && inside(world)) return { kind: 'text' };
    return null;
  },

  down(ctx, hit, e) {
    if (!hit) return false;
    if (hit.kind === 'text') return true; // the item session places the caret
    if (hit.kind !== 'text-place') return false;
    const start = ctx.vp.fromClient(e.clientX, e.clientY).world;
    gesture = { a: start, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY };
    return true;
  },

  move(_ctx, e) {
    if (!gesture) return;
    gesture.x = e.clientX;
    gesture.y = e.clientY;
  },

  up(ctx) {
    const g = gesture;
    gesture = null;
    if (!g) return;
    let box = null;
    const [dx, dy] = [g.x - g.x0, g.y - g.y0];
    if (Math.hypot(dx, dy) >= DRAG_PX) {
      const b = ctx.vp.fromClient(g.x, g.y).world;
      box = { x: Math.min(g.a.x, b.x), y: Math.min(g.a.y, b.y), w: Math.abs(b.x - g.a.x), h: Math.abs(b.y - g.a.y) };
    }
    placeText(ctx, g, box).catch((err) => console.warn('The text was not placed', err));
  },

  cancel() {
    gesture = null;
  },

  /** A double-click on a text, a shape or a connector label edits it at the point. */
  dblclick(ctx, hit, e) {
    if (!hit || edit) return false;
    const item = derived(ctx.store.get(hit.id), ctx.store, ctx.surfaces?.stampOf ?? null);
    const world = ctx.vp.fromClient(e.clientX, e.clientY).world;
    const target = targetAt(item, world);
    if (!target) return false;
    startEdit(ctx, target, world).catch((err) => console.warn('The text was not opened', err));
    return true;
  },

  /** Enter edits the selected text, shape or connector; T arms the text tool. Esc is handled in mount while editing. */
  keydown(ctx, e) {
    if (e.ctrlKey || e.metaKey || e.altKey || edit) return false;
    const api = ctx.api;
    if (e.code === 'Enter') {
      const ids = ctx.selection.ids;
      const item = ids.length === 1 ? ctx.store.get(ids[0]) : null;
      if (!item || !editable(item, 'mid')) return false;
      const target = item.type === 'connector' ? { id: item.id, slot: 'mid' } : { id: item.id };
      startEdit(ctx, target, null, { all: true }).catch((err) => console.warn('The text was not opened', err));
      return true;
    }
    const keys = { 'board.text': () => api.setMode('text') };
    const id = keyAmong(Object.keys(keys), e);
    if (!id) return false;
    keys[id]();
    return true;
  },

  // The chrome's text controls: the selected items' stories, or the one being edited.
  methods: {
    /** Whether world point `world` is inside the box being edited (place.js keeps its menu off that press). */
    inside(world) {
      return inside(world);
    },

    setText(patch = {}) {
      const ctx = ctxRef;
      if (!ctx) return false;
      const ids = ctx.selection.ids;
      if (!ids.length) return false;
      const steps = stepsOf(patch, ctx.store.get(ids[0])?.type);
      if (!steps.length) return false;
      if (edit && ids.includes(edit.id)) {
        ctx.item.execMany(steps).catch((e) => console.warn('The text was not restyled', e));
        return true;
      }
      restyle(ctx, ids, steps).catch((e) => console.warn('The text was not restyled', e));
      return true;
    },

    /** A double-click on a layers row (LayersPanel): edits the item's text at its end. */
    editItem(item) {
      const ctx = ctxRef;
      if (!ctx || !item) return false;
      const storeItem = ctx.store.get(item.id);
      if (!editable(storeItem, 'mid')) return false;
      const target = storeItem.type === 'connector' ? { id: item.id, slot: 'mid' } : { id: item.id };
      startEdit(ctx, target, null, { all: true }).catch((err) => console.warn('The text was not opened', err));
      return true;
    },

    /** Ends an open edit (the chrome backs out): true when one was open. */
    finishEdit() {
      if (!edit || !ctxRef) return false;
      endEdit(ctxRef).catch(() => {});
      return true;
    },
  },
});

/** The item session's presses: the box being edited keeps them; a press anywhere else ends the edit. A document focused on the
 * board (bd-hud) keeps the presses on its own pages, and a press elsewhere goes back to the board. */
function takes(ctx, e) {
  if (!edit) {
    if (getState().boardFocus?.kind !== 'document') return true;
    if (e.target?.closest?.('[data-board-chrome]')) return true;
    return takesDocument(ctx.api, e);
  }
  if (e.target?.closest?.('[data-board-chrome]')) return true;
  const vp = ctx.vp;
  if (!vp) return true;
  if (inside(vp.fromClient(e.clientX, e.clientY).world)) return true;
  endEdit(ctx).catch(() => {});
  return false;
}
