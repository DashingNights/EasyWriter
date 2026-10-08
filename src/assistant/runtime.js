'use strict';
// The assistant runtime, pure part: the OpenAI chat stream client (Google AI's OpenAI-compatible endpoint, or the eval's
// stub server): /props, the SSE parser and accumulator, the endpoint rule and streamChat. No electron here: src/assistant-main.js
// uses it, test/assistant-runtime.test.mjs tests it. The llama-server parts (sampling presets, thinking budgets, backend choice,
// launch line, health wait, sleep and wake) are commented out below (local models are off).

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// // Card presets per model family. qwen (Qwen3.5-9B and Defiant Fable): "Best Practices" in the README of unsloth/Qwen3.5-9B-GGUF
// // at the pinned commit 3885219, read 2026-10-06, the same as Qwen/Qwen3.5-4B's: instruct (non-thinking) general tasks, thinking
// // general tasks. gemma (Gemma 4 12B): google/gemma-4-12B-it's card at 707f0a3 (temp 1, top_p 0.95, top_k 64), one preset for
// // both modes. presence_penalty 1.5 is ours (see sampling()); max_tokens are ours: 3,072 without thinking; with
// // thinking, thinkingLimits() below.
// const SAMPLING = {
//   qwen: {
//     fast: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, max_tokens: 3072 },
//     think: { temperature: 1.0, top_p: 0.95, top_k: 20, presence_penalty: 1.5 },
//   },
//   gemma: {
//     fast: { temperature: 1.0, top_p: 0.95, top_k: 64, presence_penalty: 1.5, max_tokens: 3072 },
//     think: { temperature: 1.0, top_p: 0.95, top_k: 64, presence_penalty: 1.5 },
//   },
// };
// // ponytail: aliases for test/assistant-eval/run.js, which patches SAMPLING.fast / .think; drop them once it patches the families.
// SAMPLING.fast = SAMPLING.qwen.fast;
// SAMPLING.think = SAMPLING.qwen.think;
//
// /** The sampling preset of a request (`think`: the thinking one) that carries tools (`tools`) or not, for model `family` ('qwen'
//  * default, 'gemma'). A request with tools sends presence_penalty 0: llama.cpp penalises the last 64 tokens of the sequence, prompt
//  * included, and those hold the ids and labels of the tool result or attachment that the call must copy (plan
//  * assistant-reliability.md, wave 1). */
// const sampling = (think, tools, family = 'qwen') => ({
//   ...(family === 'gemma' ? SAMPLING.gemma : SAMPLING.qwen)[think ? 'think' : 'fast'],
//   ...(tools && { presence_penalty: 0 }),
// });
//
// // Thinking effort (settings.assistant.thinking, user decision 2026-10-06) → tokens of thinking; Auto thinks at Medium. b11433 takes
// // the budget per request (tools/server/server-common.cpp: `json_value(body, "reasoning_budget_tokens", json_value(body,
// // "thinking_budget_tokens", -1))`), so a change needs no restart.
// const BUDGETS = { auto: 4096, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 };
// const ANSWER = 2048; // tokens left for the answer after the thinking
//
// /** {reasoning_budget_tokens, max_tokens} of a thinking request at `effort`: the budget is cut so the prompt (≈ `used`, the last
//  * request's tokens) + thinking + answer fit the server's context `ctx` (High at 16 K leaves 6,144 for the prompt). */
// function thinkingLimits(effort, ctx, used) {
//   const want = BUDGETS[effort] > 0 ? BUDGETS[effort] : BUDGETS.auto;
//   const budget = Math.max(0, Math.min(want, (ctx > 0 ? ctx : 16384) - Math.max(0, Number(used) || 0) - ANSWER));
//   return { reasoning_budget_tokens: budget, max_tokens: budget + ANSWER };
// }
//
// /** app.getGPUInfo('basic').gpuDevice → 'cuda' (NVIDIA anywhere) | 'vulkan' (AMD, Intel) | 'cpu'; an override other than 'auto' wins. */
// function pickBackend(gpuDevices = [], override = 'auto') {
//   if (['cuda', 'vulkan', 'cpu'].includes(override)) return override;
//   const ids = (gpuDevices || []).map((d) => d?.vendorId);
//   if (ids.includes(0x10de)) return 'cuda';
//   return ids.some((id) => id === 0x1002 || id === 0x8086) ? 'vulkan' : 'cpu';
// }
//
// // The projector and image encoder run on the CPU under 10 GB of GPU memory or when it is unknown (user decision 2026-10-06: frees
// // ≈ 1.1–1.4 GB for the 9B on the 8 GB baseline; only pictures get slower), on the GPU from 10 GB (wave 2 of the reliability plan,
// // the threshold of Fable's -ot), and Gemma's always on the GPU: 175 MB. The §13.2 degrade ladder at 16 K, applied cumulatively up to settings.assistant.step: 1 q8_0 KV
// // (≈ 0.23 GB), 2 -ngl 24, the first 9 of 32 layers on the CPU (≈ 1.2 GB, the slowest).
// const MAX_STEP = 2;
//
// /** The local server's context (-c) on a GPU with `gpuMiB` of memory (user decision 2026-10-07): 32K at 10 GB or more, else 16K. */
// const contextFor = (gpuMiB) => (gpuMiB >= 10000 ? 32768 : 16384);
//
// /** The §13.2 llama-server arguments for {model, mmproj, port, key, sleepSeconds?, fable?, gemma?, mtp?, draft?, gpuMiB?} at degrade
//  * `step` (never a q4_0 KV cache). `fable`: the Defiant Fable model; `gemma`: the Gemma 4 model; `mtp`: MTP on (Qwen3.5-9B and
//  * Fable: their MTP files; Gemma: `draft`, its separate MTP head file); `gpuMiB`: the GPU's total memory (nvidia-smi), unknown = 8 GB. */
// function launchArgs(c, step = 0) {
//   // Context (user decision 2026-10-07): 32K on a card with 10 GB or more (Qwen3.5-9B at 32K is about 0.5 GB more than at 16K,
//   // its hybrid attention keeps the KV small; Gemma 12B with MTP about 9.2 GB in all), 16K below or when the memory is unknown.
//   const ctx = String(contextFor(c.gpuMiB));
//   const a = ['-m', c.model, '--mmproj', c.mmproj, '-ngl', '99', '-c', ctx, '-fa', 'on', '-np', '1', '-b', '2048', '-ub', '512',
//     '--cache-reuse', '256', '--cache-ram', '0', '--jinja', '--no-webui', '--host', '127.0.0.1', '--port', String(c.port), '--api-key', c.key,
//     // Thinking stops after the budget and the model answers (§13.16). Each thinking request sends its own budget (thinkingLimits),
//     // which replaces this default; the message stays the server's.
//     '--reasoning-budget', '4096', '--reasoning-budget-message', 'Thinking budget reached. Give your best answer now.'];
//   if (!c.gemma && !(c.gpuMiB >= 10000)) a.push('--no-mmproj-offload');
//   const set = (flag, value) => { a[a.indexOf(flag) + 1] = value; };
//   if (step >= 1) a.push('--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0');
//   if (step >= 2) set('-ngl', '24');
//   // Defiant Fable keeps its output matrix at 16 bits: ≈ 8.3 GB on the GPU at this line, ≈ 6.3 GB with that matrix on the CPU (slower,
//   // ≈ 20 tokens/s or less). So under ≈ 10 GB of GPU memory it goes to the CPU (user decision 2026-10-06, §13.2 tiers). Anchored:
//   // llama.cpp regex_searches the names, and a bare output\.weight would also catch every blk.N.attn_output.weight.
//   if (c.fable && !(c.gpuMiB >= 10000)) a.push('-ot', '^output\\.weight$=CPU');
//   // MTP drafts 2 tokens per step (Fable's card: "predict 2 tokens"). Qwen's and Fable's heads are inside their MTP files (wave 2b:
//   // unsloth/Qwen3.5-9B-MTP-GGUF); Gemma's is the draft file.
//   if (c.mtp) a.push('--spec-type', 'draft-mtp', ...(c.draft ? ['-md', c.draft] : []), '--spec-draft-n-max', '2');
//   // Tier 1 idle (§13.2 Warm-up and idle): llama-server's own sleep frees the model, KV cache and projector and keeps the process;
//   // the next request reloads them. Without it (0) the flag stays at its default, off (0 itself is rejected).
//   if (c.sleepSeconds > 0) a.push('--sleep-idle-seconds', String(Math.round(c.sleepSeconds)));
//   return a;
// }
//
// /** Polls `${url}/health` until 200 (llama-server answers 503 while the model loads); throws on exit or after `ms`. */
// async function waitHealthy(fetch, url, exited = () => false, ms = 180000) {
//   for (const end = Date.now() + ms; Date.now() < end && !exited();) {
//     try {
//       const res = await fetch(`${url}/health`);
//       res.body?.cancel().catch(() => {});
//       if (res.ok) return;
//     } catch {}
//     await new Promise((r) => setTimeout(r, 250));
//   }
//   throw new Error(exited() ? 'exited' : `llama-server did not start within ${Math.round(ms / 1000)} s`);
// }
//

