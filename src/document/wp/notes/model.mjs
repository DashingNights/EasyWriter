// Footnotes and endnotes, the pure part (docs/plans/word/plan.md §1.8 noteRef and footnotePr, briefs/notes.md): Word's note
// properties with their defaults, the numbering of every note in document order, where endnotes collect, how a page's note
// area splits when it does not fit, and Convert. No DOM and no app import, so node tests load it.
import { numberText } from '../../fields/numfmt.mjs';
import { sectionAt, sectionsOf } from '../../model/sections.mjs';

export const KINDS = ['footnote', 'endnote'];

/** Word's note properties when neither the document nor the section sets them (observed in Word 16.0.20527: footnotes at the
 * bottom of the page numbered 1, 2, 3; endnotes at the end of the document numbered i, ii, iii; both from 1, continuous). */
export const NOTE_DEFAULTS = Object.freeze({
  footnote: Object.freeze({ pos: 'pageBottom', numFmt: 'decimal', numStart: 1, numRestart: 'continuous', columns: 0, sep: null }),
  endnote: Object.freeze({ pos: 'docEnd', numFmt: 'lowerRoman', numStart: 1, numRestart: 'continuous', columns: 0, sep: null }),
});

/** The dialog's Number format items in Word's order (the Double byte and East Asian items are left out). */
export const NUM_FORMATS = [['decimal', '1, 2, 3, …'], ['lowerLetter', 'a, b, c, …'], ['upperLetter', 'A, B, C, …'], ['lowerRoman', 'i, ii, iii, …'],
  ['upperRoman', 'I, II, III, …'], ['chicago', '*, †, ‡, §, …']];
export const MAX_START = 16383;

/** The style ids a kind's note text and reference use. */
export const STYLE_IDS = {
  footnote: { text: 'FootnoteText', ref: 'FootnoteReference' },
  endnote: { text: 'EndnoteText', ref: 'EndnoteReference' },
};

// Word's built-in note styles: 10 pt text, single spacing, nothing after; the references superscript.
const text = (name) => ({ type: 'paragraph', name, basedOn: 'Normal', uiPriority: 99, semiHidden: true, unhideWhenUsed: true,
  para: { spacing: { after: 0, line: { rule: 'auto', value: 1 } } }, run: { size: 10 } });
const ref = (name) => ({ type: 'character', name, uiPriority: 99, semiHidden: true, unhideWhenUsed: true, run: { superscript: true } });
/** The four note styles, brought into a document on first insert through ensureStyles. */
export const NOTE_STYLES = {
  FootnoteText: text('footnote text'), FootnoteReference: ref('footnote reference'),
  EndnoteText: text('endnote text'), EndnoteReference: ref('endnote reference'),
};

const CHICAGO = ['*', '†', '‡', '§'];

/** Note number `n` (from 1) in `fmt`: the list formats through numberText, and Word's symbol series, which repeats each symbol
 * once more after every fourth note (*, †, ‡, §, **, ††...). */
export function noteNumber(n, fmt) {
  if (fmt === 'chicago') return CHICAGO[(n - 1) % 4].repeat(Math.ceil(n / 4));
  return numberText(n, fmt);
}

const set = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) : {});

/** The note properties of `kind` that hold in a section: its sect's footnotePr or endnotePr over the document's settings over the
 * defaults, key by key. Restart each page is for footnotes only. */
export function effectivePr(kind, settings, sect) {
  const key = `${kind}Pr`;
  const pr = { ...NOTE_DEFAULTS[kind], ...set(settings?.[key]), ...set(sect?.[key]) };
  if (kind === 'endnote' && pr.numRestart === 'eachPage') pr.numRestart = 'continuous';
  return pr;
}

/** Labels for `list` ([{kind, mark, section, page}] in document order) → string[]: each kind counts on its own from numStart,
 * starting again where its section's numRestart says (a new section, a new page). A custom mark is drawn instead of a number and
 * takes none from the sequence. `prOf(kind, section)` gives the section's effective properties. */
export function numberNotes(list, prOf) {
  const at = {};
  return list.map((note) => {
    const pr = prOf(note.kind, note.section);
    const last = at[note.kind];
    const restart = !last || (pr.numRestart === 'eachSect' && note.section !== last.section) || (pr.numRestart === 'eachPage' && note.page !== last.page);
    const cur = { n: restart ? pr.numStart : last.n, section: note.section, page: note.page };
    at[note.kind] = cur;
    if (note.mark) return note.mark;
    return noteNumber(cur.n++, pr.numFmt);
  });
}

