// The shape library (docs/plans/word/briefs/shape-pool.md Checks): every DrawingML preset evaluates to a closed path at its default
// adjustments, handles keep their values in range, prstGeom with avLst goes out and back unchanged, and Word's gallery and the
// board's lists hold the same presets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { exportDocx } from '../src/document/docx/export.mjs';
import { importDocx } from '../src/document/docx/import.mjs';
import { SHAPE_GROUPS, SHAPE_MAP } from '../src/document/wp/shapes/map.mjs';
import { GALLERY } from '../src/flow/gallery.mjs';
import { PRESET_NAMES, presetAdjust, presetAdjusted, presetHandles, presetShape } from '../src/flow/presets.mjs';
import { anchorPoint, handlesOf, adjustedAv, kindOf, labelBox, portNormal, portsOf, presetKind, SHAPE_KINDS, upgradedShape } from '../src/flow/shapes.mjs';

const LINES = new Set(['line', 'lineInv', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'bentConnector4', 'bentConnector5',
  'curvedConnector2', 'curvedConnector3', 'curvedConnector4', 'curvedConnector5']);

test('every preset draws at its defaults: finite numbers, its filled parts closed, an outline of three points or more', () => {
  assert.equal(PRESET_NAMES.length, 187);
  for (const prst of PRESET_NAMES) {
    for (const [w, h] of [[120, 80], [40, 160]]) {
      const s = presetShape(prst, null, w, h);
      assert.ok(s.parts.length && s.parts.every((p) => p.d && !/NaN|Infinity/.test(p.d)), prst);
      if (LINES.has(prst)) continue;
      const filled = s.parts.filter((p) => p.fill !== 'none');
      assert.ok(filled.length, `${prst} fills`);
      // Closed: each subpath ends with Z or where it began (a whole ellipse, the smiley's eyes).
      const ends = (sub) => { const n = sub.match(/-?[\d.]+/g).map(Number); return Math.hypot(n[0] - n.at(-2), n[1] - n.at(-1)) < 0.05; };
      for (const p of filled) for (const sub of p.d.split(/(?=M)/)) assert.ok(/Z$/.test(sub) || ends(sub), `${prst} closed: ${sub.slice(0, 60)}`);
      assert.ok(s.poly?.length >= 3, `${prst} outline`);
    }
  }
});

test('a dragged handle keeps every value it drags within its range, and a drag onto itself changes nothing', () => {
  const far = (w, h) => [[-2 * w, -2 * h], [3 * w, -2 * h], [3 * w, 3 * h], [-2 * w, 3 * h], [w / 2, h / 2]];
  for (const prst of PRESET_NAMES) {
    const [w, h] = [120, 80];
    presetHandles(prst, null, w, h).forEach((hd, k) => {
      for (const [x, y] of far(w, h)) {
        const av = presetAdjusted(prst, null, w, h, k, { x, y });
        for (const r of presetHandles(prst, av, w, h)[k].refs) {
          assert.ok(av[r.name] >= r.min - 1 && av[r.name] <= r.max + 1, `${prst} handle ${k} ${r.name} = ${av[r.name]} in ${r.min}..${r.max}`);
        }
      }
      const same = presetAdjusted(prst, null, w, h, k, hd);
      const d = presetAdjust(prst);
      for (const r of hd.refs) if (d[r.name] >= r.min && d[r.name] <= r.max) assert.ok(Math.abs(same[r.name] - d[r.name]) <= 1, `${prst} handle ${k} stays`);
    });
  }
  // A right arrow's head handle: dragged left by 20 px of a 50 px tall arrow, its head grows by 40 % of the short side.
  assert.deepEqual(presetAdjusted('rightArrow', null, 100, 50, 1, { x: 55, y: 0 }), { adj1: 50000, adj2: 90000 });
});

test('on the board: handles in item px (inset by half the line, mirrored with it), a drag changes the path, text in the text rectangle', () => {
  const it = { type: 'shape', shape: 'rightArrow', x: 0, y: 0, w: 102, h: 52, width: 2 };
  assert.deepEqual(handlesOf(it), [{ x: 1, y: 13.5 }, { x: 76, y: 1 }]);
  assert.deepEqual(handlesOf({ ...it, mirrorX: true })[1], { x: 26, y: 1 });
  const av = adjustedAv(it, 1, { x: 56, y: 1 });
  assert.deepEqual(av, { adj1: 50000, adj2: 90000 });
  assert.notEqual(kindOf('rightArrow').path(102, 52, 1, { ...it, av }).d, kindOf('rightArrow').path(102, 52, 1, it).d);
  assert.deepEqual(labelBox(it), { l: 1, t: 13.5, r: 13.5, b: 13.5 }, 'the shaft: l y1 x2 y2');
  assert.equal(labelBox({ ...it, shape: 'rect' }), null, 'a board kind keeps its own label box');
  assert.deepEqual(labelBox({ ...it, shape: 'rect', inset: { t: 2, r: 3, b: 4, l: 5 } }), { l: 6, t: 3, r: 4, b: 5 }, 'from Word: its margins');
});

