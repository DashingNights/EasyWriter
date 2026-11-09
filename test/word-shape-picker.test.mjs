// The one shape picker (docs/plans/word/briefs/shape-picker.md Checks): Word's gallery and the board's lists hold the library's
// sections in one order under one name per shape, and one search finds the same shapes in each.
import assert from 'node:assert/strict';
import test from 'node:test';
import { shapeSections } from '../src/app/shape-list.mjs';
import { SHAPE_GROUPS, SHAPE_MAP } from '../src/document/wp/shapes/map.mjs';
import { kindOf, SHAPE_KINDS } from '../src/flow/shapes.mjs';
import { gallerySections, inGallery, kindEntry, librarySections, recentWith, searchShapes, shapeName, shownSections } from '../src/tooling/shape-picker.mjs';

const word = librarySections(inGallery);
const board = librarySections();
const presets = (sections) => sections.map((s) => [s.id, s.entries.filter((e) => inGallery(kindOf(e.kind))).map((e) => e.kind)]).filter(([, k]) => k.length);

test('one name per shape: Word\'s for a gallery preset, the kind\'s own label still a search word', () => {
  assert.deepEqual(['rect', 'ellipse', 'star', 'diam', 'rightArrow', 'lane', 'arrow'].map(shapeName),
    ['Rectangle', 'Oval', 'Star: 5 Points', 'Flowchart: Decision', 'Arrow: Right', 'Swimlane', 'Line Arrow']);
  assert.ok(kindEntry('rect').keywords.includes('box'));
  assert.ok(kindEntry('wedgeRectCallout').keywords.includes('callouts'), 'its section\'s title');
  assert.equal(kindEntry('nope'), null);
});

test('Word\'s gallery is the library\'s sections: its headings and names in order, less its own lines and text boxes', () => {
  const own = new Set(Object.keys(SHAPE_MAP).filter((n) => !SHAPE_MAP[n].kind));
  const groups = SHAPE_GROUPS.map(([title, names]) => [title, names.filter((n) => !own.has(n))]).filter(([, names]) => names.length);
  assert.deepEqual(word.map((s) => [s.title, s.entries.map((e) => e.label)]), groups);
  for (const s of word) for (const e of s.entries) assert.equal(SHAPE_MAP[e.label].kind, e.kind, e.label);
});

test('the board\'s lists show the same sections, presets and order as Word\'s, their own kinds after them', () => {
  assert.deepEqual(presets(board), presets(word));
  const layout = shapeSections(SHAPE_KINDS, []).filter((s) => s.refs.length).map((s) => [s.id, s.refs.map((r) => r.slice(5))]);
  assert.deepEqual(layout.filter(([id]) => id !== 'favourites'), board.map((s) => [s.id, s.entries.map((e) => e.kind)]), 'shape-list.mjs keeps the library order');
  for (const s of board) {
    const own = s.entries.findIndex((e) => !inGallery(kindOf(e.kind)));
    if (own >= 0) assert.ok(s.entries.slice(own).every((e) => !inGallery(kindOf(e.kind))), `${s.id}: the board's own kinds come last`);
  }
});

test('search: the same shapes in each list, best first, each once, not every name with the letters in order', () => {
  const recent = { id: 'recent', title: 'Recently Used Shapes', entries: word[1].entries.slice(0, 3) };
  const inWord = searchShapes([recent, ...word], 'star').map((e) => e.ref);
  const inBoard = searchShapes(board, 'star').map((e) => e.ref).filter((r) => inGallery(kindOf(r.slice(5))));
  assert.deepEqual(inWord, inBoard);
  assert.ok(inWord.length >= 10 && inWord.slice(0, 10).every((r) => /^kind:(star\d*|star)$/.test(r)), inWord.join());
  assert.equal(new Set(searchShapes([recent, ...word], 'oval').map((e) => e.ref)).size, searchShapes([recent, ...word], 'oval').length);
  const tri = searchShapes(word, 'tri').map((e) => e.label);
  assert.ok(tri.length > 0 && tri.length < 10 && tri.includes('Isosceles Triangle'), tri.join());
  assert.ok(searchShapes(board, 'box').some((e) => e.kind === 'rect'), 'the old board name finds the rectangle');
});

test('shown sections: one Results section while searching; an empty section only with its hint', () => {
  const s = [{ id: 'favourites', entries: [] }, { id: 'prefabs', entries: [], empty: 'Drop here' }, ...word];
  assert.deepEqual(shownSections(s, '').map((x) => x.id).slice(0, 2), ['prefabs', 'rects']);
  assert.deepEqual(shownSections(s, ' oval ').map((x) => [x.id, x.entries[0].label]), [['results', 'Oval']]);
});

test('a gallery\'s items as picker sections, and the recently used row', () => {
  const items = [{ id: 'Oval', label: 'Oval', group: 'Recently Used Shapes', kind: 'ellipse' }, { id: 'Line', label: 'Line', group: 'Lines' },
    { id: 'Text Box', label: 'Text Box', group: 'Basic Shapes' }, { id: 'Oval', label: 'Oval', group: 'Basic Shapes', kind: 'ellipse', keywords: ['circle'] }];
  assert.deepEqual(gallerySections(items).map((s) => [s.id, s.title, s.entries.map((e) => e.ref)]), [
    ['recently-used-shapes', 'Recently Used Shapes', ['kind:ellipse']], ['lines', 'Lines', ['item:Line']], ['basic', 'Basic Shapes', ['item:Text Box', 'kind:ellipse']]]);
  assert.deepEqual(recentWith(['a', 'b', 'c'], 'c', 3), ['c', 'a', 'b']);
  assert.deepEqual(recentWith(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b'], 'the oldest goes');
});
