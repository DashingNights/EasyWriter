// Track Changes (docs/plans/word/briefs/tracking.md): the recording plugin (record.mjs) on every Document editor but the comment
// story, Accept and Reject (resolve.mjs) with the agents' suggestions beside them, Previous and Next over both, Display for Review
// (data-markup on the editor root, drawn by style.css and the scoped sheet of colors.mjs), Lock Tracking and the tab row's
// Editing, Reviewing and Viewing menu.
import { Extension } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { acceptActive, acceptAll as acceptAllSuggestions, rejectActive, rejectAll as rejectAllSuggestions, showSuggestion } from '../../../app/actions.js';
import { getState, setState, subscribe } from '../../../app/store.js';
import { agentCallOf, setActive } from '../../../suggest/extension.js';
import { commandOf, ctxOf } from '../../../tooling/registry.js';
import { REASONS } from '../../../tooling/reasons.mjs';
import { revisionsOf } from '../../model/review.mjs';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { accountName, authorOf } from '../comments/comments.mjs';
import { barsPlugin } from './bars.mjs';
import { CHANGED, markupCss } from './colors.mjs';
import { LockTracking } from './LockTracking.jsx';
import { forcedOn, REV_MARKS, trackingOn, trackingPlugin } from './record.mjs';
import { resolveTr } from './resolve.mjs';
import './engine.js'; // the sessions follow the Review settings, and the Review rows' app side (canvas drafts)

const word = () => wordSettings(getState().settings);
/** The author of new revisions: Track Changes Options' author, else the user name, else the OS account, else 'Author'. */
const userOf = () => authorOf(word().user, accountName(), word().tracking?.author);
const displayOf = () => word().tracking?.display ?? 'all';

// ---------- the editor extension ----------

let seq = 0;
/** data-track and data-markup on the editor root, and the editor's markup sheet; a click on a change bar switches between Simple
 * and All Markup. */
function displayPlugin() {
  const id = `t${++seq}`;
  const scope = `.ProseMirror.ProseMirror[data-track="${id}"]`;
  return new Plugin({
    props: {
      attributes: () => ({ 'data-track': id, 'data-markup': displayOf() }),
      handleDOMEvents: {
        mousedown(view, e) {
          const d = displayOf();
          const block = e.target instanceof Element ? e.target.closest(CHANGED) : null;
          const lines = word().tracking?.lines;
          // All Markup with lines 'none' draws no bar, so there is nothing to click.
          if ((d !== 'simple' && d !== 'all') || (d === 'all' && lines === 'none') || !block || !view.dom.contains(block)) return false;
          const r = block.getBoundingClientRect();
          if (lines === 'right' ? e.clientX <= r.right : e.clientX >= r.left) return false;
          e.preventDefault();
          saveWord({ tracking: { display: d === 'simple' ? 'all' : 'simple' } });
          return true;
        },
      },
    },
    view(view) {
      let el = null;
      let drawn = null;
      let shown = displayOf();
      const render = () => {
        if (view.isDestroyed || !view.dom.isConnected) return; // the assistant's hidden session editors draw nothing
        const t = word().tracking;
        const people = view.state.doc.attrs.people ?? [];
        if (drawn?.t === t && drawn.people === people) return;
        drawn = { t, people };
        if (!el) {
          el = view.dom.ownerDocument.createElement('style');
          el.dataset.trackStyles = id;
          view.dom.ownerDocument.head.append(el);
        }
        el.textContent = markupCss(scope, t, people);
      };
      const off = subscribe(() => {
        render();
        const d = displayOf();
        if (d === shown || view.isDestroyed) return;
        shown = d;
        view.setProps({}); // attributes() again, so data-markup follows the setting
      });
      render();
      return { update: render, destroy: () => { off(); el?.remove(); } };
    },
  });
}

const storyOf = (editor) => editor.options.editorProps?.attributes?.['data-story'] ?? null;

