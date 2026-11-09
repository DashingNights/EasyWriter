// Spelling over the document (docs/plans/word briefs/proofing.md): each paragraph's text as spelling reads it, the dictionary
// service (Chromium's checker through api.word.spell, or a harness stub, plan.md §1.16), and the walk that finds the next flagged
// word or repeated word. Main text and text boxes only; notes, headers, footers and comments live in attributes (recorded).
import { getState } from '../../../app/store.js';
import { wordSettings } from '../../word/settings.mjs';
import { served } from './languages.mjs';
import { ignoredKind, isIgnored, repeats, tokens } from './words.mjs';

/** The spell service: the harness stub when a case set one, else preload's api.word.spell. */
export const spellApi = () => globalThis.__wordTest?.spell ?? window.api?.word?.spell ?? null;

/** The proofing options now (settings.word.proofing with defaults). */
export const proofOpts = () => wordSettings(getState().settings).proofing;

let dicts = null; // the languages Chromium checks against (api.word.spell.languages().current); null until asked
let available = null; // the dictionaries Chromium can load
const langListeners = new Set();

/** Asks the spell service for its languages again; listeners hear when the answer arrives. */
export async function refreshLanguages() {
  try {
    const r = await spellApi()?.languages?.();
    dicts = Array.isArray(r?.current) ? r.current : null;
    available = Array.isArray(r?.available) ? r.available : null;
  } catch {
    dicts = null;
  }
  for (const fn of langListeners) fn();
}
/** The enabled dictionary languages (null: not known yet, so nothing is skipped for its language). */
export const dictLangs = () => dicts;
/** The dictionaries the spell service could load (null: not known). */
export const availableLangs = () => available;
/** Calls `fn` when the languages change → unsubscribe. */
export function onLanguages(fn) {
  langListeners.add(fn);
  return () => langListeners.delete(fn);
}

const added = new Set(); // words added to the dictionary this session (Chromium's own cache can lag behind the add)

/** Adds `word` to the user dictionary through the spell service. */
export async function addWord(word) {
  added.add(word.toLowerCase());
  await spellApi()?.add?.(word);
}

/** Puts `word` on the document's Ignore All list (doc settings ignored) unless it is there already, case ignored. */
export function ignoreWord(ed, word) {
  const old = ed.state.doc.attrs.settings?.ignored ?? [];
  if (!isIgnored(word, old)) ed.commands.setDocSettings({ ignored: [...old, word] });
}

/** Whether the dictionary flags `word` (false without a spell service). */
export async function misspelled(word) {
  if (added.has(word.toLowerCase())) return false;
  try {
    return !!(await spellApi()?.misspelled?.(word));
  } catch {
    return false;
  }
}

/** Suggestions for `word` → string[]. */
export async function suggest(word) {
  try {
    const r = await spellApi()?.suggest?.(word);
    return Array.isArray(r) ? r.slice(0, 8) : [];
  } catch {
    return [];
  }
}

const markOf = (node, name) => node.marks.find((m) => m.type.name === name) ?? null;
/** The document's default run language (doc.attrs.styles.defaults.run.lang.val) or null. */
export const docLang = (doc) => doc.attrs.styles?.defaults?.run?.lang?.val ?? null;

/** Textblock `node` at `pos` as spelling reads it → {text, at, quiet, langs}: text holds ￼ where spelling skips (inline objects,
 * deletion-marked text, noProof runs, runs in a language no enabled dictionary serves); at[i] is the document position of text[i];
 * quiet lists the [from, to) ranges skipped for deletion or language, which need spellcheck="false" (noProof draws its own);
 * langs lists [start, end, tag] per run. */
