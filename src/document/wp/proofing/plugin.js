// Spelling as you type (docs/plans/word briefs/proofing.md): Chromium draws the red squiggles; this plugin turns them off where Word
// would not check (ignored words, UPPERCASE, words with digits, addresses, deleted text, languages without a dictionary, Ignore Once)
// with spellcheck="false" decorations, draws repeated words with a red wavy line, and switches the editor's spellcheck off while
// Check spelling as you type is off or Hide spelling errors is on. It also holds the Ignore Once ranges (mapped through every
// transaction), the word Read Aloud is speaking and the word the Spelling pane is on.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getState, subscribe } from '../../../app/store.js';
import { changedSet } from '../page-engine/decorations.js';
import { blockText, docLang, inOnce, onLanguages, proofOpts, rangeOf } from './spell.js';
import { ignoredKind, isIgnored, repeats, tokens } from './words.mjs';

export const proofKey = new PluginKey('wordProofing');

const QUIET = { spellcheck: 'false' };
const REPEAT = { class: 'w-proof-repeat', spellcheck: 'false' };

/** Whether spelling marks show at all: the app's spell checker on, Check spelling as you type on, Hide spelling errors off. */
const showing = (opts) => getState().settings?.spellCheck !== false && opts.asYouType !== false && !opts.hideSpelling;

/** The decorations of textblock `node` at `pos` under `env` ({opts, ignored, once, lang}). */
function blockDecos(node, pos, env) {
  const bt = blockText(node, pos, env.lang);
  const out = bt.quiet.map(([a, b]) => Decoration.inline(a, b, QUIET));
  const list = tokens(bt.text);
  const reps = new Set(env.opts.flagRepeated ? repeats(list, bt.text) : []);
  for (const tok of list) {
    const r = rangeOf(bt, tok);
    const once = inOnce(r, env.once);
    if (reps.has(tok) && !once) out.push(Decoration.inline(r.from, r.to, REPEAT));
    else if (once || ignoredKind(tok, env.opts) || isIgnored(tok.word, env.ignored)) out.push(Decoration.inline(r.from, r.to, QUIET));
  }
  return out;
}

const envOf = (doc, once) => ({ opts: proofOpts(), ignored: doc.attrs.settings?.ignored ?? [], once, lang: docLang(doc) });

/** Every textblock's decorations in `doc`; with `prev`, the set they replace, only those that differ are swapped (changedSet: a
 * refresh when the spelling languages load changes few). */
function build(doc, once, prev = null) {
  const env = envOf(doc, once);
  if (!showing(env.opts)) return DecorationSet.empty;
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    out.push(...blockDecos(node, pos, env));
    return false;
  });
  return prev ? changedSet(doc, prev, out) : DecorationSet.create(doc, out);
}

/** The ranges of `tr`'s new doc its steps touched → [[from, to]]. */
function touched(tr) {
  const out = [];
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_a, _b, from, to) => out.push([rest.map(from, -1), rest.map(to, 1)]));
  });
  return out;
}

/** `decos` with the textblocks of `doc` that `ranges` ([[from, to]]) touch rebuilt. */
function patch(decos, doc, ranges, once) {
  const env = envOf(doc, once);
  if (!showing(env.opts)) return DecorationSet.empty;
  const seen = new Set();
  let set = decos;
  for (const [from, to] of ranges) {
    doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos) => {
      if (!node.isTextblock) return true;
      if (seen.has(pos)) return false;
      seen.add(pos);
      set = set.remove(set.find(pos, pos + node.nodeSize)).add(doc, blockDecos(node, pos, env));
      return false;
    });
  }
  return set;
}

const mapRange = (r, mapping) => {
  if (!r) return null;
  const from = mapping.map(r.from, 1);
  const to = mapping.map(r.to, -1);
  return to > from ? { from, to } : null;
};

/** Sets the editor root's spellcheck to the options (PM's own attributes say true and win over plugin props, so the DOM is set). */
function rootSpellcheck(view) {
  const want = showing(proofOpts()) ? 'true' : 'false';
  if (view.dom.getAttribute('spellcheck') === want) return;
  // The DOM observer would read our attribute write as a change of the document; pause it around the write.
  view.domObserver?.stop?.();
  view.dom.setAttribute('spellcheck', want);
  view.domObserver?.start?.();
}

/** Dispatches a meta transaction `meta` on `view` (no history step, no doc change). */
export const tell = (view, meta) => view.dispatch(view.state.tr.setMeta(proofKey, meta).setMeta('addToHistory', false));

const plugin = () => new Plugin({
  key: proofKey,
  state: {
    init: (_c, state) => ({ decos: build(state.doc, []), once: [], read: null, current: null }),
    apply(tr, old, oldState) {
      const meta = tr.getMeta(proofKey) ?? {};
      let once = tr.docChanged ? old.once.map((r) => mapRange(r, tr.mapping)).filter(Boolean) : old.once;
      if (meta.once) once = [...once, meta.once];
      if (meta.clearOnce) once = [];
      const read = 'read' in meta ? meta.read : tr.docChanged ? mapRange(old.read, tr.mapping) : old.read;
      const current = 'current' in meta ? meta.current : tr.docChanged ? mapRange(old.current, tr.mapping) : old.current;
      const ignoredChanged = tr.doc.attrs.settings?.ignored !== oldState.doc.attrs.settings?.ignored;
      let decos;
      if (meta.refresh || meta.clearOnce || ignoredChanged) decos = build(tr.doc, once, tr.docChanged ? null : old.decos);
      else {
        decos = tr.docChanged ? old.decos.map(tr.mapping, tr.doc) : old.decos;
        if (tr.docChanged) decos = patch(decos, tr.doc, touched(tr), once);
        if (meta.once) decos = patch(decos, tr.doc, [[meta.once.from, meta.once.to]], once);
      }
      return { decos, once, read, current };
    },
  },
  props: {
    decorations(state) {
      const s = proofKey.getState(state);
      const extra = [];
      if (s.read) extra.push(Decoration.inline(s.read.from, s.read.to, { class: 'w-read-word' }));
      if (s.current) extra.push(Decoration.inline(s.current.from, s.current.to, { class: 'w-proof-current' }));
      return extra.length ? s.decos.add(state.doc, extra) : s.decos;
    },
  },
  view(view) {
    rootSpellcheck(view);
    // Any settings save makes a new settings object, so the options are compared by value.
    const optsKey = () => JSON.stringify([proofOpts(), getState().settings?.spellCheck]);
    let last = optsKey();
    let queued = false;
    const refresh = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (view.isDestroyed) return;
        rootSpellcheck(view);
        tell(view, { refresh: true });
      });
    };
    // Settings changes (Options > Proofing, the status bar's spell check switch) and the dictionary languages redraw the marks.
    const offStore = subscribe(() => {
      const now = optsKey();
      if (now === last) return;
      last = now;
      refresh();
    });
    const offLangs = onLanguages(refresh);
    return {
      update: () => rootSpellcheck(view),
      destroy() {
        offStore();
        offLangs();
      },
    };
  },
});

/** The plugin as a TipTap extension of the Document kit. */
export const ProofingMarks = Extension.create({
  name: 'wordProofing',
  addProseMirrorPlugins: () => [plugin()],
});

/** The Ignore Once ranges of `state`. */
export const onceOf = (state) => proofKey.getState(state)?.once ?? [];
