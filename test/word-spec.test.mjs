import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as L from 'lucide-react';
import { defs, bindTools } from '../src/app/commands/tool.mjs';
import * as S from '../src/document/ribbon/spec.mjs';
import { buildSpec, iconNames, iconsSource, lintText, ownersOf, PLAN_DIR, readJson, specSource } from '../scripts/word-spec.mjs';
import { SAME_MENU_GAPS, SHARED_GALLERIES } from '../scripts/word-spec-data.mjs';

// The ribbon spec (docs/plans/word/plan.md §1.4, §1.14): well formed, every reference resolves, the copy rules hold. The checks
// that read the planning folder (gitignored) skip where it is missing.

const HAVE_PLAN = fs.existsSync(path.join(PLAN_DIR, 'index.json'));
const ICONS_JSX = fs.readFileSync(new URL('../src/document/ribbon/icons.jsx', import.meta.url), 'utf8');
const MENU_TYPES = ['dropdown', 'split', 'splitToggle', 'list', 'gallery'];
const layoutIds = (g) => g.layout.flatMap((c) => [c.large, c.gallery, ...(c.rows ?? []).flat(2)]).filter(Boolean);

test('ids are unique and each entry carries its key', () => {
  for (const [k, c] of Object.entries(S.CONTROLS)) assert.equal(c.id, k);
  for (const [k, i] of Object.entries(S.ITEMS)) assert.equal(i.id, k);
  for (const id of Object.keys(S.ITEMS)) assert.ok(!S.CONTROLS[id], `${id} is a control and an item`);
  const tabs = S.TABS.map((t) => t.id);
  assert.equal(new Set(tabs).size, tabs.length);
  const groups = S.TABS.flatMap((t) => t.groups.map((g) => g.id));
  assert.equal(new Set(groups).size, groups.length);
  const placed = S.TABS.flatMap((t) => t.groups.flatMap((g) => [...layoutIds(g), g.launcher].filter(Boolean)));
  assert.equal(new Set(placed).size, placed.length, 'a control placed twice');
});

test('every layout id is a control and every control is placed', () => {
  const placed = new Set([...S.QAT, ...S.TITLE, ...S.TAB_ROW]);
  for (const t of S.TABS) {
    assert.ok(t.context === null || S.CONTEXTS[t.context], `${t.id} context ${t.context}`);
    for (const g of t.groups) {
      for (const id of layoutIds(g)) {
        assert.ok(S.CONTROLS[id], `${g.id} names ${id}`);
        placed.add(id);
      }
      for (const c of g.layout) if (c.gallery) assert.equal(S.CONTROLS[c.gallery].type, 'gallery', c.gallery);
      if (g.launcher) {
        assert.ok(S.CONTROLS[g.launcher], g.launcher);
        placed.add(g.launcher);
      }
    }
  }
  for (const id of Object.keys(S.CONTROLS)) assert.ok(placed.has(id), `${id} is in no group`);
});

test('every menu entry resolves and no menu control has an empty menu', () => {
  for (const [key, entries] of Object.entries(S.MENUS)) {
    assert.ok(entries.length, `${key} is empty`);
    for (const e of entries) {
      if ('item' in e) assert.ok(S.ITEMS[e.item], `${key}: item ${e.item}`);
      if ('sub' in e) assert.ok(S.MENUS[e.sub]?.length, `${key}: submenu ${e.sub}`);
      const kinds = ['item', 'label', 'sep', 'gallery', 'panel'].filter((k) => k in e);
      assert.ok(kinds.length >= 1, `${key}: ${JSON.stringify(e)}`);
    }
  }
  for (const c of Object.values(S.CONTROLS)) {
    if (c.menu) assert.ok(S.MENUS[c.menu]?.length, `${c.id} menu ${c.menu}`);
    if (MENU_TYPES.includes(c.type)) assert.ok(c.menu, `${c.id} (${c.type}) has no menu`);
    if (c.cmd) assert.ok(S.CONTROLS[c.cmd] || S.ITEMS[c.cmd], `${c.id} runs ${c.cmd}`);
    if (c.type === 'spinner' && c.parts) assert.match(c.parts.more, /\.more$/);
  }
  for (const it of Object.values(S.ITEMS)) if (it.cmd) assert.ok(S.CONTROLS[it.cmd] || S.ITEMS[it.cmd], `${it.id} runs ${it.cmd}`);
});

