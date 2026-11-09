// Diagrams (Word's SmartArt) on a canvas draft: the rows of the Diagram Design and Format tabs that are not shared with shapes.
// The shared rows are in objects.mjs (fill, outline, size) and act on a diagram too. Pure: node tests load it.
import { getState } from '../../../app/store.js';
import { diagramLook, diagramNow, diagramOf, pickItem, pickedOf } from '../smart-art/state.mjs';
import { addAbove, addAfter, addBefore, addBelow, canDemote, canPromote, moveAfter, moveBefore } from '../smart-art/outline.mjs';
import { hexOf, run1, spec } from './objects.mjs';
import { exec } from './forms.mjs';

const FOREIGN = 'This diagram was made in another program. EasyWriter shows it but cannot edit it.';
const PICK = 'Select a diagram first.';

/** A row that needs an editable diagram selected, and `need(ctx)` besides. */
export const diagramRow = (run, { need = () => true, active, value } = {}) => ({
  run,
  enabled: (ctx) => !!ctx.engine && !!diagramOf(ctx) && need(ctx),
  reason: (ctx) => (diagramOf(ctx) ? null : ctx.obj?.kind === 'smartArt' ? FOREIGN : PICK),
  ...(active && { active }),
  ...(value && { value }),
});

const paneShown = (id) => Object.values(getState().panes ?? {}).includes(id);

/** A row that opens or closes pane `id`. */
export const paneRow = (id, options = {}) => spec((ctx) => {
  ctx.pane(id, !paneShown(id));
  return true;
}, { active: () => paneShown(id), ...options });

const itemsOf = (d) => d.spec.items;

/** A row for an outline edit: `op(items, picked)` from outline.mjs. Disabled when it cannot be done now. */
const outlineRow = (op, { hierarchyOnly = false, also = () => true } = {}) => diagramRow(async (ctx) => {
  const d = await diagramNow(ctx);
  const r = d && op(itemsOf(d), pickedOf(d));
  if (!r) return false;
  const done = await run1(ctx, 'smartArt.items', { items: r.items });
  if (done) pickItem(d.pos, r.at);
  return done;
}, { need: (ctx) => {
  const d = diagramOf(ctx);
  return !!d && also(ctx, d) && !!op(itemsOf(d), pickedOf(d)) && (!hierarchyOnly || d.spec.layout === 'hierarchy');
} });

const levelRow = (id, can) => diagramRow(async (ctx) => {
  const d = await diagramNow(ctx);
  return !!d && pickedOf(d) != null && run1(ctx, id, { index: pickedOf(d) });
}, { need: (ctx) => {
  const d = diagramOf(ctx);
  return !!d && can(itemsOf(d), pickedOf(d));
} });

const STEP = 10; // percent one press of Larger or Smaller changes a shape. Not probed: Word's own step may differ.
const MIN = 50;
const MAX = 300;

const sizeRow = (dir) => diagramRow(async (ctx) => {
  const d = await diagramNow(ctx);
  const i = pickedOf(d);
  if (i == null) return false;
  const now = d.spec.items[i].look?.scale ?? 100;
  const scale = Math.min(MAX, Math.max(MIN, now + dir * STEP));
  return scale !== now && diagramLook(ctx, { scale });
}, { need: (ctx) => pickedOf(diagramOf(ctx)) != null });

let lastText = '000000';
const textFill = (ctx, arg) => {
  const color = arg === undefined ? lastText : hexOf(arg);
  if (color) lastText = color;
  return diagramLook(ctx, { textColor: color }); // null is Automatic: the layout's text colour
};

const CG = 'smartArtDesign.createGraphic';
const layoutPick = async (ctx, now) => {
  const id = await ctx.dialog('chooseASmartArtGraphic', { value: now });
  return id ?? null;
};

export const SMART_ART = {
  'insert.illustrations.smartArt': spec(async (ctx) => {
    const layout = await layoutPick(ctx, 'basicList');
    return !!layout && run1(ctx, 'insert.smartArt', { layout });
  }),
  [`${CG}.addShape`]: outlineRow(addAfter),
  [`${CG}.addShape.addShapeAfter`]: outlineRow(addAfter),
  [`${CG}.addShape.addShapeBefore`]: outlineRow(addBefore),
  [`${CG}.addShape.addShapeAbove`]: outlineRow(addAbove, { hierarchyOnly: true }),
  [`${CG}.addShape.addShapeBelow`]: outlineRow(addBelow, { hierarchyOnly: true }),
  // A child of a hierarchy item is a shape there, so Add Bullet stays off on that layout.
  [`${CG}.addBullet`]: outlineRow(addBelow, { also: (ctx, d) => d.spec.layout !== 'hierarchy' }),
  [`${CG}.textPane`]: paneRow('smartArtText', { need: (ctx) => ctx.obj?.kind === 'smartArt', reason: 'Select a diagram first.' }),
  [`${CG}.promote`]: levelRow('smartArt.promote', canPromote),
  [`${CG}.demote`]: levelRow('smartArt.demote', canDemote),
  [`${CG}.moveBefore`]: outlineRow(moveBefore),
  [`${CG}.moveAfter`]: outlineRow(moveAfter),
  'smartArtDesign.layouts.layouts': exec('smartArt.layout', (id) => (id ? { layout: id } : null)),
  'smartArtDesign.layouts.layouts.moreLayouts': diagramRow(async (ctx) => {
    const d = await diagramNow(ctx);
    const layout = d && await layoutPick(ctx, d.spec.layout);
    return !!layout && run1(ctx, 'smartArt.layout', { layout });
  }),
  'smartArtDesign.smartArtStyles.changeColors': exec('smartArt.colors', (id) => (id ? { variant: id } : null)),

  'smartArtDesign.createGraphic.rightToLeft': diagramRow(async (ctx) => {
    const d = await diagramNow(ctx);
    return !!d && run1(ctx, 'smartArt.layout', { rtl: !d.spec.rtl });
  }, { active: (ctx) => !!diagramOf(ctx)?.spec.rtl }),
  'smartArtDesign.reset.resetGraphic': diagramRow((ctx) => run1(ctx, 'smartArt.reset')),
  'smartArtFormat.accessibility.altText': paneRow('altText', { need: (ctx) => !!ctx.obj, reason: 'Select a diagram first.' }),

  // The Format tab's own looks. Shape Fill, Shape Outline and Shape Styles run their shape rows in objects.mjs (the spec's cmd
  // aliases), which act on a diagram too.
  'smartArtFormat.shapes.changeShape': diagramRow((ctx, prst) => (prst ? diagramLook(ctx, { shape: String(prst) }) : true)),
  'smartArtFormat.shapes.larger': sizeRow(1),
  'smartArtFormat.shapes.smaller': sizeRow(-1),
  'smartArtFormat.wordArtStyles.textFill': diagramRow(textFill, { value: () => `#${lastText}` }),
  'smartArtFormat.wordArtStyles.textFill.moreFillColors': diagramRow(async (ctx) => {
    const r = await ctx.dialog('colors', { value: `#${lastText}` });
    return !!hexOf(r) && textFill(ctx, r);
  }),
};
