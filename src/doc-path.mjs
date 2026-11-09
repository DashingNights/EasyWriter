// Block addressing for the command layer (SPEC §8; agent-automation plan §3.5). A PATH is the list of child indices from
// the doc down to a block: [4] = the fifth top-level block, [2, 1, 0] = list → its second item → that item's first
// paragraph. outline / nodeAt / find read TipTap JSON; posOfPath / pathOfPos read ProseMirror Nodes (duck-typed: no imports).
// Text offsets are block-local and equal ProseMirror's parentOffset: a hard break counts one ('\n'), every other inline leaf (a
// field, a bookmark, a note, a picture) one U+FFFC, and an inline container (a content control) one U+FFFC at each boundary, so
// doc.find, doc.selection and doc.format agree past them (docs/plans/word/plan.md §1.8 Agents).

import { INLINE } from './document/model/blocks.mjs';

export const BOARD_TYPES = ['canvas', 'planChart'];

/** The node of TipTap JSON `doc` at `path`, or null. */
export function nodeAt(doc, path) {
  let node = doc;
  for (const i of path) {
    node = node?.content?.[i];
    if (!node) return null;
  }
  return node;
}

const OBJ = '￼';
// Inline containers hold inline content of their own.
const CONTAINERS = new Set(['sdtInline']);
const inlineContent = (node) => !!node.content?.length && node.content.every((c) => INLINE.has(c.type) || c.marks);

/** The text of a TipTap JSON node with ProseMirror's offsets: its text, a hard break as '\n', any other inline leaf as U+FFFC and an
 * inline container between two U+FFFC, joined without spaces; child blocks separated by a space. */
export function nodeText(node) {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (CONTAINERS.has(node.type)) return `${OBJ}${(node.content ?? []).map(nodeText).join('')}${OBJ}`;
  if (INLINE.has(node.type)) return OBJ;
  return (node.content ?? []).map(nodeText).join(inlineContent(node) ? '' : ' ');
}

/** The text of a TipTap JSON node as a reader sees it (outline): a field as its result, other inline leaves as nothing. */
function readText(node) {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'field') return node.attrs?.result ?? '';
  if (INLINE.has(node.type) && !CONTAINERS.has(node.type)) return '';
  return (node.content ?? []).map(readText).join(inlineContent(node) || CONTAINERS.has(node.type) ? '' : ' ');
}

function boardAttrs(node) {
  const a = node.attrs ?? {};
  return { kind: node.type, items: Array.isArray(a.items) ? a.items.length : 0, w: a.w ?? null, h: a.h ?? null };
}

/** A block's plain text for outline(): the first 120 characters, and when it is longer, a marker with its full length, so the
 * model knows the text goes on (2026-10-07: a cut paragraph read as a fragment, and the model replaced it with its 120 characters). */
const cutText = (s) => (s.length > 120 ? `${s.slice(0, 120)}... (cut, ${s.length} characters in all)` : s);

/** A block's waiting suggestion (attrs.suggest, docs/wiki/suggestions.md) for outline(), or undefined: 'insert s7k2a1',
 * 'replace s7k2a1', 'deleted before: 2 blocks s8m3q0', joined by '; '. `replaced`: the ids whose run replaced blocks. */
function pendingOf(r, replaced) {
  if (!r) return undefined;
  const out = r.ins ? [`${replaced.has(r.ins.id) ? 'replace' : 'insert'} ${r.ins.id}`] : [];
  for (const d of r.del ?? []) out.push(`deleted ${d.side}: ${d.old?.length ?? 0} block${d.old?.length === 1 ? '' : 's'} ${d.id}`);
  return out.join('; ') || undefined;
}

/** [{path, type, text, attrs?, pending?}] of the blocks of `doc` down to `depth` levels (1: the top level): `text` is the block's
 * plain text, cut after 120 characters with a marker (cutText); a board node's `attrs` = {kind, items, w, h}, a heading's = {level};
 * `pending` names a waiting suggestion on a top-level block (pendingOf). */
export function outline(doc, { depth = 1 } = {}) {
  const out = [];
  const replaced = new Set((doc.content ?? []).filter((b) => b?.attrs?.suggest?.ins?.old).map((b) => b.attrs.suggest.ins.id));
  const walk = (node, path) => {
    (node.content ?? []).forEach((child, i) => {
      if (INLINE.has(child.type)) return;
      const p = [...path, i];
      const entry = { path: p, type: child.type, text: BOARD_TYPES.includes(child.type) ? '' : cutText(readText(child)) };
      if (BOARD_TYPES.includes(child.type)) entry.attrs = boardAttrs(child);
      else if (child.type === 'heading') entry.attrs = { level: child.attrs?.level };
      const pending = pendingOf(child.attrs?.suggest, replaced);
      if (pending) entry.pending = pending;
      out.push(entry);
      if (p.length < depth && !BOARD_TYPES.includes(child.type)) walk(child, p);
    });
  };
  walk(doc, []);
  return out;
}

const isTextblock = (node) => inlineContent(node) || ['paragraph', 'heading', 'codeBlock', 'boxTitle'].includes(node.type);

/** Every textblock of `doc` with its path, in document order. */
function textblocks(doc) {
  const out = [];
  const walk = (node, path) => (node.content ?? []).forEach((child, i) => {
    if (BOARD_TYPES.includes(child.type) || INLINE.has(child.type)) return;
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
