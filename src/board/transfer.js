// Moving content between a document page and the board (docs/plans/board/briefs/bd-dragout.md, design section 7). The board and a
// draft are two files, so every move is made in an order that can only duplicate on a crash: content is created and saved in its
// new place before it is removed from the old one, and each step has a failure path that leaves the content where it was.
//   out    : copy into the item session, read what arrived, create the item, save the board, then cut it from the page
//   in     : paste into the page, save the draft, then remove the item and save the board
//   across : paste into the other draft, save it, then cut from the first
// The journal gets one entry for the move. A doc part says `adds` when its undo puts content back, which is what lets the journal
// undo a move in the safe order (what brings content back runs first and is saved, then what takes it away).
import { toast } from 'sonner';
import { boxOf } from './gestures.mjs';
import { textStory } from './look.mjs';
import { modelOf, storyOf } from './model.mjs';
import { derived } from './surfaces.mjs';
import { tools } from './tools/registry.js';

const OBJ = '￼';
const enc = new TextEncoder();
const dec = new TextDecoder();
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/** The widest a dragged text item is made, points. */
export const MAX_TEXT_W = 480;
const TEXT_PAD = 2; // points added to the widest line
const TABLE_PAD = 12; // and to a table's columns: its cell margins reach past them
/** Why a selection with comments or tracked changes stays in its document. */
export const REFUSED = 'Comments and tracked changes stay in the document, so this cannot be dragged out.';
/** Why a selection with a picture inside its text stays: the board's media table keeps only what a picture item or a fill names. */
export const REFUSED_PICTURES = 'Pictures inside text stay in the document, so drag the picture on its own.';

const LINES = {
  copy: 'The selection could not be copied, so nothing moved.',
  paste: 'The selection could not be placed, so nothing moved.',
  board: 'The whiteboard could not be saved, so nothing moved.',
  doc: 'The document could not be saved, so nothing moved.',
  cut: 'The document could not be changed, so nothing moved.',
  hit: 'There is no text at that point, so nothing moved.',
  move: 'That cannot move here.',
  changed: 'The selection changed, so nothing moved.',
};
/** Why a connector dropped on a page stays on the board. */
export const CONNECTOR = 'Connectors stay on the whiteboard.';

/** Why a drop on, or out of, a document someone else is editing is refused. */
export const EDITING = 'Someone else is editing this document.';
/** The version 1 seam of design section 11: whether the `doc` item `item` may be changed (a one-editor lock will arrive as a field
 * of it). The drop checks it for the document a drag leaves and the one it lands on. */
export const canEdit = (_item) => true;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const say = (ctx, line) => (ctx?.say ?? ((text) => toast(text)))(line);
const parse = (saved) => (typeof saved === 'string' ? JSON.parse(saved) : saved instanceof Uint8Array ? JSON.parse(dec.decode(saved)) : saved);

// --- the board's and a draft's save ---

/** Waits for the board's save → true when it stored. A GitHub sync holds saves, which resolve without writing, so that is no save. */
async function saveBoardNow() {
  const [{ saveNow }, { getState }] = await Promise.all([import('../app/actions.js'), import('../app/store.js')]);
  if (getState().syncing) return false;
  return saveNow();
}

/** Awaits the board's save, `ctx.saveBoard()` when the context has one → true when it stored; a throw is a failure. */
export async function savedBoard(ctx) {
  try {
    return !!(await (ctx.saveBoard ?? saveBoardNow)());
  } catch {
    return false;
  }
}

/** Awaits draft `client`'s save through its pinned session (ctx.saveDoc, tools/instance.js) → true when it stored. */
export async function savedDoc(ctx, client) {
  try {
    return !!(await (ctx.saveDoc ?? (() => false))(client.id));
  } catch {
    return false;
  }
}

/** The draft's own undo, not the journal's: the journal took `client.undo` over, and one undo of a failed paste must not undo
 * whatever entry the journal holds on top. */
