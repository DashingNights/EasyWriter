// The References package's rows of the Documents engine table (docs/plans/engine/stage2.md): building blocks, fields, content
// controls, tables of contents, citations, index and notes (S4). Only that package edits this file. Rows by tooling id in the
// forms of forms.mjs (APP, exec, off, a CommandSpec); commands.mjs joins them. Pure: node tests load it.
//
// The dialogs are the DOM editor's own (src/document/wp/*): those that return their values (Date and Time, Field, Enclose
// Characters, the tables' dialogs, Caption, Convert Notes, Create Source) are opened as they are and their result goes to the
// engine here; those that write as they go (Mark Index Entry, Mark Citation, Mark Table of Contents Entry, Formula, Bookmark,
// Create New Building Block) take an `engine` prop with what they read and the calls that write. The document keeps its building
// blocks and citation sources (the stage-2 decision); the user's own blocks and the master source list stay in the app.
import { ENGINE_STYLE, fromEngineSource, styleIdOf, toEngineSource } from '../../wp/citations/canvas.mjs';
import { hasDate } from '../../wp/fields-core/format.mjs';
import { DEFAULT_DATE, DEFAULT_TIME } from '../../wp/fields-core/types.mjs';
import { INDEX_FORMATS } from '../../wp/index-toa/index.mjs';
import { follow, webGo } from '../../wp/fields-ref/canvas.mjs';
import { APP, exec, off } from './forms.mjs';

/** What the Word modules hand over at load, so this file stays pure: content controls' tags drawn over the page (Ctrl+Shift+X,
 * content-controls/marks.jsx). */
export const hooks = {
  toggleTags: () => false, tagsShown: () => false,
  // engine-gaps-rest: the user's own building blocks (wp/building-blocks/canvas.js sets these): F3 after the document's own
  // blocks, and a gallery pick of one (`bb:<id>`).
  autoTextF3: null, pickUserBlock: null,
};

/** A pure engine query's value, or null. */
export const query = async (ctx, id, args = {}) => {
  const r = await ctx.engine.query(id, args);
  return r?.ok ? r.value ?? null : null;
};
/** Runs engine command `id`, or the steps `id` ([[id, args]]) as one undo step that takes back all of them when one is refused
 * → true when it ran; a refusal shows as a toast. */
export const run = async (ctx, id, args = {}) => {
  const r = await (Array.isArray(id) ? ctx.engine.execMany(id) : ctx.engine.exec(id, args));
  if (r?.ok === false && r.error) ctx.toast?.(sentence(r.error));
  return r?.ok !== false;
};
/** An engine message as a sentence for a toast. */
const sentence = (e) => {
  const t = String(e).replace(/^[\w.]+: /, '').trim();
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
};

const body = (ctx) => (ctx.story === 'body' ? null : 'Click in the main text first.');
/** The snapshot entry of engine id `id` ({enabled, reason, checked, value}); reading it adds the id to the state call. */
const stateOf = (ctx, id) => ctx.stateOf?.(id) ?? ctx.engineState?.[id] ?? null;
const NO_NOTES = (ctx) => (stateOf(ctx, 'references.showNote')?.enabled === false ? 'The document has no notes yet.' : null);
/** A CommandSpec row: `fn(ctx, arg)` runs on the draft; `when(ctx)` is the reason it is off now, or null. */
const spec = (fn, when = null) => ({ run: fn, enabled: (ctx) => !!ctx.engine && !when?.(ctx), reason: (ctx) => when?.(ctx) ?? null });

// ---------- fields ----------

/** DATE or TIME with picture `p`, as fields-core's dateCode (commands.js loads the editor, so it is not imported here). */
export const dateCode = (p) => `${hasDate(p) ? 'DATE' : 'TIME'} \\@ "${p}"`;
const field = (instr) => exec('insert.field', { instr });

/** The Field dialog: edits the one selected field's code, else inserts a new field. */
async function fieldDialog(ctx) {
  const sel = await query(ctx, 'fields.selected');
  const one = sel?.length === 1 && !sel[0].range ? sel[0] : null;
  const r = await ctx.dialog('field', one ? { code: one.instr } : {});
  if (!r?.code) return false;
  return one ? run(ctx, 'fields.setCode', { code: r.code }) : run(ctx, 'insert.field', { instr: r.code });
}

/** Ctrl+F9: the selected text becomes a field's code. Word's empty braces with the caret inside need in-place code editing. */
async function insertBraces(ctx) {
  const text = (await query(ctx, 'document.selection'))?.text?.trim();
  if (!text) {
    ctx.toast?.('Select the field code first. An empty field to type into is not on the canvas yet.');
    return false;
  }
  return run(ctx, 'insert.field', { instr: text });
}

