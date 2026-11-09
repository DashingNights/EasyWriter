// Which page tool is on (tools/index.js), for the rows' pressed state. Pure: the row files read it and node tests load them.

let on = null; // {name, tool}

/** The page tool now on, by name, or null. */
export const activeTool = () => on?.name ?? null;

/** Notes `tool` as on under `name`, or with `name` null as off (only when it is the one on) → whether that changed anything. */
export function noteTool(name, tool) {
  if (name) {
    on = { name, tool };
    return true;
  }
  if (on?.tool !== tool) return false;
  on = null;
  return true;
}
