'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, ipcMain } = require('electron');

// The MCP server for local AI agents (SPEC §8 Agents; agent-automation plan §4.4-§4.6 without the token, the user's decision
// 2026-10-08). On while settings.agent.enabled, with two transports:
// - Streamable HTTP at http://127.0.0.1:<settings.agent.port>/mcp (POST JSON-RPC, JSON answers, Mcp-Session-Id sessions), for
//   clients that take a URL;
// - a named pipe (a Unix socket elsewhere) speaking MCP's stdio framing (newline-delimited JSON-RPC 2.0), which bin/daf-agent.js
//   relays to stdin/stdout for clients that start their server themselves. userData/agent.json {version, pipe, pid, started}.
// Methods: initialize, ping, tools/list, tools/call, notifications/cancelled. The tools are every headless command in the model
// form the in-app assistant gets (SPEC §8 Tool schemas); a call runs in the main window's executor (commands.js) as source
// agent:<client name>, so the agent policy applies: writes run, destructive and approval commands ask the user every time.
// To the renderer, one channel `agent.event`: {type: call, rid, req} | {type: cancel, rid} | {type: connected | disconnected,
// id, name, since}. From it: agent.ready (its executor listens), agent.reply (rid, result), agent.disconnect (id), agent.status.

const PORT = 47823; // settings.agent.port when unset
const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']; // newest first
const MAX_BODY = 64 * 1024 * 1024;
const IDLE_MS = 30 * 60 * 1000; // an HTTP session unused this long is dropped; its client starts a new one on the 404
const RPC = '2.0';
const INSTRUCTIONS = 'EasyWriter is a desktop editor for forum post drafts with whiteboards, plans and flowcharts. '
  + 'Start with ui_state or drafts_list; commands_index and commands_describe explain the commands. Blocks are addressed by path '
  + '(indices from doc_get or doc_find). Writes run at once and the user can undo them; deletes and pushes ask the user in the app.';
