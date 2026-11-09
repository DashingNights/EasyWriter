// The integrator's copy of a package's harness files into the integration worktree (docs/plans/word/workflows/wf-build.js,
// mergeBatch). Only files git does not track there are copied: a tracked case came with the merge, and copying the package
// worktree's copy over it (LF where this checkout wrote CRLF, core.autocrlf) left git status showing it modified with an
// empty diff after every merge.
//   node scripts/copy-harness.mjs <from worktree> <to worktree> <path...>   (a path ending in * takes every file it starts)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from './agent-guards.mjs';

/** Copies `paths` (relative, / or \) from checkout `from` to `to` → [{path, done: 'copied' | 'tracked' | 'missing' | 'folder'}]. */
export function copyHarness(from, to, paths) {
  const files = paths.flatMap((p) => {
    const rel = p.replaceAll('\\', '/');
    if (!rel.endsWith('*')) return [rel];
    const dir = path.posix.dirname(rel);
    const start = path.posix.basename(rel).slice(0, -1);
    const abs = path.join(from, dir);
    return fs.existsSync(abs) ? fs.readdirSync(abs).filter((f) => f.startsWith(start)).map((f) => `${dir}/${f}`) : [];
  });
  const tracked = new Set((git(to, ['ls-files', '--', ...files]) ?? '').split('\n').filter(Boolean));
  return files.map((rel) => {
    const src = path.join(from, rel);
    if (!fs.existsSync(src)) return { path: rel, done: 'missing' };
    if (fs.statSync(src).isDirectory()) return { path: rel, done: 'folder' }; // a profile folder (.smoke-data/w-*) never moves
    if (tracked.has(rel)) return { path: rel, done: 'tracked' };
    fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(to, rel));
    return { path: rel, done: 'copied' };
  });
}

const SAY = { copied: 'copied', tracked: 'left as the merge brought it (git tracks it)', missing: 'not in the package worktree', folder: 'a folder, not copied' };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [from, to, ...paths] = process.argv.slice(2);
  if (!from || !to || !paths.length) {
    console.error('usage: node scripts/copy-harness.mjs <from worktree> <to worktree> <path...>');
    process.exit(2);
  }
  for (const r of copyHarness(from, to, paths)) console.log(`${r.path}: ${SAY[r.done]}`);
}
