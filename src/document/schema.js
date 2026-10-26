// The Document's schema, schema v1 (docs/plans/document.md dataModel, editorAndUi): Word's run and paragraph properties on
// TipTap's nodes and marks. Lengths are points, colours '#RRGGBB'. Imports no app DOM module, so Node tests can getSchema it;
// src/editors.js adds the shared app blocks and the keys. Direct formatting renders as inline style (so text copied into Word
// keeps it), style definitions come from the stylesheet plugin (stylesheet.js). After 1.3.0 every change here is additive and
// bumps the format's version (formats.mjs DOCUMENT; test/document-schema.test.mjs pins the names).
import { Extension, isNodeActive, Node } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Image } from '@tiptap/extension-image';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table, TableCell, TableHeader, TableRow, TableView } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Underline } from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { fontStack, growSize, HIGHLIGHTS, INDENT_STEP, shrinkSize, size1, UNDERLINES } from '../office.mjs';
import { docMarkdown, Lists, textblocks } from './lists.js';
import { Pagination } from './pagination.js';
import { resolved, StyleSheet } from './stylesheet.js';

export const MIN_COLUMN = 20; // px, as the forum editor's (extensions.js); table widths stay px (docs/plans/document.md Units)

// ---------- CSS values to points and hex (Word clipboard HTML and our own rendered HTML) ----------
const PT_PER = { pt: 1, px: 0.75, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12 };
const NAMED_SIZES = { 'xx-small': 6.75, 'x-small': 7.5, small: 9.75, medium: 12, large: 13.5, 'x-large': 18, 'xx-large': 24 };
const round2 = (n) => Math.round(n * 100) / 100;

/** A CSS length in points, or null. */
export function cssPt(v) {
  const m = /^(-?[\d.]+)(pt|px|in|cm|mm|pc)$/.exec(String(v ?? '').trim());
  return m ? round2(parseFloat(m[1]) * PT_PER[m[2]]) : null;
}

// The 16 basic colour names, which Word writes for its basic colours (color:red).
const BASIC = { black: '#000000', silver: '#C0C0C0', gray: '#808080', white: '#FFFFFF', maroon: '#800000', red: '#FF0000', purple: '#800080',
  fuchsia: '#FF00FF', green: '#008000', lime: '#00FF00', olive: '#808000', yellow: '#FFFF00', navy: '#000080', blue: '#0000FF', teal: '#008080',
  aqua: '#00FFFF' };

/** A CSS colour (#rgb, #rrggbb, rgb(), a basic name) as '#RRGGBB', or null (other names and transparent too). */
export function cssHex(v) {
  const s = String(v ?? '').trim();
  if (BASIC[s.toLowerCase()]) return BASIC[s.toLowerCase()];
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) return `#${(m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]).toUpperCase()}`;
  m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(s);
  if (!m || m[4] === '0') return null;
  return `#${m.slice(1, 4).map((x) => (+x).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// Word's mso-* properties survive only in the style attribute's text (the CSSOM drops them).
const mso = (el, prop) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(el.getAttribute('style') ?? '')?.[1].trim() ?? null;
const WORD_THEME = { text1: 'dk1', background1: 'lt1', text2: 'dk2', background2: 'lt2', hyperlink: 'hlink', followedhyperlink: 'folHlink' };
const HIGHLIGHT_BY_HEX = Object.fromEntries(Object.entries(HIGHLIGHTS).map(([n, h]) => [h, n]));
const highlightName = (v) => Object.keys(HIGHLIGHTS).find((n) => n.toLowerCase() === String(v).toLowerCase()) ?? null;

/** The style attribute of `props` ({css property: value | null}), or null when every value is null. */
const style = (props) => {
  const s = Object.entries(props).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`).join('; ');
  return s || null;
};

// ---------- doc ----------
/** The doc node with the document-level data (docs/plans/document.md Document-level data): sect, styles, numbering and theme,
 * changed only with tr.setDocAttribute, so undo, history and autosave carry them. Its Markdown writes list paragraphs as
 * Markdown lists (lists.js). */
