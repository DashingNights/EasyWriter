// Text boxes and styled text (docs/plans/word/plan.md §3 textbox): the pure gallery, presets and box CSS in boxes.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TEXTBOX_DEFAULTS } from '../src/document/model/nodes.js';
import { boxCss, DIRS, newBox, TEXTBOX_GALLERY, withRun, WORDART, wordArtBox } from '../src/document/wp/textbox/boxes.mjs';

const HEX = /^#[0-9A-F]{6}$/;

test('Simple Text Box comes first with the schema defaults', () => {
  assert.equal(TEXTBOX_GALLERY[0].label, 'Simple Text Box');
  const { attrs } = newBox(TEXTBOX_GALLERY[0].id);
  const { id, ...rest } = attrs;
  const { id: _none, ...defaults } = TEXTBOX_DEFAULTS;
  assert.deepEqual(rest, defaults);
  assert.deepEqual(attrs.layout, { wrap: 'front', h: { rel: 'column', offset: 0 }, v: { rel: 'paragraph', offset: 0 } });
  assert.deepEqual(attrs.inset, { t: 3.6, r: 7.2, b: 3.6, l: 7.2 });
  assert.equal(attrs.w, 144);
  assert.equal(attrs.h, 72);
  assert.ok(id, 'a new box gets an id for Create Link');
  assert.notEqual(newBox().attrs.id, newBox().attrs.id);
});

test('every gallery design has a label, a placeholder and the Built-in shape', () => {
  assert.equal(new Set(TEXTBOX_GALLERY.map((d) => d.id)).size, TEXTBOX_GALLERY.length);
  for (const d of TEXTBOX_GALLERY) {
    const n = newBox(d.id);
    assert.equal(n.type, 'textBox');
    assert.ok(n.content[0].content[0].text.length > 10, d.id);
  }
});

test('30 styled text presets, each with a colour and valid effects', () => {
  assert.equal(WORDART.length, 30);
  assert.equal(new Set(WORDART.map((p) => p.id)).size, 30);
  assert.equal(new Set(WORDART.map((p) => p.label)).size, 30);
  const KEYS = new Set(['fill', 'outline', 'shadow', 'glow', 'reflection']);
  for (const p of WORDART) {
    assert.match(p.color, HEX, p.id);
    assert.ok(p.effects && typeof p.effects === 'object' && Object.keys(p.effects).length, p.id);
    for (const [k, v] of Object.entries(p.effects)) {
      assert.ok(KEYS.has(k), `${p.id} ${k}`);
      if (v.color) assert.match(v.color, HEX, `${p.id} ${k}`);
    }
  }
});

test('a styled text box has no fill or line, 36 pt text and the preset run', () => {
  const b = wordArtBox(WORDART[2].id);
  assert.equal(b.attrs.fill, null);
  assert.equal(b.attrs.line, null);
  assert.equal(b.attrs.layout.wrap, 'front');
  assert.deepEqual(b.attrs.layout.h, { rel: 'margin', align: 'center' });
  const run = b.content[0].content[0];
  assert.equal(run.text, 'Your text here');
  const ts = run.marks.find((m) => m.type === 'textStyle').attrs;
  assert.equal(ts.size, 36);
  assert.deepEqual(ts.effects, WORDART[2].effects);
  // Selected text moving in keeps its own marks.
  const moved = wordArtBox(WORDART[0].id, [{ type: 'text', text: 'Hi', marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { font: 'Arial' } }] }]);
  const m = moved.content[0].content[0].marks;
  assert.ok(m.some((x) => x.type === 'bold'));
  assert.equal(m.find((x) => x.type === 'textStyle').attrs.font, 'Arial');
  assert.deepEqual(withRun({ type: 'text', text: 'a', marks: [{ type: 'textStyle', attrs: { effects: { glow: 1 } } }] }, { effects: { fill: 2 } }).marks[0].attrs.effects, { glow: 1, fill: 2 });
});

test('boxCss draws direction, alignment, inset and size', () => {
  const css = (patch) => boxCss({ ...TEXTBOX_DEFAULTS, ...patch });
  assert.equal(css({ dir: 'tbRl' }).inner['writing-mode'], 'vertical-rl');
  assert.equal(css({ dir: 'btLr' }).inner['writing-mode'], 'sideways-lr');
  assert.equal(css({ dir: 'stacked' }).inner['text-orientation'], 'upright');
  assert.equal(css({ dir: 'stacked' }).inner['writing-mode'], 'vertical-rl');
  assert.equal(css({}).inner['writing-mode'], null);
  assert.equal(css({ vAlign: 'center' }).outer['justify-content'], 'center');
  assert.equal(css({ vAlign: 'bottom' }).outer['justify-content'], 'flex-end');
  assert.equal(css({ vAlign: 'top', dir: 'tbRl' }).outer['justify-content'], 'flex-end'); // Top is the right edge of vertical text
  assert.equal(css({}).outer.padding, '4.8px 9.6px 4.8px 9.6px');
  assert.equal(css({}).outer.width, '192px');
  assert.equal(css({}).outer.height, '96px');
  assert.equal(css({ autoFit: true }).outer.height, null);
  assert.equal(css({ autoFit: true }).outer['min-height'], '96px');
  assert.equal(css({ noWrap: true }).outer.width, 'max-content');
  assert.equal(css({ fill: null, line: null }).outer.background, 'transparent');
  assert.equal(css({ fill: null, line: null }).outer.border, 'none');
  assert.equal(css({ line: { color: '#FF0000', width: 1.5, dash: 'sysDot' } }).outer.border, '2px dotted #FF0000');
  assert.equal(css({ rotate: 30 }).outer.transform, 'rotate(30deg)');
  assert.equal(css({ rotate: 30, upright: true }).inner.transform, 'rotate(-30deg)');
  assert.match(css({ effects: { shadow: { color: '#000000', dist: 3, angle: 45, blur: 4 } } }).outer['box-shadow'], /rgb\(0 0 0/);
});

test('Text Direction lists Word\'s four directions in menu order', () => {
  assert.deepEqual(DIRS.map(([d]) => d), ['lrTb', 'tbRl', 'btLr', 'stacked']);
  assert.deepEqual(DIRS.map(([, l]) => l), ['Horizontal', 'Rotate all text 90°', 'Rotate all text 270°', 'Stacked']);
});
