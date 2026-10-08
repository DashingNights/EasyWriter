// Flowchart blocks of the smoke sample (actions.js sampleDoc; roadmap B1, C1): one 1200 × 675 canvas with labelled shapes (a
// diamond turned 30°, a swimlane), connectors of every route (ortho, straight, curve; waypoints), labels in all three slots and
// every head kind at least once. Connectors are stored unrouted: the preview, the export and the editor route them (SPEC §6d).
// Then a synced canvas (SPEC §6f) whose library record does not exist: it draws and exports its cache with the missing badge.
const shape = (id, kind, x, y, w, h, html, [fillColor, color], more = {}) => ({
  id, type: 'shape', shape: kind, x, y, w, h, color, width: 2, opacity: 1, fill: 'solid', fillColor, flipX: false, flipY: false,
  html, size: 18, textColor: '#111111', bold: false, ...more,
});
const BLUE = '#3d99f5';
const RED = '#e05252';
const label = (html, color, t) => ({ html, t, dx: 0, dy: 0, size: 16, textColor: color, bold: true });
const conn = (id, from, to, route, [start, end], more = {}) => ({
  id, type: 'connector', from, to, route, corner: 8, points: [], heads: { start, end }, color: BLUE, width: 2, opacity: 1,
  dash: 'solid', jump: 'none', labels: {}, ...more,
});
const at = (item, anchor = null) => ({ item, anchor });

export const flowSample = () => [{
  type: 'canvas',
  attrs: {
    w: 1200,
    h: 675,
    dw: 600,
    frame: { x: 0, y: 0, w: 1200, h: 675 },
    bg: 'post',
    items: [
      shape('fstart', 'stadium', 60, 60, 160, 70, 'Start', ['#d5e8d4', '#82b366']),
      shape('fcheck', 'rect', 320, 55, 180, 80, 'Validate input', ['#dae8fc', '#6c8ebf']),
      shape('fok', 'diam', 600, 40, 180, 110, 'Valid?', ['#fff2cc', '#d6b656'], { rot: 30 }),
      shape('fsave', 'round', 940, 55, 200, 80, 'Save record', ['#dae8fc', '#6c8ebf']),
      shape('flane', 'lane', 40, 440, 1120, 200, 'Errors', ['transparent', '#9673a6'], { fill: 'none', textColor: '#9673a6', bold: true }),
      shape('fnote', 'ellipse', 560, 510, 200, 100, 'Notify user', ['#f8cecc', '#b85450']),
      conn('fc1', at('fstart', [1, 0.5]), at('fcheck', [0, 0.5]), 'straight', ['none', 'arrow'], { labels: { mid: label('submit', BLUE, 0.5) } }),
      conn('fc2', at('fcheck'), at('fok'), 'ortho', ['circle', 'triangle']),
      conn('fc3', at('fok', [1, 0.5]), at('fsave', [0, 0.5]), 'ortho', ['diamond-open', 'triangle-open'], {
        labels: { start: label('1', BLUE, 0.15), mid: label('yes', BLUE, 0.5), end: label('n', BLUE, 0.85) },
      }),
      conn('fc4', at('fok', [0.5, 1]), at('fnote'), 'curve', ['bar', 'diamond'], {
        points: [{ x: 860, y: 330 }], color: RED, dash: 'dotted', labels: { mid: label('no', RED, 0.5) },
      }),
      conn('fc5', at('fsave', [0.5, 1]), at('fnote', [1, 0.5]), 'ortho', ['one', 'many'], { points: [{ x: 1040, y: 380 }] }),
      conn('fc6', { x: 80, y: 330 }, { x: 300, y: 330 }, 'straight', ['cross', 'circle-open'], { labels: { mid: label('legend', BLUE, 0.5) } }),
      conn('fc7', at('fnote'), at('fstart', [0.5, 1]), 'curve', ['zero-one', 'one-many'], { color: RED, labels: { mid: label('retry', RED, 0.5) } }),
      conn('fc8', { x: 120, y: 260 }, at('fcheck', [0.5, 1]), 'ortho', ['zero-many', 'exactly-one'], { dash: 'dashed' }),
    ],
  },
}, {
  type: 'canvas',
  attrs: {
    w: 800,
    h: 300,
    dw: 400,
    frame: { x: 0, y: 0, w: 800, h: 300 },
    bg: 'post',
    flow: { id: '00000000-0000-4000-8000-000000000001', rev: 3 },
    items: [
      shape('mfrom', 'round', 60, 100, 200, 100, 'Cached copy', ['#dae8fc', '#6c8ebf']),
      shape('mto', 'cyl', 540, 90, 200, 120, 'Library record missing', ['#f8cecc', '#b85450']),
      conn('mc1', at('mfrom', [1, 0.5]), at('mto', [0, 0.5]), 'straight', ['none', 'arrow'], { labels: { mid: label('rev 3', BLUE, 0.5) } }),
    ],
  },
}];
