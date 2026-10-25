// Page formats (docs/plans/integrations.md Format seam): what a draft's page is, its content width, padding and the blocks only it
// inserts. Pure: the renderer, commands, gates and node tests read it. A format is {id, label, integration?, default?,
// width(settings) → content px, padding (px per side), blocks}. Its id is what a later format stores in draft.format, never renamed.
// Nothing writes draft.format yet: a draft without one takes the app default.
// A format is its own editing system with its own toolset (SPEC §5 Formats). The forum post's is the forum-limited one (the
// format.mjs value lists, the titled box, the forum typography). Document and Slides will bring their own marks, nodes and
// tools, one Office-style set they share (docx, pptx, xlsx and PDF interop), not variants of the forum post's.
// An integration's switch hides its services, never its format: a draft opens in the same format in either state, so
// switching is non-destructive (plan step 9).
import { INTEGRATIONS } from './integrations/index.mjs';

export const DEFAULT_PAGE_WIDTH = 1454;

/** The core fallback format, for when no format is the default. Until Document takes that role, the forum post is the default
 * and only editor format, so PAGE opens only drafts that store format 'page'. Its width is Settings > General > Page width. */
export const PAGE = { id: 'page', label: 'Page', width: (s) => s?.pageWidth ?? DEFAULT_PAGE_WIDTH, padding: 22, blocks: [] };

/** Every known format by id: the core page, then each integration's, tagged with its integration. */
export const FORMATS = {
  page: PAGE,
  ...Object.fromEntries(INTEGRATIONS.flatMap((i) => (i.formats ?? []).map((f) => [f.id, { ...f, integration: i.id }]))),
};

/** The format `draft` (null: a new one) opens in with `settings`. null for a format id this build does not know (a newer
 * build wrote it): the caller refuses to open the draft, since its nodes may be unknown here and an autosave would blank them.
 * A known format opens as itself whether its integration is on or off (`settings` gives only its width). */
export function formatOf(draft, settings) {
  if (draft?.format != null) return Object.hasOwn(FORMATS, draft.format) ? FORMATS[draft.format] : null;
  return Object.values(FORMATS).find((f) => f.default) ?? PAGE;
}

/** {format, width, padding} of the page `draft` shows (PAGE's when its format is unknown). */
export function pageOf(draft, settings) {
  const f = formatOf(draft, settings) ?? PAGE;
  return { format: f.id, width: f.width(settings), padding: f.padding };
}
