'use strict';
// The assistant runtime, pure part: the OpenAI chat stream client (a cloud provider's OpenAI-compatible endpoint, or the eval's
// stub server): /props, the SSE parser and accumulator, the endpoint rule and streamChat. No electron here: src/assistant-main.js
// uses it, test/assistant-runtime.test.mjs tests it.

const auth = (key) => (key ? { Authorization: `Bearer ${key}` } : {});

/** GET /props: a server's model and context window (model_path, default_generation_settings.n_ctx); null when it
 * does not answer. */
async function props(fetch, url, key, ms = 1000) {
  try {
    const res = await fetch(`${url}/props`, { headers: auth(key), signal: AbortSignal.timeout(ms) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Complete server-sent events (LF line ends) → their data: parsed JSON, or the string '[DONE]'. Comments (pings) are skipped. */
function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (data) events.push(data === '[DONE]' ? data : JSON.parse(data));
  }
  return events;
}

/** The tool calls gathered so far and `done`, once: at [DONE] or at the end of the stream (a server may send the usage chunk
 * after the finish_reason one). `done.usage` = {prompt, completion} tokens: the `usage` chunk (stream_options.include_usage),
 * else the last chunk's `timings` (prompt_n + cache_n, predicted_n); none when the server sent neither. `done.searches`: the web
 * searches the provider ran itself (Qwen Cloud's enable_search, assistant/search.js), from usage.x_tools, when there were any. */
function finish(st) {
  if (st.done) return [];
  st.done = true;
  const calls = st.calls.flatMap((c, i) => (c ? [{ type: 'tool_call', id: c.id || `call_${i}`, name: c.name, arguments: c.arguments, ...(c.extra && { extra: c.extra }) }] : []));
  const u = st.usage;
  const t = st.timings;
  const usage = Number.isFinite(u?.prompt_tokens) ? { prompt: u.prompt_tokens, completion: u.completion_tokens || 0 }
    : Number.isFinite(t?.prompt_n) ? { prompt: t.prompt_n + (t.cache_n || 0), completion: t.predicted_n || 0 } : null;
  // docs.qwencloud.com web search names the count usage.x_tools.search.count for this API and x_tools.web_search.count in a sample.
  const searches = Number(u?.x_tools?.search?.count ?? u?.x_tools?.web_search?.count) || 0;
  return [...calls, { type: 'done', finish_reason: st.finish || 'stop', ...(usage && { usage }), ...(searches > 0 && { searches }) }];
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
 * .../v1) takes /chat/completions, a bare server /v1/chat/completions. */
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

module.exports = { props, parseSse, accumulate, chatUrl, streamChat };
