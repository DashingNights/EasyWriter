// New board items match the board they join (2026-10-07; the user: "the models should be able to correctly set the annotation's
// themes as well, like the flowchart item's colors, fills, or text notes spawned to have the correct text color that is
// consistent with the existing page's theme"). A style field an agent leaves out is taken from the board's own items of the same
// type (a shape: of the same kind when there is one, else any shape): the most common style among them, the latest on a tie.
// A board with no item of that type looks at the rest of the page (`page`: every board's items in the draft, canvas items' own
// too), so a blank board's marks match the marks on the page's other boards. Fields the agent sets stay as set. With no item of
// that type anywhere the theme defaults apply (board.mjs, flow.mjs itemDefaults). Pure.

export const STYLE_KEYS = {
  text: ['size', 'color', 'bold', 'align', 'bg'],
  shape: ['color', 'width', 'opacity', 'fill', 'fillColor', 'size', 'textColor'],
  connector: ['color', 'width', 'opacity', 'dash', 'route', 'corner', 'heads', 'jump'],
  stroke: ['color', 'width', 'opacity'],
};

const pick = (i, keys) => Object.fromEntries(keys.filter((k) => i[k] !== undefined).map((k) => [k, i[k]]));

/** The most common style (`keys`) among `items`, the latest on a tie; null when `items` is empty. */
export function commonStyle(items, keys) {
  const counts = new Map();
  items.forEach((i, n) => {
    const s = pick(i, keys);
    const k = JSON.stringify(s);
    const c = counts.get(k) ?? { s, n: 0, last: 0 };
    c.n += 1;
    c.last = n;
    counts.set(k, c);
  });
  let best = null;
  for (const c of counts.values()) if (!best || c.n > best.n || (c.n === best.n && c.last > best.last)) best = c;
  return best?.s ?? null;
}

/** The items of `items` whose style a new item `i` takes: the same type, for a shape the same kind when there is one. */
function poolOf(i, items) {
  const same = items.filter((x) => x?.type === i.type);
  return i.type === 'shape' && same.some((x) => x.shape === i.shape) ? same.filter((x) => x.shape === i.shape) : same;
}

/** New item `i` with the style fields it leaves out taken from `items` (the board's own, before the call), else from `page`. */
export function matchStyle(i, items, page = []) {
  const keys = STYLE_KEYS[i?.type];
  if (!keys) return i;
  const own = poolOf(i, items);
  const pool = own.length ? own : poolOf(i, page);
  const s = pool.length ? commonStyle(pool, keys) : null;
  return s ? { ...s, ...i } : i;
}

/** Every board item of ProseMirror `doc` (whiteboards' and canvases' items, and canvas items' own items): matchStyle's `page`. */
export function pageItems(doc) {
  const out = [];
  doc?.descendants((n) => {
    if (!Array.isArray(n.attrs?.items)) return true;
    for (const i of n.attrs.items) out.push(i, ...(i?.type === 'canvas' && Array.isArray(i.items) ? i.items : []));
    return false;
  });
  return out;
}

/** The board's styles as board.get's brief names them: the most common style of each type that has items. */
export function boardStyles(items) {
  const out = {};
  for (const [type, keys] of Object.entries(STYLE_KEYS)) {
    const same = items.filter((x) => x?.type === type);
    if (same.length) out[type] = commonStyle(same, keys);
  }
  return out;
}
