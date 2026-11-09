// engine-rename (P7, docs/plans/word/briefs/engine-rename.md): WordCraft's names are gone from the engine's code and the text a
// user sees says EasyWriter. WordCraft stays where its licence and credit need it (engine/ORIGIN.md, the licence files,
// ATTRIBUTION.md), in comments that say where code came from, and where an old value is read back (ALLOWED in the script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED, codeOf, CREDIT, files, leftovers, renamePatch, renameText } from '../scripts/engine-rename.mjs';
import { initSync, Engine, setAppVersion } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { readZip, text } from '../src/document/docx/zip.mjs';

test('the files the engine writes name EasyWriter, with the app\'s version where the format has a field for it', async () => {
  initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
  await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
  setAppVersion('9.8.7');
  const e = new Engine();
  try {
    e.open(new TextEncoder().encode('Hello'), 'txt');
    const dec = (b) => new TextDecoder().decode(b);
    assert.match(dec(e.save('html')), /<meta name="generator" content="EasyWriter 9\.8\.7">/);
    assert.match(dec(e.save('rtf')), /\{\\\*\\generator EasyWriter 9\.8\.7;\}/);
    assert.match(text((await readZip(e.save('odt'))).get('meta.xml')), /<meta:generator>EasyWriter\/9\.8\.7<\/meta:generator>/);
    assert.match(text((await readZip(e.save('docx'))).get('docProps/app.xml')), /<Application>EasyWriter<\/Application>/);
    // The PDF's document information dictionary.
    assert.match(Buffer.from(e.pdf('{}')).toString('latin1'), /\/Creator\(EasyWriter 9\.8\.7\)\/Producer\(EasyWriter 9\.8\.7\)/);
  } finally {
    e.free();
  }
});

test('no WordCraft name or text is left in the engine\'s code', () => {
  const left = leftovers();
  assert.ok(!left.length, `${left.length} lines still say wordcraft. Names: run node scripts/engine-rename.mjs (a branch made before the `
    + 'rename converts its patch, see the script\'s header). Text a user sees says EasyWriter (briefs/engine-rename.md item 3); an old value '
    + 'a reader still takes goes in the script\'s ALLOWED. A comment in engine/ calls the engine EasyWriter; credit to WordCraft '
    + 'takes a form in the script\'s CREDIT.\n' + left.slice(0, 40).map(([f, n, t]) => `${f}:${n}: ${t.slice(0, 140)}`).join('\n'));
});

test('comments are left out of the check, strings are not', () => {
  const code = codeOf('let a = "WordCraft"; // WordCraft did\n/* WordCraft */ let b = \'c\';\nlet l: &\'a str = "x"; // WordCraft', 'rs');
  assert.deepEqual(code.split('\n').map((l) => /WordCraft/.test(l)), [true, false, false]);
  assert.equal(codeOf('name = "x" # WordCraft', 'toml').includes('WordCraft'), false);
});

const MANIFEST = [
  '[package]', 'name = "ew-doc-layout"', '', '[lib]', 'name = "wordcraft_layout"', '', '[lints]', 'workspace = true', '',
  '[dependencies]', 'wordcraft-geom = { workspace = true, features = ["image"] }', 'wordcraft-render = { workspace = true }', '',
];

test('names follow the table: the library is its package\'s name, keys are package names, [lib] name lines go', () => {
  const toml = renameText(MANIFEST.join('\r\n'));
  assert.equal(toml, ['[package]', 'name = "ew-doc-layout"', '', '[lints]', 'workspace = true', '', '[dependencies]',
    'ew-geom = { workspace = true, features = ["image"] }', 'ew-scene = { workspace = true }', ''].join('\r\n'));
  assert.equal(renameText('wordcraft-layout = { package = "ew-doc-layout", path = "crates/doc-layout" }\n'), 'ew-doc-layout = { path = "crates/doc-layout" }\n');
  const rs = [
    'use wordcraft_engine::layout::{DocLayout, Placed};', 'let t: wordcraft_render::Tile = wordcraft_doc::x(wordcraft_docx::y());',
    'fn wordcraft_docx_svg_uri() {}', 'std::env::var("WORDCRAFT_SPEECH")', 'format!(".wordcraft-save-{}.tmp", 1)', 'temp_dir().join("wordcraft-hf960")',
    '//! cargo test -p wordcraft-engine --test it', "const form = 'wordcraft-json'; // WordCraft's JSON",
  ];
  assert.deepEqual(renameText(rs.join('\n')).split('\n'), [
    'use ew_doc_edit::layout::{DocLayout, Placed};', 'let t: ew_scene::Tile = ew_doc::x(ew_docx::y());',
    'fn ew_docx_svg_uri() {}', 'std::env::var("EW_SPEECH")', 'format!(".easywriter-save-{}.tmp", 1)', 'temp_dir().join("easywriter-hf960")',
    '//! cargo test -p ew-doc-edit --test it', "const form = 'wordcraft-json'; // WordCraft's JSON",
  ]);
  for (const text of [MANIFEST.join('\n'), rs.join('\r\n')]) assert.equal(renameText(renameText(text)), renameText(text), 'a second run changes nothing');
});

