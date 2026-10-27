'use strict';
// The README's pictures and the installer's: banners and download buttons (docs/img, README.md), the repository's social
// preview (docs/img/social.jpg, uploaded by hand in the repository's settings) and the installer's sidebar and header
// (build/installer*.bmp). The app runs on a throwaway profile holding a demo project (a level design document with a canvas,
// a flowchart and a plan) and is captured at 2x; banner pages lay the captures out and are captured in turn.
//   npm run readme-art               everything
//   npm run readme-art -- --layout   the banners again from the last captures, to work on their layout
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const UD = path.join(ROOT, '.smoke-data', 'readme-art');
const SHOTS = path.join(ROOT, '.smoke-data', 'readme-art-shots'); // kept for --layout
const IMG = path.join(ROOT, 'docs', 'img');
const LAYOUT = process.argv.includes('--layout');
const VIEW = { width: 1440, height: 900 }; // the app's window in CSS px; captured at twice that

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (e) => {
  console.error('readme-art failed:', e?.stack ?? e);
  app.exit(1);
};

// ---------------------------------------------------------------------------------------------
// The demo project

const PROJECT = 'project:5b0e7a4c-2f1d-4c8e-9a3b-6d7f8e9a0b1c';
const PLAN = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

/** The project's plan, dated round today: week 1 done, week 2 under way, weeks 3 and 4 to come. */
function plan() {
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7 + n); // n days after the Monday a week ago
    return d.toISOString().slice(0, 10);
  };
  const id = (n) => `7c1d2e3f-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const after = (...ns) => ns.map((n) => ({ on: id(n), type: 'FS', lag: 0 }));
  const ticket = (n, title, status, labels, start, end, more = {}) => ({
    id: id(n), num: n, title, status, priority: 0, labels, estimate: null, unit: 'd', start: day(start), end: day(end), milestone: false,
    progress: { done: 100, review: 90, progress: 40 }[status] ?? 0, parent: null, deps: [], checklist: [], draftId: null, urls: [],
    description: '', baseline: null, completedAt: status === 'done' ? Date.now() : null, ...more,
  });
  const [art, code, design, audio] = ['a1b2c3d', 'c4d5e6f', 'd7e8f9a', 'e1f2a3b'];
  const tickets = [
    ticket(1, 'One-page design', 'done', [design], 0, 1, { priority: 2 }),
    ticket(2, 'Blockout: harbour and market', 'done', [design], 2, 4, { deps: after(1) }),
    ticket(3, 'Guard patrol and chase', 'progress', [code], 7, 10, { priority: 3, deps: after(2) }),
    ticket(4, 'Lighthouse tower model', 'progress', [art], 7, 11),
    ticket(5, 'Lamp puzzle', 'review', [code, design], 9, 11, { priority: 1 }),
    ticket(6, 'Storm and rain effects', 'todo', [art], 14, 16, { deps: after(4) }),
    ticket(7, 'Wind and rain sounds', 'todo', [audio], 14, 15),
    ticket(8, 'First playtest', 'todo', [design], 17, 18, { priority: 2, deps: after(3, 5) }),
    ticket(9, 'Fixes from the playtest', 'todo', [code], 21, 23, { deps: after(8) }),
    ticket(10, 'Submission', 'todo', [], 25, 25, { milestone: true, priority: 1, deps: after(9) }),
  ];
  return {
    version: 1, id: PLAN, threadUrl: PROJECT, title: 'The Lighthouse', seq: tickets.length,
    calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], weekOne: day(0) },
    columns: [
      { id: 'todo', name: 'To do', color: '#e5e5e5', tagId: 'todo', wip: null },
      { id: 'progress', name: 'In progress', color: '#3d99f5', tagId: 'progress', wip: 3 },
      { id: 'review', name: 'Review', color: '#e09952', tagId: null, wip: null },
      { id: 'done', name: 'Done', color: '#62d926', tagId: 'done', wip: null },
    ],
    doneColumn: 'done', units: [], estimateUnit: 'd', autoSchedule: false,
    labels: [{ id: art, name: 'Art', color: '#e09952' }, { id: code, name: 'Code', color: '#3d99f5' }, { id: design, name: 'Design', color: '#9673a6' },
      { id: audio, name: 'Audio', color: '#62b36b' }],
    views: [], order: tickets.map((t) => t.id), tickets, baselineAt: null, created: Date.now(), updated: Date.now(),
  };
}

// A top-down map of the level, drawn here so the README shows no one else's pictures: the island, the harbour, the market,
// the cliff path and the lighthouse, under a storm.
const MAP = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700" viewBox="0 0 1200 700">
<defs>
  <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16375c"/><stop offset="1" stop-color="#1f6390"/></linearGradient>
  <linearGradient id="beam" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#fff3a6" stop-opacity=".9"/><stop offset="1" stop-color="#fff3a6" stop-opacity="0"/></linearGradient>
  <pattern id="waves" width="90" height="46" patternUnits="userSpaceOnUse"><path d="M0 23 q22 -11 45 0 t45 0" fill="none" stroke="#fff" stroke-opacity=".09" stroke-width="2"/></pattern>
</defs>
<rect width="1200" height="700" fill="url(#sea)"/><rect width="1200" height="700" fill="url(#waves)"/>
<path d="M110 650 C80 530 160 440 255 405 C355 365 385 275 470 235 C560 192 640 232 720 192 C805 150 880 80 985 70 C1085 60 1158 122 1146 205 C1134 285 1064 305 1012 362 C952 430 962 522 882 582 C800 644 682 622 602 662 C502 706 300 712 110 650 Z" fill="#e6d3a1"/>
<path d="M152 628 C132 536 196 464 276 434 C378 398 402 304 486 266 C566 230 646 266 726 226 C806 186 882 116 978 106 C1066 98 1114 144 1104 208 C1094 272 1030 292 984 348 C924 418 930 504 858 558 C784 612 676 594 600 632 C504 676 318 678 152 628 Z" fill="#7cae64"/>
<path d="M930 150 C960 112 1030 100 1070 128 C1102 150 1096 196 1060 214 C1022 232 960 226 936 200 C920 184 918 166 930 150 Z" fill="#9aa1a8"/>
<path d="M948 160 C972 132 1026 124 1056 146 C1078 162 1072 192 1046 204 C1016 218 968 212 952 194 C942 182 940 170 948 160 Z" fill="#b8bec4"/>
<g fill="#5b8f45">
  <circle cx="300" cy="520" r="20"/><circle cx="326" cy="540" r="16"/><circle cx="560" cy="300" r="18"/><circle cx="586" cy="318" r="14"/>
  <circle cx="640" cy="520" r="22"/><circle cx="668" cy="500" r="16"/><circle cx="800" cy="430" r="18"/><circle cx="828" cy="452" r="14"/>
  <circle cx="860" cy="250" r="16"/><circle cx="520" cy="560" r="17"/><circle cx="760" cy="560" r="19"/>
</g>
<path d="M228 596 C290 548 352 482 430 438 C520 388 600 340 700 296 C800 252 900 196 990 168" fill="none" stroke="#8a5a2b" stroke-width="10" stroke-linecap="round" stroke-dasharray="2 22"/>
<g transform="translate(150 610) rotate(-38)"><rect x="0" y="-12" width="150" height="24" rx="3" fill="#8a5a2b"/>
  <g stroke="#6b4421" stroke-width="3">${Array.from({ length: 9 }, (_, k) => `<line x1="${12 + k * 16}" y1="-12" x2="${12 + k * 16}" y2="12"/>`).join('')}</g></g>
<g transform="translate(96 560) rotate(-38)"><path d="M0 0 h64 l-10 22 h-44 z" fill="#c8553d"/><rect x="28" y="-34" width="4" height="34" fill="#4a3424"/><path d="M32 -34 l24 26 h-24 z" fill="#f4efe6"/></g>
<circle cx="430" cy="436" r="64" fill="#d8c79f"/>
<g stroke="#00000022" stroke-width="2">
  <rect x="370" y="368" width="40" height="30" rx="3" fill="#c0504d"/><rect x="452" y="372" width="44" height="28" rx="3" fill="#e6a23c"/>
  <rect x="472" y="430" width="34" height="40" rx="3" fill="#6c8ebf"/><rect x="384" y="470" width="44" height="30" rx="3" fill="#e6a23c"/>
  <rect x="352" y="420" width="30" height="38" rx="3" fill="#6c8ebf"/><rect x="424" y="482" width="36" height="26" rx="3" fill="#c0504d"/>
</g>
<path d="M990 150 L560 40 L560 250 Z" fill="url(#beam)" opacity=".75"/>
<circle cx="1000" cy="160" r="34" fill="#f4efe6"/><circle cx="1000" cy="160" r="28" fill="none" stroke="#c0392b" stroke-width="9"/>
<circle cx="1000" cy="160" r="13" fill="#fff3a6"/><circle cx="1000" cy="160" r="13" fill="none" stroke="#e6a23c" stroke-width="3"/>
<g fill="#2a3240" opacity=".62">
  <ellipse cx="180" cy="70" rx="150" ry="52"/><ellipse cx="310" cy="58" rx="120" ry="46"/><ellipse cx="250" cy="104" rx="140" ry="40"/>
  <ellipse cx="700" cy="40" rx="130" ry="40"/><ellipse cx="800" cy="54" rx="100" ry="34"/>
</g>
<g stroke="#cfe3ff" stroke-opacity=".35" stroke-width="2.5" stroke-linecap="round">
  ${Array.from({ length: 22 }, (_, k) => { const x = 60 + ((k * 53) % 380); const y = 120 + ((k * 37) % 90); return `<line x1="${x}" y1="${y}" x2="${x - 10}" y2="${y + 26}"/>`; }).join('')}
</g>
<g transform="translate(1110 610)" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="3"><circle r="30"/>
  <path d="M0 -24 L8 0 L0 24 L-8 0 Z" fill="#fff" fill-opacity=".85" stroke="none"/></g>
<text x="1110" y="566" fill="#fff" fill-opacity=".85" font-family="Segoe UI, sans-serif" font-size="22" font-weight="700" text-anchor="middle">N</text>
</svg>`;

