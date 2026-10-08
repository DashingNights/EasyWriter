// Flowchart shape registry and outline geometry (docs/plans/flowchart.md §3.5, SPEC §6d). Pure: no DOM, no imports, so
// whiteboard.js, route.mjs, model.mjs and the Node tests share it.
// A kind's path(w, h, inset) → {d, poly} is in item px (viewBox 0 0 w h, inset = stroke / 2): `d` the SVG outline (null for
// the 9 older kinds, which whiteboard.js shapeGeometry still draws), `poly` the outline as [[x, y]…] (curves sampled; null for
// line and arrow, which attach on their box). `rot` (degrees clockwise) turns a shape about its box centre; x y w h stay
// the unrotated box.

const r1 = (n) => Math.round(n * 10) / 10;
const pt = (x, y) => `${r1(x)} ${r1(y)}`;
const polyD = (poly) => `M${poly.map(([x, y]) => pt(x, y)).join('L')}Z`;
const rectPoly = (l, t, r, b) => [[l, t], [r, t], [r, b], [l, b]];
// n + 1 points on an ellipse arc from angle a0 to a1 (radians).
const arc = (cx, cy, rx, ry, a0, a1, n) => Array.from({ length: n + 1 }, (_, k) => {
  const a = a0 + ((a1 - a0) * k) / n;
  return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
});
const Q = Math.PI / 2;
// A rounded rectangle's outline, each corner sampled with `n` steps.
const roundPoly = (l, t, r, b, rad, n = 4) => [
  ...arc(r - rad, t + rad, rad, rad, -Q, 0, n), ...arc(r - rad, b - rad, rad, rad, 0, Q, n),
  ...arc(l + rad, b - rad, rad, rad, Q, 2 * Q, n), ...arc(l + rad, t + rad, rad, rad, 2 * Q, 3 * Q, n),
];
const roundD = (l, t, r, b, rad) => `M${pt(l + rad, t)}H${r1(r - rad)}A${r1(rad)} ${r1(rad)} 0 0 1 ${pt(r, t + rad)}V${r1(b - rad)}` +
  `A${r1(rad)} ${r1(rad)} 0 0 1 ${pt(r - rad, b)}H${r1(l + rad)}A${r1(rad)} ${r1(rad)} 0 0 1 ${pt(l, b - rad)}V${r1(t + rad)}` +
  `A${r1(rad)} ${r1(rad)} 0 0 1 ${pt(l + rad, t)}Z`;
const old = (poly) => ({ d: null, poly });
const closed = (poly, more = '') => ({ d: polyD(poly) + more, poly });
// The ellipse filling the inset box, plus `more` path (the junction marks): its path and its 32-point outline.
const ellipse = (w, h, i, more = '') => {
  const [cx, cy, rx, ry] = [w / 2, h / 2, Math.max(0.5, w / 2 - i), Math.max(0.5, h / 2 - i)];
  const a = `A${r1(rx)} ${r1(ry)} 0 1 0`;
  return { d: `M${pt(cx - rx, cy)}${a} ${pt(cx + rx, cy)}${a} ${pt(cx - rx, cy)}Z${more}`, poly: arc(cx, cy, rx, ry, 0, 4 * Q, 32).slice(0, 32) };
};
const diamPoly = (w, h, i) => [[w / 2, i], [w - i, h / 2], [w / 2, h - i], [i, h / 2]];
// n + 1 points from x0 to x1 on the wave y = mid + a · sin(2π (x − l) / span): the edges of a document and a tape.
const wave = (x0, x1, mid, a, l, span, n = 16) => Array.from({ length: n + 1 }, (_, k) => {
  const x = x0 + ((x1 - x0) * k) / n;
  return [x, mid + a * Math.sin((2 * Math.PI * (x - l)) / span)];
});
// A kind drawn in its inset box: f(left, top, right, bottom, width, height) → {d, poly}.
const inBox = (f) => (w, h, i) => f(i, i, w - i, h - i, w - 2 * i, h - 2 * i);

