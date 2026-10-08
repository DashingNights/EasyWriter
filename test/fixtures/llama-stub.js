'use strict';
// A stand-in for llama-server (automation plan §13.2) for tests and harnesses; harnesses point settings.assistant.serverUrl at
// it. GET /health answers 503 `healthFailures` times, then 200. With `key`, every other route needs `Authorization: Bearer
// <key>`. GET /props answers `is_sleeping: true` `sleepingProps` times (or until a POST /tokenize wakes it), then false, and
// `default_generation_settings.n_ctx` = `nCtx` and `modalities.vision` = `vision` (false: no image projector). POST
// /v1/chat/completions records the request (its parsed body too) and streams OpenAI chunks every 20 ms from the next `script` entry {reasoning?, text?, tool_calls?: [{name, arguments}], usage?: {prompt, completion}} (none
// left: echoes the last user message), then finish_reason, as llama-server b11433 does a usage chunk (`choices: []`) when the
// request asks stream_options.include_usage, `timings` on the last chunk, and [DONE]. Without `usage` the tokens are estimated
// (4 characters each). stdlib only.
const http = require('http');

const pieces = (text, n = 8) => (text ? String(text).match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) : []);

/** → Promise<{url, port, requests: [{messages, tools, chat_template_kwargs, body, headers, aborted}], tokenized, vision, close()}> */
function start({ script = [], healthFailures = 0, sleepingProps = 0, key = '', nCtx = 32768, vision = true } = {}) {
  const requests = [];
  const stub = { requests, tokenized: 0, vision }; // a harness may change stub.vision
  let failures = healthFailures;
  let sleeping = sleepingProps;
  const server = http.createServer((req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && req.url === '/health') {
      return failures-- > 0 ? json(503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }) : json(200, { status: 'ok' });
    }
    if (key && req.headers.authorization !== `Bearer ${key}`) return json(401, { error: { code: 401, message: 'Invalid API Key', type: 'authentication_error' } });
    if (req.method === 'GET' && req.url === '/v1/models') return json(200, { object: 'list', data: [{ id: 'stub', object: 'model', owned_by: 'llamacpp' }] });
    if (req.method === 'GET' && req.url === '/props') return json(200, { is_sleeping: sleeping-- > 0, total_slots: 1, default_generation_settings: { n_ctx: nCtx }, modalities: { vision: stub.vision, audio: false } });
    if (req.method === 'POST' && req.url === '/tokenize') {
      stub.tokenized++;
      sleeping = 0;
      return req.resume().on('end', () => json(200, { tokens: [6023] }));
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(404, { error: { code: 404, message: 'File Not Found', type: 'not_found_error' } });
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const rec = { messages: body.messages, tools: body.tools, chat_template_kwargs: body.chat_template_kwargs, body, headers: req.headers, aborted: false };
      requests.push(rec);
      const turn = script.length ? script.shift() : { text: String([...(body.messages || [])].reverse().find((m) => m.role === 'user')?.content ?? '') };
      const deltas = [
        ...pieces(turn.reasoning).map((t) => ({ reasoning_content: t })),
        ...pieces(turn.text).map((t) => ({ content: t })),
        ...(turn.tool_calls || []).flatMap(({ name, arguments: args }, index) => {
          const text = typeof args === 'string' ? args : JSON.stringify(args ?? {});
          return [{ tool_calls: [{ index, id: `call_stub_${index}`, type: 'function', function: { name, arguments: '' } }] },
            ...pieces(text, 5).map((a) => ({ tool_calls: [{ index, function: { arguments: a } }] }))];
        }),
      ];
      const head = { id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'stub' };
      const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      // A picture counts as about 1,000 tokens, as a real server counts it, not as its base64 text (that made the eval's context
      // ring read hundreds of thousands of tokens and go red).
      const PIC = /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g;
      const prompt = turn.usage?.prompt ?? Math.ceil(raw.replace(PIC, '').length / 4) + (raw.match(PIC)?.length ?? 0) * 1000;
      const completion = turn.usage?.completion ?? Math.ceil(((turn.reasoning ?? '') + (turn.text ?? '') + JSON.stringify(turn.tool_calls ?? '')).length / 4);
      const timings = { cache_n: Math.floor(prompt / 2), prompt_n: prompt - Math.floor(prompt / 2), prompt_ms: 1, predicted_n: completion, predicted_ms: 1 };
      const last = [{ ...head, choices: [{ index: 0, delta: {}, finish_reason: turn.tool_calls?.length ? 'tool_calls' : 'stop' }] }];
      if (body.stream_options?.include_usage) {
        last.push({ ...head, choices: [], usage: { completion_tokens: completion, prompt_tokens: prompt, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: 0 } } });
      }
      last.at(-1).timings = timings;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const timer = setInterval(() => {
        if (deltas.length) return res.write(chunk(deltas.shift()));
        clearInterval(timer);
        res.end(`${last.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`);
      }, 20);
      res.on('close', () => {
        clearInterval(timer);
        if (!res.writableEnded) rec.aborted = true;
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(Object.assign(stub, {
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
      }));
    });
  });
}

module.exports = { start };