const DOC = `# The Lighthouse

A one-level puzzle game about keeping the lamp lit through a storm. The player climbs from the harbour to the lamp room while the weather gets worse on every floor.

## Level layout

The route runs from the harbour through the old market, up the cliff path and into the tower. Each part adds one new idea (Totten, 2019).

## How the guards behave

Guards patrol until they see the player, then chase them. A guard who loses the player searches the last place they saw them.

## Schedule

| Week | Goal | Status |
| --- | --- | --- |
| 1 | Blockout of the harbour | Done |
| 2 | Guards and the lamp puzzle | In progress |
| 3 | First playtest | To do |
| 4 | Sound and polish | To do |

## References`;

// The project's forum post, a weekly devlog: the map goes in at its end, under its last paragraph.
const POST = `<h2>Week 2: guards and the lamp puzzle</h2>
<p>The guards can patrol and chase now, and the lamp puzzle is playable from start to end.</p>
<h3>What changed</h3>
<ul><li>Guards patrol the market and chase the player on sight.</li><li>The lamp puzzle has three switches and a timer.</li><li>Rain gets heavier on every floor of the tower.</li></ul>
<div class="ipsRichTextBox"><div class="ipsRichTextBox__title"><p>Next week</p></div><i-richtext-box-content><p>The first playtest with five players, then fixes from their notes.</p></i-richtext-box-content></div>
<table><tbody><tr><th><p>Task</p></th><th><p>Status</p></th></tr><tr><td><p>Guard patrol and chase</p></td><td><p>Done</p></td></tr>
<tr><td><p>Lamp puzzle</p></td><td><p>In review</p></td></tr><tr><td><p>Storm and rain effects</p></td><td><p>To do</p></td></tr></tbody></table>
<p>Here is the level with this week's notes on it.</p>`;

// The assistant's turn (the feature-assistant banner): the intro with mistakes, the same intro as it suggests it, a checklist it makes.
const TYPOS = 'A one-level puzzle game about keep the lamp lit trough a storm. The player climb from the harbour to the lamp room while the weather get worse on every floor.';
const FIXED = 'A one-level puzzle game about keeping the lamp lit through a storm. The player climbs from the harbour to the lamp room while the weather gets worse on every floor.';
const CHECKLIST = '# Playtest checklist\n\n- Five players, one at a time\n- Time the lamp puzzle\n- Note where players get lost on the cliff path';
const AI_NOTES = ['gust', 't3', 'rain']; // the map's notes it adds back

