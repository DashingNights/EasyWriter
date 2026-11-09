// building-blocks (docs/plans/word plan.md §3, briefs/building-blocks.md): the building blocks store, the Quick Parts menu with
// AutoText, F3, Alt+F3 and AutoComplete, Create New Building Block and the Organizer, every Save Selection to ... Gallery item,
// our own cover pages and Quick Tables, user blocks in other packages' galleries (providers concatenate by gallery id, §1.2) and
// the AUTOTEXT, AUTOTEXTLIST and GLOSSARY fields.
import { createElement as h } from 'react';
import { BLOCK_GALLERIES } from '../../ribbon/spec.mjs';
import { both } from '../../../tooling/engine-provider.mjs';
import { ctxOf } from '../../../tooling/registry.js';
import { AutoComplete } from './autocomplete.js';
import { autoTextResult, flatText, matchAutoText } from './blocks.mjs';
import { BuildingBlocksOrganizer, CreateBuildingBlock, CreateNewCategory } from './dialogs.jsx';
import { COVERS, QUICK_TABLES } from './designs.mjs';
import { coverOf, insertContent, insertEntry, placeCover, removeCover, selectionBlock } from './insert.js';
import { FILE_GALLERIES } from './doc-blocks.mjs';
import { allEntries, reload, setSchema } from './store.js';
import { autoTextF3 as canvasF3, pickUserEntry, userGalleryItems } from './canvas.js';
import { hooks as canvasRows } from '../../canvas/rows/references.mjs';

canvasRows.autoTextF3 = async (ctx) => (await reload(), canvasF3(ctx));
canvasRows.pickUserBlock = pickUserEntry;

/** The building blocks `ctx` sees: its document's own, then the stored ones. */
const listOf = (ctx) => allEntries(ctx?.ed?.state.doc);

/** One line of an entry's text under its name, for menu rows. */
const preview = (label, text, swatch) => h('span', { className: 'flex min-w-0 items-center gap-2' },
  swatch && h('span', { className: 'size-4 shrink-0 rounded-sm', style: { background: swatch } }),
  h('span', { className: 'flex min-w-0 flex-col' }, h('span', { className: 'truncate' }, label),
    text && h('span', { className: 'max-w-72 truncate text-xs text-muted-foreground' }, text)));

/** On a canvas draft: the document's own blocks of Word gallery `gallery`, from the engine (insert.buildingBlocks), then the
 * user's, pasted as HTML (canvas.js, engine-gaps-rest). */
const engineItems = (gallery, ctx) => [...(ctx.read('insert.buildingBlocks') ?? [])
  .filter((b) => (FILE_GALLERIES[b.gallery] ?? b.gallery) === gallery)
  .map((b) => ({ id: `eb:${b.gallery}:${b.name}`, label: b.name, group: b.category, preview: preview(b.name, b.description),
    run: (c) => c.engine.exec('insert.buildingBlock', { name: b.name, gallery: b.gallery }) })),
...userGalleryItems(gallery, preview, flatText)];

/** The document's and the user's blocks of Word gallery `gallery` as GalleryItems grouped by category, General first (plan.md §1.4 GalleryItem.run). */
const userItems = (gallery) => both((ctx) => (ctx.engine ? engineItems(gallery, ctx) : listOf(ctx)
  .filter((e) => e.gallery === gallery)
  .sort((a, b) => (a.category !== b.category ? (a.category === 'General' ? -1 : b.category === 'General' ? 1 : a.category.localeCompare(b.category)) : a.name.localeCompare(b.name)))
  .map((e) => ({ id: `bb:${e.id}`, label: e.name, group: e.category, preview: preview(e.name, flatText(e.content).slice(0, 60)), run: (ctx) => insertEntry(ctx, e) }))));

const entryOf = (ctx, arg) => (typeof arg === 'string' && arg.startsWith('bb:') ? listOf(ctx).find((e) => `bb:${e.id}` === arg) : null);
/** Runs a gallery pick `arg` that names a user block. */
const pickEntry = (ctx, arg) => {
  const e = entryOf(ctx, arg);
  return e ? insertEntry(ctx, e) : false;
};

const REASONS = {
  'Text Boxes': 'Select a text box first.', Equations: 'Select an equation first.', 'Table of Contents': 'Put the cursor in a table of contents first.',
  Bibliographies: 'Put the cursor in a bibliography first.', Watermarks: 'This section has no watermark to save.',
};
/** A Save Selection to `gallery` item: Create New Building Block with that gallery, enabled while the selection fits. */
const saveTo = (gallery) => ({
  run: (ctx) => ctx.dialog('createNewBuildingBlock', { gallery }),
  enabled: (ctx) => !!selectionBlock(ctx, gallery),
  reason: () => REASONS[gallery] ?? 'Select what to save first.',
});

