// The ribbon's pure layout model (docs/plans/word/plan.md §1.4, §2.8): a spec tab (TABS, CONTROLS, CONTEXTS) becomes the
// columns, rows, joined button groups and captions the renderer draws, with each control's placeholder reason and the tab's
// KeyTip map. No DOM and no app import, so node tests and the benchmark load it; nothing here knows Word's data.

/** Default box widths in rem for the controls drawn as boxes, when the spec gives none (probe: Font 113 px, Font Size 45 px,
 * the Layout spinners 72 px at 13 px per rem). */
const BOX = { combo: 8.7, spinner: 5.5, edit: 8, list: 8 };

/** The drawn form of control `id` in `spec`, or null when CONTROLS has no such id. `has(cmdId)`: whether a command is
 * registered (optional; without it only `needs` makes a placeholder, and the renderer checks the registry at draw time). */
export function itemOf(spec, id, has) {
  const control = spec.CONTROLS[id];
  if (!control) return null;
  const cmd = control.cmd ?? id;
  const placeholder = control.needs ?? (has && !has(cmd) ? 'pending' : null);
  const box = control.type in BOX ? (control.width ?? BOX[control.type]) : null;
  return { id, cmd, control, placeholder, box };
}

/** One spec column as drawn: {kind: 'large' | 'gallery', item} or {kind: 'rows', caption, rows}, where each row holds items
 * and joined groups ({join: items}). Unknown ids go to `missing`. */
function columnOf(spec, col, has, missing) {
  const item = (id) => itemOf(spec, id, has) ?? (missing.push(id), null);
  if (col.large) return { kind: 'large', item: item(col.large), caption: col.caption ?? null };
  if (col.gallery) return { kind: 'gallery', item: item(col.gallery), caption: col.caption ?? null };
  const rows = col.rows.map((row) => row.map((e) => {
    if (!Array.isArray(e)) return item(e);
    const join = e.map(item).filter(Boolean);
    return join.length ? { join } : null;
  }).filter(Boolean));
  return { kind: 'rows', caption: col.caption ?? null, rows };
}

/** The render model of tab `tabId`: {id, label, keytip, context, groups: [{id, label, keytip, extra, launcher, columns}],
 * keytips: [[keys, id, kind]], missing: ids the layout names but CONTROLS lacks}, or null for an unknown tab. */
export function layoutTab(spec, tabId, { has } = {}) {
  const tab = spec.TABS.find((t) => t.id === tabId);
  if (!tab) return null;
  const missing = [];
  const keytips = [];
  const groups = tab.groups.map((g) => {
    const launcher = g.launcher ? itemOf(spec, g.launcher, has) ?? (missing.push(g.launcher), null) : null;
    const columns = g.layout.map((col) => columnOf(spec, col, has, missing));
    if (g.keytip) keytips.push([g.keytip, g.id, 'group']);
    for (const it of itemsOf(columns)) if (it.control.keytip) keytips.push([it.control.keytip, it.id, 'control']);
    if (launcher?.control.keytip) keytips.push([launcher.control.keytip, launcher.id, 'launcher']);
    return { id: g.id, label: g.label, keytip: g.keytip ?? null, extra: !!g.extra, launcher, columns };
  });
  return { id: tab.id, label: tab.label, keytip: tab.keytip, context: tab.context ?? null, groups, keytips, missing };
}

/** Every item of drawn `columns` in drawing order (joined groups flattened). */
export function itemsOf(columns) {
  return columns.flatMap((c) => (c.kind === 'rows' ? c.rows.flat().flatMap((e) => e.join ?? [e]) : c.item ? [c.item] : []));
}

/** The tab row's KeyTips of `spec`: [[keys, tabId]] with File first. */
export const tabKeytips = (spec) => [[spec.FILE.keytip, spec.FILE.id], ...spec.TABS.map((t) => [t.keytip, t.id])];

