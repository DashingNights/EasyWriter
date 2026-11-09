import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// cover() (src/document/ribbon/search.js, docs/plans/word/plan.md §1.14): in a Document a covered entry runs its Word command and
// offers the Word options, except where that would act on the wrong thing or draw nothing. node cannot load icons.jsx, so
// stand-ins replace its RibbonIcon and iconOf, and the kit's Spin.
const STUBS = {
  '/ribbon/icons.jsx': 'export const RibbonIcon = () => null; export const iconOf = () => null;',
  '/kit/controls.jsx': 'export const Spin = () => null;',
  // document/tools.js pulls in the app's React modules: search.js needs only inDocument.
  '/document/tools.js': "import { getState } from '../app/store.js'; export const inDocument = () => getState().draft?.format === 'document';",
};
registerHooks({
  load: (url, ctx, next) => {
    const stub = Object.keys(STUBS).find((k) => url.endsWith(k));
    return stub ? { format: 'module', source: STUBS[stub], shortCircuit: true } : next(url, ctx);
  },
});
const { cover, WORD_TOOLS } = await import('../src/document/ribbon/search.js');
const { MENUS } = await import('../src/document/ribbon/spec.mjs');
const { register, registerModule, setMenuView } = await import('../src/tooling/registry.js');
const { setState } = await import('../src/app/store.js');

// A Document is open in the editor, so the Document profile grants the Word commands.
setState({ editor: {}, view: { type: 'editor' }, draft: { format: 'document' }, settings: {} });
register('word-search-test', {
  'frame.qat.undo': { run: () => 'word undo' },
  'layout.pageSetup.margins.narrowMargins': { run: () => {} },
  // Page Number's built commands: the top-of-page submenu's gallery and the others are still empty.
  'insert.headerFooter.pageNumber.topOfPage': { run: () => {} },
  'insert.headerFooter.pageNumber.removePageNumbers': { run: () => {} },
  'layout.pageSetup.breaks': { run: () => false },
  'layout.paragraph.indentLeft': { value: () => 36, run: () => {} },
});
registerModule({ id: 'word-search-test-panels', panels: { shading: () => null } });
const word = (id) => WORD_TOOLS.find((t) => t.id === `w-${id}`);

test('Undo runs the Word command on the text but the board\'s own undo while a canvas is edited', () => {
  const undo = cover({ id: 'undo', run: (c) => (c.board ? c.board.undo() : 'text undo') });
  assert.equal(undo.run({}), 'word undo');
  assert.equal(undo.run({ board: { undo: () => 'board undo' } }), 'board undo');
});

test('a covered entry keeps its own options where the Word menu would draw nothing', () => {
  setMenuView(() => null);
  const own = 'FontBox';
  const font = cover({ id: 'doc-font', run: () => {}, options: () => own });
  assert.equal(font.options({}), own, 'Font: a gallery no package fills');
  const margins = cover({ id: 'doc-margins', run: () => {}, options: () => own });
  const el = margins.options({});
  assert.equal(el.props.menu, 'layout.pageSetup.margins', 'Margins: the ribbon menu has items');
  assert.equal(el.props.cmd, 'layout.pageSetup.margins');
  assert.ok(el.props.ctx);
  assert.ok(el.props.spec.MENUS, 'the spec goes along: the ribbon shares its own only once it is drawn');
  const pageNumber = cover({ id: 'doc-page-number', run: () => {}, options: () => own });
  assert.equal(pageNumber.options({}), own, 'Page Number: its submenus draw empty galleries, Remove alone does not count');
  const shading = cover({ id: 'doc-cell-shading', run: () => {}, options: () => own }).options({});
  assert.equal(shading.props.cmd, 'tableDesign.tableStyles.shading', 'Cell shading picks run the shading command, not the font colour');
  // The shading panel passes a hex string or null; the colour panel passes {color, themeColor}, which a cell cannot store.
  assert.equal(MENUS['tableDesign.tableStyles.shading'][0].panel, 'shading');
  setMenuView(null);
});

test('Enter on a dropdown or spin box opens its options; a button runs', () => {
  // Breaks has no action of its own: Enter opens its options, and runs it only when they draw nothing (no MenuView).
  assert.equal(word('layout.pageSetup.breaks').optionsFirst, true);
  assert.equal(typeof word('layout.pageSetup.breaks').run, 'function');
  assert.equal(word('layout.pageSetup.breaks').options({}), null, 'no MenuView: no options, so Enter runs');
  assert.equal(typeof word('insert.pages.blankPage').run, 'function');
  assert.equal(typeof word('home.paragraph.numbering.defineNewNumberFormat')?.run, 'function', 'menu items run');
  const spin = word('layout.paragraph.indentLeft');
  assert.equal(spin.optionsFirst, true);
  const el = spin.options({});
  assert.equal(el.props.unit, 'len');
  assert.equal(el.props.value, 36);
});
