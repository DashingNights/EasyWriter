// The Spelling pane's check (docs/plans/word briefs/proofing.md): from the selection or caret to the end of the main text, then from
// its start back to where it began, stopping at each flagged word and repeated word. Every action moves on. Positions follow the
// editor's transactions, so the user may edit between steps.
import { getState } from '../../../app/store.js';
import { ctxOf } from '../../../tooling/registry.js';
import { wordSettings } from '../../word/settings.mjs';
import { onceOf, tell } from './plugin.js';
import { readability } from './readability.mjs';
import { addWord, candidates, docLang, ignoreWord, nextFlagged, proofOpts, suggest } from './spell.js';
import { sentenceAround } from './words.mjs';
import { parasOf } from '../../model/count.mjs';

let s = null; // {ed, start, pos, wrapped, item, suggestions, done, busy}
const listeners = new Set();
let snap = null; // one object per change: useSyncExternalStore loops forever on a fresh snapshot per call
const emit = () => {
  snap = s && { item: s.item, suggestions: s.suggestions, done: s.done, busy: s.busy };
  for (const fn of listeners) fn();
};

/** The session's state for the pane → {item, suggestions, done, busy} or null. */
export const spellState = () => snap;
/** Calls `fn` on each change → unsubscribe. */
export function onSpell(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function onTr({ transaction: tr }) {
  if (!s || !tr.docChanged) return;
  s.start = tr.mapping.map(s.start, -1);
  s.pos = tr.mapping.map(s.pos, 1);
  if (s.item) {
    const from = tr.mapping.map(s.item.from, 1);
    const to = tr.mapping.map(s.item.to, -1);
    s.item = to > from ? { ...s.item, from, to } : null;
  }
}

/** Ends the session (the pane closed or another check started). */
export function endSpell() {
  if (!s) return;
  s.ed.off('transaction', onTr);
  if (!s.ed.isDestroyed) tell(s.ed.view, { current: null });
  s = null;
  emit();
}

/** Starts a check of `editor` from its selection's start → the first item, or null when nothing is flagged. */
export async function startSpell(editor) {
  endSpell();
  const start = editor.state.selection.from;
  s = { ed: editor, start, pos: start, wrapped: false, item: null, suggestions: [], done: false, busy: true };
  editor.on('transaction', onTr);
  emit();
  return advance();
}

/** Finds the next item from s.pos, wrapping once to the start; shows it or ends with done. */
async function advance() {
  const me = s;
  if (!me) return null;
  me.busy = true;
  emit();
  const { state } = me.ed;
  let item = await nextFlagged(state, me.pos, me.wrapped ? me.start : Infinity, onceOf(state));
  if (!item && !me.wrapped) {
    me.wrapped = true;
    me.pos = 0;
    item = await nextFlagged(me.ed.state, 0, me.start, onceOf(me.ed.state));
  }
  if (s !== me) return null; // ended or restarted meanwhile
  me.item = item && { from: item.from, to: item.to, word: item.word, kind: item.kind, lang: item.lang,
    sentence: sentenceAround(item.bt.text, item.tok.start, item.tok.end) };
  me.suggestions = item?.kind === 'spell' ? await suggest(item.word) : [];
  if (s !== me) return null;
  me.busy = false;
  me.done = !item;
  if (item) {
    me.ed.chain().setTextSelection({ from: item.from, to: item.to }).scrollIntoView().run();
    tell(me.ed.view, { current: { from: item.from, to: item.to } });
  } else {
    tell(me.ed.view, { current: null });
    finished(me.ed);
  }
  emit();
  return me.item;
}

/** At the end: Readability Statistics while Options > Proofing > Show readability statistics is on. */
function finished(editor) {
  if (!wordSettings(getState().settings).proofing.readability) return;
  const r = readability(parasOf(editor.state.doc, { notes: false }));
  ctxOf().dialog('readabilityStatistics', { stats: r });
}

const moveOn = (pos) => {
  s.pos = pos;
  return advance();
};

/** Replaces the current word with `text` (Change) → the next item. */
export function change(text) {
  const it = s?.item;
  if (!it || !text) return null;
  s.ed.view.dispatch(s.ed.state.tr.insertText(text, it.from, it.to));
  return moveOn(it.from + text.length);
}

/** Replaces every copy of the current word with `text` in one transaction (Change All) → the next item. The copies come from
 * the check's own word list, so deletion-marked text and noProof runs stay as they are; the match is exact, as the check found it. */
export function changeAll(text) {
  const it = s?.item;
  if (!it || !text) return null;
  const { state } = s.ed;
  const env = { opts: proofOpts(), ignored: [], once: [], lang: docLang(state.doc) };
  const hits = [];
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    for (const c of candidates(node, pos, env)) if (c.word === it.word) hits.push([c.from, c.to]);
    return false;
  });
  const tr = state.tr;
  for (const [a, b] of hits.reverse()) tr.insertText(text, a, b);
  s.ed.view.dispatch(tr);
  return moveOn(tr.mapping.map(it.from, -1) + text.length);
}

/** Skips this instance for the session (Ignore Once) → the next item. */
export function ignoreOnce() {
  const it = s?.item;
  if (!it) return null;
  tell(s.ed.view, { once: { from: it.from, to: it.to } });
  return moveOn(it.to);
}

/** Skips the word in the whole document (Ignore All: doc settings ignored) → the next item. */
export function ignoreAll() {
  const it = s?.item;
  if (!it) return null;
  ignoreWord(s.ed, it.word);
  return moveOn(it.to);
}

/** Adds the word to the dictionary (Add to Dictionary) → the next item. */
export async function addToDictionary() {
  const it = s?.item;
  if (!it) return null;
  await addWord(it.word);
  return s && moveOn(it.to);
}

/** Deletes a repeated word with the space before it (Delete Repeated Word) → the next item. */
export function deleteRepeat() {
  const it = s?.item;
  if (!it || it.kind !== 'repeat') return null;
  const { doc } = s.ed.state;
  let from = it.from;
  while (from > 0 && /[ \t\u00a0]/.test(doc.textBetween(from - 1, from, '', ''))) from--;
  s.ed.view.dispatch(s.ed.state.tr.delete(from, it.to));
  return moveOn(from);
}

