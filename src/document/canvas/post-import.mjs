// What the forum import checks before it writes a post draft (docs/plans/engine/stage3-forum.md C4): the canvas engine's own
// answer when it hosts posts, the DOM kit's schema check otherwise. The engine is the post's editor once it hosts posts, so a
// post it would change (a reply chain quoted past nine levels, a mark it drops) must not be written; with the flag off the
// import must not need the engine at all, so the DOM kit decides exactly as before. Node tests load this: it opens a session
// only through the `quiet` opener, and only when the engine hosts posts.
import { withQuietSession } from '../../engine/quiet.mjs';
import { checkPost, postSource, postsOn } from './post.js';

/** Why the canvas engine would not keep imported post `draft` as it is (null: it keeps it): the same check a DOM post passes
 * before it moves (checkPost), in a quiet session of its own. `quiet` is the session opener (a test's stand-in). */
export async function engineProblem(draft, settings, quiet = withQuietSession) {
  try {
    return await quiet(draft, { source: (d) => postSource(d, settings) }, async (client) => {
      await checkPost(client, draft, settings);
      return null;
    });
  } catch (e) {
    return String(e.message || e);
  }
}

/** Why imported post `draft` cannot be written (null: it can). The engine's answer when it hosts posts (postsOn, the state's
 * settings.postEngine for the harness cases), else `schema` (the DOM kit's check for the post, which throws what it cannot
 * hold), so an import with the flag off reads no engine. */
export async function importProblem(draft, state, schema, quiet) {
  if (!postsOn(state)) {
    schema();
    return null;
  }
  return engineProblem(draft, state.settings, quiet);
}
