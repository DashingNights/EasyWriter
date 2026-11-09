// One tool pool and format profiles (docs/plans/word plan.md §1.19, direction.md item 4): each format in src/formats.mjs carries
// a profile {grants: '*' | {commands: [ids or prefixes], options: {[listId]: [ids] | '*'}}, defaults: {units, spacing, styles} | null}.
// Grants decide which tools a format offers, never what content it keeps. Pure: the registry, the ribbon, tool search and the
// dialog kit filter through it, and node tests load it. The app's own profiles are below (docs/plans/cleanup/tool-pool-surfaces.md
// F2): the forum post's and the core page's, the whiteboard's, and those of the flowchart and plan views, which are surfaces but not draft formats.
import { FONTS, FONT_SIZES, HIGHLIGHTS, TEXT_COLORS } from '../format.mjs';

/** The profile of a format without one: it grants nothing from the pool. */
export const NO_PROFILE = Object.freeze({ grants: Object.freeze({ commands: [], options: {} }), defaults: null });

/** The profile of `format` (a formats.mjs format object, or null) → NO_PROFILE when it has none. */
export const profileOf = (format) => format?.profile ?? NO_PROFILE;

/** Whether `profile` grants command `id`: '*' grants all; otherwise an exact id or a prefix of it ('home.font' grants 'home.font.bold'). */
export function grants(profile, id) {
  const g = profile?.grants;
  if (g === '*') return true;
  return !!g?.commands?.some((p) => id === p || id.startsWith(p.endsWith('.') ? p : `${p}.`));
}

// An option's id: a GalleryItem's id, a kit option's value ([value, label]) or the string itself.
const keyOf = (item) => (Array.isArray(item) ? item[0] : item && typeof item === 'object' ? item.id : item);

/** `items` of option list `listId` that `profile` grants, in their order: all of them under '*' or a list granted '*', none
 * for a list the profile does not name. */
export function grantOptions(profile, listId, items) {
  const g = profile?.grants;
  if (g === '*') return items;
  const allowed = g?.options?.[listId];
  if (allowed === '*') return items;
  if (!Array.isArray(allowed)) return [];
  return items.filter((item) => allowed.includes(keyOf(item)));
}

/** The forum post's and the core page's profile (formats 'forum-post' and 'page'): the text, paragraph, insert, table, edit,
 * references, board, plan (a plan chart in the draft) and view pool ids, and the forum's value lists (src/format.mjs) as option lists: `fonts` (FONTS labels),
 * `fontSizes` (FONT_SIZES), `textColors` (TEXT_COLORS keys) and `highlights` (HIGHLIGHTS). */
export const TEXT_PROFILE = Object.freeze({
  grants: { commands: ['text.', 'para.', 'insert.', 'table.', 'edit.', 'references.', 'board.', 'plan.', 'view.'],
    options: { fonts: FONTS.map((f) => f.label), fontSizes: FONT_SIZES, textColors: Object.keys(TEXT_COLORS), highlights: HIGHLIGHTS } },
  defaults: null,
});

/** The flowchart view's profile (surface 'flow'). */
export const FLOW_PROFILE = Object.freeze({ grants: { commands: ['board.', 'flow.', 'edit.', 'view.'], options: {} }, defaults: null });

/** The plan page's profile (surface 'plan'). */
export const PLAN_PROFILE = Object.freeze({ grants: { commands: ['plan.', 'edit.', 'view.'], options: {} }, defaults: null });

/** A whiteboard's profile (format 'board'): the board tools, edit and view. Text tools come with a text item's own surface. */
export const BOARD_PROFILE = Object.freeze({ grants: { commands: ['board.', 'edit.', 'view.'], options: {} }, defaults: null });
