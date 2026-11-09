// bd-layers (docs/plans/board/briefs/bd-layers.md): groups as items, the plane board's layer tree, rename and reorder, and the
// selection's scope (stepping into a group). Keys, picks and double-clicks arrive through the registry's hooks: bd-select's
// pointer.js and bd-api's api.js stay as they are.
import { keyAmong } from '../../app/keybinds.js';
import { kOf } from '../../engine/view/camera.mjs';
import { LATER } from '../api.js';
import { DRAG_PX, boxOf, turnedBox, unionBox } from '../gestures.mjs';
import { plainOf } from '../look.mjs';
import { registerType } from '../surfaces.mjs';
import { registerTool, tools } from './registry.js';

// LATER (api.js) lists the methods a missing module brings, and can() reads it: these three land here, so they leave the list.
for (const name of ['group', 'canUngroup']) delete LATER[name];
const TOLERANCE_PX = 3; // how far past a stamp's box a press still lands on it (pointer.js's own)

/** A group keeps no geometry: its box is the union of its children's turned boxes, read every time it is asked for. A group a
 * merge left with no live children has no box at all, never one at the origin. */
registerType('group', {
  derive: (group, store) => {
    if (!store) return null;
    const children = store.children(group.id);
    if (!children.length) return null;
    return unionBox(children.map((child) => turnedBox(boxOf(child, store), child.rot ?? 0)));
  },
});

/** The layer names the panel shows: a stored name, else the type's own, a text's first 24 characters. */
export function nameOf(item) {
  if (item.name) return item.name;
  if (item.type === 'text') return (plainOf(item.story) || 'Text').replace(/\s+/g, ' ').trim().slice(0, 24).trim() || 'Text';
  if (item.type === 'shape') {
    if (item.kind === 'line') return item.extra?.arrowEnd ? 'Arrow' : 'Line';
    if (item.kind === 'ellipse') return 'Ellipse';
    if (item.kind === 'rectangle' || item.kind === 'roundedRectangle') return 'Rectangle';
    return 'Shape';
  }
  return { group: 'Group', picture: 'Picture', ink: 'Ink', connector: 'Connector', doc: 'Document' }[item.type] ?? 'Item';
}

/** `id` and everything under it, live: a move or a delete carries a group's children. */
function withDescendants(store, ids) {
  const out = new Set();
  const walk = (id) => {
    const item = store.get(id);
    if (!item || item.gone || out.has(id)) return;
    out.add(id);
    for (const child of store.children(id)) walk(child.id);
  };
  for (const id of ids) walk(id);
  return [...out];
}

/** The id among `id`'s ancestors that sits directly in `scope`, or null when it is not inside it. */
function childInScope(store, id, scope) {
  let cur = store.get(id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = cur.at?.[0] ?? null;
    if (parent === scope) return cur.id;
    if (parent == null) return null;
    cur = store.get(parent);
    if (!cur || cur.gone) break;
  }
  return null;
}

/** Whether `id` sits inside `ancestor` (a group), at any depth. */
function inside(store, id, ancestor) {
  let cur = store.get(id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = cur.at?.[0] ?? null;
    if (parent == null) return false;
    if (parent === ancestor) return true;
    cur = store.get(parent);
    if (!cur || cur.gone) return false;
  }
  return false;
}

/** Whether `id` or one of its ancestors is locked (a locked group locks its children for `pick`). */
function lockedUp(store, id) {
  let cur = store.get(id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    if (cur.locked) return true;
    seen.add(cur.id);
    const parent = cur.at?.[0] ?? null;
    const next = parent == null ? null : store.get(parent);
    cur = next && !next.gone ? next : null;
  }
  return false;
}

