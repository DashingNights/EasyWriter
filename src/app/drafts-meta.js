// Draft status tags (SPEC §7): each draft's local work status, kept in settings, never in the draft file or the forum.
// `settings.tags` = [{id, name, color}] in workflow order (a later Kanban board shows one column per tag in this order),
// `settings.draftTags` = {draftId: tagId}. Later views read tags through these functions. No imports; inputs are never mutated.

export const DEFAULT_TAGS = [
  { id: 'todo', name: 'To do', color: '#e5e5e5' },
  { id: 'progress', name: 'In progress', color: '#3d99f5' },
  { id: 'done', name: 'Done', color: '#62d926' },
];

/** The tag definitions in display / workflow order; the defaults when the key is missing. */
export const tagList = (settings) => settings.tags ?? DEFAULT_TAGS;

/** The tag of a draft, or null (untagged, or its tag is gone). */
export function draftTag(settings, draftId) {
  const id = settings.draftTags?.[draftId];
  return tagList(settings).find((t) => t.id === id) ?? null;
}

/** The drafts that carry the tag `tagId` (null: the untagged ones), in their given order. */
export const draftsWithTag = (settings, drafts, tagId) => drafts.filter((d) => (draftTag(settings, d.id)?.id ?? null) === tagId);

/** A draft → id map (draftTags, draftFolders) without the entries whose draft is not in `drafts` or whose id is not in `defs`. */
export function pruneMap(map, drafts, defs) {
  return Object.fromEntries(Object.entries(map ?? {})
    .filter(([id, to]) => drafts.some((d) => d.id === id) && defs.some((x) => x.id === to)));
}

/** settings.draftTags with the draft tagged `tagId` (null: untagged), stale entries dropped. */
export const tagDraft = (settings, drafts, draftId, tagId) => pruneMap({ ...settings.draftTags, [draftId]: tagId }, drafts, tagList(settings));
