// Schema v2 nodes (docs/plans/word/plan.md §1.8 Nodes): fields, bookmarks, notes, section and column breaks, columns, text
// boxes, equations, content controls, ruby and positional tabs. Definition, parse, render and Markdown only: each owner package
// adds its commands, node view and layout. The inline atoms take every mark, so tracked insertions and deletions can hold them.
// Stories inside attributes (noteRef.content, sect.hdr and ftr, doc.attrs.comments) are block JSON the kit schema validates.
import { Node } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { deepPatch, readJson, SECTION_KINDS } from '../../office.mjs';
import { specs, style } from './attrs.js';

/** Attribute specs that read each key of `defaults` from the element's data-json; the node's renderHTML writes data-json. */
const jsonFields = (defaults) => Object.fromEntries(Object.entries(defaults).map(([k, def]) => [k, {
  default: def,
  parseHTML: (el) => readJson(el.getAttribute('data-json'))?.[k] ?? def,
  renderHTML: () => ({}),
}]));
// Every attribute but the ones that render themselves (rev) or never leave the editor (suggest).
const dataJson = (attrs) => {
  const { rev, suggest, ...rest } = attrs;
  return JSON.stringify(rest);
};

// Notes are numbered in document order in Markdown; the doc's renderMarkdown (schema.js) restarts the count per serialisation.
let noteCount = 0;
/** Restarts the Markdown note numbers (one serialisation of a doc or of a run of its blocks). */
export const resetNoteCount = () => { noteCount = 0; };

// ---------- fields ----------
/** A field (w:fldSimple, or a complex field within one paragraph): code, its last result (null: never updated, drawn as
 * { code }), locked, dirty, the legacy form field options ff, and runs (null, or the result split by its runs' formatting:
 * [{text, marks}], fields-core runs.mjs). fields-core updates results. */
const Field = Node.create({
  name: 'field',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    ...specs({ ff: { data: 'data-ff', kind: 'json' }, runs: { data: 'data-runs', kind: 'json' } }),
    code: { default: '', parseHTML: (el) => el.getAttribute('data-code') ?? '', renderHTML: ({ code }) => ({ 'data-code': code }) },
    locked: { default: false, parseHTML: (el) => el.getAttribute('data-locked') === 'true', renderHTML: ({ locked }) => (locked ? { 'data-locked': 'true' } : {}) },
    dirty: { default: false, parseHTML: (el) => el.getAttribute('data-dirty') === 'true', renderHTML: ({ dirty }) => (dirty ? { 'data-dirty': 'true' } : {}) },
    result: {
      default: null,
      parseHTML: (el) => (el.hasAttribute('data-no-result') ? null : el.textContent),
      renderHTML: ({ result }) => (result == null ? { 'data-no-result': '' } : {}),
    },
  }),
  parseHTML: () => [{ tag: 'span[data-field]', priority: 60 }],
  renderHTML: ({ node, HTMLAttributes }) => ['span', { 'data-field': '', ...HTMLAttributes }, node.attrs.result ?? ''],
  renderMarkdown: (node) => node.attrs?.result ?? '',
});

/** A field whose result spans paragraphs (TOC, INDEX, TOA, BIBLIOGRAPHY): a plain block around its result's blocks. */
const FieldBlock = Node.create({
  name: 'fieldBlock',
  group: 'block',
  content: 'block+',
  addAttributes: () => ({
    code: { default: '', parseHTML: (el) => el.getAttribute('data-code') ?? '', renderHTML: ({ code }) => ({ 'data-code': code }) },
    locked: { default: false, parseHTML: (el) => el.getAttribute('data-locked') === 'true', renderHTML: ({ locked }) => (locked ? { 'data-locked': 'true' } : {}) },
    dirty: { default: false, parseHTML: (el) => el.getAttribute('data-dirty') === 'true', renderHTML: ({ dirty }) => (dirty ? { 'data-dirty': 'true' } : {}) },
  }),
  parseHTML: () => [{ tag: 'div[data-field-block]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-field-block': '', ...HTMLAttributes }, 0],
  renderMarkdown: (node, h) => h.renderChildren(node, '\n\n'),
});

/** A bookmark's start or end (w:bookmarkStart, w:bookmarkEnd): a zero-width marker fields-ref finds by name. */
const Bookmark = Node.create({
  name: 'bookmark',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({
    name: { default: '', parseHTML: (el) => el.getAttribute('data-name') ?? '', renderHTML: ({ name }) => ({ 'data-name': name }) },
    id: { default: '', parseHTML: (el) => el.getAttribute('data-id') ?? '', renderHTML: ({ id }) => ({ 'data-id': id }) },
    end: { default: false, parseHTML: (el) => el.getAttribute('data-end') === 'true', renderHTML: ({ end }) => (end ? { 'data-end': 'true' } : {}) },
  }),
  parseHTML: () => [{ tag: 'span[data-bookmark]', priority: 60 }],
  renderHTML: ({ HTMLAttributes }) => ['span', { 'data-bookmark': '', ...HTMLAttributes }],
});

