// References (docs/wiki/references.md): a draft's saved sources (draft.sources), their reference list entries and in-text
// citations in the draft's style (Harvard or numbered IEEE), and the details read from a pasted link. Pure: node --test imports
// it (test/references.test.mjs); the network comes in as get(url, accept) (app/references.js over main.js references.fetch).

// A source: {id, type, authors, year, title, container, date, volume, issue, pages, place, publisher, doi, arxiv, url, accessed,
// note, num?}. authors: "Family, Given" for a person, anything without a comma for an organisation or a handle. year '' prints
// n.d.; date and accessed are YYYY-MM-DD. note is for the user only: the reference list leaves it out (the user, 2026-10-26).
// num: its number in a numbered draft, fixed when it is first cited or listed (citations are plain text, so it never changes).
export const TYPES = [['web', 'Web page'], ['article', 'Article'], ['preprint', 'Preprint'], ['chapter', 'Paper or chapter'], ['book', 'Book']];

// The styles (the user, 2026-10-26): a draft has its own (draft.referenceStyle: picked in References, else set when it gets its
// first source); settings.referenceStyle is the default for drafts without one.
export const STYLES = [['harvard', 'Harvard'], ['ieee', 'Numbered (IEEE)']];
const STYLE_IDS = STYLES.map(([id]) => id);
/** The style of `draft`: its own, else the default in `settings`, else Harvard. `word`: a Document, which also takes Word's styles
 * (WORD_STYLES); a forum post keeps the two. */
export const styleOf = (draft, settings, word = false) => [draft?.referenceStyle, settings?.referenceStyle]
  .find((s) => (word ? WORD_STYLE_IDS : STYLE_IDS).includes(s)) ?? 'harvard';
const TYPE_IDS = TYPES.map(([id]) => id);
const TEXT_FIELDS = ['year', 'title', 'container', 'date', 'volume', 'issue', 'pages', 'place', 'publisher', 'doi', 'arxiv', 'url', 'accessed', 'note'];

// The fields each type prints (the form shows these, after authors and year, and the note last); container's label per type.
export const FIELDS = {
  web: ['title', 'url', 'accessed'],
  article: ['title', 'container', 'date', 'volume', 'issue', 'pages', 'doi', 'url', 'accessed'],
  preprint: ['title', 'arxiv', 'container', 'doi', 'url', 'accessed'],
  chapter: ['title', 'container', 'pages', 'place', 'publisher', 'doi', 'url', 'accessed'],
  book: ['title', 'place', 'publisher', 'doi', 'url', 'accessed'],
};
export const CONTAINER = { article: 'Journal or site', preprint: 'Server', chapter: 'Book or proceedings' };

const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 2000) : '');

/** `s` with only the source fields, trimmed; an unknown type is a web page. */
export function cleanSource(s = {}) {
  const out = { ...(typeof s.id === 'string' && s.id && { id: s.id }), type: TYPE_IDS.includes(s.type) ? s.type : 'web',
    authors: (Array.isArray(s.authors) ? s.authors : []).map(str).filter(Boolean).slice(0, 100) };
  for (const k of TEXT_FIELDS) out[k] = str(s[k]);
  if (Number.isInteger(s.num) && s.num > 0) out.num = s.num;
  // A Document's keys (Word's Create Source), kept only when set so a forum post's sources stay as they were.
  if (SOURCE_TYPE_IDS.includes(s.wtype)) out.wtype = s.wtype;
  if (str(s.tag)) out.tag = str(s.tag).replace(/\s+/g, '');
  if (s.placeholder === true) out.placeholder = true;
  if (typeof s.corporate === 'boolean') out.corporate = s.corporate; // Create Source's Corporate Author box
  if (str(s.lang)) out.lang = str(s.lang);
  const extra = Object.fromEntries(Object.entries(s.extra && typeof s.extra === 'object' ? s.extra : {}).map(([k, v]) => [k, str(v)]).filter(([, v]) => v));
  // Create Source's Year, Month and Day Accessed become the access date the styles print, when they make a whole date.
  const day = accessedOf(...ACCESSED_KEYS.map((k) => extra[k]));
  if (day) {
    out.accessed = day;
    for (const k of ACCESSED_KEYS) delete extra[k];
  }
  if (Object.keys(extra).length) out.extra = extra;
  return out;
}

const ACCESSED_KEYS = ['yearAccessed', 'monthAccessed', 'dayAccessed'];
/** Year, month (a name, its first three letters or a number) and day as YYYY-MM-DD, or '' when they make no whole date. */
function accessedOf(y = '', m = '', d = '') {
  const month = /^\d+$/.test(m) ? Number(m) : MONTHS.findIndex((x) => m.length >= 3 && x.toLowerCase().startsWith(m.toLowerCase())) + 1;
  return /^\d{4}$/.test(y) && month >= 1 && month <= 12 && /^\d{1,2}$/.test(d) && d >= 1 && d <= 31 ? `${y}-${pad(month)}-${pad(d)}` : '';
}

// ---------- Names ----------
const person = (a) => {
  const i = a.indexOf(',');
  return i < 0 ? { name: a } : { family: a.slice(0, i).trim(), given: a.slice(i + 1).trim() };
};
/** Initials of given names: "Ilya" → "I.", "Jean-Paul" → "J.-P.", "J. R. R." → "J.R.R.". */
export const initials = (given) => given.split(/[\s.]+/).filter(Boolean)
  .map((w) => w.split('-').filter(Boolean).map((p) => `${[...p][0].toUpperCase()}.`).join('-')).join('');
