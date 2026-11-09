// Find, Replace, Go To and browse on the Document (docs/plans/word/plan.md §3 find): what the dialog's buttons, the Home > Editing
// commands and the browse keys do. The search state outlives the dialog, so Shift+F4 and Ctrl+PageDown repeat the last Find or Go To.
import { closeHistory } from '@tiptap/pm/history';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { confirmDialog } from '../../../app/actions.js';
import { findClear, findText, revealRange } from '../../../find.js';
import { commandOf } from '../../../tooling/registry.js';
import { geometryOf, scaleOf } from '../../geometry.js';
import { storiesOf } from '../../model/blocks.mjs';
import { revisionsOf } from '../../model/review.mjs';
import { setUi } from '../comments/canvas.js';
import { itemsOf, parseGoTo, pick } from './goto.mjs';
import { FindError, parseReplace, searchDoc } from './query.mjs';
import { applyFormat, applyParts, partsFor, replaceAll, replaceInStories, searchStories, storyKind } from './replace.mjs';

/** The option names of the More panel, as settings.word.find names them (G2). */
export const OPTION_KEYS = ['matchCase', 'wholeWord', 'wildcards', 'soundsLike', 'allForms', 'prefix', 'suffix', 'widthForms', 'ignorePunct', 'ignoreSpace'];

