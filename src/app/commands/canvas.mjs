import { canvasEditor, openCanvasEditor } from '../../canvas.js';
import { pathOfPos, posOfPath } from '../../doc-path.mjs';
import { activeBoard } from '../../whiteboard.js';
import { define, fail, failGates } from './define.mjs';
import { ITEM_ID, NO_ARGS, ref } from './schema-defs.mjs';
import { scrollToBlock } from './ui.mjs';

// canvas.* (SPEC §8 Catalogue, §6b Canvas Mode): open a smart canvas, or a picture or canvas item of a whiteboard, in the
// in-place editor and leave it, through the code the UI runs: the canvas bar's Edit (openCanvasEditor), the item ribbon's
// Edit and a double-click on an item (Board.editCanvas; a picture becomes a canvas item first, Board.imageToCanvas, one undo
// step), the edit bar's Done and Escape (CanvasSession.close(true)).

const OPENS = ['image', 'canvas'];
const VIEW = ['doc.open', 'view.editor'];
const busy = (ctx) => ctx.lib.anyBoardBusy();

/** The position of the first block of `doc` for which `test(node, pos)` holds, or null. */
function findBlock(doc, test) {
  let at = null;
  doc.descendants((node, pos) => {
    if (at === null && test(node, pos)) at = pos;
    return at === null;
  });
  return at;
}

/** What canvas.edit opens → {pos, board?, item?}: the canvas block at `path`; item `item` of the whiteboard at `path` (no
 * path: the whiteboard holding it). No arguments: the one picture or canvas item selected on the active whiteboard; with no
 * board active (the chat box holds the focus) the node-selected canvas or the one whiteboard holding such a selection; both
 * linger after a click elsewhere (a board keeps the document's selection), so when several are selected the model picks. */
function target(ed, a) {
  const { doc, selection: sel } = ed.state;
  if (a.path && !a.item) return { pos: posOfPath(doc, a.path) }; // node.canvas held
  const whiteboardOf = (b) => findBlock(doc, (_, pos) => ed.view.nodeDOM(pos) === b.dom);
  if (a.item) {
    const pos = a.path ? posOfPath(doc, a.path) : findBlock(doc, (n) => n.type.name === 'whiteboard' && n.attrs.items.some((i) => i.id === a.item));
    if (pos === null) fail('not_found', `No whiteboard has an item ${a.item}`, { ids: [a.item] });
    const board = ed.view.nodeDOM(pos)?.wbView ?? fail('failed', 'The whiteboard is not drawn');
    const item = board.items.find((i) => i.id === a.item) ?? fail('not_found', `No item has the id ${a.item} on that board`, { ids: [a.item] });
    if (!OPENS.includes(item.type)) fail('refused', `Item ${a.item} is a ${item.type}: only a picture or a canvas item opens in Canvas Mode`, { code: 'not_a_canvas' });
    return { pos, board, item };
  }
  const one = (b) => !!b && !b.fixed && !b.destroyed && OPENS.includes(b.selected()?.type);
  const live = activeBoard.get();
  const boards = one(live) ? [live] : [...ed.view.dom.querySelectorAll('.wb')].map((el) => el.wbView).filter(one);
  const canvas = !one(live) && sel.node?.type.name === 'canvas';
  if (canvas && !boards.length) return { pos: sel.from };
  if (!canvas && boards.length === 1) return { pos: whiteboardOf(boards[0]), board: boards[0], item: boards[0].selected() };
  if (!canvas && !boards.length) failGates(['node.canvas', 'board.itemIs'], 'Nothing to open: select a canvas, or one picture or canvas item on a whiteboard, or pass path / item');
  const candidates = [...(canvas ? [{ path: pathOfPos(doc, sel.from) }] : []), ...boards.map((b) => ({ path: pathOfPos(doc, whiteboardOf(b)), item: b.selectedId }))];
  const named = candidates.map((c) => (c.item ? `item ${c.item} of the whiteboard at [${c.path}]` : `the canvas at [${c.path}]`));
  fail('refused', `Several are selected (${named.join(', ')}): pass path, and item for a whiteboard's, to pick one`, { code: 'ambiguous', candidates });
}

export const defs = [
  define({
    id: 'canvas.edit',
    title: 'Open a smart canvas or a whiteboard picture in Canvas Mode',
    brief: 'It lets the user draw by hand. {} opens the selected one.',
    notFor: 'changing items. Use board_items_update',
    guide: { playbook: 'canvas-mode' },
    group: 'canvas',
    risk: 'write', // a picture becomes a canvas item (one undo step); otherwise only the view changes
    undo: 'doc',
    needs: [...VIEW, { gate: 'node.canvas', if: (a) => !!a.path && !a.item }, { gate: 'node.whiteboard', if: (a) => !!a.path && !!a.item }],
    args: {
      type: 'object', additionalProperties: false,
      properties: {
        path: ref('PATH', 'Canvas block path, or the whiteboard holding item'),
        item: { ...ITEM_ID, description: 'Id of a picture or canvas item on a whiteboard' },
      },
    },
    result: { type: 'object', required: ['path'] },
    examples: [{ args: {} }, { args: { path: [4] } }, { args: { path: [6], item: 'k3j9x0a' } }],
    busy,
    run: (ctx, a) => {
      const ed = ctx.editor;
      const t = target(ed, a);
      canvasEditor.get()?.close(true); // as a click outside first: open() skips another item of the board being edited
      scrollToBlock(ed, t.pos);
      if (!t.item) openCanvasEditor(ed, t.pos);
      else if (t.item.type === 'image') t.board.imageToCanvas(t.item); // the canvas item keeps the picture's id
      else t.board.editCanvas(t.item);
      if (!canvasEditor.get()) fail('failed', 'Canvas Mode did not open');
      return { path: pathOfPos(ed.state.doc, t.pos), ...(t.item && { item: t.item.id, converted: t.item.type === 'image' }) };
    },
  }),
  define({
    id: 'canvas.close',
    title: 'Leave Canvas Mode (back to the document)',
    notFor: 'saving',
    group: 'canvas',
    risk: 'write',
    undo: 'none', // Done commits an open text edit: the user's own typing, not an agent's change
    needs: ['view.editor', 'board.canvasMode'],
    args: NO_ARGS,
    result: { type: 'object', required: ['closed'] },
    examples: [{ args: {} }],
    busy,
    run: () => {
      (canvasEditor.get() ?? failGates(['board.canvasMode'])).close(true);
      return { closed: true };
    },
  }),
];
