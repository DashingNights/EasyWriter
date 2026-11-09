// The one shape picker's model (docs/plans/word/briefs/shape-picker.md, shape-names-lines.md): the shape library's sections, Word's
// Lines, one name per shape, and the search, as every editor lists them (Word's Insert Shapes and Change Shape, the canvas rail, the
// flowchart editor's shape panel).
// ShapePicker.jsx draws it; each host adds its own sections and tiles. Pure, so node tests load it.
import { PRESET_LABELS } from '../flow/gallery.mjs';
import { kindOf, SHAPE_KINDS, SHAPE_SECTIONS } from '../flow/shapes.mjs';
import { rankTool } from '../app/tool-rank.mjs';

const TITLES = new Map(SHAPE_SECTIONS.map((s) => [s.id, s.title]));
const sectionOf = (k) => k.section ?? k.group;

// --- Word's Lines ---

const conn = (route, start = 'none', end = 'none') => ({ conn: { route, heads: { start, end } } });
const tool = (mode) => ({ tool: mode });
/** Word's Lines (probe/menus/insert.shapes.json), its 12 entries in its order: Word's name → a connector ({conn: {route, heads}}:
 * straight, elbow or curved, with Word's heads) or a board tool ({tool}: the board mode, whiteboard.js): 'curve' and 'freeform'
 * place a line point by point as Word's Curve and Freeform: Shape do, the pen draws Freeform: Scribble. Word's Insert Shapes
 * (src/document/wp/shapes/map.mjs), the canvas rail and the flowchart editor list these. */
export const LINE_SHAPES = {
  Line: conn('straight'),
  'Line Arrow': conn('straight', 'none', 'arrow'),
  'Line Arrow: Double': conn('straight', 'arrow', 'arrow'),
  'Connector: Elbow': conn('ortho'),
  'Connector: Elbow Arrow': conn('ortho', 'none', 'arrow'),
  'Connector: Elbow Double-Arrow': conn('ortho', 'arrow', 'arrow'),
  'Connector: Curved': conn('curve'),
  'Connector: Curved Arrow': conn('curve', 'none', 'arrow'),
  'Connector: Curved Double-Arrow': conn('curve', 'arrow', 'arrow'),
  Curve: tool('curve'),
  'Freeform: Shape': tool('freeform'),
  'Freeform: Scribble': tool('pen'),
};
/** The board's own line kinds and the Lines entry each is: its Line and Arrow are Word's Line and Line Arrow, so they are no
 * extra entries, and what arms one (a button, a key, tool search) arms the straight connector. Old items keep drawing as before. */
export const LINE_KINDS = { line: 'Line', arrow: 'Line Arrow' };

// Search words beyond the name: the route's and the heads' plain words (the board's old connector tiles' names among them).
const ROUTE_WORDS = { straight: ['straight'], ortho: ['elbow', 'right angle'], curve: ['curved', 'curve'] };
const TOOL_WORDS = {
  curve: ['smooth', 'bezier', 'spline', 'points', 'draw'],
  freeform: ['polygon', 'polyline', 'corners', 'points', 'freehand', 'draw'],
  pen: ['pen', 'draw', 'freehand', 'ink'],
};

/** Lines entry `name` as a picker entry → {ref, id, label, keywords, line}, or null. */
export function lineEntry(name) {
  const line = LINE_SHAPES[name];
  if (!line) return null;
  const { route, heads } = line.conn ?? {};
  const words = line.conn
    ? ['connector', 'link', 'edge', ...ROUTE_WORDS[route], ...(heads.end !== 'none' ? ['arrow'] : []), ...(heads.start !== 'none' ? ['double', 'two-way'] : [])]
    : TOOL_WORDS[line.tool];
  return { ref: `line:${name}`, id: name, label: name, keywords: ['line', 'lines', ...words], line };
}

/** The Lines entry board mode `mode` draws (Curve, Freeform: Shape, the pen's Freeform: Scribble), or null. */
export const toolLine = (mode) => Object.keys(LINE_SHAPES).find((n) => LINE_SHAPES[n].tool === mode) ?? null;

/** Word's Lines as a picker section. */
export const lineSection = () => ({ id: 'lines', title: TITLES.get('lines'), entries: Object.keys(LINE_SHAPES).map(lineEntry) });

