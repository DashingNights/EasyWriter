// forum-raster-export (docs/plans/word/briefs/forum-raster-export.md): the forum format declares that its output is raster, the
// other formats do not, and a downloaded picture's canvas keeps a metafile's original beside the drawing it shows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FORMATS } from '../src/formats.mjs';
import { pictureCanvas } from '../src/tooling/picture.mjs';
import forum from '../src/integrations/forum/manifest.mjs';

test('the forum post format says its output is raster; the Document and the core page do not', () => {
  assert.equal(forum.formats.find((f) => f.id === 'forum-post').rasterOutput, true);
  assert.equal(FORMATS['forum-post'].rasterOutput, true);
  assert.ok(!FORMATS.document.rasterOutput && !FORMATS.page.rasterOutput);
});

test('a picture canvas keeps a metafile original on its item, and adds none to a plain picture', () => {
  const emf = pictureCanvas({ src: 'data:image/svg+xml,drawing', w: 240, h: 160, metafile: 'data:image/x-emf;base64,AQ==' }, 1454);
  assert.equal(emf.attrs.items[0].metafile, 'data:image/x-emf;base64,AQ==');
  assert.equal(emf.attrs.items[0].src, 'data:image/svg+xml,drawing');
  assert.deepEqual([emf.attrs.w, emf.attrs.h, emf.attrs.dw], [240, 160, 240]);
  const png = pictureCanvas({ src: 'data:image/png;base64,AA==', w: 3000, h: 100 }, 1454);
  assert.ok(!('metafile' in png.attrs.items[0]));
  assert.equal(png.attrs.dw, 1454);
});

test('a file or upload renders at density 2 on any screen; a clipboard copy at the screen scale without the window zoom, 2 at least', async () => {
  const { exportDensity } = await import('../src/whiteboard.js');
  const { setState } = await import('../src/app/store.js');
  const dpr = globalThis.devicePixelRatio;
  try {
    globalThis.devicePixelRatio = 1.5 * 1.2 ** 5; // a 150% screen with the UI zoomed to level 5
    setState({ settings: { uiScale: 5 } });
    assert.equal(exportDensity('clipboard'), 2);
    assert.equal(exportDensity(), 2);
    globalThis.devicePixelRatio = 3;
    setState({ settings: { uiScale: 0 } });
    assert.equal(exportDensity('clipboard'), 3);
    assert.equal(exportDensity('file'), 2);
    assert.equal(exportDensity(), 2, 'a file is the same whichever screen made it');
  } finally {
    globalThis.devicePixelRatio = dpr;
  }
});

test('metafileOfUrl tells a metafile from its header, whatever type its data URL names', async () => {
  const { metafileOfUrl } = await import('../src/tooling/metafile.mjs');
  const emfHead = new Uint8Array(44);
  new DataView(emfHead.buffer).setUint32(0, 1, true);
  new DataView(emfHead.buffer).setUint32(40, 0x464d4520, true);
  const b64 = Buffer.from(emfHead).toString('base64');
  const m = await metafileOfUrl(`data:image/emf;base64,${b64}`, { convert: async () => [] });
  assert.match(m.metafile, /^data:image\/x-emf;base64,/);
  assert.equal(await metafileOfUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'), null);
});