test('no gallery id sits in two menus unless the data marks it shared; every building block gallery is in a menu', () => {
  const where = new Map();
  for (const [key, entries] of Object.entries(S.MENUS)) for (const e of entries) if (e.gallery) where.set(e.gallery, [...(where.get(e.gallery) ?? []), key]);
  for (const [g, keys] of where) if (keys.length > 1) assert.ok(SHARED_GALLERIES.includes(g), `${g} in ${keys.join(', ')}`);
  for (const [name, id] of Object.entries(S.BLOCK_GALLERIES)) assert.ok(where.has(id), `${name}: ${id}`);
});

test('every icon is a lucide-react export or an own icon, and icons.jsx imports exactly the lucide ones', () => {
  const own = new Set([...ICONS_JSX.slice(ICONS_JSX.indexOf('export const OWN')).matchAll(/^\s+(\w+): (?:border|cell|svg)\(/gm)].map((m) => m[1]));
  const own2 = [...ICONS_JSX.matchAll(/\b(\w+): (?:border|cell)\(/g)].map((m) => m[1]);
  for (const n of own2) own.add(n);
  for (const x of [...Object.values(S.CONTROLS), ...Object.values(S.ITEMS)]) {
    if (!x.icon) continue;
    if (x.icon.startsWith('own:')) assert.ok(own.has(x.icon.slice(4)) || ICONS_JSX.includes(`${x.icon.slice(4)}:`), `${x.id}: ${x.icon}`);
    else assert.ok(L[x.icon], `${x.id}: ${x.icon} is not a lucide-react icon`);
  }
  assert.equal(iconsSource(ICONS_JSX, iconNames(S)), ICONS_JSX, 'icons.jsx is out of date: run node scripts/word-spec.mjs');
});

test('the copy lint passes on every label and tip', () => {
  const texts = [...S.TABS.flatMap((t) => [t.label, ...t.groups.map((g) => g.label)])];
  for (const c of Object.values(S.CONTROLS)) texts.push(c.label);
  for (const i of Object.values(S.ITEMS)) texts.push(i.label);
  for (const b of S.BACKSTAGE) texts.push(b.label);
  for (const f of Object.values(S.FEATURES)) texts.push(f.label);
  for (const t of texts) assert.deepEqual(lintText(t), [], t);
  for (const c of Object.values(S.CONTROLS)) if (c.tip) assert.deepEqual(lintText(c.tip, true), [], `${c.id}: ${c.tip}`);
  assert.deepEqual(lintText('Font name box: theme fonts first.', true), ['colon pivot']);
  assert.deepEqual(lintText('Opens Word Options.'), ['names Word']);
  assert.deepEqual(lintText('Word Count'), []);
  assert.ok(lintText('Saves it — now.').includes('dash'));
  assert.ok(lintText('As Review > Protect.', true).includes('cross-reference'));
});

test('renamed labels keep Word\'s as wordLabel', () => {
  const clip = S.CONTROLS['home.clipboard.launcher'];
  assert.deepEqual([clip.label, clip.wordLabel], ['Clipboard', 'Office Clipboard']);
  assert.equal(S.CONTROLS['insert.illustrations.smartArt'].label, 'Diagram');
  assert.equal(S.ITEMS['insert.tables.table.excelSpreadsheet'].label, 'Spreadsheet');
});

test('derived items: list items run their control with the last id segment, hand items have their ids', () => {
  const b = S.ITEMS['home.paragraph.borders.bottomBorder'];
  assert.deepEqual([b.cmd, b.arg, b.derived], ['home.paragraph.borders', 'bottomBorder', true]);
  for (const id of ['insert.text.quickParts.autoText.saveSelectionToAutoTextGallery', 'insert.tables.table.quickTables.saveSelectionToQuickTablesGallery',
    'layout.pageSetup.margins.lastCustomSetting']) assert.ok(S.ITEMS[id]?.derived, id);
  assert.equal(S.MENUS['layout.pageSetup.margins'][0].item, 'layout.pageSetup.margins.lastCustomSetting');
  const toc = S.MENUS['references.tableOfContents.tableOfContents'];
  assert.ok(toc.findIndex((e) => e.gallery) > toc.findIndex((e) => e.item?.endsWith('manualTable')), 'saved blocks follow the built-ins');
  assert.deepEqual(S.MENUS['frame.qat.undo'], [{ panel: 'frame.qat.undo' }]);
  assert.ok(!JSON.stringify(S.MENUS).includes('High-contrast'));
  assert.ok(!S.MENUS['shapeFormat.shapeStyles.shapeOutline'].some((e) => e.label === 'Gallery Filters'), 'no heading left over the dropped filter row');
});

test('same controls run the canonical command with its menu; spinners carry parts and units', () => {
  const c = S.CONTROLS['textBox.size.launcher'];
  assert.equal(c.cmd, 'pictureFormat.size.launcher');
  assert.equal(S.CONTROLS['pictureFormat.arrange.position'].menu, 'layout.arrange.position');
  assert.equal(S.CONTROLS['graphicsFormat.arrangeSize.crop'].menu, 'pictureFormat.size.crop', 'Graphics Format > Crop takes the Picture Format crop menu');
  assert.ok(!S.MENUS['graphicsFormat.arrangeSize.crop']);
  const s = S.CONTROLS['layout.paragraph.spacingBefore'];
  assert.deepEqual([s.type, s.unit, s.parts.less], ['spinner', 'pt', 'layout.paragraph.spacingBefore.less']);
  assert.equal(S.TABS.find((t) => t.id === 'layout').groups.find((g) => g.id === 'layout.paragraph').layout[0].caption, 'Indent');
  assert.ok(S.TABS.find((t) => t.id === 'insert').groups.some((g) => g.id === 'insert.boards' && g.extra));
  assert.equal(S.CONTROLS['review.markup.displayForReview'].type, 'list');
});

test('every spec feature under a placeholder prefix carries that reason', { skip: !HAVE_PLAN && 'no planning folder' }, () => {
  const ownerOf = ownersOf(readJson(path.join(PLAN_DIR, 'plan.json')));
  let n = 0;
  for (const x of [...Object.values(S.CONTROLS), ...Object.values(S.ITEMS), ...S.BACKSTAGE]) {
    const o = ownerOf(x.id);
    if (o?.startsWith('placeholder:')) {
      assert.equal(x.needs, o.slice(12), x.id);
      n++;
    }
  }
  assert.ok(n > 50, `${n} placeholders`);
});

test('the canonical menu holds every item of each same control\'s probe menu', { skip: !HAVE_PLAN && 'no planning folder' }, () => {
  const require = createRequire(import.meta.url);
  const { ribbon } = require(path.join(PLAN_DIR, 'probe/scripts/ribbon-ids.js'));
  const { tabs, menus } = ribbon();
  const fileOf = new Map(tabs.flatMap((t) => t.groups.flatMap((g) => g.controls.map((c) => [`${t.tab}.${g.id}.${c.id}`, c.menuFile]))));
  // Menu items only: a gallery's list items follow the object's theme (SmartArt shape styles show other colours).
  const labels = (file) => (menus[file]?.items ?? []).filter((i) => i.kind === 'menuitem').map((i) => i.name);
  let n = 0;
  for (const c of Object.values(S.CONTROLS)) {
    const mine = fileOf.get(c.id);
    const theirs = c.cmd && fileOf.get(c.cmd);
    if (!mine || !theirs) continue;
    // The canonical menu offers every item the repeat had (Shape Format's Shape Fill adds Pattern to the diagram one's).
    const missing = labels(mine).filter((l) => !labels(theirs).includes(l) && !SAME_MENU_GAPS[c.id]?.includes(l));
    assert.deepEqual(missing, [], `${c.id} vs ${c.cmd}`);
    n++;
  }
  assert.ok(n > 20, `${n} compared`);
});

test('spec.mjs is what the generator writes from the planning folder', { skip: !HAVE_PLAN && 'no planning folder' }, () => {
  const r = buildSpec(PLAN_DIR);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.lint, []);
  assert.equal(specSource(r.spec), fs.readFileSync(new URL('../src/document/ribbon/spec.mjs', import.meta.url), 'utf8'), 'run node scripts/word-spec.mjs');
});

test('tool.list leaves the Word entries out for agents, so a Document\'s list stays within 20 of main\'s', () => {
  const main = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, label: `T${i}`, group: 'Text', when: () => true, ...(i % 7 === 0 && { headless: false }) }));
  const word = Array.from({ length: 1100 }, (_, i) => ({ id: `w-${i}`, label: `W${i}`, group: 'Home', when: () => true, headless: false, agent: false }));
  bindTools({ context: () => ({}), all: () => [...main, ...word], failedNeeds: () => [], command: () => null });
  const list = defs.find((d) => d.id === 'tool.list');
  const agent = list.run({ source: 'agent:test', board: null }, {});
  const person = list.run({ source: 'palette', board: null }, {});
  assert.ok(Math.abs(agent.length - main.length) <= 20, `${agent.length} vs ${main.length}`);
  assert.ok(!agent.some((t) => t.id.startsWith('w-')));
  assert.equal(person.length, main.length + word.length);
});