const SOURCES = [
  { type: 'book', authors: ['Totten, Christopher W.'], year: '2019', title: 'An Architectural Approach to Level Design', place: 'Boca Raton', publisher: 'CRC Press' },
  { type: 'book', authors: ['Schell, Jesse'], year: '2019', title: 'The Art of Game Design: A Book of Lenses', place: 'Boca Raton', publisher: 'CRC Press' },
  { type: 'book', authors: ['Swink, Steve'], year: '2008', title: "Game Feel: A Game Designer's Guide to Virtual Sensation", place: 'Burlington', publisher: 'Morgan Kaufmann' },
];

// The canvas's notes over the map, in its px.
const NOTES = [
  ...[[1, 206, 568], [2, 408, 412], [3, 700, 278], [4, 1000, 160]].flatMap(([n, x, y]) => [
    { id: `m${n}`, type: 'shape', shape: 'ellipse', x: x - 22, y: y - 22, w: 44, h: 44, fill: 'solid', fillColor: '#e05252', color: '#ffffff', width: 3,
      html: String(n), size: 20, bold: true, textColor: '#ffffff' },
  ]),
  { id: 't1', type: 'text', html: 'Start at the harbour', x: 248, y: 584, w: 230, size: 20, color: '#1a1a1a', bg: '#ffffff' },
  { id: 't2', type: 'text', html: 'Market: the first guard', x: 470, y: 470, w: 250, size: 20, color: '#1a1a1a', bg: '#ffffff' },
  { id: 't3', type: 'text', html: 'Cliff path: the wind pushes back', x: 760, y: 330, w: 320, size: 20, color: '#1a1a1a', bg: '#ffffff' },
  { id: 't4', type: 'text', html: 'The lamp room', x: 1020, y: 236, w: 170, size: 20, color: '#1a1a1a', bg: '#ffffff' },
  { id: 'rain', type: 'shape', shape: 'speech', x: 470, y: 120, w: 260, h: 100, fill: 'solid', fillColor: '#fff2cc', color: '#d6b656', width: 3,
    html: 'Rain gets heavier on every floor', size: 20, textColor: '#333333' },
  { id: 'gust', type: 'shape', shape: 'ellipse', x: 610, y: 236, w: 180, h: 84, fill: 'none', color: '#e05252', width: 4 },
];

// The flowchart of the guards, kept in the flowchart library and synced into the document.
const box = (id, shape, x, y, w, h, html, [fillColor, color]) => ({ id, type: 'shape', shape, x, y, w, h, color, width: 2, opacity: 1, fill: 'solid',
  fillColor, html, size: 18, textColor: '#111111', bold: false });
const link = (id, from, to, label, more = {}) => ({ id, type: 'connector', from: { item: from[0], anchor: from[1] }, to: { item: to[0], anchor: to[1] },
  route: 'ortho', corner: 10, points: [], heads: { start: 'none', end: 'arrow' }, color: '#5c6670', width: 2, opacity: 1, dash: 'solid', jump: 'none',
  labels: label ? { mid: { html: label, t: 0.5, dx: 0, dy: 0, size: 16, textColor: '#5c6670', bold: true } } : {}, ...more });
const GREEN = ['#d5e8d4', '#82b366'];
const BLUE = ['#dae8fc', '#6c8ebf'];
const YELLOW = ['#fff2cc', '#d6b656'];
const RED = ['#f8cecc', '#b85450'];
const FLOW = {
  w: 1280, h: 470,
  items: [
    box('patrol', 'stadium', 40, 70, 170, 76, 'Patrol', GREEN),
    box('sees', 'diam', 270, 45, 210, 126, 'Sees the player?', YELLOW),
    box('chase', 'rect', 540, 70, 170, 76, 'Chase', BLUE),
    box('caught', 'diam', 770, 45, 210, 126, 'Caught them?', YELLOW),
    box('back', 'round', 1040, 70, 200, 76, 'Back to the checkpoint', RED),
    box('search', 'rect', 775, 300, 200, 76, 'Search the last place seen', BLUE),
    link('l1', ['patrol', [1, 0.5]], ['sees', [0, 0.5]]),
    link('l2', ['sees', [1, 0.5]], ['chase', [0, 0.5]], 'yes'),
    link('l3', ['sees', [0.5, 1]], ['patrol', [0.5, 1]], 'no'),
    link('l4', ['chase', [1, 0.5]], ['caught', [0, 0.5]]),
    link('l5', ['caught', [1, 0.5]], ['back', [0, 0.5]], 'yes'),
    link('l6', ['caught', [0.5, 1]], ['search', [0.5, 0]], 'no'),
    link('l7', ['search', [0, 0.5]], ['patrol', [0.25, 1]], 'gives up', { dash: 'dashed' }),
  ],
};

// ---------------------------------------------------------------------------------------------
// The app's captures

// The parts of a capture the banners cut out, found by these selectors when it is taken (their rects go to SHOTS/rects.json),
// so the banners follow the UI when it moves.
const PARTS = {
  page: '#page-wrap .page', ribbon: '[data-ribbon]', canvas: '.ProseMirror .sc', layers: 'div[aria-label="Layers"]', rail: '[aria-label="Board tools"]',
  board: '#flow-area .wb', shapes: 'aside[aria-label="Shapes"]', sidebar: '[data-agent-area="sidebar"]',
  toolbar: '[data-agent-area="toolbar"]:not([data-ribbon])',
};
const rects = {};

/** Captures the app's view as a 2x PNG named `name` in SHOTS, with the rects of its PARTS. */
async function shoot(cdp, J, name, ms = 800) {
  await wait(ms);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  rects[name] = await J(`Object.fromEntries(Object.entries(${JSON.stringify(PARTS)}).map(([k, s]) => {
    const el = [...document.querySelectorAll(s)].find((x) => x.checkVisibility());
    const r = el?.getBoundingClientRect();
    return [k, r && { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }];
  }).filter(([, r]) => r))`);
  fs.writeFileSync(path.join(SHOTS, 'rects.json'), JSON.stringify(rects, null, 1));
  console.log('shot', name);
}

