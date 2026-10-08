import { BOARD_TYPES, find, nodeAt, outline, pathOfPos, posOfPath } from '../../doc-path.mjs';
import { FONT_SIZES, FONTS, HIGHLIGHTS, presetChain, TEXT_COLORS } from '../../format.mjs';
import { blockKind } from '../tool-rank.mjs';
import { define, fail } from './define.mjs';
import { CONTENT, DRAFT_ID, ref } from './schema-defs.mjs';

// doc.* (SPEC §8 Catalogue, Content): the open draft. Writes are builders: plan() returns one transaction built from the
// editor's current state and the executor dispatches it (one undo step, no focus, no scroll, the selection mapped).
// Paths: doc-path.mjs. Content conversion and Markdown live in ctx.lib (they need the editor's schema and a DOM).

const isBoard = (node) => BOARD_TYPES.includes(node.type.name);

/** A board block (TipTap JSON) as doc.get shows it unless `images` (SPEC §7i Compact draft reads): its kind (tool-rank.mjs
 * blockKind), size, item count and source in place of its items and pictures (board.get reads those). */
function boardStub(ctx, n) {
  const a = n.attrs ?? {};
  const items = a.items ?? [];
  const kind = blockKind(n.type, a) ?? n.type;
  if (n.type === 'planChart') {
    const title = a.frozen?.ctx?.plan?.title ?? ctx.plans?.planById?.(a.planId)?.title ?? null;
    return { type: n.type, kind, plan: title, view: a.view, ...(a.frozen && { frozen: true }) };
  }
  const out = { type: n.type, kind, size: n.type === 'whiteboard' ? `${Math.round(a.height)} px high` : `${Math.round(a.w)} x ${Math.round(a.h)}`, items: items.length };
  const src = kind === 'image' ? String(items[0].src ?? '') : '';
  const data = src.match(/^data:image\/([a-z0-9.+-]+);/i);
  if (kind === 'image') out.source = data ? `pasted ${data[1].toUpperCase()}, ${Math.max(1, Math.round((src.length * 3) / 4 / 1024))} KB` : src.slice(0, 200) || 'none';
  if (a.flow?.id) out.source = `library flowchart "${ctx.flows?.getFlow?.(a.flow.id)?.title ?? a.flow.id}"`;
  return out;
}
const stubText = (p) => [p.kind, p.size, p.items !== undefined && `${p.items} items`, p.plan && `plan "${p.plan}"`, p.source].filter(Boolean).join(', ');
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function nodeAtPath(doc, path) {
  const pos = posOfPath(doc, path);
  if (pos === null) fail('not_found', `No block at [${path}]`, { path });
  return { pos, node: doc.nodeAt(pos) };
}

/** The paths of `nodes` inserted at `pos` by `tr`. */
function insertedPaths(tr, pos, nodes) {
  const paths = [];
  let at = tr.mapping.map(pos, -1);
  for (const node of nodes) {
    paths.push(pathOfPos(tr.doc, at));
    at += node.nodeSize;
  }
  return paths;
}

/** Where `at: 'cursor'` inserts: after the block holding the selection (a node selection: after that node), never
 * moving the selection. */
function afterCursor(state) {
  const sel = state.selection;
  if (sel.node) return sel.to;
  const { $from } = sel;
  return $from.depth ? $from.after($from.depth) : $from.pos;
}

// Boards always go at the top level (whiteboard.js topLevelPos): after the top-level block holding `pos`.
const topLevel = (doc, pos) => {
  const $p = doc.resolve(pos);
  return $p.depth ? $p.after(1) : pos;
};

const blockLabel = (doc, path) => {
  const pos = posOfPath(doc, path);
  if (pos === null) return `[${path}]`;
  const node = doc.nodeAt(pos);
  const text = node.textContent.trim().slice(0, 60);
  return `[${path}] ${node.type.name}${text ? ` "${text}${node.textContent.trim().length > 60 ? '...' : ''}"` : ''}`;
};

