// The Document's schema, schema v2 (docs/plans/document.md dataModel, editorAndUi; docs/plans/word/plan.md §1.8): Word's run
// and paragraph properties on TipTap's nodes and marks, and v2's nodes (model/nodes.js), marks (model/marks.js) and attributes
// (model/attrs.js). Lengths are points, colours '#RRGGBB'. Imports no app DOM module, so Node tests can getSchema it;
// src/editors.js adds the shared app blocks and the keys. Direct formatting renders as inline style (so text copied into Word
// keeps it), style definitions come from the stylesheet plugin (stylesheet.js). Version 2 (formats.mjs DOCUMENT): every change
// is additive, and once the schema freezes at the Word-parity merge any change bumps the version again
// (test/document-schema.test.mjs pins the names).
import { Extension, isNodeActive, mergeAttributes, Node } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Image } from '@tiptap/extension-image';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Underline } from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { deepPatch, fontStack, growSize, HIGHLIGHTS, INDENT_STEP, isPlain, shrinkSize, size1, UNDERLINES } from '../office.mjs';
import { docMarkdown, Lists, textblocks } from './lists.js';
import './fields/engine.js'; // the field engine rides with the Document schema until fields-core wires its node view
import { Pagination } from './pagination.js';
import { cssHex, cssPt, ModelAttrs, mso, round2, RUN_ATTRS_V2, style, UNDERLINE_CSS } from './model/attrs.js';
import { MARKS_V2 } from './model/marks.js';
import { NODES_V2, resetNoteCount } from './model/nodes.js';
import { styleIdOf } from './model/styles.mjs';
import { resolved, StyleSheet } from './stylesheet.js';
import { DocTableView, mergeSlots } from './table-view.js';
import { Chart } from './chart/node.js';
import { whenNear } from './lazy.mjs';
import { stripRuns, without } from './wp/fields-core/runs.mjs';
import { splitTable, tableOf } from './wp/table-tools/ops.js';

export { cssHex, cssPt };

export const MIN_COLUMN = 20; // px, as the forum editor's (extensions.js); table widths stay px (docs/plans/document.md Units)

const NAMED_SIZES = { 'xx-small': 6.75, 'x-small': 7.5, small: 9.75, medium: 12, large: 13.5, 'x-large': 18, 'xx-large': 24 };
const WORD_THEME = { text1: 'dk1', background1: 'lt1', text2: 'dk2', background2: 'lt2', hyperlink: 'hlink', followedhyperlink: 'folHlink' };
const HIGHLIGHT_BY_HEX = Object.fromEntries(Object.entries(HIGHLIGHTS).map(([n, h]) => [h, n]));
const highlightName = (v) => Object.keys(HIGHLIGHTS).find((n) => n.toLowerCase() === String(v).toLowerCase()) ?? null;

// ---------- doc ----------
/** The doc node with the document-level data (docs/plans/document.md Document-level data; plan.md §1.8 Doc attrs): sect,
 * styles, numbering and theme, and v2's settings, props, vars, comments, people, background and merge (defaults.mjs writes
 * them for a new Document), changed only with tr.setDocAttribute, so undo, history and autosave carry them. Its Markdown writes
 * list paragraphs as Markdown lists (lists.js) and numbers notes from 1. */
export const DOC_ATTRS = ['sect', 'styles', 'numbering', 'theme', 'settings', 'props', 'vars', 'comments', 'people', 'background', 'merge'];
const DocNode = Document.extend({
  addAttributes() {
    return Object.fromEntries(DOC_ATTRS.map((k) => [k, { default: null, rendered: false }]));
  },
  renderMarkdown: (node, h) => {
    resetNoteCount();
    return docMarkdown(node, h);
  },
});

// ---------- paragraph properties ----------
// Word's paragraph style classes on clipboard HTML (MsoNormal and the headings need nothing).
const MSO_STYLE = { MsoTitle: 'Title', MsoSubtitle: 'Subtitle', MsoQuote: 'Quote', MsoIntenseQuote: 'IntenseQuote', MsoNoSpacing: 'NoSpacing',
  MsoListParagraph: 'ListParagraph' };
const msoStyle = (el) => [...el.classList].map((c) => MSO_STYLE[c.replace(/CxSp\w+$/i, '')]).find(Boolean) ?? null;

function parseSpacing(el) {
  const before = cssPt(el.style.marginTop);
  const after = cssPt(el.style.marginBottom);
  const lh = el.style.lineHeight;
  let line = null;
  if (/^[\d.]+$/.test(lh)) line = { rule: 'auto', value: +lh };
  else if (/%$/.test(lh)) line = { rule: 'auto', value: round2(parseFloat(lh) / 100) };
  else if (cssPt(lh) != null) line = { rule: mso(el, 'mso-line-height-rule') === 'exactly' ? 'exact' : 'atLeast', value: cssPt(lh) };
  if (before == null && after == null && !line) return null;
  return { ...(before != null && { before }), ...(after != null && { after }), ...(line && { line }) };
}