async function capture(win) {
  const wc = win.webContents;
  const J = async (s) => JSON.parse(await wc.executeJavaScript(`Promise.resolve(${s}).then((v) => JSON.stringify(v) ?? 'null')`, true));
  wc.debugger.attach();
  const cdp = (m, p) => wc.debugger.sendCommand(m, p);
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 2, mobile: false });
  for (let i = 0; i < 300 && !(await J('!!window.__agent')); i++) await wait(100);
  await wait(1500);
  const inv = async (id, args = {}) => {
    const r = await J(`window.__agent.invoke(${JSON.stringify({ id, args, source: 'ui' })})`);
    if (!r?.ok) throw new Error(`${id}: ${JSON.stringify(r?.error)}`);
    return r.result;
  };

  // The project's drafts: the forum post with the map, short notes, then the document, which stays open.
  const devlog = await inv('drafts.create', { title: 'Week 2 devlog', format: 'forum-post', threadUrl: PROJECT, content: { html: POST } });
  const postMap = await inv('board.insert', { at: 'end', attrs: { w: 1200, h: 700, dw: 1200 } });
  const notes = await inv('drafts.create', { title: 'Playtest notes', format: 'document', threadUrl: PROJECT,
    content: { markdown: '# Playtest notes\n\n- Two of five players missed the cliff path.\n- The lamp puzzle took about four minutes.' } });
  const doc = await inv('drafts.create', { title: 'Level design document', format: 'document', threadUrl: PROJECT, content: { markdown: DOC } });
  await inv('drafts.setTag', { draftId: devlog.draftId, tagId: 'done' });
  await inv('drafts.setTag', { draftId: notes.draftId, tagId: 'todo' });
  await inv('drafts.setTag', { draftId: doc.draftId, tagId: 'progress' });
  const ours = new Set([devlog.draftId, notes.draftId, doc.draftId]);
  for (const d of await inv('drafts.list')) if (!ours.has(d.id)) await inv('drafts.delete', { draftId: d.id }); // the empty one a new profile starts with

  // The map with its notes after "Level layout", the guards' flowchart after theirs, and the reference list at the end.
  const map = await J(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(MAP).toString('base64'))};
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: 1200, height: 700 });
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/png');
  })()`);
  const items = [{ id: 'map', type: 'image', src: map, x: 0, y: 0, w: 1200, h: 700 }, ...NOTES];
  await inv('board.items.add', { path: postMap.path, items, draftId: devlog.draftId });
  const canvas = await inv('board.insert', { at: [3], attrs: { w: 1200, h: 700, dw: 1200 } });
  await inv('board.items.add', { path: canvas.path, items });
  const flow = await inv('flow.library.create', { title: 'Guard behaviour', threadUrl: PROJECT, board: FLOW });
  await inv('flow.insert', { flowId: flow.flowId, at: [canvas.path[0] + 2] });
  await inv('references.setStyle', { style: 'harvard' });
  for (const source of SOURCES) await inv('references.add', { source });
  await inv('references.insertList', { at: 'end' });
  console.log('outline', JSON.stringify(await inv('doc.get', { format: 'outline' })).slice(0, 600));

  // Each draft from its page's top, just under the top of the editor area, at 100 % (a Document keeps room above its first page).
  const S = (name, ms) => shoot(cdp, J, name, ms);
  const fromTop = async (zoom = 100) => { // a forum post is as wide as the forum shows it: fit
    await inv('ui.zoom', { value: zoom });
    await wait(400);
    await J(`(() => { const page = document.querySelector('#page-wrap .page'); let el = page;
      while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      if (el) el.scrollTop += page.getBoundingClientRect().top - el.getBoundingClientRect().top - 24; return !!el; })()`);
  };
  await inv('drafts.open', { draftId: devlog.draftId });
  await fromTop('fit');
  await S('forum', 1200);
  await inv('drafts.open', { draftId: doc.draftId });
  await fromTop();
  await S('write');

  await inv('canvas.edit', { path: canvas.path });
  await S('canvas', 1000);
  await inv('canvas.close', {});

  await inv('tool.run', { id: 'plan-open' }); // on its Board tab
  for (let i = 0; i < 50 && !(await J(`window.__agent.invoke({ id: 'tool.list', source: 'ui' }).then((r) => JSON.stringify(r).includes('"plan-gantt"'))`)); i++) await wait(100);
  await S('plan-board', 1500);
  await inv('tool.run', { id: 'plan-gantt' });
  await S('plan-gantt', 1500);
  await inv('tool.run', { id: 'plan-close' });

  // An assistant's turn, made with its own source (agent:assistant), so its changes wait as suggestions: the document with mistakes
  // and fewer notes (ai-0), its grammar fixes (ai-1), its notes on the map (ai-2), and the checklist it makes in the sidebar (ai-3).
  const agent = async (id, args) => {
    const r = await J(`window.__agent.invoke(${JSON.stringify({ id, args, source: 'agent:assistant' })})`);
    if (!r?.ok) throw new Error(`${id}: ${JSON.stringify(r?.error)}`);
    return r.result;
  };
  await inv('drafts.open', { draftId: doc.draftId });
  await inv('doc.replace', { path: [1], content: { markdown: TYPOS } });
  await inv('board.items.remove', { path: canvas.path, ids: AI_NOTES });
  await fromTop();
  await S('ai-0');
  await agent('doc.replace', { path: [1], content: { markdown: FIXED } });
  await S('ai-1');
  await agent('board.items.add', { path: canvas.path, items: NOTES.filter((i) => AI_NOTES.includes(i.id)) });
  await S('ai-2');
  await agent('drafts.create', { title: 'Playtest checklist', format: 'document', threadUrl: PROJECT, content: { markdown: CHECKLIST } });
  await inv('drafts.open', { draftId: doc.draftId });
  await fromTop();
  await S('ai-3');
  // The app's theme on the root, for the banners drawn with its own CSS (the chat panel).
  fs.writeFileSync(path.join(SHOTS, 'theme.json'), JSON.stringify(await J(`({ cls: document.documentElement.className, style: document.documentElement.getAttribute('style') ?? '',
    data: { ...document.documentElement.dataset }, body: document.body.className })`)));

  await inv('flow.open', { flowId: flow.flowId }); // last: no command goes back to the editor from the flowchart library
  await wait(1500);
  await J(`(document.querySelector('div[aria-label="Layers"]')?.style.setProperty('visibility', 'hidden'), 1)`); // this capture only: the flowchart in full
  await S('flow', 1000);
}

// ---------------------------------------------------------------------------------------------
// The banners

const icon = (name, size = 24, className) => {
  const { createElement } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  return renderToStaticMarkup(createElement(require('lucide-react')[name], { size, strokeWidth: 1.9, 'aria-hidden': true, className }));
};
const url = (file) => `file:///${file.replace(/\\/g, '/')}`;
const LOGO = () => fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8');

