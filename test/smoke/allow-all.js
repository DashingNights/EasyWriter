'use strict';
// Allow all smoke (SPEC §8 Policy, Calls): the executor runs a deletion the in-app assistant asks for with no card in Allow all
// (drafts.delete, a batch holding doc.delete, ui.invoke on "Delete draft" with the app's own confirm), Standard still asks, and
// one calls call runs a read and two drafts' changes. Throwaway profile (.smoke-data/allow-all), the window on screen, inactive,
// ignoring the mouse, network blocked but 127.0.0.1. Manual, never part of npm test:
//   npm run build && npx electron test/smoke/allow-all.js
// Exit 0 when every step passes; each step is printed.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const UD = path.join(ROOT, '.smoke-data', 'allow-all');
fs.rmSync(UD, { recursive: true, force: true });
fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({ onboarded: true, demoSeeded: true, assistant: { permission: 'all' } }));
process.argv.push(`--data-dir=${UD}`); // main.js: this profile, never the real one
app.on('session-created', (s) => s.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
  (d, cb) => cb({ cancel: !/^http:\/\/127\.0\.0\.1[:/]/.test(d.url) })));
require(path.join(ROOT, 'src', 'dictation-main.js')).warmAtStart = () => {}; // no whisper server

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let started = false;
app.on('browser-window-created', (_, win) => {
  if (started) return;
  started = true;
  win.show = () => win.showInactive();
  win.webContents.once('did-finish-load', () => run(win).then(() => app.exit(failed ? 1 : 0), (e) => {
    console.log('FAIL', e.stack);
    app.exit(1);
  }));
});
setTimeout(() => {
  console.log('FAIL timeout');
  app.exit(2);
}, 90000);
require(path.join(ROOT, 'main.js'));

async function run(win) {
  const wc = win.webContents;
  const J = async (s) => JSON.parse(await wc.executeJavaScript(`Promise.resolve(${s}).then((v) => JSON.stringify(v) ?? 'null')`, true));
  win.setIgnoreMouseEvents(true);
  win.setContentSize(1600, 1000);
  win.showInactive();
  for (let i = 0; i < 200 && !(await J(`!!window.__agent && !!document.querySelector('#editor .ProseMirror')`)); i++) await wait(100);
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); // ui.invoke wants the window focused
  const invoke = (id, args = {}, source = 'agent:assistant') => J(`window.__agent.invoke(${JSON.stringify({ id, args, source })})`);
  const check = (label, ok, got) => {
    if (!ok) failed++;
    console.log(ok ? 'ok  ' : 'FAIL', label, ok ? '' : JSON.stringify(got).slice(0, 800));
  };
  const card = () => J(`!!document.querySelector('[data-agent-ask]') || [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Deny')`);
  const draft = async (title) => (await invoke('drafts.create', { content: { markdown: `# ${title}` } }, 'ui')).result.draftId;

  // 1. drafts.delete in Allow all: no card, done at once.
  const a = await draft('Allow all one');
  let t0 = Date.now();
  let r = await invoke('drafts.delete', { draftId: a });
  check('drafts.delete runs with no card', r.ok && Date.now() - t0 < 5000, r);

  // 2. A batch holding a delete in Allow all.
  await invoke('doc.insert', { at: 'end', content: { markdown: 'One\n\nTwo' } });
  r = await invoke('batch', { steps: [{ id: 'doc.delete', args: { paths: [[0]] } }, { id: 'doc_insert', args: { at: 'end', content: { markdown: 'Three' } } }] });
  check('batch with doc.delete runs with no card', r.ok && r.result.results.length === 2, r);

  // 3. calls: a read, a change in the open draft and one in another draft, each with its own result and undo step.
  const b = await draft('Other draft');
  const c = await draft('Open draft');
  r = await invoke('calls', { steps: [{ id: 'drafts_list' }, { id: 'doc.insert', args: { at: 'end', content: { markdown: 'Here' } } },
    { id: 'doc.insert', args: { draftId: b, at: 'end', content: { markdown: 'There' } } }, { id: 'nope' }] });
  const res = r.result?.results ?? [];
  check('calls runs each step alone', r.ok && res.length === 4 && res[0].ok && res[1].ok && res[1].undoSteps === 1 && res[1].draftId === c
    && res[2].ok && res[2].draftId === b && res[3].error?.code === 'unknown_command', r);

  // 4. ui.invoke on the row's "Delete draft": the app's confirm passes unseen in Allow all.
  const snap = await invoke('ui.snapshot', { query: 'Delete draft' });
  const item = JSON.stringify(snap).match(/"ref":"([^"]+)"[^}]*"name":"Delete draft"/) ?? JSON.stringify(snap).match(/"name":"Delete draft"[^}]*"ref":"([^"]+)"/);
  const before = (await invoke('drafts.list', {}, 'ui')).result;
  r = item ? await invoke('ui.invoke', { ref: item[1], action: 'click' }) : snap;
  await wait(800);
  const after = (await invoke('drafts.list', {}, 'ui')).result;
  const count = (l) => (Array.isArray(l) ? l : l?.drafts ?? []).length;
  check('ui.invoke Delete draft confirms by itself', r.ok && !(await J('!!document.querySelector(\'[role="alertdialog"]\')')) && count(after) === count(before) - 1,
    { r, before: count(before), after: count(after) });

  // 5. Standard still asks: the card shows; the call is cancelled.
  await J(`window.api.settings.set({ assistant: { permission: 'standard' } })`);
  wc.reload(); // the renderer reads settings at start
  await wait(500);
  for (let i = 0; i < 200 && !(await J(`!!window.__agent && !!document.querySelector('#editor .ProseMirror')`)); i++) await wait(100);
  await J(`(window.__ctl = new AbortController(), window.__p = window.__agent.invoke({ id: 'drafts.delete', args: { draftId: ${JSON.stringify(b)} },
    source: 'agent:assistant', signal: window.__ctl.signal }), 1)`);
  await wait(800);
  const asked = await card();
  await J('(window.__ctl.abort(), 1)');
  r = await J('window.__p');
  check('Standard asks on a card', asked && r.error?.code === 'cancelled', { asked, r });
}
