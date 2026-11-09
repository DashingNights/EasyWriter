// Citations & Bibliography (docs/plans/word/plan.md §3 citations, briefs/citations.md): the references builder as Word's group
// for Documents. Insert Citation, Manage Sources, Style and Bibliography replace base's builder commands; CITATION and BIBLIOGRAPHY
// fields live in content controls whose title-bar menus are the 'sdt:citation' and 'sdt:Bibliographies' panels. Forum posts keep
// the builder's plain text (app/references.js branches on the format).
import { createElement as h } from 'react';
import { both } from '../../../tooling/engine-provider.mjs';
import { keepFocus } from '../../../app/components/Toolbar.jsx';
import {
  insertCitation, openCitePicker, saveSource, setStyle, sourcesOf, styleNow,
} from '../../../app/references.js';
import { wordCitation, wordLabels, WORD_STYLES } from '../../../references.mjs';
import {
  citationIn, convertToText, envNow, insertBibliography, replaceBibliography, sdtAt, setCitation, updateCitations,
} from './doc.js';
import { AddNewPlaceholder, CreateSource, EditCitation, EditName, SourceManager } from './dialogs.jsx';
import { fromEngineSource, styleIdOf } from './canvas.mjs';
import { citedTags, FIELDS } from './fields.mjs';

const ID = 'references.citationsBibliography';
const BUILT_IN = { bibliography: 'Bibliography', references: 'References', worksCited: 'Works Cited' };
const fail = (e) => console.warn('Citations:', e);
const docOnly = (ctx) => !!ctx.ed;

/** Adds `source` from Create Source to the current list and cites it at the cursor. */
async function addAndCite(source) {
  if (!source) return;
  const saved = await saveSource(source);
  await insertCitation(saved.id);
}

/** The style id for a combo pick: an id, or a label typed into the box. */
const styleId = (v) => WORD_STYLES.find((r) => r.id === v || r.label.toLowerCase() === String(v ?? '').trim().toLowerCase())?.id ?? null;

const commands = {
  [`${ID}.insertCitation`]: {
    // A gallery pick cites that source; the control itself (tool search) opens the citation picker.
    run: (ctx, id) => (id ? insertCitation(id).catch(fail) : openCitePicker()),
    enabled: docOnly,
  },
  [`${ID}.insertCitation.addNewSource`]: {
    run: (ctx) => ctx.dialog('createSource', {}).then(addAndCite).catch(fail),
    enabled: docOnly,
  },
  [`${ID}.insertCitation.addNewPlaceholder`]: {
    run: (ctx) => ctx.dialog('addNewPlaceholder', {}).then((tag) => tag && addAndCite({ placeholder: true, tag, type: 'web', accessed: '' })).catch(fail),
    enabled: docOnly,
  },
  [`${ID}.manageSources`]: { run: (ctx) => ctx.dialog('sourceManager'), enabled: docOnly },
  [`${ID}.style`]: {
    value: () => styleNow(),
    run: (ctx, v) => {
      const id = styleId(v);
      return id ? setStyle(id).catch(fail) : false;
    },
  },
  // The Bibliography control opens its menu; run on its own (tool search) it inserts the plain bibliography.
  [`${ID}.bibliography`]: { run: (ctx, id) => insertBibliography(ctx.target ?? ctx.ed, BUILT_IN[id] ?? null), enabled: docOnly },
  [`${ID}.bibliography.insertBibliography`]: { run: (ctx) => insertBibliography(ctx.target ?? ctx.ed), enabled: docOnly },
  ...Object.fromEntries(Object.entries(BUILT_IN).map(([key, heading]) => [`${ID}.bibliography.${key}`, {
    run: (ctx) => insertBibliography(ctx.target ?? ctx.ed, heading), enabled: docOnly,
  }])),
  'x.citations.update': { run: (ctx) => updateCitations(ctx.ed), enabled: docOnly },
};


/** On a canvas draft the document's sources, cited tags and style (the engine's references.citations), in the app's shapes. */
function engineEnv(ctx) {
  const c = ctx.read('references.citations');
  return { sources: (c?.sources ?? []).map(fromEngineSource), style: styleIdOf(c?.style) ?? 'apa', cited: c?.cited ?? [] };
}

