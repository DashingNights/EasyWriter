// engine-a11y-route (docs/plans/word/briefs/engine-a11y-route.md, viewport-design.md P10): what the engine adds for accessibility
// and spelling in every session a viewport shows, run on its WebAssembly in Node: the header, footer, notes and text boxes as
// part blocks with ids unique in the session, each line's box on its page, and forced colours that repaint every page. The DOM
// side (the regions, the copy laid over the lines, the selection and squiggles) runs in the harness case engine-a11y-route.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { blocksOf, textBlocks } from '../src/engine/a11y/blocks.js';
import { copyTree } from '../src/engine/a11y/copy.js';
import { hex } from '../src/engine/a11y/forced.js';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

const wasm = initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const J = JSON.parse;
const S = JSON.stringify;

/** A client over engine `e` with the calls blocksOf makes. */
const client = (e) => ({ blocks: async (page) => J(e.blocks(page)) });
const run = (e, id, args = {}) => {
  const r = J(e.exec(id, S(args)));
  assert.ok(r.ok, `${id}: ${r.error}`);
  return r;
};
/** Every block id under `blocks`, parts and table cells included. */
const ids = (blocks, out = []) => {
  for (const b of blocks ?? []) {
    out.push(b.id);
    ids(b.blocks, out);
    for (const r of b.rows ?? []) for (const c of r.cells ?? []) ids(c.blocks, out);
  }
  return out;
};

test('a header, a footer and a footnote reach the blocks as parts, with ids unique in the session', () => {
  const e = new Engine();
  run(e, 'text.insert', { text: 'Body text with a note', raw: true });
  run(e, 'references.footnote', { text: 'The note text' });
  run(e, 'insert.editHeader');
  run(e, 'text.insert', { text: 'Running head', raw: true });
  run(e, 'insert.closeHeader');
  run(e, 'insert.editFooter');
  run(e, 'text.insert', { text: 'Running foot', raw: true });
  run(e, 'insert.closeHeader');
  const blocks = J(e.blocks(0));
  const part = (name) => blocks.find((b) => b.kind === 'part' && b.part === name);
  const [head, foot, note] = [part('header'), part('footer'), part('footnote')];
  assert.deepEqual(blocks.map((b) => b.part ?? b.kind), ['header', 'p', 'footnote', 'footer'], 'reading order: header, body, notes, footer');
  assert.equal(head.blocks[0].text, 'Running head');
  assert.equal(foot.blocks[0].text, 'Running foot');
  assert.ok(note.blocks[0].text.includes('The note text'), note.blocks[0].text);
  assert.deepEqual(blocks[1].objects, [{ offset: 21, alt: 'Footnote' }], 'the note mark in the body reads as a footnote, not a picture');
  assert.match(head.id, /^\d+:$/);
  assert.match(head.blocks[0].id, /^\d+$/, "a part's paragraph carries its stable id (engine-box)");
  const all = ids(blocks);
  assert.equal(new Set(all).size, all.length, `ids ${all}`);
  // A part's paragraph maps to positions and back, as the DOM selection mirror needs when the caret is in a header.
  const at = J(e.posAt(head.blocks[0].id, 4));
  assert.deepEqual(J(e.locate(S(at))), { id: head.blocks[0].id, offset: 4 });
  assert.equal(e.text(S(J(e.posAt(head.blocks[0].id, 0))), S(at)), 'Runn');
  assert.ok(textBlocks(blocks).some((b) => b.text === 'Running foot'), 'spelling reads the parts too');
  e.free();
});

