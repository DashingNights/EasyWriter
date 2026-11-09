// Editing a header or footer (docs/plans/word/plan.md §3 headers-footers, §1.7 story editors): the part opens in a story sub-editor
// placed over its page in the page overlay, with the dashed line and tab label Word draws, while the body is dimmed (the plugin's
// data-hf-editing). Each edit batch is written back into the section that holds the part, in one main-editor transaction. Every
// write of this package goes through change() or writePart, which first converts v1 page numbers (sect.pageNumber) into footer or
// header parts in the same transaction, so the conversion is part of the user's own undo step and opening a v1 Document changes
// nothing.
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { getState } from '../../../app/store.js';
import { defaultSect } from '../../defaults.mjs';
import { geometryOf, overlayOf, scaleOf } from '../../geometry.js';
import { sectionsOf } from '../../model/sections.mjs';
import { ensureStyles } from '../../model/styles.mjs';
import { mountStory, writeBack } from '../../word/story.js';
import { pageFrom } from '../float-layout/place.mjs';
import { setStoryPage } from '../float-layout/plugin.js';
import {
  drawnSect, EDGE, HF_STYLES, isLinked, labelOf, partOf, PLACEHOLDER, resolvePart, setPageNumberPart, STYLE, writeTarget,
} from './model.mjs';

/** The plugin state on the main editor: {edit: null | {kind, page, section, part}, showBody, rev}. Layers key on it. */
export const hfKey = new PluginKey('headersFooters');

const drawn = new WeakMap();
/** The sects of `doc` in section order as its pages draw them (a v1 page number shown as a part), memoised per doc. */
export function drawnSects(doc) {
  let out = drawn.get(doc);
  if (!out) drawn.set(doc, (out = sectionsOf(doc).map((s) => drawnSect(s.sect))));
  return out;
}

/** The stored sects of `doc` (defaults filled), in section order. */
export const sectsOf = (doc) => sectionsOf(doc).map((s) => s.sect);

/** Replaces section `index`'s sect in `tr` with `fn(old)`, the stored object (unknown keys kept), when that changes anything.
 * The schema's setSectionProps does not fit: it deep-merges a patch, and these writes delete keys (Link to Previous on drops a
 * part, the v1 conversion clears pageNumber) inside a transaction change() composes. */
export function writeSect(tr, index, fn) {
  const sec = sectionsOf(tr.doc)[index];
  if (!sec) return;
  const old = sec.holder != null ? tr.doc.nodeAt(sec.holder).attrs.sect ?? sec.sect : tr.doc.attrs.sect ?? defaultSect(getState().settings?.paper);
  const next = fn(old);
  if (JSON.stringify(next) === JSON.stringify(old)) return;
  if (sec.holder != null) tr.setNodeAttribute(sec.holder, 'sect', next);
  else tr.setDocAttribute('sect', next);
}

/** Converts every v1 sect.pageNumber of `tr`'s doc into its footer or header part (plan.md §1.10: inside the user's first edit).
 * Only the first section keeps the v1 start, as geometry applies it: a section break's cloned sect must not restart there. */
export function convertV1(tr) {
  sectionsOf(tr.doc).forEach((s, i) => {
    if (!s.sect.pageNumber) return;
    writeSect(tr, i, (old) => {
      const { start, ...rest } = old.pageNumber;
      return setPageNumberPart(old, i === 0 && start != null ? old.pageNumber : rest);
    });
  });
}

/** Brings the Header and Footer styles into `tr`'s doc when it lacks them (ensureStyles on first use). */
export function useStyles(tr) {
  const styles = ensureStyles(tr.doc, HF_STYLES);
  if (styles) tr.setDocAttribute('styles', styles);
}

/** One undo step on main editor `ed`: v1 page numbers converted, then `fn(tr)`. → whether the doc changed. */
export function change(ed, fn) {
  const tr = closeHistory(ed.state.tr);
  convertV1(tr);
  fn(tr);
  if (!tr.docChanged) return false;
  ed.view.dispatch(tr.setMeta(hfKey, { rev: (hfKey.getState(ed.state)?.rev ?? 0) + 1 }));
  return true;
}

