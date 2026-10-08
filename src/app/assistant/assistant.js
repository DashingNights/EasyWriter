import { toast } from 'sonner';
import { refocusEditor, saveSettings } from '../actions.js';
import { getState, setState, useStore } from '../store.js';
import { modelContent, partsText } from './attach.mjs';
import { buildHistory, COMPACT_ASK, COMPACT_SYSTEM, repeats, shouldCompact } from './context.mjs';
import { runTurn } from './loop.js';
import QWEN_MODELS from '../../assistant/qwen-models.json';

// The local assistant's chat (SPEC §7i; automation plan §13.4): the panel's state and the client of api.assistant (main runs
// llama-server, §13.2). `state.assistant` holds the panel and the conversation for the session only (§13.6: never stored):
// {open, status, messages, turn, pending, usage}; a message is {id, role: 'user' | 'assistant' | 'step' | 'divider', text,
// reasoning, streaming, error, step?: {title, ok, code?, undoSteps, summary, undo?, undone?, call?: {id, name, args}, line?}}, a user
// message also {parts (its text and attachment pills, attach.mjs), content (what the model gets)}, a divider (a compaction) also
// {summary?, pending?}; `turn` is {ctrl} (its AbortController) while a turn runs (loop.js); `pending` is message parts for the text
// box (tool search asked while a turn ran); `usage` is {used, ctx, next?}: the last request's prompt + completion tokens and the
// server's context (the ring), and `used` without the reasoning (end), which main uses to fit the thinking budget. `state.assistantInstall` is the open install dialog ({id, resolve}).

const api = window.api;
export const CTX = 16384; // llama-server -c until a request reports the server's n_ctx
const IDLE = { open: false, status: null, messages: [], turn: null, pending: null, usage: null };
export const ASSISTANT_DEFAULTS = {
  installed: false, model: 'qwen9b', mtp: false, backend: 'auto', serverPath: '', modelPath: '', mmprojPath: '', serverUrl: '', apiKey: '',
  provider: 'qwen', googleKey: '', googleModel: 'gemini-3.8-flash', // a cloud provider since 2026-10-07 (local models commented out)
  qwenKey: '', qwenModel: 'qwen3.7-plus', qwenModels: ['qwen3.7-plus', 'qwen3.7-flash', 'qwen3.8-flash', 'qwen3.8-max'], // Qwen Cloud (2026-10-08)
  deepseekKey: '', deepseekModel: 'deepseek-flash', // provider 'deepseek' (2026-10-08)
  warmAtStart: true, sleepMinutes: 10, idleUnloadMinutes: 30, step: 0, panel: null, thinking: 'auto', permission: 'standard', uiControl: true,
  pictureAfterWrite: true,
};
// export const BACKENDS = [['auto', 'Auto'], ['cuda', 'NVIDIA CUDA'], ['vulkan', 'Vulkan'], ['cpu', 'CPU']]; // LOCAL LLM (commented out 2026-10-07)
const THINK_RE = /\b(solve|derive|prove|verify|calculate|compute|integral|equation|simplif(y|ies))\b/i; // §13.16 routing
// settings.assistant.thinking (user decision 2026-10-06): the chat panel's Thinking menu [id, label, line]; main sends each one's
// budget (runtime.js thinkingLimits).
// The user's list of 2026-10-07 ("the standard low medium high xhigh max efforts in the switcher, and auto"; Off went, Auto covers
// it on this computer): [id, label, line on this computer, line with Google AI, line with DeepSeek,
// line with Qwen Cloud (its thinking_budget)]. Gemini 3.8 Flash has low, medium and high only.
export const EFFORTS = [
  ['auto', 'Auto', 'Thinks for solve, derive or prove requests', 'Low, or medium for solve, derive or prove requests', 'Off, or medium for solve, derive or prove requests', 'Off, or up to 4,096 tokens for solve, derive or prove requests'],
  ['low', 'Low', 'Up to 1,024 tokens of thinking', 'Gemini thinking level low', 'DeepSeek thinking effort low', 'Up to 1,024 tokens of thinking'],
  ['medium', 'Medium', 'Up to 4,096 tokens of thinking', 'Gemini thinking level medium', 'DeepSeek thinking effort medium', 'Up to 4,096 tokens of thinking'],
  ['high', 'High', 'Up to 8,192 tokens, less in a long chat', 'Gemini thinking level high', 'DeepSeek thinking effort high', 'Up to 8,192 tokens of thinking'],
  ['xhigh', 'Xhigh', 'Up to 16,384 tokens, less in a long chat', 'Gemini thinking level high, its highest', 'DeepSeek thinking effort high, its highest', 'Up to 16,384 tokens of thinking'],
  ['max', 'Max', 'Up to 32,768 tokens, less in a long chat', 'Gemini thinking level high, its highest', 'DeepSeek thinking effort high, its highest', 'Up to 32,768 tokens of thinking'],
];

