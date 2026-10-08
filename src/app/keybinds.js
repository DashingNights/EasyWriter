import { chordOf, DEFS, effective } from './keys.mjs';

// The keybinds in force (SPEC §7k): the registry's defaults (keys.mjs DEFS) with settings.keybinds over them. actions.js
// applySettings sets them; every key handler asks keyIs(id, event); tooltips and tool search show keyLabel(id). No React
// here (whiteboard.js, which the Node tests load, imports it): components re-render through useSyncExternalStore(subscribeKeybinds,
// keybindsVersion).

let binds = effective(DEFS);
let version = 0;
const listeners = new Set();

/** The user's overrides (settings.keybinds) applied; the app re-renders (App.jsx), so labels follow. */
export function setKeybinds(overrides) {
  binds = effective(DEFS, overrides);
  version += 1;
  for (const fn of listeners) fn();
}

/** Calls `fn` after each change of the keybinds; returns the unsubscribe function. */
export function subscribeKeybinds(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A number that changes with every change of the keybinds (useSyncExternalStore's snapshot). */
export const keybindsVersion = () => version;

/** The chords of binding `id` ([] when unbound). */
export const keysOf = (id) => binds[id] ?? [];

/** Whether key event `e` is one of binding `id`'s chords. */
export function keyIs(id, e) {
  const c = chordOf(e);
  return !!c && keysOf(id).includes(c);
}

/** The binding among `ids` that key event `e` (or chord string `e`) is, or null. */
export function keyAmong(ids, e) {
  const c = typeof e === 'string' ? e : chordOf(e);
  return c ? ids.find((id) => keysOf(id).includes(c)) ?? null : null;
}

/** Binding `id`'s first chord, for labels ('' when unbound). */
export const keyLabel = (id) => keysOf(id)[0] ?? '';

/** `title` with binding `id`'s chord after it in brackets, as tooltips show shortcuts ("Undo (Ctrl+Z)"). */
export const withKey = (title, id) => (keyLabel(id) ? `${title} (${keyLabel(id)})` : title);
