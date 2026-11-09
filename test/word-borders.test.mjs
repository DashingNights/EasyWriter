// The borders work package's pure part (src/document/wp/borders/model.mjs; docs/plans/word/briefs/borders.md Acceptance).
import assert from 'node:assert/strict';
import test from 'node:test';
import { BORDER_STYLES, SHADING_PATTERNS } from '../src/office.mjs';
import {
  cellEdges, cellHas, cellPatch, groupRoles, isLine, mirrored, paraPatch, PATTERN_NAMES, patternName, patternOf, presetBorders, runPatch, settingOf, STYLE_NAMES,
  shadingOf, sixOf, styleName, styleOf, tablePatch, WIDTHS, widthOf,
} from '../src/document/wp/borders/model.mjs';

const pen = { style: 'single', width: 0.5, color: null };
const apply = (list, patches) => list.map((b, i) => {
  const out = { ...b };
  for (const [k, v] of Object.entries(patches[i].borders)) if (v == null) delete out[k]; else out[k] = v;
  return out;
});
const lines = (b) => Object.keys(b).filter((k) => isLine(b[k])).sort();

test('paragraph items: Bottom toggles on three paragraphs, All, Outside, Inside Horizontal and No Border', () => {
  const three = [{}, {}, {}];
  const on = apply(three, paraPatch('bottomBorder', three, pen));
  assert.deepEqual(on.map(lines), [['bottom'], ['bottom'], ['bottom']]);
  assert.equal(on[0].bottom.space, 1);
  const off = apply(on, paraPatch('bottomBorder', on, pen));
  assert.deepEqual(off.map(lines), [[], [], []]);
  assert.deepEqual(lines(apply([{}], paraPatch('allBorders', [{}], pen))[0]), ['between', 'bottom', 'left', 'right', 'top']);
  assert.deepEqual(lines(apply([{}], paraPatch('outsideBorders', [{}], pen))[0]), ['bottom', 'left', 'right', 'top']);
  assert.deepEqual(lines(apply([{}], paraPatch('insideHorizontalBorder', [{}], pen))[0]), ['between']);
  assert.deepEqual(lines(apply([{}], paraPatch('insideBorders', [{}], pen))[0]), ['between']);
  const boxed = apply([{}], paraPatch('allBorders', [{}], pen));
  assert.deepEqual(lines(apply(boxed, paraPatch('noBorder', boxed, pen))[0]), []);
  // A style's border is switched off with nil, so it does not come back from the style.
  assert.deepEqual(paraPatch('bottomBorder', [{ bottom: { style: 'single' } }], pen, [{ bottom: { style: 'single' } }])[0].borders, { bottom: { style: 'nil' } });
});

test('cell items: Outside on 2 x 2 gives outer edges only, Inside gives the inner ones', () => {
  const rect = { left: 0, top: 0, right: 2, bottom: 2 };
  const cells = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([r, c]) => ({ id: `${r}${c}`, rect: { top: r, left: c, bottom: r + 1, right: c + 1 }, borders: null }));
  const out = Object.fromEntries(cellPatch('outsideBorders', rect, cells, pen).map((p) => [p.id, Object.keys(p.borders).sort()]));
  assert.deepEqual(out, { '00': ['left', 'top'], '01': ['right', 'top'], 10: ['bottom', 'left'], 11: ['bottom', 'right'] });
  const inside = Object.fromEntries(cellPatch('insideBorders', rect, cells, pen).map((p) => [p.id, Object.keys(p.borders).sort()]));
  assert.deepEqual(inside, { '00': ['bottom', 'right'], '01': ['bottom', 'left'], 10: ['right', 'top'], 11: ['left', 'top'] });
  const h = Object.fromEntries(cellPatch('insideHorizontalBorder', rect, cells, pen).map((p) => [p.id, Object.keys(p.borders).sort()]));
  assert.deepEqual(h, { '00': ['bottom'], '01': ['bottom'], 10: ['top'], 11: ['top'] });
  assert.deepEqual(cellPatch('diagonalDownBorder', rect, cells, pen).map((p) => Object.keys(p.borders)), [['tl2br'], ['tl2br'], ['tl2br'], ['tl2br']]);
});