/** The Lines entry a connector (or the connector tool) is, by its route and heads → its name, or null. */
export const lineOf = (c) => Object.keys(LINE_SHAPES).find((n) => {
  const l = LINE_SHAPES[n].conn;
  return l && l.route === c?.route && l.heads.start === (c.heads?.start ?? 'none') && l.heads.end === (c.heads?.end ?? 'none');
}) ?? null;

/** Arms `board`'s tool for a picker entry, the one place every caller (the board commands, the board's keys, Word's Insert Shapes in
 * a canvas) does it: Lines entry `line` arms the connector tool with its route and heads, or its board tool (Curve, Freeform: Shape,
 * the pen); shape kind `kind` arms the shape tool with that kind. */
export function armTool(board, { kind = null, line = null }) {
  const l = line && LINE_SHAPES[line];
  if (l?.conn) board.setConnTool(structuredClone(l.conn));
  else if (!l) board.setShapeTool({ shape: kind });
  return board.setMode(l ? (l.conn ? 'connector' : l.tool) : 'shape');
}

/** Lines entry `name` as an id part, 'Connector: Elbow Arrow' → 'connectorElbowArrow' (the board's command board.lines.<it>). */
export const lineSlug = (name) => name.split(/[^A-Za-z]+/).filter(Boolean).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');

// --- names ---

/** Kind `kind`'s name in every picker: Word's name for a preset of Word's gallery or for the board's line kinds, else the kind's
 * own label. */
export function shapeName(kind) {
  const k = kindOf(kind);
  return (k && (PRESET_LABELS[k.prst] || LINE_KINDS[k.kind])) || k?.label || kind;
}

/** Whether kind `k` (a kind object) draws a preset of Word's gallery. */
export const inGallery = (k) => !!PRESET_LABELS[k?.prst];

/** The picker entry of kind `kind` → {ref, kind, label, keywords}, or null. The kind's own label and its section's title are
 * search words too, so "box" still finds the Rectangle and "callout" every callout. */
export function kindEntry(kind) {
  const k = kindOf(kind);
  if (!k) return null;
  const words = [k.label, ...k.keywords, TITLES.get(sectionOf(k)) ?? ''].map((w) => w.toLowerCase()).filter(Boolean);
  return { ref: `kind:${kind}`, kind, label: shapeName(kind), keywords: [...new Set(words)] };
}

/** The library's sections in order, [{id, title, entries}], with the listed kinds `keep(k)` lets through in the library's order;
 * a section left empty is dropped. */
export function librarySections(keep = () => true) {
  return SHAPE_SECTIONS.map(({ id, title }) => ({ id, title, entries: SHAPE_KINDS.filter((k) => sectionOf(k) === id && keep(k)).map((k) => kindEntry(k.kind)) }))
    .filter((s) => s.entries.length);
}

/** A gallery's items (§1.4 GalleryItem, with `kind`, `keywords` and `tile` for a shape) as picker sections, one per `group` in
 * order of first appearance: a library section's id where the group is its title. */
export function gallerySections(items) {
  const ids = new Map(SHAPE_SECTIONS.map((s) => [s.title, s.id]));
  const out = [];
  for (const it of items) {
    const title = it.group ?? '';
    let s = out.find((x) => x.title === title);
    if (!s) out.push(s = { id: ids.get(title) ?? title.toLowerCase().replace(/\W+/g, '-'), title, entries: [] });
    s.entries.push({ ref: it.kind ? `kind:${it.kind}` : `item:${it.id}`, id: it.id, kind: it.kind ?? null, label: it.label, keywords: it.keywords ?? [], icon: it.tile ?? null });
  }
  return out;
}

/** The entries of `sections` that match `query`, best first, each ref once. rankTool's last tier (the query's letters in order)
 * is left out: among short shape names it matches most of them. */
export function searchShapes(sections, query) {
  const found = new Map();
  for (const s of sections) {
    for (const e of s.entries) {
      if (found.has(e.ref)) continue;
      const r = rankTool(query, e.label, e.keywords);
      if (r > 1) found.set(e.ref, [e, r]);
    }
  }
  return [...found.values()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
}

/** The sections a picker shows for `query`: one Results section while it has text, else those holding an entry or an `empty` hint. */
export const shownSections = (sections, query) => (query.trim()
  ? [{ id: 'results', title: 'Results', entries: searchShapes(sections, query) }]
  : sections.filter((s) => s.entries.length || s.empty));

/** `list` with `id` first, each id once, at most `max` long (a recently used row). */
export const recentWith = (list, id, max = list.length + 1) => [id, ...list.filter((x) => x !== id)].slice(0, max);
