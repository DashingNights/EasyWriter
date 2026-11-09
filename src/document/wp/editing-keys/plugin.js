// editing-keys' ProseMirror plugin (docs/plans/word briefs/editing-keys.md): the modes the keys start (Extend, column, F2 move and
// Shift+F2 copy, accent prefixes, overtype), Word's mouse selection (double, triple and Ctrl+click, Ctrl and Alt drags, the
// selection bar, Click and Type, the right-drag menu), and what Go Back, Repeat and the Undo list remember. Every Document kit
// editor carries it (story and hidden session editors too), so DOM work checks view.dom.isConnected.
import { isHistoryTransaction, undoDepth } from '@tiptap/pm/history';
import { AllSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { AddMarkStep, AttrStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getState, setState } from '../../../app/store.js';
import { commandOf, lastCommand } from '../../../tooling/registry.js';
import { REASONS } from '../../../tooling/reasons.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { compose } from './accents.mjs';
import { blockRanges, pushEdit, undoLabel } from './logic.mjs';
import { MultiSelection } from './multisel.js';
import { charExtend, flatOf, paraAt, sentenceAt, wordAt } from './words.mjs';
import { zoneAt } from './zones.mjs';

export const ekKey = new PluginKey('wordEditingKeys');

/** Store word (plan.md §1.12): extend is null | 'extend' | 'column' | 'move' | 'copy'. */
export const word = () => getState().word ?? {};
export const setWord = (patch) => setState({ word: { ...getState().word, ...patch } });
export const editing = () => wordSettings(getState().settings).editing;

// The pending accent prefix (its chord) and the column selection started from the keys: one focused editor at a time has them.
export const pending = { prefix: null, col: null, scrolled: false, ctrlBase: null };

/** Ends every mode the keys started → whether one was on. */
export function endModes(view) {
  const on = !!word().extend || !!pending.prefix || !!word().painter;
  pending.prefix = null;
  pending.col = null;
  if (word().extend || word().painter) setWord({ extend: null, painter: null });
  if (view && ekKey.getState(view.state)?.src) view.dispatch(view.state.tr.setMeta(ekKey, { src: null }));
  return on;
}

const setSel = (view, sel) => view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
const text = (view, from, to) => TextSelection.create(view.state.doc, from, to);

/** The ProseMirror position under pointer event `e`, or null. */
const posAt = (view, e) => view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? null;

/** The text of the textblock holding `$pos` (inline atoms as one character each) → {text, start}. */
function blockOf($pos) {
  const start = $pos.start();
  return { text: `${$pos.parent.textBetween(0, $pos.parent.content.size, '\n', '￼')}\r`, start };
}

/** The word at `pos` with its trailing spaces (Word's double-click) → {from, to}. */
export function wordRange(doc, pos) {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return { from: pos, to: pos };
  const { text: t, start } = blockOf($pos);
  const [a, b] = wordAt(t, pos - start);
  return { from: start + a, to: start + Math.min(b, t.length - 1) };
}

/** The sentence at `pos` with its trailing spaces (Ctrl+click) → {from, to}. */
export function sentenceRange(doc, pos) {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return { from: pos, to: pos };
  const { text: t, start } = blockOf($pos);
  const [a, b] = sentenceAt(t, pos - start);
  return { from: start + a, to: start + b };
}

/** The paragraph at `pos` with its mark (triple-click): to the start of the next textblock, else its own end → {from, to}. */
export function paraRange(doc, pos) {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return { from: pos, to: pos };
  const next = Selection.findFrom(doc.resolve($pos.after()), 1, true);
  return { from: $pos.start(), to: next ? next.from : $pos.end() };
}

/** A plain drag from `a` to `b` under the editing options → [anchor, head]: autoWordSelect snaps to whole words once the pointer
 * leaves the first word; smartParagraph adds the mark to a selection that covers whole paragraphs. */
export function dragRange(doc, a, b, { autoWordSelect, smartParagraph }) {
  let [anchor, head] = [a, b];
  const first = wordRange(doc, a);
  if (autoWordSelect && (b < first.from || b > first.to)) {
    const w = wordRange(doc, b);
    [anchor, head] = b > a ? [first.from, Math.max(b, w.to)] : [first.to, Math.min(b, w.from)];
  }
  const [from, to] = anchor < head ? [anchor, head] : [head, anchor];
  if (smartParagraph && from < to) {
    const $from = doc.resolve(from);
    const $to = doc.resolve(to);
    if ($from.parent.isTextblock && $to.parent.isTextblock && from === $from.start() && to === $to.end()) {
      const end = paraRange(doc, to).to;
      return anchor < head ? [anchor, end] : [end, head];
    }
  }
  return [anchor, head];
}

// ---------------------------------------------------------------------------------------------
// Undo labels, typing and edit positions

const FORMAT_STEPS = [AddMarkStep, RemoveMarkStep, AttrStep];
const formatOnly = (tr) => tr.steps.length > 0 && tr.steps.every((s) => FORMAT_STEPS.some((T) => s instanceof T) || (s instanceof ReplaceAroundStep && s.structure));

/** What transaction `tr` did, for its undo label → {uiEvent, inserted, deleted, marksOnly}. */
function summary(tr) {
  let inserted = '';
  let deleted = false;
  for (const s of tr.steps) {
    if (s instanceof ReplaceStep) {
      if (s.from < s.to) deleted = true;
      inserted += s.slice.content.textBetween(0, s.slice.content.size, ' ', '');
    } else if (!FORMAT_STEPS.some((T) => s instanceof T)) deleted = true;
  }
  return { uiEvent: tr.getMeta('uiEvent'), inserted, deleted, marksOnly: formatOnly(tr) };
}

/** A command's label for the Undo list: its own label, else the spec's. */
function labelOf(id) {
  const spec = commandOf(id);
  const own = typeof spec?.label === 'function' ? null : spec?.label;
  const s = globalThis.__word?.spec;
  return own ?? s?.CONTROLS?.[id]?.label ?? s?.ITEMS?.[id]?.label ?? null;
}

const sameBlock = (doc, a, b) => {
  try {
    return doc.resolve(a).start() === doc.resolve(b).start();
  } catch {
    return false;
  }
};

// box: the Undo list's labels, shared by every state of one editor and kept in step by the plugin view (labelsAfter).
const INITIAL = () => ({ src: null, origin: null, ring: [], idx: -1, typed: { run: '', last: '', cmd: null }, box: { pend: [], labels: [], redo: [] } });

function apply(tr, v, old, now) {
  const meta = tr.getMeta(ekKey) ?? {};
  const next = { ...v };
  for (const k of ['src', 'origin', 'idx']) if (k in meta) next[k] = meta[k];
  if ('ring' in meta) Object.assign(next, { ring: meta.ring, idx: -1 });
  if (!tr.docChanged) {
    // A caret move ends the typing run that Repeat would type again.
    if (tr.selectionSet && !old.selection.eq(now.selection) && v.typed.run) next.typed = { run: '', last: v.typed.run, cmd: v.typed.cmd };
    return next;
  }
  const map = (p) => tr.mapping.map(p);
  if (next.src && !('src' in meta)) next.src = { from: tr.mapping.map(next.src.from, 1), to: tr.mapping.map(next.src.to, -1) };
  if (next.origin != null && !('origin' in meta)) next.origin = map(next.origin);
  next.ring = next.ring.map(map);
  const hist = isHistoryTransaction(tr);
  const sum = summary(tr);
  if (!hist && tr.getMeta('addToHistory') !== false && !('ring' in meta)) {
    const same = next.ring.length > 0 && sameBlock(now.doc, next.ring[0], now.selection.head);
    Object.assign(next, { ring: pushEdit(next.ring, now.selection.head, same), idx: -1 });
  }
  const typing = !hist && !!sum.inserted && !sum.uiEvent && tr.steps.length === 1;
  if (typing) next.typed = { run: v.typed.run + sum.inserted, last: v.typed.last, cmd: lastCommand() };
  // The Undo list reads the history's depth, which this plugin's apply cannot see yet (the history plugin's field comes later), so
  // the plugin view sorts these out after the update (labelsAfter).
  v.box.pend.push({ hist, sum, typing });
  return next;
}

/** Updates the Undo list's labels in `box` once the history has taken the update from depth `d0` to `d1`. */
function labelsAfter(box, d0, d1) {
  const pend = box.pend.splice(0);
  if (pend.some((p) => p.hist)) {
    if (d1 < d0) {
      const k = Math.min(d0 - d1, box.labels.length);
      box.redo.push(...box.labels.splice(box.labels.length - k).reverse());
    } else if (d1 > d0) box.labels.push(...box.redo.splice(Math.max(0, box.redo.length - (d1 - d0))).reverse());
    return;
  }
  const first = pend[0];
  if (!first) return;
  // A new event raises the depth, or lowers it when the history trims its oldest events past its limit (prosemirror-history lets
  // the count run 20 over its depth, then cuts back), so any change of depth from a plain transaction is a new step.
  if (d1 !== d0) {
    const entry = { label: undoLabel(first.sum), typing: first.typing && !first.sum.deleted ? first.sum.inserted : null };
    // The registry records lastCommand after its command returns, so the step's command is known only once the run ends.
    const before = lastCommand();
    queueMicrotask(() => {
      const c = lastCommand();
      if (c && c !== before) entry.label = labelOf(c.id) ?? entry.label;
    });
    box.labels.push(entry);
    box.redo.length = 0;
  } else if (d1 === d0 && box.labels.at(-1)?.typing != null && pend.every((p) => p.typing)) {
    const top = box.labels.at(-1);
    top.typing += pend.map((p) => p.sum.inserted).join('');
    top.label = `Typing "${top.typing}"`;
  }
  if (box.labels.length > d1) box.labels.splice(0, box.labels.length - d1);
}

/** The Undo list's labels for `state`, newest first; steps from before the draft was reopened read Edit. */
export function undoLabels(state) {
  const depth = undoDepth(state);
  const labels = (ekKey.getState(state)?.box.labels ?? []).map((e) => e.label).reverse();
  return [...labels, ...Array(Math.max(0, depth - labels.length)).fill('Edit')].slice(0, depth);
}

// ---------------------------------------------------------------------------------------------
// Moving and copying (F2, Shift+F2, the right-drag menu)

/** Moves or copies `src` ({from, to}) to `at` in one undo step and selects it there → whether it ran. */
export function transfer(view, src, at, move) {
  if (move && at > src.from && at < src.to) return false;
  const { state } = view;
  const slice = state.doc.slice(src.from, src.to);
  const tr = state.tr;
  if (move) tr.delete(src.from, src.to);
  const k = tr.steps.length;
  const to = tr.mapping.map(at);
  tr.replaceRange(to, to, slice);
  const m = tr.mapping.slice(k);
  tr.setSelection(TextSelection.create(tr.doc, m.map(to, -1), m.map(to, 1))).setMeta(ekKey, { src: null }).scrollIntoView();
  view.dispatch(tr);
  return true;
}

/** Wraps `src` in a hidden _Hlk bookmark and puts a link to it, with the source's text, at `at` (Create Hyperlink Here). */
function hyperlinkHere(view, src, at) {
  const { state } = view;
  const { bookmark } = state.schema.nodes;
  const link = state.schema.marks.link;
  if (!bookmark || !link) return false;
  const name = `_Hlk${Math.floor(Math.random() * 1e9)}`;
  const label = state.doc.textBetween(src.from, src.to, ' ', '');
  const tr = state.tr;
  tr.insert(src.to, bookmark.create({ name, id: name, end: true })).insert(src.from, bookmark.create({ name, id: name, end: false }));
  const to = tr.mapping.map(at);
  tr.insert(to, state.schema.text(label, [link.create({ href: `#${name}`, anchor: name })]));
  view.dispatch(tr.scrollIntoView());
  return true;
}

let menuEl = null;
const closeMenu = () => {
  menuEl?.remove();
  menuEl = null;
};

/** The right-drag menu at the pointer: Move Here, Copy Here, Link Here, Create Hyperlink Here and Cancel. */
function rightDragMenu(view, src, at, x, y) {
  closeMenu();
  const doc = view.dom.ownerDocument;
  menuEl = doc.createElement('div');
  menuEl.className = 'fixed z-[60] flex min-w-48 flex-col rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md';
  menuEl.setAttribute('role', 'menu');
  menuEl.dataset.wordRightDrag = '';
  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
  const items = [
    ['Move Here', () => transfer(view, src, at, true)],
    ['Copy Here', () => transfer(view, src, at, false)],
    ['Link Here', null, REASONS.ole],
    ['Create Hyperlink Here', () => hyperlinkHere(view, src, at)],
    ['Cancel', () => {}],
  ];
  for (const [label, act, reason] of items) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.className = 'rounded-sm px-2 py-1 text-left hover:bg-accent disabled:opacity-50';
    if (!act) {
      b.disabled = true;
      b.title = reason;
    }
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      closeMenu();
      act?.();
      view.focus();
    });
    menuEl.appendChild(b);
  }
  doc.body.appendChild(menuEl);
  const away = (e) => {
    if (menuEl?.contains(e.target) && e.type !== 'keydown') return;
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    closeMenu();
    doc.removeEventListener('mousedown', away, true);
    doc.removeEventListener('keydown', away, true);
  };
  doc.addEventListener('mousedown', away, true);
  doc.addEventListener('keydown', away, true);
}

