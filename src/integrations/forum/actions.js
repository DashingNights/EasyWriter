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
//   posts(urls: at most 50 topic URLs of forumUrl) -> {threads: [{url, posts: [{id, url, date, html, media}]} | {url, error}]}, the
//     signed-in member's own posts (docs/plans/onboarding.md Forum import); it throws when nobody is signed in
//   download(url: https) -> {type, data: Uint8Array}, one picture or video of an imported post, with the forum's sign-in
const service = window.api.forum;

import {
  addProject, alertDialog, changeSettings, commitBoardEdit, confirmDialog, hideOverlay, markDirty, openDialog, saveNow, saveSettings, selectThread,
  showOverlay, threadLabel, toast, updateDraft,
} from '../../app/actions.js';
import { fail } from '../../app/commands/define.mjs';
import { getState, setState, subscribe } from '../../app/store.js';
import { tagList } from '../../app/drafts-meta.js';
import { kitOf } from '../../editors.js';
import { FORMATS } from '../../formats.mjs';
import { enabled } from '../index.mjs';
import { buildPayload } from './export.js';
import { fillPlaceholders, placeholderUrls, postTitle, postToDoc } from './import.mjs';
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

/** The setup's sign-in (ui.jsx SetupThreads) on forum `site` (set when none is yet): no window while the forum already knows
 * the member, else the forum window's login, which resolves once signed in or once the window closes. `onWindow()` runs just
 * before that window opens; false from it (the page dropped this sign-in) opens none. Keeps the status bar's status. → the status. */
export async function signIn(site, onWindow = () => {}) {
  if (!settings().forumUrl) await saveSettings({ forumUrl: site });
  let status = await service.status();
  if (!status.loggedIn && onWindow() !== false) status = await service.login();
  setState({ status });
  return status;
}

/** The setup's threads (canonical topic URLs) as projects: a project that links one already is kept, the others are added
 * (addLinkedProject, which looks each up on the forum). → their project keys, in order. */
