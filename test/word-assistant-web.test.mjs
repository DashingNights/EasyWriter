import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { byId, CATALOGUE, MODEL_DEFS } from '../src/app/commands/catalogue.mjs';
import { CORE, MAX_TOOL, VIEW_SETS, WEB } from '../src/app/commands/tool-sets.mjs';
import { toolsFor } from '../src/app/commands/tools-schema.mjs';
import { mayRead, pageAnswer, searchAnswer, TEXT_CHARS, WEB_NOTE } from '../src/app/commands/web.mjs';
import { RULES, systemPrompt, WEB_RULE } from '../src/app/assistant/prompts.mjs';

// assistant-web (docs/plans/word/briefs/assistant-web.md): the app's own web tools for every provider, and the providers' own search
// as a setting. No live provider turn and no key: argument lists, sample stream lines and pure answer shaping.
const require = createRequire(import.meta.url);
const { claudeArgs, codexArgs, parseClaude, parseCodex } = require('../src/assistant/cli.js');
const { accumulate } = require('../src/assistant/runtime.js');
const { providerSearch, searchFields } = require('../src/assistant/search.js');

const link = { command: 'C:\\App\\EasyWriter.exe', args: ['C:\\App\\bin\\easywriter-agent.js'] };
const after = (args, flag) => args[args.indexOf(flag) + 1];
const dashC = (args) => args.filter((_, i) => args[i - 1] === '-c');
const parse = (fn, lines) => {
  const st = {};
  return lines.flatMap((l) => fn(st, JSON.parse(l)));
};

test('Claude Code: WebSearch and WebFetch only while the setting is on, allowed beside the app server', () => {
  const on = claudeArgs({ link, search: true });
  assert.deepEqual(after(on, '--tools').split(','), ['WebSearch', 'WebFetch']);
  assert.deepEqual(after(on, '--allowedTools').split(','), ['mcp__easywriter', 'WebSearch', 'WebFetch']);
  const off = claudeArgs({ link });
  assert.equal(after(off, '--tools'), '');
  assert.equal(after(off, '--allowedTools'), 'mcp__easywriter');
});

test('Codex: web search live while the setting is on, disabled otherwise, resumed runs too', () => {
  assert.ok(dashC(codexArgs({ link, search: true })).includes('web_search="live"'));
  assert.ok(dashC(codexArgs({ link, search: true, resume: 't-1' })).includes('web_search="live"'));
  const off = dashC(codexArgs({ link }));
  assert.ok(off.includes('web_search="disabled"') && !off.some((c) => c === 'web_search="live"'));
});

test('the setting: off by default, on only for a provider with its own search; Qwen Cloud gets enable_search', () => {
  for (const provider of ['claude', 'codex', 'qwen']) {
    assert.equal(providerSearch({ provider, providerSearch: true }), true, provider);
    assert.equal(providerSearch({ provider }), false, provider);
  }
  for (const provider of ['google', 'deepseek', 'none', undefined]) assert.equal(providerSearch({ provider, providerSearch: true }), false, provider);
  assert.deepEqual(searchFields({ provider: 'qwen', providerSearch: true }), { enable_search: true });
  assert.deepEqual(searchFields({ provider: 'qwen' }), {});
  assert.deepEqual(searchFields({ provider: 'google', providerSearch: true }), {});
});

// Claude Code's own tools stream as tool_use blocks named WebSearch and WebFetch, their results as tool_result text.
test('parseClaude: its own web search and fetch become tool steps', () => {
  const events = parse(parseClaude, [
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_w","name":"WebSearch","input":{"query":"sea otter diet"}}]},"session_id":"s"}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_w","content":"Web search results for query: \\"sea otter diet\\""}]},"session_id":"s"}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_f","name":"WebFetch","input":{"url":"https://example.org/otters","prompt":"diet"}}]},"session_id":"s"}',
  ]);
  assert.deepEqual(events, [
    { type: 'tool_start', id: 'toolu_w', name: 'WebSearch', args: { query: 'sea otter diet' } },
    { type: 'tool_end', id: 'toolu_w', name: 'WebSearch', ok: true, result: 'Web search results for query: "sea otter diet"' },
    { type: 'tool_start', id: 'toolu_f', name: 'WebFetch', args: { url: 'https://example.org/otters', prompt: 'diet' } },
  ]);
});

// codex exec --json web_search items (exec_events.rs WebSearchItem {id, query, action}); one may start before its query is known.
test('parseCodex: a web_search item is one WebSearch step when it completes', () => {
  const events = parse(parseCodex, [
    '{"type":"item.started","item":{"id":"ws_1","type":"web_search","query":"","action":{"type":"other"}}}',
    '{"type":"item.completed","item":{"id":"ws_1","type":"web_search","query":"sea otter diet","action":{"type":"search","query":"sea otter diet"}}}',
    '{"type":"item.completed","item":{"id":"ws_2","type":"web_search","query":"","action":{"type":"open_page","url":"https://example.org/otters"}}}',
  ]);
  assert.deepEqual(events, [
    { type: 'tool_start', id: 'ws_1', name: 'WebSearch', args: { query: 'sea otter diet', action: { type: 'search', query: 'sea otter diet' } } },
    { type: 'tool_end', id: 'ws_1', name: 'WebSearch', ok: true, result: 'sea otter diet' },
    { type: 'tool_start', id: 'ws_2', name: 'WebSearch', args: { query: '', action: { type: 'open_page', url: 'https://example.org/otters' } } },
    { type: 'tool_end', id: 'ws_2', name: 'WebSearch', ok: true, result: '' },
  ]);
});

