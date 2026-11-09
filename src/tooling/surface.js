// The active surface (docs/plans/word plan.md §1.3, direction.md item 2, docs/plans/cleanup/tool-pool-surfaces.md F2): what the
// tools act on, with its format and profile. Its `kind` names the surface: 'document' (an open Document's main editor, with the
// story sub-editor that holds the focus, or the canvas draft that holds it), 'text' (a forum post or core page editor), 'flow'
// (the flowchart view: the library and the open flowchart), 'plan' (the plan page) or 'board' (a whiteboard draft). The registry reads the editor, the story
// and the engine session only through activeSurface().
import { getState } from '../app/store.js';
import { isPost, postsOn } from '../document/canvas/post.js';
import { wordSettings } from '../document/word/settings.mjs';
import { isCanvas } from '../engine/model/form.mjs';
import { FORMATS, formatOf } from '../formats.mjs';
import { BOARD_PROFILE, FLOW_PROFILE, PLAN_PROFILE, profileOf } from './profile.mjs';

/** Whether the canvas page area shows store state `s`'s draft, so it is opening it or has (a Document while the Canvas engine
 * switch is on, a forum post while the engine hosts posts or once it is a canvas draft) and the engine has not refused it
 * (session.js). The page area mounts on this test (PageArea.jsx CanvasSlot), and the surface, the focus and the engine
 * warm-up's busy check read it: one test, so they never disagree. */
export function areaOpens(s) {
  if (s.view?.type !== 'editor' || !s.draft || s.engineRefused === s.draft) return false;
  if (s.draft.format === 'document') return !!wordSettings(s.settings).canvasEngine || isCanvas(s.draft);
  return isPost(s.draft, s.settings) && (postsOn(s) || isCanvas(s.draft));
}

/** Whether the editor view shows a whiteboard draft (format 'board'): its items live in draft.board, not in the DOM editor. */
export const boardOpens = (s) => s.view?.type === 'editor' && s.draft?.format === 'board';

/** How the open draft `id` holds its content now: 'engine' when the page area shows it (its session has the text, whatever the
 * record's form says), 'dom' when its DOM editor does, else null (not the open draft, or no editor of either). A download's fill
 * picks the one that holds the placeholders: a post shown in the page area must be filled there, before its first save makes the
 * record the canvas form. */
export function openEditor(s, id) {
  if (!id || s?.draft?.id !== id) return null;
  return areaOpens(s) ? 'engine' : s.editor ? 'dom' : null;
}

let story = null; // {kind, editor} of the story sub-editor that is the target (registry setStory and clearStory decide)

let engineStory = null; // the story kind the focused canvas draft's selection is in (its document.context), or null for the body

/** Sets the surface's story: {kind, editor} or null. Only the registry's setStory and clearStory call it. */
export const setSurfaceStory = (next) => {
  story = next;
};

/** Sets the canvas draft's story kind ('header', 'footnote', 'equation'…; null or 'body' for the body). Only the registry calls
 * it, from the engine's document.context. */
export const setEngineStory = (kind) => {
  engineStory = kind && kind !== 'body' ? { kind, editor: null } : null;
};

/** The surface the tools act on → {kind, editor, format (its id), profile, story: {kind, editor | null} | null, session?}, or null in the
 * browser or with no draft open in the editor view. Only a Document has a story; the flow and plan surfaces have no editor. While
 * a canvas draft holds the focus (the store's focusedSession, docs/plans/engine/viewport-design.md section 4.7) the Document's
 * surface has that SessionClient as `session` and no editor, so no command reaches the DOM editor under the canvas. While the page
 * area opens the draft, or after it could not, `session` is null too, and the commands show disabled (registry.js commandOf). A
 * caller that means "a Document is open" checks `format === 'document'`, never a non-null surface. */
export function activeSurface() {
  const s = getState();
  const type = s.view?.type;
  if (type === 'flows') return { kind: 'flow', editor: null, format: 'flow', profile: FLOW_PROFILE, story: null };
  if (type === 'plan') return { kind: 'plan', editor: null, format: 'plan', profile: PLAN_PROFILE, story: null };
  if (type !== 'editor' || !(s.editor || s.focusedSession)) return null;
  // The focused session's format picks the profile; it is the open draft's while the editor view shows one draft at a time.
  const f = formatOf(s.draft, s.settings);
  if (!f) return null;
  if (f.id === 'document' && (s.focusedSession || areaOpens(s))) {
    // The engine edits every story in place, so a canvas draft's story has no editor of its own.
    return { kind: 'document', editor: null, format: f.id, profile: profileOf(f), session: s.focusedSession ?? null, story: s.focusedSession ? engineStory : null };
  }
  // A document focused on a board (bd-hud) is that draft's surface, over the instance layer's session: its rows and its ribbon
  // act on the document, wherever the board has placed it.
  if (boardOpens(s) && s.boardFocus?.kind === 'document') {
    const f = FORMATS[s.boardFocus.format];
    return { kind: f.id === 'document' ? 'document' : 'text', editor: null, format: f.id, profile: profileOf(f), session: s.boardFocus.session, story: s.focusedSession ? engineStory : null };
  }
  // A text item being edited on a board is the text surface, over the item session (bd-text).
  if (boardOpens(s) && s.boardFocus?.kind === 'text') {
    return { kind: 'text', editor: null, format: 'board', profile: BOARD_PROFILE, session: s.boardFocus.session, story: null };
  }
  // A post on the engine is the text surface with the page area's session and no DOM editor (its rows run the post commands).
  if (f.id !== 'document' && (s.focusedSession || areaOpens(s))) {
    return { kind: 'text', editor: null, format: f.id, profile: profileOf(f), session: s.focusedSession ?? null, story: null };
  }
  // A whiteboard's tools act on its board, never on the hidden DOM editor under it.
  if (boardOpens(s)) return { kind: 'board', editor: null, format: 'board', profile: BOARD_PROFILE, story: null, session: null };
  if (!s.editor) return null;
  if (f.id !== 'document') return { kind: 'text', editor: s.editor, format: f.id, profile: profileOf(f), story: null };
  return { kind: 'document', editor: s.editor, format: f.id, profile: profileOf(f), story: story?.editor?.isDestroyed ? null : story };
}