function parseIndent(el) {
  const out = { left: cssPt(el.style.marginLeft), right: cssPt(el.style.marginRight), firstLine: cssPt(el.style.textIndent) };
  for (const k of Object.keys(out)) if (!out[k]) delete out[k]; // 0 is no indent
  return Object.keys(out).length ? out : null;
}

/** The run and paragraph properties paragraph or heading `node` of Document `doc` shows: docDefaults, then its style (a
 * heading's implied HeadingN) with its basedOn chain, then its own attributes. The ribbon shows these where the text has no
 * direct formatting; grow, shrink and indent step from them. */
export function effectiveProps(doc, node) {
  const { defaults = {}, list = {} } = doc.attrs.styles ?? {};
  const own = node.attrs;
  const styleId = styleIdOf(node);
  const s = resolved(list, styleId);
  return {
    styleId,
    run: { ...defaults.run, ...s.run },
    para: {
      align: own.textAlign ?? s.para?.align ?? 'left',
      spacing: { ...defaults.para?.spacing, ...s.para?.spacing, ...own.spacing },
      indent: { ...s.para?.indent, ...own.indent },
    },
  };
}

/** `obj` with `partial` merged in, a null value removing its key; null when nothing is left (inherit from the style). */
const patch = (obj, partial) => {
  const out = { ...obj, ...partial };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return Object.keys(out).length ? out : null;
};

/** A command running `fn(tr, node, pos)` on every paragraph and heading the selection touches; false where there is none. */
const each = (fn) => ({ state, tr, dispatch }) => {
  const paras = textblocks(state);
  if (!paras.length) return false;
  if (dispatch) for (const { node, pos } of paras) fn(tr, node, pos);
  return true;
};
const inList = (state) => textblocks(state).some(({ node }) => node.attrs.numbering);
const leftOf = (tr, node) => effectiveProps(tr.doc, node).para.indent.left ?? 0;
/** Left indent `left` points (at least 0, in whole twips) as `node`'s own indent.left: null where its style gives that much,
 * else the number, 0 included, so Decrease indent on an indented style (Intense Quote, List Paragraph) reaches the margin as
 * Word's w:ind w:left="0" does. */
const leftAttr = (tr, node, left) => {
  const v = Math.max(0, Math.round(left * 20) / 20);
  return v === (effectiveProps(tr.doc, { type: node.type, attrs: { ...node.attrs, indent: null } }).para.indent.left ?? 0) ? null : v;
};

const lineCss = (line) => (!line ? null : line.rule === 'auto' ? String(line.value) : `${line.value}pt`); // atLeast drawn as exact

/** Sets textblock `node` at `pos` to paragraph style `id` in `tr`: Heading1 to Heading6 make a heading node of that level (as
 * headings stay heading nodes), Normal or null a plain paragraph, any other id a paragraph with that styleId. Outline view's
 * level changes share it. */
export function restyleBlock(tr, node, pos, id) {
  const h = typeof id === 'string' && /^Heading([1-6])$/.exec(id);
  const { level, ...attrs } = node.attrs;
  const { nodes } = tr.doc.type.schema;
  if (h) return tr.setNodeMarkup(pos, nodes.heading, { ...attrs, level: +h[1], styleId: null });
  return tr.setNodeMarkup(pos, nodes.paragraph, { ...attrs, styleId: !id || id === 'Normal' ? null : id });
}

/** Paragraph properties on paragraph and heading: styleId (null: Normal, or HeadingN on a heading), spacing {before, after, line}
 * and indent {left, right, firstLine (negative: hanging)}, each null to inherit from the style; numbering {numId, ilvl} makes
 * the paragraph a list item (lists.js). */
