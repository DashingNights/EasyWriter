// The forum integration's renderer actions (docs/plans/integrations.md Web seam): projects' forum threads, the forum's sign-in,
// push and unpush. Commands reach them through ctx.integrations.forum (app/commands.js makeCtx), the forum's UI through
// integrations/ui.js. They read app/actions.js bindings only inside functions: app/actions.js -> integrations/ui.js ->
// forum/ui.jsx -> this file is a cycle, like the existing actions/commands one.
//
// The forum service: the five calls below, through this one line. A web build swaps it for a browser extension's transport;
// the desktop one is IPC forum.* -> main's onlyIf('forum') gate -> forum/main.js.
//   status() -> {loggedIn, memberId, name, profileUrl, error?}
//   login() -> status, once signed in or once the window closes
//   describe(urls: at most 50 topic URLs of forumUrl) -> {threads: [{url, title, subject, year, forum}]}
//   push({threadUrl, html, images: [{name, base64, width, height}]}) -> {ok, error?}; it fills the reply box and never submits
//   open(url) -> true
const service = window.api.forum;

import {
  addProject, alertDialog, changeSettings, commitBoardEdit, confirmDialog, hideOverlay, markDirty, openDialog, saveNow, saveSettings, selectThread,
  showOverlay, threadLabel, toast, updateDraft,
} from '../../app/actions.js';
import { fail } from '../../app/commands/define.mjs';
import { getState, setState } from '../../app/store.js';
import { enabled } from '../index.mjs';
import { buildPayload } from './export.js';
import { hasForum, normalizeThread as normalizeTopic, siteOf, slugTitle, topicId, topicOf } from './topic.mjs';

export { buildPayload }; // export.preview and push.prepare (forum/commands.mjs), and the smoke hook (app/actions.js __smoke)

const settings = () => getState().settings;

/** `url` → the canonical topic URL on the set forum (none set yet: on its own site), or ''. */
const normalizeThread = (url) => normalizeTopic(url, settings().forumUrl || siteOf(url));
/** The forum thread (topic URL) of the project keyed `key`, or ''. */
export const projectTopic = (key) => topicOf(settings().threads, key);

/** forum.status (§8): the forum window's sign-in. */
export const status = () => service.status();
/** threads.openInForum (§8): `url` in the forum window; it throws when the forum cannot open it. */
export const open = (url) => service.open(url);

/** The listed project of `url` (its key, or a form normalizeThread takes of its forum thread, matched by topic id), or undefined. */
function findThread(url) {
  const id = topicId(url);
  return settings().threads.find((t) => t.url === url || (id && topicId(projectTopic(t.url)) === id));
}

/** app/actions.js draftThreadUrl: a forum thread's key may predate the canonical form, and its drafts must match it, so a topic
 * URL maps to its listed project, else to the canonical URL; '' for a topic of another forum (core then stores none), null
 * for a URL that is no topic. */
export const resolveProject = (url) => findThread(url)?.url ?? (normalizeThread(url) || (topicId(url) ? '' : null));

export async function refreshStatus() {
  let status = { loggedIn: false };
  if (!hasForum(settings())) return setState({ status }); // off, or no project links a forum thread: no forum to ask
  try {
    status = await service.status();
  } catch {
    status = { loggedIn: false };
  }
  setState({ status });
  if (status.loggedIn) describeUnnamed();
}

/** Projects whose forum thread the forum has not described yet get its names (after a status check or a login). */
const describeUnnamed = () => describeThreads(settings().threads.filter((t) => !t.year && !t.subject).map((t) => projectTopic(t.url)).filter(Boolean).slice(0, 50));

export function openInForum(url) {
  service.open(url).catch((e) => toast(`Could not open the forum: ${e.message || e}`, true));
}

/** TicketDialog's links: one to the forum site opens in the forum window (its sign-in). → whether it did. */
export function opensUrl(url) {
  const { forumUrl } = settings();
  if (!forumUrl || !url.startsWith(`${forumUrl}/`)) return false;
  openInForum(url);
  return true;
}

