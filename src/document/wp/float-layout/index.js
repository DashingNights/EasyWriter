// float-layout (docs/plans/word/plan.md §3 float-layout): Word's text wrapping and positioning for pictures, text boxes, canvases
// and plan charts from their layout attribute (§1.8 float layout object). Wrap Text and Position (Layout, Picture Format and Shape
// Format share the commands), the Layout dialog, the Layout Options button, dragging with anchors, the Text Wrapping break and
// legacy frames. The plugin (plugin.js) draws and measures; place.mjs holds the pure placement.
import { Extension } from '@tiptap/core';
import { createElement as h } from 'react';
import { saveWord } from '../../word/settings.mjs';
import { run } from '../../../tooling/registry.js';
import { FrameDialog, LayoutDialog } from './dialogs.jsx';
import { full, offsetOf, POSITIONS, PT, round, withWrap } from './place.mjs';
import { positionItem } from '../../canvas/rows/objects.mjs';
import {
  armFrameTool, drawnAt, editWrapPoints, floatLayoutPlugin, floatObj, kindOf, layoutOf, measOf, onLayoutOptions, PAGE_WRAP_PASS, pageOf,
  selectedFloat, setLayoutTr,
} from './plugin.js';

const NEEDS_OBJ = () => 'Select a picture, text box or canvas first.';
const NEEDS_FLOAT = (ctx) => (floatObj(ctx) ? 'Pick a wrapping style other than In Line with Text first.' : NEEDS_OBJ());

/** The full layout of the object (null while In Line). */
const layoutNow = (ctx) => {
  const o = floatObj(ctx);
  return o ? full(layoutOf(ctx.state.doc.nodeAt(o.pos) ?? o.node, ctx.state.doc)) : null;
};
const wrapNow = (ctx) => layoutNow(ctx)?.wrap ?? 'inline';

/** Writes `layout` on the object of `ctx` as one undo step. */
function write(ctx, layout) {
  const o = floatObj(ctx);
  if (!o) return false;
  const view = ctx.target.view;
  const node = view.state.doc.nodeAt(o.pos);
  view.dispatch(setLayoutTr(view.state.tr, o.pos, node, layout));
  ctx.target.commands.focus();
  return true;
}

/** Gives the object wrap `wrap`; an In Line object becomes a float where it is drawn now. */
export function setWrap(ctx, wrap) {
  const o = floatObj(ctx);
  if (!o) return false;
  const node = ctx.state.doc.nodeAt(o.pos);
  const stored = layoutOf(node);
  const at = full(stored) ? null : drawnAt(ctx.target.view, o.pos);
  return write(ctx, withWrap(stored, wrap, o.kind, at ?? undefined));
}

/** Patches the object's float layout with `patch` (a function of the full layout, or an object). */
function patch(ctx, fn) {
  const l = layoutNow(ctx);
  if (!l) return false;
  const stored = layoutOf(ctx.state.doc.nodeAt(floatObj(ctx).pos));
  return write(ctx, { ...stored, ...(typeof fn === 'function' ? fn(l) : fn) });
}

const WRAP_ITEMS = {
  inLineWithText: 'inline', square: 'square', tight: 'tight', through: 'through', topAndBottom: 'topBottom', behindText: 'behind', inFrontOfText: 'front',
};
const ITEM_OF = Object.fromEntries(Object.entries(WRAP_ITEMS).map(([k, v]) => [v, k]));

/** The page top (layout px) of measure `m` in `view`: a story editor's page (a header's) or the geometry's. */
const pageTop = (view, m) => pageOf(view, m.page)?.top ?? 0;

/** Move with Text: v relative to the anchor paragraph at the object's current place. Fix Position on Page: v relative to the page. */
function anchorMode(ctx, withText) {
  const o = floatObj(ctx);
  const m = o && measOf(ctx.target.view.state, o.pos);
  if (!m) return false;
  return patch(ctx, (l) => {
    const { align: _a, pct: _p, ...v } = l.v ?? {};
    return withText ? { moveWithText: true, v: { ...v, rel: 'paragraph', offset: offsetOf(m.y, m.anchorTop) } }
      : { moveWithText: false, v: { ...v, rel: 'page', offset: offsetOf(m.y, pageTop(ctx.target.view, m)) } };
  });
}

