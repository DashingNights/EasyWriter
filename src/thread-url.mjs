// Forum topic URLs (SPEC §7 Sidebar): one canonical form per topic, so a pasted link matches the one the forum lists. Pure and
// import-free: actions.js and the command catalogue (node --test) share it.

// Scheme and www. optional; whatever follows the slug (/page/N/, query, hash) is dropped.
const TOPIC = /^(?:https?:\/\/)?(?:www\.)?daf\.staffs\.ac\.uk\/topic\/(\d+)(-[^/?#\s]+)?(?:[/?#]\S*)?$/i;

/** `value` → the canonical topic URL `https://daf.staffs.ac.uk/topic/<id>-<slug>/`, or '' when it is not a DAF topic URL. */
export function normalizeThread(value) {
  const m = TOPIC.exec(String(value ?? '').trim());
  return m ? `https://daf.staffs.ac.uk/topic/${m[1]}${m[2] ?? ''}/` : '';
}

/** The topic id of `value` (any form normalizeThread takes), or ''. Two links to one topic can differ in the slug (case,
 * percent-encoding, a renamed topic), so a listed topic is found by its id. */
export const topicId = (value) => TOPIC.exec(String(value ?? '').trim())?.[1] ?? '';

/** A readable title from a topic URL's slug: ".../topic/12345-level-design/" → "Level design"; no slug → "Topic 12345". */
export function slugTitle(url) {
  const m = TOPIC.exec(normalizeThread(url));
  if (!m) return '';
  let words = (m[2] ?? '').slice(1);
  try { words = decodeURIComponent(words); } catch { /* a stray % stays as it is */ }
  words = words.replace(/-+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : `Topic ${m[1]}`;
}

/** The listed threads with the forum's `found` ones merged in by topic: a known topic keeps its entry and stored URL (its drafts
 * and plan point at it), updated by what the forum says; a new one is appended. → {threads, added}. */
export function mergeThreads(listed, found) {
  const byTopic = new Map(listed.map((t) => [topicId(t.url) || t.url, t]));
  let added = 0;
  for (const t of found) {
    const key = topicId(t.url) || t.url;
    const old = byTopic.get(key);
    if (!old) added++;
    byTopic.set(key, { ...old, ...t, url: old?.url ?? t.url });
  }
  return { threads: [...byTopic.values()], added };
}
