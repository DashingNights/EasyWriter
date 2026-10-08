// Board items ↔ the flowchart graph (flowchart plan §3.7; SPEC §6d Formats): what Mermaid import, Copy as Mermaid and auto-layout
// work on. Pure (no DOM). Graph sizes and positions are post px; items are board px of `unit` (board px per post px, §6c Units).
// Graph: as mermaid.mjs, plus node x y w h rot, edge route / startLabel / endLabel, group kind frame | lane and x y w h.
import { layout } from './layout.mjs';
import { cleanConnector, containedIn, defaultMeasure } from './model.mjs';
import { flowPreset, kindOf } from './shapes.mjs';

const CONTAINERS = ['frame', 'lane'];
const NODE_TYPES = ['shape', 'text', 'image', 'canvas'];
const ROUND = ['ellipse', 'sm-circ', 'cross-circ', 'or-circ'];
const PAD = 24; // a group's frame around its members, post px (when the positions are given)
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const r2 = (n) => Math.round(n * 100) / 100;
const newId = () => Math.random().toString(36).slice(2, 9);

/** A label's html (the text-item content rules) → plain text, '\n' for a line break. */
export const htmlToText = (html) => String(html ?? '').replace(/<br\s*\/?>|<(?:div|p)(?:\s[^>]*)?>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/^\n/, '').replace(/&(#\d+|\w+);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(Number(e.slice(1))) : ENTITY[e] ?? m));

/** Plain text → label html. */
export const textToHtml = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

/** A node's size in post px for its label (16 px text): its kind's own box when it has one (the small circles, the fork bar),
 * else at least 140 × 64, wide enough for the label within the kind's label inset (at most 280 wide, then wrapped); circles
 * square. → {w, h} */
export function nodeSize(node) {
  const k = kindOf(node.kind);
  if (k?.box) return { w: k.box[0], h: k.box[1] };
  const lines = String(node.label ?? '').split('\n');
  const [ix, iy] = [k?.labelInset?.x ?? 0.08, k?.labelInset?.y ?? 0.08];
  const CHAR = 9; // px per character at 16 px
  const text = (w) => w * (1 - 2 * ix) - 16; // the label's room in a box w wide (the label pads 8 px a side)
  const w = Math.max(140, Math.min(280, Math.ceil((Math.max(...lines.map((l) => l.length)) * CHAR + 16) / (1 - 2 * ix))));
  const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil((l.length * CHAR) / text(w))), 0);
  const h = Math.max(64, Math.ceil((rows * 21 + 12) / (1 - 2 * iy)));
  return ROUND.includes(node.kind) ? { w: Math.max(w, h), h: Math.max(w, h) } : { w, h };
}

/** The graph of board `items`: shapes, text, images and canvases as nodes (kind: the shape kind, else the item type;
 * label: the label as text), swimlanes and frames as groups (members: the items whose turned bounds lie inside, the
 * innermost group only), connectors bound at both ends to nodes or groups as edges (a free end: left out); `dir` from the
 * edges' prevailing direction. A shape's style {fill, stroke, text} holds the colours that differ from `preset` (flowPreset:
 * the theme's default look; without it, all of them). */
