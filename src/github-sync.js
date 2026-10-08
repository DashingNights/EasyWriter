'use strict';
// GitHub backup (SPEC §4b): the synced files go to one private repository through GitHub's REST API (no git): the drafts with
// their undo history, plans, flowcharts, prefabs and the drafts' metadata from settings. Login is GitHub's device flow; the
// token is kept encrypted (safeStorage) in github-token.json. github-sync.json holds the last synced commit and each file's
// blob SHA at that commit, the base of a three-way merge per file.
const { app, dialog, net, safeStorage, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const crypto = require('crypto');
const { readJson, serialized, writeJsonAtomic } = require('./file-family.js');

// The OAuth app the device flow logs in to (github.com/settings/developers, "Enable Device Flow" ticked). A client ID is public.
const CLIENT_ID = process.env.EASYWRITER_GITHUB_CLIENT_ID || 'Ov23liF2DRVkwtYJ59dw';
const API = 'https://api.github.com';
const DIRS = ['drafts', 'plans', 'flowcharts', 'prefabs'];
const NAME_RE = /^[a-f0-9-]{36}(\.history)?\.json$/;
const PATH_RE = new RegExp(`^(${DIRS.join('|')})/[a-f0-9-]{36}(\\.history)?\\.json$`);
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SETTINGS_FILE = 'settings.json';
const SETTINGS_KEYS = ['threads', 'folders', 'draftFolders', 'draftOrder', 'draftTags', 'tags'];
const MARKER = '.easywriter'; // a repository holding it is an EasyWriter backup; any other non-empty one is refused
const MARKER_BODY = Buffer.from('{"app":"EasyWriter","format":1}\n');
const MIN_SECONDS = 30;
const CHUNK = 8 * 1024 * 1024; // inline content per tree request; a bigger file goes up as a blob of its own
const DEFAULTS = { enabled: false, repo: '', intervalSec: 300, onClose: 'ask' }; // onClose: ask | push | skip

const userFile = (name) => path.join(app.getPath('userData'), name);
const tokenFile = () => userFile('github-token.json');
const stateFile = () => userFile('github-sync.json');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let hooks; // main.js: {getSettings, setSettings, win, flush, reload, busy}
let auth; // undefined until read, then null or {login, token}
let cfg = null; // settings.github as last configured
let timer = null;
let active = false; // a synced file was written since the last sync
let running = Promise.resolve();
let loginRun = null;
const status = { busy: false, lastSync: null, error: null };

// ---------------------------------------------------------------------------------------------
// Login

async function getAuth() {
  if (auth === undefined) {
    try {
      const f = await readJson(tokenFile());
      auth = f?.token ? { login: f.login, token: safeStorage.decryptString(Buffer.from(f.token, 'base64')) } : null;
    } catch {
      auth = null; // unreadable, or encrypted for another Windows account
    }
  }
  return auth;
}

async function setAuth(next) {
  if (!next) {
    auth = null;
    return fs.rm(tokenFile(), { force: true });
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer cannot store the GitHub login safely.');
  await serialized(() => writeJsonAtomic(tokenFile(), { login: next.login, token: safeStorage.encryptString(next.token).toString('base64') }));
  auth = next;
}

async function post(url, body) {
  const res = await net.fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GitHub login failed (HTTP ${res.status}).`);
  return res.json();
}

/** Starts GitHub's device flow and opens its page in the browser → {userCode, uri}; loginWait() resolves once the user entered it. */
async function login() {
  if (!CLIENT_ID) throw new Error('This build has no GitHub app ID (EASYWRITER_GITHUB_CLIENT_ID).');
  if (loginRun) loginRun.cancelled = true;
  const r = await post('https://github.com/login/device/code', { client_id: CLIENT_ID, scope: 'repo' });
  if (r.error) throw new Error(r.error_description || r.error);
  const run = (loginRun = { cancelled: false });
  run.done = poll(run, r);
  run.done.catch(() => {});
  shell.openExternal(r.verification_uri);
  return { userCode: r.user_code, uri: r.verification_uri };
}

async function poll(run, { device_code, interval = 5, expires_in = 900 }) {
  const end = Date.now() + expires_in * 1000;
  while (Date.now() < end) {
    await delay(interval * 1000);
    if (run.cancelled) throw new Error('Login cancelled.');
    const r = await post('https://github.com/login/oauth/access_token', {
      client_id: CLIENT_ID, device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (run.cancelled) throw new Error('Login cancelled.');
    if (r.access_token) {
      const { login: name } = await gh('GET', '/user', null, { token: r.access_token });
      await setAuth({ login: name, token: r.access_token });
      setStatus({ error: null });
      if (cfg?.enabled && cfg.repo) sync().catch(() => {}); // logging in with the backup on pulls first
      return publicStatus();
    }
    if (r.error === 'slow_down') interval = r.interval ?? interval + 5;
    else if (r.error !== 'authorization_pending') throw new Error(r.error_description || r.error);
  }
  throw new Error('The login code expired. Try again.');
}

function loginWait() {
  if (!loginRun) throw new Error('No GitHub login is running.');
  return loginRun.done;
}

async function logout() {
  if (loginRun) loginRun.cancelled = true;
  await setAuth(null);
  setStatus({ error: null });
}

// ---------------------------------------------------------------------------------------------
// REST API

/** A GitHub API call → its JSON (raw: the body's bytes). A failure throws with the HTTP status as `status`. */
async function gh(method, url, body, { raw = false, token = null } = {}) {
  token ??= (await getAuth())?.token;
  if (!token) throw new Error('Not logged in to GitHub.');
  const res = await net.fetch(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store', // GitHub's responses may be cached for 60 s: a stale branch head breaks the push
    signal: AbortSignal.timeout(120000),
  });
  if (res.status === 401) {
    await setAuth(null);
    setStatus({});
    throw new Error('The GitHub login has expired. Log in again in Settings.');
  }
  if (!res.ok) {
    const msg = (await res.json().catch(() => null))?.message;
    throw Object.assign(new Error(`GitHub: ${msg || `HTTP ${res.status}`}`), { status: res.status });
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

/** The user's private repositories they can push to (full names, last updated first). */
async function repos() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const list = await gh('GET', `/user/repos?visibility=private&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`);
    out.push(...list.filter((r) => r.permissions?.push).map((r) => r.full_name));
    if (list.length < 100) break;
  }
  return out;
}

/** The repository's default branch, its head commit (null: empty) and its files {path: blob sha}. Throws for a repository
 * that is not private, not writable, or not empty without being an EasyWriter backup. `base` saves the tree reads when the
 * head is the last synced commit. */
const refuse = (message) => Object.assign(new Error(message), { refused: true });
const refPath = (branch) => `heads/${branch.split('/').map(encodeURIComponent).join('/')}`;

async function readRemote(repo, base) {
  if (!REPO_RE.test(repo)) throw refuse('Invalid repository name.');
  const info = await gh('GET', `/repos/${repo}`);
  if (!info.private) throw refuse(`${repo} is public. Choose a private repository.`);
  if (info.permissions && !info.permissions.push) throw refuse(`You cannot push to ${repo}.`);
  const branch = info.default_branch;
  let head;
  try {
    head = (await gh('GET', `/repos/${repo}/git/ref/${refPath(branch)}`)).object.sha;
  } catch (e) {
    if (e.status !== 409) throw e; // 409: the repository is empty
    return { branch, head: null, files: {} };
  }
  if (head === base?.head) return { branch, head, files: base.files };
  const commit = await gh('GET', `/repos/${repo}/git/commits/${head}`);
  const tree = await gh('GET', `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new Error(`${repo} has too many files to read.`);
  const files = {};
  for (const e of tree.tree) if (e.type === 'blob') files[e.path] = e.sha;
  if (!files[MARKER]) throw refuse(`${repo} is not empty. Choose an empty private repository.`);
  return { branch, head, files };
}

/** → {ok, empty} or {ok: false, error, refused}; refused: this repository can never be used (not just unreachable now). */
async function checkRepo(repo) {
  try {
    return { ok: true, empty: !(await readRemote(repo)).head };
  } catch (e) {
    return { ok: false, error: e.message, refused: !!e.refused || e.status === 404 };
  }
}

// ---------------------------------------------------------------------------------------------
// Files

const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const shas = (files) => Object.fromEntries([...files].map(([p, b]) => [p, blobSha(b)]));
const settingsBody = (s) => Buffer.from(JSON.stringify(Object.fromEntries(SETTINGS_KEYS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]))));
const enoent = (e) => { if (e.code !== 'ENOENT') throw e; };