test('cells read the lines they draw: a Table Grid cell shows Bottom pressed and the first press removes it, on both cells', () => {
  // A 2 x 2 table in Table Grid (one edge for all six), the caret in the top left cell; ids are the cells' positions.
  const te = sixOf({ style: 'single', width: 0.5, color: null });
  const map = { width: 2, height: 2, map: [0, 10, 20, 30], findCell: (rel) => ({ left: (rel / 10) % 2, top: Math.floor(rel / 20), right: (rel / 10) % 2 + 1, bottom: Math.floor(rel / 20) + 1 }) };
  const rect = map.findCell(0);
  const cell = { id: 100, rect, borders: cellEdges(null, rect, 2, 2, te) };
  assert.equal(cellHas('bottomBorder', rect, [cell]), true);
  const p = mirrored(cellPatch('bottomBorder', rect, [cell], pen), map, 100);
  assert.deepEqual(p, [{ id: 100, borders: { bottom: { style: 'nil' } } }, { id: 120, borders: { top: { style: 'nil' } } }]);
  // A cell's own edge beats the table's; the table's own beats its style's.
  assert.equal(cellEdges({ bottom: { style: 'nil' } }, rect, 2, 2, te).bottom.style, 'nil');
  assert.equal(cellEdges(null, rect, 2, 2, { ...te, insideV: { style: 'nil' } }).right.style, 'nil');
  // A whole table: All Borders in Table Grid removes the six edges, and No Border writes nil on all six.
  const all = [0, 10, 20, 30].map((rel) => ({ id: 100 + rel, rect: map.findCell(rel), borders: cellEdges(null, map.findCell(rel), 2, 2, te) }));
  const whole = { left: 0, top: 0, right: 2, bottom: 2 };
  assert.equal(cellHas('allBorders', whole, all), true);
  // The press removes them only in a matching pen: a 3 pt pen redraws the 0.5 pt grid instead.
  assert.equal(cellHas('allBorders', whole, all, { style: 'single', width: 0.5, color: null }), true);
  assert.equal(cellHas('allBorders', whole, all, { style: 'single', width: 3, color: null }), false);
  assert.equal(cellPatch('allBorders', whole, all, { style: 'single', width: 3, color: null })[0].borders.bottom.width, 3);
  assert.deepEqual(Object.values(tablePatch('allBorders', true, pen)).map((e) => e.style), Array(6).fill('nil'));
  assert.equal(tablePatch('bottomBorder', false, pen).bottom.style, 'single');
  assert.equal(cellHas('noBorder', whole, all.map((c) => ({ ...c, borders: cellEdges(null, c.rect, 2, 2, sixOf({ style: 'nil' })) }))), true);
});

test('Home Shading writes one shading object for runs and paragraphs, null for No Color', () => {
  assert.deepEqual(shadingOf('#FFFF00'), { val: 'clear', color: 'auto', fill: '#FFFF00' });
  assert.equal(shadingOf(null), null);
});

test('part of a paragraph: any edge item gives a run box, again removes it', () => {
  const box = runPatch('topBorder', null, pen);
  assert.equal(box.style, 'single');
  assert.equal(runPatch('leftBorder', box, pen), null);
  assert.equal(runPatch('noBorder', null, pen), null);
});

test('grouping roles: equal borders join, a different left indent splits', () => {
  const b = { top: { style: 'single', space: 1 }, bottom: { style: 'single', space: 1 } };
  const p = (left = 0) => ({ borders: b, shading: null, left, right: 0 });
  assert.deepEqual(groupRoles([p(), p(), p()]), ['first', 'middle', 'last']);
  assert.deepEqual(groupRoles([p(), p(36), p(36)]), ['single', 'first', 'last']);
  assert.deepEqual(groupRoles([p(), null, p()]), ['single', null, 'single']);
});

test('Setting presets: Box is four equal edges, Shadow puts shadow on all four', () => {
  const edge = { style: 'double', width: 1.5, color: '#FF0000' };
  const box = presetBorders('box', edge);
  assert.deepEqual(Object.keys(box).sort(), ['bottom', 'left', 'right', 'top']);
  for (const e of Object.values(box)) assert.deepEqual([e.style, e.width, e.color, e.shadow], ['double', 1.5, '#FF0000', false]);
  assert.deepEqual([box.top.space, box.left.space], [1, 4]);
  assert.ok(Object.values(presetBorders('shadow', edge)).every((e) => e.shadow));
  assert.ok(Object.values(presetBorders('threeD', edge)).every((e) => e.frame));
  assert.equal(settingOf(box), 'box');
  assert.equal(settingOf(presetBorders('shadow', edge)), 'shadow');
  assert.equal(settingOf({ top: box.top }), 'custom');
  assert.equal(settingOf({}), 'none');
});

test('the 24 style names and 37 pattern names map to OOXML values and back; widths to pt', () => {
  assert.equal(STYLE_NAMES.length, 24);
  for (const [name, val] of STYLE_NAMES) {
    assert.ok(BORDER_STYLES.includes(val), val);
    assert.equal(styleName(styleOf(name)), name);
  }
  assert.equal(styleOf('Dashed (large gap)'), 'dashed');
  assert.equal(styleOf('Thick-thin small gap'), 'thickThinSmallGap');
  assert.equal(PATTERN_NAMES.length, 37);
  for (const [name, val] of PATTERN_NAMES) {
    assert.ok(SHADING_PATTERNS.includes(val), val);
    assert.equal(patternName(patternOf(name)), name);
  }
  assert.equal(patternOf('12.5%'), 'pct12');
  assert.equal(patternOf('Dk Dwn Diagonal'), 'reverseDiagStripe');
  assert.deepEqual(WIDTHS.map(([, pt]) => pt), [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6]);
  assert.equal(widthOf('¼ pt'), 0.25);
  assert.equal(widthOf('6 pt'), 6);
});