const listName = (a) => {
  const p = person(a);
  if (p.name) return p.name;
  const i = initials(p.given);
  return i ? `${p.family}, ${i}` : p.family;
};
const citeName = (a) => person(a).name ?? person(a).family;
const join = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
// The list puts a comma before "and" from three names on: "Ward, D., and Headleand, C." (the user's course slide, 2026-10-26).
const serial = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`);

// Italics (the course slide): containers, standalone titles and et al. are marked \u0001…\u0002 while an entry is built.
// formatReference, citation and referenceList give plain text, the *Runs functions [{text, italic?}] for the editor.
const it = (t) => (t ? `\u0001${t}\u0002` : '');
const plain = (s) => s.replace(/[\u0001\u0002]/g, '');
const runs = (s) => s.split(/(\u0001[^\u0002]*\u0002)/).filter(Boolean).map((p) => (p[0] === '\u0001' ? { text: p.slice(1, -1), italic: true } : { text: p }));

// ponytail: fixed cut-offs. A reference list names up to six authors (the course slide names five), a citation three.
const LIST_MAX = 6;
const CITE_MAX = 3;
const listAuthors = (a) => (a.length > LIST_MAX ? `${listName(a[0])} ${it('et al.')}` : serial(a.map(listName)));
const citeAuthors = (a) => (a.length > CITE_MAX ? `${citeName(a[0])} ${it('et al.')}` : join(a.map(citeName)));

// ---------- Dates ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');
/** `d` (default now) as YYYY-MM-DD in local time. */
export const isoDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** "2026-10-24" → "24 October 2026", `day` only: "24 October"; text that is no such date stays as it is. */
export function longDate(s, day = false) {
  const m = s.match(ISO);
  if (!m || !MONTHS[m[2] - 1]) return s;
  return `${Number(m[3])} ${MONTHS[m[2] - 1]}${day ? '' : ` ${m[1]}`}`;
}

// ---------- The list and citations ----------
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const collate = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });
const who = (s) => (s.authors.length ? citeAuthors(s.authors) : s.title || 'Untitled');
const letter = (i) => (i < 26 ? String.fromCharCode(97 + i) : letter(Math.floor(i / 26) - 1) + letter(i % 26));

/** Map source id → its letter ('a', 'b' …) where two or more sources cite the same (same names and year, n.d. included),
 * lettered by title. */
export function suffixes(sources) {
  const groups = new Map();
  for (const s of sources) {
    const key = fold(plain(`${who(s)}|${s.year}`));
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out = new Map();
  for (const g of groups.values()) {
    if (g.length > 1) [...g].sort((a, b) => collate(a.title, b.title)).forEach((s, i) => out.set(s.id, letter(i)));
  }
  return out;
}

/** The number a numbered draft's next cited source gets. */
export const nextNumber = (sources) => Math.max(0, ...sources.map((s) => s.num ?? 0)) + 1;

/** Map source id → its label in `style`: Harvard, its letter where it needs one (suffixes); numbered, its num, else the next
 * numbers in stored order (what listing them now gives them). */
export function labels(sources, style = 'harvard') {
  if (!numbered(style)) return suffixes(sources);
  let next = nextNumber(sources) - 1;
  return new Map(sources.map((s) => [s.id, String(s.num ?? ++next)]));
}

const cite = (s, label, narrative, style) => {
  if (WORD_ONLY[style]) return wordCiteOne(s, label, WORD_ONLY[style]);
  if (style === 'ieee') return narrative ? `${who(s)} [${label}]` : `[${label}]`;
  const year = `${s.year || 'n.d.'}${label}`;
  return narrative ? `${who(s)} (${year})` : `(${who(s)}, ${year})`;
};
/** The in-text citation with `label` (labels): Harvard "(Anthropic, n.d.a)" or narrative "Anthropic (n.d.a)", "Davis et al.
 * (2026)" from four authors; numbered "[1]" or narrative "Campbell and Verbrugge [1]". */
export const citation = (s, label = '', narrative = false, style = 'harvard') => plain(cite(s, label, narrative, style));
/** citation as runs: et al. in italics. */
export const citationRuns = (s, label = '', narrative = false, style = 'harvard') => runs(cite(s, label, narrative, style));

const end = (s) => (/[.?!]\u0002?$/.test(s) ? s : `${s}.`);
const pages = (p) => (p ? `${/[-–]/.test(p) ? 'pp.' : 'p.'} ${p}` : '');

// One Harvard entry, marked: the authors (none: the title in their place), the year and a full stop, the title (quoted when it
// sits in a container, else in italics), the container in italics, the publisher, the link and the access date.
function harvard(s, suffix) {
  const year = `(${s.year || 'n.d.'}${suffix}).`;
  const standalone = s.type === 'web' || s.type === 'book';
  const lead = s.title || 'Untitled';
  const head = s.authors.length ? `${listAuthors(s.authors)} ${year}` : `${standalone ? it(lead) : `‘${lead}’`} ${year}`;
  const title = s.authors.length ? s.title : ''; // without authors the title leads
  const inside = (where) => (title || where) && end(title ? `‘${title}’${where ? `, ${where}` : ''}` : where);
  const publisher = s.publisher ? `${s.place ? `${s.place}: ` : ''}${s.publisher}.` : '';
  let body;
  if (s.type === 'article') {
    const volume = s.volume ? `${s.volume}${s.issue ? `(${s.issue})` : ''}` : s.issue && `(${s.issue})`;
    body = [inside([it(s.container), volume, pages(s.pages), !volume && s.date && longDate(s.date, true)].filter(Boolean).join(', '))];
  } else if (s.type === 'preprint') {
    body = [inside(s.arxiv ? `arXiv preprint arXiv:${s.arxiv}` : s.container ? `${it(s.container)} preprint` : 'Preprint')];
  } else if (s.type === 'chapter') {
    body = [inside([s.container && `in ${it(s.container)}`, pages(s.pages)].filter(Boolean).join(', ')), publisher];
  } else body = [title && end(it(title)), s.type === 'book' && publisher];
  const link = s.url || (s.doi ? `https://doi.org/${s.doi}` : '');
  const available = link && `Available at: ${link}${s.accessed ? ` (Accessed: ${longDate(s.accessed)})` : ''}.`;
  return [head, ...body, available].filter(Boolean).join(' ');
}

const MON = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
/** "2026-10-24" → "Oct. 24, 2026"; text that is no such date stays as it is. */
const ieeeDate = (s) => {
  const m = s.match(ISO);
  return m && MON[m[2] - 1] ? `${MON[m[2] - 1]} ${Number(m[3])}, ${m[1]}` : s;
};
const ieeeName = (a) => {
  const p = person(a);
  if (p.name) return p.name;
  const i = initials(p.given).replace(/\.(?=[^-])/g, '. '); // "J. R. R.", "J.-P."
  return i ? `${i} ${p.family}` : p.family;
};
const ieeeAuthors = (a) => (a.length > LIST_MAX ? `${ieeeName(a[0])} ${it('et al.')}` : serial(a.map(ieeeName)));

// One IEEE entry, marked (IEEE Reference Guide): [n], the authors initials first, the title in double quotes (a book's in
// italics), the container in italics, volume, number, pages and date, then the DOI, else the access date and the link.
function ieee(s, num) {
  const byline = s.authors.length ? `${ieeeAuthors(s.authors)}, ` : '';
  const title = s.title || 'Untitled';
  const year = s.year || 'n.d.';
  const doi = s.doi && `doi: ${s.doi}`;
  const publisher = s.publisher ? `${s.place ? `${s.place}: ` : ''}${s.publisher}` : s.place;
  const quoted = (rest) => `${byline}“${title}${/[?!]$/.test(title) ? '' : ','}” ${end(rest.filter(Boolean).join(', '))}`;
  let main;
  if (s.type === 'article') {
    main = quoted([it(s.container), s.volume && `vol. ${s.volume}`, s.issue && `no. ${s.issue}`, pages(s.pages), s.date ? ieeeDate(s.date) : year, doi]);
  } else if (s.type === 'chapter') main = quoted([s.container && `in ${it(s.container)}`, publisher, year, pages(s.pages), doi]);
  else if (s.type === 'preprint') main = quoted([year, s.arxiv ? `arXiv:${s.arxiv}` : it(s.container), doi]);
  else if (s.type === 'book') main = [`${byline}${end(it(title))}`, end([publisher, year].filter(Boolean).join(', ')), doi && end(doi)].filter(Boolean).join(' ');
  else main = `${byline}“${end(title)}”`;
  const online = !s.doi && s.url && [s.accessed && `Accessed: ${ieeeDate(s.accessed)}.`, `[Online]. Available: ${s.url}`].filter(Boolean).join(' ');
  return [num && `[${num}]`, main, online].filter(Boolean).join(' '); // no num: a source not cited yet, shown in References
}

const entry = (s, label, style) => (WORD_ONLY[style] ? wordEntry(s, label, WORD_ONLY[style]) : style === 'ieee' ? ieee(s, label) : harvard(s, label));
/** One reference list entry as plain text in `style`, with its `label` (labels): Harvard in the course slide's punctuation
 * (docs/wiki/references.md), numbered as the IEEE Reference Guide. */
export const formatReference = (s, label = '', style = 'harvard') => plain(entry(s, label, style));
/** formatReference as runs: containers, standalone titles and et al. in italics. */
export const referenceRuns = (s, label = '', style = 'harvard') => runs(entry(s, label, style));

/** `sources` in reference list order: Harvard by authors (or title), then year (n.d. last), then letter; numbered by number. */
export function sortSources(sources, style = 'harvard') {
  const lab = labels(sources, style);
  if (numbered(style)) return [...sources].sort((a, b) => lab.get(a.id) - lab.get(b.id));
  if (WORD_ONLY[style]) return wordSort(sources, WORD_ONLY[style]);
  const head = (s) => plain(s.authors.length ? listAuthors(s.authors) : s.title);
  return [...sources].sort((a, b) => collate(head(a), head(b)) || (!a.year - !b.year) || collate(a.year, b.year)
    || collate(lab.get(a.id) ?? '', lab.get(b.id) ?? ''));
}

