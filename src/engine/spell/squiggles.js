// Spelling as you type in the canvas editor (docs/plans/engine/plan.md section 1, briefs/engine-a11y.md): the words of the visible
// pages' paragraphs go to the checker in one batch, misspelled and repeated words become squiggles (rectangles from the engine,
// drawn as the viewport's 'squiggle' marks), and the context menu offers suggestions, Add to Dictionary and Ignore All. The word
// rules (UPPERCASE, numbers, addresses, repeated words) and the menu card are the DOM editor's own: the host passes them in
// (`rules`: {tokens, repeats, ignoredKind, isIgnored, served} from src/document/wp/proofing; `menu`: spellingEntries), since the
// engine imports nothing of the app (viewport-design.md section 3).
import { blocksOf, rpc, textBlocks } from '../a11y/blocks.js';

const WAIT = 150; // ms after a layout before checking: typing lays out every key, and the worker has pages to paint

/** The words of text block `b` spelling looks at → [{start, end, word, kind: 'spell'|'repeat', lang, cut?}]. Runs marked Do not
 * check spelling and runs in a language no dictionary of `dicts` serves are skipped; `opts` are the proofing options, `ignored`
 * the Ignore All words, `once` the Ignore keys (onceKey), `lang` the document's language, `rules` the word rules. A repeat's cut
 * is the range Delete Repeated Word removes. Pure. */
export function candidates(b, { opts = {}, ignored = [], once = new Set(), dicts = null, lang = null, rules } = {}) {
  const { tokens, repeats, ignoredKind, isIgnored, served } = rules;
  let text = b.text ?? '';
  const mask = (s, e) => {
    text = text.slice(0, s) + '￼'.repeat(Math.max(0, e - s)) + text.slice(e);
  };
  for (const [s, e] of b.noproof ?? []) mask(s, e);
  for (const [s, e, tag] of b.langs ?? []) if (tag && dicts && !served(tag, dicts)) mask(s, e);
  const list = tokens(text);
  const reps = new Set(opts.flagRepeated !== false ? repeats(list, text) : []);
  const out = [];
  list.forEach((tok, i) => {
    if (once.has(onceKey(b.id, tok))) return;
    const tag = (b.langs ?? []).find(([s, e]) => tok.start >= s && tok.start < e)?.[2] ?? lang;
    const base = { start: tok.start, end: tok.end, word: tok.word, lang: tag };
    if (reps.has(tok)) out.push({ ...base, kind: 'repeat', cut: [list[i - 1].end, tok.end] });
    else if (!ignoredKind(tok, opts) && !isIgnored(tok.word, ignored)) out.push({ ...base, kind: 'spell' });
  });
  return out;
}

/** The Ignore key of token `tok` of paragraph `id`. */
const onceKey = (id, tok) => `${id}\n${tok.start}\n${tok.word}`;

/** Spelling for engine `client` with `checker` (checker.js) → {setPages, refresh, forPage, at, menu, run, subscribe, destroy}.
 * `options()` gives the proofing options now: settings.word.proofing plus `on` (settings.spellCheck); `lang()` the document's
 * language; `rules` and `menu` the word rules and the spelling menu's entries (see the note above). Ignore All and Ignore last
 * while the document is open. */