/** Marks every group in `ids`' ancestry that the removes in this step leave empty gone, in the same step. */
function sweepGroups(store, ids, tx) {
  const going = new Set(ids);
  for (const id of ids) {
    const seen = new Set(); // this walk's own chain: a stored cycle must not loop it
    let parent = store.get(id)?.at?.[0] ?? null;
    while (parent != null && !seen.has(parent)) {
      seen.add(parent);
      const group = store.get(parent);
      if (!group || group.gone) break;
      if (group.type === 'group' && store.children(parent).every((child) => going.has(child.id))) tx.set(parent, 'gone', true);
      parent = group.at?.[0] ?? null;
    }
  }
}

/** Marks `id` and every ancestor group this step leaves with no live children gone, in the same step: a layer moved out of
 * its last group, or a group gathered elsewhere, never leaves an empty group behind. */
function buryEmpty(store, tx, id) {
  const seen = new Set();
  let parent = id;
  while (parent != null && !seen.has(parent)) {
    seen.add(parent);
    const group = store.get(parent);
    if (!group || group.gone || group.type !== 'group' || store.children(parent).length) break;
    const above = group.at?.[0] ?? null;
    tx.set(parent, 'gone', true);
    parent = above;
  }
}

/** The top of the selection: its live items without a selected ancestor (a selected group already holds its children). */
function topOfSelection(store, ids) {
  const items = ids.map((id) => store.get(id)).filter((item) => item && !item.gone);
  return items.filter((item) => !items.some((other) => other.id !== item.id && inside(store, item.id, other.id)));
}

let grip = null; // the press's drag inside a group's scope: {ids, base, x0, y0, dx, dy}
let altDrag = false; // Alt was held on the drag's last frame: the drop is bd-clip's duplicate, not this module's move