test('connection sites: a preset kind\'s ports, where the line ends, leaving the way the site faces', () => {
  const it = { type: 'shape', shape: 'rightArrow', x: 10, y: 20, w: 100, h: 50, width: 0 };
  assert.deepEqual(portsOf(it), [[0.75, 0], [0, 0.5], [0.75, 1], [1, 0.5]]);
  assert.deepEqual(anchorPoint(it, [0.75, 0]), { x: 85, y: 20 }, 'the head\'s top corner');
  assert.deepEqual(portNormal(it, [0.75, 0]), { x: 0, y: -1 });
  assert.equal(portsOf({ ...it, shape: 'diam' }).length, 8, 'a board kind keeps its eight ports');
});

test('Word\'s gallery, the canvas and flowchart lists and the presets: the same shapes', () => {
  const gallery = GALLERY.flatMap((s) => s.shapes.map(([p]) => p));
  const word = Object.values(SHAPE_MAP).filter((m) => m.kind).map((m) => m.prst);
  const board = SHAPE_KINDS.map((k) => k.prst).filter(Boolean);
  assert.deepEqual(word, gallery);
  assert.deepEqual(board, gallery);
  assert.equal(new Set(gallery).size, gallery.length);
  for (const p of gallery) assert.equal(kindOf(presetKind(p)).prst, p, p);
  assert.ok(SHAPE_KINDS.some((k) => k.kind === 'lane') && SHAPE_KINDS.some((k) => k.kind === 'fork'), 'the flowchart editor keeps its own kinds');
  assert.equal(SHAPE_GROUPS.length, GALLERY.length + 1);
});

test('prstGeom with avLst out and back: every preset, the same kind and adjust values', async () => {
  const items = PRESET_NAMES.filter((p) => !LINES.has(p)).map((prst, k) => {
    const d = presetAdjust(prst);
    const av = Object.keys(d).length ? Object.fromEntries(Object.entries(d).map(([n, v], j) => [n, v + 1000 * (j + 1)])) : undefined;
    return { id: `s${k}`, type: 'shape', shape: presetKind(prst), ...(av && { av }), x: (k % 16) * 30, y: Math.floor(k / 16) * 30, w: 24, h: 20,
      fill: 'solid', fillColor: '#156082', color: '#0A2F41', width: 1, opacity: 1 };
  });
  const canvas = { type: 'canvas', attrs: { w: 480, h: 360, dw: 480, frame: { x: 0, y: 0, w: 480, h: 360 }, bg: 'transparent', items } };
  const { bytes } = await exportDocx({ type: 'doc', attrs: {}, content: [canvas] });
  const back = (await importDocx(bytes, { fresh: true })).doc.content.find((n) => n.type === 'canvas').attrs.items;
  assert.equal(back.length, items.length);
  back.forEach((b, k) => assert.deepEqual([b.shape, b.av], [items[k].shape, items[k].av], items[k].shape));
});

test('a draft from before every preset had a kind keeps its preset: drawn and exported as the kind that draws it', async () => {
  const look = { fill: 'solid', fillColor: '#156082', color: '#0A2F41', width: 1, opacity: 1, w: 40, h: 30 };
  const old = [
    { shape: 'rect', prst: 'sun' }, // a preset the board had no kind for
    { shape: 'lean-r', prst: 'parallelogram', av: { adj: 30000 } }, // a board kind standing in for another preset
    { shape: 'brace', prst: 'rightBrace', mirrorX: true }, // stood in for flipped
    { shape: 'rect', prst: 'heart' }, // a heart the old app drew, changed to a rectangle by hand
    // Presets the old import gave a board kind: a rectangle naming one was changed to a rectangle by hand too.
    { shape: 'rect', prst: 'ellipse' },
    { shape: 'rect', prst: 'flowChartDecision' },
    { shape: 'rect', prst: 'flowChartProcess' }, // but this one the old import drew as the rectangle itself
  ].map((x, k) => ({ id: `o${k}`, type: 'shape', x: k * 50, y: 0, ...look, ...x }));
  assert.deepEqual(old.map(upgradedShape).map((it) => [it.shape, it.prst, it.av, !!it.mirrorX]),
    [['sun', undefined, undefined, false], ['parallelogram', undefined, { adj: 30000 }, false], ['rightBrace', undefined, undefined, false], ['rect', 'heart', undefined, false],
      ['rect', 'ellipse', undefined, false], ['rect', 'flowChartDecision', undefined, false], ['flowChartProcess', undefined, undefined, false]]);
  const canvas = { type: 'canvas', attrs: { w: 360, h: 60, dw: 360, frame: { x: 0, y: 0, w: 360, h: 60 }, bg: 'transparent', items: old } };
  const { bytes } = await exportDocx({ type: 'doc', attrs: {}, content: [canvas] });
  const back = (await importDocx(bytes, { fresh: true })).doc.content.find((n) => n.type === 'canvas').attrs.items;
  assert.deepEqual(back.map((b) => [b.shape, b.av, !!b.mirrorX]), [['sun', undefined, false], ['parallelogram', { adj: 30000 }, false], ['rightBrace', undefined, false], ['rect', undefined, false],
    ['rect', undefined, false], ['rect', undefined, false], ['flowChartProcess', undefined, false]]);
});