/** Date and Time: a DATE field when Update automatically is on, else the date as text. */
async function dateTime(ctx) {
  const r = await ctx.dialog('dateAndTime', {});
  if (r?.code) return run(ctx, 'insert.field', { instr: r.code });
  return r?.text ? run(ctx, 'text.insert', { text: r.text }) : false;
}

const ENCLOSE = { '○': 'circle', '□': 'square', '△': 'triangle', '◇': 'diamond' };
/** Enclose Characters: the selection's first character in the dialog; None removes an enclosure. */
async function enclose(ctx) {
  const text = [...((await query(ctx, 'document.selection'))?.text ?? '')].slice(0, 2).join('');
  const r = await ctx.dialog('encloseCharacters', { text });
  if (!r) return false;
  if (r.style === 'none') return run(ctx, 'format.enclose', { shape: null });
  return run(ctx, 'format.enclose', { shape: ENCLOSE[r.enclosure] ?? 'circle', style: r.style, text: r.text });
}

/** Insert Hyperlink on the canvas: the address, or a place in the document from link.targets. */
async function hyperlink(ctx, url) {
  if (typeof url === 'string' && url) return run(ctx, 'insert.link', { url });
  const targets = await query(ctx, 'link.targets');
  const r = await ctx.dialog('insertHyperlink', { engine: { targets, text: (await query(ctx, 'document.selection'))?.text ?? '' } });
  if (!r) return false;
  const text = r.text ? { text: r.text } : {};
  if (r.url) return run(ctx, 'insert.link', { url: r.url, ...text });
  if (r.bookmark) return run(ctx, 'insert.link', { bookmark: r.bookmark, ...text });
  if (r.heading != null) return run(ctx, 'insert.link', { heading: r.heading, ...text });
  return r.top ? run(ctx, 'insert.link', { top: true, ...text }) : false;
}

/** Bookmark: the dialog reads the bookmarks from link.targets and adds, deletes and goes to them through the engine. */
async function bookmarkDialog(ctx) {
  const engine = {
    list: async () => (await query(ctx, 'link.targets'))?.all ?? [],
    add: (name) => run(ctx, 'insert.bookmark', { name }),
    remove: (name) => run(ctx, 'insert.deleteBookmark', { name }),
    go: (name) => run(ctx, 'edit.goto', { bookmark: name }),
    selected: async () => (await query(ctx, 'document.selection'))?.text ?? '',
  };
  await ctx.dialog('bookmark', { engine });
  return true;
}

/** Cross-reference: the targets the engine knows (headings, bookmarks, captions) and insert.crossReference. */
async function crossReference(ctx) {
  await ctx.dialog('crossReference', { engine: { list: (to) => run0(ctx, 'insert.crossReference', { to }), insert: (args) => run(ctx, 'insert.crossReference', args) } });
  return true;
}
/** An engine command's value (for a listing that is not pure in the engine), or null. */
const run0 = async (ctx, id, args) => {
  const r = await ctx.engine.exec(id, args);
  return r?.ok ? r.value : null;
};

/** Formula: OK writes the = field through table.formula, which proposes =SUM(ABOVE) or LEFT from the cells itself. */
const formula = spec(async (ctx) => {
  const r = await ctx.dialog('formula', { engine: { formula: '=SUM(ABOVE)' } });
  return r ? run(ctx, 'table.formula', { formula: r }) : false;
}, (ctx) => (ctx.in?.table ? null : 'Put the cursor in a table cell first.'));

/** Advanced Properties from file.info; Summary writes file.properties and Custom the custom properties. */
async function properties(ctx, arg) {
  const fi = await query(ctx, 'file.info');
  const p = fi?.properties ?? {};
  const props = { core: { title: p.title, subject: p.subject, creator: p.creator, keywords: p.keywords, description: p.description, category: p.category } };
  const info = {
    props, title: ctx.title?.() ?? (p.title || 'Document'), project: '', created: p.created || null, saved: p.modified || null, printed: null,
    savedBy: p.lastModifiedBy ?? '', revision: p.revision ?? 0, editMinutes: 0, bytes: 0, pages: fi?.pages ?? 1, lines: null,
    words: fi?.words ?? 0, paragraphs: fi?.paragraphs ?? 0, headings: [], user: '', lang: 'en-US', date: (v) => (v ? String(v) : ''),
  };
  const patch = await ctx.dialog('advancedProperties', { info, tab: arg?.tab });
  if (!patch) return false;
  const KEYS = { title: 'title', subject: 'subject', creator: 'author', keywords: 'keywords', description: 'comments', category: 'category' };
  const args = Object.fromEntries(Object.entries(patch.core ?? {}).filter(([k]) => KEYS[k]).map(([k, v]) => [KEYS[k], v ?? '']));
  if (patch.custom) args.custom = Object.fromEntries(patch.custom.map((c) => [c.name, String(c.value ?? '')]));
  return Object.keys(args).length ? run(ctx, 'file.properties', args) : true;
}

