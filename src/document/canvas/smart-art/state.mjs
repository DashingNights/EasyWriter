// What the ribbon knows about the selected diagram: object.get's `smartArt` (engine/crates/doc-edit/src/cmd/objects/select.rs).
// Pure: node tests load it.

const asDiagram = (o) => (o?.smartArt ? { pos: o.pos, w: o.w, h: o.h, rotation: o.rotation ?? 0, spec: o.smartArt.spec, shapes: o.smartArt.shapes } : null);

/** The selected diagram EasyWriter can edit, for drawing a control, or null (another kind of object, or a diagram from another program). */
export const diagramOf = (ctx) => (ctx.obj?.kind === 'smartArt' ? asDiagram(ctx.read?.('object.get', {})) : null);

/** The same, read now: a command acts on what the diagram is, not on the last drawn reading. */
export const diagramNow = async (ctx) => asDiagram((await ctx.engine.query?.('object.get', {}))?.value);

// The shape picked inside the selected diagram. The engine's commands take an item index, so the pick lives here and goes with
// each command; with none picked the whole diagram is selected.
let key = null; // the diagram's position as JSON
let index = null;
let version = 0;
const fns = new Set();
const keyOf = (pos) => JSON.stringify(pos ?? null);

/** Picks item `i` of the diagram at `pos`, or nothing with `i` null. */
export function pickItem(pos, i) {
  key = keyOf(pos);
  index = i;
  version += 1;
  for (const fn of fns) fn();
}
export const subscribePick = (fn) => {
  fns.add(fn);
  return () => fns.delete(fn);
};
export const pickVersion = () => version;

/** The picked item of diagram `d` (diagramOf, diagramNow), or null. A pick from another diagram, or past the end, is no pick. */
export const pickedOf = (d) => (d && key === keyOf(d.pos) && index != null && index < d.spec.items.length ? index : null);

/** Runs smartArt.look with `look` on the picked item of the selected diagram, or on every item with none picked. → whether it ran. */
export async function diagramLook(ctx, look) {
  const d = await diagramNow(ctx);
  if (!d) return false;
  const i = pickedOf(d);
  const r = await Promise.resolve(ctx.engine.exec('smartArt.look', { ...look, ...(i == null ? {} : { items: [i] }) })).catch(() => null);
  return !!r?.ok;
}