/** Writes `content` as `edge`'s `part` for section `section`'s pages: into the section holding the part, else the first. */
export function putPart(tr, section, edge, part, content) {
  const target = writeTarget(sectsOf(tr.doc), section, edge, part);
  writeSect(tr, target, (old) => ({ ...old, [edge]: { ...(old[edge] ?? {}), [part]: content } }));
  useStyles(tr);
}

// ---------------------------------------------------------------------------------------------
// The session

let session = null;

/** The open header or footer session → {ed, kind, edge, part, section, page, story} | null. */
export const sessionOf = () => (session && !session.ed.isDestroyed ? session : null);

/** The page `ed`'s header and footer commands act on: the one being edited, else the caret's. */
export function currentPage(ed) {
  const s = sessionOf();
  if (s?.ed === ed) return s.page;
  const geo = geometryOf(ed.state);
  return geo ? geo.pageOf(ed.state.selection.from) : 0;
}

/** The section `ed`'s commands act on: the one being edited, else the caret's. */
export const currentSection = (ed) => sessionOf()?.ed === ed ? sessionOf().section : geometryOf(ed.state)?.pages[currentPage(ed)]?.section ?? 0;

const meta = (ed, patch) => ed.view.dispatch(ed.state.tr.setMeta(hfKey, patch).setMeta('addToHistory', false));

const el = (d, cls, css) => Object.assign(d.createElement('div'), { className: cls, style: css ?? '' });

/** Opens `kind` ('header' or 'footer') of page `page` (default: the current page) of main editor `ed` for editing. `select`: text
 * to select in it, or {from, to} positions (x.reveal.header). → whether it opened. */
export function openStory(ed, { kind = 'header', page: index, select } = {}) {
  if (!ed || ed.isDestroyed) return false;
  const at = index ?? currentPage(ed);
  closeStory({ focus: false });
  const page = geometryOf(ed.state)?.pages[at];
  const overlay = page && overlayOf(ed.view);
  if (!overlay) return false;
  const edge = EDGE[kind];
  const part = partOf(page.part);
  const { content } = resolvePart(drawnSects(ed.state.doc), page.section, edge, part);
  const { box } = page;
  const d = ed.view.dom.ownerDocument;

  // The paper of the page, then the part's frame at the header or footer distance; the frame reaches at least the margin, where
  // Word draws the dashed line.
  const wrap = el(d, 'hf-edit', `position:absolute;left:${-box.left}px;top:${page.top}px;width:${box.w}px;height:${box.h}px;pointer-events:none`);
  wrap.dataset.hfEdit = kind;
  const frame = wrap.appendChild(el(d, 'hf-frame', `position:absolute;left:${box.left}px;width:${box.text}px;pointer-events:auto;`
    + (kind === 'header' ? `top:${box.header}px;min-height:${Math.max(0, box.top - box.header)}px` : `bottom:${box.footer}px;min-height:${Math.max(0, box.bottom - box.footer)}px`)));
  frame.dataset.hfFrame = kind;
  const host = frame.appendChild(el(d, 'hf-host'));
  const label = frame.appendChild(el(d, 'hf-label'));
  const tab = label.appendChild(d.createElement('span'));
  tab.className = 'hf-tab';
  const same = label.appendChild(d.createElement('span'));
  same.className = 'hf-same';
  overlay.append(wrap);

  const s = { ed, kind, edge, part, section: page.section, page: page.index, wrap, story: null };
  const refresh = () => {
    if (ed.isDestroyed) return;
    const doc = ed.state.doc;
    const l = labelOf({ kind, part, evenAndOdd: !!doc.attrs.settings?.evenAndOddHeaders, section: s.section, sections: sectionsOf(doc).length,
      linked: isLinked(drawnSects(doc), s.section, edge, part) });
    tab.textContent = l.text;
    same.textContent = l.right;
  };
  s.refresh = refresh;
  refresh();
  ed.on('transaction', refresh);

  s.story = mountStory({
    kind,
    host,
    content: content?.length ? content : [{ type: 'paragraph', attrs: { styleId: STYLE[edge] } }],
    // One main transaction per edit batch: the shared attributes the story changed, then the part.
    onChange: ({ content: blocks, attrs }) => {
      if (ed.isDestroyed) return;
      writeBack(ed, attrs, (tr) => {
        convertV1(tr);
        putPart(tr, s.section, edge, part, blocks);
      });
    },
    onExit: () => closeStory(),
  });
  // The part's pictures, text boxes and canvases go where the layer puts them on the paper (float-layout places them on this
  // page): y 0 is the story's top on the paper, read on each measure, since a footer grows upward as it is typed in.
  const sv = s.story.editor.view;
  setStoryPage(sv, () => pageFrom(geometryOf(ed.state)?.pages[s.page] ?? page,
    (sv.dom.getBoundingClientRect().top - wrap.getBoundingClientRect().top) / scaleOf(sv)));
  session = s;
  meta(ed, { edit: { kind, page: s.page, section: s.section, part } });
  const sub = s.story.editor;
  s.story.focus();
  const range = typeof select === 'string' ? findText(sub.state.doc, select) : select;
  if (range) sub.commands.setTextSelection(range);
  else if (select === undefined) {
    const hit = findText(sub.state.doc, PLACEHOLDER);
    if (hit) sub.commands.setTextSelection(hit);
  }
  return true;
}

