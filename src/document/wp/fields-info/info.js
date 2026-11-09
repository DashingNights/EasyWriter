// What the Info panel and the Advanced Properties dialog show: the properties the user typed (doc.attrs.props), the draft record's
// statistics (plan.md §1.12 Draft record) and the Word Count numbers. Writes go to doc.attrs.props as one setDocAttribute step.
import { closeHistory } from '@tiptap/pm/history';
import { getState } from '../../../app/store.js';
import { deepPatch } from '../../../office.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { geometryOf } from '../../geometry.js';
import { dateText, statsOf } from './fields.mjs';

/** Bytes of the open draft's saved JSON (the record as last written: the save path keeps its doc). */
export function savedBytes() {
  const d = getState().draft;
  return d ? new TextEncoder().encode(JSON.stringify(d)).length : 0;
}

/** The main view's line count: distinct line boxes of each textblock while the view is on screen, else null (left blank). */
export function linesOf(ed) {
  const dom = ed?.view?.dom;
  if (!dom?.isConnected) return null;
  let n = 0;
  const range = document.createRange();
  ed.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const el = ed.view.nodeDOM(pos);
    if (el?.nodeType === 1) {
      range.selectNodeContents(el);
      const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.bottom)));
      n += Math.max(1, tops.size);
    }
    return false;
  });
  return n;
}

/** The project a draft is filed under (its thread's title), for FILENAME \p and the General tab. */
export function projectOf() {
  const s = getState();
  return s.settings?.threads?.find((t) => t.url === s.draft?.threadUrl)?.title ?? '';
}

/** Everything the panel and the dialog show for main editor `ed`. */
export function docInfo(ed) {
  const s = getState();
  const d = s.draft ?? {};
  const doc = ed.state.doc;
  const lang = doc.attrs.styles?.defaults?.run?.lang?.val ?? 'en-US';
  const headings = [];
  doc.descendants((n) => {
    if (n.type.name === 'heading') headings.push({ level: n.attrs.level, text: n.textContent });
    return !n.isTextblock;
  });
  return {
    props: doc.attrs.props ?? {},
    title: d.title ?? '',
    project: projectOf(),
    created: d.created ?? null,
    saved: d.updated ?? null,
    printed: d.printed ?? null,
    savedBy: d.savedBy ?? '',
    revision: d.revision ?? 0,
    editMinutes: Math.floor(d.editMinutes ?? 0),
    bytes: savedBytes(),
    pages: geometryOf(ed.state)?.pages?.length || 1,
    lines: linesOf(ed),
    ...statsOf(doc),
    headings,
    user: wordSettings(s.settings).user?.name ?? '',
    lang,
    date: (v) => dateText(v, lang),
  };
}

/** Writes `next` (the whole props object, or a patch with `patch: true`) to main editor `ed`'s doc.attrs.props in one undo step. */
export function writeProps(ed, next, { patch = false } = {}) {
  if (!ed) return false;
  const old = ed.state.doc.attrs.props ?? {};
  const value = patch ? deepPatch(old, next) : next;
  if (JSON.stringify(value) === JSON.stringify(old)) return true;
  ed.view.dispatch(closeHistory(ed.state.tr.setDocAttribute('props', value)));
  return true;
}

/** "13.1 KB (13,418 bytes)", as Windows file properties show a size. */
export function sizeText(bytes, lang = 'en-US') {
  const n = (v, d = 0) => v.toLocaleString(lang, { maximumFractionDigits: d });
  if (bytes < 1024) return `${n(bytes)} bytes`;
  return `${n(bytes / 1024, 1)} KB (${n(bytes)} bytes)`;
}
