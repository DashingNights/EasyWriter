// Word's AutoFit floors and the hidden cell end after a nested table (src/document/wp/table-tools/autofit.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { floorTrack, hiddenCellEnd } from '../src/document/wp/table-tools/autofit.mjs';

test('a floor widens a set column and keeps a share above it', () => {
  assert.equal(floorTrack('23px', 0), '23px');
  assert.equal(floorTrack('23px', 31.493), 'max(23px, 31.5px)');
  assert.equal(floorTrack('minmax(0, 0.7302fr)', 23.001), 'minmax(max(0px, 23.01px), 0.7302fr)');
  assert.equal(floorTrack('minmax(20px, 1fr)', null), 'minmax(20px, 1fr)');
});

test('only an empty paragraph ending a cell after a nested table is hidden', () => {
  const table = { type: 'table', content: [] };
  const empty = { type: 'paragraph' };
  const text = { type: 'paragraph', content: [{ type: 'text', text: 'Text after the inner table' }] };
  assert.equal(hiddenCellEnd(empty, table, true), true);
  assert.equal(hiddenCellEnd(text, table, true), false);
  assert.equal(hiddenCellEnd(empty, table, false), false);
  assert.equal(hiddenCellEnd(empty, text, true), false);
  assert.equal(hiddenCellEnd(empty, undefined, true), false);
});
