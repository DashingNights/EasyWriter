// Work package find (docs/plans/word/plan.md §3 find): Find and Replace, Go To and browse. Home > Editing's Find opens the
// Navigation pane's search (navpane reads store word.navSearch); Advanced Find, Replace and Go To open the modeless Find and Replace
// dialog; Ctrl+PageDown and Ctrl+PageUp browse the last Find or Go To kind, Shift+F4 repeats it.
import { getState, setState } from '../../../app/store.js';
import { browse, DONE, findNext, goTo, last, searchOpts, selectAll } from './actions.js';
import { BrowsePicker, FindDialog, openFindDialog, selectionSeed } from './FindDialog.jsx';
import { searchDoc } from './query.mjs';

/** Find: the Navigation pane with its search box focused and seeded with the selected word (store word.navSearch, §1.12). */
function navFind(ctx) {
  ctx.pane('navigation', true);
  const w = getState().word;
  setState({ word: { ...w, navSearch: { n: (w.navSearch?.n ?? 0) + 1, seed: selectionSeed(ctx.state) } } });
}

const say = (ctx, r) => {
  if (r?.error) ctx.toast(r.error);
  else if (r?.none) ctx.toast('No matches found.');
  else if (r?.done) ctx.toast(DONE);
};

/** Shift+F4: the last Find or Go To again, without the dialog. */
async function repeat(ctx) {
  if (last.kind === 'find') say(ctx, await findNext(ctx));
  else {
    const r = goTo(ctx, last.kind, '', 1);
    if (r !== true) ctx.toast(r);
  }
}

const MARKS = ['bold', 'italic', 'underline', 'strike', 'subscript', 'superscript'];

/** Select All Text With Similar Formatting: every run with the selection's run formatting (G11 multiple selection; until then
 * every run highlighted and the first selected). */
function selectSimilar(ctx) {
  const { state } = ctx;
  const marks = state.storedMarks ?? state.selection.$from.marks();
  const run = Object.fromEntries(MARKS.map((k) => [k, marks.some((m) => m.type.name === k)]));
  for (const [k, v] of Object.entries(marks.find((m) => m.type.name === 'textStyle')?.attrs ?? {})) if (v != null) run[k] = v;
  const opts = { ...searchOpts(ctx), format: { run } };
  selectAll(ctx, searchDoc(state.doc, '', opts).matches, '', opts);
}

/** Ctrl+Alt+Home: the browse object picker; Go To and Find open the dialog, the rest browse that kind. */
async function browseSel(ctx) {
  const id = await ctx.dialog('browseObject');
  if (!id) return;
  if (id === 'goTo' || id === 'find') openFindDialog(ctx, id);
  else {
    last.kind = id;
    browse(ctx, 1);
  }
}

// A canvas draft searches through its engine (actions.js): the dialog, Go To and browse run there too.
const doc = (ctx) => !!ctx.state || !!ctx.engine;

// For the harness case (.smoke-data/word/cases/find.js): the store's navSearch and the last search, which no command shows.
if (typeof window !== 'undefined') window.__word = Object.assign(window.__word ?? {}, { find: () => ({ navSearch: getState().word?.navSearch ?? null, last: { ...last } }) });

export default {
  id: 'find',
  commands: {
    'home.editing.find': { run: navFind, enabled: doc },
    'home.editing.find.find': { run: navFind, enabled: doc },
    'home.editing.find.advancedFind': { run: (ctx) => openFindDialog(ctx, 'find', selectionSeed(ctx.state)), enabled: doc },
    'home.editing.replace': { run: (ctx) => openFindDialog(ctx, 'replace', selectionSeed(ctx.state)), enabled: doc },
    'home.editing.find.goTo': { run: (ctx) => openFindDialog(ctx, 'goTo'), enabled: doc },
    'home.editing.select.selectAllTextWithSimilarFormattingNoData': { run: selectSimilar, enabled: doc },
    'find.repeatFind': { run: repeat, enabled: doc },
    'find.browseNext': { run: (ctx) => browse(ctx, 1), enabled: doc },
    'find.browsePrev': { run: (ctx) => browse(ctx, -1), enabled: doc },
    'find.browseSel': { run: browseSel, enabled: doc },
  },
  dialogs: { findAndReplace: FindDialog, browseObject: BrowsePicker },
  implements: ['find.dialog', 'find.matchCase', 'find.wholeWords', 'find.wildcards', 'find.soundsLike', 'find.allWordForms', 'find.prefixSuffix',
    'find.ignorePunctuation', 'find.direction', 'find.readingHighlight', 'find.findIn', 'find.replaceAll', 'find.format', 'find.special',
    'find.goTo', 'keys.findKey', 'keys.replaceKey', 'keys.goToKey'],
};
