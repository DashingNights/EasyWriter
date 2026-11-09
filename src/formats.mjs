// Page formats (docs/wiki/integrations.md Format seam): what a draft's page is, its content width, padding and the blocks only it
// inserts. Pure: the renderer, commands, gates and node tests read it. A format is {id, label, integration?, default?,
// version, width(settings, draft) → content px, padding (px per side), blocks, rasterOutput?}. Its id is what draft.format
// stores, never renamed. rasterOutput: the format's export is raster only (the forum post's), so a vector media block (an SVG,
// EMF or WMF) goes out rendered (export.js vectorMediaPicture), while its canvases keep their vector pictures.
// Every new draft writes format and formatVersion (docs/plans/document.md). A draft without format is a forum post forever (the
// forum manifest's default: true is only that fallback). 'presentation' and 'spreadsheet' are reserved ids, not in FORMATS, so
// formatOf refuses them like any id a newer build wrote.
// The version guard (SPEC §5 Formats): a format's version counts its schema changes, each additive. A draft whose formatVersion
// (absent: 1) is above this build's version may hold attributes or nodes this build would drop on load, so it is refused too.
// A format is its own editing system with its own toolset (SPEC §5 Formats). The forum post's is the forum-limited one (the
// format.mjs value lists, the titled box, the forum typography). Document, Presentation and Spreadsheet bring their own marks,
// nodes and tools, one Office-style set they share (docx, pptx, xlsx and PDF interop), not variants of the forum post's.
// src/editors.js holds each format's editor kit. A format's hudRank says how verbose its HUD is (Document 2, post 1, board 0;
// docs/plans/board/design.md section 8).
// Each format may carry a profile (docs/plans/word/plan.md §1.19): {grants: '*' | {commands, options}, defaults: {units, spacing,
// styles}} names which tools of the one tool pool it offers and its parameter defaults (null: the built-ins). A format without a
// profile grants nothing from the pool (src/tooling/profile.mjs reads them). Grants pick tools, never what content a draft keeps.
// The Document grants the whole pool; the forum post and the core page share TEXT_PROFILE (docs/plans/cleanup/tool-pool-surfaces.md).
// An integration's switch hides its services, never its format: a draft opens in the same format in either state, so
// switching is non-destructive (plan step 9).
import { defaultSect } from './document/defaults.mjs';
import { DOM_VERSION, FORMAT_VERSION, isCanvas } from './engine/model/form.mjs';
import { enabled, INTEGRATIONS } from './integrations/index.mjs';
import { ptToPx } from './office.mjs';
import { BOARD_PROFILE, TEXT_PROFILE } from './tooling/profile.mjs';

export const DEFAULT_PAGE_WIDTH = 1454;

/** The core fallback format, for when no format is the default. A draft without format is a forum post and a new draft takes
 * defaultFormat's, never this one, so PAGE opens only drafts that store format 'page'. Its width is Settings > General > Page width.
 * Version 3 is the canvas form, as the forum post's (docs/plans/engine/stage3-forum.md section 2): a build without the post host
 * refuses the record instead of opening it with no doc. A DOM save stamps 1 (actions.js versionOf), so 1.x builds still open it. */
export const PAGE = { id: 'page', label: 'Page', version: 3, width: (s) => s?.pageWidth ?? DEFAULT_PAGE_WIDTH, padding: 22, blocks: [],
  profile: TEXT_PROFILE, hudRank: 1 };

/** The Whiteboard (docs/plans/board/design.md sections 4 and 8): an infinite board whose items live in `draft.board` (src/board/
 * store.mjs), not in `doc`, which stays null. Its tools are the board's (BOARD_PROFILE). Version 1 is the board form. */
export const BOARD = { id: 'board', label: 'Whiteboard', version: 1, blocks: [], profile: BOARD_PROFILE, hudRank: 0,
  width: (s) => s?.pageWidth ?? DEFAULT_PAGE_WIDTH, padding: 0 };

/** The sect (doc.attrs.sect, points) of a Document draft: `sect` (the live editor's) or the draft file's, else the device's paper. */
const sectOf = (settings, draft, sect) => sect ?? draft?.doc?.attrs?.sect ?? defaultSect(settings?.paper);

/** The Document (docs/plans/document.md, core): a sheet of paper. Its text width is the paper width less the left and right
 * margins; paper(sect) gives the sheet and its margins in px (1 pt = 4/3 px). Version 2 is schema v2 (docs/plans/word/plan.md
 * §1.8), so a version 1 build refuses a Document that may hold its nodes. Version 3 is the canvas form (docs/plans/engine/model.md:
 * the engine's model in `draft.engine`), so a build without the canvas engine refuses a canvas draft instead of opening its stale
 * `doc`. Saves stamp the form they write (actions.js): a Document in the DOM editor stays 2 (engine/model/form.mjs DOM_VERSION),
 * so 1.x builds still open it. It grants the whole tool pool. */