test('each line of a paragraph has its box on the page, and a paragraph over two pages has the boxes of both', async () => {
  const e = new Engine();
  run(e, 'text.insert', { text: `${'A long paragraph that wraps over many lines and pages. '.repeat(160)}End`, raw: true });
  const pages = J(e.pages()).pages.length;
  assert.ok(pages >= 2, `${pages} pages`);
  const [b] = J(e.blocks(0));
  const boxes = b.boxes;
  assert.ok(boxes.length >= 10 && boxes.every((x, i) => x.line === i), S(boxes.slice(0, 3)));
  for (const [i, x] of boxes.entries()) {
    assert.ok(x.x >= 70 && x.w > 100 && x.h > x.size && x.size >= 8 && x.size <= 14, S(x));
    if (i) assert.ok(x.y > boxes[i - 1].y, 'lines run down the page');
  }
  const [all] = await blocksOf(client(e), [0, 1]);
  const on1 = all.boxes.filter((x) => x.surface === 1);
  assert.equal(all.boxes.filter((x) => x.surface === 0).length, boxes.length);
  assert.ok(on1.length > 0 && on1[0].line === boxes.length && on1[0].y < boxes[0].y + 1, S(on1[0]));
  e.free();
});

/** The RGBA pixel at (x, y) of tile `v` (paintTile's view into wasm memory). */
const pixel = (v, x, y) => [...new Uint8Array(wasm.memory.buffer, v.ptr + (y * v.width + x) * 4, 4)];

test('forced colours re-key every page and paint text and paper in the system colours, blank tiles too', () => {
  const e = new Engine();
  run(e, 'text.insert', { text: 'Some words in black on white', raw: true });
  run(e, 'insert.pageBreak');
  run(e, 'text.insert', { text: 'Page two', raw: true });
  const n = J(e.pages()).pages.length;
  e.takeLayout();
  // At 1 px a point tile (1, 1) is the page's bottom right corner, which nothing reaches: no tile, the slot's paper shows.
  assert.equal(e.paintTile(0, 1, 1, 1), undefined);
  const before = e.version;
  e.setColors('#ffffff', '#000000');
  const change = J(e.takeLayout());
  assert.deepEqual([change.from, change.to, change.version > before], [0, n, true], 'every page repaints');
  assert.equal(J(e.surfaces()).list[0].paper, '#000000', "a slot's paper is the system's");
  const blank = e.paintTile(0, 1, 1, 1);
  assert.ok(blank, 'a blank tile is painted in the paper colour');
  assert.deepEqual(pixel(blank, 50, 50), [0, 0, 0, 255]);
  blank.free();
  const top = e.paintTile(0, 2, 0, 0);
  let white = 0;
  for (let y = 140; y < 180; y++) for (let x = 140; x < 500; x++) if (pixel(top, x, y)[0] > 200) white++;
  assert.deepEqual(pixel(top, 2, 2), [0, 0, 0, 255], 'paper');
  assert.ok(white > 100, `text pixels in the text colour: ${white}`);
  top.free();
  e.setColors('#ffffff', '#000000');
  assert.equal(e.takeLayout(), undefined, 'the same colours again change nothing');
  e.setColors('', '');
  assert.ok(e.takeLayout(), 'forced colours off repaint again');
  assert.equal(e.paintTile(0, 1, 1, 1), undefined);
  e.free();
});

test("copyTree names a part's group by its kind, and a block that only moved keeps its signature", () => {
  const p = (id, text, more = {}) => ({ id, kind: 'p', text, ...more });
  const [head] = copyTree([{ id: '3:', kind: 'part', part: 'header', blocks: [p('3:0', 'Running head')] }]);
  assert.deepEqual([head.node.attrs.role, head.node.attrs['aria-label'], head.node.kids[0].attrs['data-id']], ['group', 'Header', '3:0']);
  const box = (y) => [{ line: 0, x: 72, y, w: 100, h: 14, size: 11, surface: 0 }];
  assert.equal(copyTree([p('a', 'One', { boxes: box(72) })])[0].sig, copyTree([p('a', 'One', { boxes: box(90) })])[0].sig);
});

test('a computed colour reads as #rrggbb', () => {
  assert.equal(hex('rgb(255, 255, 255)'), '#ffffff');
  assert.equal(hex('rgb(0 0 0)'), '#000000');
  assert.equal(hex('rgba(16, 32, 48, 0.5)'), '#102030');
  assert.equal(hex('canvas'), null);
});
