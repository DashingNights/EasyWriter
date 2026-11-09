// Static drawings of notes (docs/plans/word/plan.md §1.9 Static drawings): a note's text, its separators and the continuation
// notice, drawn as DOM that editor plugins never see, inside the footnote areas of the page layer and the endnote areas in the
// text. The drawings sit inside the main .ProseMirror, so the document's style sheet (Footnote Text, Footnote Reference) applies.
import { DOMSerializer } from '@tiptap/pm/model';
import { layoutTabs } from '../tabs/static.js';
import { STYLE_IDS } from './model.mjs';

const serializers = new WeakMap();
const serializerOf = (schema) => {
  let s = serializers.get(schema);
  if (!s) serializers.set(schema, (s = DOMSerializer.fromSchema(schema)));
  return s;
};

const ids = new WeakMap();
let nextId = 0;
/** A short stable id of `content` (a block JSON array), for drawing keys: attrs are replaced, never mutated, so identity is enough. */
export function contentId(content) {
  if (!content || typeof content !== 'object') return 0;
  let id = ids.get(content);
  if (!id) ids.set(content, (id = ++nextId));
  return id;
}

/** `content` (block JSON) drawn with `schema` into a fragment; an unreadable story draws as one empty paragraph. */
function blocksOf(schema, content, doc) {
  try {
    const nodes = (content?.length ? content : [{ type: 'paragraph' }]).map((j) => schema.nodeFromJSON(j));
    return serializerOf(schema).serializeFragment(schema.nodes.doc.create(null, nodes).content, { document: doc });
  } catch {
    const frag = doc.createDocumentFragment();
    frag.append(doc.createElement('p'));
    return frag;
  }
}

/** Lays out the tab characters of a drawn part against the document's default stop and the part's width. */
const tabs = (root, schemaDoc, width) => layoutTabs(root, { defaultTabStop: schemaDoc?.attrs.settings?.defaultTabStop ?? 36, width });

/** A note drawn as `div[data-note-box]`: its text with the label leading its first paragraph in the reference style, as Word
 * starts a note with its number and a space. `ctx` {schema, doc (the main doc), width (px), ownerDocument}. */
export function noteBox(ctx, { id, kind, label, content }) {
  const d = ctx.ownerDocument;
  const box = d.createElement('div');
  box.dataset.noteBox = '';
  box.dataset.id = id;
  box.dataset.kind = kind;
  box.append(blocksOf(ctx.schema, content, d));
  const num = d.createElement('sup');
  num.dataset.noteNum = '';
  num.dataset.cstyle = STYLE_IDS[kind].ref;
  num.textContent = label;
  const first = box.firstElementChild;
  if (first?.matches('p, h1, h2, h3, h4, h5, h6')) first.prepend(num, ' ');
  else box.prepend(num);
  tabs(box, ctx.doc, ctx.width);
  return box;
}

/** A separator part (`which`: 'separator', 'continuationSeparator' or 'continuationNotice') of a note kind's `sep`: the user's
 * blocks when set, else Word's default: a short rule for the separator, one across the column for the continuation separator and
 * nothing for the notice. → an element, or null for an empty notice. */
export function sepBox(ctx, kind, which, sep) {
  const d = ctx.ownerDocument;
  const el = d.createElement('div');
  el.dataset.noteSep = which;
  el.dataset.kind = kind;
  const own = sep?.[which];
  if (Array.isArray(own)) {
    el.append(blocksOf(ctx.schema, own, d));
    tabs(el, ctx.doc, ctx.width);
  } else if (which === 'continuationNotice') return null;
  else el.dataset.rule = which === 'separator' ? 'short' : 'long';
  return el;
}
