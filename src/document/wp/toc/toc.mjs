// Tables of contents and figures, TC entries and captions (docs/plans/word/briefs/toc.md, index-fields.md TOC and TC, SEQ and
// captions). Pure: ProseMirror nodes in, block JSON out, so the field type, the editor commands and the Node tests share one builder.
import { fieldCtx, parseField } from '../../fields/registry.mjs';
import { numberText } from '../../fields/numfmt.mjs';
import { visibleText } from '../../model/review.mjs';
import { sectionAt, sectionsOf } from '../../model/sections.mjs';
import { styleChain, styleIdOf } from '../../model/styles.mjs';

/** The switch letters of TOC and TC that take no argument (the others take the next word when one follows). */
export const TOC_BARE = 'hzuwx';
export const TC_BARE = 'n';

export const NO_TOC = 'No table of contents entries found.';
export const NO_TOF = 'No table of figures entries found.';
export const TOC_GALLERY = 'Table of Contents';

// ---------- styles ----------
// Brought into a document on first use through ensureStyles. TOC 1 is the probe's (table-of-contents-style.json: space after 5 pt,
// based on Normal, next Normal); the 11 pt indent per level, Table of Figures and Caption are Word's defaults as remembered, unverified.
const tocLevel = (n) => ({
  type: 'paragraph', name: `toc ${n}`, basedOn: 'Normal', next: 'Normal', autoRedefine: true, uiPriority: 39, semiHidden: true, unhideWhenUsed: true,
  para: { spacing: { after: 5 }, ...(n > 1 && { indent: { left: 11 * (n - 1) } }) },
});
export const TOC_STYLES = {
  TOCHeading: { type: 'paragraph', name: 'TOC Heading', basedOn: 'Heading1', next: 'Normal', uiPriority: 39, unhideWhenUsed: true, qFormat: true, para: { outline: 9 } },
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`TOC${i + 1}`, tocLevel(i + 1)])),
};
export const TOF_STYLES = {
  TableofFigures: { type: 'paragraph', name: 'table of figures', basedOn: 'Normal', next: 'Normal', uiPriority: 99, unhideWhenUsed: true, para: { spacing: { after: 0 } } },
};
export const CAPTION_STYLES = {
  Caption: {
    type: 'paragraph', name: 'caption', basedOn: 'Normal', next: 'Normal', uiPriority: 35, unhideWhenUsed: true, qFormat: true,
    para: { spacing: { after: 10, line: { rule: 'auto', value: 1 } } },
    run: { italic: true, size: 9, color: '#0E2841', themeColor: { slot: 'dk2', lum: 0 } },
  },
};

/** The Table of Contents dialog's Formats, as run properties per TOC level (From template leaves the styles alone). Our own presets:
 * Word's are not recorded. */
export const TOC_FORMATS = {
  template: null,
  classic: { 1: { bold: true, caps: true }, 2: { smallCaps: true }, 3: { italic: true } },
  distinctive: { 1: { bold: true }, 2: { italic: true }, 3: { italic: true } },
  fancy: { 1: { bold: true, smallCaps: true }, 2: { italic: true } },
  modern: { 1: { bold: true }, 2: { bold: false } },
  formal: { 1: { caps: true }, 2: { smallCaps: true } },
  simple: {},
};

// ---------- small readers ----------
export const nameOf = (n) => n?.type?.name ?? n?.type;
const lower = (s) => String(s ?? '').toLowerCase();

/** A level range switch value ('1-3', '2', true) → [from, to]; `all` when the switch is bare or absent. */
export function rangeOf(v, all = [1, 9]) {
  if (v == null || v === true) return all;
  const m = String(v).match(/(\d+)\s*(?:-\s*(\d+))?/);
  return m ? [+m[1], +(m[2] ?? m[1])] : all;
}
const within = ([a, b], n) => n >= a && n <= b;

