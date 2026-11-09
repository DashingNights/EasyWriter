// fields-ref's editor behaviour (docs/plans/word/briefs/fields-ref.md): bookmark markers that cost no key press, that leave with
// their text and that a paste does not duplicate; point bookmarks for Show bookmarks; Ctrl+click on links and on hyperlinked
// fields; a link's ScreenTip; one click selecting a MACROBUTTON. Runs in every editor of the Document kit, the assistant's hidden
// session editors and story sub-editors included, so DOM work checks that the view is connected.
import { Extension } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Mapping } from '@tiptap/pm/transform';
import { isMac } from '../../../app/keys.mjs';
import { getState, subscribe } from '../../../app/store.js';
import { parseField } from '../../fields/registry.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { bookmarksOf } from './bookmarks.mjs';
import { fieldsRefKey, follow, selectField, stackState } from './edit.js';
import { hyperlinkOf } from './refs.mjs';

const isMark = (node) => node?.type.name === 'bookmark';

// ---------- keys: bookmark markers never cost a key press ----------
// From `pos`, the position past the run of bookmark markers in direction `dir`.
function past(doc, pos, dir) {
  let p = pos;
  for (;;) {
    const $p = doc.resolve(p);
    const n = dir > 0 ? $p.nodeAfter : $p.nodeBefore;
    if (!isMark(n)) return p;
    p += dir;
  }
}

// The UTF-16 length of the character at the `dir` edge of `text`: 2 for a surrogate pair (an emoji), else 1. ponytail: a
// combined emoji (ZWJ sequence, skin tone) still takes one press per code point; a grapheme segmenter would cover it.
const charLen = (text, dir) => {
  const c = text.charCodeAt(dir > 0 ? 0 : text.length - 1);
  return text.length > 1 && c >= 0xd800 && c <= 0xdfff ? 2 : 1;
};

/** Arrow keys, Backspace and Delete next to bookmark markers: step over the markers as if they were not there. */
function stepKey(view, e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const dir = { ArrowLeft: -1, ArrowRight: 1, Backspace: -1, Delete: 1 }[e.key];
  if (!dir) return false;
  const { state } = view;
  const sel = state.selection;
  const arrow = e.key.startsWith('Arrow');
  if (!sel.empty && !(arrow && e.shiftKey)) return false;
  const head = sel.head;
  const skip = past(state.doc, head, dir);
  if (skip === head) return false;
  const $s = state.doc.resolve(skip);
  const char = dir > 0 ? $s.nodeAfter : $s.nodeBefore;
  if (!char?.isText || !arrow) {
    // Backspace and Delete, a block edge or another inline node: move over the markers and let the editor do the rest of the key,
    // so its own deletion runs (whole characters, and any later handling of deletions).
    view.dispatch(state.tr.setSelection(arrow && e.shiftKey ? TextSelection.create(state.doc, sel.anchor, skip) : TextSelection.create(state.doc, skip)));
    return false;
  }
  const next = skip + dir * charLen(char.text, dir);
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, e.shiftKey ? sel.anchor : next, next)).scrollIntoView());
  return true;
}

// ---------- the doc rules: a bookmark goes with its text; a broken pair is mended ----------
/** After a change: a bookmark whose text was all deleted goes (Word's), and a bookmark that lost one marker gets it back at the
 * place its text now starts or ends, so a deletion that takes in a marker shrinks the bookmark instead of breaking it. */
