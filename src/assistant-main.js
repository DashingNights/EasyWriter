'use strict';
// The assistant, main-process side (SPEC §7i). Google AI only since 2026-10-07 (the user: "i plan to abandon local llm usage, just
// stick to google api now. comment out all the code for local llm stuff"): chat completions stream from Google AI's
// OpenAI-compatible endpoint to the renderer as `assistant.event`. An OpenAI-compatible server in settings.assistant.serverUrl
// (+ apiKey) takes its place only while settings.assistant.provider is not 'google' (the eval's stub server). The local llama.cpp
// runtime (downloads, llama-server, MTP, degrade steps, sleep, idle unload, power events) is commented out at the end of this
// file, the module as it was, so uncommenting that part (and dropping this one) brings it back.
const path = require('path');
const { props, streamChat } = require('./assistant/runtime.js');
const QWEN_MODELS = require('./assistant/qwen-models.json'); // [{id, label, ctx}], also the Settings checklist

// Google AI's OpenAI-compatible base (ai.google.dev/gemini-api/docs/openai, read 2026-10-07): Bearer API key, model in the body.
const GOOGLE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GOOGLE_CTX = 1048576; // a Google model's context window when its model page does not answer (Gemini 3.8 Flash's input limit)
const googleWindows = new Map(); // `${model}|${key}` → its inputTokenLimit (or GOOGLE_CTX), asked once per model and key
const OFF = 'Local models are turned off. The assistant uses a cloud provider.';
// The cloud providers (settings.assistant.provider), OpenAI-compatible: base URL, default model, the settings fields of the key and
// the model, a label. DeepSeek (api-docs.deepseek.com, read 2026-10-08): https://api.deepseek.com (the /v1 base is the same API),
// model deepseek-flash (V4.1 Flash: images in user messages, 1M context), thinking as {thinking: {type}} and reasoning_effort.
// Qwen Cloud (docs.qwencloud.com, read 2026-10-08): the model the chat panel picks from settings.assistant.qwenModels,
// enable_thinking and thinking_budget, one tool call per reply unless parallel_tool_calls.
const CLOUD = {
  qwen: { url: 'https://maas.qwencloudapi.com/compatible-mode/v1', model: 'qwen3.7-plus', key: 'qwenKey', modelField: 'qwenModel', label: 'Qwen Cloud', ctx: 1000000 },
  google: { url: GOOGLE_URL, model: 'gemini-3.8-flash', key: 'googleKey', modelField: 'googleModel', label: 'Google AI', ctx: GOOGLE_CTX },
  deepseek: { url: 'https://api.deepseek.com/v1', model: 'deepseek-flash', key: 'deepseekKey', modelField: 'deepseekModel', label: 'DeepSeek', ctx: 1000000 },
};

let getSettings = null;
let getWin = null;
const chats = new Map(); // rid → AbortController