/** Recording and display on every Document editor; the comment story only displays. */
export const Tracking = Extension.create({
  name: 'wordTracking',
  addProseMirrorPlugins() {
    const editor = this.editor;
    const story = storyOf(editor);
    if (story === 'comment') return [displayPlugin(), barsPlugin()];
    // Header and note story docs have no settings of their own: they record while the main editor does.
    const on = story ? () => { const ed = ctxOf().ed; return !!ed && ed !== editor && trackingOn(ed.state.doc); } : trackingOn;
    return [
      trackingPlugin({ user: userOf, settings: () => word().tracking, skip: (tr) => !!agentCallOf(editor, tr), on }),
      displayPlugin(),
      barsPlugin(),
    ];
  },
});

// ---------- Lock Tracking ----------

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** PBKDF2-SHA-512 of `password` with `salt` over `spins` rounds, base64. The password is never stored, logged or sent. */
async function hashOf(password, salt, spins = 100000) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: spins }, key, 512);
  return b64(new Uint8Array(bits));
}
const lockMatches = async (lock, password) => !lock?.hashValue
  || (await hashOf(password ?? '', unb64(lock.saltValue ?? ''), lock.spinCount ?? 100000)) === lock.hashValue;

// ---------- state ----------

const docSettings = (ctx) => ctx.ed?.state.doc.attrs.settings ?? null;
const isOn = (ctx) => !!ctx.ed && trackingOn(ctx.ed.state.doc);
const forced = (ctx) => forcedOn(docSettings(ctx));
const locked = (ctx) => docSettings(ctx)?.lockTracking != null;
const setMode = (mode) => setState({ word: { ...getState().word, mode } });

/** Asks the lock's password; the right one removes the lock. → whether it did. */
async function unlock(ctx) {
  const lock = docSettings(ctx)?.lockTracking;
  const r = await ctx.dialog('lockTracking', { unlock: true });
  if (!r || ctx.ed?.isDestroyed) return false;
  if (!(await lockMatches(lock, r.password))) {
    ctx.toast('That password is not right, so Track Changes stays on.');
    return false;
  }
  ctx.ed.commands.setDocSettings({ lockTracking: null });
  return true;
}

/** Turns recording on or off for the open Document (locked: off asks the password first). → whether it changed. */
async function setTracking(ctx, on) {
  if (!ctx.ed || forced(ctx)) return false;
  if (isOn(ctx) === on) return true;
  if (!on && locked(ctx) && !(await unlock(ctx))) return false;
  ctx.ed.commands.setDocSettings({ trackRevisions: on });
  if (getState().word?.mode !== 'viewing') setMode(on ? 'reviewing' : 'editing');
  return true;
}

/** Sets the Editing or Reviewing mode. protect refuses every doc change while the store mode is viewing, so Viewing is left before
 * tracking writes its doc setting and put back when the switch fails (a wrong password or Cancel). */
async function switchMode(ctx, on, mode) {
  const was = getState().word?.mode;
  if (was === 'viewing') setMode(mode);
  if (!(await setTracking(ctx, on))) {
    if (was === 'viewing') setMode(was);
    return false;
  }
  setMode(mode);
  return true;
}

// The revisions of a doc, read once per doc state, and only when a command runs or the selection asks (hereIds).
const revCache = new WeakMap();
const revs = (doc) => {
  if (!revCache.has(doc)) revCache.set(doc, revisionsOf(doc));
  return revCache.get(doc);
};
// Whether a node or story JSON holds a tracked change, for the ribbon's enabled states on every new doc. Both are cached by
// object identity: a transaction keeps the nodes and story attributes it did not touch, so typing reads again only the changed
// paragraph and the path above it, never the whole doc.
const anyCache = new WeakMap();
const cached = (key, fn) => {
  if (!key || typeof key !== 'object') return false;
  if (!anyCache.has(key)) anyCache.set(key, fn(key));
  return anyCache.get(key);
};
// Story JSON (header and footer parts, a note's content, the comments): any node object with a revision mark or attribute.
const jsonRev = (v) => cached(v, (o) => (o.type && (o.marks?.some?.((m) => REV_MARKS.has(m?.type)) || o.attrs?.markRev || o.attrs?.pChange || o.attrs?.rev))
  || Object.values(o).some(jsonRev));
