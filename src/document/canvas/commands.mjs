// The Documents table of docs/plans/engine/viewport-design.md section 4.7: a tooling id (the one the ribbon, tool search and Word's
// keys use) → what it does on a canvas draft, in the row forms of rows/forms.mjs. The registry's ctx.engine runs it and reads its
// state; a granted tooling id missing here shows disabled with its reason (src/tooling/reasons.mjs `engine`), and an engine
// command no row names cannot be reached from the tools. CORE is the scaffold's and frozen after it; each stage-2 package fills
// its own row file (docs/plans/engine/stage2.md "How the table splits"). sessionRows below are rows that run on the draft's
// session itself (Print and Create PDF). Pure: node tests load it.
import { base64 } from '../../tooling/base64.mjs';
import { CHARTS } from './rows/charts.mjs';
import { APP } from './rows/forms.mjs';
import { HOME } from './rows/home.mjs';
import { OBJECTS } from './rows/objects.mjs';
import { PAGE } from './rows/page.mjs';
import { REFERENCES } from './rows/references.mjs';
import { REVIEW } from './rows/review.mjs';
import { SMART_ART } from './rows/smart-art.mjs';

export { APP };

/** The rows every package shares: Home's first toggles, the app's own commands (the switch, tool search, the zoom the page area
 * follows, the ribbon's display, the windows) and the board and plan chart pools, which act on the box edit mode's board and
 * chart (app/pool-board.js, app/pool-plan.js), not on the draft. */
export const CORE = {
  'home.font.bold': 'format.bold',
  'home.font.italic': 'format.italic',
  'home.paragraph.alignLeft': 'para.alignLeft',
  'home.paragraph.center': 'para.alignCenter',
  'home.paragraph.alignRight': 'para.alignRight',
  'home.paragraph.justify': 'para.justify',
  'view.canvasEngine': APP, // turning the canvas off must work from the canvas
  'view.onePageRow': APP,
  'frame.titleBar.search': APP,
  ...Object.fromEntries([
    'view.zoom.zoom', 'view.zoom.zoom100', 'view.zoom.onePage', 'view.zoom.pageWidth', 'view.zoom.multiplePages', 'views.zoomIn',
    'views.zoomOut', 'statusBar.zoomSlider', 'frame.tabRow.collapse', 'frame.tabRow.ribbonDisplayOptions.showTabsOnly',
    'frame.tabRow.ribbonDisplayOptions.alwaysShowRibbon', 'frame.tabRow.ribbonDisplayOptions.fullScreenMode',
    'frame.tabRow.ribbonDisplayOptions.hideQuickAccessToolbar', 'window.nextWindow', 'window.prevWindow', 'view.window.switchWindows',
    'board.*', 'plan.chart.*', 'plan.open',
  ].map((id) => [id, APP])),
};

/** {toolingId: row}: the scaffold's rows and the six packages' (rows/*.mjs; their keys never overlap, rows.test). */
export const ENGINE_COMMANDS = { ...CORE, ...HOME, ...OBJECTS, ...PAGE, ...REFERENCES, ...REVIEW, ...CHARTS, ...SMART_ART };

/** The rows whose command runs on the draft's session itself rather than as one engine command (viewport-design.md P14b and
 * section 8): Print, Quick Print and Export > Create PDF go through the engine's PDF, which the helper worker makes, so the
 * drafts keep painting meanwhile. index.js adds them to the table with the app's side, `app`: {title() → the draft's title,
 * saveFile({name, data, filters}) → the saved path or null (api.word.saveFile, data in base64), notice(families) for a PDF that
 * drew font families as outlines, error(text)}. */
export function sessionRows(app) {
  const enabled = (ctx) => !!ctx.engine;
  /** Every page as one print job; `printer` holds word.print's options: none opens the print dialog, {silent} is Quick Print's
   * one copy to the default printer. */
  const print = (printer) => async (ctx) => {
    const r = await ctx.engine.print({}, printer).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
    if (!r.ok && r.error && !/cancel/i.test(r.error)) app.error(`Could not print: ${r.error}`);
    return r.ok;
  };
  return {
    'file.print': { enabled, run: print({}) },
    'print.quickPrint': { enabled, run: print({ silent: true }) },
    'file.export.pdf': {
      enabled,
      run: async (ctx) => {
        try {
          const r = await ctx.engine.pdf({});
          const name = `${(app.title() || 'Document').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.pdf`;
          const path = await app.saveFile({ name, data: base64(r.bytes), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
          if (path && r.outlined?.length) app.notice(r.outlined);
          return path;
        } catch (e) {
          app.error(`Could not make the PDF: ${e?.message ?? e}`);
          return null;
        }
      },
    },
  };
}
