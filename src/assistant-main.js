'use strict';
// The assistant, main-process side (SPEC §7i): chat completions stream from a cloud provider's OpenAI-compatible endpoint to the
// renderer as `assistant.event`, and the coding CLIs run whole turns (cli.js). An OpenAI-compatible server in
// settings.assistant.serverUrl (+ apiKey) takes the provider's place only while settings.assistant.provider names none (the
// eval's stub server).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const agentServer = require('./agent-server.js');
const { advanced } = require('./assistant/advanced.js');
const cli = require('./assistant/cli.js');
const { props, streamChat } = require('./assistant/runtime.js');
const { providerSearch, searchFields } = require('./assistant/search.js');
const QWEN_MODELS = require('./assistant/qwen-models.json'); // [{id, label, ctx}], also the Settings checklist

// Google AI's OpenAI-compatible base (ai.google.dev/gemini-api/docs/openai, read 2026-10-07): Bearer API key, model in the body.
const GOOGLE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GOOGLE_CTX = 1048576; // a Google model's context window when its model page does not answer (Gemini 3.8 Flash's input limit)
const googleWindows = new Map(); // `${model}|${key}` → its inputTokenLimit (or GOOGLE_CTX), asked once per model and key
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
const runs = new Map(); // rid → a CLI run's {kill}

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
  const a = { ...(await getSettings()).assistant, ...over };
  if (cli.isCli(a.provider)) {
    // Claude Code or Codex: {state: ready | not_found | signed_out, cli: cli.js probe()}; over.fresh asks the CLI again.
    const p = await cli.probe(a.provider, a, over?.fresh === true);
    const model = String(a[cli.CLIS[p.id].modelField] ?? '').trim();
    return {
      ready: p.state === 'ready', provider: p.id, providerLabel: p.label, state: p.state, cli: p, ctx: null, url: null, missing: [],
      server: { state: 'ready', sleeping: false }, model: { label: model || 'Default', file: model, bytes: 0 },
    };
  }
  const c = await config(over);
  const ext = c.cloud ? null : await props(fetch, c.url, c.key); // a server names its model and context through /props
  return {
    ready: c.cloud ? !!c.key : true,
    provider: c.provider ?? 'server',
    providerLabel: c.cloud?.label ?? 'the server',
    ctx: c.google ? (c.key ? await googleWindow(c) : GOOGLE_CTX) : c.cloud ? c.ctx : ext?.default_generation_settings?.n_ctx || null,
    url: c.url,
    missing: [],
    server: { state: 'ready', sleeping: false },
    model: c.cloud ? { label: c.model, file: c.model, bytes: 0 }
      : ext?.model_path ? { label: path.basename(String(ext.model_path)), file: path.basename(String(ext.model_path)), bytes: 0 } : null,
  };
}

const EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }; // Gemini's and DeepSeek's reasoning_effort
const BUDGET = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 }; // Qwen Cloud's thinking_budget (tokens)
/** The thinking fields of a DeepSeek or Qwen Cloud request at the Thinking menu's `level`, thinking only when `think`. */
const thinkingFields = (provider, think, level) => (provider === 'deepseek'
  ? { thinking: { type: think ? 'enabled' : 'disabled' }, ...(think && { reasoning_effort: EFFORT[level] ?? 'medium' }) }
  : { enable_thinking: !!think, ...(think && { thinking_budget: BUDGET[level] ?? 4096 }) });

/** Streams one completion as `assistant.event {rid, type: delta | reasoning | tool_call | done | error}`; resolves at
 * once. Google AI: the model by name and `reasoning_effort` (Gemini 3.8 Flash cannot turn thinking off: low without Think, with it
 * the Thinking menu's level, Xhigh and Max as high, Auto's thinking turns medium). DeepSeek and Qwen Cloud: thinkingFields. A server: the OpenAI fields. `done` carries `usage` and `n_ctx` (the context window). */
function chat({ rid, messages, tools, think, response_format } = {}) {
  if (typeof rid !== 'string' || !rid || !Array.isArray(messages)) throw new Error('chat takes {rid, messages}');
  chats.get(rid)?.abort();
  const ac = new AbortController();
  chats.set(rid, ac);
  const emit = (e) => { if (!ac.signal.aborted) send({ rid, ...e }); };
  (async () => {
    try {
      const c = await config();
      if (cli.isCli(c.a.provider)) throw new Error('Claude Code and Codex run whole turns through assistant.cliRun.');
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
          max_tokens: advanced(c.a).maxTokens, // Settings > Assistant > Advanced (8192 by default)
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
          max_tokens: advanced(c.a).maxTokens, // Settings > Assistant > Advanced (8192 by default)
          ...thinkingFields(c.provider, think, c.a.thinking),
          ...searchFields(c.a), // the provider's own web search (assistant/search.js)
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
      const ctx = props(fetch, c.url, c.key, 2000).then((p) => p?.default_generation_settings?.n_ctx || null);
      await streamChat(fetch, c.url, c.key, body, (e) => (e.type === 'done' ? ctx.then((n) => emit({ ...e, n_ctx: n })) : emit(e)), ac.signal);
    } catch (e) {
      emit({ type: 'error', message: e.message });
    } finally {
      if (chats.get(rid) === ac) chats.delete(rid);
    }
  })();
  return true;
}

/** Aborts chat `rid`: the socket closes (a CLI run: its process tree is killed), no more events for it. */
function cancelChat(rid) {
  chats.get(rid)?.abort();
  chats.delete(rid);
  runs.get(rid)?.kill();
  runs.delete(rid);
}

/** Kills every CLI run: on quit, before an update installs and when the main window's page reloads or its renderer dies (no
 * chat panel is left to stop them, and a portable update cannot replace an exe the bridge still runs). */