const ParaProps = Extension.create({
  name: 'paraProps',
  priority: 101, // its Enter runs before TipTap's own (core keymap, 100)
  // The Home tab's paragraph commands (and doc.format paragraph, doc.command), on every selected paragraph and heading.
  addCommands() {
    return {
      // A paragraph style (Normal clears it); HeadingN makes a heading node of that level, as headings stay heading nodes.
      // False for any other id the Document's styles do not hold as a paragraph style (doc.command passes agents' args here).
      setStyle: (id) => (props) => {
        const h = typeof id === 'string' && /^Heading([1-6])$/.exec(id);
        if (id != null && id !== 'Normal' && !h && props.state.doc.attrs.styles?.list?.[id]?.type !== 'paragraph') return false;
        return each((tr, node, pos) => restyleBlock(tr, node, pos, id))(props);
      },
      // {before?, after?, line?} in points; null resets one to the style.
      setSpacing: (spacing) => each((tr, node, pos) => tr.setNodeAttribute(pos, 'spacing', patch(node.attrs.spacing, spacing))),
      setLineSpacing: (multiple) => ({ commands }) => commands.setSpacing({ line: multiple == null ? null : { rule: 'auto', value: multiple } }),
      // {left?, right?, firstLine?} in points (negative firstLine: hanging); null resets one to the style.
      setIndent: (indent) => each((tr, node, pos) => tr.setNodeAttribute(pos, 'indent', patch(node.attrs.indent, indent))),
      // Increase and Decrease indent: half an inch, or one level in a list, as Word's buttons do.
      increaseIndent: () => ({ state, commands }) => (inList(state) ? commands.sinkListLevel()
        : commands.command(each((tr, node, pos) => tr.setNodeAttribute(pos, 'indent', patch(node.attrs.indent, { left: leftAttr(tr, node, leftOf(tr, node) + INDENT_STEP) }))))),
      decreaseIndent: () => ({ state, commands }) => (inList(state) ? commands.liftListLevel()
        : commands.command(each((tr, node, pos) => tr.setNodeAttribute(pos, 'indent', patch(node.attrs.indent, { left: leftAttr(tr, node, leftOf(tr, node) - INDENT_STEP) }))))),
      // Ctrl+T hangs the first line half an inch out from a left indent moved in by as much; Ctrl+Shift+T undoes that.
      setHanging: (on) => each((tr, node, pos) => {
        const left = leftOf(tr, node);
        tr.setNodeAttribute(pos, 'indent', patch(node.attrs.indent, on ? { left: leftAttr(tr, node, left + INDENT_STEP), firstLine: -INDENT_STEP }
          : { left: leftAttr(tr, node, left - INDENT_STEP), firstLine: null }));
      }),
      // plan.md §1.8 generic commands. {attr: value} on every selected paragraph and heading: an object merges into the
      // attribute's object key by key (null removes a key), so keys a newer build wrote survive; null resets the attribute.
      setParaProps: (props) => each((tr, node, pos) => {
        for (const [k, v] of Object.entries(props ?? {})) {
          if (!(k in node.type.spec.attrs)) continue;
          const old = tr.doc.nodeAt(pos).attrs[k];
          const next = isPlain(v) && isPlain(old) ? deepPatch(old, v) : v;
          tr.setNodeAttribute(pos, k, isPlain(next) && !Object.keys(next).length ? null : next);
        }
      }),
      // Merges `patch` into doc.attrs.settings in one step (null removes a key).
      setDocSettings: (patch) => ({ tr, dispatch }) => {
        if (dispatch) tr.setDocAttribute('settings', deepPatch(tr.doc.attrs.settings ?? {}, patch));
        return true;
      },
      // Ctrl+Q: the paragraph's own alignment, spacing and indents go; its style and list stay.
      clearParagraph: () => each((tr, node, pos) => tr.setNodeMarkup(pos, null, { ...node.attrs, textAlign: null, spacing: null, indent: null })),
      // Word's Clear All Formatting: the runs lose their formatting but keep their hyperlinks, comments, tracked changes and
      // editing permissions, as in Word, and the paragraph goes back to Normal without its own alignment, spacing and indents; a
      // list stays.
      clearFormatting: () => ({ tr, dispatch, chain }) => {
        if (dispatch) {
          const { link, comment, insertion, deletion, formatChange, permission, ...marks } = tr.doc.type.schema.marks;
          for (const { $from, $to } of tr.selection.ranges) {
            for (const type of Object.values(marks)) tr.removeMark($from.pos, $to.pos, type);
            stripRuns(tr, $from.pos, $to.pos, without(Object.keys(marks))); // a field result's own runs, which removeMark misses
          }
        }
        return chain().setStyle('Normal').clearParagraph().run();
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      // Enter at the end of a paragraph whose style names a next style (Title, Subtitle, Quote: Normal) goes on in that style,
      // as in Word. Elsewhere a split keeps the attributes (TipTap keepOnSplit), so both halves keep the style. The new paragraph
      // never takes the suggestion record (docs/wiki/suggestions.md).
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        const p = $from.parent;
        if (!empty || p.type.name !== 'paragraph' || !p.attrs.styleId || $from.parentOffset < p.content.size) return false;
        const next = editor.state.doc.attrs.styles?.list?.[p.attrs.styleId]?.next;
        if (!next || next === p.attrs.styleId || /^Heading\d$/.test(next)) return false; // a heading style needs a heading node
        // One split step that types the new paragraph (TipTap's keyboardShortcut maps a second step to the wrong place); the
        // run formatting goes on as splitBlock's keepMarks does.
        const marks = editor.state.storedMarks ?? $from.marks();
        return editor.commands.command(({ tr, dispatch }) => {
          if (dispatch) tr.split($from.pos, 1, [{ type: p.type, attrs: { ...p.attrs, styleId: next === 'Normal' ? null : next, suggest: null } }]).ensureMarks(marks).scrollIntoView();
          return true;
        });
      },
    };
  },
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        styleId: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-style') ?? msoStyle(el),
          renderHTML: ({ styleId }) => (styleId ? { 'data-style': styleId } : {}),
        },
        spacing: {
          default: null,
          parseHTML: parseSpacing,
          renderHTML: ({ spacing: s }) => ({ style: s && style({ 'margin-top': s.before != null ? `${s.before}pt` : null,
            'margin-bottom': s.after != null ? `${s.after}pt` : null, 'line-height': lineCss(s.line) }) }),
        },
        indent: {
          default: null,
          parseHTML: parseIndent,
          renderHTML: ({ indent: i }) => ({ style: i && style({ 'margin-left': i.left != null ? `${i.left}pt` : null,
            'margin-right': i.right != null ? `${i.right}pt` : null, 'text-indent': i.firstLine != null ? `${i.firstLine}pt` : null }) }),
        },
        numbering: {
          default: null,
          // 'numId:ilvl', or 'numId:ilvl:abstract' for a list a copy or paste brings in (lists.js numberNewLists gives it a num);
          // paste.js writes it for HTML lists and Word's mso-list paragraphs.
          parseHTML: (el) => {
            const m = /^(-?\d+):([0-8])(?::([A-Za-z]\w*))?$/.exec(el.getAttribute('data-num') ?? '');
            return m ? { numId: +m[1], ilvl: +m[2], ...(m[3] && { abstract: m[3] }) } : null;
          },
          renderHTML: ({ numbering: n }) => (n ? { 'data-num': `${n.numId}:${n.ilvl}${n.abstract ? `:${n.abstract}` : ''}` } : {}),
        },
      },
    }];
  },
});

