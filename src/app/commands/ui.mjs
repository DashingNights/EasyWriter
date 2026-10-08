import { BOARD_TYPES, posOfPath } from '../../doc-path.mjs';
import { KEYS } from '../assistant/ui-tree.mjs';
import { define, fail } from './define.mjs';
import { DRAFT_ID, ref } from './schema-defs.mjs';

// ui.* (SPEC §8 Catalogue; ui.state is in app.mjs): what the user sees. ui.select is the one command that moves the
// selection, focuses and scrolls; ui.scrollTo only scrolls. ui.snapshot / ui.invoke are application control, the fallback
// when no command does the job (automation plan §13.11): the DOM work is assistant/ui-control.js, reached through ctx.lib.

const VIEW = ['doc.open', 'view.editor'];

function blockAt(ctx, path) {
  const { doc } = ctx.editor.state;
  const pos = posOfPath(doc, path);
  if (pos === null) fail('not_found', `No block at [${path}]`, { path });
  return pos;
}

/** Scrolls the editor page's viewport so the block at `pos` is centred in it (its top, when taller than the view); by
 * hand, as the page's CSS zoom misleads scrollIntoView. */
export function scrollToBlock(ed, pos) {
  const el = ed.view.nodeDOM(pos);
  const area = el?.closest?.('[data-viewport]');
  if (!area) return;
  const r = el.getBoundingClientRect();
  const v = area.getBoundingClientRect();
  area.scrollTop += r.top - v.top - Math.max(0, (v.height - r.height) / 2);
  if (r.right < v.left || r.left > v.right) area.scrollLeft += r.left + r.width / 2 - (v.left + v.width / 2);
}

