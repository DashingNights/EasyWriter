// The Cross-reference dialog's data (probe/dialogs/cross-reference.json; docs/plans/word/briefs/fields-ref.md): the reference
// types, what each can insert, the items "For which" lists, and the field code an insert writes. Pure.
import { kindOf, listLabels } from '../../numbering.mjs';
import { parseField } from '../../fields/registry.mjs';
import { isHidden, listedBookmarks, textOf } from './bookmarks.mjs';

/** Reference types in the probe's order: [id, label]. */
export const TYPES = [['numbered', 'Numbered item'], ['heading', 'Heading'], ['bookmark', 'Bookmark'], ['footnote', 'Footnote'],
  ['endnote', 'Endnote'], ['Equation', 'Equation'], ['Figure', 'Figure'], ['Table', 'Table']];
const CAPTION = new Set(['Equation', 'Figure', 'Table']);
const NUMBERS = [['number', 'Paragraph number'], ['numberNoContext', 'Paragraph number (no context)'], ['numberFull', 'Paragraph number (full context)']];

/** What type `type` can insert: [id, label] in Word's order (the probe's for Numbered item). */
export function insertKinds(type) {
  if (type === 'numbered') return [['page', 'Page number'], ...NUMBERS, ['text', 'Paragraph text'], ['position', 'Above/below']];
  if (type === 'heading') {
    return [['text', 'Heading text'], ['page', 'Page number'], ['number', 'Heading number'], ['numberNoContext', 'Heading number (no context)'],
      ['numberFull', 'Heading number (full context)'], ['position', 'Above/below']];
  }
  if (type === 'bookmark') return [['text', 'Bookmark text'], ['page', 'Page number'], ...NUMBERS, ['position', 'Above/below']];
  if (type === 'footnote' || type === 'endnote') {
    const noun = type === 'footnote' ? 'Footnote' : 'Endnote';
    return [['note', `${noun} number`], ['page', 'Page number'], ['position', 'Above/below'], ['noteFormatted', `${noun} number (formatted)`]];
  }
  return [['text', 'Entire caption'], ['labelNumber', 'Only label and number'], ['captionText', 'Only caption text'], ['page', 'Page number'],
    ['position', 'Above/below']];
}

/** The "For which" label of type `type`: For which numbered item: and so on. */
export const forWhichLabel = (type) => `For &which ${{ numbered: 'numbered item', heading: 'heading', bookmark: 'bookmark', footnote: 'footnote',
  endnote: 'endnote' }[type] ?? 'caption'}:`;

const trimmed = (s) => s.replace(/\s+/g, ' ').trim();

/** The items of type `type` in `doc`: [{id, label, from, to, name?}] where from..to is the range a hidden _Ref bookmark wraps
 * (a bookmark item names its own bookmark instead). Captions also give `labelTo` (the end of label and number) and `textFrom`. */
