// One editor kit per format (docs/plans/document.md One kit per format; SPEC §5 Formats): a format is its own editing system,
// so each has its own extension list, schema and Markdown manager. Renderer only. The open draft's editor, the assistant's
// background sessions, content parsing (commands.js toNodes) and the load guard all read the kit of the draft's format.
import { Extension, getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { Marked } from 'marked';
import { Canvas } from './canvas.js';
import { storiesOf, storyDoc } from './document/model/blocks.mjs';
import { documentExtensions } from './document/schema.js';
import { WordKeys } from './document/word/keys.js';
import { CopyPicture } from './export.js';
import { ColumnDrag, forumExtensions, InactiveSelection, textKeys, TIPTAP_CHORDS } from './extensions.js';
import { osChord } from './app/keys.mjs';
import { getState } from './app/store.js';
import { Find } from './find.js';
import { formatOf, pageOf } from './formats.mjs';
import { PlanChart } from './plan-chart.js';
import { Suggestions } from './suggest/extension.js';
import { migrateBoards, WhiteboardPaste } from './whiteboard.js';

// The Document's text shortcuts on its own commands (document/schema.js): the shared keybind ids it has (no code, quote, code block,
// strike, subscript, lists or Heading 5 here), then Word's own (keys.mjs group Document, docs/plans/document.md Keys). The text
// chords Word moves (docs/plans/word/plan.md §1.13 rule 4) do nothing in a Document either: WordKeys runs Word's command on them
// first, and textKeys swallows their TipTap chords, so a declined Word chord never reaches TipTap's command.
const DOCUMENT_KEYS = {
  'edit.undo': (c) => c.undo(),
  'edit.redo': (c) => c.redo(),
  'text.bold': (c) => c.toggleBold(),
  'text.italic': (c) => c.toggleItalic(),
  'text.underline': (c) => c.toggleUnderline(),
  'text.superscript': (c) => c.toggleSuperscript(),
  ...Object.fromEntries([1, 2, 3, 4, 6].map((level) => [`text.heading${level}`, (c) => c.toggleHeading({ level })])),
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
const DocumentKeys = textKeys(DOCUMENT_KEYS, new Set([...TIPTAP_CHORDS, osChord('Ctrl+Enter')]));

// Markdown's input rules (**bold**, # Heading, ~~strike~~) run only while Word's AutoFormat As You Type option for them is on
// (settings.word.autoformat.markdown, plan.md §1.12), read when an editor is built; the list rules are AutoFormat's own and stay.
const MARKDOWN_RULES = new Set(['bold', 'italic', 'strike', 'heading', 'code', 'codeBlock', 'blockquote', 'horizontalRule']);
const MarkdownRules = Extension.create({
  name: 'markdownRules',
  onBeforeCreate() {
    if (getState().settings?.word?.autoformat?.markdown !== false) return;
    // Before the view exists, so TipTap builds its input rule plugins from this list.
    this.editor.options.enableInputRules = this.editor.extensionManager.extensions.map((e) => e.name).filter((n) => !MARKDOWN_RULES.has(n));
  },
});

// The work packages' extensions in hub order (document/wp/index.js EXTENSIONS). The hub reaches React components, which Node tests
// cannot load, so the renderer hands them in (actions.js) instead of this file importing the hub. They never add schema, so the
// cached schema and Markdown manager stay right; each editor reads the list when it is built.
let moduleExtensions = () => [];
/** Sets the function that lists the work packages' editor extensions, which every Document editor built from then on carries.
 * A function, so the hub's list is read only when an editor is built, after every module has loaded. */
export const setModuleExtensions = (list) => {
  moduleExtensions = list;
};

// A Document's canvases hold Word's shapes: one with no autoFit keeps its size (Do not Autofit), and a canvas that is one shape
// draws past its frame, as the Word shape it exports as does (canvas.js Canvas options).
const WORD_CANVAS = { fitText: false, overflow: true };
/** The Document's editor: its own schema (document/schema.js) plus the shared app blocks and the keys, then every work package's
 * extensions, then Word's keys. */
const documentKit = (depth) => [...documentExtensions(depth, [Canvas.name, PlanChart.name]), ColumnDrag, WhiteboardPaste, Canvas.configure(WORD_CANVAS), PlanChart, CopyPicture, Find, InactiveSelection, DocumentKeys,
  Suggestions, MarkdownRules, ...moduleExtensions(), WordKeys];
/** The forum post's editor: its extensions plus agent edits as suggestions (docs/wiki/suggestions.md), which every kit carries. */
const forumKit = (depth) => [...forumExtensions(depth), Suggestions];

// Format id → the function that lists its editor extensions for an undo depth. The core page shares the forum post's. A
// whiteboard's hidden DOM editor stays empty (its items live in draft.board), so its kit never holds a text item's tools.
const EXTENSIONS = { 'forum-post': forumKit, page: forumKit, document: documentKit, board: forumKit };
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
 * and autosave would then write the loss. Only nodeFromJSON, never node.check(): TipTap loads content-expression violations.
 * A Document's stories in attributes (notes, headers, footers, comments) are checked the same way, so a malformed one is refused
 * here instead of throwing when its story editor opens (plan.md §1.8). */
export function loadable(draft, settings) {
  const f = formatOf(draft, settings);
  if (!f) return false;
  // A canvas record's `doc`, if it still holds one, is stale: the engine form is what opens (engine-model).
  if (!draft?.doc || draft.engine != null) return true;
  try {
    const { schema } = kitOf(f.id);
    const doc = schema.nodeFromJSON(migrateBoards(draft.doc, pageOf(draft, settings).width));
    for (const story of storiesOf(doc)) storyDoc(schema, story.content);
    return true;
  } catch {
    return false;
  }
}
