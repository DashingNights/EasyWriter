import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// LOCAL LLM (commented out 2026-10-07): MAX_STEP, SAMPLING, sampling, thinkingLimits, pickBackend, launchArgs, waitHealthy, isSleeping, wake.
const { props, parseSse, accumulate, chatUrl, streamChat } = require('../src/assistant/runtime.js');
const stub = require('./fixtures/llama-stub.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// test('pickBackend: NVIDIA anywhere → cuda, AMD / Intel → vulkan, none → cpu; an override wins', () => {
//   assert.equal(pickBackend([{ vendorId: 0x8086 }, { vendorId: 0x10de }]), 'cuda');
//   assert.equal(pickBackend([{ vendorId: 0x1002 }]), 'vulkan');
//   assert.equal(pickBackend([{ vendorId: 0x8086 }], 'auto'), 'vulkan');
//   assert.equal(pickBackend([]), 'cpu');
//   assert.equal(pickBackend([{ vendorId: 0x10de }], 'cpu'), 'cpu');
// });

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// test('sampling: presence_penalty 0 on requests with tools, 1.5 without; the rest of the preset kept', () => {
//   assert.deepEqual(sampling(false, true), { ...SAMPLING.qwen.fast, presence_penalty: 0 });
//   assert.deepEqual(sampling(true, true), { ...SAMPLING.qwen.think, presence_penalty: 0 });
//   assert.equal(sampling(false, false).presence_penalty, 1.5);
//   assert.equal(sampling(true, false).presence_penalty, 1.5);
//   assert.equal(sampling(false, true).max_tokens, 3072);
//   assert.equal(SAMPLING.fast, SAMPLING.qwen.fast); // the eval's DAF_EVAL_SAMPLING patches SAMPLING.fast / .think
// });

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// test('sampling: Gemma\'s card preset (1.0, 0.95, 64) in both modes, the same presence_penalty rule; Qwen\'s unchanged', () => {
//   const card = { temperature: 1.0, top_p: 0.95, top_k: 64 };
//   assert.deepEqual(sampling(false, false, 'gemma'), { ...card, presence_penalty: 1.5, max_tokens: 3072 });
//   assert.deepEqual(sampling(true, false, 'gemma'), { ...card, presence_penalty: 1.5 });
//   assert.equal(sampling(false, true, 'gemma').presence_penalty, 0);
//   assert.equal(sampling(true, true, 'gemma').presence_penalty, 0);
//   assert.deepEqual(sampling(false, false, 'qwen'), { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, max_tokens: 3072 });
//   assert.deepEqual(sampling(true, true, 'qwen'), sampling(true, true));
// });

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// test('thinkingLimits: per-request budget by effort (Auto = Medium; Xhigh 16,384, Max 32,768), max_tokens = budget + 2,048, cut to fit the context', () => {
//   const at = thinkingLimits;
//   assert.deepEqual(at('low', 16384, 0), { reasoning_budget_tokens: 1024, max_tokens: 3072 });
//   assert.deepEqual(at('medium', 16384, 0), { reasoning_budget_tokens: 4096, max_tokens: 6144 });
//   assert.deepEqual(at('auto', 16384, 0), { reasoning_budget_tokens: 4096, max_tokens: 6144 });
//   assert.deepEqual(at('high', 16384, 6000), { reasoning_budget_tokens: 8192, max_tokens: 10240 });
//   assert.deepEqual(at('high', 16384, 9000), { reasoning_budget_tokens: 5336, max_tokens: 7384 }); // 16384 - 9000 - 2048
//   assert.deepEqual(at('high', 16384, 15000), { reasoning_budget_tokens: 0, max_tokens: 2048 });
//   assert.deepEqual(at('high', null, undefined), { reasoning_budget_tokens: 8192, max_tokens: 10240 }); // unknown n_ctx: 16384
//   assert.deepEqual(at('constructor', 16384, 'x'), { reasoning_budget_tokens: 4096, max_tokens: 6144 }); // unknown effort: Auto
//   assert.deepEqual(at('xhigh', 32768, 0), { reasoning_budget_tokens: 16384, max_tokens: 18432 });
//   assert.deepEqual(at('max', 32768, 0), { reasoning_budget_tokens: 30720, max_tokens: 32768 }); // 32768 - 2048: cut to fit
// });

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// test('launchArgs: the §13.2 line, degrade steps cumulative, never q4_0', () => {
//   const c = { model: 'm.gguf', mmproj: 'p.gguf', port: 4321, key: 'k' };
//   const flag = (a, f) => a[a.indexOf(f) + 1];
//   const base = launchArgs(c, 0);
//   assert.deepEqual(base, ['-m', 'm.gguf', '--mmproj', 'p.gguf', '-ngl', '99', '-c', '16384', '-fa', 'on', '-np', '1', '-b', '2048', '-ub', '512',
//     '--cache-reuse', '256', '--cache-ram', '0', '--jinja', '--no-webui', '--host', '127.0.0.1', '--port', '4321', '--api-key', 'k',
//     '--reasoning-budget', '4096', '--reasoning-budget-message', 'Thinking budget reached. Give your best answer now.',
//     '--no-mmproj-offload']);
//   assert.equal(flag(launchArgs(c, 1), '--cache-type-k'), 'q8_0');
//   assert.equal(flag(launchArgs(c, 1), '-ngl'), '99');
//   const last = launchArgs(c, MAX_STEP);
//   assert.equal(MAX_STEP, 2);
//   assert.deepEqual([flag(last, '-ngl'), flag(last, '-c'), flag(last, '--cache-type-v')], ['24', '16384', 'q8_0']);
//   assert.ok(last.includes('--no-mmproj-offload') && !last.includes('q4_0'));
//   assert.equal(flag(launchArgs({ ...c, sleepSeconds: 600 }, 0), '--sleep-idle-seconds'), '600');
//   assert.ok(!base.includes('--sleep-idle-seconds'));
// });

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// test('launchArgs: Defiant Fable\'s output matrix on the CPU under 10 GB (unknown = 8 GB), never for Qwen3.5-9B; MTP adds its draft', () => {
//   const c = { model: 'm.gguf', mmproj: 'p.gguf', port: 4321, key: 'k' };
//   const flag = (a, f) => a[a.indexOf(f) + 1];
//   const ot = flag(launchArgs({ ...c, fable: true, gpuMiB: 8188 }), '-ot');
//   assert.equal(ot, '^output\\.weight$=CPU');
//   const re = new RegExp(ot.split('=')[0]); // llama.cpp regex_searches tensor names: only the output matrix
//   assert.ok(re.test('output.weight') && !re.test('blk.3.attn_output.weight') && !re.test('output_norm.weight'));
//   assert.equal(flag(launchArgs({ ...c, fable: true }), '-ot'), ot);
//   assert.ok(!launchArgs({ ...c, fable: true, gpuMiB: 12282 }).includes('-ot'));
//   // Context: 32K at 10 GB or more of GPU memory, 16K below or unknown.
//   assert.equal(flag(launchArgs({ ...c, gpuMiB: 12282 }), '-c'), '32768');
//   assert.equal(flag(launchArgs({ ...c, gpuMiB: 8188 }), '-c'), '16384');
//   assert.equal(flag(launchArgs(c), '-c'), '16384');
//   assert.ok(!launchArgs({ ...c, gpuMiB: 8188 }).includes('-ot'));
//   const mtp = launchArgs({ ...c, fable: true, mtp: true, gpuMiB: 12282 });
//   assert.deepEqual(mtp.slice(mtp.indexOf('--spec-type'), mtp.indexOf('--spec-type') + 4), ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '2']);
//   assert.ok(!launchArgs({ ...c, fable: true, gpuMiB: 12282 }).includes('--spec-type') && !launchArgs(c).includes('--spec-type'));
//   assert.ok(!mtp.includes('-md'));
// });

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// test('launchArgs: Qwen3.5-9B with MTP (wave 2b) runs as Fable\'s MTP file: the head inside the file, no draft file, no -ot', () => {
//   const c = { model: 'Qwen3.5-9B-MTP-Q4_K_M.gguf', mmproj: 'Qwen3.5-9B-mmproj-BF16.gguf', port: 4321, key: 'k' };
//   for (const gpuMiB of [undefined, 8188, 12282]) {
//     const base = launchArgs({ ...c, gpuMiB });
//     const mtp = launchArgs({ ...c, gpuMiB, mtp: true });
//     assert.deepEqual(mtp.slice(0, base.length), base);
//     assert.deepEqual(mtp.slice(base.length), ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '2']);
//     assert.ok(!mtp.includes('-ot') && !mtp.includes('-md') && !mtp.includes('--chat-template-file'));
//   }
//   // The projector shared with the regular file, on the CPU at 8 GB as before.
//   assert.ok(launchArgs({ ...c, mtp: true, gpuMiB: 8188 }).includes('--no-mmproj-offload'));
// });

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// test('launchArgs: Gemma keeps its projector on the GPU on every card, never -ot; MTP names its draft file', () => {
//   const c = { model: 'g.gguf', mmproj: 'gp.gguf', port: 4321, key: 'k', gemma: true };
//   const base = launchArgs(c);
//   assert.deepEqual(base, ['-m', 'g.gguf', '--mmproj', 'gp.gguf', '-ngl', '99', '-c', '16384', '-fa', 'on', '-np', '1', '-b', '2048', '-ub', '512',
//     '--cache-reuse', '256', '--cache-ram', '0', '--jinja', '--no-webui', '--host', '127.0.0.1', '--port', '4321', '--api-key', 'k',
//     '--reasoning-budget', '4096', '--reasoning-budget-message', 'Thinking budget reached. Give your best answer now.']);
//   for (const gpuMiB of [undefined, 8188, 12282]) {
//     const a = launchArgs({ ...c, gpuMiB }, 2);
//     assert.ok(!a.includes('--no-mmproj-offload') && !a.includes('-ot'));
//   }
//   const mtp = launchArgs({ ...c, mtp: true, draft: 'd.gguf' });
//   assert.deepEqual(mtp.slice(base.length), ['--spec-type', 'draft-mtp', '-md', 'd.gguf', '--spec-draft-n-max', '2']);
//   // Qwen and Fable: the projector on the GPU from 10 GB (wave 2, Fable's -ot threshold), on the CPU below it or when unknown.
//   for (const m of [{}, { fable: true }]) {
//     assert.ok(!launchArgs({ ...c, gemma: false, ...m, gpuMiB: 12282 }).includes('--no-mmproj-offload'));
//     assert.ok(!launchArgs({ ...c, gemma: false, ...m, gpuMiB: 10000 }).includes('--no-mmproj-offload'));
//     for (const gpuMiB of [8188, 9999, undefined]) assert.ok(launchArgs({ ...c, gemma: false, ...m, gpuMiB }).includes('--no-mmproj-offload'), String(gpuMiB));
//   }
//   // Stock Gemma runs the template inside its GGUF: no --chat-template-file, with or without MTP.
//   assert.ok(!base.includes('--chat-template-file') && !mtp.includes('--chat-template-file'));
// });

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

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// test('waitHealthy waits through 503 for 200, and stops when the process exits', async () => {
//   const s = await stub.start({ healthFailures: 2 });
//   try {
//     await waitHealthy(fetch, s.url, () => false, 5000);
//     await assert.rejects(waitHealthy(fetch, 'http://127.0.0.1:9', () => true, 5000), /exited/);
//   } finally {
//     await s.close();
//   }
// });

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// test('isSleeping reads /props (true, then false); props gives n_ctx; wake posts /tokenize', async () => {
//   const s = await stub.start({ key: 'k', sleepingProps: 1, nCtx: 16384 });
//   try {
//     assert.equal(await isSleeping(fetch, s.url, 'k'), true);
//     assert.equal((await props(fetch, s.url, 'k')).default_generation_settings.n_ctx, 16384);
//     assert.equal(await isSleeping(fetch, s.url, 'k'), false);
//     assert.equal(await isSleeping(fetch, s.url, 'wrong'), null);
//     await wake(fetch, s.url, 'k');
//     assert.equal(s.tokenized, 1);
//   } finally {
//     await s.close();
//   }
// });

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
    await wait(150);
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