const entries = (sources, style) => {
  const lab = labels(sources, style);
  return sortSources(sources, style).map((s) => entry(s, lab.get(s.id) ?? '', style));
};
/** The reference list in `style`: one plain entry per source, in order. */
export const referenceList = (sources, style = 'harvard') => entries(sources, style).map(plain);
/** The reference list as runs, one array per entry. */
export const referenceListRuns = (sources, style = 'harvard') => entries(sources, style).map(runs);
/** Runs as TipTap JSON text nodes (italic: the italic mark, which both editors have). */
export const textJson = (rs) => rs.map((r) => ({ type: 'text', text: r.text, ...(r.italic && { marks: [{ type: 'italic' }] }) }));

// ---------- Word's sources and styles (docs/plans/word/briefs/citations.md) ----------
// A Document cites through CITATION and BIBLIOGRAPHY fields (src/document/wp/citations). Its sources are the same draft.sources
// with a few more keys: wtype (Word's source type), tag (the name a field cites it by), placeholder, lang and extra (the Word
// fields the source model has no key for). A forum post never sees them.

// A field of a source type's form: [key, label]. Keys of the source model go there; any other key goes to source.extra.
const F = {
  title: ['title', 'Title'], year: ['year', 'Year'], month: ['month', 'Month'], day: ['day', 'Day'], city: ['place', 'City'],
  state: ['stateProvince', 'State/Province'], country: ['countryRegion', 'Country/Region'], publisher: ['publisher', 'Publisher'],
  editor: ['editor', 'Editor'], volume: ['volume', 'Volume'], volumes: ['numberVolumes', 'Number of Volumes'], translator: ['translator', 'Translator'],
  shortTitle: ['shortTitle', 'Short Title'], standard: ['standardNumber', 'Standard Number'], pages: ['pages', 'Pages'], edition: ['edition', 'Edition'],
  comments: ['comments', 'Comments'], medium: ['medium', 'Medium'], yearAccessed: ['yearAccessed', 'Year Accessed'],
  monthAccessed: ['monthAccessed', 'Month Accessed'], dayAccessed: ['dayAccessed', 'Day Accessed'], url: ['url', 'URL'], doi: ['doi', 'DOI'],
  issue: ['issue', 'Issue'], bookTitle: ['container', 'Book Title'], journal: ['container', 'Journal Name'], periodical: ['container', 'Periodical Title'],
  conference: ['container', 'Conference Publication Name'], webPage: ['title', 'Name of Web Page'], webSite: ['container', 'Name of Web Site'],
  institution: ['publisher', 'Institution'], department: ['department', 'Department'], reportType: ['reportType', 'Report Type'],
  album: ['container', 'Album Title'], production: ['publisher', 'Production Company'], theater: ['publisher', 'Theater'],
  distributor: ['publisher', 'Distributor'], patentNumber: ['patentNumber', 'Patent Number'], type: ['kind', 'Type'],
  caseNumber: ['caseNumber', 'Case Number'], court: ['publisher', 'Court'], reporter: ['reporter', 'Reporter'],
};
const ACCESSED = [F.yearAccessed, F.monthAccessed, F.dayAccessed];
const MORE = [F.shortTitle, F.standard, F.comments, F.medium, ...ACCESSED, F.url, F.doi];

/** Word's 17 source types in the Create Source list's order (probe/dialogs/create-source.json, verified). Each: id (Word's
 * b:SourceType), label, author (the label of its name list, null: none), short (the recommended fields), all (what Show All
 * Bibliography Fields adds), verified (only Book's fields were probed: its short set and the first rows of its full set; the
 * other types' fields come from Word knowledge, unverified). */
export const SOURCE_TYPES = [
  { id: 'Book', label: 'Book', author: 'Author', verified: true, short: [F.title, F.year, F.city, F.publisher],
    all: [F.state, F.country, F.editor, F.volume, F.volumes, F.translator, F.pages, F.edition, ...MORE] },
  { id: 'BookSection', label: 'Book Section', author: 'Author', short: [F.title, F.bookTitle, F.year, F.pages, F.city, F.publisher],
    all: [F.state, F.country, F.editor, F.volume, F.volumes, F.translator, F.edition, ...MORE] },
  { id: 'JournalArticle', label: 'Journal Article', author: 'Author', short: [F.title, F.journal, F.year, F.pages],
    all: [F.editor, F.publisher, F.volume, F.issue, F.month, F.day, ...MORE] },
  { id: 'ArticleInAPeriodical', label: 'Article in a Periodical', author: 'Author', short: [F.title, F.periodical, F.year, F.month, F.day, F.pages],
    all: [F.editor, F.edition, F.volume, F.issue, ...MORE] },
  { id: 'ConferenceProceedings', label: 'Conference Proceedings', author: 'Author', short: [F.title, F.pages, F.year, F.conference, F.city, F.publisher],
    all: [F.editor, F.volume, F.volumes, F.state, F.country, ...MORE] },
  { id: 'Report', label: 'Report', author: 'Author', short: [F.title, F.year, F.publisher, F.city],
    all: [F.department, F.reportType, F.state, F.country, F.pages, ...MORE] },
  { id: 'InternetSite', label: 'Web site', author: 'Author', short: [F.webPage, F.year, F.month, F.day, ...ACCESSED, F.url],
    all: [F.editor, F.production, F.shortTitle, F.standard, F.comments, F.medium, F.doi] },
  { id: 'DocumentFromInternetSite', label: 'Document From Web site', author: 'Author', short: [F.webPage, F.webSite, F.year, F.month, F.day, ...ACCESSED, F.url],
    all: [F.editor, F.production, F.shortTitle, F.standard, F.comments, F.medium, F.doi] },
  { id: 'ElectronicSource', label: 'Electronic Source', author: 'Author', short: [F.title, F.year, F.city, F.publisher],
    all: [F.editor, F.translator, F.month, F.day, F.edition, F.state, F.country, ...MORE] },
  { id: 'Art', label: 'Art', author: 'Artist', short: [F.title, F.year, F.institution, F.city], all: [F.medium, F.state, F.country, ...MORE] },
  { id: 'SoundRecording', label: 'Sound Recording', author: 'Composer', short: [F.title, F.album, F.year, F.production, F.city],
    all: [F.month, F.day, F.medium, F.state, F.country, ...MORE] },
  { id: 'Performance', label: 'Performance', author: 'Writer', short: [F.title, F.theater, F.city, F.year], all: [F.month, F.day, F.state, F.country, ...MORE] },
  { id: 'Film', label: 'Film', author: 'Performer', short: [F.title, F.year, F.distributor], all: [F.city, F.medium, F.country, ...MORE] },
  { id: 'Interview', label: 'Interview', author: 'Interviewee', short: [F.title, F.year, F.month, F.day], all: [F.publisher, F.city, F.medium, ...MORE] },
  { id: 'Patent', label: 'Patent', author: 'Inventor', short: [F.title, F.year, F.month, F.day, F.country, F.patentNumber], all: [F.type, ...MORE] },
  { id: 'Case', label: 'Case', author: null, short: [F.title, F.caseNumber, F.court, F.year, F.month, F.day, F.reporter], all: [F.volume, F.pages, ...MORE] },
  { id: 'Misc', label: 'Miscellaneous', author: 'Author', short: [F.title, F.year, F.city, F.publisher], all: [F.month, F.day, F.editor, F.volume, ...MORE] },
];
const SOURCE_TYPE_IDS = SOURCE_TYPES.map((t) => t.id);
// Today's five types as Word's (the brief), and back: a Word type to the type the forum post's builder prints it as.
const TO_WORD = { web: 'InternetSite', article: 'JournalArticle', preprint: 'Report', chapter: 'BookSection', book: 'Book' };
const FROM_WORD = { InternetSite: 'web', DocumentFromInternetSite: 'web', ElectronicSource: 'web', JournalArticle: 'article',
  ArticleInAPeriodical: 'article', BookSection: 'chapter', ConferenceProceedings: 'chapter' };
/** Source `s`'s Word type: its own, else its type's (web → Web site, article → Journal Article, preprint → Report, chapter → Book
 * Section, book → Book). */
