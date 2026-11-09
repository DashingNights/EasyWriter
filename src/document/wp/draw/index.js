// Draw tab and Review > Ink (docs/plans/word plan.md §3 draw, briefs/draw.md). Word inks over the text; here ink lives in canvases
// (recorded deviation): a pen pick draws on the canvas being edited, else opens the node-selected canvas, else inserts one at the
// caret. Every write goes through canvas.js exports and the Board's own methods. Draw with Touch only keeps its state: the board
// already draws with touch pointers in pen mode (recorded deviation).
import { createElement as h } from 'react';
import { insertCanvas } from '../../../app/actions.js';
import { setState } from '../../../app/store.js';
import { canvasEditor, commitSynced, liveBoard, openCanvasEditor } from '../../../canvas.js';
import { saveWord } from '../../word/settings.mjs';
import { onOverlayEsc, replayOn, rulerOn, setRuler, startReplay, stopReplay } from './overlays.js';
import { addPen, colorName, KINDS, penToBoard, pensOf } from './pens.mjs';
import { PenPanel } from './PenPanel.jsx';
import { activeTool } from '../../canvas/tools/state.mjs';

const GALLERY = 'draw.drawingTools.drawingTools';
const TOOLS = [['select', 'Select'], ['lasso', 'Lasso Select'], ['eraser', 'Eraser']];

// View state of the open document: the picked tool, Draw with Touch and Hide Ink. setState({}) re-renders the ribbon.
const st = { tool: null, touch: false, hideInk: false };
const bump = () => setState({});
onOverlayEsc(bump);

const pens = (ctx) => pensOf(ctx.settings?.word?.pens);
const savePens = (list) => saveWord({ pens: list });
const penLabel = (p) => `${colorName(p.color)} ${KINDS[p.kind].label.toLowerCase()}, ${p.width} mm`;
const isStroke = (i) => i.type === 'stroke';

/** The board of the canvas being edited on the main editor; else opens the node-selected canvas, else (`create`) inserts one. */
function boardFor(ctx, create) {
  const s = canvasEditor.get();
  if (s && s.editor === ctx.ed) return s.board;
  if (!ctx.ed) return null;
  if (ctx.obj?.kind === 'canvas') openCanvasEditor(ctx.ed, ctx.obj.pos);
  else if (create) insertCanvas();
  else return null;
  return canvasEditor.get()?.board ?? null;
}

/** The gallery's current item: the open board's mode wins over the last pick (the board rail can change it). */
function current() {
  const b = canvasEditor.get()?.board;
  if (!b) return st.tool;
  if (b.mode === 'eraser') return 'eraser';
  if (b.mode === 'pen') return st.tool?.startsWith('pen-') ? st.tool : null;
  if (!b.mode) return st.tool === 'lasso' ? 'lasso' : 'select';
  return null;
}

function pick(ctx, id) {
  if (TOOLS.some(([t]) => t === id)) {
    // Lasso Select draws as the board's marquee (recorded deviation).
    boardFor(ctx, false)?.setMode(id === 'eraser' ? 'eraser' : null);
    st.tool = id;
    bump();
    return true;
  }
  const pen = pens(ctx)[Number(String(id).slice(4))];
  const b = pen && boardFor(ctx, true);
  if (!b) return false;
  b.setPen(penToBoard(pen));
  b.setMode('pen');
  st.tool = id;
  bump();
  return true;
}

function changePen(ctx, i, patch) {
  const list = pens(ctx).map((p, j) => (j === i ? { ...p, ...patch } : p));
  savePens(list);
  const b = canvasEditor.get()?.board;
  if (b && st.tool === `pen-${i}`) b.setPen(penToBoard(list[i]));
}

function deletePen(ctx, i) {
  savePens(pens(ctx).filter((_, j) => j !== i));
  if (st.tool === `pen-${i}`) st.tool = null;
  else if (st.tool?.startsWith('pen-') && Number(st.tool.slice(4)) > i) st.tool = `pen-${Number(st.tool.slice(4)) - 1}`;
  bump();
}

const tile = (label, color, opacity, mm) => h('span', { className: 'flex flex-col items-center gap-1 text-[11px]' },
  h('span', { className: 'block w-10 rounded-full ring-1 ring-foreground/20', style: { background: color, opacity, height: `${Math.min(10, Math.max(2, mm * 2))}px` } }),
  h('span', { className: 'truncate' }, label));

// On a canvas draft the pick is the page tool now on (src/document/canvas/tools/ink.js), so the gallery serves both (`engine`).
function galleryItems(ctx) {
  const tool = ctx.engine && activeTool();
  const now = ctx.engine ? (tool?.startsWith('ink:') ? tool.slice(4) : 'select') : current();
  return [
    ...TOOLS.map(([id, label]) => ({ id, label, active: now === id })),
    ...pens(ctx).map((p, i) => ({
      id: `pen-${i}`, label: penLabel(p), active: now === `pen-${i}`, panel: 'draw.pen',
      preview: tile(KINDS[p.kind].label, p.color, penToBoard(p).opacity, p.width),
    })),
  ];
}

