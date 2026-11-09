// Work package borders (docs/plans/word/plan.md §3, briefs/borders.md): Home > Borders with its 12 edges, Horizontal Line, Draw
// Table and View Gridlines (run through their owners), Home > Shading, the Borders and Shading dialog (also Table Design's
// launcher), and Word's border drawing (group.js). Gallery items draw in the pen (store word.pen, plan.md §1.12), which
// Borders and Shading's OK writes.
import { createElement as h } from 'react';
import { getState } from '../../../app/store.js';
import { commandOf } from '../../../tooling/registry.js';
import { hooks } from '../../canvas/rows/home.mjs';
import { iconOf } from '../../ribbon/icons.jsx';
import { ITEMS } from '../../ribbon/spec.mjs';
import { BorderOptionsDialog, BordersAndShadingDialog, PageBorderOptionsDialog } from './Dialog.jsx';
import { BorderDrawing } from './group.js';
import { cellHas, cellPatch, DEFAULT_PEN, EDGE_ITEMS, isLine, mirrored, paraHas, paraPatch, runPatch, shadingOf, tablePatch } from './model.mjs';
import { bordersOf, cellList, patchAttr, runBorder, styleBorders, targetOf, write } from './select.js';

const PREFIX = 'home.paragraph.borders';
const DIAGONALS = ['diagonalDownBorder', 'diagonalUpBorder'];
const pen = () => getState().word?.pen ?? DEFAULT_PEN;
hooks.pen = pen; // the canvas rows draw in the same pen

// Split buttons repeat their last pick (Word's): Bottom Border, and No Color until a shading colour is picked.
let lastItem = 'bottomBorder';
let lastShade = null;

/** Whether `item` can act on target `t`: the diagonals only in a table, Inside Vertical only on cells. */
const fits = (item, t) => !!t && (t.kind === 'cells' || (DIAGONALS.includes(item) ? !!t.cell : item !== 'insideVerticalBorder'));

/** The target `item` acts on: text selected in a cell takes the diagonals on that cell. */
const targetFor = (item, t) => (t?.cell && DIAGONALS.includes(item) ? t.cell : t);

/** Whether the selection already has `item`'s edges (its pressed state), read from the lines the cells draw. */
function has(ctx, item) {
  const t0 = targetOf(ctx.state);
  if (!fits(item, t0)) return false;
  const t = targetFor(item, t0);
  if (t.kind === 'run') return item === 'noBorder' ? !isLine(runBorder(ctx.state)) : isLine(runBorder(ctx.state));
  if (t.kind === 'paras') return t.paras.every(({ node }) => paraHas(item, bordersOf(ctx.state.doc, node)));
  return cellHas(item, t.rect, cellList(t));
}

/** Applies Borders gallery item `item` to the selection (paragraphs, a run, cells or a whole table) in the pen. */
function applyItem(ctx, item) {
  const t0 = targetOf(ctx.state);
  if (!fits(item, t0)) return false;
  const t = targetFor(item, t0);
  const p = pen();
  if (t.kind === 'run') return ctx.chain((c) => c.setRunProps({ border: runPatch(item, runBorder(ctx.state), p) }));
  if (t.kind === 'paras') {
    const doc = ctx.state.doc;
    const patches = paraPatch(item, t.paras.map(({ node }) => bordersOf(doc, node)), p, t.paras.map(({ node }) => styleBorders(doc, node)));
    return !!patches && write(ctx, (tr) => t.paras.forEach(({ pos }, i) => patchAttr(tr, pos, 'borders', patches[i].borders)));
  }
  const cells = cellList(t);
  if (t.whole && !DIAGONALS.includes(item)) {
    // The table's edges carry the item; the cells' own edges it covers go, or they would keep drawing over the table's.
    const patch = tablePatch(item, cellHas(item, t.rect, cells, p), p);
    const clear = cellPatch(item, t.rect, cells, p).map((c) => ({ id: c.id, borders: Object.fromEntries(Object.keys(c.borders).map((k) => [k, null])) }));
    return write(ctx, (tr) => {
      patchAttr(tr, t.tablePos, 'borders', patch);
      for (const c of clear) patchAttr(tr, c.id, 'borders', c.borders);
    });
  }
  const patches = mirrored(cellPatch(item, t.rect, cells, p), t.map, t.start);
  return patches.length > 0 && write(ctx, (tr) => patches.forEach((c) => patchAttr(tr, c.id, 'borders', c.borders)));
}

/** Applies shading colour `hex` (null: No Color) to the selection: the cells' fill, the run's or the paragraphs' shading. */
function applyShading(ctx, hex) {
  const t = targetOf(ctx.state);
  if (!t) return false;
  if (t.kind === 'cells') {
    const cells = cellList(t);
    return write(ctx, (tr) => cells.forEach((c) => tr.setNodeAttribute(c.id, 'shading', hex)));
  }
  if (t.kind === 'run') return ctx.chain((c) => c.setRunProps({ shading: shadingOf(hex) }));
  return write(ctx, (tr) => t.paras.forEach(({ pos }) => patchAttr(tr, pos, 'shading', shadingOf(hex))));
}

