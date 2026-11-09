// Word's right-click menus and the mini toolbar's placement (src/document/wp/context-menu, docs/plans/word/briefs/context-menu.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { REASONS } from '../src/tooling/reasons.mjs';
import { changeAll, wordMatches } from '../src/document/wp/context-menu/changeAll.mjs';
import { changeName, contextOf, entriesForKey, entryForKey, menuFor } from '../src/document/wp/context-menu/menus.mjs';
import { areaAt, distance, fadeAt, placeBar } from '../src/document/wp/context-menu/place.mjs';

/** "label/key" for each entry, '|' for a separator, a submenu's entries in brackets. */
const show = (entries) => entries.map((e) => (e.sep ? '|' : `${e.label}${e.key ? `/${e.key}` : ''}${e.sub ? `[${show(e.sub).join(', ')}]` : ''}`));
const labels = (hit) => show(menuFor(hit).entries);

test('each of the 13 contexts gets its menu in the brief\'s order with the probe\'s access keys', () => {
  const TEXT = ['Cut/T', 'Copy/C', 'Paste Options', '|', 'Font.../F', 'Paragraph.../P', '|', 'Search "cat"', 'Synonyms/Y', 'Read Aloud/R', 'Translate/T', '|', 'Link', 'New Comment/M'];
  assert.deepEqual(labels({ word: 'cat' }), TEXT);
  assert.equal(menuFor({}).id, 'text');
  assert.deepEqual(labels({ list: true, numbered: true }), ['Cut/T', 'Copy/C', 'Paste Options', '|', 'Adjust List Indents.../U', 'Restart at 1', 'Continue Numbering/C',
    'Set Numbering Value.../V', '|', 'Font.../F', 'Paragraph.../P', '|', 'Synonyms/Y', 'Read Aloud/R', 'Translate/T', '|', 'New Comment/M']);
  assert.ok(!labels({ list: true }).includes('Restart at 1'), 'Restart at 1 only on a numbered item');
  const table = labels({ table: true, cells: 1 });
  assert.deepEqual(table.slice(0, 7), ['Cut/T', 'Copy/C', 'Paste Options', '|', 'Synonyms/Y', 'Read Aloud/R', 'Translate/T']);
  assert.ok(table.includes('Insert/I[Insert Columns to the Left/L, Insert Columns to the Right/R, Insert Rows Above/A, Insert Rows Below/B, Insert Cells.../E]'));
  assert.deepEqual(table.slice(-7), ['Delete Cells.../D', 'Split Cells.../G', 'Border Styles/B', 'Text Direction.../X', 'Table Properties.../R', '|', 'New Comment/M']);
  assert.ok(labels({ table: true, cells: 4 }).includes('Merge Cells/G'));
  assert.deepEqual(labels({ table: true, list: true }).slice(3, 8), ['|', 'Adjust List Indents.../U', 'Continue Numbering/C', 'Set Numbering Value.../V', '|']);
  assert.deepEqual(labels({ picture: true }), ['Cut/T', 'Copy/C', 'Paste Options', '|', 'Save as Picture.../S', 'Change Picture/A', 'Group/G', 'Bring to Front/R',
    'Send to Back/K', 'Link', 'Insert Caption.../C', 'Wrap Text/W', 'View Alt Text...', 'Size and Position.../Z', 'Format Picture.../O', '|', 'New Comment/M']);
  assert.deepEqual(labels({ link: true }).slice(0, 5), ['Edit Hyperlink.../H', 'Open Hyperlink/O', 'Copy Hyperlink/C', 'Remove Hyperlink/R', '|']);
  assert.deepEqual(labels({ link: true }).slice(5), TEXT.map((l) => l.replace(' "cat"', '')));
  assert.deepEqual(labels({ field: true }), ['Cut/T', 'Copy/C', 'Paste Options', '|', 'Update Field/U', 'Edit Field.../E', 'Toggle Field Codes/T', '|', 'Font.../F', 'Paragraph.../P']);
  assert.deepEqual(labels({ story: 'comment' }), ['Cut/T', 'Copy/C', 'Paste/P', '|', 'Edit Comment/E', 'Reply To Comment/M', 'Delete Comment/M', 'Mark Comment Done/O', '|',
    'Font.../F', 'Paragraph.../P', '|', 'New Comment/M']);
  assert.deepEqual(labels({ revision: { kind: 'insert' } }), ['Accept Insertion/E', 'Reject Insertion/R', 'Track Changes/T', '|', 'Cut/T', 'Copy/C', 'Paste/P', '|', 'New Comment/M']);
  assert.deepEqual(labels({ heading: true }).slice(0, 4), ['Cut/T', 'Copy/C', 'Paste Options',
    'Expand/Collapse/E[Expand Heading/E, Collapse Heading/C, Expand All Headings/X, Collapse All Headings/L]']);
  assert.deepEqual(labels({ story: 'footnote' }), ['Cut/T', 'Copy/C', 'Paste/P', '|', 'Font.../F', 'Paragraph.../P', 'Style.../S', '|', 'Go to Footnote/G', 'Note Options.../N',
    'Convert to Endnote/V', '|', 'New Comment/M']);
  assert.ok(labels({ story: 'endnote' }).includes('Convert to Footnote/V') && labels({ story: 'endnote' }).includes('Go to Endnote/G'));
  assert.deepEqual(labels({ equation: true }), ['Cut/T', 'Copy/C', 'Paste/P', '|', 'Professional/P', 'Linear/L', 'Save as New Equation.../S', '|', 'Font.../F', 'Paragraph.../P']);
  assert.deepEqual(labels({ headerArea: 'header', table: true }), ['Edit Header/H']);
  assert.deepEqual(labels({ headerArea: 'footer' }), ['Edit Footer/E']);
  const ids = [{}, { list: true }, { table: true }, { picture: true }, { link: true }, { field: true }, { comment: true }, { revision: { kind: 'delete' } },
    { heading: true }, { note: 'footnote' }, { equation: true }, { headerArea: 'header' }].map(contextOf);
  assert.deepEqual(ids, ['text', 'lists', 'table', 'picture', 'hyperlink', 'field', 'comment', 'revision', 'headings', 'footnote', 'equation', 'header']);
});