// Qwen Cloud's OpenAI-compatible stream gives no sources, only a count in the usage (docs.qwencloud.com web search).
test('accumulate: the usage chunk\'s search count rides on done; none without searches', () => {
  const st = { calls: [], finish: null, done: false };
  accumulate(st, { choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] });
  accumulate(st, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, x_tools: { search: { count: 2 } } } });
  assert.deepEqual(accumulate(st, '[DONE]'), [{ type: 'done', finish_reason: 'stop', usage: { prompt: 10, completion: 2 }, searches: 2 }]);
  const plain = { calls: [], finish: null, done: false };
  accumulate(plain, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  assert.ok(!('searches' in accumulate(plain, '[DONE]')[0]));
});

test('browser.read answers: marked as web content first, cut with a way to read on, links in the first part only', () => {
  const text = 'a'.repeat(TEXT_CHARS + 120);
  const page = { title: 'Otters', url: 'https://example.org/otters', text, links: [{ text: 'Diet', url: 'https://example.org/diet' }, { text: 'Run me', url: 'javascript:alert(1)' }, { text: '', url: 'https://x.org' }] };
  const first = pageAnswer('t1', page);
  assert.deepEqual(Object.keys(first).slice(0, 2), ['source', 'note']);
  assert.equal(first.source, 'web');
  assert.equal(first.note, WEB_NOTE);
  assert.equal(first.text.length, TEXT_CHARS);
  assert.match(first.more, /^120 more characters\. Read on with browser_read \{"tab": "t1", "from": 5000\}\.$/);
  assert.deepEqual(first.links, [{ text: 'Diet', url: 'https://example.org/diet' }]);
  const next = pageAnswer('t1', page, TEXT_CHARS);
  assert.equal(next.text.length, 120);
  assert.ok(!('more' in next) && !('links' in next));
  // What the page sent is untrusted: wrong types and non-web URLs come out empty.
  const odd = pageAnswer('t2', { title: 5, url: 'file:///C:/secret', text: null, links: 'x' });
  assert.equal(odd.title, '');
  assert.equal(odd.url, '');
  assert.equal(odd.text, '');
  assert.deepEqual(odd.links, []);
});

test('web.search answers: marked, results kept only with a title and a web URL; none says why it may be empty', () => {
  const a = searchAnswer('otters', { tab: 't', title: 'otters - Search', results: [
    { title: 'Sea otter', url: 'https://example.org/otter', snippet: 'Sea otters eat urchins.' }, { title: '', url: 'https://x.org' }, { title: 'Bad', url: 'ftp://x' }] });
  assert.equal(a.source, 'web');
  assert.equal(a.note, WEB_NOTE);
  assert.deepEqual(a.results, [{ title: 'Sea otter', url: 'https://example.org/otter', snippet: 'Sea otters eat urchins.' }]);
  assert.ok(!('empty' in a));
  const none = searchAnswer('otters', { tab: 't', title: 'Before you continue', results: [] });
  assert.deepEqual(none.results, []);
  assert.match(none.empty, /^The search page "Before you continue" showed no results\./);
});

// The brief: an agent reads the tabs it opened; a tab the user opened (their sign-ins) asks first, under the agent policy's approval.
test('mayRead: own tab without asking; the user\'s tab asks with risk approval, and a no or a policy deny refuses', async () => {
  const asked = [];
  const ctx = (approval, answer = true) => ({ source: 'agent:assistant', policy: { approval }, ask: async (...a) => { asked.push(a); return answer; } });
  const mine = { id: 'm', url: 'https://example.org', title: 'Mine', agent: 'agent:assistant' };
  const theirs = { id: 'u', url: 'https://mail.example.com/inbox', title: 'Inbox' };
  await mayRead(ctx('ask'), mine);
  assert.equal(asked.length, 0);
  await mayRead(ctx('ask'), theirs);
  assert.deepEqual(asked, [['read your browser tab "Inbox"', 'https://mail.example.com/inbox', { risk: 'approval' }]]);
  await assert.rejects(mayRead(ctx('ask', false), theirs), (e) => e.code === 'denied' && e.data.reason === 'user');
  await assert.rejects(mayRead(ctx('deny'), theirs), (e) => e.code === 'denied' && e.data.reason === 'policy');
  asked.length = 0;
  await mayRead(ctx('ask'), { ...theirs, agent: 'agent:other-client' }); // another agent's tab is not this one's either
  assert.equal(asked.length, 1);
  asked.length = 0;
  await mayRead(ctx(true), theirs); // Allow all
  assert.equal(asked.length, 0);
});

test('the web tools: in no view set, small, keyboard characters, described; every family\'s rules say web text is data', () => {
  const tools = toolsFor(CATALOGUE, { ids: WEB, $defs: MODEL_DEFS, form: 'model' });
  assert.equal(tools.length, 2);
  for (const t of tools) {
    const id = WEB.find((x) => x.replaceAll('.', '_') === t.function.name);
    assert.ok(byId(id).brief, id);
    assert.ok(!CORE.includes(id) && !Object.values(VIEW_SETS).flat().includes(id), `${id} is in a set`);
    assert.equal(byId(id).risk, 'read');
    assert.ok(JSON.stringify(t).length <= MAX_TOOL, id);
    for (const [k, p] of Object.entries(t.function.parameters.properties)) assert.ok(p.description && p.description.length <= 90, `${id}.${k}`);
    assert.ok(!/[–—…‘’“”]/.test(JSON.stringify(t)), id);
  }
  assert.ok(JSON.stringify(tools).length <= 1800, `${JSON.stringify(tools).length} characters`); // what every request adds
  for (const family of Object.keys(RULES)) assert.ok(systemPrompt(family).includes(WEB_RULE), family);
});
