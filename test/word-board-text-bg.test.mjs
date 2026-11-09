// A text item's background colour (docs/plans/word/briefs/board-text-bg.md): any hex colour, transparency included, saves with
// the item; None saves as no background; notes saved with the old note colours keep them; text by theme reads on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, inkOn, MIN_CONTRAST, surfaceOf } from '../src/app/commands/item-style.mjs';
import { parseBoard, TEXT_BACKGROUNDS } from '../src/whiteboard.js';

const text = (id, more) => ({ id, type: 'text', html: 'Hi', x: 0, y: 0, w: 200, size: 20, color: null, bold: false, align: 'left', ...more });
const reload = (items) => parseBoard(JSON.stringify({ items })).items;

test('a #rrggbb or #rrggbbaa background saves and reloads as set', () => {
  const bgs = ['#4a7fe0', '#4A7FE080', '#e0525200', '#ffffff'];
  const back = reload(bgs.map((bg, k) => text(`t${k}`, { bg })));
  assert.deepEqual(back.map((i) => i.bg), bgs);
});

test('None removes the background; anything that is not a hex colour is dropped on load', () => {
  const back = reload([text('none', { bg: null }), text('url', { bg: 'url(https://example.com/x.png)' }), text('word', { bg: 'red' }), text('plain', {})]);
  for (const i of back) assert.equal('bg' in i, false, i.id);
});

test('text saved with the old note colours keeps them', () => {
  const notes = ['#fff59d', '#c8e6c9', '#bbdefb', '#f8bbd0'];
  assert.deepEqual(reload(notes.map((bg, k) => text(`n${k}`, { bg }))).map((i) => i.bg), notes);
  // and they are among the presets, so a saved note shows as picked
  for (const n of notes) assert.ok(TEXT_BACKGROUNDS.some(([c]) => c === n), n);
});

test('the presets are ten colours that each stand out from the light and the dark board', () => {
  assert.equal(TEXT_BACKGROUNDS.length, 10);
  for (const [c, name] of TEXT_BACKGROUNDS) {
    // 1.1:1 is a visible step from the board; black on the dark board or white on the white one would be 1:1 or near it.
    for (const board of ['#ffffff', '#1a1a1a']) assert.ok(contrast(c, board) > 1.1, `${name} on ${board}`);
  }
});

test('text by theme reads on a preset, a half transparent colour and no background, on a light and a dark board', () => {
  const boards = { light: '#ffffff', dark: '#1a1a1a' };
  for (const [theme, board] of Object.entries(boards)) {
    for (const bg of [...TEXT_BACKGROUNDS.map(([c]) => c), '#4a7fe080', '#ffffff80', '#00000080', undefined]) {
      const surface = surfaceOf({ type: 'text', bg }, board);
      assert.ok(contrast(inkOn(surface, theme), surface) >= MIN_CONTRAST, `${bg} on the ${theme} board`);
    }
  }
});