function mend(trs, oldState, newState) {
  if (!trs.some((tr) => tr.docChanged)) return null;
  const before = bookmarksOf(oldState.doc);
  if (!before.length) return null;
  const mapping = new Mapping();
  for (const tr of trs) mapping.appendMapping(tr.mapping);
  const now = new Map(bookmarksOf(newState.doc).map((b) => [b.id || b.name, b]));
  const type = newState.schema.nodes.bookmark;
  const fixes = []; // [{pos, del?: true, node?}]
  for (const b of before) {
    if (b.end == null) continue;
    const key = b.id || b.name;
    const n = now.get(key);
    const startGone = !n;
    const endGone = !!n && n.end == null;
    if (!startGone && !endGone) {
      if (b.from < b.to && n.from === n.to) fixes.push({ pos: n.end, del: true }, { pos: n.start, del: true });
      continue;
    }
    // One marker left: find the other in the new doc, then put the lost one back at the mapped place.
    let other = null;
    newState.doc.descendants((node, pos) => {
      if (isMark(node) && (node.attrs.id || node.attrs.name) === key) other = { pos, node };
      return other == null;
    });
    if (!other) continue;
    const lostEnd = endGone;
    const at = mapping.map(lostEnd ? b.end : b.start, lostEnd ? -1 : 1);
    const from = lostEnd ? other.pos + 1 : at;
    const to = lostEnd ? at : other.pos;
    if (to <= from) fixes.push({ pos: other.pos, del: true });
    else fixes.push({ pos: at, node: type.create({ name: b.name, id: b.id, end: lostEnd }) });
  }
  if (!fixes.length) return null;
  const tr = newState.tr;
  for (const f of fixes.sort((a, b) => b.pos - a.pos)) {
    if (f.del) tr.delete(f.pos, f.pos + 1);
    else if (newState.doc.resolve(f.pos).parent.inlineContent) tr.insert(f.pos, f.node);
  }
  return tr.docChanged ? tr : null;
}

// ---------- paste: a name the document holds stays with the original ----------
// A drag that moves text deletes the original in the same step, so a bookmark whose two markers both ride in the slice goes with it.
function movedKeys(slice) {
  const seen = new Map();
  slice.content.descendants((n) => {
    if (isMark(n)) {
      const key = n.attrs.id || n.attrs.name;
      seen.set(key, (seen.get(key) ?? 0) | (n.attrs.end ? 2 : 1));
    }
  });
  return new Set([...seen].filter(([, v]) => v === 3).map(([k]) => k));
}

function pasteSlice(slice, view) {
  const moving = view.dragging?.move ? movedKeys(slice) : new Set();
  const names = new Set(bookmarksOf(view.state.doc).map((b) => b.name.toLowerCase()));
  let changed = false;
  const ids = new Map();
  let next = 1 + Math.max(0, ...bookmarksOf(view.state.doc).map((b) => Number(b.id) || 0));
  const walk = (frag) => {
    const out = [];
    frag.forEach((node) => {
      if (isMark(node)) {
        if (names.has(String(node.attrs.name).toLowerCase()) && !moving.has(node.attrs.id || node.attrs.name)) {
          changed = true;
          return;
        }
        // A kept bookmark gets an id of its own, so it never pairs with a marker already in the document.
        const old = node.attrs.id || node.attrs.name;
        if (!ids.has(old)) ids.set(old, String(next++));
        changed = true;
        out.push(node.type.create({ ...node.attrs, id: ids.get(old) }, null, node.marks));
        return;
      }
      out.push(node.content.size ? node.copy(walk(node.content)) : node);
    });
    return Fragment.from(out);
  };
  const content = walk(slice.content);
  return changed ? new Slice(content, slice.openStart, slice.openEnd) : slice;
}

// ---------- decorations: point bookmarks for Show bookmarks ----------
// Built once per doc: a view update that only moves the selection reuses the set.
const pointSets = new WeakMap();
function pointDecorations(doc) {
  let set = pointSets.get(doc);
  if (set) return set;
  const decos = [];
  for (const b of bookmarksOf(doc)) if (b.end != null && b.from === b.to) decos.push(Decoration.node(b.start, b.start + 1, { 'data-point': '' }));
  set = decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty;
  pointSets.set(doc, set);
  return set;
}

// ---------- clicks ----------
const ctrlClickLinks = () => wordSettings(getState().settings ?? {}).editing?.ctrlClickLinks !== false;
const follows = (e) => (ctrlClickLinks() ? e.ctrlKey || e.metaKey : !e.shiftKey && !e.altKey);

/** The link a click at `pos` lands on: {href, anchor} from the link mark, or a hyperlinked field (REF, PAGEREF, NOTEREF \h, or
 * HYPERLINK). */
