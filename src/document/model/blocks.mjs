// Blocks and stories of a Document (docs/plans/word/plan.md §1.8 Wrapper nodes, Stories inside attributes). columns, sdtBlock and
// fieldBlock hold blocks, so the top level is no longer flat: every reader that walked doc.forEach for blocks walks blocksOf.
// Note text, header and footer parts and comment text are block JSON inside attributes: storiesOf lists each with a locator.
// Pure: ProseMirror nodes in, plain data out, so Node tests and every package share it.

/** The node types whose children are blocks of the text flow. */
export const WRAPPERS = new Set(['columns', 'sdtBlock', 'fieldBlock']);
/** The inline node types of the kits (sdtInline holds inline content of its own). */
export const INLINE = new Set(['text', 'hardBreak', 'image', 'field', 'bookmark', 'noteRef', 'equation', 'ruby', 'ptab', 'sdtInline']);

/** Every block of ProseMirror doc `doc` in document order, through the wrappers: {node, pos, depth, parent, index}. A wrapper
 * comes before its children (depth 0 at the top level, +1 per wrapper). */
export function* blocksOf(doc) {
  function* walk(parent, start, depth) {
    let pos = start;
    for (let index = 0; index < parent.childCount; index++) {
      const node = parent.child(index);
      yield { node, pos, depth, parent, index };
      if (WRAPPERS.has(node.type.name)) yield* walk(node, pos + 1, depth + 1);
      pos += node.nodeSize;
    }
  }
  yield* walk(doc, 0, 0);
}

const PARTS = ['default', 'first', 'even'];
// A story attribute holds an array of block JSON; a doc JSON wrapper is read too.
const blocksJson = (v) => (Array.isArray(v) ? v : Array.isArray(v?.content) ? v.content : null);

/** Every story of `doc` held in an attribute, in this order: headers and footers per section (sectionBreaks in document order, then
 * doc.attrs.sect for the last section), notes in document order, then comments. [{at, content, holder}]: `at` the locator
 * ({story: 'header'|'footer', section, part} | {story: 'note', id} | {story: 'comment', id}), `content` its block JSON, `holder`
 * the position of the node holding it (sectionBreak or noteRef) or null for doc attributes. */
export function storiesOf(doc) {
  const out = [];
  const sects = [];
  for (const { node, pos } of blocksOf(doc)) if (node.type.name === 'sectionBreak') sects.push({ sect: node.attrs.sect, holder: pos });
  sects.push({ sect: doc.attrs.sect, holder: null });
  sects.forEach(({ sect, holder }, section) => {
    for (const [story, key] of [['header', 'hdr'], ['footer', 'ftr']]) {
      for (const part of PARTS) {
        const content = blocksJson(sect?.[key]?.[part]);
        if (content) out.push({ at: { story, section, part }, content, holder });
      }
    }
  });
  doc.descendants((node, pos) => {
    if (node.type.name !== 'noteRef') return true;
    const content = blocksJson(node.attrs.content);
    if (content) out.push({ at: { story: 'note', id: node.attrs.id }, content, holder: pos });
    return false;
  });
  for (const [id, c] of Object.entries(doc.attrs.comments ?? {})) {
    const content = blocksJson(c?.content);
    if (content) out.push({ at: { story: 'comment', id }, content, holder: null });
  }
  return out;
}

/** A ProseMirror doc of `schema` holding story block JSON `content`; throws when the JSON does not fit the schema. */
export const storyDoc = (schema, content) => schema.topNodeType.create(null, content.map((j) => schema.nodeFromJSON(j)));
