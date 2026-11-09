// Pool commands no format module owns (docs/plans/cleanup/tool-pool-surfaces.md F2, B1): the forum post's and core page's toolset
// on a text surface, and Undo and Redo there and on the flowchart view. Each acts on the surface's editor through ctx.chain (Undo
// and Redo on the active board when there is one), reports its state (active, value, enabled) to the controls that draw it (the
// forum toolbar, the rail's text mode, the quick tools, the draft menu) and carries tool search meta, so app/tools.js generates its
// entry. A value command takes the value as `arg` and lists its choices from the surface's profile (`choices(ctx)`); the per-value
// commands (block style, alignment, presets) keep their hand entries in app/tools.js and have no meta. Node tests load this file,
// so the app's actions and dialogs load when a command runs.
import {
  Bold, BookMarked, Code, Frame, Grid2x2X, Highlighter, ImagePlus, Italic, Link, List, ListOrdered, Minus, PanelTop, Quote, Redo2,
  RemoveFormatting, SquareCode, SquareKanban, Strikethrough, Subscript, Superscript, Table, TableColumnsSplit, TableRowsSplit,
  TextQuote, Underline, Undo2, Workflow, BetweenHorizontalEnd, BetweenVerticalEnd, Baseline, CaseSensitive, ALargeSmall,
} from 'lucide-react';
import { KINDS } from '../flow/shapes.mjs';
import { FONTS, FONT_SIZES, HIGHLIGHTS, TEXT_COLORS } from '../format.mjs';
import { formatOf } from '../formats.mjs';
import { grantOptions } from '../tooling/profile.mjs';
import { register } from '../tooling/registry.js';
import { insertFiles, isPost } from '../document/canvas/post.js';
import { addImageFilesToEditor, readImage } from '../whiteboard.js';
import { PICTURE_ACCEPT } from '../tooling/metafile.mjs';
import { getState } from './store.js';

/** Swatch colours: the forum's (SPEC §1), root, soft and hard in the page theme's (page.css). */
export const HUE = {
  root: 'var(--text)', soft: 'var(--c-soft)', hard: 'var(--c-hard)', red: '#e05252', orange: '#e09952', yellow: '#e0c952',
  green: '#62d926', blue: '#3d99f5', indigo: '#9c6ef7', violet: '#e052e0',
};

const actions = () => import('./actions.js');

// Gates: an insert needs the text and no board being edited (it goes after a node-selected block); formatting also a caret or text
// selection, not a node-selected block; the table tools the caret in a table.
const text = (ctx) => !!ctx.target && !ctx.board;
// An insert works with a caret in the DOM editor, or on a canvas draft through its focused session.
const inserting = (ctx) => text(ctx) || !!ctx.engine;
// The plan chart and flowchart insert through their dialogs and flows, which write to a forum post's page area through its
// session; a Document's canvas draft takes them from the DOM editor's own insert commands.
const posting = (ctx) => text(ctx) || (!!ctx.engine && isPost(getState().draft, getState().settings));
const format = (ctx) => text(ctx) && !ctx.state?.selection.node;
// A command whose dialog writes through the canvas engine on a post in the page area (C3b): its caret is the engine's, not the
// DOM editor's, so it needs only a surface that has one.
const engineOrText = (ctx) => !!(ctx.target || ctx.engine) && !ctx.board;
// Link: on the engine any caret; in the DOM editor a caret or text, never a selected block (an image, a box), as before.
const linkable = (ctx) => (ctx.engine ? engineOrText(ctx) : format(ctx));
const inTable = (ctx) => text(ctx) && ctx.target.isActive('table');
const is = (ctx, ...args) => !!ctx.target?.isActive(...args);
const chain = (fn) => (ctx) => ctx.chain(fn);
// Moves a node selection (a clicked canvas) to just after the node first, so the insert does not replace it.
const after = (fn) => (ctx) => actions().then((a) => ctx.chain((c) => fn(a.afterNodeSel(c))));
const COLOURS = [...Object.values(TEXT_COLORS).map((l) => l.toLowerCase()), 'purple', 'pink', 'grey', 'gray', 'white'];

