// The demo draft (actions.js init seeds it once, on the first start with no drafts) and the doc helpers it shares with the
// smoke sample (actions.js sampleDoc). Its flowchart and plan charts are the smoke sample's (samples/flow.js, samples/plan.js).
import { flowSample } from './flow.js';
import { planSample } from './plan.js';

export const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
export const para = (...content) => ({ type: 'paragraph', content });
export const cell = (type, t) => ({ type, content: [para(text(t))] });

/** A 400 × 200 gradient picture with `label` on it, as a PNG data URL. */
export function sampleImage(label = 'WB') {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 200;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 400, 200);
  gradient.addColorStop(0, '#3d99f5');
  gradient.addColorStop(1, '#e052e0');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 400, 200);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 96px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 200, 100);
  return canvas.toDataURL('image/png');
}

const h2 = (t) => ({ type: 'heading', attrs: { level: 2 }, content: [text(t)] });
const list = (...items) => ({ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: [para(text(t))] })) });
const row = (type, ...cells) => ({ type: 'tableRow', content: cells.map((t) => cell(type, t)) });
const shape = (id, kind, x, y, w, h, fillColor, color, html = '') => ({
  id, type: 'shape', shape: kind, x, y, w, h, color, width: 3, opacity: 1, fill: 'solid', fillColor, flipX: false, flipY: false,
  html, size: 20, textColor: '#111111', bold: true,
});
// The marks of the four default presets (main.js DEFAULT_SETTINGS.presets, applied by format.mjs presetChain).
const KEY_TERM = [{ type: 'bold' }, { type: 'textColor', attrs: { color: 'blue' } }];
const CAPTION = [{ type: 'italic' }, { type: 'fontSize', attrs: { size: '90' } }, { type: 'textColor', attrs: { color: 'soft' } }];
const HIGHLIGHT = [{ type: 'highlight', attrs: { color: 'yellow' } }];
const STATEMENT = [{ type: 'bold' }, { type: 'fontSize', attrs: { size: '150' } }, { type: 'textColor', attrs: { color: 'hard' } }];

// The smoke flow without its stress-test parts: the rotated diamond and the two connectors that start from a loose point.
function demoFlow() {
  const clean = (o) => {
    if (Array.isArray(o)) return o.filter((i) => !['fc6', 'fc8'].includes(i?.id)).map(clean);
    if (o && typeof o === 'object') { delete o.rot; for (const k of Object.keys(o)) o[k] = clean(o[k]); }
    return o;
  };
  return clean(JSON.parse(JSON.stringify(flowSample()[0])));
}

export const demoDoc = () => ({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [text('Welcome to EasyWriter')] },
    para(text('EasyWriter is a desktop editor for Digital Academy Forum development threads. You write each post here, with '
      + 'whiteboards, flowcharts and plans built in, and push it to your thread when it is ready. This draft shows what a post '
      + 'can hold.')),
    h2('Text and presets'),
    para(text('Presets apply a saved text style in one click. Select some text and pick one from the toolbar. The app comes '
      + 'with four of them.')),
    para(text('Key term', KEY_TERM), text(', '), text('Caption', CAPTION), text(', '), text('Highlight', HIGHLIGHT), text(' and '),
      text('Statement', STATEMENT)),
    para(text('Change them or add your own under Manage presets in the presets menu.')),
    h2('The toolbar'),
    para(text('The toolbar at the bottom of the editor holds the formatting and insert tools.')),
    list(
      'Headings, bold, italic, underline, colours and font sizes',
      'Bullet and numbered lists, quotes and code blocks',
      'Tables, boxes, whiteboards, flowcharts and plan charts',
      'Undo history that is still there after a restart',
    ),
    h2('Tables and boxes'),
    para(text('Tables suit schedules and feedback. A box sets a note apart under its own title.')),
    {
      type: 'table',
      content: [
        row('tableHeader', 'Week', 'Goal', 'Status'),
        row('tableCell', '1', 'Blockout of level 1', 'Done'),
        row('tableCell', '2', 'Lighting pass', 'In progress'),
        row('tableCell', '3', 'First playtest', 'To do'),
      ],
    },
    {
      type: 'box',
      content: [
        { type: 'boxTitle', content: [text('Tip')] },
        { type: 'boxContent', content: [para(text('Use a box for the summary at the top of a long post, or for a link to your latest build.'))] },
      ],
    },
    h2('Whiteboard'),
    para(text('A whiteboard is a free area inside the post. Drop in pictures, write text and draw shapes, then drag them where '
      + 'you want them. The forum gets it as one picture.')),
    {
      type: 'whiteboard',
      attrs: {
        height: 320,
        bg: 'post',
        items: [
          { id: 'demoimg', type: 'image', src: sampleImage('Hello'), x: 40, y: 50, w: 400, h: 200 },
          { id: 'demotxt', type: 'text', html: 'Pictures, text and shapes<br>go <b>anywhere</b> on the board', x: 500, y: 70, w: 420, size: 24, color: '#3d99f5', bold: false, align: 'left', bg: null },
          shape('demostar', 'star', 1000, 40, 160, 160, '#e0c952', '#e09952'),
          shape('demonote', 'speech', 520, 170, 260, 110, '#d5e8d4', '#82b366', 'Drag me'),
          shape('demoball', 'ellipse', 1200, 120, 140, 140, '#dae8fc', '#6c8ebf'),
        ],
      },
    },
    h2('Flowcharts'),
    para(text('Connectors stay attached to their shapes, so the lines follow when you move a box. Keep flowcharts in the library '
      + 'to reuse them in other drafts.')),
    demoFlow(),
    h2('Plans'),
    para(text('Each thread can have a plan with a Kanban board and a Gantt chart. Put either one in a post to show your progress.')),
    ...planSample(),
    h2('Pushing a post'),
    para(text('Choose the draft\'s thread in the sidebar, then press Push to forum. EasyWriter opens the thread with your post in '
      + 'the reply box, and you press Submit on the forum when it looks right.')),
    para(text('This draft is only an example. Delete it from the sidebar when you no longer need it.', CAPTION)),
  ],
});
