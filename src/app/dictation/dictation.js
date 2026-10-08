import { toast } from 'sonner';
import { saveSettings } from '../actions.js';
import { getState, setState, useStore } from '../store.js';
import { cleanText, commitPoint, DICTATION_DEFAULTS, encodeWav, hasSpeech, joinText, RATE } from './core.mjs';

// Push-to-talk dictation (SPEC §7h): microphone capture, the transcription loop and the transcript pane's state.
// `state.dictation` holds the pane in memory: it survives draft and thread switches and the workspaces, not a restart.
// `state.dictationInstall` is the open install dialog ({id, model, language, resolve}).

const api = window.api;
const IDLE = { shown: false, minimized: false, recording: false, closing: false, opening: false, committed: '', partial: '', error: '' };
const TICK_MS = 700; // re-transcribe the open tail this often while held
export const DISMISS_MS = 3000;
// The close sequence (Dictation.jsx plays it): the card narrows to the pod's width, its height falls (its bottom fixed, the pod
// coming down with its top), the pod narrows to a circle, then fades out while shrinking. Without text the card is hidden: the pod's two steps alone. Restoring a minimized
// pane plays it in reverse (`opening`).
export const CLOSE_STEPS = [220, 180, 180, 160];
export const CLOSE_MS = CLOSE_STEPS.reduce((a, b) => a + b);

const get = () => getState().dictation ?? IDLE;
const set = (patch) => setState({ dictation: { ...get(), ...patch } });
export const useDictation = () => useStore((s) => s.dictation ?? IDLE);
export const dictationSettings = () => ({ ...DICTATION_DEFAULTS, ...getState().settings?.dictation });
const message = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let seqTimer = 0; // the playing sequence's end (close or reverse open)
let closeEnd = null; // the playing close sequence's end
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const seqMs = (d) => (d.committed || d.partial || d.error ? CLOSE_MS : CLOSE_STEPS[2] + CLOSE_STEPS[3]);

/** Plays the close sequence (`closing`), then applies `end`; at once when reduced motion is preferred or the pane is
 * minimized (nothing shows). A new press meanwhile clears `closing`, and the end is skipped. A request while it plays keeps
 * its timing; a Dismiss's end wins over a Minimize's. It cuts a reverse open short (from the full pane). */
function close(end) {
  const d = get();
  if (d.closing) {
    if (end === IDLE) closeEnd = IDLE;
    return;
  }
  clearTimeout(seqTimer);
  if (d.minimized || reduced()) return set({ ...end, opening: false });
  closeEnd = end;
  set({ closing: true, opening: false });
  seqTimer = setTimeout(() => get().closing && set({ ...closeEnd, closing: false }), seqMs(d));
}

/** Restores a minimized pane: the close sequence in reverse (`opening`, same length); at once with reduced motion. A new
 * press, Minimize or Dismiss meanwhile clears `opening`. */
function open() {
  const d = get();
  if (!d.minimized) return;
  clearTimeout(seqTimer);
  if (reduced()) return set({ minimized: false });
  set({ minimized: false, opening: true });
  seqTimer = setTimeout(() => get().opening && set({ opening: false }), seqMs(d));
}

const hasText = (d) => !!(d.committed || d.partial || d.error);
/** Minimize with nothing to show (no transcript, not recording) closes the pane instead: no restore button that opens to
 * an empty pane. */
export const minimize = (minimized) => (!minimized ? open() : hasText(get()) || get().recording ? close({ minimized }) : close(IDLE));

export function dismiss() {
  const r = rec;
  rec = null; // a session still running stops writing
  if (r) finish(r);
  close(IDLE);
}

// ---------------------------------------------------------------------------------------------
// Capture: the mic at 16 kHz into a growing buffer, and an analyser for the pod's waveform

let meter = null;
const meterData = new Float32Array(512);

/** The microphone's current RMS level (0 when not recording). */
export function level() {
  if (!meter) return 0;
  meter.getFloatTimeDomainData(meterData);
  return Math.sqrt(meterData.reduce((sum, v) => sum + v * v, 0) / meterData.length);
}

function push(rec, chunk) {
  if (rec.len + chunk.length > rec.buf.length) {
    const grown = new Float32Array(rec.buf.length * 2);
    grown.set(rec.buf.subarray(0, rec.len));
    rec.buf = grown;
  }
  rec.buf.set(chunk, rec.len);
  rec.len += chunk.length;
}

async function capture(rec, micId) {
  const open = (id) => navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
  let stream;
  try {
    stream = await open(micId);
  } catch (e) {
    if (!micId) throw e;
    stream = await open(''); // the chosen microphone is gone: the system default
  }
  const ctx = new AudioContext({ sampleRate: RATE });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = meterData.length;
  // ponytail: ScriptProcessorNode is deprecated and runs on the main thread; move to an AudioWorklet if capture stutters.
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  proc.onaudioprocess = (e) => push(rec, e.inputBuffer.getChannelData(0));
  source.connect(analyser);
  source.connect(proc);
  proc.connect(ctx.destination);
  meter = analyser;
  rec.release = () => {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    if (meter === analyser) meter = null;
  };
}

// ---------------------------------------------------------------------------------------------
// Transcription loop. While held, the open tail (audio after the last commit) is re-transcribed about every 700 ms and
// its text replaces the partial text (the model's live edits); a pause or 20 s commits the audio before it. One request
// at a time. Release: the mic stops and a final pass commits the rest.

let rec = null; // the current session
let pressed = false;