// The canvas Ink Replay plays: the one being edited, else the node-selected one, else the first in the document.
function replayTarget(ctx) {
  const b = canvasEditor.get()?.board;
  if (b) return { el: b.dom, items: b.items, w: b.dom.offsetWidth, h: b.dom.offsetHeight };
  let pos = ctx.obj?.kind === 'canvas' ? ctx.obj.pos : null;
  ctx.ed?.state.doc.descendants((n, p) => {
    if (pos == null && n.type.name === 'canvas') pos = p;
    return pos == null;
  });
  const cv = pos != null && ctx.ed.view.nodeDOM(pos)?.scView;
  if (!cv) return null;
  const live = liveBoard(cv);
  return { el: cv.dom, items: live.items, w: live.w, h: live.h };
}

const canvasesOf = (ed) => {
  const out = [];
  ed?.state.doc.descendants((n, pos) => {
    if (n.type.name === 'canvas') out.push(pos);
  });
  return out;
};
const hasInk = (ed) => canvasesOf(ed).some((pos) => ed.state.doc.nodeAt(pos).attrs.items?.some(isStroke));

// Every stroke of every canvas, removed in one undo step: the first commit opens a history group, the rest join it.
function deleteAllInk(ctx) {
  let first = true;
  for (const pos of canvasesOf(ctx.ed)) {
    const cv = ctx.ed.view.nodeDOM(pos)?.scView;
    const live = cv && liveBoard(cv);
    if (!live?.items.some(isStroke)) continue;
    commitSynced(cv, pos, { ...cv.node.attrs, ...live, items: live.items.filter((i) => !isStroke(i)) }, first);
    first = false;
  }
  return !first;
}

function toggleHideInk() {
  st.hideInk = !st.hideInk;
  document.getElementById('editor-area')?.toggleAttribute('data-hide-ink', st.hideInk);
  bump();
  return true;
}

const hideInk = { run: toggleHideInk, active: () => st.hideInk };
const ADD = Object.fromEntries(['pen', 'highlighter', 'fountainPen', 'brushPen', 'pencil'].map((kind) => [`draw.drawingTools.add.${kind}`, {
  run: (ctx) => {
    savePens(addPen(pens(ctx), kind));
    return true;
  },
}]));

export default {
  id: 'draw',
  commands: {
    [GALLERY]: { run: pick, value: () => current() },
    ...ADD,
    'draw.touch.drawWithTouch': { run: () => { st.touch = !st.touch; bump(); return true; }, active: () => st.touch },
    'draw.stencils.ruler': {
      run: (ctx) => {
        setRuler(!rulerOn(), ctx.settings?.word?.units === 'in' ? 'in' : 'cm');
        bump();
        return true;
      },
      active: () => rulerOn(),
    },
    'draw.replay.inkReplay': {
      run: (ctx) => {
        if (replayOn()) {
          stopReplay();
          return true;
        }
        const target = replayTarget(ctx);
        if (!target || !startReplay(target, bump)) {
          ctx.toast('There is no ink to replay.');
          return false;
        }
        bump();
        return true;
      },
      active: () => replayOn(),
    },
    'review.ink.hideInk': hideInk,
    'review.ink.hideInk.hideInk': hideInk,
    'review.ink.hideInk.deleteAllInkInDocument': {
      run: deleteAllInk,
      enabled: (ctx) => hasInk(ctx.ed),
      reason: () => 'There is no ink in this document.',
    },
  },
  galleries: { [GALLERY]: Object.assign(galleryItems, { engine: true }) },
  panels: {
    'draw.pen': ({ ctx, close }) => {
      const i = Number(st.tool?.slice(4));
      const list = pens(ctx);
      if (!st.tool?.startsWith('pen-') || !list[i]) return null;
      return h(PenPanel, {
        pen: list[i], close,
        onChange: (patch) => changePen(ctx, i, patch),
        onDelete: list.length > 1 ? () => deletePen(ctx, i) : null,
        onMore: async () => {
          const hex = await ctx.dialog('colors', { value: list[i].color });
          if (hex) changePen(ctx, i, { color: hex });
        },
      });
    },
  },
  implements: ['draw.drawingTools.add'],
  setup() {
    // Harness hook: the canvas being edited (briefs/draw.md Acceptance).
    window.__wordDraw = { session: () => canvasEditor.get(), board: () => canvasEditor.get()?.board ?? null };
    return () => {
      setRuler(false);
      stopReplay();
      document.getElementById('editor-area')?.removeAttribute('data-hide-ink');
      Object.assign(st, { tool: null, hideInk: false });
    };
  },
};