/** The tabs shown while the contexts in `held` ({context: true}) hold, in drawing order: tabs marked `first` whose context
 * holds, the main tabs (a `hidden` tab only when `show` lists its id), then the other contextual tabs whose context holds.
 * A context marked `alone` in CONTEXTS hides the main tabs while it holds (Word's Immersive Reader). */
export function visibleTabs(spec, held, show = []) {
  const holds = (t) => !!t.context && !!held[t.context];
  const alone = spec.TABS.some((t) => holds(t) && spec.CONTEXTS?.[t.context]?.alone);
  const main = alone ? [] : spec.TABS.filter((t) => !t.context && (!t.hidden || show.includes(t.id)));
  return [...spec.TABS.filter((t) => holds(t) && t.first), ...main, ...spec.TABS.filter((t) => holds(t) && !t.first)];
}

/** The tab to show next. `current`: the tab shown so far; `tabs`: visibleTabs now; `before` and `held`: the contexts held at
 * the last call and now; `lastMain`: the last main tab picked. A context that starts holding and is marked `activate` in
 * CONTEXTS (or whose tab is `first`) brings its tab forward; a tab that went away gives way to the last main tab. */
export function nextTab(spec, { current, tabs, before = {}, held = {}, lastMain = 'home' }) {
  const rising = tabs.find((t) => t.context && held[t.context] && !before[t.context] && (t.first || spec.CONTEXTS?.[t.context]?.activate));
  if (rising) return rising.id;
  if (tabs.some((t) => t.id === current)) return current;
  return (tabs.find((t) => t.id === lastMain) ?? tabs.find((t) => !t.context) ?? tabs[0])?.id ?? null;
}

/** A large control's label on two lines as Word draws it ("Text" / "Direction", "Margins" / ""), split at the space that
 * makes the longer line shortest; one word keeps the second line for the menu chevron. `step(n)` is told of each n characters
 * looked at, for the test that bounds the work (npm test counts work, never a time). */
export function splitLabel(label, step = () => {}) {
  // One pass over the spaces: a label can hold a whole pasted text (Undo Typing "..."), where joining the words at every space
  // took minutes.
  let at = -1;
  let worst = Infinity;
  for (let i = label.indexOf(' '), from = 0; i !== -1; from = i + 1, i = label.indexOf(' ', i + 1)) {
    step(i + 1 - from);
    const m = Math.max(i, label.length - i - 1);
    if (m < worst) [at, worst] = [i, m];
  }
  return at < 0 ? [label, ''] : [label.slice(0, at), label.slice(at + 1)];
}

// ---------------------------------------------------------------------------------------------
// Adaptive groups (ribbon-chrome; docs/plans/word briefs/ribbon-chrome.md): when the full layout does not fit the ribbon's own
// width, in-ribbon galleries lose columns first, then groups shrink from the right end (large controls to medium, then medium
// to small, icon only), and last a group collapses into one large button that drops the whole group down. The spec has no
// per-group sizes, so they are derived by this rule from widths measured once per tab.

// The control types a size step changes; boxes, check boxes and galleries keep their size.
const SHRINKS = new Set(['button', 'toggle', 'split', 'splitToggle', 'dropdown']);
const sizeOf = (it) => it.size ?? it.control.size;
const big = (c) => c?.kind === 'large' && !!c.item && SHRINKS.has(c.item.control.type);

/** Shrink levels: 0 as the spec draws it, 1 large controls medium, 2 medium controls small, 3 collapsed. */
export const LEVELS = [0, 1, 2, 3];

/** Whether group `g` is one large control (Dictate, Table), which collapsing would draw as the same button: fit never
 * collapses it. */
export const loneGroup = (g) => g.columns.length === 1 && g.columns[0].kind === 'large';