const get = () => getState().assistant ?? IDLE;
const set = (patch) => setState({ assistant: { ...get(), ...patch } });
export const useAssistant = () => useStore((s) => s.assistant ?? IDLE);
export const assistantSettings = () => ({ ...ASSISTANT_DEFAULTS, ...getState().settings?.assistant });
const message = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
export const size = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/** Saves `patch` over the stored settings.assistant read fresh (main may have moved `step` meanwhile). */
export async function saveAssistant(patch) {
  const fresh = (await api.settings.get()).assistant;
  return saveSettings({ assistant: { ...ASSISTANT_DEFAULTS, ...fresh, ...patch } });
}

/** Whether the chat can run: installed (or a server URL) and nothing missing. */
export const usable = (status) => !!status?.ready && (!!status.url || assistantSettings().installed);

export function refreshStatus() {
  return api.assistant.status().then((status) => {
    set({ status });
    return status;
  }, () => null);
}

/** Refreshes the status and, when usable, starts or wakes the server (§13.2 re-warm: opening the panel, holding its mic). */
export const wake = () => refreshStatus().then((s) => usable(s) && api.assistant.warm().then(refreshStatus, () => {}));

/** Opens or closes the panel. Opening wakes the server. Provider 'none' turns the assistant off: it never opens. */
export function toggleChat(open = !get().open) {
  if (!open) return closeChat();
  if (assistantSettings().provider === 'none') return undefined;
  set({ open: true });
  wake();
}

export function closeChat() {
  set({ open: false });
  refocusEditor();
}

/** The saved thinking effort, one of EFFORTS ('auto' when unset or unknown). */
export const thinkingEffort = (t = assistantSettings().thinking) => (EFFORTS.some(([id]) => id === t) ? t : 'auto');

// The chat panel's model menu (2026-10-08): the enabled Qwen Cloud models, then Gemini and DeepSeek, each provider only with its key.
export const MODEL_FIELD = { qwen: 'qwenModel', google: 'googleModel', deepseek: 'deepseekModel' };
const QWEN_LABEL = Object.fromEntries(QWEN_MODELS.map((m) => [m.id, m.label]));
/** [[provider, model id, label], ...] that settings.assistant `a` can run. */
export const modelChoices = (a) => [
  ...(a.qwenKey ? (a.qwenModels ?? []).map((id) => ['qwen', id, QWEN_LABEL[id] ?? id]) : []),
  ...(a.googleKey ? [['google', a.googleModel || 'gemini-3.8-flash', 'Gemini']] : []),
  ...(a.deepseekKey ? [['deepseek', a.deepseekModel || 'deepseek-flash', 'DeepSeek']] : []),
];
/** Picks the model of the next request (saved at once, kept across chats). */
export const pickModel = (provider, id) => saveAssistant({ provider, [MODEL_FIELD[provider]]: id }).then(refreshStatus);

/** The Thinking menu: saved at once (settings.assistant.thinking), kept across chats and restarts. */
export const setThinking = (thinking) => saveAssistant({ thinking });

/** Whether a request runs with thinking: Auto only for a maths-style request (§13.16), every other effort always. */
export function wantsThinking(text) {
  return thinkingEffort() === 'auto' ? THINK_RE.test(text) : true;
}

// ---------------------------------------------------------------------------------------------
// Turns. A turn (loop.js runTurn) makes one or more completions; each streams into one assistant message.

const turns = new Map(); // completion rid → {calls, resolve}
// Kept across turns (loop.js): the rev of the assistant's last document read (revs: per background draft id), the tools
// commands_describe added, the view key.
const session = { lastRev: undefined, revs: {}, described: new Map(), viewKey: null };

export const patchMessage = (id, fn) => set({ messages: get().messages.map((m) => (m.id === id ? { ...m, ...fn(m) } : m)) });

/** Appends message `m` (`id` made when missing); returns its id. */
export function addMessage(m) {
  const id = m.id ?? crypto.randomUUID();
  set({ messages: [...get().messages, { text: '', reasoning: '', streaming: false, error: '', ...m, id }] });
  return id;
}

/** The conversation as OpenAI messages (context.mjs buildHistory): texts (no reasoning, §13.2) and tool-call summaries. */
export const history = () => buildHistory(get().messages);

/** Streams one completion of `req` ({messages, tools?, think}) into a new assistant message (`quiet`: into no message). Resolves
 * with {id, text, reasoning, toolCalls: [{id, name, arguments}], finish, error} when it ends, fails or `signal` aborts it (finish
 * 'cancelled'). A shown completion's usage moves the ring. */