export default registerTool({
  id: 'layers',

  mount(ctx) {
    if (ctx.selection.scope === undefined) ctx.selection.scope = null;
  },

  // A press over an item a locked group holds goes nowhere: pointer.js would otherwise select the locked group.
  pick(ctx, world) {
    if (ctx.api?.mode) return null;
    const v = ctx.vp;
    if (!v) return null;
    const tol = TOLERANCE_PX / kOf(v.camera.zoom);
    let blocked = false;
    for (let i = v.placements.length - 1; i >= 0; i--) {
      const p = v.placements[i];
      if (world.x < p.x - tol || world.x > p.x + p.w + tol || world.y < p.y - tol || world.y > p.y + p.h + tol) continue;
      const item = ctx.store.get(p.key);
      if (!item || item.gone) continue;
      if (!lockedUp(ctx.store, item.id)) return null; // the normal hit test finds this one
      blocked = true;
    }
    return blocked ? { kind: 'locked' } : null;
  },

  // Inside a group's scope a click selects what sits directly in that group; a press outside it steps out. A press on an item
  // there is this module's gesture (pointer.js would select the top group), so its move is written here too.
  down(ctx, hit, e) {
    if (ctx.api?.mode) return false;
    const scope = ctx.selection.scope ?? null;
    if (scope == null) return false;
    if (!hit?.id) {
      ctx.selection.scope = null; // a click on the empty plane steps out
      return false;
    }
    const item = ctx.store.get(hit.id);
    if (!item || item.gone) return false;
    const target = e.ctrlKey || e.metaKey ? item.id : childInScope(ctx.store, item.id, scope);
    if (!target) {
      ctx.selection.scope = null; // a click outside the group steps out
      return false;
    }
    const sel = ctx.selection;
    if (e.shiftKey) sel.toggle(target);
    else if (!sel.has(target)) sel.set([target]);
    if (!sel.has(target)) return true; // Shift removed it: nothing to drag
    const ids = withDescendants(ctx.store, sel.ids).filter((id) => ctx.store.get(id)?.type !== 'group');
    const base = {};
    for (const id of ids) {
      const it = ctx.store.get(id);
      if (it && !it.gone) base[id] = { x: it.x ?? 0, y: it.y ?? 0 };
    }
    grip = { ids, base, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false };
    return true;
  },

  // pointer.js hands every drag frame to this hook before the drop, as {ctrl, shift, alt} (or a pointer event): Alt there
  // makes the move a duplicate (bd-clip).
  moveFrame(_ctx, _ids, _dx, _dy, e) {
    altDrag = !!(e?.alt ?? e?.altKey);
    return null; // the delta is unchanged
  },

  move(ctx, e) {
    if (!grip) return;
    if (!grip.moved && Math.hypot(e.clientX - grip.x0, e.clientY - grip.y0) < DRAG_PX) return;
    grip.moved = true;
    const k = kOf(ctx.vp.camera.zoom);
    let [dx, dy] = [(e.clientX - grip.x0) / k, (e.clientY - grip.y0) / k];
    if (e.shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    const step = tools.frame(ctx, grip.ids, dx, dy, e); // bd-snap adjusts the delta here as it does for pointer.js's drags
    grip.dx = step.dx;
    grip.dy = step.dy;
    ctx.vp.nudge(grip.ids, step.dx, step.dy);
    const fields = {};
    for (const [id, start] of Object.entries(grip.base)) fields[id] = { x: start.x + step.dx, y: start.y + step.dy };
    ctx.selection.setPreview(fields);
  },

  up(ctx) {
    const g = grip;
    grip = null;
    if (!g) return;
    ctx.selection.setPreview(null);
    ctx.vp?.nudge(null);
    if (!g.moved || (!g.dx && !g.dy)) return;
    const fields = {};
    for (const [id, start] of Object.entries(g.base)) fields[id] = { x: start.x + g.dx, y: start.y + g.dy };
    ctx.store.change('Move', (tx) => {
      for (const [id, f] of Object.entries(fields)) tx.patch(id, f);
    });
  },

  cancel(ctx) {
    if (!grip) return;
    grip = null;
    ctx.selection.setPreview(null);
    ctx.vp?.nudge(null);
  },

  // A group moves by its children, which the move's ids already hold. Its resize, turn and flip write nothing (the user's
  // note of 2026-11-03: bd-select's default transform keeps a group to move only).
  transform(ctx, ids, { kind, fields }) {
    if (altDrag) return null; // Alt+drag duplicates: bd-clip's transform answers that move (its `moved` hook clones)
    if (!ids.some((id) => ctx.store.get(id)?.type === 'group')) return null;
    if (kind !== 'move') return null;
    return ids.filter((id) => ctx.store.get(id)?.type !== 'group').map((id) => [id, fields[id]]);
  },

  // Inside a delete's step: a group the delete leaves empty goes with it.
  removing(ctx, ids, tx) {
    sweepGroups(ctx.store, ids, tx);
  },

  // A double-click on a member of a group steps into that group. A text edits instead (bd-text).
  dblclick(ctx, hit) {
    const item = hit?.item;
    if (!item || item.type === 'text') return false;
    const parent = item.at?.[0] != null ? ctx.store.get(item.at[0]) : null;
    if (!parent || parent.gone || parent.type !== 'group') return false;
    if (ctx.selection.scope === parent.id) return false; // already inside: the next double-click is the item's own (bd-text)
    ctx.selection.scope = parent.id;
    ctx.selection.set([item.id]);
    return true;
  },

  keydown(ctx, e) {
    const api = ctx.api;
    const store = ctx.store;
    const sel = ctx.selection;
    if (e.code === 'Escape' && sel.scope != null) {
      // Step out: the group is the selection again, as in Figma. A second Esc deselects (pointer.js).
      sel.scope = null;
      sel.set([ctx.store.get(sel.ids[0])?.at?.[0]].filter(Boolean));
      return true;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.code === 'Enter' && e.shiftKey || e.code === 'Backslash') {
        const parents = [...new Set(sel.ids.map((id) => store.get(id)?.at?.[0]).filter((id) => id != null && store.get(id) && !store.get(id).gone))];
        if (!parents.length) return false;
        const above = store.get(parents[0])?.at?.[0] ?? null;
        sel.scope = above != null && store.get(above)?.type === 'group' ? above : null;
        sel.set(parents);
        return true;
      }
      if (e.code === 'Enter') {
        const groups = sel.ids.map((id) => store.get(id)).filter((i) => i && !i.gone && i.type === 'group');
        if (!groups.length) return false;
        sel.scope = groups[0].id;
        sel.set(groups.flatMap((g) => store.children(g.id).map((k) => k.id)));
        return true;
      }
      // Inside a group Tab steps between its members; at the top level bd-a11y reads the board in reading order.
      if (e.code === 'Tab' && sel.scope != null && sel.ids.length === 1) {
        const item = store.get(sel.ids[0]);
        const siblings = item && !item.gone ? store.children(item.at?.[0] ?? null) : [];
        const at = siblings.findIndex((k) => k.id === item?.id);
        if (at < 0) return false;
        sel.set([siblings[(at + (e.shiftKey ? -1 : 1) + siblings.length) % siblings.length].id]);
        return true;
      }
      return false;
    }
    const keys = {
      'board.group': () => api.group(),
      'board.ungroup': () => api.group(false),
      'board.lock': () => api.setLayer('locked'),
      'board.hide': () => api.setLayer('hidden'),
      'board.forward': () => api.arrange('forward'),
      'board.front': () => api.arrange('front'),
      'board.backward': () => api.arrange('backward'),
      'board.back': () => api.arrange('back'),
    };
    const id = keyAmong(Object.keys(keys), e);
    if (!id) return false;
    keys[id]();
    return true;
  },

  methods: {
    group,
    canUngroup,
    select,
    tree,
    renameLayer,
    moveLayer,
    hover,
    renameItem,
    removeItem,
  },
});