// ---------------------------------------------------------------------------------------------
// Column selection

/** The column selection between client points `a` and `b` ({left, top, bottom}): one range per line box they span. */
export function applyBlock(view, a, b) {
  const top = Math.min(a.top, b.top);
  const bottom = Math.max(a.bottom, b.bottom);
  const r = view.dom.getBoundingClientRect();
  const from = view.posAtCoords({ left: r.left + 1, top: top + 1 })?.pos ?? 0;
  const to = view.posAtCoords({ left: r.right - 1, top: bottom - 1 })?.pos ?? view.state.doc.content.size;
  const lines = new Map();
  // ponytail: one coordsAtPos per character between the two lines; fine for a screenful, slow for a column over many pages.
  view.state.doc.nodesBetween(Math.min(from, to), Math.max(from, to), (node, pos) => {
    if (!node.isTextblock) return true;
    for (let p = pos + 1; p <= pos + node.nodeSize - 1; p++) {
      const c = view.coordsAtPos(p, p === pos + node.nodeSize - 1 ? -1 : 1);
      if (c.bottom < top || c.top > bottom) continue;
      const key = `${pos}:${Math.round(c.top)}`;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push({ pos: p, x: c.left });
    }
    return false;
  });
  const ranges = blockRanges([...lines.values()], a.left, b.left);
  const sel = MultiSelection.of(view.state.doc, ranges);
  if (sel) view.dispatch(view.state.tr.setSelection(sel));
}

