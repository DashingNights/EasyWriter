import { citation, formatReference, labels, referenceList, referenceListRuns, STYLES, textJson, TYPES } from '../../references.mjs';
import { define, fail } from './define.mjs';
import { defs as docDefs } from './doc.mjs';
import { ref } from './schema-defs.mjs';

// references.* (docs/plans/references.md): the open draft's sources and style, through ctx.references (app/references.js). A link
// is read as the References dialog reads it (the page, then doi.org for a DOI). The list goes in as paragraphs through
// doc.insert's plan: one undo step, and a suggestion like any agent edit. A citation goes in with doc.replace, from
// references.list's cite (Harvard) or references.cite (numbered, which fixes the source's number first).

const text = (description) => ({ type: 'string', maxLength: 2000, ...(description && { description }) });
const SOURCE = {
  type: 'object', additionalProperties: false,
  properties: {
    type: { enum: TYPES.map(([id]) => id), description: 'web page, article, preprint, chapter (or conference paper), book' },
    authors: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 300 }, description: 'A person as "Family, Given", an organisation as its name' },
    year: text('Empty prints n.d.'),
    title: text(),
    container: text('The journal, site, preprint server or book it is in'),
    date: text('YYYY-MM-DD published (articles)'),
    volume: text(), issue: text(), pages: text(), place: text(), publisher: text(), doi: text(), arxiv: text('arXiv id, e.g. 2411.00114'), url: text(),
    accessed: text('YYYY-MM-DD the link was read; default today'),
    note: text('For the user only; the list leaves it out'),
  },
};
const ID = ref('ID', 'The source id, from references_list');
const SAMPLE_ID = '3f2b6c1e-8a4d-4b7e-9c2a-5d1e8f0a6b3c';
const STYLE = { enum: STYLES.map(([id]) => id), description: 'harvard (author and year) or ieee (numbered)' };

/** `sources` as references.list shows them in `style`: each with its list entry and its two citations; a numbered draft's source
 * not cited yet has none (references.cite gives it its number). */
function shown(sources, style) {
  const lab = labels(sources, style);
  return sources.map((s) => {
    const label = lab.get(s.id) ?? '';
    const open = style !== 'ieee' || s.num;
    return { ...s, reference: formatReference(s, label, style), cite: open ? citation(s, label, false, style) : null,
      citeNarrative: open ? citation(s, label, true, style) : null };
  });
}
const shownOne = (ctx, id) => shown(ctx.references.sourcesOf(), ctx.references.styleNow()).find((s) => s.id === id);
const sourceOf = (ctx, id) => ctx.references.sourcesOf().find((s) => s.id === id)
  ?? fail('not_found', `The draft has no source ${id}`, { hint: 'references_list gives the ids' });
const INSERT = docDefs.find((d) => d.id === 'doc.insert');