/** Group (Ctrl+G) the selection: one `group` item at the topmost member's place, the members keep their order keys inside it.
 * Ungroup (`on` false, Ctrl+Shift+G) is `ungroup`. */
function group(on = true) {
  const store = this.store;
  if (on === false) return ungroup.call(this);
  const items = topOfSelection(store, this.selection.ids);
  if (items.length < 2) return false;
  const order = new Map(store.live().map((item, i) => [item.id, i]));
  const top = items.reduce((a, b) => (order.get(b.id) > order.get(a.id) ? b : a));
  const parent = top.at?.[0] ?? null;
  const from = new Set(items.map((item) => item.at?.[0] ?? null));
  let id = null;
  store.change('Group', (tx) => {
    id = tx.create({ type: 'group', at: [parent, top.at?.[1] ?? ''] });
    for (const item of items) tx.set(item.id, 'at', [id, item.at?.[1] ?? '']);
    for (const old of from) buryEmpty(store, tx, old); // a group gathered away leaves nothing behind
  });
  this.selection.set([id]);
  return true;
}

/** A group's children take the group's parent and its place between its neighbours; the group is gone. */
function ungroup() {
  const store = this.store;
  const groups = this.selection.ids.map((id) => store.get(id)).filter((item) => item && !item.gone && item.type === 'group');
  if (!groups.length) return false;
  const out = [];
  store.change('Ungroup', (tx) => {
    for (const g of groups) {
      const parent = g.at?.[0] ?? null;
      for (const child of store.children(g.id)) {
        const at = store.children(parent).findIndex((item) => item.id === g.id); // the group still holds its place
        tx.set(child.id, 'at', [parent, store.orderKey(parent, at, tx)]);
        out.push(child.id);
      }
      tx.set(g.id, 'gone', true);
    }
  });
  this.selection.set(out.filter((id) => !store.get(id)?.gone));
  return true;
}

function canUngroup() {
  return this.selection.ids.some((id) => {
    const item = this.store.get(id);
    return !!item && !item.gone && item.type === 'group';
  });
}

/** The selection, with the group's scope the layers panel sets on a row. `scope` left out keeps the one in force. */
function select(ids, scope) {
  this.selection.set(ids == null ? [] : Array.isArray(ids) ? ids : [ids]);
  if (scope !== undefined) this.selection.scope = scope ?? null;
}