function linkAt(state, pos, node) {
  if (node?.type.name === 'field') {
    const f = parseField(node.attrs.code);
    if (f.name === 'HYPERLINK') return hyperlinkOf(f);
    if ((f.name === 'REF' || f.name === 'PAGEREF' || f.name === 'NOTEREF') && f.sw.h && f.args[0]) return { anchor: f.args[0] };
    return null;
  }
  const $p = state.doc.resolve(pos);
  const mark = [...$p.marks(), ...($p.nodeAfter?.marks ?? [])].find((m) => m.type.name === 'link');
  return mark ? { href: mark.attrs.href, anchor: mark.attrs.anchor } : null;
}

// ---------- the ScreenTip ----------
let tip = null;
let tipTimer = 0;
function hideTip() {
  clearTimeout(tipTimer);
  tip?.remove();
  tip = null;
}
function showTip(a, e) {
  hideTip();
  const text = a.getAttribute('data-tooltip') || a.getAttribute('href') || '';
  if (!text) return;
  tipTimer = setTimeout(() => {
    if (!a.isConnected) return;
    // Styled inline: it lives on document.body, outside the Document scope the package stylesheet may style.
    tip = document.createElement('div');
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('data-link-tip', '');
    Object.assign(tip.style, { position: 'fixed', zIndex: 60, maxWidth: '24rem', padding: '0.375rem 0.5rem', border: '1px solid var(--border)',
      borderRadius: '0.375rem', background: 'var(--popover)', color: 'var(--popover-foreground)', fontSize: '0.75rem', overflowWrap: 'anywhere',
      pointerEvents: 'none', boxShadow: '0 4px 12px rgb(0 0 0 / 0.15)' });
    const line = document.createElement('div');
    line.textContent = text;
    const hint = document.createElement('div');
    hint.style.color = 'var(--muted-foreground)';
    hint.textContent = ctrlClickLinks() ? `${isMac() ? 'Cmd' : 'Ctrl'}+click to open` : 'Click to open';
    tip.append(line, hint);
    document.body.append(tip);
    const r = a.getBoundingClientRect();
    tip.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - tip.offsetWidth - 4))}px`;
    tip.style.top = `${r.bottom + 6 + tip.offsetHeight > window.innerHeight ? r.top - tip.offsetHeight - 6 : r.bottom + 6}px`;
  }, 400);
}

/** The fields-ref extension for the Document kit. */
export const FieldsRef = Extension.create({
  name: 'fieldsRef',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key: fieldsRefKey,
      state: stackState,
      appendTransaction: mend,
      props: {
        decorations: (state) => pointDecorations(state.doc),
        handleKeyDown: stepKey,
        transformPasted: pasteSlice,
        handleClickOn(view, pos, node, nodePos, e, direct) {
          if (!direct || node.type.name !== 'field') return false;
          const f = parseField(node.attrs.code);
          // NoMacro placeholders: one click selects the whole field, so typing replaces it.
          if (f.name === 'MACROBUTTON' && !e.ctrlKey) return selectField(view, nodePos);
          const link = follows(e) && linkAt(view.state, nodePos, node);
          return link ? follow(editor, link) : false;
        },
        handleClick(view, pos, e) {
          if (e.button !== 0 || !follows(e)) return false;
          const link = linkAt(view.state, pos, null);
          if (!link) return false;
          e.preventDefault();
          hideTip();
          return follow(editor, link);
        },
        handleDOMEvents: {
          mouseover(view, e) {
            const a = e.target instanceof Element && e.target.closest('a[href]');
            if (a && view.dom.contains(a)) showTip(a, e);
            return false;
          },
          mouseout(view, e) {
            if (tip || tipTimer) {
              const a = e.target instanceof Element && e.target.closest('a[href]');
              if (a && !a.contains(e.relatedTarget)) hideTip();
            }
            return false;
          },
          mousedown: () => {
            hideTip();
            return false;
          },
        },
      },
      view(view) {
        // Show bookmarks (settings.word.bookmarks): brackets drawn by style.css under this attribute.
        const paint = () => {
          if (!view.dom.isConnected) return;
          const on = !!wordSettings(getState().settings ?? {}).bookmarks;
          if (on !== view.dom.hasAttribute('data-show-bookmarks')) view.dom.toggleAttribute('data-show-bookmarks', on);
        };
        paint();
        let last = getState().settings;
        const off = subscribe(() => {
          if (getState().settings === last) return;
          last = getState().settings;
          paint();
        });
        return { update: paint, destroy: off };
      },
    })];
  },
});