/** Text from File: a .docx, .txt or .md picked through the app, pasted at the selection. */
async function textFromFile(ctx) {
  const f = await globalThis.window?.api?.word?.openFile({ filters: [{ name: 'Word documents and text', extensions: ['docx', 'txt', 'md'] }], as: 'base64' });
  if (!f) return false;
  const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
  const docx = /\.docx$/i.test(f.name);
  // ponytail: a .docx goes through the engine's paste, which also makes it the session's clipboard; an insert-from-bytes host
  // call would leave the clipboard alone.
  const r = await ctx.engine.paste(docx ? 'docx' : 'text', docx ? bytes : new TextDecoder().decode(bytes));
  return r?.ok !== false;
}

// ---------- content controls ----------

const DOC_PROPERTY = { title: 'Title', author: 'Author', subject: 'Subject', keywords: 'Keywords', comments: 'Comments', category: 'Category' };
/** Document Property: the six the engine binds; the other nine (Abstract, Company...) are not on the canvas yet. */
const docProperty = spec((ctx, arg) => {
  const name = DOC_PROPERTY[arg];
  if (name) return run(ctx, 'insert.docProperty', { name });
  if (arg) ctx.toast?.('This document property is not on the canvas yet. Title, Author, Subject, Keywords, Comments and Category are.');
  return false;
});

// The engine's control kinds (developer.control `type`) → the DOM dialog's sdt types, and its lock pair → the dialog's lock.
const SDT_TYPE = { richText: 'richText', plainText: 'text', checkBox: 'checkbox', comboBox: 'comboBox', dropDown: 'dropDown', date: 'date', picture: 'picture',
  buildingBlock: 'docPart', repeatingSection: 'repeating', repeatingSectionItem: 'repeatingItem' };
const LOCK = { '00': 'none', 10: 'sdtLocked', '01': 'contentLocked', 11: 'sdtContentLocked' };
/** The engine's control description → the Content Control Properties dialog's sdt. */
export const sdtOf = (c) => ({
  type: SDT_TYPE[c.type] ?? 'richText', title: c.title || null, tag: c.tag || null, lock: LOCK[`${+!!c.lockDelete}${+!!c.lockEdit}`], temporary: !!c.temporary,
  ...(c.multiLine != null && { multiLine: !!c.multiLine }), ...(c.checkedSymbol && { checkedChar: c.checkedSymbol, uncheckedChar: c.uncheckedSymbol }),
  ...(c.items && { items: c.items }), ...(c.format && { date: { format: c.format } }),
});
/** The dialog's edited sdt → developer.properties' params (colour, appearance and the date's locale and storage are gap G5's list). */
export const controlArgs = (r) => ({
  title: r.title ?? '', tag: r.tag ?? '', lockDelete: ['sdtLocked', 'sdtContentLocked'].includes(r.lock), lockEdit: ['contentLocked', 'sdtContentLocked'].includes(r.lock),
  temporary: !!r.temporary, ...(r.multiLine != null && { multiLine: !!r.multiLine }),
  ...(r.checkedChar && { checkedSymbol: r.checkedChar, uncheckedSymbol: r.uncheckedChar }),
  ...(Array.isArray(r.items) && { items: r.items.map((i) => ({ display: i.display, value: i.value ?? i.display })) }),
  ...(r.date?.format && { format: r.date.format }),
});

/** Content Control Properties for the control at the caret: developer.control in, developer.properties out. */
async function controlProperties(ctx) {
  const c = await query(ctx, 'developer.control');
  if (!c) {
    ctx.toast?.('Put the caret in a content control first.');
    return false;
  }
  const r = await ctx.dialog('contentControlProperties', { sdt: sdtOf(c) });
  return r ? run(ctx, 'developer.properties', controlArgs(r)) : false;
}

// ---------- tables of contents and captions ----------

const LEADER = { dot: 'dot', hyphen: 'hyphen', underscore: 'underscore', none: 'none', middleDot: 'dot' };
/** Table of Contents dialog values (toc.mjs TOC_DEFAULTS shape) → references.toc. */
export const tocArgs = (v) => ({
  levels: v.levels, pageNumbers: !!v.pageNumbers, rightAlign: !!v.rightAlign, tabLeader: LEADER[v.leader] ?? 'dot', hyperlinks: !!v.hyperlinks,
  headingStyles: !!v.styles, outlineLevels: !!v.outline, tcFields: !!v.tcFields,
  ...(v.extra?.length ? { styleLevels: Object.fromEntries(v.extra) } : {}),
});
const TOC = 'references.tableOfContents.tableOfContents';
const automatic = (title) => exec('references.toc', { title, levels: 3, hyperlinks: true, outlineLevels: true }, { when: body });
// Update Table: the engine updates the entire table, so the canvas skips Word's choice of page numbers only (not on the canvas yet).

