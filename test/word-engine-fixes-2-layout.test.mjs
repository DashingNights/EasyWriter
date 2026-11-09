// engine-fixes-2-layout (docs/plans/word/briefs/engine-fixes-2-layout.md): wave E's layout loose ends that npm test checks.
// The layout and editing items are tested natively (engine/: cargo test -p ew-doc-layout fixes_2_layout, cargo test -p
// ew-doc-edit fixes_2_layout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storedForm } from '../scripts/schema-fields.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Item 5: a freeform's Edit Points paths are stored, so a change to their fields, keys or point types must change the field
// list agent-guards compares (scripts/schema-fields.mjs). Their JSON was written by hand, which the list could not read.
test('the stored form\'s field list holds the Edit Points paths, their points and point types', () => {
  const list = storedForm(root);
  for (const line of ['EditPath.nodes Vec<EditNode>', 'EditPath.closed bool', 'EditNode rename_all=camelCase', 'EditNode.at [f32; 2]',
    'EditNode.c_in Option<[f32; 2]>', 'EditNode.kind NodeKind', 'NodeKind rename_all=lowercase', 'NodeKind::Smooth']) {
    assert.ok(list.includes(line), `${line} is in the field list: ${list.filter((l) => /Edit|NodeKind/.test(l)).join(' | ')}`);
  }
});