const DocNode = Document.extend({
  addAttributes() {
    return Object.fromEntries(['sect', 'styles', 'numbering', 'theme'].map((k) => [k, { default: null, rendered: false }]));
  },
  renderMarkdown: (node, h) => docMarkdown(node, h),
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
  const styleId = own.styleId ?? (node.type.name === 'heading' ? `Heading${own.level}` : 'Normal');
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
        return each((tr, node, pos) => {
          const { level, ...attrs } = node.attrs;
          const { nodes } = tr.doc.type.schema;
          if (h) tr.setNodeMarkup(pos, nodes.heading, { ...attrs, level: +h[1], styleId: null });
          else tr.setNodeMarkup(pos, nodes.paragraph, { ...attrs, styleId: !id || id === 'Normal' ? null : id });
        })(props);
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
      // Ctrl+Q: the paragraph's own alignment, spacing and indents go; its style and list stay.
      clearParagraph: () => each((tr, node, pos) => tr.setNodeMarkup(pos, null, { ...node.attrs, textAlign: null, spacing: null, indent: null })),
      // Word's Clear All Formatting: the runs lose their formatting but keep their hyperlinks, as in Word, and the paragraph
      // goes back to Normal without its own alignment, spacing and indents; a list stays.
      clearFormatting: () => ({ tr, dispatch, chain }) => {
        if (dispatch) {
          const { link, ...marks } = tr.doc.type.schema.marks;
          for (const { $from, $to } of tr.selection.ranges) for (const type of Object.values(marks)) tr.removeMark($from.pos, $to.pos, type);
        }
        return chain().setStyle('Normal').clearParagraph().run();
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      // Enter at the end of a paragraph whose style names a next style (Title, Subtitle, Quote: Normal) goes on in that style,
      // as in Word. Elsewhere a split keeps the attributes (TipTap keepOnSplit), so both halves keep the style. The new paragraph
      // never takes the suggestion record (docs/plans/suggestions.md).
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
const RUN_ATTRS = {
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
    parseHTML: inherit((el) => highlightName(el.getAttribute('data-highlight') ?? mso(el, 'mso-highlight') ?? '')
      ?? HIGHLIGHT_BY_HEX[cssHex(el.style.backgroundColor) ?? ''] ?? highlightName(el.style.backgroundColor)),
    renderHTML: ({ highlight }) => (HIGHLIGHTS[highlight] ? { 'data-highlight': highlight, style: `background-color: ${HIGHLIGHTS[highlight]}` } : {}),
  },
};

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

const RunProps = TextStyle.extend({
  // Grow and Shrink font (Ctrl+Shift+. and Ctrl+Shift+,: the next listed size) and Ctrl+] and Ctrl+[ (one point).
  addCommands() {
    return { ...this.parent?.(), growFont: stepSize(growSize), shrinkFont: stepSize(shrinkSize), growFont1: stepSize((pt) => size1(pt, 1)),
      shrinkFont1: stepSize((pt) => size1(pt, -1)) };
  },
  // Only a span holding a run property: Word's and web pages' other spans (mso-ansi-language, font-weight: 400) would leave a
  // textStyle with every attribute null (docs/plans/document.md dataModel: removeEmptyTextStyle drops those). Each attribute
  // falls back to the closest ancestor span (inherit), so <span style="font-size:20pt"><span style="color:red"> keeps both.
  // TextStyle's mergeNestedSpanStyles is not used: its 'outer;inner' style text makes the mso-* reads take the outer values.
  parseHTML() {
    return [{ tag: 'span', consuming: false, getAttrs: (el) => (el.hasAttribute('style') && Object.values(RUN_ATTRS).some((a) => a.parseHTML(el) != null) ? {} : false) }];
  },
  addAttributes() {
    return RUN_ATTRS;
  },
});

// ST_Underline to CSS: the line style and whether it is heavy.
const UNDERLINE_CSS = (val) => ({
  'text-decoration-style': /^double|wavyDouble$/.test(val) ? 'double' : /^dotted/.test(val) ? 'dotted' : /^dash|dotDash|dotDotDash/.test(val) ? 'dashed' : /^wav/.test(val) ? 'wavy' : null,
  'text-decoration-thickness': /thick|Heavy/.test(val) ? '2px' : null,
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
// The resizable table's view (columnResizing makes it without the node's HTML attributes): it carries data-style, which the
// table style's rules (stylesheet.js) select. Pages split a table between rows (pagination.js): each row is a grid of its own
// (document.css), its columns copied from the colgroup into --cols on the wrapper, also while a column is dragged (the
// colgroup changes without a transaction). A table with a cell spanning rows cannot split that way and moves whole
// (data-whole), and so does one with a row taller than a page's text area (document.css --fit-h), which no page could hold.
// A whole table taller than that is scaled down to fit one page, as a picture is, since it cannot cross a page end.
// ponytail: rowspan and tall-row tables move whole; split them per row group, and a tall row per line, if long ones matter.
class DocTableView extends TableView {
  constructor(node, ...rest) {
    super(node, ...rest);
    this.table.dataset.style = node.attrs.styleId;
    this.cols = new MutationObserver(() => this.sync());
    this.cols.observe(this.colgroup, { attributes: true, childList: true, subtree: true });
    this.cols.observe(this.table, { attributes: true, attributeFilter: ['style'] });
    // The table's own height (a transform does not change it) while no transaction runs, a font arriving say; next frame,
    // since fit() may change the observed size. Pagination fits it before each measure too (pagination.js), after every
    // change and resize, so a page count never counts it unscaled, and a split table's rows (display: contents) are seen.
    this.tall = new ResizeObserver(() => requestAnimationFrame(() => this.fit()));
    this.tall.observe(this.table);
    this.dom.dataset.pgFit = '';
    this.dom.pgFit = () => this.fit();
    this.sync();
  }

  update(node) {
    if (!super.update(node)) return false;
    this.table.dataset.style = node.attrs.styleId;
    this.sync();
    return true;
  }

  /** The columns as a grid template: a set width in px, else an equal share with the column's minimum. */
  sync() {
    const cols = [...this.colgroup.children].map((c) => c.style.width || `minmax(${c.style.minWidth || '0px'}, 1fr)`);
    this.dom.style.setProperty('--cols', cols.join(' '));
    this.dom.style.setProperty('--table-w', this.table.style.width || '100%');
    this.dom.style.setProperty('--table-min', this.table.style.minWidth || '0px');
    this.spans = false;
    this.node.forEach((row) => row.forEach((cell) => { this.spans ||= cell.attrs.rowspan > 1; }));
    this.fit();
  }

  /** Whole when a cell spans rows or a row is taller than a page's text area; a whole table taller than that is drawn scaled
   * to it, the wrapper as tall as the drawing. */
  fit() {
    const max = parseFloat(getComputedStyle(this.dom).getPropertyValue('--fit-h')) - 2;
    // Rows are measured unscaled in either layout; 4 px of slack keeps a row near the limit from switching back and forth.
    const was = this.table.hasAttribute('data-whole');
    const tall = (was || this.dom.offsetHeight > max) && [...this.table.rows].some((r) => r.offsetHeight > max - (was ? 4 : 0));
    this.table.toggleAttribute('data-whole', this.spans || tall);
    const h = this.table.offsetHeight;
    const s = this.table.hasAttribute('data-whole') && h > max ? Math.floor((max / h) * 1e4) / 1e4 : 1; // 4 places read back as written
    const transform = s === 1 ? '' : `scale(${s})`;
    if (this.table.style.transform === transform) return; // also ends the style observer's round trip
    this.table.style.transformOrigin = s === 1 ? '' : '0 0';
    this.table.style.transform = transform;
    this.dom.style.height = s === 1 ? '' : `${h * s}px`;
  }

  destroy() {
    this.cols.disconnect();
    this.tall.disconnect();
  }
}

const DocTable = Table.extend({
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
  renderHTML: () => ['div', { 'data-page-break': '', style: 'page-break-after: always' }],
  renderMarkdown: () => '<!-- page break -->',
  addCommands() {
    return {
      // At a caret in top-level text, as Word's Ctrl+Enter: the text after the caret goes on the new sheet; at the start of a
      // paragraph the break goes before it. False in a table or across blocks. At a paragraph's end the new empty paragraph never
      // takes the suggestion record (docs/plans/suggestions.md), as with Enter.
      setPageBreak: () => ({ tr, dispatch }) => {
        const { $from, $to } = tr.selection;
        if ($from.depth !== 1 || !$from.parent.isTextblock || !$from.sameParent($to)) return false;
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

// ---------- markdown ----------
/** Markdown code in a Document: Word has no code, so a fenced or indented block becomes one plain paragraph per line and inline
 * code its text (docs/plans/document.md Headings, styles and omitted nodes: pasted code becomes plain text). */
const PlainCode = [
  Extension.create({ name: 'plainCodeBlock', markdownTokenName: 'code',
    parseMarkdown: (token) => token.text.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) }),
  Extension.create({ name: 'plainCodeSpan', markdownTokenName: 'codespan', parseMarkdown: (token) => ({ type: 'text', text: token.text }) }),
];

/** The Document's own extensions for an undo depth (docs/plans/document.md editorAndUi). No blockquote, code, code block,
 * horizontal rule, box, media (video) or nested lists: Word has none of them (lists are flat list paragraphs, lists.js). */
export function documentExtensions(historyDepth) {
  return [
    StarterKit.configure({
      document: false, code: false, codeBlock: false, blockquote: false, horizontalRule: false, underline: false,
      bulletList: false, orderedList: false, listItem: false, listKeymap: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      undoRedo: { depth: historyDepth },
    }),
    DocNode,
    ParaProps,
    HeadingStyles,
    Lists,
    RunProps,
    WordUnderline,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Subscript.extend({ excludes: 'superscript' }), // w:vertAlign holds one of them
    Superscript.extend({ excludes: 'subscript' }),
    DocTable.configure({ resizable: true, cellMinWidth: MIN_COLUMN, View: DocTableView }),
    TableRow,
    DocTableHeader,
    DocTableCell,
    PageBreak,
    Picture,
    StyleSheet,
    Pagination,
    ...PlainCode,
  ];
}

