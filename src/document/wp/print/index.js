// Print, preview and PDF (docs/plans/word/briefs/print.md): the Print backstage page, Ctrl+P and its other keys (keymap rows of
// file.print), Quick Print, Export > Create PDF/XPS, and the print options settings.word.print holds.
import { openBackstage } from '../../ribbon/Backstage.jsx';
import { PrintPage } from './PrintPage.jsx';
import { geometryOf } from '../../geometry.js';
import { exportPdf, opts, printDocument } from './printing.js';

// Pages exist only in Print Layout (and Focus); Word prints the print layout from any view, so the Print page switches to it.
const toPages = (ctx) => ctx.view !== 'print' && ctx.view !== 'focus' && ctx.run('view.views.printLayout');
/** Calls `fn` once pagination has laid out pages after a switch to Print Layout (up to about a second), so a job never plans on
 * a view without pages. */
const afterPages = (ctx, fn, tries = 60) => requestAnimationFrame(() => (
  geometryOf(ctx.ed.view.state)?.pages.length || tries <= 0 ? fn() : afterPages(ctx, fn, tries - 1)));
const hasDoc = (ctx) => !!ctx.ed?.view;
const QUICK = { copies: 1, printer: null, what: 'all', text: '', odd: false, even: false, sides: 'one', collate: true, perSheet: 1 };

export default {
  id: 'print',
  commands: {
    // arg {selection: true} opens the page with Print Selection chosen (navpane's Print Heading and Content).
    'file.print': {
      enabled: hasDoc,
      run: (ctx, arg) => {
        toPages(ctx);
        if (arg?.selection) Object.assign(opts, { what: 'selection', text: '' });
        openBackstage('file.print');
        return true;
      },
    },
    'print.quickPrint': {
      enabled: hasDoc,
      run: (ctx) => {
        toPages(ctx);
        // Quick Print sends one copy of every page to the default printer, whatever the Print page holds, as Word's does.
        afterPages(ctx, () => printDocument(ctx.ed, QUICK, { silent: true }));
        return true;
      },
    },
    'file.export.pdf': {
      enabled: hasDoc,
      run: (ctx) => {
        toPages(ctx);
        // Word's Create PDF has its own options (every page by default), apart from the Print page's. Its range and markup
        // choices wait for the backstage's Export page; until then it makes every page.
        afterPages(ctx, () => exportPdf(ctx.ed, QUICK));
        return true;
      },
    },
  },
  backstage: { 'file.print': PrintPage },
  implements: [
    'print.printKey', 'print.previewKeys', 'print.hiddenText', 'print.properties', 'file.print.settings.pages', 'file.print.settings.sides',
    'file.print.settings.collated', 'file.print.settings.orientation', 'file.print.settings.paper', 'file.print.settings.margins',
    'file.print.settings.pagesPerSheet', 'file.print.preview', 'file.print.pageSetupLink', 'sections.twoPagesPerSheet', 'sections.bookFold',
    'fieldsUi.updateBeforePrint',
  ],
};