test('a branch\'s patch from before the rename applies to the renamed tree', () => {
  const lines = (a) => a.map((l) => `${l}\n`).join('');
  const rust = ['use wordcraft_doc::Document;', '', 'fn a() -> wordcraft_layout::Pages {', '    wordcraft_layout::paginate()', '}', ''];
  const patch = lines([
    'diff --git a/crates/doc-layout/Cargo.toml b/crates/doc-layout/Cargo.toml', 'index 1111111..2222222 100644',
    '--- a/crates/doc-layout/Cargo.toml', '+++ b/crates/doc-layout/Cargo.toml', '@@ -3,9 +3,10 @@ name = "ew-doc-layout"',
    '', ' [lib]', ' name = "wordcraft_layout"', ' ', ' [lints]', ' workspace = true', ' ', ' [dependencies]',
    '+wordcraft-docx = { workspace = true }', ' wordcraft-geom = { workspace = true, features = ["image"] }',
    'diff --git a/crates/doc-layout/src/a.rs b/crates/doc-layout/src/a.rs', 'index 3333333..4444444 100644',
    '--- a/crates/doc-layout/src/a.rs', '+++ b/crates/doc-layout/src/a.rs', '@@ -2,4 +2,5 @@ use wordcraft_doc::Document;',
    ' ', ' fn a() -> wordcraft_layout::Pages {', '-    wordcraft_layout::paginate()', '+    let d = wordcraft_docx::read();', '+    wordcraft_layout::paginate_doc(&d)', ' }',
  ]);
  const renamed = renamePatch(patch);
  assert.equal(renamePatch(renamed), renamed, 'a second run changes nothing');
  assert.ok(renamed.includes('@@ -3,6 +3,7 @@ name = "ew-doc-layout"\n \n [lints]') && !renamed.includes('wordcraft'), renamed);
  // The renamed tree, as the rename leaves it, takes the patch.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easywriter-rename-'));
  try {
    fs.mkdirSync(path.join(dir, 'crates/doc-layout/src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'crates/doc-layout/Cargo.toml'), renameText(lines(MANIFEST.slice(0, -1))));
    fs.writeFileSync(path.join(dir, 'crates/doc-layout/src/a.rs'), renameText(lines(rust.slice(0, -1))));
    fs.writeFileSync(path.join(dir, 'p.patch'), renamed);
    execFileSync('git', ['apply', 'p.patch'], { cwd: dir, stdio: 'pipe' });
    // git apply writes this machine's line ends (core.autocrlf).
    const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8').replaceAll('\r\n', '\n');
    assert.equal(read('crates/doc-layout/src/a.rs'),
      lines(['use ew_doc::Document;', '', 'fn a() -> ew_doc_layout::Pages {', '    let d = ew_docx::read();', '    ew_doc_layout::paginate_doc(&d)', '}']));
    assert.match(read('crates/doc-layout/Cargo.toml'), /\[dependencies\]\new-docx = \{ workspace = true \}\new-geom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('in engine/ a comment that calls the engine WordCraft is left over, one that credits WordCraft is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easywriter-rename-'));
  try {
    fs.mkdirSync(path.join(dir, 'engine'));
    fs.mkdirSync(path.join(dir, 'other'));
    const rs = '/// Not a package part: WordCraft\'s own bookkeeping.\n//! The editing session adapted from WordCraft.\nfn a() {}\n';
    fs.writeFileSync(path.join(dir, 'engine', 'a.rs'), rs);
    fs.writeFileSync(path.join(dir, 'other', 'a.rs'), rs);
    assert.deepEqual(leftovers(dir, ['engine', 'other']).map(([f, n]) => `${f}:${n}`), ['engine/a.rs:1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// engine-fixes-3: the engine's own JavaScript (src/engine) and the canvas draft's host (src/document/canvas) call the engine
// EasyWriter's in their comments too, as engine/ does. Credit and old stored values stay (CREDIT and ALLOWED), and so does
// form.mjs's note on the keys version 8 renamed. The DOM editor's files are not checked.
const COMMENTED = ['src/engine', 'src/document/canvas'];
const NOTES = [['src/engine/model/form.mjs', /`wordcraft:`/g]];

test('comments in src/engine and src/document/canvas call the engine EasyWriter\'s, not WordCraft\'s', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const left = [];
  for (const rel of COMMENTED.flatMap((d) => files(root, d))) {
    const kept = [...ALLOWED, ...NOTES].filter(([f]) => !f || f === rel).map(([, re]) => re);
    let text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const re of [...kept, ...CREDIT]) text = text.replace(re, (m) => ' '.repeat(m.length));
    text.split(/\r?\n/).forEach((l, i) => /wordcraft/i.test(l) && left.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`));
  }
  assert.deepEqual(left, [], 'say the engine (EasyWriter\'s) here; credit to WordCraft takes a form in scripts/engine-rename.mjs CREDIT');
});
