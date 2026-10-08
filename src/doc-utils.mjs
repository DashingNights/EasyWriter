// Pure transforms on TipTap JSON. No imports; inputs are never mutated.

const HEADING = 'heading';
const CODE_BLOCK = 'codeBlock';

const hasMark = (node, type) => (node.marks ?? []).some((m) => m.type === type);

/** Adds base font / size marks to text that has none (see SPEC §5). */
export function applyBaseStyles(doc, { baseFont = '', baseSize = 100 } = {}) {
  const out = structuredClone(doc);
  const size = Number(baseSize) !== 100 ? String(baseSize) : null;
  if (!baseFont && !size) return out;

  const walk = (node, inHeading, inCode) => {
    if (node.type === 'text') {
      if (inCode || hasMark(node, 'code')) return;
      const add = [];
      if (baseFont && !hasMark(node, 'fontFamily')) add.push({ type: 'fontFamily', attrs: { font: baseFont } });
      if (size && !inHeading && !hasMark(node, 'fontSize')) add.push({ type: 'fontSize', attrs: { size } });
      if (add.length) node.marks = [...(node.marks ?? []), ...add];
      return;
    }
    for (const child of node.content ?? []) {
      walk(child, inHeading || node.type === HEADING, inCode || node.type === CODE_BLOCK);
    }
  };
  walk(out, false, false);
  return out;
}

const IMAGE_NODES = ['whiteboard', 'canvas', 'planChart'];

/** Replaces every whiteboard, canvas and plan chart node with a `[[IMG:i]]` paragraph; returns the nodes' attrs plus
 * `kind: 'whiteboard' | 'canvas' | 'planChart'` in document order. */
export function replaceWhiteboards(doc) {
  const out = structuredClone(doc);
  const boards = [];
  const walk = (node) => {
    if (!node.content) return;
    node.content = node.content.map((child) => {
      if (!IMAGE_NODES.includes(child.type)) {
        walk(child);
        return child;
      }
      const text = `[[IMG:${boards.length}]]`;
      boards.push({ ...child.attrs, kind: child.type });
      return { type: 'paragraph', content: [{ type: 'text', text }] };
    });
  };
  walk(out);
  return { doc: out, boards };
}

// Plain text of every textblock, in document order. Non-text inline nodes count as a space.
function blockTexts(node, out = []) {
  const kids = node.content ?? [];
  if (kids.some((k) => k.type === 'text')) out.push(kids.map((k) => k.text ?? ' ').join(''));
  else for (const k of kids) blockTexts(k, out);
  return out;
}

const TITLE_MAX = 60;

/** First non-empty block's text, at most 60 chars (ellipsis included), or 'Untitled draft'. */
export function draftTitle(doc) {
  const text = blockTexts(doc).map((t) => t.trim()).find(Boolean);
  if (!text) return 'Untitled draft';
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 3) + '...' : text;
}

/** Number of whitespace-separated words in the document. */
export function wordCount(doc) {
  return blockTexts(doc).join(' ').split(/\s+/).filter(Boolean).length;
}

const FLOW_ID = /^[a-f0-9-]{36}$/;

/** The synced canvases of `doc` (canvas nodes whose `flow` names a library flowchart) in document order: `path` = the
 * child indices from the doc down to the node, `flowId`, and `label` = `titleOf(flowId)` (the record's title), else
 * "Flowchart n" (n counts the distinct flowcharts). */
export function flowRefs(doc, titleOf = () => null) {
  const refs = [];
  const ids = [];
  const walk = (node, path) => (node.content ?? []).forEach((child, i) => {
    const id = child.type === 'canvas' ? child.attrs?.flow?.id : null;
    if (typeof id !== 'string' || !FLOW_ID.test(id)) return walk(child, [...path, i]);
    if (!ids.includes(id)) ids.push(id);
    refs.push({ path: [...path, i], flowId: id, label: titleOf(id) ?? `Flowchart ${ids.indexOf(id) + 1}` });
  });
  walk(doc, []);
  return refs;
}

/** The plan charts of `doc` in document order: [{id, planId}]. */
export function chartRefs(doc) {
  const refs = [];
  const walk = (node) => (node.content ?? []).forEach((child) => {
    if (child.type === 'planChart') refs.push({ id: child.attrs?.id ?? null, planId: child.attrs?.planId ?? null });
    else walk(child);
  });
  walk(doc);
  return refs;
}