export const wordTypeOf = (s) => (SOURCE_TYPE_IDS.includes(s?.wtype) ? s.wtype : TO_WORD[s?.type] ?? 'InternetSite');
/** The builder type a Word type prints as: `old` (the source's type) while the Word type is still that type's, else the nearest. */
export const typeFromWord = (wtype, old) => (old && TO_WORD[old] === wtype ? old : FROM_WORD[wtype] ?? 'book');
/** The value of field `key` of source `s` (a model key, else s.extra[key]). */
export function fieldOf(s, key) {
  if (TEXT_FIELDS.includes(key)) return s[key] ?? '';
  // The access date shows in Create Source's three Accessed boxes (cleanSource puts them back together).
  const m = !s.extra?.[key] && ACCESSED_KEYS.includes(key) && s.accessed?.match(ISO);
  if (m) return [m[1], MONTHS[m[2] - 1], String(Number(m[3]))][ACCESSED_KEYS.indexOf(key)] ?? '';
  return s.extra?.[key] ?? '';
}
/** Whether `key` is a key of the source model (else it lives in source.extra). */
export const modelKey = (key) => TEXT_FIELDS.includes(key);

/** The tag Word gives source `s`: the first three letters of the first author's family name (no author: the title's) and the
 * year's last two digits ("Smith, John", 2026 → "Smi26"). When another source in `taken` (a Set) holds it, a digit is added:
 * Smi261, Smi262 (unverified: Word's clash rule was not probed). */
