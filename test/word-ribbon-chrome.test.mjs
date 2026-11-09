// ribbon-chrome's pure parts (docs/plans/word briefs/ribbon-chrome.md Acceptance): the KeyTips machine over the spec's own
// KeyTips, derived menu KeyTips, adaptive groups (layout.mjs groupAt and fit), the F6 order and the Quick Access Toolbar's
// customise menu.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as SPEC from '../src/document/ribbon/spec.mjs';
import { WORD_DEFAULTS } from '../src/document/word/settings.mjs';
import { back, deriveKeytips, enter, IDLE, matching, press, resolveKeytips, top } from '../src/document/wp/ribbon-chrome/keytips.mjs';
import { moveQat, nextRegion, QAT_MENU, regionOrder, toggleQat } from '../src/document/wp/ribbon-chrome/nav.mjs';
import { fit, groupAt, layoutTab, tabKeytips } from '../src/tooling/ribbon/layout.mjs';

const tabRow = () => resolveKeytips(tabKeytips(SPEC).map(([keys, id]) => ({ keys, id, label: id })));
const controls = (tab) => resolveKeytips(layoutTab(SPEC, tab).keytips.filter(([, , kind]) => kind !== 'group').map(([keys, id]) => ({ keys, id, label: id })));

test('Alt, H, F, P presses Format Painter; F alone filters the two-key KeyTips', () => {
  let m = enter(IDLE, 'top');
  let r = press(m, 'H', tabRow());
  assert.equal(r.act, 'press');
  assert.equal(r.entry.id, 'home');
  m = enter(r.m, 'tab:home');
  const home = controls('home');
  r = press(m, 'F', home);
  assert.equal(r.act, 'filter');
  const left = matching(r.m, home);
  assert.ok(left.length > 1 && left.every((e) => e.keys.startsWith('F ')), 'only the KeyTips starting with F stay lit');
  assert.ok(left.some((e) => e.id === 'home.clipboard.formatPainter'));
  r = press(r.m, 'P', home);
  assert.equal(r.act, 'press');
  assert.equal(r.entry.id, 'home.clipboard.formatPainter');
});

test('Esc clears what was typed, then steps back to the tab row, then ends', () => {
  let m = enter(enter(IDLE, 'top'), 'tab:home');
  m = press(m, 'F', controls('home')).m;
  let r = back(m);
  assert.equal(r.act, 'clear');
  assert.deepEqual(top(r.m).typed, []);
  r = back(r.m);
  assert.equal(r.act, 'back');
  assert.equal(top(r.m).id, 'top');
  r = back(r.m);
  assert.equal(r.act, 'end');
  assert.equal(r.m.levels.length, 0);
});

test('a key no KeyTip starts with misses (KeyTips end); the tab row covers File, every main tab and the J tabs', () => {
  const row = tabRow();
  assert.equal(press(enter(IDLE, 'top'), 'K', row).act, 'miss');
  for (const [keys, id] of [['F', 'file'], ['N', 'insert'], ['P', 'layout'], ['W', 'view']]) {
    const r = press(enter(IDLE, 'top'), keys, row);
    assert.equal(r.entry?.id, id, keys);
  }
  let r = press(enter(IDLE, 'top'), 'J', row);
  assert.equal(r.act, 'filter');
  r = press(r.m, 'T', row);
  assert.equal(r.entry.id, 'tableDesign');
});

test('shared keys get numbers: C 1 and C 2 are both reachable', () => {
  const list = resolveKeytips([{ keys: 'C', id: 'a' }, { keys: 'C', id: 'b' }, { keys: 'X', id: 'c' }]);
  assert.deepEqual(list.map((e) => e.keys), ['C 1', 'C 2', 'X']);
  for (const [n, id] of [['1', 'a'], ['2', 'b']]) {
    const r1 = press(enter(IDLE, 'menu'), 'C', list);
    assert.equal(r1.act, 'filter');
    assert.equal(press(r1.m, n, list).entry.id, id);
  }
  // A key that starts a longer one is numbered too, so both stay reachable.
  assert.deepEqual(resolveKeytips([{ keys: 'E' }, { keys: 'E 2' }]).map((e) => e.keys), ['E 1', 'E 2']);
});

test('derived menu KeyTips are unique, skip the letters siblings hold and fall back to digits', () => {
  const keys = deriveKeytips(['Save', 'Save As', 'Share', 'SSS'], ['S', 'H X']);
  assert.deepEqual(keys, ['A', 'V', 'R', '1']);
  assert.equal(new Set(keys).size, keys.length);
  const resolved = resolveKeytips([{ keys: 'N', label: 'New' }, { keys: '', label: 'Normal' }, { keys: '', label: 'Open' }]);
  assert.deepEqual(resolved.map((e) => e.keys), ['N', 'O', 'P']);
  assert.ok(resolved[1].derived && !resolved[0].derived);
  // Every frame and ribbon menu gets unique KeyTips with the probe's where it has them.
  for (const [id, entries] of Object.entries(SPEC.MENUS)) {
    const items = entries.filter((e) => e.item && !e.sub).map((e) => SPEC.ITEMS[e.item] ?? { label: e.item });
    const r = resolveKeytips(items.map((it) => ({ keys: it.keytip ?? '', label: it.label })));
    const all = r.map((e) => e.keys).filter(Boolean);
    assert.equal(new Set(all).size, all.length, id);
  }
});

