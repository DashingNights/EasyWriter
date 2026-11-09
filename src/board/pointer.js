// The board's pointer and keys (docs/plans/board/briefs/bd-select.md): pick, select, marquee, move, resize, rotate, hover, edge
// panning, nudges, flips and zoom to selection. Tools take a gesture through the registry's hooks; this module only dispatches.
// Capture-phase listeners on the view's root run before the pan driver's, so a press that starts a board gesture is never a pan.
import { fitRect, kOf } from '../engine/view/camera.mjs';
import { BIG_NUDGE, DRAG_PX, NUDGE, boxOf, dragIds, edgeDepth, marqueeHits, moved, resized, rotated, turnedBox, unionBox } from './gestures.mjs';
import { placementsOf } from './surfaces.mjs';
import { tools } from './tools/registry.js';

const ARROWS = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
const EDGE = 8; // CSS px from the view's edge where a drag pans it
const EDGE_SPEED = 800; // CSS px a second at the very edge
const NUDGE_JOIN_MS = 500; // arrow presses this close are one undo step
const HANDLE_PX = 6; // half a corner handle's 12 px target (it draws 8 px)
// A handle's screen angle, counterclockwise from east, and the cursors for 0, 45, 90 and 135 degrees.
const HANDLE_ANGLE = { e: 0, ne: 45, n: 90, nw: 135, w: 180, sw: 225, s: 270, se: 315 };
const RESIZE_CURSORS = ['ew-resize', 'nesw-resize', 'ns-resize', 'nwse-resize'];
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M6 15a7 7 0 1 1 3 4" fill="none" stroke="white" stroke-width="4"/><path d="M6 15a7 7 0 1 1 3 4" fill="none" stroke="black" stroke-width="1.6"/><path d="M3 12l3 4 3-4z" fill="black" stroke="white" stroke-width="1"/></svg>')}") 12 12, crosshair`;
const ROTATE_PX = 16; // the rotate zone outside a corner
const STRIP_PX = 6; // an edge strip's width
const TOLERANCE_PX = 3; // how far past a stamp's box a hit still lands on it

/** A control a key must not reach past: form fields, and any widget the board's chrome may hold. */
const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);
const FIELD_ROLES = ['textbox', 'spinbutton', 'combobox', 'slider'];
const FIELDS = `[role="dialog"], ${FIELD_ROLES.map((role) => `[role="${role}"]`).join(', ')}`;
const onField = (target) => {
  if (!target || target.nodeType == null) return false;
  if (target.isContentEditable || FIELD_TAGS.has(target.tagName)) return true;
  const role = target.getAttribute?.('role');
  if (role && FIELD_ROLES.includes(role)) return true;
  return !!target.closest?.(FIELDS);
};

/** Whether the target is a field or an EditContext editing host (the viewport's root while a session has the keys): a key or
 * a paste there is the input's. A press is not: a press outside an open text ends it and picks what it lands on (onDown). */
const onFieldOrInput = (target) => {
  if (onField(target)) return true;
  for (let el = target; el; el = el.parentElement) if (el.editContext) return true;
  return false;
};

/** The board's pointer over `ctx` (store, selection, vp, client, surfaces): returns its off() for BoardArea's unmount. */
export function boardPointer(ctx) {
  const root = ctx.vp?.root;
  if (!root) return () => {};
  const { store, selection: sel, client, surfaces } = ctx;
  const vp = () => ctx.vp;
  const k = () => kOf(vp().camera.zoom);
  const worldOf = (cx, cy) => vp().fromClient(cx, cy).world;
  const offs = [];
  const on = (type, fn, opts) => {
    root.addEventListener(type, fn, opts);
    offs.push(() => root.removeEventListener(type, fn, opts));
  };
  let press = null; // the press in hand
  let frame = 0; // the drag's frame loop
  let space = false; // Space is held: the pan driver has the press
  let edgeOff = false; // the window lost focus: a drag's edge pan stops until the next press
  let nudgeRun = null; // the arrows' open undo step

  /** Whether item `id` may be resized, turned or flipped: a group is not until bd-layers answers the transform hook, and a
   * document is not at all (its box is its pages', moved by bd-section's drag). */
  const transformable = (id) => {
    const item = store.get(id);
    return !!item && item.type !== 'group' && item.type !== 'doc';
  };

  /** What a transform writes: a tool's `transform` hook answers for its own items; otherwise the default runs. The default
   * moves a group's children with `move` but refuses a group's resize, turn and flip (no write). */
  const defaultTransform = (kind, ids, fields) => {
    if (kind !== 'move' && ids.some((id) => store.get(id)?.type === 'group')) return null;
    const out = {};
    for (const id of ids) {
      const item = store.get(id);
      if (item && !item.gone && item.type !== 'group') out[id] = fields[id];
    }
    return out;
  };
  const transformOf = (kind, ids, fields, extra = {}) => {
    const answer = tools.first('transform', ctx, ids, { kind, fields, ...extra }) ?? defaultTransform(kind, ids, fields);
    if (!answer) return null;
    return Array.isArray(answer) ? answer : Object.entries(answer);
  };

  /** The topmost live group of `id`: a click on a child selects the group it sits in. */
  const topOf = (id) => {
    let cur = store.get(id);
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = cur.at?.[0] != null ? store.get(cur.at[0]) : null;
      if (!parent || parent.gone) break;
      cur = parent;
    }
    return cur;
  };

  /** The selected ids with every descendant: a move, a delete and a nudge carry a group's children. */
  const withChildren = (ids) => {
    const out = new Set();
    const walk = (id) => {
      const item = store.get(id);
      if (!item || item.gone || out.has(id)) return;
      out.add(id);
      for (const child of store.children(id)) walk(child.id);
    };
    for (const id of ids) walk(id);
    return [...out];
  };

  /** The item under world point `world`, topmost first, against each stamp's own frame; locked and hidden items are skipped. */
  const hitAt = async (world) => {
    const v = vp();
    if (!v) return null;
    const tol = TOLERANCE_PX / k();
    const list = v.placements;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (world.x < p.x - tol || world.x > p.x + p.w + tol || world.y < p.y - tol || world.y > p.y + p.h + tol) continue;
      const item = store.get(p.key);
      if (!item || item.gone || item.hidden || item.locked) continue;
      let hit = false;
      try {
        hit = await client.call('boardHit', [p.surface, world.x - p.x, world.y - p.y, tol]);
      } catch {
        hit = false;
      }
      if (hit) return item;
    }
    return null;
  };

  /** The handle or rotate zone of the selection at world point `world`, or null. Multi-selection boxes take turns, not resizes. */
  const zoneAt = (world) => {
    const ids = [...sel.ids];
    if (!ids.length || !ids.every(transformable)) return null;
    const one = ids.length === 1 ? store.get(ids[0]) : null;
    // A connector's box is its route: it has end and segment handles (bd-connect), never resize or turn zones.
    if (one?.type === 'connector') return null;
    const rot = one ? one.rot ?? 0 : 0;
    const box = one ? boxOf(one, store)
      : unionBox(ids.map((id) => { const it = store.get(id); return it && !it.gone ? boxOf(it, store) : null; }));
    if (!box) return null;
    const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const a = (-rot * Math.PI) / 180;
    const dx = world.x - c.x;
    const dy = world.y - c.y;
    const p = { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
    const [hl, hr] = [HANDLE_PX / k(), ROTATE_PX / k()];
    const strip = STRIP_PX / k();
    const inside = p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
    const corners = [['nw', -1, -1], ['ne', 1, -1], ['se', 1, 1], ['sw', -1, 1]].map(([name, fx, fy]) =>
      [name, Math.abs(p.x - (c.x + (fx * box.w) / 2)), Math.abs(p.y - (c.y + (fy * box.h) / 2))]);
    if (one) {
      for (const [name, ox, oy] of corners) if (ox <= hl && oy <= hl) return { kind: 'resize', handle: name };
      // An edge strip sits across the edge line, half outside, as Figma's does. The body takes precedence on a narrow axis: an
      // item under two and a half strips wide has no edge strip on that axis.
      const edges = [];
      const inX = p.x >= box.x && p.x <= box.x + box.w;
      const inY = p.y >= box.y && p.y <= box.y + box.h;
      if (box.w >= 2.5 * strip && inY) edges.push([p.x - box.x, 'w'], [box.x + box.w - p.x, 'e']);
      if (box.h >= 2.5 * strip && inX) edges.push([p.y - box.y, 'n'], [box.y + box.h - p.y, 's']);
      const near = edges.filter(([d]) => d >= -strip && d <= strip).sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))[0];
      if (near) return { kind: 'resize', handle: near[1] };
    }
    if (inside) return null;
    for (const [, ox, oy] of corners) if (Math.hypot(ox, oy) <= hr) return { kind: 'rotate' };
    return null;
  };

  /** The cursor for zone `zone` of the selection: a resize arrow along its handle's axis as the item is turned, or the turn. */
  const cursorOf = (zone) => {
    if (!zone) return '';
    if (zone.kind === 'rotate') return ROTATE_CURSOR;
    const one = sel.ids.length === 1 ? store.get(sel.ids[0]) : null;
    const angle = (HANDLE_ANGLE[zone.handle] - (one?.rot ?? 0) + 3600) % 180;
    return RESIZE_CURSORS[Math.round(angle / 45) % 4];
  };

  /** Shows a resize or a turn: each item's stamp is sent with the preview fields, then the placements follow them. */
  const previewFrame = (p, fields) => {
    if (p.busy) return;
    p.busy = true;
    sel.setPreview(fields);
    const ids = Object.keys(fields);
    Promise.all(ids.map((id) => surfaces.preview(id, fields[id]))).then(() => {
      p.busy = false;
      const v = vp();
      if (v && sel.preview === fields) v.setPlacements(placementsOf(store, surfaces, client.id, ctx, fields));
    }, () => {
      p.busy = false;
    });
  };

  const edgePan = (p) => {
    if (edgeOff) return;
    const r = root.getBoundingClientRect();
    const [m, max] = [EDGE, EDGE_SPEED];
    const dx = p.cx < r.left + m ? -(r.left + m - p.cx) : p.cx > r.right - m ? p.cx - (r.right - m) : 0;
    const dy = p.cy < r.top + m ? -(r.top + m - p.cy) : p.cy > r.bottom - m ? p.cy - (r.bottom - m) : 0;
    const now = performance.now();
    const dt = Math.min(0.05, (now - (p.last ?? now)) / 1000);
    p.last = now;
    if (!dx && !dy) return;
    const c = vp().camera;
    vp().setCamera({ x: c.x + (Math.sign(dx) * edgeDepth(dx, m) * max * dt) / k(),
      y: c.y + (Math.sign(dy) * edgeDepth(dy, m) * max * dt) / k(), zoom: c.zoom });
  };

  /** One drag frame: the world point under the pointer decides the delta, each tool may adjust it, then the slots follow. */
  const applyDrag = (p) => {
    const d = p.drag;
    const world = worldOf(p.cx, p.cy);
    if (d.kind === 'marquee') {
      sel.setMarquee({ x: p.world0.x, y: p.world0.y, w: world.x - p.world0.x, h: world.y - p.world0.y });
      return;
    }
    // The keys as they are now, not as the press had them: Ctrl or Shift pressed mid-drag changes what the delta means.
    const mods = { ctrl: p.ctrl, shift: p.shift, alt: p.alt };
    if (d.kind === 'move') {
      const raw = moved({ x: 0, y: 0 }, world.x - p.world0.x, world.y - p.world0.y, { shift: p.shift });
      const step = tools.frame(ctx, sel.ids, raw.x, raw.y, mods);
      d.delta = step;
      vp().nudge(d.ids, step.dx, step.dy);
      const fields = {};
      for (const [id, start] of Object.entries(d.base)) fields[id] = { x: start.x + step.dx, y: start.y + step.dy };
      sel.setPreview(fields);
      return;
    }
    if (d.kind === 'resize') {
      let [dx, dy] = [world.x - p.world0.x, world.y - p.world0.y];
      let fields = resized(d.start, d.handle, dx, dy, { ...mods, rot: d.rot });
      // A resize's moving edges snap (no turned item: its box is read in its own frame); the correction goes back through the
      // delta, so the opposite corner still holds.
      if (!d.rot) {
        const edges = [...d.handle];
        const step = tools.frame(ctx, { ids: [d.id], box: fields, edges }, dx, dy, mods);
        if (step.dx !== dx || step.dy !== dy) {
          [dx, dy] = [step.dx, step.dy];
          fields = resized(d.start, d.handle, dx, dy, { ...mods, rot: d.rot });
        }
      }
      d.fields = fields;
      previewFrame(p, { [d.id]: fields });
      return;
    }
    if (d.kind === 'rotate') {
      const deg = rotated(d.startRot, d.centre, d.from, world, { shift: p.shift });
      d.deg = deg;
      const delta = deg - d.startRot;
      const a = (delta * Math.PI) / 180;
      const [cs, sn] = [Math.cos(a), Math.sin(a)];
      const fields = {};
      for (const [id, start] of Object.entries(d.base)) {
        const cx = start.x + start.w / 2;
        const cy = start.y + start.h / 2;
        const dx = cx - d.centre.x;
        const dy = cy - d.centre.y;
        fields[id] = { rot: start.rot + delta, x: d.centre.x + dx * cs - dy * sn - start.w / 2,
          y: d.centre.y + dx * sn + dy * cs - start.h / 2 };
      }
      previewFrame(p, fields);
    }
  };

  const tick = () => {
    frame = 0;
    const p = press;
    if (!p?.drag) return;
    edgePan(p);
    applyDrag(p);
    frame = requestAnimationFrame(tick);
  };
  const loop = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };

  const startDrag = (e) => {
    const p = press;
    if (!p || p.drag || p.tool) return;
    p.ctrl = e.ctrlKey;
    p.shift = e.shiftKey;
    p.alt = e.altKey;
    if (p.empty) {
      p.drag = { kind: 'marquee' };
    } else if (p.item && sel.has(p.item)) {
      const ids = withChildren([...sel.ids]);
      const base = {};
      for (const id of ids) {
        const item = store.get(id);
        if (!item || item.gone) continue;
        const box = boxOf(item, store); // a group's box is its children's union, so its preview moves that
        if (!box) continue;
        base[id] = { x: box.x, y: box.y };
      }
      p.drag = { kind: 'move', ids, base };
    }
    if (p.drag) loop();
  };

  const begin = (p, item, pick = null) => {
    const hit = pick ?? (item ? { kind: 'item', id: item.id, item } : null);
    if (tools.first('down', ctx, hit, p.e)) {
      p.tool = true;
      return;
    }
    // A pick that names no item took the press as a tool's own: it is not an empty click, so nothing is cleared or marqueed.
    if (pick && !item) return;
    if (item) {
      const deep = p.e.ctrlKey || p.e.metaKey;
      const id = deep ? item.id : topOf(item.id).id;
      if (p.e.shiftKey) sel.toggle(id);
      else if (!sel.has(id)) sel.set([id]);
      else if (sel.ids.length > 1) p.member = id; // a member press keeps the set; a release with no drag picks it
      p.item = id;
    } else {
      if (!p.e.shiftKey) sel.clear();
      p.empty = true;
      p.additive = p.e.shiftKey;
      sel.setMarquee({ x: p.world0.x, y: p.world0.y, w: 0, h: 0 });
    }
  };

  const finish = () => {
    const p = press;
    press = null;
    cancelAnimationFrame(frame);
    frame = 0;
    if (!p) return;
    settle(p);
    // The drag is over whichever way the release came (pointerup, lost capture or a move with no buttons): every tool hears
    // it once, so one that draws an overlay of its own clears it here rather than on a release it may never see.
    if (p.drag || p.tool) tools.all('end', ctx, { ids: dragIds(p.drag), cancelled: false });
  };

  const settle = (p) => {
    if (p.tool) {
      tools.first('up', ctx, p.e);
      return;
    }
    if (p.drag && p.drag.kind !== 'marquee') applyDrag(p); // the pointer's last place, if no frame ran after it
    const d = p.drag;
    if (d?.kind === 'marquee') {
      const rect = sel.marquee;
      sel.setMarquee(null);
      if (rect && (Math.abs(rect.w) > DRAG_PX / k() || Math.abs(rect.h) > DRAG_PX / k())) {
        const hits = marqueeHits(rect, candidates());
        if (p.additive) sel.add(hits);
        else sel.set(hits);
      }
      return;
    }
    if (d?.kind === 'move') {
      const delta = d.delta ?? { dx: 0, dy: 0 };
      const fields = {};
      for (const [id, start] of Object.entries(d.base)) fields[id] = { x: start.x + delta.dx, y: start.y + delta.dy };
      const pairs = transformOf('move', d.ids, fields, { delta }) ?? [];
      const more = tools.all('moved', ctx, d.ids, fields);
      if (pairs.length || more.length) {
        store.change('Move', (tx) => {
          for (const [id, f] of pairs) tx.patch(id, f);
          for (const list of more) for (const [id, f] of list ?? []) tx.patch(id, f);
        });
      }
      sel.setPreview(null);
      requestAnimationFrame(() => vp()?.nudge(null));
      return;
    }
    if (d?.kind === 'resize') {
      const fields = d.fields ?? resized(d.start, d.handle, 0, 0, { rot: d.rot });
      const pairs = transformOf('resize', [d.id], { [d.id]: fields }, { handle: d.handle, start: d.start });
      if (pairs?.length) store.change('Resize', (tx) => { for (const [id, f] of pairs) tx.patch(id, f); });
      sel.setPreview(null);
      return;
    }
    if (d?.kind === 'rotate') {
      const delta = (d.deg ?? d.startRot) - d.startRot;
      const a = (delta * Math.PI) / 180;
      const [cs, sn] = [Math.cos(a), Math.sin(a)];
      const fields = {};
      for (const [id, start] of Object.entries(d.base)) {
        const dx = start.x + start.w / 2 - d.centre.x;
        const dy = start.y + start.h / 2 - d.centre.y;
        fields[id] = { rot: start.rot + delta, x: d.centre.x + dx * cs - dy * sn - start.w / 2,
          y: d.centre.y + dx * sn + dy * cs - start.h / 2 };
      }
      const pairs = transformOf('rotate', Object.keys(fields), fields, { centre: d.centre, deg: d.deg ?? d.startRot });
      if (pairs?.length) store.change('Rotate', (tx) => { for (const [id, f] of pairs) tx.patch(id, f); });
      sel.setPreview(null);
      return;
    }
    if (p.member) sel.set([p.member]);
  };

  const candidates = () => {
    const out = [];
    const seen = new Set();
    for (const item of store.live()) {
      if (item.hidden || item.locked) continue;
      const top = topOf(item.id);
      if (!top || seen.has(top.id)) continue;
      seen.add(top.id);
      const box = turnedBox(boxOf(top, store), top.rot ?? 0); // a group with no live children has none: nothing to meet
      if (!box) continue;
      out.push({ id: top.id, box });
    }
    return out;
  };

  const cancel = () => {
    const p = press;
    press = null;
    cancelAnimationFrame(frame);
    frame = 0;
    if (!p) return;
    try {
      root.releasePointerCapture(p.id);
    } catch {}
    if (p.tool) tools.first('cancel', ctx);
    sel.setMarquee(null);
    sel.setPreview(null);
    if (p.drag?.kind === 'resize' || p.drag?.kind === 'rotate') {
      // The stamps go back to the stored fields first: the placements must read the restored stamp, not the preview's.
      const ids = Object.keys(p.drag.base ?? { [p.drag.id]: 1 });
      Promise.all(ids.map((id) => surfaces.preview(id, {}).catch(() => {}))).then(() => {
        vp()?.setPlacements(placementsOf(store, surfaces, client.id, ctx));
      });
    }
    vp()?.nudge(null);
    if (p.drag || p.tool) tools.all('end', ctx, { ids: dragIds(p.drag), cancelled: true });
  };

  const onDown = (e) => {
    if (e.button !== 0 || space) return;
    if (onField(e.target)) return;
    edgeOff = false;
    if (press) finish(); // the release was lost
    root.focus?.({ preventScroll: true });
    sel.setHover(null);
    const world = worldOf(e.clientX, e.clientY);
    const pick = tools.first('pick', ctx, world, e);
    const p = press = { id: e.pointerId, cx: e.clientX, cy: e.clientY, x0: e.clientX, y0: e.clientY, e, world0: world,
      ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, ready: false, moved: false, drag: null, tool: null };
    try {
      root.setPointerCapture(e.pointerId);
    } catch {}
    const zone = !pick ? zoneAt(world) : null;
    if (zone) {
      p.ready = true;
      startZone(p, zone, world);
      return;
    }
    if (pick) {
      p.ready = true;
      begin(p, pick.id ? store.get(pick.id) : null, pick);
      return;
    }
    hitAt(world).then((item) => {
      if (press !== p) return;
      p.ready = true;
      begin(p, item);
      if (p.released) finish();
      else if (p.moved) startDrag(p.e);
    });
  };

  const startZone = (p, zone, world) => {
    const item = store.get(sel.ids[0]);
    const one = sel.ids.length === 1 && item;
    const box = one ? boxOf(item, store)
      : unionBox(sel.ids.map((id) => { const it = store.get(id); return it && !it.gone ? boxOf(it, store) : null; }));
    if (!box) return;
    const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    if (zone.kind === 'rotate') {
      const base = {};
      for (const id of sel.ids) {
        const it = store.get(id);
        if (!it || it.gone) continue;
        const b = boxOf(it, store);
        if (!b) continue;
        base[id] = { rot: it.rot ?? 0, x: b.x, y: b.y, w: b.w, h: b.h };
      }
      p.drag = { kind: 'rotate', centre, from: world, startRot: one ? item.rot ?? 0 : 0, base };
    } else {
      p.drag = { kind: 'resize', id: item.id, start: { ...box, flipX: item.flipX, flipY: item.flipY }, handle: zone.handle,
        rot: item.rot ?? 0 };
    }
    loop();
  };

  const onMove = (e) => {
    const p = press;
    if (p && e.buttons === 0) {
      finish(); // the release was lost outside the view: settle the drag where it last stood
      return;
    }
    if (p) {
      p.cx = e.clientX;
      p.cy = e.clientY;
      p.ctrl = e.ctrlKey;
      p.shift = e.shiftKey;
      p.alt = e.altKey;
      if (p.tool) {
        tools.first('move', ctx, e);
        return;
      }
      if (!p.drag) {
        if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) >= DRAG_PX) p.moved = true;
        if (p.moved && p.ready) startDrag(e);
      }
      if (p.drag) e.preventDefault();
      return;
    }
    hover(e);
  };

  const onUp = (e) => {
    const p = press;
    if (!p || e.pointerId !== p.id) return;
    if (!p.ready) {
      p.released = true;
      p.e = e;
      return;
    }
    finish();
  };

  let hoverSeq = 0;
  let hoverRaf = 0;
  let hoverAt = { x: 0, y: 0 };
  const hover = (e) => {
    hoverAt = { x: e.clientX, y: e.clientY };
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(async () => {
      hoverRaf = 0;
      if (press || !ctx.vp) return;
      const world = worldOf(hoverAt.x, hoverAt.y);
      // An armed tool keeps its own cursor (api.js), and so does a session that has the keys.
      if (!ctx.api?.mode && !ctx.api?.editing) root.style.cursor = cursorOf(zoneAt(world));
      const seq = ++hoverSeq;
      const item = await hitAt(world);
      if (seq !== hoverSeq || press) return;
      sel.setHover(item ? topOf(item.id)?.id ?? null : null);
    });
  };

  /** The item ids of the selection's boxes, for a turn or a flip about their union. */
  const selectedBoxes = () => [...sel.ids].map((id) => {
    const item = store.get(id);
    const box = item && !item.gone ? boxOf(item, store) : null;
    return box ? { item, box } : null;
  }).filter(Boolean);

  const rotateBy = (deg) => {
    const items = selectedBoxes();
    const union = unionBox(items.map(({ item, box }) => turnedBox(box, item.rot ?? 0)));
    if (!union) return;
    const centre = { x: union.x + union.w / 2, y: union.y + union.h / 2 };
    const a = (deg * Math.PI) / 180;
    const [cs, sn] = [Math.cos(a), Math.sin(a)];
    const fields = {};
    for (const { item, box } of items) {
      const dx = box.x + box.w / 2 - centre.x;
      const dy = box.y + box.h / 2 - centre.y;
      fields[item.id] = { rot: ((item.rot ?? 0) + deg) % 360, x: centre.x + dx * cs - dy * sn - box.w / 2,
        y: centre.y + dx * sn + dy * cs - box.h / 2 };
    }
    const pairs = transformOf('rotate', Object.keys(fields), fields, { centre, deg });
    if (pairs?.length) store.change('Rotate', (tx) => { for (const [id, f] of pairs) tx.patch(id, f); });
  };

  const flip = (field) => {
    const items = selectedBoxes();
    const union = unionBox(items.map(({ item, box }) => turnedBox(box, item.rot ?? 0)));
    if (!union) return;
    const fields = {};
    for (const { item, box } of items) {
      // The engine flips in the item's frame, then turns it: a world mirror toggles the flag and negates the turn.
      const patch = { [field]: !item[field], rot: -(item.rot ?? 0) };
      if (field === 'flipX') patch.x = union.x + union.w - (box.x - union.x) - box.w;
      else patch.y = union.y + union.h - (box.y - union.y) - box.h;
      fields[item.id] = patch;
    }
    const pairs = transformOf('flip', Object.keys(fields), fields, { axis: field });
    if (pairs?.length) store.change('Flip', (tx) => { for (const [id, f] of pairs) tx.patch(id, f); });
  };

  const remove = () => {
    const ids = [...sel.ids];
    if (!ids.length) return;
    const all = withChildren(ids);
    store.change('Delete', (tx) => {
      tools.all('removing', ctx, all, tx);
      for (const id of ids) tx.remove(id);
    });
    sel.clear();
  };

  /** An arrow press: with nothing selected the view pans 40 px, else every selected item and child moves 1 or 10 points. */
  const nudge = (dir, big) => {
    if (!sel.ids.length) {
      const step = 40 / k();
      const c = vp().camera;
      vp().setCamera({ x: c.x + dir.x * step, y: c.y + dir.y * step, zoom: c.zoom });
      return;
    }
    const ids = withChildren([...sel.ids]).filter((id) => { const item = store.get(id); return item && !item.locked && !item.hidden; });
    if (!ids.length) return;
    const now = performance.now();
    const amount = big ? BIG_NUDGE : NUDGE;
    let base;
    if (nudgeRun && now - nudgeRun.at < NUDGE_JOIN_MS && store.steps.at(-1) === nudgeRun.step
      && nudgeRun.ids.length === ids.length && nudgeRun.ids.every((id) => ids.includes(id))) {
      store.undo(nudgeRun.step.id);
      base = nudgeRun.base;
      nudgeRun.dx += dir.x * amount;
      nudgeRun.dy += dir.y * amount;
    } else {
      base = {};
      for (const id of ids) {
        const item = store.get(id);
        if (item) base[id] = { x: item.x ?? 0, y: item.y ?? 0 };
      }
      nudgeRun = { ids, base, dx: dir.x * amount, dy: dir.y * amount };
    }
    nudgeRun.at = now;
    nudgeRun.step = store.change('Nudge', (tx) => {
      for (const [id, start] of Object.entries(base)) tx.patch(id, { x: start.x + nudgeRun.dx, y: start.y + nudgeRun.dy });
    });
  };

  const zoomSelection = () => {
    const boxes = selectedBoxes();
    const box = unionBox(boxes.map(({ item, box: b }) => turnedBox(b, item.rot ?? 0)));
    const v = vp();
    if (!box || !v) return;
    v.setCamera(fitRect(box, v.size, 48));
  };

  const onKey = (e) => {
    if (onFieldOrInput(e.target) || ctx.api?.editing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (tools.first('keydown', ctx, e)) {
      e.preventDefault();
      return;
    }
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) {
        if (!tools.first('redo', ctx)) store.redo();
      } else if (!tools.first('undo', ctx)) store.undo();
      return;
    }
    if (mod && e.code === 'KeyY') {
      e.preventDefault();
      if (!tools.first('redo', ctx)) store.redo();
      return;
    }
    if (mod && e.code === 'KeyA') {
      e.preventDefault();
      sel.set(store.children(null).filter((item) => !item.hidden && !item.locked).map((item) => item.id));
      return;
    }
    if (e.code === 'Escape') {
      if (press) cancel();
      else sel.clear();
      return;
    }
    if (e.code === 'Delete' || e.code === 'Backspace') {
      e.preventDefault();
      remove();
      return;
    }
    if (e.shiftKey && !mod && e.code === 'KeyH') {
      e.preventDefault();
      flip('flipX');
      return;
    }
    if (e.shiftKey && !mod && e.code === 'KeyV') {
      e.preventDefault();
      flip('flipY');
      return;
    }
    if (e.shiftKey && !mod && e.code === 'Digit2') {
      e.preventDefault();
      zoomSelection();
      return;
    }
    if (!mod && e.code === 'KeyR') {
      e.preventDefault();
      rotateBy(e.shiftKey ? -90 : 90);
      return;
    }
    const dir = ARROWS[e.code];
    if (dir && !mod && !e.altKey) {
      e.preventDefault();
      nudge(dir, e.shiftKey);
    }
  };

  const onDblclick = (e) => {
    const world = worldOf(e.clientX, e.clientY);
    hitAt(world).then((item) => {
      if (ctx.vp) tools.first('dblclick', ctx, item ? { kind: 'item', id: item.id, item } : null, e);
    });
  };

  /** A key pressed or released with the pointer still: a drag's next frame follows the new Ctrl or Shift at once, so snapping
   * and the axis lock change without another pointer move. */
  const trackKeys = (e) => {
    const p = press;
    if (!p) return;
    p.ctrl = e.ctrlKey;
    p.shift = e.shiftKey;
    p.alt = e.altKey;
    if (p.drag) loop();
  };
  const onKeySpace = (e) => {
    if (e.code === 'Space' && !onFieldOrInput(e.target) && !ctx.api?.editing) space = e.type === 'keydown';
  };
  const onBlur = () => {
    space = false;
    edgeOff = true; // a drag's edge pan stops while the window is away
  };
  const onLeave = () => {
    if (!press) sel.setHover(null);
  };
  const onDrop = (e) => {
    if (tools.first('drop', ctx, e)) e.preventDefault();
  };
  const onPaste = (e) => {
    if (onFieldOrInput(e.target) || ctx.api?.editing) return; // a field or a focused session keeps its own paste, as the keys do
    if (tools.first('paste', ctx, e.clipboardData)) e.preventDefault();
  };
  const onDragOver = (e) => {
    if (tools.list().some((module) => typeof module.drop === 'function')) e.preventDefault();
  };

  // A selected item that a change hides or removes (an undo of its create, say) leaves the selection.
  offs.push(store.subscribe(() => {
    const keep = sel.ids.filter((id) => { const item = store.get(id); return item && !item.gone && !item.hidden; });
    if (keep.length !== sel.ids.length) sel.set(keep);
  }));

  on('pointerdown', onDown, true);
  on('pointermove', onMove, true);
  on('pointerup', onUp, true);
  on('pointercancel', onUp, true);
  on('lostpointercapture', onUp, true);
  on('keydown', trackKeys);
  on('keyup', trackKeys);
  on('keydown', onKey);
  on('keyup', onKeySpace);
  on('keydown', onKeySpace);
  on('dblclick', onDblclick);
  on('pointerleave', onLeave);
  on('drop', onDrop);
  on('paste', onPaste);
  on('dragover', onDragOver);
  globalThis.addEventListener?.('blur', onBlur);
  offs.push(() => globalThis.removeEventListener?.('blur', onBlur));

  return () => {
    cancelAnimationFrame(frame);
    cancelAnimationFrame(hoverRaf);
    sel.setPreview(null);
    sel.setMarquee(null);
    sel.setHover(null);
    for (const off of offs) off();
  };
}