const CSS = `
* { box-sizing: border-box; margin: 0; }
html, body { background: transparent; }
body { font-family: 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif; color: #f4f4f5; -webkit-font-smoothing: antialiased; }
.card { position: relative; overflow: hidden; border-radius: 22px; background: #0c0e13; }
.card::before { content: ''; position: absolute; inset: 0; background:
  radial-gradient(60% 90% at var(--gx, 0%) var(--gy, 0%), color-mix(in oklab, var(--a) 42%, transparent), transparent 70%),
  radial-gradient(50% 70% at 100% 100%, color-mix(in oklab, var(--a) 16%, transparent), transparent 70%); }
.card::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08); pointer-events: none; }
.card.square, .card.square::after { border-radius: 0; }
.text { position: absolute; z-index: 1; }
.eyebrow { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--a); }
.text h1 { font-size: 46px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
.text h2 { margin-top: 12px; font-size: 30px; font-weight: 700; line-height: 1.14; letter-spacing: -0.01em; text-wrap: balance; }
.text p { margin-top: 12px; font-size: 15.5px; line-height: 1.5; color: #a8abb3; text-wrap: pretty; }
.shot { position: absolute; z-index: 1; overflow: hidden; border-radius: 12px; background: #1a1a1a;
  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.12), 0 22px 56px rgb(0 0 0 / 0.55); }
.shot img { position: absolute; left: 0; top: 0; transform-origin: 0 0; max-width: none; height: auto; }
.tilt { transform: perspective(1800px) rotateY(-12deg) rotateX(2deg); transform-origin: 0 50%; }
`;

/** Part `key` (PARTS) of capture `name` as its rect was when it was taken, `pad` px wider each way, `cut` overriding fields;
 * the whole view when it was not there. */
function part(name, key, pad = 0, cut = {}) {
  const r = JSON.parse(fs.readFileSync(path.join(SHOTS, 'rects.json'), 'utf8'))[name]?.[key] ?? { x: 0, y: 0, w: VIEW.width, h: VIEW.height };
  return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad, ...cut };
}
const WHOLE = { x: 0, y: 0, w: VIEW.width, h: VIEW.height };

/** A capture `name` cut to `crop` ({x, y, w, h} in its CSS px) and shown `w` px wide at left/top `at`. */
function shot(name, crop, at, w, { cls = '', style = '' } = {}) {
  const s = w / crop.w;
  return `<div class="shot ${cls}" style="left:${at[0]}px;top:${at[1]}px;width:${w}px;height:${Math.round(crop.h * s)}px;${style}">
    <img src="${url(path.join(SHOTS, `${name}.png`))}" style="width:${VIEW.width * s}px;translate:${-crop.x * s}px ${-crop.y * s}px"></div>`;
}
/** The plan's area of capture `name`: right of the sidebar, from the top of its toolbar down `h` px. */
const planArea = (name, y, h) => {
  const side = part(name, 'sidebar');
  return { x: side.x + side.w + 6, y, w: VIEW.width - side.x - side.w - 6, h };
};

/** A feature banner: `eyebrow` with its icon, `title` and `line` on one side, the captures (`shots`, HTML) on the other. */
const feature = ({ accent, glow = '0% 0%', eyebrow, iconName, title, line, side = 'left', shots }) => ({
  w: 800, h: 380,
  html: `<div class="card" style="width:800px;height:380px;--a:${accent};--gx:${glow.split(' ')[0]};--gy:${glow.split(' ')[1]}">
    <div class="text" style="${side === 'left' ? 'left:44px' : 'right:44px'};top:0;bottom:0;width:270px;display:flex;flex-direction:column;justify-content:center">
      <div class="eyebrow">${icon(iconName, 16)}${eyebrow}</div><h2>${title}</h2><p>${line}</p></div>
    ${shots}</div>`,
});