const galleries = {
  // Insert Citation's sources: the citation in the current style, then the author and title. On a canvas draft an item's id is
  // the source's tag, which the canvas row cites.
  [`${ID}.insertCitation`]: both((ctx) => {
    const env = ctx.engine ? engineEnv(ctx) : null;
    const { sources, style } = env ?? envNow();
    const lab = wordLabels(sources, style, env ? env.cited : ctx.state ? citedTags(ctx.state.doc) : []);
    return sources.map((s) => ({
      id: s.id, label: wordCitation([{ s, label: lab.get(s.id) ?? '' }], style),
      preview: h('span', { className: 'flex min-w-0 flex-col' }, h('span', null, wordCitation([{ s, label: lab.get(s.id) ?? '' }], style)),
        h('span', { className: 'truncate text-xs text-muted-foreground' }, [s.authors.join('; '), s.title].filter(Boolean).join(', ') || s.tag)),
    }));
  }),
  [`${ID}.style`]: both((ctx) => {
    const now = ctx?.engine ? engineEnv(ctx).style : styleNow();
    return WORD_STYLES.map((r) => ({ id: r.id, label: r.label, active: r.id === now }));
  }),
};

// A content control's title-bar menu items (content-controls draws the control and opens these panels).
const Item = ({ label, onClick, feature }) => h('button', {
  type: 'button', role: 'menuitem', 'data-feature': feature, onMouseDown: keepFocus, onClick,
  className: 'flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent/60',
}, label);
const act = (close, fn) => () => {
  close?.();
  Promise.resolve().then(fn).catch(fail);
};

/** The citation control's menu: Edit Citation..., Edit Source..., Convert citation to static text, Update Citations and Bibliography. */
function CitationPanel({ ctx, close }) {
  const ed = ctx.target ?? ctx.ed;
  const at = ed && sdtAt(ed.state, 'citation');
  const f = at && citationIn(at);
  const source = f && sourcesOf().find((s) => s.tag === f.c.tags[0]);
  return h('div', { role: 'menu', className: 'flex min-w-56 flex-col', 'data-panel': 'sdt:citation' },
    h(Item, { label: 'Edit Citation...', feature: 'x.citations.editCitation', onClick: act(close, async () => {
      const c = f && await ctx.dialog('editCitation', { c: f.c });
      if (c) setCitation(ed, c);
    }) }),
    h(Item, { label: 'Edit Source...', feature: 'x.citations.editSource', onClick: act(close, async () => {
      const out = source && await ctx.dialog('createSource', { source, title: 'Edit Source' });
      if (out) await saveSource(out);
    }) }),
    h(Item, { label: 'Convert citation to static text', feature: 'x.citations.convert', onClick: act(close, () => convertToText(ed, 'citation')) }),
    h(Item, { label: 'Update Citations and Bibliography', feature: 'x.citations.update', onClick: act(close, () => updateCitations(ctx.ed)) }));
}

/** The bibliography control's menu: the three built-ins, Update Citations and Bibliography, Convert bibliography to static text. */
function BibliographyPanel({ ctx, close }) {
  const ed = ctx.target ?? ctx.ed;
  return h('div', { role: 'menu', className: 'flex min-w-56 flex-col', 'data-panel': 'sdt:Bibliographies' },
    ...Object.entries(BUILT_IN).map(([key, heading]) => h(Item, { key, label: heading, feature: `${ID}.bibliography.${key}`,
      onClick: act(close, () => replaceBibliography(ed, heading)) })),
    h('div', { className: 'my-1 h-px bg-border' }),
    h(Item, { label: 'Update Citations and Bibliography', feature: 'x.citations.update', onClick: act(close, () => updateCitations(ctx.ed)) }),
    h(Item, { label: 'Convert bibliography to static text', feature: 'x.citations.convertBibliography', onClick: act(close, () => convertToText(ed, 'Bibliographies')) }));
}

export default {
  id: 'citations',
  commands,
  galleries,
  dialogs: { createSource: CreateSource, editName: EditName, addNewPlaceholder: AddNewPlaceholder, sourceManager: SourceManager, editCitation: EditCitation },
  panels: { 'sdt:citation': CitationPanel, 'sdt:Bibliographies': BibliographyPanel },
  fields: FIELDS,
  providers: { citations: () => envNow() },
  implements: ['fields.CITATION', 'fields.BIBLIOGRAPHY'],
};
