// Headers, footers and page numbers, the pure part (docs/plans/word/plan.md §3 headers-footers, §1.8 sect v2): which part a page
// shows through the Link to Previous chain, where an edit of a linked part is written, the gallery blocks, the v1 page number
// (sect.pageNumber) as a footer or header part, Remove Page Numbers, the editing label and the reserve() sums. No DOM and no app
// import, so node tests load it and the agents' doc.pageSetup can call setPageNumberPart.

/** The sect key of each story kind. */
export const EDGE = { header: 'hdr', footer: 'ftr' };
/** The paragraph style of each sect key. */
export const STYLE = { hdr: 'Header', ftr: 'Footer' };

/** The sect part a page shows for its PageBox.part: 'odd' is the default part. */
export const partOf = (pagePart) => (pagePart === 'odd' || !pagePart ? 'default' : pagePart);

// Word's Header and Footer styles (index-layout.md line 83): based on Normal, a Center stop at 234 pt and a Right stop at 468 pt
// (Letter positions, kept on A4), no space after.
const hfStyle = (name) => ({
  type: 'paragraph', name, basedOn: 'Normal', next: name, uiPriority: 99, unhideWhenUsed: true,
  para: { tabs: [{ pos: 234, align: 'center', leader: 'none' }, { pos: 468, align: 'right', leader: 'none' }], spacing: { after: 0, line: { rule: 'auto', value: 1 } } },
});
/** The styles this package brings in on first use (ensureStyles). */
export const HF_STYLES = { Header: hfStyle('Header'), Footer: hfStyle('Footer') };

/** The first word of field code `code`, upper case ('PAGE', 'NUMPAGES'). */
export const fieldName = (code) => String(code ?? '').trim().split(/[\s\\]/)[0].toUpperCase();

// ---------------------------------------------------------------------------------------------
// Part resolution

/** The content of part `part` ('default', 'first', 'even') of sect key `edge` ('hdr', 'ftr') in section `index` of `sects`
 * (sect objects in section order), followed back through linked sections → {content: block JSON | null, holder: the section
 * index that holds it, or null when no section does (the part is empty)}. A null part, or a whole null hdr or ftr, is linked to
 * the previous section; a null part in the first section is empty. */
export function resolvePart(sects, index, edge, part) {
  for (let j = Math.min(index, sects.length - 1); j >= 0; j--) {
    const v = sects[j]?.[edge]?.[part];
    if (Array.isArray(v)) return { content: v, holder: j };
  }
  return { content: null, holder: null };
}

/** Whether section `index`'s part is linked to the previous section's (Same as Previous): never in the first section. */
export const isLinked = (sects, index, edge, part) => index > 0 && !Array.isArray(sects[index]?.[edge]?.[part]);

/** The section an edit of section `index`'s part writes to: the nearest earlier section holding it, else the first section. */
export const writeTarget = (sects, index, edge, part) => resolvePart(sects, index, edge, part).holder ?? 0;

/** `sect` with part `part` of `edge` set to `content` (block JSON; [] is an own empty part). Other keys are kept. */
export const withPart = (sect, edge, part, content) => ({ ...sect, [edge]: { ...(sect?.[edge] ?? {}), [part]: content } });

/** `sect` with part `part` of `edge` linked to the previous section (Link to Previous on): the part goes. */
export function withoutPart(sect, edge, part) {
  const own = { ...(sect?.[edge] ?? {}) };
  delete own[part];
  return { ...sect, [edge]: own };
}

/** What section `index`'s part shows from the previous section, as a copy: Link to Previous off keeps it as the section's own
 * part, and Alt+Shift+R puts it into the part being edited. */
export const previousContent = (sects, index, edge, part) => structuredClone(resolvePart(sects, index - 1, edge, part).content ?? []);

