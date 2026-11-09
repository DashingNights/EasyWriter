// Text effects take line room as in Word (docs/plans/word/briefs/text-effects.md): fxRoom against Word's measured room
// (docs/plans/word/measurements/text-effects-line-room.md, Calibri single, probe 3) and fxBox's spacing rules.
import assert from 'node:assert/strict';
import test from 'node:test';
import { drawnAsBlock, fxBox, fxRoom } from '../src/document/wp/font/run.mjs';

// Calibri in Word: single line 2500/2048 em, descent 550/2048 em.
const R = 2500 / 2048;
const D = 550 / 2048;
const room = (fx, s) => fxRoom(fx, s, R * s, D * s);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(2)} against Word's ${b}`);

// size: [glow 20, shadow 20 straight down, shadow blur 20 (above, below), reflection distance 0, reflection distance 20]
const WORD = {
  6: [2.63, 3.6, 3.46, 3.6, 4.2, 12.6],
  8: [3.24, 4.46, 4.2, 4.32, 5.52, 16.8],
  11: [4.08, 5.28, 5.4, 5.52, 7.68, 23.28],
  14: [4.75, 6.36, 6.36, 6.36, 9.72, 29.4],
  16: [5.23, 6.84, 6.98, 6.96, 11.04, 33.51],
  22: [6.48, 8.79, 8.64, 8.76, 15.24, 46.11],
  28: [7.74, 10.32, 10.32, 10.22, 19.32, 58.8],
  36: [9.3, 12.36, 12.27, 12.48, 25.08, 75.74],
};

test('fxRoom matches the room Word gives each effect from 6 to 36 pt', () => {
  for (const [size, [glow, down, bu, bd, r0, r20]] of Object.entries(WORD)) {
    const s = Number(size);
    const g = room({ glow: { size: 20 } }, s);
    // A glow's room is the same above and below.
    near(g.up, glow, 0.15, `glow 20 at ${s} pt above`);
    near(g.down, glow, 0.15, `glow 20 at ${s} pt below`);
    const sh = room({ shadow: { blur: 0, dist: 20, angle: 90 } }, s);
    near(sh.up, 0, 0.01, `shadow down at ${s} pt above`);
    near(sh.down, down, 0.2, `shadow down at ${s} pt below`);
    const bl = room({ shadow: { blur: 20, dist: 0, angle: 0 } }, s);
    near(bl.up, bu, 0.2, `shadow blur at ${s} pt above`);
    near(bl.down, bd, 0.2, `shadow blur at ${s} pt below`);
    // Reflection: Word's figures run about 1% of the size over A - D (its 0.5 pt blur or the PDF's 0.12 pt grid).
    near(room({ reflection: { dist: 0 } }, s).down, r0, 0.02 * s, `reflection 0 at ${s} pt`);
    near(room({ reflection: { dist: 20 } }, s).down, r20, 0.02 * s + 0.2, `reflection 20 at ${s} pt`);
  }
});

test('fxRoom combines effects as Word does and gives none without room', () => {
  // 11 pt: glow 20 and shadow 20 down add below (Word 4.08 / 9.36); shadow 20 down and reflection 20: the reflection alone.
  const a = room({ glow: { size: 20 }, shadow: { blur: 0, dist: 20, angle: 90 } }, 11);
  near(a.up, 4.08, 0.15, 'glow and shadow above');
  near(a.down, 9.36, 0.2, 'glow and shadow below');
  const b = room({ shadow: { blur: 0, dist: 20, angle: 90 }, reflection: { dist: 20 } }, 11);
  near(b.up, 0, 0.01, 'shadow and reflection above');
  near(b.down, 23.04, 0.3, 'shadow and reflection below');
  // A shadow straight up takes room above only.
  const up = room({ shadow: { blur: 0, dist: 20, angle: 270 } }, 11);
  assert.ok(up.up > 5 && up.down === 0);
  assert.equal(room({ outline: { width: 6 } }, 11), null);
  assert.equal(room({ shadow: { blur: 0, dist: 0 } }, 11), null);
  assert.equal(room(null, 11), null);
});

test('fxBox grows the line as for a taller font under each spacing rule', () => {
  const rm = { up: 10, down: 10 };
  // Single: the run's box grows by the room.
  assert.deepEqual(fxBox(rm, null, 13.43, 13.43), { h: 33.43, v: 0 });
  // A multiple multiplies the room (Word: 11 pt glow 50 at 1.15 lines grows the line 1.15 times the room).
  const m = fxBox(rm, { rule: 'auto', value: 1.15 }, 15.44, 13.43);
  near(m.h - 15.44, 23, 1e-9, 'multiple');
  // At least: the single line plus the room, which counts where it beats the minimum.
  assert.equal(fxBox(rm, { rule: 'atLeast', value: 15 }, 15, 13.43).h, 33.43);
  // Exactly: no growth.
  assert.equal(fxBox(rm, { rule: 'exact', value: 15 }, 15, 13.43), null);
  // Room only below shifts the box's middle down.
  assert.equal(fxBox({ up: 0, down: 8 }, null, 13, 13).v, -4);
  assert.equal(fxBox(null, null, 13, 13), null);
});

test('drawnAsBlock: reflection and character scale draw as an inline-block', () => {
  assert.equal(drawnAsBlock({ effects: { reflection: { dist: 0 } } }), true);
  assert.equal(drawnAsBlock({ scale: 150 }), true);
  assert.equal(drawnAsBlock({ scale: 100, effects: { glow: { size: 5 } } }), false);
  assert.equal(drawnAsBlock(null), false);
});
