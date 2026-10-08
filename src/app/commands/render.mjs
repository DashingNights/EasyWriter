import { liveBoard } from '../../canvas.js';
import { pathOfPos } from '../../doc-path.mjs';
import { itemLines, listBody } from '../assistant/attach.mjs';
import { boardPicture, drawMarks, markCentres, markSpots, PICTURE_SIDE, sizeText } from '../assistant/marks.mjs';
import { viewportRect } from '../viewport.js';
import { drawnWidth, ITEM_PATH_SHORT, target } from './board.mjs';
import { define, fail } from './define.mjs';
import { DRAFT_ID, ref } from './schema-defs.mjs';

// view.render (SPEC §8 Catalogue, §7i Tool loop; plan assistant-reliability.md wave 2): a picture the assistant's model can
// look at mid-turn, with numbered marks (marks.mjs) and the legend that names them. The loop (loop.js) takes `url` out of the
// answer and sends the picture as the next user message, since OpenAI-style servers take images in user messages only.

const NAMES = { whiteboard: 'Whiteboard', canvas: 'Canvas' };
const lines = (items, all = items) => (items.length ? itemLines(items, all, 1).split('\n') : []);

/** The page viewport ([data-viewport]) as main captures it (ctx.lib.capturePage), at most 1 280 px on the long side, with the marks
 * of the board items whose badge falls inside it, numbered per board; the legend names each board by its path first. */
async function renderView(ctx) {
  const vp = viewportRect();
  const blob = new Blob([await ctx.lib.capturePage()], { type: 'image/png' });
  const k = new DataView(await blob.slice(16, 24).arrayBuffer()).getUint32(0) / window.innerWidth; // capture px per CSS px
  const f = Math.min(k, PICTURE_SIDE / Math.max(vp.width, vp.height, 1));
  const [width, height] = [Math.max(1, Math.round(vp.width * f)), Math.max(1, Math.round(vp.height * f))];
  const marks = [];
  const sections = [];
  const ed = ctx.state.view.type === 'editor' ? ctx.editor : null; // a workspace page hides the draft
  ed?.state.doc.descendants((node, pos) => {
    const type = node.type.name;
    if (!NAMES[type]) return true;
    const dom = ed.view.nodeDOM(pos);
    const r = dom?.getBoundingClientRect();
    if (!r?.width || r.bottom < vp.top || r.top > vp.bottom || r.right < vp.left || r.left > vp.right) return false;
    const b = type === 'whiteboard' ? { w: dom.wbView?.size().w ?? r.width, items: node.attrs.items } : dom.scView ? liveBoard(dom.scView) : node.attrs;
    const kb = r.width / b.w; // board px → CSS px (the page zoom, a canvas's displayed width)
    const toPx = (p) => ({ x: (r.left + p.x * kb - vp.left) * f, y: (r.top + p.y * kb - vp.top) * f });
    const shown = markCentres(markSpots(b.items), toPx).map((m, i) => [m, b.items[i]])
      .filter(([m]) => m.x >= 0 && m.y >= 0 && m.x <= width && m.y <= height);
    if (!shown.length) return false;
    marks.push(...shown.map(([m], i) => ({ ...m, n: i + 1 })));
    sections.push(`${NAMES[type]} at block [${pathOfPos(ed.state.doc, pos)}]`, ...lines(shown.map(([, i]) => i), b.items));
    return false;
  });
  const url = await drawMarks(blob, marks, { crop: { x: vp.left * k, y: vp.top * k, w: vp.width * k, h: vp.height * k }, width, height });
  const legend = sections.length ? listBody('The view as the user sees it. Board items, numbered per board:', sections) : 'The view as the user sees it. No board items in it.';
  return { legend, width, height, size: sizeText(width, height, vp.width, vp.height, 'view'), picture: 'next message', url };
}

export const defs = [
  define({
    id: 'view.render',
    title: 'Look at a board or the page as a picture with numbered marks',
    brief: 'Use it when the target is visual or ambiguous. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'ui',
    risk: 'read',
    undo: 'none',
    // A board's picture is drawn from its data, so the window may be hidden or covered (2026-10-07: "The window is not visible"
    // left the assistant blind); the whole view is a screen capture and needs the window.
    headless: true,
    needs: [{ gate: 'doc.open', if: (a) => !!a.path }, { gate: 'node.board', if: (a) => !!a.path }, { gate: 'window.visible', if: (a) => !a.path }],
    args: {
      type: 'object', additionalProperties: false,
      properties: { path: ref('PATH', 'Board block path. Omit it for the whole view'), itemPath: ITEM_PATH_SHORT, draftId: DRAFT_ID },
    },
    result: { type: 'object', required: ['legend', 'width', 'height', 'size', 'picture'] },
    examples: [{ args: {} }, { args: { path: [4] } }],
    run: async (ctx, a) => {
      if (!a.path) return a.itemPath ? fail('invalid_args', 'itemPath needs the path of its whiteboard', { path: '/path', message: 'is required with itemPath', expected: {} }) : renderView(ctx);
      const t = target(ctx, a.path, a.itemPath);
      const b = t.kind === 'whiteboard' ? { ...t.node.attrs, w: drawnWidth(ctx, t.pos), h: t.node.attrs.height }
        : t.kind === 'item' ? { w: t.item.aw, h: t.item.ah, bg: t.item.bg, items: t.item.items } : t.board;
      const pic = await boardPicture({ w: b.w, h: b.h, bg: b.bg, items: b.items }, { theme: ctx.state.settings.theme === 'light' ? 'light' : 'dark' });
      const name = t.kind === 'item' ? `Canvas item ${t.item.id} of the whiteboard` : NAMES[t.kind];
      const legend = listBody(`${name} at block [${a.path}] with ${b.items.length} item${b.items.length === 1 ? '' : 's'}`, lines(b.items));
      return { legend, width: pic.width, height: pic.height, size: pic.size, picture: 'next message', url: pic.url };
    },
  }),
];