/** The first match of `text` inside one textblock of `doc` → {from, to} or null. */
function findText(doc, text) {
  let hit = null;
  doc.descendants((node, pos) => {
    if (hit) return false;
    if (!node.isText) return true;
    const i = node.text.indexOf(text);
    if (i >= 0) hit = { from: pos + i, to: pos + i + text.length };
    return false;
  });
  return hit;
}

/** Closes the open session: its last batch is written back, the body is no longer dimmed and, with `focus`, main takes the focus. */
export function closeStory({ focus = true } = {}) {
  const s = session;
  if (!s) return false;
  session = null;
  s.ed.off('transaction', s.refresh);
  s.story?.destroy();
  s.wrap.remove();
  if (!s.ed.isDestroyed) {
    meta(s.ed, { edit: null });
    if (focus) s.ed.view.focus();
  }
  return true;
}

/** Closes the session and opens it again on the same page once pagination has laid the change out (a part, a position or the
 * first page option changed which part or place the page has). */
export function reopen(ed) {
  const s = sessionOf();
  if (!s || s.ed !== ed) return;
  const before = geometryOf(ed.state);
  closeStory({ focus: false });
  // Pagination publishes a new geometry in its own frame; wait for it (at most 30 frames), so the page's part is the new one.
  let left = 30;
  const tick = () => {
    if (ed.isDestroyed) return;
    if (geometryOf(ed.state) === before && --left > 0) requestAnimationFrame(tick);
    else openStory(ed, { kind: s.kind, page: s.page, select: null });
  };
  requestAnimationFrame(tick);
}

/** The main editor plugin: the session's state for the page layer and the dimmed body; a click on the dimmed body does nothing and
 * a double-click leaves the header (Word's). */
export const HeadersFootersPlugin = Extension.create({
  name: 'headersFooters',
  addProseMirrorPlugins() {
    const mine = (view) => sessionOf()?.ed.view === view;
    return [new Plugin({
      key: hfKey,
      state: {
        init: () => ({ edit: null, showBody: true, rev: 0 }),
        apply: (tr, value) => {
          const m = tr.getMeta(hfKey);
          return m ? { ...value, ...m } : value;
        },
      },
      props: {
        attributes: (state) => {
          const s = hfKey.getState(state);
          return s?.edit ? { 'data-hf-editing': s.showBody ? 'dim' : 'hide' } : {};
        },
        handleDOMEvents: {
          mousedown: (view, e) => {
            if (!mine(view)) return false;
            e.preventDefault();
            return true;
          },
          dblclick: (view, e) => {
            if (!mine(view)) return false;
            e.preventDefault();
            closeStory();
            return true;
          },
        },
      },
    })];
  },
});