const killRuns = () => [...runs.keys()].forEach(cancelChat);

/** One turn on the CLI of settings.assistant.provider + `over` (cli.js) → {kill}: `prompt` on stdin, `system` (the system prompt)
 * through a file (Claude) or -c (Codex), `session` (the previous turn's done.session) resumed. Runs in userData/assistant-cli, an
 * empty folder, so the CLI sees none of the user's files. Every event → `emit`. */
async function startRun({ prompt, system, session }, emit, over = {}) {
  const a = { ...(await getSettings()).assistant, ...over };
  const id = a.provider;
  if (!cli.isCli(id)) throw new Error('The assistant does not run on Claude Code or Codex');
  const p = await cli.probe(id, a);
  if (p.state !== 'ready') {
    emit({ type: 'error', code: p.state, message: p.hint });
    return { kill() {} };
  }
  const c = cli.CLIS[id];
  const cwd = path.join(app.getPath('userData'), 'assistant-cli');
  fs.mkdirSync(cwd, { recursive: true });
  agentServer.startPipe(); // Settings' Test can run before the provider that opens it is saved
  const link = agentServer.assistantLink();
  const opts = { link, model: String(a[c.modelField] ?? '').trim(), effort: String(a[c.effortField] ?? '').trim(), resume: session || '', search: providerSearch(a) };
  let args;
  if (id === 'claude') {
    const systemFile = system ? path.join(cwd, 'system-prompt.txt') : '';
    if (system) fs.writeFileSync(systemFile, system);
    args = cli.claudeArgs({ ...opts, systemFile });
  } else args = cli.codexArgs({ ...opts, system });
  return cli.run({ id, file: p.path, args, cwd, prompt, key: link.key, emit });
}

/** Streams one CLI turn as `assistant.event {rid, type: delta | reasoning | tool_start | tool_end | done | error}` (SPEC §7i Coding
 * CLIs); resolves at once. Stop: assistant.cancelChat(rid). */
function cliRun({ rid, prompt, system, session } = {}) {
  if (typeof rid !== 'string' || !rid || typeof prompt !== 'string') throw new Error('cliRun takes {rid, prompt}');
  cancelChat(rid);
  const live = { kill() {} };
  runs.set(rid, live);
  const emit = (e) => {
    if (runs.get(rid) !== live) return;
    if (e.type === 'done' || e.type === 'error') runs.delete(rid);
    send({ rid, ...e });
  };
  startRun({ prompt, system, session }, emit).then((r) => {
    if (runs.get(rid) === live) live.kill = r.kill;
    else r.kill(); // stopped while it started
  }, (e) => emit({ type: 'error', message: e.message }));
  return true;
}

const TEST_PROMPT = 'Call the ui_state tool once. Then reply with the single word ready.';

/** Settings' Test: one tiny turn on the CLI of settings.assistant + `over` (the dialog's unsaved fields) → {ok, tools (EasyWriter's
 * ui_state answered), reply, code, message}. */
function cliTest(over = {}) {
  return new Promise((resolve) => {
    let reply = '';
    let tools = false;
    let run = null;
    const end = (res) => {
      clearTimeout(timer);
      run?.kill();
      resolve({ ok: false, tools, reply: reply.trim(), ...res });
    };
    const timer = setTimeout(() => end({ message: 'No answer within 2 minutes.' }), 120000);
    startRun({ prompt: TEST_PROMPT, system: 'You check that a tool works. Be brief.' }, (e) => {
      if (e.type === 'delta') reply += e.text;
      if (e.type === 'tool_end' && e.name === 'ui_state' && e.ok) tools = true;
      if (e.type === 'done') end({ ok: true });
      if (e.type === 'error') end({ code: e.code, message: e.message });
    }, over).then((r) => { run = r; }, (e) => end({ message: e.message }));
  });
}

/** The setup's Save (docs/plans/onboarding.md helpers): whether `key` works for the cloud provider `provider`, asked through its
 * OpenAI-compatible models list, which spends no tokens → {ok, message}. */
async function checkKey({ provider, key } = {}) {
  if (!Object.hasOwn(CLOUD, provider)) return { ok: false, message: 'This provider has no API key.' };
  const { url, label } = CLOUD[provider];
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return { ok: false, message: `Add your ${label} API key.` };
  try {
    const res = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(15000) });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => null);
    const said = String((Array.isArray(body) ? body[0] : body)?.error?.message ?? '').trim(); // Google AI answers with a list
    const why = res.status === 401 || res.status === 403 ? `${label} did not accept this key.` : `${label} answered HTTP ${res.status}.`;
    return { ok: false, message: said ? `${why} ${said}` : why };
  } catch (e) {
    return { ok: false, message: `${label} could not be reached. ${e.message}` };
  }
}

// The writing guide (prompts.mjs GUIDE_RULE): EasyWriter's own, shipped with the app, so every user and every provider gets the
// same one and nothing is read from the user's home folder (the user, 2026-10-25: "what if another user downloads the app").
// Read at every turn, so an edit to the file reaches a dev build's next message without a restart.
const GUIDE = path.join(__dirname, 'assistant', 'human-writing.md');
const writingGuide = () => fs.promises.readFile(GUIDE, 'utf8');

/** Registers the assistant.* channels through main.js's handle(). */
function register(handle, settings, win) {
  getSettings = settings;
  getWin = win;
  handle('assistant.status', status);
  handle('assistant.writingGuide', writingGuide);
  handle('assistant.chat', chat);
  handle('assistant.cancelChat', cancelChat);
  handle('assistant.cliRun', cliRun);
  handle('assistant.cliTest', cliTest);
  handle('assistant.checkKey', checkKey);
  app.on('will-quit', killRuns);
}

module.exports = { register, killRuns };
