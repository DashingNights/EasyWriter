// Printing and PDF (docs/plans/word/briefs/print.md, plan.md §1.12 and §1.17): a copy of the laid-out pages, one pageClone per
// page in a sheet of its own paper size, shown only in @media print, so every printed page equals a screen page whatever Chromium
// does with fragmentation. The live editor is never printed; the copy goes as soon as the job ends.
import { draftMeta, toast } from '../../../app/actions.js';
import { getState } from '../../../app/store.js';
import { updateFields } from '../../fields/engine.js';
import { geometryOf, pageClone, pagesReady, scaleOf } from '../../geometry.js';
import { drawAll } from '../../lazy.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { bookletOrder, pdfRanges, pickPages, printArgs, runsOf } from './ranges.mjs';

const PX = 0.75; // pt per layout px

/** The Print page's options; they last while the app runs, as Word keeps them while the document is open. */
export const opts = {
  copies: 1, printer: null, what: 'all', text: '', odd: false, even: false, sides: 'one', collate: true, perSheet: 1,
};

/** The paper of page box `p` in pt: its section's sect when the geometry has it, else the box. */
const paperOf = (geo, p) => {
  const s = geo.sections?.[p.section]?.sect;
  return s?.w ? { w: s.w, h: s.h } : { w: p.box.w * PX, h: p.box.h * PX };
};
const nameOf = ({ w, h }) => `pg_${Math.round(w * 10)}_${Math.round(h * 10)}`;

/** A sheet of `paper` (pt) in the copy, printed on a page of that size; `k` times as large when the PDF scales it back. */
function sheetEl(d, paper, k = 1) {
  const el = d.createElement('div');
  el.className = 'print-sheet';
  el.style.cssText = `page:${nameOf(paper)};width:${(paper.w / PX) * k}px;height:${(paper.h / PX) * k}px`;
  return el;
}

/** Word's properties page (Document Info, and Print document properties): the draft title and the typed properties. */
function propertiesSheet(d, state, paper, k = 1) {
  const sheet = sheetEl(d, paper, k);
  const p = state.doc.attrs.props ?? {};
  const rows = [['Title', p.core?.title || getState().draft?.title], ['Subject', p.core?.subject], ['Author', p.core?.creator],
    ['Keywords', p.core?.keywords], ['Comments', p.core?.description], ['Category', p.core?.category], ['Company', p.app?.company],
    ['Manager', p.app?.manager], ...(p.custom ?? []).map((c) => [c.name, c.value])].filter(([, v]) => v != null && v !== '');
  const box = d.createElement('div');
  box.className = 'print-props';
  box.style.zoom = String(k);
  for (const [k, v] of rows) {
    const row = d.createElement('div');
    row.append(Object.assign(d.createElement('b'), { textContent: `${k}:` }), Object.assign(d.createElement('span'), { textContent: String(v) }));
    box.append(row);
  }
  sheet.append(box);
  return sheet;
}

/** The sheets to print for `o` on `view` → {sheets: [{pages: [index|null], paper}], runs, error}. `runs` (0-based) select from a
 * copy that holds every page in order; null when the copy is already in print order (reverse, book fold, a properties page). */
export function planJob(view, o = opts) {
  const geo = geometryOf(view.state);
  const pages = geo?.pages ?? [];
  if (!pages.length) return { sheets: [], runs: null, error: 'There are no pages to print. Switch to Print Layout and try again.' };
  const { from, to } = view.state.selection;
  const pick = pickPages({ ...o, current: geo.page ?? 0, selection: [geo.pageOf(from), geo.pageOf(to)] }, pages);
  if (pick.error) return { sheets: [], runs: null, error: pick.error };
  const doc = view.state.doc.attrs.settings ?? {};
  const word = wordSettings(getState().settings).print;
  const paper = (i) => paperOf(geo, pages[i]);
  const props = word.properties || o.what === 'info';
  const p0 = paperOf(geo, pages[0]);
  if (doc.bookFold) {
    // Two pages side by side on the section's paper turned landscape (w:pgSz is the sheet; book fold lays out half-sheet pages),
    // in booklet order. Without a sect the sheet is twice the page's width.
    const sides = bookletOrder(pick.indices.length, doc.bookFold.sheets ?? 0, !!doc.bookFold.reverse);
    const s0 = geo.sections?.[pages[0].section]?.sect;
    const sheet = s0?.w ? { w: Math.max(s0.w, s0.h), h: Math.min(s0.w, s0.h) } : { w: p0.w * 2, h: p0.h };
    const sheets = sides.map((pair) => ({ pages: pair.map((k) => (k == null ? null : pick.indices[k])), paper: sheet }));
    return { sheets, runs: null, error: null };
  }
  let order = pick.indices;
  if (word.reverse) order = [...order].reverse();
  if (word.reverse || props) {
    const sheets = order.map((i) => ({ pages: [i], paper: paper(i) }));
    if (props) sheets.push({ props: true, pages: [], paper: p0 });
    return { sheets: o.what === 'info' ? sheets.filter((s) => s.props) : sheets, runs: null, error: null };
  }
  if (!order.length) return { sheets: [], runs: null, error: 'No page matches these settings.' };
  // Every page in order, the unprinted ones as empty sheets, so pageRanges index the document's pages.
  const want = new Set(order);
  return { sheets: pages.map((g) => ({ pages: [want.has(g.index) ? g.index : null], paper: paper(g.index) })), runs: runsOf(order), error: null };
}