export async function linkThreads(topics) {
  const keys = [];
  for (const topic of topics) keys.push(findThread(topic)?.url ?? await addLinkedProject('', topic));
  return keys;
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

// ---------------------------------------------------------------------------------------------
// Import of the member's earlier posts (docs/plans/onboarding.md Forum import). Drafts are written through window.api.drafts
// directly: a new draft here is never the open one, so the editor and its autosave stay as they are.

// ponytail: the forum's clock against this computer's. Two posts of the member in one thread closer together than this can pair
// a pushed draft with the wrong post.
const CLOCK_SKEW = 2 * 60000;

/** The draft id of post `postId` on forum `site`: the same on every import, so a post imported before is found by it. */
async function postDraftId(site, postId) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${site}#${postId}`)));
  const h = [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Imports the signed-in member's own posts in the forum threads of the projects keyed `projectKeys` as forum post drafts: each
 * titled by its first line, in its project, tagged Done, marked pushed (and created) at the post's date, its pictures and
 * videos placeholders that download in the background (downloadMedia). A post imported before, or pushed from this app, is
 * skipped. `onProgress({found, imported})` follows the count. → {found, imported, skipped, failed: [{url, error}], downloads};
 * throws when nobody is signed in to the forum. */
export async function importPosts(projectKeys, onProgress = () => {}) {
  const topics = new Map(); // topic URL → project key
  const failed = [];
  for (const key of new Set(projectKeys)) {
    const topic = projectTopic(key);
    if (topic) topics.set(topic, key);
    else failed.push({ url: key, error: 'The project links no forum thread' });
  }
  let found = 0;
  let imported = 0;
  let skipped = 0;
  let downloads = 0;
  if (!topics.size) return { found, imported, skipped, failed, downloads };
  const { threads } = await service.posts([...topics.keys()]);
  found = threads.reduce((n, t) => n + (t.posts?.length ?? 0), 0);
  onProgress({ found, imported });
  const done = tagList(settings()).find((t) => t.id === 'done') ?? tagList(settings()).find((t) => /^done$/i.test(t.name));
  const format = FORMATS['forum-post'];
  const { schema } = kitOf(format.id);
  const tags = {};
  const pending = [];
  for (const t of threads) {
    if (!t.posts) {
      failed.push({ url: t.url, error: t.error });
      continue;
    }
    const key = topics.get(t.url);
    const ids = new Set(getState().drafts.map((d) => d.id));
    const pushed = getState().drafts.filter((d) => d.threadUrl === key && d.pushedAt).map((d) => d.pushedAt);
    let prev = -Infinity; // the date of the member's post before this one in the thread
    for (const post of t.posts) {
      const date = Date.parse(post.date); // NaN: the page showed none
      const id = await postDraftId(siteOf(t.url), post.id);
      // Imported before (its id), or pushed from this app: a draft of the project pushed after the member's previous post and
      // before this one (the reply box is filled first, then submitted by hand).
      const had = ids.has(id) || (!Number.isNaN(date) && pushed.some((at) => at > prev + CLOCK_SKEW && at <= date + CLOCK_SKEW));
      if (!Number.isNaN(date)) prev = date;
      if (had) {
        skipped++;
        continue;
      }
      const at = Number.isNaN(date) ? Date.now() : date;
      const doc = postToDoc(post.html, post.media);
      // A given id keeps `created` at the post's date (main sets created only for a record without an id).
      const draft = { id, title: postTitle(doc, post.date), threadUrl: key, created: at, pushedAt: at, format: format.id,
        formatVersion: format.version, doc };
      try {
        schema.nodeFromJSON(doc).check(); // the editor would drop what its schema cannot hold
        await window.api.drafts.save(draft);
      } catch (e) {
        failed.push({ url: post.url, error: String(e.message || e) });
        continue;
      }
      ids.add(id);
      if (done) tags[draft.id] = done.id;
      const n = placeholderUrls(doc).length;
      if (n) {
        pending.push(draft.id);
        downloads += n;
      }
      onProgress({ found, imported: ++imported });
    }
  }
  if (imported) {
    setState({ drafts: await window.api.drafts.list() });
    await saveSettings({ draftTags: { ...settings().draftTags, ...tags }, ...(pending.length && { forumMedia: [...(settings().forumMedia ?? []), ...pending] }) });
  }
  if (pending.length) downloadMedia();
  return { found, imported, skipped, failed, downloads };
}

const dataUrlOf = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/** The placeholder URLs of draft `id`: its file's, and the open editor's while it is the open draft (the two differ until the
 * editor's next save). [] when the draft is gone, null when its file could not be read. */
async function pendingUrls(id) {
  let file;
  try {
    file = await window.api.drafts.load(id);
  } catch {
    return null;
  }
  if (!file) return [];
  const { draft, editor } = getState();
  const open = draft?.id === id && editor ? placeholderUrls(editor.getJSON()) : [];
  return [...new Set([...placeholderUrls(file.doc ?? {}), ...open])];
}

/** Puts `files` ({url: data URL}) in draft `id`'s placeholders: another draft loaded, patched and saved; the open draft in one
 * transaction outside the undo history, saved at once, also when it opened while its file was patched (it may have loaded the
 * old file). A fill that still gets lost (the draft switched while it landed) leaves the placeholder, which the next pass sees. */
async function fill(id, files) {
  if (getState().draft?.id !== id) {
    const doc = (await window.api.drafts.load(id))?.doc;
    // ponytail: load, then save through updateDraft; an edit to that draft landing in between (the background window) is lost.
    // Lock per draft if that window starts editing imported drafts while they download.
    if (doc) await updateDraft(id, { doc: fillPlaceholders(doc, files) });
  }
  const { draft, editor } = getState();
  if (draft?.id !== id || !editor) return;
  const tr = editor.state.tr;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'media' && files[node.attrs.src]) tr.setNodeMarkup(pos, null, { ...node.attrs, src: files[node.attrs.src] });
  });
  if (!tr.docChanged) return;
  editor.view.dispatch(tr.setMeta('addToHistory', false));
  await saveNow(); // not the 800 ms autosave: openDraft may replace this editor before then
}

let downloading = null;
let again = false;
let watched;

/** The import's background downloads: every placeholder of the drafts in settings.forumMedia, fetched by main (at most three
 * at a time) and swapped for its file. A draft leaves the list once its file and open editor hold no placeholder; a failed
 * download stays a placeholder and is tried again on the next start (ui.jsx init), the next import or when its draft opens.
 * The status bar shows the count (store forumDownloads). Never throws. */
