// Charts in Word files (docs/plans/word/left-out.md package 4): what a chart keeps of its .docx so export writes it back unchanged.
// Import reads the chart part into the chart node's model and copies the part with every part its relationships reach inside the
// package (the embedded workbook, Word's chart style and colour parts, a drawing of shapes on the chart), each byte for byte as
// base64 with its content type, into the node's `parts`. Export writes them back under their own names; a name already written
// (the same chart pasted twice, charts from two files) moves to a free one, and only then are the relationship parts rewritten.
// Pure: the XML reader comes from the caller.
import { chartModel } from './model.mjs';
import { base64, bytesOf } from '../../tooling/base64.mjs';

const RT_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const RT_CHARTEX = 'http://schemas.microsoft.com/office/2014/relationships/chartEx';
const URI = { c: 'http://schemas.openxmlformats.org/drawingml/2006/chart', cx: 'http://schemas.microsoft.com/office/drawing/2014/chartex' };
// The folders a chart's parts may take in an export: never the document's own parts or its pictures (word/media).
const NAME = /^word\/(charts|embeddings|drawings)\/(_rels\/)?[\w. -]+$/;

const dec = new TextDecoder();
const kids = (n, name) => (n?.kids ?? []).filter((k) => typeof k === 'object' && (!name || k.name === name));
const at = (n, a) => n?.attrs?.[a] ?? null;
const resolve = (from, target) => {
  if (target.startsWith('/')) return target.slice(1);
  const out = from.split('/').slice(0, -1);
  for (const seg of target.split('/')) (seg === '..' ? out.pop() : seg !== '.' && out.push(seg));
  return out.join('/');
};
/** The relationships part of part `name`. */
export const relsName = (name) => name.replace(/([^/]+)$/, '_rels/$1.rels');

/**
 * The chart whose part is `path` in package `files` (Map name → bytes), drawn under `theme` → {model, parts} or null when the part
 * is missing. `parse` is import.mjs's parseXml. parts: {kind: 'c' | 'cx', main: path, list: [{name, type (content type, null for
 * a relationships part), data (base64)}]}.
 */
export function chartOf(files, path, parse, theme) {
  const bytes = files.get(path);
  const root = bytes && parse(dec.decode(bytes));
  if (!root) return null;
  const ct = parse(dec.decode(files.get('[Content_Types].xml') ?? new Uint8Array()));
  const typeOf = (name) => at(kids(ct, 'Override').find((o) => at(o, 'PartName')?.replace(/^\//, '').toLowerCase() === name.toLowerCase()), 'ContentType')
    ?? at(kids(ct, 'Default').find((d) => at(d, 'Extension')?.toLowerCase() === name.split('.').pop().toLowerCase()), 'ContentType');
  const list = [];
  const seen = new Set();
  const take = (name) => {
    if (seen.has(name) || !files.has(name)) return;
    seen.add(name);
    list.push({ name, type: typeOf(name), data: base64(files.get(name)) });
    const rels = relsName(name);
    if (!files.has(rels)) return;
    list.push({ name: rels, type: null, data: base64(files.get(rels)) });
    for (const r of kids(parse(dec.decode(files.get(rels))), 'Relationship')) if (at(r, 'TargetMode') !== 'External' && at(r, 'Target')) take(resolve(name, at(r, 'Target')));
  };
  take(path);
  return { model: chartModel(root, theme), parts: { kind: root.name === 'cx:chartSpace' ? 'cx' : 'c', main: path, list } };
}

/**
 * Writes chart `parts` (chartOf's) into an export: `taken(name)` says whether a part name is in use, `put(name, bytes, type)` stores
 * a part → {target: the main part's name, rel: its relationship type, graphic(rid): the a:graphic that shows it} or null when
 * the parts are not a chart's (a pasted node with no parts, or names outside a chart's folders).
 */
export function writeChart(parts, taken, put) {
  const list = parts?.list ?? [];
  const own = list.filter((p) => p.type != null || !p.name.endsWith('.rels'));
  if (!own.some((p) => p.name === parts.main) || !list.every((p) => NAME.test(p.name) && !p.name.split('/').some((s) => s === '.' || s === '..'))) return null;
  // New names for the parts whose name is in use: chart1.xml becomes chart1_2.xml, and so on.
  const moved = new Map();
  const used = (n) => taken(n) || list.some((p) => p.name === n) || [...moved.values()].includes(n);
  for (const p of own) {
    if (!taken(p.name)) continue;
    let k = 2;
    const at2 = (i) => p.name.replace(/(\.[^./]*)?$/, (ext) => `_${i}${ext}`);
    while (used(at2(k))) k++;
    moved.set(p.name, at2(k));
  }
  const nameOf = (n) => moved.get(n) ?? n;
  const enc = new TextEncoder();
  for (const p of list) {
    const isRels = p.type == null && p.name.endsWith('.rels');
    const source = isRels ? p.name.replace(/_rels\/([^/]+)\.rels$/, '$1') : null;
    let bytes = bytesOf(p.data);
    // A moved part's relationships follow it, and point at the moved parts they reach.
    if (isRels && moved.size) {
      bytes = enc.encode(dec.decode(bytes).replace(/(\sTarget=")([^"]*)"/g, (all, pre, target) => {
        const to = moved.get(resolve(source, target));
        return to ? `${pre}${target.replace(/[^/]*$/, to.split('/').pop())}"` : all;
      }));
    }
    put(isRels ? relsName(nameOf(source)) : nameOf(p.name), bytes, isRels ? null : p.type);
  }
  const kind = parts.kind === 'cx' ? 'cx' : 'c';
  return {
    target: nameOf(parts.main),
    rel: kind === 'cx' ? RT_CHARTEX : RT_CHART,
    graphic: (rid) => `<a:graphic><a:graphicData uri="${URI[kind]}"><${kind}:chart xmlns:${kind}="${URI[kind]}" r:id="${rid}"/></a:graphicData></a:graphic>`,
  };
}
