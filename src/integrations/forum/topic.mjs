// Forum topics (SPEC §7 Sidebar): a project's `thread` is the forum topic linked to it, and a thread added before projects is
// keyed by its topic URL (that topic is its forum thread). Topic URLs have one canonical form per topic, so a pasted link
// matches the one the forum lists. Pure: actions.js, the command catalogue (node --test), manifest.mjs and main.js share it.
import { isProject, isThreadKey } from '../../thread-url.mjs';

// Scheme and www. optional; whatever follows the slug (/page/N/, query, hash) is dropped.
const TOPIC = /^(?:https?:\/\/)?(?:www\.)?([^/\s]+)\/topic\/(\d+)(-[^/?#\s]+)?(?:[/?#]\S*)?$/i;

/** The forum topic of the project keyed `key` in `threads` (settings.threads): its linked thread, or the key itself for a forum
 * thread added before projects (a draft may keep such a key after its entry was removed); '' for none. */
export function topicOf(threads, key) {
  if (!isProject(key)) return isThreadKey(key) ? key : '';
  return threads?.find((t) => t.url === key)?.thread || '';
}

/** Whether a forum is in use: the integration is on (Settings > Integrations), a forum site is set (settings.forumUrl, kept
 * after the last unlink) and a project links one of its threads. Its sign-in, status and the forum commands need it. The flag
 * is read inline: importing integrations/index.mjs would cycle through manifest.mjs. */
export const hasForum = (settings) => settings?.integrations?.forum?.enabled === true && !!settings.forumUrl && !!settings.threads?.some((t) => topicOf(settings.threads, t.url));

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

/** The setup's thread list (forum/ui.jsx SetupThreads): pasted `value` → {topic}, its canonical URL on forum `site` (none set:
 * its own site, so the first link sets it), or {error} when it is no topic link of that forum, `list` has that topic, or `list`
 * is full (forum.posts reads at most 50 topics). */
export function listTopic(list, value, site) {
  if (list.length >= 50) return { error: 'The list holds 50 threads at most.' };
  const text = String(value ?? '').trim();
  const topic = normalizeThread(text, site || siteOf(text));
  if (!topic) return { error: site && siteOf(text) ? `That thread is not on ${site}. Add threads of one forum.` : 'Paste the full link of a forum topic, like https://forum.example.com/topic/12345-name/' };
  if (list.some((u) => topicId(u) === topicId(topic))) return { error: 'That thread is in the list already.' };
  return { topic };
}