/** Group `g` of a layoutTab model drawn at shrink `level`, its gallery (if any) showing `cols` columns (null: the spec's).
 * Level 1 stacks runs of two or more large buttons into columns of up to three medium rows; level 2 makes medium buttons
 * small; level 3 marks the group collapsed and keeps its full columns for the drop-down. A large button with no large
 * neighbour keeps its size, as Word keeps Paste beside Cut, Copy and Format Painter, Insert Footnote and Dictate. */
export function groupAt(g, level = 0, cols = null) {
  if (level >= 3) return { ...g, level: 3, collapsed: true };
  let columns = cols == null ? g.columns : g.columns.map((c) => (c.kind === 'gallery' && c.item ? { ...c, item: { ...c.item, cols } } : c));
  if (level >= 1) {
    const out = [];
    for (const [k, c] of columns.entries()) {
      if (big(c) && (big(columns[k - 1]) || big(columns[k + 1]))) {
        const it = { ...c.item, size: 'medium' };
        const prev = out.at(-1);
        if (prev?.stack && prev.rows.length < 3) prev.rows.push([it]);
        else out.push({ kind: 'rows', caption: null, rows: [[it]], stack: true });
      } else out.push(c);
    }
    columns = out;
  }
  if (level >= 2) {
    const small = (e) => (e.join ? { join: e.join.map(small) } : SHRINKS.has(e.control.type) && sizeOf(e) === 'medium' ? { ...e, size: 'small' } : e);
    columns = columns.map((c) => (c.kind === 'rows' ? { ...c, rows: c.rows.map((r) => r.map(small)) } : c));
  }
  return { ...g, level, columns };
}

/** The gallery of group `g` (a layoutTab model group) → {id, cols} or null. */
export function galleryOfGroup(g) {
  const c = g.columns.find((x) => x.kind === 'gallery' && x.item);
  return c ? { id: c.item.id, cols: c.item.control.grid?.cols ?? 6 } : null;
}

/** The levels that fit `width`. `groups`: [{id, widths: [w0, w1, w2, w3] (outer px per level, the gallery at its full columns),
 * gallery?: {cols, min, col (px per column)}, lone?: loneGroup, never collapsed}] in drawing order. Galleries lose columns first (the widest first, the rightmost
 * on a tie) down to `min`; then passes from the right end take one size step per group (level 1, then level 2), each only where
 * it makes the group narrower; collapse comes last, again from the right end. → {levels: {id: level}, cols: {id: columns},
 * total, overflow}: overflow true when even that does not fit (the renderer scrolls sideways then). */
export function fit(groups, width) {
  const level = groups.map(() => 0);
  const cols = groups.map((g) => g.gallery?.cols ?? null);
  const cut = (i) => (cols[i] == null || level[i] === 3 ? 0 : (groups[i].gallery.cols - cols[i]) * groups[i].gallery.col);
  const w = (i) => groups[i].widths[level[i]] - cut(i);
  const total = () => groups.reduce((s, _, i) => s + w(i), 0);
  const fits = () => total() <= width;
  while (!fits()) {
    let best = -1;
    for (let i = groups.length - 1; i >= 0; i--) {
      if (cols[i] != null && cols[i] > groups[i].gallery.min && (best < 0 || cols[i] > cols[best])) best = i;
    }
    if (best < 0) break;
    cols[best]--;
  }
  for (const step of [1, 2]) {
    for (let i = groups.length - 1; i >= 0 && !fits(); i--) {
      if (level[i] < step && groups[i].widths[step] < groups[i].widths[level[i]]) level[i] = step;
    }
  }
  for (let i = groups.length - 1; i >= 0 && !fits(); i--) {
    if (!groups[i].lone && groups[i].widths[3] < w(i)) level[i] = 3;
  }
  const t = total();
  return {
    levels: Object.fromEntries(groups.map((g, i) => [g.id, level[i]])),
    cols: Object.fromEntries(groups.map((g, i) => [g.id, cols[i]])),
    total: t,
    overflow: t > width,
  };
}
