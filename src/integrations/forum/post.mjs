// The forum post's pure transforms on TipTap JSON (SPEC §5): base styles, and the [[IMG:i]] placeholders that
// integrations/forum/inject.js swaps for the uploaded images. No imports; inputs are never mutated.

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

const IMAGE_NODES = ['canvas', 'planChart', 'media'];

/** Replaces every canvas, plan chart and media node with a `[[IMG:i]]` paragraph; returns the nodes' attrs plus
 * `kind: 'canvas' | 'planChart' | 'media'` in document order. */
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
