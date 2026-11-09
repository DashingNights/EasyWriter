// The board's tool registry (docs/plans/board/briefs/bd-select.md): later packages add a file and fill its hooks, never edit
// pointer.js, BoardArea.jsx or api.js. A tool module is
//   { id, mount(ctx) → off, methods: {name: fn(this: api, ...)},
//     pick(ctx, world, e) → {kind, id, ...} | null,                 // first non-null wins, in index order, before items
//     down(ctx, hit, e) → true when it takes the gesture, move(ctx, e), up(ctx, e), cancel(ctx),
//     dblclick(ctx, hit, e) → true, keydown(ctx, e) → true, drop(ctx, e) → true, paste(ctx, data) → true,
//     moveFrame(ctx, sel, dx, dy, e) → {dx, dy},                    // adjusts a drag each frame (snap); each tool sees the delta
//                                                                   // the one before adjusted (tools.frame)
//     end(ctx, {ids, cancelled}),                                    // a drag finished or was cancelled, once (guides clear here)
//     moved(ctx, ids, fields) → [[id, fields]],                     // more fields to write in a move's step (Alt+drag copies)
//     transform(ctx, ids, {kind, fields, ...}) → [[id, fields]] | null, // a resize, rotate, flip or move this tool answers
//                                                                   // for its own items; null runs pointer.js's default
//     removing(ctx, ids, tx),                                       // inside a delete's step (connector ends become free)
//     undo(ctx) → true, redo(ctx) → true }                          // the journal replaces the store's undo
const list = [];

/** Adds a tool module (every key optional). Returns it, so a module file can export `registerTool({...})` or `{}`. */
export function registerTool(module) {
  if (module && !list.includes(module)) list.push(module);
  return module;
}

/** The tools, in registration order; `first` runs a hook until one answers (null/undefined/false is no answer, true is one);
 * `all` collects every answer that is not null or undefined. */
export const tools = {
  list: () => [...list],
  first(hook, ...args) {
    for (const module of list) {
      const fn = module[hook];
      if (typeof fn !== 'function') continue;
      const out = fn.call(module, ...args);
      if (out != null && out !== false) return out;
    }
    return null;
  },
  all(hook, ...args) {
    const out = [];
    for (const module of list) {
      const fn = module[hook];
      if (typeof fn === 'function') out.push(fn.call(module, ...args));
    }
    return out;
  },
  /** The drag's delta after every `moveFrame` hook, in registration order: each sees {dx, dy} as the one before left it, and a
   * returned {dx, dy} replaces it. */
  frame(ctx, ids, dx, dy, e) {
    let step = { dx, dy };
    for (const module of list) {
      const fn = module.moveFrame;
      if (typeof fn !== 'function') continue;
      const out = fn.call(module, ctx, ids, step.dx, step.dy, e);
      if (out && Number.isFinite(out.dx) && Number.isFinite(out.dy)) step = { dx: out.dx, dy: out.dy };
    }
    return step;
  },
};