// A session's transcript ({recording, committed, partial, error}): the pane's state, or with a sink (the chat panel's mic, SPEC
// §7i) its own copy, handed to the sink on every change while the pane stays as it is.
const sofar = (r) => (r.sink ? r.out : get());
const show = (r, patch) => (r.sink ? r.sink((r.out = { ...r.out, ...patch })) : set(patch));
// A sink session's end, once, whatever ended it (the final text, an error, a newer session): the sink gets `done: true`.
function end(r) {
  if (!r.sink || r.ended) return;
  r.ended = true;
  r.sink({ ...r.out, recording: false, done: true });
}

async function request(r, pcm, commit) {
  r.sent = r.len;
  const wav = encodeWav(pcm); // copies the samples before anything else can run
  let text;
  try {
    text = cleanText(await api.dictation.transcribe(wav));
  } catch (e) {
    if (rec === r) show(r, { error: `Transcription failed: ${message(e)}` });
    return false;
  }
  if (rec !== r) return false; // a newer session overwrote this one
  show(r, commit ? { committed: joinText(sofar(r).committed, text), partial: '', error: '' } : { partial: text, error: '' });
  return true;
}

function tick(r) {
  if (r.busy || r.len - r.sent < RATE / 4) return;
  const tail = r.buf.subarray(r.start, r.len);
  const cut = commitPoint(tail);
  if (cut > 0 && !hasSpeech(tail.subarray(0, cut))) r.start += cut; // silence or a click: the model would make up words
  else if (cut > 0) r.busy = request(r, tail.subarray(0, cut), true).then((ok) => { if (ok) r.start += cut; });
  else if (hasSpeech(tail)) r.busy = request(r, tail, false);
  r.busy?.finally(() => { r.busy = null; });
}

async function finish(r) {
  if (r.done || !r.release) return; // finish runs once, after the mic opened
  r.done = true;
  clearInterval(r.timer);
  r.release();
  if (rec !== r) return end(r);
  show(r, { recording: false });
  await r.busy;
  const tail = r.buf.subarray(r.start, r.len);
  if (rec === r && hasSpeech(tail) && !(await request(r, tail, true)) && rec === r) {
    show(r, { committed: joinText(sofar(r).committed, sofar(r).partial) }); // the final pass failed: keep the last partial text
  }
  if (rec === r && sofar(r).partial) show(r, { partial: '' });
  end(r);
}

/** PTT pressed: a new session overwrites the transcript (and restores a minimized pane); not installed: the install dialog.
 * With `sink` (the chat panel's mic) the session's transcript goes to `sink({recording, committed, partial, error, done})` on
 * every change instead, and the pane is left as it is; `done: true` comes once, last. */
export async function pttDown(sink = null) {
  pressed = true;
  const ready = await api.dictation.status().then((s) => s.ready, () => false);
  if (!ready) {
    pressed = false;
    openInstall();
    return void sink?.({ ...IDLE, done: true });
  }
  if (!pressed) return void sink?.({ ...IDLE, done: true }); // released before it could start
  api.dictation.warm().catch(() => {}); // the server loads the model while the user speaks; errors show on the first request
  const r = (rec = { buf: new Float32Array(RATE * 30), len: 0, start: 0, sent: 0, busy: null, release: null, done: false, sink });
  if (sink) show(r, { ...IDLE, recording: true });
  else setState({ dictation: { ...IDLE, shown: true, recording: true } });
  try {
    await capture(r, dictationSettings().micId);
  } catch (e) {
    if (rec === r) show(r, { recording: false, error: `Microphone unavailable: ${message(e)}` });
    return void end(r);
  }
  r.timer = setInterval(() => tick(r), TICK_MS);
  if (!pressed || rec !== r) finish(r);
}

/** PTT released (anywhere: the button holds the pointer capture). */
export function pttUp() {
  pressed = false;
  if (rec) finish(rec);
}

/** Starts the local server ahead of the first press (on hover); quiet when dictation is not installed. */
export function warm() {
  api.dictation.status().then((s) => s.ready && api.dictation.warm()).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Install dialog

/** Opens the install dialog (model and language preselected from `preset` or the settings). Resolves with
 * {installed: true, model, language} once installed, or null. */
export function openInstall(preset = {}) {
  const d = { ...dictationSettings(), ...preset };
  getState().dictationInstall?.resolve(null);
  return new Promise((resolve) => setState({ dictationInstall: { id: Date.now(), model: d.model, language: d.language, resolve } }));
}

export function closeInstall(result) {
  const open = getState().dictationInstall;
  setState({ dictationInstall: null });
  open?.resolve(result);
}

/** Downloads what `model` needs; on success saves settings.dictation and resolves the dialog. Throws the error message. */
export async function install(model, language) {
  try {
    await api.dictation.install(model);
  } catch (e) {
    throw new Error(message(e));
  }
  const result = { installed: true, model, language };
  await saveSettings({ dictation: { ...dictationSettings(), ...result } });
  closeInstall(result);
  toast('Dictation is ready: hold the mic button and speak.');
}

export const cancelInstall = () => api.dictation.cancel();

// ---------------------------------------------------------------------------------------------
// Downloaded models (Settings > Dictation)

/** Whether dictation runs on the downloaded model `id` (the saved model, unless a model file or server URL replaces it). */
export function modelInUse(id) {
  const d = dictationSettings();
  return !d.modelPath && !d.serverUrl && d.model === id;
}

/** Deletes the downloaded model `id`. The model in use is first switched in settings.dictation to the downloaded model `to`
 * (none: dictation is off until installed again). Resolves with that settings patch, or null. Throws the error message. */
export async function deleteModel(id, to) {
  const patch = modelInUse(id) ? (to ? { model: to } : { installed: false }) : null;
  try {
    if (patch) await saveSettings({ dictation: { ...dictationSettings(), ...patch } });
    await api.dictation.deleteModel(id);
  } catch (e) {
    throw new Error(message(e));
  }
  return patch;
}