export const defs = [
  define({
    id: 'references.list',
    title: "List the open draft's sources with their reference list entries and citations",
    brief: 'Use it before citing. cite is the citation, citeNarrative the narrative one, list the whole reference list, style the draft\'s style.',
    guide: { args: 'In an ieee draft a source not cited yet has cite null. Get its citation with references_cite' },
    group: 'references',
    risk: 'read',
    undo: 'none',
    needs: ['doc.open'],
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'object', required: ['style', 'sources', 'list'] },
    examples: [{ args: {} }],
    run: (ctx) => {
      const sources = ctx.references.sourcesOf();
      const style = ctx.references.styleNow();
      return { style, sources: shown(sources, style), list: referenceList(sources, style) };
    },
  }),
  define({
    id: 'references.cite',
    title: 'Get the citation of a source of the open draft, to write it into the text',
    brief: 'In a numbered (ieee) draft this gives the source its number if it has none. Put the text in with doc_replace.',
    group: 'references',
    risk: 'write',
    undo: 'none',
    needs: ['doc.open'],
    args: {
      type: 'object', required: ['id'], additionalProperties: false,
      properties: { id: ID, narrative: { type: 'boolean', default: false, description: 'Lee and Chan (2021) or Lee and Chan [1] in place of the bracketed form' } },
    },
    result: { type: 'object', required: ['text'] },
    examples: [{ args: { id: SAMPLE_ID } }, { args: { id: SAMPLE_ID, narrative: true } }],
    run: async (ctx, a) => {
      sourceOf(ctx, a.id);
      await ctx.references.numberSources([a.id]);
      const s = shownOne(ctx, a.id);
      return { text: a.narrative ? s.citeNarrative : s.cite };
    },
  }),
  define({
    id: 'references.add',
    title: 'Add a source to the open draft from a link, a DOI or an arXiv id, or from its details',
    brief: 'With link, EasyWriter reads the page (and doi.org for a DOI) and fills in what it finds; source sets fields or overrides them.',
    guide: { errors: 'problem means the page could not be read in full. Fill the gaps with references_update' },
    group: 'references',
    risk: 'write',
    undo: 'none',
    needs: ['doc.open'],
    args: {
      type: 'object', additionalProperties: false,
      properties: { link: { type: 'string', maxLength: 2000, description: 'A web link, a DOI or an arXiv id' }, source: { ...SOURCE, description: 'Its details' } },
    },
    result: { type: 'object', required: ['source'] },
    examples: [
      { args: { link: 'https://arxiv.org/abs/2411.00114' } },
      { args: { source: { type: 'web', authors: ['Anthropic'], title: 'Pricing', url: 'https://platform.claude.com/docs/en/about-claude/pricing' } } },
      { args: { link: '10.1145/3290605.3300712', source: { note: 'check the pages' } } },
    ],
    run: async (ctx, a) => {
      if (!a.link && !a.source) fail('invalid_args', 'Give a link or the source details', { path: '', message: 'needs link or source', expected: { required: ['link'] } });
      let found = {};
      let problem = '';
      if (a.link) {
        try {
          ({ source: found, problem } = await ctx.references.lookupLink(a.link));
        } catch (e) {
          fail('invalid_args', e.message, { path: '/link', message: e.message });
        }
      }
      const source = await ctx.references.saveSource({ ...found, ...a.source });
      return { source: shownOne(ctx, source.id), ...(problem && { problem }) };
    },
  }),
  define({
    id: 'references.update',
    title: 'Change the details of a source of the open draft',
    group: 'references',
    risk: 'write',
    undo: 'none',
    needs: ['doc.open'],
    args: { type: 'object', required: ['id', 'source'], additionalProperties: false, properties: { id: ID, source: { ...SOURCE, description: 'The fields to change' } } },
    result: { type: 'object', required: ['source'] },
    examples: [{ args: { id: SAMPLE_ID, source: { year: '2024', pages: '12-19' } } }],
    run: async (ctx, a) => {
      await ctx.references.saveSource({ ...sourceOf(ctx, a.id), ...a.source, id: a.id });
      return { source: shownOne(ctx, a.id) };
    },
  }),
  define({
    id: 'references.remove',
    title: 'Remove a source from the open draft',
    group: 'references',
    risk: 'destructive',
    undo: 'none',
    needs: ['doc.open'],
    args: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID } },
    result: { type: 'object', required: ['source'] },
    examples: [{ args: { id: SAMPLE_ID } }],
    ask: (ctx, a) => `remove the source ${citation(sourceOf(ctx, a.id), '', true)} from the draft`,
    run: async (ctx, a) => {
      const source = shownOne(ctx, sourceOf(ctx, a.id).id);
      await ctx.references.removeSource(a.id);
      return { source };
    },
  }),
  define({
    id: 'references.setStyle',
    title: "Set the open draft's reference style, and with asDefault the style of new drafts",
    brief: 'Citations already in the text keep their style.',
    group: 'references',
    risk: 'write',
    undo: 'none',
    needs: ['doc.open'],
    args: {
      type: 'object', required: ['style'], additionalProperties: false,
      properties: { style: STYLE, asDefault: { type: 'boolean', default: false, description: 'Also make it the default for drafts without a style' } },
    },
    result: { type: 'object', required: ['style'] },
    examples: [{ args: { style: 'ieee' } }, { args: { style: 'harvard', asDefault: true } }],
    run: async (ctx, a) => {
      await ctx.references.setStyle(a.style);
      if (a.asDefault) await ctx.references.setDefaultStyle(a.style);
      return { style: a.style };
    },
  }),
  define({
    id: 'references.insertList',
    title: 'Insert the reference list into the open draft as paragraphs',
    brief: 'Use it for the References section. It is plain text: after the sources change, delete it and insert it again.',
    group: 'references',
    risk: 'write',
    undo: 'doc',
    needs: ['doc.open'],
    args: {
      type: 'object', additionalProperties: false,
      properties: {
        at: { oneOf: [ref('PATH'), { enum: ['start', 'end', 'cursor'] }], default: 'end', description: 'A block path such as [3], or one of start, end, cursor' },
        position: { enum: ['before', 'after'], default: 'after', description: 'Before or after the block at at' },
      },
    },
    result: { type: 'object', required: ['paths'] },
    examples: [{ args: { at: 'end' } }, { args: { at: [12], position: 'after' } }],
    // A numbered draft's sources without a number get theirs first, as the dialog's Insert reference list gives them.
    plan: async (ctx, a) => {
      const list = referenceListRuns(await ctx.references.numberSources(), ctx.references.styleNow());
      if (!list.length) fail('refused', 'The draft has no sources yet', { code: 'no_sources', hint: 'Add them with references_add' });
      const json = list.map((rs) => ({ type: 'paragraph', content: textJson(rs) }));
      return INSERT.plan(ctx, { at: a.at ?? 'end', position: a.position ?? 'after', content: { json } });
    },
  }),
];