const undoOf = (ctx, client) => {
  const real = ctx.journal?.real?.get?.(client)?.undo;
  return real ? real.call(client) : client.undo();
};

// --- what a page held, as board fields ---

/** Whether `node` (a model's block, part or run) carries a comment's marker or a tracked change. */
function tracked(node) {
  if (Array.isArray(node)) return node.some(tracked);
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'commentStart' || node.type === 'commentEnd') return true;
  if (typeof node.ins === 'number' || typeof node.del === 'number' || node.fmtChange || node.numChange) return true;
  for (const key in node) if (node[key] && typeof node[key] === 'object' && tracked(node[key])) return true;
  return false;
}

/** null, or the line that refuses the drag: a model that holds a comment or a tracked change (review finding 2). The comment text
 * and the revisions are tables of the document, so what a fragment carries is the markers in its blocks. */
export function refusal(model) {
  const m = parse(model);
  if (Object.keys(m.comments ?? {}).length || (m.revisions ?? []).length) return REFUSED;
  return tracked(m.body) || tracked(m.parts) ? REFUSED : null;
}

/** The media keys the blocks of `node` name (an object's `media`, a fill's): a pasted fragment's own table holds every picture of the
 * document it came from, so what it names is what it uses. */
function mediaUsed(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((n) => mediaUsed(n, out));
  else if (node && typeof node === 'object') {
    for (const key in node) {
      if (key === 'media' && typeof node[key] === 'string') out.add(node[key]);
      else mediaUsed(node[key], out);
    }
  }
  return out;
}

/** null, or the line that refuses a drag whose blocks use a picture the item does not name (one inside text): the board keeps a
 * picture only when an item's `media` or its fill names it, so the picture would be lost at the next save. */
export function refusalPictures(model, fields) {
  const m = parse(model);
  const named = new Set([fields.media, fields.fill?.media].filter((k) => k != null));
  return [...mediaUsed([m.body, m.parts])].some((key) => !named.has(key)) ? REFUSED_PICTURES : null;
}

/** The float's keys that place an object on a page: a picture's `look` is what is left, and its turn is the item's own. */
const PLACING = new Set(['wrap', 'wrapText', 'hRel', 'vRel', 'x', 'y', 'hAlign', 'vAlign', 'dist', 'distTop', 'distBottom', 'effect', 'rot',
  'flipH', 'flipV', 'id', 'z', 'wrapPolygon', 'outsideCell', 'box', 'hidden']);

const lookOf = (float) => Object.fromEntries(Object.entries(float ?? {}).filter(([key]) => !PLACING.has(key)));
const turnOf = (float) => ({ ...(float?.rot ? { rot: float.rot } : {}), ...(float?.flipH ? { flipX: true } : {}), ...(float?.flipV ? { flipY: true } : {}) });

const blank = (b) => b?.kind === 'para' && !b.text && !b.objects?.length;

/** `story` without the empty paragraph a paste leaves: the one the blank document held before a table, and the one that was left
 * after a whole paragraph (its mark came along with the copy). One after a table stays, as a table needs a paragraph after it. */
function tidy(story) {
  const blocks = [...story.blocks];
  if (blocks.length > 1 && blank(blocks[0]) && blocks[1].kind === 'table') blocks.shift();
  if (blocks.length > 1 && blank(blocks.at(-1)) && blocks.at(-2).kind === 'para') blocks.pop();
  return { ...story, blocks };
}

/** The one object a body of one paragraph holding one object character is, else null. */
function loneOf(m) {
  const body = m.body ?? [];
  const para = body.length === 1 && body[0].kind === 'para' && body[0].text === OBJ && body[0].objects?.length === 1 ? body[0] : null;
  return para?.objects[0] ?? null;
}

/** Whether `obj` floats on its page, as against sitting in a line of text. */
const floats = (obj) => !!obj?.float?.wrap && obj.float.wrap !== 'inline';