/** The outline level (0 to 8, 9 body text) paragraph `node` takes from its style chain; a heading without styles gives its level. */
export function styleOutline(doc, node) {
  let o = null;
  for (const s of styleChain(doc, styleIdOf(node))) if (s.para?.outline != null) o = s.para.outline;
  if (o == null && nameOf(node) === 'heading') o = (node.attrs.level ?? 1) - 1;
  return o;
}

/** `\t "Style,Level,..."` → Map of lower-case style id and name → level. */
function extraStyles(doc, v) {
  const out = new Map();
  if (typeof v !== 'string') return out;
  const parts = v.split(/[,;]/).map((s) => s.trim());
  const list = doc.attrs?.styles?.list ?? {};
  for (let i = 0; i < parts.length; i += 2) {
    const name = lower(parts[i]);
    if (!name) continue;
    const level = +parts[i + 1] || 1;
    out.set(name, level);
    // Style names match whatever their case or spacing; the id (Heading2) matches its name (heading 2) too.
    for (const [id, s] of Object.entries(list)) if (lower(s.name) === name || lower(id) === name.replace(/\s+/g, '')) out.set(lower(id), level);
  }
  return out;
}

/** The SEQ identifier a caption label writes: spaces become underscores, as Word's do. */
export const seqId = (label) => String(label).trim().replace(/\s+/g, '_');

/** The name of the first `_Toc` bookmark that starts inside textblock `node` → name or null (reused on every update). */
function tocBookmarkIn(node) {
  let name = null;
  node.forEach((c) => {
    if (!name && nameOf(c) === 'bookmark' && !c.attrs.end && /^_Toc/i.test(c.attrs.name)) name = c.attrs.name;
  });
  return name;
}

/** Entry text: visible text with tabs and line breaks turned into spaces unless `\w` and `\x` keep them. */
const entryText = (s, sw) => {
  let t = String(s);
  if (!sw.w) t = t.replace(/\t/g, ' ');
  if (!sw.x) t = t.replace(/\n/g, ' ');
  return t.trim();
};

// The text of `node` after its child at `index` (the caption text without label and number, for \a), its leading separator dropped.
function textAfter(node, index) {
  let s = '';
  node.forEach((c, _o, i) => {
    if (i > index) s += visibleText(c);
  });
  return s.replace(/^\s*[:.\-\u2013\u2014]?\s*/, '');
}

/** The SEQ numbers of `doc` in document order → [{pos, id (lower case), n}], following Word's rules: `\r n` sets, `\c` repeats,
 * `\s n` restarts after each heading of level n, `\h` still counts. */
export function seqNumbers(doc) {
  const out = [];
  const count = new Map();
  const lastReset = new Map(); // id → the heading index its count belongs to
  const headings = []; // [level] → how many headings of that level so far
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      const o = styleOutline(doc, node);
      if (o != null && o < 9) headings[o + 1] = (headings[o + 1] ?? 0) + 1;
    }
    if (nameOf(node) !== 'field') return true;
    const f = parseField(node.attrs.code);
    if (f.name !== 'SEQ' || !f.args[0]) return false;
    const id = lower(f.args[0]);
    if (f.sw.s) {
      const mark = `${f.sw.s}:${headings[+f.sw.s] ?? 0}`;
      if (lastReset.get(id) !== mark) {
        lastReset.set(id, mark);
        count.set(id, 0);
      }
    }
    let n = count.get(id) ?? 0;
    if (f.sw.r != null && f.sw.r !== true) n = +f.sw.r || 0;
    else if (!f.sw.c) n++;
    count.set(id, n);
    out.push({ pos, id, n, f });
    return false;
  });
  return out;
}

const FORMAT_OF = { arabic: 'decimal', alphabetic: 'lowerLetter', roman: 'lowerRoman' };
/** SEQ number `n` in the field's `\*` format (ARABIC, alphabetic, ALPHABETIC, roman, ROMAN). */
export function seqText(n, format) {
  const fmt = (format ?? []).find((x) => FORMAT_OF[lower(x)]);
  if (!fmt) return String(n);
  const base = FORMAT_OF[lower(fmt)];
  const upper = fmt === fmt.toUpperCase() && base !== 'decimal';
  return upper ? numberText(n, base.replace('lower', 'upper')) : numberText(n, base);
}