// 4 sides + 4 corners, as fractions of the box.
export const PORTS = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5], [0, 0], [1, 0], [1, 1], [0, 1]];
export const LANE_BAND = 28; // a swimlane's title band, px

// Registry order (the shape list's order within a group). group ∈ basic | flow | container; keywords: what the shape list and
// the tool search match besides the label. Optional: ports (default PORTS), labelInset (fractions of w / h, default 0.08),
// dash (dashed outline), band (title band px: the label sits in it), align / valign (label defaults), box ([w, h] post px of a
// click-placed shape, default 160 × 110), open (an open outline: never filled; it attaches and hit-tests on its box).
export const KINDS = [
  { kind: 'rect', label: 'Box', group: 'basic', keywords: ['rectangle', 'square', 'rect', 'border', 'outline', 'process', 'rectange', 'sqaure'],
    path: (w, h, i) => old(rectPoly(i, i, w - i, h - i)) },
  { kind: 'round', label: 'Rounded box', group: 'basic', keywords: ['rounded rectangle', 'rounded square', 'round rect', 'rounded corners', 'pill', 'button'],
    path: (w, h, i) => old(roundPoly(i, i, w - i, h - i, Math.max(0, Math.min(w, h) * 0.18 - i))) },
  { kind: 'ellipse', label: 'Circle', group: 'basic', keywords: ['ellipse', 'oval', 'round', 'ring', 'elipse', 'cirlce', 'circel'],
    path: (w, h, i) => old(arc(w / 2, h / 2, Math.max(0.5, w / 2 - i), Math.max(0.5, h / 2 - i), 0, 4 * Q, 32).slice(0, 32)) },
  { kind: 'triangle', label: 'Triangle', group: 'basic', keywords: ['tri', 'pyramid', 'delta', 'wedge', 'trinagle', 'traingle'],
    path: (w, h, i) => old([[w / 2, i], [w - i, h - i], [i, h - i]]) },
  {
    kind: 'star', label: 'Star', group: 'basic', keywords: ['favourite', 'favorite', 'rating', 'sparkle', 'asterisk'],
    path: (w, h, i) => old(Array.from({ length: 10 }, (_, k) => {
      const a = -Q + (k * Math.PI) / 5;
      const s = k % 2 ? 0.45 : 1;
      return [w / 2 + Math.cos(a) * (w / 2 - i) * s, h / 2 + Math.sin(a) * (h / 2 - i) * s];
    })),
  },
  { kind: 'arrow', label: 'Arrow', group: 'basic', keywords: ['pointer', 'direction', 'connector', 'pointing', 'arow', 'arrrow'], path: () => old(null) },
  { kind: 'line', label: 'Line', group: 'basic', keywords: ['straight line', 'rule', 'connector', 'segment', 'stroke'], path: () => old(null) },
  {
    // The cloud's ellipse body, widened to its bumps (the puffs are left out).
    kind: 'thought', label: 'Thought bubble', group: 'basic', keywords: ['thought', 'think', 'thinking', 'cloud', 'bubble', 'idea'],
    path: (w, h, i) => old(arc(w / 2, i + (h - 2 * i) * 0.4, (w / 2 - i) * 0.84 * 1.1, (h - 2 * i) * 0.32 * 1.1, 0, 4 * Q, 32).slice(0, 32)),
  },
  {
    kind: 'speech', label: 'Speech bubble', group: 'basic',
    keywords: ['speech', 'speech balloon', 'callout', 'comic', 'talk', 'say', 'dialogue', 'dialog', 'chat', 'bubble', 'balloon'],
    path: (w, h, i) => {
      const [l, t, r, b] = [i, i, w - i, h - i];
      const bb = b - (h - 2 * i) * 0.22;
      return old([[l, t], [r, t], [r, bb], [l + (r - l) * 0.42, bb], [l + (r - l) * 0.16, b], [l + (r - l) * 0.28, bb], [l, bb]]);
    },
  },
  {
    // A regular pentagon stretched to the box.
    kind: 'pentagon', label: 'Pentagon', group: 'basic', keywords: ['five sides', 'polygon', 'house'],
    path: inBox((l, t, r, b, W, H) => closed(Array.from({ length: 5 }, (_, k) => {
      const a = -Q + (k * 4 * Q) / 5;
      return [l + (W / 2) * (1 + Math.cos(a) / Math.cos(Q / 5)), t + (H * (1 + Math.sin(a))) / (1 + Math.cos(Q * 0.4))];
    }))),
  },
  {
    kind: 'octagon', label: 'Octagon', group: 'basic', keywords: ['stop sign', 'eight sides', 'polygon'],
    path: inBox((l, t, r, b, W, H) => {
      const c = Math.min(W, H) * 0.29;
      return closed([[l + c, t], [r - c, t], [r, t + c], [r, b - c], [r - c, b], [l + c, b], [l, b - c], [l, t + c]]);
    }),
  },
  {
    kind: 'plus', label: 'Plus', group: 'basic', keywords: ['add', 'greek cross', 'cross', 'positive'],
    path: inBox((l, t, r, b, W, H) => {
      const [a, e] = [W / 3, H / 3];
      return closed([[l + a, t], [r - a, t], [r - a, t + e], [r, t + e], [r, b - e], [r - a, b - e], [r - a, b], [l + a, b], [l + a, b - e], [l, b - e], [l, t + e], [l + a, t + e]]);
    }),
  },
  {
    kind: 'cross', label: 'Cross', group: 'basic', keywords: ['x', 'times', 'multiply', 'saltire', 'close', 'wrong'],
    path: inBox((l, t, r, b, W, H) => closed([[0, 0.15], [0.15, 0], [0.5, 0.35], [0.85, 0], [1, 0.15], [0.65, 0.5], [1, 0.85], [0.85, 1], [0.5, 0.65],
      [0.15, 1], [0, 0.85], [0.35, 0.5]].map(([u, v]) => [l + u * W, t + v * H]))),
  },
  {
    // Nine bumps on an ellipse (|sin| humps, cusps pointing in).
    kind: 'cloud', label: 'Cloud', group: 'basic', keywords: ['internet', 'network', 'sky', 'weather', 'online'],
    path: inBox((l, t, r, b, W, H) => closed(Array.from({ length: 72 }, (_, k) => {
      const a = (k * 4 * Q) / 72;
      const s = 0.8 + 0.2 * Math.abs(Math.sin(a * 4.5));
      return [l + (W / 2) * (1 + s * Math.cos(a)), t + (H / 2) * (1 + s * Math.sin(a))];
    }))),
  },
  {
    kind: 'stadium', label: 'Terminator', group: 'flow', keywords: ['start', 'end', 'stop', 'begin', 'finish', 'pill', 'stadium', 'terminal'],
    path: (w, h, i) => {
      const rad = Math.max(0, Math.min(w, h) / 2 - i);
      return { d: roundD(i, i, w - i, h - i, rad), poly: roundPoly(i, i, w - i, h - i, rad, 8) };
    },
  },
  { kind: 'diam', label: 'Decision', group: 'flow', labelInset: { x: 0.2, y: 0.2 }, keywords: ['if', 'branch', 'condition', 'question', 'yes no', 'rhombus', 'diamond'],
    path: (w, h, i) => closed(diamPoly(w, h, i)) },
  { kind: 'lean-r', label: 'Data', group: 'flow', labelInset: { x: 0.2, y: 0.08 }, keywords: ['input', 'output', 'io', 'i/o', 'parallelogram', 'lean right'],
    path: inBox((l, t, r, b, W) => closed([[l + W * 0.2, t], [r, t], [r - W * 0.2, b], [l, b]])) },
  { kind: 'lean-l', label: 'Data (reversed)', group: 'flow', labelInset: { x: 0.2, y: 0.08 }, keywords: ['input', 'output', 'io', 'parallelogram', 'lean left', 'reversed'],
    path: inBox((l, t, r, b, W) => closed([[l, t], [r - W * 0.2, t], [r, b], [l + W * 0.2, b]])) },
  { kind: 'doc', label: 'Document', group: 'flow', labelInset: { x: 0.08, y: 0.12 }, keywords: ['doc', 'paper', 'report', 'file', 'page', 'printout'],
    path: inBox((l, t, r, b, W, H) => closed([[l, t], [r, t], ...wave(r, l, b - H * 0.08, H * 0.08, l, W)])) },
  {
    // Three sheets: the front one whole, the two behind it up and right by o.
    kind: 'docs', label: 'Multi-document', group: 'flow', labelInset: { x: 0.1, y: 0.14 }, keywords: ['documents', 'multiple documents', 'docs', 'files', 'pages', 'stack', 'reports'],
    path: inBox((l, t, r, b, W, H) => {
      const o = Math.min(W, H) * 0.06;
      const [f, a] = [r - 2 * o, (H - 2 * o) * 0.08];
      const front = wave(f, l, b - a, a, l, f - l);
      const y = b - a; // the front sheet's lower corners
      return {
        d: `${polyD([[l, t + 2 * o], [f, t + 2 * o], ...front])}M${pt(l + o, t + 2 * o)}V${r1(t + o)}H${r1(r - o)}V${r1(y - o)}H${r1(f)}` +
          `M${pt(l + 2 * o, t + o)}V${r1(t)}H${r1(r)}V${r1(y - 2 * o)}H${r1(r - o)}`,
        poly: [[l, t + 2 * o], [l + o, t + 2 * o], [l + o, t + o], [l + 2 * o, t + o], [l + 2 * o, t], [r, t], [r, y - 2 * o], [r - o, y - 2 * o], [r - o, y - o], [f, y - o], ...front],
      };
    }),
  },
  { kind: 'fr-rect', label: 'Subroutine', group: 'flow', labelInset: { x: 0.14, y: 0.08 }, keywords: ['predefined process', 'function', 'procedure', 'call', 'subprocess', 'module'],
    path: inBox((l, t, r, b, W) => closed(rectPoly(l, t, r, b), `M${pt(l + W * 0.1, t)}V${r1(b)}M${pt(r - W * 0.1, t)}V${r1(b)}`)) },
  {
    kind: 'hex', label: 'Preparation', group: 'flow', labelInset: { x: 0.2, y: 0.08 }, keywords: ['prepare', 'setup', 'initialise', 'initialize', 'hexagon', 'loop'],
    path: inBox((l, t, r, b, W, H) => {
      const s = Math.min(W * 0.2, H / 2);
      return closed([[l + s, t], [r - s, t], [r, t + H / 2], [r - s, b], [l + s, b], [l, t + H / 2]]);
    }),
  },
  { kind: 'sl-rect', label: 'Manual input', group: 'flow', keywords: ['keyboard', 'enter', 'type in', 'user input', 'sloped'],
    path: inBox((l, t, r, b, W, H) => closed([[l, t + H * 0.25], [r, t], [r, b], [l, b]])) },
  { kind: 'trap-t', label: 'Manual operation', group: 'flow', labelInset: { x: 0.2, y: 0.08 }, keywords: ['manual', 'by hand', 'trapezoid', 'inverted trapezoid'],
    path: inBox((l, t, r, b, W) => closed([[l, t], [r, t], [r - W * 0.2, b], [l + W * 0.2, b]])) },
  { kind: 'trap-b', label: 'Priority', group: 'flow', labelInset: { x: 0.2, y: 0.08 }, keywords: ['priority action', 'trapezoid', 'important'],
    path: inBox((l, t, r, b, W) => closed([[l + W * 0.2, t], [r - W * 0.2, t], [r, b], [l, b]])) },
  {
    kind: 'curv-trap', label: 'Display', group: 'flow', labelInset: { x: 0.16, y: 0.08 }, keywords: ['screen', 'monitor', 'show', 'output', 'curved trapezoid'],
    path: inBox((l, t, r, b, W, H) => {
      const [s, e, cy] = [W * 0.15, Math.min(W * 0.15, H / 2), t + H / 2];
      return { d: `M${pt(l, cy)}L${pt(l + s, t)}H${r1(r - e)}A${r1(e)} ${r1(H / 2)} 0 0 1 ${pt(r - e, b)}H${r1(l + s)}Z`,
        poly: [[l, cy], [l + s, t], ...arc(r - e, cy, e, H / 2, -Q, Q, 8), [l + s, b]] };
    }),
  },
  {
    // Convex on the left, concave on the right.
    kind: 'bow-rect', label: 'Stored data', group: 'flow', labelInset: { x: 0.14, y: 0.08 }, keywords: ['storage', 'data store', 'saved data', 'bow'],
    path: inBox((l, t, r, b, W, H) => {
      const [e, ry, cy] = [Math.min(W * 0.12, H / 2), H / 2, t + H / 2];
      return { d: `M${pt(l + e, t)}H${r1(r)}A${r1(e)} ${r1(ry)} 0 0 0 ${pt(r, b)}H${r1(l + e)}A${r1(e)} ${r1(ry)} 0 0 1 ${pt(l + e, t)}Z`,
        poly: [...arc(r, cy, e, ry, -Q, -3 * Q, 8), ...arc(l + e, cy, e, ry, Q, 3 * Q, 8)] };
    }),
  },
  {
    // Body, then the front half of the top ellipse.
    kind: 'cyl', label: 'Database', group: 'flow', labelInset: { x: 0.08, y: 0.2 }, keywords: ['db', 'cylinder', 'sql', 'table', 'disk', 'storage', 'data store'],
    path: inBox((l, t, r, b, W, H) => {
      const [rx, ry, cx] = [W / 2, Math.min(H * 0.12, W * 0.25), l + W / 2];
      const a = `A${r1(rx)} ${r1(ry)} 0 0`;
      return { d: `M${pt(l, t + ry)}${a} 1 ${pt(r, t + ry)}V${r1(b - ry)}${a} 1 ${pt(l, b - ry)}ZM${pt(l, t + ry)}${a} 0 ${pt(r, t + ry)}`,
        poly: [...arc(cx, t + ry, rx, ry, 2 * Q, 4 * Q, 12), ...arc(cx, b - ry, rx, ry, 0, 2 * Q, 12)] };
    }),
  },
  {
    kind: 'h-cyl', label: 'Direct access', group: 'flow', labelInset: { x: 0.18, y: 0.08 }, keywords: ['direct access storage', 'drum', 'hard disk', 'horizontal cylinder', 'storage'],
    path: inBox((l, t, r, b, W, H) => {
      const [rx, ry, cy] = [Math.min(W * 0.12, H * 0.25), H / 2, t + H / 2];
      const a = `A${r1(rx)} ${r1(ry)} 0 0`;
      return { d: `M${pt(l + rx, t)}H${r1(r - rx)}${a} 1 ${pt(r - rx, b)}H${r1(l + rx)}${a} 1 ${pt(l + rx, t)}ZM${pt(r - rx, t)}${a} 0 ${pt(r - rx, b)}`,
        poly: [...arc(r - rx, cy, rx, ry, -Q, Q, 12), ...arc(l + rx, cy, rx, ry, Q, 3 * Q, 12)] };
    }),
  },
  {
    kind: 'win-pane', label: 'Internal storage', group: 'flow', labelInset: { x: 0.14, y: 0.14 }, keywords: ['memory', 'ram', 'window pane', 'storage'],
    path: inBox((l, t, r, b, W, H) => {
      const e = Math.min(W, H) * 0.15;
      return closed(rectPoly(l, t, r, b), `M${pt(l + e, t)}V${r1(b)}M${pt(l, t + e)}H${r1(r)}`);
    }),
  },
  {
    kind: 'delay', label: 'Delay', group: 'flow', keywords: ['wait', 'pause', 'hold', 'half rounded', 'd shape'],
    path: inBox((l, t, r, b, W, H) => {
      const [e, cy] = [Math.min(W, H) / 2, t + H / 2];
      return { d: `M${pt(l, t)}H${r1(r - e)}A${r1(e)} ${r1(H / 2)} 0 0 1 ${pt(r - e, b)}H${r1(l)}Z`, poly: [[l, t], ...arc(r - e, cy, e, H / 2, -Q, Q, 12), [l, b]] };
    }),
  },
  { kind: 'sm-circ', label: 'On-page connector', group: 'flow', box: [60, 60], labelInset: { x: 0.15, y: 0.15 }, keywords: ['connector', 'reference', 'jump', 'small circle', 'circle'],
    path: (w, h, i) => ellipse(w, h, i) },
  { kind: 'off-page', label: 'Off-page connector', group: 'flow', box: [80, 80], labelInset: { x: 0.08, y: 0.12 }, keywords: ['off page', 'continue', 'next page', 'home plate', 'pentagon'],
    path: inBox((l, t, r, b, W, H) => closed([[l, t], [r, t], [r, t + H * 0.6], [l + W / 2, b], [l, t + H * 0.6]])) },
  {
    kind: 'notch-pent', label: 'Loop limit', group: 'flow', keywords: ['loop', 'repeat', 'while', 'for', 'iteration', 'notched pentagon'],
    path: inBox((l, t, r, b, W, H) => {
      const c = Math.min(W, H) * 0.2;
      return closed([[l + c, t], [r - c, t], [r, t + c], [r, b], [l, b], [l, t + c]]);
    }),
  },
  {
    kind: 'cross-circ', label: 'Summing junction', group: 'flow', box: [60, 60], keywords: ['sum', 'and', 'junction', 'crossed circle', 'x circle'],
    path: (w, h, i) => {
      const [cx, cy, kx, ky] = [w / 2, h / 2, (w / 2 - i) * Math.SQRT1_2, (h / 2 - i) * Math.SQRT1_2];
      return ellipse(w, h, i, `M${pt(cx - kx, cy - ky)}L${pt(cx + kx, cy + ky)}M${pt(cx + kx, cy - ky)}L${pt(cx - kx, cy + ky)}`);
    },
  },
  { kind: 'or-circ', label: 'Or', group: 'flow', box: [60, 60], keywords: ['junction', 'merge', 'plus circle'],
    path: (w, h, i) => ellipse(w, h, i, `M${pt(w / 2, i)}V${r1(h - i)}M${pt(i, h / 2)}H${r1(w - i)}`) },
  { kind: 'hourglass', label: 'Collate', group: 'flow', box: [80, 100], keywords: ['hourglass', 'bowtie', 'order', 'organise', 'organize'],
    path: inBox((l, t, r, b) => closed([[l, t], [r, t], [l, b], [r, b]])) },
  { kind: 'sort', label: 'Sort', group: 'flow', labelInset: { x: 0.2, y: 0.2 }, keywords: ['order', 'arrange', 'split diamond'],
    path: (w, h, i) => closed(diamPoly(w, h, i), `M${pt(i, h / 2)}H${r1(w - i)}`) },
  {
    kind: 'notch-rect', label: 'Card', group: 'flow', keywords: ['punch card', 'punched card', 'notched rectangle'],
    path: inBox((l, t, r, b, W, H) => {
      const c = Math.min(W, H) * 0.2;
      return closed([[l + c, t], [r, t], [r, b], [l, b], [l, t + c]]);
    }),
  },
  { kind: 'flag', label: 'Tape', group: 'flow', labelInset: { x: 0.08, y: 0.16 }, keywords: ['paper tape', 'punched tape', 'flag', 'wave'],
    path: inBox((l, t, r, b, W, H) => closed([...wave(l, r, t + H * 0.08, H * 0.08, l, W), ...wave(r, l, b - H * 0.08, H * 0.08, l, W)])) },
  {
    // A curly brace down the left side; the text sits right of it.
    kind: 'brace', label: 'Annotation', group: 'flow', open: true, align: 'left', labelInset: { x: 0.12, y: 0.04 },
    keywords: ['comment', 'note', 'remark', 'brace', 'bracket', 'curly'],
    path: inBox((l, t, r, b, W, H) => {
      const e = Math.min(H / 4, W / 2, 16);
      const [m, cy] = [l + e / 2, t + H / 2];
      return {
        d: `M${pt(l + e, t)}Q${pt(m, t)} ${pt(m, t + e)}V${r1(cy - e)}Q${pt(m, cy)} ${pt(l, cy)}Q${pt(m, cy)} ${pt(m, cy + e)}V${r1(b - e)}Q${pt(m, b)} ${pt(l + e, b)}`,
        poly: rectPoly(l, t, r, b),
      };
    }),
  },
  { kind: 'fork', label: 'Fork/join bar', group: 'flow', box: [160, 14], keywords: ['join', 'bar', 'parallel', 'synchronisation', 'synchronization', 'split', 'merge'],
    path: inBox((l, t, r, b) => closed(rectPoly(l, t, r, b))) },
  {
    kind: 'lane', label: 'Swimlane', group: 'container', band: LANE_BAND, box: [900, 180], keywords: ['swim lane', 'lane', 'pool', 'container', 'group', 'actor', 'role'],
    path: (w, h, i) => {
      const poly = rectPoly(i, i, w - i, h - i);
      return { d: `${polyD(poly)}M${pt(i, Math.min(LANE_BAND, h - i))}H${r1(w - i)}`, poly };
    },
  },
  {
    kind: 'frame', label: 'Frame', group: 'container', dash: true, labelInset: { x: 0.01, y: 0.01 }, align: 'left', valign: 'top',
    keywords: ['group', 'container', 'border', 'section', 'dashed box', 'area'],
    path: (w, h, i) => {
      const poly = rectPoly(i, i, w - i, h - i);
      return { d: polyD(poly), poly };
    },
  },
];
const BY_KIND = new Map(KINDS.map((k) => [k.kind, k]));
export const kindOf = (kind) => BY_KIND.get(kind) ?? null;

