'use strict';
// The assistant through the user's own Claude Code or Codex (SPEC §7i Coding CLIs): finding the CLI, its version, sign-in and
// models; the arguments of one run; its JSON lines as assistant.event events. Each run gets EasyWriter's MCP server on its command
// line (bin/easywriter-agent.js with the per-start key in EASYWRITER_ASSISTANT, src/agent-server.js), never in the CLI's own
// config files, and no built-in tools. Electron-free, so test/assistant-cli.test.mjs runs it under Node.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const WIN = process.platform === 'win32';
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const KEY_VAR = 'EASYWRITER_ASSISTANT'; // the bridge's env: the key that makes its calls the in-app assistant's
const SERVER = 'easywriter'; // the MCP server's name in the run: Claude names its tools mcp__easywriter__<tool>
// The CLIs (settings.assistant.provider): the executable, the folders their installers use besides PATH, the settings fields,
// how to install and sign in. Efforts from `claude --help` (2.1.274) and Codex's model_reasoning_effort values (0.154.0).
const CLIS = {
  claude: {
    // label: the app name, then the CLI (the user, 2026-10-26, as ChatGPT (Codex)).
    label: 'Claude (Claude Code)', bin: 'claude', npm: '@anthropic-ai/claude-code', pathField: 'claudePath', modelField: 'claudeModel', effortField: 'claudeEffort',
    dirs: [path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'],
    // The Claude app for Windows keeps its own Claude Code in <appDir>/<version>/<build>/claude.exe; the newest one is used.
    appDir: path.join(ROAMING, 'Claude', 'claude-code'),
    // Not found: the Claude app brings Claude Code with it.
    install: 'Download the Claude app for Windows, then open Settings again.', installUrl: 'https://claude.com/download',
    login: 'Run claude in a terminal and sign in.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  codex: {
    // label: the name the user knows it by (2026-10-26).
    label: 'ChatGPT (Codex)', bin: 'codex', npm: '@openai/codex', pathField: 'codexPath', modelField: 'codexModel', effortField: 'codexEffort',
    dirs: [path.join(LOCAL, 'Programs', 'OpenAI', 'Codex', 'bin'), path.join(HOME, '.codex', 'packages', 'standalone', 'current', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'],
    // Not found: the ChatGPT app for Windows brings Codex with it (the user, 2026-10-26).
    install: 'Download the ChatGPT app for Windows, then open Settings again.', installUrl: 'https://chatgpt.com/download/',
    login: 'Run codex login in a terminal.',
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
};
const CLAUDE_MODELS = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]; // aliases of the latest of each
const SIGNED_OUT = /not logged in|log ?in|unauthori[sz]ed|\b401\b|authenticat|api key/i;

const isCli = (id) => Object.hasOwn(CLIS, id);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

const isFile = (f) => !!fs.statSync(f, { throwIfNoEntry: false })?.isFile();

/** The native executable behind an npm install's `<bin>.cmd` shim: the `<bin>.exe` its package holds (Codex: vendor/<triple>/
 * codex/codex.exe, maybe in a nested platform package), or null. A .cmd needs a shell, and the prompt and arguments would go
 * through its quoting. */
function fromShim(id, cmd) {
  const pkg = path.join(path.dirname(cmd), 'node_modules', ...CLIS[id].npm.split('/'));
  try {
    const hit = fs.readdirSync(pkg, { recursive: true }).find((f) => path.basename(String(f)).toLowerCase() === `${CLIS[id].bin}.exe`);
    return hit ? path.join(pkg, String(hit)) : null;
  } catch {
    return null;
  }
}

/** The executable of CLI `id`: settings.assistant's custom path when it is a file, else the first on PATH or in CLIS.dirs, or null.
 * Windows: an .exe, or the one behind an npm .cmd shim (fromShim). */
function find(id, custom) {
  const native = (f) => (WIN && /\.cmd$/i.test(f) ? fromShim(id, f) : f);
  const own = str(custom);
  if (own) return isFile(own) ? native(own) : null;
  const names = WIN ? [`${CLIS[id].bin}.exe`, `${CLIS[id].bin}.cmd`] : [CLIS[id].bin];
  for (const dir of [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...CLIS[id].dirs]) {
    for (const name of names) {
      const file = path.join(dir, name);
      const exe = isFile(file) && native(file);
      if (exe) return exe;
    }
  }
  return CLIS[id].appDir ? newestIn(CLIS[id].appDir, names[0]) : null;
}

/** The newest `<dir>/<version>/<build>/<name>` by version number, else null. */
function newestIn(dir, name) {
  const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const parts = (v) => v.split('.').map((n) => Number(n) || 0);
  const newer = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0; };
  for (const v of list(dir).sort(newer)) {
    for (const b of list(path.join(dir, v))) if (isFile(path.join(dir, v, b, name))) return path.join(dir, v, b, name);
  }
  return null;
}

/** Runs `file args` → {code, out, err}, killed after `ms`. */
const quick = (file, args, ms = 10000) => new Promise((resolve) => {
  execFile(file, args, { timeout: ms, windowsHide: true, maxBuffer: 1 << 20 }, (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(out), err: String(err) }));
});

/** Codex's models: its models_cache.json (CODEX_HOME, else ~/.codex) lists the ones the signed-in account can pick. */
function codexModels() {
  try {
    const dir = process.env.CODEX_HOME || path.join(HOME, '.codex');
    const { models } = JSON.parse(fs.readFileSync(path.join(dir, 'models_cache.json'), 'utf8'));
    return models.filter((m) => m.visibility !== 'hide' && m.slug).map((m) => [m.slug, m.display_name || m.slug]);
  } catch {
    return [];
  }
}

/** The sign-in line of `claude auth status --json` or `codex login status` (both local, no model call) → {signedIn, account}. */
function signInOf(id, { code, out, err = '' }) {
  if (id === 'codex') {
    const line = `${out}\n${err}`.split('\n').map((l) => l.trim()).find((l) => /logged in/i.test(l)) ?? ''; // codex prints it on stderr
    return { signedIn: code === 0 && !!line && !/not logged in/i.test(line), account: line.replace(/^logged in using /i, '') };
  }
  try {
    const j = JSON.parse(out);
    return { signedIn: j.loggedIn === true, account: [j.authMethod, j.subscriptionType].filter(Boolean).join(', ') };
  } catch {
    return { signedIn: false, account: '' };
  }
}

const probes = new Map(); // `${id}|${file}` → Promise of the probe, kept a minute (the Settings dialog asks on every edit)

/** CLI `id` with settings.assistant `a` → {id, label, path, version, signedIn, account, state: ready | not_found | signed_out,
 * hint, models: [[id, label]], efforts}. */
async function probe(id, a = {}, fresh = false) {
  const c = CLIS[id];
  const file = find(id, a[c.pathField]);
  const base = { id, label: c.label, path: file, models: id === 'claude' ? CLAUDE_MODELS : codexModels(), efforts: c.efforts };
  if (!file) return { ...base, version: '', signedIn: false, account: '', state: 'not_found', hint: c.install, url: c.installUrl ?? null };
  const k = `${id}|${file}`;
  if (fresh || !probes.has(k) || probes.get(k).at < Date.now() - 60000) {
    const p = Promise.all([quick(file, ['--version']), quick(file, id === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'])]);
    probes.set(k, { at: Date.now(), p });
  }
  const [v, s] = await probes.get(k).p;
  const version = v.code === 0 ? v.out.trim().split('\n')[0] : '';
  if (!version) return { ...base, version: '', signedIn: false, account: '', state: 'not_found', hint: `${file} did not run. ${c.install}`, url: c.installUrl ?? null };
  const sign = signInOf(id, s);
  return { ...base, version, ...sign, state: sign.signedIn ? 'ready' : 'signed_out', hint: sign.signedIn ? '' : c.login };
}

/** A TOML value for Codex's -c (JSON strings and arrays of strings are valid TOML). */
const toml = (v) => JSON.stringify(v);

/** The arguments of one Claude Code run (`claude --help`, 2.1.274): print mode, the prompt on stdin, stream-json with partial
 * messages, only EasyWriter's MCP server (`link` = {command, args}) and none of the user's settings, hooks, CLAUDE.md, skills
 * or MCP servers, no built-in tools, EasyWriter's tools allowed without asking (the app's permission mode decides), anything
 * else refused. `systemFile`: the system prompt's file; `resume`: the session id of the turn before. */
function claudeArgs({ link, model, effort, systemFile, resume }) {
  const mcp = { mcpServers: { [SERVER]: { command: link.command, args: link.args, env: { ELECTRON_RUN_AS_NODE: '1', [KEY_VAR]: `\${${KEY_VAR}}` } } } };
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
    '--tools', '', '--allowedTools', `mcp__${SERVER}`, '--permission-mode', 'dontAsk',
    ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
    ...(systemFile ? ['--system-prompt-file', systemFile] : []), ...(resume ? ['--resume', resume] : []),
  ];
}

// Codex's own tools, turned off for EasyWriter's runs (`codex features list`, 0.154.0), and its web search.
const CODEX_OFF = ['shell_tool', 'unified_exec', 'view_image', 'apps', 'plugins', 'memories', 'browser_use', 'computer_use', 'image_generation', 'multi_agent'];

/** The arguments of one Codex run (`codex exec --help`, 0.154.0): JSON lines, the prompt on stdin ('-'), outside a git repository,
 * without ~/.codex/config.toml (its sign-in still counts), none of its own tools (CODEX_OFF) and a read-only sandbox in case one is
 * left, never asking, EasyWriter's MCP server by -c with
 * its tools approved (the app's permission mode decides) and the key passed through by name. `resume`: the thread id of the
 * turn before (exec resume has no --sandbox, so the sandbox goes by -c too). */
function codexArgs({ link, model, effort, system, resume }) {
  const s = `mcp_servers.${SERVER}`;
  const opts = [
    '--json', '--skip-git-repo-check', '--ignore-user-config',
    '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
    ...CODEX_OFF.flatMap((f) => ['-c', `features.${f}=false`]), '-c', 'web_search="disabled"',
    '-c', `${s}.command=${toml(link.command)}`, '-c', `${s}.args=${toml(link.args)}`, '-c', `${s}.env={ELECTRON_RUN_AS_NODE="1"}`,
    '-c', `${s}.env_vars=${toml([KEY_VAR])}`, '-c', `${s}.default_tools_approval_mode="approve"`, '-c', `${s}.tool_timeout_sec=600`,
    ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${toml(effort)}`] : []),
    ...(system ? ['-c', `developer_instructions=${toml(system)}`] : []),
  ];
  return resume ? ['exec', 'resume', ...opts, resume, '-'] : ['exec', ...opts, '-'];
}

const toolOf = (name) => String(name ?? '').replace(`mcp__${SERVER}__`, '');
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((p) => (p?.type === 'text' ? p.text : p?.type === 'image' ? '[image]' : '')).join('') : '');
const signedOut = (id, message) => (SIGNED_OUT.test(message)
  ? { type: 'error', code: 'signed_out', message: `${CLIS[id].label} is not signed in. ${CLIS[id].login}` } : { type: 'error', message });

/** One stream-json line of Claude Code → events. `st` keeps the session id, the MCP server's state at init and the tool names by id. */
function parseClaude(st, msg) {
  st.names ??= {};
  if (msg.session_id) st.session = msg.session_id;
  if (msg.type === 'system' && msg.subtype === 'init') {
    st.mcp = msg.mcp_servers?.find((s) => s.name === SERVER)?.status ?? 'missing';
    return [];
  }
  if (msg.type === 'stream_event') {
    const d = msg.event?.type === 'content_block_delta' ? msg.event.delta : null;
    if (d?.type === 'text_delta' && d.text) return [{ type: 'delta', text: d.text }];
    if (d?.type === 'thinking_delta' && d.thinking) return [{ type: 'reasoning', text: d.thinking }];
    return [];
  }
  const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
  if (msg.type === 'assistant') {
    return blocks.filter((b) => b.type === 'tool_use').map((b) => {
      st.names[b.id] = toolOf(b.name);
      return { type: 'tool_start', id: b.id, name: toolOf(b.name), args: b.input ?? {} };
    });
  }
  if (msg.type === 'user') {
    return blocks.filter((b) => b.type === 'tool_result')
      .map((b) => ({ type: 'tool_end', id: b.tool_use_id, name: st.names[b.tool_use_id] ?? '', ok: !b.is_error, result: textOf(b.content) }));
  }
  if (msg.type === 'result') {
    if (msg.is_error || msg.subtype !== 'success') return [signedOut('claude', String(msg.result || msg.errors?.join(' ') || msg.subtype || `${CLIS.claude.label} failed`))];
    const u = msg.usage ?? {};
    const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    return [{ type: 'done', session: st.session ?? null, usage: { prompt, completion: u.output_tokens || 0 }, ...(Number.isFinite(msg.total_cost_usd) && { cost: msg.total_cost_usd }) }];
  }
  return [];
}

/** One `codex exec --json` line → events. `st` keeps the thread id and the text sent per item (item.updated may repeat it).
 * Items of type error are notices (skills trimmed, transport fallbacks) and top-level errors are retries: only turn.failed ends. */
function parseCodex(st, msg) {
  st.sent ??= {};
  const it = msg.item;
  switch (msg.type) {
    case 'thread.started':
      st.session = msg.thread_id;
      return [];
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      if (!it) return [];
      if (it.type === 'agent_message' || it.type === 'reasoning') {
        const text = String(it.text ?? '');
        const from = st.sent[it.id] ?? 0;
        st.sent[it.id] = text.length;
        return text.length > from ? [{ type: it.type === 'agent_message' ? 'delta' : 'reasoning', text: text.slice(from) }] : [];
      }
      const tool = it.type === 'mcp_tool_call' ? { name: it.tool, args: it.arguments ?? {} }
        : it.type === 'command_execution' ? { name: 'command', args: { command: it.command } } : null;
      if (!tool) return [];
      if (msg.type === 'item.started') return [{ type: 'tool_start', id: it.id, ...tool }];
      if (msg.type !== 'item.completed') return [];
      const ok = it.type === 'mcp_tool_call' ? it.status === 'completed' && !it.error && !it.result?.is_error && !it.result?.isError : it.exit_code === 0;
      const result = it.error?.message ?? textOf(it.result?.content) ?? '';
      return [{ type: 'tool_end', id: it.id, name: tool.name, ok, result: it.type === 'command_execution' ? String(it.aggregated_output ?? '') : result }];
    }
    case 'turn.completed': {
      const u = msg.usage ?? {};
      return [{ type: 'done', session: st.session ?? null, usage: { prompt: (u.input_tokens || 0), completion: u.output_tokens || 0 } }];
    }
    case 'turn.failed':
      return [signedOut('codex', String(msg.error?.message ?? `${CLIS.codex.label} failed`))];
    default:
      return [];
  }
}

/** Ends process `child` and everything it started (Windows: taskkill /T /F; elsewhere its process group). */
function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

/** Starts one run of CLI `id` at `file` in folder `cwd` with `args`, the prompt on stdin and the bridge key in its env; each event
 * → `emit`; one `done` or `error` ends it (an exit without either → error with stderr's end). → {kill}. */
function run({ id, file, args, cwd, prompt, key, emit }) {
  const child = spawn(file, args, { cwd, env: { ...process.env, [KEY_VAR]: key }, windowsHide: true, detached: !WIN, stdio: ['pipe', 'pipe', 'pipe'] });
  const st = {};
  let ended = false;
  let err = '';
  let buf = '';
  const out = (e) => {
    if (ended) return;
    if (e.type === 'done' || e.type === 'error') ended = true;
    emit(e);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        for (const e of (id === 'claude' ? parseClaude : parseCodex)(st, JSON.parse(line))) out(e);
      } catch { /* not a JSON event */ }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
  child.on('error', (e) => out({ type: 'error', message: e.message }));
  child.on('close', (code) => {
    const last = err.split('\n').map((l) => l.trim()).filter((l) => l && !/^WARNING/.test(l)).slice(-3).join(' ');
    out(signedOut(id, last || `${CLIS[id].label} stopped (exit code ${code}).`));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  return { st, kill: () => { ended = true; killTree(child); } };
}

module.exports = { CLIS, KEY_VAR, isCli, find, newestIn, probe, signInOf, codexModels, claudeArgs, codexArgs, parseClaude, parseCodex, run, killTree };