/** `value` → why it cannot be the forum thread of the project keyed `key` (null: a new one), or '' when it can. */
function threadProblem(value, key = null) {
  const site = settings().forumUrl;
  const topic = normalizeThread(value);
  if (!topic) return `Enter a forum topic URL, like ${site || 'https://forum.example.com'}/topic/12345-name/`;
  const other = findThread(topic);
  return other && other.url !== key ? `That thread is already linked to "${threadLabel(other)}".` : '';
}

/** New project (app/actions.js addThreadUrl): a name, a forum thread, or both (no name: the thread's title, from the forum).
 * → true: the forum's form handled it, also when cancelled. */
export async function newProject() {
  const value = await openDialog('forumNewProject', {
    validate: ({ name, thread }) => (thread.trim() ? threadProblem(thread) : name.trim() ? '' : 'Enter a name or a forum thread.'),
  });
  if (value) await selectThread(await (value.thread.trim() ? addLinkedProject(value.name, value.thread) : addProject(value.name)));
  return true;
}

/** Adds a project titled `title` (no title: the thread's slug, until the forum names it) linked to the forum thread `thread`
 * (the first one sets the forum site), whose title, subject, year and forum are then looked up. Throws a command error (§8
 * threads.add) when `thread` is not a topic URL or a project links it already. Resolves its key. */
export async function addLinkedProject(title, thread) {
  const topic = normalizeThread(thread);
  if (!topic) fail('invalid_args', `Not a topic URL of the forum (${settings().forumUrl || 'any forum while none is set'})`, { path: '/thread', message: 'is not a topic URL of the forum', expected: { $ref: '#/$defs/URL' } });
  if (settings().threads.some((t) => topicId(projectTopic(t.url)) === topicId(topic))) fail('already_exists', `A project already links ${topic}`);
  const url = `project:${crypto.randomUUID()}`;
  const entry = { url, title: title.trim().slice(0, 200) || slugTitle(topic), thread: topic, subject: '', year: '', forum: '' };
  await linked(topic, { threads: [...settings().threads, entry] });
  return url;
}

/** The row's Forum thread action: links a forum thread to the project `t`, changes it, or (an empty field) unlinks it. */
export async function editProjectThread(t) {
  const value = await openDialog('projectThread', { value: t.thread ?? '', validate: (v) => (v.trim() ? threadProblem(v, t.url) : '') });
  if (value != null) await setProjectThread(t.url, value);
}

/** Links the forum thread `thread` to the project keyed `key` ('' unlinks it, and the forum's names go with it). */
async function setProjectThread(key, thread) {
  const topic = thread.trim() ? normalizeThread(thread) : '';
  await linked(topic, { threads: settings().threads.map((t) => {
    if (t.url !== key) return t;
    const { thread: old, ...rest } = t;
    const title = autoTitle(t) ? slugTitle(topic) || t.title : t.title;
    return topic ? { ...rest, title, thread: topic, ...(topic !== old && { subject: '', year: '', forum: '' }) } : { ...rest, subject: '', year: '', forum: '' };
  }) });
}

/** Saves `patch` (settings.threads after a link), setting the forum site from `topic` when none is set yet, then looks the topic
 * up on the forum. */
async function linked(topic, patch) {
  const first = topic && !hasForum(settings());
  await saveSettings({ ...patch, ...(topic && !settings().forumUrl && { forumUrl: siteOf(topic) }) });
  if (first) refreshStatus(); // the sidebar's forum sign-in shows now
  if (topic) describeThreads([topic]);
}

// A title the user did not choose: none, the key (threads added before the forum lookup) or the forum thread's slug.
const autoTitle = (t) => !t.title || t.title === t.url || t.title === slugTitle(projectTopic(t.url));

/** Looks the listed threads `urls` up on their topic pages and fills in subject, year and forum, and the title unless the user
 * chose it. Never throws: a thread the forum does not describe (offline, no access, removed) stays as it is. */
async function describeThreads(urls) {
  if (!urls.length) return;
  try {
    const found = new Map((await service.describe(urls)).threads.map((f) => [f.url, f]));
    if (!found.size) return;
    await saveSettings({ threads: settings().threads.map((t) => {
      const f = found.get(projectTopic(t.url));
      return f ? { ...t, title: autoTitle(t) ? f.title : t.title, subject: f.subject, year: f.year, forum: f.forum } : t;
    }) });
  } catch {
    // the thread keeps its title from the URL until the next lookup
  }
}

