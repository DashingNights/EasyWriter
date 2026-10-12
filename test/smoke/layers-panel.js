'use strict';
// Layers panel smoke (§6c Layers panel; the black screen of 2026-10-12): a whiteboard with a text, a shape, an image and a
// group, the panel open, the image row clicked, then a click back out on the board, in the document text and on the rail's
// Layers button. Each must leave the app on screen with no uncaught error and no error boundary. Real input events
// (sendInputEvent) on a throwaway profile (.smoke-data/layers-panel), the window on screen, inactive, ignoring the mouse.
// Manual, never part of npm test:
//   npm run build && npx electron test/smoke/layers-panel.js
// Exit 0 when every step passes; each step is printed.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const UD = path.join(ROOT, '.smoke-data', 'layers-panel');
fs.rmSync(UD, { recursive: true, force: true });
fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({ onboarded: true }));
process.argv.push(`--data-dir=${UD}`); // main.js: this profile, never the real one
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('session-created', (s) => s.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
  (d, cb) => cb({ cancel: !/^http:\/\/127\.0\.0\.1[:/]/.test(d.url) })));
require(path.join(ROOT, 'src', 'dictation-main.js')).warmAtStart = () => {}; // no whisper server

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleErrors = [];
let failed = 0;
let started = false;
app.on('browser-window-created', (_, win) => {
  if (started) return;
  started = true;
  win.show = () => win.showInactive();
  win.webContents.on('console-message', (e) => e.level === 'error' && consoleErrors.push(String(e.message).slice(0, 600)));
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('FAIL renderer gone', d.reason);
    app.exit(1);
  });
  win.webContents.once('did-finish-load', () => run(win).then(() => app.exit(failed ? 1 : 0), (e) => {
    console.log('FAIL', e.stack);
    app.exit(1);
  }));
});
setTimeout(() => {
  console.log('FAIL timeout');
  app.exit(2);
}, 120000);
require(path.join(ROOT, 'main.js'));

async function run(win) {
  const wc = win.webContents;
  const J = async (s) => JSON.parse(await wc.executeJavaScript(`Promise.resolve(${s}).then((v) => JSON.stringify(v) ?? 'null')`, true));
  const R = Math.round;
  win.setIgnoreMouseEvents(true);
  wc.setBackgroundThrottling(false);
  win.setContentSize(1600, 1000);
  win.showInactive();
  for (let i = 0; i < 200 && !(await J(`!!window.__agent && !!document.querySelector('#editor .ProseMirror')`)); i++) await wait(100);
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); // the board takes the focus inactive
  await J(`(window.__errs = [], window.addEventListener('error', (e) => window.__errs.push(String(e.error?.stack ?? e.message))), 1)`);
  const invoke = (id, args = {}) => J(`window.__agent.invoke({ id: ${JSON.stringify(id)}, args: ${JSON.stringify(args)}, source: 'ui' })`);
  const click = async (p) => {
    wc.sendInputEvent({ type: 'mouseMove', x: R(p.x), y: R(p.y) });
    await wait(30);
    wc.sendInputEvent({ type: 'mouseDown', x: R(p.x), y: R(p.y), button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: R(p.x), y: R(p.y), button: 'left', clickCount: 1 });
    await wait(300);
  };
  const at = (sel) => J(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect();
    return r && { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.right, b: r.bottom }; })()`);
  const check = async (label) => {
    await wait(200);
    const s = await J(`({ shell: !!document.querySelector('#editor-area'), errs: window.__errs.splice(0) })`);
    const errs = [...s.errs, ...consoleErrors.splice(0)];
    const ok = s.shell && !errs.length;
    if (!ok) failed++;
    console.log(ok ? 'ok  ' : 'FAIL', label, ok ? '' : JSON.stringify({ shell: s.shell, errs }));
  };

  const png = await J(`(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 30;
    c.getContext('2d').fillRect(0, 0, 40, 30); return c.toDataURL(); })()`);
  await invoke('drafts.create');
  await invoke('doc.insert', { at: 'end', content: { markdown: 'Text before the board.' } });
  const { result: { path: board } } = await invoke('board.insert', { kind: 'whiteboard', at: 'end' });
  await invoke('board.items.add', { path: board, items: [
    { type: 'text', html: 'Text', x: 20, y: 20, w: 200 },
    { type: 'shape', shape: 'rect', x: 40, y: 120, w: 160, h: 100 },
    { type: 'image', src: png, x: 300, y: 40, w: 200, h: 150 },
    { type: 'shape', shape: 'rect', x: 600, y: 40, w: 80, h: 60, groups: ['g'] },
    { type: 'shape', shape: 'ellipse', x: 700, y: 40, w: 80, h: 60, groups: ['g'] }] });
  await wait(500);
  const wb = await at('.wb');
  const empty = { x: wb.r - 30, y: wb.b - 30 };
  await click(empty); // the board becomes the active one
  await invoke('tool.run', { id: 'layers' });
  await check('panel open');
  const IMAGE = `[...document.querySelectorAll('div[aria-label="Layers"] [data-layer] > div')].find((e) => e.textContent === 'Image')`;
  const image = () => J(`(() => { const r = ${IMAGE}?.getBoundingClientRect(); return r && { x: r.left + 60, y: r.top + r.height / 2 }; })()`);

  await click(await image());
  await check('image row clicked');
  await click(empty);
  await check('then the board clicked');

  await click(await image());
  await click(await at('#editor .ProseMirror p'));
  await check('image row, then the document text clicked');

  await click(empty);
  await click(await image());
  await click(await at('[role=toolbar] [aria-label="Layers"]'));
  await check('image row, then the panel closed from the rail');
}
