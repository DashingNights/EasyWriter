// Recent drafts for the File backstage's Home and Open pages (docs/plans/word/briefs/backstage.md): newest updated first, Word's
// date groups and the Search box filter. Pure: Node tests load it.

/** `drafts` (entries with `updated` in ms) newest first, without changing the input. */
export const byUpdated = (drafts) => [...drafts].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));

const DAY = 86400000;
const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
// Local midnight `n` calendar days before `t` (setDate keeps daylight saving changes right).
const daysBefore = (t, n) => {
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() - n);
  return d.getTime();
};

/** Open's date group of a draft updated at `t`, seen at `now`: 'Today', 'Yesterday', 'This week', 'Last week' or 'Older'.
 * Weeks start on Monday. */
export function dateGroup(t, now = Date.now()) {
  const today = startOfDay(now);
  if (t >= today) return 'Today';
  if (t >= daysBefore(now, 1)) return 'Yesterday';
  const weekStart = daysBefore(now, (new Date(now).getDay() + 6) % 7);
  if (t >= weekStart) return 'This week';
  if (t >= weekStart - 7 * DAY) return 'Last week';
  return 'Older';
}

/** `drafts` newest first in date groups → [{label, drafts}], empty groups left out, in Word's order. */
export function groupRecent(drafts, now = Date.now()) {
  const groups = new Map(['Today', 'Yesterday', 'This week', 'Last week', 'Older'].map((g) => [g, []]));
  for (const d of byUpdated(drafts)) groups.get(dateGroup(d.updated ?? 0, now)).push(d);
  return [...groups].filter(([, list]) => list.length).map(([label, list]) => ({ label, drafts: list }));
}

/** The drafts whose title (or `extra(d)`, such as the folder name) holds every word of `query`, case-insensitive. */
export function filterDrafts(drafts, query, extra = () => '') {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return drafts;
  return drafts.filter((d) => {
    const hay = `${d.title ?? ''} ${extra(d) ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
