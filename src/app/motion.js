// The app's animations by name, in the order Settings > Motion lists them: [name, length in ms, label, what it covers].
// settings.reduceMotion is off (every one plays), system (the OS's reduced motion setting), on (none plays) or custom, where
// settings.motion turns them off one by one ({name: false}). CSS reads the lengths as --motion-<name> on <html>
// (`duration-(--motion-menus)`; a bare transition-* takes --motion-controls, app.css), script as motion(name). What has no
// length to set (spinners and pulses, sonner's toasts, the gap cursor) stops under [data-still~=<name>] on <html> (app.css).
// Not ours to set: Chromium's smooth wheel scrolling (a process-wide switch), the text caret's blink and the title bar's
// window buttons (Windows'), a drag's edge autoscroll (it moves the view to where the drag is going), and sonner's toasts
// under the OS's reduced motion even when reduce motion is off (sonner's own !important rule).
export const MOTION = [
  ['menus', 90, 'Menus', 'Menus, selects, popovers, quick tools and tool search opening'],
  ['tooltips', 90, 'Tooltips', 'Tooltips and hover hints'],
  ['dialogs', 160, 'Dialogs', 'Dialogs and their backdrop'],
  ['pages', 140, 'Pages', 'The editor and the plans and flowcharts pages fading in'],
  ['islands', 150, 'Islands', "The toolbar's More tools row and the left rail changing height"],
  ['panel', 280, 'Assistant panel', 'The chat panel opening and closing'],
  // The transcript card's growth; the minimize and restore sequences have their own lengths (dictation.js CLOSE_STEPS).
  ['pane', 300, 'Dictation pane', 'Minimizing and restoring it, and the transcript growing'],
  ['notices', 1000, 'Notices', 'Notices above the toolbar fading out, and toasts'],
  ['controls', 150, 'Controls', 'Hover, focus and on or off changes of buttons, switches and fields'],
  ['status', 150, 'Status', 'Spinners, pulses, progress bars, the Deny countdown and blinking carets'],
  ['levels', 1, 'Mic levels', 'The level bars while you dictate'], // an on / off flag
  ['scroll', 1, 'Smooth scrolling', 'Settings scrolling to a section'], // an on / off flag: Chromium sets the length
];

const LENGTH = Object.fromEntries(MOTION.map(([name, ms]) => [name, ms]));
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let mode = 'system'; // settings.reduceMotion
let off = {}; // settings.motion, for custom

const still = (name) => mode === 'on' || (mode === 'system' && reduced.matches) || (mode === 'custom' && off[name] === false);

/** The length of animation `name` in ms; 0 when it does not play. */
export const motion = (name) => (still(name) ? 0 : LENGTH[name]);

// The last settings, kept for the first frames of the next start (before the settings load), as the palette is.
const KEY = 'daf-writer.motion';

/** Sets the CSS lengths and data-still from `settings`; again (with the last ones) when the OS's preference changes. */
export function applyMotion(settings) {
  if (settings) {
    mode = settings.reduceMotion ?? 'system';
    off = settings.motion ?? {};
    try { localStorage.setItem(KEY, JSON.stringify({ reduceMotion: mode, motion: off })); } catch {}
  }
  const root = document.documentElement;
  for (const [name] of MOTION) root.style.setProperty(`--motion-${name}`, `${motion(name)}ms`);
  root.dataset.still = MOTION.filter(([name]) => still(name)).map(([name]) => name).join(' ');
}

const cached = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
};
applyMotion(cached()); // before the first render: the lengths exist from the start
reduced.addEventListener('change', () => applyMotion());
