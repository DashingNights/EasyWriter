// Projects (SPEC §7 Sidebar): settings.threads holds the projects, keyed `project:<uuid>`, and the forum threads added before
// projects, keyed by their topic URL. Those topic-URL keys are legacy core keys, valid forever: drafts, plans and flowcharts keep
// them. The forum's own topic rules live in integrations/forum/topic.mjs. Pure and import-free.

const PROJECT = /^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A stored thread key (the threadUrl of drafts, plans and flowcharts; the commands' URL schema): a topic URL of any forum (the
// forum site can change) or a project key. main.js has a copy (THREAD_KEY_RE).
export const THREAD_KEY = '^(?:https://[^/\\s]+/topic/\\d+\\S*|project:[0-9a-f-]{36})$';
const KEY = new RegExp(THREAD_KEY);
export const isThreadKey = (url) => typeof url === 'string' && KEY.test(url);

/** Whether `url` is a project's key. */
export const isProject = (url) => typeof url === 'string' && PROJECT.test(url);

/** A legacy topic-URL key's topic, `<host without www.>/<topic number>`, or '' for a project key or no thread key. Links to one
 * topic differ in slug, page and query, so a draft's key matches its listed entry by this while no integration resolves it. */
export function legacyTopic(url) {
  if (!isThreadKey(url) || isProject(url)) return '';
  const m = /^https:\/\/(?:www\.)?([^/\s]+)\/topic\/(\d+)/i.exec(url);
  return m ? `${m[1].toLowerCase()}/${m[2]}` : '';
}