export function targetsOf(doc, type) {
  const out = [];
  if (type === 'bookmark') {
    for (const b of listedBookmarks(doc, { sort: 'name' })) out.push({ id: b.name, label: b.name, name: b.name, from: b.from, to: b.to });
    return out;
  }
  if (type === 'footnote' || type === 'endnote') {
    let n = 0;
    doc.descendants((node, pos) => {
      if (node.type.name !== 'noteRef') return true;
      if ((node.attrs.kind === 'endnote' ? 'endnote' : 'footnote') !== type) return false;
      n++;
      const first = (node.attrs.content ?? []).map((b) => (b.content ?? []).map((c) => c.text ?? '').join('')).join(' ');
      out.push({ id: String(pos), label: trimmed(`${node.attrs.mark ?? n} ${first}`), from: pos, to: pos + node.nodeSize });
      return false;
    });
    return out;
  }
  const paras = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    paras.push({ node, pos });
    return false;
  });
  if (type === 'numbered') {
    const numbered = paras.filter((p) => p.node.attrs.numbering && kindOf(doc.attrs.numbering, p.node.attrs.numbering.numId) === 'number');
    const labels = listLabels(numbered.map((p) => p.node.attrs.numbering), doc.attrs.numbering);
    numbered.forEach((p, i) => out.push({ id: String(p.pos), label: trimmed(`${labels[i] ?? ''} ${p.node.textContent}`), from: p.pos + 1, to: p.pos + p.node.nodeSize - 1 }));
    return out;
  }
  if (type === 'heading') {
    for (const p of paras) {
      if (p.node.type.name !== 'heading' || !p.node.textContent.trim()) continue;
      out.push({ id: String(p.pos), label: `${'  '.repeat(p.node.attrs.level - 1)}${trimmed(p.node.textContent)}`, from: p.pos + 1, to: p.pos + p.node.nodeSize - 1 });
    }
    return out;
  }
  if (CAPTION.has(type)) {
    for (const p of paras) {
      let seq = null;
      p.node.forEach((child, offset) => {
        if (seq || child.type.name !== 'field') return;
        const f = parseField(child.attrs.code);
        if (f.name === 'SEQ' && f.args[0]?.toLowerCase() === type.toLowerCase()) seq = p.pos + 1 + offset;
      });
      if (seq == null) continue;
      const from = p.pos + 1;
      const to = p.pos + p.node.nodeSize - 1;
      const after = textOf(doc, seq + 1, to);
      const skip = /^[\s:.\-–—]*/.exec(after)[0].length;
      out.push({ id: String(p.pos), label: trimmed(textOf(doc, from, to)), from, to, labelTo: seq + 1, textFrom: Math.min(to, seq + 1 + skip) });
    }
  }
  return out;
}

/** The range the hidden bookmark of a reference to `item` with `kind` wraps → {from, to}. */
export function rangeFor(item, kind) {
  if (kind === 'labelNumber' && item.labelTo != null) return { from: item.from, to: item.labelTo };
  if (kind === 'captionText' && item.textFrom != null) return { from: item.textFrom, to: item.to };
  return { from: item.from, to: item.to };
}

/** A hidden _Ref bookmark already around `from`..`to` (bookmarks from bookmarksOf) → its name, or null. Bookmark markers at either
 * edge do not count, so a second reference to a heading reuses the _Ref the first one put around its text. */
export function refAround(bookmarks, { from, to }) {
  const marks = new Set(bookmarks.flatMap((b) => [b.start, b.end]));
  const trim = (a, z) => {
    while (a < z && marks.has(a)) a++;
    while (z > a && marks.has(z - 1)) z--;
    return `${a}:${z}`;
  };
  const want = trim(from, to);
  return bookmarks.find((b) => isHidden(b.name) && /^_Ref/i.test(b.name) && b.end != null && trim(b.from, b.to) === want)?.name ?? null;
}

/** The field code a cross-reference inserts: REF, PAGEREF or NOTEREF to bookmark `name` with Word's switches. */
export function refCode(kind, name, { hyperlink = true, aboveBelow = false, separator = null } = {}) {
  const h = hyperlink ? ' \\h' : '';
  const p = aboveBelow && kind !== 'position' ? ' \\p' : '';
  switch (kind) {
    case 'page': return `PAGEREF ${name}${h}${p}`;
    case 'note': return `NOTEREF ${name}${h}${p}`;
    case 'noteFormatted': return `NOTEREF ${name} \\f${h}${p}`;
    case 'number': return `REF ${name} \\r${h}${p}`;
    case 'numberNoContext': return `REF ${name} \\n${h}${p}`;
    case 'numberFull': return `REF ${name} \\w${h}${separator != null ? ` \\d "${separator.replace(/(["\\])/g, '\\$1')}"` : ''}${p}`;
    case 'position': return `REF ${name} \\p${h}`;
    default: return `REF ${name}${h}${p}`;
  }
}
