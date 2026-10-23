// Threads and projects (SPEC §7 Sidebar): settings.threads holds forum topics (forum mode) and projects (projects mode, keyed
// `project:<uuid>`). Topic URLs have one canonical form per topic, so a pasted link matches the one the forum lists. Pure and
// import-free: actions.js, the command catalogue (node --test) and main.js (getSettings) share it.

// Scheme and www. optional; whatever follows the slug (/page/N/, query, hash) is dropped.
const TOPIC = /^(?:https?:\/\/)?(?:www\.)?([^/\s]+)\/topic\/(\d+)(-[^/?#\s]+)?(?:[/?#]\S*)?$/i;
const PROJECT = /^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A stored thread key (the threadUrl of drafts, plans and flowcharts; the commands' URL schema): a topic URL of any forum (the
// forum site can change) or a project key. main.js has a copy (THREAD_KEY_RE).
export const THREAD_KEY = '^(?:https://[^/\\s]+/topic/\\d+\\S*|project:[0-9a-f-]{36})$';
const KEY = new RegExp(THREAD_KEY);
export const isThreadKey = (url) => typeof url === 'string' && KEY.test(url);

/** Whether `url` is a project's key. */
export const isProject = (url) => typeof url === 'string' && PROJECT.test(url);

/** settings.mode: 'forum' (Invision Community threads) or 'projects' (the default, no forum). */
export const isForum = (settings) => settings?.mode === 'forum';

/** `value` (a typed forum address) → its https origin, or '' when it is not one. */
export function forumOrigin(value) {
  const text = String(value ?? '').trim();
  try {
    const u = new URL(/^[a-z]+:/i.test(text) ? text : `https://${text}`);
    return u.protocol === 'https:' && u.hostname.includes('.') ? u.origin : '';
  } catch {
    return '';
  }
}

/** settings.json's `stored` object as read: one from before settings.mode with a saved thread gets forum mode and the forum
 * it was written for; any other keeps its mode (none: the default, projects). */
export function migrateSettings(stored) {
  if (!stored || 'mode' in stored || !stored.threads?.length) return stored;
  return { ...stored, mode: 'forum', forumUrl: stored.forumUrl || 'https://daf.staffs.ac.uk' };
}

const host = (origin) => forumOrigin(origin).replace(/^https:\/\/(?:www\.)?/, '').toLowerCase();

/** `value` → the canonical topic URL `<site>/topic/<id>-<slug>/` of the forum at origin `site`, or '' when it is not a topic
 * URL of that forum. */
export function normalizeThread(value, site) {
  const m = TOPIC.exec(String(value ?? '').trim());
  return m && site && m[1].toLowerCase() === host(site) ? `${forumOrigin(site)}/topic/${m[2]}${m[3] ?? ''}/` : '';
}

/** The topic id of `value` (a topic URL of any forum), or ''. Two links to one topic can differ in the slug (case,
 * percent-encoding, a renamed topic), so a listed topic is found by its id. */
export const topicId = (value) => TOPIC.exec(String(value ?? '').trim())?.[2] ?? '';

/** A readable title from a topic URL's slug: ".../topic/12345-level-design/" → "Level design"; no slug → "Topic 12345". */
export function slugTitle(url) {
  const m = TOPIC.exec(String(url ?? '').trim());
  if (!m) return '';
  let words = (m[3] ?? '').slice(1);
  try { words = decodeURIComponent(words); } catch { /* a stray % stays as it is */ }
  words = words.replace(/-+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : `Topic ${m[2]}`;
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
