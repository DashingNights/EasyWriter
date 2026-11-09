// Objects on the page (docs/plans/engine/stage2b.md, engine-page-tools; stage2.md G12): Select Objects (a click takes the object
// under it, Shift or Ctrl adds it, a drag selects every object inside the box: object.at, the frames, select.addObject) and the
// object layer (Ctrl+Alt+5: the first floating object of the caret's page, Tab and Shift+Tab through the others, Esc back to the
// text where it was).

const OBJ = 3; // an object's character (U+FFFC) in the engine's UTF-8 offsets
const CLICK = 3; // points a press may move and still count as a click

const objRange = (pos) => ({ anchor: pos, focus: { ...pos, off: pos.off + OBJ } });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Select Objects: stays on until Esc or its button again. */
export const selectObjectsTool = (env) => {
  let a = null;
  let b = null;
  let picked = []; // frames {surface, x, y, w, h, pos} selected through this tool, outlined while it is on
  const framesOn = async (surface) => ((await env.client.frames(surface)) ?? []).filter((f) => f.pos).map((f) => ({ ...f, surface }));
  return {
    cursor: 'default',
    async down(at, e) {
      a = at;
      b = at;
      const o = await env.query('object.at', { page: at.surface, x: at.x, y: at.y });
      if (!o) return;
      a = null; // a press on an object picks it, no box
      const f = { surface: at.surface, x: o.x, y: o.y, w: o.w, h: o.h, pos: o.pos };
      if ((e.shiftKey || e.ctrlKey) && picked.length) {
        await env.exec('select.addObject', { pos: o.pos });
        picked = picked.some((p) => same(p.pos, o.pos)) ? picked.filter((p) => !same(p.pos, o.pos)) : [...picked, f];
      } else {
        await env.exec('select.range', objRange(o.pos));
        picked = [f];
      }
      env.redraw();
    },
    move(at) {
      if (!a || at.surface !== a.surface) return;
      b = at;
      env.redraw();
    },
    async up() {
      if (!a) return;
      const [s, e] = [a, b];
      a = null;
      env.redraw();
      if (Math.abs(e.x - s.x) < CLICK && Math.abs(e.y - s.y) < CLICK) return;
      const box = { x: Math.min(s.x, e.x), y: Math.min(s.y, e.y), x1: Math.max(s.x, e.x), y1: Math.max(s.y, e.y) };
      const inside = (await framesOn(s.surface)).filter((f) => f.x >= box.x && f.y >= box.y && f.x + f.w <= box.x1 && f.y + f.h <= box.y1);
      if (!inside.length) return;
      await env.exec('select.range', objRange(inside[0].pos));
      if (inside.length > 1) await env.exec('select.addObject', { objects: inside.slice(1).map((f) => f.pos) });
      picked = inside;
      env.redraw();
    },
    preview(surface) {
      const out = picked.filter((p) => p.surface === surface).map((p) => ({ rect: p, dash: true }));
      if (a && a.surface === surface) out.push({ rect: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }, dash: true, fill: 'color-mix(in srgb, Highlight 12%, transparent)' });
      return out;
    },
  };
};

/** The object layer: keys only; a press on the page ends it and goes on to the text as usual. */
export const objectLayerTool = (back, floats) => (env) => {
  let i = 0;
  const show = (n) => {
    i = (n + floats.length) % floats.length;
    return env.exec('select.range', objRange(floats[i]));
  };
  show(0);
  return {
    passive: true,
    down: () => env.done(),
    key(e) {
      if (e.key === 'Escape') {
        env.done();
        env.client.select(back.anchor, back.head);
        return true;
      }
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return false;
      show(i + (e.shiftKey ? -1 : 1));
      return true;
    },
  };
};

/** The floating objects of the caret's page, in document order → [pos]; and the selection to go back to. */
export async function layerOf(client) {
  const back = await client.selection();
  const c = back && (await client.caret(back.head));
  if (!c) return null;
  const frames = ((await client.frames(c.page)) ?? []).filter((f) => f.pos);
  const floats = [];
  for (const f of frames) {
    const o = (await client.query('object.at', { page: c.page, x: f.x + f.w / 2, y: f.y + f.h / 2 }))?.value;
    if (o?.floating && same(o.pos, f.pos)) floats.push(f.pos);
  }
  return { back, floats };
}