const pointOf = (c) => ({ left: c.left, top: c.top, bottom: c.bottom });

/** The text position on the line above (`dir` -1) or below (1) the one holding `pos`, nearest its x. Scans positions rather than
 * hitting a point, which can fall in the space between paragraphs. */
function lineMove(view, pos, dir) {
  const { doc } = view.state;
  const c = view.coordsAtPos(pos);
  let best = null;
  let line = null;
  for (let p = pos + dir; p >= 0 && p <= doc.content.size; p += dir) {
    if (!doc.resolve(p).parent.isTextblock) continue;
    const q = view.coordsAtPos(p);
    const next = dir > 0 ? q.top >= c.bottom - 1 : q.bottom <= c.top + 1;
    if (!next) continue;
    line ??= Math.round(q.top);
    if (Math.abs(Math.round(q.top) - line) > 1) break;
    if (!best || Math.abs(q.left - c.left) < best.d) best = { p, d: Math.abs(q.left - c.left) };
  }
  return best?.p ?? pos;
}

/** An arrow key `key` in column mode: moves the block's head and reselects the block. */
function columnKey(view, key) {
  const col = pending.col;
  const size = view.state.doc.content.size;
  let head = col.head;
  if (key === 'ArrowLeft') head = Math.max(0, head - 1);
  else if (key === 'ArrowRight') head = Math.min(size, head + 1);
  else head = lineMove(view, head, key === 'ArrowUp' ? -1 : 1);
  col.head = head;
  applyBlock(view, col.anchor, pointOf(view.coordsAtPos(head)));
}

