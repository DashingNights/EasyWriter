// The page background work package (docs/plans/word briefs/page-background.md): Design > Page Background (Watermark, Page Color,
// Page Borders) and Draw > Format Background (rule and grid lines, Page Color). Watermarks live in each section's sect, the page
// colour, fill and rule lines in doc.attrs.background; page layers draw them (layers.js) and --page-color on the editor's own
// .page paints the paper, so the assistant's hidden session hosts stay white.
import { createElement as h } from 'react';
import { anyWatermark, backgroundOf, bodyFont, setBackground, setWatermark, watermarkNow } from './apply.js';
import { FillEffectsDialog } from './FillEffectsDialog.jsx';
import { LAYERS } from './layers.js';
import { galleryIdOf, galleryWatermark, isDark, RULE_KINDS, WATERMARK_GALLERY } from './model.mjs';
import { WatermarkDialog } from './WatermarkDialog.jsx';
import { commandOf } from '../../../tooling/registry.js';

const WM = 'design.pageBackground.watermark';
const PC = 'design.pageBackground.pageColor';
const FB = 'draw.edit.formatBackground';

/** Opens dialog `id` when its owner registered it, else says it is not built yet (an unregistered id would open nothing and keep
 * the dialog stack waiting). Imported late: tooling/dialogs.js imports the hub, which imports this module. */
async function openOwned(ctx, id, props) {
  const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js');
  if (!WORD_DIALOGS[id]) {
    ctx.toast('Not built yet.');
    return null;
  }
  return ctx.dialog(id, props);
}

/** A watermark gallery item's small page: the word across it as the watermark lies. */
const preview = (text, layout) => h('span', { className: 'flex items-center gap-3' },
  h('span', {
    'aria-hidden': true,
    className: 'relative grid h-14 w-11 shrink-0 place-items-center overflow-hidden border border-neutral-300 bg-white',
  }, h('span', {
    className: 'text-[6px] font-semibold whitespace-nowrap text-neutral-400',
    style: { transform: layout === 'diagonal' ? 'rotate(315deg)' : 'none' },
  }, text)),
  h('span', null, `${text} ${layout === 'diagonal' ? 1 : 2}`));

const pageColor = {
  run: (ctx, arg) => {
    if (!ctx.ed || !arg || typeof arg !== 'object') return false;
    // A page background is a solid colour or a fill effect, so any pick clears the fill, as Word's does; rule lines stay (Draw's
    // own choice).
    return setBackground(ctx.ed, { color: arg.color ?? null, themeColor: arg.color == null ? null : arg.themeColor ?? null, fill: null });
  },
  value: (ctx) => backgroundOf(ctx.ed).color ?? null,
  enabled: (ctx) => !!ctx.ed,
  repeatable: true,
};
const moreColors = {
  run: async (ctx) => {
    const hex = await ctx.dialog('colors', { value: backgroundOf(ctx.ed).color ?? '#FFFFFF' });
    return hex ? setBackground(ctx.ed, { color: hex, themeColor: null, fill: null }) : false;
  },
  enabled: (ctx) => !!ctx.ed,
};
const fillEffects = { run: (ctx) => ctx.dialog('fillEffects', {}), enabled: (ctx) => !!ctx.ed };

/** A rule or grid kind of Format Background ('none' clears it), checked while it is the page's. */
const rule = (kind) => ({
  run: (ctx) => {
    const full = !!backgroundOf(ctx.ed).rule?.full;
    return setBackground(ctx.ed, { rule: kind !== 'none' || full ? { kind: kind === 'none' ? null : kind, full } : null });
  },
  active: (ctx) => (backgroundOf(ctx.ed).rule?.kind ?? 'none') === kind,
  enabled: (ctx) => !!ctx.ed,
});

const commands = {
  [WM]: {
    run: (ctx, id) => {
      const wm = galleryWatermark(id, bodyFont(ctx.ed));
      return !!wm && setWatermark(ctx.ed, wm);
    },
    value: (ctx) => galleryIdOf(watermarkNow(ctx.ed)),
    enabled: (ctx) => !!ctx.ed,
  },
  [`${WM}.customWatermark`]: { run: (ctx) => ctx.dialog('printedWatermark', {}), enabled: (ctx) => !!ctx.ed },
  [`${WM}.removeWatermark`]: {
    run: (ctx) => setWatermark(ctx.ed, null),
    enabled: (ctx) => anyWatermark(ctx.ed),
    reason: () => 'This document has no watermark.',
  },
  // building-blocks registers Save Selection to Watermark Gallery (it owns that command and its dialog).
  [PC]: pageColor,
  [`${PC}.moreColors`]: moreColors,
  [`${PC}.fillEffects`]: fillEffects,
  // borders owns Borders and Shading and its Page Border tab, which writes sect.pgBorders; this package draws them.
  'design.pageBackground.pageBorders': { run: (ctx) => openOwned(ctx, 'bordersAndShading', { tab: 'pageBorder' }), enabled: (ctx) => !!ctx.ed },
  [`${FB}.none`]: rule('none'),
  ...Object.fromEntries(RULE_KINDS.map((k) => [`${FB}.${k}`, rule(k)])),
  [`${FB}.applyToFullPage`]: {
    run: (ctx) => {
      const r = backgroundOf(ctx.ed).rule;
      return setBackground(ctx.ed, { rule: { kind: r?.kind ?? null, full: !r?.full } });
    },
    active: (ctx) => !!backgroundOf(ctx.ed).rule?.full,
    // Enabled with None checked, as in Word: the choice waits in {kind: null, full} for the next rule kind.
    enabled: (ctx) => !!ctx.ed,
  },
  [`${FB}.pageColor`]: pageColor,
  [`${FB}.pageColor.moreColors`]: moreColors,
  [`${FB}.pageColor.fillEffects`]: fillEffects,
};

const galleries = {
  // On a canvas draft the current one is the engine row's value (src/document/canvas/rows/page.mjs).
  [WM]: Object.assign((ctx) => {
    const now = ctx.engine ? commandOf(WM)?.value?.(ctx) : galleryIdOf(watermarkNow(ctx.ed));
    return WATERMARK_GALLERY.flatMap(([group, items]) => items.map(([id, text, layout]) => ({
      id, label: `${text} ${layout === 'diagonal' ? 1 : 2}`, group, active: id === now, preview: preview(text, layout),
    })));
  }, { engine: true }),
};

/** Paints the editor's own sheet: --page-color while the page colour shows (each page's paper and, without pages, the sheet
 * read it) and automatic text white on a dark page (v). */
function setup(editor) {
  const page = editor.view.dom.closest('.page');
  if (!page) return undefined;
  let last; // undefined, so the first sync always runs
  const sync = () => {
    const { doc } = editor.state;
    const b = doc.attrs.background ?? null;
    const color = doc.attrs.settings?.displayBackground && b?.color ? b.color : null;
    if (color === last) return;
    last = color;
    if (color) page.style.setProperty('--page-color', color);
    else page.style.removeProperty('--page-color');
    page.toggleAttribute('data-pb-dark', isDark(color));
  };
  sync();
  editor.on('transaction', sync);
  return () => {
    editor.off('transaction', sync);
    page.style.removeProperty('--page-color');
    page.removeAttribute('data-pb-dark');
  };
}

export default {
  id: 'page-background',
  commands,
  galleries,
  dialogs: { printedWatermark: WatermarkDialog, fillEffects: FillEffectsDialog },
  layers: LAYERS,
  setup,
  // The Options page writes print.background; this package's print rules read it through html[data-print-bg] (style.css).
  implements: ['print.background'],
};