/** F3 and Ctrl+Alt+Shift+V: the AutoText entry named by the text before the caret replaces it. */
function autoTextF3(ctx) {
  const st = ctx.state;
  if (!st?.selection.empty) return false;
  const { $from } = st.selection;
  const before = $from.parent.textBetween(0, $from.parentOffset, null, '￼');
  const hit = matchAutoText(listOf(ctx), before);
  if (hit.error) {
    ctx.toast(hit.error === 'ambiguous' ? 'More than one building block starts with that text. Type more of the name.' : 'No building block has that name.');
    return true;
  }
  return insertEntry(ctx, hit.entry, { from: $from.pos - (before.length - hit.start), to: $from.pos });
}

const commands = {
  'editing.autoTextF3': { run: autoTextF3 },
  'editing.createBuildingBlock': saveTo('AutoText'),
  'insert.text.quickParts': { run: pickEntry },
  'insert.text.quickParts.autoText': { run: pickEntry },
  'insert.text.quickParts.autoText.saveSelectionToAutoTextGallery': saveTo('AutoText'),
  'insert.text.quickParts.buildingBlocksOrganizer': { run: (ctx) => ctx.dialog('buildingBlocksOrganizer') },
  'insert.text.quickParts.saveSelectionToQuickPartGallery': saveTo('Quick Parts'),
  'insert.pages.coverPage': { run: (ctx, arg) => (COVERS[arg] ? placeCover(ctx, COVERS[arg].blocks()) : pickEntry(ctx, arg)) },
  'insert.pages.coverPage.removeCurrentCoverPage': {
    run: removeCover,
    enabled: (ctx) => !!ctx.ed && !!coverOf(ctx.ed.state.doc),
    reason: () => 'This document has no cover page.',
  },
  'insert.pages.coverPage.saveSelectionToCoverPageGallery': saveTo('Cover Pages'),
  'insert.tables.table.quickTables': {
    run: (ctx, arg) => (QUICK_TABLES[arg] ? insertContent(ctx, QUICK_TABLES[arg].blocks(new Date()), 'paragraph') : pickEntry(ctx, arg)),
  },
  'insert.tables.table.quickTables.saveSelectionToQuickTablesGallery': saveTo('Tables'),
  'insert.headerFooter.header.saveSelectionToHeaderGallery': saveTo('Headers'),
  'insert.headerFooter.footer.saveSelectionToFooterGallery': saveTo('Footers'),
  'insert.headerFooter.pageNumber.topOfPage.saveSelectionAsPageNumberTop': saveTo('Page Numbers (Top of Page)'),
  'insert.headerFooter.pageNumber.bottomOfPage.saveSelectionAsPageNumberBottom': saveTo('Page Numbers (Bottom of Page)'),
  'insert.headerFooter.pageNumber.pageMargins.saveSelectionAsPageNumberMargin': saveTo('Page Numbers (Margins)'),
  'insert.headerFooter.pageNumber.currentPosition.saveSelectionToPageNumberGallery': saveTo('Page Numbers'),
  'insert.text.textBox.saveSelectionToTextBoxGallery': saveTo('Text Boxes'),
  'design.pageBackground.watermark.saveSelectionToWatermarkGallery': saveTo('Watermarks'),
  'insert.symbols.equation.saveSelectionToEquationGallery': saveTo('Equations'),
  'equation.tools.equation.saveSelectionToEquationGallery': saveTo('Equations'),
  'references.tableOfContents.tableOfContents.saveSelectionToTableOfContentsGallery': saveTo('Table of Contents'),
  'references.citationsBibliography.bibliography.saveSelectionToBibliographyGallery': saveTo('Bibliographies'),
};

// Built-in items of our own galleries, then the user's blocks.
const builtIn = (designs, swatch) => Object.entries(designs).map(([id, d]) => ({ id, label: d.label, group: 'Built-In', preview: preview(d.label, null, swatch && d.colour) }));
const galleries = Object.fromEntries(Object.entries(BLOCK_GALLERIES).map(([name, id]) => [id, userItems(name)]));
galleries['insert.pages.coverPage'] = both((ctx) => [...builtIn(COVERS, true), ...userItems('Cover Pages')(ctx)]);
galleries['insert.tables.table.quickTables'] = both((ctx) => [...builtIn(QUICK_TABLES), ...userItems('Tables')(ctx)]);
galleries['equation.tools.equation'] = userItems('Equations'); // the Equation tab's gallery shows the same blocks