/** A toggle: a mark or a block type `name` toggled by chain command `cmd`. */
const toggle = (name, cmd, label, icon, key, keywords, group = 'Text') => ({
  run: chain((c) => c[cmd]()), enabled: format, active: (ctx) => is(ctx, name), meta: { label, group, icon, key, keywords, toggle: true },
});
/** A button running `run` while `enabled`. */
const button = (run, enabled, label, icon, keywords, group = 'Insert', key) => ({ run, enabled, meta: { label, group, icon, key, keywords } });

// Undo and Redo: the active board's when there is one (a canvas edited in place, the open flowchart), else the editor's.
const history = (dir, label, icon, keywords) => ({
  run: (ctx) => (ctx.board ? ctx.board[dir]() : ctx.chain((c) => c[dir]())),
  enabled: (ctx) => (ctx.board ? !!ctx.board.getSnapshot?.()[dir === 'undo' ? 'canUndo' : 'canRedo'] : !!ctx.target?.can()[dir]()),
  reason: () => `There is nothing to ${dir}`,
  meta: { label, group: 'Edit', icon, keywords, key: `edit.${dir}` },
});

// Lazily made file input of Insert image (click() opens the picker): each picked image goes in as a canvas, a video or GIF as a
// media node. On a canvas draft the focused session takes them (insertEngineFiles).
let picker = null;
function pickImages(ctx) {
  picker ??= Object.assign(document.createElement('input'), { type: 'file', accept: `${PICTURE_ACCEPT},video/*`, multiple: true });
  picker.onchange = () => {
    const files = [...picker.files];
    picker.value = '';
    if (!files.length) return;
    if (ctx.engine) return insertEngineFiles(ctx.engine, files);
    const editor = getState().editor;
    if (editor) addImageFilesToEditor(editor, files);
  };
  picker.click();
}

/** Picked files into canvas session `client`: a post's as its kit's nodes (post.js insertFiles: pictures as smart canvases, a
 * video or GIF as media), a Document's as inline pictures. → whether any went in. */
async function insertEngineFiles(client, files) {
  const s = getState();
  if (isPost(s.draft, s.settings)) return insertFiles(client, files);
  let inserted = false;
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const data = (await readImage(f))?.src?.split(';base64,')[1];
    if (data && (await client.exec('insert.picture', { data }))?.ok) inserted = true;
  }
  return inserted;
}

const fonts = (ctx) => grantOptions(ctx.profile, 'fonts', FONTS.map((f) => ({ id: f.label, label: f.label, font: f.css })));
const sizes = (ctx) => grantOptions(ctx.profile, 'fontSizes', FONT_SIZES);
const swatches = (ids) => ids.map((id) => ({ id, label: TEXT_COLORS[id] ?? id, swatch: HUE[id] }));
const textColors = (ctx) => swatches(grantOptions(ctx.profile, 'textColors', Object.keys(TEXT_COLORS)));
const highlights = (ctx) => swatches(grantOptions(ctx.profile, 'highlights', HIGHLIGHTS));
/** Block styles: [value, label]. */
export const BLOCKS = [['p', 'Paragraph'], ...[1, 2, 3, 4, 5, 6].map((l) => [`h${l}`, `Heading ${l}`])];
export const ALIGNS = ['left', 'center', 'right', 'justify'];
const boxes = () => !!formatOf(getState().draft, getState().settings)?.blocks.includes('box');