// ---------------------------------------------------------------------------------------------
// Keys

const ARROWS = { ArrowLeft: ['backward', 'character'], ArrowRight: ['forward', 'character'], ArrowUp: ['backward', 'line'], ArrowDown: ['forward', 'line'],
  Home: ['backward', 'lineboundary'], End: ['forward', 'lineboundary'], PageUp: ['backward', 'line'], PageDown: ['forward', 'line'] };

/** Extends the DOM selection (whose anchor ProseMirror set to the state's) by key `e`, as the Shift version of the key would. */
function extendBy(view, e) {
  const [dir, unit] = ARROWS[e.key];
  const sel = view.dom.ownerDocument.getSelection();
  let gran = unit;
  if (e.ctrlKey && unit === 'character') gran = 'word';
  if (e.ctrlKey && unit === 'lineboundary') gran = 'documentboundary';
  // ponytail: PageUp and PageDown extend by 20 lines; a viewport's worth of lines would need the line height.
  const times = e.key.startsWith('Page') ? 20 : 1;
  for (let i = 0; i < times; i++) sel.modify('extend', dir, gran);
}

/** Word's keys that work inside a mode, before WordKeys (handleDOMEvents runs ahead of every plugin's handleKeyDown). */
function onKeyDown(view, e) {
  if (!view.dom.isConnected) return false;
  if (e.isComposing) {
    endModes(null);
    return false;
  }
  const mods = e.ctrlKey || e.altKey || e.metaKey;
  if (pending.prefix && !/^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) {
    const chord = pending.prefix;
    pending.prefix = null;
    const ch = !mods && e.key.length === 1 ? compose(chord, e.key) : null;
    if (!ch) return false; // a letter with no accented form types itself
    e.preventDefault();
    view.dispatch(view.state.tr.insertText(ch).scrollIntoView());
    return true;
  }
  // Ctrl+Shift+C does nothing in Word's text (editing.disabledKey). Its keymap row is 'off', and WORD_DEFS binds only 'bind' rows,
  // so without this the chord would reach the app's own bindings.
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyC') {
    e.preventDefault();
    return true;
  }
  if (e.code === 'Insert' && !mods && !e.shiftKey) {
    const opt = editing();
    if (opt.insKeyOvertype) setWord({ overtype: !word().overtype });
    else if (opt.insKeyPaste) globalThis.__word?.run?.('home.clipboard.paste');
    else return false;
    e.preventDefault();
    return true;
  }
  const mode = word().extend;
  // Ctrl+Home and Ctrl+End: Chromium's own move to either end of the document stops at the non-editable widgets the page
  // engine and later packages draw around the text, so the caret never moves. Both go to the first or last text position.
  if ((e.key === 'Home' || e.key === 'End') && e.ctrlKey && !e.altKey && !e.metaKey && mode !== 'column') {
    e.preventDefault();
    const { doc } = view.state;
    const to = e.key === 'Home' ? Selection.atStart(doc).from : (Selection.findFrom(doc.resolve(doc.content.size), -1, true) ?? Selection.atEnd(doc)).to;
    setSel(view, text(view, e.shiftKey || mode === 'extend' ? view.state.selection.anchor : to, to));
    return true;
  }
  if ((mode === 'move' || mode === 'copy') && e.key === 'Enter' && !mods && !e.shiftKey) {
    const src = ekKey.getState(view.state)?.src;
    e.preventDefault();
    if (src) transfer(view, src, view.state.selection.head, mode === 'move');
    setWord({ extend: null });
    return true;
  }
  if (mode === 'column' && pending.col && /^Arrow/.test(e.key) && !mods) {
    e.preventDefault();
    columnKey(view, e.key);
    return true;
  }
  if (mode === 'extend' && !e.altKey && !e.metaKey) {
    // Ctrl+Up and Down (paragraphs) and Ctrl+PageUp and PageDown (browse) fall through to WordKeys, which extends in this mode.
    if (ARROWS[e.key] && (!e.ctrlKey || /^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key))) {
      e.preventDefault();
      extendBy(view, e);
      return true;
    }
    if (e.key.length === 1 && !e.ctrlKey) {
      const flat = flatOf(view.state.doc);
      const { anchor, head } = view.state.selection;
      const to = charExtend(flat.text, flat.offset(head), e.key);
      e.preventDefault();
      if (to != null) setSel(view, text(view, anchor, flat.at(to)));
      return true;
    }
  }
  // Smart cursoring: after a scroll left the caret off screen, the first arrow puts it on the visible page.
  if (pending.scrolled && /^Arrow|^Page/.test(e.key) && !mods && editing().smartCursoring) {
    pending.scrolled = false;
    const vp = view.dom.closest('[data-viewport]')?.getBoundingClientRect();
    const c = view.coordsAtPos(view.state.selection.head);
    if (vp && (c.bottom < vp.top || c.top > vp.bottom)) {
      const r = view.dom.getBoundingClientRect();
      const pos = view.posAtCoords({ left: r.left + 2, top: Math.max(vp.top, r.top) + 8 })?.pos;
      if (pos != null) {
        e.preventDefault();
        setSel(view, text(view, pos, pos));
        return true;
      }
    }
  }
  return false;
}