// The Save Selection to <Gallery> dialog ids of plan.md §1.6: Create New Building Block with that gallery preset.
const preset = (gallery) => (props) => h(CreateBuildingBlock, { gallery, ...props });
const SAVE_DIALOGS = {
  saveSelectionToHeaderGallery: 'Headers', saveSelectionToFooterGallery: 'Footers', saveSelectionToTextBoxGallery: 'Text Boxes',
  saveSelectionToWatermarkGallery: 'Watermarks', saveSelectionToEquationGallery: 'Equations', saveSelectionToTableOfContentsGallery: 'Table of Contents',
  saveSelectionToBibliographyGallery: 'Bibliographies', saveSelectionToCoverPageGallery: 'Cover Pages', saveSelectionToQuickPartGallery: 'Quick Parts',
};

/** The style a block starts in (its first paragraph's), for AUTOTEXTLIST's \s match. */
const styleOfBlock = (b) => (b?.type === 'heading' ? `Heading${b.attrs?.level ?? 1}` : b?.attrs?.styleId ?? 'Normal');

/** A small pick list at (x, y) for AUTOTEXTLIST's right-click; `onPick(item)` gets the choice. */
function pickList(x, y, items, onPick) {
  const menu = document.createElement('div');
  menu.setAttribute('data-bb-pick', '');
  menu.setAttribute('role', 'menu');
  menu.className = 'fixed z-50 flex min-w-40 flex-col rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md';
  Object.assign(menu.style, { left: `${x}px`, top: `${y}px` });
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', outside, true);
  };
  const outside = (e) => !menu.contains(e.target) && close();
  if (!items.length) menu.append(Object.assign(document.createElement('div'), { className: 'px-2 py-1 text-muted-foreground', textContent: 'No AutoText entries in this style' }));
  for (const it of items) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: it.name, className: 'rounded-sm px-2 py-1 text-left hover:bg-accent' });
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => {
      close();
      onPick(it);
    });
    menu.append(b);
  }
  document.body.append(menu);
  document.addEventListener('mousedown', outside, true);
}

const AUTOTEXT = { category: 'Links and References', updates: 'manual', compute: (f) => autoTextResult(listOf(ctxOf()), f.args[0]) };
const fields = {
  AUTOTEXT,
  GLOSSARY: AUTOTEXT,
  AUTOTEXTLIST: {
    category: 'Links and References',
    updates: 'manual',
    compute: (f) => f.args[0] ?? '',
    // The \t tip on hover; the text is the literal or the last pick.
    // The node comes from the drawing view's doc (ctx.doc): the editor's state is not this view's yet while a new document's node
    // views draw, and the imported result (Word's "Right-click for the AutoText entries") was drawn empty.
    draw: (f, ctx, el, api) => {
      const pos = api?.getPos?.();
      el.textContent = (pos != null ? (ctx?.doc ?? api.editor?.state.doc)?.nodeAt(pos)?.attrs.result : null) ?? f.args[0] ?? '';
      if (typeof f.sw.t === 'string') el.title = f.sw.t;
    },
    // Right-click: the AutoText entries whose first paragraph has the \s style (else the field paragraph's); a pick is the result.
    click: (f, ctx, api) => {
      if (!api.event) return false;
      const pos = api.getPos();
      const style = typeof f.sw.s === 'string' ? f.sw.s : (api.editor.state.doc.resolve(pos).parent.attrs.styleId ?? 'Normal');
      const list = listOf(ctxOf()).filter((e) => e.gallery === 'AutoText' && styleOfBlock(e.content[0]) === style);
      api.event.preventDefault?.();
      pickList(api.event.clientX, api.event.clientY, list, (e) => api.setAttrs({ result: flatText(e.content) }));
      return true;
    },
  },
};

export default {
  id: 'building-blocks',
  commands,
  galleries,
  dialogs: {
    createNewBuildingBlock: CreateBuildingBlock,
    buildingBlocksOrganizer: BuildingBlocksOrganizer,
    createNewCategory: CreateNewCategory,
    ...Object.fromEntries(Object.entries(SAVE_DIALOGS).map(([id, g]) => [id, preset(g)])),
  },
  fields,
  extensions: [AutoComplete((tip) => insertEntry(ctxOf(), tip.entry, { from: tip.from, to: tip.to }))],
  // AutoComplete is a behaviour; the Header & Footer tab's Quick Parts runs insert.text.quickParts (index.json same).
  implements: ['editing.autoComplete', 'headerFooter.insert.quickParts'],
  setup(editor) {
    setSchema(editor.schema);
    reload();
    const again = () => reload();
    editor.on('focus', again);
    return () => editor.off('focus', again);
  },
};