export function toGraph(items, { unit = 1, preset = null } = {}) {
  const post = (v) => r2(v / unit);
  const boxOf = (i) => {
    const b = defaultMeasure(i);
    return { x: post(b.x), y: post(b.y), w: post(b.w), h: post(b.h) };
  };
  const containers = items.filter((i) => i.type === 'shape' && CONTAINERS.includes(i.shape));
  const inside = new Map(containers.map((c) => [c, new Set(containedIn(c, items))]));
  const area = (i) => i.w * i.h;
  const parentOf = (i) => containers.filter((c) => inside.get(c).has(i.id) && (!containers.includes(i) || area(c) > area(i)))
    .sort((a, b) => area(a) - area(b))[0];
  const nodeItems = items.filter((i) => NODE_TYPES.includes(i.type) && !containers.includes(i));
  const fillOf = (i) => (i.fill === 'none' ? 'none' : i.fillColor);
  const nodes = nodeItems.map((i) => {
    const n = { id: i.id, kind: i.type === 'shape' ? i.shape : i.type, label: htmlToText(i.html), ...boxOf(i), ...(i.type === 'shape' && i.rot && { rot: i.rot }) };
    if (i.type !== 'shape') return n;
    const own = { fill: fillOf(i), stroke: i.color, text: i.textColor };
    const base = preset && { fill: fillOf(preset), stroke: preset.color, text: preset.textColor };
    const style = Object.fromEntries(Object.entries(own).filter(([k, v]) => v && v !== base?.[k]));
    if (Object.keys(style).length) n.style = style;
    return n;
  });
  const groups = containers.map((c) => ({ id: c.id, kind: c.shape, label: htmlToText(c.html), ...boxOf(c), members: [] }));
  for (const i of [...containers, ...nodeItems]) {
    const p = parentOf(i);
    if (p) groups.find((g) => g.id === p.id).members.push(i.id);
  }
  const ids = new Set([...nodes, ...groups].map((n) => n.id));
  const text = (l) => l && htmlToText(l.html);
  const edges = items.filter((c) => c.type === 'connector' && ids.has(c.from.item) && ids.has(c.to.item)).map((c) => ({
    id: c.id, from: c.from.item, to: c.to.item,
    ...(text(c.labels?.mid) && { label: text(c.labels.mid) }), ...(text(c.labels?.start) && { startLabel: text(c.labels.start) }),
    ...(text(c.labels?.end) && { endLabel: text(c.labels.end) }),
    heads: { start: c.heads?.start ?? 'none', end: c.heads?.end ?? 'arrow' }, dash: c.dash ?? 'solid', route: c.route ?? 'ortho',
    ...(post(c.width ?? 2) >= 3 && { thick: true }),
  }));
  // The direction most edges run in (centre to centre).
  const at = new Map([...nodes, ...groups].map((n) => [n.id, { x: n.x + n.w / 2, y: n.y + n.h / 2 }]));
  let [h, v] = [0, 0];
  for (const e of edges) {
    const [a, b] = [at.get(e.from), at.get(e.to)];
    if (Math.abs(b.x - a.x) > Math.abs(b.y - a.y)) h += Math.sign(b.x - a.x);
    else v += Math.sign(b.y - a.y);
  }
  const dir = Math.abs(h) > Math.abs(v) ? (h > 0 ? 'LR' : 'RL') : v < 0 ? 'BT' : 'TB';
  return { dir, nodes, edges, groups };
}

/** Board items for `graph` (board px of `unit`): groups as frames or swimlanes (outer first, so behind; no fill), nodes as
 * shapes in the style of `preset` (flowPreset) unless a node has its own (kind 'text': a text item; a kind the registry does
 * not have: a box), edges as floating connectors in the preset's ink, elbow by default. A node without a size gets one for
 * its label (nodeSize); when any node has no position the graph is laid out (layout(), direction `dir`), else a group is
 * its members' bounds + 24 px. Item ids are the graph ids, except where `taken` holds one (then makeId()). Connectors are
 * not routed (the board's commit, or resolveConnectors, routes them). → {items, ids: Map graph id → item id} | {error}. */