/** `float` set to put an object's top left at `at` ({x, y}, points) of its page; `wrap` replaces the wrap when given. */
function placedFloat(float, at, wrap) {
  const { hAlign: _h, vAlign: _v, ...rest } = float ?? {};
  return { ...rest, ...(wrap ? { wrap } : {}), hRel: 'page', vRel: 'page', x: r6(at.x), y: r6(at.y) };
}

/** The widest a model's tables are, points. */
function tableWidth(blocks) {
  let w = 0;
  for (const b of blocks ?? []) if (b.kind === 'table') w = Math.max(w, (b.grid ?? []).reduce((sum, c) => sum + c, 0));
  return w;
}

/**
 * The item session's saved model → the fields of the board item it becomes, with `at` ({x, y}, world points) its top left. A body
 * of one paragraph holding one object character is that object: a picture, a shape (with its text box's story as the label) or,
 * for a chart or SmartArt, a fixed text that paints it. Anything else is a text that keeps its styles, numbering and footnote
 * parts: `size.w`, the widest line the session laid out, sets its width (capped at 480 points), else the tables' and the page's text
 * width. A picture's `media` is the engine's key: transfer.js turns it into the board's content key before the item is made.
 */
export function fieldsOf(model, at = { x: 0, y: 0 }, size = null) {
  const m = parse(model);
  const body = m.body ?? [];
  const place = { x: r6(at?.x ?? 0), y: r6(at?.y ?? 0) };
  const obj = loneOf(m);
  if (obj?.type === 'image') {
    return { type: 'picture', media: obj.media, crop: obj.crop ?? [0, 0, 0, 0], alt: obj.alt ?? '', look: lookOf(obj.float),
      ...place, w: obj.w, h: obj.h, ...turnOf(obj.float) };
  }
  if (obj?.type === 'shape') {
    const fields = { type: 'shape', kind: obj.kind, fill: obj.fill ?? null, stroke: obj.stroke ?? null, strokeWidth: obj.stroke_width ?? 1,
      ...place, w: obj.w, h: obj.h, ...turnOf(obj.float) };
    if (obj.freeform) fields.freeform = obj.freeform;
    if (obj.effects) fields.effects = obj.effects;
    if (obj.extra) fields.extra = obj.extra;
    const part = obj.story != null ? m.parts?.[obj.story] : null;
    if (part) fields.story = storyOf({ body: part.blocks, parts: m.parts, styles: m.styles, numbering: m.numbering });
    return fields;
  }
  if (obj && Number.isFinite(obj.w) && Number.isFinite(obj.h)) {
    return { type: 'text', story: tidy(storyOf(m)), fit: 'fixed', ...place, w: obj.w, h: obj.h, ...turnOf(obj.float) };
  }
  const section = m.lastSection ?? {};
  const page = (section.pageW ?? 612) - (section.marginLeft ?? 72) - (section.marginRight ?? 72);
  // A little over what the lines and tables measured, so that a line never wraps for want of a hair of width.
  const widest = Math.max(size?.w ? size.w + TEXT_PAD : 0, tableWidth(body) ? tableWidth(body) + TABLE_PAD : 0);
  return { type: 'text', story: tidy(storyOf(m)), fit: 'height', ...place, w: r6(Math.max(8, Math.min(widest || page, MAX_TEXT_W))) };
}

/** The widest line of a session's `blocks(page)` answer, from `left` (the page's left margin), points; tables are read by `fieldsOf`. */
export function widestOf(blocks, left = 0) {
  let w = 0;
  const walk = (list) => {
    for (const b of list ?? []) {
      for (const box of b.boxes ?? []) w = Math.max(w, box.x + box.w - left);
      for (const row of b.rows ?? []) for (const cell of row.cells ?? []) walk(cell.blocks);
    }
  };
  walk(blocks);
  return w;
}

// --- the item session ---