// Heading 1 to 6 by key (Ctrl+Alt+N, TipTap's own Mod-Alt-N) or by setHeading go through setStyle, as Word's heading keys
// apply the Heading style: TipTap's setNode copies the paragraph's styleId (Title, Quote) onto the heading, which would then
// still draw and report as that style. Priority under Heading's 100, so these replace its commands of the same names.
const HeadingStyles = Extension.create({
  name: 'headingStyles',
  priority: 99,
  addCommands() {
    return {
      setHeading: ({ level }) => ({ commands }) => commands.setStyle(`Heading${level}`),
      toggleHeading: ({ level }) => ({ state, commands }) => commands.setStyle(isNodeActive(state, 'heading', { level }) ? 'Normal' : `Heading${level}`),
    };
  },
});

// ---------- run properties ----------
const NUM = (v) => (v == null ? null : +v);

// Nested spans: the inner span's textStyle replaces the outer one, so a property the inner span does not set comes from the
// closest ancestor span, as CSS inherits it. `own` is the test for setting it, which for themeColor is setting a color too,
// so <span style="color:#4472C4;mso-themecolor:accent1"><span style="color:red"> leaves the inner run plain red.
const inherit = (parse, own = parse) => function read(el) {
  if (own(el) != null) return parse(el);
  const up = el.parentElement?.closest('span');
  return up ? read(up) : null;
};
const ownColor = (el) => cssHex(el.style.color);
const ownThemeColor = (el) => {
  const own = el.getAttribute('data-theme-color');
  if (own) {
    const [slot, lum] = own.split(':');
    return { slot, lum: NUM(lum) ?? 0 };
  }
  const word = mso(el, 'mso-themecolor')?.toLowerCase();
  const slot = WORD_THEME[word] ?? (/^accent[1-6]$/.test(word) ? word : null);
  if (!slot) return null;
  const shade = NUM(mso(el, 'mso-themeshade'));
  const tint = NUM(mso(el, 'mso-themetint'));
  const lum = shade != null ? -(1 - shade / 255) : tint != null ? 1 - tint / 255 : 0;
  return { slot, lum: round2(lum) };
};
const ownColorPair = (el) => ownColor(el) ?? ownThemeColor(el);