/** Overtype and Typing replaces selection (settings.word.editing.typingReplaces). */
function onTextInput(view, from, to, typed) {
  if (view.composing || !view.dom.isConnected) return false;
  if (word().overtype && from === to) {
    const $from = view.state.doc.resolve(from);
    const end = Math.min($from.end(), from + typed.length);
    view.dispatch(view.state.tr.insertText(typed, from, Math.max(from, end)));
    return true;
  }
  if (from < to && !editing().typingReplaces) {
    const tr = view.state.tr.insertText(typed, from, from);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + typed.length, to + typed.length)));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Mouse

/** Ranges a Ctrl selection adds to: the current multiple selection's, or a non-empty selection. */
const baseRanges = (sel) => (sel instanceof MultiSelection ? sel.ranges : sel.empty ? [] : [sel.ranges[0]]).map((r) => ({ from: r.$from.pos, to: r.$to.pos }));

/** Follows the pointer until the button is released: `move(e)` per move, `up(e, moved)` once. */
function track(view, start, move, up) {
  const win = view.dom.ownerDocument.defaultView;
  let moved = false;
  const onMove = (e) => {
    if (!moved && Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < 4) return;
    moved = true;
    move(e);
  };
  const onUp = (e) => {
    win.removeEventListener('mousemove', onMove);
    win.removeEventListener('mouseup', onUp);
    up?.(e, moved);
  };
  win.addEventListener('mousemove', onMove);
  win.addEventListener('mouseup', onUp);
}