/** Builds the print copy of `job` for `view` → the root element, appended to the body; root.pgScale is how much larger than its
 * paper each sheet is laid out (`pdf`: the PDF scales it back, printToPDF's scale). */
function buildCopy(view, job, { pdf = false } = {}) {
  const d = view.dom.ownerDocument;
  const root = d.createElement('div');
  root.className = 'print-root';
  const sizes = new Map();
  // Each page copy lays out at the zoom the editor's text has on the screen, in device pixels: the browser rounds borders and
  // font metrics to them, so a table laid out at another zoom came out about 2 pt shorter and the text below it moved off its
  // page ends. Print has no screen pixels, so the copy takes the screen's pixel ratio into its zoom.
  const zoom = scaleOf(view) * (d.defaultView?.devicePixelRatio || 1);
  // A copy scaled back by a transform printed three times slower (25 s for 21 pages): a PDF takes the sheets at the copies' own
  // size and scales the whole page instead (printToPDF's scale runs from 0.1 to 2). Printing keeps the transform.
  const k = pdf && zoom >= 0.5 && zoom <= 10 ? zoom : 1;
  root.pgScale = k;
  for (const s of job.sheets) {
    sizes.set(nameOf(s.paper), s.paper);
    if (s.props) {
      root.append(propertiesSheet(d, view.state, s.paper, k));
      continue;
    }
    const sheet = sheetEl(d, s.paper, k);
    for (const i of s.pages) {
      // An unprinted page stays an empty half or sheet; pageRanges skip it.
      if (i == null) sheet.append(d.createElement('div'));
      else if (job.runs?.some((r) => i >= r.from && i <= r.to) ?? true) sheet.append(pageClone(view, i, { near: true, now: true, match: zoom, scale: k }));
    }
    root.append(sheet);
  }
  const style = d.createElement('style');
  style.textContent = [PRINT_CSS, ...[...sizes].map(([name, p]) => `@page ${name} { size: ${p.w}pt ${p.h}pt; margin: 0; }`)].join('\n');
  root.append(style);
  d.body.append(root);
  return root;
}

// The copy's rules, in the page only while a job runs, so none of them reaches the app or a forum post: only the copy prints,
// one sheet per page at its paper size.
const PRINT_CSS = `@media print {
  html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; background: none !important; }
  body > :not(.print-root) { display: none !important; }
  @page { margin: 0; }
  .print-sheet { display: flex; overflow: hidden; break-after: page; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .print-sheet:last-of-type { break-after: auto; }
}
.print-root { display: none; }
@media print {
  .print-root { display: block; }
  /* A page is one unbreakable box: nothing inside starts a printed page of its own. */
  .print-root .pg-clone { flex: none; contain: strict; }
  .print-root .pg-clone * { break-before: auto !important; break-after: auto !important; break-inside: auto !important; }
  /* Inside a clone the screen's layout must stay as measured (document.css's sheet print rules skip html[data-printing]), so
     the page widgets and break rules keep their screen boxes. Column break labels are not printed but keep their line; a section
     break that starts no page has no room on the screen either (document.css). */
  .print-root .page[data-format="document"] .ProseMirror > .pg-pages { display: block; }
  .print-root .page[data-format="document"] .ProseMirror [data-column-break]:not([data-page-break]) { border-top: 1px dotted transparent; color: transparent; }
  .print-root .page[data-format="document"] .ProseMirror [data-column-break]:not([data-page-break])::after { content: "\\a0"; }
  .print-root .page[data-format="document"] .ProseMirror [data-section-break]:not([data-page-break])::after { content: none; }
  /* Editor chrome never prints: controls and menus inside the text (an equation's options arrow, a picture's handles) and the
     selection's outline are the editor's, not the page's. Each package's own print rules apply too: the copy keeps the editor
     root's attributes ([data-doc-text]). */
  .print-root .pg-clone :is(button, [role="menu"], [data-resize-handle]) { display: none !important; }
  .print-root .pg-clone .ProseMirror-selectednode { outline: none !important; }
  /* Proofing marks (proofing style.css) are the editor's too: Word prints none. */
  .print-root .pg-clone :is(.w-proof-repeat, .w-proof-current) { text-decoration: none !important; background-color: transparent !important; }
  .print-root .print-props { padding: 96px; font: 11pt/1.5 sans-serif; color: #000; }
  .print-root .print-props b { display: inline-block; min-width: 10em; font-weight: 600; }
}`;