const BANNERS = {
  banner: () => ({
    w: 800, h: 400,
    html: `<div class="card" style="width:800px;height:400px;--a:#3b82f6;--gx:12%;--gy:0%">
      <div class="text" style="left:44px;top:0;bottom:0;width:300px;display:flex;flex-direction:column;justify-content:center">
        <div style="display:flex;align-items:center;gap:14px"><div style="width:54px;height:54px">${LOGO().replace('<svg ', '<svg width="54" height="54" ')}</div><h1>EasyWriter</h1></div>
        <p style="font-size:18.5px;color:#d4d6dc;margin-top:18px">Write, draw and plan<br>your project in one app.</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:22px">
          ${[['MessagesSquare', 'Forum posts'], ['FileText', 'Documents'], ['Sparkles', 'AI assistant'], ['Frame', 'Canvases'], ['Workflow', 'Flowcharts'], ['SquareKanban', 'Plans']].map(([i, t]) =>
            `<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:12.5px;font-weight:600;color:#dbe4ff;background:rgb(59 130 246 / 0.16);box-shadow:inset 0 0 0 1px rgb(147 180 255 / 0.25)">${icon(i, 13)}${t}</span>`).join('')}
        </div></div>
      ${shot('forum', WHOLE, [372, 40], 600, { cls: 'tilt' })}
      ${shot('plan-gantt', planArea('plan-gantt', 126, 300), [336, 262], 300, { cls: 'tilt', style: 'border-radius:10px' })}
    </div>`,
  }),
  'feature-forum': () => feature({ accent: '#38bdf8', eyebrow: 'Forum posts', iconName: 'MessagesSquare', title: 'Write forum posts with the forum\'s own tools',
    line: 'Boxes, tables, pictures and canvases, laid out as the forum shows them. Push fills your thread\'s reply box.',
    shots: `${shot('forum', part('forum', 'page', 8, { h: 600 }), [352, 40], 520)}${shot('forum', part('forum', 'toolbar', 4, { w: 760 }), [334, 296], 400, { style: 'border-radius:12px' })}` }),
  'feature-documents': () => feature({ accent: '#818cf8', glow: '100% 0%', side: 'right', eyebrow: 'Documents', iconName: 'FileText',
    title: 'Documents with pages, styles and references', line: 'A page view and a ribbon of tools, as in a word processor, with a reference list in Harvard or IEEE.',
    shots: `${shot('write', part('write', 'page', 8, { h: 540 }), [-40, 44], 470)}${shot('write', part('write', 'ribbon'), [338, 92], 128, { style: 'border-radius:10px' })}` }),
  'feature-canvas': () => feature({ accent: '#fb923c', glow: '100% 0%', side: 'right', eyebrow: 'Canvas', iconName: 'Frame',
    title: 'Draw on top of any picture', line: 'Paste a screenshot, then mark it up with shapes, arrows and notes. It stays inside your draft.',
    shots: `${shot('canvas', part('canvas', 'canvas', 6), [100, 84], 370)}${shot('canvas', part('canvas', 'layers'), [28, 52], 118, { style: 'border-radius:10px' })}` }),
  'feature-flow': () => feature({ accent: '#2dd4bf', eyebrow: 'Flowcharts', iconName: 'Workflow', title: 'Flowcharts that stay connected',
    line: 'Move a box and its arrows follow. Keep flowcharts in a library and use them in any draft.',
    shots: `${shot('flow', part('flow', 'board', 12), [466, 60], 780)}${shot('flow', part('flow', 'shapes', 0, { h: 440 }), [320, 104], 130, { style: 'border-radius:10px' })}` }),
  'feature-plan': () => feature({ accent: '#c084fc', glow: '100% 0%', side: 'right', eyebrow: 'Plan', iconName: 'SquareKanban',
    title: 'Plan the weeks ahead', line: 'A Kanban board, a backlog and a Gantt chart for every project, with your drafts on the cards.',
    shots: `${shot('plan-board', planArea('plan-board', 46, 380), [-56, 46], 512)}${shot('plan-gantt', planArea('plan-gantt', 126, 300), [36, 214], 420, { style: 'border-radius:10px' })}` }),
  'feature-more': () => ({
    w: 800, h: 410,
    html: `<div class="card" style="width:800px;height:410px;--a:#facc15;--gx:50%;--gy:0%">
      <div class="text" style="left:44px;right:44px;top:30px"><div class="eyebrow">${icon('Sparkles', 16)}Also inside</div></div>
      <div class="text" style="left:44px;right:44px;top:64px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
        ${[['Globe', 'Browser', 'Web pages in tabs, right beside your draft.'],
          ['Mic', 'Dictation', 'Speak instead of typing. It runs on your PC.'],
          ['Palette', 'Themes', 'Light or dark, with your own colours for panels and text.'],
          ['CloudUpload', 'Backup', 'Your drafts, plans and flowcharts in a private GitHub repository.'],
          ['Command', 'Quick access', 'One shortcut opens the tools for what you are working on.'],
          ['Usb', 'Portable', 'Runs from a folder with no install, for school PCs.']].map(([i, t, l]) => `
          <div style="padding:14px 15px 13px;border-radius:14px;background:rgb(255 255 255 / 0.045);box-shadow:inset 0 0 0 1px rgb(255 255 255 / 0.07)">
            <div style="width:32px;height:32px;border-radius:9px;display:grid;place-items:center;color:#fde68a;background:rgb(250 204 21 / 0.14)">${icon(i, 18)}</div>
            <div style="margin-top:10px;font-size:15.5px;font-weight:700">${t}</div>
            <div style="margin-top:3px;font-size:13px;line-height:1.45;color:#a8abb3">${l}</div></div>`).join('')}
      </div>
      <div class="text" style="left:0;right:0;bottom:22px;text-align:center;font-size:14.5px;font-weight:600;color:#fde68a">More features are coming soon.</div></div>`,
  }),
  'download-installer': () => button({ primary: true, iconName: 'Download', title: 'Download for Windows', sub: 'Installer' }),
  'download-portable': () => button({ iconName: 'FolderArchive', title: 'Portable version', sub: 'No install needed' }),
};

/** A download button for the README (it links nowhere itself; the README wraps it in its link). */
function button({ primary, iconName, title, sub }) {
  return {
    w: 280, h: 64,
    html: `<div style="width:280px;height:64px;border-radius:14px;display:flex;align-items:center;gap:14px;padding:0 20px;
      ${primary ? 'background:linear-gradient(180deg,#3b82f6,#2563eb);color:#fff;box-shadow:inset 0 1px 0 rgb(255 255 255 / 0.25)' : 'background:#16181d;color:#f4f4f5;box-shadow:inset 0 0 0 1.5px #3a3f4b'}">
      ${icon(iconName, 26)}<div><div style="font-size:17px;font-weight:700;line-height:1.2">${title}</div>
      <div style="font-size:13px;opacity:.78;margin-top:2px">${sub}</div></div></div>`,
  };
}

// The assistant's banner, animated: a sample turn in a chat panel drawn here with the app's own markup and CSS (Chat.jsx Message,
// dist/app.css), beside the document the turn changed (ai-0 to ai-3, captured above). It starts on the finished turn, so a viewer
// that shows only the first frame still sees it, then plays the turn again. LOOP seconds; each part shows in its [from, to] spans.
const LOOP = 11;
const GHOST_XS = 'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap h-6 gap-1 px-2 text-xs';
const CHAT = [
  [2.2, `<div data-role="user" class="ml-8 grid gap-1.5 self-end rounded-lg bg-secondary px-2.5 py-1.5 select-text"><div class="break-words whitespace-pre-wrap">Can you fix the grammar in my design doc, circle the windy part of the map and start a playtest checklist?</div></div>`],
  [3.0, 'Read Level design document'],
  [3.8, 'Suggested 4 grammar fixes', true],
  [5.0, 'Suggested 3 notes on the map', true],
  [6.2, 'Created Playtest checklist'],
  [7.2, `<div data-role="assistant" class="mr-4 grid gap-1 select-text"><p>Done. The fixes and the notes wait in your document as suggestions, and the checklist is in your project.</p></div>`],
].map(([at, html, suggested]) => [at, html.startsWith('<') ? html
  : `<div data-role="step" class="flex min-h-6 items-center gap-1.5 text-xs text-muted-foreground">${suggested
    ? '<span class="flex size-3.5 shrink-0 items-center justify-center"><span class="size-2 shrink-0 rounded-full ring-1 ring-foreground/25 ring-inset" style="background:var(--suggest)"></span></span>'
    : icon('Check', 14, 'size-3.5 shrink-0')}<span class="min-w-0 flex-1 truncate">${html}</span>${suggested ? `<span class="${GHOST_XS}">Show</span><span class="${GHOST_XS}">Reject</span>` : ''}</div>`]);

/** Keyframes `name` for something shown in `spans` ([from, to] seconds of LOOP), fading in and out over 0.3 s. */
function shown(name, spans) {
  const pts = spans.flatMap(([a, b]) => [...(a > 0 ? [[a, 0], [a + 0.3, 1]] : [[0, 1]]), ...(b < LOOP ? [[b, 1], [b + 0.3, 0]] : [[LOOP, 1]])]);
  if (!pts.some(([t]) => t === 0)) pts.push([0, 0]);
  if (!pts.some(([t]) => t === LOOP)) pts.push([LOOP, 0]);
  pts.sort((x, y) => x[0] - y[0]);
  return `@keyframes ${name} { ${pts.map(([t, v]) => `${((t / LOOP) * 100).toFixed(3)}% { opacity: ${v}; }`).join(' ')} }`;
}

function assistantBanner() {
  const theme = JSON.parse(fs.readFileSync(path.join(SHOTS, 'theme.json'), 'utf8'));
  // The document's page from its top, and the sidebar's drafts list (where the checklist appears), in each of the four states.
  const states = ['ai-0', 'ai-1', 'ai-2', 'ai-3'];
  const spans = { 'ai-0': [[0, LOOP]], 'ai-1': [[3.8, 6.6]], 'ai-2': [[5.0, 6.6]], 'ai-3': [[0, 1.8], [6.2, LOOP]] };
  const side = part('ai-3', 'sidebar');
  const list = { x: side.x, y: side.y + 150, w: side.w, h: 120 };
  const page = (s) => { const p = part(s, 'page', 8); return { ...p, y: p.y + 72, h: 500 }; }; // from its title, past the top margin
  const layers = states.map((s) => `${shot(s, page(s), [44, 176], 440, { style: `animation:${s.replace('-', '')} ${LOOP}s infinite linear` })}
    ${shot(s, list, [24, 396], 196, { style: `border-radius:10px;animation:${s.replace('-', '')} ${LOOP}s infinite linear` })}`).join('');
  const keyframes = [...states.map((s) => shown(s.replace('-', ''), spans[s])), ...CHAT.map(([at], k) => shown(`m${k}`, [[0, 1.8], [at, LOOP]]))].join('\n');
  return {
    w: 800, h: 500, app: theme, loop: LOOP,
    html: `<style>${keyframes}</style><div class="card" style="width:800px;height:500px;--a:#f472b6;--gx:100%;--gy:0%">
      <div class="text" style="left:44px;top:34px;right:44px"><div class="eyebrow">${icon('Sparkles', 16)}Assistant</div>
        <h2>An assistant that works across the app</h2>
        <p style="max-width:690px">It sees what you have open. Ask it for grammar fixes, notes on a picture or a new draft, and its changes wait as suggestions until you accept them. It works with the major AI providers.</p></div>
      ${layers}
      <div id="assistant-panel" class="flex flex-col rounded-island border bg-island p-1 text-sm shadow-xl"
        style="position:absolute;z-index:2;left:508px;top:176px;width:268px;height:300px;font-family:var(--font-sans, 'Segoe UI', sans-serif);color:var(--foreground)">
        <div class="flex shrink-0 items-center gap-1.5 py-1 pr-0.5 pl-2 select-none"><span class="font-semibold">Assistant</span>
          <span class="size-2 shrink-0 rounded-full ring-1 ring-foreground/25 ring-inset" style="background:var(--success)"></span><span class="flex-1"></span>
          <span class="${GHOST_XS} text-muted-foreground">${icon('MessageSquarePlus', 14)}</span><span class="${GHOST_XS} text-muted-foreground">${icon('X', 14)}</span></div>
        <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-2 py-1">
          ${CHAT.map(([, html], k) => html.replace('<div ', `<div style="animation:m${k} ${LOOP}s infinite linear" `)).join('')}</div>
        <div class="flex shrink-0 items-end gap-1 p-1"><span class="${GHOST_XS} size-8 text-muted-foreground">${icon('Mic', 16)}</span>
          <div class="min-w-0 flex-1 rounded-md border px-2 py-1.5 text-muted-foreground">Message the assistant</div>
          <span class="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">${icon('ArrowUp', 16)}</span></div>
      </div></div>`,
  };
}

/** Renders the animated `page` as frames at `fps` (its CSS animations stepped by hand) and encodes them with ffmpeg as an animated
 * WebP at `out`. */
async function animate(win, page, out, { fps = 12, scale = 1.5 } = {}) {
  const frames = path.join(UD, 'frames');
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  await render(win, page, { scale, format: 'png' });
  const cdp = (m, p) => win.webContents.debugger.sendCommand(m, p);
  for (let k = 0; k < page.loop * fps; k++) {
    await win.webContents.executeJavaScript(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${(k * 1000) / fps}; }); 1`, true);
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(frames, `f${String(k).padStart(3, '0')}.png`), Buffer.from(data, 'base64'));
  }
  const { execFileSync } = require('child_process');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frames, 'f%03d.png'), '-c:v', 'libwebp_anim',
    '-quality', '80', '-loop', '0', out]);
}

