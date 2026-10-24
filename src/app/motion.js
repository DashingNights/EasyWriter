// The app's animations by name, each with its length in ms. A reduced-motion preference sets every one to 0, and
// settings.motion turns them off one by one ({name: false}); that switch is not in Settings yet (a reduced motion setting and
// its tuning come later). CSS reads them as --motion-<name> on <html> (`duration-(--motion-menus)`), script as motion(name).
export const MOTION = {
  menus: 90, // menus, selects, popovers, tool flyouts, quick tools and tool search: tools, so super quick
  tooltips: 90, // tooltips and hover hints
  dialogs: 160, // dialogs and alert dialogs, with their overlay
  pages: 140, // the editor and the workspace pages fading in when shown
  islands: 150, // an island's row appearing (the toolbar's More tools)
  panel: 280, // the assistant panel's open and close sequence (Chat.jsx)
  pane: 1, // the dictation pane's close and open sequences (their own lengths, dictation.js CLOSE_STEPS): 0 turns them off
};

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let off = {}; // settings.motion

/** The length of animation `name` in ms; 0 when it is turned off or motion is reduced. */
export const motion = (name) => (reduced.matches || off[name] === false ? 0 : MOTION[name]);

/** Sets the CSS lengths from `settings` (settings.motion); again when the reduced-motion preference changes. */
export function applyMotion(settings = off) {
  off = settings ?? {};
  for (const name of Object.keys(MOTION)) document.documentElement.style.setProperty(`--motion-${name}`, `${motion(name)}ms`);
}

applyMotion({}); // before the first render: the lengths exist from the start
reduced.addEventListener('change', () => applyMotion());