/** The Position gallery's item matching the object's layout, or null. */
function positionNow(ctx) {
  const l = layoutNow(ctx);
  if (!l) return floatObj(ctx) ? 'inLineWithText' : null;
  if (l.wrap !== 'square' || l.h?.rel !== 'margin' || l.v?.rel !== 'margin') return null;
  return POSITIONS.find((p) => p.h.align === l.h.align && p.v.align === l.v.align)?.id ?? null;
}

/** Applies Position gallery item `id` (In Line with Text or one of the nine). */
function setPosition(ctx, id) {
  if (id === 'inLineWithText') return setWrap(ctx, 'inline');
  const p = POSITIONS.find((x) => x.id === id);
  const o = floatObj(ctx);
  if (!p || !o) return false;
  const stored = layoutOf(ctx.state.doc.nodeAt(o.pos));
  const base = full(stored) ? stored : withWrap(stored, p.wrap, o.kind, drawnAt(ctx.target.view, o.pos));
  return write(ctx, { ...base, wrap: p.wrap, h: { rel: p.h.rel, align: p.h.align }, v: { rel: p.v.rel, align: p.v.align }, moveWithText: p.moveWithText });
}

/** Convert to Frame: the selected text box's paragraphs become framed paragraphs at its place on the page (one undo step). */
function toFrame(ctx) {
  const o = floatObj(ctx);
  if (o?.kind !== 'textbox') return false;
  const view = ctx.target.view;
  const { state } = view;
  const node = state.doc.nodeAt(o.pos);
  const m = measOf(state, o.pos);
  const page = pageOf(view, m?.page ?? 0);
  const l = full(layoutOf(node));
  const frame = {
    dropCap: null, lines: null, w: node.attrs.w, h: node.attrs.h, hRule: node.attrs.autoFit ? 'atLeast' : 'exact', hSpace: l?.dist.l ?? 9,
    vSpace: l?.dist.t ?? 0, wrap: l?.wrap === 'topBottom' ? 'none' : 'around', hAnchor: 'page', vAnchor: 'page',
    x: m && page ? round((m.x + page.box.left) / PT) : 0, xAlign: null, y: m && page ? round((m.y - page.top) / PT) : 0, yAlign: null,
  };
  const blocks = [];
  node.forEach((child) => blocks.push(kindOf(child) || child.isTextblock ? child.type.create({ ...child.attrs, frame }, child.content, child.marks) : child));
  view.dispatch(state.tr.replaceWith(o.pos, o.pos + node.nodeSize, blocks).scrollIntoView());
  ctx.target.commands.focus();
  return true;
}

const enabledObj = (ctx) => !!floatObj(ctx);
const enabledFloat = (ctx) => !!layoutNow(ctx);

const wrapItem = (wrap) => ({
  run: (ctx) => setWrap(ctx, wrap),
  enabled: enabledObj,
  reason: NEEDS_OBJ,
  active: (ctx) => !!floatObj(ctx) && wrapNow(ctx) === wrap,
  repeatable: true,
});