// The installer's pictures, at their own size: the welcome page's sidebar (164 x 314) and the header of its other pages (150 x 57).
const INSTALLER = {
  installerSidebar: () => ({
    w: 164, h: 314, bg: '#0c0e13',
    html: `<div style="width:164px;height:314px;position:relative;overflow:hidden;background:#0c0e13">
      <div style="position:absolute;inset:0;background:radial-gradient(120% 70% at 50% 0%, rgb(59 130 246 / 0.55), transparent 70%)"></div>
      <div style="position:absolute;left:0;right:0;top:58px;display:flex;flex-direction:column;align-items:center;gap:14px">
        <div style="width:76px;height:76px">${LOGO().replace('<svg ', '<svg width="76" height="76" ')}</div>
        <div style="font-size:21px;font-weight:700;letter-spacing:-0.01em">EasyWriter</div>
        <div style="font-size:11.5px;line-height:1.45;text-align:center;color:#a8abb3;padding:0 16px">Write, draw and plan your project in one app.</div>
      </div></div>`,
  }),
  installerHeader: () => ({
    w: 150, h: 57, bg: '#ffffff',
    html: `<div style="width:150px;height:57px;background:#fff;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-right:10px;color:#111">
      <div style="font-size:15px;font-weight:700">EasyWriter</div><div style="width:34px;height:34px">${LOGO().replace('<svg ', '<svg width="34" height="34" ')}</div></div>`,
  }),
};

