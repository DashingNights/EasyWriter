import assert from 'node:assert/strict';
import test from 'node:test';
import {
  citation, citationRuns, cleanSource, formatReference, fromCsl, initials, labels, lookup, nextNumber, parseInput, parseMeta, referenceList,
  referenceRuns, sortSources, styleOf, suffixes,
} from '../src/references.mjs';

const at = '2026-10-24';
const src = (o) => cleanSource({ accessed: at, ...o });
// The user's sample (docs/plans/references.md), notes left out of the list (the user, 2026-10-26).
const SAMPLE = [
  src({ id: 'vosk', authors: ['Alpha Cephei'], title: 'VOSK offline speech recognition API', url: 'https://alphacephei.com/vosk/' }),
  src({ id: 'sid', type: 'preprint', authors: ['Altera.AL', 'Ahn, Andrew', 'Becker, Nic', 'Carroll, Stephanie', 'Christie, Nico', 'Cortes, Manuel', 'Demirci, Arda'],
    year: '2024', title: 'Project Sid: many-agent simulations toward AI civilization', arxiv: '2411.00114', url: 'https://arxiv.org/abs/2411.00114', note: 'preprint' }),
  src({ id: 'cache', authors: ['Anthropic'], title: 'Prompt caching', url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching' }),
  src({ id: 'price', authors: ['Anthropic'], title: 'Pricing', url: 'https://platform.claude.com/docs/en/about-claude/pricing' }),
  src({ id: 'npc', type: 'preprint', authors: ['Borovikov, Igor', 'Harder, Jesse', 'Sadovsky, Michael', 'Beirami, Ahmad'], year: '2019',
    title: 'Towards interactive training of non-player characters in video games', arxiv: '1906.00535', url: 'https://arxiv.org/abs/1906.00535' }),
  src({ id: 'lod', type: 'chapter', authors: ['Brom, Cyril', 'Šerý, Ondřej', 'Poch, Tomáš'], year: '2007', title: 'Simulation level of detail for virtual humans',
    container: 'Intelligent Virtual Agents (IVA 2007)', place: 'Berlin', publisher: 'Springer',
    url: 'https://www.springerprofessional.de/en/simulation-level-of-detail-for-virtual-humans/2882154' }),
  src({ id: 'ace', type: 'article', authors: ['Burnes, Andrew'], year: '2025', date: '2025-03-13', container: 'NVIDIA GeForce News',
    title: 'NVIDIA ACE autonomous game characters debut this month in inZOI & NARAKA: BLADEPOINT MOBILE PC VERSION',
    url: 'https://www.nvidia.com/en-gb/geforce/news/nvidia-ace-naraka-bladepoint-inzoi-launch-this-month/' }),
];

test('the reference list: the sample in the course slide\'s punctuation, sorted, lettered and without notes', () => {
  assert.deepEqual(referenceList([...SAMPLE].reverse()), [
    'Alpha Cephei (n.d.). VOSK offline speech recognition API. Available at: https://alphacephei.com/vosk/ (Accessed: 24 October 2026).',
    'Altera.AL et al. (2024). ‘Project Sid: many-agent simulations toward AI civilization’, arXiv preprint arXiv:2411.00114. Available at: https://arxiv.org/abs/2411.00114 (Accessed: 24 October 2026).',
    'Anthropic (n.d.a). Pricing. Available at: https://platform.claude.com/docs/en/about-claude/pricing (Accessed: 24 October 2026).',
    'Anthropic (n.d.b). Prompt caching. Available at: https://platform.claude.com/docs/en/build-with-claude/prompt-caching (Accessed: 24 October 2026).',
    'Borovikov, I., Harder, J., Sadovsky, M., and Beirami, A. (2019). ‘Towards interactive training of non-player characters in video games’, arXiv preprint arXiv:1906.00535. Available at: https://arxiv.org/abs/1906.00535 (Accessed: 24 October 2026).',
    'Brom, C., Šerý, O., and Poch, T. (2007). ‘Simulation level of detail for virtual humans’, in Intelligent Virtual Agents (IVA 2007). Berlin: Springer. Available at: https://www.springerprofessional.de/en/simulation-level-of-detail-for-virtual-humans/2882154 (Accessed: 24 October 2026).',
    'Burnes, A. (2025). ‘NVIDIA ACE autonomous game characters debut this month in inZOI & NARAKA: BLADEPOINT MOBILE PC VERSION’, NVIDIA GeForce News, 13 March. Available at: https://www.nvidia.com/en-gb/geforce/news/nvidia-ace-naraka-bladepoint-inzoi-launch-this-month/ (Accessed: 24 October 2026).',
  ]);
});

test('italics as the slide: the container, a standalone title and et al.', () => {
  const cox = src({ type: 'chapter', authors: ['Cox, L.', 'Williams, B.', 'Vickers, J.', 'Ward, D.', 'Headleand, C.'], year: '2025',
    title: 'Run-time Performance Comparison of Sparse-set and Archetype Entity-Component Systems', container: 'Computer Graphics and Visual Computing (CGVC)',
    publisher: 'The Eurographics Association', accessed: '' });
  assert.deepEqual(referenceRuns(cox), [
    { text: 'Cox, L., Williams, B., Vickers, J., Ward, D., and Headleand, C. (2025). ‘Run-time Performance Comparison of Sparse-set and Archetype Entity-Component Systems’, in ' },
    { text: 'Computer Graphics and Visual Computing (CGVC)', italic: true }, { text: '. The Eurographics Association.' }]);
  assert.deepEqual(referenceRuns(SAMPLE[3]).slice(0, 2), [{ text: 'Anthropic (n.d.). ' }, { text: 'Pricing', italic: true }]);
  const davis = src({ authors: ['Davis, A.', 'Lee, B.', 'Ng, C.', 'Ode, D.'], year: '2026', title: 'Citations' });
  assert.deepEqual(citationRuns(davis, '', true), [{ text: 'Davis ' }, { text: 'et al.', italic: true }, { text: ' (2026)' }]);
  assert.equal(citation(davis), '(Davis et al., 2026)');
});

test('citations: bracketed and narrative, with the letter, two and three names, et al. from four', () => {
  const suf = suffixes(SAMPLE);
  const byId = (id) => SAMPLE.find((s) => s.id === id);
  assert.equal(citation(byId('price'), suf.get('price')), '(Anthropic, n.d.a)');
  assert.equal(citation(byId('cache'), suf.get('cache'), true), 'Anthropic (n.d.b)');
  assert.equal(citation(byId('npc'), suf.get('npc')), '(Borovikov et al., 2019)');
  assert.equal(citation(byId('lod'), '', true), 'Brom, Šerý and Poch (2007)');
  assert.equal(citation(src({ authors: ['Lee, Ann', 'Chan, Bo'], year: '2020' })), '(Lee and Chan, 2020)');
  assert.equal(citation(src({ title: 'Untitled page' })), '(Untitled page, n.d.)'); // no authors: the title
  assert.equal(suf.get('vosk'), undefined);
});

test('entries: journal volume and pages, a book, a DOI link, no authors, no link, titles ending in a question mark', () => {
  assert.equal(formatReference(src({ type: 'article', authors: ['Lee, Ann'], year: '2021', title: 'Why NPCs talk?', container: 'Games Journal',
    volume: '12', issue: '3', pages: '45–67', date: '2021-05-01', doi: '10.1000/xyz' })),
  'Lee, A. (2021). ‘Why NPCs talk?’, Games Journal, 12(3), pp. 45–67. Available at: https://doi.org/10.1000/xyz (Accessed: 24 October 2026).');
  assert.equal(formatReference(src({ type: 'book', authors: ['Tolkien, John Ronald Reuel'], year: '1954', title: 'The Lord of the Rings', place: 'London',
    publisher: 'Allen & Unwin', accessed: '' })), 'Tolkien, J.R.R. (1954). The Lord of the Rings. London: Allen & Unwin.');
  assert.equal(formatReference(src({ title: 'Release notes', year: '2026', url: 'https://example.com/notes' })),
    'Release notes (2026). Available at: https://example.com/notes (Accessed: 24 October 2026).');
  assert.equal(initials('Jean-Paul'), 'J.-P.');
  assert.equal(initials('J. R. R.'), 'J.R.R.');
});

test('order: authors, then year with n.d. last; letters follow title order', () => {
  const list = [src({ id: 'b', authors: ['Ng, Al'], title: 'B' }), src({ id: 'a', authors: ['Ng, Al'], year: '2020', title: 'A' }),
    src({ id: 'c', authors: ['Ng, Al'], year: '2020', title: 'C' }), src({ id: 'z', authors: ['Abe, Jo'], year: '2030', title: 'Z' })];
  assert.deepEqual(sortSources(list).map((s) => s.id), ['z', 'a', 'c', 'b']);
  assert.deepEqual([...suffixes(list)].sort(), [['a', 'a'], ['c', 'b']]);
});

test('parseInput: links, bare domains, DOIs and arXiv ids', () => {
  assert.deepEqual(parseInput('https://arxiv.org/pdf/2411.00114v2'), { arxiv: '2411.00114', url: 'https://arxiv.org/abs/2411.00114' });
  assert.deepEqual(parseInput('arXiv:1906.00535'), { arxiv: '1906.00535', url: 'https://arxiv.org/abs/1906.00535' });
  assert.deepEqual(parseInput('arxiv.org/abs/2411.00114'), { arxiv: '2411.00114', url: 'https://arxiv.org/abs/2411.00114' });
  assert.deepEqual(parseInput('https://doi.org/10.1145/3290605.3300712'), { doi: '10.1145/3290605.3300712' });
  assert.deepEqual(parseInput('doi:10.1007/978-3-540-74997-4_22'), { doi: '10.1007/978-3-540-74997-4_22' });
  assert.deepEqual(parseInput('alphacephei.com/vosk/'), { url: 'https://alphacephei.com/vosk/' });
  assert.equal(parseInput('not a link'), null);
  assert.equal(parseInput(''), null);
});

const ARXIV_HTML = `<html><head><title>[2411.00114] Project Sid</title>
<meta name="citation_title" content="Project Sid: Many-agent simulations toward AI civilization" />
<meta name="citation_author" content="AL, Altera" /><meta name="citation_author" content="Ahn, Andrew" />
<meta name="citation_date" content="2024/10/31" /><meta name="citation_arxiv_id" content="2411.00114" />
<meta property="og:site_name" content="arXiv.org" /></head><body></body></html>`;

test('parseMeta: arXiv tags, a news page with Open Graph and JSON-LD, a docs page with only a <title>', () => {
  const ax = parseMeta(ARXIV_HTML);
  assert.equal(ax.type, 'preprint');
  assert.deepEqual(ax.authors, ['AL, Altera', 'Ahn, Andrew']);
  assert.equal(ax.year, '2024');
  assert.equal(ax.arxiv, '2411.00114');
  assert.equal(ax.container, '');
  const news = parseMeta(`<head><meta property="og:type" content="article"><meta property="og:site_name" content="NVIDIA GeForce News">
    <meta property="og:title" content="NVIDIA ACE debut &amp; more"><meta property="article:published_time" content="2025-03-13T09:00:00Z">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"NewsArticle","headline":"x","author":{"@type":"Person","name":"Andrew Burnes"}}]}</script></head>`);
  assert.deepEqual([news.type, news.title, news.container, news.year, news.date, news.authors], ['article', 'NVIDIA ACE debut & more', 'NVIDIA GeForce News',
    '2025', '2025-03-13', ['Burnes, Andrew']]);
  const docs = parseMeta('<head><title>Pricing - Claude Docs</title><meta property="og:site_name" content="Claude Docs"></head>');
  assert.deepEqual([docs.type, docs.title, docs.site, docs.authors], ['web', 'Pricing', 'Claude Docs', []]);
  const byline = parseMeta('<head><meta name="author" content="Ann Lee, Bo Chan and Cy Diaz"><title>T</title></head>');
  assert.deepEqual(byline.authors, ['Lee, Ann', 'Chan, Bo', 'Diaz, Cy']);
});

test('fromCsl: a Crossref proceedings paper', () => {
  const r = fromCsl({ type: 'paper-conference', title: 'Simulation <i>level</i> of detail', author: [{ family: 'Brom', given: 'Cyril' }, { literal: 'IVA Team' }],
    issued: { 'date-parts': [[2007, 9]] }, 'container-title': 'Intelligent Virtual Agents', publisher: 'Springer', page: '89-102', DOI: '10.1007/978-3-540-74997-4_9' });
  assert.deepEqual([r.type, r.title, r.authors, r.year, r.date, r.pages], ['chapter', 'Simulation level of detail', ['Brom, Cyril', 'IVA Team'], '2007', '', '89–102']);
});

test('lookup: page tags; a DOI page that blocks the app falls back to doi.org; a web page takes its site as author', async () => {
  const calls = [];
  const pages = {
    'https://arxiv.org/abs/2411.00114': { ok: true, status: 200, type: 'text/html; charset=utf-8', body: ARXIV_HTML },
    'https://dl.acm.org/doi/10.1145/123.456': { ok: false, status: 403, type: 'text/html', body: '' },
    'https://doi.org/10.1145/123.456': { ok: true, status: 200, type: 'application/json', body: JSON.stringify({ type: 'article-journal', title: 'Talking NPCs',
      author: [{ family: 'Lee', given: 'Ann' }], issued: { 'date-parts': [[2022, 4, 2]] }, 'container-title': 'CHI', DOI: '10.1145/123.456' }) },
    'https://platform.claude.com/docs/en/about-claude/pricing': { ok: true, status: 200, type: 'text/html',
      body: '<head><title>Pricing - Anthropic</title><meta property="og:site_name" content="Anthropic"></head>' },
  };
  const get = async (url, accept) => {
    calls.push([url, accept ?? null]);
    if (!pages[url]) throw new Error('offline');
    return pages[url];
  };
  const ax = await lookup('https://arxiv.org/abs/2411.00114v1', { get, today: at });
  assert.equal(ax.problem, '');
  assert.deepEqual([ax.source.type, ax.source.arxiv, ax.source.url, ax.source.accessed], ['preprint', '2411.00114', 'https://arxiv.org/abs/2411.00114', at]);
  assert.ok(!calls.some(([u]) => u.startsWith('https://doi.org/')), 'an arXiv paper skips doi.org');
  const acm = await lookup('https://dl.acm.org/doi/10.1145/123.456', { get, today: at });
  assert.deepEqual([acm.problem, acm.source.title, acm.source.authors, acm.source.doi, acm.source.url, acm.source.type],
    ['', 'Talking NPCs', ['Lee, Ann'], '10.1145/123.456', 'https://dl.acm.org/doi/10.1145/123.456', 'article']);
  assert.equal(calls.find(([u]) => u === 'https://doi.org/10.1145/123.456')[1], 'application/vnd.citationstyles.csl+json');
  const web = await lookup('https://platform.claude.com/docs/en/about-claude/pricing', { get, today: at });
  assert.deepEqual([web.source.type, web.source.authors, web.source.title], ['web', ['Anthropic'], 'Pricing']);
  const off = await lookup('https://example.org/x', { get, today: at });
  assert.match(off.problem, /could not be reached/);
  assert.equal(off.source.url, 'https://example.org/x');
  await assert.rejects(lookup('hello', { get, today: at }), /Paste a link/);
});

test('styles: the draft\'s own, else the default, else Harvard', () => {
  assert.equal(styleOf({ referenceStyle: 'ieee' }, { referenceStyle: 'harvard' }), 'ieee');
  assert.equal(styleOf({}, { referenceStyle: 'ieee' }), 'ieee');
  assert.equal(styleOf(null, null), 'harvard');
  assert.equal(styleOf({ referenceStyle: 'apa' }, {}), 'harvard');
});

test('numbered (IEEE): numbers kept, the rest next in stored order; an entry per type; citations', () => {
  const list = [
    src({ id: 'w', authors: ['Anthropic'], title: 'Pricing', url: 'https://example.com/pricing' }),
    src({ id: 'a', type: 'article', authors: ['Lee, Ann', 'Chan, Bo'], year: '2021', title: 'Talking to NPCs', container: 'Games Journal', volume: '12',
      issue: '3', pages: '45–67', doi: '10.1000/xyz', num: 2 }),
    src({ id: 'c', type: 'chapter', authors: ['Ng, Al'], year: '2022', title: 'Crowds of agents', container: 'Proc. of Agents', publisher: 'ACM', pages: '1–9', num: 1 }),
    src({ id: 'p', type: 'preprint', authors: ['Borovikov, Igor', 'Harder, Jesse', 'Sadovsky, Michael', 'Beirami, Ahmad'], year: '2019', title: 'Towards NPCs',
      arxiv: '1906.00535' }),
    src({ id: 'b', type: 'book', authors: ['Tolkien, John Ronald Reuel'], year: '1954', title: 'The Lord of the Rings', place: 'London', publisher: 'Allen & Unwin' }),
  ];
  assert.equal(nextNumber(list), 3);
  assert.deepEqual([...labels(list, 'ieee')], [['w', '3'], ['a', '2'], ['c', '1'], ['p', '4'], ['b', '5']]);
  assert.deepEqual(referenceList(list, 'ieee'), [
    '[1] A. Ng, “Crowds of agents,” in Proc. of Agents, ACM, 2022, pp. 1–9.',
    '[2] A. Lee and B. Chan, “Talking to NPCs,” Games Journal, vol. 12, no. 3, pp. 45–67, 2021, doi: 10.1000/xyz.',
    '[3] Anthropic, “Pricing.” Accessed: Oct. 24, 2026. [Online]. Available: https://example.com/pricing',
    '[4] I. Borovikov, J. Harder, M. Sadovsky, and A. Beirami, “Towards NPCs,” 2019, arXiv:1906.00535.',
    '[5] J. R. R. Tolkien, The Lord of the Rings. London: Allen & Unwin, 1954.',
  ]);
  assert.equal(citation(list[1], '2', false, 'ieee'), '[2]');
  assert.equal(citation(list[1], '2', true, 'ieee'), 'Lee and Chan [2]');
  assert.deepEqual(sortSources(list, 'ieee').map((s) => s.id), ['c', 'a', 'w', 'p', 'b']);
  assert.equal(cleanSource({ num: 3 }).num, 3);
  assert.equal(cleanSource({ num: 0 }).num, undefined);
});