/** The forum toolset and Undo and Redo, by id (registered below for the text surface; the controls read their meta here). */
export const POOL = {
  'edit.undo': history('undo', 'Undo', Undo2, ['back', 'revert', 'go back', 'step back', 'reverse', 'oops', 'undo last']),
  'edit.redo': history('redo', 'Redo', Redo2, ['again', 'repeat', 'forward', 'reapply', 'redo last']),

  'text.bold': toggle('bold', 'toggleBold', 'Bold', Bold, 'text.bold', ['strong', 'thick', 'heavy', 'fat', 'emphasis', 'emphasise', 'emphasize', 'b', 'bolt', 'blod']),
  'text.italic': toggle('italic', 'toggleItalic', 'Italic', Italic, 'text.italic', ['italics', 'slanted', 'slant', 'oblique', 'emphasis', 'cursive', 'i', 'itallic', 'italik']),
  'text.underline': toggle('underline', 'toggleUnderline', 'Underline', Underline, 'text.underline', ['underlined', 'underscore', 'line under', 'u', 'undeline', 'underlne']),
  'text.strike': toggle('strike', 'toggleStrike', 'Strikethrough', Strikethrough, 'text.strike',
    ['strike', 'strikeout', 'strike out', 'cross out', 'crossed out', 'line through', 'scratch', 'stroke']),
  'text.subscript': toggle('subscript', 'toggleSubscript', 'Subscript', Subscript, 'text.subscript', ['sub', 'lower', 'below', 'subscipt', 'chemical', 'index']),
  'text.superscript': toggle('superscript', 'toggleSuperscript', 'Superscript', Superscript, 'text.superscript',
    ['sup', 'power', 'exponent', 'raised', 'above', 'squared', 'ordinal', 'superscipt']),
  'text.code': toggle('code', 'toggleCode', 'Inline code', Code, 'text.code', ['code', 'monospace', 'mono', 'typewriter', 'backtick', 'snippet', 'programming', 'variable']),
  // arg: a font's id (its label), or '' / null for the default font.
  'text.font': {
    run: (ctx, id) => {
      if (!id) return ctx.chain((c) => c.unsetFontFamily());
      const f = fonts(ctx).find((o) => o.id === id);
      return !!f && ctx.chain((c) => c.setFontFamily(f.font));
    },
    enabled: format,
    value: (ctx) => FONTS.find((f) => f.css === ctx.target?.getAttributes('fontFamily').font)?.label ?? '',
    choices: fonts,
    meta: { label: 'Font', group: 'Text', icon: CaseSensitive,
      keywords: ['typeface', 'font family', 'family', 'fonts', 'face', 'type', 'serif', 'sans', 'monospace', ...FONTS.map((f) => f.label)] },
  },
  // arg: a size in percent (a number or its text, '150' or '150%').
  'text.size': {
    run: (ctx, v) => {
      const n = Number(String(v ?? '').replace('%', '').trim());
      return sizes(ctx).includes(n) && ctx.chain((c) => c.setFontSize(n));
    },
    enabled: format,
    value: (ctx) => Number(ctx.target?.getAttributes('fontSize').size || 100),
    choices: sizes,
    meta: { label: 'Font size', group: 'Text', icon: ALargeSmall, keywords: ['size', 'text size', 'bigger', 'larger', 'smaller', 'scale', 'percent', 'big', 'small', 'fontsize'] },
  },
  // arg: a colour's id ('red'); 'root' or null is the default colour.
  'text.color': {
    run: (ctx, id) => (id == null || id === 'root' ? ctx.chain((c) => c.unsetTextColor())
      : textColors(ctx).some((o) => o.id === id) && ctx.chain((c) => c.setTextColor(id))),
    enabled: format,
    value: (ctx) => ctx.target?.getAttributes('textColor').color || 'root',
    choices: textColors,
    meta: { label: 'Text colour', group: 'Text', icon: Baseline,
      keywords: ['colour', 'color', 'text color', 'font colour', 'font color', 'foreground', 'ink', 'tint', 'hue', 'paint', 'colur', 'colr', ...COLOURS] },
  },
  // arg: a highlight's id ('yellow'), or null for none.
  'text.highlight': {
    run: (ctx, id) => (!id ? ctx.chain((c) => c.unsetHighlight()) : highlights(ctx).some((o) => o.id === id) && ctx.chain((c) => c.setHighlight(id))),
    enabled: format,
    value: (ctx) => (is(ctx, 'highlight') ? ctx.target.getAttributes('highlight').color : null),
    choices: highlights,
    meta: { label: 'Highlight', group: 'Text', icon: Highlighter,
      keywords: ['highlighter', 'marker', 'background colour', 'background color', 'text background', 'mark', 'shade', 'fill', 'hilight', 'hilite',
        'highlite', 'higlight', 'highligh', ...COLOURS] },
  },
  'text.clear': button(chain((c) => c.unsetAllMarks().clearNodes()), format, 'Clear formatting', RemoveFormatting,
    ['remove formatting', 'clear format', 'plain text', 'unformat', 'reset format', 'strip', 'clean', 'normal'], 'Edit'),
  // arg: the preset's index in settings.presets.
  'text.preset': { run: (_ctx, i) => actions().then((a) => a.applyPresetAt(i)), enabled: format },

  // arg: a block style ('p', 'h1' to 'h6').
  'para.block': {
    run: (ctx, v) => (v === 'p' ? ctx.chain((c) => c.setParagraph()) : /^h[1-6]$/.test(v ?? '') && ctx.chain((c) => c.setHeading({ level: Number(v.slice(1)) }))),
    enabled: format,
    value: (ctx) => (is(ctx, 'paragraph') ? 'p' : BLOCKS.find(([v]) => v !== 'p' && is(ctx, 'heading', { level: Number(v.slice(1)) }))?.[0] ?? ''),
    choices: () => BLOCKS,
  },
  // arg: 'left', 'center', 'right' or 'justify'.
  'para.align': {
    run: (ctx, v) => ALIGNS.includes(v) && ctx.chain((c) => c.setTextAlign(v)),
    enabled: format,
    value: (ctx) => ALIGNS.find((a) => a !== 'left' && is(ctx, { textAlign: a })) ?? 'left',
    choices: () => ALIGNS,
  },
  'para.bulletList': toggle('bulletList', 'toggleBulletList', 'Bullet list', List, 'text.bulletList',
    ['unordered', 'unordered list', 'dots', 'points', 'bullets', 'bulleted', 'bullet points', 'ul', 'list', 'buller']),
  'para.orderedList': toggle('orderedList', 'toggleOrderedList', 'Numbered list', ListOrdered, 'text.orderedList',
    ['ordered', 'ordered list', 'numbers', 'numbered', 'numbering', 'ol', 'list', 'steps', 'enumerate', '1 2 3']),
  'para.quote': toggle('blockquote', 'toggleBlockquote', 'Quote', Quote, 'text.blockquote', ['blockquote', 'block quote', 'quotation', 'citation', 'cite', 'indent', 'qoute']),
  'para.codeBlock': toggle('codeBlock', 'toggleCodeBlock', 'Code block', SquareCode, 'text.codeBlock', ['pre', 'preformatted', 'source code', 'code', 'snippet', 'monospace', 'program']),

  'insert.rule': button(chain((c) => c.setHorizontalRule()), text, 'Horizontal rule', Minus,
    ['divider', 'separator', 'line', 'hr', 'rule', 'horizontal line', 'break', 'section break']),
  'insert.table': button(after((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })), text, 'Insert table', Table,
    ['table', 'grid', 'rows', 'columns', 'cells', 'spreadsheet', '3x3', 'tabel', 'tbale']),
  'insert.box': {
    ...button(after((c) => c.insertBox()), (ctx) => text(ctx) && boxes(), 'Insert titled box', PanelTop,
      ['box', 'titled box', 'panel', 'callout', 'container', 'card', 'section', 'spoiler']),
    active: (ctx) => is(ctx, 'box'),
  },
  'insert.link': {
    ...button(() => actions().then((a) => a.openLinkDialog()), linkable, 'Link', Link, ['url', 'hyperlink', 'href', 'web', 'website', 'address', 'anchor', 'lnk', 'linc'],
      'Text', 'text.link'),
    active: (ctx) => is(ctx, 'link'),
  },
  'insert.canvas': button((ctx) => (ctx.engine
    ? import('./flows.js').then((m) => m.insertCanvasBox())
    : actions().then((a) => a.insertCanvas())), inserting, 'Insert canvas', Frame,
    ['canvas', 'frame', 'artboard', 'smart canvas', 'graphic', 'design', 'layout', 'canvass', 'whiteboard', 'board', 'drawing', 'draw', 'sketch', 'diagram',
      'doodle', 'paint', 'wb', 'white board'], 'Insert', 'insert.canvas'),
  'insert.flowchart': button(() => import('./flows.js').then((m) => m.insertFlowchartDialog()), posting, 'Insert flowchart', Workflow,
    ['diagram', 'flow', 'flow chart', 'process', 'chart', 'graph', 'nodes', 'boxes and arrows', 'swimlane', 'uml'], 'Insert', 'insert.flowchart'),
  'insert.planChart': button(() => import('./plans.js').then((m) => m.insertPlanChartDialog()), posting, 'Insert plan chart', SquareKanban,
    ['plan chart', 'kanban', 'board', 'backlog', 'tickets', 'chart', 'plan', 'sprint', 'todo', 'task', 'progress', 'status', 'embed plan']),
  'insert.image': button(pickImages, inserting, 'Insert image', ImagePlus, ['image', 'picture', 'photo', 'img', 'pic', 'upload', 'file', 'png', 'jpg', 'screenshot', 'imgae']),

  'table.addRowAfter': button(chain((c) => c.addRowAfter()), inTable, 'Add row after', BetweenHorizontalEnd, ['row', 'new row', 'insert row', 'table row']),
  'table.addColumnAfter': button(chain((c) => c.addColumnAfter()), inTable, 'Add column after', BetweenVerticalEnd,
    ['column', 'new column', 'insert column', 'table column', 'col']),
  'table.deleteRow': button(chain((c) => c.deleteRow()), inTable, 'Delete row', TableRowsSplit, ['remove row', 'row']),
  'table.deleteColumn': button(chain((c) => c.deleteColumn()), inTable, 'Delete column', TableColumnsSplit, ['remove column', 'column', 'col']),
  'table.deleteTable': button(chain((c) => c.deleteTable()), inTable, 'Delete table', Grid2x2X, ['remove table', 'table']),

  // The draft's sources (docs/wiki/references.md): the citation picker at the cursor, and the References dialog.
  'references.insertCitation': button(() => import('./references.js').then((m) => m.openCitePicker()), engineOrText, 'Insert reference', TextQuote,
    ['reference', 'citation', 'cite', 'in-text citation', 'source', 'harvard', 'quote a source', 'referance', 'refrence', 'citeation']),
  'references.manageSources': button(() => import('./references.js').then((m) => m.openReferences()), engineOrText, 'References', BookMarked,
    ['references', 'sources', 'bibliography', 'works cited', 'citations', 'add source', 'add reference', 'edit source', 'manage sources', 'harvard', 'doi',
      'arxiv', 'paste link']),
};