export const defs = [
  define({
    id: 'ui.select',
    title: 'Select a block or board items and bring it into view',
    brief: 'draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    notFor: 'changing items. No tool needs a selection first',
    group: 'ui',
    risk: 'write',
    undo: 'none',
    // ids without a path: the active board's items.
    needs: [...VIEW, { gate: 'board.active', if: (a) => !!a.ids && !a.path }],
    args: {
      type: 'object', additionalProperties: false, minProperties: 1,
      properties: {
        path: ref('PATH', 'Block path, or the whiteboard holding ids'),
        ids: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 32 }, minItems: 1, maxItems: 500, description: 'Item ids on that whiteboard' },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['kind'] },
    examples: [{ args: { path: [4] } }, { args: { path: [6], ids: ['a1b2c3d'] } }],
    run: (ctx, a) => {
      const ed = ctx.editor;
      const pos = a.path ? blockAt(ctx, a.path) : null;
      const bg = !!ctx.session; // a background draft (draftId): nothing takes the focus, scrolls or becomes the active board
      if (!a.ids) {
        if (!bg || !BOARD_TYPES.includes(ed.state.doc.nodeAt(pos).type.name)) ed.commands.setNodeSelection(pos);
        if (!bg) {
          ed.view.focus();
          scrollToBlock(ed, pos);
        }
        return { kind: 'node', path: a.path };
      }
      const board = pos === null ? ctx.board : ed.view.nodeDOM(pos)?.wbView;
      if (!board) {
        fail('refused', `The block at [${a.path}] is not a whiteboard`, {
          code: 'not_a_whiteboard', hint: 'A canvas\'s items are selected while it is edited: canvas.edit {path}, then ui.select {ids}',
        });
      }
      const missing = a.ids.filter((id) => !board.items.some((i) => i.id === id));
      if (missing.length) fail('not_found', `No item has the id ${missing.join(', ')} on that board`, { ids: missing });
      board.select(a.ids);
      if (bg) return { kind: 'board', ids: a.ids };
      board.focus(); // the board becomes the active one (its chrome shows)
      if (pos !== null) scrollToBlock(ed, pos);
      return { kind: 'board', ids: a.ids };
    },
  }),
  define({
    id: 'ui.scrollTo',
    title: 'Scroll a block into the middle of the view (no selection change, no focus)',
    group: 'ui',
    risk: 'write',
    undo: 'none',
    needs: VIEW,
    args: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: ref('PATH') } },
    result: { type: 'object', required: ['path'] },
    examples: [{ args: { path: [12] } }],
    run: (ctx, a) => {
      scrollToBlock(ctx.editor, blockAt(ctx, a.path));
      return { path: a.path };
    },
  }),
  define({
    id: 'ui.notice',
    title: 'Show a short notice above the toolbar (it fades out)',
    group: 'ui',
    risk: 'write',
    undo: 'none',
    args: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 120 } } },
    result: { type: 'object', required: ['text'] },
    examples: [{ args: { text: 'Draft tidied' } }],
    run: (ctx, a) => {
      ctx.actions.notify({ text: a.text });
      return { text: a.text };
    },
  }),
  define({
    id: 'ui.zoom',
    title: 'Zoom the page: fit to the view, or a percent (10 to 400)',
    group: 'ui',
    risk: 'write',
    undo: 'none',
    needs: ['view.editor'],
    args: {
      type: 'object', required: ['value'], additionalProperties: false,
      // The percent first: the gemma model form keeps a union's first branch (tools-schema.mjs rewrite).
      properties: { value: { anyOf: [{ type: 'number', minimum: 10, maximum: 400 }, { const: 'fit' }] } },
    },
    result: { type: 'object', required: ['zoom', 'previous'] },
    examples: [{ args: { value: 'fit' } }, { args: { value: 125 } }],
    run: (ctx, a) => {
      const previous = ctx.state.zoom;
      ctx.actions.setZoom(a.value);
      return { zoom: ctx.state.zoomPct, previous };
    },
  }),
  define({
    id: 'ui.snapshot',
    title: 'List the controls on screen with refs for ui_invoke (only when no other tool does the job)',
    group: 'ui',
    risk: 'read',
    undo: 'none',
    headless: false,
    args: {
      type: 'object', additionalProperties: false,
      properties: {
        scope: { enum: ['view', 'dialog', 'menu'], description: 'Only the open dialog, the open menu, or the rest' },
        page: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
        query: { type: 'string', minLength: 1, maxLength: 60, description: 'Words in a control name or role' },
      },
    },
    result: { type: 'object', required: ['page', 'pages', 'total', 'groups'] },
    examples: [{ args: {} }, { args: { query: 'bold' } }, { args: { scope: 'dialog', page: 2 } }],
    run: (ctx, a) => ctx.lib.uiSnapshot(a),
  }),
  define({
    id: 'ui.invoke',
    title: 'Click, type into, choose in or send a key to one control by its ui_snapshot ref',
    group: 'ui',
    risk: 'write', // a destructive or outward-facing control asks on the approval card (ui-tree.mjs riskOf)
    undo: 'doc',
    headless: false,
    args: {
      type: 'object', required: ['ref', 'action'], additionalProperties: false,
      properties: {
        ref: { type: 'string', pattern: '^e[0-9]{1,7}$' },
        action: { enum: ['click', 'type', 'select', 'key'] },
        text: { type: 'string', maxLength: 2000, description: 'type: the new text of the field' },
        value: { type: 'string', minLength: 1, maxLength: 200, description: 'select: the option to choose, by its name' },
        key: { enum: KEYS },
      },
    },
    result: { type: 'object', required: ['ref', 'action', 'name', 'role', 'area', 'changes'] },
    examples: [{ args: { ref: 'e12', action: 'click' } }, { args: { ref: 'e4', action: 'type', text: '640' } },
      { args: { ref: 'e7', action: 'select', value: 'Heading 2' } }, { args: { ref: 'e9', action: 'key', key: 'Escape' } }],
    run: (ctx, a) => ctx.lib.uiInvoke(ctx, a),
  }),
];