/** A footnote or endnote reference: its note's text is block JSON in content, mark a custom mark (null: the automatic number,
 * which the notes node view draws). */
const NoteRef = Node.create({
  name: 'noteRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    kind: { default: 'footnote', parseHTML: (el) => (el.getAttribute('data-kind') === 'endnote' ? 'endnote' : 'footnote'), renderHTML: ({ kind }) => ({ 'data-kind': kind }) },
    id: { default: '', parseHTML: (el) => el.getAttribute('data-id') ?? '', renderHTML: ({ id }) => ({ 'data-id': id }) },
    content: { default: [{ type: 'paragraph' }], parseHTML: (el) => readJson(el.getAttribute('data-content')) ?? [{ type: 'paragraph' }],
      renderHTML: ({ content }) => ({ 'data-content': JSON.stringify(content) }) },
    mark: { default: null, parseHTML: (el) => el.getAttribute('data-mark'), renderHTML: ({ mark }) => (mark ? { 'data-mark': mark } : {}) },
  }),
  // Above Superscript's sup rule, so a note stays a note.
  parseHTML: () => [{ tag: 'sup[data-note]', priority: 60 }],
  renderHTML: ({ node, HTMLAttributes }) => ['sup', { 'data-note': '', ...HTMLAttributes }, node.attrs.mark ?? '*'],
  renderMarkdown: (node) => `[^${node.attrs?.mark ?? ++noteCount}]`,
});

// ---------- sections and columns ----------
const KIND_LABEL = { nextPage: 'next page', continuous: 'continuous', evenPage: 'even page', oddPage: 'odd page', nextColumn: 'next column' };

/** Every section break of `doc` in document order as [node, pos] (blocks only: never inside a paragraph). */
const breaksOf = (doc, type) => {
  const out = [];
  doc.descendants((n, pos) => {
    if (n.type === type) out.push([n, pos]);
    return !n.isTextblock && !n.isAtom;
  });
  return out;
};

/** A section break: it ends a section and holds that section's sect (Word keeps w:sectPr in the section's last paragraph);
 * doc.attrs.sect is the last section's. kind is how the next section starts. A break that arrives without a sect (pasted from
 * Word, written by an agent) takes a copy of the following section's in the same transaction. */
