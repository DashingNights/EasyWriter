import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { defs } from '../src/app/commands/doc.mjs';
import { documentExtensions } from '../src/document/schema.js';
import { numberText } from '../src/document/fields/numfmt.mjs';
import { FIELD_NAMES, fieldCtx, fieldNames, fieldType, parseField, registerField, updateState } from '../src/document/fields/registry.mjs';
import { blocksOf, storiesOf } from '../src/document/model/blocks.mjs';
import { commentsOf, isDeleted, revisionsOf, visibleText } from '../src/document/model/review.mjs';
import { ensureStyles, styleChain } from '../src/document/model/styles.mjs';
import { tabStopsOf } from '../src/document/model/tabs.mjs';

// Word parity scaffold (docs/plans/word/plan.md §1.8 helpers, §1.10, §1.11): the pure model helpers and the field registry, read
// through schema v2's own nodes and marks.
const schema = getSchema(documentExtensions(50));
const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const p = (...content) => ({ type: 'paragraph', content });
const ins = (id, author = 'Ana') => ({ type: 'insertion', attrs: { id, author, date: '2026-10-27T10:00:00Z' } });
const del = (id, author = 'Ben') => ({ type: 'deletion', attrs: { id, author, date: '2026-10-27T11:00:00Z' } });
const doc = (content, attrs = {}) => schema.nodeFromJSON({ type: 'doc', attrs, content });

// ---------- parseField ----------
test('parseField: the syntax examples of index-fields.md', () => {
  const f = (code, nest) => parseField(code, nest);
  assert.deepEqual(f(' num ').name, 'REF', 'a first word that is no field name is a bookmark');
  assert.deepEqual(f('num').args, ['num']);
  assert.deepEqual([f('FORMULA').name, f('FORMULA').args], ['REF', ['FORMULA']]);
  assert.equal(f('page \\* roman').name, 'PAGE', 'names are case-insensitive');
  assert.deepEqual(f('QUOTE "a \\"quoted\\" word"').args, ['a "quoted" word']);
  assert.deepEqual(f('INCLUDETEXT "C:\\\\folder\\\\file.docx"').args, ['C:\\folder\\file.docx']);
  assert.deepEqual(f('QUOTE noquotes here').args, ['noquotes', 'here']);
  assert.deepEqual(f("QUOTE 'single'").args, ["'single'"], 'apostrophes are not quotes');
  assert.deepEqual(f('QUOTE ""').args, ['']);
  const formula = f('= 28 \\* roman \\* Upper');
  assert.deepEqual([formula.name, formula.args, formula.format], ['=', ['28'], ['roman', 'Upper']]);
  assert.deepEqual(f('=2+3*4').args, ['2+3*4']);
  assert.equal(f('QUOTE "12 apples" \\# "0.0"').numeric, '0.0');
  assert.equal(f('= 5 \\# 00').numeric, '00', 'a picture without spaces needs no quotes');
  assert.equal(f('= 5 \\#00').numeric, '00');
  assert.equal(f('= 1234.5 \\# "0.00 `Figure`"').numeric, '0.00 `Figure`');
  const date = f('DATE \\@ "dddd" \\* Upper');
  assert.deepEqual([date.date, date.format], ['dddd', ['Upper']]);
  const toc = f('TOC \\o "1-3" \\h \\z \\u');
  assert.deepEqual(toc.sw, { o: '1-3', h: true, z: true, u: true });
  const ref = f('REF bm \\H \\d "-" \\! ');
  assert.deepEqual([ref.args, ref.sw, ref.lock], [['bm'], { h: true, d: '-' }, true]);
  assert.equal(ref.code, 'REF bm \\H \\d "-" \\! ');
  // Nested fields: kept as written without a resolver, replaced by their results with one (inside quotes too).
  const ifCode = 'IF { PAGE } = 1 "first page" "page { PAGE }"';
  assert.deepEqual(f(ifCode).args, ['{ PAGE }', '=', '1', 'first page', 'page { PAGE }']);
  const nest = (c) => ({ PAGE: '3', NUMPAGES: '9', 'QUOTE "}"': '}' })[c] ?? '?';
  assert.deepEqual(f(ifCode, nest).args, ['3', '=', '1', 'first page', 'page 3']);
  assert.deepEqual(f('QUOTE "Page { PAGE } of { NUMPAGES }"', nest).args, ['Page 3 of 9']);
  assert.deepEqual(f('QUOTE { QUOTE "}" }x', nest).args, ['}x'], 'a brace inside the nested field quotes');
  const sum = f('= { num } * 2 \\# "0.00"', (c) => (c === 'num' ? '42' : ''));
  assert.deepEqual([sum.args, sum.numeric], [['42 * 2'], '0.00']);
  assert.deepEqual(f('').name, '');
  // A type's bare letters take no argument.
  const off = registerField('XQTEST', { category: 'All', updates: 'manual', bare: 'h', compute: () => 'x' });
  assert.deepEqual(f('XQTEST \\h word').args, ['word']);
  assert.deepEqual(f('XQTEST \\h word').sw, { h: true });
  assert.ok(fieldNames().includes('XQTEST'));
  off();
  assert.equal(fieldType('XQTEST'), null);
  assert.equal(FIELD_NAMES.length, 95);
  assert.ok(FIELD_NAMES.includes('=') && FIELD_NAMES.includes('DISPLAYBARCODE'));
});