// --- rotation ---

const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const rotOf = (it) => (it.type === 'shape' && Number.isFinite(it.rot) ? it.rot : 0); // only shapes turn

/** Point `p` turned `deg` degrees clockwise (screen axes, y down) about `c`; the inverse is -deg. */
export function rotatePoint(p, c, deg) {
  if (!deg) return { x: p.x, y: p.y };
  const a = (deg * Math.PI) / 180;
  const [cos, sin, dx, dy] = [Math.cos(a), Math.sin(a), p.x - c.x, p.y - c.y];
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** `poly` ([[x, y]…] in item px) placed at box `b` ({x, y, w, h, rot?}) and turned about its centre → [{x, y}] board px. */
export function rotatePoly(b, poly) {
  const c = centre(b);
  return poly.map(([x, y]) => rotatePoint({ x: b.x + x, y: b.y + y }, c, b.rot));
}

/** The axis-aligned bounds of box `b` turned by `b.rot` about its centre. */
export function rotBox(b) {
  if (!b.rot) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const a = (b.rot * Math.PI) / 180;
  const [cos, sin] = [Math.abs(Math.cos(a)), Math.abs(Math.sin(a))];
  const [w, h] = [b.w * cos + b.h * sin, b.w * sin + b.h * cos];
  const c = centre(b);
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

// --- outline, perimeter, ports ---

/** Item `it`'s outline in board px ([{x, y}]): its kind's poly, else its box, turned by a shape's rot. `b`: its unrotated box
 * (text: the rendered height; default the item itself). */
export function outlineOf(it, b = it) {
  const poly = (it.type === 'shape' && kindOf(it.shape)?.path(b.w, b.h, (it.width || 0) / 2).poly) || rectPoly(0, 0, b.w, b.h);
  return rotatePoly({ x: b.x, y: b.y, w: b.w, h: b.h, rot: rotOf(it) }, poly);
}

/** Where the ray from `from` through `toward` leaves polygon `poly` ([{x, y}]): its farthest crossing (the outer edge of a
 * concave outline); `from` itself when the ray is degenerate or misses. */
export function perimeter(poly, from, toward) {
  const [dx, dy] = [toward.x - from.x, toward.y - from.y];
  if (!dx && !dy) return { x: from.x, y: from.y };
  let best = -1;
  for (let k = 0; k < poly.length; k++) {
    const [a, b] = [poly[k], poly[(k + 1) % poly.length]];
    const [ex, ey, ax, ay] = [b.x - a.x, b.y - a.y, a.x - from.x, a.y - from.y];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ey - ay * ex) / den; // along the ray
    const u = (ax * dy - ay * dx) / den; // along the edge
    if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 && t > best) best = t;
  }
  return best < 0 ? { x: from.x, y: from.y } : { x: from.x + dx * best, y: from.y + dy * best };
}