export function downloadMedia() {
  watchEditor();
  if (downloading) {
    again = true;
    return downloading;
  }
  downloading = (async () => {
    // The app opens its first draft after the integrations' init: start once it has, so no fill races that load.
    while (!getState().editor) await new Promise((r) => setTimeout(r, 200));
    // Another pass while one was asked for, or while the last one fetched every file and left fewer placeholders (a fill lost
    // to a draft switch); a pass that leaves as many as it found ends it.
    let before = Infinity;
    for (;;) {
      again = false;
      const { total, failed } = await downloadPass().catch(() => ({ total: 0, failed: 1 }));
      if (!again && (failed || !total || total >= before)) break;
      before = total;
    }
  })().finally(() => {
    downloading = null;
    setState({ forumDownloads: 0 });
  });
  return downloading;
}

/** An editor that opens on a draft with placeholders (one opened from a file older than its last fill, or a pasted
 * placeholder) puts that draft on the list and starts the downloads. */
function watchEditor() {
  if (watched !== undefined) return;
  watched = null;
  subscribe(() => {
    const { draft, editor } = getState();
    if (editor === watched) return;
    watched = editor;
    if (!editor || !draft?.id || !enabled(settings(), 'forum') || !placeholderUrls(editor.getJSON()).length) return;
    const list = settings().forumMedia ?? [];
    (list.includes(draft.id) ? Promise.resolve() : saveSettings({ forumMedia: [...list, draft.id] })).then(downloadMedia, () => {});
  });
}

/** One pass over settings.forumMedia → {total: placeholders found, failed: downloads that failed}. */
async function downloadPass() {
  const work = [];
  for (const id of settings().forumMedia ?? []) work.push({ id, urls: await pendingUrls(id) });
  const total = work.reduce((n, w) => n + (w.urls?.length ?? 0), 0);
  let left = total;
  let failed = 0;
  setState({ forumDownloads: left });
  let listed = Promise.resolve(); // settings.forumMedia changes one at a time
  // Every file at once: main's three download slots set the pace, so a slow file holds up only itself. A draft's fills run one
  // after another (each loads and saves it), and a draft whose placeholders are all gone leaves forumMedia.
  await Promise.all(work.filter((w) => w.urls).map(async (w) => {
    let filled = Promise.resolve();
    await Promise.all(w.urls.map(async (url) => {
      try {
        const { type, data } = await service.download(url);
        const file = await dataUrlOf(new Blob([data], { type }));
        filled = filled.then(() => fill(w.id, { [url]: file })).catch(() => {});
      } catch {
        failed++;
      }
      setState({ forumDownloads: --left });
    }));
    await filled;
    const rest = await pendingUrls(w.id);
    if (rest && !rest.length) listed = listed.then(() => saveSettings({ forumMedia: (settings().forumMedia ?? []).filter((id) => id !== w.id) })).catch(() => {});
  }));
  await listed;
  return { total, failed };
}

/** Tool search's Import my forum posts: signs in when needed, asks, then imports the posts of every project's forum thread
 * (at most 50) with the count on the overlay. */
export async function importAll() {
  const keys = settings().threads.filter((t) => projectTopic(t.url)).map((t) => t.url).slice(0, 50);
  if (!keys.length) return toast('No project links a forum thread yet. Link one from its row in the sidebar first.', true);
  if (!getState().status.loggedIn) {
    await login();
    if (!getState().status.loggedIn) return;
  }
  if (!(await confirmDialog({
    title: 'Import your earlier posts as drafts?',
    description: `Your own posts in ${keys.length === 1 ? 'the linked forum thread' : `${keys.length} linked forum threads`} become drafts, marked pushed and tagged Done. Pictures and videos download in the background, so you can keep writing.`,
    confirmText: 'Import',
  }))) return;
  showOverlay('Looking for your posts...');
  let result;
  try {
    result = await importPosts(keys, ({ found, imported }) => showOverlay(`${found} posts found, ${imported} imported`));
  } catch (e) {
    hideOverlay();
    return alertDialog('Import failed', String(e.message || e));
  }
  hideOverlay();
  const { imported, skipped, failed } = result;
  toast([`${imported} ${imported === 1 ? 'post' : 'posts'} imported`, skipped && `${skipped} imported before`, failed.length && `${failed.length} could not be read`]
    .filter(Boolean).join(', ') + '.', failed.length > 0);
}