test('numberText: decimal, letters, roman and the text formats (fields-core completes the stub)', () => {
  assert.equal(numberText(4, 'upperRoman'), 'IV');
  assert.equal(numberText(14, 'lowerRoman'), 'xiv');
  assert.equal(numberText(3, 'upperLetter'), 'C');
  assert.equal(numberText(28, 'lowerLetter'), 'bb');
  assert.equal(numberText(12, 'decimal'), '12');
  assert.equal(numberText(5, 'cardinalText'), 'five');
});

test('fieldCtx: bookmark, prop, variable and listLabel providers; setProp only inside an update', () => {
  const numbering = { abstract: { decimal: { levels: [{ fmt: 'decimal', text: '%1)', start: 1 }, { fmt: 'lowerLetter', text: '%2)', start: 1 }] } }, nums: { 3: { abstract: 'decimal' } } };
  const d = doc([
    p(t('Total '), { type: 'bookmark', attrs: { name: 'Num', id: 'b1' } }, t('42'), { type: 'bookmark', attrs: { name: 'Num', id: 'b1', end: true } }),
    { type: 'paragraph', attrs: { numbering: { numId: 3, ilvl: 0 } }, content: [t('First')] },
    { type: 'paragraph', attrs: { numbering: { numId: 3, ilvl: 1 } }, content: [t('Sub')] },
  ], { numbering, props: { core: { creator: 'Ana', title: 'Report' }, custom: [{ name: 'Client', type: 'text', value: 'ACME' }] }, vars: { Region: 'North' } });
  const ctx = fieldCtx({ doc: d, pos: 1, draft: { title: 'Draft title', revision: 4 }, user: { name: 'Kel' } });
  const bm = ctx.bookmark('num');
  assert.equal(d.textBetween(bm.from, bm.to), '42');
  assert.equal(ctx.bookmark('missing'), null);
  assert.equal(ctx.get('prop', 'Author'), 'Ana');
  assert.equal(ctx.get('prop', 'title'), 'Report');
  assert.equal(ctx.get('prop', 'RevisionNumber'), 4);
  assert.equal(ctx.get('prop', 'client'), 'ACME');
  assert.equal(ctx.get('variable', 'region'), 'North');
  assert.equal(ctx.get('variable', 'nope'), null);
  let sub = 0;
  d.forEach((n, pos) => { if (n.textContent === 'Sub') sub = pos + 2; });
  assert.deepEqual(ctx.listLabel(sub), { text: 'a)', levels: ['1)', 'a)'] });
  assert.equal(ctx.listLabel(1), null);
  assert.equal(ctx.user.name, 'Kel');
  ctx.setProp('core.title', 'X'); // ignored outside an update
  const shared = updateState({ props: [] });
  fieldCtx({ doc: d, shared }).setProp('core.title', 'Y');
  assert.deepEqual(shared.props, [{ path: 'core.title', value: 'Y' }]);
  assert.equal(ctx.pageAt(5), null);
  assert.deepEqual(fieldCtx({ doc: d, geometry: { pages: [{ index: 0, from: 0, to: 10 }, { index: 1, from: 10, to: 99 }] } }).pageAt(12).index, 1);
});