// ---------- entries ----------
/** @typedef {{level: number, text: string, from: number, to: number, bookmark: string|null, noPage: boolean, error?: boolean}} Entry
 * from and to: the range the entry's _Toc bookmark goes around (the heading's text, or the TC field). */

/** The entries field `f` (a parsed TOC) collects from `doc`, in document order. `rd(name)` → a ProseMirror doc for RD fields or null.
 * `nested` builds an RD file's entries (no TC, no RD and no bookmarks inside it). */
export function tocEntries(doc, f, { rd = () => null, nested = false } = {}) {
  const sw = f.sw;
  const label = typeof sw.c === 'string' ? sw.c : typeof sw.a === 'string' ? sw.a : null;
  const figures = label != null;
  const extra = extraStyles(doc, sw.t);
  const outlines = sw.o != null ? rangeOf(sw.o) : null;
  const useStyles = outlines || extra.size;
  const tcWanted = sw.f != null && !nested;
  const tcId = sw.f === true ? null : lower(sw.f);
  const tcLevels = rangeOf(sw.l);
  const only = typeof sw.b === 'string' ? fieldCtx({ doc }).bookmark(sw.b) : null;
  const out = [];
  doc.descendants((node, pos) => {
    if (nameOf(node) === 'fieldBlock') return false; // a table's own entries never list themselves
    if (!node.isTextblock) return true;
    if (only && (pos < only.from - 1 || pos > only.to)) return false;
    const from = pos + 1;
    const to = pos + node.nodeSize - 1;
    const bookmark = nested ? null : tocBookmarkIn(node);
    if (figures) {
      let at = -1;
      node.forEach((c, _o, i) => {
        if (at < 0 && nameOf(c) === 'field') {
          const p = parseField(c.attrs.code);
          if (p.name === 'SEQ' && lower(p.args[0]) === lower(seqId(label))) at = i;
        }
      });
      const caption = styleIdOf(node) === 'Caption';
      if (at >= 0 && (sw.c != null || caption)) {
        const text = entryText(sw.a != null && sw.c == null ? textAfter(node, at) : visibleText(node), sw);
        out.push({ level: 1, text, from, to, bookmark, noPage: false });
      }
    } else {
      const sid = lower(styleIdOf(node));
      const sname = lower(doc.attrs?.styles?.list?.[styleIdOf(node)]?.name);
      let level = extra.get(sid) ?? extra.get(sname) ?? null;
      if (level == null && outlines) {
        const o = sw.u && node.attrs.outline != null ? node.attrs.outline : styleOutline(doc, node);
        if (o != null && o < 9 && within(outlines, o + 1)) level = o + 1;
      }
      if (level == null && sw.u && !useStyles) {
        const o = node.attrs.outline;
        if (o != null && o < 9) level = o + 1;
      }
      const text = level != null ? entryText(visibleText(node), sw) : '';
      if (level != null && text) out.push({ level, text, from, to, bookmark, noPage: false });
    }
    // TC fields and RD files inside this paragraph, at their own place in the order.
    node.forEach((c, offset) => {
      if (nameOf(c) !== 'field') return;
      const p = parseField(c.attrs.code);
      const at = from + offset;
      if (p.name === 'TC' && tcWanted) {
        const id = p.sw.f == null || p.sw.f === true ? null : lower(p.sw.f);
        // A bare \f takes the TC fields with no identifier, and C, the Mark dialog's default.
        const fits = tcId ? id === tcId : id == null || id === 'c';
        const level = +(p.sw.l ?? 1) || 1;
        if (fits && within(tcLevels, level)) out.push({ level, text: entryText(p.args[0] ?? '', sw), from: at, to: at + 1, bookmark: tcBookmarkBefore(node, offset), noPage: !!p.sw.n });
      } else if (p.name === 'RD' && !nested) {
        const other = rd(p.args[0]);
        if (!other) out.push({ level: 1, text: '', from: at, to: at + 1, bookmark: null, noPage: true, error: true, rd: true });
        else for (const e of tocEntries(other, f, { nested: true })) out.push({ ...e, from: at, to: at + 1, bookmark: null, noPage: true, rd: true });
      }
    });
    return false;
  });
  return out;
}