/** This computer's synced files → Map(repo path → bytes). */
async function readLocal() {
  const files = new Map([[MARKER, MARKER_BODY]]);
  for (const dir of DIRS) {
    const names = await fs.readdir(userFile(dir)).catch((e) => (enoent(e), []));
    for (const n of names) {
      if (!NAME_RE.test(n)) continue;
      const buf = await fs.readFile(path.join(userFile(dir), n)).catch(enoent);
      if (buf) files.set(`${dir}/${n}`, buf);
    }
  }
  files.set(SETTINGS_FILE, settingsBody(await hooks.getSettings()));
  return files;
}

/** Three-way merge per file of {path: sha} maps (a missing path = no file) → {take: the paths to copy from remote (missing
 * there: delete here), conflicts: the paths both sides changed since base, differently}. A path only this computer changed
 * stays as it is and goes up with the next push. */
function plan(local, remote, base) {
  const take = [];
  const conflicts = [];
  for (const p of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const [l, r, b] = [local[p], remote[p], base[p]];
    if (l === r || r === b) continue;
    (l === b ? take : conflicts).push(p);
  }
  return { take, conflicts };
}

const parse = (buf) => {
  try {
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  } catch {
    return null;
  }
};
const KIND = { drafts: 'Draft', plans: 'Plan', flowcharts: 'Flowchart', prefabs: 'Prefab' };

