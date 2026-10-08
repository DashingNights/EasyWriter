// Tool search ranking (SPEC §7c), the palette's cmdk filter: how well `query` matches an entry's label and keywords.
// 0 = no match, higher = better; equal scores keep the registry order. Best first: the exact label, an exact keyword
// ("h2", "red": a whole synonym beats a label that merely starts with the query, e.g. "Redo"), the label's start, a
// keyword's start, the start of a word in the label, then in a keyword, the query anywhere, then the query's letters in
// order in the label ("bld" → Bold; not in keywords, where that matches almost anything).

import { kindOf } from '../flow/shapes.mjs';

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const words = (s) => s.split(/[\s/()+-]+/);

function inOrder(q, s) {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}

// Flowchart mode's sections [category, heading], best first (an entry's `category`, tools.js): listed first with an empty
// query, and on equal match quality they break the tie in this order, before the other entries.
export const FLOW_SECTIONS = [['flowchart', 'Flowchart shapes'], ['text', 'Text'], ['basic', 'Basic shapes']];

// A node-selected block (blockKind): [heading, its actions as on its bar (entry ids, the main one first), the suggested
// entries]. Listed first with an empty query, and they win ties, as flowchart mode's sections do.
export const BLOCK_SECTIONS = {
  flowchart: ['Flowchart canvas', ['canvas-edit', 'canvas-library', 'flow-unlink', 'flow-save-to-library', 'canvas-actual-size', 'canvas-full-width',
    'canvas-delete'], ['flow-library-open', 'assistant']],
  canvas: ['Smart canvas', ['canvas-edit', 'flow-save-to-library', 'canvas-actual-size', 'canvas-full-width', 'canvas-delete'], ['flow-library-open', 'assistant']],
  image: ['Image', ['canvas-edit', 'canvas-actual-size', 'canvas-full-width', 'canvas-delete'], ['assistant']],
  planChart: ['Plan chart', ['chart-open', 'chart-kanban', 'chart-backlog', 'chart-gantt', 'chart-freeze', 'chart-refresh', 'chart-live', 'chart-full-width',
    'chart-delete'], ['plan-open', 'assistant']],
  whiteboard: ['Whiteboard', ['pen', 'add-text', 'shape', 'add-canvas', 'fit-height', 'background', 'delete-board'], ['assistant']],
};
const TIE_ORDER = ['block', 'suggested', ...FLOW_SECTIONS.map(([category]) => category)];

/** `tie`: the entry's section for the tie-break (TIE_ORDER: a selected block's two sections, flowchart mode's categories), a
 * bonus under 1 (elsewhere leave it out). */
export function rankTool(query, label, keywords = [], tie) {
  const q = norm(query);
  if (!q) return 1;
  const l = norm(label);
  const k = keywords.map(norm);
  const letters = q.replace(/ /g, '');
  const tiers = [
    l === q,
    k.includes(q),
    l.startsWith(q),
    k.some((w) => w.startsWith(q)),
    words(l).some((w) => w.startsWith(q)),
    k.some((w) => words(w).some((x) => x.startsWith(q))),
    l.includes(q) || k.some((w) => w.includes(q)),
    inOrder(letters, l),
  ];
  const t = tiers.indexOf(true);
  const i = TIE_ORDER.indexOf(tie);
  return t < 0 ? 0 : tiers.length - t + (i < 0 ? 0 : (TIE_ORDER.length - i) / (TIE_ORDER.length + 1));
}

export const GROUPS = ['Board', 'Text', 'Insert', 'Item', 'Edit', 'Plan', 'Flowchart', 'App'];

/** The palette's sections [heading, entries, tie?]: a node-selected block's (`block`: its kind) or flowchart mode's (`flow`)
 * first, then the groups in GROUPS order with the other entries. `tie`: rankTool's tie-break for the section's entries. */
export function paletteSections(entries, { flow, block }) {
  const pick = (ids) => ids.map((id) => entries.find((x) => x.id === id)).filter(Boolean);
  const [heading, own, suggested] = BLOCK_SECTIONS[block] ?? [];
  const first = heading ? [[heading, pick(own), 'block'], ['Suggested', pick(suggested), 'suggested']]
    : flow ? FLOW_SECTIONS.map(([category, title]) => [title, entries.filter((x) => x.category === category), category]) : [];
  const shown = new Set(first.flatMap(([, list]) => list));
  return [...first, ...GROUPS.map((group) => [group, entries.filter((x) => x.group === group && !shown.has(x))])];
}

/** What the tool search calls a node-selected block of type `type` with `attrs`: flowchart (a canvas that is a flowchart, as
 * flowchartMode), image (a canvas holding one image), canvas, planChart, whiteboard; null for any other block. */
export function blockKind(type, attrs) {
  if (type === 'canvas') return flowchartMode(null, attrs) ? 'flowchart' : attrs.items?.length === 1 && attrs.items[0].type === 'image' ? 'image' : 'canvas';
  return type === 'planChart' || type === 'whiteboard' ? type : null;
}

/** Flowchart mode (§7c): the flowchart library editor (`view`), or `canvas` (the attrs of the canvas being edited in place)
 * is a flowchart: synced with or copied from the library (flow, source), or holding a connector or a flowchart shape. */
export const flowchartMode = (view, canvas) => (view?.type === 'flows' && !!view.flowId)
  || (!!canvas && (!!canvas.flow || !!canvas.source
    || !!canvas.items?.some((i) => i.type === 'connector' || (i.type === 'shape' && kindOf(i.shape)?.group === 'flow'))));
