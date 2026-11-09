// A pure engine read for a pane: query an id on a canvas draft's session and read it again after each change. A read after a
// layout waits until typing pauses (afterTyping), so a keystroke never pays for a pane (docs/plans/engine/stage2b.md rule 6).
// A reopen or a pane's own command (review., nav., file. and the rest) is read at once, so the pane shows the result of its
// action without a lag. The keys' command families wait like a layout: a held Delete or Ctrl+B at a caret posts 'command' on
// every keystroke (worker.js).
import { useEffect, useMemo, useState } from 'react';
import { afterTyping } from '../app/store.js';
import { engineHost } from '../engine/client.js';

/** React hook: a watcher of draft `id`'s session (EngineHost.watch) while the component is mounted, released when it unmounts or
 * `id` changes; null for a null id. How a component reads a draft other than through the focused session: it hears the session
 * while the page area holds it and never keeps it open, so a draft switch leaves one session (engine-session-release). */
export function useSessionWatch(id) {
  const client = useMemo(() => (id == null ? null : engineHost().watch(id)), [id]);
  useEffect(() => () => client?.release(), [client]);
  return client;
}

/** The command families the keyboard sends (src/engine/input): typing and editing keys, which never read a pane at once. */
const KEYS = /^(caret|select|text|edit|format|para|document)\./;

/** The value of engine query `id` with `args` on `session` (a SessionClient), or null until it answers or when it fails. It is
 * read again at once after a 'reopened' event or a 'command' outside the KEYS families, and otherwise once typing pauses. */
export function useEngineValue(session, id, args = {}) {
  const [value, setValue] = useState(null);
  const key = JSON.stringify(args);
  useEffect(() => {
    if (!session) return undefined;
    let live = true;
    const read = async () => {
      const r = await Promise.resolve(session.query(id, JSON.parse(key))).catch(() => null);
      if (live) setValue(r?.value ?? null);
    };
    read();
    const offs = [
      session.on?.('layout', () => afterTyping(read)),
      session.on?.('command', (e) => (KEYS.test(e?.id ?? '') ? afterTyping(read) : read())),
      session.on?.('reopened', () => read()),
    ];
    return () => {
      live = false;
      offs.forEach((off) => off?.());
    };
  }, [session, id, key]);
  return value;
}