// RunProps' attributes, which its span rule also asks.
const RUN_V1 = {
  font: {
    default: null,
    parseHTML: inherit((el) => {
      const theme = /^(major|minor)/i.exec(mso(el, 'mso-ascii-theme-font') ?? '');
      if (theme) return `+${theme[1].toLowerCase()}`;
      const first = el.style.fontFamily.split(',')[0]?.trim().replace(/^["']|["']$/g, '');
      return first && !/^var\(/.test(first) ? first : el.getAttribute('data-font');
    }),
    renderHTML: ({ font }) => (!font ? {} : font.startsWith('+')
      ? { 'data-font': font, style: `font-family: var(--doc-${font.slice(1)})` } : { style: `font-family: ${fontStack(font)}` }),
  },
  size: {
    default: null,
    parseHTML: inherit((el) => {
      const v = el.style.fontSize;
      const pt = NAMED_SIZES[v] ?? cssPt(v);
      return pt == null ? null : Math.min(1638, Math.max(1, Math.round(pt * 2) / 2));
    }),
    renderHTML: ({ size }) => (size ? { style: `font-size: ${size}pt` } : {}),
  },
  color: {
    default: null,
    parseHTML: inherit(ownColor, ownColorPair),
    renderHTML: ({ color }) => (color ? { style: `color: ${color}` } : {}),
  },
  themeColor: {
    default: null,
    parseHTML: inherit(ownThemeColor, ownColorPair),
    renderHTML: ({ themeColor: t }) => (t ? { 'data-theme-color': `${t.slot}:${t.lum ?? 0}` } : {}),
  },
  highlight: {
    default: null,
    // A background is a highlight unless it is run shading (ours, or Word's mso-shading), which draws through background too.
    parseHTML: inherit((el) => highlightName(el.getAttribute('data-highlight') ?? mso(el, 'mso-highlight') ?? '')
      ?? (el.hasAttribute('data-shading') || mso(el, 'mso-shading') ? null
        : HIGHLIGHT_BY_HEX[cssHex(el.style.backgroundColor) ?? ''] ?? highlightName(el.style.backgroundColor))),
    renderHTML: ({ highlight }) => (HIGHLIGHTS[highlight] ? { 'data-highlight': highlight, style: `background-color: ${HIGHLIGHTS[highlight]}` } : {}),
  },
};
// v2's run properties inherit from enclosing spans the same way. Highlight renders last, so it wins over shading, as in Word.
const { highlight: HIGHLIGHT, ...V1 } = RUN_V1;
// A span with its own style or data attribute; without one, the inherited attributes would make any plain inner span a run.
const ownRun = (el) => el.hasAttribute('style') || el.getAttributeNames().some((n) => n.startsWith('data-'));
const RUN_ATTRS = { ...V1, ...Object.fromEntries(Object.entries(RUN_ATTRS_V2).map(([k, a]) => [k, { ...a, parseHTML: inherit(a.parseHTML) }])), highlight: HIGHLIGHT };

/** The textStyle mark with Word's run properties: font (a family, '+major' or '+minor'), size (pt), color ('#RRGGBB', null is
 * Automatic), themeColor ({slot, lum} the colour was picked from; rendering reads only color) and highlight (one of the 16
 * names). Parses Word clipboard spans (mso-ascii-theme-font, mso-themecolor, mso-highlight) and our own. */
/** A command setting each selected run's size to `fn(its size)` (the style's where it has none); at a caret, the size typing
 * goes on with. */
const stepSize = (fn) => () => ({ state, tr, dispatch, commands }) => {
  const type = state.schema.marks.textStyle;
  const sizeOf = (marks, para) => type.isInSet(marks)?.attrs.size ?? effectiveProps(state.doc, para).run.size ?? 12;
  const { empty, from, to, $from } = state.selection;
  if (empty) return commands.setMark(type, { size: fn(sizeOf(state.storedMarks ?? $from.marks(), $from.parent)) });
  if (dispatch) {
    state.doc.nodesBetween(from, to, (node, pos, parent) => {
      if (!node.isText) return;
      tr.addMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), type.create({ ...type.isInSet(node.marks)?.attrs, size: fn(sizeOf(node.marks, parent)) }));
    });
  }
  return true;
};

/** plan.md §1.8 generic command: {attr: value} into the textStyle of every run and inline object in the selection (at a caret,
 * the formatting typing goes on with). An object merges into the attribute's object key by key and null resets it, so keys a
 * newer build wrote survive; a textStyle left with nothing set is removed, as removeEmptyTextStyle does. */
const setRunProps = (props) => ({ state, tr, dispatch }) => {
  const type = state.schema.marks.textStyle;
  const merged = (old = {}) => {
    const out = { ...old };
    for (const [k, v] of Object.entries(props ?? {})) if (k in type.spec.attrs) out[k] = isPlain(v) && isPlain(old[k]) ? deepPatch(old[k], v) : v;
    return out;
  };
  const apply = (old, add, remove) => {
    const attrs = merged(old);
    return Object.values(attrs).some((v) => v != null) ? add(type.create(attrs)) : remove();
  };
  const { empty, $from, ranges } = state.selection;
  if (!dispatch) return true;
  if (empty) {
    apply(type.isInSet(state.storedMarks ?? $from.marks())?.attrs, (m) => tr.addStoredMark(m), () => tr.removeStoredMark(type));
    return true;
  }
  // Every range, so a CellSelection formats each selected cell (its from..to covers one cell), as TipTap's setMark does.
  for (const { $from: { pos: from }, $to: { pos: to } } of ranges) {
    state.doc.nodesBetween(from, to, (node, pos, parent) => {
      if (!node.isInline || !parent.type.allowsMarkType(type)) return;
      const a = Math.max(from, pos);
      const b = Math.min(to, pos + node.nodeSize);
      apply(type.isInSet(node.marks)?.attrs, (m) => tr.addMark(a, b, m), () => tr.removeMark(a, b, type));
    });
  }
  return true;
};

/** TipTap's removeEmptyTextStyle drops a textStyle whose values are all falsy, but v2's false and 0 are set values (a style's
 * caps switched off, spacing 0), so Font Color Automatic would bring the style's back. Empty here means every value is null. */
const removeEmptyTextStyle = () => ({ state, tr }) => {
  const type = state.schema.marks.textStyle;
  for (const { $from, $to } of tr.selection.ranges) {
    tr.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (!node.isInline) return true;
      const own = node.marks.filter((m) => m.type === type);
      if (own.length && !own.some((m) => Object.values(m.attrs).some((v) => v != null))) tr.removeMark(pos, pos + node.nodeSize, type);
    });
  }
  return true;
};

