'use strict';
// Dictation (SPEC §7h), main-process side: downloads whisper.cpp (CPU build) and a model into userData/dictation/, runs
// whisper-server on 127.0.0.1 (started at app start when installed, else on first use; kept alive, killed on quit) and
// transcribes the renderer's WAV clips.
const { app, session } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const MB = 1024 * 1024;
const MODEL_REPO = 'ggerganov/whisper.cpp';
// Multilingual models (not .en), so Automatic works. Sizes from the Hugging Face API (lfs size). The first is the default.
const MODELS = [
  { id: 'small', bytes: 487601967, label: 'Small',
    note: 'Recommended. Accurate enough for everyday dictation, in English and other languages, and quick on most computers.' },
  { id: 'large-v3-turbo-q5_0', bytes: 574041195, label: 'Best quality',
    note: 'The most accurate, also with names, punctuation and languages other than English, but bigger and slower on the CPU: needs about 1 GB of memory while dictating.' },
  { id: 'base', bytes: 147951465, label: 'Base',
    note: 'Smallest and fastest, but makes more mistakes: often mishears words, especially with accents or background noise.' },
];
const VAD = { repo: 'ggml-org/whisper-vad', file: 'ggml-silero-v5.1.2.bin', bytes: 885098 };
const BIN = { asset: 'whisper-bin-x64.zip', bytes: 9 * MB, exe: 'whisper-server.exe' }; // the size is an estimate until download
const RELEASES = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30';
const UA = { 'User-Agent': 'daf-writer' };

let getSettings = null;
let getWin = null;
let server = null; // {key, model, proc, ready: Promise<url>}
let install = null; // AbortController of the running install

const dir = () => path.join(app.getPath('userData'), 'dictation');
const exists = (file) => !!file && fs.existsSync(file);
const model = (id) => MODELS.find((m) => m.id === id) || MODELS[0];
const modelFile = (id) => path.join(dir(), `ggml-${model(id).id}.bin`);

function downloadedExe() {
  const bin = path.join(dir(), 'bin');
  const hit = exists(bin) && fs.readdirSync(bin, { recursive: true }).find((f) => path.basename(f) === BIN.exe);
  return hit ? path.join(bin, hit) : null;
}

/** settings.dictation (with `over` laid on it, e.g. the Settings dialog's unsaved fields) → what runs. */
async function config(over = {}) {
  const d = { ...(await getSettings()).dictation, ...over };
  return {
    d,
    url: typeof d.serverUrl === 'string' && /^https?:\/\/\S+$/.test(d.serverUrl) ? d.serverUrl.replace(/\/+$/, '') : '',
    exe: d.serverPath || downloadedExe(),
    model: d.modelPath || modelFile(d.model),
    vad: path.join(dir(), VAD.file),
  };
}

/** {ready, url, missing: [{label, bytes}], models: [{id, label, note, bytes, downloaded}]} for settings.dictation + `over`. */
async function status(over) {
  const c = await config(over);
  const missing = [];
  // A path of the user's that is gone is listed too (the install refuses it), so the status says what is wrong.
  if (!exists(c.exe)) missing.push(c.d.serverPath ? { label: `${c.d.serverPath} (not found)`, bytes: 0 } : { label: 'whisper.cpp server (CPU build)', bytes: BIN.bytes });
  if (!exists(c.model)) {
    missing.push(c.d.modelPath ? { label: `${c.d.modelPath} (not found)`, bytes: 0 } : { label: `Speech model ggml-${model(c.d.model).id}.bin`, bytes: model(c.d.model).bytes });
  }
  if (!exists(c.vad)) missing.push({ label: `Voice activity model ${VAD.file}`, bytes: VAD.bytes });
  return {
    ready: !!c.url || (exists(c.exe) && exists(c.model)),
    url: c.url,
    missing,
    models: MODELS.map((m) => ({ ...m, downloaded: exists(modelFile(m.id)) })),
  };
}

// ---------------------------------------------------------------------------------------------
// Install

const progress = (p) => getWin()?.webContents.send('dictation.progress', p);

