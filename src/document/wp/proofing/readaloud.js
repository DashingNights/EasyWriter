// Read Aloud (docs/plans/word briefs/proofing.md, index-editing.md Read Aloud): speechSynthesis reads from the caret, or only the
// selection, one utterance per paragraph, and the word being spoken is highlighted from each 'boundary' event's charIndex and kept
// in view. Voices without boundary events get the whole paragraph highlighted. A click in the text moves the reading there; while it
// reads, Ctrl+Space plays or pauses, Ctrl+Left and Ctrl+Right step paragraphs and Alt+Left and Alt+Right change the speed.
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { getState } from '../../../app/store.js';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { tell } from './plugin.js';
import { docLang } from './spell.js';

/** The speech service: the harness stub when a case set one, else the page's speechSynthesis. */
const speech = () => globalThis.__wordTest?.speech ?? globalThis.speechSynthesis ?? null;

export const RATES = { min: 0.5, max: 2, step: 0.25 };

let st = { active: false, paused: false, index: 0, count: 0, rate: 1, voice: null };
let ed = null; // the editor being read
let paras = []; // [{text, at, lang}] in reading order
let gen = 0; // bumps on every speak, cancel and stop, so a cancelled utterance's late events do nothing
let char = 0; // the paragraph offset of the word being spoken
const listeners = new Set();

const set = (patch) => {
  st = { ...st, ...patch };
  for (const fn of listeners) fn();
};
/** The reading state → {active, paused, index, count, rate, voice}. */
export const readState = () => st;
/** Calls `fn` on every change of the reading state → unsubscribe. */
export function onRead(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const markOf = (node, name) => node.marks.find((m) => m.type.name === name) ?? null;

/** The paragraphs of `doc` between `from` and `to` as speech reads them → [{text, at, lang}]: deleted text left out, an inline
 * object or a line break as a space; at[i] is the document position of text[i]. */
function parasOf(doc, from, to) {
  const lang = docLang(doc);
  const out = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    const at = [];
    let tag = null;
    node.forEach((child, offset) => {
      const p = pos + 1 + offset;
      if (p + child.nodeSize <= from || p >= to) return;
      if (child.isText) {
        if (markOf(child, 'deletion')) return;
        tag ??= markOf(child, 'textStyle')?.attrs?.lang?.val ?? null;
        for (let i = 0; i < child.text.length; i++) {
          if (p + i < from || p + i >= to) continue;
          text += child.text[i];
          at.push(p + i);
        }
      } else {
        text += ' ';
        at.push(p);
      }
    });
    if (text.trim()) out.push({ text, at, lang: tag ?? lang });
    return false;
  });
  return out;
}

