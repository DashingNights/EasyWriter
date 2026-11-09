// The sidebar's slide (motion 'sidebar', App.jsx): while it runs, the main column changes width on every frame, and a reader
// that only needs the settled size (the ribbon's fit, the viewport box, the assistant's frame) waits for the end instead of
// re-rendering on each frame, which would hold every frame to the main thread's pace. Those readers place things from the
// column's right and bottom edges or relative to the editor area, so their last values stay right while it moves.

let until = 0;
let timer = 0;
const waiting = new Set();

/** Starts a slide of `ms`: readers asking afterSlide wait until it ends. */
export function slide(ms) {
  if (!ms) return;
  until = performance.now() + ms;
  clearTimeout(timer);
  timer = setTimeout(() => {
    until = 0;
    const fns = [...waiting];
    waiting.clear();
    fns.forEach((fn) => fn());
  }, ms + 16);
}

/** During a slide: queues `fn` (once) for its end → true; otherwise → false, and the caller reads now. */
export const afterSlide = (fn) => (performance.now() < until ? (waiting.add(fn), true) : false);