const SectionBreak = Node.create({
  name: 'sectionBreak',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes: () => ({
    kind: { default: 'nextPage', parseHTML: (el) => (SECTION_KINDS.includes(el.getAttribute('data-kind')) ? el.getAttribute('data-kind') : 'nextPage'),
      renderHTML: ({ kind }) => ({ 'data-kind': kind }) },
    sect: { default: null, parseHTML: (el) => readJson(el.getAttribute('data-sect')), renderHTML: ({ sect }) => (sect ? { 'data-sect': JSON.stringify(sect) } : {}) },
  }),
  // Word's clipboard writes a section break as a <br> with mso-break-type:section-break (and page-break-before for a new
  // page); above the page break's br rule (60).
  parseHTML: () => [{ tag: 'div[data-section-break]' }, {
    tag: 'br',
    priority: 61,
    getAttrs: (el) => (/mso-break-type:\s*section-break/i.test(el.getAttribute('style') ?? '')
      ? { kind: /page-break-before:\s*always/i.test(el.getAttribute('style')) ? 'nextPage' : 'continuous' } : false),
  }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-section-break': '', ...HTMLAttributes }],
  renderMarkdown: (node) => `<!-- section break (${KIND_LABEL[node.attrs?.kind] ?? 'next page'}) -->`,
  addCommands() {
    return {
      // Merges `patch` into a section's sect (plan.md §1.8: unknown keys survive): `section` is its index, by default the
      // selection's. The sect is its break's, or doc.attrs.sect for the last section.
      setSectionProps: (patch, { section } = {}) => ({ tr, dispatch }) => {
        const breaks = breaksOf(tr.doc, this.type);
        const i = section ?? breaks.filter(([, pos]) => pos < tr.selection.from).length;
        if (!Number.isInteger(i) || i < 0 || i > breaks.length) return false;
        if (dispatch) {
          if (i < breaks.length) tr.setNodeAttribute(breaks[i][1], 'sect', deepPatch(breaks[i][0].attrs.sect ?? {}, patch));
          else tr.setDocAttribute('sect', deepPatch(tr.doc.attrs.sect ?? {}, patch));
        }
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const type = this.type;
    return [new Plugin({
      key: new PluginKey('sectionBreakSect'),
      appendTransaction: (trs, _, state) => {
        if (!trs.some((tr) => tr.docChanged)) return null;
        const breaks = breaksOf(state.doc, type);
        if (breaks.every(([n]) => n.attrs.sect)) return null;
        const tr = state.tr;
        let next = state.doc.attrs.sect;
        for (const [n, pos] of breaks.reverse()) {
          if (!n.attrs.sect && next) tr.setNodeAttribute(pos, 'sect', structuredClone(next));
          next = n.attrs.sect ?? next;
        }
        return tr.docChanged ? tr : null;
      },
    })];
  },
});

/** A column break (w:br w:type="column"). */
const ColumnBreak = Node.create({
  name: 'columnBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div[data-column-break]' }, {
    tag: 'br',
    priority: 61,
    getAttrs: (el) => (/(?:mso-)?column-break-before:\s*always|break-before:\s*column/i.test(el.getAttribute('style') ?? '') ? {} : false),
  }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-column-break': '', style: 'break-after: column', ...HTMLAttributes }],
  renderMarkdown: () => '<!-- column break -->',
});

/** Newspaper columns around blocks (w:cols in the sectPr of the continuous section around them): count, space between (pt),
 * a line between, equal widths, or widths [{w, space}]. Holds any block but section breaks and columns: canvases and plan
 * charts are kit nodes (src/editors.js), so the kit names them in the `objects` option (documentExtensions) and a schema
 * without them still builds. Widening it keeps every draft stored before loadable. */
const Columns = Node.create({
  name: 'columns',
  group: 'block',
  addOptions: () => ({ objects: [] }),
  content() {
    return `(${['paragraph', 'heading', 'table', 'pageBreak', 'columnBreak', 'textBox', 'fieldBlock', 'sdtBlock', ...this.options.objects].join(' | ')})+`;
  },
  addAttributes: () => ({
    count: { default: 2, parseHTML: (el) => +el.getAttribute('data-count') || 2,
      renderHTML: ({ count }) => ({ 'data-count': String(count), style: `column-count: ${count}` }) },
    space: { default: 36, parseHTML: (el) => (el.hasAttribute('data-space') ? +el.getAttribute('data-space') : 36),
      renderHTML: ({ space }) => ({ 'data-space': String(space), style: `column-gap: ${space}pt` }) },
    sep: { default: false, parseHTML: (el) => el.getAttribute('data-sep') === 'true',
      renderHTML: ({ sep }) => (sep ? { 'data-sep': 'true', style: 'column-rule: 0.75pt solid currentColor' } : {}) },
    equal: { default: true, parseHTML: (el) => el.getAttribute('data-equal') !== 'false', renderHTML: ({ equal }) => (equal ? {} : { 'data-equal': 'false' }) },
    widths: { default: null, parseHTML: (el) => readJson(el.getAttribute('data-widths')), renderHTML: ({ widths }) => (widths ? { 'data-widths': JSON.stringify(widths) } : {}) },
  }),
  parseHTML: () => [{ tag: 'div[data-columns]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-columns': '', ...HTMLAttributes }, 0],
  renderMarkdown: (node, h) => h.renderChildren(node, '\n\n'),
});

// ---------- objects ----------
export const TEXTBOX_DEFAULTS = {
  layout: { wrap: 'front', h: { rel: 'column', offset: 0 }, v: { rel: 'paragraph', offset: 0 } },
  w: 144, h: 72, autoFit: false, inset: { t: 3.6, r: 7.2, b: 3.6, l: 7.2 }, vAlign: 'top', dir: 'lrTb', fill: '#FFFFFF',
  line: { color: '#000000', width: 0.75, dash: 'solid' }, effects: null, style: null, link: null, name: null, id: '', rotate: 0, alt: '',
  decorative: false, noWrap: false, upright: false, overflow: null,
  // A .docx gradient fill {kind, angle, stops [{pos, color}], color, scaled, path, focus, tile, flip} (docx/dml.mjs gradientOf):
  // while fill is still its middle colour `color` the box draws it and export writes it back; a fill the user picks replaces it.
  gradient: null,
  // What a .docx gives that no tool edits, written back as it came (docx/dml.mjs boxLook): the theme links of the box's colours
  // (Design > Colors re-resolves them), its wps:style references, and the line and fill Word keeps hidden behind No Outline and
  // No Fill.
  themeColors: null, styleRefs: null, hidden: null,
};
const JUSTIFY = { center: 'center', bottom: 'flex-end' };

/** A text box (wps:wsp with w:txbxContent): blocks in a sized box; float-layout positions it by layout, textbox edits it.
 * overflow is bodyPr vertOverflow: 'overflow' shows the text past the box, anything else clips it. The static form (header and
 * footer layer, clipboard) draws what the node view draws but direction and effects: Align Text and the overflow. */
const TextBox = Node.create({
  name: 'textBox',
  group: 'block',
  content: 'block+',
  isolating: true,
  selectable: true,
  addAttributes: () => jsonFields(TEXTBOX_DEFAULTS),
  parseHTML: () => [{ tag: 'div[data-textbox]' }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const a = node.attrs;
    const { t, r, b, l } = a.inset ?? {};
    return ['div', { 'data-textbox': '', 'data-dir': a.dir, 'data-json': dataJson(a), ...HTMLAttributes, style: style({
      display: 'flex', 'flex-direction': 'column', 'justify-content': JUSTIFY[a.vAlign],
      width: `${a.w}pt`, [a.autoFit ? 'min-height' : 'height']: `${a.h}pt`, padding: `${t ?? 0}pt ${r ?? 0}pt ${b ?? 0}pt ${l ?? 0}pt`,
      background: typeof a.fill === 'string' ? a.fill : null, border: a.line ? `${a.line.width}pt ${a.line.dash === 'solid' ? 'solid' : 'dashed'} ${a.line.color}` : null,
      transform: a.rotate ? `rotate(${a.rotate}deg)` : null, overflow: a.overflow === 'overflow' ? 'visible' : null,
    }) }, ['div', { 'data-textbox-text': '' }, 0]];
  },
  renderMarkdown: (node, h) => h.renderChildren(node, '\n\n'),
});

// MathML kept from a paste is cleaned on the way in and again when drawn: only MathML elements and their presentation
// attributes, so a pasted page cannot bring scripts, handlers or links in through an equation.
const MATH_TAG = /^(math|semantics|annotation|annotation-xml|m[a-z]+)$/;
const MATH_NS = 'http://www.w3.org/1998/Math/MathML';
function cleanMath(src, doc) {
  const name = src.localName;
  if (!MATH_TAG.test(name)) return null;
  const out = doc.createElementNS(MATH_NS, name);
  for (const { name: a, value } of src.attributes) if (/^[a-z][a-z-]*$/.test(a) && !/^on|href|src|style/.test(a)) out.setAttribute(a, value);
  for (const c of src.childNodes) {
    if (c.nodeType === 3) out.append(c.data);
    else if (c.nodeType === 1) {
      const k = cleanMath(c, doc);
      if (k) out.append(k);
    }
  }
  return out;
}
/** The cleaned MathML element of markup `mml` in `doc`, or null. A template's content is inert, so nothing runs while it parses. */
function mathOf(mml, doc) {
  const t = doc.createElement('template');
  t.innerHTML = mml;
  const m = t.content.querySelector('math');
  return m && cleanMath(m, doc);
}

/** An equation (m:oMath, or m:oMathPara when display): math in UnicodeMath linear form, mml the cached MathML equations draws. */
const Equation = Node.create({
  name: 'equation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    math: { default: '', parseHTML: (el) => el.getAttribute('data-math') ?? el.getAttribute('alttext') ?? el.textContent.trim(), renderHTML: ({ math }) => ({ 'data-math': math }) },
    display: { default: false, parseHTML: (el) => el.getAttribute('data-display') === 'true' || el.getAttribute('display') === 'block',
      renderHTML: ({ display }) => (display ? { 'data-display': 'true' } : {}) },
    align: { default: 'center', parseHTML: (el) => el.getAttribute('data-align') ?? 'center', renderHTML: ({ align }) => (align === 'center' ? {} : { 'data-align': align }) },
    mml: { default: null, parseHTML: (el) => {
      const m = el.localName === 'math' ? el : el.querySelector('math');
      return m ? cleanMath(m, el.ownerDocument)?.outerHTML ?? null : null;
    }, renderHTML: () => ({}) },
    linear: { default: false, parseHTML: (el) => el.getAttribute('data-linear') === 'true', renderHTML: ({ linear }) => (linear ? { 'data-linear': 'true' } : {}) },
    // A .docx equation's own m:oMath XML {xml, math, linear}: docx export writes it back while math and linear are still these.
    omml: { default: null, rendered: false, parseHTML: () => null },
  }),
  parseHTML: () => [{ tag: 'span[data-equation]', priority: 60 }, { tag: 'math' }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const m = node.attrs.mml && !node.attrs.linear && typeof document !== 'undefined' && mathOf(node.attrs.mml, document);
    return ['span', { 'data-equation': '', ...HTMLAttributes }, m || node.attrs.math];
  },
  renderMarkdown: (node) => (node.attrs?.display ? `$$${node.attrs.math}$$` : `$${node.attrs?.math ?? ''}$`),
});