// ---------- review ----------
const footer = { default: [p(t('Page '), t('old', [del('d9', 'Cy')]), t(' footer'))], first: null, even: null };
const reviewDoc = () => doc([
  p(t('Kept '), t('added', [ins('i1')]), t(' and '), t('gone', [del('d1')]), t(' end')),
  { type: 'paragraph', attrs: { markRev: { del: { id: 'm1', author: 'Ben', date: null } } }, content: [t('Para with a note'), { type: 'noteRef', attrs: { id: 'n1', content: [p(t('Note '), t('cut', [del('d2')]))] } }] },
  { type: 'columns', content: [p(t('in columns', [ins('i2')])), p(t('more', [ins('i2')]))] },
], { sect: { ftr: footer } });

test('revisionsOf: marks joined into runs by id, a paragraph mark, the footer part and the note with their locators', () => {
  const rs = revisionsOf(reviewDoc());
  const body = rs.filter((r) => !r.at);
  assert.deepEqual(body.map((r) => [r.kind, r.id, r.text ?? null, r.op ?? null]), [
    ['insert', 'i1', 'added', null], ['delete', 'd1', 'gone', null], ['paraMark', 'm1', null, 'delete'], ['insert', 'i2', 'in columnsmore', null]]);
  assert.ok(body.every((r) => r.source === 'tracking'));
  const d = reviewDoc();
  const r1 = body[0];
  assert.equal(d.textBetween(r1.from, r1.to), 'added');
  assert.equal(r1.author, 'Ana');
  const stories = rs.filter((r) => r.at);
  assert.deepEqual(stories.map((r) => [r.at, r.id, r.text]), [
    [{ story: 'footer', section: 0, part: 'default' }, 'd9', 'old'], [{ story: 'note', id: 'n1' }, 'd2', 'cut']]);
  assert.equal(stories[0].from, 6, 'positions inside the footer story');
});

test('visibleText in the four displays; isDeleted reads nodes and JSON', () => {
  const d = reviewDoc();
  const first = d.child(0);
  assert.equal(visibleText(first), 'Kept added and  end');
  assert.equal(visibleText(first, 'simple'), 'Kept added and  end');
  assert.equal(visibleText(first, 'original'), 'Kept  and gone end');
  assert.equal(visibleText(first, 'all'), 'Kept added and gone end');
  assert.equal(visibleText(first.toJSON(), 'original'), 'Kept  and gone end', 'JSON too');
  assert.equal(visibleText(doc([p(t('a')), p(t('b'), { type: 'field', attrs: { code: 'PAGE', result: '7' } }, { type: 'hardBreak' }, t('c'))])), 'a\nb7\nc');
  // A text box deleted through rev.del, inserted through rev.ins; ruby reads as its base text.
  const box = (rev) => ({ type: 'textBox', attrs: { rev }, content: [p(t('box'))] });
  const blocks = doc([p(t('a')), box({ del: { id: 'r1' } }), box({ ins: { id: 'r2' } }), p({ type: 'ruby', attrs: { base: '漢字', text: 'kanji' } })]);
  assert.equal(visibleText(blocks), 'a\nbox\n漢字');
  assert.equal(visibleText(blocks, 'original'), 'a\nbox\n漢字');
  assert.equal(visibleText(blocks, 'all'), 'a\nbox\nbox\n漢字');
  assert.ok(isDeleted([del('x')]) && isDeleted(schema.text('x', [schema.markFromJSON(del('x'))]).marks));
  assert.ok(!isDeleted([ins('x')]) && !isDeleted(undefined));
});