const blockNotes = new WeakMap();
const docNotes = new WeakMap();

/** Every noteRef of `doc` in document order → [{pos, node}]. Unchanged top-level blocks keep their scan (ProseMirror shares them
 * between versions), so a keypress rescans one block. */
export function notesOf(doc) {
  let out = docNotes.get(doc);
  if (out) return out;
  out = [];
  doc.forEach((block, offset) => {
    let rel = blockNotes.get(block);
    if (!rel) {
      rel = [];
      block.descendants((n, p) => {
        if (n.type.name === 'noteRef') rel.push({ at: p + 1, node: n });
        return !n.isLeaf;
      });
      blockNotes.set(block, rel);
    }
    for (const r of rel) out.push({ pos: offset + r.at, node: r.node });
  });
  docNotes.set(doc, out);
  return out;
}

/** A note id not in `used` (a Set of ids), which then holds it. */
export function freshId(used) {
  let n = used.size + 1;
  while (used.has(String(n))) n++;
  used.add(String(n));
  return String(n);
}

/** The noteRefs of `doc` that repeat an id another note holds (a pasted or dropped copy of a reference) → [{pos, node, id}], each
 * with a fresh id. Of the notes sharing an id, the one at `keep(id)` (where the note that held it before now is) keeps it, else
 * the first. Everything looks a note up by its id, so two with one id would edit and hide each other. */
export function repeatedIds(doc, keep = () => null) {
  const byId = new Map();
  for (const n of notesOf(doc)) {
    const list = byId.get(n.node.attrs.id);
    if (list) list.push(n);
    else byId.set(n.node.attrs.id, [n]);
  }
  if (byId.size === notesOf(doc).length) return [];
  const used = new Set(byId.keys());
  const out = [];
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    const at = keep(id);
    const owner = list.find((n) => n.pos === at) ?? list[0];
    for (const n of list) if (n !== owner) out.push({ pos: n.pos, node: n.node, id: freshId(used) });
  }
  return out;
}

/** Whether a section of `doc` holding footnotes restarts them on each page (the labels then need each reference's page). */
export function sectionsUseEachPage(doc) {
  if (!notesOf(doc).some((n) => n.node.attrs.kind === 'footnote')) return false;
  return sectionsOf(doc).some((s) => effectivePr('footnote', doc.attrs.settings, s.sect).numRestart === 'eachPage');
}

/** Each noteRef's label in `doc` → Map(pos → {kind, label, section}). `pageOf(pos)` gives a reference's page; it is asked only
 * when a section restarts its footnotes on each page. */
export function labelsOf(doc, pageOf = () => 0) {
  const notes = notesOf(doc);
  const sections = sectionsOf(doc);
  const settings = doc.attrs.settings;
  const prs = new Map();
  const prOf = (kind, i) => {
    const k = `${kind}${i}`;
    if (!prs.has(k)) prs.set(k, effectivePr(kind, settings, sections[i]?.sect));
    return prs.get(k);
  };
  const list = notes.map(({ pos, node }) => {
    const { kind, mark } = node.attrs;
    const section = sectionAt(sections, pos).index;
    const page = kind === 'footnote' && prOf(kind, section).numRestart === 'eachPage' ? pageOf(pos) : 0;
    return { kind, mark, section, page };
  });
  const labels = numberNotes(list, prOf);
  return new Map(notes.map(({ pos }, i) => [pos, { kind: list[i].kind, label: labels[i], section: list[i].section }]));
}

/** Where the endnotes of `doc` are drawn → [{pos, notes: [{pos, node}]}]: one group at the end of the document, or with End of
 * section one at the end of each section that has endnotes, where a section with noEndnote passes its endnotes on to the next.
 * `pos` is the position the group follows: its section's break, or the end of the document. */
