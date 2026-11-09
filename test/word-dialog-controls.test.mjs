// ui-sweep-6 (docs/plans/word/briefs/ui-sweep-6.md): every WordDialog's text boxes, lists and text areas use the kit's
// controls, so a raw input, select or textarea cannot come back. Hidden and ranged inputs are not form controls here.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../src/document', import.meta.url));

/** The raw controls that stay: the caption box beside its prefix, and the mailing list's tiny column filter. */
const ALLOW = [
  ['toc/dialogs.jsx', 'id="cap-text"'],
  ['mailings/Lists.jsx', 'aria-label={`Filter ${f}`}'],
];

/** Every .jsx under src/document, as paths relative to it. */
function jsxFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) jsxFiles(full, out);
    else if (name.endsWith('.jsx')) out.push(path.relative(ROOT, full).replaceAll('\\', '/'));
  }
  return out;
}

test('WordDialog files hold no raw input, select or textarea', () => {
  const bad = [];
  for (const file of jsxFiles(ROOT)) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
    if (!lines.some((line) => line.includes('<WordDialog'))) continue;
    lines.forEach((line, i) => {
      if (!/<(input|select|textarea)\b/.test(line)) return;
      const next = lines[i + 1] ?? '';
      if (/sr-only|type="range"/.test(`${line} ${next}`)) return;
      if (ALLOW.some(([name, text]) => file.includes(name) && line.includes(text))) return;
      bad.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, [], `raw controls in WordDialog files:\n${bad.join('\n')}`);
});
