// Citation pool commands for a forum post or page (docs/plans/cleanup/tool-pool-surfaces.md B2): the reference style, Insert
// Bibliography and Add New Source, each with tool search meta. Insert Citation and Manage Sources are the forum toolset's
// (references.insertCitation, references.manageSources). A Document keeps Word's references.citationsBibliography.* commands.
import { createElement as h } from 'react';
import { BookPlus, Hash, ScrollText } from 'lucide-react';
import { WORD_STYLES } from '../references.mjs';
import { register } from '../tooling/registry.js';
import { toast } from './actions.js';
import { ReferenceStyle } from './components/References.jsx';
import { addNewSource, insertReferenceList, openReferences, setStyle, sourcesOf, styleNow } from './references.js';

const fail = (err) => toast(err.message, true);

register('app', {
  // A style id sets the draft's style; run with none (Enter in tool search) it opens Source Manager, which holds the style.
  'references.style': {
    value: () => styleNow(),
    run: (ctx, id) => (id === undefined ? openReferences() : WORD_STYLES.some((r) => r.id === id) ? setStyle(id).catch(fail) : false),
    options: () => h(ReferenceStyle),
    meta: { label: 'Reference style', group: 'Insert', icon: Hash, keywords: ['reference style', 'citation style', 'referencing style', 'harvard', 'ieee', 'apa',
      'mla', 'chicago', 'numbered', 'author date', 'default style'] },
  },
  'references.bibliography': {
    run: () => insertReferenceList().catch(fail),
    enabled: () => sourcesOf().length > 0,
    meta: { label: 'Insert bibliography', group: 'Insert', icon: ScrollText, keywords: ['bibliography', 'reference list', 'works cited', 'references',
      'list of sources', 'insert references'] },
  },
  'references.addSource': {
    run: () => addNewSource().catch(fail),
    meta: { label: 'Add new source', group: 'Insert', icon: BookPlus, headless: false, keywords: ['add source', 'new source', 'create source', 'add reference', 'book',
      'journal article', 'web site', 'cite'] },
  },
}, ['text']);
