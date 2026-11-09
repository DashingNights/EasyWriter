import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { props, parseSse, accumulate, chatUrl, streamChat } = require('../src/assistant/runtime.js');
const stub = require('./fixtures/chat-stub.js');

test('parseSse + accumulate: pings skipped, tool calls joined by index, one done', () => {
  const text = ': ping\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"doc_get","arguments":"{\\"x\\""}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"ui_state","arguments":"{}"}},{"index":0,"function":{"arguments":":1}"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]';
  const st = { calls: [], finish: null, done: false };
  const events = parseSse(text).flatMap((ev) => accumulate(st, ev));
  assert.deepEqual(events, [
    { type: 'tool_call', id: 'a', name: 'doc_get', arguments: '{"x":1}' },
    { type: 'tool_call', id: 'b', name: 'ui_state', arguments: '{}' },
    { type: 'done', finish_reason: 'tool_calls' },
  ]);
  assert.throws(() => accumulate({ calls: [] }, { error: { message: 'boom' } }), /boom/);
});

test('accumulate: done waits for [DONE]; usage from the usage chunk, else from the last chunk\'s timings', () => {
  const fin = { choices: [{ delta: {}, finish_reason: 'stop' }] };
  const run = (...chunks) => {
    const st = { calls: [], finish: null, done: false };
    return chunks.flatMap((c) => accumulate(st, c));
  };
  assert.deepEqual(run(fin), []);
  assert.deepEqual(run(fin, { choices: [], usage: { prompt_tokens: 900, completion_tokens: 40 }, timings: { prompt_n: 1, cache_n: 2, predicted_n: 3 } }, '[DONE]'),
    [{ type: 'done', finish_reason: 'stop', usage: { prompt: 900, completion: 40 } }]);
  assert.deepEqual(run({ ...fin, timings: { prompt_n: 100, cache_n: 800, predicted_n: 40 } }, '[DONE]'),
    [{ type: 'done', finish_reason: 'stop', usage: { prompt: 900, completion: 40 } }]);
});

test('streamChat: reasoning, text and a tool call in order, with the bearer key', async () => {
  const s = await stub.start({ key: 'secret', script: [{ reasoning: 'Look at the outline first.', text: 'Reading the draft.', tool_calls: [{ name: 'doc_get', arguments: { format: 'outline' } }], usage: { prompt: 120, completion: 9 } }, { text: 'Hi.', usage: { prompt: 300, completion: 2 } }] });
  try {
    const events = [];
    const body = { messages: [{ role: 'user', content: 'hi' }], stream: true, chat_template_kwargs: { enable_thinking: false } };
    await streamChat(fetch, s.url, 'secret', body, (e) => events.push(e));
    const types = events.map((e) => e.type).filter((t, i, a) => t !== a[i - 1]);
    assert.deepEqual(types, ['reasoning', 'delta', 'tool_call', 'done']);
    const join = (type) => events.filter((e) => e.type === type).map((e) => e.text).join('');
    assert.equal(join('reasoning'), 'Look at the outline first.');
    assert.equal(join('delta'), 'Reading the draft.');
    assert.deepEqual(events.at(-2), { type: 'tool_call', id: 'call_stub_0', name: 'doc_get', arguments: '{"format":"outline"}' });
    assert.deepEqual(events.at(-1), { type: 'done', finish_reason: 'tool_calls', usage: { prompt: 120, completion: 9 } }); // from timings
    assert.equal(s.requests[0].headers.authorization, 'Bearer secret');
    assert.equal(s.requests[0].chat_template_kwargs.enable_thinking, false);
    const second = [];
    await streamChat(fetch, s.url, 'secret', { ...body, stream_options: { include_usage: true } }, (e) => second.push(e));
    assert.deepEqual(second.at(-1), { type: 'done', finish_reason: 'stop', usage: { prompt: 300, completion: 2 } }); // the usage chunk
    await assert.rejects(streamChat(fetch, s.url, 'wrong', body, () => {}), /Invalid API Key/);
  } finally {
    await s.close();
  }
});

test('streamChat: abort → no further events, the server sees the socket close', async () => {
  const s = await stub.start({ script: [{ text: 'x'.repeat(400) }] });
  try {
    const events = [];
    const ac = new AbortController();
    const run = streamChat(fetch, s.url, '', { messages: [], stream: true }, (e) => {
      events.push(e);
      if (events.length === 2) ac.abort();
    }, ac.signal);
    await run;
    // The client is done before the server hears the socket close: wait for that, not for a time (150 ms missed it under load).
    await s.requests[0].closed;
    assert.equal(events.length, 2);
    assert.equal(s.requests[0].aborted, true);
  } finally {
    await s.close();
  }
});

test('chatUrl: a bare server takes /v1/chat/completions, a versioned base (Google AI, OpenAI) /chat/completions', () => {
  assert.equal(chatUrl('http://127.0.0.1:8765'), 'http://127.0.0.1:8765/v1/chat/completions');
  assert.equal(chatUrl('https://generativelanguage.googleapis.com/v1beta/openai'), 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(chatUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
});

test('accumulate: a tool call keeps its extra_content (Gemini thought signature) for the reply to send back', () => {
  const st = { calls: [], finish: null, done: false };
  const extra = { google: { thought_signature: 'sig' } };
  accumulate(st, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'doc_get', arguments: '{}' }, extra_content: extra }] } }] });
  const [call] = accumulate(st, '[DONE]');
  assert.deepEqual(call, { type: 'tool_call', id: 'c1', name: 'doc_get', arguments: '{}', extra });
});

test('accumulate: two calls with their own ids at one index stay two calls (Google AI parallel calls)', () => {
  const st = { calls: [], finish: null, done: false };
  accumulate(st, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'board_get', arguments: '{"path":[6]}' } }] } }] });
  accumulate(st, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'b', function: { name: 'board_get', arguments: '{"path":[8]}' } }] } }] });
  const calls = accumulate(st, '[DONE]').filter((e) => e.type === 'tool_call');
  assert.deepEqual(calls.map((c) => [c.id, c.arguments]), [['a', '{"path":[6]}'], ['b', '{"path":[8]}']]);
});

test('streamChat: Qwen Cloud\'s Free quota only stop reads as the used-up free quota', async () => {
  const stop = (json) => async () => ({ ok: false, status: 403, json: async () => json });
  for (const json of [{ error: { code: 'AllocationQuota.FreeTierOnly', message: 'The free tier of the model has been exhausted.' } },
    { code: 'AllocationQuota.FreeTierOnly', message: 'The free tier of the model has been exhausted.' }]) {
    await assert.rejects(streamChat(stop(json), 'https://maas.qwencloudapi.com/compatible-mode/v1', 'k', {}, () => {}), /free quota of this model is used up/);
  }
});