export function complete(req, signal, quiet = false) {
  const rid = quiet ? crypto.randomUUID() : addMessage({ role: 'assistant', streaming: true });
  return new Promise((resolve) => {
    turns.set(rid, { calls: [], text: '', reasoning: '', checked: { text: 0, reasoning: 0 }, quiet, resolve });
    const cancel = () => {
      api.assistant.cancelChat(rid);
      end(rid, { finish: 'cancelled' });
    };
    if (signal?.aborted) return cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    const u = get().usage; // used: fits the thinking budget
    api.assistant.chat({ rid, ...req, used: u?.next ?? u?.used ?? 0 }).catch((e) => end(rid, { error: message(e) }));
  });
}

function end(rid, { finish = null, error = '', usage, n_ctx: ctx }) {
  const t = turns.get(rid);
  if (!t) return;
  turns.delete(rid);
  if (usage && !t.quiet) {
    // next: the tokens the next prompt starts from. The reasoning is never sent back (buildHistory), so its share of the completion
    // (by characters) is left out; otherwise one long think would cut the next request's budget by as much.
    const r = t.reasoning.length;
    const kept = t.text.length + t.calls.reduce((n, c) => n + c.name.length + c.arguments.length, 0);
    const next = usage.prompt + Math.round(usage.completion * (r ? kept / (r + kept) : 1));
    set({ usage: { used: usage.prompt + usage.completion, ctx: ctx || get().usage?.ctx || CTX, next } });
  }
  patchMessage(rid, () => ({ streaming: false, error }));
  t.resolve({ id: rid, text: t.text, reasoning: t.reasoning, toolCalls: t.calls, finish, error });
}

let saidNoVision = false; // the server has no image projector: said once a session

api.assistant.onEvent((e) => {
  if (e.type === 'status') {
    if (get().status) set({ status: { ...get().status, server: e.server } });
    return;
  }
  const t = turns.get(e.rid);
  if (!t) return;
  if (e.type === 'delta' || e.type === 'reasoning') {
    const k = e.type === 'delta' ? 'text' : 'reasoning';
    t[k] += e.text;
    if (!t.quiet) patchMessage(e.rid, (m) => ({ [k]: m[k] + e.text }));
    // Repetition guard (SPEC §7i): a looping stream is cut off; the tool loop asks once more without thinking.
    if (t[k].length - t.checked[k] >= 30) {
      t.checked[k] = t[k].length;
      if (repeats(t[k])) {
        api.assistant.cancelChat(e.rid);
        end(e.rid, { finish: 'repeat' });
      }
    }
  } else if (e.type === 'novision') {
    if (!saidNoVision) toast('This server has no image projector, so the pictures were not sent.');
    saidNoVision = true;
  } else if (e.type === 'tool_call') t.calls.push({ id: e.id, name: e.name, arguments: e.arguments, ...(e.extra && { extra: e.extra }) });
  else if (e.type === 'done') end(e.rid, { finish: e.finish_reason, usage: e.usage, n_ctx: e.n_ctx });
  else if (e.type === 'error') end(e.rid, { error: e.message });
});

/** The user's message `parts` (the text box's content: strings and attachments, attach.mjs) with `note` for the model (where
 * it came from): shown, then answered by one tool-loop turn (loop.js), after a compaction when the last request used 80 % of
 * the context. → false when it is empty or a turn runs. */
export function send(parts, note = '') {
  const text = partsText(parts).trim();
  if (!text || get().turn) return false;
  const divider = shouldCompact(get().usage) ? addMessage({ role: 'divider', text: 'Summarizing earlier messages...', pending: true }) : null;
  const kept = parts.map((p) => (typeof p === 'string' || !p.picture ? p : withoutPicture(p))); // the message keeps no renderer
  const id = addMessage({ role: 'user', text, parts: kept, content: modelContent(parts, note) });
  const ctrl = new AbortController();
  set({ turn: { ctrl } });
  session.signal = ctrl.signal;
  (async () => {
    if (divider && !(await compact(divider, ctrl.signal))) return;
    const pics = await pictures(parts);
    if (pics.length) patchMessage(id, () => ({ content: modelContent(parts, note, pics) })); // the pictures before the request
    await runTurn(session, text, kept);
  })()
    .catch((e) => addMessage({ role: 'assistant', error: message(e) }))
    .finally(() => get().turn?.ctrl === ctrl && set({ turn: null }));
  return true;
}

const withoutPicture = ({ picture, ...p }) => p;

/** Vision (SPEC §7i): the pictures of the attachments in `parts` that have one (capture.js), each as OpenAI content parts, a
 * line naming its pill and its size (wave 2b; a marked picture adds that its numbers are the legend's, the attachment's numbered
 * lines) and the image_url part (a PNG data URL); one that fails to render is left out. Only the message being answered carries
 * them: the history sends its text (context.mjs buildHistory). */
