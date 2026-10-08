import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATTACH_CHARS, blockAttachment, boardOrder, endSide, itemLines, itemsAttachment, listBody, modelContent, partsText, textAttachment,
} from '../src/app/assistant/attach.mjs';

test('text selection: label by lines or words, the block path, the text and its context', () => {
  const one = textAttachment({ path: [2], from: 4, to: 15, text: 'quick brown', context: 'The quick brown fox' });
  assert.equal(one.label, 'Selection: 2 words');
  assert.match(one.body, /block \[2\], characters 4 to 15/);
  assert.match(one.body, /"quick brown"/);
  assert.match(one.body, /In context "The quick brown fox"/);
  const three = textAttachment({ path: [0], toPath: [2], from: 0, to: 3, text: 'a\nb\nc', context: 'a' });
  assert.equal(three.label, 'Selection: 3 lines');
  assert.match(three.body, /blocks \[0\] to \[2\]/);
});

test('every attachment is capped', () => {
  const long = textAttachment({ path: [0], from: 0, to: 9000, text: 'word '.repeat(1800), context: '' });
  assert.ok(long.body.length <= ATTACH_CHARS && long.body.endsWith('(cut)'));
  const items = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, type: 'shape', shape: 'rect', html: `<p>Step ${i}</p>`, x: i, y: 0, w: 10, h: 10 }));
  const many = itemsAttachment(items, 'the whiteboard at block [4]');
  assert.equal(many.label, '300 items');
  assert.ok(many.body.length <= ATTACH_CHARS);
  assert.ok(blockAttachment('flowchart', { path: [1], mermaid: 'A --> B\n'.repeat(1000) }).body.length <= ATTACH_CHARS);
  // Wave 2: whole lines from the start, then "... and N more" for the item lines left out; the Mermaid goes first.
  const wb = blockAttachment('whiteboard', { path: [4], attrs: { items } }).body.split('\n');
  const shown = wb.filter((l) => /^\d+ s\d+ /.test(l)).length;
  assert.equal(wb.at(-1), `... and ${300 - shown} more`);
  assert.equal(wb[1], '1 s0 shape rect "Step 0" at 0,0 size 10x10');
  assert.ok(wb.join('\n').length <= ATTACH_CHARS && shown > 20, shown);
  const fc = blockAttachment('flowchart', { path: [1], attrs: { items }, mermaid: 'A --> B' }).body;
  assert.ok(!fc.includes('Mermaid') && fc.endsWith(' more'), fc.slice(-80));
  assert.equal(listBody('Head', ['1 a', 'Other items on the board', '2 b']), 'Head\n1 a\nOther items on the board\n2 b');
});

