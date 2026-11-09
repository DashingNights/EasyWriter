// bd-text (docs/plans/board/briefs/bd-text.md): a shape's label box, and what the chrome reads of a story's look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelRect } from '../src/board/tools/text.js';
import { runLook } from '../src/board/look.mjs';

const para = (props, runs) => ({ kind: 'para', text: '', runs, props });
const story = (blocks, styles = []) => ({ blocks, parts: {}, styles: { styles }, numbering: { abstracts: [], nums: [] } });

test('a plain shape insets its label 7.2 pt at the sides and 3.6 pt top and bottom', () => {
  assert.deepEqual(labelRect({ type: 'shape', kind: 'rectangle', w: 100, h: 60 }), { x: 7.2, y: 3.6, w: 85.6, h: 52.8 });
});

test('a DrawingML preset uses its own text rectangle', () => {
  // A right arrow's text rectangle sits in its tail: `l t x2 b` of a 200 x 100 box.
  const r = labelRect({ type: 'shape', kind: 'rightArrow', w: 200, h: 100, extra: { preset: ['rightArrow', []] } });
  assert.deepEqual(r, { x: 0, y: 25, w: 175, h: 50 });
});

test('runLook reads a run\'s own size', () => {
  const look = runLook(story([para({}, [{ len: 3, props: { size: 20 } }])]));
  assert.equal(look.size, 20);
});

test('runLook resolves a run\'s size through its style\'s basedOn chain', () => {
  const styles = [
    { id: 'Base', basedOn: null, para: {}, chr: { size: 14, font: 'Aptos' } },
    { id: 'Big', basedOn: 'Base', para: {}, chr: {} },
  ];
  const look = runLook(story([para({}, [{ len: 3, props: { style: 'Big' } }])], styles));
  assert.equal(look.size, 14);
  assert.equal(look.font, 'Aptos');
});

test('runLook reads the paragraph style\'s alignment and the run colour', () => {
  const styles = [{ id: 'Heading1', basedOn: null, para: { align: 'center' }, chr: { bold: true, color: { Rgb: [15, 71, 97] } } }];
  const look = runLook(story([para({ style: 'Heading1' }, [{ len: 3 }])], styles));
  assert.deepEqual(look, { font: null, size: null, bold: true, italic: false, color: '#0f4761', align: 'center' });
});
