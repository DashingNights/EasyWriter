// Forced colours (Windows High Contrast, docs/plans/engine/viewport-design.md section 7): while `(forced-colors: active)` matches,
// the system's text and paper colours, read from a probe's computed style, so the engine paints pages in them as the DOM editor's
// follow the theme. Plain web code.

/** `rgb(r, g, b)` (a computed colour) → '#rrggbb', or null. */
export function hex(css) {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css ?? '');
  return m ? `#${m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}` : null;
}

/** Calls `fn({text, paper})` with the system's CanvasText and Canvas while forced colours are on, `fn(null)` while they are off:
 * now and at every change → a function that stops. */
export function watchForcedColors(doc, fn) {
  const mq = doc.defaultView?.matchMedia?.('(forced-colors: active)');
  if (!mq) return () => {};
  const read = () => {
    if (!mq.matches) return fn(null);
    // forced-color-adjust: none, or the probe's own colours would be forced too and read the same whatever the theme.
    const probe = doc.createElement('div');
    probe.style.cssText = 'position:absolute;width:0;height:0;color:CanvasText;background-color:Canvas;forced-color-adjust:none';
    doc.body.append(probe);
    const cs = doc.defaultView.getComputedStyle(probe);
    const colors = { text: hex(cs.color), paper: hex(cs.backgroundColor) };
    probe.remove();
    fn(colors.text && colors.paper ? colors : null);
  };
  mq.addEventListener('change', read);
  read();
  return () => mq.removeEventListener('change', read);
}