/** The panel's rows, topmost first: `{id, name, type, depth, hidden, locked, open, selected}`. `open` holds the group ids the
 * panel shows expanded; a group's children follow its row only then. A document's pages follow its row, read only. */
function tree(open = null) {
  const shown = open instanceof Set ? open : new Set(open ?? []);
  const rows = [];
  const walk = (parent, depth) => {
    for (const item of [...this.store.children(parent)].reverse()) {
      const isOpen = item.type === 'group' && shown.has(item.id);
      rows.push({ id: item.id, name: nameOf(item), type: item.type, depth, hidden: !!item.hidden, locked: !!item.locked,
        open: isOpen, selected: this.selection.has(item.id) });
      if (isOpen) walk(item.id, depth + 1);
      if (item.type === 'doc') {
        const pages = this.instances?.pagesOf(item.id) ?? [];
        for (let k = 0; k < pages.length; k++) {
          rows.push({ id: `${item.id}:${k}`, name: `Page ${k + 1}`, type: 'page', depth: depth + 1, hidden: false, locked: false,
            open: false, selected: this.selection.page?.id === item.id && this.selection.page.page === k });
        }
      }
    }
  };
  walk(null, 0);
  return rows;
}

/** Inline rename (L6), one step `Rename`. A name stops at 200 characters. */
function renameLayer(id, name) {
  const item = this.store.get(id);
  const value = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  if (!item || item.gone || !value || value === nameOf(item)) return false;
  this.store.change('Rename', (tx) => tx.set(id, 'name', value));
  return true;
}

/** Reorder or reparent a row (L4): `id` goes under `parent` (null: the top level) just before `beforeId` (null: last, the
 * topmost place). Into its own descendant is refused, and a document stays at the top level. One step `Reorder`. */
function moveLayer(id, parent, beforeId = null) {
  const store = this.store;
  const item = store.get(id);
  if (!item || item.gone || beforeId === id) return false;
  const p = parent ?? null;
  if (p != null) {
    const owner = store.get(p);
    if (!owner || owner.gone || owner.type === 'doc') return false;
    if (p === id || inside(store, p, id)) return false;
  }
  if (item.type === 'doc' && p != null) return false;
  const kids = store.children(p).filter((k) => k.id !== id);
  const at = beforeId == null ? kids.length : kids.findIndex((k) => k.id === beforeId);
  if (at < 0) return false;
  const siblings = store.children(p);
  const now = siblings.findIndex((k) => k.id === id);
  if (now >= 0 && (beforeId == null ? now === siblings.length - 1 : siblings[now + 1]?.id === beforeId)) return false;
  const from = item.at?.[0] ?? null;
  store.change('Reorder', (tx) => {
    tx.set(id, 'at', [p, store.orderKey(p, at, tx)]);
    if (from !== p) buryEmpty(store, tx, from); // its last child moved out: the group goes too
  });
  return true;
}

/** The hover outline (L11): the item id (or ids) the panel has its pointer on, or null for none. */
function hover(ids) {
  this.selection.setHover(ids == null ? null : Array.isArray(ids) ? ids[0] ?? null : ids);
  return true;
}

/** The Layers rename (L6): selects the layer and asks the panel to edit its name inline (`renameId`). */
function renameItem(target) {
  const id = typeof target === 'string' ? target : target?.id;
  const item = id && this.store.get(id);
  if (!item || item.gone) return false;
  this.selection.set([id]);
  this.renameId = id;
  this._changed();
  return true;
}

/** Delete (a group the delete leaves empty goes in the same step); the plane board's own, so the button path agrees with
 * pointer.js's Delete, which calls the `removing` hook. */
function removeItem() {
  const ids = this.selection.ids;
  if (!ids.length) return;
  const all = withDescendants(this.store, ids);
  this.store.change('Delete', (tx) => {
    sweepGroups(this.store, all, tx);
    for (const id of ids) tx.remove(id);
  });
  this.selection.clear();
}