test('the spelling card sits on top: three suggestions with Read Aloud and Change All, then Add to Dictionary, Ignore All and See More', () => {
  const m = menuFor({ spelling: { word: 'teh', suggestions: ['the', 'tech', 'ten', 'tea'] }, word: 'teh' });
  assert.equal(m.id, 'spelling');
  assert.deepEqual(show(m.entries).slice(0, 8), ['the[Read Aloud/R, Change All/A]', 'tech[Read Aloud/R, Change All/A]', 'ten[Read Aloud/R, Change All/A]',
    'Add to Dictionary/A', 'Ignore All/I', 'See More', '|', 'Cut/T']);
});

test('an unregistered command drops out, a reason shows disabled, a revision falls back to base', () => {
  const has = (id) => ['home.clipboard.cut', 'home.clipboard.copy', 'insert.comments.comment', 'review.tracking.accept', 'review.tracking.reject'].includes(id);
  const m = menuFor({ word: 'cat' }, { has });
  assert.deepEqual(show(m.entries), ['Cut/T', 'Copy/C', '|', 'Search "cat"', 'Translate/T', '|', 'New Comment/M']);
  const tr = m.entries.find((e) => e.label === 'Translate');
  assert.equal(tr.disabled, true);
  assert.equal(tr.reason, REASONS.cloud);
  assert.ok(!m.entries.some((e) => e.label === 'Synonyms'), 'a cmd that is not registered drops out');
  const r = menuFor({ revision: { kind: 'delete' } }, { has }).entries;
  assert.equal(r[0].label, 'Accept Deletion');
  assert.equal(r[0].cmd, 'review.tracking.accept');
  assert.equal(r[1].cmd, 'review.tracking.reject');
  // A submenu with nothing registered drops out; a spec menu stays while one of its items is registered.
  assert.ok(!show(menuFor({ table: true }, { has }).entries).some((l) => l.startsWith('Insert/')));
  const pic = menuFor({ picture: true }, { has: (id) => id === 'layout.arrange.wrapText.square', menus: { 'layout.arrange.wrapText': [{ item: 'layout.arrange.wrapText.square' }] } });
  assert.deepEqual(show(pic.entries), ['Wrap Text/W']);
  assert.equal(entryForKey(m.entries, 't').label, 'Cut');
  assert.deepEqual(entriesForKey(m.entries, 't').map((e) => e.label), ['Cut'], 'a disabled entry (Translate) does not match');
  const shared = [{ label: 'Paste', key: 'P' }, { sep: true }, { label: 'Paragraph...', key: 'P' }];
  assert.deepEqual(entriesForKey(shared, 'p').map((e) => e.label), ['Paste', 'Paragraph...'], 'a shared letter matches both, so the menu cycles');
});

