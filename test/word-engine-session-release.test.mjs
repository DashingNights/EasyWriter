// engine-session-release (docs/plans/word/briefs/engine-session-release.md): only the page area holds a draft's engine session,
// and the assistant's background sessions while they edit a draft no page area shows. Every other reader (a pane, an overlay, a
// card, a ruler, a tool layer, a status bar item, a command) reaches the session through a watcher, which never keeps it open,
// so a draft switch leaves one session in the worker. engine-undo-file removed two holders; content-controls/marks.jsx
// (engine-gaps-editing) and navpane/folds.jsx (engine-gaps-review) brought them back, and this test names any next one.
// The harness case .smoke-data/word/cases/engine-session-release.js checks the same with every pane and overlay open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = new URL('../src/', import.meta.url);

/** The files that may hold a session (EngineHost.session): the page area, the assistant's background sessions, the engine's own
 * warm-up draft, the quiet session a job opens for itself and releases when it ends (engine/quiet.mjs: the forum import's check
 * and fill), and a board's area (`board:<draftId>` paints the items, `item:<draftId>` builds their models; both are the board's
 * own ids and go with its unmount, docs/plans/board/briefs/bd-area.md). */
const HOLDERS = new Set(['document/canvas/session.js', 'app/assistant/sessions.js', 'engine/client.js', 'engine/quiet.mjs',
  'board/BoardArea.jsx']);

test('only a page area (a Document\'s or a board\'s) and the assistant\'s background sessions hold a draft\'s engine session', () => {
  const found = [];
  for (const f of fs.readdirSync(SRC, { recursive: true })) {
    const rel = f.split(path.sep).join('/');
    if (!/\.(m?js|jsx)$/.test(rel) || HOLDERS.has(rel) || rel.startsWith('engine/wasm/')) continue;
    fs.readFileSync(new URL(rel, SRC), 'utf8').split('\n').forEach((line, i) => {
      if (/\.session\(/.test(line)) found.push(`src/${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, [], 'These hold a draft\'s engine session, so it stays open after a draft switch. Read the draft through a '
    + 'watcher instead: engineHost().watch(id), released when done, or useSessionWatch(id) in a component (src/tooling/engine-value.js).');
});