const RunProps = TextStyle.extend({
  // Grow and Shrink font (Ctrl+Shift+. and Ctrl+Shift+,: the next listed size) and Ctrl+] and Ctrl+[ (one point).
  addCommands() {
    return { ...this.parent?.(), growFont: stepSize(growSize), shrinkFont: stepSize(shrinkSize), growFont1: stepSize((pt) => size1(pt, 1)),
      shrinkFont1: stepSize((pt) => size1(pt, -1)), setRunProps, removeEmptyTextStyle };
  },
  // Only a span holding a run property, in its style or (for those with no CSS, such as charStyle and fontEA) a data attribute:
  // Word's and web pages' other spans (mso-ansi-language, font-weight: 400) would leave a textStyle with every attribute null
  // (docs/plans/document.md dataModel: removeEmptyTextStyle drops those). Each attribute falls back to the closest ancestor span
  // (inherit), so <span style="font-size:20pt"><span style="color:red"> keeps both.
  // TextStyle's mergeNestedSpanStyles is not used: its 'outer;inner' style text makes the mso-* reads take the outer values.
  parseHTML() {
    return [{ tag: 'span', consuming: false, getAttrs: (el) => (ownRun(el) && Object.values(RUN_ATTRS).some((a) => a.parseHTML(el) != null) ? {} : false) }];
  },
  addAttributes() {
    return RUN_ATTRS;
  },
});

/** Underline with Word's style (val, one of the 17 ST_Underline names; 'single' by default). */
const WordUnderline = Underline.extend({
  addAttributes() {
    return {
      val: {
        default: 'single',
        parseHTML: (el) => {
          const v = el.getAttribute('data-underline') ?? mso(el, 'text-underline');
          return UNDERLINES.find((u) => u.toLowerCase() === v?.toLowerCase()) ?? 'single';
        },
        renderHTML: ({ val }) => (val === 'single' ? {} : { 'data-underline': val, style: style(UNDERLINE_CSS(val)) }),
      },
    };
  },
});

// ---------- tables ----------
const VALIGN = { top: 'top', middle: 'center', bottom: 'bottom' };
const cellAttrs = {
  shading: {
    default: null,
    parseHTML: (el) => cssHex(el.style.backgroundColor),
    renderHTML: ({ shading }) => (shading ? { style: `background-color: ${shading}` } : {}),
  },
  vAlign: {
    default: null,
    parseHTML: (el) => VALIGN[el.style.verticalAlign] ?? null,
    renderHTML: ({ vAlign }) => (vAlign ? { style: `vertical-align: ${vAlign === 'center' ? 'middle' : vAlign}` } : {}),
  },
};
const DocTableCell = TableCell.extend({ addAttributes() { return { ...this.parent?.(), ...cellAttrs }; } });
const DocTableHeader = TableHeader.extend({ addAttributes() { return { ...this.parent?.(), ...cellAttrs }; } });
const DocTable = Table.extend({
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), mergeSlots];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      styleId: { default: 'TableGrid', parseHTML: (el) => el.getAttribute('data-style') ?? 'TableGrid', renderHTML: ({ styleId }) => ({ 'data-style': styleId }) },
    };
  },
});

