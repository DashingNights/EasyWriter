// The title strip (SPEC §7, .titlebar in app.css) covers the window's top 34 px, and the native window controls draw over
// it: popups (tooltips, menus, lists, popovers, palettes) treat it as outside the window, so they flip or shift below it.
export const TITLEBAR = 34;
export const COLLISION = { top: TITLEBAR };