// What tool.run applies to an agent (commands/tool.mjs): a picker or dialog needs the user at the window; deleting a table asks.
for (const id of ['insert.link', 'insert.image', 'insert.flowchart', 'insert.planChart', 'references.insertCitation', 'references.manageSources']) POOL[id].meta.headless = false;
POOL['table.deleteTable'].meta.risk = 'destructive';

/** The toolbar keys of the forum toolset's pool commands (above), which the draft menu, tool search and the rail also read. */
export const POOL_IDS = {
  undo: 'edit.undo', redo: 'edit.redo', bold: 'text.bold', italic: 'text.italic', underline: 'text.underline', strike: 'text.strike',
  sub: 'text.subscript', sup: 'text.superscript', code: 'text.code', bulletList: 'para.bulletList', orderedList: 'para.orderedList',
  quote: 'para.quote', codeBlock: 'para.codeBlock', rule: 'insert.rule', table: 'insert.table', addRow: 'table.addRowAfter',
  addColumn: 'table.addColumnAfter', deleteRow: 'table.deleteRow', deleteColumn: 'table.deleteColumn', deleteTable: 'table.deleteTable',
  box: 'insert.box', link: 'insert.link', canvas: 'insert.canvas', flowchart: 'insert.flowchart', planChart: 'insert.planChart',
  image: 'insert.image', cite: 'references.insertCitation', references: 'references.manageSources', clear: 'text.clear',
};