/** A conflict's line in the question: what it is, its name and which side saved it last. */
function describe(p, local, bodies) {
  if (p === SETTINGS_FILE) return 'Threads, folders and tags';
  const record = p.replace(/\.history\.json$/, '.json');
  const here = parse(local.get(record));
  const there = bodies.get(record);
  const name = here?.title ?? here?.name ?? there?.title ?? there?.name ?? path.basename(record, '.json');
  const newer = here?.updated && there?.updated && here.updated !== there.updated
    ? (here.updated > there.updated ? ', newer here' : ', newer on GitHub') : '';
  return `${KIND[p.split('/')[0]]} "${name}"${newer}`;
}

/** Asks which version of the conflicting files to keep → 'cloud' | 'local' | null (not now). `first`: this computer never
 * synced with the repository, so GitHub's version is the default button. */
async function ask(conflicts, local, bodies, first) {
  const lines = [...new Set(conflicts.map((p) => describe(p, local, bodies)))];
  const shown = lines.slice(0, 12).map((l) => `- ${l}`).join('\n') + (lines.length > 12 ? `\n- ${lines.length - 12} more` : '');
  const win = hooks.win();
  const { response } = await dialog.showMessageBox(...(win ? [win] : []), {
    type: 'question',
    title: 'GitHub backup',
    message: 'These changed on this computer and on GitHub since the last sync.',
    detail: `${shown}\n\nThe other version is not lost. GitHub keeps every backup, and files replaced on this computer are copied to the github-backups folder first.`,
    buttons: ['Use the GitHub version', "Keep this computer's version", 'Not now'],
    defaultId: first ? 0 : 1,
    cancelId: 2,
    noLink: true,
  });
  return ['cloud', 'local', null][response];
}

/** Copies the remote version of `paths` here (parsed `bodies`; a path missing from them is deleted). Each file it replaces is
 * first copied to github-backups/<time>/ (a deleted one is moved there). */
async function apply(paths, bodies) {
  const backup = path.join('github-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  for (const p of paths) {
    const kept = userFile(path.join(backup, p));
    await fs.mkdir(path.dirname(kept), { recursive: true });
    if (p === SETTINGS_FILE) {
      await fs.writeFile(kept, settingsBody(await hooks.getSettings()));
      const remote = bodies.get(p) ?? {};
      await hooks.setSettings(Object.fromEntries(SETTINGS_KEYS.map((k) => [k, remote[k]])));
    } else if (bodies.has(p)) {
      await fs.copyFile(userFile(p), kept).catch(enoent);
      await serialized(() => writeJsonAtomic(userFile(p), bodies.get(p)));
    } else {
      await serialized(() => fs.rename(userFile(p), kept).catch(enoent));
    }
  }
}

