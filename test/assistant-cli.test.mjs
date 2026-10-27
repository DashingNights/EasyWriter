import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { claudeArgs, codexArgs, newestIn, parseClaude, parseCodex, signInOf } = require('../src/assistant/cli.js');

const link = { command: 'C:\\App\\EasyWriter.exe', args: ['C:\\App\\bin\\easywriter-agent.js', '--pipe=\\\\.\\pipe\\easywriter-abc'] };
const parse = (fn, lines) => {
  const st = {};
  return { st, events: lines.flatMap((l) => fn(st, JSON.parse(l))) };
};
const after = (args, flag) => args[args.indexOf(flag) + 1];

test('claudeArgs: print mode, stream-json, only EasyWriter\'s server and tools, the key by name', () => {
  const a = claudeArgs({ link, model: 'haiku', effort: 'low', systemFile: 'C:\\x\\system-prompt.txt', resume: 's-1' });
  for (const f of ['-p', '--verbose', '--include-partial-messages', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(a.includes(f), f);
  assert.equal(after(a, '--output-format'), 'stream-json');
  assert.equal(after(a, '--setting-sources'), '');
  assert.equal(after(a, '--tools'), '');
  assert.equal(after(a, '--allowedTools'), 'mcp__easywriter');
  assert.equal(after(a, '--permission-mode'), 'dontAsk');
  assert.equal(after(a, '--model'), 'haiku');
  assert.equal(after(a, '--effort'), 'low');
  assert.equal(after(a, '--system-prompt-file'), 'C:\\x\\system-prompt.txt');
  assert.equal(after(a, '--resume'), 's-1');
  const server = JSON.parse(after(a, '--mcp-config')).mcpServers.easywriter;
  assert.deepEqual(server, { command: link.command, args: link.args, env: { ELECTRON_RUN_AS_NODE: '1', EASYWRITER_ASSISTANT: '${EASYWRITER_ASSISTANT}' } });
  const bare = claudeArgs({ link, model: '', effort: '', systemFile: '', resume: '' });
  for (const f of ['--model', '--effort', '--system-prompt-file', '--resume']) assert.ok(!bare.includes(f), f);
});

test('codexArgs: exec --json, read-only, no user config, the bridge by -c, resume by thread id, prompt on stdin', () => {
  const a = codexArgs({ link, model: 'gpt-6-luna', effort: 'high', system: 'Be "brief".\nOK', resume: '' });
  assert.deepEqual(a.slice(0, 4), ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config']);
  assert.equal(a.at(-1), '-');
  const c = a.filter((_, i) => a[i - 1] === '-c');
  assert.ok(c.includes('sandbox_mode="read-only"'));
  assert.ok(c.includes('approval_policy="never"'));
  assert.ok(c.includes('features.shell_tool=false') && c.includes('web_search="disabled"'));
  assert.ok(c.includes(`mcp_servers.easywriter.command=${JSON.stringify(link.command)}`));
  assert.ok(c.includes(`mcp_servers.easywriter.args=${JSON.stringify(link.args)}`));
  assert.ok(c.includes('mcp_servers.easywriter.env={ELECTRON_RUN_AS_NODE="1"}'));
  assert.ok(c.includes('mcp_servers.easywriter.env_vars=["EASYWRITER_ASSISTANT"]'));
  assert.ok(c.includes('mcp_servers.easywriter.default_tools_approval_mode="approve"'));
  assert.ok(c.includes('model_reasoning_effort="high"'));
  assert.ok(c.includes('developer_instructions="Be \\"brief\\".\\nOK"'));
  assert.equal(after(a, '-m'), 'gpt-6-luna');
  const r = codexArgs({ link, model: '', effort: '', system: '', resume: '0199-thread' });
  assert.deepEqual(r.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(r.slice(-2), ['0199-thread', '-']);
  assert.ok(!r.includes('-m') && !r.includes('-s'));
});

// The stream-json lines of Claude Code 2.1.274 (print mode, --verbose --include-partial-messages), cut to the fields read.
const CLAUDE = [
  '{"type":"system","subtype":"init","session_id":"53c4","model":"claude-haiku","tools":["mcp__easywriter__ui_state"],"mcp_servers":[{"name":"easywriter","status":"connected"}]}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan."}},"session_id":"53c4"}',
  '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp__easywriter__drafts_create","input":{}}},"session_id":"53c4"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"mcp__easywriter__drafts_create","input":{"content":{"markdown":"CLI smoke"}}}]},"session_id":"53c4"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"{\\"result\\":{\\"draftId\\":\\"47b3\\"}}"}]}]},"session_id":"53c4"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","is_error":true,"content":"denied"}]},"session_id":"53c4"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}},"session_id":"53c4"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]},"session_id":"53c4"}',
  '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"53c4","total_cost_usd":0.0156,"usage":{"input_tokens":40,"cache_creation_input_tokens":1600,"cache_read_input_tokens":60000,"output_tokens":685}}',
];

test('parseClaude: deltas, thinking, tool start and end by id, done with the session and usage; init notes the server', () => {
  const { st, events } = parse(parseClaude, CLAUDE);
  assert.equal(st.mcp, 'connected');
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'Plan.' },
    { type: 'tool_start', id: 'toolu_1', name: 'drafts_create', args: { content: { markdown: 'CLI smoke' } } },
    { type: 'tool_end', id: 'toolu_1', name: 'drafts_create', ok: true, result: '{"result":{"draftId":"47b3"}}' },
    { type: 'tool_end', id: 'toolu_2', name: '', ok: false, result: 'denied' },
    { type: 'delta', text: 'done' },
    { type: 'done', session: '53c4', usage: { prompt: 61640, completion: 685 }, cost: 0.0156 },
  ]);
});

test('parseClaude: a failed result is an error, signed out when it says so', () => {
  const { events } = parse(parseClaude, ['{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","session_id":"x"}']);
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].code, 'signed_out');
  const { events: e2 } = parse(parseClaude, ['{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"x"}']);
  assert.deepEqual(e2, [{ type: 'error', message: 'error_max_turns' }]);
});

