import { liveBoard } from '../../canvas.js';
import { pathOfPos } from '../../doc-path.mjs';
import { itemLines, listBody } from '../assistant/attach.mjs';
import { boardPicture, drawMarks, markCentres, markSpots, PICTURE_SIDE, sizeText } from '../assistant/marks.mjs';
import { viewportRect } from '../viewport.js';
import { target } from './board.mjs';
import { define, fail } from './define.mjs';
import { DRAFT_ID, ref } from './schema-defs.mjs';

// view.render (SPEC §8 Catalogue, §7i Tool loop; plan assistant-reliability.md wave 2): a picture the assistant's model can
// look at mid-turn, with numbered marks (marks.mjs) and the legend that names them. The loop (loop.js) takes `url` out of the
// answer and sends the picture as the next user message, since OpenAI-style servers take images in user messages only.
// `ids` maps every mark to its item: mark n is ids[n - 1] (the legend is cut at 2 000 characters).

const lines = (items, all = items, first = 1) => (items.length ? itemLines(items, all, first).split('\n') : []);

/** The page viewport ([data-viewport]) as main captures it (ctx.lib.capturePage), at most 1 280 px on the long side, with the marks
 * of the board items whose badge falls inside it (the draft's canvases, or the library editor's flowchart), numbered on across
 * the boards; the legend names each board first. */
async function renderView(ctx, numbered) {
  const vp = viewportRect();
  const blob = new Blob([await ctx.lib.capturePage()], { type: 'image/png' });
  const k = new DataView(await blob.slice(16, 24).arrayBuffer()).getUint32(0) / window.innerWidth; // capture px per CSS px
  const f = Math.min(k, PICTURE_SIDE / Math.max(vp.width, vp.height, 1));
  const [width, height] = [Math.max(1, Math.round(vp.width * f)), Math.max(1, Math.round(vp.height * f))];
  const marks = [];
  const sections = [];
  const ids = [];
  // Board `b` {w, items} drawn at client rect `r`: its items whose badge falls inside the picture.
  const mark = (r, b, head) => {
    if (!r?.width || r.bottom < vp.top || r.top > vp.bottom || r.right < vp.left || r.left > vp.right) return;
    const kb = r.width / b.w; // board px → CSS px (the page zoom, a canvas's displayed width)
    const toPx = (p) => ({ x: (r.left + p.x * kb - vp.left) * f, y: (r.top + p.y * kb - vp.top) * f });
    const shown = markCentres(markSpots(b.items), toPx).map((m, i) => [m, b.items[i]])
      .filter(([m]) => m.x >= 0 && m.y >= 0 && m.x <= width && m.y <= height);
    if (!shown.length) return;
    const first = marks.length + 1;
    marks.push(...shown.map(([m], i) => ({ ...m, n: first + i })));
    ids.push(...shown.map(([, i]) => i.id));
    sections.push(head, ...lines(shown.map(([, i]) => i), b.items, first));
  };
  const ed = ctx.state.view.type === 'editor' ? ctx.editor : null; // a workspace page hides the draft
  ed?.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'canvas') return true;
    const dom = ed.view.nodeDOM(pos);
    mark(dom?.getBoundingClientRect(), dom?.scView ? liveBoard(dom.scView) : node.attrs, `Canvas at block [${pathOfPos(ed.state.doc, pos)}]`);
    return false;
  });
  const fb = ctx.state.view.type === 'flows' ? document.querySelector('#flow-area .wb')?.wbView : null; // the library editor's Board
  if (fb) {
    const id = ctx.state.view.flowId;
    mark(fb.dom.getBoundingClientRect(), { w: fb.size().w, items: fb.items }, `Flowchart "${ctx.flows.getFlow(id)?.title ?? 'Flowchart'}" (flowId ${id})`);
  }
  const url = await drawMarks(blob, numbered ? marks : [], { crop: { x: vp.left * k, y: vp.top * k, w: vp.width * k, h: vp.height * k }, width, height });
  const legend = sections.length ? listBody('The view as the user sees it. Board items by mark number:', sections) : 'The view as the user sees it. No board items in it.';
  return { legend, ids, width, height, size: sizeText(width, height, vp.width, vp.height, 'view'), picture: 'next message', url };
}

/** Board `b` {w, h, bg, items} drawn from its data, every item marked unless not `numbered`; the legend starts with `head`. */
async function renderBoard(ctx, b, head, numbered) {
  const pic = await boardPicture({ w: b.w, h: b.h, bg: b.bg, items: b.items }, { theme: ctx.state.settings.theme === 'light' ? 'light' : 'dark', order: numbered ? b.items : [] });
  const legend = listBody(`${head} with ${b.items.length} item${b.items.length === 1 ? '' : 's'}`, lines(b.items));
  return { legend, ids: b.items.map((i) => i.id), width: pic.width, height: pic.height, size: pic.size, picture: 'next message', url: pic.url };
}

export const defs = [
  define({
    id: 'view.render',
    title: 'Look at a canvas, a library flowchart or the page as a picture with numbered marks',
    brief: 'Use it when the target is visual or ambiguous. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'ui',
    risk: 'read',
    undo: 'none',
    // A board's picture is drawn from its data, so the window may be hidden or covered (2026-10-07: "The window is not visible"
    // left the assistant blind); the whole view is a screen capture and needs the window.
    headless: true,
    needs: [{ gate: 'doc.open', if: (a) => !!a.path }, { gate: 'node.board', if: (a) => !!a.path }, { gate: 'window.visible', if: (a) => !a.path && !a.flowId }],
    args: {
      type: 'object', additionalProperties: false,
      properties: {
        path: ref('PATH', 'Board block path. Omit it for the whole view'),
        flowId: ref('ID', 'A library flowchart, whole (flow_library_list)'),
        marks: { type: 'boolean', default: true, description: 'false: no numbers on the picture' },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['legend', 'ids', 'width', 'height', 'size', 'picture'] },
    examples: [{ args: {} }, { args: { path: [4] } }, { args: { flowId: '5f0c2a9e-7b1d-4c3e-9a8f-1d2e3f4a5b6c' } }],
    run: async (ctx, a) => {
      if (a.path && a.flowId) fail('invalid_args', 'Give path or flowId, not both', { path: '/flowId', message: 'is given with path', expected: {} });
      if (a.flowId) {
        const r = (await ctx.flows.loadFlow(a.flowId)) ?? fail('not_found', `No flowchart has the id ${a.flowId}. Call flow_library_list`, { flowId: a.flowId });
        return renderBoard(ctx, r.board, `Flowchart "${r.title}"`, a.marks);
      }
      return a.path ? renderBoard(ctx, target(ctx, a.path).board, `Canvas at block [${a.path}]`, a.marks) : renderView(ctx, a.marks);
    },
  }),
];
