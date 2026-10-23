// Projects (SPEC §7 Sidebar): settings.threads holds the projects, keyed `project:<uuid>` (`thread`: the forum topic linked to it,
// optional), and the forum threads added before projects, keyed by their topic URL (that topic is their forum thread). Topic URLs
// have one canonical form per topic, so a pasted link matches the one the forum lists. Pure and import-free: actions.js, the
// command catalogue (node --test) and main.js (getSettings) share it.

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

/** The forum topic of the project keyed `key` in `threads` (settings.threads): its linked thread, or the key itself for a forum
 * thread added before projects (a draft may keep such a key after its entry was removed); '' for none. */
export function topicOf(threads, key) {
  if (!isProject(key)) return isThreadKey(key) ? key : '';
  return threads?.find((t) => t.url === key)?.thread || '';
}

/** Whether a forum is in use: a forum site is set (settings.forumUrl, kept after the last unlink) and a project links one of
 * its threads. Its sign-in, status and the forum commands need it. */
export const hasForum = (settings) => !!settings?.forumUrl && !!settings.threads?.some((t) => topicOf(settings.threads, t.url));

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

/** settings.json's `stored` object as read: one with forum threads but no forum site (from before the site was a setting) gets
 * the site of its first thread. */
export function migrateSettings(stored) {
  const first = stored?.forumUrl ? null : stored?.threads?.map((t) => topicOf(stored.threads, t.url)).find(Boolean);
  return first ? { ...stored, forumUrl: siteOf(first) } : stored;
}

const host = (origin) => forumOrigin(origin).replace(/^https:\/\/(?:www\.)?/, '').toLowerCase();

/** The forum site (https origin, no www.) of topic URL `value`, or ''. */
export const siteOf = (value) => {
  const m = TOPIC.exec(String(value ?? '').trim());
  return m ? forumOrigin(m[1]) : '';
};

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
