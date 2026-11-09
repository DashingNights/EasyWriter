// The canonical form of a post's JSON, for comparing two saves (docs/plans/engine/stage3-forum.md A4): checkPost compares
// normal(save('post').doc) with normal(draft.doc), so values the save may leave out or order differently must not differ.
// Pure: node --test loads it.

import { MARK_DEFAULTS, MARK_ORDER, NODE_DEFAULTS } from './html.mjs';

// What the reader adds after one of these at the end of a story or a container, so typing can go on past it; the writer
// drops it again, so it is not content (A3's write).
const CONTAINERS = new Set(['blockquote', 'codeBlock', 'box']);
const RANK = new Map(MARK_ORDER.map((name, i) => [name, i]));
const BLANK = (n) => n.type === 'paragraph' && !n.content?.length;

const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A node's attrs: the post kit's own keys with its defaults left out, so both sides of a save agree on what is not there. */
function attrsOf(node) {
  const defaults = NODE_DEFAULTS[node.type];
  if (!defaults) return null;
  const have = node.attrs ?? {};
  const kept = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const v = key === 'colwidth' && Array.isArray(have.colwidth) && !have.colwidth.some((w) => w != null) ? null : have[key];
    if (!equal(v ?? fallback, fallback)) kept[key] = v ?? fallback;
  }
  return Object.keys(kept).length ? kept : null;
}

/** Marks in the editor's nesting order, each with only its content-bearing attrs (a link keeps its href alone). A size at the
 * base (100 %) is no mark at all: the engine's model spells it the same as no size, and it shows the same, so a save leaves it
 * out (A3's write). Every other mark stays: an editor that cannot hold it would silently lose formatting, so the comparison
 * must refuse the post instead (checkPost). */
function marksOf(marks) {
  return marks
    .filter((m) => m.type !== 'fontSize' || (m.attrs?.size != null && Number(m.attrs.size) !== 100))
    .map((m) => {
      const kept = {};
      for (const [key, fallback] of Object.entries(MARK_DEFAULTS[m.type] ?? {})) {
        const v = m.attrs?.[key];
        if (!equal(v ?? fallback, fallback)) kept[key] = v ?? fallback;
      }
      const out = { type: m.type };
      if (Object.keys(kept).length) out.attrs = kept;
      return out;
    })
    .sort((a, b) => (RANK.get(a.type) ?? MARK_ORDER.length) - (RANK.get(b.type) ?? MARK_ORDER.length));
}

function normal(n) {
  const out = { type: n.type };
  const attrs = attrsOf(n);
  if (attrs) out.attrs = attrs;
  if (n.type === 'text') out.text = n.text ?? '';
  // A mark the save leaves out (a size at the base) leaves the run with no marks at all.
  const marks = n.marks?.length ? marksOf(n.marks) : [];
  if (marks.length) out.marks = marks;
  if (Array.isArray(n.content)) out.content = contentOf(n.content);
  return out;
}

function contentOf(list) {
  const kids = [];
  for (const c of list) {
    const n = normal(c);
    const last = kids.at(-1);
    if (n.type === 'text' && last?.type === 'text' && equal(last.marks, n.marks)) last.text += n.text;
    else if (n.type !== 'text' || n.text) kids.push(n);
  }
  // An empty paragraph left after a container is the reader's typing room, not the writer's content.
  while (kids.length > 1 && CONTAINERS.has(kids.at(-2).type) && BLANK(kids.at(-1))) kids.pop();
  return kids;
}

/** `doc` with text runs merged, marks sorted and trimmed, default attrs, null colwidth, a container's trailing empty
 * paragraph, `shown`, the nw/nh/ch hints and a suggestion's `suggest` left out. */
export { normal };
