// Diagrams on a canvas draft: the Choose a Diagram dialog, the Text Pane, the Layouts and Change Colors galleries and the page
// layer the rows use. src/document/wp/index.js is frozen, so src/document/canvas/index.js spreads SMART_ART_PARTS into its module.
import { createElement as h } from 'react';
import { clickHooks } from '../../../engine/input/pointer.js';
import { both } from '../../../tooling/engine-provider.mjs';
import { THEME } from '../../defaults.mjs';
import { registerOverlay } from '../overlay.jsx';
import { ChooseDialog, ICONS } from './ChooseDialog.jsx';
import { COLORS, LAYOUTS, SHAPE_CHOICES } from './layouts.mjs';
import { ShapesLayer } from './ShapesLayer.jsx';
import { diagramOf, pickItem } from './state.mjs';
import { TextPane } from './TextPane.jsx';

/** Colour variants: small squares in a row, the theme's colour for each slot. */
const Swatches = ({ slots }) => h('span', { className: 'flex gap-0.5' },
  slots.map((s) => h('span', { key: s, className: 'size-3', style: { background: THEME.colors[s] } })));

const tile = (Icon) => h(Icon, { className: 'size-6' });

const GALLERIES = {
  'smartArtDesign.layouts.layouts': both((ctx) => {
    const now = diagramOf(ctx)?.spec.layout;
    return LAYOUTS.map((l) => ({ id: l.id, label: l.label, active: l.id === now,
      preview: h('span', { className: 'flex items-center gap-2' }, h(ICONS[l.icon], { className: 'size-4' }), l.label), tile: tile(ICONS[l.icon]) }));
  }),
  'smartArtDesign.smartArtStyles.changeColors': both((ctx) => {
    const now = diagramOf(ctx)?.spec.colors;
    return COLORS.map((c) => ({ id: c.id, label: c.label, group: c.group, active: c.id === now, preview: h(Swatches, { slots: c.slots }) }));
  }),
  'smartArtFormat.shapes.changeShape': both(() => SHAPE_CHOICES.map((c) => ({ id: c.prst, label: c.name, group: c.group }))),
};

export const SMART_ART_PARTS = {
  dialogs: { chooseASmartArtGraphic: ChooseDialog },
  panes: { smartArtText: { title: 'Type your text here', side: 'left', width: 18, Component: TextPane } },
  galleries: GALLERIES,
};

registerOverlay('smart-art-shapes', ShapesLayer);

// A plain press on a diagram selects it (Word selects the whole graphic), so the caret can leave it and come back. object.at
// gives kind 'graphic' for charts too, so a press selects a chart the same way.
const OBJ = 3; // an object's character (U+FFFC) in the engine's UTF-8 offsets
clickHooks.add(async (client, pos, e, at) => {
  if (!at || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const o = (await client.query('object.at', { page: at.page, x: at.x, y: at.y }))?.value;
  if (o?.kind !== 'graphic') return false;
  pickItem(o.pos, null);
  await client.exec('select.range', { anchor: o.pos, focus: { ...o.pos, off: o.pos.off + OBJ } });
  return true;
});