/** Highlights document range [from, to) of the editor being read (null clears) and keeps it in view. */
function highlight(range) {
  if (!ed || ed.isDestroyed) return;
  tell(ed.view, { read: range });
  if (range) requestAnimationFrame(() => ed?.view.dom.querySelector('.w-read-word')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}

/** The voice of the settings among speechSynthesis's voices: the saved name, else one for `lang`, else the default. */
function voiceFor(lang) {
  const voices = speech()?.getVoices?.() ?? [];
  const saved = st.voice && voices.find((v) => v.name === st.voice || v.voiceURI === st.voice);
  if (saved) return saved;
  const base = String(lang ?? '').split('-')[0].toLowerCase();
  return voices.find((v) => v.lang?.toLowerCase() === String(lang).toLowerCase())
    ?? voices.find((v) => v.lang?.toLowerCase().split(/[-_]/)[0] === base) ?? voices.find((v) => v.default) ?? null;
}

/** Speaks paragraph `i` from its offset `offset`. */
function speak(i, offset = 0) {
  const S = speech();
  const p = paras[i];
  if (!S || !p) return stop();
  const g = ++gen;
  S.cancel?.();
  if (st.paused) S.resume?.(); // Chromium keeps a queue paused, so a new paragraph after a pause would stay silent
  char = offset;
  set({ index: i, paused: false });
  const u = new SpeechSynthesisUtterance(p.text.slice(offset));
  u.rate = st.rate;
  if (p.lang) u.lang = p.lang;
  const voice = voiceFor(p.lang);
  try {
    if (voice) u.voice = voice;
  } catch {
    // a stub's plain voice object is no SpeechSynthesisVoice; the default voice reads then
  }
  const whole = () => highlight({ from: p.at[offset] ?? p.at[0], to: p.at[p.at.length - 1] + 1 });
  u.onstart = () => g === gen && whole();
  u.onboundary = (e) => {
    if (g !== gen || (e.name && e.name !== 'word')) return;
    const at = offset + (e.charIndex ?? 0);
    const len = e.charLength || (p.text.slice(at).match(/^\S+/)?.[0].length ?? 1);
    char = at;
    highlight({ from: p.at[at], to: p.at[Math.min(p.at.length, at + len) - 1] + 1 });
  };
  const next = () => {
    if (g !== gen) return;
    if (i + 1 < paras.length) speak(i + 1);
    else stop();
  };
  u.onend = next;
  u.onerror = (e) => {
    if (e?.error !== 'interrupted' && e?.error !== 'canceled') next();
  };
  S.speak(u);
}

/** Starts reading `editor` from its caret, or only its selection. */
export function start(editor) {
  if (!editor || !speech()) return false;
  stop();
  const { state } = editor;
  const { from, to, empty } = state.selection;
  paras = parasOf(state.doc, from, empty ? state.doc.content.size : to);
  if (!paras.length) return false;
  ed = editor;
  const saved = wordSettings(getState().settings).readAloud;
  st = { ...st, rate: saved.rate ?? 1, voice: saved.voice ?? null };
  ed.on('destroy', stop);
  // While it reads, the app's window-capture Ctrl+Space (tool search, actions.js) lets the key through to ReadAloudKeys.
  ed.view.dom.setAttribute('data-reading', '');
  set({ active: true, count: paras.length });
  speak(0);
  return true;
}

/** Starts reading paragraphs `list` ([{text, lang}]) of a canvas draft (proofing/canvas.js): no word highlight, since the engine
 * draws the page, and the bar's buttons in place of the reading keys. */
// ponytail: the spoken word is not highlighted on a canvas draft; a viewport mark from the engine's rects can show it if wanted.
export function startParas(list) {
  if (!speech() || !list?.length) return false;
  stop();
  paras = list.map((p) => ({ text: p.text, at: [], lang: p.lang }));
  const saved = wordSettings(getState().settings).readAloud;
  st = { ...st, rate: saved.rate ?? 1, voice: saved.voice ?? null };
  set({ active: true, count: paras.length });
  speak(0);
  return true;
}

/** Stops reading and hides the bar. */
export function stop() {
  gen++;
  if (st.active) speech()?.cancel?.();
  if (ed) {
    ed.off('destroy', stop);
    if (!ed.isDestroyed) {
      ed.view.dom.removeAttribute('data-reading');
      tell(ed.view, { read: null });
    }
  }
  ed = null;
  paras = [];
  set({ active: false, paused: false, index: 0, count: 0 });
}

/** Plays or pauses. */
export function toggle() {
  const S = speech();
  if (!st.active || !S) return;
  if (st.paused) {
    S.resume?.();
    set({ paused: false });
  } else {
    S.pause?.();
    set({ paused: true });
  }
}

/** Steps `d` paragraphs (-1 or 1), staying inside the text. */
export function step(d) {
  if (!st.active) return;
  speak(Math.max(0, Math.min(paras.length - 1, st.index + d)));
}

/** Sets the reading speed to `rate` (0.5 to 2) and the voice to `voice` (a name, or undefined to keep it); a running paragraph
 * goes on from its word at the new setting. Both are saved in settings.word.readAloud. */
export function configure({ rate = st.rate, voice = st.voice } = {}) {
  const r = Math.round(Math.min(RATES.max, Math.max(RATES.min, rate)) * 100) / 100;
  const changed = r !== st.rate || voice !== st.voice;
  set({ rate: r, voice });
  if (changed) saveWord({ readAloud: { rate: r, voice } }).catch(() => {});
  if (changed && st.active && !st.paused) speak(st.index, char);
}

/** Moves the reading to document position `pos` (a click in the text). */
function jump(pos) {
  const i = paras.findIndex((p) => pos >= p.at[0] && pos <= p.at[p.at.length - 1] + 1);
  if (i < 0) return;
  let k = paras[i].at.findIndex((x) => x >= pos);
  if (k < 0) k = 0;
  while (k > 0 && /\S/.test(paras[i].text[k - 1])) k--;
  speak(i, k);
}

const isKey = (e, key, mod) => e.key === key && (mod === 'ctrl' ? e.ctrlKey && !e.altKey : e.altKey && !e.ctrlKey) && !e.shiftKey && !e.metaKey;

/** The reading keys, above WordKeys (1200) so Ctrl+Space does not also reset the character formatting while it reads. */
export const ReadAloudKeys = Extension.create({
  name: 'wordReadAloudKeys',
  priority: 1300,
  addProseMirrorPlugins: () => [new Plugin({
    props: {
      handleKeyDown(view, e) {
        if (!st.active || view.dom.editor !== ed) return false;
        if (isKey(e, ' ', 'ctrl')) toggle();
        else if (isKey(e, 'ArrowLeft', 'ctrl')) step(-1);
        else if (isKey(e, 'ArrowRight', 'ctrl')) step(1);
        else if (isKey(e, 'ArrowLeft', 'alt')) configure({ rate: st.rate - RATES.step });
        else if (isKey(e, 'ArrowRight', 'alt')) configure({ rate: st.rate + RATES.step });
        else return false;
        e.preventDefault();
        return true;
      },
      handleClick(view, pos) {
        if (st.active && view.dom.editor === ed) jump(pos);
        return false;
      },
    },
  })],
});
