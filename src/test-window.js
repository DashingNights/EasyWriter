'use strict';
// Test runs (--smoke, and the scripted harnesses, which start main.js with --data-dir) never take the focus: every show is
// inactive, on the second screen when there is one (the user works on the primary). Chromium's occlusion tracking and
// background throttling are off for them, so a covered window still paints and reports document.visibilityState 'visible'
// (the window.visible gate, SPEC §8).
const { app, screen } = require('electron');

/** Before ready: a covered test window keeps painting, and an uncaught error (in the app or in a harness script's own code) is
 * logged and ends the run with exit code 1 instead of opening Electron's error dialog on the user's screen. */
exports.prepare = () => {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  process.on('uncaughtException', (e) => {
    console.error('Uncaught exception in a test run:', e);
    app.exit(1);
  });
};

/** `win` never takes the focus when it is shown, and sits centred on the first screen that is not the primary, shrunk to fit
 * its work area; with one screen it stays where it is. */
exports.keepBehind = (win) => {
  win.webContents.setBackgroundThrottling(false);
  win.show = win.showInactive.bind(win);
  const primary = screen.getPrimaryDisplay().id;
  const other = screen.getAllDisplays().find((d) => d.id !== primary);
  if (!other) return;
  const a = other.workArea;
  const [w, h] = win.getSize();
  const width = Math.min(w, a.width);
  const height = Math.min(h, a.height);
  win.setBounds({ x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width, height });
};