export async function login() {
  const state = getState();
  if (state.status.loggedIn) {
    openInForum(`${state.settings.forumUrl}/`);
    return;
  }
  setState({ loggingIn: true });
  try {
    state.status = await service.login();
    if (state.status.loggedIn) describeUnnamed();
  } catch (e) {
    await alertDialog('Login failed', String(e.message || e));
  } finally {
    setState({ loggingIn: false });
  }
}

/** Plan step 9: before `action` ('Pushing' or 'Unpushing') of a forum draft's control while the forum is off, asks to turn it
 * back on and saves that. Only the user answers (human): agents never turn an integration on. Main merges `integrations` by
 * id, so the other ids, a newer build's among them, stay as they are. → whether the forum is on. */
export async function wake(action) {
  if (enabled(settings(), 'forum')) return true;
  if (!(await confirmDialog({
    title: 'Turn the forum integration back on?',
    description: `${action} needs it. You can turn it off again in Settings > Integrations.`,
    confirmText: 'Turn on',
    human: true,
  }))) return false;
  await changeSettings({ integrations: { forum: { ...settings().integrations?.forum, enabled: true } } });
  return true;
}

export async function unpushDraft(entry) {
  if (!(await confirmDialog({
    title: `Mark "${entry.title}" as not pushed?`,
    description: 'Use this only if you did not press Submit in the forum.',
    confirmText: 'Unpush',
  }))) return;
  try {
    await doUnpushDraft(entry.id);
  } catch (e) {
    toast(`Could not update the draft: ${e.message || e}`, true);
  }
}

/** Unpush without the dialog (§8 drafts.unpush). */
export const doUnpushDraft = (id) => updateDraft(id, { pushedAt: null });

/** The project with a forum thread a draft in no project pushes to: the one picked in the dialog, or null. */
async function chooseThread() {
  const threads = settings().threads.filter((t) => projectTopic(t.url));
  if (!threads.length) {
    await alertDialog('Link a forum thread first', 'Add one to a project with the link button on its row, or with New project.');
    return null;
  }
  return openDialog('chooseThread', { threads, selected: settings().selectedThread });
}

/** Fills the forum reply box of the open draft's project's forum thread after the human confirm (never submits). A draft in no
 * project asks for a project with one; a project without one says to link it; with `requireThread` both resolve
 * {code: 'no_thread'} (agents get no dialog). */
export async function push({ requireThread = false } = {}) {
  const state = getState();
  if (!state.editor || !state.draft) return;
  let key = state.draft.threadUrl;
  if (!projectTopic(key)) {
    if (requireThread) return { code: 'no_thread' };
    const project = key && findThread(key);
    if (project) return alertDialog(`Link a forum thread to "${threadLabel(project)}" first`, 'Use the link button on its row in the sidebar.');
    key = await chooseThread();
    if (!key) return;
    state.draft.threadUrl = key;
    markDirty();
  }
  const url = projectTopic(key);
  const thread = findThread(key);
  const label = thread ? threadLabel(thread) : url;
  if (!(await confirmDialog({
    title: `Fill the reply box of "${label}" with this draft?`,
    description: 'You review and press Submit in the forum window.',
    confirmText: 'Push',
  }))) return;

  let error = null;
  showOverlay('Rendering canvases...');
  try {
    commitBoardEdit();
    await saveNow();
    const payload = await buildPayload(state.editor, state.settings, state.draft);
    showOverlay('Uploading images in the forum window...');
    const result = await service.push({ threadUrl: url, ...payload });
    if (!result?.ok) throw new Error(result?.error || 'Unknown error');
    state.draft.pushedAt = Date.now();
    state.dirty = true;
    setState({}); // after the in-place change of state.draft
    await saveNow();
  } catch (e) {
    error = e;
  }
  hideOverlay();
  if (error) await alertDialog('Push failed', String(error.message || error));
  else toast('Content placed in the forum reply box. Review it there and press Submit.');
}