/** Mark Table of Contents Entry stays open; each Mark writes a hidden TC field after the selection. */
async function markToc(ctx) {
  const text = (await query(ctx, 'document.selection'))?.text ?? '';
  ctx.dialog('markTableOfContentsEntry', { text, engine: { mark: (code) => run(ctx, 'insert.field', { instr: code }) } });
  return true;
}

// ---------- citations ----------

const CITATIONS = 'references.citationsBibliography';
const BIBLIOGRAPHY = { bibliography: 'Bibliography', references: 'References', worksCited: 'Works Cited' };
/** Create Source (or Add New Placeholder's tag) → a source in the document, cited at the selection. */
const addAndCite = async (ctx, source) => (source ? run(ctx, 'references.citation', { source: toEngineSource(source) }) : false);

/** Source Manager's reads and writes on a canvas draft: the document's sources (references.citations) and the tags cited,
 * Copy into the document and Delete through references.sources, Edit as delete and add under the same tag. */
const sourceEngine = (ctx) => ({
  list: async () => {
    const c = await query(ctx, 'references.citations');
    return { sources: (c?.sources ?? []).map(fromEngineSource), cited: c?.cited ?? [] };
  },
  save: async (source) => {
    const s = toEngineSource(source);
    const had = ((await query(ctx, 'references.citations'))?.sources ?? []).some((x) => x.tag === s.tag);
    return ctx.engine.execMany([...(had ? [['references.sources', { remove: s.tag }]] : []), ['references.sources', { add: s }]])
      .then((r) => r?.ok !== false);
  },
  remove: (tag) => run(ctx, 'references.sources', { remove: tag }),
});

// ---------- index and authorities ----------

const INDEX_LEADER = LEADER;
/** The selection's text whenever the engine's selection changes: `fn(text)` gets it; → a function that stops listening. Mark
 * Index Entry and Mark Citation follow the engine's selection so (gap G47), as they follow the DOM editor's. */
const watchSelection = (ctx) => (fn) => {
  const off = ctx.engine?.on?.('selection', async () => {
    const text = (await query(ctx, 'document.selection').catch(() => null))?.text?.trim();
    if (text) fn(text);
  });
  return typeof off === 'function' ? off : () => {};
};

/** Mark Index Entry and Mark Citation stay open; each Mark writes through the engine. `more(ctx)` adds what the dialog reads. */
const markDialog = (id, mark, more = async () => ({})) => spec(async (ctx) => {
  const text = (await query(ctx, 'document.selection'))?.text?.trim() ?? '';
  ctx.dialog(id, { engine: { text, mark: (v) => mark(ctx, v), watch: watchSelection(ctx), ...(await more(ctx)) } });
  return true;
}, body);

/** The document's TA fields' long and short citations and categories, for Mark Citation's list of short citations. */
async function taEntries(ctx) {
  const codes = (await query(ctx, 'document.inspect'))?.blocks?.flatMap((b) => b.objects ?? []).filter((o) => o.type === 'field').map((o) => o.instr) ?? [];
  const arg = (code, k) => new RegExp(`\\\\${k}\\s+(?:"([^"]*)"|(\\S+))`).exec(code)?.slice(1).find((x) => x != null) ?? null;
  return { known: codes.filter((c) => /^\s*TA\b/.test(c)).map((c) => ({ long: arg(c, 'l'), short: arg(c, 's') ?? arg(c, 'l'), category: Number(arg(c, 'c')) || 1 }))
    .filter((e) => e.long) };
}

// ---------- notes ----------

/** Convert Notes: which kinds exist from references.notes; the dialog's choice → references.convertNotes. */
const CONVERT = { toEndnotes: 'endnote', toFootnotes: 'footnote', swap: 'swap' };
async function convertNotes(ctx, arg) {
  const kinds = [...new Set(((await query(ctx, 'references.notes')) ?? []).map((n) => n.kind))];
  const mode = arg ?? await ctx.dialog('convertNotes', { kinds });
  if (mode === 'this') {
    ctx.toast?.('Converting only this note is not on the canvas yet.');
    return false;
  }
  return CONVERT[mode] ? run(ctx, 'references.convertNotes', { to: CONVERT[mode] }) : false;
}

/** Footnote and Endnote: the options in effect from references.noteOptions; Apply and Insert write them, Insert adds a note. */
async function noteDialog(ctx) {
  const now = await run0(ctx, 'references.noteOptions', {});
  ctx.dialog('footnoteAndEndnote', {
    engine: {
      now,
      apply: (kind, patch, scope) => run(ctx, 'references.noteOptions', { kind, scope: scope === 'sect' ? 'section' : 'document', ...patch }),
      insert: (kind, mark) => run(ctx, kind === 'endnote' ? 'references.endnote' : 'references.footnote', mark ? { mark } : {}),
    },
  });
  return true;
}