/** A content control's properties (w:sdtPr), the sdt attribute of sdtInline and sdtBlock; a missing key has this value. */
export const SDT_DEFAULTS = {
  id: '', tag: null, title: null, type: 'richText', lock: 'none', placeholder: null, showingPlaceholder: false, appearance: 'boundingBox',
  color: null, style: null, items: [], date: null, repeat: null, checked: false, checkedChar: '☒', uncheckedChar: '☐', multiLine: false,
  temporary: false, binding: null, docPart: null,
};
const sdtAttr = { sdt: { default: null, parseHTML: (el) => readJson(el.getAttribute('data-json')), renderHTML: ({ sdt }) => (sdt ? { 'data-json': JSON.stringify(sdt) } : {}) } };

/** A content control inside a paragraph (w:sdt in w:p). */
const SdtInline = Node.create({
  name: 'sdtInline',
  group: 'inline',
  inline: true,
  content: 'inline*',
  addAttributes: () => sdtAttr,
  parseHTML: () => [{ tag: 'span[data-sdt]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', { 'data-sdt': '', ...HTMLAttributes }, 0],
  renderMarkdown: (node, h) => h.renderChildren(node),
});

/** A content control around blocks (w:sdt in w:body): a plain block. */
const SdtBlock = Node.create({
  name: 'sdtBlock',
  group: 'block',
  content: 'block+',
  addAttributes: () => sdtAttr,
  parseHTML: () => [{ tag: 'div[data-sdt]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-sdt': '', ...HTMLAttributes }, 0],
  renderMarkdown: (node, h) => h.renderChildren(node, '\n\n'),
});

/** A phonetic guide (w:ruby): base text with its reading above. */
const Ruby = Node.create({
  name: 'ruby',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({
    base: { default: '', parseHTML: (el) => [...el.childNodes].filter((c) => !/^(rt|rp)$/i.test(c.nodeName)).map((c) => c.textContent).join(''), renderHTML: () => ({}) },
    text: { default: '', parseHTML: (el) => el.querySelector('rt')?.textContent ?? '', renderHTML: () => ({}) },
    // lang: the guide's language (w:lid); hint: its runs' font hint (w:rFonts w:hint), kept for Word.
    ...specs({ size: { data: 'data-size', kind: 'num' }, offset: { data: 'data-offset', kind: 'num' }, font: { data: 'data-font', kind: 'str' },
      lang: { data: 'data-lang', kind: 'str' }, hint: { data: 'data-font-hint', kind: 'str' } }),
    align: { default: 'distributeSpace', parseHTML: (el) => el.getAttribute('data-align') ?? 'distributeSpace', renderHTML: ({ align }) => ({ 'data-align': align }) },
  }),
  parseHTML: () => [{ tag: 'ruby' }],
  renderHTML: ({ node, HTMLAttributes }) => ['ruby', HTMLAttributes, node.attrs.base, ['rt', node.attrs.text]],
  renderMarkdown: (node) => node.attrs?.base ?? '',
});

/** A positional tab (w:ptab): aligned to the margin or indent; tabs lays out its width. A click puts the cursor beside it, as on a
 * tab character, never selects it. */
const Ptab = Node.create({
  name: 'ptab',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({
    align: { default: 'center', parseHTML: (el) => el.getAttribute('data-align') ?? 'center', renderHTML: ({ align }) => ({ 'data-align': align }) },
    relativeTo: { default: 'margin', parseHTML: (el) => el.getAttribute('data-relative-to') ?? 'margin', renderHTML: ({ relativeTo }) => ({ 'data-relative-to': relativeTo }) },
    leader: { default: 'none', parseHTML: (el) => el.getAttribute('data-leader') ?? 'none', renderHTML: ({ leader }) => ({ 'data-leader': leader }) },
  }),
  parseHTML: () => [{ tag: 'span[data-ptab]', priority: 60 }],
  renderHTML: ({ HTMLAttributes }) => ['span', { 'data-ptab': '', ...HTMLAttributes }, '\t'],
  renderMarkdown: () => '\t',
});

export const NODES_V2 = [Field, FieldBlock, Bookmark, NoteRef, SectionBreak, ColumnBreak, Columns, TextBox, Equation, SdtInline, SdtBlock, Ruby, Ptab];