async function getJson(url, signal) {
  const res = await fetch(url, { headers: UA, signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// The sha256 Hugging Face lists for a file (its LFS oid), or null when the API does not answer.
async function hfSha(repo, file, signal) {
  try {
    return (await getJson(`https://huggingface.co/api/models/${repo}/tree/main`, signal)).find((f) => f.path === file)?.lfs?.oid ?? null;
  } catch (e) {
    if (signal.aborted) throw e;
    return null;
  }
}

// ponytail: no resume; a cancelled or failed download starts again from zero.
async function download(url, dest, { sha256, signal, report }) {
  const res = await fetch(url, { headers: UA, signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let received = 0;
  let last = 0;
  const count = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      received += chunk.length;
      if (Date.now() - last > 150) {
        last = Date.now();
        report(received, total);
      }
      done(null, chunk);
    },
  });
  const part = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(part), { signal });
    report(received, total);
    if (sha256 && hash.digest('hex') !== sha256) throw new Error(`${path.basename(dest)} is damaged (checksum mismatch). Try again.`);
    await fsp.rename(part, dest);
  } finally {
    await fsp.rm(part, { force: true });
  }
}

const tar = (args) => new Promise((resolve, reject) => {
  // Windows' own bsdtar reads zip files (a Git Bash tar on PATH would not).
  execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), args, { windowsHide: true }, (e) => (e ? reject(e) : resolve()));
});

