// Page formats (docs/plans/integrations.md Format seam): what a draft's page is, its content width, padding and the blocks only it
// inserts. Pure: the renderer, commands, gates and node tests read it. A format is {id, label, integration?, default?,
// version, width(settings, draft) → content px, padding (px per side), blocks}. Its id is what draft.format stores, never renamed.
// Every new draft writes format and formatVersion (docs/plans/document.md). A draft without format is a forum post forever (the
// forum manifest's default: true is only that fallback). 'presentation' and 'spreadsheet' are reserved ids, not in FORMATS, so
// formatOf refuses them like any id a newer build wrote.
// The version guard (SPEC §5 Formats): a format's version counts its schema changes, each additive. A draft whose formatVersion
// (absent: 1) is above this build's version may hold attributes or nodes this build would drop on load, so it is refused too.
// A format is its own editing system with its own toolset (SPEC §5 Formats). The forum post's is the forum-limited one (the
// format.mjs value lists, the titled box, the forum typography). Document, Presentation and Spreadsheet bring their own marks,
// nodes and tools, one Office-style set they share (docx, pptx, xlsx and PDF interop), not variants of the forum post's.
// src/editors.js holds each format's editor kit.
// An integration's switch hides its services, never its format: a draft opens in the same format in either state, so
// switching is non-destructive (plan step 9).
import { defaultSect } from './document/defaults.mjs';
import { enabled, INTEGRATIONS } from './integrations/index.mjs';
import { ptToPx } from './office.mjs';

export const DEFAULT_PAGE_WIDTH = 1454;

/** The core fallback format, for when no format is the default. A draft without format is a forum post and a new draft takes
 * defaultFormat's, never this one, so PAGE opens only drafts that store format 'page'. Its width is Settings > General > Page width. */
export const PAGE = { id: 'page', label: 'Page', version: 1, width: (s) => s?.pageWidth ?? DEFAULT_PAGE_WIDTH, padding: 22, blocks: [] };

/** The sect (doc.attrs.sect, points) of a Document draft: `sect` (the live editor's) or the draft file's, else the device's paper. */
const sectOf = (settings, draft, sect) => sect ?? draft?.doc?.attrs?.sect ?? defaultSect(settings?.paper);

/** The Document (docs/plans/document.md, core): a sheet of paper. Its text width is the paper width less the left and right
 * margins; paper(sect) gives the sheet and its margins in px (1 pt = 4/3 px). */
export const DOCUMENT = {
  id: 'document', label: 'Document', version: 1, blocks: [],
  width: (settings, draft, sect) => {
    const { w, margin } = sectOf(settings, draft, sect);
    return ptToPx(w - margin.left - margin.right);
  },
  padding: 0, // pageOf gives the left margin
  paper: (sect) => ({ w: ptToPx(sect.w), h: ptToPx(sect.h), ...Object.fromEntries(['top', 'right', 'bottom', 'left'].map((k) => [k, ptToPx(sect.margin[k])])) }),
};

/** Every known format by id: the core page and the Document, then each integration's, tagged with its integration. */
export const FORMATS = {
  page: PAGE,
  document: DOCUMENT,
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

/** {format, width, padding, paper?} of the page `draft` shows (PAGE's when its format is unknown). `sect`: the open editor's
 * doc.attrs.sect, newer than the draft file's. A Document adds paper (px, DOCUMENT.paper) and its padding is the left margin. */
export function pageOf(draft, settings, sect) {
  const f = formatOf(draft, settings) ?? PAGE;
  if (!f.paper) return { format: f.id, width: f.width(settings, draft), padding: f.padding };
  const paper = f.paper(sectOf(settings, draft, sect));
  return { format: f.id, width: f.width(settings, draft, sect), padding: paper.left, paper };
}

/** Whether a new draft may take format `id` with `settings`: a known format other than the core fallback PAGE, whose integration
 * (if any) is on. */
const creatable = (settings, id) => Object.hasOwn(FORMATS, id ?? '') && id !== 'page' && (!FORMATS[id].integration || enabled(settings, FORMATS[id].integration));

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