// A synthetic tab: [w0, w1, w2, w3] per group (full, medium, small, collapsed).
const G = (id, widths, gallery) => ({ id, widths, ...(gallery && { gallery }) });
const groups = () => [G('a', [200, 150, 120, 60]), G('b', [300, 300, 300, 60], { cols: 6, min: 3, col: 40 }), G('c', [200, 150, 100, 60])];

test('fit: nothing shrinks when everything fits', () => {
  const r = fit(groups(), 700);
  assert.deepEqual(r.levels, { a: 0, b: 0, c: 0 });
  assert.equal(r.cols.b, 6);
  assert.equal(r.overflow, false);
});

test('fit: galleries lose columns before any group shrinks', () => {
  const r = fit(groups(), 650);
  assert.deepEqual(r.levels, { a: 0, b: 0, c: 0 });
  assert.equal(r.cols.b, 4);
  assert.ok(r.total <= 650);
});

test('fit: then the rightmost group shrinks first, one step at a time', () => {
  const r = fit(groups(), 535);
  assert.equal(r.cols.b, 3);
  assert.deepEqual(r.levels, { a: 0, b: 0, c: 1 });
  const r2 = fit(groups(), 440);
  assert.deepEqual(r2.levels, { a: 1, b: 0, c: 2 });
});

test('fit: collapse comes last, from the right; too narrow reports overflow', () => {
  const r = fit(groups(), 380);
  assert.equal(r.levels.c, 3);
  assert.equal(r.levels.a, 2);
  assert.ok(r.total <= 380 && !r.overflow);
  const r2 = fit(groups(), 100);
  assert.deepEqual(r2.levels, { a: 3, b: 3, c: 3 });
  assert.equal(r2.overflow, true);
  const lone = fit([...groups(), { id: 'd', widths: [57, 57, 57, 56], lone: true }], 100);
  assert.equal(lone.levels.d, 0);
});

test('groupAt: runs of large buttons stack as medium rows, then go small; a large button with no large neighbour stays', () => {
  const home = layoutTab(SPEC, 'home');
  const clip = home.groups.find((g) => g.id === 'home.clipboard');
  assert.equal(groupAt(clip, 1).columns[0].kind, 'large'); // Paste
  const at2 = groupAt(clip, 2);
  assert.equal(at2.columns[0].kind, 'large');
  assert.ok(at2.columns.flatMap((c) => (c.kind === 'rows' ? c.rows.flat() : [])).every((it) => it.join || it.size === 'small' || it.control.size === 'small'));
  assert.equal(groupAt(clip, 3).collapsed, true);
  const pages = layoutTab(SPEC, 'insert').groups.find((g) => g.id === 'insert.pages');
  assert.equal(groupAt(pages, 1).columns[0].rows[0][0].size, 'medium');
  const voice = home.groups.find((g) => g.columns.length === 1 && g.columns[0].kind === 'large');
  if (voice) assert.deepEqual(groupAt(voice, 2).columns, voice.columns);
  const insert = layoutTab(SPEC, 'insert').groups.find((g) => g.id === 'insert.illustrations');
  const stacked = groupAt(insert, 1).columns;
  assert.ok(stacked.every((c) => c.kind !== 'rows' || c.rows.length <= 3));
  assert.equal(stacked.reduce((n, c) => n + (c.kind === 'rows' ? c.rows.length : 1), 0), insert.columns.length);
});

test('F6 visits the regions shown, in order, and Shift+F6 goes back', () => {
  const order = regionOrder({ panes: [{ id: 'styles', side: 'right' }, { id: 'navigation', side: 'left' }], statusbar: true, ribbon: true });
  assert.deepEqual(order, ['document', 'pane:navigation', 'pane:styles', 'statusbar', 'ribbon']);
  assert.equal(nextRegion(order, 'document', 1), 'pane:navigation');
  assert.equal(nextRegion(order, 'ribbon', 1), 'document');
  assert.equal(nextRegion(order, 'document', -1), 'ribbon');
  const bare = regionOrder({ ribbon: true });
  assert.deepEqual(bare, ['document', 'ribbon']);
  assert.equal(nextRegion(bare, 'statusbar', 1), 'ribbon', 'a region that went away counts as the document');
});

test('the Quick Access Toolbar menu: toggles keep the order, the defaults are checked', () => {
  const qat = WORD_DEFAULTS.ribbon.qat;
  const checked = QAT_MENU.filter((x) => qat.includes(x.id)).map((x) => x.label);
  assert.deepEqual(checked, ['Save', 'Undo', 'Redo']);
  const withNew = toggleQat(qat, 'file.new');
  assert.deepEqual(withNew, [...qat, 'file.new']);
  assert.deepEqual(toggleQat(withNew, 'frame.qat.undo'), ['frame.qat.save', 'frame.qat.redoRepeat', 'file.new']);
  assert.deepEqual(toggleQat(withNew, 'file.new'), qat);
  assert.deepEqual(moveQat(qat, 'frame.qat.save', 1), ['frame.qat.undo', 'frame.qat.save', 'frame.qat.redoRepeat']);
  assert.deepEqual(moveQat(qat, 'frame.qat.save', -1), qat);
  assert.ok(QAT_MENU.filter((x) => x.needs).every((x) => x.needs === 'cloud'));
});