// doc.format: boolean marks → TipTap's set<Name> / unset<Name>.
const MARKS = { bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strike', sub: 'Subscript', sup: 'Superscript', code: 'Code' };
const orNull = (s) => ({ anyOf: [s, { type: 'null' }] });

// doc.command: the editor commands an agent may run (agent-automation plan §7); setContent, insertContent, deleteSelection,
// deleteTable, focus … are not among them (deleting a block is doc.delete, which asks).
const TABLE_COMMANDS = ['addRowBefore', 'addRowAfter', 'addColumnBefore', 'addColumnAfter', 'deleteRow', 'deleteColumn'];
const SELECT_COMMANDS = ['setTextSelection', 'setNodeSelection'];
const COMMANDS = [
  ...Object.values(MARKS).flatMap((m) => [`toggle${m}`, `set${m}`, `unset${m}`]), 'setLink', 'unsetLink',
  ...['FontSize', 'TextColor', 'Highlight', 'FontFamily'].flatMap((m) => [`set${m}`, `unset${m}`]),
  'setTextAlign', 'setParagraph', 'setHeading', 'toggleBulletList', 'toggleOrderedList', 'toggleBlockquote', 'toggleCodeBlock',
  'setHorizontalRule', 'insertTable', ...TABLE_COMMANDS, 'insertBox', 'unsetAllMarks', 'clearNodes', ...SELECT_COMMANDS,
];

/** A link target as the Link dialog keeps it: without a scheme, https:// is added. */
const href = (v) => (/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);

const cannot = (what) => fail('refused', `${what} does not apply here`, { code: 'cannot_apply' });

export const defs = [
  define({
    id: 'doc.get',
    title: 'Read the open draft as JSON, Markdown, text, HTML or an outline',
    brief: 'Use it before you answer about the draft or change it. The outline gives the block paths. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    notFor: 'boards. Use board_get',
    guide: {
      args: 'format outline first for the paths, then path for one block',
      errors: 'A sparse answer lists the paths left out in next. not_found means no block at that path',
    },
    group: 'doc',
    risk: 'read',
    undo: 'none',
    needs: ['doc.open'],
    args: {
      type: 'object', additionalProperties: false,
      properties: {
        format: { enum: ['json', 'markdown', 'text', 'html', 'outline'], default: 'json', description: 'outline lists the blocks with their paths' },
        path: ref('PATH', 'Read one block by its path, such as [2]'),
        images: { type: 'boolean', default: false, description: 'Keep picture data' },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['rev', 'draftId', 'content'] },
    examples: [{ args: { format: 'outline' } }, { args: { format: 'markdown' } }, { args: { format: 'json', path: [0] } }],
    run: (ctx, a) => {
      const ed = ctx.editor;
      const json = ed.getJSON();
      let node = json;
      if (a.path) {
        node = nodeAt(json, a.path);
        if (!node) fail('not_found', `No block at [${a.path}]`, { path: a.path });
      }
      let content;
      // Boards sit at the top level only: the doc's children, or the block at a path.
      const boards = (a.path ? [node] : node.content ?? []).filter((n) => BOARD_TYPES.includes(n.type));
      const stub = (n) => (BOARD_TYPES.includes(n.type) ? boardStub(ctx, n) : n);
      if (a.format === 'json') content = a.images ? node : ctx.lib.stripImages(a.path ? stub(node) : { ...node, content: (node.content ?? []).map(stub) });
      else if (a.format === 'outline') content = outline({ content: node.content ?? [] }).map((e) => ({ ...e, path: [...(a.path ?? []), ...e.path] }));
      else if (a.format === 'markdown') content = ctx.lib.toMarkdown(node, a.path);
      else if (a.format === 'html') {
        // A board's data-json attribute (its items and pictures) in document order → a one-line summary.
        let i = 0;
        content = ctx.lib.toHtml(a.path, a.images);
        if (!a.images) content = content.replace(/ data-json="[^"]*"/g, () => ` data-summary="${attr(stubText(boardStub(ctx, boards[i++] ?? {})))}"`);
      }
      else {
        const n = a.path ? nodeAtPath(ed.state.doc, a.path).node : ed.state.doc;
        content = n.textBetween(0, n.content.size, '\n\n', '\n');
      }
      return { rev: ctx.state.rev, draftId: ctx.state.draft?.id ?? null, content };
    },
  }),
  define({
    id: 'doc.find',
    title: 'Find text in the open draft: the block paths and block-local offsets of the matches',
    brief: 'Use it to find the block that holds some words. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    guide: { args: 'text is words from the draft, not a question', errors: 'With no matches, try fewer words' },
    group: 'doc',
    risk: 'read',
    undo: 'none',
    needs: ['doc.open'],
    args: {
      type: 'object', required: ['text'], additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 1000, description: 'The words to find' },
        regex: { type: 'boolean', default: false, description: 'Read text as a regular expression' },
        caseSensitive: { type: 'boolean', default: false, description: 'Match upper and lower case exactly' },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'array' },
    examples: [{ args: { text: 'Week 3' } }, { args: { text: 'week \\d+', regex: true } }],
    run: (ctx, a) => {
      try {
        return find(ctx.editor.getJSON(), a);
      } catch (e) {
        return fail('invalid_args', String(e.message), { path: '/text', message: String(e.message), expected: { type: 'string' } });
      }
    },
  }),
  define({
    id: 'doc.selection',
    title: 'Read the selection of the open draft: its block path, block-local offsets and text',
    brief: 'Use it when the user means the selected text or block. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'doc',
    risk: 'read',
    undo: 'none',
    needs: ['doc.open'],
    args: { type: 'object', additionalProperties: false, properties: { draftId: DRAFT_ID } },
    result: { type: 'object', required: ['kind'] },
    examples: [{ args: {} }],
    run: (ctx) => ctx.lib.selection(),
  }),
  define({
    id: 'doc.insert',
    title: 'Insert blocks into the open draft',
    brief: 'Use it to add new text or blocks. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    guide: {
      before: 'Read the paths with doc_get format outline',
      args: 'at is a path such as [3], not "[3]". content is {"markdown":"..."}',
      errors: 'stale means the draft changed. Read the outline again',
    },
    group: 'doc',
    risk: 'write',
    undo: 'doc',
    needs: ['doc.open'],
    args: {
      type: 'object', required: ['at', 'content'], additionalProperties: false,
      properties: {
        at: { oneOf: [ref('PATH'), { enum: ['start', 'end', 'cursor'] }], description: 'A block path such as [3], or one of start, end, cursor' },
        position: { enum: ['before', 'after'], default: 'after', description: 'Before or after the block at at' },
        content: { ...CONTENT, description: 'The new blocks, as markdown, html or json' },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['paths'] },
    examples: [
      { args: { at: 'end', content: { markdown: '## Week 3\n\nWhat I built this week.' } } },
      { args: { at: [2], position: 'before', content: { json: { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] } } } },
      { args: { at: 'cursor', content: { html: '<p><strong>Note:</strong> check this.</p>' } }, dryRun: true },
    ],
    plan: async (ctx, a) => {
      const { nodes, dropped } = await ctx.lib.toNodes(a.content);
      const { state } = ctx.editor; // after the await: the newest state
      const { doc } = state;
      let pos;
      if (a.at === 'start') pos = 0;
      else if (a.at === 'end') pos = doc.content.size;
      else if (a.at === 'cursor') pos = afterCursor(state);
      else {
        const t = nodeAtPath(doc, a.at);
        pos = a.position === 'before' ? t.pos : t.pos + t.node.nodeSize;
      }
      if (nodes.some(isBoard)) pos = topLevel(doc, pos);
      const tr = state.tr.insert(pos, nodes);
      return { tr, result: { paths: insertedPaths(tr, pos, nodes), ...(dropped.length && { dropped }) } };
    },
  }),
  define({
    id: 'doc.replace',
    title: 'Replace one block of the open draft (not a board)',
    brief: 'Use it to reword one block by its path. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    guide: {
      before: 'Read the block in full with doc_get path and format markdown. The outline cuts long text',
      args: 'content replaces the whole block',
      errors: 'stale means the draft changed. Read the outline again. A board is denied. Use the board tools',
    },
    group: 'doc',
    risk: 'write',
    undo: 'doc',
    needs: ['doc.open'],
    args: {
      type: 'object', required: ['path', 'content'], additionalProperties: false,
      properties: { path: ref('PATH', 'The block path from doc_get outline'), content: { ...CONTENT, description: 'The new block, as markdown, html or json' }, draftId: DRAFT_ID },
    },
    result: { type: 'object', required: ['path', 'paths'] },
    examples: [{ args: { path: [3], content: { markdown: '## Week 3' } } }],
    busy: (ctx, a) => ctx.lib.boardBusy(a.path),
    plan: async (ctx, a) => {
      const { nodes, dropped } = await ctx.lib.toNodes(a.content);
      const { state } = ctx.editor;
      const { pos, node } = nodeAtPath(state.doc, a.path);
      if (isBoard(node)) {
        fail('denied', `The block at [${a.path}] is a ${node.type.name}: replacing it would remove its items`, {
          reason: 'policy', hint: 'Change its items with the board commands, or swap the board with batch [doc.delete, doc.insert]',
        });
      }
      if (a.path.length > 1 && nodes.some(isBoard)) fail('refused', 'A board goes at the top level, not inside another block', { code: 'nested_board' });
      const tr = state.tr.replaceWith(pos, pos + node.nodeSize, nodes);
      return { tr, result: { path: a.path, paths: insertedPaths(tr, pos, nodes), ...(dropped.length && { dropped }) } };
    },
  }),
  define({
    id: 'doc.delete',
    title: 'Delete blocks of the open draft',
    brief: 'Use it to remove blocks by their paths. The user confirms on a card. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    guide: { before: 'Read the paths with doc_get format outline', args: 'Every path in one call', errors: 'denied means the user said no. Do not try again' },
    group: 'doc',
    risk: 'destructive',
    undo: 'doc',
    needs: ['doc.open'],
    args: {
      type: 'object', required: ['paths'], additionalProperties: false,
      properties: { paths: { type: 'array', items: ref('PATH'), minItems: 1, maxItems: 100, description: 'Block paths from doc_get outline, such as [[4]]' }, draftId: DRAFT_ID },
    },
    result: { type: 'object', required: ['deleted'] },
    examples: [{ args: { paths: [[4]] } }, { args: { paths: [[2, 1], [6]] } }],
    ask: (ctx, a) => {
      const { doc } = ctx.editor.state;
      const n = a.paths.length;
      return {
        title: `delete ${n === 1 ? 'a block' : `${n} blocks`} of the draft "${ctx.state.draft?.title || 'Untitled draft'}" (Ctrl+Z restores ${n === 1 ? 'it' : 'them'})`,
        description: a.paths.map((p) => blockLabel(doc, p)).join('\n'),
      };
    },
    busy: (ctx, a) => a.paths.some((p) => ctx.lib.boardBusy(p)),
    plan: (ctx, a) => {
      const { state } = ctx.editor;
      const { doc } = state;
      const byPos = new Map(); // a path given twice deletes once
      for (const p of a.paths) {
        const { pos, node } = nodeAtPath(doc, p);
        byPos.set(pos, { from: pos, to: pos + node.nodeSize });
      }
      // A block inside another deleted block goes with it; the rest go last to first, so earlier positions hold.
      const all = [...byPos.values()];
      const ranges = all.filter((r) => !all.some((o) => o !== r && o.from <= r.from && r.to <= o.to)).sort((x, y) => y.from - x.from);
      const tr = state.tr;
      const top = new Set(ranges.filter((r) => doc.resolve(r.from).depth === 0).map((r) => r.from));
      if (top.size === doc.childCount) {
        tr.replaceWith(0, doc.content.size, state.schema.nodes.paragraph.create()); // a doc keeps one block
      } else {
        for (const r of ranges) tr.deleteRange(tr.mapping.map(r.from), tr.mapping.map(r.to));
      }
      return { tr, result: { deleted: ranges.length } };
    },
  }),
  define({
    id: 'doc.format',
    title: 'Format the text of one block with marks, block type, alignment or a font preset',
    brief: 'Use it to make text bold or a heading, align it or colour it. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'doc',
    risk: 'write',
    undo: 'doc',
    needs: ['doc.open'],
    args: {
      type: 'object', required: ['path'], additionalProperties: false,
      anyOf: [{ required: ['marks'] }, { required: ['block'] }, { required: ['presetId'] }],
      properties: {
        path: ref('PATH', 'The block path from doc_get outline'),
        // block-local text offsets, as doc.find returns (default: the whole block)
        from: { type: 'integer', minimum: 0, description: 'Start offset in the block text, as doc_find gives it' },
        to: { type: 'integer', minimum: 0, description: 'End offset in the block text. Leave both out for the whole block.' },
        marks: {
          description: 'Marks to set. true adds a mark, false removes it.',
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            ...Object.fromEntries(Object.keys(MARKS).map((k) => [k, { type: 'boolean' }])),
            fontSize: { enum: [...FONT_SIZES, null] },
            textColor: { enum: [...Object.keys(TEXT_COLORS), null] },
            highlight: { enum: [...HIGHLIGHTS, null] },
            fontFamily: { enum: [...FONTS.map((f) => f.css), null] },
            link: orNull({ type: 'string', minLength: 1, maxLength: 2000 }),
          },
        },
        block: {
          type: 'object', additionalProperties: false, minProperties: 1, description: 'Make it a paragraph or a heading of a level, or align it',
          properties: { type: { enum: ['paragraph', 'heading'] }, level: { type: 'integer', minimum: 1, maximum: 6 }, align: { enum: ['left', 'center', 'right', 'justify'] } },
        },
        presetId: { type: 'string', minLength: 1, maxLength: 64, description: 'A font preset id' },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['path', 'from', 'to'] },
    examples: [
      { args: { path: [2], from: 0, to: 5, marks: { bold: true } } },
      { args: { path: [0], block: { type: 'heading', level: 2, align: 'center' } } },
      { args: { path: [3], presetId: 'p1' } },
    ],
    plan: (ctx, a) => {
      const ed = ctx.editor;
      const { state } = ed;
      const { pos, node } = nodeAtPath(state.doc, a.path);
      if (!node.isTextblock) fail('refused', `The block at [${a.path}] is a ${node.type.name}, not text`, { code: 'not_text' });
      const size = node.content.size;
      const from = a.from ?? 0;
      const to = a.to ?? size;
      if (to > size || from > to) {
        fail('invalid_args', `from / to must keep 0 <= from <= to <= ${size} (the block's length)`,
          { path: to > size ? '/to' : '/from', message: 'is outside the block', expected: { type: 'integer', minimum: 0, maximum: size } });
      }
      if (a.block?.type === 'heading' && !a.block.level) {
        fail('invalid_args', 'A heading needs its level', { path: '/block/level', message: 'is required for a heading', expected: { type: 'integer', minimum: 1, maximum: 6 } });
      }
      const preset = a.presetId && (ctx.state.settings.presets.find((p) => p.id === a.presetId) ?? fail('not_found', `No font preset has the id ${a.presetId}`));
      const tr = state.tr;
      const chain = ed.commandManager.createChain(tr); // with a start transaction the chain only adds steps; the executor dispatches
      chain.setTextSelection({ from: pos + 1 + from, to: pos + 1 + to });
      if (preset) presetChain(chain, preset);
      for (const [k, v] of Object.entries(a.marks ?? {})) {
        if (MARKS[k]) chain[`${v ? 'set' : 'unset'}${MARKS[k]}`]();
        else if (k === 'link') (v ? chain.setLink({ href: href(v) }) : chain.unsetLink());
        else chain[`set${k[0].toUpperCase()}${k.slice(1)}`](v); // setFontSize / setTextColor / setHighlight / setFontFamily (null: unset)
      }
      if (a.block?.type === 'paragraph') chain.setParagraph();
      if (a.block?.type === 'heading') chain.setHeading({ level: a.block.level });
      if (a.block?.align) chain.setTextAlign(a.block.align);
      if (!chain.run()) cannot('That formatting');
      tr.setSelection(state.selection.map(tr.doc, tr.mapping)); // the user's selection, not the range
      return { tr, result: { path: a.path, from, to } };
    },
  }),
  define({
    id: 'doc.command',
    title: 'Run one allowed editor command on the selection (marks, lists, tables, selection)',
    brief: 'draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'doc',
    risk: 'write',
    undo: 'doc',
    needs: ['doc.open', { gate: 'doc.inTable', if: (a) => TABLE_COMMANDS.includes(a.name) }],
    args: {
      type: 'object', required: ['name'], additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 40, description: `One of: ${COMMANDS.join(', ')}` },
        args: { type: 'array', maxItems: 4, default: [] },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['name'] },
    examples: [{ args: { name: 'toggleBold' } }, { args: { name: 'setHeading', args: [{ level: 2 }] } }, { args: { name: 'insertTable', args: [{ rows: 3, cols: 3, withHeaderRow: true }] } }],
    plan: (ctx, a) => {
      if (!COMMANDS.includes(a.name)) {
        fail('denied', `${a.name} is not an allowed editor command`, {
          reason: 'policy', hint: 'doc.delete deletes blocks, doc.insert / doc.replace change content; app.capabilities lists the allowed names',
        });
      }
      const ed = ctx.editor;
      const { state } = ed;
      const node = state.selection.node;
      if (node && BOARD_TYPES.includes(node.type.name) && !SELECT_COMMANDS.includes(a.name)) {
        fail('refused', `A ${node.type.name} is selected: editor commands act on text`, { code: 'board_selected', hint: 'Move the selection into text first (setTextSelection)' });
      }
      const t = a.name === 'insertTable' && a.args[0];
      if (t && (t.rows > 50 || t.cols > 20)) fail('invalid_args', 'A table has at most 50 rows and 20 columns', { path: '/args/0', message: 'is too large', expected: {} });
      if (!ed.can()[a.name]?.(...a.args)) cannot(a.name);
      const tr = state.tr;
      const chain = ed.commandManager.createChain(tr);
      if (!chain[a.name](...a.args).run()) cannot(a.name);
      return { tr, result: { name: a.name } };
    },
  }),
];