/** A fixed anchor ([rx, ry] of the unrotated box) turned with the item and moved from the centre onto its outline, so a
 * box port lands on a diamond's edge and a bound end turns with its shape. */
export function anchorPoint(it, anchor, b = it) {
  const c = centre(b);
  const p = rotatePoint({ x: b.x + anchor[0] * b.w, y: b.y + anchor[1] * b.h }, c, rotOf(it));
  return perimeter(outlineOf(it, b), c, p);
}

export const portsOf = (it) => (it.type === 'shape' && kindOf(it.shape)?.ports) || PORTS;

/** The item's port points in board px (on its turned outline). */
export const portPoints = (it, b = it) => portsOf(it).map((a) => anchorPoint(it, a, b));

/** The outward unit normal of the box side an anchor is on, turned by a shape's rot. */
export function portNormal(it, anchor) {
  const [dx, dy] = [anchor[0] - 0.5, anchor[1] - 0.5];
  const n = Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) };
  return rotatePoint(n, { x: 0, y: 0 }, rotOf(it));
}

// --- styles ---

/** draw.io's default fill / stroke pairs (text #111111) plus two theme pairs: card / ink and transparent / ink (dark theme
 * values; flowPreset picks per theme). Raw hex: agents may pass `preset: n` in place of colours. */