test('commentsOf: ranges per id in document order, threads with replies, a comment without anchor last', () => {
  const c = (id) => ({ type: 'comment', attrs: { id } });
  const d = doc([p(t('one '), t('two', [c('c2')]), t(' three')), p(t('four', [c('c1')]), t(' five', [c('c1')]))], {
    comments: {
      c1: { author: 'Ana', initials: 'A', date: '2026-10-27T09:00:00Z', done: false, parent: null, content: [p(t('Check'))] },
      c2: { author: 'Ben', date: '2026-10-27T08:00:00Z', parent: null },
      r2: { author: 'Cy', date: '2026-10-27T12:00:00Z', parent: 'c1' }, r1: { author: 'Di', date: '2026-10-27T10:00:00Z', parent: 'c1' },
      lone: { author: 'Ed' },
    },
  });
  const cs = commentsOf(d);
  assert.deepEqual(cs.map((x) => x.id), ['c2', 'c1', 'lone']);
  assert.equal(cs[1].text, 'four five');
  assert.equal(d.textBetween(cs[1].from, cs[1].to), 'four five');
  assert.deepEqual(cs[1].replies.map((x) => x.id), ['r1', 'r2']);
  assert.equal(cs[2].from, null);
});

// ---------- styles, tabs, blocks ----------
const styles = {
  defaults: {},
  list: {
    Normal: { type: 'paragraph', name: 'Normal', para: { tabs: [{ pos: 72, align: 'left', leader: 'none' }, { pos: 144, align: 'right', leader: 'dot' }] } },
    Base: { type: 'paragraph', name: 'Base', basedOn: 'Normal', para: { tabs: [{ pos: 36, align: 'center' }] } },
    Mine: { type: 'paragraph', name: 'Mine', basedOn: 'Base', para: { tabs: [{ pos: 72, align: 'clear' }] } },
    Loop: { type: 'paragraph', name: 'Loop', basedOn: 'Loop2' }, Loop2: { type: 'paragraph', name: 'Loop 2', basedOn: 'Loop' },
  },
};

test('styleChain: base first, a loop stops; ensureStyles adds only what is missing', () => {
  const d = doc([p()], { styles });
  assert.deepEqual(styleChain(d, 'Mine').map((s) => s.id), ['Normal', 'Base', 'Mine']);
  assert.deepEqual(styleChain(d, 'Loop').map((s) => s.id), ['Loop2', 'Loop']);
  assert.deepEqual(styleChain(d, 'Nope'), []);
  const out = ensureStyles(d, { Mine: { type: 'paragraph', name: 'Other' }, Caption: { type: 'paragraph', name: 'caption' } });
  assert.deepEqual(Object.keys(out.list), [...Object.keys(styles.list), 'Caption']);
  assert.equal(out.list.Mine.name, 'Mine', 'the document keeps its own definition');
  assert.equal(ensureStyles(d, { Normal: {} }), null);
});

test('tabStopsOf: the style chain then the node; a clear removes an inherited stop; 64 at most', () => {
  const d = doc([p()], { styles, settings: { defaultTabStop: 35.4 } });
  const node = schema.nodeFromJSON({ type: 'paragraph', attrs: { styleId: 'Mine', tabs: [{ pos: 144, align: 'clear' }, { pos: 200, align: 'decimal', leader: 'hyphen' }] } });
  assert.deepEqual(tabStopsOf(d, node), { stops: [{ pos: 36, align: 'center', leader: 'none' }, { pos: 200, align: 'decimal', leader: 'hyphen' }], default: 35.4 });
  const many = schema.nodeFromJSON({ type: 'paragraph', attrs: { tabs: Array.from({ length: 70 }, (_, i) => ({ pos: 300 + i, align: 'left' })) } });
  assert.equal(tabStopsOf(doc([p()]), many).stops.length, 64);
  assert.equal(tabStopsOf(doc([p()]), many).default, 36);
  assert.deepEqual(tabStopsOf(d, schema.nodeFromJSON(p())).stops.map((s) => s.pos), [72, 144], 'Normal');
});