// ---------- building blocks ----------

/** Word's gallery names (Create New Building Block) → the file's gallery values (building-blocks/doc-blocks.mjs FILE_GALLERIES). */
export const GALLERY_CODE = {
  AutoText: 'autoTxt', Bibliographies: 'bib', 'Cover Pages': 'coverPg', Equations: 'eq', Footers: 'ftrs', Headers: 'hdrs', 'Page Numbers': 'pgNum',
  'Page Numbers (Bottom of Page)': 'pgNumB', 'Page Numbers (Margins)': 'pgNumMargins', 'Page Numbers (Top of Page)': 'pgNumT', 'Quick Parts': 'docParts',
  'Table of Contents': 'tblOfContents', Tables: 'tbls', 'Text Boxes': 'txtBox', Watermarks: 'watermarks',
};
/** A canvas gallery item's id for the document's building block `name` of gallery value `code` (building-blocks/index.js). */
export const blockId = (code, name) => `eb:${code}:${name}`;
/** A gallery pick on the canvas: one of the document's building blocks, or the user's own (`bb:<id>`) → inserted; anything
 * else → false. */
const pickBlock = (ctx, arg) => {
  const m = typeof arg === 'string' && /^eb:([^:]+):(.*)$/s.exec(arg);
  if (m) return run(ctx, 'insert.buildingBlock', { name: m[2], gallery: m[1] });
  return (typeof arg === 'string' && arg.startsWith('bb:') && hooks.pickUserBlock?.(ctx, arg)) || false;
};

// The galleries Word saves whole without a selection (gap G5): the engine's insert.saveTargets says what the caret has.
const WHOLE = { Watermarks: ['watermark', 'This document has no watermark to save.'], 'Table of Contents': ['toc', 'Put the cursor in a table of contents first.'],
  Bibliographies: ['bibliography', 'Put the cursor in a bibliography first.'] };
/** Why Save Selection to `gallery` is off now, as the DOM editor's (building-blocks/index.js saveTo): a text box or an equation
 * for their galleries, the watermark, table of contents or bibliography for theirs, else a selection (the engine's
 * insert.saveBuildingBlock state). */
const saveWhy = (gallery) => (ctx) => {
  if (gallery === 'Text Boxes') return ctx.in?.textbox ? null : 'Select a text box first.';
  if (gallery === 'Equations') return ctx.in?.equation ? null : 'Select an equation first.';
  if (WHOLE[gallery]) return stateOf(ctx, 'insert.saveTargets')?.value?.[WHOLE[gallery][0]] ? null : WHOLE[gallery][1];
  return stateOf(ctx, 'insert.saveBuildingBlock')?.enabled === false ? 'Select what to save first.' : null;
};
/** Save Selection to `gallery`: Create New Building Block in the canvas form, saving into the document's building blocks. */
const saveTo = (gallery) => ({ ...spec(async (ctx) => {
  const text = (await query(ctx, 'document.selection'))?.text ?? '';
  const save = (v) => run(ctx, 'insert.saveBuildingBlock', { name: v.name, gallery: GALLERY_CODE[v.gallery.replace(/^Custom /, '')] ?? 'docParts',
    category: v.category, description: v.description, behavior: { paragraph: 'p', page: 'pg' }[v.insert] ?? 'content' });
  return ctx.dialog('createNewBuildingBlock', { gallery, engine: { text, save, whole: !!WHOLE[gallery] } });
}, saveWhy(gallery)), reads: ['insert.saveTargets', 'insert.saveBuildingBlock'] });

/** Quick Tables the engine builds: our calendars, matrix and tabular list; the others are not on the canvas yet. */
const QUICK_TABLE = { calendar1: 'calendar', calendar2: 'calendar', calendar3: 'calendar', calendar4: 'calendar', matrix: 'matrix', tabularList: 'tabular' };

// ---------- the rows ----------