test('items: every line starts with the id; a connector names the items it joins by id, label and side, then its route and bends', () => {
  const a = itemsAttachment([
    { id: 'k3j9x0a', type: 'shape', shape: 'rect', html: 'Decision' },
    { id: 'b', type: 'shape', shape: 'diam', html: '' },
    { id: 'c81hd0q', type: 'connector', from: { item: 'k3j9x0a' }, to: { item: 'b' }, labels: { mid: { html: 'yes' } }, route: 'ortho', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
    { id: 'a1b2c3d', type: 'image', w: 320.4, h: 199.6 },
    { id: 'f', type: 'connector', from: { x: 0, y: 0 }, to: { item: 'gone' }, route: 'straight', points: [] },
  ], 'the canvas being edited');
  assert.equal(a.label, '5 items');
  // The legend form (wave 2): numbered from 1 in order, the numbers of the marks on the attachment's picture.
  assert.match(a.body, /^1 k3j9x0a shape rect "Decision"$/m);
  assert.match(a.body, /^3 c81hd0q connector "yes" from k3j9x0a "Decision" \(nearest side\) to b \(a diam, nearest side\), ortho, 2 bends$/m);
  assert.match(a.body, /^4 a1b2c3d image size 320x200$/m);
  assert.match(a.body, /^5 f connector from \(a point at 0,0\) to gone \(nearest side\), straight$/m);
  const all = [{ id: 'k3j9x0a', type: 'shape', shape: 'rect', html: 'Decision' }, { id: 'q2m1f8z', type: 'shape', shape: 'rect', html: 'End' },
    { id: 'c81hd0q', type: 'connector', from: { item: 'k3j9x0a' }, to: { item: 'q2m1f8z' }, labels: { mid: { html: 'yes' } } }];
  // No route stored: the board's default, ortho; no waypoints: no bends. Its shapes are not selected.
  assert.equal(itemLines([all[2]], all), '- c81hd0q connector "yes" from k3j9x0a "Decision" (nearest side) to q2m1f8z "End" (nearest side), ortho, no bends');
  // A selection's legend: the selected items first, then the rest of the board under its own line (the picture shows them all).
  assert.deepEqual(itemsAttachment([all[2]], 'the whiteboard', all).body.split('\n'), ['1 selected item on the whiteboard',
    '1 c81hd0q connector "yes" from k3j9x0a "Decision" (nearest side) to q2m1f8z "End" (nearest side), ortho, no bends', 'Other items on the board',
    '2 k3j9x0a shape rect "Decision"', '3 q2m1f8z shape rect "End"']);
  assert.deepEqual(boardOrder([all[2]], all).map((i) => i.id), ['c81hd0q', 'k3j9x0a', 'q2m1f8z']);
  // The ends, route and bends follow the cut, so long labels never hide them (an end's label is cut at 40 characters).
  const ends = [{ id: 'a', type: 'shape', shape: 'rect', html: 'a'.repeat(80) }, { id: 'b', type: 'shape', shape: 'rect', html: 'b'.repeat(80) }];
  const long = itemLines([{ id: 'c', type: 'connector', from: { item: 'a', anchor: [1, 0.5] }, to: { item: 'b', anchor: [0, 0.5] }, route: 'curve', points: [{ x: 5, y: 5 }], labels: { mid: { html: 'c'.repeat(200) } } }], ends);
  assert.ok(long.endsWith(`to b "${'b'.repeat(30)}... (cut)" (left), curve, 1 bend`) && long.includes(`from a "${'a'.repeat(30)}... (cut)" (right) to`), long);
});

test('items: each connector end names its side (the straighten-yes fixture: both ends on a bottom), a free end its point', () => {
  const fixture = [{ id: 'd4q8n1x', type: 'shape', shape: 'rect', html: 'Decision' }, { id: 'e9r3t6w', type: 'shape', shape: 'rect', html: 'End' },
    { id: 'y6b1v4z', type: 'connector', from: { item: 'd4q8n1x', anchor: 's' }, to: { item: 'e9r3t6w', anchor: [0.5, 1] }, route: 'straight', points: [{ x: 450, y: 340 }, { x: 750, y: 340 }], labels: { mid: { html: 'yes' } } }];
  assert.equal(itemLines([fixture[2]], fixture), '- y6b1v4z connector "yes" from d4q8n1x "Decision" (bottom) to e9r3t6w "End" (bottom), straight, 2 bends');
  assert.equal(itemLines([{ id: 'f', type: 'connector', from: { x: 120.4, y: 39.6 }, to: { item: 'e9r3t6w', anchor: 'w' } }], fixture), '- f connector from (a point at 120,40) to e9r3t6w "End" (left), ortho, no bends');
  const names = { n: 'top', s: 'bottom', e: 'right', w: 'left', ne: 'top right', nw: 'top left', se: 'bottom right', sw: 'bottom left', c: 'centre' };
  const FRACTIONS = { n: [0.5, 0], e: [1, 0.5], s: [0.5, 1], w: [0, 0.5], ne: [1, 0], nw: [0, 0], se: [1, 1], sw: [0, 1], c: [0.5, 0.5] }; // flow/model.mjs ANCHOR_NAMES
  for (const [k, words] of Object.entries(names)) assert.deepEqual([endSide(k), endSide(FRACTIONS[k])], [words, words], k);
  assert.deepEqual([endSide(null), endSide(undefined), endSide([0.25, 1]), endSide([1, 0.3]), endSide([0.55, 0.45])], ['nearest side', 'nearest side', 'bottom', 'right', 'centre']);
});

test('items: every line but a connector\'s carries its box in whole px, after the cut (wave 2, the move-valve case)', () => {
  const box = itemLines([{ id: 'v1x6m9q', type: 'shape', shape: 'rect', html: 'Valve', x: 420.4, y: 39.6, w: 160, h: 80 }]);
  assert.equal(box, '- v1x6m9q shape rect "Valve" at 420,40 size 160x80');
  assert.equal(itemLines([{ id: 't1', type: 'text', html: 'Note', x: 40, y: 30, w: 240 }], undefined, 7), '7 t1 text "Note" at 40,30 width 240');
  assert.equal(itemLines([{ id: 'v', type: 'canvas', items: [{}, {}], x: 0, y: 10, w: 400, h: 225 }]), '- v canvas with 2 items at 0,10 size 400x225');
  const long = itemLines([{ id: 's', type: 'shape', shape: 'rect', html: 'x'.repeat(200), x: 1, y: 2, w: 3, h: 4 }]);
  assert.ok(long.endsWith('... (cut)" at 1,2 size 3x4'), long);
});

test('blocks: flowchart as item lines (Mermaid only when it fits), plan chart counts, image size', () => {
  const items = [{ id: 's1', type: 'shape', shape: 'stadium', html: 'Start' }, { id: 's2', type: 'shape', shape: 'rect', html: 'End' },
    { id: 'c1', type: 'connector', from: { item: 's1' }, to: { item: 's2' } }];
  const f = blockAttachment('flowchart', { path: [1], attrs: { items }, mermaid: 'flowchart TD\n  a --> b', flowTitle: 'Login flow' });
  assert.equal(f.label, 'Flowchart canvas');
  assert.equal(f.body.split('\n')[0], 'Flowchart canvas at block [1] of the draft, synced with the library flowchart "Login flow", with 3 items');
  assert.match(f.body, /\n1 s1 shape stadium "Start"\n2 s2 shape rect "End"\n3 c1 connector from s1 "Start" \(nearest side\) to s2 "End" \(nearest side\), ortho, no bends\nAs Mermaid\nflowchart TD/);
  const big = blockAttachment('flowchart', { path: [1], attrs: { items }, mermaid: 'A --> B\n'.repeat(300) });
  assert.ok(big.body.endsWith('3 c1 connector from s1 "Start" (nearest side) to s2 "End" (nearest side), ortho, no bends') && !big.body.includes('Mermaid'), big.body);
  const p = blockAttachment('planChart', { path: [3], plan: { title: 'Level', view: 'kanban', total: 3, counts: [['To do', 2], ['Done', 1]], frozen: false } });
  assert.equal(p.label, 'Plan chart');
  assert.match(p.body, /"Level" in Board view, 3 tickets \(To do 2, Done 1\)/);
  const img = blockAttachment('image', { path: [5], attrs: { items: [{ type: 'image', src: 'data:image/png;base64,AAAA', w: 200, h: 100 }] } });
  assert.match(img.body, /200 x 100 px, a pasted PNG picture/);
  assert.equal(blockAttachment('horizontalRule', { path: [6], type: 'horizontalRule' }).label, 'Horizontal rule');
});

test('model content: each attachment block, the pictures, the note, then "Request:" and the words, a pill among them as its label', () => {
  const pill = { kind: 'text', label: 'Selection: 2 words', body: 'Selected text' };
  const parts = ['  fix this ', pill, ' please '];
  assert.equal(partsText(parts), '  fix this [Selection: 2 words] please ');
  assert.equal(modelContent(parts, 'From tool search.'), 'Attachment [Selection: 2 words]\nSelected text\n\nFrom tool search.\n\nRequest: fix this [Selection: 2 words] please');
  // Wave 2: a pill in the middle stays as [label]; only the pill that opens the message (the auto-attached selection) goes.
  const wb = { kind: 'whiteboard', label: 'Whiteboard', body: 'Whiteboard at block [4]' };
  assert.ok(modelContent(['Make ', wb, ' bigger']).endsWith('\n\nRequest: Make [Whiteboard] bigger'));
  assert.ok(modelContent([wb, ' Make it bigger']).endsWith('\n\nRequest: Make it bigger'));
  assert.equal(modelContent(['hello']), 'Request: hello');
  assert.equal(modelContent([pill]), 'Attachment [Selection: 2 words]\nSelected text\n\nRequest: [Selection: 2 words]'); // pills only
  // The eval's straighten-yes message: the pill label no longer glued to the words.
  const canvas = { kind: 'flowchart', label: 'Flowchart canvas', body: 'Flowchart canvas at block [2] of the draft with 5 items' };
  assert.ok(modelContent([canvas, 'Straighten the yes arrow.']).endsWith('\n\nRequest: Straighten the yes arrow.'));
  // With pictures: content parts, neighbouring texts joined (a template may trim and glue each part), the request last.
  const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  assert.deepEqual(modelContent([canvas, 'Straighten the yes arrow.'], '', [{ type: 'text', text: 'The next picture shows [Flowchart canvas].' }, img]), [
    { type: 'text', text: `Attachment [Flowchart canvas]\n${canvas.body}\n\nThe next picture shows [Flowchart canvas].` }, img,
    { type: 'text', text: 'Request: Straighten the yes arrow.' },
  ]);
  assert.ok(!/[–—…]/.test(modelContent(parts, 'x') + textAttachment({ path: [0], from: 0, to: 1, text: 'a', context: 'b' }).body));
});
