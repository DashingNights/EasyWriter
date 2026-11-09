// styles-pages (docs/plans/word/briefs/styles-pages.md): a frame from a paragraph style, and a page's multiple-spaced last line
// fitted by its text as Word fits it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { frameOf } from '../src/document/wp/float-layout/place.mjs';
import { planPages } from '../src/document/wp/page-engine/layout.mjs';

const STYLES = {
  list: {
    Normal: { type: 'paragraph', name: 'Normal' },
    Framed: { type: 'paragraph', name: 'Framed', basedOn: 'Normal', para: { frame: { w: 144, wrap: 'around', xAlign: 'right', y: 0.05 } } },
  },
};
const doc = { attrs: { styles: STYLES } };
const para = (attrs) => ({ type: { name: 'paragraph' }, attrs: { styleId: null, frame: null, ...attrs } });

test("a paragraph's frame is its style's with its own settings over it", () => {
  assert.deepEqual(frameOf(para({ styleId: 'Framed', frame: { wrap: 'none', w: null } }), doc), { w: 144, wrap: 'none', xAlign: 'right', y: 0.05 });
  assert.deepEqual(frameOf(para({ styleId: 'Framed' }), doc), STYLES.list.Framed.para.frame);
  assert.deepEqual(frameOf(para({ styleId: 'Framed', frame: { wrap: 'around' } })), { wrap: 'around' }, 'without the doc, its own only');
  assert.equal(frameOf(para({}), doc), null);
});

// One page of single-line paragraphs at 1.1583 multiple (a line box 22.62 px, its text 19.53 px) with the last line's text end
// `past` px below the page's room.
const page = (past) => {
  const line = 22.62;
  const text = line / 1.1583;
  const bodyH = 40 * 3 + text - past;
  const units = Array.from({ length: 4 }, (_, i) => ({ kind: 'text', section: 0, keepNext: false, keepLines: false, widow: true, breakBefore: false,
    table: null, header: false, multiple: 1.1583, ft: i * 40, fb: i * 40 + line, L: [{ top: i * 40, bottom: i * 40 + line }] }));
  const A4 = { w: 595.3, h: 841.9, margin: { top: 72, right: 72, bottom: 72, left: 72, header: 35.4, footer: 35.4, gutter: 0 } };
  return planPages({ units, linesOf: (j) => units[j].L, sectOf: () => A4, size: () => ({ bodyH, topOff: 96, botOff: 96 }) })[0];
};

test("a page's last line stays while its text fits and moves on 0.29 px past the margin (Word fixture page 137)", () => {
  assert.equal(page(-0.05).cut, null, 'text end just above the margin: four lines on the page');
  assert.equal(page(0.05).cut, null, 'within the layout noise');
  assert.equal(page(0.29).cut?.unit, 3, 'the Intense Reference line starts the next page');
});

test('a framed paragraph that does not fit below its place starts the next page with the text after it', () => {
  const A4 = { w: 595.3, h: 841.9, margin: { top: 72, right: 72, bottom: 72, left: 72, header: 35.4, footer: 35.4, gutter: 0 } };
  const unit = (ft, fb, more = {}) => ({ kind: 'text', section: 0, keepNext: false, keepLines: false, widow: true, breakBefore: false, table: null,
    header: false, ft, fb, L: [{ top: ft, bottom: fb }], ...more });
  const plan = (hold) => {
    const units = [unit(0, 20), unit(20, 40), { ...unit(40, 40), kind: 'block', out: true, hold, L: [] }, unit(40, 60), unit(60, 80)];
    return planPages({ units, linesOf: (j) => units[j].L, sectOf: () => A4, size: () => ({ bodyH: 70, topOff: 96, botOff: 96 }) });
  };
  assert.equal(plan(25).at(0).cut?.unit, 4, 'a frame 25 px tall fits below 40: the page ends at the text below 70');
  assert.equal(plan(40).at(0).cut?.unit, 2, 'a frame 40 px tall does not: it starts the next page');
});
