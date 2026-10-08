'use strict';
// Sign in with Chrome (SPEC §7j). Google refuses sign-in from embedded browsers, and spoofing the UA / Sec-CH-UA /
// userAgentData did not change that. So we hand the sign-in to a real Chrome (or Edge) on a dedicated profile, then copy the
// resulting cookies into the in-app browser's persist:browser session. Cookie values stay in the main process and are never
// logged.
const { app, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CHROME = ['Google', 'Chrome', 'Application', 'chrome.exe'];
const EDGE = ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
const BASES = () => [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);

/** The first installed Chrome, else Edge (Google accepts Edge): {exe, name}. null if neither is found. */
function findBrowser() {
  for (const parts of [CHROME, EDGE]) {
    for (const base of BASES()) {
      const exe = path.join(base, ...parts);
      if (fs.existsSync(exe)) return { exe, name: parts === CHROME ? 'Chrome' : 'Edge' };
    }
  }
  return null;
}

const SAME_SITE = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' };
const bareDomain = (domain) => domain.replace(/^\./, '');
const isGoogle = (domain) => { const d = bareDomain(domain); return d === 'google.com' || d.endsWith('.google.com'); };

/** A CDP Network.Cookie mapped to electron session.cookies.set details, or {skip} for a cookie Electron cannot set. Pure. */
function toElectronCookie(c) {
  if (c.partitionKey) return { skip: 'partitioned' }; // Electron's cookies.set has no partitionKey
  const host = bareDomain(c.domain);
  const p = c.path || '/';
  const details = {
    url: (c.secure || c.sourceScheme === 'Secure' ? 'https://' : 'http://') + host + p,
    name: c.name,
    value: c.value,
    path: p,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: SAME_SITE[c.sameSite] || 'unspecified',
  };
  if (c.domain.startsWith('.')) details.domain = c.domain; // host-only and __Host- cookies omit domain
  if (typeof c.expires === 'number' && c.expires > 0) details.expirationDate = c.expires; // else a session cookie
  return { details };
}

/** Runs the browser headless on `profile` over --remote-debugging-pipe and returns its cookies (CDP shape). CDP messages are
 * JSON, each NUL-terminated: fd3 to the browser, fd4 from it. No port is opened, so no other process can read the cookies.
 * A pending call fails at once if the child exits or errors; the child never outlives this call. */
async function exportCookies({ exe, name }, profile) {
  const child = spawn(exe, ['--headless', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const pending = new Map();
  let ended = null;
  const end = () => {
    ended ??= new Error(`Could not read ${name}'s cookies.`);
    for (const { reject } of pending.values()) reject(ended);
    pending.clear();
  };
  child.on('error', end);
  child.on('exit', end);
  child.stdio[3].on('error', end); // EPIPE once the browser is gone
  child.stdio[4].on('error', end);
  let buf = Buffer.alloc(0);
  child.stdio[4].on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) !== -1) {
      const text = buf.subarray(0, i).toString('utf8');
      buf = buf.subarray(i + 1);
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }
      pending.get(msg.id)?.resolve(msg);
      pending.delete(msg.id);
    }
  });
  let nextId = 0;
  const send = (method, ms) => new Promise((resolve, reject) => {
    if (ended) return reject(ended);
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Could not read ${name}'s cookies in time.`)); }, ms);
    const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
    pending.set(id, { resolve: done(resolve), reject: done(reject) });
    child.stdio[3].write(JSON.stringify({ id, method, params: {} }) + '\0');
  });
  try {
    const res = await send('Storage.getCookies', EXPORT_TIMEOUT_MS);
    if (!res.result) throw new Error(`Could not read ${name}'s cookies.`);
    await send('Browser.close', 3000).catch(() => {});
    return res.result.cookies || [];
  } finally {
    if (child.exitCode === null && child.signalCode === null) { // child.killed stays false after a clean exit
      const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(r, 3000, false))]);
      if (!gone) child.kill();
    }
  }
}

const SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/';
const EXPORT_TIMEOUT_MS = 20000;
const HANDOFF_MS = 3000; // a sign-in browser that exits sooner handed its URL to one already open on the profile
let running = false;

/** The whole flow (SPEC §7j, IPC browser.chromeSignIn): launch a real browser for the user to sign in, then copy every cookie
 * of its profile into persist:browser. Resolves {ok, browser, imported, google, failed, skipped} or {ok: false, error}.
 * One run at a time. opts is a test seam for the harness only (main.js passes none): opts.url overrides the sign-in URL,
 * opts.onLaunch(child) gets the sign-in child so the harness can close its window. */
async function chromeSignIn(opts = {}) {
  if (running) return { ok: false, error: 'A sign-in is already running.' };
  running = true;
  try {
    const found = findBrowser();
    if (!found) return { ok: false, error: 'No Chrome or Edge browser found.' };
    const profile = path.join(app.getPath('userData'), 'chrome-signin');
    fs.mkdirSync(profile, { recursive: true });

    // Sign-in phase: a plain browser, no remote debugging and no automation flags. DeviceBoundSessions / EnableBoundSessionCredentials
    // off so Google does not bind the session to this browser (which would expire the copied cookies in minutes).
    // ponytail: this feature-disable is the ceiling. Google may still bind or expire the session; the user re-runs the button.
    const started = Date.now();
    const signIn = spawn(found.exe,
      [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
        '--disable-features=DeviceBoundSessions,EnableBoundSessionCredentials', opts.url || SIGN_IN_URL],
      { stdio: 'ignore', windowsHide: false });
    opts.onLaunch?.(signIn);
    // A dedicated --user-data-dir runs its own browser process, which exits when the user closes its window (checked by the
    // harness). One that exits at once handed off to a sign-in window left open by an earlier run (the app closed mid-flow).
    const spawnError = await new Promise((resolve) => { signIn.on('exit', () => resolve(null)); signIn.on('error', resolve); });
    if (spawnError) return { ok: false, error: `Could not start ${found.name}.` };
    if (Date.now() - started < HANDOFF_MS) return { ok: false, error: 'The sign-in window is already open. Sign in there, close it, then try again.' };

    const cookies = await exportCookies(found, profile);
    const ses = session.fromPartition('persist:browser');
    let imported = 0, failed = 0, skipped = 0, google = 0;
    for (const c of cookies) {
      const m = toElectronCookie(c);
      if (m.skip) { skipped++; continue; }
      try {
        await ses.cookies.set(m.details);
        imported++;
        if (isGoogle(c.domain)) google++;
      } catch {
        failed++;
      }
    }
    return { ok: true, browser: found.name, imported, google, failed, skipped };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    running = false;
  }
}

module.exports = { chromeSignIn, toElectronCookie, findBrowser, isGoogle };