// ---------- page breaks and pictures ----------
/** A page break (w:br w:type="page"): an atom block between paragraphs, drawn as the sheet's end, a gap and a new sheet
 * (document.css). Ctrl+Enter (keys.mjs document.pageBreak) runs setPageBreak. */
const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  // Word's clipboard writes a page break as a <br> with page-break-before (inside a paragraph, which the parser closes).
  parseHTML: () => [{ tag: 'div[data-page-break]' },
    { tag: 'br', priority: 60, getAttrs: (el) => (/page-break-before:\s*always/i.test(el.getAttribute('style') ?? '') ? {} : false) }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-page-break': '', style: 'page-break-after: always' }, HTMLAttributes)],
  renderMarkdown: () => '<!-- page break -->',
  addCommands() {
    return {
      // At a caret in top-level text, as Word's Ctrl+Enter: the text after the caret goes on the new sheet; at the start of a
      // paragraph the break goes before it. In a cell of a top-level table it splits the table above the caret's row with the
      // break between, as Word does and the canvas engine's text.pageBreak does. False across blocks or cells. At a paragraph's
      // end the new empty paragraph never takes the suggestion record (docs/wiki/suggestions.md), as with Enter.
      setPageBreak: () => ({ state, tr, dispatch }) => {
        const { $from, $to } = tr.selection;
        if (!$from.parent.isTextblock || !$from.sameParent($to)) return false;
        if ($from.depth !== 1) {
          if (tableOf($from)?.depth !== 1) return false;
          if (dispatch) tr.deleteSelection();
          return !!splitTable(state, this.type.create()); // state.tr is this command's tr, so the split lands in it
        }
        if (dispatch) {
          tr.deleteSelection();
          const $p = tr.selection.$from;
          const types = $p.parentOffset === $p.parent.content.size ? [{ type: $p.parent.type, attrs: { ...$p.parent.attrs, suggest: null } }] : undefined;
          const at = $p.parentOffset === 0 ? $p.before() : (tr.split($p.pos, 1, types), $p.pos + 1);
          tr.insert(at, this.type.create()).scrollIntoView();
        }
        return true;
      },
    };
  },
});

/** Pictures: inline image nodes (docs/plans/document.md Pictures), src a data URL (the draft file stores it as a file),
 * width and height in px, alt (Word's alt text) and title. Only data URLs parse: a remote picture would load from the network
 * and could not export. Resizing from a corner keeps the aspect ratio. */
const Picture = Image.extend({
  parseHTML: () => [{ tag: 'img[src^="data:"]' }],
  addInputRules: () => [], // TipTap's ![alt](src) rule would make a picture with a remote src
  // Markdown pictures likewise: a data URL only, else the alt text ('![alt](picture)' from doc.get included).
  parseMarkdown: (token) => (/^data:/.test(token.href ?? '') ? { type: 'image', attrs: { src: token.href, title: token.title || null, alt: token.text || null } }
    : token.text ? { type: 'text', text: token.text } : []),
  // doc.get markdown names the picture instead of carrying its data.
  renderMarkdown: (node) => `![${node.attrs.alt ?? ''}](picture)`,
  // TipTap's resizable view (ResizableNodeView) puts the rendered attributes on the img and, on each update, replaces the img's
  // style attribute with the rendered one, which drops the size it set. So after each update the size goes back on, and the
  // layout's data attributes (data-layout, data-wrap, data-z) move to the outer wrapper, where float-layout draws the wrap:
  // never a CSS float, which would land at the end of its page run under the page floats (plan.md §1.9).
  // A picture of a known size loads its bitmap only once it comes near the view (lazy.mjs): its box has that size already, so
  // the page is laid out the same before and after. Until then the view holds the node without its src.
  addNodeView() {
    const make = this.parent?.();
    if (!make) return null;
    return (props) => {
      let real = props.node;
      const sized = real.attrs.width != null && real.attrs.height != null && !!real.attrs.src;
      let drawn = !sized;
      const bare = (n) => (drawn ? n : n.type.create({ ...n.attrs, src: null }, null, n.marks));
      const view = make(drawn ? props : { ...props, node: bare(real), HTMLAttributes: { ...props.HTMLAttributes, src: null } });
      const img = view.element;
      img.decoding = 'async';
      const apply = (node) => {
        for (const k of ['data-layout', 'data-wrap', 'data-z']) {
          const v = img.getAttribute(k);
          img.removeAttribute(k);
          if (v == null) view.dom.removeAttribute(k);
          else view.dom.setAttribute(k, v);
        }
        // A zero size is kept (a Word picture with a zero extent draws at no size), not left to the picture's own.
        if (node.attrs.width != null) img.style.width = `${node.attrs.width}px`;
        if (node.attrs.height != null) img.style.height = `${node.attrs.height}px`;
      };
      apply(props.node);
      const update = view.update.bind(view);
      view.update = (node, ...rest) => {
        const ok = update(bare(node), ...rest);
        if (ok) {
          real = node;
          apply(node);
        }
        return ok;
      };
      if (!sized) return view;
      // TipTap shows the picture once it loads, to learn its size; this one knows it, so it shows at once.
      const lazy = whenNear(props.view, view.dom, () => {
        drawn = true;
        img.src = real.attrs.src;
        Object.assign(view.dom.style, { visibility: '', pointerEvents: '' });
        return img.decode().catch(() => {});
      });
      // Reached by the keyboard or a search (a node selection): drawn at once. The class is ProseMirror's own selectNode.
      view.selectNode = () => {
        lazy.now();
        view.dom.classList.add('ProseMirror-selectednode');
      };
      const destroy = view.destroy.bind(view);
      view.destroy = () => {
        lazy.stop();
        destroy();
      };
      return view;
    };
  },
  addCommands() {
    return {
      ...this.parent?.(),
      // The selected pictures' alt text (empty: none).
      setAltText: (alt) => ({ state, tr, dispatch }) => {
        const at = [];
        state.doc.nodesBetween(state.selection.from, state.selection.to, (n, pos) => {
          if (n.type === this.type) at.push(pos);
        });
        if (!at.length || typeof alt !== 'string') return false;
        if (dispatch) for (const pos of at) tr.setNodeAttribute(pos, 'alt', alt.trim() || null);
        return true;
      },
    };
  },
}).configure({ inline: true, allowBase64: true, resize: { enabled: true, alwaysPreserveAspectRatio: true, minWidth: 16, minHeight: 16 } });