export function createSpelling({ client, checker, options = () => ({}), lang = () => null, ignored = [], rules, menu: entries }) {
  let visible = [];
  let items = []; // [{id, start, end, word, kind, lang, cut?, anchor, head, rects}]
  let dicts; // the checker's languages, asked once (null: unknown, nothing skipped for its language)
  let gen = 0;
  let timer = null;
  let last = null; // the check setPages started last, so the same pages again wait for it rather than check again
  const ignoreAll = new Set(ignored);
  const once = new Set();
  const listeners = new Set();

  async function refresh() {
    const my = ++gen;
    clearTimeout(timer);
    const o = options() ?? {};
    let next = [];
    if (o.on !== false && o.asYouType !== false && !o.hideSpelling && visible.length) {
      if (dicts === undefined) dicts = (await checker.languages())?.current ?? null;
      const ctx = { opts: o, ignored: [...ignoreAll], once, dicts, lang: lang(), rules };
      const found = textBlocks(await blocksOf(client, visible)).flatMap((b) => candidates(b, ctx).map((c) => ({ ...c, id: b.id })));
      const words = found.filter((c) => c.kind === 'spell');
      const bad = await checker.check(words);
      const flagged = new Set(words.filter((_, i) => bad[i]));
      next = await Promise.all(found.filter((c) => c.kind === 'repeat' || flagged.has(c)).map(async (c) => {
        const [anchor, head] = await Promise.all([rpc(client, 'posAt', c.id, c.start), rpc(client, 'posAt', c.id, c.end)]);
        return { ...c, anchor, head, rects: (await rpc(client, 'rects', anchor, head)) ?? [] };
      }));
    }
    if (my !== gen) return; // a newer check started meanwhile
    items = next;
    for (const fn of listeners) fn(items);
  }
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, WAIT);
  };

  const offs = [client.on?.('layout', later)];

  return {
    /** The page indexes in view now. */
    setPages(list) {
      const next = [...new Set(list)].sort((a, b) => a - b);
      if (next.join() === visible.join() && last) return last;
      visible = next;
      return (last = refresh());
    },
    /** Checks again now (the proofing options or the dictionary languages changed). */
    refresh(cleared = false) {
      if (cleared) {
        checker.clear();
        dicts = undefined;
      }
      return refresh();
    },
    /** The squiggles with a rectangle on page `page`, each with only those rectangles. */
    forPage: (page) => items.map((it) => ({ ...it, rects: it.rects.filter((r) => r.page === page) })).filter((it) => it.rects.length),
    /** The squiggle at point (x, y) of page `page` (page points), the line under the word included, or null. */
    at: (page, x, y) => items.find((it) => it.rects.some((r) => r.page === page && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h + 3)) ?? null,
    /** The context menu card for squiggle `it` → entries (context-menu/menus.mjs shape, act entries run through run()). */
    async menu(it) {
      if (it.kind === 'repeat') {
        return [{ label: 'Delete Repeated Word', key: 'D', act: 'deleteRepeat' }, { label: 'Ignore', key: 'I', act: 'ignoreOnce' }, { sep: true }];
      }
      // ponytail: Change All needs a replace-all engine command, so the suggestions' submenus keep Read Aloud only until then.
      return entries({ word: it.word, suggestions: await checker.suggest(it.word, it.lang) })
        .map((e) => (e.sub ? { ...e, sub: e.sub.filter((s) => s.act !== 'changeAll') } : e));
    },
    /** Runs menu entry `e` (from menu) on squiggle `it`. */
    async run(it, e) {
      if (e.act === 'replace') {
        await rpc(client, 'select', it.anchor, it.head);
        await rpc(client, 'insertText', e.arg);
      } else if (e.act === 'deleteRepeat') {
        const [a, h] = await Promise.all([rpc(client, 'posAt', it.id, it.cut[0]), rpc(client, 'posAt', it.id, it.cut[1])]);
        await rpc(client, 'select', a, h);
        await rpc(client, 'deleteBackward', 'character');
      } else if (e.act === 'learn') {
        await checker.add(e.arg ?? it.word);
        await refresh();
      } else if (e.act === 'ignoreAll') {
        // ponytail: kept for this session only; engine-model can store the list with the document as the DOM editor's settings.ignored.
        ignoreAll.add(e.arg ?? it.word);
        await refresh();
      } else if (e.act === 'ignoreOnce') {
        once.add(onceKey(it.id, it));
        await refresh();
      } else if (e.act === 'speak') {
        const speech = globalThis.__wordTest?.speech ?? globalThis.speechSynthesis;
        speech?.cancel?.();
        speech?.speak(new SpeechSynthesisUtterance(e.arg));
      }
    },
    /** Calls `fn(items)` after every check → unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      clearTimeout(timer);
      gen++;
      for (const off of offs) off?.();
      listeners.clear();
    },
  };
}