const ATTRS = ['data-printing', 'data-print-bg', 'data-print-hidden', 'data-print-markup'];

/** Runs `fn` with the print copy of `job` in place and the print state attributes (plan.md §1.12) on <html>, then removes both. */
async function withCopy(ed, job, fn, { pdf = false } = {}) {
  const { view } = ed;
  const word = wordSettings(getState().settings).print;
  const html = view.dom.ownerDocument.documentElement;
  // Word refreshes REF, NUMPAGES, DATE and TIME at print time; each field type's updates rule decides (drawn values only).
  // Update fields before printing computes every field first, as F9 on the whole document does.
  await updateFields(ed, 'all', word.updateFields ? 'manual' : 'print').catch(() => 0);
  await pagesReady(view); // again after the fields' update; the frames lay the pages out while the window keeps answering
  await drawAll(view); // every object that waits to draw (lazy.mjs), its pictures loaded
  const root = buildCopy(view, job, { pdf });
  const on = (b) => (b ? 'on' : 'off');
  html.setAttribute('data-printing', '');
  html.setAttribute('data-print-bg', on(word.background));
  html.setAttribute('data-print-hidden', on(word.hiddenText));
  html.setAttribute('data-print-markup', on(word.markup));
  try {
    await Promise.all([...root.querySelectorAll('img')].map((img) => img.decode?.().catch(() => null)));
    return await fn(root);
  } finally {
    root.remove();
    ATTRS.forEach((a) => html.removeAttribute(a));
  }
}

const api = () => globalThis.__wordTest?.word ?? window.api.word;
const firstPaper = (job) => job.sheets.find((s) => s.props || s.pages.some((i) => i != null))?.paper ?? job.sheets[0]?.paper;

/** Prints Document editor `ed` with options `o`; `silent` sends it to the default (or chosen) printer without the system dialog
 * (Quick Print). Manual both sides prints the odd pages here; the Print page then asks for the even ones. → {ok, error}. */
export async function printDocument(ed, o = opts, { silent = false } = {}) {
  await pagesReady(ed.view); // the job picks from every page
  const job = planJob(ed.view, o);
  if (job.error) {
    toast(job.error, true);
    return { ok: false, error: job.error };
  }
  // Page Setup's 2 pages per sheet prints two half-size pages on each sheet (w:printTwoOnOne).
  const perSheet = ed.state.doc.attrs.settings?.printTwoOnOne ? 2 : o.perSheet;
  const r = await withCopy(ed, job, () => api().print(printArgs({ ...o, perSheet }, { sheet: firstPaper(job), runs: job.runs, silent })));
  if (r?.ok) draftMeta({ printed: Date.now() });
  else if (r?.error && !/cancel/i.test(r.error)) toast(`Could not print: ${r.error}`, true);
  return r ?? { ok: false, error: 'No answer from the printer' };
}

/** The PDF of Document editor `ed` with options `o` → base64. */
export async function pdfOf(ed, o = opts) {
  await pagesReady(ed.view); // the job picks from every page
  const job = planJob(ed.view, o);
  if (job.error) throw new Error(job.error);
  const d = ed.view.dom.ownerDocument;
  const title = d.title;
  d.title = getState().draft?.title || 'Document'; // the PDF's title
  try {
    return await withCopy(ed, job, (root) => api().printToPDF({
      preferCSSPageSize: true, generateDocumentOutline: true, printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 },
      scale: 1 / root.pgScale, ...(job.runs ? { pageRanges: pdfRanges(job.runs) } : {}),
    }), { pdf: true });
  } finally {
    d.title = title;
  }
}

/** Export > Create PDF/XPS: the PDF of the pages `o` picks (every page from the command), through a save dialog → the saved path or null. */
export async function exportPdf(ed, o = opts) {
  try {
    const data = await pdfOf(ed, o);
    const name = `${(getState().draft?.title || 'Document').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.pdf`;
    const path = await api().saveFile({ name, data, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (path) draftMeta({ printed: Date.now() });
    return path;
  } catch (e) {
    toast(`Could not make the PDF: ${e.message || e}`, true);
    return null;
  }
}