// `codex exec --json` (0.154.0): the signed-out run's own lines, then a turn's items as its docs describe them.
const CODEX_SIGNED_OUT = [
  '{"type":"thread.started","thread_id":"01a16a31-5ada-7873-882a-308892f3dd6c"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened to fit the skills context budget."}}',
  '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}',
  '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}}',
];
const CODEX_TURN = [
  '{"type":"thread.started","thread_id":"t-1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Checking the view**"}}',
  '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"easywriter","tool":"ui_state","arguments":{},"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"easywriter","tool":"ui_state","arguments":{},"result":{"content":[{"type":"text","text":"{\\"view\\":\\"editor\\"}"}]},"status":"completed"}}',
  '{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"easywriter","tool":"drafts_delete","arguments":{"draftId":"d"},"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"easywriter","tool":"drafts_delete","arguments":{"draftId":"d"},"error":{"message":"denied"},"status":"failed"}}',
  '{"type":"item.updated","item":{"id":"item_3","type":"agent_message","text":"rea"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"ready"}}',
  '{"type":"turn.completed","usage":{"input_tokens":2400,"cached_input_tokens":2000,"output_tokens":12}}',
];

test('parseCodex: signed out → one signed_out error at turn.failed; notices and retries are skipped', () => {
  const { st, events } = parse(parseCodex, CODEX_SIGNED_OUT);
  assert.equal(st.session, '01a16a31-5ada-7873-882a-308892f3dd6c');
  assert.deepEqual(events.map((e) => [e.type, e.code]), [['error', 'signed_out']]);
  assert.match(events[0].message, /ChatGPT \(Codex\) is not signed in\. Run codex login/);
});

test('parseCodex: reasoning, MCP calls with ok and error, text once per item, done with the thread id and usage', () => {
  const { events } = parse(parseCodex, CODEX_TURN);
  assert.deepEqual(events, [
    { type: 'reasoning', text: '**Checking the view**' },
    { type: 'tool_start', id: 'item_1', name: 'ui_state', args: {} },
    { type: 'tool_end', id: 'item_1', name: 'ui_state', ok: true, result: '{"view":"editor"}' },
    { type: 'tool_start', id: 'item_2', name: 'drafts_delete', args: { draftId: 'd' } },
    { type: 'tool_end', id: 'item_2', name: 'drafts_delete', ok: false, result: 'denied' },
    { type: 'delta', text: 'rea' },
    { type: 'delta', text: 'dy' },
    { type: 'done', session: 't-1', usage: { prompt: 2400, completion: 12 } },
  ]);
});

