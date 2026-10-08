#!/usr/bin/env node
'use strict';
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// daf-agent: the stdio side of EasyWriter's MCP server (SPEC §8 Agents), for MCP clients that start their server themselves.
// It relays stdin to the app's pipe and the pipe to stdout, line by line (both speak newline-delimited JSON-RPC 2.0); the app
// (src/agent-server.js) answers everything. Stdlib only, so the app's own executable can run it with ELECTRON_RUN_AS_NODE=1
// (the config Settings > Local AI agents shows). The pipe: --pipe=<path>, else the one userData/agent.json names
// (DAF_WRITER_USERDATA overrides the folder). While the app does not listen, every request is answered with an error saying so.

const OFF = 'EasyWriter is not running, or its agents are off. Start the app and turn on Settings > Local AI agents.';
const APP_DATA = process.platform === 'win32' ? process.env.APPDATA
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

function pipePath() {
  const arg = process.argv.find((a) => a.startsWith('--pipe='));
  if (arg) return arg.slice(7);
  const dir = process.env.DAF_WRITER_USERDATA || path.join(APP_DATA, 'EasyWriter');
  return JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')).pipe;
}

function lines(stream, fn) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) fn(line);
    }
  });
}

let socket = null;
let queue = null; // lines read while connecting
let ended = false;
const open = new Set(); // ids of requests the app has not answered

const out = (line) => process.stdout.write(`${line}\n`);
const quitIfDone = () => ended && !open.size && process.exit(0);

/** Answers every open request with OFF: the app is not there, or it closed the pipe. */
function fail() {
  for (const id of open) out(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: OFF } }));
  open.clear();
  queue = null;
  socket = null;
  quitIfDone();
}

function toApp(line) {
  if (socket && !queue) return socket.write(`${line}\n`);
  if (queue) return queue.push(line);
  let pipe;
  try {
    pipe = pipePath();
  } catch {
    return fail();
  }
  queue = [line];
  const s = net.connect(pipe);
  socket = s;
  s.on('connect', () => {
    for (const l of queue) s.write(`${l}\n`);
    queue = null;
  });
  s.on('error', () => {});
  s.on('close', () => socket === s && fail());
  lines(s, (l) => {
    try {
      const msg = JSON.parse(l);
      if (!('method' in msg)) open.delete(msg.id);
    } catch { /* passed on as it came */ }
    out(l);
    quitIfDone();
  });
  return undefined;
}

lines(process.stdin, (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method && msg.id !== undefined) open.add(msg.id);
  } catch { /* the app answers the parse error */ }
  toApp(line);
});
process.stdin.on('end', () => {
  ended = true;
  quitIfDone();
});