/** The parts the pages show, once each, in page order: [{section, part, page}] (Previous and Next step through them). */
export function partsInOrder(pages) {
  const seen = new Set();
  const out = [];
  for (const p of pages ?? []) {
    const part = partOf(p.part);
    const key = `${p.section}:${part}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ section: p.section, part, page: p.index });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Blocks

const para = (style, attrs, content) => ({ type: 'paragraph', attrs: { styleId: style, ...attrs }, ...(content?.length ? { content } : {}) });
const text = (t, marks) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const field = (code, result, marks) => ({ type: 'field', attrs: { code, result }, ...(marks ? { marks } : {}) });
const BOLD = [{ type: 'bold' }];
const RULE = { style: 'single', width: 0.75, space: 1, color: 'auto' };

/** The placeholder text the Blank galleries put in, selected when the story opens so typing replaces it. */
export const PLACEHOLDER = '[Type here]';
const TITLE = '[Document title]';

/** The Header and Footer galleries' items: Word's two blank ones, then designs of our own. */
export const HF_GALLERY = [
  { id: 'blank', label: 'Blank' },
  { id: 'blankThreeColumns', label: 'Blank (three columns)' },
  { id: 'titleRule', label: 'Title over a rule' },
  { id: 'titleNumber', label: 'Title and page number' },
];

/** The blocks of gallery item `id` for sect key `edge`, or null for an id this package does not know (a user block). */
export function galleryBlocks(edge, id) {
  const s = STYLE[edge];
  switch (id) {
    case 'blank': return [para(s, {}, [text(PLACEHOLDER)])];
    // Three placeholders on the style's left edge, Center stop and Right stop.
    case 'blankThreeColumns': return [para(s, {}, [text(`${PLACEHOLDER}\t${PLACEHOLDER}\t${PLACEHOLDER}`)])];
    case 'titleRule': return [para(s, { borders: { [edge === 'hdr' ? 'bottom' : 'top']: RULE } }, [text(TITLE)])];
    case 'titleNumber': return [para(s, {}, [text(`${TITLE}\t\t`), field('PAGE', '1')])];
    default: return null;
  }
}

/** Page Number > Top of Page and Bottom of Page items: Plain Number 1 to 3 and Page X of Y. */
export const NUMBER_GALLERY = [
  { id: 'left', label: 'Plain Number 1' }, { id: 'center', label: 'Plain Number 2' }, { id: 'right', label: 'Plain Number 3' },
  { id: 'pageXofY', label: 'Page X of Y' },
];
/** Page Number > Current Position items. */
export const CURRENT_GALLERY = [{ id: 'plainNumber', label: 'Plain Number' }, { id: 'pageXofY', label: 'Page X of Y' }];
/** Page Number > Page Margins items. */
export const MARGIN_GALLERY = [{ id: 'left', label: 'Number in the left margin' }, { id: 'right', label: 'Number in the right margin' }];

/** Inline content of Page X of Y: "Page {PAGE} of {NUMPAGES}" with the numbers bold. */
export const pageXofY = (page = '1', pages = '1') => [text('Page '), field('PAGE', page, BOLD), text(' of '), field('NUMPAGES', pages, BOLD)];

/** The blocks of Top or Bottom of Page item `id` for `edge`: a PAGE field in a paragraph aligned left, centre or right, or Page X
 * of Y centred; null for an unknown id. */
export function numberBlocks(edge, id, page = '1', pages = '1') {
  if (id === 'pageXofY') return [para(STYLE[edge], { textAlign: 'center' }, pageXofY(page, pages))];
  if (!['left', 'center', 'right'].includes(id)) return null;
  return [para(STYLE[edge], { textAlign: id }, [field('PAGE', page)])];
}

/** A text box in the side margin (`side` 'left' or 'right') holding a centred PAGE field. float-layout places it once merged. */
export const marginNumberBox = (side, page = '1') => ({
  type: 'textBox',
  attrs: { layout: { wrap: 'front', h: { rel: 'page', align: side, offset: 0 }, v: { rel: 'page', align: 'center', offset: 0 } }, w: 36, h: 28, line: null, fill: null },
  content: [para(null, { textAlign: 'center' }, [field('PAGE', page)])],
});

// ---------------------------------------------------------------------------------------------
// Page numbers: v1 and Remove Page Numbers

const isPageField = (n) => n?.type === 'field' && fieldName(n.attrs?.code) === 'PAGE';
const holdsPage = (b) => isPageField(b) || (b?.content ?? []).some(holdsPage);

// A gallery number paragraph: nothing but PAGE and NUMPAGES fields and Page X of Y's words.
const galleryLine = (content) => /^\s*(Page\s+of)?\s*$/i.test(content
  .filter((n) => !(n.type === 'field' && ['PAGE', 'NUMPAGES'].includes(fieldName(n.attrs?.code)))).map((n) => (n.type === 'text' ? n.text : '\u0001')).join(''));

function stripBlock(b) {
  if (b.type === 'textBox') return holdsPage(b) ? null : b;
  if (!Array.isArray(b.content) || !holdsPage(b)) return b;
  if (b.type === 'paragraph' || b.type === 'heading') {
    if (galleryLine(b.content)) return null;
    const content = b.content.filter((n) => !isPageField(n));
    const out = { ...b, content };
    if (!content.length) delete out.content;
    return out;
  }
  const content = b.content.map(stripBlock).filter(Boolean);
  // A container keeps one block (a table cell, a content control).
  return { ...b, content: content.length || b.type === 'table' || b.type === 'tableRow' ? content : [{ type: 'paragraph' }] };
}

/** Story blocks `blocks` without page numbers: the gallery's number paragraphs and margin boxes go, other PAGE fields leave their
 * paragraph. The same array back when nothing changed. */
export function stripPageNumbers(blocks) {
  if (!Array.isArray(blocks) || !blocks.some(holdsPage)) return blocks;
  return blocks.map(stripBlock).filter(Boolean);
}

/** The part a v1 page number {at, align, start} becomes: one Header or Footer paragraph holding a PAGE field, aligned as before. */
export const pageNumberPart = (pn) => [para(pn.at === 'top' ? 'Header' : 'Footer', { textAlign: pn.align ?? 'center' }, [field('PAGE', String(pn.start ?? 1))])];

/** `sect` with page number `value` ({at, align, start} or null) as a header or footer part (plan.md §3 headers-footers, the agents'
 * doc.pageSetup): every page number goes from its parts first, so a page never shows two; then value's edge gets a default part
 * holding the number and pgNum.start takes value.start. sect.pageNumber (v1) is cleared. Pure: unknown keys are kept. */
export function setPageNumberPart(sect, value) {
  const out = { ...sect, pageNumber: null };
  for (const edge of ['hdr', 'ftr']) {
    if (!out[edge]) continue;
    out[edge] = Object.fromEntries(Object.entries(out[edge]).map(([k, v]) => [k, Array.isArray(v) ? stripPageNumbers(v) : v]));
  }
  if (!value) return out;
  const edge = value.at === 'top' ? 'hdr' : 'ftr';
  out[edge] = { ...(out[edge] ?? {}), default: pageNumberPart(value) };
  // Only a given start replaces the section's: {at, align} alone keeps a Start at the user set in Format Page Numbers.
  if ('start' in value) out.pgNum = { ...(sect.pgNum ?? {}), start: value.start ?? null };
  return out;
}

/** Whether `sect` shows a page number: a v1 sect.pageNumber or a PAGE field in one of its own parts. */
export const hasPageNumbers = (sect) => !!sect?.pageNumber
  || ['hdr', 'ftr'].some((edge) => Object.values(sect?.[edge] ?? {}).some((v) => Array.isArray(v) && v.some(holdsPage)));

// The drawn parts per v1 pageNumber object, reused while the sect's own hdr and ftr are the same objects: the page layer keys on
// the parts' identity, so a new array per doc change would redraw every page on every keystroke.
const drawnParts = new WeakMap();

/** The sect a page draws: a v1 sect.pageNumber shown as its footer or header part without a write (until the user's first header
 * or footer edit converts it). The part arrays keep their identity while the stored sect is unchanged. */
export function drawnSect(sect) {
  const pn = sect?.pageNumber;
  if (!pn) return sect;
  const out = setPageNumberPart(sect, pn);
  if (typeof pn !== 'object') return out;
  const hit = drawnParts.get(pn);
  if (hit && hit.hdr === sect.hdr && hit.ftr === sect.ftr) return { ...out, hdr: hit.out.hdr, ftr: hit.out.ftr };
  drawnParts.set(pn, { hdr: sect.hdr, ftr: sect.ftr, out });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Page number text

/** Format Page Numbers' Number format list (probe/dialogs/page-number-format.json; the Double byte and East Asian items are left out). */
export const NUMBER_FORMATS = [['decimal', '1, 2, 3, …'], ['numberInDash', '- 1 -, - 2 -, - 3 -, …'], ['lowerLetter', 'a, b, c, …'],
  ['upperLetter', 'A, B, C, …'], ['lowerRoman', 'i, ii, iii, …'], ['upperRoman', 'I, II, III, …']];
/** The chapter separators (w:chapSep) and their characters. */
export const SEPARATORS = { hyphen: '-', period: '.', colon: ':', emDash: '—', enDash: '–' };
/** Word's text when no paragraph of the chapter style precedes the page. */
export const CHAPTER_ERROR = 'Error! No text of specified style in document.';

/** The text of a PAGE field: `label` (the page's number in pgNum.fmt), after the chapter number and separator when pgNum.chapStyle
 * (heading level 1 to 9) is set; `chapter` is that heading's list label (null when there is none, giving Word's error text). */
export function pageNumberText(label, pgNum, chapter) {
  if (!pgNum?.chapStyle) return label;
  if (chapter == null || chapter === '') return CHAPTER_ERROR;
  return `${chapter}${SEPARATORS[pgNum.chapSep] ?? '-'}${label}`;
}

/** The drawn text of a layout field in a header or footer when no field type computes it: PAGE, NUMPAGES, SECTIONPAGES and
 * SECTION from the page being drawn; null for any other field. */
export function layoutFieldText(code, { page, pages, sectionPages, pgNum, chapter }) {
  switch (fieldName(code)) {
    case 'PAGE': return pageNumberText(page.label, pgNum, chapter);
    case 'NUMPAGES': return String(pages);
    case 'SECTIONPAGES': return String(sectionPages);
    case 'SECTION': return String(page.section + 1);
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Editing label and reserve

/** The tab label of a part being edited (index-layout.md line 196): its name, "-Section n-" with several sections, and "Same as
 * Previous" at the right when linked → {text, right}. */
export function labelOf({ kind, part, evenAndOdd, section, sections, linked }) {
  const base = kind === 'header' ? 'Header' : 'Footer';
  const name = part === 'first' ? `First Page ${base}` : part === 'even' ? `Even Page ${base}` : evenAndOdd ? `Odd Page ${base}` : base;
  return { text: sections > 1 ? `${name} -Section ${section + 1}-` : name, right: linked ? 'Same as Previous' : '' };
}

/** What a page's body must keep clear (PageLayer.reserve, px): top = header distance + the drawn header's height, bottom = footer
 * distance + the footer's height. A negative top or bottom margin gives nothing for that edge, so the part overlaps the body
 * (index-layout.md line 152). `box` is the PageBox's box; a height of null is not measured yet. */
export function reserveOf(box, { headerH, footerH }) {
  const out = {};
  if (box.top >= 0 && headerH != null) out.top = box.header + headerH;
  if (box.bottom >= 0 && footerH != null) out.bottom = box.footer + footerH;
  return out;
}
