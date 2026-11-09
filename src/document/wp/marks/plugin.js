// Formatting marks in the editor (docs/plans/word/briefs/marks.md): decorations for what CSS cannot reach (space dots, ¶, ↵,
// break labels), built only for the kinds shown and only near the visible part of a long Document, so a keypress costs little
// with marks on. Every glyph is absolutely positioned (style.css), so no line wraps differently and pagination is unchanged.
// The kinds come from the Word settings in the store; crop marks and text boundaries are flagged on the editor root for the
// page layer's CSS. Hidden session editors (never connected) get no decorations.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getState, subscribe } from '../../../app/store.js';
import { wordSettings } from '../../word/settings.mjs';
import { GLYPH, breakLabel, charsIn, kindsOf, paraGlyph } from './kinds.mjs';

export const marksKey = new PluginKey('wordMarks');

// Below this size the whole document is decorated: no visible-range work at all. ponytail: a fixed size, not a measure of cost.
const WHOLE = 20000;

const CELLS = new Set(['tableCell', 'tableHeader']);
// The kinds drawn by decorations; the rest are CSS only.
const DRAWN = ['paragraphs', 'all', 'spaces', 'optionalHyphens'];

/** The settings this plugin follows, from the store: {shown: Set of kinds, crop, bounds, sig}. */
function current() {
  const w = wordSettings(getState().settings);
  const shown = new Set(kindsOf(w));
  return { shown, crop: !!w.cropMarks, bounds: !!w.textBoundaries, sig: `${[...shown].join(' ')}|${w.cropMarks}|${w.textBoundaries}` };
}

const glyphWidget = (glyph, cls) => (view) => {
  const s = view.dom.ownerDocument.createElement('span');
  s.className = `wm ${cls}`;
  s.contentEditable = 'false';
  s.textContent = glyph;
  return s;
};

/** The decorations for `doc` inside `range` ({from, to}) for the kinds in `shown`. */
export function build(doc, range, shown) {
  if (!range || !shown.size) return DecorationSet.empty;
  if (!DRAWN.some((k) => shown.has(k))) return DecorationSet.empty;
  const para = shown.has('paragraphs');
  const all = shown.has('all');
  const chars = shown.has('spaces') || shown.has('optionalHyphens');
  const from = Math.max(0, range.from);
  const to = Math.min(doc.content.size, range.to);
  const decos = [];
  doc.nodesBetween(from, to, (node, pos, parent, index) => {
    if (node.isText) {
      if (chars) for (const c of charsIn(node.text, pos, from, to, shown)) decos.push(Decoration.inline(c.pos, c.pos + 1, { class: `wm-ch wm-${c.glyph}` }));
      return false;
    }
    const name = node.type.name;
    if (name === 'hardBreak') {
      if (para) decos.push(Decoration.widget(pos, glyphWidget(GLYPH.lineBreak, 'wm-br'), { side: -1, key: 'wm-br', ignoreSelection: true }));
      return false;
    }
    if (node.isTextblock) {
      if (para) {
        const cellEnd = CELLS.has(parent?.type.name) && index === parent.childCount - 1;
        const glyph = paraGlyph({ rtl: node.attrs.bidi === true, cellEnd });
        const cls = `wm-pm${cellEnd ? ' wm-cell' : ''}${node.attrs.specVanish ? ' wm-sep' : ''}${node.content.size ? '' : ' wm-empty'}`;
        decos.push(Decoration.widget(pos + node.nodeSize - 1, glyphWidget(glyph, cls), { side: 1, key: `${cls}:${glyph}`, ignoreSelection: true }));
      }
      return true;
    }
    const label = all && breakLabel(name, node.attrs);
    if (label) decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-wm-label': label }));
    return true;
  });
  return DecorationSet.create(doc, decos);
}

/** `decos` after the doc change `tr`: mapped, with the top-level blocks the change touched rebuilt (inside `range`), so a
 * keypress redraws one paragraph's marks rather than the whole range's. */
function patch(decos, tr, range, shown) {
  const doc = tr.doc;
  let from = Infinity;
  let to = -Infinity;
  tr.mapping.maps.forEach((map, i) => map.forEach((_s, _e, start, end) => {
    const rest = tr.mapping.slice(i + 1);
    from = Math.min(from, rest.map(start, -1));
    to = Math.max(to, rest.map(end, 1));
  }));
  const mapped = decos.map(tr.mapping, doc);
  if (!range || from > to) return mapped;
  const $a = doc.resolve(Math.max(0, Math.min(from, doc.content.size)));
  const $b = doc.resolve(Math.max(0, Math.min(to, doc.content.size)));
  const a = Math.max(range.from, $a.depth ? $a.before(1) : $a.pos);
  const b = Math.min(range.to, $b.depth ? $b.after(1) : $b.pos);
  if (a >= b) return mapped;
  const stale = mapped.find(a, b).filter((d) => d.from >= a && d.to <= b);
  return mapped.remove(stale).add(doc, build(doc, { from: a, to: b }, shown).find());
}