export const STYLE_PRESETS = [
  ['#ffffff', '#000000'], ['#f5f5f5', '#666666'], ['#dae8fc', '#6c8ebf'], ['#d5e8d4', '#82b366'], ['#ffe6cc', '#d79b00'],
  ['#fff2cc', '#d6b656'], ['#f8cecc', '#b85450'], ['#e1d5e7', '#9673a6'],
].map(([fill, stroke]) => ({ fill, stroke, text: '#111111' })).concat([
  { fill: '#3a3b46', stroke: '#ffffff', text: '#ffffff' },
  { fill: 'transparent', stroke: '#ffffff', text: '#ffffff' },
]);

/** The shape tool preset of Insert flowchart and the library editor: ink and card colours of the page theme. */
export function flowPreset(theme) {
  const [ink, card] = theme === 'light' ? ['#111111', '#f0f0f4'] : ['#ffffff', '#3a3b46'];
  return { shape: 'rect', color: ink, width: 2, opacity: 1, fill: 'solid', fillColor: card, size: 16, textColor: ink };
}

/** STYLE_PRESETS with the two theme pairs in `theme`'s card and ink (the preset row's swatches). */
export function stylePresets(theme) {
  const { fillColor: card, color: ink } = flowPreset(theme);
  return STYLE_PRESETS.map((p, k) => (k < 8 ? p : { fill: k === 8 ? card : p.fill, stroke: ink, text: ink }));
}
