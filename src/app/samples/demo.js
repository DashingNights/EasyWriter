// The demo draft (actions.js init seeds it once, on the first start with no drafts) and the doc helpers it shares with the
// smoke sample (actions.js sampleDoc). Its flowchart and plan charts are the smoke sample's (samples/flow.js, samples/plan.js).
// The annotated whiteboard and the smart canvas are copied from the author's own dev thread posts. Their pictures are WebP
// data URLs (at most 1024 px on the long side) in demo-images.json, keyed by item id; the items keep their original boxes.
import IMAGES from './demo-images.json';
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
    h2('Annotated screenshots'),
    para(text('Drop a screenshot on a whiteboard, then draw and write over it. The forum gets the whole board as one picture. '
      + 'This board comes from a real dev thread post.')),
    para(text('This board was inspired by the map '), text('"', [{ type: 'italic' }]),
      text('Imperial Dueling Grounds', [{ type: 'italic' }, { type: 'underline' }]), text('" ', [{ type: 'italic' }]), text('of Marvel Rivals.')),
    {
      type: 'whiteboard',
      attrs: {
        height: 777,
        base: 777,
        bg: 'post',
        items: [
          { id: 'jwb5cig', type: 'canvas', x: 341, y: 42, w: 409, h: 266, aw: 1883, ah: 1224, frame: { x: 0, y: 0, w: 1883, h: 1224 }, bg: 'transparent', items: [{ id: 'vxs8dco', type: 'image', src: IMAGES.vxs8dco, x: 0, y: 0, w: 1883, h: 1224 }] },
          { id: 'qrxnyay', type: 'text', html: 'Enemy encounter at corridor before reaching capture zone.', x: 455, y: 316, w: 206, size: 14, color: '#111111', bold: false, align: 'left', bg: '#fff59d' },
          { id: '9fvc7u8', type: 'canvas', x: 21, y: 49, w: 304, h: 171, aw: 1808, ah: 1019, frame: { x: 0, y: 0, w: 1808, h: 1019 }, bg: 'transparent', items: [{ id: 'l1wv2ns', type: 'image', src: IMAGES.l1wv2ns, x: 0, y: 0, w: 1808, h: 1019 }] },
          { id: 'bjhz6kb', type: 'stroke', x: 156, y: 243, w: 152, h: 32, vw: 152, vh: 32, d: 'M4.8 3.4Q4 5.1 4 5.9Q4 6.6 4 7.4Q4 8.2 4 9Q4 9.9 4 10.6Q4 11.4 4 12.3Q4 13.1 4 13.9Q4 14.6 4 15.4Q4 16.2 4 17Q4 17.9 3.6 18.6Q3.2 19.4 3.2 20.3Q3.2 21.1 3.2 21.9Q3.2 22.6 3.2 23.4Q3.2 24.2 3.2 25Q3.2 25.9 4 26.3Q4.8 26.6 5.6 26.6Q6.4 26.6 7.2 27Q8 27.4 8.8 27.4Q9.6 27.4 10.4 27.8Q11.2 28.2 12 28.2Q12.8 28.2 13.6 28.2Q14.4 28.2 15.2 28.2Q16 28.2 16.8 28.2Q17.6 28.2 18.4 28.2Q19.2 28.2 20 28.2Q20.8 28.2 21.6 28.2Q22.4 28.2 23.2 28.2Q24 28.2 25.2 28.2Q26.4 28.2 27.6 28.2Q28.8 28.2 29.6 28.2Q30.4 28.2 31.2 28.2Q32 28.2 32.8 28.2Q33.6 28.2 34.4 28.2Q35.2 28.2 36 28.2Q36.8 28.2 37.6 28.2Q38.4 28.2 39.2 28.2Q40 28.2 40.8 28.2Q41.6 28.2 42.4 28.2Q43.2 28.2 44.4 28.2Q45.6 28.2 46.8 28.2Q48 28.2 48.8 28.2Q49.6 28.2 50.8 28.2Q52 28.2 52.8 28.2Q53.6 28.2 54.8 28.2Q56 28.2 56.8 28.2Q57.6 28.2 58.8 28.2Q60 28.2 60.8 28.2Q61.6 28.2 62.4 28.2Q63.2 28.2 64.4 28.2Q65.6 28.2 66.4 28.2Q67.2 28.2 68 28.2Q68.8 28.2 70 28.2Q71.2 28.2 72 28.2Q72.8 28.2 73.6 28.2Q74.4 28.2 75.6 28.2Q76.8 28.2 78 27.8Q79.2 27.4 80.4 27.4Q81.6 27.4 82.4 27.4Q83.2 27.4 84 27.4Q84.8 27.4 85.6 27.4Q86.4 27.4 87.2 27.4Q88 27.4 88.8 27.4Q89.6 27.4 90.4 27.4Q91.2 27.4 92 27.4Q92.8 27.4 93.6 27.4Q94.4 27.4 95.2 27.4Q96 27.4 96.8 27.4Q97.6 27.4 98.4 27.4Q99.2 27.4 100 27.4Q100.8 27.4 101.6 27Q102.4 26.6 103.2 26.6Q104 26.6 104.8 26.6Q105.6 26.6 106.4 26.6Q107.2 26.6 108 26.6Q108.8 26.6 109.6 26.3Q110.4 25.9 111.2 25.9Q112 25.9 112.8 25.9Q113.6 25.9 114.4 25.9Q115.2 25.9 116 25.5Q116.8 25.1 117.6 25.1Q118.4 25.1 119.2 25.1Q120 25.1 120.8 25.1Q121.6 25.1 122.4 25.1Q123.2 25.1 124 25.1Q124.8 25.1 125.6 25.1Q126.4 25.1 127.2 25.1Q128 25.1 128.8 24.6Q129.6 24.2 130.4 24.2Q131.2 24.2 132 23.8Q132.8 23.4 133.6 23.4Q134.4 23.4 135.2 23Q136 22.6 136.8 22.3Q137.6 21.9 138.4 21.9Q139.2 21.9 140 21.9Q140.8 21.9 141.6 21.9Q142.4 21.9 143.2 21.9Q144 21.9 144.8 21.9Q145.6 21.9 146.4 21.5Q147.2 21.1 148 21.1L148.8 21.1', color: '#e05252', width: 4, opacity: 1 },
          { id: 'kgiawwq', type: 'stroke', x: 265, y: 247, w: 41, h: 42, vw: 41, vh: 42, d: 'M3.8 3.4Q5.4 4.2 5.8 5Q6.2 5.9 7 5.9Q7.8 5.9 8.6 6.6Q9.4 7.4 10.2 7.8Q11 8.2 11.8 8.6Q12.6 9.1 13.4 9.1Q14.2 9.1 15 9.5Q15.8 9.9 16.6 10.3Q17.4 10.6 18.2 11Q19 11.4 19.8 11.4Q20.6 11.4 21.4 11.4Q22.2 11.4 23 11.8Q23.8 12.2 24.6 12.6Q25.4 13.1 26.2 13.1Q27 13.1 27.8 13.5Q28.6 13.9 29.4 13.9Q30.2 13.9 31 14.3Q31.8 14.6 32.6 14.6Q33.4 14.6 34.2 14.6Q35 14.6 35.8 14.6Q36.6 14.6 37 15.4Q37.4 16.2 37.4 17Q37.4 17.9 36.6 18.3Q35.8 18.6 35.4 19.4Q35 20.2 34.2 20.6Q33.4 21.1 32.6 21.5Q31.8 21.9 31 22.3Q30.2 22.6 29.4 23.4Q28.6 24.2 27.8 24.6Q27 25.1 26.2 25.5Q25.4 25.9 24.6 26.3Q23.8 26.6 23.4 27.4Q23 28.2 22.2 28.2Q21.4 28.2 21 29Q20.6 29.9 20.6 30.6Q20.6 31.4 19.8 31.4Q19 31.4 18.2 31.8Q17.4 32.2 17.4 33Q17.4 33.9 16.6 34.3Q15.8 34.6 15.4 35.4Q15 36.2 14.2 36.6Q13.4 37.1 13 37.9L12.6 38.6', color: '#e05252', width: 4, opacity: 1 },
          { id: 'fka4klq', type: 'image', src: IMAGES.fka4klq, x: 762, y: 46, w: 456, h: 262 },
          { id: 'nr81848', type: 'text', html: 'Chokepoint engagement at enemy corridor exit.', x: 885, y: 318, w: 196, size: 14, color: '#111111', bold: false, align: 'left', bg: '#fff59d' },
          { id: 'k3d6sdw', type: 'text', html: 'Green circle marks the reference 3d location anchor', x: 683, y: 115, w: 200, size: 12, color: '#111111', bold: false, align: 'left', bg: '#c8e6c9' },
          { id: 'cathe76', type: 'image', src: IMAGES.cathe76, x: 223, y: 441, w: 540, h: 306 },
          { id: 'td6zulk', type: 'text', html: 'Capture zone', x: 392, y: 702, w: 200, size: 14, color: '#111111', bold: true, align: 'center', bg: '#bbdefb' },
          { id: 'z3vhbye', type: 'text', html: 'This map is in a V-shape, with corridor areas before the converging point, allowing different strategies to be played out.', x: 21, y: 532, w: 191, size: 14, color: '#111111', bold: false, align: 'left', bg: '#fff59d' },
          { id: '6z0j39b', type: 'text', html: 'There is intentional engagement line-of-sight created by the map designers in this engagement example.', x: 1126, y: 239, w: 256, size: 12, color: '#111111', bold: false, align: 'left', bg: '#f8bbd0' },
          { id: '4ljsm7h', type: 'shape', shape: 'ellipse', color: '#00ff33', width: 2, opacity: 1, fill: 'none', fillColor: '#ffffff', x: 435, y: 160, w: 35, h: 31, flipX: false, flipY: false },
          { id: 'fd9y7k9', type: 'shape', shape: 'ellipse', color: '#00ff33', width: 2, opacity: 1, fill: 'none', fillColor: '#ffffff', x: 789, y: 176, w: 119, h: 108, flipX: false, flipY: false },
          { id: '4up3wrt', type: 'shape', shape: 'ellipse', color: '#52ff49', width: 2, opacity: 1, fill: 'none', fillColor: '#ffffff', x: 454, y: 536, w: 94, h: 59, flipX: false, flipY: false },
          { id: '4zmforr', type: 'shape', shape: 'arrow', color: '#52ff49', width: 2, opacity: 1, fill: 'none', fillColor: '#ffffff', x: 533, y: 269, w: 284, h: 284, flipX: true, flipY: false },
          { id: 'r37gcv6', type: 'shape', shape: 'arrow', color: '#52ff49', width: 2, opacity: 1, fill: 'none', fillColor: '#ffffff', x: 441, y: 177, w: 40, h: 368, flipX: false, flipY: false },
        ],
      },
    },
    h2('Smart canvas'),
    para(text('A smart canvas has a set size and shows in the post as one picture. Double-click it to edit it in place in '
      + 'Canvas Mode.')),
    {
      type: 'canvas',
      attrs: {
        w: 2500,
        h: 1250,
        dw: 872,
        frame: { x: 0, y: 0, w: 2500, h: 1250, item: '9ol5dh6' },
        bg: 'transparent',
        items: [
          { id: '9ol5dh6', type: 'image', src: IMAGES['9ol5dh6'], x: 0, y: 0, w: 2500, h: 1250 },
          { id: 'g78ltiy', type: 'shape', shape: 'line', color: '#f50000', width: 8, opacity: 1, fill: 'none', fillColor: '#e05252', x: 231, y: 592, w: 820, h: 38, flipX: true, flipY: true },
          { id: '0ejq22d', type: 'shape', shape: 'line', color: '#f50000', width: 8, opacity: 1, fill: 'none', fillColor: '#e05252', x: 1165, y: 606, w: 590, h: 10, flipX: false, flipY: false },
          { id: '3y4o49t', type: 'shape', shape: 'line', color: '#f50000', width: 8, opacity: 1, fill: 'none', fillColor: '#e05252', x: 1866, y: 611, w: 519, h: 24, flipX: false, flipY: false },
          { id: 'oy0c9gm', type: 'shape', shape: 'rect', color: '#f50000', width: 8, opacity: 1, fill: 'none', fillColor: '#e05252', x: 429, y: 371, w: 377, h: 485, flipX: false, flipY: false },
          { id: 'arnyn9m', type: 'shape', shape: 'rect', color: '#f50000', width: 8, opacity: 1, fill: 'none', fillColor: '#e05252', x: 1250, y: 344, w: 399, h: 529, flipX: false, flipY: false },
          { id: 'rxbvubk', type: 'shape', shape: 'rect', color: '#f50000', width: 8, opacity: 1, fill: 'none', fillColor: '#e05252', x: 2072, y: 310, w: 228, h: 634, flipX: false, flipY: false },
          { id: '3p0hi5r', type: 'shape', shape: 'line', color: '#f50000', width: 8, opacity: 1, fill: 'none', fillColor: '#e05252', x: 2160, y: 75, w: 10, h: 1103, flipX: false, flipY: false },
          { id: 'v5s35fr', type: 'shape', shape: 'line', color: '#f50000', width: 8, opacity: 1, fill: 'none', fillColor: '#e05252', x: 1349, y: 165, w: 209, h: 453, flipX: false, flipY: false },
          { id: 'h495ppx', type: 'shape', shape: 'line', color: '#f50000', width: 8, opacity: 1, fill: 'none', fillColor: '#e05252', x: 1344, y: 604, w: 219, h: 448, flipX: false, flipY: true },
          { id: '0hk9bx0', type: 'shape', shape: 'line', color: '#f50000', width: 8, opacity: 1, fill: 'none', fillColor: '#e05252', x: 581, y: 599, w: 13, h: 503, flipX: true, flipY: true },
          { id: 'kap9k23', type: 'shape', shape: 'line', color: '#f50000', width: 8, opacity: 1, fill: 'none', fillColor: '#e05252', x: 583, y: 160, w: 40, h: 454, flipX: false, flipY: true },
          { id: '2bau9md', type: 'shape', shape: 'ellipse', color: '#e05252', width: 11.467816394486503, opacity: 1, fill: 'none', fillColor: '#e05252', x: 438, y: 464, w: 312, h: 301, flipX: false, flipY: false },
          { id: 'od3fgff', type: 'shape', shape: 'ellipse', color: '#e05252', width: 11.467816394486503, opacity: 1, fill: 'none', fillColor: '#e05252', x: 1923, y: 490, w: 320, h: 267, flipX: false, flipY: false },
        ],
      },
    },
    para(text('Map image by statbanana.com, via https://liquipedia.net/overwatch/Main_Page', CAPTION)),
    h2('Flowcharts'),
    para(text('Connectors stay attached to their shapes, so the lines follow when you move a box. Keep flowcharts in the library '
      + 'to reuse them in other drafts.')),
    demoFlow(),
    h2('Boards in a post'),
    para(text('Each thread can have a plan with a Kanban board and a Gantt chart. Put either one in a post with Insert into draft '
      + 'in the plan\'s menu. The chart follows the plan as it changes until you freeze it. The two below are frozen.')),
    ...planSample(),
    h2('Pushing a post'),
    para(text('Choose the draft\'s thread in the sidebar, then press Push to forum. EasyWriter opens the thread with your post in '
      + 'the reply box, and you press Submit on the forum when it looks right.')),
    para(text('This draft is only an example. Delete it from the sidebar when you no longer need it.', CAPTION)),
  ],
});
