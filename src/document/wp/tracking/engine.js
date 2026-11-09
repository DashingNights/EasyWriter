// Review on a canvas draft (docs/plans/engine/stage2.md S5): the per-user settings every engine session follows, and the app's
// side of the Review rows (src/document/canvas/rows/review.mjs reviewApp). The author, Track Changes Options, Display for
// Review, Show All (marks) and Print Markup live in settings.word; a session gets them when it first shows and whenever they
// change, and again after the engine restarts it (its 'reopened' event). Its view mode follows the store's view (views/canvas.mjs
// engineView: Outline, Web Layout, Draft, Read Mode and Immersive Reader, and Print Layout for Print Layout and Focus).
import { openPane } from '../../../app/browser.js';
import { getState, setState, subscribe } from '../../../app/store.js';
import { commandOf, ctxOf } from '../../../tooling/registry.js';
import { activeSurface } from '../../../tooling/surface.js';
import { bindReviewApp } from '../../canvas/rows/review.mjs';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { accountName, authorOf } from '../comments/comments.mjs';
import { COLOR_HEX } from '../markup/options.mjs';
import { engineView } from '../views/canvas.mjs';

// Track Changes Options' marks (tracking/colors.mjs markCss) → the engine's review.trackingOptions names.
const MARKS = { underline: 'underline', dunderline: 'doubleUnderline', strike: 'strikethrough', dstrike: 'doubleStrikethrough', bold: 'bold',
  italic: 'italic', color: 'colorOnly', none: 'none', hidden: 'hidden', caret: 'caret', pound: 'hash' };
const DISPLAY = { simple: 'simpleMarkup', all: 'allMarkup', none: 'noMarkup', original: 'original' };
// Show Markup › Balloons (settings.word.tracking.balloons) → review.trackingOptions' names.
const BALLOONS = { revisions: 'revisions', none: 'inline', comments: 'commentsAndFormatting' };

/** A colour choice → 'byAuthor', 'RRGGBB', or undefined when the engine has no form for it ('auto' and unknown names). */
function colorOf(c) {
  if (!c || c === 'byAuthor') return 'byAuthor';
  const hex = /^#?[0-9a-f]{6}$/i.test(c) ? c : COLOR_HEX[c];
  return hex ? hex.replace('#', '').toUpperCase() : undefined;
}

/** The engine calls that carry the settings, as [[id, args]]. Track Changes Options' document settings (track moves and
 * formatting) are the document's in the engine and stay out: pushing them would change the draft. The balloons and Specific
 * People reach the session too: comments/CanvasCards.jsx draws the balloons review.balloons lists. */
export function settingsCalls(settings) {
  const w = wordSettings(settings);
  const t = w.tracking ?? {};
  const mark = (m, key, colorKey, out) => {
    if (MARKS[m?.mark]) out[key] = MARKS[m.mark];
    const c = colorOf(m?.color);
    if (c) out[colorKey] = c;
  };
  const options = { insertionsDeletions: t.show?.insDel !== false, formatting: t.show?.formatting !== false,
    balloons: BALLOONS[t.balloons] ?? 'commentsAndFormatting', people: Array.isArray(t.people) ? t.people : null };
  mark(t.ins, 'insertMark', 'insertColor', options);
  mark(t.del, 'deleteMark', 'deleteColor', options);
  mark(t.moveFrom, 'moveFromMark', 'moveFromColor', options);
  mark(t.moveTo, 'moveToMark', 'moveToColor', options);
  if (['outside', 'left', 'right', 'none'].includes(t.lines)) options.changedLines = t.lines;
  return [
    ['file.setAuthor', { name: authorOf(w.user, accountName(), t.author).name }],
    ['review.trackingOptions', options],
    ['review.markup', { value: DISPLAY[t.display] ?? 'allMarkup' }],
    ['view.marks', { value: !!w.marks?.all }],
    ['file.printMarkup', { value: w.print?.markup !== false }],
  ];
}

const pushed = new WeakMap(); // session → the calls last pushed to it, as JSON
let memo = { settings: null, account: '', key: '' };
/** The calls for `settings` as JSON, kept per settings object and OS account name (the author falls back to it, and it arrives
 * after the first push): a store change elsewhere in the settings sends nothing (view.marks and review.markup lay the whole
 * document out again). */