/** Inserts Word's Horizontal Line after the caret's paragraph: an empty paragraph with only a grey bottom border. */
function horizontalLine(ctx) {
  const { $from } = ctx.state.selection;
  if (!$from.parent.isTextblock) return false;
  const at = $from.after($from.depth);
  const borders = { bottom: { style: 'single', width: 1.5, space: 1, color: '#A0A0A0', shadow: false, frame: false } };
  return ctx.chain((c) => c.insertContentAt(at, { type: 'paragraph', attrs: { borders } }));
}

/** A menu item that runs another package's command and shows its pressed state (Draw Table, View Gridlines). */
const via = (id) => ({ run: (ctx) => ctx.run(id), active: (ctx) => !!commandOf(id)?.active?.(ctx) });

const IconRow = (item) => {
  const it = ITEMS[`${PREFIX}.${item}`];
  return ({ off }) => h('span', { className: 'flex items-center gap-2', 'data-disabled': off || undefined, style: off ? { opacity: 0.4 } : undefined },
    iconOf(it?.icon) ? h(iconOf(it.icon), { className: 'size-4' }) : null, it?.label ?? item);
};
const ROWS = Object.fromEntries(EDGE_ITEMS.map((id) => [id, IconRow(id)]));

const openBorders = (ctx, props) => ctx.dialog('bordersAndShading', props);

/** The 12 edges on a canvas draft: in a table the engine's table.borders kinds, else the paragraphs' (the diagonals and Inside
 * Vertical need cells the engine cannot border one by one yet). */
function canvasEdges(ctx) {
  const cells = !!ctx.engineState?.['document.context']?.value?.table;
  const fit = cells ? ['bottomBorder', 'topBorder', 'leftBorder', 'rightBorder', 'noBorder', 'allBorders', 'outsideBorders', 'insideBorders']
    : EDGE_ITEMS.filter((id) => id !== 'insideVerticalBorder' && !DIAGONALS.includes(id));
  return EDGE_ITEMS.map((id) => {
    const off = !fit.includes(id);
    return { id, label: ITEMS[`${PREFIX}.${id}`]?.label ?? id, preview: h(ROWS[id], { off }) };
  });
}

export default {
  id: 'borders',
  extensions: [BorderDrawing],
  commands: {
    [PREFIX]: {
      run: (ctx, arg) => {
        const item = EDGE_ITEMS.includes(arg) ? arg : lastItem;
        const done = applyItem(ctx, item);
        if (done && EDGE_ITEMS.includes(arg)) lastItem = arg;
        return done;
      },
      enabled: (ctx) => !!targetOf(ctx.state),
      active: (ctx) => has(ctx, lastItem),
      value: () => lastItem,
      icon: () => ITEMS[`${PREFIX}.${lastItem}`]?.icon ?? 'own:borderBottom',
      repeatable: true,
    },
    [`${PREFIX}.horizontalLine`]: { run: horizontalLine, enabled: (ctx) => !!ctx.state?.selection.$from.parent.isTextblock, repeatable: true },
    [`${PREFIX}.drawTable`]: via('tableLayout.draw.drawTable'),
    [`${PREFIX}.viewGridlines`]: via('tableLayout.table.viewGridlines'),
    [`${PREFIX}.bordersAndShading`]: { run: (ctx) => openBorders(ctx, { tab: 'borders' }) },
    'tableDesign.borders.launcher': {
      run: (ctx) => {
        const t = targetOf(ctx.state);
        return openBorders(ctx, { tab: 'borders', apply: t?.kind === 'cells' && !t.whole && cellList(t).length > 1 ? 'cell' : 'table' });
      },
      enabled: (ctx) => ctx.in.table,
    },
    'home.paragraph.shading': {
      run: (ctx, pick) => {
        const hex = pick === undefined ? lastShade : pick && typeof pick === 'object' ? pick.color ?? null : pick;
        const done = applyShading(ctx, hex);
        if (done && pick !== undefined) lastShade = hex;
        return done;
      },
      enabled: (ctx) => !!targetOf(ctx.state),
      value: () => lastShade,
      repeatable: true,
    },
    'home.paragraph.shading.moreColors': {
      run: async (ctx) => {
        const hex = await ctx.dialog('colors', { value: lastShade });
        return hex ? ctx.run('home.paragraph.shading', hex) : false;
      },
    },
  },
  galleries: {
    // The 12 edges (plan.md §1.4 derived items): a pick runs home.paragraph.borders with the item id.
    [PREFIX]: Object.assign((ctx) => {
      if (ctx.engine) return canvasEdges(ctx);
      const t = targetOf(ctx.state);
      return EDGE_ITEMS.map((id) => {
        const off = !fits(id, t);
        return { id, label: ITEMS[`${PREFIX}.${id}`]?.label ?? id, active: !off && has(ctx, id), preview: h(ROWS[id], { off }) };
      });
    }, { engine: true }),
  },
  dialogs: { bordersAndShading: BordersAndShadingDialog, borderAndShadingOptions: BorderOptionsDialog, borderAndShadingOptionsPage: PageBorderOptionsDialog },
  // Word's grouping and distance from text (group.js) deliver the paragraph properties' drawing.
  implements: ['paragraph.borders', 'paragraph.shading'],
};