const commands = {
  // The Wrap Text dropdown (also Picture Format's and Shape Format's, through cmd): its arg is an item id or a wrap.
  'layout.arrange.wrapText': {
    run: (ctx, arg) => (arg == null ? false : setWrap(ctx, WRAP_ITEMS[arg] ?? arg)),
    enabled: enabledObj,
    reason: NEEDS_OBJ,
    value: (ctx) => (floatObj(ctx) ? ITEM_OF[wrapNow(ctx)] : null),
  },
  ...Object.fromEntries(Object.entries(WRAP_ITEMS).map(([item, wrap]) => [`layout.arrange.wrapText.${item}`, wrapItem(wrap)])),
  'layout.arrange.wrapText.editWrapPoints': {
    run: (ctx) => {
      editWrapPoints(ctx.target.view, floatObj(ctx).pos);
      ctx.target.commands.focus();
      return true;
    },
    enabled: (ctx) => ['tight', 'through'].includes(layoutNow(ctx)?.wrap),
    reason: (ctx) => (layoutNow(ctx) ? 'Pick Tight or Through first.' : NEEDS_FLOAT(ctx)),
  },
  'layout.arrange.wrapText.moveWithText': {
    run: (ctx) => anchorMode(ctx, true), enabled: enabledFloat, reason: NEEDS_FLOAT, active: (ctx) => !!layoutNow(ctx)?.moveWithText,
  },
  'layout.arrange.wrapText.fixPositionOnPage': {
    run: (ctx) => anchorMode(ctx, false), enabled: enabledFloat, reason: NEEDS_FLOAT, active: (ctx) => !!layoutNow(ctx) && !layoutNow(ctx).moveWithText,
  },
  'layout.arrange.wrapText.moreLayoutOptions': { run: (ctx) => ctx.dialog('layout', { tab: 'textWrapping' }), enabled: enabledObj, reason: NEEDS_OBJ },
  'layout.arrange.wrapText.setAsDefaultLayout': {
    // Insert > Pictures and paste read it (plugin.js defaultLayout); a picture's wrap, never a text box's.
    run: (ctx) => {
      saveWord({ paste: { pictures: wrapNow(ctx) } }).catch(() => ctx.toast('The default layout could not be saved.'));
      return true;
    },
    enabled: enabledObj,
    reason: NEEDS_OBJ,
  },
  'layout.arrange.position': {
    run: (ctx, arg) => (arg == null ? false : setPosition(ctx, arg)),
    enabled: enabledObj,
    reason: NEEDS_OBJ,
    value: positionNow,
    repeatable: true,
  },
  'layout.arrange.position.moreLayoutOptions': { run: (ctx) => ctx.dialog('layout', { tab: 'position' }), enabled: enabledObj, reason: NEEDS_OBJ },
  'pictureFormat.size.launcher': { run: (ctx) => ctx.dialog('layout', { tab: 'size' }), enabled: enabledObj, reason: NEEDS_OBJ },
  'layout.pageSetup.breaks.textWrapping': {
    run: (ctx) => ctx.chain((c) => c.insertContent({ type: 'hardBreak', attrs: { clear: 'all' } })),
    enabled: (ctx) => !!ctx.state?.selection.$from.parent.inlineContent,
    reason: () => 'Put the cursor in text first.',
    repeatable: true,
  },
  'developer.controls.legacyTools.insertFrame': {
    run: (ctx) => {
      armFrameTool(ctx.ed.view);
      ctx.ed.view.focus();
      return true;
    },
    enabled: (ctx) => !!ctx.ed && ctx.target === ctx.ed,
  },
  'pictures.textBoxConvert': { run: toFrame, enabled: (ctx) => floatObj(ctx)?.kind === 'textbox', reason: () => 'Select a text box first.' },
};

/** Word's Position icon: a page of text lines with the object at row `v`, column `col` (0 to 2), or in the first line (`v` null). */
const pageIcon = (v, col) => h('svg', { viewBox: '0 0 30 38', 'aria-hidden': true, style: { width: 30, height: 38 } }, // a menu item's svg rule would make it 16 px
  h('rect', { x: 0.5, y: 0.5, width: 29, height: 37, rx: 1.5, fill: 'white', stroke: '#9ca3af' }),
  ...[6, 10, 14, 18, 22, 26, 30].map((y) => h('line', { key: y, x1: 5, x2: 25, y1: y, y2: y, stroke: '#c4c8ce', strokeWidth: 1.2 })),
  v === null ? h('rect', { x: 9, y: 3, width: 6, height: 6, fill: '#2b6cb0' }) : h('rect', { x: 4 + col * 7.5, y: 4 + v * 11, width: 7, height: 8, fill: '#2b6cb0' }));