/** Old ids of the hand tool search entries pool commands replaced (docs/plans/cleanup/tool-pool-surfaces.md B1 to B4), which agents
 * and scripts know: tool.run takes one where its old entry does not apply, and tool.list shows it beside the pool id as `alias`.
 * An old entry that still exists (a Document's, a workspace board's) gives way wherever its pool command serves (app/tools.js). */
export const TOOL_ALIASES = {
  ...POOL_IDS, 'insert-reference': 'references.insertCitation', 'plan-insert-chart': 'insert.planChart',
  font: 'text.font', size: 'text.size', color: 'text.color', highlight: 'text.highlight',
  select: 'board.select', pen: 'board.pen', eraser: 'board.eraser', shape: 'board.shape', connector: 'board.connector', 'add-text': 'board.text',
  'add-image': 'board.image', 'keep-tool': 'board.keepTool', snapping: 'board.snap', background: 'board.background', layers: 'board.layers',
  ...Object.fromEntries(KINDS.map(({ kind }) => [`shape-${kind}`, `board.shape.${kind}`])),
  'unlock-all': 'board.items.unlockAll', 'show-all': 'board.items.showAll', duplicate: 'board.items.duplicate', delete: 'board.items.remove',
  front: 'board.items.arrange.front', back: 'board.items.arrange.back', rotate: 'board.items.rotate', lock: 'board.items.lock', hide: 'board.items.hide',
  group: 'board.items.group', ungroup: 'board.items.ungroup', 'create-prefab': 'board.items.prefab', 'reverse-connector': 'board.items.reverse',
  straighten: 'board.items.straighten', 'reset-size': 'board.items.resetSize', 'reset-crop': 'board.items.resetCrop',
  ...Object.fromEntries(['left', 'centre', 'right', 'top', 'middle', 'bottom'].map((a) => [`align-${a}`, `board.items.align.${a}`])),
  'distribute-h': 'board.items.distribute.h', 'distribute-v': 'board.items.distribute.v', 'same-width': 'board.items.sameSize.w', 'same-height': 'board.items.sameSize.h',
  'flow-new': 'flow.library.create', 'import-diagram': 'flow.library.import',
  'plan-open': 'plan.open', 'plan-board': 'plan.board', 'plan-backlog': 'plan.backlog', 'plan-gantt': 'plan.gantt', 'plan-new-ticket': 'plan.newTicket',
  'plan-undo': 'plan.undo', 'plan-redo': 'plan.redo', 'plan-close': 'plan.close',
  'chart-open': 'plan.chart.open', 'chart-kanban': 'plan.chart.kanban', 'chart-backlog': 'plan.chart.backlog', 'chart-gantt': 'plan.chart.gantt',
  'chart-freeze': 'plan.chart.freeze', 'chart-refresh': 'plan.chart.refresh', 'chart-live': 'plan.chart.live', 'chart-full-width': 'plan.chart.fullWidth',
  'chart-delete': 'plan.chart.delete',
};

const { 'edit.undo': undo, 'edit.redo': redo, ...TEXT } = POOL;
register('app', { 'edit.undo': undo, 'edit.redo': redo }, ['text', 'flow']);
register('app', TEXT, ['text']);
