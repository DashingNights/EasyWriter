// Auto-layout of a flowchart graph (flowchart plan §8, §9 Phase 4; SPEC §6d Formats) with @dagrejs/dagre: layered, groups as
// compound clusters, synchronous. A group's own `dir` is not used: dagre 3.1.1's per-cluster rankdir loses the positions of
// clusters nested in such a cluster (NaN) and draws it without padding. Edge points from dagre are ignored: the board's
// router draws the connectors afterwards (route.mjs). Pure (no DOM); bundled whole (CSP: no lazy load).
import { graphlib, layout as dagre } from '@dagrejs/dagre';
import { rotBox } from './shapes.mjs';

export const MAX_NODES = 500;
const DIRS = { TB: 'TB', TD: 'TB', BT: 'BT', LR: 'LR', RL: 'RL' };

/** Positions for `graph` ({dir, nodes: [{id, w, h, rot?}], edges: [{from, to}], groups: [{id, members}]}, sizes in px):
 * {nodes: {id: {x, y}} (top-left of the unrotated box), groups: {id: {x, y, w, h}}}, the drawing's top-left at 0,0. `dir`
 * TB | TD | BT | LR | RL (default graph.dir, else TB); `nodesep` / `ranksep`: the gaps between nodes in a rank / between
 * ranks. A turned node takes its turned bounds; an edge to a group goes to a member node (dagre cannot lay out edges to
 * clusters); a group without member nodes is laid out as a node of its own size. More than 500 nodes, or a dagre failure:
 * {error: {code: 'layout_failed', message}}. */
export function layout(graph, { dir = graph.dir, nodesep = 40, ranksep = 60 } = {}) {
  const nodes = graph.nodes ?? [];
  const groups = graph.groups ?? [];
  if (nodes.length > MAX_NODES) return { error: { code: 'layout_failed', message: `More than ${MAX_NODES} nodes: too many to lay out.` } };
  const g = new graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({ rankdir: DIRS[dir] ?? 'TB', nodesep, ranksep, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const size = new Map(); // id → its unrotated size
  for (const n of nodes) {
    const b = rotBox({ x: 0, y: 0, w: n.w, h: n.h, rot: n.rot });
    size.set(n.id, { w: n.w, h: n.h });
    g.setNode(n.id, { width: b.w, height: b.h });
  }
  const byGroup = new Map(groups.map((gr) => [gr.id, gr]));
  // A member node of group `id` (depth first; a member group that holds no node is a node itself), or null when it holds none.
  const leaf = (id, seen = new Set()) => {
    if (seen.has(id)) return null;
    seen.add(id);
    for (const m of byGroup.get(id)?.members ?? []) {
      if (size.has(m)) return m;
      const deeper = byGroup.has(m) && (leaf(m, seen) ?? m);
      if (deeper) return deeper;
    }
    return null;
  };
  for (const gr of groups) {
    if (leaf(gr.id)) g.setNode(gr.id, {});
    else {
      size.set(gr.id, { w: gr.w || 160, h: gr.h || 80 });
      g.setNode(gr.id, { width: gr.w || 160, height: gr.h || 80 });
    }
  }
  for (const gr of groups) for (const m of gr.members ?? []) if (m !== gr.id && g.hasNode(m)) g.setParent(m, gr.id);
  const end = (id) => (byGroup.has(id) && !size.has(id) ? leaf(id) : g.hasNode(id) ? id : null);
  (graph.edges ?? []).forEach((e, k) => {
    const [v, w] = [end(e.from), end(e.to)];
    if (v && w) g.setEdge(v, w, {}, e.id ?? `e${k}`);
  });
  try {
    dagre(g);
    if (g.nodes().some((v) => !Number.isFinite(g.node(v).x + g.node(v).y))) throw new Error('no position');
  } catch (err) {
    return { error: { code: 'layout_failed', message: `The layout failed: ${err.message}` } };
  }
  const out = { nodes: {}, groups: {} };
  for (const [id, s] of size) {
    const p = g.node(id);
    (byGroup.has(id) ? out.groups : out.nodes)[id] = byGroup.has(id)
      ? { x: Math.round(p.x - s.w / 2), y: Math.round(p.y - s.h / 2), w: s.w, h: s.h }
      : { x: Math.round(p.x - s.w / 2), y: Math.round(p.y - s.h / 2) };
  }
  for (const gr of groups) {
    const p = g.node(gr.id);
    if (!size.has(gr.id)) out.groups[gr.id] = { x: Math.round(p.x - p.width / 2), y: Math.round(p.y - p.height / 2), w: Math.round(p.width), h: Math.round(p.height) };
  }
  return out;
}