/** The last Find or Go To: what the dialog shows when it opens again and what Shift+F4 and browse repeat. */
export const last = {
  kind: 'page', // 'find' or a Go To target: what browse steps through
  query: '',
  replace: '',
  search: 'down', // 'down' | 'up' | 'all'
  opts: null, // the More options; null until the dialog seeds them from settings.word.find
  format: null,
  replaceFormat: null,
  target: 'page',
  box: '',
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- canvas drafts ----------
// On a canvas draft Find and Replace and Go To run the engine's own find (cmd/edit.rs): the search box and the options it has.
// Sounds like, All word forms, the width forms and formatting as a condition have no engine form yet (stage2.md gap 36).

/** edit.find's params of the dialog's search `s`. */
const engineFind = (s) => ({
  text: s.query, matchCase: !!s.opts?.matchCase, wholeWord: !!s.opts?.wholeWord, matchPrefix: !!s.opts?.prefix, matchSuffix: !!s.opts?.suffix,
  ignorePunct: !!s.opts?.ignorePunct, ignoreSpace: !!s.opts?.ignoreSpace, wildcards: !!s.opts?.wildcards,
});
/** Why search `s` cannot run on a canvas draft, or null. */
function canvasGap(s) {
  if (!s.query) return 'Type the text to find.';
  if (s.format && Object.values(s.format).some((v) => v != null && (typeof v !== 'object' || Object.keys(v).length))) return 'Finding formatting is not built for canvas drafts yet.';
  if (['soundsLike', 'allForms', 'widthForms'].some((k) => s.opts?.[k])) return 'That search option is not built for canvas drafts yet.';
  return null;
}
/** Find In on a canvas draft, at one of the engine's places (edit.findInPlaces: the selection's ranges, the body or a kind of story):
 * the engine selects every match there, several ranges at once → the count or {error}. In comments, as Word does, it selects the
 * matches of the first comment holding any (a selection lies in one story); comments are cards beside the page on a canvas draft
 * (src/document/wp/comments/canvas.js), not laid-out text, so that thread's card opens and marks them (`found`). */
async function canvasFindIn(ctx, where, s) {
  const why = canvasGap(s);
  if (why) return { error: why };
  last.kind = 'find';
  const r = await ctx.engine.exec('edit.advancedFind', { ...engineFind(s), in: where, select: true });
  if (!r?.ok) return { error: r?.error ?? 'The search did not run.' };
  const n = r.value?.count ?? 0;
  const top = r.value?.comment;
  if (where === 'comments' && top != null) setUi({ active: top, opened: top, found: { id: r.value.inComment ?? top, matches: r.value.matches ?? [] } });
  ctx.toast(`Found ${plural(n, 'match', 'matches')}.`);
  return n;
}

/** Find Next or Previous through the engine → findNext's results. */
async function canvasFind(ctx, s, dir) {
  const why = canvasGap(s);
  if (why) return s.query ? { error: why } : { none: true };
  last.kind = 'find';
  const up = (s.search === 'up') !== (dir < 0);
  const r = await ctx.engine.exec(up ? 'edit.findPrevious' : 'edit.findNext', engineFind(s));
  return r?.ok ? { found: true } : { none: true };
}
/** Go To on a canvas draft: pages (a number, + or - a number, or the next and previous page) and bookmarks by name. */
function canvasGoTo(ctx, target, text, dir) {
  const q = parseGoTo(text, target);
  if (!q) return 'Type a number, or + or - and a number.';
  last.kind = target;
  last.target = target;
  let args = null;
  if (target === 'page') args = q.kind === 'abs' ? { page: q.n } : q.kind === 'rel' ? { pageBy: q.n } : q.kind === 'step' ? { pageBy: dir } : null;
  else if (target === 'bookmark' && q.kind === 'name') args = { bookmark: q.name };
  if (!args) return 'Going to that is not built for canvas drafts yet.';
  ctx.engine.exec('edit.goto', args);
  return true;
}

/** findMatches' opts for the current search (§1.18): the More options, Format, the display and the field codes setting. */
export function searchOpts(ctx, s = last) {
  const w = ctx.settings?.word ?? {};
  return { codes: true, ...s.opts, format: s.format, display: w.tracking?.display ?? 'all', fieldCodes: !!w.fieldCodes };
}

const sameRange = (a, b) => a.from === b.from && a.to === b.to;

/** Selects range `m` in the target editor and marks it as the current match (the other matches stay highlighted only while Reading
 * Highlight is on). */
function select(ctx, m, opts, query) {
  const ed = ctx.target;
  const { doc } = ed.state;
  const sel = m.to > m.from ? TextSelection.create(doc, m.from, Math.min(m.to, doc.content.size)) : Selection.near(doc.resolve(m.from));
  ed.view.dispatch(ed.state.tr.setSelection(sel).scrollIntoView());
  const keep = !!highlighting;
  findText(ed, query, { ...opts, highlightAll: keep, index: Math.max(0, searchDoc(ed.state.doc, query, opts).matches.findIndex((x) => sameRange(x, m))) });
}

let highlighting = false;

/** What Find Next says when a Search All run comes back to where it began. */
export const DONE = 'Finished searching the document.';
// A Search All run: where it began, whether it wrapped, and the match it selected last. Moving the selection starts a new run.
let allRun = null;

/** Find Next (dir 1) or the previous match (-1) from the selection, following Search (Down and Up ask before going on from the other
 * end; All wraps once and reports when it comes back to where it began) → {found: true} | {none: true} | {done: true} | {error} |
 * {stopped: true}. */
export async function findNext(ctx, { dir = 1, s = last } = {}) {
  if (ctx.engine) return canvasFind(ctx, s, dir);
  const ed = ctx.target;
  if (!ed || (!s.query && !s.format)) return { none: true };
  const opts = searchOpts(ctx, s);
  const { matches, error } = searchDoc(ed.state.doc, s.query, opts);
  if (error) return { error };
  last.kind = 'find';
  if (!matches.length) return { none: true };
  const up = (s.search === 'up') !== (dir < 0);
  const sel = ed.state.selection;
  const all = s.search === 'all';
  if (all && !(allRun?.m && sameRange(allRun.m, sel))) allRun = { at: up ? sel.to : sel.from, wrapped: false };
  let m = up ? matches.findLast((x) => x.to <= sel.from && !sameRange(x, sel)) : matches.find((x) => x.from >= sel.to && !sameRange(x, sel));
  if (!m) {
    if (!all) {
      const go = await confirmDialog({ title: up ? 'Search from the end?' : 'Search from the start?',
        description: up ? 'Find reached the start of the document.' : 'Find reached the end of the document.', confirmText: 'Continue' });
      if (!go) return { stopped: true };
    } else allRun.wrapped = true;
    m = up ? matches.at(-1) : matches[0];
  }
  if (all && allRun.wrapped && (up ? m.to <= allRun.at : m.from >= allRun.at)) {
    allRun = null; // the next Find Next starts a new run
    return { done: true };
  }
  if (all) allRun.m = m;
  select(ctx, m, opts, s.query);
  return { found: true };
}

/** The clipboard text for ^c, read only when Replace with holds it. */
async function clipFor(text) {
  if (!/\^c/.test(text)) return '';
  try {
    return (await (globalThis.__wordTest?.clipboard ?? window.api?.word?.clipboard)?.read?.())?.text ?? '';
  } catch {
    return '';
  }
}

/** Replace: replaces the selected match (when the selection is one), then finds the next → findNext's result or {error}. */
export async function replaceOne(ctx, s = last) {
  if (ctx.engine) {
    const why = canvasGap(s);
    if (why) return { error: why };
    const r = await ctx.engine.exec('edit.replace', { ...engineFind(s), with: s.replace ?? '' });
    if (!r?.ok) return { error: r?.error ?? 'Could not replace.' };
    last.kind = 'find';
    return r.value?.remaining ? { found: true } : { none: true };
  }
  const ed = ctx.target;
  const opts = searchOpts(ctx, s);
  const { matches, model, error } = searchDoc(ed.state.doc, s.query, opts);
  if (error) return { error };
  const m = matches.find((x) => sameRange(x, ed.state.selection));
  if (m) {
    let parts;
    try {
      parts = partsFor(model, m, parseReplace(s.replace, opts), { ...opts, query: s.query, clip: await clipFor(s.replace) });
    } catch (e) {
      if (e instanceof FindError) return { error: e.message };
      throw e;
    }
    const tr = ed.state.tr;
    const keep = !s.replace && s.replaceFormat;
    const end = keep ? m.to : applyParts(tr, m, parts);
    applyFormat(tr, { from: m.from, to: end }, s.replaceFormat);
    tr.setSelection(Selection.near(tr.doc.resolve(end)));
    ed.view.dispatch(closeHistory(tr));
  }
  return findNext(ctx, { s });
}

/** Replace All: one transaction and one undo step, the main text and every story held in attributes; inside a selection it replaces
 * there first and asks about the rest; Down or Up started mid-document asks before the part behind the caret → the count or
 * {error}. Reports the count. */
export async function replaceEvery(ctx, s = last) {
  if (ctx.engine) {
    const why = canvasGap(s);
    if (why) return { error: why };
    // The engine replaces every match of the story the caret is in, as one undo step.
    const r = await ctx.engine.exec('edit.replaceAll', { ...engineFind(s), with: s.replace ?? '' });
    if (!r?.ok) return { error: r?.error ?? 'Could not replace.' };
    const total = r.value?.replaced ?? 0;
    last.kind = 'find';
    ctx.toast(total ? `Replaced ${plural(total, 'match', 'matches')}.` : 'Nothing to replace.');
    return total;
  }
  const ed = ctx.target;
  const opts = { ...searchOpts(ctx, s), clip: await clipFor(s.replace), replaceFormat: s.replaceFormat };
  const sel = ed.state.selection;
  const inSel = !sel.empty && !searchDoc(ed.state.doc, s.query, opts).matches.some((m) => sameRange(m, sel));
  const KINDS = new Set(['headers', 'footnotes', 'endnotes', 'comments']);
  const all = (tr, within) => replaceAll(tr, s.query, s.replace, { ...opts, within });
  const stories = (tr) => replaceInStories(tr, s.query, s.replace, opts, KINDS);
  // One transaction per part, one undo step each; a later range first, so the earlier positions stay.
  const step = (fn) => {
    const tr = ed.state.tr;
    const n = fn(tr);
    if (n) ed.view.dispatch(closeHistory(tr));
    return [n, tr.mapping];
  };
  const ask = (title, n) => confirmDialog({ title, description: `${plural(n, 'replacement')} so far.`, confirmText: 'Continue' });
  let total = 0;
  try {
    if (inSel) {
      const [n, map] = step((tr) => all(tr, { from: sel.from, to: sel.to }));
      total += n;
      if (await ask('Replace in the rest of the document too?', total)) {
        const a = map.map(sel.from, -1);
        const b = map.map(sel.to, 1);
        total += step((tr) => all(tr, { from: b, to: tr.doc.content.size }) + all(tr, { from: 0, to: a }) + stories(tr))[0];
      }
    } else if (s.search === 'all' || sel.from <= Selection.atStart(ed.state.doc).from) {
      total += step((tr) => all(tr) + stories(tr))[0];
    } else {
      const down = s.search !== 'up';
      const [n, map] = step((tr) => (down ? all(tr, { from: sel.from, to: tr.doc.content.size }) : all(tr, { from: 0, to: sel.from })));
      total += n;
      if (await ask(down ? 'Go on from the start of the document?' : 'Go on from the end of the document?', total)) {
        const p = map.map(sel.from);
        total += step((tr) => (down ? all(tr, { from: 0, to: p }) : all(tr, { from: p, to: tr.doc.content.size })) + stories(tr))[0];
      }
    }
  } catch (e) {
    if (e instanceof FindError) return { error: e.message };
    throw e;
  }
  last.kind = 'find';
  ctx.toast(total ? `Replaced ${plural(total, 'match', 'matches')}.` : 'Nothing to replace.');
  return total;
}

/** Reading Highlight > Highlight All → the count. */
export function highlightAll(ctx, s = last) {
  if (ctx.engine) {
    const why = canvasGap(s);
    if (why) return { error: why };
    highlighting = true;
    return ctx.engine.exec('edit.advancedFind', { ...engineFind(s), highlight: true }).then((r) => {
      const n = r?.value?.count ?? 0;
      ctx.toast(n ? `Highlighted ${plural(n, 'match', 'matches')}.` : 'No matches to highlight.');
      return n;
    });
  }
  const ed = ctx.target;
  const opts = searchOpts(ctx, s);
  const { matches, error } = searchDoc(ed.state.doc, s.query, opts);
  if (error) return { error };
  highlighting = true;
  findText(ed, s.query, { ...opts, highlightAll: true });
  ctx.toast(matches.length ? `Highlighted ${plural(matches.length, 'match', 'matches')}.` : 'No matches to highlight.');
  return matches.length;
}

/** Reading Highlight > Clear Highlighting. */
export function clearHighlight(ctx) {
  highlighting = false;
  if (ctx.engine) ctx.engine.exec('edit.advancedFind', { highlight: false });
  if (ctx.target) findClear(ctx.target);
}

/** The dialog closed: clears the find state unless Reading Highlight is on (Shift+F4 and browse read `last`, not the find state). */
export function endSearch(ctx) {
  if (!highlighting && ctx?.target) findClear(ctx.target);
}

/** Selects every range in `ranges` (x.selection.multi while editing-keys has it; until then every range is highlighted and the
 * first selected). */
export function selectAll(ctx, ranges, query, opts) {
  if (!ranges.length) return;
  if (commandOf('x.selection.multi')) {
    ctx.run('x.selection.multi', ranges.map(({ from, to }) => ({ from, to })));
    return;
  }
  findText(ctx.target, query, { ...opts, highlightAll: true, index: 0 });
  ctx.target.view.dispatch(ctx.target.state.tr.setSelection(TextSelection.create(ctx.target.state.doc, ranges[0].from, ranges[0].to)));
}

const REVEAL = { header: 'x.reveal.header', footer: 'x.reveal.footer', note: 'x.reveal.note', comment: 'x.reveal.comment' };

/** Find In: 'selection' or 'main' selects every match there; a story kind ('headers', 'footnotes', 'endnotes', 'comments') counts
 * its matches and opens the first through x.reveal.* when its owner registered it → the count or {error}. */
export function findIn(ctx, where, s = last) {
  if (ctx.engine) return canvasFindIn(ctx, where, s);
  const ed = ctx.target;
  const opts = searchOpts(ctx, s);
  last.kind = 'find';
  if (where === 'main' || where === 'selection') {
    const sel = ed.state.selection;
    const { matches, error } = searchDoc(ed.state.doc, s.query, where === 'selection' ? { ...opts, within: { from: sel.from, to: sel.to } } : opts);
    if (error) return { error };
    selectAll(ctx, matches, s.query, opts);
    ctx.toast(`Found ${plural(matches.length, 'match', 'matches')}.`);
    return matches.length;
  }
  const hits = searchStories(ed.state.doc, s.query, opts, new Set([where]));
  const n = hits.reduce((a, h) => a + h.count, 0);
  const first = hits[0];
  const id = first && REVEAL[first.at.story];
  if (id && commandOf(id)) ctx.run(id, { ...first.at, ...first.first });
  ctx.toast(`Found ${plural(n, 'match', 'matches')}.`);
  return n;
}

/** The kinds of story present in the doc, for Find In. */
export const storiesPresent = (doc) => new Set(storiesOf(doc).map((x) => storyKind(doc, x)));

// ---------- Go To ----------

/** The page boxes of the main editor's geometry, or []. */
const pagesOf = (ed) => geometryOf(ed.state)?.pages ?? [];

/** The position at the top of page `page`'s text: posAtCoords at its body top once the page is scrolled into view, else its
 * first block. */
function pageTop(ed, page) {
  const { view } = ed;
  const scale = scaleOf(view);
  const area = view.dom.closest('[data-viewport]');
  const y = () => view.dom.getBoundingClientRect().top + page.bodyTop * scale + 4;
  if (area) area.scrollTop += y() - area.getBoundingClientRect().top - 24;
  const r = view.dom.getBoundingClientRect();
  const hit = view.posAtCoords({ left: r.left + r.width / 2, top: y() });
  const g = geometryOf(ed.state);
  if (hit && g?.pageOf(hit.pos) === page.index) return hit.pos;
  return Math.min(page.from + 1, ed.state.doc.content.size);
}

/** The start positions of the rendered lines of `ed` from the top. ponytail: walks every position through coordsAtPos, fine for
 * documents of a few hundred pages; a line map from the page engine would be cheaper. */
function linesOf(ed) {
  const out = [];
  let top = null;
  ed.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    for (let p = pos + 1; p <= pos + 1 + node.content.size; p++) {
      let c;
      try {
        c = ed.view.coordsAtPos(p, 1);
      } catch {
        continue;
      }
      if (top === null || Math.abs(c.top - top) > 2) out.push({ from: p });
      top = c.top;
    }
    return false;
  });
  return out;
}