export function fromGraph(graph, { unit = 1, preset = flowPreset('dark'), taken = new Set(), makeId = newId, dir = graph.dir } = {}) {
  const nodes = (graph.nodes ?? []).map((n) => (Number.isFinite(n.w) && Number.isFinite(n.h) ? n : { ...n, ...nodeSize(n) }));
  const groups = graph.groups ?? [];
  const parent = new Map();
  for (const g of groups) for (const m of g.members ?? []) parent.set(m, g.id);
  const depth = (id, n = 0) => (parent.has(id) && n < groups.length ? depth(parent.get(id), n + 1) : n);
  const box = new Map(); // graph id → {x, y, w, h} post px
  if (nodes.some((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y))) {
    const pos = layout({ ...graph, nodes }, { dir });
    if (pos.error) return pos;
    for (const n of nodes) box.set(n.id, { ...pos.nodes[n.id], w: n.w, h: n.h });
    for (const g of groups) box.set(g.id, pos.groups[g.id]);
  } else {
    for (const n of nodes) box.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
    for (const g of [...groups].sort((a, b) => depth(b.id) - depth(a.id))) { // innermost first
      const inner = (g.members ?? []).map((m) => box.get(m)).filter(Boolean);
      if ([g.x, g.y, g.w, g.h].every(Number.isFinite)) box.set(g.id, { x: g.x, y: g.y, w: g.w, h: g.h });
      else if (inner.length) {
        const [x, y] = [Math.min(...inner.map((b) => b.x)) - PAD, Math.min(...inner.map((b) => b.y)) - PAD];
        box.set(g.id, { x, y, w: Math.max(...inner.map((b) => b.x + b.w)) + PAD - x, h: Math.max(...inner.map((b) => b.y + b.h)) + PAD - y });
      } else box.set(g.id, { x: 0, y: 0, w: 160, h: 80 });
    }
  }
  const used = new Set([...taken, 'preview']); // 'preview': the Board's id for an item being drawn
  const ids = new Map();
  const claim = (want) => {
    let id = typeof want === 'string' && want ? want : makeId();
    while (used.has(id)) id = makeId();
    used.add(id);
    return id;
  };
  for (const x of [...groups, ...nodes]) ids.set(x.id, claim(x.id));
  const px = (b) => ({ x: Math.round(b.x * unit), y: Math.round(b.y * unit), w: Math.max(1, Math.round(b.w * unit)), h: Math.max(1, Math.round(b.h * unit)) });
  const ink = preset.color;
  const shape = (x, kind, s = {}) => ({
    id: ids.get(x.id), type: 'shape', shape: kind, ...px(box.get(x.id)), color: s.stroke ?? ink, width: r2(preset.width * unit), opacity: 1,
    fill: (s.fill ?? preset.fill) === 'none' ? 'none' : 'solid', fillColor: s.fill && s.fill !== 'none' ? s.fill : preset.fillColor,
    ...(x.label && { html: textToHtml(x.label), size: r2(preset.size * unit), textColor: s.text ?? preset.textColor }),
    ...(Number.isFinite(x.rot) && x.rot && { rot: x.rot }),
  });
  const items = [...groups].sort((a, b) => depth(a.id) - depth(b.id)).map((g) => shape(g, g.kind === 'lane' ? 'lane' : 'frame', { fill: 'none' }));
  for (const n of nodes) {
    if (n.kind !== 'text') items.push(shape(n, kindOf(n.kind) ? n.kind : 'rect', n.style));
    else {
      const { x, y, w } = px(box.get(n.id));
      items.push({ id: ids.get(n.id), type: 'text', html: textToHtml(n.label), x, y, w, size: r2(preset.size * unit), color: n.style?.text ?? ink, bold: false, align: 'center' });
    }
  }
  const label = (t) => t && { html: textToHtml(t), size: r2(14 * unit), textColor: ink };
  for (const e of graph.edges ?? []) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    items.push(cleanConnector({
      id: claim(e.id), type: 'connector', from: { item: ids.get(e.from), anchor: null }, to: { item: ids.get(e.to), anchor: null },
      route: e.route ?? 'ortho', corner: 8, points: [], heads: { start: e.heads?.start ?? 'none', end: e.heads?.end ?? 'arrow' }, color: ink,
      width: r2((e.thick ? 4 : 2) * unit), opacity: 1, dash: e.dash ?? 'solid', jump: 'none',
      labels: { start: label(e.startLabel), mid: label(e.label), end: label(e.endLabel) },
    }));
  }
  return { items, ids };
}