/** Click and Type: a double-click in the blank space below the last paragraph adds empty paragraphs down to it, the last one set by
 * the zone of the text column it lands in → whether it ran. */
function clickAndType(view, e) {
  if (!editing().clickAndType || !['print', 'web'].includes(word().view ?? 'print') || view.dom.closest('[data-story]')) return false;
  const { doc } = view.state;
  const end = Selection.atEnd(doc);
  const c = view.coordsAtPos(end.from);
  const r = view.dom.getBoundingClientRect();
  if (e.clientY <= c.bottom + 2 || e.clientX < r.left || e.clientX > r.right) return false;
  const scale = r.width / (view.dom.offsetWidth || r.width);
  const lineH = Math.max(1, c.bottom - c.top);
  const n = Math.max(1, Math.round((e.clientY - c.bottom) / lineH));
  const zone = zoneAt(((e.clientX - r.left) / scale) * 0.75, view.dom.offsetWidth * 0.75);
  const { paragraph } = view.state.schema.nodes;
  const attrs = { center: { textAlign: 'center' }, right: { textAlign: 'right' }, indent: { indent: { firstLine: zone.at } },
    tab: { tabs: [{ pos: Math.round(zone.at * 10) / 10, align: 'left', leader: 'none' }] }, left: {} }[zone.kind];
  const paras = Array.from({ length: n }, (_, i) => (i < n - 1 ? paragraph.create()
    : paragraph.create(attrs, zone.kind === 'tab' ? view.state.schema.text('\t') : null)));
  const tr = view.state.tr.insert(doc.content.size, paras);
  tr.setSelection(Selection.atEnd(tr.doc)).scrollIntoView();
  view.dispatch(tr);
  return true;
}

/** ProseMirror's double-click props (handleDoubleClickOn up from the node under the pointer, then handleDoubleClick) → handled.
 * ProseMirror runs them only for a press this handler lets through, so the word select below would swallow a double-click
 * on a note reference, a field or a content control. Walks the tree the way ProseMirror's runHandlerOnContext does. */
function doubleClickProps(view, e) {
  const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
  if (!at) return false;
  if (at.inside >= 0) {
    const $pos = view.state.doc.resolve(at.inside);
    for (let i = $pos.depth + 1; i > 0; i--) {
      const inner = i > $pos.depth;
      if (view.someProp('handleDoubleClickOn', (f) => f(view, at.pos, inner ? $pos.nodeAfter : $pos.node(i), $pos.before(i), e, inner))) return true;
    }
  }
  return !!view.someProp('handleDoubleClick', (f) => f(view, at.pos, e));
}

