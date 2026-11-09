// The canvas page area's overlay calls (docs/plans/engine/plan.md section 1). The registries and drawing are the Viewport's, one
// set per viewport (src/engine/view/overlay.jsx, viewport-design.md section 4.5); these module calls reach the page area's
// viewport, whenever it mounts, so other packages keep them:
//   setMarks(kind, items): the caret, selection rectangles, the composition underline and squiggles, as [{page, x, y, w, h}] in pt;
//   registerFrameKind(kind, Component): a component drawn at each frames(page) box of that kind ({frame, page, k});
//   registerOverlay(id, Component): anything else over every visible page, such as object handles ({page, k, frames}).
export { ptBox } from '../../engine/view/overlay.jsx';

const marks = new Map(); // kind → items
const kinds = new Map(); // frame kind → Component
const layers = new Map(); // id → Component
const areas = new Map(); // the mounted page areas' viewports → their session

const mine = (items, session) => items?.map((m) => ({ session, ...m }));

/** Replaces the marks of `kind` ('caret' | 'selection' | 'composition' | 'squiggle' | 'frame') with `items` ([{page, x, y, w, h}]
 * in pt; a caret's w is ignored). An empty list or null clears them. */
export function setMarks(kind, items) {
  if (items?.length) marks.set(kind, items);
  else marks.delete(kind);
  for (const [vp, session] of areas) vp.marks.set('page-area', kind, mine(items, session));
}

/** Draws `Component` ({frame, page, k}) at every frames(page) box of `kind`; null removes it. */
export function registerFrameKind(kind, Component) {
  if (Component) kinds.set(kind, Component);
  else kinds.delete(kind);
  for (const vp of areas.keys()) vp.frameKinds.register(kind, Component);
}

/** Draws `Component` ({page, k, frames}) over every visible page; null removes it. */
export function registerOverlay(id, Component) {
  if (Component) layers.set(id, Component);
  else layers.delete(id);
  for (const vp of areas.keys()) vp.overlays.register(id, Component);
}

/** The page areas' viewports showing session `session` (any session without one). */
export const areaViewports = (session) => [...areas].filter(([, s]) => session == null || s === session).map(([vp]) => vp);

/** The page area's viewport `vp`, showing session `session`, takes every registration made so far and those to come → a function
 * that lets it go. */
export function adopt(vp, session) {
  areas.set(vp, session);
  for (const [kind, items] of marks) vp.marks.set('page-area', kind, mine(items, session));
  for (const [kind, C] of kinds) vp.frameKinds.register(kind, C);
  for (const [id, C] of layers) vp.overlays.register(id, C);
  return () => {
    areas.delete(vp);
    for (const kind of marks.keys()) vp.marks.set('page-area', kind, null);
  };
}