test('revision labels name the change', () => {
  assert.equal(changeName({ kind: 'insert' }), 'Insertion');
  assert.equal(changeName({ kind: 'delete' }), 'Deletion');
  assert.equal(changeName({ kind: 'format' }), 'Formatting Change');
  assert.equal(changeName({ kind: 'paraMark', op: 'delete' }), 'Deletion');
  assert.equal(changeName({ kind: 'replace' }), 'Change');
});

test('Change All replaces whole-word, same-case matches only', () => {
  assert.deepEqual(wordMatches('teh Teh teh, tehx xteh teh', 'teh'), [0, 8, 23]);
  const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'inline*' }, text: { group: 'inline' } }, marks: { strong: {} } });
  const p = (...kids) => schema.node('paragraph', null, kids);
  const doc = schema.node('doc', null, [p(schema.text('teh cat ')), p(schema.text('Teh teh', [schema.mark('strong')]), schema.text(' tehteh'))]);
  const tr = EditorState.create({ doc }).tr;
  assert.equal(changeAll(tr, 'teh', 'the'), 2);
  assert.equal(tr.doc.textBetween(0, tr.doc.content.size, '\n'), 'the cat \nTeh the tehteh');
  assert.ok(tr.doc.child(1).child(0).marks.length, 'the replaced word keeps its marks');
});

test('the mini toolbar sits above the selection, flips below near the top and never covers a selection rect', () => {
  const view = { left: 0, top: 40, right: 1000, bottom: 800 };
  const rects = [{ left: 100, top: 300, right: 400, bottom: 320 }, { left: 80, top: 320, right: 200, bottom: 340 }];
  const hits = (p, w, h) => rects.some((r) => p.left < r.right && p.left + w > r.left && p.top < r.bottom && p.top + h > r.top);
  const up = placeBar({ rects, at: { x: 150, y: 330 }, w: 300, h: 60, view });
  assert.equal(up.below, false);
  assert.equal(up.top, 300 - 8 - 60);
  assert.ok(!hits(up, 300, 60));
  const top = [{ left: 100, top: 60, right: 300, bottom: 80 }];
  const down = placeBar({ rects: top, at: { x: 120, y: 70 }, w: 300, h: 60, view });
  assert.equal(down.below, true);
  assert.equal(down.top, 88);
  assert.ok(!top.some((r) => down.top < r.bottom));
  assert.equal(placeBar({ rects, at: { x: 400, y: 330 }, w: 300, h: 60, view: { ...view, right: 420 } }).left, 120, 'kept inside the view');
});

test('the fade rule: solid within 30 px, faded to 100 px, hidden beyond', () => {
  const bar = { left: 100, top: 100, right: 300, bottom: 150 };
  assert.equal(fadeAt(distance({ x: 200, y: 170 }, bar)), 'solid');
  assert.equal(fadeAt(distance({ x: 200, y: 210 }, bar)), 'faded');
  assert.equal(fadeAt(distance({ x: 200, y: 270 }, bar)), 'hidden');
  assert.equal(distance({ x: 150, y: 120 }, bar), 0);
});

test('a right-click above the body is the header band, below it the footer band', () => {
  const pages = [{ top: 0, bodyTop: 96, bodyHeight: 864, box: { h: 1056 } }, { top: 1076, bodyTop: 1172, bodyHeight: 864, box: { h: 1056 } }];
  assert.equal(areaAt(pages, 40), 'header');
  assert.equal(areaAt(pages, 500), null);
  assert.equal(areaAt(pages, 1000), 'footer');
  assert.equal(areaAt(pages, 1066), null, 'between pages');
  assert.equal(areaAt(pages, 1100), 'header');
});