const auth = (key) => (key ? { Authorization: `Bearer ${key}` } : {});

/** GET /props (llama-server answers it without waking or resetting its idle timer: is_sleeping, default_generation_settings.n_ctx);
 * null when it does not answer. */
async function props(fetch, url, key, ms = 1000) {
  try {
    const res = await fetch(`${url}/props`, { headers: auth(key), signal: AbortSignal.timeout(ms) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// /** /props is_sleeping; null when the server does not answer. */
// const isSleeping = async (fetch, url, key, ms) => {
//   const p = await props(fetch, url, key, ms);
//   return p ? !!p.is_sleeping : null;
// };
//
// /** POST /tokenize wakes a sleeping server without running a task; resolves once the model is loaded again. */
// async function wake(fetch, url, key) {
//   const res = await fetch(`${url}/tokenize`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(key) }, body: '{"content":"hi"}' });
//   res.body?.cancel().catch(() => {});
//   if (!res.ok) throw new Error(`llama-server answered HTTP ${res.status}`);
// }
//

/** Complete server-sent events (LF line ends) → their data: parsed JSON, or the string '[DONE]'. Comments (pings) are skipped. */
function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (data) events.push(data === '[DONE]' ? data : JSON.parse(data));
  }
  return events;
}

/** The tool calls gathered so far and `done`, once: at [DONE] or at the end of the stream (llama-server sends the usage chunk
 * after the finish_reason one). `done.usage` = {prompt, completion} tokens: the `usage` chunk (stream_options.include_usage),
 * else the last chunk's `timings` (prompt_n + cache_n, predicted_n); none when the server sent neither. */
function finish(st) {
  if (st.done) return [];
  st.done = true;
  const calls = st.calls.flatMap((c, i) => (c ? [{ type: 'tool_call', id: c.id || `call_${i}`, name: c.name, arguments: c.arguments, ...(c.extra && { extra: c.extra }) }] : []));
  const u = st.usage;
  const t = st.timings;
  const usage = Number.isFinite(u?.prompt_tokens) ? { prompt: u.prompt_tokens, completion: u.completion_tokens || 0 }
    : Number.isFinite(t?.prompt_n) ? { prompt: t.prompt_n + (t.cache_n || 0), completion: t.predicted_n || 0 } : null;
  return [...calls, { type: 'done', finish_reason: st.finish || 'stop', ...(usage && { usage }) }];
}

const FREE_QUOTA_USED = 'The free quota of this model is used up. Pick another model in the chat panel.';

/** One parsed chunk of an OpenAI chat stream → events: content → delta, reasoning_content → reasoning, tool_calls joined by index. */
function accumulate(st, chunk) {
  if (st.done) return [];
  if (chunk === '[DONE]') return finish(st);
  if (chunk?.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
  if (chunk?.usage) st.usage = chunk.usage;
  if (chunk?.timings) st.timings = chunk.timings;
  const choice = chunk?.choices?.[0];
  if (!choice) return [];
  const d = choice.delta || {};
  const out = [];
  if (d.reasoning_content) out.push({ type: 'reasoning', text: d.reasoning_content });
  if (d.content) out.push({ type: 'delta', text: d.content });
  for (const t of d.tool_calls || []) {
    // A new id at a taken index is a call of its own (Google AI sends parallel calls whole, each at index 0): it gets the next
    // index, so two calls never run together as one (2026-10-07: "{...}{...}" arguments).
    let at = t.index ?? 0;
    if (t.id && st.calls[at]?.id && st.calls[at].id !== t.id) {
      at = st.calls.findIndex((c) => c?.id === t.id);
      if (at < 0) at = st.calls.length;
      st.remap = { ...st.remap, [t.index ?? 0]: at }; // its later chunks (no id) follow it
    } else if (!t.id && st.remap?.[at] !== undefined) at = st.remap[at];
    const c = (st.calls[at] ??= { id: '', name: '', arguments: '' });
    if (t.id) c.id = t.id;
    if (t.function?.name) c.name = t.function.name;
    if (t.function?.arguments) c.arguments += t.function.arguments;
    if (t.extra_content) c.extra = t.extra_content; // Gemini's thought signature (Google AI), sent back with the call
  }
  if (choice.finish_reason) st.finish = choice.finish_reason;
  return out;
}

/** The chat completions endpoint of base `url`: a base that already ends in an API version (Google AI's .../v1beta/openai, a
 * .../v1) takes /chat/completions, a bare server (llama-server) /v1/chat/completions. */
const chatUrl = (url) => (/\/v\d+\w*(\/openai)?$/.test(url) ? `${url}/chat/completions` : `${url}/v1/chat/completions`);

/** POSTs `body` to chatUrl(url) and emits its events; after `signal` aborts nothing more is emitted. */
async function streamChat(fetch, url, key, body, emit, signal) {
  const send = (e) => { if (!signal?.aborted) emit(e); };
  try {
    const res = await fetch(chatUrl(url), {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', ...auth(key) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const err = (Array.isArray(json) ? json[0] : json)?.error ?? json; // Google AI answers errors as a one-item array
      // Qwen Cloud with Free quota only on: 403 AllocationQuota.FreeTierOnly once the model's free quota is used up.
      if (/FreeTierOnly/.test(`${err?.code} ${err?.message}`)) throw new Error(FREE_QUOTA_USED);
      throw new Error(err?.message || `The server answered HTTP ${res.status}`);
    }
    const st = { calls: [], finish: null, done: false };
    const take = (text) => { for (const ev of parseSse(text)) for (const e of accumulate(st, ev)) send(e); };
    const decoder = new TextDecoder();
    let buf = '';
    for await (const bytes of res.body) {
      buf = (buf + decoder.decode(bytes, { stream: true })).replace(/\r\n/g, '\n');
      const cut = buf.lastIndexOf('\n\n');
      if (cut < 0) continue;
      take(buf.slice(0, cut));
      buf = buf.slice(cut + 2);
    }
    take(buf);
    for (const e of finish(st)) send(e);
  } catch (e) {
    if (!signal?.aborted) throw e;
  }
}

// LOCAL LLM (commented out): SAMPLING, sampling, thinkingLimits, MAX_STEP, pickBackend, contextFor, launchArgs, waitHealthy, isSleeping, wake.
module.exports = { props, parseSse, accumulate, chatUrl, streamChat };