function keyOf(settings) {
  if (memo.settings !== settings || memo.account !== accountName()) {
    memo = { settings, account: accountName(), key: JSON.stringify(settingsCalls(settings)) };
  }
  return memo.key;
}
const heard = new WeakSet(); // sessions whose 'reopened' event is followed
const modes = new WeakMap(); // session → the view command last run on it; none: the engine's own Print Layout

const viewing = new WeakMap(); // session → whether it was last set read-only

/** Viewing mode (the store's word.mode) makes the session take no edits (view.readOnly, stage2.md G34). */
function followMode(session, mode) {
  const on = mode === 'viewing';
  if ((viewing.get(session) ?? false) === on) return;
  viewing.set(session, on);
  Promise.resolve(session.exec('view.readOnly', { value: on })).catch(() => {});
}

/** Sets the session's view mode to the store's view, when it differs from the last one set (views/canvas.mjs engineView). */
function followView(session, view) {
  const [id, args] = engineView(view);
  if ((modes.get(session) ?? 'view.printLayout') === id) return;
  modes.set(session, id);
  Promise.resolve(session.exec(id, args)).catch(() => {});
}

/** Sends the settings to `session`: each call alone, so one the engine refuses (a protected document's user name, say) leaves
 * the others. The marks and colours fall back to the engine's defaults when it refuses them. */
async function push(session, settings) {
  pushed.set(session, keyOf(settings));
  for (const [id, args] of settingsCalls(settings)) {
    const r = await Promise.resolve(session.exec(id, args)).catch(() => null);
    if (id === 'review.trackingOptions' && r && !r.ok) {
      const { insertionsDeletions, formatting, balloons, people } = args;
      await Promise.resolve(session.exec(id, { insertionsDeletions, formatting, balloons, people })).catch(() => null);
    }
  }
}

// Tool search can list the commands before any ribbon control has read the engine state they decide by (the Review and Mailings
// tabs unopened): read those at once, so the first list hides Next Comment with no comment, as the DOM path does.
const PRIME = ['review.tracking.trackChanges', 'mailings.writeInsertFields.addressBlock', 'mailings.previewResults.previewResults',
  'mailings.previewResults.next', 'mailings.previewResults.record'];
function prime() {
  const ctx = ctxOf();
  if (!ctx.engine) return;
  ctx.read('review.counts', {});
  for (const id of PRIME) commandOf(id)?.enabled?.(ctx);
}

function follow() {
  const s = getState();
  // A board's focused session is its text item's, not a draft's: the Review settings, the view and read-only are a draft's
  // (bd-text: Viewing on a Document must not make a board's text box read-only).
  if (activeSurface()?.format === 'board') return;
  // A document focused on a board (bd-hud) stays in print layout and editing: Read Mode and Viewing are the open Document's.
  const boardDoc = s.boardHud === 'document';
  const session = activeSurface()?.session ?? s.focusedSession ?? null;
  if (!session) return;
  followView(session, boardDoc ? 'print' : s.word?.view);
  followMode(session, boardDoc ? 'editing' : s.word?.mode);
  if (pushed.get(session) === keyOf(s.settings)) return;
  if (!heard.has(session)) {
    heard.add(session);
    prime();
    session.on?.('reopened', () => {
      modes.delete(session);
      viewing.delete(session);
      const now = getState();
      const board = now.boardHud === 'document';
      followMode(session, board ? 'editing' : now.word?.mode);
      followView(session, board ? 'print' : now.word?.view);
      push(session, now.settings);
    });
  }
  push(session, s.settings);
}
subscribe(follow);

bindReviewApp({
  setMode: (mode) => setState({ word: { ...getState().word, mode } }),
  mode: () => getState().word?.mode ?? 'editing',
  saveWord,
  title: () => getState().draft?.title ?? '',
  saveFile: (file) => (globalThis.__wordTest?.word ?? window.api.word).saveFile(file),
  openLink: (href) => (/^https?:/i.test(href) ? (openPane(null, href), true) : false),
  copyText: (text) => window.api.word.clipboard.write({ text }),
});
