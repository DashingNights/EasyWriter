// The Documents host of the viewport's tool layer (src/engine/view/tools.jsx; docs/plans/engine/stage2b.md, engine-page-tools): a
// row starts a page tool on the focused canvas draft's page areas, and the ribbon reads which one is on (state.mjs). The tools
// themselves are in the files beside this one, each a factory ({vp, client, done, redraw}) → tool; they hit-test through the
// engine (object.at, table.borderAt, the frames) and commit through engine commands, each one undo step.
import { setState } from '../../../app/store.js';
import { areaViewports } from '../overlay.jsx';
import { activeTool, noteTool } from './state.mjs';

const ok = (r) => !!r?.ok;

/** Starts tool `name` made by `make(env)` on the page areas showing `ctx.engine` → whether one took it. `env`: {vp, client, done,
 * redraw, exec(id, args) → ok, query(id, args) → value}. The tool ends with Esc, another tool, or its own `done()`. */
export function startTool(ctx, name, make) {
  const client = ctx.engine;
  const vps = client ? areaViewports(client.id) : [];
  if (!vps.length) return false;
  for (const vp of vps) {
    const env = {
      vp,
      client,
      done: () => vp.tools.end(tool),
      redraw: () => vp.tools.redraw(),
      exec: (id, args = {}) => Promise.resolve(client.exec(id, args)).then(ok, () => false),
      execMany: (steps) => Promise.resolve(client.execMany(steps)).then(ok, () => false),
      query: async (id, args = {}) => (await Promise.resolve(client.query(id, args)).catch(() => null))?.value ?? null,
    };
    const made = make(env);
    if (!made) return false;
    const end = made.end;
    const tool = {
      ...made,
      name,
      session: client.id,
      end() {
        end?.();
        noteTool(null, tool);
        // The ribbon reads the pressed state again; a table tool's end reaches the store's word.tableTool, which the DOM editor's
        // pointer and the Table Design pen read too.
        const t = name.startsWith('table:') ? name.slice(6) : null;
        setState((s) => (t && s.word?.tableTool === t ? { word: { ...s.word, tableTool: null } } : {}));
      },
    };
    noteTool(name, tool);
    vp.tools.set(tool);
  }
  setState({});
  return true;
}

/** Ends the page tool now on (any, or only `name`). */
export function endTool(name) {
  for (const vp of areaViewports()) {
    const t = vp.tools.current;
    if (t && (!name || t.name === name)) vp.tools.end(t);
  }
}

/** A row's run that turns tool `name` on, or off when it is on already (Word's tool buttons toggle). */
export function toggleTool(ctx, name, make) {
  if (activeTool() === name) {
    endTool();
    return true;
  }
  return startTool(ctx, name, make);
}
