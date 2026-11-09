// hf-edit-drawings (docs/plans/word/briefs/hf-edit-drawings.md): a header's floats placed on the page in its story editor's own
// coordinates (pageFrom) land where the page layer (placePartFloats, pageFrom(page, 0)) places them on the paper, for every relation
// and alignment.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPages, pageBox } from '../src/document/geometry.mjs';
import { pageFrom, placement } from '../src/document/wp/float-layout/place.mjs';

const sect = { w: 612, h: 792, margin: { top: 72, right: 72, bottom: 90, left: 72, header: 36, footer: 36, gutter: 0 } };
const box = pageBox(sect);
const step = box.body + box.breaker;
// The second page (an even one, so inside and outside mirror), well below the first.
const page = buildPages({ segments: [{ top: 0, pages: 2 }], box, starts: [0, 10], tops: [0, step], size: 20,
  sections: [{ index: 0, from: 0, to: 20, sect }] }).pages[1];

test('a float placed on the story page sits where the layer places it on the paper', () => {
  const size = { w: 80, h: 30 };
  const anchor = 70; // the anchor paragraph's top below the paper's top
  for (const rel of ['page', 'margin', 'paragraph', 'line', 'topMargin', 'bottomMargin', 'insideMargin', 'outsideMargin']) {
    for (const v of [{ rel, offset: 12 }, { rel, align: 'center' }, { rel, align: 'bottom' }, { rel, pct: 25 }]) {
      for (const h of [{ rel: 'page', offset: 30 }, { rel: 'margin', align: 'right' }, { rel: 'insideMargin', align: 'outside' }]) {
        const layout = { wrap: 'front', h, v };
        const paper = placement(layout, size, { page: pageFrom(page, 0), anchorTop: anchor, lineTop: anchor, colLeft: 0, colWidth: box.text });
        for (const y of [box.header, 61.5, -20]) {
          const story = placement(layout, size, { page: pageFrom(page, y), anchorTop: anchor - y, lineTop: anchor - y, colLeft: 0, colWidth: box.text });
          assert.equal(story.x, paper.x, JSON.stringify({ h, v, y }));
          assert.ok(Math.abs(story.y + y - paper.y) < 1e-9, JSON.stringify({ v, y, story, paper }));
        }
      }
    }
  }
});

test('pageFrom keeps the page and moves only its vertical origin', () => {
  const p = pageFrom(page, 48);
  assert.equal(p.top, -48);
  assert.equal(p.bodyTop, page.bodyTop - page.top - 48);
  assert.deepEqual({ ...p, top: page.top, bodyTop: page.bodyTop }, page);
});
