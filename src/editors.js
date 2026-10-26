// One editor kit per format (docs/plans/document.md One kit per format; SPEC §5 Formats): a format is its own editing system,
// so each has its own extension list, schema and Markdown manager. Renderer only. The open draft's editor, the assistant's
// background sessions, content parsing (commands.js toNodes) and the load guard all read the kit of the draft's format.
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { Marked } from 'marked';
import { Canvas } from './canvas.js';
import { documentExtensions } from './document/schema.js';
import { CopyPicture } from './export.js';
import { ColumnDrag, forumExtensions, InactiveSelection, TEXT_KEYS, textKeys, TIPTAP_CHORDS } from './extensions.js';
import { Find } from './find.js';
import { formatOf, pageOf } from './formats.mjs';
import { PlanChart } from './plan-chart.js';
import { Suggestions } from './suggest/extension.js';
import { migrateBoards, WhiteboardPaste } from './whiteboard.js';

// The Document's text shortcuts: the shared ids whose commands exist in its schema (no code, quote or code block; chain() on a
// missing command throws), then Word's own (keys.mjs group Document, docs/plans/document.md Keys) on the Document's commands
// (document/schema.js). Bullets and numbering run its own flat-list commands of the same names (document/lists.js).
const NOT_IN_DOCUMENT = new Set(['text.code', 'text.blockquote', 'text.codeBlock']);
const DOCUMENT_KEYS = {
  'text.paragraph': (c) => c.setStyle('Normal'), // the heading keys apply HeadingN the same way (schema.js HeadingStyles)
  'document.alignLeft': (c) => c.setTextAlign('left'),
  'document.alignCenter': (c) => c.setTextAlign('center'),
  'document.alignRight': (c) => c.setTextAlign('right'),
  'document.justify': (c) => c.setTextAlign('justify'),
  'document.growFont': (c) => c.growFont(),
  'document.shrinkFont': (c) => c.shrinkFont(),
  'document.growFont1': (c) => c.growFont1(),
  'document.shrinkFont1': (c) => c.shrinkFont1(),
  'document.spacing1': (c) => c.setLineSpacing(1),
  'document.spacing15': (c) => c.setLineSpacing(1.5),
  'document.spacing2': (c) => c.setLineSpacing(2),
  'document.indent': (c) => c.increaseIndent(),
  'document.outdent': (c) => c.decreaseIndent(),
  'document.hanging': (c) => c.setHanging(true),
  'document.removeHanging': (c) => c.setHanging(false),
  'document.clearParagraph': (c) => c.clearParagraph(),
  'document.normalStyle': (c) => c.setStyle('Normal'),
  'document.pageBreak': (c) => c.setPageBreak(),
};
// Ctrl+Enter is HardBreak's Mod-Enter too: moved off Page break, it does nothing rather than break the line.
const DocumentKeys = textKeys({ ...Object.fromEntries(Object.entries(TEXT_KEYS).filter(([id]) => !NOT_IN_DOCUMENT.has(id))), ...DOCUMENT_KEYS },
  new Set([...TIPTAP_CHORDS, 'Ctrl+Enter']));

/** The Document's editor: its own schema (document/schema.js) plus the shared app blocks and the keys. */
const documentKit = (depth) => [...documentExtensions(depth), ColumnDrag, WhiteboardPaste, Canvas, PlanChart, CopyPicture, Find, InactiveSelection, DocumentKeys,
  Suggestions];
/** The forum post's editor: its extensions plus agent edits as suggestions (docs/plans/suggestions.md), which every kit carries. */
const forumKit = (depth) => [...forumExtensions(depth), Suggestions];

// Format id → the function that lists its editor extensions for an undo depth. The core page shares the forum post's.
const EXTENSIONS = { 'forum-post': forumKit, page: forumKit, document: documentKit };
const kits = new Map();

/** The kit of format `id`: {extensions(depth) (a fresh list per editor), schema, markdown (a MarkdownManager on JSON, so it
 * never needs a particular editor)}. Schema and manager are made once per id: only the history depth differs between editors. */
export function kitOf(id) {
  if (!kits.has(id)) {
    const extensions = EXTENSIONS[id];
    if (!extensions) throw new Error(`No editor for the format ${id}`);
    const base = extensions(50);
    // Its own marked instance: the manager registers each extension's tokenizers with marked.use(), and on the shared default
    // one every kit would parse with every other kit's tokenizers.
    kits.set(id, { extensions, schema: getSchema(base), markdown: new MarkdownManager({ marked: new Marked(), extensions: base }) });
  }
  return kits.get(id);
}

/** Whether `draft` can open here (the load guard, SPEC §5 Formats): its format and formatVersion are known (formats.mjs formatOf)
 * and its doc parses in that format's schema. ProseMirror drops unknown attributes and TipTap blanks a doc with an unknown node,
 * and autosave would then write the loss. Only nodeFromJSON, never node.check(): TipTap loads content-expression violations. */
export function loadable(draft, settings) {
  const f = formatOf(draft, settings);
  if (!f) return false;
  if (!draft?.doc) return true;
  try {
    kitOf(f.id).schema.nodeFromJSON(migrateBoards(draft.doc, pageOf(draft, settings).width));
    return true;
  } catch {
    return false;
  }
}