export function tagOf(s, taken = new Set()) {
  const a = s.authors?.[0];
  const head = (a ? person(a).family ?? person(a).name : s.title || '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3) || 'Src';
  const base = `${head}${String(s.year ?? '').replace(/\D/g, '').slice(-2)}`;
  if (!taken.has(base)) return base;
  for (let n = 1; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}
/** `sources` where each one without a tag got one (tagOf, clear of the others) → the same array when none needed one. */
export function ensureTags(sources) {
  if (sources.every((s) => s.tag)) return sources;
  const taken = new Set(sources.map((s) => s.tag).filter(Boolean));
  return sources.map((s) => {
    if (s.tag) return s;
    const tag = tagOf(s, taken);
    taken.add(tag);
    return { ...s, tag };
  });
}
/** The next placeholder name: Placeholder1, else the first number no source's tag holds. */
export function nextPlaceholder(sources) {
  const taken = new Set(sources.map((s) => s.tag));
  for (let n = 1; ; n++) if (!taken.has(`Placeholder${n}`)) return `Placeholder${n}`;
}

// Name forms of the styles' lists: each takes one stored author ("Family, Given" or an organisation) and its place in the list.
const given = (a) => person(a).given ?? '';
const NAMES = {
  initials: (a) => listName(a), // Smith, J.
  full: (a, i) => person(a).name ?? (i ? `${given(a)} ${person(a).family}`.trim() : a), // Smith, John; then John Smith
  inverted: (a) => person(a).name ?? a, // Smith, John
  upperInitials: (a) => person(a).name ?? `${person(a).family.toUpperCase()}${initials(given(a)) ? `, ${initials(given(a))}` : ''}`, // SMITH, J.
  upperFull: (a) => person(a).name ?? `${person(a).family.toUpperCase()}${given(a) ? `, ${given(a)}` : ''}`, // SMITH, John
  bare: (a) => person(a).name ?? `${person(a).family} ${initials(given(a)).replace(/\./g, '')}`.trim(), // Smith J
  spaced: (a) => person(a).name ?? `${person(a).family} ${given(a)}`.trim(), // Smith John
};
/** `authors` in name form `form`, `and` before the last ("Smith, J., & Lee, A."). */
const nameList = (authors, form, and) => {
  const n = authors.map((a, i) => NAMES[form](a, i));
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')}${and}${n.at(-1)}`;
};
const words = (...parts) => parts.filter(Boolean).join(' ');
const dot = (s) => (s ? end(s) : '');
const pubOf = (v, sep = ': ') => [v.place, v.publisher].filter(Boolean).join(sep);
const pubYear = (v, sep) => [pubOf(v, sep), v.year].filter(Boolean).join(', ');

// One source as the style rows read it: the type group, the names as the row prints them, the fields with their fallbacks.
const GROUPS = { BookSection: 'part', ConferenceProceedings: 'part', JournalArticle: 'journal', ArticleInAPeriodical: 'journal', InternetSite: 'web',
  DocumentFromInternetSite: 'web' };
function view(s, row, num) {
  return {
    g: GROUPS[wordTypeOf(s)] ?? 'book', authors: s.authors.length ? nameList(s.authors, row.names, row.and) : '', title: s.title || 'Untitled',
    year: s.year || 'n.d.', container: s.container, place: s.place, publisher: s.publisher, volume: s.volume, issue: s.issue, pages: s.pages,
    url: s.url || (s.doi ? `https://doi.org/${s.doi}` : ''), num,
    accessed: s.accessed ? longDate(s.accessed) : [s.extra?.dayAccessed, s.extra?.monthAccessed, s.extra?.yearAccessed].filter(Boolean).join(' '),
  };
}
const U = { cite: 'unverified', entry: 'unverified', sort: 'unverified' };
const quoted = (v) => (v.g === 'book' ? dot(it(v.title)) : dot(`“${v.title}”`));

/** Word's styles, one row each, in the Style list's order (probe/menus/references.style.json, verified), then the user's own
 * Harvard. A row: id, label, numbered (cites by number, sources numbered by their first citation), cite {open, close, sep
 * (between the names and the year; null: no year), and (between two names), page(p) → text, pageSep}, names (the list's name
 * form, NAMES), and (between the list's last two names), sort ('author' | 'title' | 'number'), entry(v) → the marked entry (v:
 * view, by type group book, part, journal and web), builder (Harvard and IEEE: the builder's own entries), and status: each rule
 * 'verified' (a probe, the user's course slide or the IEEE Reference Guide) or 'unverified' (from Word knowledge). */
export const WORD_STYLES = [
  { id: 'apa', label: 'APA', cite: { open: '(', close: ')', sep: ', ', and: ' & ', page: (p) => `p. ${p}`, pageSep: ', ' }, names: 'initials', and: ', & ',
    sort: 'author', status: U,
    entry: (v) => words(v.authors ? `${v.authors} (${v.year}).` : `${it(v.title)}. (${v.year}).`, v.authors && (v.g === 'book' ? dot(it(v.title)) : dot(v.title)),
      v.g === 'part' && dot(`In ${it(v.container)}${v.pages ? ` (pp. ${v.pages})` : ''}`),
      v.g === 'journal' && dot([it(v.container), v.volume && `${v.volume}${v.issue ? `(${v.issue})` : ''}`, v.pages].filter(Boolean).join(', ')),
      (v.g === 'book' || v.g === 'part') && dot(pubOf(v)), v.g === 'web' && v.url && `Retrieved from ${v.url}`) },
  { id: 'chicago', label: 'Chicago', cite: { open: '(', close: ')', sep: ' ', and: ' and ', page: (p) => p, pageSep: ', ' }, names: 'full', and: ', and ',
    sort: 'author', status: U,
    entry: (v) => words(dot(v.authors), quoted(v), v.g === 'part' && dot(`In ${it(v.container)}`),
      v.g === 'journal' ? dot(`${words(it(v.container), v.volume, v.issue && `no. ${v.issue}`)} (${v.year})${v.pages ? `: ${v.pages}` : ''}`) : dot(pubYear(v)),
      v.g === 'web' && v.url && dot(v.url)) },
  { id: 'gb7714', label: 'GB7714', numbered: true, cite: { open: '[', close: ']', page: (p) => p, pageSep: ': ' }, names: 'bare', and: ', ', sort: 'number', status: U,
    entry: (v) => words(`[${v.num}]`, dot(v.authors), dot(`${v.title}[${{ book: 'M', part: 'C', journal: 'J', web: 'EB/OL' }[v.g]}]`),
      v.g === 'journal' ? dot(`${v.container}, ${v.year}${v.volume ? `, ${v.volume}` : ''}${v.issue ? `(${v.issue})` : ''}${v.pages ? `: ${v.pages}` : ''}`) : dot(pubYear(v)),
      v.g === 'web' && v.url && dot(v.url)) },
  { id: 'gostName', label: 'GOST - Name Sort', numbered: true, cite: { open: '[', close: ']', page: (p) => `p. ${p}`, pageSep: ', ' }, names: 'spaced', and: ', ',
    sort: 'author', status: U,
    entry: (v) => words(`${v.num}.`, v.authors, dot(v.title), pubYear(v, ' : ') && dot(`- ${pubYear(v, ' : ')}`), v.pages && dot(`- ${v.pages}`)) },
  { id: 'gostTitle', label: 'GOST - Title Sort', numbered: true, cite: { open: '[', close: ']', page: (p) => `p. ${p}`, pageSep: ', ' }, names: 'spaced', and: ', ',
    sort: 'title', status: U,
    entry: (v) => words(`${v.num}.`, dot(v.title), v.authors && dot(`/ ${v.authors}`), pubYear(v, ' : ') && dot(`- ${pubYear(v, ' : ')}`)) },
  { id: 'harvardAnglia', label: 'Harvard - Anglia', cite: { open: '(', close: ')', sep: ', ', and: ' & ', page: (p) => `p.${p}`, pageSep: ', ' },
    names: 'upperInitials', and: ' & ', sort: 'author', status: U,
    entry: (v) => words(v.authors && `${v.authors},`, `(${v.year}).`, v.g === 'book' ? dot(it(v.title)) : dot(v.title), v.g === 'part' && dot(`In ${it(v.container)}`),
      v.g === 'journal' && dot([it(v.container), v.volume && `${v.volume}${v.issue ? `(${v.issue})` : ''}`, v.pages && `pp.${v.pages}`].filter(Boolean).join(', ')),
      (v.g === 'book' || v.g === 'part') && dot(pubOf(v)), v.g === 'web' && v.url && `[Online]. Available at: ${v.url}${v.accessed ? ` [Accessed ${v.accessed}]` : ''}.`) },
  { id: 'ieee', label: 'IEEE', numbered: true, builder: true, cite: { open: '[', close: ']', page: (p) => `p. ${p}`, pageSep: ', ' }, sort: 'number',
    status: { cite: 'verified', entry: 'verified', sort: 'verified' } }, // today's numbered IEEE rules (IEEE Reference Guide)
  { id: 'iso690Date', label: 'ISO 690 - First Element and Date', cite: { open: '(', close: ')', sep: ', ', and: ' and ', page: (p) => `p. ${p}`, pageSep: ', ' },
    names: 'upperFull', and: ' and ', sort: 'author', status: U,
    entry: (v) => words(dot(v.authors), dot(v.year), v.g === 'book' ? dot(it(v.title)) : dot(v.title), v.g !== 'book' && dot(it(v.container)),
      dot([pubOf(v, ' : '), v.pages && `pp. ${v.pages}`].filter(Boolean).join(', ')), v.g === 'web' && v.url && dot(`Available from: ${v.url}`)) },
  { id: 'iso690Num', label: 'ISO 690 - Numerical Reference', numbered: true, cite: { open: '(', close: ')', page: (p) => `p. ${p}`, pageSep: ', ' },
    names: 'upperFull', and: ' and ', sort: 'number', status: U,
    entry: (v) => words(`${v.num}.`, dot(v.authors), v.g === 'book' ? dot(it(v.title)) : dot(v.title), v.g !== 'book' && dot(it(v.container)),
      dot(pubYear(v, ' : ')), v.g === 'web' && v.url && dot(`Available from: ${v.url}`)) },
  { id: 'mla', label: 'MLA', cite: { open: '(', close: ')', sep: null, and: ' and ', page: (p) => p, pageSep: ' ' }, names: 'full', and: ', and ',
    sort: 'author', status: U,
    entry: (v) => words(dot(v.authors), quoted(v), v.g !== 'book' && dot(it(v.container)), dot(pubYear(v)), v.g !== 'book' && dot(v.pages),
      v.g === 'web' && v.url && dot(v.url)) },
  { id: 'sist02', label: 'SIST02', numbered: true, cite: { open: '[', close: ']', page: (p) => `p. ${p}`, pageSep: ', ' }, names: 'inverted', and: '; ',
    sort: 'number', status: U,
    entry: (v) => words(`${v.num})`, dot(v.authors), dot(v.title), v.g !== 'book' && dot(v.container), dot(pubYear(v, ', ')), v.pages && dot(`p. ${v.pages}`)) },
  { id: 'turabian', label: 'Turabian', cite: { open: '(', close: ')', sep: ' ', and: ' and ', page: (p) => p, pageSep: ', ' }, names: 'full', and: ', and ',
    sort: 'author', status: U,
    entry: (v) => words(dot(v.authors), quoted(v), v.g !== 'book' && dot(it(v.container)), dot(pubYear(v)), v.g === 'web' && v.url && dot(v.url)) },
  { id: 'harvard', label: 'Harvard', builder: true, cite: { open: '(', close: ')', sep: ', ', and: ' and ', page: (p) => pages(p), pageSep: ', ' },
    sort: 'author', status: { cite: 'verified', entry: 'verified', sort: 'verified' } }, // the user's course style (the builder's own)
];
const WORD_STYLE_IDS = WORD_STYLES.map((r) => r.id);
const ROWS = Object.fromEntries(WORD_STYLES.map((r) => [r.id, r]));
// The rows the builder has no rules of its own for: formatReference and citation take them through the table.
const WORD_ONLY = Object.fromEntries(WORD_STYLES.filter((r) => !r.builder).map((r) => [r.id, r]));
/** Whether `style` cites by number. */
export const numbered = (style) => !!ROWS[style]?.numbered;
/** The table row of `style` (Harvard's for an unknown id). */
export const wordStyle = (style) => ROWS[style] ?? ROWS.harvard;

/** One citation part of source `s` in `row`, marked: the names (et al. from four; from three in APA), the year with its `label`
 * letter, then the volume and pages; a numbered row's number (`label`) instead of names and year. noAuthor, noYear and noTitle
 * leave their part out (Word's \n, \y and \t); without authors the title stands in for them. */
function partOf(s, label, row, { pages: p, volume, noAuthor, noYear, noTitle } = {}) {
  const c = row.cite;
  let head = String(label ?? '');
  if (!row.numbered) {
    const fam = s.authors.map(citeName);
    const max = row.id === 'apa' ? 2 : CITE_MAX;
    const names = !fam.length ? '' : fam.length > max ? `${fam[0]} ${it('et al.')}` : fam.length < 2 ? fam[0] : `${fam.slice(0, -1).join(', ')}${c.and}${fam.at(-1)}`;
    const who = noAuthor ? '' : names || (noTitle ? '' : s.title || 'Untitled');
    const year = noYear || c.sep == null ? '' : `${s.year || 'n.d.'}${label ?? ''}`;
    head = [who, year].filter(Boolean).join(c.sep ?? ' ');
  }
  const tail = [volume && `Vol. ${volume}`, p && c.page(p)].filter(Boolean).join(', ');
  return [head, tail].filter(Boolean).join(c.pageSep);
}
/** One source's citation in a Word-only row (citation's path for those styles). */
const wordCiteOne = (s, label, row) => `${row.cite.open}${partOf(s, label, row)}${row.cite.close}`;

/** A Document's citation in `style`: `items` [{s (null: an unknown tag), label (the letter, or a numbered style's number), pages,
 * volume, noAuthor, noYear, noTitle}] in one pair of brackets ("(Smith, 2026; Lee, 2025)"), with Word's \f `prefix` and \s
 * `suffix` inside them. A placeholder cites as its name in brackets, "(Placeholder1)". → plain text, or "Invalid source
 * specified." when the first source is unknown. */
export function wordCitation(items, style, { prefix = '', suffix = '' } = {}) {
  if (!items.length || !items[0].s) return 'Invalid source specified.';
  const row = wordStyle(style);
  const known = items.filter((x) => x.s);
  if (known.every((x) => x.s.placeholder)) return `(${known.map((x) => x.s.tag).join('; ')})`;
  const parts = known.map((x) => (x.s.placeholder ? x.s.tag : partOf(x.s, x.label, row, x)));
  const body = parts.join(row.numbered ? `${row.cite.close}, ${row.cite.open}` : '; ');
  return plain(`${row.cite.open}${prefix ? `${prefix} ` : ''}${body}${suffix ? ` ${suffix}` : ''}${row.cite.close}`);
}

/** One entry of source `s` in a Word-only row, marked; `label`: its number in a numbered row. */
const wordEntry = (s, label, row) => row.entry(view(s, row, label));

/** `sources` in a Word-only row's order: by the list's names (none: the title), then year and title; or by title, then year. */
function wordSort(sources, row) {
  const head = (s) => plain(s.authors.length ? nameList(s.authors, row.names ?? 'initials', row.and ?? ', ') : s.title);
  const key = (s) => (row.sort === 'title' ? [s.title, s.year] : [head(s), s.year, s.title]);
  return [...sources].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < x.length; i++) {
      const d = collate(x[i] ?? '', y[i] ?? '');
      if (d) return d;
    }
    return 0;
  });
}