export function blockText(node, pos, lang = null) {
  let text = '';
  const at = [];
  const quiet = [];
  const langs = [];
  node.forEach((child, offset) => {
    const p = pos + 1 + offset;
    if (child.isText) {
      const style = markOf(child, 'textStyle')?.attrs;
      const tag = style?.lang?.val ?? lang;
      const del = !!markOf(child, 'deletion');
      const unserved = !!tag && !!dicts && !served(tag, dicts);
      const skip = del || unserved || !!style?.noProof;
      if (del || unserved) quiet.push([p, p + child.text.length]);
      langs.push([text.length, text.length + child.text.length, tag]);
      text += skip ? '\ufffc'.repeat(child.text.length) : child.text;
      for (let i = 0; i < child.text.length; i++) at.push(p + i);
    } else {
      text += child.type.name === 'hardBreak' ? '\n' : '\ufffc';
      at.push(p);
    }
  });
  return { text, at, quiet, langs };
}

/** The range of token `tok` of a blockText `bt` → {from, to}. */
export const rangeOf = (bt, tok) => ({ from: bt.at[tok.start], to: bt.at[tok.end - 1] + 1 });

/** Whether range `r` is one of the Ignore Once ranges `once`. */
export const inOnce = (r, once) => once.some((o) => o.from === r.from && o.to === r.to);

/** The candidates of textblock `node` at `pos` under `opts` → [{from, to, word, kind: 'spell'|'repeat', lang, bt, tok}] in order,
 * before the dictionary is asked: every word the options leave to the checker, and every repeated word. */
export function candidates(node, pos, { opts, ignored, once, lang }) {
  const bt = blockText(node, pos, lang);
  const list = tokens(bt.text);
  const reps = new Set(opts.flagRepeated ? repeats(list, bt.text) : []);
  const out = [];
  for (const tok of list) {
    const r = rangeOf(bt, tok);
    if (inOnce(r, once)) continue;
    const tag = bt.langs.find(([a, b]) => tok.start >= a && tok.start < b)?.[2] ?? lang;
    if (reps.has(tok)) out.push({ ...r, word: tok.word, kind: 'repeat', lang: tag, bt, tok });
    else if (!ignoredKind(tok, opts) && !isIgnored(tok.word, ignored)) out.push({ ...r, word: tok.word, kind: 'spell', lang: tag, bt, tok });
  }
  return out;
}

/** The first flagged item of `state`'s main text with from >= `from` and from < `to` → the item or null. `once` holds the
 * Ignore Once ranges. A repeated word is flagged by position; any other candidate when the dictionary flags it. */
export async function nextFlagged(state, from, to, once = []) {
  const opts = proofOpts();
  const ignored = state.doc.attrs.settings?.ignored ?? [];
  const lang = docLang(state.doc);
  const blocks = [];
  state.doc.nodesBetween(Math.max(0, from), Math.min(to, state.doc.content.size), (node, pos) => {
    if (!node.isTextblock) return true;
    blocks.push([node, pos]);
    return false;
  });
  for (const [node, pos] of blocks) {
    for (const c of candidates(node, pos, { opts, ignored, once, lang })) {
      if (c.from < from || c.from >= to) continue;
      if (c.kind === 'repeat' || await misspelled(c.word)) return c;
    }
  }
  return null;
}

/** Every flagged word of `state`'s main text → the count (the status bar's proofing value). */
export async function flaggedCount(state, once = []) {
  const opts = proofOpts();
  const ignored = state.doc.attrs.settings?.ignored ?? [];
  const lang = docLang(state.doc);
  const cache = new Map();
  let n = 0;
  const jobs = [];
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    jobs.push([node, pos]);
    return false;
  });
  // Words already looked up are counted without a wait, so a long document ran in tasks of about 80 ms: the count gives the
  // window back every 8 ms.
  let slice = performance.now();
  for (const [node, pos] of jobs) {
    if (performance.now() - slice > 8) {
      await (globalThis.scheduler?.yield?.() ?? new Promise((r) => setTimeout(r, 0)));
      slice = performance.now();
    }
    for (const c of candidates(node, pos, { opts, ignored, once, lang })) {
      if (c.kind === 'repeat') n++;
      else {
        const key = c.word;
        if (!cache.has(key)) cache.set(key, await misspelled(key));
        if (cache.get(key)) n++;
      }
    }
  }
  return n;
}