/** {toolingId: row}. */
export const REFERENCES = {
  // building-blocks
  // F3: the document's building block named by the text before the caret (the engine's insert.autoTextF3), else the user's
  // own (engine-gaps-rest); the refusal shows.
  'editing.autoTextF3': spec((ctx) => (hooks.autoTextF3 ? hooks.autoTextF3(ctx) : run(ctx, 'insert.autoTextF3'))),
  'editing.createBuildingBlock': saveTo('AutoText'),
  'insert.text.quickParts': spec((ctx, arg) => (arg ? pickBlock(ctx, arg) : true)),
  'insert.text.quickParts.autoText': spec((ctx, arg) => (arg ? pickBlock(ctx, arg) : true)),
  'insert.text.quickParts.autoText.saveSelectionToAutoTextGallery': saveTo('AutoText'),
  'insert.text.quickParts.buildingBlocksOrganizer': spec((ctx) => ctx.dialog('buildingBlocksOrganizer', {
    engine: { list: () => query(ctx, 'insert.buildingBlocks'), insert: (name, gallery) => run(ctx, 'insert.buildingBlock', { name, gallery }),
      remove: (name, gallery) => run(ctx, 'insert.deleteBuildingBlock', { name, gallery }) },
  })),
  'insert.text.quickParts.saveSelectionToQuickPartGallery': saveTo('Quick Parts'),
  // ponytail: every cover design is the engine's one (title, subtitle, author, date); the six designs and their bound properties
  // need the engine to build them.
  'insert.pages.coverPage': spec((ctx, arg) => (typeof arg === 'string' && arg.startsWith('eb:') ? pickBlock(ctx, arg) : run(ctx, 'insert.coverPage', {}))),
  'insert.pages.coverPage.removeCurrentCoverPage': exec('insert.removeCoverPage', {}),
  'insert.pages.coverPage.saveSelectionToCoverPageGallery': saveTo('Cover Pages'),
  'insert.tables.table.quickTables': spec((ctx, arg) => {
    if (typeof arg === 'string' && arg.startsWith('eb:')) return pickBlock(ctx, arg);
    if (QUICK_TABLE[arg]) return run(ctx, 'table.quick', { kind: QUICK_TABLE[arg] });
    if (arg) ctx.toast?.('This Quick Table is not on the canvas yet. The calendars, Matrix and Tabular List are.');
    return !arg;
  }),
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
  [`${TOC}.saveSelectionToTableOfContentsGallery`]: saveTo('Table of Contents'),
  [`${CITATIONS}.bibliography.saveSelectionToBibliographyGallery`]: saveTo('Bibliographies'),

  // fields-core
  'fieldsUi.update': exec('references.updateFields', {}),
  'fieldsUi.toggle': exec('fields.toggleCode', {}),
  'fieldsUi.toggleAll': exec('view.fieldCodes', {}),
  'fieldsUi.insertField': spec(insertBraces),
  'fieldsUi.next': exec('fields.next', {}),
  'fieldsUi.prev': exec('fields.previous', {}),
  'fieldsUi.lock': exec('fields.lock', {}),
  'fieldsUi.unlock': exec('fields.unlock', {}),
  'fieldsUi.unlink': exec('fields.unlink', {}),
  // Alt+Shift+F9: GOTOBUTTON goes to its bookmark and a HYPERLINK to its place in the engine; a web address opens here.
  'fieldsUi.doFieldClick': spec(async (ctx) => {
    const r = await ctx.engine.exec('fields.click', {});
    if (r?.ok === false) {
      if (r.error) ctx.toast?.(sentence(r.error));
      return false;
    }
    return r?.value?.url ? follow(ctx.engine, { url: r.value.url }) : true;
  }),
  'fieldsUi.dateField': exec('insert.field', (_, ctx) => ({ instr: dateCode(ctx.settings?.word?.dateTime?.format ?? DEFAULT_DATE) })),
  'fieldsUi.timeField': field(`TIME \\@ "${DEFAULT_TIME}"`),
  'fieldsUi.pageField': exec('insert.pageField', {}),
  'fieldsUi.dialog': spec(fieldDialog),
  // The app's setting (never, always, when selected): content-controls/marks.jsx draws it over the canvas pages.
  'fieldsUi.shading': APP,
  'insert.text.quickParts.field': spec(fieldDialog),
  'headerFooter.insert.documentInfo.field': spec(fieldDialog),
  'insert.text.dateTime': spec(dateTime),

  // fields-ref
  'insert.links.link': spec(hyperlink),
  'insert.links.link.insertLink': spec((ctx) => hyperlink(ctx)),
  'insert.links.bookmark': spec(bookmarkDialog),
  'insert.links.crossReference': spec(crossReference),
  'tableLayout.data.formula': formula,
  // The places followed links left (Ctrl+click, fields-ref/canvas.mjs); with none they do nothing, as the DOM editor's do.
  'navigation.webGoBack': { run: (ctx) => webGo(ctx.engine, -1) },
  'navigation.webGoForward': { run: (ctx) => webGo(ctx.engine, 1) },

  // fields-info
  'file.info.properties': spec(properties),
  'headerFooter.insert.documentInfo': APP, // the control only opens its menu
  'headerFooter.insert.documentInfo.author': field('AUTHOR'),
  'headerFooter.insert.documentInfo.fileName': field('FILENAME'),
  'headerFooter.insert.documentInfo.filePath': field('FILENAME \\p'),
  'insert.text.object.textFromFile': spec(textFromFile),

  // fields-draw
  'home.font.encloseCharacters': spec(enclose),

  // content-controls
  'developer.controls.richTextContentControl': exec('developer.richText', {}),
  'developer.controls.plainTextContentControl': exec('developer.plainText', {}),
  'developer.controls.pictureContentControl': exec('developer.picture', {}),
  'developer.controls.buildingBlockGalleryContentControl': exec('developer.buildingBlock', {}),
  'developer.controls.checkBoxContentControl': exec('developer.checkBox', {}),
  'developer.controls.comboBoxContentControl': exec('developer.comboBox', {}),
  'developer.controls.dropDownListContentControl': exec('developer.dropDown', {}),
  'developer.controls.datePickerContentControl': exec('developer.datePicker', {}),
  'developer.controls.repeatingSectionContentControl': exec('developer.repeatingSection', {}),
  'developer.controls.designMode': exec('developer.designMode', {}),
  'developer.controls.properties': spec(controlProperties, (ctx) => (ctx.in?.sdt ? null : 'Put the caret in a content control first.')),
  // The split button's main part groups; its menu's Ungroup takes the group round the selection away.
  'developer.controls.group': spec((ctx, arg) => run(ctx, 'developer.group', { ungroup: arg === 'ungroup' })),
  'developer.controls.legacyTools': spec(() => true), // the control only opens its menu
  'developer.controls.legacyTools.textFormField': exec('developer.formField', { kind: 'text' }),
  'developer.controls.legacyTools.checkBoxFormField': exec('developer.formField', { kind: 'checkBox' }),
  'developer.controls.legacyTools.dropDownFormField': exec('developer.formField', { kind: 'dropDown' }),
  'developer.controls.legacyTools.formFieldShading': exec('developer.formShading', {}),
  'developer.controls.legacyTools.resetFormFields': exec('developer.resetFormFields', {}),
  // The pane inserts content controls bound to the document's properties (w:dataBinding) through developer.insertBound
  // (engine-gaps-rest); the engine keeps the six File > Info properties and their controls in step.
  'developer.mapping.xmlMappingPane': APP,
  'keys.xmlTags': { run: () => hooks.toggleTags(), active: () => hooks.tagsShown() },
  'insert.text.quickParts.documentProperty': docProperty,
  'headerFooter.insert.documentInfo.documentProperty': docProperty,
  'headerFooter.insert.documentInfo.documentTitle': exec('insert.docProperty', { name: 'Title' }),

  // toc
  // The menu control itself runs from Alt+Shift+F12: Update Table inside a table of contents.
  [TOC]: spec(async (ctx) => {
    const f = (await query(ctx, 'fields.selected')) ?? [];
    const inToc = f.some((x) => /^\s*TOC\b/.test(x.instr)) || /^\s*TOC\b/.test(ctx.engineState?.['document.context']?.value?.field?.instr ?? '');
    return inToc ? run(ctx, 'references.updateToc') : false;
  }),
  [`${TOC}.automaticTable1`]: automatic('Contents'),
  [`${TOC}.automaticTable2`]: automatic('Table of Contents'),
  // Word's typed entries in a Table of Contents control (gap G45); Remove Table of Contents takes it too.
  [`${TOC}.manualTable`]: spec((ctx) => run(ctx, 'references.manualToc', { title: 'Table of Contents' }), body),
  [`${TOC}.customTableOfContents`]: spec(async (ctx) => {
    const v = await ctx.dialog('tableOfContents', {});
    return v ? run(ctx, 'references.toc', tocArgs(v)) : false;
  }, body),
  [`${TOC}.removeTableOfContents`]: exec('references.removeToc', {}),
  'references.tableOfContents.updateTable': exec('references.updateToc', {}),
  'references.captions.insertCaption': spec(async (ctx) => {
    const r = await ctx.dialog('caption', {});
    if (!r) return false;
    return run(ctx, 'references.caption', { label: r.label, text: r.text ?? '', position: r.position ?? 'below', excludeLabel: !!r.exclude });
  }, body),
  'references.captions.insertTableOfFigures': spec(async (ctx) => {
    const v = await ctx.dialog('tableOfFigures', {});
    if (!v) return false;
    return run(ctx, 'references.tableOfFigures', { ...(v.label ? { label: v.label } : {}), includeLabel: !!v.includeLabel, pageNumbers: !!v.pageNumbers,
      rightAlign: !!v.rightAlign, tabLeader: LEADER[v.leader] ?? 'dot' });
  }, body),
  'references.captions.updateTable': exec('references.updateFigures', {}),
  'fieldsUi.markTocEntry': spec(markToc, body),

  // citations
  [`${CITATIONS}.insertCitation`]: spec(async (ctx, tag) => {
    if (tag) return run(ctx, 'references.citation', { tag });
    const source = await ctx.dialog('createSource', {});
    return addAndCite(ctx, source);
  }),
  [`${CITATIONS}.insertCitation.addNewSource`]: spec(async (ctx) => addAndCite(ctx, await ctx.dialog('createSource', {}))),
  [`${CITATIONS}.insertCitation.addNewPlaceholder`]: spec(async (ctx) => {
    const tag = await ctx.dialog('addNewPlaceholder', {});
    return tag ? run(ctx, 'references.citation', { source: { tag, kind: 'book' } }) : false;
  }),
  // Source Manager on the document's sources (gap G46): the master list stays the app's, the current list is the engine's.
  [`${CITATIONS}.manageSources`]: spec((ctx) => ctx.dialog('sourceManager', { engine: sourceEngine(ctx) })),
  [`${CITATIONS}.style`]: exec('references.citationStyle', (v) => ({ style: ENGINE_STYLE[v] ?? ENGINE_STYLE[styleIdOf(v)] ?? v }), {
    state: 'references.citationStyle',
    value: (e) => styleIdOf(e?.value) ?? null,
  }),
  [`${CITATIONS}.bibliography`]: exec('references.bibliography', (id) => ({ title: BIBLIOGRAPHY[id] ?? '' })),
  [`${CITATIONS}.bibliography.insertBibliography`]: exec('references.bibliography', { title: '' }),
  [`${CITATIONS}.bibliography.bibliography`]: exec('references.bibliography', { title: 'Bibliography' }),
  [`${CITATIONS}.bibliography.references`]: exec('references.bibliography', { title: 'References' }),
  [`${CITATIONS}.bibliography.worksCited`]: exec('references.bibliography', { title: 'Works Cited' }),
  'x.citations.update': exec('references.updateCitations', {}),

  // index-toa
  'references.index.markEntry': markDialog('markIndexEntry', (ctx, v) => run(ctx, 'references.markEntry', v)),
  'references.index.insertIndex': spec(async (ctx) => {
    const v = await ctx.dialog('index', {});
    if (!v || v === true) return !!v;
    // As indexCode: the format's own heading and alignment. A blank \h (Simple) is a blank line, not a letter heading.
    const f = INDEX_FORMATS[v.format] ?? {};
    return run(ctx, 'references.index', { type: v.runIn ? 'runIn' : 'indented', columns: v.columns || 1, rightAlign: !!(v.right || f.right),
      tabLeader: INDEX_LEADER[v.leader] ?? 'dot', headings: !!f.h?.trim() });
  }, body),
  'references.index.updateIndex': exec('references.updateIndex', {}),
  // Next Citation selects the next legal authority in the engine (references.nextCitation, engine-gaps-rest).
  'references.tableOfAuthorities.markCitation': markDialog('markCitation', (ctx, v) => run(ctx, 'references.markCitation', v),
    async (ctx) => ({ ...(await taEntries(ctx)), next: () => run(ctx, 'references.nextCitation', {}) })),
  // Category (All: one list per category marked), passim and the leader (gap G47); the categories renamed in the app's settings.
  'references.tableOfAuthorities.insertTableOfAuthorities': spec(async (ctx) => {
    const v = await ctx.dialog('tableOfAuthorities', {});
    if (!v || v === true) return !!v;
    return run(ctx, 'references.tableOfAuthorities', { category: v.category ?? 'all', passim: !!v.passim, tabLeader: LEADER[v.leader] ?? 'dot',
      names: ctx.settings?.word?.toaCategories ?? {} });
  }, body),
  'references.tableOfAuthorities.updateTable': exec('references.updateAuthorities', {}),

  // notes
  'references.footnotes.insertFootnote': exec('references.footnote', {}),
  'references.footnotes.insertEndnote': exec('references.endnote', {}),
  'references.footnotes.nextFootnote': exec('references.nextFootnote', {}),
  'references.footnotes.nextFootnote.nextFootnote': exec('references.nextFootnote', {}),
  'references.footnotes.nextFootnote.previousFootnote': exec('references.nextFootnote', { back: true }),
  'references.footnotes.nextFootnote.nextEndnote': exec('references.nextEndnote', {}),
  'references.footnotes.nextFootnote.previousEndnote': exec('references.nextEndnote', { back: true }),
  'references.footnotes.showNotes': exec('references.showNote', {}),
  'references.footnotes.launcher': spec(noteDialog),
  'notes.convert': spec(convertNotes, NO_NOTES),
  // A double-click on a note reference (the pointer layer's): Show Notes, off without notes.
  'notes.doubleClickMark': spec((ctx) => run(ctx, 'references.showNote'), NO_NOTES),
  // Another view shows a note: {id} (the engine's note id); from and to inside it are not on the canvas yet.
  'x.reveal.note': exec('references.showNote', (arg) => ({ id: arg?.id })),
};
