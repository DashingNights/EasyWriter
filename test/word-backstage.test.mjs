import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { documentExtensions } from '../src/document/schema.js';
import { newDocumentJson } from '../src/document/defaults.mjs';
import { byUpdated, dateGroup, filterDrafts, groupRecent } from '../src/document/wp/backstage/recent.mjs';
import { quizStops, TEMPLATES } from '../src/document/wp/backstage/templates.mjs';
import { inspect, removeCategory } from '../src/document/wp/backstage/inspect.mjs';
import { plainText, saveTitle, webPage } from '../src/document/wp/backstage/exportText.mjs';

// File backstage pure logic (docs/plans/word/briefs/backstage.md Acceptance).
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 10, 28, 15); // a Wednesday

test('recent: newest first and Word\'s date groups for fixed times', () => {
  const drafts = [
    { id: 'old', title: 'Old', updated: at(2026, 9, 1) },
    { id: 'today', title: 'Today', updated: at(2026, 10, 28, 9) },
    { id: 'lastweek', title: 'Last week', updated: at(2026, 10, 21) },
    { id: 'yday', title: 'Yesterday', updated: at(2026, 10, 27) },
    { id: 'week', title: 'This week', updated: at(2026, 10, 26, 8) }, // Monday
  ];
  assert.deepEqual(byUpdated(drafts).map((d) => d.id), ['today', 'yday', 'week', 'lastweek', 'old']);
  assert.equal(dateGroup(at(2026, 10, 25), NOW), 'Last week'); // Sunday before
  assert.equal(dateGroup(at(2026, 10, 19, 1), NOW), 'Last week'); // Monday a week before
  assert.equal(dateGroup(at(2026, 10, 18), NOW), 'Older');
  assert.deepEqual(groupRecent(drafts, NOW).map((g) => [g.label, g.drafts.map((d) => d.id)]),
    [['Today', ['today']], ['Yesterday', ['yday']], ['This week', ['week']], ['Last week', ['lastweek']], ['Older', ['old']]]);
});

test('recent: the search filter matches every word in the title or the place', () => {
  const drafts = [{ id: 'a', title: 'Essay on rivers' }, { id: 'b', title: 'Rivers map' }, { id: 'c', title: 'Notes' }];
  assert.deepEqual(filterDrafts(drafts, 'rivers').map((d) => d.id), ['a', 'b']);
  assert.deepEqual(filterDrafts(drafts, 'ESSAY rivers').map((d) => d.id), ['a']);
  assert.deepEqual(filterDrafts(drafts, 'school', (d) => (d.id === 'c' ? 'School' : '')).map((d) => d.id), ['c']);
  assert.equal(filterDrafts(drafts, '  ').length, 3);
});

const schema = getSchema(documentExtensions(50));
const base = newDocumentJson({});

test('templates build with the Document schema and the quiz options sit on four equal tab stops', () => {
  for (const t of TEMPLATES) schema.nodeFromJSON({ ...base, content: t.build(base.attrs.sect) }).check();
  const quiz = TEMPLATES.find((t) => t.id === 'quiz').build(base.attrs.sect);
  const opts = quiz.filter((p) => p.attrs?.tabs);
  assert.equal(opts.length, 3);
  const stops = opts[0].attrs.tabs.map((s) => s.pos);
  assert.equal(stops.length, 4);
  const steps = stops.slice(1).map((p, i) => Math.round((p - stops[i]) * 100) / 100);
  assert.ok(steps.every((s) => s === steps[0]), String(steps));
  const width = base.attrs.sect.w - base.attrs.sect.margin.left - base.attrs.sect.margin.right;
  assert.ok(stops.at(-1) < width && Math.abs(steps[0] * 4 - width) < 0.2);
  assert.deepEqual(quizStops(base.attrs.sect), opts[0].attrs.tabs);
  assert.equal(opts[0].content[0].text.split('\t').length, 5);
});