const nodeRev = (node) => {
  const a = node.attrs;
  if (node.marks.some((m) => REV_MARKS.has(m.type.name)) || a.markRev || a.pChange || a.rev) return true;
  if (jsonRev(a.sect) || jsonRev(a.comments) || (node.type.name === 'noteRef' && jsonRev(a.content))) return true;
  if (node.isLeaf) return false;
  return cached(node, (n) => {
    let found = false;
    n.forEach((c) => { found ||= nodeRev(c); });
    return found;
  });
};
const hasAny = (doc) => nodeRev(doc);
const tracked = (ctx) => !!ctx.target && hasAny(ctx.target.state.doc);
const suggestions = () => (getState().suggestions?.count ?? 0) > 0;
const activeSuggestion = () => getState().suggestions?.active ?? null;
const canReview = (ctx) => !forced(ctx) && (tracked(ctx) || suggestions());

// What markup's filters show: reviewers (people), insertions and deletions, formatting.
function shownPick(ctx) {
  const t = ctx.settings?.word?.tracking ?? {};
  const show = t.show ?? {};
  return (r) => (!Array.isArray(t.people) || t.people.includes(r.author))
    && (r.kind === 'format' || r.kind === 'paraProps' ? show.formatting !== false : show.insDel !== false);
}
const filtersHide = (ctx) => {
  const t = ctx.settings?.word?.tracking ?? {};
  return Array.isArray(t.people) || t.show?.insDel === false || t.show?.formatting === false;
};

/** The tracked revisions of the target's body that the selection touches → their ids. */
function hereIds(ctx) {
  const st = ctx.target?.state;
  if (!st) return new Set();
  const { from, to } = st.selection;
  return new Set(revs(st.doc).filter((r) => r.source === 'tracking' && !r.at && r.from <= to && r.to >= from).map((r) => r.id));
}
const atChange = (ctx) => hereIds(ctx).size > 0 || !!activeSuggestion();

/** Accepts or rejects the change at the selection: tracked revisions there, else the active suggestion. */
function resolveHere(ctx, action) {
  const ids = hereIds(ctx);
  if (ids.size) {
    // A selection resolves only the part of each change it covers; a bare caret resolves the whole change.
    const { from, to, empty } = ctx.target.state.selection;
    const tr = resolveTr(ctx.target.state, action, (r) => ids.has(r.id), { range: empty ? null : { from, to } });
    if (tr) {
      ctx.target.view.dispatch(tr);
      return true;
    }
  }
  if (activeSuggestion()) return (action === 'accept' ? acceptActive() : rejectActive()), true;
  return false;
}

/** Accepts or rejects every tracked change (only those shown with `shown`), stories too from the main editor, then the agents'
 * suggestions; a mixed run is two undo steps. `stop` turns Track Changes off after. */
async function resolveAll(ctx, action, { shown = false, stop = false } = {}) {
  const ed = ctx.target;
  if (!ed) return false;
  const main = ed === ctx.ed;
  const tr = resolveTr(ed.state, action, shown ? shownPick(ctx) : () => true, { stories: main });
  if (tr) ed.view.dispatch(tr);
  if (main && suggestions()) await (action === 'accept' ? acceptAllSuggestions() : rejectAllSuggestions());
  if (stop) await setTracking(ctx, false);
  return true;
}

// ---------- Previous and Next ----------

const REVEAL = { header: 'x.reveal.header', footer: 'x.reveal.footer', note: 'x.reveal.note', comment: 'x.reveal.comment' };
/** Tracked revisions and suggestions in document order (body first), then story revisions whose owner can reveal them. */
function stepList(doc) {
  const all = revs(doc);
  const body = all.filter((r) => !r.at && r.kind !== 'attr').sort((x, y) => x.from - y.from);
  return [...body, ...all.filter((r) => r.at && commandOf(REVEAL[r.at.story]))];
}