test('blocksOf walks through the wrappers; storiesOf lists every story with its locator', () => {
  const sect = { hdr: { default: [p(t('Head'))], first: [p(t('First head'))], even: null }, ftr: null };
  const d = doc([
    p(t('a')),
    { type: 'columns', content: [p(t('b')), { type: 'sdtBlock', attrs: { sdt: { id: 's1' } }, content: [p(t('c'))] }] },
    { type: 'sectionBreak', attrs: { sect } },
    p(t('d'), { type: 'noteRef', attrs: { id: 'n1', content: [p(t('A note'))] } }),
  ], { sect: { ftr: { default: [p(t('Foot'))] } }, comments: { c1: { content: [p(t('Say'))] }, c2: { author: 'x' } } });
  const bs = [...blocksOf(d)];
  assert.deepEqual(bs.map((b) => [b.node.type.name, b.depth, b.node.textContent]), [
    ['paragraph', 0, 'a'], ['columns', 0, 'bc'], ['paragraph', 1, 'b'], ['sdtBlock', 1, 'c'], ['paragraph', 2, 'c'], ['sectionBreak', 0, ''], ['paragraph', 0, 'd']]);
  for (const b of bs) assert.equal(d.nodeAt(b.pos), b.node);
  const ss = storiesOf(d);
  assert.deepEqual(ss.map((s) => s.at), [
    { story: 'header', section: 0, part: 'default' }, { story: 'header', section: 0, part: 'first' },
    { story: 'footer', section: 1, part: 'default' }, { story: 'note', id: 'n1' }, { story: 'comment', id: 'c1' }]);
  assert.equal(ss[0].holder, bs[5].pos);
  assert.equal(ss[2].holder, null);
  assert.equal(d.nodeAt(ss[3].holder).type.name, 'noteRef');
});

// ---------- doc.replace and doc.insert: what a rewrite loses ----------
test('doc.replace over a block holding a field and a footnote reports both as lost and changes nothing; allowLoss passes', async () => {
  const replace = defs.find((x) => x.id === 'doc.replace');
  const insert = defs.find((x) => x.id === 'doc.insert');
  const d = doc([p(t('Page '), { type: 'field', attrs: { code: 'PAGE', result: '3' } }, t(' see'), { type: 'noteRef', attrs: { id: 'n1', content: [p(t('Source'))] } }), p(t('two'))]);
  const state = EditorState.create({ doc: d });
  const ctx = (nodes) => ({ editor: { state }, lib: { toNodes: async () => ({ nodes, dropped: [] }) } });
  const markdown = [schema.nodeFromJSON(p(t('Page 3 see[^1]')))];
  await assert.rejects(replace.plan(ctx(markdown), { path: [0], content: { markdown: 'Page 3 see[^1]' } }), (e) => {
    assert.equal(e.code, 'refused');
    assert.equal(e.data.code, 'content_lost');
    assert.deepEqual(e.data.lost, [{ kind: 'field', code: 'PAGE' }, { kind: 'note', note: 'footnote', id: 'n1', text: 'Source' }]);
    return true;
  });
  // The block written back whole keeps both; allowLoss lets a lossy rewrite through and reports what went.
  const kept = await replace.plan(ctx([d.child(0)]), { path: [0], content: { json: {} } });
  assert.equal(kept.result.lost, undefined);
  const lossy = await replace.plan(ctx(markdown), { path: [0], content: { markdown: '' }, allowLoss: true });
  assert.deepEqual(lossy.result.lost.map((l) => l.kind), ['field', 'note']);
  assert.equal(lossy.tr.doc.child(0).textContent, 'Page 3 see[^1]');
  // doc.insert: Markdown note markers would turn into plain text.
  await assert.rejects(insert.plan(ctx(markdown), { at: 'end', content: { markdown: 'Text[^1]' } }), (e) => e.data.code === 'content_lost');
  assert.deepEqual((await insert.plan(ctx(markdown), { at: 'end', content: { markdown: 'Plain' } })).result.paths, [[2]]);
  // A regex class in code is code, not a note marker.
  const code = 'Match `[^0-9]` or [^a]\n\n```js\nconst r = /[^1]/;\n```';
  assert.deepEqual((await insert.plan(ctx(markdown), { at: 'end', content: { markdown: code } })).result.paths, [[2]]);
});