/** A Document's numbers: the sources cited in it numbered by their first citation (`citedTags`, in document order), the rest after
 * them in stored order; placeholders get none → Map source id → number. */
export function numbersOf(sources, citedTags) {
  const out = new Map();
  let n = 0;
  for (const tag of citedTags) {
    const s = sources.find((x) => x.tag === tag && !x.placeholder);
    if (s && !out.has(s.id)) out.set(s.id, ++n);
  }
  for (const s of sources) if (!s.placeholder && !out.has(s.id)) out.set(s.id, ++n);
  return out;
}

/** The label each source of a Document cites with in `style`: a numbered style's number (numbersOf), else its letter (suffixes)
 * → Map source id → text. */
export const wordLabels = (sources, style, citedTags = []) => (numbered(style)
  ? new Map([...numbersOf(sources, citedTags)].map(([k, v]) => [k, String(v)])) : suffixes(sources.filter((s) => !s.placeholder)));

/** A Document's bibliography in `style`: one entry per source of the current list but placeholders, in the style's order (a
 * numbered one by number) → runs, one array per entry. Harvard and IEEE are the builder's own entries. */
export function wordBibliography(sources, style, citedTags = []) {
  const row = wordStyle(style);
  const list = sources.filter((s) => !s.placeholder);
  const lab = wordLabels(list, style, citedTags);
  let order;
  if (row.sort === 'number') order = [...list].sort((a, b) => lab.get(a.id) - lab.get(b.id));
  else order = row.builder ? sortSources(list, 'harvard') : wordSort(list, row);
  const one = (s) => (row.id === 'ieee' ? ieee(s, lab.get(s.id)) : row.builder ? harvard(s, lab.get(s.id) ?? '') : wordEntry(s, lab.get(s.id) ?? '', row));
  return order.map((s) => runs(one(s)));
}

