// Index and table of authorities builders (docs/plans/word/plan.md §3 index-toa, §1.10 fields). Pure: XE and TA codes in, block
// JSON out, so node tests check Word's drawn results (probe/fields/out3.tsv) without an editor. Page numbers arrive with the entries;
// the field types in index.js read them from ctx.pageAt.

/** Word's built-in styles for indexes and tables of authorities, brought in through ensureStyles on first use. Values follow
 * probe/dialogs/index-style.json (Index 1: hanging 0.42 cm, no space after) and table-of-authorities-style.json (TOA Heading: bold,
 * 6 pt before); the deeper Index levels step by the same 0.42 cm, unverified. */
const HANG = 11.9; // 0.42 cm in points
export const STYLES = {
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Index${i + 1}`, {
    type: 'paragraph', name: `index ${i + 1}`, basedOn: 'Normal', next: 'Normal',
    para: { indent: { left: HANG * (i + 1), firstLine: -HANG }, spacing: { after: 0 } },
  }])),
  IndexHeading: { type: 'paragraph', name: 'index heading', basedOn: 'Normal', next: 'Index1', run: { bold: true } },
  TableofAuthorities: { type: 'paragraph', name: 'table of authorities', basedOn: 'Normal', next: 'Normal',
    para: { indent: { left: HANG, firstLine: -HANG }, spacing: { after: 0 } } },
  TOAHeading: { type: 'paragraph', name: 'toa heading', basedOn: 'Normal', next: 'Normal', run: { bold: true }, para: { spacing: { before: 6 } } },
};

/** The seven built-in categories of a table of authorities; 8 to 16 are numbers until the user renames them (settings.word.toaCategories). */
export const TOA_CATEGORIES = ['Cases', 'Statutes', 'Other Authorities', 'Rules', 'Treatises', 'Regulations', 'Constitutional Provisions'];
/** Category `n`'s name (1 to 16) with the user's names for 8 to 16. */
export const categoryName = (n, names = {}) => TOA_CATEGORIES[n - 1] ?? names[n] ?? String(n);

// The sort languages of the Index dialog's Language list by LCID (\z).
const LCID = { 1033: 'en-US', 2057: 'en-GB', 15369: 'en-HK', 2052: 'zh-CN', 3076: 'zh-HK', 1028: 'zh-TW' };
// In the probe's order (alphabetical); the default is still 1033.
export const LANGUAGES = [[2052, 'Chinese (Simplified, Mainland China)'], [3076, 'Chinese (Traditional, Hong Kong SAR)'], [1028, 'Chinese (Traditional, Taiwan)'],
  [15369, 'English (Hong Kong SAR)'], [2057, 'English (United Kingdom)'], [1033, 'English (United States)']];

// ---------- codes ----------
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
/** Entry text for an XE code: a colon and a quote in the text are written \: and \" (a colon separates levels). */
const escEntry = (s) => esc(s).replace(/:/g, '\\:');

/** The XE code for a Mark Index Entry: {main, sub, cross, bookmark, bold, italic, yomi, subYomi}. The two readings share one \y
 * as "main:sub", as the entry's levels do. */
export function xeCode({ main, sub = '', cross = null, bookmark = null, bold = false, italic = false, yomi = '', subYomi = '' }) {
  let code = `XE "${escEntry(main)}${sub ? `:${escEntry(sub)}` : ''}"`;
  if (yomi || subYomi) code += ` \\y "${escEntry(yomi)}${subYomi ? `:${escEntry(subYomi)}` : ''}"`;
  if (cross) code += ` \\t "${esc(cross)}"`;
  else if (bookmark) code += ` \\r ${bookmark}`;
  if (bold) code += ' \\b';
  if (italic) code += ' \\i';
  return code;
}

/** The TA code: a long citation with its short form and category, or only the short form (Mark All's later occurrences). */
export function taCode({ long = null, short, category = null }) {
  return long ? `TA \\l "${esc(long)}" \\s "${esc(short || long)}" \\c ${category ?? 1}` : `TA \\s "${esc(short)}"`;
}

/** An XE's entry text (args[0] after parseField, where \: stays escaped) → its levels: split on bare colons, \: unescaped. */
export const levelsOf = (text) => String(text ?? '').split(/(?<!\\):/).map((s) => s.replace(/\\:/g, ':').trim()).filter(Boolean).slice(0, 9);

// ---------- shared ----------
const t = (text, marks) => ({ type: 'text', text, ...(marks?.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const para = (styleId, content, tabs) => ({ type: 'paragraph', attrs: { styleId, ...(tabs ? { tabs } : {}) }, ...(content.length ? { content } : {}) });
const collatorOf = (lcid) => new Intl.Collator(LCID[lcid] ?? 'en-US', { numeric: true });

/** Page items → text runs: ascending, without repeats, a range as "5–7", bold and italic numbers as marked. `list` joins them. */
function pageRuns(pages, { list = ', ', range = '–' } = {}) {
  const seen = new Map();
  for (const p of pages) {
    const key = `${p.n}-${p.to?.n ?? p.n}`;
    const had = seen.get(key);
    if (had) Object.assign(had, { bold: had.bold || p.bold, italic: had.italic || p.italic });
    else seen.set(key, { ...p });
  }
  const out = [];
  [...seen.values()].sort((a, b) => a.n - b.n || (a.to?.n ?? a.n) - (b.to?.n ?? b.n)).forEach((p, i) => {
    if (i) out.push(t(list));
    const text = p.to && p.to.n !== p.n ? `${p.label}${range}${p.to.label}` : p.label;
    out.push(t(text, [p.bold && 'bold', p.italic && 'italic'].filter(Boolean)));
  });
  return out;
}

const tabStop = (pos, leader) => (pos ? [{ pos, align: 'right', leader }] : null);

// ---------- INDEX ----------

/** The INDEX field's result for `entries` ([{levels, page: {n, label}, to?: {n, label}, bold, italic, cross, type, yomi}]) under the
 * field's switches `sw` (parseField's): block JSON. `tabPos` (pt) is the right tab for \e "\t" in one column, `leader` its leader. */
export function buildIndex(entries, sw = {}, { tabPos = 0, leader = 'dot' } = {}) {
  const type = String(sw.f ?? 'I').toLowerCase();
  const [lo, hi] = typeof sw.p === 'string' ? sw.p.toLowerCase().split(/-+/) : [];
  const col = collatorOf(sw.z);
  const root = { kids: new Map() };
  for (const e of entries) {
    if (String(e.type ?? 'I').toLowerCase() !== type || !e.levels?.length) continue;
    const first = e.levels[0][0]?.toLowerCase() ?? '';
    if (lo && (first < lo || first > (hi || lo))) continue;
    let node = root;
    // \y "main:sub" gives each level its own reading to sort by (an empty part keeps that level's text).
    const yomi = e.yomi ? e.yomi.split(/(?<!\\):/).map((s) => s.replace(/\\:/g, ':').trim()) : [];
    e.levels.forEach((text, i) => {
      if (!node.kids.has(text)) node.kids.set(text, { text, sort: text, pages: [], cross: [], kids: new Map() });
      node = node.kids.get(text);
      if (yomi[i]) node.sort = yomi[i];
    });
    if (e.cross) node.cross.includes(e.cross) || node.cross.push(e.cross);
    else if (e.page) node.pages.push({ ...e.page, to: e.to, bold: e.bold, italic: e.italic });
  }
  const sorted = (n) => [...n.kids.values()].sort((a, b) => col.compare(a.sort, b.sort));
  const columns = Math.min(4, Math.max(1, Number(sw.c) || 1));
  const entrySep = sw.e ?? ', ';
  const crossSep = sw.k ?? (sw.e != null ? sw.e : '. ');
  const tabs = entrySep.includes('\t') ? tabStop(tabPos ? Math.round((tabPos - 18 * (columns - 1)) / columns) : 0, leader) : null;
  const opts = { list: sw.l ?? ', ', range: sw.g ?? '–' };
  // One entry's runs: its text, its page numbers, then its cross-references in italic.
  const runsOf = (n) => {
    const out = [t(n.text)];
    if (n.pages.length) out.push(t(entrySep), ...pageRuns(n.pages, opts));
    if (n.cross.length) out.push(t(n.pages.length ? sw.k ?? '. ' : crossSep), t(n.cross.join('; '), ['italic']));
    return out;
  };
  const blocks = [];
  const walk = (n, level) => {
    for (const k of sorted(n)) {
      if (sw.r && level === 1 && k.kids.size) {
        // Run-in: the subentries follow their main entry in one paragraph ("Fruit: Banana, 4; Cherry, 5").
        const runs = runsOf(k);
        sorted(k).forEach((s, i) => runs.push(t(i ? '; ' : ': '), ...runsOf(s)));
        blocks.push(para('Index1', runs, tabs));
        continue;
      }
      blocks.push(para(`Index${level}`, runsOf(k), tabs));
      walk(k, level + 1);
    }
  };
  // Letter headings (\h): "A" becomes each group's letter; a heading without a letter (" ") gives a blank line between groups.
  const h = sw.h === true ? '' : sw.h ?? '';
  let group = null;
  for (const k of sorted(root)) {
    const letter = (k.sort[0] ?? '').toLocaleUpperCase();
    if (h && letter !== group) {
      if (/[a-z]/i.test(h)) blocks.push(para('IndexHeading', [t(h.replace(/[a-z]/i, letter))]));
      else if (group !== null) blocks.push(para('IndexHeading', []));
      group = letter;
    }
    walk({ kids: new Map([[k.text, k]]) }, 1);
  }
  if (!blocks.length) return [para('Normal', [t('No index entries found.')])];
  return columns > 1 ? [{ type: 'columns', attrs: { count: columns }, content: blocks }] : blocks;
}

// ---------- TOA ----------

/** The TOA field's result for `entries` ([{long, short, category, page: {n, label}, to?, bold, italic}] in document order) under
 * `sw`: block JSON. A TA with only \s takes the long citation and category of the TA that defined that short citation. */
export function buildToa(entries, sw = {}, { names = {}, tabPos = 0, leader = 'dot', lcid = 1033 } = {}) {
  const byShort = new Map();
  for (const e of entries) if (e.long) byShort.set(e.short || e.long, { long: e.long, category: Number(e.category) || 1 });
  const want = sw.c != null ? Number(sw.c) : null;
  const cites = new Map();
  for (const e of entries) {
    const def = e.long ? { long: e.long, category: Number(e.category) || 1 } : byShort.get(e.short);
    if (!def || (want != null && def.category !== want)) continue;
    if (!cites.has(def.long)) cites.set(def.long, []);
    if (e.page) cites.get(def.long).push({ ...e.page, to: e.to, bold: e.bold, italic: e.italic });
  }
  const col = collatorOf(lcid);
  const entrySep = sw.e ?? '\t';
  const tabs = entrySep.includes('\t') ? tabStop(tabPos, leader) : null;
  const blocks = [];
  for (const long of [...cites.keys()].sort(col.compare)) {
    const pages = cites.get(long);
    const distinct = new Set(pages.map((p) => p.n)).size;
    const nums = sw.p && distinct >= 5 ? [t('passim')] : pageRuns(pages, { list: sw.l ?? ', ', range: sw.g ?? '–' });
    blocks.push(para('TableofAuthorities', [t(long), t(entrySep), ...nums], tabs));
  }
  if (!blocks.length) return [para('Normal', [t('No table of authorities entries found.')])];
  if (sw.h && want != null) blocks.unshift(para('TOAHeading', [t(categoryName(want, names))]));
  return blocks;
}

// ---------- marking ----------

/** Mark All's hits of `text` in `paras` ([{pos, text}]: each paragraph's text start and its plain text, one character per position):
 * the same case and the whole text, the first per paragraph (unverified rule) → [{from, to}]. */
export function markAllHits(paras, text) {
  const out = [];
  if (!text) return out;
  const word = (c) => !!c && /[\p{L}\p{N}_]/u.test(c);
  for (const p of paras) {
    for (let i = p.text.indexOf(text); i >= 0; i = p.text.indexOf(text, i + 1)) {
      if (word(p.text[i - 1]) || word(p.text[i + text.length])) continue;
      out.push({ from: p.pos + i, to: p.pos + i + text.length });
      break;
    }
  }
  return out;
}

/** Text that looks like a legal authority, for Next Citation (unverified list). */
export const CITATION = /\sv\.\s|\bIn re\b|\bId\.|§|\bSupra\b/i;

/** A concordance file's rows (tab- or comma-separated: the text to mark, then the entry; an empty entry means the same text). */
export function concordanceRows(data) {
  return String(data ?? '').split(/\r?\n/).map((line) => line.split(line.includes('\t') ? '\t' : ','))
    .map(([text, entry]) => ({ text: text?.trim() ?? '', entry: entry?.trim() || text?.trim() || '' })).filter((r) => r.text);
}

/** The Index tab's Formats as INDEX switches: `h` the letter heading (`\h`; a blank one is a blank line), `right` page numbers
 * right-aligned. Our presets for the formats other than From template (Word's own designs are not copied; recorded). */
export const INDEX_FORMATS = { template: {}, classic: { h: 'A' }, fancy: { h: 'A', right: true }, modern: { h: 'A' }, bulleted: { h: 'A' }, formal: { right: true }, simple: { h: ' ' } };