function step(ctx, dir) {
  const ed = ctx.target;
  if (!ed) return false;
  const list = stepList(ed.state.doc);
  if (!list.length) return false;
  const act = activeSuggestion();
  const cur = act && list.find((r) => r.source === 'suggestion' && (r.id === act || String(act).startsWith(`${r.id}-`)));
  const sel = ed.state.selection;
  const ref = cur ? cur.from : sel.from;
  const strict = !!cur || !sel.empty;
  const body = list.filter((r) => !r.at);
  // After the last body change come the story changes (list holds them after the body), then the wrap to the first.
  const next = dir > 0
    ? body.find((r) => r !== cur && (strict ? r.from > ref : r.from >= ref)) ?? list[body.length] ?? list[0]
    : body.findLast((r) => r !== cur && r.from < ref) ?? list.at(-1);
  if (next.source === 'suggestion') return showSuggestion(next.id);
  if (next.at) {
    const { story, ...at } = next.at;
    return ctx.run(REVEAL[story], { ...at, from: next.from, to: next.to });
  }
  if (act && ctx.ed) setActive(ctx.ed, null);
  const doc = ed.state.doc;
  const to = Math.min(next.to, doc.content.size);
  const tr = ed.state.tr.setSelection(TextSelection.between(doc.resolve(next.from), doc.resolve(next.kind === 'paraMark' ? next.from : to)));
  ed.view.dispatch(tr.scrollIntoView());
  ed.view.focus();
  return true;
}

// ---------- commands ----------

// Accept or Reject and Move to Next: with no change at the selection it only moves to the next one.
const andNext = (ctx, action) => (resolveHere(ctx, action), step(ctx, 1));

const T = 'review.tracking.trackChanges';
const A = 'review.tracking.accept';
const R = 'review.tracking.reject';
const DISPLAY = { simple: 'review.markup.displayForReview.simpleMarkup', all: 'review.markup.displayForReview.allMarkup',
  none: 'review.markup.displayForReview.noMarkup', original: 'review.markup.displayForReview.original' };
const MODE = { editing: 'frame.tabRow.editingMode.editing', reviewing: 'frame.tabRow.editingMode.reviewing', viewing: 'frame.tabRow.editingMode.viewing' };
const modeOf = (ctx) => (getState().word?.mode === 'viewing' ? 'viewing' : isOn(ctx) ? 'reviewing' : 'editing');
const noReason = (ctx) => (forced(ctx) ? 'Restrict Editing keeps Track Changes on.' : null);
const review = (fn) => ({ run: fn, enabled: canReview, reason: noReason });

async function openOwned(ctx, id, props) {
  // The dialog may belong to a package not merged yet: say so instead of opening nothing.
  const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js');
  if (!WORD_DIALOGS[id]) return ctx.toast(REASONS.pending), false;
  return ctx.dialog(id, props);
}