export const DOCUMENT = {
  id: 'document', label: 'Document', version: 3, blocks: [], hudRank: 2,
  profile: { grants: '*', defaults: { units: null, spacing: null, styles: null } },
  width: (settings, draft, sect) => {
    const { w, margin } = sectOf(settings, draft, sect);
    return ptToPx(w - margin.left - margin.right);
  },
  padding: 0, // pageOf gives the left margin
  paper: (sect) => ({ w: ptToPx(sect.w), h: ptToPx(sect.h), ...Object.fromEntries(['top', 'right', 'bottom', 'left'].map((k) => [k, ptToPx(sect.margin[k])])) }),
};

/** Every known format by id: the core page, the Document and the Whiteboard, then each integration's, tagged with its integration. */
/** Whether Documents open on the canvas engine by default: the one source of settings.word.canvasEngine's default. View > Canvas
 * engine stores one user's choice over it. Off until the user's hand checks pass (docs/plans/engine/stage3.md section 1). */
export const DOCUMENTS_ON_ENGINE = false;

/** Whether a new draft may be a Whiteboard: off until the board is usable here (docs/plans/board/design.md; the review of
 * bd-format). A board draft already saved still opens either way (FORMATS keeps it); settings.boardEngine turns new ones on for
 * a run, mostly the checks. */
export const BOARDS_ON = false;
export const boardsOn = (settings) => (settings?.boardEngine ?? BOARDS_ON) === true;

export const FORMATS = {
  page: PAGE,
  document: DOCUMENT,
  board: BOARD,
  ...Object.fromEntries(INTEGRATIONS.flatMap((i) => (i.formats ?? []).map((f) => [f.id, { ...f, integration: i.id }]))),
};

/** The format `draft` (null: a new one) opens in with `settings`. null for a format id this build does not know, or a
 * formatVersion above its version (a newer build wrote it): the caller refuses to open the draft, since its nodes or attributes
 * may be unknown here and an autosave would drop them. A known format opens as itself whether its integration is on or off
 * (`settings` gives only its width). */
export function formatOf(draft, settings) {
  const f = draft?.format == null ? Object.values(FORMATS).find((x) => x.default) ?? PAGE : Object.hasOwn(FORMATS, draft.format) ? FORMATS[draft.format] : null;
  return f && (draft?.formatVersion ?? 1) <= f.version ? f : null;
}

/** The theme `draft`'s canvases, flowcharts and plan charts draw in: light on a Document's white paper, else the page theme
 * (settings.theme; actions.js applyPageTheme sets it on the root while the draft is open). */
export const drawTheme = (draft, settings) => (formatOf(draft, settings)?.id === 'document' || settings?.theme === 'light' ? 'light' : 'dark');

/** {format, width, padding, paper?} of the page `draft` shows (PAGE's when its format is unknown). `sect`: the open editor's
 * doc.attrs.sect, newer than the draft file's. A Document adds paper (px, DOCUMENT.paper) and its padding is the left margin. */
export function pageOf(draft, settings, sect) {
  const f = formatOf(draft, settings) ?? PAGE;
  if (!f.paper) return { format: f.id, width: f.width(settings, draft), padding: f.padding };
  const paper = f.paper(sectOf(settings, draft, sect));
  return { format: f.id, width: f.width(settings, draft, sect), padding: paper.left, paper };
}

/** The formatVersion a save of `draft` stamps: the canvas form's (FORMAT_VERSION) for a canvas draft, DOM_VERSION for a Document
 * in the DOM editor, 1 for a post or page there (their formats' versions are the canvas form's too, so 1.x builds must still
 * open DOM saves), else its format's version. Every path that writes a draft's record stamps its form through this one function
 * (actions.js versionOf, the forum import). */
export const formatVersionOf = (draft) => (isCanvas(draft) ? FORMAT_VERSION
  : draft?.format === 'document' ? DOM_VERSION : draft?.format === 'board' ? BOARD.version : 1);

/** Whether a new draft may take format `id` with `settings`: a known format other than the core fallback PAGE, whose integration
 * (if any) is on. */
const creatable = (settings, id) => Object.hasOwn(FORMATS, id ?? '') && id !== 'page' && (id !== 'board' || boardsOn(settings))
  && (!FORMATS[id].integration || enabled(settings, FORMATS[id].integration));

/** The format a new draft in project `threadUrl` takes (docs/plans/document.md New-draft defaults): the one an integration that
 * is on prefers for that project (the forum's forum post in a project linking a forum thread); else settings.lastFormat when
 * `last` (the New draft dialog and the fallbacks without it; drafts.create leaves the user's last pick out) and a new draft may
 * still take it; else 'document'. */
export function defaultFormat(settings, threadUrl, { last = false } = {}) {
  for (const i of INTEGRATIONS) {
    const id = enabled(settings, i.id) && i.prefers?.(settings, threadUrl);
    if (id) return id;
  }
  return last && creatable(settings, settings?.lastFormat) ? settings.lastFormat : 'document';
}