test('doc.replace refuses to drop run and paragraph properties and names doc_edit; doc.edit swaps words and keeps them', async () => {
  const replace = defs.find((x) => x.id === 'doc.replace');
  const edit = defs.find((x) => x.id === 'doc.edit');
  const run = { type: 'textStyle', attrs: { font: 'Georgia', size: 14, color: '#C00000', highlight: 'yellow' } };
  const styled = { type: 'paragraph', attrs: { styleId: 'Quote', spacing: { before: 12, after: 18 } }, content: [t('The quick fox', [run])] };
  const state = EditorState.create({ doc: doc([styled]) });
  const ctx = { editor: { state }, lib: { toNodes: async () => ({ nodes: [schema.nodeFromJSON(p(t('The slow fox')))], dropped: [] }) } };
  await assert.rejects(replace.plan(ctx, { path: [0], content: { markdown: 'The slow fox' } }), (e) => {
    assert.equal(e.data.code, 'content_lost');
    assert.deepEqual(new Set(e.data.lost.map((l) => `${l.kind}:${l.property}`)),
      new Set(['paragraph:styleId', 'paragraph:spacing', 'run:font', 'run:size', 'run:color', 'run:highlight']));
    assert.match(e.data.hint, /doc_edit/);
    return true;
  });
  const { tr } = edit.plan(ctx, { path: [0], from: 4, to: 9, text: 'slow' });
  const after = tr.doc.child(0);
  assert.equal(after.textContent, 'The slow fox');
  assert.deepEqual(after.attrs, state.doc.child(0).attrs);
  assert.ok(after.firstChild.marks[0].eq(state.doc.child(0).firstChild.marks[0]) && after.childCount === 1);
  assert.throws(() => edit.plan(ctx, { path: [0], from: 4, to: 99, text: 'x' }), (e) => e.code === 'invalid_args');
});

// ---------- the engine stub ----------
test('updateFields: manual writes every result in one undo step; layout and open write nothing', async () => {
  const { Editor } = await import('@tiptap/core');
  const { undoDepth } = await import('@tiptap/pm/history');
  const { updateFields, drawnOf, insertField } = await import('../src/document/fields/engine.js');
  const field = (code, extra) => ({ type: 'field', attrs: { code, ...extra } });
  const ed = new Editor({ element: null, extensions: documentExtensions(50), content: { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'On ' }, field('DATE'), { type: 'text', text: ' page ' }, field('PAGE'), field('DATE', { locked: true, result: 'kept' })] }] } });
  ed.view.updateState(ed.state.reconfigure({ plugins: ed.extensionManager.plugins }));
  const offs = [
    registerField('DATE', { category: 'Date and Time', updates: 'open', compute: (f, ctx) => ctx.now.toISOString().slice(0, 10) }),
    registerField('PAGE', { category: 'Numbering', updates: 'layout', compute: (f, ctx) => String((ctx.page?.index ?? 0) + 1) }),
  ];
  try {
    const before = ed.state.doc;
    assert.equal(await updateFields(ed, 'all', 'layout'), 1, 'PAGE only');
    assert.equal(await updateFields(ed, 'all', 'open'), 2);
    assert.equal(ed.state.doc, before, 'no doc write');
    assert.equal(undoDepth(ed.state), 0);
    assert.equal([...drawnOf(ed).values()].length, 2);
    assert.equal(await updateFields(ed, 'all', 'manual', { names: ['DATE'] }), 1);
    const results = [];
    ed.state.doc.descendants((n) => void (n.type.name === 'field' && results.push(n.attrs.result)));
    assert.deepEqual(results, [new Date().toISOString().slice(0, 10), null, 'kept']);
    assert.equal(undoDepth(ed.state), 1);
    assert.equal(await updateFields(ed, 'all', 'manual'), 2);
    assert.equal(undoDepth(ed.state), 2, 'one step per update');
    ed.commands.setTextSelection(1);
    assert.ok(insertField(ed, 'PAGE', { marks: [{ type: 'bold' }] }));
    const inserted = ed.state.doc.firstChild.firstChild;
    assert.deepEqual([inserted.attrs.code, inserted.attrs.result, inserted.marks.map((m) => m.type.name)], ['PAGE', '1', ['bold']]);
  } finally {
    offs.forEach((off) => off());
    ed.destroy();
  }
});