test('signInOf: claude auth status --json, codex login status (stderr)', () => {
  assert.deepEqual(signInOf('claude', { code: 0, out: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}' }), { signedIn: true, account: 'claude.ai, max' });
  assert.equal(signInOf('claude', { code: 1, out: '{"loggedIn":false}' }).signedIn, false);
  assert.deepEqual(signInOf('codex', { code: 0, out: '', err: 'Logged in using ChatGPT\n' }), { signedIn: true, account: 'ChatGPT' });
  assert.equal(signInOf('codex', { code: 1, out: '', err: 'WARNING: proceeding\nNot logged in\n' }).signedIn, false);
});

// The chat's side (context.mjs, as loop.js runCliTurn uses it): Codex lines → events → the messages shown.
test('chat display of a Codex turn: reasoning, a step per call with its command id, the reply; signed out → its message', async () => {
  const { cliMessages, cliResult } = await import('../src/app/assistant/context.mjs');
  const { commandIdOf } = await import('../src/app/commands/tools-schema.mjs');
  const shown = (lines) => {
    let n = 0;
    let ms = [{ id: 'u', role: 'user', text: 'hi' }, { id: 'a0', role: 'assistant', text: '', reasoning: '', error: '', streaming: true }];
    for (const e of parse(parseCodex, lines).events) {
      ms = cliMessages(ms, e, `m${++n}`);
      if (e.type === 'tool_end') {
        ms = [...ms, { role: 'step', id: commandIdOf(e.name), res: cliResult(e) }, { id: `s${n}`, role: 'assistant', text: '', reasoning: '', error: '', streaming: true }];
      }
    }
    return ms;
  };
  const ms = shown(CODEX_TURN);
  assert.equal(ms[1].reasoning, '**Checking the view**');
  assert.deepEqual(ms.filter((m) => m.role === 'step').map((m) => [m.id, m.res.ok, m.res.error?.message]), [['ui.state', true, undefined], ['drafts.delete', false, 'denied']]);
  assert.equal(ms.at(-1).text, 'ready');
  assert.ok(ms.every((m) => !m.streaming));
  const out = shown(CODEX_SIGNED_OUT).at(-1);
  assert.equal(out.streaming, false);
  assert.match(out.error, /^ChatGPT \(Codex\) is not signed in\. Run codex login in a terminal\.$/);
  // The bridge's result JSON keeps undoSteps, rev and draftId for the step's Undo; an error's JSON is the error.
  assert.deepEqual(cliResult({ ok: true, result: '{"result":{"id":"d1"},"undoSteps":1,"rev":4,"draftId":"d1"}' }), { ok: true, result: { id: 'd1' }, undoSteps: 1, rev: 4, draftId: 'd1' });
  assert.deepEqual(cliResult({ ok: false, result: '{"code":"denied","message":"No"}' }), { ok: false, error: { code: 'denied', message: 'No' } });
});

test('advanced settings: defaults per key, numbers rounded and clamped, invalid values ignored', () => {
  const { ADVANCED, advanced } = require('../src/assistant/advanced.js');
  assert.deepEqual(advanced(undefined), ADVANCED);
  assert.deepEqual(advanced({ advanced: 'x' }), ADVANCED);
  assert.equal(ADVANCED.maxCalls, 40);
  assert.equal(ADVANCED.maxTokens, 8192);
  const a = advanced({ advanced: { maxCalls: 0, maxResult: 1e9, shots: '5', cloudKeep: 'many', cloudLive: 2.6, maxTokens: null, limitCalls: false, repeatStop: 'no' } });
  assert.deepEqual(a, { ...ADVANCED, maxCalls: 1, maxResult: 200000, shots: 5, cloudLive: 3, limitCalls: false });
});

test('find: an npm .cmd shim resolves to the exe inside its package (Windows)', { skip: process.platform !== 'win32' }, () => {
  const fs = require('fs');
  const path = require('path');
  const { find } = require('../src/assistant/cli.js');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ew-shim-'));
  const exe = path.join(dir, 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '');
  try {
    assert.equal(find('codex', path.join(dir, 'codex.cmd')), exe);
    assert.equal(find('claude', path.join(dir, 'claude.cmd')), null); // no claude.exe in its package
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takePictures: a calls step picture is taken out of its result', async () => {
  const { takePictures } = await import('../src/app/assistant/context.mjs');
  const pic = { size: '10 x 10 screenshot', picture: 'next message', url: 'data:image/jpeg;base64,AAAA' };
  const { res, pictures } = takePictures({ ok: true, result: { results: [{ ok: true, result: pic }, { ok: false, error: { code: 'x' } }] } });
  assert.deepEqual(pictures, [{ url: pic.url, size: pic.size }]);
  assert.equal(res.result.results[0].result.url, undefined);
  assert.equal(res.result.results[1].error.code, 'x');
});

test('newestIn: the Claude app keeps Claude Code per version and build; the newest version with the program wins', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-cli-'));
  const put = (v, b) => { fs.mkdirSync(path.join(dir, v, b), { recursive: true }); fs.writeFileSync(path.join(dir, v, b, 'claude.exe'), ''); };
  try {
    assert.equal(newestIn(path.join(dir, 'missing'), 'claude.exe'), null);
    put('2.1.9', 'aaa');
    put('2.1.10', 'bbb'); // 10 > 9 by number, not by text
    fs.mkdirSync(path.join(dir, '2.2.0', 'ccc'), { recursive: true }); // newest folder without the program
    assert.equal(newestIn(dir, 'claude.exe'), path.join(dir, '2.1.10', 'bbb', 'claude.exe'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pathBetween: the login shell\'s PATH between the markers, banners around it ignored; no markers → empty', () => {
  const { pathBetween } = require('../src/assistant/cli.js');
  assert.equal(pathBetween('Welcome back!\n__EASYWRITER_PATH__\n/opt/homebrew/bin:/usr/bin:/bin\n__EASYWRITER_PATH__\nbye\n'), '/opt/homebrew/bin:/usr/bin:/bin');
  assert.equal(pathBetween('zsh: command not found: compinit\n'), '');
  assert.equal(pathBetween('__EASYWRITER_PATH__\n/usr/bin\n'), ''); // cut off before the second marker
  assert.equal(pathBetween(undefined), '');
});

test('find on a Mac: PATH first, then the installers\' folders, then the app copies; an npm-linked codex resolves to its binary', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { find } = require('../src/assistant/cli.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-mac-'));
  const put = (...p) => { const f = path.join(home, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); return f; };
  const mac = (PATH = '', arch = 'arm64') => ({ platform: 'darwin', arch, home, PATH });
  try {
    assert.equal(find('claude', '', mac()), null);
    // The Claude app's copy: <version>/claude.app/Contents/MacOS/claude, newest by number; claude-code-vm is skipped.
    const app = ['Library', 'Application Support', 'Claude', 'claude-code'];
    put(...app, '1.9.0', 'claude.app', 'Contents', 'MacOS', 'claude');
    const newest = put(...app, '1.10.0', 'claude.app', 'Contents', 'MacOS', 'claude');
    put(...app, 'claude-code-vm', 'claude.app', 'Contents', 'MacOS', 'claude');
    assert.equal(find('claude', '', mac()), newest);
    const local = put('.local', 'bin', 'claude');
    assert.equal(find('claude', '', mac()), local);
    const onPath = put('brew', 'bin', 'claude');
    assert.equal(find('claude', '', mac([path.join(home, 'nothing'), path.dirname(onPath)].join(path.delimiter))), onPath);
    // Codex: the ChatGPT app's copy under ~/Applications, then ~/.local/bin (its install script) before it.
    const chatgpt = put('Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex');
    assert.equal(find('codex', '', mac()), chatgpt);
    const script = put('.local', 'bin', 'codex');
    assert.equal(find('codex', '', mac()), script);
    // npm: <prefix>/bin/codex links to bin/codex.js; the binary is in the nested platform package.
    const pkg = ['lib', 'node_modules', '@openai', 'codex'];
    const js = put(...pkg, 'bin', 'codex.js');
    const arm = put(...pkg, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
    assert.equal(find('codex', js, mac()), arm);
    assert.equal(find('codex', js, mac('', 'x64')), js); // no Intel binary: the script, which runs with node on PATH
    put(...pkg, 'node_modules', '@openai', 'codex-darwin-x64', 'vendor', 'x86_64-apple-darwin', 'bin', 'codex');
    assert.match(find('codex', js, mac('', 'x64')), /x86_64-apple-darwin[\\/]bin[\\/]codex$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