const galleries = {
  // A grid of page icons (word-spec-data GALLERY_VIEWS), each named in its tooltip, as Word draws it.
  // A canvas draft reads its object from the engine (object.get, canvas/rows/objects.mjs positionItem).
  'layout.arrange.position': Object.assign((ctx) => {
    if (ctx.engine ? !ctx.obj : !floatObj(ctx)) return [];
    const now = ctx.engine ? positionItem(ctx.read('object.get', {})) : positionNow(ctx);
    return [
      { id: 'inLineWithText', label: 'In Line with Text', group: 'In Line with Text', active: now === 'inLineWithText', preview: pageIcon(null) },
      ...POSITIONS.map((p, i) => ({ id: p.id, label: p.label, group: 'With Text Wrapping', active: now === p.id, preview: pageIcon(Math.floor(i / 3), i % 3) })),
    ];
  }, { engine: true }),
};

// ---------------------------------------------------------------------------------------------
// The Layout Options button's menu (pictures.layoutOptionsButton): drawn in the page overlay next to the button.

const MENU = [
  ['h', 'In Line with Text'], ['layout.arrange.wrapText.inLineWithText', 'In Line with Text'],
  ['h', 'With Text Wrapping'], ['layout.arrange.wrapText.square', 'Square'], ['layout.arrange.wrapText.tight', 'Tight'],
  ['layout.arrange.wrapText.through', 'Through'], ['layout.arrange.wrapText.topAndBottom', 'Top and Bottom'],
  ['layout.arrange.wrapText.behindText', 'Behind Text'], ['layout.arrange.wrapText.inFrontOfText', 'In Front of Text'],
  ['sep'], ['layout.arrange.wrapText.moveWithText', 'Move with text'], ['layout.arrange.wrapText.fixPositionOnPage', 'Fix position on page'],
  ['sep'], ['layout.arrange.wrapText.moreLayoutOptions', 'See more...'],
];

function openOptionsMenu(view, btn) {
  const host = btn.parentElement;
  host.querySelector(':scope > [data-fl-menu]')?.remove();
  const menu = host.ownerDocument.createElement('div');
  menu.dataset.flMenu = '';
  menu.setAttribute('role', 'menu');
  menu.style.left = `${btn.offsetLeft + btn.offsetWidth + 4}px`;
  menu.style.top = btn.style.top;
  const o = selectedFloat(view.state);
  const ctxWrap = o ? full(layoutOf(o.node))?.wrap ?? 'inline' : null;
  const moving = o ? full(layoutOf(o.node))?.moveWithText : null;
  for (const [id, label] of MENU) {
    if (id === 'h') {
      menu.insertAdjacentHTML('beforeend', `<b>${label}</b>`);
      continue;
    }
    if (id === 'sep') continue;
    const b = host.ownerDocument.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitemcheckbox');
    b.dataset.feature = id;
    b.textContent = label;
    const item = id.split('.').pop();
    const on = WRAP_ITEMS[item] ? WRAP_ITEMS[item] === ctxWrap : item === 'moveWithText' ? moving === true : item === 'fixPositionOnPage' ? moving === false : false;
    b.setAttribute('aria-checked', String(on));
    if ((item === 'moveWithText' || item === 'fixPositionOnPage') && ctxWrap === 'inline') b.disabled = true;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      close();
      run(id);
    });
    menu.append(b);
  }
  const close = () => {
    menu.remove();
    host.ownerDocument.removeEventListener('mousedown', outside, true);
  };
  const outside = (e) => {
    if (!menu.contains(e.target) && e.target !== btn) close();
  };
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(host.ownerDocument.activeElement);
    if (e.key === 'Escape') {
      close();
      btn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else return;
    e.stopPropagation();
  });
  host.append(menu);
  host.ownerDocument.addEventListener('mousedown', outside, true);
  menu.querySelector('button:not(:disabled)')?.focus();
}
onLayoutOptions(openOptionsMenu);

const FloatLayout = Extension.create({
  name: 'wordFloatLayout',
  addProseMirrorPlugins: () => [floatLayoutPlugin()],
});

export default {
  id: 'float-layout',
  extensions: [FloatLayout],
  passes: [PAGE_WRAP_PASS],
  commands,
  galleries,
  dialogs: { layout: LayoutDialog, frame: FrameDialog },
  implements: [
    'pictures.layoutDialog', 'pictures.layoutOptionsButton', 'pictures.frames', 'marks.anchors', 'paragraph.textboxTightWrap',
    'pictures.alignmentGuides', 'pictures.shapeModifiers',
  ],
};