function onMouseDown(view, e) {
  if (!view.dom.isConnected) return false;
  const { state } = view;
  const sel = state.selection;
  const pos = posAt(view, e);
  if (e.button === 2) {
    // A right press inside the selection that is released elsewhere opens the right-drag menu instead of the context menu.
    if (pos == null || sel.empty || pos < sel.from || pos > sel.to) return false;
    const src = { from: sel.from, to: sel.to };
    const win = view.dom.ownerDocument.defaultView;
    const up = (u) => {
      win.removeEventListener('mouseup', up, true);
      const at = posAt(view, u);
      if (u.button !== 2 || at == null || (at >= src.from && at <= src.to)) return;
      const stop = (c) => {
        c.preventDefault();
        c.stopImmediatePropagation();
        win.removeEventListener('contextmenu', stop, true);
      };
      win.addEventListener('contextmenu', stop, true);
      setTimeout(() => win.removeEventListener('contextmenu', stop, true), 500);
      rightDragMenu(view, src, at, u.clientX, u.clientY);
    };
    win.addEventListener('mouseup', up, true);
    return false;
  }
  if (e.button !== 0 || pos == null) return false;
  // A Ctrl+double or triple-click adds to the ranges held before its first click, whose own Ctrl+click already chose a sentence.
  if (e.detail === 1) pending.ctrlBase = e.ctrlKey ? baseRanges(sel) : null;
  if (e.detail === 2 && !e.ctrlKey && !e.altKey && (clickAndType(view, e) || doubleClickProps(view, e))) {
    e.preventDefault();
    return true;
  }
  if (word().extend === 'extend') {
    e.preventDefault();
    view.focus();
    setSel(view, text(view, sel.anchor, pos));
    return true;
  }
  if (e.altKey && !e.ctrlKey) {
    // Alt+drag: a column (block) selection.
    e.preventDefault();
    view.focus();
    const a = { left: e.clientX, top: e.clientY, bottom: e.clientY };
    track(view, e, (m) => applyBlock(view, a, { left: m.clientX, top: m.clientY, bottom: m.clientY }));
    return true;
  }
  if (e.ctrlKey && !e.shiftKey) {
    if (e.target.closest?.('a[href]')) return false; // Ctrl+click on a link follows it (fields-ref)
    e.preventDefault();
    view.focus();
    const base = (e.detail > 1 && pending.ctrlBase) || baseRanges(sel);
    const add = (r) => {
      if (r.from === r.to) return;
      const next = MultiSelection.of(state.doc, [...base.filter((b) => b.to <= r.from || b.from >= r.to), r]);
      if (next) setSel(view, next);
    };
    if (e.detail === 2) add(wordRange(state.doc, pos));
    else if (e.detail >= 3) add(paraRange(state.doc, pos));
    else {
      track(view, e, (m) => {
        const at = posAt(view, m);
        if (at != null && at !== pos) add({ from: Math.min(pos, at), to: Math.max(pos, at) });
      }, (u, moved) => {
        const r = sentenceRange(state.doc, pos);
        if (!moved && r.from < r.to) setSel(view, text(view, r.from, r.to));
      });
    }
    return true;
  }
  if (e.shiftKey || e.ctrlKey || e.altKey) return false;
  if (e.detail === 2) {
    const r = wordRange(state.doc, pos);
    if (r.from === r.to) return false;
    e.preventDefault();
    setSel(view, text(view, r.from, r.to));
    return true;
  }
  if (e.detail === 3) {
    const r = paraRange(state.doc, pos);
    if (r.from === r.to) return false;
    e.preventDefault();
    setSel(view, text(view, r.from, r.to));
    return true;
  }
  // The drag options take over a plain drag that starts outside the selection (one inside it drags the text).
  const opt = editing();
  if (e.detail === 1 && (opt.autoWordSelect || opt.smartParagraph) && (sel.empty || pos < sel.from || pos > sel.to)) {
    e.preventDefault();
    view.focus();
    setSel(view, text(view, pos, pos));
    track(view, e, (m) => {
      const at = posAt(view, m);
      if (at != null) setSel(view, text(view, ...dragRange(view.state.doc, pos, at, opt)));
    });
    return true;
  }
  return false;
}

/** The selection bar: the left margin beside the text. Click selects the line, double-click the paragraph, triple-click or
 * Ctrl+click the document, Shift+click extends by lines, and a drag selects whole lines. */
function selectionBar(view, page) {
  const inBar = (e) => {
    const r = view.dom.getBoundingClientRect();
    const p = page.getBoundingClientRect();
    return e.clientX >= p.left && e.clientX < r.left && e.clientY >= r.top && e.clientY <= r.bottom && !view.dom.contains(e.target);
  };
  const lineAt = (y) => {
    const r = view.dom.getBoundingClientRect();
    const a = view.posAtCoords({ left: r.left + 1, top: y })?.pos;
    const b = view.posAtCoords({ left: r.right - 1, top: y })?.pos;
    return a == null || b == null ? null : { from: Math.min(a, b), to: Math.max(a, b) };
  };
  const down = (e) => {
    if (e.button !== 0 || !view.dom.isConnected || !inBar(e)) return;
    const line = lineAt(e.clientY);
    if (!line) return;
    e.preventDefault();
    e.stopPropagation();
    view.focus();
    const { doc, selection } = view.state;
    if (e.detail >= 3 || e.ctrlKey) return setSel(view, new AllSelection(doc));
    if (e.detail === 2) {
      const r = paraRange(doc, line.from);
      return setSel(view, text(view, r.from, r.to));
    }
    const anchor = e.shiftKey ? selection.anchor : line.from;
    const to = (l) => (l.from >= anchor ? l.to : l.from);
    setSel(view, text(view, anchor, e.shiftKey ? to(line) : line.to));
    track(view, e, (m) => {
      const l = lineAt(m.clientY);
      if (l) setSel(view, text(view, l.from >= anchor ? line.from : line.to, to(l)));
    });
  };
  const hover = (e) => {
    if (inBar(e)) page.dataset.wekBar = '';
    else delete page.dataset.wekBar;
  };
  page.addEventListener('mousedown', down);
  page.addEventListener('mousemove', hover);
  return () => {
    page.removeEventListener('mousedown', down);
    page.removeEventListener('mousemove', hover);
    delete page.dataset.wekBar;
  };
}

