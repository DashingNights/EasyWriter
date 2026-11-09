// A draft opened in a quiet session for work no page area shows, released after it (engine-session-release: the page area and the
// assistant's background sessions hold sessions; a job of its own, like the forum import's check or fill, holds one only while it
// runs). Quiet: its layout goes out to no view.
import { engineHost } from './client.js';
import { openDraft } from './model/form.mjs';

/** A quiet session's id: its own, never a draft's and never another call's. Two imports at once must not share one session, so
 * they cannot overwrite each other's draft. */
export const quietSessionId = () => `quiet-${globalThis.crypto.randomUUID()}`;

/** Opens `draft` in a quiet session of `host` for `fn(client)`, releases it after, and resolves what `fn` resolved. */
export async function withQuietSession(draft, deps, fn, host = engineHost()) {
  const client = host.session(quietSessionId());
  try {
    await client.quiet(true);
    await openDraft(client, draft, deps);
    return await fn(client);
  } finally {
    client.release();
  }
}