/** Commits `local` (Map path → bytes) on top of `remote` unless the remote tree already matches → {head, files}. */
async function push(repo, remote, local) {
  let head = remote.head;
  let have = remote.files;
  if (!head) { // an empty repository: the git database API needs a first commit, which the contents API can make
    const r = await gh('PUT', `/repos/${repo}/contents/${MARKER}`, { message: 'Start the EasyWriter backup', content: MARKER_BODY.toString('base64'), branch: remote.branch });
    head = r.commit.sha;
    have = { [MARKER]: blobSha(MARKER_BODY) };
  }
  const sha = shas(local);
  const paths = Object.keys(sha);
  if (paths.length === Object.keys(have).length && paths.every((p) => have[p] === sha[p])) return { head, files: sha };
  // The first tree request lists every file (no base tree, so files gone here are gone there); the rest add to it.
  const entry = (p, more) => ({ path: p, mode: '100644', type: 'blob', ...more });
  let batch = [];
  let size = 0;
  let tree = null;
  const send = async () => {
    tree = (await gh('POST', `/repos/${repo}/git/trees`, { tree: batch, ...(tree && { base_tree: tree }) })).sha;
    batch = [];
    size = 0;
  };
  for (const [p, buf] of local) {
    if (have[p] === sha[p]) batch.push(entry(p, { sha: sha[p] }));
    else if (buf.length > CHUNK) batch.push(entry(p, { sha: (await gh('POST', `/repos/${repo}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' })).sha }));
  }
  for (const [p, buf] of local) {
    if (have[p] === sha[p] || buf.length > CHUNK) continue;
    if (size && size + buf.length > CHUNK) await send();
    batch.push(entry(p, { content: buf.toString('utf8') })); // the files are JSON, so UTF-8 text
    size += buf.length;
  }
  await send();
  const commit = await gh('POST', `/repos/${repo}/git/commits`, { message: `Backup from ${os.hostname()}`, tree, parents: [head] });
  await gh('PATCH', `/repos/${repo}/git/refs/${refPath(remote.branch)}`, { sha: commit.sha }); // 422 when the branch moved
  return { head: commit.sha, files: sha };
}

// ---------------------------------------------------------------------------------------------
// Sync

const publicStatus = () => ({ ...status, login: auth?.login ?? null, configured: !!CLIENT_ID, enabled: !!cfg?.enabled, repo: cfg?.repo ?? '' });

function setStatus(patch) {
  Object.assign(status, patch);
  const win = hooks.win();
  if (win && !win.isDestroyed()) win.webContents.send('github.event', publicStatus());
}

/** Pulls what changed on GitHub, then pushes what changed here. One at a time; `closing`: the window is about to close, so
 * it is not reloaded after a pull. → 'deferred' when the user put off the conflict question. */
function sync(opts) {
  const run = running.then(() => doSync(opts));
  running = run.catch(() => {});
  return run;
}

async function doSync({ closing = false, retry = true } = {}) {
  if (!cfg?.enabled || !cfg.repo || !(await getAuth())) return;
  const repo = cfg.repo;
  let covered = false;
  setStatus({ busy: true });
  try {
    let base = await readJson(stateFile()).catch(() => null);
    // Never synced with this repository: a fresh install's settings count as unchanged, so GitHub's threads and tags come in.
    if (base?.repo !== repo) base = { repo, head: null, files: { [SETTINGS_FILE]: blobSha(settingsBody({ threads: [] })) } };
    const remote = await readRemote(repo, base);
    // New commits there: the open draft's last change goes to disk before the merge reads it.
    const news = remote.head && remote.head !== base.head;
    if (news && !closing) { // the window takes no input until it reloads with the merged files
      hooks.busy('Syncing with GitHub...');
      covered = true;
    }
    if (news && (await hooks.flush()) === false) throw new Error('The open draft could not be saved, so nothing was synced.');
    let local = await readLocal();
    if (news) {
      const theirs = Object.fromEntries(Object.entries(remote.files).filter(([p]) => p === SETTINGS_FILE || PATH_RE.test(p)));
      const ours = shas(local);
      delete ours[MARKER];
      const { take, conflicts } = plan(ours, theirs, base.files);
      const bodies = new Map();
      for (const p of [...take, ...conflicts]) {
        if (theirs[p]) bodies.set(p, JSON.parse((await gh('GET', `/repos/${repo}/git/blobs/${theirs[p]}`, null, { raw: true })).toString('utf8')));
      }
      let paths = take;
      if (conflicts.length) {
        const choice = await ask(conflicts, local, bodies, !base.head);
        if (!choice) {
          active = true; // asked again on the next tick
          return 'deferred';
        }
        if (choice === 'cloud') paths = [...take, ...conflicts];
      }
      if (paths.length) {
        await apply(paths, bodies);
        local = await readLocal();
        if (!closing) hooks.reload();
      }
      // Merged: GitHub's head is the new base, so a failed or retried push does not merge (or ask) again.
      await serialized(() => writeJsonAtomic(stateFile(), { repo, head: remote.head, files: remote.files }));
    }
    const next = await push(repo, remote, local);
    await serialized(() => writeJsonAtomic(stateFile(), { repo, ...next }));
    setStatus({ lastSync: Date.now(), error: null });
  } catch (e) {
    if (e.status === 422 && retry) return await doSync({ closing, retry: false }); // the branch moved during the push
    active = true; // the next tick tries again
    setStatus({ error: e.message });
    throw e;
  } finally {
    if (covered) hooks.busy(null);
    setStatus({ busy: false });
  }
}

/** Whether this computer has changes the last sync did not push. */
async function pending() {
  const base = await readJson(stateFile()).catch(() => null);
  if (base?.repo !== cfg.repo) return true;
  const now = shas(await readLocal());
  const paths = Object.keys(now);
  return paths.length !== Object.keys(base.files).length || paths.some((p) => now[p] !== base.files[p]);
}

/** Main's settings changed: the push timer follows them; turning the backup on or picking another repository syncs at once. */
function configure(settings) {
  const next = { ...DEFAULTS, ...settings.github };
  const changed = cfg && (next.repo !== cfg.repo || next.enabled !== cfg.enabled);
  cfg = next;
  clearInterval(timer);
  timer = null;
  if (cfg.enabled && cfg.repo) {
    timer = setInterval(() => {
      if (!active) return;
      active = false;
      sync().catch(() => {});
    }, Math.max(MIN_SECONDS, Number(cfg.intervalSec) || DEFAULTS.intervalSec) * 1000);
  }
  getAuth().then(() => setStatus({}));
  if (changed && cfg.enabled && cfg.repo) sync().catch(() => {});
}

/** A synced file was written: the next tick pushes. */
const touch = () => { active = true; };

/** Whether closing the window should wait for beforeClose (logged in, the backup on, closing does not skip it). */
const closeCheck = () => !!(auth && cfg?.enabled && cfg.repo && cfg.onClose !== 'skip');

/** Before the window closes: with unpushed changes, asks whether to push them (or pushes, as the user chose to always do).
 * → false to keep the window open. */
async function beforeClose(win) {
  if ((await hooks.flush()) === false || !(await pending())) return true;
  if (cfg.onClose !== 'push') {
    const { response, checkboxChecked } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'GitHub backup',
      message: 'Push your changes to GitHub before closing?',
      buttons: ['Push', "Don't push", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: "Don't ask again",
      noLink: true,
    });
    if (response === 2) return false;
    if (checkboxChecked) await hooks.setSettings({ github: { ...cfg, onClose: response === 0 ? 'push' : 'skip' } });
    if (response === 1) return true;
  }
  hooks.busy('Pushing to GitHub...');
  try {
    if ((await sync({ closing: true })) === 'deferred') throw new Error('Nothing was pushed because the question was put off.');
    return true;
  } catch (e) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'GitHub backup',
      message: 'Your changes could not be pushed to GitHub.',
      detail: e.message,
      buttons: ['Close anyway', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return response === 0;
  } finally {
    hooks.busy(null);
  }
}

function register(handle, h) {
  hooks = h;
  handle('github.status', () => getAuth().then(publicStatus));
  handle('github.login', login);
  handle('github.loginWait', loginWait);
  handle('github.logout', logout);
  handle('github.repos', repos);
  handle('github.checkRepo', checkRepo);
  handle('github.syncNow', () => sync().then(publicStatus));
  handle('github.start', () => { sync().catch(() => {}); }); // the renderer has started: pull what changed while the app was closed
}

module.exports = { register, configure, touch, closeCheck, beforeClose, plan, blobSha, DEFAULTS, SETTINGS_KEYS };