export function endnoteGroups(doc) {
  const ends = notesOf(doc).filter((n) => n.node.attrs.kind === 'endnote');
  if (!ends.length) return [];
  const atEnd = { pos: doc.content.size, notes: ends };
  if (effectivePr('endnote', doc.attrs.settings, null).pos !== 'sectEnd') return [atEnd];
  const sections = sectionsOf(doc);
  const groups = [];
  let held = [];
  for (const s of sections) {
    held.push(...ends.filter((n) => n.pos >= s.from && n.pos < s.to));
    if (!held.length || (s.sect.noEndnote && s.holder != null)) continue;
    groups.push({ pos: s.holder ?? doc.content.size, notes: held });
    held = [];
  }
  return groups;
}

/** Splits note areas over pages. `pages` [{room, notes: [{id, h, lines, room?}]}] in page order: room is the px the page's area may
 * take, notes its own notes (h px; lines the line bottoms from the note's top, ascending, or a function giving them, asked only when
 * the note is cut; room, when given, the px below the note's reference, which the area up to and including that note must fit in). A note that does not fit is cut at its last line that does, and the rest continues at the top of the next page,
 * before that page's own notes. A page's own note keeps at least its first line there, as Word keeps a note on its reference's
 * page. → per page {parts: [{id, from, to}] (px of the note shown), cont (it starts with a continued note), notice (it ends cut),
 * height}. The last page takes whatever is left. */
export function splitAreas(pages) {
  let carry = [];
  return pages.map((p, i) => {
    const queue = [...carry, ...p.notes.map((n) => ({ ...n, from: 0, own: true }))];
    const cont = carry.length > 0;
    carry = [];
    let used = 0;
    const parts = [];
    let notice = false;
    const last = i === pages.length - 1;
    for (let k = 0; k < queue.length; k++) {
      const n = queue[k];
      const room = Math.min(p.room, n.own ? n.room ?? Infinity : Infinity) - used;
      if (last || n.h - n.from <= room + 0.5) {
        parts.push({ id: n.id, from: n.from, to: n.h });
        used += n.h - n.from;
        continue;
      }
      const lines = (typeof n.lines === 'function' ? n.lines() : n.lines) ?? [n.h];
      const fit = lines.filter((b) => b > n.from + 0.5 && b - n.from <= room + 0.5).at(-1);
      const to = fit ?? (n.own ? lines.find((b) => b > n.from + 0.5) ?? n.h : null);
      if (to != null) {
        parts.push({ id: n.id, from: n.from, to });
        if (to < n.h - 0.5) {
          notice = true;
          carry.push({ ...n, from: to, own: false, lines });
        }
      } else carry.push(n);
      // ponytail: notes after a cut move on whole, even a page's own; engine 2 settles their references through pageGuard.
      carry.push(...queue.slice(k + 1).map((m) => ({ ...m, own: false })));
      break;
    }
    return { parts, cont, notice, height: parts.reduce((a, x) => a + x.to - x.from, 0) };
  });
}

/** The kind a note of `kind` becomes under Convert `mode` ('toEndnotes', 'toFootnotes' or 'swap'). */
export function convertKind(kind, mode) {
  if (mode === 'toEndnotes') return 'endnote';
  if (mode === 'toFootnotes') return 'footnote';
  if (mode === 'swap') return kind === 'footnote' ? 'endnote' : 'footnote';
  return kind;
}

/** Note text `content` (block JSON) moved to `kind`: paragraphs in the other kind's note text style take this kind's, as Word's
 * Convert does. → the same array when nothing changes. */
export function convertContent(content, kind) {
  const from = STYLE_IDS[kind === 'footnote' ? 'endnote' : 'footnote'].text;
  const to = STYLE_IDS[kind].text;
  const walk = (n) => {
    let out = n;
    if (n.attrs?.styleId === from) out = { ...n, attrs: { ...n.attrs, styleId: to } };
    if (Array.isArray(n.content)) {
      const kids = n.content.map(walk);
      if (kids.some((c, i) => c !== n.content[i])) out = { ...out, content: kids };
    }
    return out;
  };
  const next = (content ?? []).map(walk);
  return next.some((c, i) => c !== content[i]) ? next : content;
}

/** Which notes `mode` changes in `doc` → [{pos, node, kind}] with the kind each takes. */
export function convertPlan(doc, mode) {
  return notesOf(doc).map(({ pos, node }) => ({ pos, node, kind: convertKind(node.attrs.kind, mode) })).filter((c) => c.kind !== c.node.attrs.kind);
}