/** The items a Go To or browse target steps through → [{from, to}]. */
function itemsFor(ed, target) {
  if (target === 'line') return linesOf(ed);
  if (target === 'edits') return revisionsOf(ed.state.doc).filter((r) => !r.at).map((r) => ({ from: r.from, to: r.to }));
  return itemsOf(ed.state.doc, target);
}

/** Go To: target `target`, box text `text`, `dir` 1 (Next, Go To) or -1 (Previous) → true when it moved, else a message. */
export function goTo(ctx, target, text = '', dir = 1) {
  if (ctx.engine) return canvasGoTo(ctx, target, text, dir);
  const ed = ctx.ed ?? ctx.target;
  if (!ed) return 'No document is open.';
  const q = parseGoTo(text, target);
  if (!q) return 'Type a number, or + or - and a number.';
  last.kind = target;
  last.target = target;
  const { doc, selection } = ed.state;
  let pos;
  if (target === 'page') {
    const pages = pagesOf(ed);
    const g = geometryOf(ed.state);
    const cur = g ? g.pageOf(selection.from) : 0;
    let page;
    if (q.kind === 'page') page = pages.filter((p) => q.section == null || p.section === q.section - 1)[q.page - 1];
    else if (q.kind === 'abs') page = pages[q.n - 1];
    else if (q.kind === 'rel') page = pages[cur + q.n];
    else if (q.kind === 'step') page = pages[cur + dir];
    if (!page) return pages.length ? 'That page is not in the document.' : 'Pages show in Print Layout.';
    pos = pageTop(ed, page);
  } else {
    const items = itemsFor(ed, target);
    const i = pick(items, q, selection.from, dir);
    if (i < 0) return items.length ? 'There is no such item.' : 'The document has none of these.';
    const it = items[i];
    const node = doc.nodeAt(it.from);
    pos = node?.isBlock ? it.from + 1 : it.from;
  }
  const sel = Selection.near(doc.resolve(Math.min(pos, doc.content.size)));
  ed.view.dispatch(ed.state.tr.setSelection(sel));
  revealRange(ed, { from: sel.from, to: sel.to });
  return true;
}

/** Browse Next (dir 1) and Browse Prev (-1): the next item of the last Find or Go To kind, Page by default. */
export function browse(ctx, dir) {
  if (last.kind === 'find') return findNext(ctx, { dir });
  const r = goTo(ctx, last.kind, '', dir);
  if (r !== true) ctx.toast(r);
  return r === true;
}