/** Opens an empty document in the item session. */
const blankItem = (ctx) => ctx.item.open(modelOf({ type: 'text', story: textStory(''), w: 468, fit: 'height' }, undefined, {}, { allStyles: true }), 'engine');

/** The bytes of a data URL `url`, or null. */
function bytesOfUrl(url) {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(String(url ?? ''));
  if (!m) return null;
  const bin = atob(m[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Puts `fields`' picture into the board's media table under its content key → the fields with the key the item names. Never writes
 * the store: the table is a map the item's create reads, as `addPictures` fills it. */
async function takeMedia(ctx, model, fields) {
  const table = (ctx.store.board.media ??= {});
  const out = { ...fields };
  if (fields.type === 'picture') {
    // Loaded here: a tool file registers itself as it is imported, and the board's tools are asked in the order they were imported.
    const { extOf, mediaKey } = await import('./tools/pictures.js');
    const url = model.media?.[fields.media];
    const bytes = bytesOfUrl(url);
    if (!bytes) throw new Error('The picture has no bytes.');
    const key = await mediaKey(bytes, extOf(null, fields.media));
    if (!table[key]) table[key] = url;
    out.media = key;
    return out;
  }
  const fill = fields.fill?.media; // a shape's picture fill: refusalPictures let this one through
  if (fill != null && model.media?.[fill] !== undefined && table[fill] === undefined) table[fill] = model.media[fill];
  return out;
}

/** Whether `from`'s selection is no longer `was`, which the cut would then take instead (it changes while the move waits on a paste, a
 * save and a hit). */
async function moved(from, was) {
  return !same(await from.selection().catch(() => null), was);
}

/** Holds the journal for a move: its first half makes no entry of its own and an undo in the window is not taken, so the one entry
 * `record` makes is the only way back. `run(release)` releases before it records. */
async function holding(ctx, run) {
  const journal = ctx.journal;
  const mine = !!journal && !journal.busy;
  if (mine) journal.busy = true;
  const release = () => {
    if (mine) journal.busy = false;
  };
  try {
    return await run(release);
  } finally {
    release();
  }
}

/** Copies `from`'s selection into the item session and reads it → {model, sel} or null (the line is said): `sel` is the selection the
 * copy was made from. The page is not changed. */
async function fragment(ctx, from) {
  const sel = await from.selection().catch(() => null);
  const copied = await from.exec('edit.copy').catch(() => null);
  if (!copied?.ok) return say(ctx, LINES.copy), null;
  await blankItem(ctx);
  const pasted = await ctx.item.call('pasteSession', [from.id]);
  if (!pasted?.ok) return say(ctx, LINES.paste), null;
  const model = parse(await ctx.item.save('engine'));
  const why = refusal(model);
  if (why) return say(ctx, why), null;
  return { model, sel };
}

/** Removes item `id` with no undo step (a create that did not take). */
function dropItem(ctx, id, step) {
  if (step && ctx.store.steps.at(-1) === step) ctx.store.steps.pop();
  ctx.store.change('', (tx) => tx.remove(id), { silent: true });
}

/** The journal entry for a move, made once the hold is released. */
function record(ctx, parts, release) {
  release();
  ctx.journal?.group(parts);
}

// --- out ---

/**
 * Moves `from`'s selection out to the board with its top left at `at` ({x, y}, world points) → the new item's id, or null with the
 * reason said. `copy` leaves the page as it is. `into` names a text or shape item whose story takes the text at its end instead of
 * a new item. The page is unchanged until the item is created and the board is saved.
 */
export const moveOut = (ctx, from, at, opts = {}) => holding(ctx, (release) => out(ctx, from, at, opts, release));

async function out(ctx, from, at, { copy = false, into = null }, release) {
  const got = await fragment(ctx, from);
  if (!got) return null;
  const { model } = got;
  let id = into;
  let step = null;
  try {
    if (into) {
      const was = ctx.store.get(into);
      if (mediaUsed([model.body, model.parts]).size) return say(ctx, REFUSED_PICTURES), null;
      const joined = joinStory(was?.story, tidy(storyOf(model)));
      step = ctx.store.change('Drag in text', (tx) => tx.patch(into, { story: joined }));
      if (!step) return say(ctx, LINES.paste), null; // nothing was added: the cut must not take the text
    } else {
      const size = { w: widestOf(await ctx.item.call('blocks', [0]).catch(() => null), model.lastSection?.marginLeft ?? 72) };
      const made = fieldsOf(model, at, size);
      const why = refusalPictures(model, made);
      if (why) return say(ctx, why), null;
      const fields = await takeMedia(ctx, model, made);
      step = ctx.store.change('Drag out', (tx) => {
        id = tx.create({ ...fields, at: [null, ctx.store.orderKey(null, ctx.store.children(null).length, tx)] });
      });
    }
  } catch (e) {
    console.warn('The item was not made', e);
    return say(ctx, LINES.paste), null;
  }
  if (!await savedBoard(ctx)) {
    if (into) ctx.store.undo(step?.id);
    else dropItem(ctx, id, step);
    return say(ctx, LINES.board), null;
  }
  ctx.selection?.set?.([id]);
  if (copy) return record(ctx, [{ kind: 'board', step }], release), id;
  // The page loses the content only now, and only the selection that was copied: a crash before this line duplicates it.
  const rollback = async (line) => {
    if (into) ctx.store.undo(step.id);
    else dropItem(ctx, id, step);
    await savedBoard(ctx);
    return say(ctx, line), null;
  };
  if (await moved(from, got.sel)) return rollback(LINES.changed);
  const cut = await from.exec('edit.cut').catch(() => null);
  if (!cut?.ok) return rollback(LINES.cut);
  ctx.cutDone = true;
  const docStep = (await from.steps().catch(() => null))?.undo ?? null;
  // The doc part's undo brings the content back: `adds` runs it first, saved, before the item goes.
  record(ctx, [{ kind: 'board', step }, { kind: 'doc', session: from.id, step: docStep, adds: true }], release);
  return id;
}

/** `base`'s story with `added`'s blocks at its end (a text or shape item taking text): styles and lists come along. */
function joinStory(base, added) {
  if (!base?.blocks?.length) return added;
  const has = (list, e) => list.some((x) => x.id === e.id);
  const sheet = base.styles?.styles ?? [];
  const numbering = base.numbering ?? { abstracts: [], nums: [] };
  const lone = base.blocks.length === 1 && !base.blocks[0].text && !base.blocks[0].objects?.length;
  return {
    blocks: lone ? added.blocks : [...base.blocks, ...added.blocks],
    parts: { ...(base.parts ?? {}), ...(added.parts ?? {}) },
    styles: { ...(base.styles ?? {}), ...(added.styles ?? {}), styles: [...sheet, ...(added.styles?.styles ?? []).filter((s) => !has(sheet, s))] },
    numbering: { abstracts: [...numbering.abstracts, ...(added.numbering?.abstracts ?? []).filter((a) => !has(numbering.abstracts, a))],
      nums: [...numbering.nums, ...(added.numbering?.nums ?? []).filter((n) => !has(numbering.nums, n))] },
  };
}

// --- in ---

/** The item's model for pasting into a page: an object floats in front of the text at `at` of its page, with its turn; text is as it is. */
function modelFor(ctx, item, at) {
  const bytes = modelOf(derived(item, ctx.store, ctx.surfaces?.stampOf ?? null), undefined, ctx.media ?? {});
  if (!bytes || !['picture', 'shape', 'ink'].includes(item.type)) return bytes;
  const m = JSON.parse(dec.decode(bytes));
  const obj = m.body?.[0]?.objects?.[0];
  if (!obj) return bytes;
  obj.float = { ...placedFloat(obj.float, at, 'inFrontOfText'),
    ...(item.rot ? { rot: item.rot } : {}), ...(item.flipX ? { flipH: true } : {}), ...(item.flipY ? { flipV: true } : {}) };
  return enc.encode(JSON.stringify(m));
}

/**
 * Moves board item `id` into draft `to` at `hit` ({page, x, y}: the pointer on that page, points; `at`: where an object's top left
 * lands, else the pointer) → whether it moved. A picture or shape joins the document in front of the text, a text flows in at the
 * point. `copy` leaves the item on the board. The item goes only once the draft is saved with it.
 */
export const moveIn = (ctx, id, to, hit, opts = {}) => holding(ctx, (release) => into(ctx, id, to, hit, opts, release));

async function into(ctx, id, to, hit, { copy = false }, release) {
  const item = ctx.store.get(id);
  if (!item || item.gone) return false;
  if (item.type === 'connector') return say(ctx, CONNECTOR), false;
  if (!['picture', 'shape', 'ink', 'text'].includes(item.type)) return false;
  try {
    await ctx.item.open(modelFor(ctx, item, hit.at ?? hit), 'engine');
    await ctx.item.exec('select.all', {});
    if (!(await ctx.item.exec('edit.copy', {}))?.ok) return say(ctx, LINES.copy), false;
    const pos = (await to.hit(hit.page, hit.x, hit.y))?.pos;
    if (!pos) return say(ctx, LINES.hit), false;
    await to.select(pos, pos);
    if (!(await to.call('pasteSession', [ctx.item.id]))?.ok) return say(ctx, LINES.paste), false;
  } catch (e) {
    console.warn('The item was not placed', e);
    return say(ctx, LINES.paste), false;
  }
  const docStep = (await to.steps().catch(() => null))?.undo ?? null;
  if (!await savedDoc(ctx, to)) {
    await undoOf(ctx, to);
    return say(ctx, LINES.doc), false;
  }
  const paste = { kind: 'doc', session: to.id, step: docStep };
  if (copy) return record(ctx, [paste], release), true;
  // The item goes once the draft holds it: a crash before this line duplicates it. It goes as a delete does, so that the
  // connectors that end on it are freed.
  const step = ctx.store.change('Drag in', (tx) => {
    tools.all('removing', ctx, [id], tx);
    tx.remove(id);
  });
  // No step: the item was gone already, and the draft's paste is the whole move.
  record(ctx, step ? [paste, { kind: 'board', step }] : [paste], release);
  if (step) await savedBoard(ctx);
  return true;
}

// --- across and within ---

/** Moves `from`'s selection into draft `to` at `hit` ({page, x, y}) → whether it moved. The copy is checked for comments and tracked
 * changes first; `to` is saved with it before `from` loses it. */
export const moveAcross = (ctx, from, to, hit, opts = {}) => holding(ctx, (release) => across(ctx, from, to, hit, opts, release));

async function across(ctx, from, to, hit, { copy = false }, release) {
  const got = await fragment(ctx, from);
  if (!got) return false;
  try {
    const pos = (await to.hit(hit.page, hit.x, hit.y))?.pos;
    if (!pos) return say(ctx, LINES.hit), false;
    // A floating object lands where it was dropped, not at the place it had on its own page: it goes through the item session with
    // its float set to the drop point, as a board item does.
    let via = from.id;
    const lone = loneOf(got.model);
    if (floats(lone) && hit.at) {
      const m = structuredClone(got.model);
      loneOf(m).float = placedFloat(lone.float, hit.at);
      await ctx.item.open(enc.encode(JSON.stringify(m)), 'engine');
      await ctx.item.exec('select.all', {});
      if (!(await ctx.item.exec('edit.copy', {}))?.ok) return say(ctx, LINES.copy), false;
      via = ctx.item.id;
    }
    await to.select(pos, pos);
    if (!(await to.call('pasteSession', [via]))?.ok) return say(ctx, LINES.paste), false;
  } catch (e) {
    console.warn('The selection was not placed', e);
    return say(ctx, LINES.paste), false;
  }
  const toStep = (await to.steps().catch(() => null))?.undo ?? null;
  if (!await savedDoc(ctx, to)) {
    await undoOf(ctx, to);
    return say(ctx, LINES.doc), false;
  }
  const paste = { kind: 'doc', session: to.id, step: toStep };
  if (copy) return record(ctx, [paste], release), true;
  const rollback = async (line) => {
    await undoOf(ctx, to);
    await savedDoc(ctx, to);
    return say(ctx, line), false;
  };
  if (await moved(from, got.sel)) return rollback(LINES.changed);
  const cut = await from.exec('edit.cut').catch(() => null);
  if (!cut?.ok) return rollback(LINES.cut);
  ctx.cutDone = true;
  const fromStep = (await from.steps().catch(() => null))?.undo ?? null;
  await savedDoc(ctx, from);
  record(ctx, [paste, { kind: 'doc', session: from.id, step: fromStep, adds: true }], release);
  return true;
}

/** Moves `client`'s selection inside its own draft: a floating object takes the place `at` ({page, x, y}, its top left), text goes to
 * the caret at `hit` (one undo step, as Word's move is). `copy` puts a copy there and leaves the original. → whether it moved. */
export async function moveWithin(ctx, client, hit, { copy = false, object = null } = {}) {
  try {
    if (object?.floating && !copy) {
      const at = hit.at ?? hit;
      return !!(await client.execMany([['arrange.bounds', { page: hit.page, x: r6(at.x), y: r6(at.y) }]]))?.ok;
    }
    const sel = await client.selection();
    const pos = (await client.hit(hit.page, hit.x, hit.y))?.pos;
    if (!sel || !pos) return say(ctx, LINES.hit), false;
    // An object is copied where it lands (a floating one by its place, one in a line by the text position); text is moved or copied
    // to the caret.
    const at = hit.at ?? hit;
    const r = await client.execMany(object && copy
      ? [['arrange.copyTo', object.floating ? { page: hit.page, x: r6(at.x), y: r6(at.y) } : { to: pos }]]
      : [['select.range', { anchor: pos, focus: pos }], ['edit.moveTo', { anchor: sel.anchor, focus: sel.head, copy }]]);
    if (!r?.ok) return say(ctx, LINES.move), false;
    return true;
  } catch (e) {
    console.warn('The selection was not moved', e);
    return false;
  }
}

// --- where a drop lands ---

/**
 * What world point `world` is over for a drop: a page of a document (`{kind: 'page', doc, page, x, y}`, the point on that page in
 * points, `own` when the drag began on that page) unless Space is held (Figma's rule: Space keeps it free); else a text or shape item
 * (`{kind: 'text', id}`, whose story takes dropped text at its end); else the plane. A locked document is no target: a point over its
 * pages is `{kind: 'locked', doc}`, which the caller refuses with EDITING. `e`: `{space, start: {doc, page}}`.
 */
export function dropTarget(ctx, world, e = {}) {
  const items = ctx.store.live();
  if (!e.space) {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== 'doc' || item.gone || item.hidden) continue;
      const rects = ctx.instances?.rectsFor?.(item) ?? [];
      const page = rects.findIndex((r) => world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h);
      if (page >= 0) {
        if (item.locked) return { kind: 'locked', doc: item.id };
        return { kind: 'page', doc: item.id, page, x: world.x - rects[page].x, y: world.y - rects[page].y,
          own: e.start?.doc === item.id && e.start?.page === page };
      }
    }
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if ((item.type !== 'text' && item.type !== 'shape') || item.gone || item.hidden || item.locked) continue;
    const b = boxOf(derived(item, ctx.store, ctx.surfaces?.stampOf ?? null), ctx.store);
    if (b && world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y && world.y <= b.y + b.h) return { kind: 'text', id: item.id };
  }
  return { kind: 'plane' };
}