// A doc holding one of each thing the inspector finds.
const hidden = { type: 'text', text: 'secret', marks: [{ type: 'textStyle', attrs: { vanish: true } }] };
const fixture = () => ({
  ...base,
  attrs: {
    ...base.attrs,
    comments: { c1: { author: 'Ann', content: [{ type: 'paragraph' }] } },
    people: [{ name: 'Ann', initials: 'A', color: null }],
    props: { core: { title: 'Kept', creator: 'Ann' }, app: { company: 'Acme', manager: null }, custom: [] },
    sect: { ...base.attrs.sect, hdr: { default: [{ type: 'paragraph' }], first: null, even: null }, ftr: null, watermark: null, unknownKey: 1 },
  },
  content: [
    { type: 'heading', attrs: { level: 1, collapsed: true }, content: [{ type: 'text', text: 'Head' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Note', marks: [{ type: 'comment', attrs: { id: 'c1' } }] }, { type: 'text', text: ' and ' }, hidden] },
    { type: 'paragraph', content: [{ type: 'text', text: 'new', marks: [{ type: 'insertion', attrs: { id: 'r1', author: 'Ann', date: null } }] }] },
    { type: 'textBox', attrs: { layout: { wrap: 'front', hidden: true } }, content: [{ type: 'paragraph' }] },
  ],
});

test('inspect finds each category, and each Remove All is a pure transform that keeps the other attrs', () => {
  const doc = fixture();
  const before = JSON.stringify(doc);
  const found = inspect(doc);
  assert.deepEqual(found, { comments: 1, revisions: 1, props: ['creator', 'company', 'people'], collapsed: 1, headers: 1, invisible: 1, hidden: 1 });
  const keep = (next, changed) => {
    for (const k of Object.keys(doc.attrs)) if (!changed.includes(k)) assert.deepEqual(next.attrs[k], doc.attrs[k], k);
    schema.nodeFromJSON(next).check();
  };
  const c = removeCategory(doc, 'comments');
  keep(c, ['comments']);
  assert.equal(c.attrs.comments, null);
  assert.equal(inspect(c).comments, 0);
  assert.equal(inspect(c).revisions, 1); // tracked changes are Accept All's
  const p = removeCategory(doc, 'props');
  keep(p, ['props', 'people']);
  assert.deepEqual(p.attrs.props.core, { title: 'Kept', creator: null });
  assert.deepEqual(inspect(p).props, []);
  const h = removeCategory(doc, 'headers');
  keep(h, ['sect']);
  assert.equal(h.attrs.sect.hdr, null);
  assert.equal(h.attrs.sect.unknownKey, 1);
  assert.equal(h.attrs.sect.w, doc.attrs.sect.w);
  for (const id of ['collapsed', 'invisible', 'hidden']) {
    const next = removeCategory(doc, id);
    keep(next, []);
    assert.equal(inspect(next)[id], 0, id);
  }
  assert.equal(plainText(removeCategory(doc, 'hidden')).includes('secret'), false);
  assert.equal(JSON.stringify(doc), before); // the input stays as it was
});

test('Plain Text and Web Page builders, and the Save As title fallback', () => {
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'A\tB' }, { type: 'hardBreak' }, { type: 'text', text: 'C' }, { type: 'text', text: 'gone', marks: [{ type: 'deletion' }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'cell' }] }] }] }] },
  ] };
  assert.equal(plainText(doc), 'Title\nA\tB\nC\ncell\n');
  const page = webPage('A <b> & "c"', '<p>Hi</p>');
  assert.match(page, /^<!DOCTYPE html>/);
  assert.match(page, /<title>A &lt;b&gt; &amp; &quot;c&quot;<\/title>/);
  assert.match(page, /<body>\n<p>Hi<\/p>\n<\/body>/);
  assert.equal(saveTitle('', 'Draft one'), 'Draft one');
  assert.equal(saveTitle('   ', 'Draft one'), 'Draft one');
  assert.equal(saveTitle(' New name ', 'Draft one'), 'New name');
});