// The stdio relay, outside the asar archive in a packaged app (package.json build.asarUnpack).
const BRIDGE = path.join(__dirname, '..', 'bin', 'daf-agent.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

let getWin = () => null;
let ready = false; // the renderer's executor is listening
let pipeServer = null;
let httpServer = null;
let port = null;
let httpError = null;
let sweep = null;
let lastRid = 0;
let lastSession = 0;
const sessions = new Set(); // initialized sessions: the status bar's connections
const httpSessions = new Map(); // Mcp-Session-Id → session
const waiting = []; // [rid, req] sent before the renderer was ready
const pending = new Map(); // rid → {session, id (the JSON-RPC request), resolve}

const infoFile = () => path.join(app.getPath('userData'), 'agent.json');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const portOf = (s) => (Number.isInteger(s?.agent?.port) && s.agent.port >= 1024 && s.agent.port <= 65535 ? s.agent.port : PORT);
const rpcError = (code, message, id = null) => ({ jsonrpc: RPC, id, error: { code, message } });

/** The pipe for this profile: one per userData folder, so a smoke run's own profile never meets the real one. */
function pipePath() {
  const hash = crypto.createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\daf-writer-${hash}` : path.join(os.tmpdir(), `daf-writer-${hash}.sock`);
}

/** The executor's source name: lower case, [a-z0-9_-], at most 32 characters. 'assistant' is the in-app assistant's own
 * (its permission mode applies to it), so an outside client with that name gets another. */
function nameOf(raw) {
  const name = String(raw ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '').slice(0, 32) || 'mcp';
  return name === 'assistant' ? 'assistant-mcp' : name;
}

function toRenderer(ev) {
  const win = getWin();
  if (ready && win && !win.isDestroyed()) win.webContents.send('agent.event', ev);
}

// ---------------------------------------------------------------------------------------------
// Sessions and calls

const connected = (s) => ({ type: 'connected', id: s.id, name: s.name, since: s.since });

function newSession(close) {
  return { id: ++lastSession, name: null, since: Date.now(), seen: Date.now(), key: null, close };
}

function join(session, name) {
  session.name = nameOf(name);
  sessions.add(session);
  toRenderer(connected(session));
}

function drop(session) {
  if (session.key) httpSessions.delete(session.key);
  for (const [rid, p] of pending) if (p.session === session) cancelRid(rid);
  if (sessions.delete(session)) toRenderer({ type: 'disconnected', id: session.id, name: session.name });
}

/** Answers call `rid` with `result` (the command result). */
function answer(rid, result) {
  const p = pending.get(rid);
  if (!p) return;
  pending.delete(rid);
  p.resolve(result);
}

function dispatch(rid, req) {
  const win = getWin();
  if (!win || win.isDestroyed()) return answer(rid, { ok: false, error: { code: 'failed', message: 'The app window is closed' } });
  win.webContents.send('agent.event', { type: 'call', rid, req });
}

function cancelRid(rid) {
  const queued = waiting.findIndex(([r]) => r === rid);
  if (queued < 0) return toRenderer({ type: 'cancel', rid });
  waiting.splice(queued, 1);
  answer(rid, { ok: false, error: { code: 'cancelled', message: 'Cancelled before it ran' } });
}

function cancel(session, id) {
  for (const [rid, p] of pending) if (p.session === session && p.id === id) cancelRid(rid);
}

/** Runs command request `req` for `session`'s JSON-RPC request `id` → the command result (SPEC §8 Envelope). */
function run(session, id, req) {
  return new Promise((resolve) => {
    const rid = ++lastRid;
    pending.set(rid, { session, id, resolve });
    if (ready) dispatch(rid, req);
    else waiting.push([rid, req]);
  });
}

// ---------------------------------------------------------------------------------------------
// MCP

let catalogue = null; // Promise of {tools, idOf(name)}

function tools() {
  catalogue ??= (async () => {
    const mod = (f) => import(pathToFileURL(path.join(__dirname, 'app', 'commands', f)).href);
    const [{ CATALOGUE, MODEL_DEFS }, { toolsFor, commandIdOf }] = await Promise.all([mod('catalogue.mjs'), mod('tools-schema.mjs')]);
    const caps = CATALOGUE.filter((d) => d.headless).map((d) => ({ id: d.id, title: d.title, args: d.args }));
    const ids = caps.map((c) => c.id);
    return {
      tools: toolsFor(caps, { $defs: MODEL_DEFS, form: 'model' }).map(({ function: f }) => ({ name: f.name, description: f.description, inputSchema: f.parameters })),
      idOf: (name) => commandIdOf(name, ids),
    };
  })();
  return catalogue;
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) });

/** A command result as MCP tool content: its JSON (without ok and ms), a `png` field (board.render) as an image. */
function toolResult(res) {
  if (!res?.ok) return text(JSON.stringify(res?.error ?? res), true);
  const { ok: _ok, ms: _ms, ...rest } = res;
  const png = typeof rest.result?.png === 'string' ? rest.result.png : null;
  if (!png) return text(JSON.stringify(rest));
  const { png: _png, ...result } = rest.result;
  return { content: [{ type: 'image', data: png, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ ...rest, result }) }] };
}

async function method(session, id, name, params) {
  switch (name) {
    case 'initialize':
      if (!session.name) join(session, params.clientInfo?.name);
      return {
        protocolVersion: MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'easywriter', version: app.getVersion() },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: (await tools()).tools };
    case 'tools/call': {
      if (!session.name) join(session, 'mcp'); // a stdio client whose initialize reached an earlier connection
      const cmd = (await tools()).idOf(params.name);
      if (!cmd) return text(`Unknown tool ${params.name}`, true);
      return toolResult(await run(session, id, { id: cmd, args: params.arguments ?? {}, source: `agent:${session.name}` }));
    }
    default:
      throw Object.assign(new Error(`Method not found: ${name}`), { code: -32601 });
  }
}

/** One JSON-RPC message from `session` → its response, or null (a notification, or a response to us). */
async function mcp(session, msg) {
  if (!isObject(msg) || typeof msg.method !== 'string') return isObject(msg) && 'id' in msg ? null : rpcError(-32600, 'Invalid request');
  const params = isObject(msg.params) ? msg.params : {};
  session.seen = Date.now();
  if (msg.id === undefined) {
    if (msg.method === 'notifications/cancelled') cancel(session, params.requestId);
    return null;
  }
  try {
    return { jsonrpc: RPC, id: msg.id, result: await method(session, msg.id, msg.method, params) };
  } catch (e) {
    return rpcError(e.code ?? -32603, e.message, msg.id);
  }
}

// ---------------------------------------------------------------------------------------------
// Transports

function onSocket(socket) {
  const session = newSession(() => socket.destroy());
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = undefined;
      }
      const reply = msg === undefined ? Promise.resolve(rpcError(-32700, 'Parse error')) : mcp(session, msg);
      reply.then((res) => res && !socket.destroyed && socket.write(`${JSON.stringify(res)}\n`));
    }
    if (buf.length > MAX_BODY) socket.destroy();
  });
  socket.on('error', () => {});
  socket.on('close', () => drop(session));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

async function onHttp(req, res) {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  // No authentication; only what a web page could send is refused (MCP Streamable HTTP: validate Origin). The Host check stops
  // DNS rebinding; a JSON content type makes a browser ask first (CORS preflight), which this server never allows.
  if (!LOCAL_HOST.test(req.headers.host ?? '') || (req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin))) {
    return send(403, rpcError(-32000, 'Forbidden'));
  }
  if (new URL(req.url, 'http://127.0.0.1').pathname !== '/mcp') return send(404, rpcError(-32000, 'The MCP endpoint is /mcp'));
  const key = req.headers['mcp-session-id'];
  if (req.method === 'DELETE') {
    const s = httpSessions.get(key);
    if (!s) return send(404, rpcError(-32000, 'Unknown session'));
    drop(s);
    return send(200);
  }
  if (req.method !== 'POST') return send(405, undefined, { Allow: 'POST, DELETE' });
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(415, rpcError(-32000, 'Send Content-Type: application/json'));
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(400, rpcError(-32700, 'Parse error'));
  }
  const msgs = Array.isArray(body) ? body : [body];
  let session;
  if (msgs.some((m) => m?.method === 'initialize')) {
    session = newSession(null);
    session.close = () => drop(session);
    session.key = crypto.randomUUID();
    httpSessions.set(session.key, session);
  } else if (!key) return send(400, rpcError(-32000, 'Missing Mcp-Session-Id: send initialize first'));
  else if (!(session = httpSessions.get(key))) return send(404, rpcError(-32000, 'Unknown session: send initialize again'));
  let done = false;
  res.on('close', () => {
    if (!done) for (const m of msgs) if (m?.id !== undefined) cancel(session, m.id); // the client gave up waiting
  });
  const out = (await Promise.all(msgs.map((m) => mcp(session, m)))).filter(Boolean);
  done = true;
  const headers = { 'Mcp-Session-Id': session.key };
  if (!out.length) return send(202, undefined, headers);
  return send(200, Array.isArray(body) ? out : out[0], headers);
}

// ---------------------------------------------------------------------------------------------
// Start and stop

function stopHttp() {
  clearInterval(sweep);
  sweep = null;
  if (httpServer) {
    httpServer.close();
    httpServer.closeAllConnections();
  }
  httpServer = null;
  for (const s of [...httpSessions.values()]) drop(s);
}

function start(settings) {
  if (!pipeServer) {
    const pipe = pipePath();
    if (process.platform !== 'win32') fs.rmSync(pipe, { force: true }); // a socket file left by a crash
    pipeServer = net.createServer(onSocket);
    pipeServer.on('error', (e) => console.error('agent pipe:', e.message));
    pipeServer.listen(pipe, () => {
      if (process.platform !== 'win32') fs.chmodSync(pipe, 0o600);
      fs.writeFileSync(infoFile(), JSON.stringify({ version: 1, pipe, pid: process.pid, started: Date.now() }));
    });
  }
  const want = portOf(settings);
  if (httpServer && port === want) return;
  stopHttp();
  port = want;
  httpError = null;
  const server = http.createServer((req, res) => onHttp(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }));
  server.on('error', (e) => {
    httpError = e.code === 'EADDRINUSE' ? `Port ${want} is in use by another program. Pick another port.` : e.message;
    if (httpServer === server) httpServer = null;
  });
  server.listen(want, '127.0.0.1');
  httpServer = server;
  sweep = setInterval(() => {
    for (const s of [...httpSessions.values()]) if (Date.now() - s.seen > IDLE_MS && ![...pending.values()].some((p) => p.session === s)) drop(s);
  }, 60000);
  sweep.unref();
}

function stop() {
  stopHttp();
  port = null;
  httpError = null;
  if (!pipeServer) return;
  pipeServer.close();
  pipeServer = null;
  for (const s of [...sessions]) s.close();
  fs.rmSync(infoFile(), { force: true });
}

/** Starts, restarts (a new port) or stops the server to match settings.agent. */
function sync(settings) {
  if (settings?.agent?.enabled) start(settings);
  else stop();
}

/** Settings > Local AI agents: whether it is on, the URL while the port listens or the reason it does not, and the stdio
 * command (the app's own executable run as Node, so no Node install is needed). */
function status() {
  return {
    on: !!pipeServer,
    port,
    url: httpServer?.listening ? `http://127.0.0.1:${port}/mcp` : null,
    error: httpError,
    stdio: { command: process.execPath, args: [BRIDGE, `--pipe=${pipePath()}`], env: { ELECTRON_RUN_AS_NODE: '1' } },
  };
}

/** The IPC of the server; `handle` is main.js's sender-checked ipcMain.handle, `win()` the main window. */
function register(handle, win) {
  getWin = win;
  const fromMain = (e) => e.sender === getWin()?.webContents;
  ipcMain.on('agent.ready', (e) => {
    if (!fromMain(e)) return;
    ready = true;
    for (const s of sessions) toRenderer(connected(s));
    for (const [rid, req] of waiting.splice(0)) dispatch(rid, req);
  });
  ipcMain.on('agent.reply', (e, rid, result) => fromMain(e) && answer(rid, result));
  handle('agent.disconnect', (id) => [...sessions].find((s) => s.id === id)?.close());
  handle('agent.status', status);
  app.on('will-quit', stop);
}

module.exports = { register, sync, PORT };