// ---------- Details from a link ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});
const clean = (s) => decode(String(s ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** Lowercase words at the end of the given names go to the family name: arXiv and DataCite split a name at its last word,
 * so "Diego de las Casas" arrives as "Casas, Diego de las" → "de las Casas, Diego". A name without a comma stays. */
const particles = (a) => {
  const i = a.indexOf(',');
  if (i < 0) return a;
  const family = [a.slice(0, i).trim()];
  const given = a.slice(i + 1).trim().split(' ');
  while (given.length > 1 && /^\p{Ll}/u.test(given.at(-1))) family.unshift(given.pop());
  return family.length > 1 ? `${family.join(' ')}, ${given.join(' ')}` : a;
};
// ponytail: word lists. A byline word that makes a name an organisation ("Associated Press", "Unity Technologies"), and the
// degrees a byline may end with ("Catharine Paddock, Ph.D.").
const ORG = /\b(?:Press|Staff|Team|Technolog(?:y|ies)|Inc|Ltd|LLC|Corp|Corporation|Company|Games|Studios?|News|Labs?|Group|University|Institute|Foundation|Association|Editors?|Editorial|Desk|Agency|Media|Magazine|Network|Society|Council|Committee|Department|Ministry|Organi[sz]ation|Entertainment|Software|Systems|Research|Cent(?:er|re)|Bureau|Wire|Reporters?|Writers?)\b/;
const DEGREE = /,?\s+(?:Ph\.?\s?D|M\.?D|M\.?Sc|MPH|MBA|D\.?Phil|R\.?N)\.?$/i;
/** "Ilya Borovikov" → "Borovikov, Ilya", "Diego de las Casas" → "de las Casas, Diego"; a name of one word or an organisation's
 * stays. */
const familyFirst = (name) => {
  const n = name.replace(DEGREE, '');
  const w = n.split(' ');
  if (!n.includes(',') && ORG.test(n)) return n;
  return particles(n.includes(',') || w.length < 2 ? n : `${w.at(-1)}, ${w.slice(0, -1).join(' ')}`);
};
/** A byline of several people ("Ann Lee, Bo Chan and Cy Diaz") as one name each; one name (also "Lee, Ann") stays whole. */
const splitNames = (s) => {
  const parts = s.split(/\s*(?:[,;&]|\band\b)\s*/).filter(Boolean);
  return parts.length > 1 && parts.every((p) => p.includes(' ')) ? parts : [s];
};
/** "2024/10/31", "2024-10-31T09:00Z", "Oct 31, 2024" → {year, date (YYYY-MM-DD when the day is known, else '')}. */
function dateOf(s) {
  const t = typeof s === 'string' ? s : '';
  const iso = t.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return { year: iso[1], date: `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}` };
  return { year: t.match(/\b(1[5-9]|20)\d{2}\b/)?.[0] ?? '', date: '' };
}
const DOI_RE = /10\.\d{4,9}\/[^\s"<>?#]+/;
const doiOf = (s) => s?.match(DOI_RE)?.[0].replace(/\.pdf$|[.,;)]+$/i, '') ?? '';
/** The DOI in a link's path (dl.acm.org/doi/10.1145/…, link.springer.com/chapter/10.1007/…), else ''. */
const doiInLink = (url) => {
  try {
    return doiOf(decodeURI(new URL(url).pathname));
  } catch {
    return '';
  }
};

// The schema.org types that describe the page itself (JSON-LD), and the ones that make it an article.
const LD_TYPES = /Article|BlogPosting|Report|WebPage|Book|Chapter|Thesis|CreativeWork|SoftwareSourceCode|Dataset/;
const typeOf = (n) => [n?.['@type']].flat().join(' ');
const ldName = (v) => (typeof v === 'string' ? clean(v) : clean(v?.name));

/** The first JSON-LD object of `html` that describes the page: {title, authors, date, site, article}. */
function jsonLd(html) {
  for (const [, body] of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(body.trim());
    } catch {
      continue;
    }
    const nodes = [data].flat().flatMap((n) => [n, ...(Array.isArray(n?.['@graph']) ? n['@graph'] : [])]);
    const named = nodes.filter((x) => LD_TYPES.test(typeOf(x)) && (x.headline || x.name));
    const n = named.find((x) => /Article|BlogPosting/.test(typeOf(x))) ?? named[0]; // a graph's WebPage has no author
    if (!n) continue;
    const authors = [n.author].flat().filter(Boolean).map((a) => (/Organization/.test(typeOf(a)) ? ldName(a) : familyFirst(ldName(a)))).filter(Boolean);
    return { title: clean(n.headline || n.name), authors, date: n.datePublished, site: ldName(n.isPartOf) || ldName(n.publisher),
      article: /Article|BlogPosting/.test(typeOf(n)) };
  }
  return {};
}

const letters = (s) => fold(String(s ?? '')).replace(/[^a-z0-9]/g, '');
const HOME = /^(?:home|home ?page|welcome)$/i;
/** A page title without the site's name around it: "Pricing | OpenAI API" → "Pricing", "GitHub - owner/repo" → "owner/repo",
 * "HYBRID AI — In-Game Inferencing SDK documentation" → "HYBRID AI". A part names the site when it is `site`, is in the domain
 * name, says documentation, or (at the end, four words at most) starts with the domain's name ("Roblox Creator Hub"). After
 * " | " or " · " only the first part stays. A home page's title is the site's name ("Inworld AI – Realtime AI for …" → "Inworld
 * AI"). → {title, site: the part taken off that named the site, else ''}. */
function trimTitle(title, site = '', url = '') {
  let host = '';
  let label = '';
  let home = false;
  try {
    const u = new URL(url);
    const labels = u.hostname.replace(/^www\d*\./, '').split('.');
    host = letters(labels.join(''));
    label = letters(labels.at(-2) && /^(?:co|com|ac|org|gov|net)$/.test(labels.at(-2)) && labels.length > 2 ? labels.at(-3) : labels.at(-2) ?? '');
    home = !u.pathname.replace(/\/+$/, '') && !u.search;
  } catch {}
  const bits = title.split(/\s+([|·•–—-])\s+/);
  const parts = bits.filter((_, i) => i % 2 === 0);
  const seps = bits.filter((_, i) => i % 2);
  if (parts.length < 2) return { title, site: home ? title : '' };
  // A brand names the site ("Hugging Face", "Roblox Creator Hub"); a part that only says documentation comes off but names nothing.
  const brand = (p, end) => {
    const l = letters(p);
    return l.length > 3 && (l === letters(site) || host.includes(l) || (end && label.length > 3 && l.startsWith(label) && p.split(' ').length <= 4));
  };
  const names = (p, end) => brand(p, end) || /\b(?:documentation|docs)\b/i.test(p);
  if (home) {
    const b = parts.find((p) => brand(p, true));
    return { title: b ?? parts.find((p) => !HOME.test(p)) ?? title, site: b ?? '' };
  }
  const off = [];
  while (parts.length > 1 && names(parts.at(-1), true)) off.push([parts.pop(), true]), seps.pop();
  while (parts.length > 1 && names(parts[0], false)) off.push([parts.shift(), false]), seps.shift();
  const bar = seps.findIndex((s) => s === '|' || s === '·' || s === '•');
  const keep = bar < 0 ? parts.length : bar + 1;
  return { title: parts.slice(0, keep).map((p, i) => (i ? `${seps[i - 1]} ${p}` : p)).join(' '), site: off.find(([p, end]) => brand(p, end))?.[0] ?? '' };
}

// A repository page's owner and name: github.com/owner/repo, huggingface.co/owner/model (also datasets/ and spaces/).
const REPO = /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org|huggingface\.co(?:\/(?:datasets|spaces))?)\/([^/?#]+)\/([^/?#]+)/i;
// Other names a page gives its publication date ("nv-pub-date", "publish-date", "parsely-pub-date").
const PUB_DATE = /(?:^|[-_:.])pub(?:lish(?:ed)?|lication)?[-_:.]?(?:date|time)$/;

/** The details a page's head gives (citation_* Highwire tags, Dublin Core, Open Graph, JSON-LD, <title>), plus `site`. `url`, the
 * page's link, helps take the site's name off the title, and gives a repository's owner and name. */
export function parseMeta(html, url = '') {
  const head = String(html).slice(0, 600000);
  const meta = new Map();
  for (const [, attrs] of head.matchAll(/<meta\b([^>]*)>/gi)) {
    const a = {};
    for (const m of attrs.matchAll(/([^\s=/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) a[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    const key = (a.name ?? a.property ?? a.itemprop ?? '').toLowerCase();
    const value = clean(a.content);
    if (key && value) meta.set(key, [...(meta.get(key) ?? []), value]);
  }
  const first = (...keys) => keys.map((k) => meta.get(k)?.[0]).find(Boolean) ?? '';
  const ld = jsonLd(head);
  let site = first('og:site_name', 'citation_publisher', 'dc.publisher', 'application-name', 'apple-mobile-web-app-title') || ld.site || '';
  // A scholarly title is the paper's own; the others often carry the site's name, which names the site when nothing else does.
  let title = first('citation_title', 'dc.title');
  if (!title) {
    const t = trimTitle(first('og:title', 'twitter:title') || ld.title || clean(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]), site, url);
    title = t.title;
    site ||= t.site;
  }
  const people = (key) => (meta.get(key) ?? []).filter((a) => !/^https?:/.test(a)).flatMap(splitNames).map(familyFirst);
  const patent = first('citation_patent_number'); // Google Patents: the inventors, and the grant date after the filing date
  let authors = people('citation_author');
  if (!authors.length) authors = people('dc.creator');
  if (!authors.length && patent) authors = (meta.get('dc.contributor') ?? []).filter((a) => !ORG.test(a)).map(familyFirst);
  if (!authors.length) authors = people('article:author');
  if (!authors.length) authors = ld.authors ?? [];
  if (!authors.length) authors = people('author');
  const repo = url.match(REPO);
  if (repo && title.toLowerCase().startsWith(`${repo[1]}/${repo[2]}`.toLowerCase())) {
    authors = [repo[1]]; // "art-from-the-machine/Mantella: Mantella is a Skyrim mod" → art-from-the-machine, Mantella
    title = title.slice(repo[1].length + 1, repo[1].length + 1 + repo[2].length);
  }
  const pubKey = [...meta.keys()].find((k) => PUB_DATE.test(k));
  const arxiv = first('citation_arxiv_id').replace(/v\d+$/, '');
  const journal = first('citation_journal_title');
  const book = first('citation_conference_title', 'citation_inbook_title', 'citation_book_title');
  const article = !!journal || /article/i.test(first('og:type')) || !!ld.article;
  const type = arxiv ? 'preprint' : journal ? 'article' : book ? 'chapter' : article ? 'article' : 'web';
  const { year, date } = dateOf((patent && meta.get('dc.date')?.at(-1)) || first('citation_publication_date', 'citation_date', 'citation_online_date',
    'dc.date', 'article:published_time', 'datepublished', 'date', pubKey) || ld.date);
  const [from, to] = [first('citation_firstpage'), first('citation_lastpage')];
  return {
    type, authors, year, date, title, site, arxiv,
    container: journal || book || (type === 'article' ? site : ''),
    volume: first('citation_volume'), issue: first('citation_issue'), pages: from && to && to !== from ? `${from}–${to}` : from,
    publisher: first('citation_publisher', 'dc.publisher'),
    doi: doiOf(first('citation_doi', 'prism.doi', 'bepress_citation_doi', 'dc.identifier', 'doi')),
  };
}

// CSL types (doi.org's citation JSON, Crossref and DataCite) → source types; any other with a container is an article.
const CSL_TYPES = {
  'article-journal': 'article', 'article-magazine': 'article', 'article-newspaper': 'article', 'post-weblog': 'article', post: 'article',
  'paper-conference': 'chapter', chapter: 'chapter', 'entry-encyclopedia': 'chapter', 'entry-dictionary': 'chapter',
  'book-chapter': 'chapter', 'book-section': 'chapter', 'proceedings-article': 'chapter', // Crossref's own names

  book: 'book', monograph: 'book', report: 'book', thesis: 'book', 'posted-content': 'preprint', article: 'preprint',
  webpage: 'web', dataset: 'web', software: 'web',
};

/** The details of a CSL JSON record (doi.org with Accept: application/vnd.citationstyles.csl+json). */
export function fromCsl(c) {
  const text = (v) => clean([v].flat()[0]);
  // Springer chapters have issued [[null]]; their date is only in created (when the DOI was registered), the last resort.
  const [y, m, d] = [c.issued, c.published, c['published-print'], c['published-online'], c.created]
    .map((x) => x?.['date-parts']?.[0]).find((p) => p?.[0]) ?? [];
  return {
    type: CSL_TYPES[c.type] ?? (text(c['container-title']) ? 'article' : 'web'),
    authors: (c.author ?? []).map((a) => clean(a.literal) || particles([clean(a.family), clean(a.given)].filter(Boolean).join(', '))).filter(Boolean),
    year: y ? String(y) : '', date: y && m && d ? `${y}-${pad(m)}-${pad(d)}` : '',
    title: text(c.title), container: text(c['container-title']), volume: text(c.volume), issue: text(c.issue),
    pages: text(c.page).replace(/(\d)-(\d)/, '$1–$2'), place: text(c['publisher-place'] ?? c['publisher-location']), publisher: text(c.publisher), doi: text(c.DOI),
  };
}

/** A DSpace item (a university repository's REST API, /server/api/core/items/{uuid}) → its details: dc.title,
 * dc.contributor.author (Family, Given), dc.date.issued; a thesis, dissertation, book or report is a book, an article sits in
 * dc.relation.ispartof. */
export function fromDspace(o) {
  const m = (k) => (o?.metadata?.[k] ?? []).map((x) => clean(x?.value)).filter(Boolean);
  const kind = m('dc.type')[0] ?? '';
  const type = /thesis|dissertation|book|report/i.test(kind) ? 'book' : /article/i.test(kind) ? 'article' : /chapter|conference|proceedings/i.test(kind) ? 'chapter' : 'web';
  const people = m('dc.contributor.author');
  return {
    type, title: m('dc.title')[0] ?? clean(o?.name), authors: (people.length ? people : m('dc.creator')).map(familyFirst), ...dateOf(m('dc.date.issued')[0]),
    container: type === 'article' || type === 'chapter' ? m('dc.relation.ispartof')[0] ?? '' : '', publisher: m('dc.publisher')[0] ?? '',
    doi: doiOf(m('dc.identifier.doi')[0]),
  };
}
// DSpace 7 and later send an empty app shell (<ds-app>) at an item's link (/items/{uuid}, /entities/{type}/{uuid}) or its handle
// (/handle/{prefix}/{suffix}); the item is in its REST API. ponytail: the API at /server, DSpace's default.
const DSPACE_ITEM = /\/(?:items|entities\/[^/]+)\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/i;
const DSPACE_HANDLE = /\/handle\/(\d[\d.]*\/[^/?#]+)/;
const dspaceApi = (url) => {
  try {
    const u = new URL(url);
    const item = u.pathname.match(DSPACE_ITEM);
    const handle = u.pathname.match(DSPACE_HANDLE);
    return item ? `${u.origin}/server/api/core/items/${item[1]}` : handle ? `${u.origin}/server/api/pid/find?id=${encodeURIComponent(handle[1])}` : '';
  } catch {
    return '';
  }
};

/** What was pasted: {arxiv, url} for an arXiv id or link, {doi} for a DOI (bare, doi: or a doi.org link), {url} for another
 * web address (https:// added to a bare domain), else null. */
export function parseInput(text) {
  let s = String(text ?? '').trim();
  const doi = s.match(/^(?:doi:\s*|(?:https?:\/\/)?(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i);
  if (doi) {
    let d = doi[1];
    try {
      d = decodeURIComponent(d);
    } catch {}
    const ax = d.match(/^10\.48550\/arxiv\.(\d{4}\.\d{4,5})(?:v\d+)?$/i); // arXiv's own DOI reads as its id
    return ax ? { arxiv: ax[1], url: `https://arxiv.org/abs/${ax[1]}` } : { doi: d };
  }
  if (!/^https?:\/\//i.test(s) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) && !/^\d+\.\d+$/.test(s)) s = `https://${s}`;
  const ax = s.match(/^(?:arxiv:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?$/i)
    || s.match(/^https?:\/\/(?:www\.|export\.|ar5iv\.labs\.|ar5iv\.)?arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?\/?$/i)
    || s.match(/^https?:\/\/ar5iv\.org\/(?:abs|html)\/(\d{4}\.\d{4,5})(?:v\d+)?\/?$/i);
  if (ax) return { arxiv: ax[1], url: `https://arxiv.org/abs/${ax[1]}` };
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    return { url: new URL(s).href };
  } catch {
    return null;
  }
}

export const CSL = 'application/vnd.citationstyles.csl+json';
const FILL = 'Fill in the details yourself.';
const nonEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => (Array.isArray(v) ? v.length : v)));

/** The details of the source at `text` (a link, a DOI or an arXiv id), read through get(url, accept) → {ok, status, url, type,
 * body}: the page's citation tags, then for a DOI (pasted, on the page or in the link) doi.org's record, which wins where both
 * have a field. An arXiv paper reads it only when its page lists a journal's or conference's DOI: the published version is cited
 * then, at its DOI in place of the arXiv link (the user, 2026-10-27); else it stays a preprint. A web page or a site's own
 * article without authors takes the site's name. Resolves {source (cleanSource, accessed `today`, the pasted link kept but for a
 * published arXiv paper), problem: a sentence when something could not be read, else ''}; throws when `text` is no link, DOI or
 * arXiv id. */
export async function lookup(text, { get, today }) {
  const q = parseInput(text);
  if (!q) throw new Error('Paste a link, a DOI or an arXiv id.');
  const read = (url, accept) => Promise.resolve().then(() => get(url, accept)).catch((e) => ({ ok: false, status: 0, error: String(e?.message ?? e) }));
  let page = {};
  let problem = '';
  if (q.url) {
    const r = await read(q.url);
    if (r.ok && /<ds-app\b/i.test(r.body ?? '')) { // a DSpace repository: its shell's title is "DSpace"
      const api = dspaceApi(r.url || q.url);
      const j = api ? await read(api, 'application/json') : {};
      try {
        if (j.ok) page = fromDspace(JSON.parse(j.body));
      } catch {}
    } else if (r.ok && /html|xml/i.test(r.type ?? '')) page = parseMeta(r.body, r.url || q.url);
    else if (r.ok) problem = `The link is not a web page. ${FILL}`;
    else if (r.status === 401 || r.status === 403) problem = `The site did not let EasyWriter read the page. ${FILL}`;
    else problem = r.status ? `The site answered with error ${r.status}. ${FILL}` : `The site could not be reached. ${FILL}`;
  }
  const doi = q.doi || page.doi || (q.url ? doiInLink(q.url) : '');
  let record = {};
  const arxiv = q.arxiv || page.arxiv;
  if (doi && (!arxiv || !/^10\.48550\//.test(doi))) { // not arXiv's own DOI, which has nothing the page lacks
    const r = await read(`https://doi.org/${doi}`, CSL);
    try {
      if (r.ok) record = fromCsl(JSON.parse(r.body));
    } catch {}
    if (record.title) problem = '';
    else if (!q.url) problem = `doi.org has no record of ${doi}. ${FILL}`;
  }
  const { site = '', ...found } = { ...nonEmpty(page), ...nonEmpty(record) };
  const published = arxiv && record.title;
  const source = cleanSource({ type: 'web', ...found, ...(q.arxiv && !published && { type: 'preprint', arxiv: q.arxiv }),
    url: published ? '' : q.url ?? '', doi, accessed: today });
  // A web page or a site's own article (not a journal's) without authors takes the site's name.
  if (!source.authors.length && site && (source.type === 'web' || (source.type === 'article' && source.container === site))) {
    source.authors = [site.replace(/\s+(?:documentation|docs)$/i, '')]; // "Convai Documentation" → Convai
  }
  if (!source.title && !problem) problem = `The page has no citation details. Paste its DOI if it has one, or fill in the details yourself.`;
  return { source, problem };
}