async function pictures(parts) {
  const atts = parts.filter((p) => typeof p !== 'string' && p.picture);
  const pics = await Promise.all(atts.map((a) => a.picture().catch(() => null)));
  const caption = (a, p) => `The next picture shows [${a.label}], ${p.size}.${a.marked ? " The numbers on it are the legend's." : ''}`;
  return atts.flatMap((a, i) => (pics[i] ? [{ type: 'text', text: caption(a, pics[i]) }, { type: 'image_url', image_url: { url: pics[i].url } }] : []));
}

/** Compaction (SPEC §7i Context): one tool-less, non-thinking request summarizes the history before divider `id`, which then
 * holds the summary; the model gets it in place of the messages before it (shown dimmed). A failed summary moves the divider
 * before the last two earlier turns, which are sent as they are. → false when Stop cancelled it (the divider goes). */
async function compact(id, signal) {
  const all = get().messages;
  const before = all.slice(0, all.findIndex((m) => m.id === id));
  // The ask is the message being answered, so an earlier user message left last (a stopped turn) goes as its label only.
  const req = { messages: [{ role: 'system', content: COMPACT_SYSTEM }, ...buildHistory([...before, { role: 'user', text: COMPACT_ASK }])], think: false };
  const r = await complete(req, signal, true);
  if (r.finish === 'cancelled' || signal.aborted) {
    set({ messages: get().messages.filter((m) => m.id !== id) });
    return false;
  }
  set({ usage: { used: 0, ctx: get().usage?.ctx || CTX } });
  if (!r.error && r.finish !== 'repeat' && r.text.trim()) {
    patchMessage(id, () => ({ text: 'Earlier messages were summarized.', summary: r.text.trim(), pending: false }));
    return true;
  }
  const ms = get().messages.filter((m) => m.id !== id);
  const users = ms.flatMap((m, i) => (m.role === 'user' && i < ms.length - 1 ? [i] : []));
  const cut = users.length > 2 ? users.at(-2) : 0;
  const d = { id, role: 'divider', text: 'The summary failed, so only the last two turns before this one are sent.', reasoning: '', error: '' };
  set({ messages: [...ms.slice(0, cut), d, ...ms.slice(cut)] });
  return true;
}

/** New chat: stops a running reply (its approval card goes with it) and clears the conversation, the waiting attachments and the
 * ring; the session's last read rev and described tools go too. */
export function newChat() {
  stop();
  Object.assign(session, { lastRev: undefined, revs: {}, viewKey: null });
  session.described.clear();
  set({ messages: [], turn: null, pending: null, usage: get().usage && { used: 0, ctx: get().usage.ctx } });
}

/** Tool search's "Resolve with assistant" (SPEC §7c): the panel shown whatever its state and `parts` sent with `note`; while
 * a turn runs they go into the text box instead, for the user to send. */
export function ask(parts, note) {
  toggleChat(true);
  if (!send(parts, note)) set({ pending: parts });
}

export const clearPending = () => set({ pending: null });

/** Stop: ends the running turn: the streaming completion (its message keeps the text so far), a command waiting on its card. */
export function stop() {
  get().turn?.ctrl.abort();
}

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// // ---------------------------------------------------------------------------------------------
// // Install dialog (§13.2: downloads only when the user starts it)
//
// /** Opens the install dialog; resolves true once installed, false when it closes without. */
// export function openInstall() {
//   getState().assistantInstall?.resolve(false);
//   return new Promise((resolve) => setState({ assistantInstall: { id: Date.now(), resolve } }));
// }
//
// export function closeInstall(installed = false) {
//   const open = getState().assistantInstall;
//   setState({ assistantInstall: null });
//   open?.resolve(installed);
// }
// export const cancelInstall = () => api.assistant.cancel();
//
// /** Downloads what is missing, turns the assistant on (settings.assistant.installed) and warms it. Throws the error message. */
// export async function install() {
//   try {
//     await api.assistant.install();
//     await saveAssistant({ installed: true });
//   } catch (e) {
//     throw new Error(message(e));
//   }
//   closeInstall(true);
//   toast('Assistant ready');
//   await refreshStatus();
//   api.assistant.warm().then(refreshStatus, () => {});
// }
//
// /** Settings > Assistant > Delete: stops the server, deletes userData/assistant/ and turns the assistant off. Throws the message. */
// export async function deleteAssistant() {
//   try {
//     await api.assistant.delete();
//     await saveAssistant({ installed: false });
//   } catch (e) {
//     throw new Error(message(e));
//   }
//   refreshStatus();
// }
//
// /** Settings > Assistant > an unused model file's Delete (status().leftovers): removes that file only. Throws the message. */
// export const deleteLeftover = (file) => api.assistant.deleteLeftover(file).catch((e) => { throw new Error(message(e)); });