// The _Toc bookmark that starts right before the TC field at `offset` in `node`, or null.
function tcBookmarkBefore(node, offset) {
  let prev = null;
  let name = null;
  node.forEach((c, o) => {
    if (o === offset && prev && nameOf(prev) === 'bookmark' && !prev.attrs.end && /^_Toc/i.test(prev.attrs.name)) name = prev.attrs.name;
    prev = c;
  });
  return name;
}

/** The text width (pt) of the section holding `pos`: the right tab of every entry sits there. */
export function textWidth(doc, pos) {
  const s = sectionAt(sectionsOf(doc), pos).sect;
  return Math.round((s.w - (s.margin.left ?? 0) - (s.margin.right ?? 0) - (s.margin.gutter ?? 0)) * 20) / 20;
}

const txt = (text, marks) => ({ type: 'text', text, ...(marks?.length && { marks }) });

/** The block JSON of a table built from `entries` for parsed TOC `f`. `pageOf(pos)` → the page label or null; `leader` the right
 * tab's leader; `width` its position (pt). */
export function tocBlocks(entries, f, { pageOf = () => null, leader = 'dot', width = 451.3 } = {}) {
  const sw = f.sw;
  const figures = typeof sw.c === 'string' || typeof sw.a === 'string';
  if (!entries.length) return [{ type: 'paragraph', content: [txt(figures ? NO_TOF : NO_TOC, [{ type: 'bold' }])] }];
  const noPages = sw.n != null ? rangeOf(sw.n) : null;
  const sep = typeof sw.p === 'string' ? sw.p : '\t';
  return entries.map((e) => {
    const style = figures ? 'TableofFigures' : `TOC${Math.min(9, Math.max(1, e.level))}`;
    if (e.error) return { type: 'paragraph', attrs: { styleId: style }, content: [txt(`Error! Cannot open file referenced on page ${pageOf(e.from) ?? 1}`, [{ type: 'bold' }])] };
    const link = sw.h && e.bookmark ? [{ type: 'link', attrs: { href: `#${e.bookmark}`, anchor: e.bookmark, target: null } }] : null;
    const pageless = e.noPage || (noPages && within(noPages, e.level));
    const content = [];
    // \x keeps line breaks as breaks; other text stays one run.
    e.text.split('\n').forEach((part, i) => {
      if (i) content.push({ type: 'hardBreak' });
      if (part) content.push(txt(part, link));
    });
    if (!pageless) {
      let page = pageOf(e.from) ?? '1';
      if (typeof sw.s === 'string') page = `${chapterOf(e, sw.s)}${typeof sw.d === 'string' ? sw.d : '-'}${page}`;
      content.push(txt(sep, link));
      content.push(e.bookmark
        ? { type: 'field', attrs: { code: `PAGEREF ${e.bookmark} \\h`, result: page }, ...(link && { marks: link }) }
        : txt(page, link));
    }
    const tab = !pageless && sep === '\t' ? { tabs: [{ pos: width, align: 'right', leader }] } : {};
    return { type: 'paragraph', attrs: { styleId: style, ...tab }, content };
  });
}

// The \s chapter number of an entry, set by tocEntries' caller through e.chapter (0 when no SEQ of that identifier comes before).
const chapterOf = (e) => e.chapter ?? 0;

/** Sets `chapter` on each entry: the number of the last SEQ `id` field before it (\s Id). */
export function withChapters(doc, entries, id) {
  const seqs = seqNumbers(doc).filter((s) => s.id === lower(id));
  return entries.map((e) => ({ ...e, chapter: seqs.filter((s) => s.pos < e.from).at(-1)?.n ?? 0 }));
}