const commands = {
  [T]: { run: (ctx) => setTracking(ctx, !isOn(ctx)), active: isOn, enabled: (ctx) => !!ctx.ed && !forced(ctx), reason: noReason },
  [`${T}.forEveryone`]: { run: (ctx) => setTracking(ctx, !isOn(ctx)), active: isOn, enabled: (ctx) => !!ctx.ed && !forced(ctx), reason: noReason },
  [`${T}.lockTracking`]: {
    active: locked,
    enabled: (ctx) => !!ctx.ed && !forced(ctx),
    async run(ctx) {
      if (locked(ctx)) return unlock(ctx);
      const r = await ctx.dialog('lockTracking', {});
      if (!r || !ctx.ed || ctx.ed.isDestroyed) return false;
      let lock = {};
      if (r.password) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        lock = { algorithmName: 'PBKDF2-SHA-512', hashValue: await hashOf(r.password, salt), saltValue: b64(salt), spinCount: 100000 };
      }
      ctx.ed.commands.setDocSettings({ trackRevisions: true, lockTracking: lock });
      if (getState().word?.mode !== 'viewing') setMode('reviewing');
      return true;
    },
  },
  [A]: review((ctx) => andNext(ctx, 'accept')),
  [`${A}.acceptAndMoveToNext`]: review((ctx) => andNext(ctx, 'accept')),
  [`${A}.acceptThisChange`]: { run: (ctx) => resolveHere(ctx, 'accept'), enabled: (ctx) => !forced(ctx) && atChange(ctx), reason: noReason },
  [`${A}.acceptAllChangesShown`]: { run: (ctx) => resolveAll(ctx, 'accept', { shown: true }), enabled: (ctx) => canReview(ctx) && filtersHide(ctx) },
  [`${A}.acceptAllChanges`]: review((ctx) => resolveAll(ctx, 'accept')),
  [`${A}.acceptAllChangesAndStopTracking`]: review((ctx) => resolveAll(ctx, 'accept', { stop: true })),
  [R]: review((ctx) => andNext(ctx, 'reject')),
  [`${R}.rejectAndMoveToNext`]: review((ctx) => andNext(ctx, 'reject')),
  [`${R}.rejectChange`]: { run: (ctx) => resolveHere(ctx, 'reject'), enabled: (ctx) => !forced(ctx) && atChange(ctx), reason: noReason },
  [`${R}.rejectAllChangesShown`]: { run: (ctx) => resolveAll(ctx, 'reject', { shown: true }), enabled: (ctx) => canReview(ctx) && filtersHide(ctx) },
  [`${R}.rejectAllChanges`]: review((ctx) => resolveAll(ctx, 'reject')),
  [`${R}.rejectAllChangesAndStopTracking`]: review((ctx) => resolveAll(ctx, 'reject', { stop: true })),
  'review.tracking.previous': { run: (ctx) => step(ctx, -1), enabled: (ctx) => tracked(ctx) || suggestions() },
  'review.tracking.next': { run: (ctx) => step(ctx, 1), enabled: (ctx) => tracked(ctx) || suggestions() },

  'review.markup.displayForReview': { value: () => DISPLAY[displayOf()] ?? DISPLAY.all, run: (ctx, arg) => (arg ? ctx.run(arg) : true) },
  ...Object.fromEntries(Object.entries(DISPLAY).map(([d, id]) => [id, { active: () => displayOf() === d, run: () => saveWord({ tracking: { display: d } }) }])),

  'frame.tabRow.editingMode': { value: (ctx) => MODE[modeOf(ctx)], run: (ctx, arg) => (arg ? ctx.run(arg) : true) },
  [MODE.editing]: {
    active: (ctx) => modeOf(ctx) === 'editing',
    run: (ctx) => switchMode(ctx, false, 'editing'),
  },
  [MODE.reviewing]: {
    active: (ctx) => modeOf(ctx) === 'reviewing',
    enabled: (ctx) => !!ctx.ed,
    run: (ctx) => switchMode(ctx, true, 'reviewing'),
  },
  [MODE.viewing]: { active: (ctx) => modeOf(ctx) === 'viewing', run: () => (setMode('viewing'), true) },

  'tracking.userName': { run: (ctx) => openOwned(ctx, 'wordOptions', { page: 'general' }) },
  'tracking.authorColors': { run: (ctx) => openOwned(ctx, 'advancedTrackChangesOptions') },
};

// The store fields tracking reads and writes, for harness cases (which cannot import the store).
if (typeof window !== 'undefined') {
  window.__word = Object.assign(window.__word ?? {}, {
    tracking: { mode: () => getState().word?.mode ?? 'editing', suggestions: () => getState().suggestions ?? null },
  });
}

export default {
  id: 'tracking',
  extensions: [Tracking],
  commands,
  dialogs: { lockTracking: LockTracking },
  // keys.trackKey is Ctrl+Shift+E on review.tracking.trackChanges (keymap.mjs); the rest are behaviours of the recording plugin.
  implements: ['keys.trackKey', 'tracking.userEdits', 'tracking.marks', 'tracking.formatting', 'tracking.moves', 'tracking.tables'],
};
