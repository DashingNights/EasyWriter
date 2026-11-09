// AutoCorrect's shipped lists (docs/plans/word plan.md §3 autocorrect, briefs/autocorrect.md): the replacement entries used while
// settings.word.autocorrect.entries is null, and the First Letter exceptions used while exceptions.firstLetter is null. Both are our
// own short lists, not Microsoft's (Word ships 926 entries and 276 abbreviations): the symbol and contraction entries follow
// probe/autocorrect-entries.tsv, the misspellings are common English ones we chose.

const SYMBOLS = [
  ['(c)', '©'], ['(r)', '®'], ['(tm)', '™'], ['(e)', '€'], ['...', '…'],
  // Word's smileys are formatted entries in Segoe UI Emoji; ours are plain emoji characters.
  [':)', '😊'], [':-)', '😊'], [';)', '😉'], [';-)', '😉'], [':(', '☹'], [':-(', '☹'], [':|', '😐'], [':-|', '😐'],
  // Word's arrows are Wingdings symbol characters (w:sym); ours are the Unicode arrows.
  ['-->', '→'], ['<--', '←'], ['==>', '⇒'], ['<==', '⇐'], ['<=>', '⇔'],
  ['htp:', 'http:'], ['http:\\\\', 'http://'], ['I"m', 'I’m'], ['vis-a-vis', 'vis-à-vis'],
  ['can;t', 'can’t'], ['don;t', 'don’t'], ['didn;t', 'didn’t'], ['doesn;t', 'doesn’t'], ['isn;t', 'isn’t'], ['won;t', 'won’t'],
  ['wouldn;t', 'wouldn’t'], ['couldn;t', 'couldn’t'], ['shouldn;t', 'shouldn’t'], ['wasn;t', 'wasn’t'], ['aren;t', 'aren’t'],
  ['haven;t', 'haven’t'], ['hasn;t', 'hasn’t'], ['it;s', 'it’s'], ['that;s', 'that’s'], ['there;s', 'there’s'], ['you;re', 'you’re'],
  ['they;re', 'they’re'], ['we;re', 'we’re'], ['i;m', 'I’m'], ['i;ll', 'I’ll'], ['i;ve', 'I’ve'], ['i;d', 'I’d'],
];

const MISSPELLINGS = [
  ['teh', 'the'], ['adn', 'and'], ['taht', 'that'], ['thier', 'their'], ['recieve', 'receive'], ['recieved', 'received'],
  ['beleive', 'believe'], ['acheive', 'achieve'], ['accross', 'across'], ['acommodate', 'accommodate'], ['adress', 'address'],
  ['alot', 'a lot'], ['agian', 'again'], ['becuase', 'because'], ['begining', 'beginning'], ['calender', 'calendar'],
  ['cemetary', 'cemetery'], ['comming', 'coming'], ['commited', 'committed'], ['definately', 'definitely'], ['dependant', 'dependent'],
  ['enviroment', 'environment'], ['existance', 'existence'], ['familar', 'familiar'], ['finaly', 'finally'], ['foriegn', 'foreign'],
  ['freind', 'friend'], ['goverment', 'government'], ['gaurd', 'guard'], ['happend', 'happened'], ['independant', 'independent'],
  ['knowlege', 'knowledge'], ['libary', 'library'], ['neccessary', 'necessary'], ['noticable', 'noticeable'], ['occured', 'occurred'],
  ['occurence', 'occurrence'], ['peice', 'piece'], ['posession', 'possession'], ['prefered', 'preferred'], ['publically', 'publicly'],
  ['realy', 'really'], ['seperate', 'separate'], ['succesful', 'successful'], ['tommorow', 'tomorrow'], ['tounge', 'tongue'],
  ['truely', 'truly'], ['untill', 'until'], ['wich', 'which'], ['wierd', 'weird'], ['writting', 'writing'], ['yuo', 'you'],
  ['i', 'I'],
];

/** The built-in replacement list as entries {name, text}. */
export const DEFAULT_ENTRIES = [...SYMBOLS, ...MISSPELLINGS].map(([name, text]) => ({ name, text }));

const LETTERS = [...'abcdefghijklmnopqrstuvwxyz'].map((c) => `${c}.`);
/** Words ending in a period after which a sentence does not start (lower case), with the single letters a. to z. */
export const DEFAULT_FIRST_LETTER = [
  'a.m.', 'p.m.', 'abbr.', 'approx.', 'apt.', 'assn.', 'asst.', 'attn.', 'ave.', 'blvd.', 'ca.', 'capt.', 'cf.', 'ch.', 'co.', 'col.',
  'corp.', 'dept.', 'dr.', 'e.g.', 'ed.', 'est.', 'etc.', 'ex.', 'fig.', 'figs.', 'ft.', 'gen.', 'gov.', 'hr.', 'hrs.', 'i.e.', 'inc.',
  'jan.', 'feb.', 'mar.', 'apr.', 'jun.', 'jul.', 'aug.', 'sep.', 'sept.', 'oct.', 'nov.', 'dec.', 'jr.', 'lb.', 'lbs.', 'lt.', 'ltd.',
  'max.', 'min.', 'misc.', 'mr.', 'mrs.', 'ms.', 'mt.', 'no.', 'nos.', 'oz.', 'p.', 'pp.', 'para.', 'ph.d.', 'pl.', 'prof.', 'pt.',
  'qt.', 'ref.', 'rev.', 'sgt.', 'sr.', 'st.', 'tel.', 'vol.', 'vols.', 'vs.', 'wt.', 'yr.', 'yrs.', ...LETTERS,
];