/** A 24-bit BMP of PNG `png` (NSIS wants BMP). */
function bmp(png) {
  const img = nativeImage.createFromBuffer(png);
  const { width: w, height: h } = img.getSize();
  const bgra = img.toBitmap();
  const row = Math.ceil((w * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * h);
  out.write('BM', 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22); // bottom-up rows
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = 54 + (h - 1 - y) * row + x * 3;
      out[d] = bgra[s];
      out[d + 1] = bgra[s + 1];
      out[d + 2] = bgra[s + 2];
    }
  }
  return out;
}

/** Renders `page` ({w, h, html}) at `scale` and captures it in `format` (webp keeps the transparent corners); `bg`, an opaque
 * background instead (a BMP has no alpha). */
async function render(win, page, { scale = 2, format = 'webp', zoom = 1, square = false, bg = null } = {}) {
  const file = path.join(UD, 'page.html');
  const html = square ? page.html.replace('class="card"', 'class="card square"') : page.html;
  // `page.app`: the app's theme ({cls, style, data, body} of its root and body) and its CSS, for markup drawn as the app draws it.
  const q = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const app = page.app;
  const root = app ? ` class="${q(app.cls)}" style="${q(app.style)}"${Object.entries(app.data).map(([k, v]) => ` data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${q(v)}"`).join('')}` : '';
  fs.writeFileSync(file, `<!doctype html><html${root}><meta charset="utf-8">${app ? `<link rel="stylesheet" href="${url(path.join(ROOT, 'dist', 'app.css'))}">` : ''}
    <style>${CSS} html,body{background:${bg ?? 'transparent'} !important;overflow:hidden} body{zoom:${zoom}}</style><body class="${q(app?.body ?? '')}">${html}</body></html>`);
  await win.loadFile(file);
  const cdp = (m, p) => win.webContents.debugger.sendCommand(m, p);
  await cdp('Emulation.setDeviceMetricsOverride', { width: Math.round(page.w * zoom), height: Math.round(page.h * zoom), deviceScaleFactor: scale, mobile: false });
  await cdp('Emulation.setDefaultBackgroundColorOverride', bg ? {} : { color: { r: 0, g: 0, b: 0, a: 0 } });
  await win.webContents.executeJavaScript('Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))])', true);
  await wait(150);
  const { data } = await cdp('Page.captureScreenshot', { format, ...(format !== 'png' && { quality: 92 }) });
  return Buffer.from(data, 'base64');
}

async function layout() {
  // Shown, as a hidden window paints no frame to capture: inactive, on the second screen (src/test-window.js).
  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  require(path.join(ROOT, 'src', 'test-window.js')).keepBehind(win);
  win.showInactive();
  win.webContents.debugger.attach();
  fs.mkdirSync(IMG, { recursive: true });
  for (const [name, page] of Object.entries(BANNERS)) {
    fs.writeFileSync(path.join(IMG, `${name}.webp`), await render(win, page()));
    console.log('wrote', `docs/img/${name}.webp`);
  }
  fs.writeFileSync(path.join(IMG, 'social.jpg'), await render(win, BANNERS.banner(), { scale: 1, format: 'jpeg', zoom: 1.6, square: true }));
  console.log('wrote docs/img/social.jpg');
  await animate(win, assistantBanner(), path.join(IMG, 'feature-assistant.webp'));
  console.log('wrote docs/img/feature-assistant.webp');
  for (const [name, page] of Object.entries(INSTALLER)) {
    fs.writeFileSync(path.join(ROOT, 'build', `${name}.bmp`), bmp(await render(win, page(), { scale: 1, format: 'png', bg: page().bg })));
    console.log('wrote', `build/${name}.bmp`);
  }
  win.destroy();
}

// ---------------------------------------------------------------------------------------------

if (LAYOUT) {
  require(path.join(ROOT, 'src', 'test-window.js')).prepare();
  app.whenReady().then(() => fs.mkdirSync(UD, { recursive: true })).then(layout).then(() => app.exit(0), fail);
} else {
  fs.rmSync(UD, { recursive: true, force: true });
  fs.mkdirSync(path.join(UD, 'plans'), { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(UD, 'plans', `${PLAN}.json`), JSON.stringify(plan()));
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({
    onboarded: true, demoSeeded: true, hideBackupWarning: true, layersPanel: true, threads: [{ url: PROJECT, title: 'The Lighthouse' }], selectedThread: PROJECT,
    integrations: { forum: { enabled: true } }, // for the forum post's own tools
  }));
  process.argv.push(`--data-dir=${UD}`);
  // Nothing leaves the computer: the demo needs no network.
  app.on('session-created', (s) => s.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (d, cb) => cb({ cancel: !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(d.url) })));
  require(path.join(ROOT, 'src', 'dictation-main.js')).warmAtStart = () => {};
  let started = false;
  app.on('browser-window-created', (_, win) => {
    if (started) return;
    started = true;
    win.show = () => win.showInactive();
    win.webContents.once('did-finish-load', () => capture(win).then(layout).then(() => app.exit(0), fail));
  });
  setTimeout(() => fail(new Error('timed out')), 240000);
  require(path.join(ROOT, 'main.js'));
}
