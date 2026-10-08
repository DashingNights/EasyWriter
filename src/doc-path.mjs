// Block addressing for the command layer (SPEC §8; agent-automation plan §3.5). A PATH is the list of child indices from
// the doc down to a block: [4] = the fifth top-level block, [2, 1, 0] = list → its second item → that item's first
// paragraph. outline / nodeAt / find read TipTap JSON; posOfPath / pathOfPos read ProseMirror Nodes (duck-typed: no imports).
// Text offsets are block-local: the characters of the textblock's text, a hard break counting one ('\n'), as ProseMirror's
// parentOffset counts them.

export const BOARD_TYPES = ['whiteboard', 'canvas', 'planChart'];

/** The node of TipTap JSON `doc` at `path`, or null. */
export function nodeAt(doc, path) {
  let node = doc;
  for (const i of path) {
    node = node?.content?.[i];
    if (!node) return null;
  }
  return node;
}

/** The plain text of a TipTap JSON node: its text, a hard break as '\n', child blocks separated by a space. */
export function nodeText(node) {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  const inline = node.content?.every((c) => c.type === 'text' || c.type === 'hardBreak');
  return (node.content ?? []).map(nodeText).join(inline ? '' : ' ');
}

function boardAttrs(node) {
  const a = node.attrs ?? {};
  return { kind: node.type, items: Array.isArray(a.items) ? a.items.length : 0, w: a.w ?? null, h: a.h ?? a.height ?? null };
}

/** A block's plain text for outline(): the first 120 characters, and when it is longer, a marker with its full length, so the
 * model knows the text goes on (2026-10-07: a cut paragraph read as a fragment, and the model replaced it with its 120 characters). */
const cutText = (s) => (s.length > 120 ? `${s.slice(0, 120)}... (cut, ${s.length} characters in all)` : s);

/** [{path, type, text, attrs?}] of the blocks of `doc` down to `depth` levels (1: the top level): `text` is the block's plain text,
 * cut after 120 characters with a marker (cutText); a board node's `attrs` = {kind, items, w, h}, a heading's = {level}. */
export function outline(doc, { depth = 1 } = {}) {
  const out = [];
  const walk = (node, path) => {
    (node.content ?? []).forEach((child, i) => {
      if (child.type === 'text' || child.type === 'hardBreak') return;
      const p = [...path, i];
      const entry = { path: p, type: child.type, text: BOARD_TYPES.includes(child.type) ? '' : cutText(nodeText(child)) };
      if (BOARD_TYPES.includes(child.type)) entry.attrs = boardAttrs(child);
      else if (child.type === 'heading') entry.attrs = { level: child.attrs?.level };
      out.push(entry);
      if (p.length < depth && !BOARD_TYPES.includes(child.type)) walk(child, p);
    });
  };
  walk(doc, []);
  return out;
}

const isTextblock = (node) => !!node.content?.length && node.content.every((c) => c.type === 'text' || c.type === 'hardBreak')
  || ['paragraph', 'heading', 'codeBlock', 'boxTitle'].includes(node.type);

/** Every textblock of `doc` with its path, in document order. */
function textblocks(doc) {
  const out = [];
  const walk = (node, path) => (node.content ?? []).forEach((child, i) => {
    if (BOARD_TYPES.includes(child.type) || child.type === 'text' || child.type === 'hardBreak') return;
    if (isTextblock(child)) out.push({ path: [...path, i], text: nodeText(child) });
    else walk(child, [...path, i]);
  });
  walk(doc, []);
  return out;
}

const CONTEXT = 40;
const MAX_MATCHES = 500;

/** The matches of `text` (a regular expression source with `regex`) in the textblocks of `doc`:
 * [{path, from, to, context}] with block-local offsets and 40 characters of context on each side. Throws on a bad regex. */
export function find(doc, { text, regex = false, caseSensitive = false }) {
  const source = regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(source, caseSensitive ? 'g' : 'gi');
  const out = [];
  for (const block of textblocks(doc)) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(block.text)) && out.length < MAX_MATCHES;) {
      if (!m[0].length) {
        re.lastIndex++; // an empty match would never advance
        continue;
      }
      const from = m.index;
      const to = from + m[0].length;
      out.push({ path: block.path, from, to, context: block.text.slice(Math.max(0, from - CONTEXT), to + CONTEXT) });
    }
  }
  return out;
}

/** The position just before the node at `path` in ProseMirror doc `pmDoc`, or null when there is none. */
export function posOfPath(pmDoc, path) {
  let node = pmDoc;
  let pos = 0;
  for (let d = 0; d < path.length; d++) {
    const i = path[d];
    if (!Number.isInteger(i) || i < 0 || i >= node.childCount || node.inlineContent) return null;
    for (let j = 0; j < i; j++) pos += node.child(j).nodeSize;
    node = node.child(i);
    if (d < path.length - 1) pos += 1; // into the node
  }
  return path.length ? pos : null;
}

/** The path of the block that starts at `pos` in ProseMirror doc `pmDoc`, else of the innermost block holding `pos`; null
 * for a position at the doc level with no block after it. */
export function pathOfPos(pmDoc, pos) {
  if (pos < 0 || pos > pmDoc.content.size) return null;
  const $p = pmDoc.resolve(pos);
  const path = [];
  for (let d = 0; d < $p.depth; d++) path.push($p.index(d));
  if (!$p.parent.inlineContent && $p.nodeAfter) path.push($p.index($p.depth));
  return path.length ? path : null;
}