/** Click and Type's pointer: the zone a double-click below the text would use, as data-wek-zone on the editor. */
function zonePointer(view) {
  const move = (e) => {
    const end = view.coordsAtPos(Selection.atEnd(view.state.doc).from);
    const r = view.dom.getBoundingClientRect();
    const on = editing().clickAndType && e.clientY > end.bottom + 2 && !view.dom.closest('[data-story]');
    if (!on) return delete view.dom.dataset.wekZone;
    const scale = r.width / (view.dom.offsetWidth || r.width);
    view.dom.dataset.wekZone = zoneAt(((e.clientX - r.left) / scale) * 0.75, view.dom.offsetWidth * 0.75).kind;
  };
  const leave = () => delete view.dom.dataset.wekZone;
  view.dom.addEventListener('mousemove', move);
  view.dom.addEventListener('mouseleave', leave);
  return () => {
    view.dom.removeEventListener('mousemove', move);
    view.dom.removeEventListener('mouseleave', leave);
  };
}

// ---------------------------------------------------------------------------------------------

/** editing-keys' plugin for one editor of the Document kit. */
export function editingKeysPlugin() {
  return new Plugin({
    key: ekKey,
    state: { init: INITIAL, apply },
    appendTransaction(trs, old, now) {
      // Any edit but formatting collapses a multiple selection to its head range (ponytail in multisel.js).
      if (!(now.selection instanceof MultiSelection) || !trs.some((tr) => tr.docChanged && !formatOnly(tr))) return null;
      return now.tr.setSelection(TextSelection.create(now.doc, now.selection.from, now.selection.to));
    },
    props: {
      decorations(state) {
        const v = ekKey.getState(state);
        const decos = [];
        if (v?.src && v.src.from < v.src.to) decos.push(Decoration.inline(v.src.from, v.src.to, { class: 'wek-src' }));
        if (state.selection instanceof MultiSelection) {
          for (const r of state.selection.ranges.slice(0, -1)) decos.push(Decoration.inline(r.$from.pos, r.$to.pos, { class: 'wek-sel' }));
        }
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
      handleTextInput: onTextInput,
      handleDOMEvents: {
        keydown: onKeyDown,
        mousedown: onMouseDown,
        compositionstart: () => {
          endModes(null);
          return false;
        },
        dragstart: (view, e) => {
          if (editing().dragDrop) return false;
          e.preventDefault();
          return true;
        },
      },
    },
    view(view) {
      const page = view.dom.closest('.page');
      const offs = [page && !view.dom.closest('[data-story]') ? selectionBar(view, page) : null, zonePointer(view)].filter(Boolean);
      const vp = view.dom.closest('[data-viewport]');
      // Any scroll counts (wheel, scroll bar, keys): one the caret's own move caused leaves it on screen, so the check does nothing.
      const scrolled = () => {
        pending.scrolled = true;
      };
      vp?.addEventListener('scroll', scrolled, { capture: true, passive: true });
      return {
        update(v, prev) {
          const box = ekKey.getState(v.state)?.box;
          if (box?.pend.length) labelsAfter(box, undoDepth(prev), undoDepth(v.state));
          // An edit ends Extend and column mode (Word drops them as soon as the text changes).
          if (v.state.doc !== prev.doc && v.hasFocus() && ['extend', 'column'].includes(word().extend)) setWord({ extend: null });
        },
        destroy() {
          for (const off of offs) off();
          vp?.removeEventListener('scroll', scrolled, { capture: true });
        },
      };
    },
  });
}