/** The document range the viewport of `view` shows, widened by its own length on each side → {from, to}, or null when the
 * editor is out of view. posAtCoords needs on-screen points, hence the widening in positions rather than pixels. */
function visibleRange(view) {
  const area = view.dom.closest('[data-viewport]');
  const r = area ? area.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const d = view.dom.getBoundingClientRect();
  const top = Math.max(r.top, d.top) + 2;
  const bottom = Math.min(r.bottom, d.bottom) - 2;
  if (bottom <= top) return null;
  const x = d.left + d.width / 2;
  const a = view.posAtCoords({ left: x, top })?.pos ?? 0;
  const b = view.posAtCoords({ left: x, top: bottom })?.pos ?? view.state.doc.content.size;
  const span = Math.max(b - a, 2000);
  return { from: Math.max(0, a - span), to: Math.min(view.state.doc.content.size, b + span), seen: [a, b] };
}

export const WordMarks = Extension.create({
  name: 'wordMarks',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: marksKey,
      state: {
        init: (_, state) => ({ ...current(), range: null, decos: DecorationSet.empty, size: state.doc.content.size }),
        apply(tr, v, _old, state) {
          const meta = tr.getMeta(marksKey);
          if (!meta && !tr.docChanged) return v;
          const next = { ...v, ...meta, size: state.doc.content.size };
          if (!meta?.range && next.range) {
            next.range = next.range.whole ? { from: 0, to: next.size, whole: true }
              : { from: tr.mapping.map(next.range.from, -1), to: tr.mapping.map(next.range.to, 1) };
          }
          next.decos = meta ? build(state.doc, next.range, next.shown) : patch(v.decos, tr, next.range, next.shown);
          return next;
        },
      },
      props: {
        decorations: (state) => marksKey.getState(state).decos,
        attributes: (state) => {
          const s = marksKey.getState(state);
          return { ...(s.crop && { 'data-wm-crop': '' }), ...(s.bounds && { 'data-wm-bounds': '' }) };
        },
      },
      view(view) {
        let frame = 0;
        let timer = 0;
        const win = view.dom.ownerDocument.defaultView;
        // Sets the range when the shown part leaves it (or the whole document while it is short); no transaction otherwise.
        const check = (force) => {
          frame = 0;
          if (view.isDestroyed || !view.dom.isConnected) return;
          const s = marksKey.getState(view.state);
          if (!DRAWN.some((k) => s.shown.has(k))) return;
          const size = view.state.doc.content.size;
          if (size <= WHOLE) {
            if (force || !s.range?.whole) view.dispatch(view.state.tr.setMeta(marksKey, { range: { from: 0, to: size, whole: true } }));
            return;
          }
          const seen = visibleRange(view);
          if (!seen) return;
          if (!force && s.range && !s.range.whole && seen.seen[0] >= s.range.from && seen.seen[1] <= s.range.to) return;
          view.dispatch(view.state.tr.setMeta(marksKey, { range: { from: seen.from, to: seen.to } }));
        };
        const soon = () => {
          if (!frame) frame = win.requestAnimationFrame(() => check(false));
        };
        const area = () => view.dom.closest('[data-viewport]');
        let scroller = null;
        const watch = () => {
          const a = area();
          if (a === scroller) return;
          scroller?.removeEventListener('scroll', soon);
          scroller = a;
          scroller?.addEventListener('scroll', soon, { passive: true });
        };
        let sig = marksKey.getState(view.state).sig;
        const unsub = subscribe(() => {
          const now = current();
          if (now.sig === sig || view.isDestroyed) return;
          sig = now.sig;
          view.dispatch(view.state.tr.setMeta(marksKey, now));
          check(true);
        });
        win.addEventListener('resize', soon);
        win.requestAnimationFrame(() => {
          watch();
          check(true);
        });
        return {
          update(v, prev) {
            if (v.state.doc === prev.doc) return;
            watch();
            // After typing settles, so the visible-range read never sits in a keypress's frame.
            win.clearTimeout(timer);
            timer = win.setTimeout(soon, 150);
          },
          destroy() {
            unsub();
            win.cancelAnimationFrame(frame);
            win.clearTimeout(timer);
            win.removeEventListener('resize', soon);
            scroller?.removeEventListener('scroll', soon);
          },
        };
      },
    })];
  },
});