/** The PAGEREF results inside an existing table's block JSON `json` refreshed through `pageOfBookmark(name)` (Update page numbers
 * only); everything else stays. */
export function refreshPages(json, pageOfBookmark) {
  const walk = (n) => {
    if (n.type === 'field') {
      const p = parseField(n.attrs?.code);
      if (p.name === 'PAGEREF' && p.args[0]) {
        const page = pageOfBookmark(p.args[0]);
        if (page != null) return { ...n, attrs: { ...n.attrs, result: page } };
      }
      return n;
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  return json.map(walk);
}

/** The leader of the first entry's right tab in table block `node` (a fieldBlock), else 'dot'. */
export function leaderOf(node) {
  let leader = null;
  node?.descendants((n) => {
    if (leader) return false;
    const tab = n.attrs?.tabs?.find?.((t) => t.align === 'right');
    if (tab) leader = tab.leader ?? 'none';
    return !n.isTextblock;
  });
  return leader ?? 'dot';
}

// ---------- field types ----------
const pageText = (ctx) => (pos) => {
  const p = ctx.pageAt?.(pos);
  return p ? String(p.label ?? p.number ?? p.index + 1) : null;
};

/** TOC's result for FieldCtx `ctx`: Update page numbers only (ctx.mode 'pages') refreshes the PAGEREF results; otherwise the entries
 * are rebuilt from the document. RD files come from the 'tocRd' provider. A compute cannot write outside its field, so a rebuild here
 * (Update Field, another package's update) adds no _Toc bookmarks: a heading new since the last Update Table gets a plain page
 * number with no link until Update entire table runs (recorded deviation). */
export function computeToc(f, ctx) {
  const node = ctx.doc.nodeAt(ctx.pos);
  const own = nameOf(node) === 'fieldBlock' ? node : null;
  const pageOf = pageText(ctx);
  if (ctx.mode === 'pages' && own) {
    const json = own.toJSON().content ?? [];
    return { blocks: refreshPages(json, (name) => {
      const b = ctx.bookmark(name);
      return b ? pageOf(b.from) : null;
    }) };
  }
  let entries = tocEntries(ctx.doc, f, { rd: (name) => ctx.get('tocRd', name) });
  if (typeof f.sw.s === 'string') entries = withChapters(ctx.doc, entries, f.sw.s);
  return { blocks: tocBlocks(entries, f, { pageOf, leader: leaderOf(own), width: textWidth(ctx.doc, ctx.pos) }) };
}

const NONE = () => ({ text: '', raw: true });
/** The field types this package registers (plan.md §1.10). TC and RD are hidden markers with no result. */
export const FIELDS = {
  TOC: { category: 'Index and Tables', updates: 'manual', block: true, bare: TOC_BARE, compute: computeToc },
  TC: { category: 'Index and Tables', updates: 'never', bare: TC_BARE, compute: NONE },
  RD: { category: 'Index and Tables', updates: 'never', bare: 'f', compute: NONE },
};

// ---------- TC and captions ----------
const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The code Mark Table of Contents Entry writes: `TC "text" \f C \l "1"`, quotes and backslashes escaped. */
export const tcCode = (text, { id = 'C', level = 1 } = {}) => `TC ${quote(text)} \\f ${id} \\l "${level}"`;

/** Caption separators of Caption Numbering (probe caption-numbering.json). */
export const SEPARATORS = { hyphen: '-', period: '.', colon: ':', emDash: '\u2014', enDash: '\u2013' };
/** Caption number formats: value → the `\*` switch. */
export const NUM_FORMATS = { ARABIC: '1, 2, 3, \u2026', alphabetic: 'a, b, c, \u2026', ALPHABETIC: 'A, B, C, \u2026', roman: 'i, ii, iii, \u2026', ROMAN: 'I, II, III, \u2026' };

/** The inline JSON of a caption: the label and a space (unless `exclude`), with chapter numbers `STYLEREF n \s`, the separator and
 * `SEQ Label \* FORMAT \s n`, else `SEQ Label \* FORMAT`, then `text`. `seq` and `chapter` are the results to show. */
export function captionInline(label, { exclude = false, chapter = null, format = 'ARABIC', text = '', seq = 1, chapterText = '0' } = {}) {
  const id = seqId(label);
  const out = [];
  if (!exclude) out.push(txt(`${label} `));
  if (chapter) {
    out.push({ type: 'field', attrs: { code: `STYLEREF ${chapter.level} \\s`, result: chapterText } });
    out.push(txt(SEPARATORS[chapter.sep] ?? '-'));
    out.push({ type: 'field', attrs: { code: `SEQ ${id} \\* ${format} \\s ${chapter.level}`, result: seqText(seq, [format]) } });
  } else out.push({ type: 'field', attrs: { code: `SEQ ${id} \\* ${format}`, result: seqText(seq, [format]) } });
  if (text) out.push(txt(text));
  return out;
}

// ---------- dialog state and switches ----------
export const LEADERS = [['none', '(none)'], ['dot', '.......'], ['hyphen', '-------'], ['underscore', '____'], ['middleDot', '\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7']];

/** The Table of Contents dialog's state for a new table. */
export const TOC_DEFAULTS = { pageNumbers: true, rightAlign: true, leader: 'dot', hyperlinks: true, format: 'template', levels: 3, styles: true,
  outline: true, tcFields: false, extra: [] };

/** Table of Contents dialog state `v` → the TOC code. */
export function tocCode(v) {
  const s = ['TOC'];
  if (v.styles) s.push(`\\o "1-${v.levels}"`);
  if (v.hyperlinks) s.push('\\h', '\\z');
  if (!v.pageNumbers) s.push('\\n');
  else if (!v.rightAlign) s.push('\\p " "');
  if (v.styles && v.extra?.length) s.push(`\\t "${v.extra.map(([name, level]) => `${name},${level}`).join(',')}"`);
  if (v.outline) s.push('\\u');
  if (v.tcFields) s.push('\\f');
  return s.join(' ');
}

/** The dialog state of an existing table's code `code` and its entries' `leader`. */
export function tocState(code, leader = 'dot') {
  const { sw } = parseField(code, null);
  const levels = sw.o != null ? rangeOf(sw.o)[1] : 3;
  const extra = [];
  if (typeof sw.t === 'string') {
    const p = sw.t.split(',').map((x) => x.trim());
    for (let i = 0; i + 1 < p.length; i += 2) extra.push([p[i], +p[i + 1] || 1]);
  }
  return { ...TOC_DEFAULTS, pageNumbers: sw.n == null, rightAlign: typeof sw.p !== 'string', leader, hyperlinks: !!sw.h, levels,
    styles: sw.o != null || extra.length > 0, outline: !!sw.u, tcFields: sw.f != null, extra };
}

/** The Table of Figures dialog's state for a new table. */
export const TOF_DEFAULTS = { pageNumbers: true, rightAlign: true, leader: 'dot', hyperlinks: true, format: 'template', label: 'Figure',
  includeLabel: true, style: null, tcFields: false, tcId: 'F' };

/** Table of Figures dialog state `v` → the TOC code (`\c` or `\a` with the label, `\t` for a style, `\f` for entry fields). */
export function tofCode(v) {
  const s = ['TOC'];
  if (v.hyperlinks) s.push('\\h', '\\z');
  if (!v.pageNumbers) s.push('\\n');
  else if (!v.rightAlign) s.push('\\p " "');
  if (v.style) s.push(`\\t "${v.style},1"`);
  if (v.tcFields) s.push(`\\f ${v.tcId}`);
  if (v.label) s.push(`\\${v.includeLabel ? 'c' : 'a'} "${v.label}"`);
  return s.join(' ');
}

/** Whether TOC code `code` builds a table of figures (`\c` or `\a`). */
export const isFigures = (code) => {
  const { sw } = parseField(code);
  return sw.c != null || sw.a != null;
};