// Word's Distributed alignment (w:jc distribute) spreads every line, the last too: CSS justify plus text-align-last.
const WordAlign = TextAlign.extend({
  addGlobalAttributes() {
    const [g] = this.parent();
    const a = g.attributes.textAlign;
    return [{ ...g, attributes: { textAlign: {
      ...a,
      parseHTML: (el) => (el.style.textAlign === 'justify' && (el.style.textAlignLast === 'justify' || /distribute/i.test(mso(el, 'text-justify') ?? ''))
        ? 'distribute' : a.parseHTML(el)),
      renderHTML: (attrs) => (attrs.textAlign === 'distribute' ? { style: 'text-align: justify; text-align-last: justify' } : a.renderHTML(attrs)),
    } } }];
  },
});

// ---------- markdown ----------
/** Markdown code in a Document: Word has no code, so a fenced or indented block becomes one plain paragraph per line and inline
 * code its text (docs/plans/document.md Headings, styles and omitted nodes: pasted code becomes plain text). */
const PlainCode = [
  Extension.create({ name: 'plainCodeBlock', markdownTokenName: 'code',
    parseMarkdown: (token) => token.text.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) }),
  Extension.create({ name: 'plainCodeSpan', markdownTokenName: 'codespan', parseMarkdown: (token) => ({ type: 'text', text: token.text }) }),
];

/** The Document's own extensions for an undo depth (docs/plans/document.md editorAndUi). No blockquote, code, code block,
 * horizontal rule, box, media (video) or nested lists: Word has none of them (lists are flat list paragraphs, lists.js).
 * Schema v2's nodes, marks and global attributes come last (model/). `objects` names the kit's own block objects (src/editors.js:
 * canvas, planChart), which newspaper columns hold too, as Word keeps an object in its column. */
export function documentExtensions(historyDepth, objects = []) {
  return [
    StarterKit.configure({
      document: false, code: false, codeBlock: false, blockquote: false, horizontalRule: false, underline: false,
      bulletList: false, orderedList: false, listItem: false, listKeymap: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      undoRedo: { depth: historyDepth },
      // Columns over the whole document hold its last paragraph, as Word's last section does: no empty paragraph after them,
      // which would count as text after the columns (balance) and take a page of its own.
      trailingNode: { notAfter: ['columns'] },
    }),
    DocNode,
    ParaProps,
    HeadingStyles,
    Lists,
    RunProps,
    WordUnderline,
    WordAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify', 'distribute'] }),
    Subscript.extend({ excludes: 'superscript' }), // w:vertAlign holds one of them
    Superscript.extend({ excludes: 'subscript' }),
    DocTable.configure({ resizable: true, cellMinWidth: MIN_COLUMN, View: DocTableView }),
    TableRow,
    DocTableHeader,
    DocTableCell,
    PageBreak,
    Picture,
    Chart,
    ...NODES_V2.map((n) => (n.name === 'columns' ? n.configure({ objects }) : n)),
    ...MARKS_V2,
    ModelAttrs,
    StyleSheet,
    Pagination,
    ...PlainCode,
  ];
}