/** The context window of `c.googleModel`: its inputTokenLimit from Google AI's model page (GET v1beta/models/<model>). */
async function googleWindow(c) {
  const k = `${c.googleModel}|${c.key}`;
  if (!googleWindows.has(k)) {
    googleWindows.set(k, (async () => {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.googleModel)}`,
          { headers: { 'x-goog-api-key': c.key }, signal: AbortSignal.timeout(4000) });
        const n = res.ok ? Number((await res.json()).inputTokenLimit) : 0;
        return n > 0 ? n : GOOGLE_CTX;
      } catch {
        return GOOGLE_CTX;
      }
    })());
  }
  return googleWindows.get(k);
}

/** Everything the renderer hears goes out on `assistant.event`: chat streams. */
function send(payload) {
  const wc = getWin()?.webContents;
  if (wc && !wc.isDestroyed()) wc.send('assistant.event', payload);
}

/** settings.assistant (with `over` laid on it, e.g. the Settings dialog's unsaved fields) → {a, provider, cloud, google, model,
 * googleModel, key, url}: a cloud provider (CLOUD; Google AI unless it says DeepSeek), or the OpenAI-compatible server in serverUrl
 * when the provider names none (the eval's stub). */
async function config(over = {}) {
  const a = { ...(await getSettings()).assistant, ...over };
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const server = /^https?:\/\/\S+$/.test(str(a.serverUrl)) ? str(a.serverUrl).replace(/\/+$/, '') : '';
  const provider = Object.hasOwn(CLOUD, a.provider) ? a.provider : server ? null : 'qwen';
  const cloud = provider ? CLOUD[provider] : null;
  const model = cloud ? str(a[cloud.modelField]) || cloud.model : '';
  const ctx = provider === 'qwen' ? QWEN_MODELS.find((m) => m.id === model)?.ctx ?? cloud.ctx : cloud?.ctx; // a model added by id: 1M
  return { a, provider, cloud, google: provider === 'google', model, googleModel: model, ctx, key: cloud ? str(a[cloud.key]) : str(a.apiKey), url: cloud ? cloud.url : server };
}

/** {ready (a cloud provider: its key), provider ('qwen' | 'google' | 'deepseek' | 'server'), providerLabel, ctx (the context window), url,
 * missing: [], server: {state: 'ready'}, model: {label, file, bytes}} for settings.assistant + `over`. */
async function status(over) {
  const c = await config(over);
  const ext = c.cloud ? null : await props(fetch, c.url, c.key); // a server names its model and context through /props (llama-server)
  return {
    ready: c.cloud ? !!c.key : true,
    provider: c.provider ?? 'server',
    providerLabel: c.cloud?.label ?? 'the server',
    ctx: c.google ? (c.key ? await googleWindow(c) : GOOGLE_CTX) : c.cloud ? c.ctx : ext?.default_generation_settings?.n_ctx || null,
    url: c.url,
    missing: [],
    server: { state: 'ready', sleeping: false },
    model: c.cloud ? { label: c.model, file: c.model, bytes: 0 }
      : ext?.model_path ? { label: path.basename(String(ext.model_path)).replace(/\.gguf$/i, ''), file: path.basename(String(ext.model_path)), bytes: 0 } : null,
  };
}

// The caption that ends the text part before an attachment's picture (assistant.js pictures; its size line since wave 2b).
const CAPTION = /\s*The next picture shows \[[^\]]*\](?:, [^.\n]*)?\.(?: The numbers on it are the legend's\.)?$/;

/** Message `m` for a server without an image projector: no image parts, and each caption that ended the text part before one cut
 * (the situation note and the attachments before it stay); a picture message of the tool loop ([its line, the picture], loop.js:
 * view_render's, whose legend is in the tool message before it, and the board after a change) → null, left out. */
function withoutPictures(m) {
  if (!Array.isArray(m?.content) || !m.content.some((p) => p?.type === 'image_url')) return m;
  if (m.content.length === 2 && m.content[0]?.type === 'text') return null;
  const content = m.content.flatMap((p, i, all) => {
    if (p?.type === 'image_url') return [];
    if (p?.type !== 'text' || all[i + 1]?.type !== 'image_url') return [p];
    const text = p.text.replace(CAPTION, '');
    return text ? [{ ...p, text }] : [];
  });
  return { ...m, content };
}

const EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }; // Gemini's and DeepSeek's reasoning_effort
const BUDGET = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 }; // Qwen Cloud's thinking_budget (tokens)
/** The thinking fields of a DeepSeek or Qwen Cloud request at the Thinking menu's `level`, thinking only when `think`. */
const thinkingFields = (provider, think, level) => (provider === 'deepseek'
  ? { thinking: { type: think ? 'enabled' : 'disabled' }, ...(think && { reasoning_effort: EFFORT[level] ?? 'medium' }) }
  : { enable_thinking: !!think, ...(think && { thinking_budget: BUDGET[level] ?? 4096 }) });

/** Streams one completion as `assistant.event {rid, type: delta | reasoning | tool_call | done | error | novision}`; resolves at
 * once. Google AI: the model by name and `reasoning_effort` (Gemini 3.8 Flash cannot turn thinking off: low without Think, with it
 * the Thinking menu's level, Xhigh and Max as high, Auto's thinking turns medium). DeepSeek and Qwen Cloud: thinkingFields. A server: the OpenAI fields, pictures dropped
 * when its /props reports no vision (novision). `done` carries `usage` and `n_ctx` (the context window). */
function chat({ rid, messages, tools, think, response_format } = {}) {
  if (typeof rid !== 'string' || !rid || !Array.isArray(messages)) throw new Error('chat takes {rid, messages}');
  chats.get(rid)?.abort();
  const ac = new AbortController();
  chats.set(rid, ac);
  const emit = (e) => { if (!ac.signal.aborted) send({ rid, ...e }); };
  (async () => {
    try {
      const c = await config();
      const withTools = Array.isArray(tools) && tools.length > 0;
      if (c.google) {
        const effort = EFFORT[c.a.thinking] ?? 'medium';
        const body = {
          model: c.googleModel,
          messages,
          ...(withTools && { tools, tool_choice: 'auto' }),
          ...(response_format && { response_format }),
          stream: true,
          stream_options: { include_usage: true },
          reasoning_effort: think ? effort : 'low', // Auto: low, the fastest Gemini 3.8 Flash allows (a simple command is 2 round trips)
          max_tokens: 8192,
        };
        const n = googleWindow(c);
        await streamChat(fetch, c.url, c.key, body, (e) => (e.type === 'done' ? n.then((ctx) => emit({ ...e, n_ctx: ctx })) : emit(e)), ac.signal);
        return;
      }
      if (c.cloud) {
        // DeepSeek and Qwen Cloud: thinking on only when the turn thinks (the Thinking menu; Auto for solve, derive or prove).
        const body = {
          model: c.model,
          messages,
          ...(withTools && { tools, tool_choice: 'auto' }),
          ...(withTools && c.provider === 'qwen' && { parallel_tool_calls: true }), // Qwen's default is one call; loop.js runs them all
          ...(response_format && { response_format }),
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 8192,
          ...thinkingFields(c.provider, think, c.a.thinking),
        };
        await streamChat(fetch, c.url, c.key, body, (e) => emit(e.type === 'done' ? { ...e, n_ctx: c.ctx } : e), ac.signal);
        return;
      }
      const body = {
        messages,
        ...(withTools && { tools, tool_choice: 'auto', parallel_tool_calls: false }),
        ...(response_format && { response_format }),
        stream: true,
        stream_options: { include_usage: true },
      };
      const info = props(fetch, c.url, c.key, 2000);
      const pictures = messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url'));
      if (pictures && (await info)?.modalities?.vision === false) {
        body.messages = messages.map(withoutPictures).filter(Boolean);
        emit({ type: 'novision' });
      }
      const ctx = info.then((p) => p?.default_generation_settings?.n_ctx || null);
      await streamChat(fetch, c.url, c.key, body, (e) => (e.type === 'done' ? ctx.then((n) => emit({ ...e, n_ctx: n })) : emit(e)), ac.signal);
    } catch (e) {
      emit({ type: 'error', message: e.message });
    } finally {
      if (chats.get(rid) === ac) chats.delete(rid);
    }
  })();
  return true;
}

/** Aborts chat `rid`: the socket closes, no more events for it. */
function cancelChat(rid) {
  chats.get(rid)?.abort();
  chats.delete(rid);
}

/** Registers the assistant.* channels through main.js's handle(). The local runtime's channels answer that it is off (install,
 * delete) or do nothing (warm, stop), so an older caller never hangs. */
function register(handle, settings, win) {
  getSettings = settings;
  getWin = win;
  handle('assistant.status', status);
  handle('assistant.chat', chat);
  handle('assistant.cancelChat', cancelChat);
  for (const ch of ['assistant.install', 'assistant.delete', 'assistant.deleteLeftover']) handle(ch, async () => { throw new Error(OFF); });
  for (const ch of ['assistant.cancel', 'assistant.warm', 'assistant.stop']) handle(ch, async () => true);
}

/** App start (main.js): nothing to warm with Google AI. */
const autoWarm = async () => {};

module.exports = { register, autoWarm };


// -----------------------------------------------------------------------------------------------------------------------------
// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all
// the code for local llm stuff"). The module as it was before that day's change, Google AI parts included: uncomment it and drop the
// live part above to bring back the local llama.cpp runtime (src/assistant/runtime.js and test/assistant-runtime.test.mjs have
// their local parts commented out the same way).
// -----------------------------------------------------------------------------------------------------------------------------
// 'use strict';
// // Local assistant (automation plan §13.2, §13.5, §13.6), main-process side: installs the pinned llama.cpp build and the chosen
// // model (Qwen3.5-9B by default) into userData/assistant/ when the user asks, runs llama-server on 127.0.0.1 and streams chat
// // completions to the renderer as `assistant.event`. Warm-up and idle follow §13.2: warmed 10 s after the window shows when
// // installed, asleep after `sleepMinutes` (llama-server's own sleep), killed after `idleUnloadMinutes`, on battery, suspend, 5 min
// // locked and on quit.
// // Modelled on src/dictation-main.js.
// const { app, powerMonitor } = require('electron');
// const { execFile, spawn } = require('child_process');
// const crypto = require('crypto');
// const fs = require('fs');
// const fsp = require('fs/promises');
// const net = require('net');
// const os = require('os');
// const path = require('path');
// const { Readable, Transform } = require('stream');
// const { pipeline } = require('stream/promises');
// const { readJson } = require('./file-family.js');
// const { MAX_STEP, contextFor, sampling, thinkingLimits, isSleeping, launchArgs, pickBackend, props, streamChat, waitHealthy, wake } = require('./assistant/runtime.js');
//
// // Pins, read from the GitHub and Hugging Face APIs on 2026-10-06. b11433 (2026-10-05) contains PR #29773 (image-token cap,
// // merged 2026-10-01). Model: Qwen3.5-9B Q4_K_M at -c 16384 (user decision 2026-10-06, replacing the 4B Q6_K), pinned at the
// // GGUF repo's head commit (2026-03-02, its last upload: Unsloth's 2026-03-05 re-upload with the tool-calling template fix
// // covered the 27B and larger models). Sizes from the same APIs. The sha256 of every download is read at install time (GitHub
// // asset `digest`, Hugging Face tree at the pinned commit) and required.
// const QWEN = { repo: 'unsloth/Qwen3.5-9B-GGUF', commit: '3885219b6810b007914f3a7950a8d1b469d598a5' };
// // Qwen3.5-9B with its MTP head (user request 2026-10-07, opt-in through "Faster replies (MTP)"): Unsloth's MTP repo at its head
// // commit (2026-05-16), sha256 e8dd9481… read from its tree API on 2026-10-07. The head is inside the file; the projector is the
// // regular repo's (its own mmproj-BF16.gguf differs by 96 bytes). Its file has the regular file's name, so it is saved as
// // Qwen3.5-9B-MTP-Q4_K_M.gguf (`as`, the name of the user's own download).
// const QWEN_MTP = { repo: 'unsloth/Qwen3.5-9B-MTP-GGUF', commit: '9716a636ee4bddc3fed678220b7a33dd2a4160ae' };
// // Defiant Fable (user decision 2026-10-06, opt-in): DavidAU's Qwen3.5-9B fine-tune at its head commit (2026-10-02). Its chat
// // template is byte-identical to Qwen3.5-9B's and its mmproj-BF16.gguf is Unsloth's file (same sha256), so the projector is shared.
// const FABLE = { repo: 'DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF', commit: '8b192a8e203440d6492a133f6cdfa4bf7bffac98' };
// // Gemma 4 12B (opt-in; user decision 2026-10-07, the stock model): Unsloth's
// // GGUF of google/gemma-4-12B-it at its head commit, read from its tree API on 2026-10-07. The GGUF carries the current Gemma 4 chat
// // template, so none is passed. The projector and the MTP head (a separate draft file) come from the same repo; the projector and
// // the draft are saved under `as`, the names of the user's own earlier downloads.
// const GEMMA = { repo: 'unsloth/gemma-4-12b-it-GGUF', commit: 'fc034cfff751157913579611efad8462ac1be606' };
// // Google AI's OpenAI-compatible base (ai.google.dev/gemini-api/docs/openai, read 2026-10-07): Bearer API key, model in the body.
// const GOOGLE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
// const GOOGLE_CTX = 1048576; // a Google model's context window when its model page does not answer (Gemini 3.8 Flash's input limit)
// const googleWindows = new Map(); // `${model}|${key}` → its inputTokenLimit (or GOOGLE_CTX), asked once per model and key
//
// /** The context window of `c.googleModel`: its inputTokenLimit from Google AI's model page (GET v1beta/models/<model>). */
// async function googleWindow(c) {
//   const k = `${c.googleModel}|${c.key}`;
//   if (!googleWindows.has(k)) {
//     googleWindows.set(k, (async () => {
//       try {
//         const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.googleModel)}`,
//           { headers: { 'x-goog-api-key': c.key }, signal: AbortSignal.timeout(4000) });
//         const n = res.ok ? Number((await res.json()).inputTokenLimit) : 0;
//         return n > 0 ? n : GOOGLE_CTX;
//       } catch {
//         return GOOGLE_CTX;
//       }
//     })());
//   }
//   return googleWindows.get(k);
// }
// // Saved under the model's name (`as`): the 4B's projector, still on disk after the switch, has the same file name.
// const MMPROJ = {
//   qwen: { ...QWEN, file: 'mmproj-BF16.gguf', bytes: 921705024, as: 'Qwen3.5-9B-mmproj-BF16.gguf' },
//   gemma: { ...GEMMA, file: 'mmproj-BF16.gguf', bytes: 175115840, as: 'gemma-4-12B-mmproj-BF16.gguf' },
// };
// // The GGUF repos have no licence file: the base model's, at its pinned commit (Qwen's: the same text as the 4B's, git blob f938136).
// // No Gemma 4 repo has one either, so Gemma's is the base model card, which states Apache 2.0 and links the text (git blob 99f6f1c).
// const LICENCE = {
//   qwen: { repo: 'Qwen/Qwen3.5-9B', commit: 'c202236235762e1c871ad0ccb60c8ee5ba337b9a', file: 'LICENSE', as: 'LICENSE', name: 'Apache-2.0', model: 'Qwen3.5', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
//   gemma: { repo: 'google/gemma-4-12B-it', commit: '707f0a3b8a3c7ad586ed01e27eafbad8a27dd0f7', file: 'README.md', as: 'gemma-4-12B-it-README.md', name: 'Apache-2.0', model: 'Gemma 4', url: 'https://ai.google.dev/gemma/docs/gemma_4_license' },
// };
// const PINS = {
//   build: 'b11433',
//   assets: {
//     cuda: [{ name: 'llama-b11433-bin-win-cuda-12.4-x64.zip', bytes: 264475988, label: 'llama.cpp server (CUDA 12.4)' },
//       { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', bytes: 391443627, label: 'CUDA 12.4 runtime' }],
//     vulkan: [{ name: 'llama-b11433-bin-win-vulkan-x64.zip', bytes: 33337778, label: 'llama.cpp server (Vulkan)' }],
//     cpu: [{ name: 'llama-b11433-bin-win-cpu-x64.zip', bytes: 19399521, label: 'llama.cpp server (CPU)' }],
//   },
//   // settings.assistant.model (+ mtp: Qwen's and Fable's MTP files, Gemma's draft file) → its file (saved as `as` ?? `file`),
//   // projector, licence.
//   models: {
//     qwen9b: { ...QWEN, file: 'Qwen3.5-9B-Q4_K_M.gguf', bytes: 5680522464, label: 'Qwen3.5-9B Q4_K_M', mmproj: MMPROJ.qwen, licence: LICENCE.qwen },
//     qwen9bMtp: { ...QWEN_MTP, file: 'Qwen3.5-9B-Q4_K_M.gguf', as: 'Qwen3.5-9B-MTP-Q4_K_M.gguf', bytes: 5868826976, label: 'Qwen3.5-9B Q4_K_M MTP', mmproj: MMPROJ.qwen, licence: LICENCE.qwen },
//     fable9b: { ...FABLE, file: 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q4_K_M.gguf', bytes: 6828993824, label: 'Defiant Fable 9B Q4_K_M', mmproj: MMPROJ.qwen, licence: LICENCE.qwen },
//     fable9bMtp: { ...FABLE, file: 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-MTP-Q4_K_M.gguf', bytes: 6979975392, label: 'Defiant Fable 9B Q4_K_M MTP', mmproj: MMPROJ.qwen, licence: LICENCE.qwen },
//     gemma12b: {
//       ...GEMMA, file: 'gemma-4-12b-it-Q4_K_M.gguf', bytes: 7121861440, label: 'Gemma 4 12B Q4_K_M', mmproj: MMPROJ.gemma, licence: LICENCE.gemma,
//       draft: { ...GEMMA, file: 'mtp-gemma-4-12b-it.gguf', as: 'gemma-4-12B-it-MTP-Q8_0.gguf', bytes: 465109248 },
//     },
//   },
// };
// const RELEASE = `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${PINS.build}`;
// const EXE = 'llama-server.exe';
// const UA = { 'User-Agent': 'daf-writer' };
// // ponytail: log-text match for llama.cpp's allocation failures (CUDA, Vulkan, CPU) while loading; a later out-of-memory exit
// // (e.g. on a first picture) just stops the server.
// const OOM = /out of memory|OutOfDeviceMemory|failed to allocate|unable to allocate/i;
//
// let getSettings = null;
// let setSettings = null;
// let getWin = null;
// let server = null; // {sig, key, url, proc, up, ready: Promise<{url, key}>}
// let state = { state: 'stopped' }; // the local server's, as status() and the `status` event report it
// let install = null; // AbortController of the running install
// let gpus = null; // Promise of app.getGPUInfo('basic').gpuDevice
// let vram = null; // Promise of gpuMemory()
// let budgetLogged = false;
// let idleTimer = null; // Tier 2: kills the local server idleUnloadMinutes after the last request
// let lockTimer = null;
// const chats = new Map(); // rid → AbortController
//
// const dir = () => path.join(app.getPath('userData'), 'assistant');
// const exists = (file) => !!file && fs.existsSync(file);
// const onDisk = (c) => [c.exe, c.model, c.mmproj].every(exists) && (!c.draft || exists(c.draft)); // config(c)'s files to start the server
//
// const binDir = (backend) => path.join(dir(), `llama-${PINS.build}-${backend}`);
// const serverFile = () => path.join(dir(), 'server.json');
//
// function findExe(folder) {
//   const hit = exists(folder) && fs.readdirSync(folder, { recursive: true }).find((f) => path.basename(f) === EXE);
//   return hit ? path.join(folder, hit) : null;
// }
//
// /** Everything the renderer hears goes out on `assistant.event`: install progress, server status, chat streams. */
// function send(payload) {
//   const wc = getWin()?.webContents;
//   if (wc && !wc.isDestroyed()) wc.send('assistant.event', payload);
// }
//
// const setState = (next) => {
//   state = next;
//   send({ type: 'status', server: next });
// };
//
// /** {total, free} MiB of the first NVIDIA GPU from nvidia-smi (the driver puts it in System32), read once per start; null elsewhere.
//  * Full path as for tar and tasklist: a bare name is looked up in the working directory first. */
// const gpuMemory = () => (vram ??= new Promise((resolve) => {
//   execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'), ['--query-gpu=memory.total,memory.free', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 3000 }, (e, out) => {
//     const [total, free] = e ? [] : String(out).split('\n')[0].split(',').map(Number);
//     resolve(total > 0 ? { total, free } : null);
//   });
// }));
//
// /** settings.assistant (with `over` laid on it, e.g. the Settings dialog's unsaved fields) → what runs. */
// async function config(over = {}) {
//   const a = { ...(await getSettings()).assistant, ...over };
//   gpus ??= app.getGPUInfo('basic').then((info) => info.gpuDevice || [], () => []);
//   const backend = pickBackend(await gpus, a.backend || 'auto');
//   const fable = a.model === 'fable9b';
//   const gemma = a.model === 'gemma12b';
//   const pin = PINS.models[gemma ? 'gemma12b' : fable ? (a.mtp ? 'fable9bMtp' : 'fable9b') : a.mtp ? 'qwen9bMtp' : 'qwen9b'];
//   const mtp = !!a.mtp; // every model has an MTP choice since wave 2b (Qwen's file, as Fable's, holds its head)
//   const models = path.join(dir(), 'models');
//   // provider 'google' (2026-10-07): Gemini through Google AI's OpenAI-compatible endpoint, used like an external server.
//   const google = a.provider === 'google';
//   const str = (v) => (typeof v === 'string' ? v.trim() : '');
//   return {
//     a,
//     backend,
//     google,
//     googleModel: str(a.googleModel) || 'gemini-3.8-flash',
//     key: google ? str(a.googleKey) : str(a.apiKey), // the Bearer key of the server at `url`
//     url: google ? GOOGLE_URL : typeof a.serverUrl === 'string' && /^https?:\/\/\S+$/.test(a.serverUrl) ? a.serverUrl.replace(/\/+$/, '') : '',
//     exe: a.serverPath || findExe(binDir(backend)),
//     pin,
//     model: a.modelPath || path.join(models, pin.as ?? pin.file),
//     mmproj: a.mmprojPath || path.join(models, pin.mmproj.as),
//     draft: mtp && pin.draft ? path.join(models, pin.draft.as) : '', // Gemma's MTP head (Qwen's and Fable's are inside their MTP files)
//     fable,
//     family: gemma ? 'gemma' : 'qwen', // runtime.js SAMPLING
//     mtp,
//     gpu: await gpuMemory(),
//     step: Math.min(MAX_STEP, Math.max(0, Math.trunc(Number(a.step)) || 0)),
//     sleepSeconds: Math.max(0, Number(a.sleepMinutes ?? 10) || 0) * 60,
//     idleMinutes: Math.max(0, Number(a.idleUnloadMinutes ?? 30) || 0),
//   };
// }
//
// /** The .gguf files in userData/assistant/models/ that the chosen model does not use (an earlier pin's, e.g. the 4B's, or the
//  * other model choice's, kept so switching back needs no download): [{file, bytes}]. A custom model path never lists the chosen
//  * model's download as unused. */
// function leftovers(c) {
//   const folder = path.join(dir(), 'models');
//   const used = new Set([c.model, c.mmproj, c.draft, path.join(folder, c.pin.as ?? c.pin.file), path.join(folder, c.pin.mmproj.as)].filter(Boolean)
//     .map((p) => path.resolve(p).toLowerCase()));
//   return !exists(folder) ? [] : fs.readdirSync(folder, { withFileTypes: true })
//     .filter((f) => f.isFile() && /\.gguf$/i.test(f.name) && !used.has(path.join(folder, f.name).toLowerCase()))
//     .map((f) => ({ file: f.name, bytes: fs.statSync(path.join(folder, f.name)).size }));
// }
//
// /** Deletes one of leftovers() by its name (anything else is refused), after stopping a server still running on it. */
// async function deleteLeftover(file) {
//   if (!leftovers(await config()).some((f) => f.file === file)) throw new Error(`${file} is not an unused model file.`);
//   const full = path.join(dir(), 'models', file);
//   if (server?.sig.split('|').includes(full)) await stopServer();
//   await fsp.rm(full, { force: true });
//   return true;
// }
//
// /** {ready, url, missing: [{label, bytes}], backend, server: {state: stopped | starting | ready | error, error?, sleeping?},
//  * model: {label, file, bytes, repo?, mmprojRepo?}, licence: {name, model, url} (the chosen model's), leftovers: [{file, bytes}],
//  * gpuMemory: {total, free} MiB | null} for settings.assistant + `over`. */
// async function status(over) {
//   const c = await config(over);
//   const lost = (p) => ({ label: `${p} (not found)`, bytes: 0 }); // a path of the user's that is gone (the install refuses it)
//   const assets = PINS.assets[c.backend];
//   const missing = [];
//   if (!exists(c.exe)) {
//     missing.push(c.a.serverPath ? lost(c.a.serverPath) : { label: assets.map((a) => a.label).join(' + '), bytes: assets.reduce((n, a) => n + a.bytes, 0) });
//   }
//   if (!exists(c.model)) missing.push(c.a.modelPath ? lost(c.a.modelPath) : { label: `Model ${path.basename(c.model)}`, bytes: c.pin.bytes });
//   if (!exists(c.mmproj)) missing.push(c.a.mmprojPath ? lost(c.a.mmprojPath) : { label: `Image projector ${c.pin.mmproj.as}`, bytes: c.pin.mmproj.bytes });
//   if (c.draft && !exists(c.draft)) missing.push({ label: `MTP draft ${c.pin.draft.as}`, bytes: c.pin.draft.bytes });
//   // Asleep or not from /props, which neither wakes the server nor resets its timer (the chat panel polls status while open).
//   const s = server;
//   const ext = c.url && !c.google ? await props(fetch, c.url, c.key) : null; // an external server: asleep or not, and the model file it runs
//   const srv = c.url ? { state: 'ready', sleeping: !!ext?.is_sleeping } : s?.up && state.state === 'ready' ? { ...state, sleeping: (await isSleeping(fetch, s.url, s.key)) === true } : state;
//   // An external server names its model through /props model_path (llama-server); the label is the file name without .gguf.
//   // Google AI's is the model name in the settings.
//   const extModel = c.google ? { label: c.googleModel, file: c.googleModel, bytes: 0 }
//     : ext?.model_path ? { label: path.basename(String(ext.model_path)).replace(/\.gguf$/i, ''), file: path.basename(String(ext.model_path)), bytes: 0 } : null;
//   return {
//     ready: c.google ? !!c.key : !!c.url || !missing.length, // Google AI needs its API key
//     // The model's context window, for the chat's ring: a Google model's input limit, an external server's n_ctx, the local -c.
//     ctx: c.google ? (c.key ? await googleWindow(c) : GOOGLE_CTX) : c.url ? ext?.default_generation_settings?.n_ctx || null : contextFor(c.gpu?.total),
//     provider: c.google ? 'google' : 'local',
//     url: c.url,
//     missing,
//     backend: c.backend,
//     server: srv,
//     // The model the server runs: the pinned one, the user's own file (its name and size), or an external server's model_path.
//     model: c.url ? extModel : c.a.modelPath ? { label: 'Custom model', file: path.basename(c.model), bytes: exists(c.model) ? fs.statSync(c.model).size : 0 }
//       : { label: c.pin.label, file: path.basename(c.model), bytes: c.pin.bytes, repo: c.pin.repo, mmprojRepo: c.pin.mmproj.repo },
//     licence: { name: c.pin.licence.name, model: c.pin.licence.model, url: c.pin.licence.url },
//     leftovers: leftovers(c),
//     gpuMemory: c.gpu,
//   };
// }
//
// // ---------------------------------------------------------------------------------------------
// // Install
//
// const progress = (p) => send({ type: 'progress', ...p });
//
// async function getJson(url, signal) {
//   const res = await fetch(url, { headers: UA, signal });
//   if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
//   return res.json();
// }
//
// // ponytail: no resume; a cancelled or failed download starts again from zero.
// /** `check` = {algo, hex, head?}: the hash of `head` + the file must be `hex`, or the file is deleted and the install fails. */
// async function download(url, dest, { check, signal, report }) {
//   const res = await fetch(url, { headers: UA, signal });
//   if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
//   const total = Number(res.headers.get('content-length')) || 0;
//   const hash = crypto.createHash(check.algo).update(check.head || '');
//   let received = 0;
//   let last = 0;
//   const count = new Transform({
//     transform(chunk, _enc, done) {
//       hash.update(chunk);
//       received += chunk.length;
//       if (Date.now() - last > 150) {
//         last = Date.now();
//         report(received, total);
//       }
//       done(null, chunk);
//     },
//   });
//   const part = `${dest}.part`;
//   try {
//     await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(part), { signal });
//     report(received, total);
//     if (hash.digest('hex') !== check.hex.toLowerCase()) throw new Error(`${path.basename(dest)} is damaged (checksum mismatch) and was deleted. Try again.`);
//     await fsp.rename(part, dest);
//   } finally {
//     await fsp.rm(part, { force: true });
//   }
// }
//
// /** `file` of Hugging Face `repo` at its pinned `commit`, checked against the tree API's sha256 (LFS oid); a small text file kept
//  * in git (the licence) against its git blob id. No checksum listed: the install stops. */
// async function hfDownload({ repo, commit }, file, dest, signal, report) {
//   const folder = path.posix.dirname(file); // the tree API lists one folder
//   const f = (await getJson(`https://huggingface.co/api/models/${repo}/tree/${commit}${folder === '.' ? '' : `/${folder}`}`, signal)).find((x) => x.path === file);
//   const check = /^[0-9a-f]{64}$/.test(f?.lfs?.oid) ? { algo: 'sha256', hex: f.lfs.oid }
//     : !f?.lfs && /^[0-9a-f]{40}$/.test(f?.oid) && f.size < 1e6 ? { algo: 'sha1', head: `blob ${f.size}\0`, hex: f.oid } : null;
//   if (!check) throw new Error(`Hugging Face lists no checksum for ${file}, so the install stopped. Try again later.`);
//   await download(`https://huggingface.co/${repo}/resolve/${commit}/${file}`, dest, { check, signal, report });
// }
//
// const tar = (args) => new Promise((resolve, reject) => {
//   // Windows' own bsdtar reads zip files (a Git Bash tar on PATH would not).
//   execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), args, { windowsHide: true }, (e) => (e ? reject(e) : resolve()));
// });
//
// /** Downloads what is missing (llama.cpp for the backend, model, projector, licence), sending `progress` events. The renderer
//  * saves settings.assistant.installed afterwards. */
// async function runInstall() {
//   if (install) throw new Error('The assistant is already being installed.');
//   install = new AbortController();
//   const { signal } = install;
//   try {
//     const c = await config();
//     const lost = [c.a.serverPath, c.a.modelPath, c.a.mmprojPath].find((p) => p && !exists(p)); // nothing to download for it: say so
//     if (lost) throw new Error(`${lost} was not found (Settings > Assistant > Advanced).`);
//     await fsp.mkdir(path.join(dir(), 'models'), { recursive: true });
//     const steps = [];
//     if (!exists(c.exe) && !c.a.serverPath) {
//       // The zips (CUDA: the build and its runtime) extract into one staging folder, renamed when all are in.
//       const assets = PINS.assets[c.backend];
//       const stage = `${binDir(c.backend)}.part`;
//       let release = null;
//       const fetchZip = async (a, i, report) => {
//         release ??= getJson(RELEASE, signal);
//         const asset = (await release).assets?.find((x) => x.name === a.name);
//         if (!asset) throw new Error(`The llama.cpp ${PINS.build} release has no ${a.name}.`);
//         const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || '')?.[1];
//         if (!sha256) throw new Error(`GitHub lists no SHA-256 for ${a.name}, so the install stopped (nothing unchecked is run). Try again later.`);
//         if (i === 0) {
//           await fsp.rm(stage, { recursive: true, force: true });
//           await fsp.mkdir(stage);
//         }
//         const zip = path.join(dir(), a.name);
//         await download(asset.browser_download_url, zip, { check: { algo: 'sha256', hex: sha256 }, signal, report });
//         await tar(['-xf', zip, '-C', stage]).finally(() => fsp.rm(zip, { force: true }));
//         if (i < assets.length - 1) return;
//         if (!findExe(stage)) throw new Error(`${EXE} is missing from ${assets[0].name}.`);
//         await fsp.rm(binDir(c.backend), { recursive: true, force: true });
//         await fsp.rename(stage, binDir(c.backend));
//       };
//       for (const [i, a] of assets.entries()) {
//         steps.push([a.label, (report) => fetchZip(a, i, report).catch(async (e) => {
//           await fsp.rm(stage, { recursive: true, force: true });
//           throw e;
//         })]);
//       }
//     }
//     if (!exists(c.model) && !c.a.modelPath) steps.push(['model', (report) => hfDownload(c.pin, c.pin.file, c.model, signal, report)]);
//     if (!exists(c.mmproj) && !c.a.mmprojPath) steps.push(['image projector', (report) => hfDownload(c.pin.mmproj, c.pin.mmproj.file, c.mmproj, signal, report)]);
//     if (c.draft && !exists(c.draft)) steps.push(['MTP draft', (report) => hfDownload(c.pin.draft, c.pin.draft.file, c.draft, signal, report)]);
//     const licence = path.join(dir(), c.pin.licence.as);
//     if (!exists(licence)) steps.push(['licence', (report) => hfDownload(c.pin.licence, c.pin.licence.file, licence, signal, report)]);
//     for (const [i, [label, run]] of steps.entries()) {
//       progress({ step: i + 1, steps: steps.length, label, received: 0, total: 0 });
//       await run((received, total) => progress({ step: i + 1, steps: steps.length, label, received, total }));
//     }
//     return true;
//   } catch (e) {
//     throw signal.aborted ? new Error('cancelled') : e;
//   } finally {
//     install = null;
//   }
// }
//
// // ---------------------------------------------------------------------------------------------
// // Server
//
// function freePort() {
//   return new Promise((resolve, reject) => {
//     const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
//       const { port } = probe.address();
//       probe.close(() => resolve(port));
//     });
//   });
// }
//
// /** Kills a server a crash left behind (server.json's pid), only when that pid still runs a program of `exe`'s name. */
// async function killStale(exe) {
//   const old = await readJson(serverFile()).catch(() => null);
//   if (!Number.isInteger(old?.pid)) return;
//   const tasklist = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
//   const out = await new Promise((r) => execFile(tasklist, ['/FI', `PID eq ${old.pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (e, o) => r(e ? '' : o)));
//   if (out.toLowerCase().includes(`"${path.basename(exe).toLowerCase()}"`)) {
//     try {
//       process.kill(old.pid);
//     } catch {}
//   }
//   await fsp.rm(serverFile(), { force: true });
// }
//
// function startServer(c, sig) {
//   const s = { sig, key: crypto.randomBytes(32).toString('hex'), proc: null, up: false };
//   setState({ state: 'starting' });
//   s.ready = (async () => {
//     if (!onDisk(c)) throw new Error('The assistant is not installed (Settings > Assistant).');
//     await killStale(c.exe);
//     const port = await freePort();
//     if (server !== s) throw new Error('stopped'); // replaced or quit meanwhile: a process spawned now would be orphaned
//     const args = launchArgs({ model: c.model, mmproj: c.mmproj, port, key: s.key, sleepSeconds: c.sleepSeconds, fable: c.fable,
//       gemma: c.family === 'gemma', mtp: c.mtp, draft: c.draft, gpuMiB: c.gpu?.total }, c.step);
//     let log = '';
//     let boot = ''; // the load log, for the budget lines and the out-of-memory check
//     let code = null;
//     const proc = (s.proc = spawn(c.exe, args, { cwd: path.dirname(c.exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
//     const keep = (b) => {
//       log = (log + b).slice(-4096);
//       if (!s.up && boot.length < 1 << 20) boot += b;
//     };
//     proc.stdout.on('data', keep);
//     proc.stderr.on('data', keep);
//     proc.on('error', (e) => { code = e.message; });
//     proc.on('spawn', () => {
//       try {
//         os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
//       } catch {}
//       fsp.writeFile(serverFile(), JSON.stringify({ pid: proc.pid, port, started: Date.now() })).catch(() => {});
//     });
//     proc.on('exit', (exit, signal) => {
//       code ??= exit ?? signal ?? 'exit';
//       readJson(serverFile()).then((j) => j?.pid === proc.pid && fsp.rm(serverFile(), { force: true })).catch(() => {});
//       if (server === s && s.up) { // a crash: the next request starts it again
//         server = null;
//         setState({ state: 'stopped' });
//       }
//     });
//     const url = (s.url = `http://127.0.0.1:${port}`);
//     try {
//       await waitHealthy(fetch, url, () => code !== null);
//     } catch (e) {
//       if (code === null) throw e;
//       const err = new Error(`llama-server stopped (${code}). ${log.trim().split(/\s*\n/).slice(-3).join(' ')}`);
//       err.oom = OOM.test(boot);
//       throw err;
//     }
//     s.up = true;
//     if (!budgetLogged) { // what the first load put where (§13.2 budget)
//       budgetLogged = true;
//       for (const line of boot.split('\n')) if (/model buffer size|KV|compute buffer size/.test(line)) console.log(`llama-server: ${line.trim()}`);
//     }
//     boot = '';
//     if (server === s) setState({ state: 'ready' });
//     return { url, key: s.key };
//   })();
//   s.ready.catch((e) => {
//     if (server !== s) return;
//     stopServer();
//     setState({ state: 'error', error: e.message });
//   });
//   return s;
// }
//
// /** Kills the local server; resolves once it has exited (at most 5 s), so its files can be deleted. */
// function stopServer() {
//   clearTimeout(idleTimer);
//   const proc = server?.proc;
//   if (server) {
//     server = null;
//     setState({ state: 'stopped' });
//   }
//   if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
//   const exited = new Promise((r) => proc.once('exit', r));
//   proc.kill();
//   return Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
// }
//
// /** {url, key}: settings.assistant.serverUrl (+ apiKey) as it is, or the local server, started or restarted for changed files or
//  * flags. A load that fails out of memory moves settings.assistant.step one degrade step on and starts once more. */
// async function ensure(c, retried = false) {
//   if (c.url) return { url: c.url, key: c.key };
//   const sig = [c.exe, c.model, c.mmproj, c.draft, c.step, c.sleepSeconds, c.fable, c.family, c.mtp].join('|');
//   if (server?.sig !== sig) {
//     stopServer();
//     server = startServer(c, sig);
//   }
//   const s = server;
//   try {
//     return await s.ready;
//   } catch (e) {
//     if (!e.oom || retried || c.step >= MAX_STEP) throw e;
//     const a = (await getSettings()).assistant || {};
//     if ((Number(a.step) || 0) === c.step) await setSettings({ assistant: { ...a, step: c.step + 1 } }); // once for parallel callers
//     return ensure(await config(), true);
//   }
// }
//
// /** Tier 2 idle: the local server is killed `idleUnloadMinutes` after the last request (0 = never); a running chat defers it. */
// function touch(c) {
//   clearTimeout(idleTimer);
//   if (c.url || !c.idleMinutes) return;
//   idleTimer = setTimeout(() => (chats.size ? touch(c) : stopServer()), c.idleMinutes * 60000);
// }
//
// /** The chat panel opening: starts a stopped server, or wakes a sleeping one (POST /tokenize), so the load overlaps the typing. */
// async function warm() {
//   const c = await config();
//   const { url, key } = await ensure(c);
//   if (!c.url) await wake(fetch, url, key);
//   touch(c);
//   return true;
// }
//
// /** App start (main.js, 10 s after the window shows) and the power events: starts the local server in the background when the
//  * assistant is installed, warmAtStart is on, the computer is not on battery and nothing else serves it. Failures only go to
//  * the log (the next request shows them). */
// async function autoWarm() {
//   try {
//     const c = await config();
//     if (!c.a.installed || c.a.warmAtStart === false || powerMonitor.isOnBatteryPower() || c.url) return;
//     if (!onDisk(c)) return;
//     await ensure(c);
//     touch(c);
//   } catch (e) {
//     console.log(`assistant: warm-up failed: ${e.message}`);
//   }
// }
//
// // ---------------------------------------------------------------------------------------------
// // Chat
//
// // The caption that ends the text part before an attachment's picture (assistant.js pictures; its size line since wave 2b).
// const CAPTION = /\s*The next picture shows \[[^\]]*\](?:, [^.\n]*)?\.(?: The numbers on it are the legend's\.)?$/;
//
// /** Message `m` for a server without an image projector: no image parts, and each caption that ended the text part before one cut
//  * (the situation note and the attachments before it stay); a picture message of the tool loop ([its line, the picture], loop.js:
//  * view_render's, whose legend is in the tool message before it, and the board after a change) → null, left out. */
// function withoutPictures(m) {
//   if (!Array.isArray(m?.content) || !m.content.some((p) => p?.type === 'image_url')) return m;
//   if (m.content.length === 2 && m.content[0]?.type === 'text') return null;
//   const content = m.content.flatMap((p, i, all) => {
//     if (p?.type === 'image_url') return [];
//     if (p?.type !== 'text' || all[i + 1]?.type !== 'image_url') return [p];
//     const text = p.text.replace(CAPTION, '');
//     return text ? [{ ...p, text }] : [];
//   });
//   return { ...m, content };
// }
//
// /** Streams one completion as `assistant.event {rid, type: delta | reasoning | tool_call | done | error | novision}`; resolves at
//  * once (novision: the pictures were dropped, the server has no image projector).
//  * `think` sets the template's enable_thinking (the Qwen3.5 and Gemma 4 templates both read it) and the sampling preset of the
//  * model's family, and with it settings.assistant.thinking's budget (runtime.js
//  * thinkingLimits; `used`: the last request's tokens without its reasoning, so the budget fits); `tools` are OpenAI function tools,
//  * one call per turn.
//  * `done` carries `usage` ({prompt, completion} tokens, runtime.js finish) and `n_ctx` (the server's context, /props). */
// function chat({ rid, messages, tools, think, used, response_format } = {}) {
//   if (typeof rid !== 'string' || !rid || !Array.isArray(messages)) throw new Error('chat takes {rid, messages}');
//   chats.get(rid)?.abort();
//   const ac = new AbortController();
//   chats.set(rid, ac);
//   const emit = (e) => { if (!ac.signal.aborted) send({ rid, ...e }); };
//   let c = null;
//   (async () => {
//     try {
//       c = await config();
//       const { url, key } = await ensure(c);
//       if (c.google) {
//         // Gemini takes the OpenAI fields only: the model by name, no template switches or llama.cpp samplers. Thinking cannot be
//         // turned off on Gemini 3.8 Flash (its levels are low, medium and high), so a turn without Think asks for low; Xhigh and
//         // Max ask for high; Auto's thinking turns (solve, derive, prove) medium.
//         const effort = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }[c.a.thinking] ?? 'medium';
//         const body = {
//           model: c.googleModel,
//           messages,
//           ...(Array.isArray(tools) && tools.length && { tools, tool_choice: 'auto' }),
//           ...(response_format && { response_format }),
//           stream: true,
//           stream_options: { include_usage: true },
//           reasoning_effort: think ? effort : 'low',
//           max_tokens: 8192,
//         };
//         const n = googleWindow(c);
//         await streamChat(fetch, url, key, body, (e) => (e.type === 'done' ? n.then((ctx) => emit({ ...e, n_ctx: ctx })) : emit(e)), ac.signal);
//         return;
//       }
//       const body = {
//         messages,
//         ...(Array.isArray(tools) && tools.length && { tools, tool_choice: 'auto', parallel_tool_calls: false }),
//         ...(response_format && { response_format }),
//         stream: true,
//         stream_options: { include_usage: true },
//         chat_template_kwargs: { enable_thinking: !!think },
//         ...sampling(think, Array.isArray(tools) && tools.length > 0, c.family), // the family's preset, presence_penalty 0 with tools
//       };
//       // No X-Conversation-Id: it would turn on llama-server's replay buffer.
//       const info = props(fetch, url, key, 2000);
//       // Pictures (SPEC §7i Vision) need the image projector: a server whose /props reports no vision gets the text only.
//       const pictures = messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url'));
//       if (pictures && (await info)?.modalities?.vision === false) {
//         body.messages = messages.map(withoutPictures).filter(Boolean);
//         emit({ type: 'novision' });
//       }
//       const ctx = info.then((p) => p?.default_generation_settings?.n_ctx || null);
//       if (think) Object.assign(body, thinkingLimits(c.a.thinking, await ctx, used)); // the effort's budget, cut to fit the context
//       await streamChat(fetch, url, key, body, (e) => (e.type === 'done' ? ctx.then((n) => emit({ ...e, n_ctx: n })) : emit(e)), ac.signal);
//     } catch (e) {
//       emit({ type: 'error', message: e.message });
//     } finally {
//       if (chats.get(rid) === ac) chats.delete(rid);
//       if (c) touch(c);
//     }
//   })();
//   return true;
// }
//
// /** Aborts chat `rid`: the socket closes, llama-server frees the slot, no more events for it. */
// function cancelChat(rid) {
//   chats.get(rid)?.abort();
//   chats.delete(rid);
// }
//
// /** Stops the server and deletes userData/assistant/ (never a path of the user's). */
// async function remove() {
//   if (install) throw new Error('The assistant is being installed: cancel it first.');
//   await stopServer();
//   await fsp.rm(dir(), { recursive: true, force: true });
//   return true;
// }
//
// // ---------------------------------------------------------------------------------------------
//
// /** Registers the assistant.* channels through main.js's handle(); `saveSettings` is settings.set (the degrade step). */
// function register(handle, settings, win, saveSettings) {
//   getSettings = settings;
//   getWin = win;
//   setSettings = saveSettings;
//   handle('assistant.status', status);
//   handle('assistant.install', runInstall);
//   handle('assistant.cancel', () => install?.abort());
//   handle('assistant.warm', warm);
//   handle('assistant.stop', () => stopServer().then(() => true));
//   handle('assistant.delete', remove);
//   handle('assistant.deleteLeftover', deleteLeftover);
//   handle('assistant.chat', chat);
//   handle('assistant.cancelChat', cancelChat);
//   app.on('will-quit', stopServer);
//   // §13.2 Power: kill on battery, suspend and after 5 min locked; warm again 10 s after mains, unlock or resume (focused).
//   app.whenReady().then(() => {
//     const rewarm = () => setTimeout(autoWarm, 10000);
//     powerMonitor.on('on-battery', () => stopServer());
//     powerMonitor.on('suspend', () => stopServer());
//     powerMonitor.on('lock-screen', () => {
//       clearTimeout(lockTimer);
//       lockTimer = setTimeout(stopServer, 5 * 60000);
//     });
//     powerMonitor.on('unlock-screen', () => {
//       clearTimeout(lockTimer);
//       rewarm();
//     });
//     powerMonitor.on('on-ac', rewarm);
//     powerMonitor.on('resume', () => getWin()?.isFocused() && rewarm());
//   });
// }
//
// module.exports = { register, autoWarm, PINS };
