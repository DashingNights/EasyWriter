// Waiting for the canvas page area to open the draft it was just handed (docs/plans/engine/stage3-forum.md C5): an agent's or
// the smoke script's call runs the render after drafts.create opens a forum post, so it waits for the engine session instead of
// reporting busy. Pure: a poll of a reader and the caller's AbortSignal, so a Stop cancels it (commands.js runOne). Returns the
// session's client, or false (still opening, the page area is not showing the draft, or the call was cancelled).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits up to `ms` for the client of draft `id` to appear, reading `read()` (→ {focus, areaOpens, draftId}) every `every` ms.
 * Stops at once when `signal` aborts (false), when the page area is not showing the draft, or the open draft changed. */
export async function engineSoon({ id, read, signal, ms = 20000, every = 50 }) {
  const end = Date.now() + ms;
  for (;;) {
    if (signal?.aborted) return false;
    const s = read();
    if (s.focus && s.focus.id === id) return s.focus;
    if (!s.areaOpens || s.draftId !== id || Date.now() >= end) return false;
    await sleep(every);
  }
}