/** Downloads what model `id` still needs (server, model, VAD model), sending `dictation.progress` events. */
async function runInstall(id) {
  if (install) throw new Error('Dictation is already being installed.');
  install = new AbortController();
  const { signal } = install;
  try {
    const c = await config({ model: model(id).id });
    const lost = [c.d.serverPath, c.d.modelPath].find((p) => p && !exists(p)); // nothing to download for it: say so
    if (lost) throw new Error(`${lost} was not found (Settings > Dictation > Advanced).`);
    await fsp.mkdir(dir(), { recursive: true });
    const steps = [];
    if (!exists(c.exe) && !c.d.serverPath) {
      steps.push(['whisper.cpp server', async (report) => {
        // Binaries are attached to the nightly bNNNN releases (the vX.Y.Z releases have none): the newest that has one.
        const asset = (await getJson(RELEASES, signal)).flatMap((r) => (r.draft ? [] : r.assets)).find((a) => a.name === BIN.asset);
        if (!asset) throw new Error(`No whisper.cpp release has ${BIN.asset}.`);
        const zip = path.join(dir(), BIN.asset);
        const bin = path.join(dir(), 'bin');
        await download(asset.browser_download_url, zip, { sha256: asset.digest?.replace(/^sha256:/, ''), signal, report });
        await fsp.rm(bin, { recursive: true, force: true });
        await fsp.mkdir(bin);
        await tar(['-xf', zip, '-C', bin]).finally(() => fsp.rm(zip, { force: true }));
        if (!downloadedExe()) throw new Error(`${BIN.exe} is missing from ${BIN.asset}.`);
      }]);
    }
    if (!exists(c.model) && !c.d.modelPath) {
      const file = path.basename(c.model);
      steps.push(['speech model', async (report) => {
        const sha256 = await hfSha(MODEL_REPO, file, signal);
        await download(`https://huggingface.co/${MODEL_REPO}/resolve/main/${file}`, c.model, { sha256, signal, report });
      }]);
    }
    if (!exists(c.vad)) {
      steps.push(['voice activity model', async (report) => {
        const sha256 = await hfSha(VAD.repo, VAD.file, signal);
        await download(`https://huggingface.co/${VAD.repo}/resolve/main/${VAD.file}`, c.vad, { sha256, signal, report });
      }]);
    }
    for (const [i, [label, run]] of steps.entries()) {
      progress({ step: i + 1, steps: steps.length, label, received: 0, total: 0 });
      await run((received, total) => progress({ step: i + 1, steps: steps.length, label, received, total }));
    }
    return true;
  } catch (e) {
    throw signal.aborted ? new Error('cancelled') : e;
  } finally {
    install = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Server

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitHealthy(url, exited) {
  for (const end = Date.now() + 180000; Date.now() < end && !exited();) {
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(exited() ? 'exited' : 'whisper-server did not start within 3 minutes');
}

function startServer(c, key) {
  const s = { key, model: c.model, proc: null };
  s.ready = (async () => {
    if (!exists(c.exe) || !exists(c.model)) throw new Error('Dictation is not installed (Settings > Dictation).');
    const port = await freePort();
    if (server !== s) throw new Error('stopped'); // replaced or quit meanwhile: a process spawned now would be orphaned
    const threads = Math.max(1, Math.min(8, os.availableParallelism() - 1));
    const args = ['-m', c.model, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads)];
    if (exists(c.vad)) args.push('--vad', '-vm', c.vad);
    let log = '';
    let code = null;
    const proc = (s.proc = spawn(c.exe, args, { cwd: path.dirname(c.exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    // Below normal: a game or build alongside keeps the CPU (idle costs none). Without a pid setPriority would hit this process.
    if (proc.pid) try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    const keep = (b) => { log = (log + b).slice(-4000); };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    proc.on('error', (e) => { code = e.message; });
    proc.on('exit', (exit) => {
      code ??= exit;
      if (server === s) server = null; // a crash: the next request starts it again
    });
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitHealthy(url, () => code !== null);
    } catch (e) {
      const tail = log.trim().split('\n').slice(-3).join(' ');
      throw code !== null ? new Error(`whisper-server stopped (${code}). ${tail}`) : e;
    }
    return url;
  })();
  s.ready.catch(() => server === s && stopServer());
  return s;
}

/** Kills the local server; resolves once it has exited (at most 5 s), so its files can be deleted. */
function stopServer() {
  const proc = server?.proc;
  server = null;
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill();
  return Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}

/** The server's URL (settings.dictation.serverUrl, or the local one, started or restarted for a changed exe / model). */
async function serverUrl(c) {
  if (c.url) return c.url;
  const key = `${c.exe}|${c.model}|${exists(c.vad)}`;
  if (server?.key !== key) {
    stopServer();
    server = startServer(c, key);
  }
  return server.ready;
}

/** App start (main.js, once the window has shown): 2 s later, starts the local server in the background when it is installed,
 * so the first press transcribes at once. It then idles at about 0 CPU (RAM only: about 0.6 GB for Small). A failure is only
 * logged; the first warm / transcribe tries again. */
function warmAtStart() {
  setTimeout(async () => {
    try {
      const c = await config();
      if (!c.url && exists(c.exe) && exists(c.model)) await serverUrl(c);
    } catch (e) {
      console.warn('Dictation warm-up failed:', e.message);
    }
  }, 2000);
}

/** WAV bytes → the text (settings.dictation.language: a whisper code or 'auto'). */
async function transcribe(wav) {
  if (!ArrayBuffer.isView(wav)) throw new Error('transcribe takes the WAV file as bytes');
  const c = await config();
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  form.append('language', c.d.language || 'en');
  const res = await fetch(`${await serverUrl(c)}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `the whisper server answered HTTP ${res.status}`);
  return String(json.text ?? '');
}

// ---------------------------------------------------------------------------------------------
// Downloaded models

/** The downloaded speech models: [{id, label, file, bytes (on disk)}]. */
const listModels = () => MODELS.filter((m) => exists(modelFile(m.id)))
  .map((m) => ({ id: m.id, label: m.label, file: path.basename(modelFile(m.id)), bytes: fs.statSync(modelFile(m.id)).size }));

/** Deletes the downloaded model `id`, which must be one of MODELS (a path or any other name is refused). A server running
 * on it is stopped first and then started again on the settings' model (the renderer switches that before). */
async function deleteModel(id) {
  if (!MODELS.some((m) => m.id === id)) throw new Error(`${id} is not a dictation model.`);
  if (install) throw new Error('Dictation is being installed: try again when it has finished.');
  const file = modelFile(id);
  const stopped = !!server && server.model === file;
  if (stopped) await stopServer();
  await fsp.rm(file, { force: true });
  if (stopped) serverUrl(await config()).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------------------------

/** Registers the dictation.* channels through main.js's handle() and the main window's microphone permission. */
function register(handle, settings, win) {
  getSettings = settings;
  getWin = win;
  handle('dictation.status', status);
  handle('dictation.install', runInstall);
  handle('dictation.cancel', () => install?.abort());
  handle('dictation.warm', async () => serverUrl(await config()).then(() => true));
  handle('dictation.transcribe', transcribe);
  handle('dictation.listModels', listModels);
  handle('dictation.deleteModel', deleteModel);
  app.on('will-quit', stopServer);
  // Electron grants every permission by default: keep that, except that media is audio only and for the app's own page.
  app.whenReady().then(() => {
    const appPage = (wc) => !!wc && wc === getWin()?.webContents;
    session.defaultSession.setPermissionRequestHandler((wc, p, cb, details) => cb(p !== 'media'
      || (appPage(wc) && details.requestingUrl?.startsWith('file:') && (details.mediaTypes ?? []).every((t) => t === 'audio'))));
    session.defaultSession.setPermissionCheckHandler((_wc, p, origin, details) => p !== 'media'
      || (String(origin).startsWith('file:') && details.mediaType !== 'video'));
  });
}

module.exports = { register, warmAtStart };
