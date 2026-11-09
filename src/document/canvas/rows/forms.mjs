// The row forms of the engine tables (docs/plans/engine/stage2.md "How the table splits"): what a tooling id does on a
// canvas draft. Each package's row file (home, objects, page, references, review) holds rows by tooling id in these forms, and
// src/tooling/registry.js turns each into the command the ribbon, tool search and Word's keys run. Pure: node tests load it.
//
// - 'engine.id': runs that engine command with the control's argument as its params.
// - APP: runs as registered (the command acts on the app, not on the draft).
// - exec(id, args?, {state?, when?, active?, value?}): an engine command with its own params or state reading.
// - off(reason): a gap row, shown disabled with `reason` (UI copy rules: plain words, no em dashes).
// - a CommandSpec {run, enabled?, active?, value?, reason?, reads?} for dialogs and composite rows: `run` acts through ctx.engine
//   (execMany for one undo step) and the registry reads the engine's state again after it. `reads` names the engine ids its
//   enabled, active and value read through ctx.stateOf, so the first state call holds them.
// A key that ends in '.*' is a row for every id under that prefix (the board and plan chart pools).

/** A row that runs as registered on a canvas draft. */
export const APP = true;

/** Engine command `id` with params `args`: an object, or (arg, ctx) => params from the control's argument (a gallery id, a
 * colour, points); none passes the argument as it is. The function may return null (run nothing: no valid pick) or a promise
 * of the params (read the state first with a pure query). `state`: the snapshot id the control reads (default `id`); `when(ctx)`:
 * an extra reason it is disabled now, or null; `hide(ctx)`: whether it is off with no reason now (tool search hides it, as the
 * DOM editor's gates do: a drop cap in a table); `active(entry, ctx)` and `value(entry, ctx)` map the snapshot entry
 * ({enabled, reason, checked, value}) when the control's form differs (an underline style name, a highlight name). */
export const exec = (id, args, { state, when, hide, active, value } = {}) => Object.freeze({ exec: id, args, state, when, hide, active, value });

/** A gap row: disabled with `reason` until the engine command behind it lands. */
export const off = (reason) => Object.freeze({ off: reason });

/** The form of row value `v`: 'engine', 'app', 'exec', 'off', 'spec', or null when it is none of them. */
export function formOf(v) {
  if (typeof v === 'string') return v ? 'engine' : null;
  if (v === APP) return 'app';
  if (!v || typeof v !== 'object') return null;
  if (typeof v.exec === 'string') return 'exec';
  if (typeof v.off === 'string') return v.off ? 'off' : null;
  return typeof v.run === 'function' ? 'spec' : null;
}
