// The layout predictor's engine (docs/plans/word/briefs/layout-predictor.md, grown from docs/plans/word/layout-spike.md): a
// Document's lines and pages from its model, with no DOM, so a worker knows a large document's page map within a second while the
// editor's DOM still draws the pages in view. It keeps a copy of the doc JSON, lays out again only the top-level blocks whose
// content or inputs changed (each block's layout is cached on its node with a key of its width, its section's body, the styles
// and the list labels and note numbers it shows), and paginates through the page engine's own planPages.
// Per changed block, in timed phases:
//   resolve   the block to paragraphs of inline items with the app's own style code (rules.mjs, office.mjs fontStack, numbering.mjs
//             labels, model/resolved.mjs), at its section's text width or its column's (width.mjs)
//   segment   break opportunities (segment.mjs)
//   measure   each word's width and its trailing spaces' through the injected measurer (measure.mjs in the worker)
//   break     greedy lines, tabs (wp/tabs/layout.mjs), line heights, paragraph, cell, row and table heights
// then over the whole document:
//   flow      the blocks stacked with their spacing into planPages' units, the DOM's measured heights where it reported them
//   paginate  planPages (wp/page-engine/layout.mjs): keep rules, widow and orphan control, section starts, repeated header rows,
//             footnotes kept with their reference lines
// Lengths are CSS px (1 pt = 4/3 px) unless a name says pt. Plain JS and Intl.Segmenter: node tests run it with a fake measurer.
import { eaFamily, eastAsianRuns, fontStack } from '../../office.mjs';
import { parseField } from '../fields/registry.mjs';
import { charRun, resolvedAll } from '../model/resolved.mjs';
import { withDefaults } from '../model/sections.mjs';
import { styleIdOf } from '../model/styles.mjs';
import { tabStopsOf } from '../model/tabs.mjs';
import { levelOf, listLabels, numOf } from '../numbering.mjs';
import { isLine, lineWidth } from '../wp/borders/model.mjs';
import { AUTO_SPACE, dropsNext, effectivePara, gridOf, gridPitch, lineCss, lineExtra, linePitch, reachRight, styleProps } from '../wp/paragraph/rules.mjs';
import { bodyOf, collapse, keepsOf, paperOf, planPages, startOf } from '../wp/page-engine/layout.mjs';
import { effectivePr, noteNumber, STYLE_IDS } from '../wp/notes/model.mjs';
import { numStop, placePtab, placeTab } from '../wp/tabs/layout.mjs';
import { fxBox, fxRoom } from '../wp/font/run.mjs';
import { hiddenCellEnd } from '../wp/table-tools/autofit.mjs';
import { ID, segment, startState } from './segment.mjs';
import { colBoxes, columnWidthOf } from './width.mjs';

export const PX = 4 / 3;
const EPS = 0.01;
const now = () => performance.now();

/** The line and measuring rules, each a named option. The defaults are the editor's, because its DOM still draws the pages; Word's
 * switch on once the engine places lines itself. The worker adds two canvas rules (worker.js): ligatures and lang. */
export const RULES = Object.freeze({
  // 'hang': spaces hang past the edge, as in Word and the editor's white-space: pre-wrap (document.css); 'break': a word's trailing
  // space must fit, as ProseMirror's own break-spaces draws
  spaces: 'hang',
  // 'editor': the CSS line boxes wp/paragraph/extension.js draws (one line-height per paragraph from its tallest font, each line
  // box as tall as its inline boxes); 'word': each line as tall as its own tallest font (rules.mjs linePitch)
  lines: 'editor',
  // {font stack: ratio}: the editor's single line over the size of each stack (extension.js ratioOf: Word's, read from the font
  // file by fonts/metrics.mjs, or measured in its DOM). Both line modes take it. A stack missing here takes the canvas metrics,
  // which leave out the font's line gap.
  ratios: null,
  // Field names drawn as objects (the field registry's types with a draw), whose drawn size the model lacks.
  drawn: [],
  // Each line's text and width (diagnostics: the harness compares them with the editor's DOM).
  keepText: false,
});

/** Why a block's height is not the engine's own model: bits of est[i]. dom: the editor's measured height replaces the engine's. */
export const EST = Object.freeze({ float: 1, object: 2, note: 4, oversize: 8, approx: 16, dom: 32 });

const borderPx = (e) => {
  if (!e?.style || e.style === 'nil' || e.style === 'none') return 0;
  const w = e.width || 0.5;
  return (/^(double|triple)$|Thin|Thick(?!$)/.test(e.style) && e.style !== 'thick' ? Math.max(w * 3, 2.25) : w) * PX;
};

/** The room in px a paragraph's top or bottom border takes: Word's line width (borders/model.mjs, as borders/group.js pads) and
 * its distance from the text. */
const edgeRoom = (e) => (isLine(e) ? (lineWidth(e) + (e.space ?? 0)) * PX : 0);

// ---------- list labels and note numbers ----------
const isText = (n) => n.type === 'paragraph' || n.type === 'heading';

/** List labels (numbering.mjs, counted over the whole document as lists.js does) and note numbers, written onto the doc's nodes as
 * __label, __num and __n, and each top-level node's __sig: the labels and numbers it shows, part of its layout key. */
function count(doc) {
  const items = [];
  const nodes = [];
  const notes = { footnote: 0, endnote: 0 };
  let top = null;
  const walk = (n) => {
    if (isText(n)) {
      const num = numOf(doc, n);
      n.__label = n.__num = null;
      if (num) {
        items.push(num);
        nodes.push([n, top]);
      }
    } else if (n.type === 'noteRef') top.__sig += `|${(n.__n = ++notes[n.attrs.kind === 'endnote' ? 'endnote' : 'footnote'])}`;
    if (n.content) for (const k of n.content) walk(k);
  };
  for (const k of doc.content) {
    top = k;
    k.__sig = '';
    walk(k);
  }
  const labels = listLabels(items, doc.attrs.numbering);
  nodes.forEach(([n, t], i) => {
    if (labels[i] == null) return;
    n.__label = labels[i];
    n.__num = items[i];
    t.__sig += `|${labels[i]}`;
  });
}

/** The numbered paragraphs and note references in `nodes` in order: [[node, key]], key the numbering or note kind each counts by.
 * `fresh`: nodes that were never counted (their numbering read from the model, not from __num). */
function counted(nodes, doc, fresh) {
  const out = [];
  const walk = (n) => {
    if (isText(n)) {
      const num = fresh ? numOf(doc, n) : n.__num;
      if (num) out.push([n, `${num.numId}:${num.ilvl}`]);
    } else if (n.type === 'noteRef') out.push([n, n.attrs.kind === 'endnote' ? 'e' : 'f']);
    for (const k of n.content ?? []) walk(k);
  };
  for (const n of nodes) walk(n);
  return out;
}

/** After `old` top-level nodes became `nodes`: when both count the same lists and notes in the same order, every label and
 * number stays, so the new nodes take the old ones' and no count runs (typing in a numbered paragraph). → whether it did. */
function keepCount(old, nodes, doc) {
  const a = counted(old, doc, false);
  const b = counted(nodes, doc, true);
  if (a.length !== b.length || a.some(([, k], i) => k !== b[i][1])) return false;
  b.forEach(([n], i) => {
    const o = a[i][0];
    if (o.__num) [n.__label, n.__num] = [o.__label, o.__num];
    else n.__n = o.__n;
  });
  for (const n of nodes) {
    n.__sig = '';
    for (const [k] of counted([n], doc, false)) n.__sig += `|${k.__label ?? k.__n}`;
  }
  return true;
}

// ---------- sections ----------
/** The sections of top-level `content` with the last one's `lastSect` → {sects (defaults filled), secOf (block → section)}.
 * A sectionBreak ends its section and holds its sect; one with no sect takes the next section's (model/sections.mjs). */
function sectionsOfJson(content, lastSect) {
  const raw = [];
  const secOf = new Int32Array(content.length);
  content.forEach((n, i) => {
    secOf[i] = raw.length;
    if (n.type === 'sectionBreak') raw.push(n.attrs.sect ?? null);
  });
  raw.push(lastSect ?? null);
  for (let i = raw.length - 2; i >= 0; i--) raw[i] ??= raw[i + 1];
  return { sects: raw.map(withDefaults), secOf };
}

// ---------- resolve ----------
const T_TEXT = 0;
const T_TAB = 1;
const T_BR = 2;
const T_BOX = 3;
const T_PTAB = 4;

const sizeOf = (r) => r.size ?? 12;

/** The context of one set of doc attrs (styles, theme, numbering, settings): memos that last until those change. */
function contextOf(attrs, m, o, ratios, ver) {
  const doc = { type: 'doc', attrs };
  const stacks = new Map(); // font name → CSS stack (office.mjs fontStack builds its string each call)
  const charRuns = new Map();
  const list = attrs.styles?.list ?? {};
  const canvasRatio = new Map();
  const ctx = {
    doc, attrs, list, theme: attrs.theme, m, o, ver, drawn: new Set(o.drawn ?? []),
    styles: resolvedAll(attrs.styles),
    stack(name = '+minor') {
      let s = stacks.get(name);
      if (s === undefined) stacks.set(name, (s = fontStack(name, attrs.theme)));
      return s;
    },
    charRun(id) {
      let r = charRuns.get(id);
      if (!r) charRuns.set(id, (r = charRun(list, id) ?? {}));
      return r;
    },
    /** The editor's single line of font `name` over its size; one the editor has not reported comes from the canvas and marks
     * block B (B.fb), which lays out again once the editor's arrives. */
    ratio(name, B) {
      const stack = ctx.stack(name);
      const r = ratios.get(stack);
      if (r != null) return r;
      if (B) B.fb = true;
      let c = canvasRatio.get(stack);
      if (c == null) {
        const a = m.metrics(`200px ${stack}`);
        canvasRatio.set(stack, (c = Math.round(((a.ascU + a.descU) / 200) * 10000) / 10000));
      }
      return c;
    },
  };
  return ctx;
}

/** The canvas font of run `r` at `px`. small-caps is part of the shorthand canvas reads. */
const canvasFont = (r, px, ctx) => `${r.italic ? 'italic ' : ''}${r.smallCaps ? 'small-caps ' : ''}${r.bold ? 'bold ' : ''}${px}px ${ctx.stack(r.font ?? '+minor')}`;

/** Run properties of a text node: the paragraph's run (styleProps), its character style (charRun), its own textStyle, then the
 * bold and italic marks (stylesheet.js and schema.js draw them in that order). → {run, ts (the textStyle attrs), sup}. */
function runOf(base, marks, ctx) {
  let ts = null;
  let bold = null;
  let italic = null;
  let sup = 0;
  for (const m of marks ?? []) {
    if (m.type === 'textStyle') ts = m.attrs;
    else if (m.type === 'bold') bold = true;
    else if (m.type === 'italic') italic = true;
    else if (m.type === 'superscript' || m.type === 'subscript') sup = m.type === 'superscript' ? 'super' : 'sub';
  }
  if (!ts && bold == null && italic == null) return { run: base, ts: null, sup };
  let run = ts?.charStyle ? { ...base, ...ctx.charRun(ts.charStyle) } : { ...base };
  if (ts) for (const k in ts) if (ts[k] != null && k !== 'charStyle') run[k] = ts[k];
  if (bold) run.bold = true;
  if (italic) run.italic = true;
  return { run, ts, sup };
}

/** A text item of `text` in run `run`. sup ('super' or 'sub'): drawn smaller and off the baseline, as the browser's sup and sub
 * (Blink shifts them by a third and a fifth of the parent's size, plus 1 px); position: raised or lowered (vertical-align in pt);
 * scale: Word's character scaling, which the font package draws as one inline-block of the scaled width. `own`: the
 * textStyle's font and size, which the editor's line height reads. */
function textItem(text, run, sup, ctx, own) {
  const parent = sizeOf(run) * PX;
  const px = parent * (sup ? 1 / 1.2 : 1);
  const sc = run.scale > 0 && run.scale !== 100 ? run.scale / 100 : 1;
  const shift = (run.position ?? 0) * PX + (sup === 'super' ? parent / 3 + 1 : sup === 'sub' ? -(parent / 5 + 1) : 0);
  const font = canvasFont(run, px, ctx);
  // kern: w:kern's threshold (pt), as the font package draws it (font-kerning normal from that size up, else none).
  const kern = run.kern > 0 && sizeOf(run) >= run.kern;
  return { k: T_TEXT, text, font, px, ls: (run.spacing ?? run.charSpacing ?? 0) * PX, sc, shift, upper: !!run.caps, ts: own, face: run.font ?? '+minor', kern };
}

/** Text items of `text` into `out`. Where the run's East Asian font has the taller single line, the editor draws each stretch of
 * East Asian characters in it at its own line height (decosOf's data-ea-line): such a stretch is an item of its own in that font,
 * `ea` naming it. */
function pushText(out, text, run, sup, ctx, own, B) {
  const runs = eastAsianRuns(text);
  const name = runs.length ? eaFamily(run.fontEA ?? '+minor', ctx.theme) : null;
  if (!name || ctx.ratio(name, B) <= ctx.ratio(run.font ?? '+minor', B) + 1e-6) {
    out.push(textItem(text, run, sup, ctx, own));
    return;
  }
  const ea = { ...run, font: name };
  let at = 0;
  for (const [a, b] of runs) {
    if (a > at) out.push(textItem(text.slice(at, a), run, sup, ctx, own));
    out.push({ ...textItem(text.slice(a, b), ea, sup, ctx, own), ea: name });
    at = b;
  }
  if (at < text.length) out.push(textItem(text.slice(at), run, sup, ctx, own));
}

/** The inline items of a textblock's (or sdtInline's) `content` into `out`; what the engine does not model marks B.est. */
function inlines(content, base, ctx, out, B) {
  for (const n of content ?? []) {
    switch (n.type) {
      case 'text': {
        const { run, ts, sup } = runOf(base, n.marks, ctx);
        if (run.vanish) break; // document.css hides it
        if (run.em) B.est |= EST.object; // emphasis marks take room over or under the line
        // fx: the textStyle's text effects, whose room grows the line (wp/font/run.mjs fxRoom), as the paragraph drawing reads them.
        const own = ts ? { font: ts.font ?? null, size: ts.size ?? null, fx: ts.effects ?? null } : null;
        const s = n.text;
        let i = 0;
        for (let j = s.indexOf('\t'); j >= 0; j = s.indexOf('\t', i)) {
          if (j > i) pushText(out, s.slice(i, j), run, sup, ctx, own, B);
          out.push({ k: T_TAB });
          i = j + 1;
        }
        if (i < s.length) pushText(out, i ? s.slice(i) : s, run, sup, ctx, own, B);
        break;
      }
      case 'hardBreak': out.push({ k: T_BR }); break;
      case 'field': {
        if (ctx.drawn.has(parseField(n.attrs.code).name)) B.est |= EST.object; // fields-draw draws a barcode, an EQ or a symbol box
        if (n.attrs.result) out.push(textItem(n.attrs.result, runOf(base, n.marks, ctx).run, 0, ctx, null));
        break;
      }
      case 'noteRef': {
        const { run } = runOf(base, n.marks, ctx);
        const it = textItem(n.attrs.mark ?? String(n.__n ?? 1), { ...run, size: sizeOf(run) * 0.65 }, 0, ctx, null);
        it.noHeight = true; // sup[data-note] has line-height 0
        if (n.attrs.kind !== 'endnote') it.note = n; // its line keeps the note's room at the page's foot (notesOf)
        out.push(it);
        B.est |= EST.note; // the note area is laid out from the model, not measured
        break;
      }
      case 'sdtInline': inlines(n.content, base, ctx, out, B); break;
      case 'ptab': out.push({ k: T_PTAB, a: n.attrs }); break;
      case 'image': {
        const wrap = n.attrs.layout?.wrap;
        if (wrap && wrap !== 'inline') {
          B.est |= EST.float; // anchored: text wraps around it (float-layout), not modelled
          break;
        }
        if (!(n.attrs.width > 0 && n.attrs.height > 0)) B.est |= EST.object;
        out.push({ k: T_BOX, w: n.attrs.width ?? 0, h: n.attrs.height ?? 0, va: 'bottom' }); // document.css img: vertical-align bottom
        break;
      }
      case 'chart': {
        if (n.attrs.layout?.wrap && n.attrs.layout.wrap !== 'inline') B.est |= EST.float;
        else out.push({ k: T_BOX, w: (n.attrs.w ?? 0) * PX, h: (n.attrs.h ?? 0) * PX, va: 'baseline' }); // chart/node.js: inline-block on the baseline
        break;
      }
      case 'equation': {
        // ponytail: an equation as its linear text in Cambria Math, a third taller; MathML layout is not modelled.
        const it = textItem(n.attrs.math ?? '', { ...runOf(base, n.marks, ctx).run, font: 'Cambria Math' }, 0, ctx, null);
        it.tall = 1.3;
        out.push(it);
        B.est |= EST.object;
        break;
      }
      case 'ruby': {
        const it = textItem(n.attrs.base ?? '', runOf(base, n.marks, ctx).run, 0, ctx, null);
        it.tall = 1.5; // the reading above
        out.push(it);
        B.est |= EST.object;
        break;
      }
      default: break; // bookmarks and other zero-width markers
    }
  }
}

/** A textblock → P, its resolved record: items, label, paragraph properties, its run and its mark's. */
function resolvePara(node, ctx, table, B) {
  const { doc } = ctx;
  const id = styleIdOf(node);
  const { run: base, para: styled } = styleProps(doc, id, table);
  const para = effectivePara(doc, node, table);
  const P = { node, id, para, base, items: [], label: null };
  inlines(node.content, base, ctx, P.items, B);
  if (node.attrs.frame || styled.frame) B.est |= EST.approx; // a drop cap or frame (its own or its style's) lays out as a plain paragraph
  P.mark = node.attrs.markRun ? { ...base, ...node.attrs.markRun } : base;
  if (node.__label != null) {
    const lvl = levelOf(doc.attrs.numbering, node.__num.numId, node.__num.ilvl) ?? {};
    // The number's run: the paragraph mark's, then the level's own (lists.js labelRun).
    const own = (r) => Object.fromEntries(Object.entries(r ?? {}).filter(([k, v]) => v != null && ['font', 'size', 'bold', 'italic'].includes(k)));
    const lr = { ...base, ...own(node.attrs.markRun), ...own(lvl.run) };
    const suff = lvl.suff ?? 'tab';
    P.label = { text: node.__label + (suff === 'space' ? ' ' : ''), font: canvasFont(lr, sizeOf(lr) * PX, ctx), suff, lvl };
  }
  B.paras.push(P);
  return P;
}

/** Whether a floating object takes room in the flow: inline, top and bottom wrapping, or one too wide for text beside it. */
function floatRoom(layout, wPx, colPx) {
  const wrap = layout?.wrap;
  if (!wrap || wrap === 'inline' || wrap === 'topAndBottom') return true;
  if (wrap === 'front' || wrap === 'behind') return false;
  return wPx > colPx * 0.6; // ponytail: square, tight and through wrap as room only when little text fits beside
}

/** An object block's drawn box: a canvas at its display width (canvas.js: min(dw, 100%) at its artboard's aspect), a text box at
 * its size in pt. → {w, h} px. */
function boxOf(n, colPx, B) {
  const a = n.attrs;
  if (n.type === 'canvas') {
    const w = Math.min(a.dw ?? a.w ?? 0, colPx);
    return { w, h: a.w > 0 ? (w * (a.h ?? 0)) / a.w : 0 };
  }
  if (a.autoFit) B.est |= EST.object; // a text box that grows with its text
  return { w: (a.w ?? 0) * PX, h: (a.h ?? 0) * PX };
}

/** Block `content` into flow entries `out` at `colPx` wide (wrappers flattened, so their paragraphs paginate one by one).
 * Neighbouring textblocks in one parent drop their contextual spacing between them (rules.mjs dropsNext, as the editor draws). */
function resolveBlocks(content, ctx, out, table, colPx, B) {
  let prev = null;
  for (const n of content ?? []) {
    let P = null;
    switch (n.type) {
      case 'paragraph':
      case 'heading':
        P = resolvePara(n, ctx, table, B);
        out.push({ k: 'para', P, w: colPx });
        if (prev) [prev.dropAfter, P.dropBefore] = [dropsNext(me(prev), me(P)), dropsNext(me(P), me(prev))];
        break;
      case 'table':
        out.push(resolveTable(n, ctx, B));
        break;
      case 'sdtBlock':
      case 'fieldBlock':
        resolveBlocks(n.content, ctx, out, table, colPx, B);
        break;
      case 'columns': {
        const inner = [];
        const w = colBoxes(n.attrs, colPx)[0].width;
        resolveBlocks(n.content, ctx, inner, table, w, B);
        out.push({ k: 'cols', inner, count: Math.max(1, n.attrs.count ?? 1), w });
        B.est |= EST.approx; // balanced by an even fold
        break;
      }
      case 'pageBreak':
      case 'columnBreak':
        out.push({ k: 'break' });
        break;
      case 'sectionBreak':
        out.push({ k: 'sbreak', node: n });
        break;
      case 'textBox':
      case 'canvas': {
        const { w, h } = boxOf(n, colPx, B);
        B.box = Math.max(B.box ?? 0, h);
        if (floatRoom(n.attrs.layout, w, colPx)) {
          const d = n.attrs.layout?.dist ?? {};
          out.push({ k: 'box', w, h, top: (d.t ?? 0) * PX, bottom: (d.b ?? 0) * PX });
        } else B.est |= EST.float;
        break;
      }
      default:
        break;
    }
    prev = P;
  }
}
const me = (P) => ({ style: P.id, contextual: P.para.contextual });

/** A table: rows of cells, each cell's blocks resolved with the table's style under its paragraphs (styleProps). */
function resolveTable(n, ctx, B) {
  const style = n.attrs.styleId ?? 'TableNormal';
  const ts = ctx.styles[style]?.table ?? {};
  const margin = { top: 0, left: 5.4, bottom: 0, right: 5.4, ...ts.cellMargin, ...n.attrs.cellMargin };
  const b = n.attrs.borders ?? ts.borders;
  const inner = b?.style ? b : b?.insideH ?? b?.top;
  const rows = (n.content ?? []).map((row) => ({
    attrs: row.attrs,
    cells: (row.content ?? []).map((cell) => {
      const blocks = [];
      const w = (cell.attrs.colwidth ?? []).reduce((a, x) => a + (x ?? 0), 0);
      if (!(w > 0) || (cell.attrs.rowspan ?? 1) > 1) B.est |= EST.approx; // autofit widths, merged rows
      // Word's empty cell end after a nested table takes no height (table-tools autofit.mjs).
      const kids = cell.content ?? [];
      resolveBlocks(hiddenCellEnd(kids.at(-1), kids.at(-2), true) ? kids.slice(0, -1) : kids, ctx, blocks, style, 0, B);
      return { w, span: cell.attrs.colspan ?? 1, rowspan: cell.attrs.rowspan ?? 1, m: { ...margin, ...cell.attrs.margins }, blocks };
    }),
  }));
  return { k: 'table', node: n, rows, rowBorder: borderPx(inner) };
}

// ---------- measure ----------
const cps = (s) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) n++;
  }
  return n;
};

/** The width of `word` (a slice of text item `it`) in px, caps and letter spacing included. */
const wordWidth = (it, word, m) => (word ? (m.width(it.font, it.upper ? word.toUpperCase() : word, it.kern) + (it.ls ? it.ls * cps(word) : 0)) * it.sc : 0);

/** Paragraph P's break opportunities. */
function segmentPara(P) {
  const st = startState();
  for (const it of P.items) {
    if (it.k === T_TEXT && it.sc !== 1) {
      // A scaled run is one inline-block (font/extension.js): it keeps to one line, with break opportunities on both sides.
      [it.sb, it.st, it.b0] = [[0], [it.text.length], true];
      Object.assign(st, { prev: ID, base: ID, pp: ID });
    } else if (it.k === T_TEXT) segment(it, st);
    else if (it.k === T_BR) Object.assign(st, startState());
    else Object.assign(st, { prev: ID, base: ID, pp: ID }); // an atomic inline: break opportunities on both sides
  }
}

/** Paragraph P's word widths it.ww and space widths it.sw (px), its label's width and every font's metrics. */
function measurePara(P, ctx) {
  const { m } = ctx;
  for (const it of P.items) {
    if (it.k !== T_TEXT) continue;
    const s = it.text;
    const { sb, st: tr } = it;
    const ww = new Array(sb.length);
    const sw = new Array(sb.length);
    const space = (m.width(it.font, ' ') + it.ls) * it.sc;
    for (let j = 0; j < sb.length; j++) {
      const t = tr[j];
      ww[j] = wordWidth(it, s.slice(sb[j], t), m);
      sw[j] = ((j + 1 < sb.length ? sb[j + 1] : s.length) - t) * space;
    }
    it.ww = ww;
    it.sw = sw;
    it.space = space;
    it.m = m.metrics(it.font);
  }
  if (P.label) {
    P.label.w = m.width(P.label.font, P.label.text);
    P.label.m = m.metrics(P.label.font);
  }
  P.strutM = m.metrics(canvasFont(P.base, sizeOf(P.base) * PX, ctx));
}

/** Splits segment `j` of text item `it` so its first part fits `room` px, as overflow-wrap: break-word does in the editor and as
 * Word breaks a word wider than the line → true when it split (the item's arrays then hold one segment more). */
function splitSegment(it, j, room, m) {
  if (it.sc !== 1) return false; // an inline-block overflows instead
  const a = it.sb[j];
  const word = it.text.slice(a, it.st[j]);
  if (word.length < 2) return false;
  let lo = 1;
  let hi = word.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (wordWidth(it, word.slice(0, mid), m) <= room + EPS) lo = mid;
    else hi = mid - 1;
  }
  let k = lo;
  const c = word.charCodeAt(k - 1);
  if (c >= 0xd800 && c < 0xdc00) k++; // never between the halves of a surrogate pair
  if (k >= word.length) return false;
  it.sb.splice(j + 1, 0, a + k);
  it.st.splice(j, 0, a + k);
  it.ww.splice(j, 1, wordWidth(it, word.slice(0, k), m), wordWidth(it, word.slice(k), m));
  it.sw.splice(j, 0, 0);
  return true;
}

// ---------- break ----------
/** The editor's CSS line height for paragraph P (wp/paragraph/extension.js decosOf: one value for the whole paragraph, from the
 * tallest single line among its text runs and its mark) → {fixed: px} or {factor}. A static drawing's paragraph (B.static: a note
 * or a separator, drawn without the paragraph decorations) takes the style sheet's instead (stylesheet.js paraCss: a multiple as
 * the CSS factor, any other rule in points, none as the font's own). */
function cssLine(P, ctx, B) {
  if (B.static) {
    const rule = P.para.spacing?.line;
    if (rule?.rule === 'auto' && rule.value > 0) return { factor: rule.value };
    if (rule?.rule && rule.value > 0) return { fixed: rule.value * PX };
    return { factor: ctx.ratio(P.base.font ?? '+minor', B) };
  }
  const metric = (font, size) => {
    const r = ctx.ratio(font, B);
    return { s: size, r, h: r * size };
  };
  const strut = metric(P.base.font ?? '+minor', sizeOf(P.base));
  let top = P.node.attrs.markRun ? metric(P.node.attrs.markRun.font ?? P.base.font ?? '+minor', P.node.attrs.markRun.size ?? sizeOf(P.base)) : null;
  for (const it of P.items) {
    if (it.k !== T_TEXT || it.noHeight) continue;
    const mm = metric(it.ts?.font ?? P.base.font ?? '+minor', it.ts?.size ?? sizeOf(P.base));
    if (!top || mm.h > top.h) top = mm;
  }
  top ??= strut;
  const rule = P.para.spacing?.line;
  // A paragraph that snaps to its section's line grid (B.grid) takes whole grid lines (rules.mjs gridPitch), as decosOf draws.
  const pitch = P.para.snapToGrid === false ? null : B.grid;
  const v = pitch ? `${gridPitch(rule, top.h, pitch)}pt` : strut.h > top.h + 1e-6 ? `${linePitch(rule, top.h)}pt` : lineCss(rule, top.r, top.s);
  // Exactly and the grid: the runs' boxes take no room (decosOf's data-line-fixed), so each line is the strut's.
  const runsAdd = !(pitch || rule?.rule === 'exact');
  // An East Asian item's own line height (decosOf's data-ea-line) → px, or null under Exactly.
  const eaLine = (it) => {
    if (rule?.rule === 'exact') return null;
    const r = ctx.ratio(it.ea, B);
    const size = it.ts?.size ?? sizeOf(P.base);
    const lh = pitch ? `${gridPitch(rule, r * size, pitch)}pt` : lineCss(rule, r, size);
    const px = lh.endsWith('pt') ? parseFloat(lh) * PX : parseFloat(lh) * it.px;
    return pitch && px <= parseFloat(v) * PX + 0.02 ? null : px; // on the grid only where it needs more grid lines
  };
  const pic = lineExtra(rule, top.h) * PX; // the room under a picture that sets its line (paragraph/extension.js --line-extra)
  return v.endsWith('pt') ? { fixed: parseFloat(v) * PX, runsAdd, eaLine, pic } : { factor: parseFloat(v), runsAdd, eaLine, pic };
}

/** Paragraph P's pieces in order: [item index, segment index] packed for the breaker. */
function piecesOf(P) {
  const out = [];
  P.items.forEach((it, i) => {
    if (it.k === T_TEXT) for (let j = 0; j < it.sb.length; j++) out.push(i, j);
    else out.push(i, -1);
  });
  return out;
}

/** Lines of paragraph P in a column `colW` px wide, at most `bodyH` tall per object → P.lines [{top, bottom}] (paragraph content
 * coordinates, in the rule ctx.o.lines picks) and P.h; inline objects' places into P.objs; each line's text with ctx.o.keepText. */
function breakPara(P, colW, ctx, B, bodyH) {
  const pa = P.para;
  const ind = pa.indent ?? {};
  const own = P.node.attrs.indent ?? {};
  let left = (ind.left ?? 0) * PX;
  let first = (ind.firstLine ?? 0) * PX;
  const right = reachRight(ind.right, colW / PX) * PX;
  if (P.label) {
    left = (own.left ?? P.label.lvl.left ?? 0) * PX;
    first = own.firstLine != null ? own.firstLine * PX : -(P.label.lvl.hanging ?? 0) * PX;
  }
  const bd = pa.borders ?? {};
  const bt = edgeRoom(bd.top);
  const bb = edgeRoom(bd.bottom);
  const inner = colW - left - right; // left and right borders sit outside the text (borders/style.css), as in Word
  const { items } = P;
  const hang = ctx.o.spaces === 'hang';
  let tabs = null;
  const tabCtx = () => (tabs ??= tabStopsOf(ctx.doc, P.node));
  const colPt = colW / PX;
  const leftPt = left / PX;
  const rightPt = (colW - right) / PX;
  // The first line starts at the first-line indent, then a list label's box up to its number tab (lists' ::before, whose
  // min-width the tabs pass sets to the number tab when that differs from the hanging indent by more than half a pixel).
  let start0 = first;
  if (P.label) {
    const startPt = leftPt + first / PX;
    if (P.label.suff === 'tab') {
      const t = tabCtx();
      const stop = numStop(startPt + P.label.w / PX, { levelTab: P.label.lvl.tab ?? null, left: leftPt, stops: t.stops, def: t.default });
      const wTab = (stop - startPt) * PX;
      start0 = first + Math.max(P.label.w, Math.abs(wTab + first) > 0.5 ? wTab : -first);
    } else start0 = first + P.label.w;
  }
  const pieces = piecesOf(P);
  let np = pieces.length / 2;
  const lines = [];
  let lineFrom = 0; // the piece the line starts at
  let x = start0;
  let lineNo = 0;
  let lastOpp = -1; // the piece before which the line may break (> lineFrom)
  let ext = 0; // a custom stop past the right indent lets the paragraph run into the margin (tabs/measure.js data-tab-ext)
  const avail = () => inner + ext;
  const boxW = (it) => Math.min(it.w, inner); // document.css img: max-width 100%
  const widthOfTab = (pi, xAt, ln) => {
    const it = items[pieces[pi * 2]];
    const t = tabCtx();
    const c = { stops: t.stops, def: t.default, left: leftPt, right: rightPt, width: colPt, lineStart: leftPt + (ln === 0 ? first / PX : 0), first: ln === 0 };
    const follow = {
      get w() {
        let w = 0;
        for (let q = pi + 1; q < np; q++) {
          const jt = items[pieces[q * 2]];
          if (jt.k !== T_TEXT) break;
          const j = pieces[q * 2 + 1];
          w += jt.ww[j] + jt.sw[j];
        }
        return w / PX;
      },
      dec: null,
    };
    const pen = leftPt + xAt / PX;
    const r = it.k === T_PTAB ? placePtab(pen, it.a, c, follow) : placeTab(pen, c, follow);
    if (!r.wrap && r.stop > rightPt - 0.1) {
      const tail = r.align === 'right' ? 0 : r.align === 'center' ? follow.w / 2 : follow.w;
      ext = Math.max(ext, Math.ceil((Math.min(r.stop + tail, colPt) - rightPt) * PX) + 1);
    }
    return { w: Math.max(0, r.w) * PX, wrap: !!r.wrap };
  };
  const tabW = new Map(); // piece → its width on its line
  const finish = (to, forced) => {
    lines.push({ from: lineFrom, to, forced });
    lineNo++;
    lineFrom = to;
    x = 0;
    lastOpp = -1;
  };
  let guard = 0;
  for (let p = 0; p < np; p++) {
    if (++guard > np * 8 + 1000) break; // never loop forever on a pathological paragraph
    const it = items[pieces[p * 2]];
    const j = pieces[p * 2 + 1];
    const atStart = p === lineFrom;
    if (it.k === T_BR) {
      finish(p + 1, true);
      continue;
    }
    if ((it.k !== T_TEXT || j > 0 || it.b0) && !atStart) lastOpp = p;
    let w;
    let fitW;
    if (it.k === T_TEXT) {
      w = it.ww[j] + it.sw[j];
      fitW = it.ww[j] + (hang || !it.sw[j] ? 0 : it.space);
    } else if (it.k === T_BOX) {
      w = fitW = boxW(it);
    } else {
      const r = widthOfTab(p, x, lineNo);
      if (r.wrap && !atStart) {
        finish(p, false);
        p--;
        continue;
      }
      w = fitW = r.w;
      tabW.set(p, w);
    }
    if (x + fitW <= avail() + EPS || (atStart && lastOpp < 0)) {
      if (atStart && it.k === T_TEXT && it.ww[j] > avail() - x + EPS && splitSegment(it, j, avail() - x, ctx.m)) {
        // A word wider than the line breaks by characters: the rest becomes the next piece.
        const ii = pieces[p * 2];
        for (let q = p + 1; q < np && pieces[q * 2] === ii; q++) pieces[q * 2 + 1]++;
        pieces.splice(p * 2 + 2, 0, ii, j + 1);
        np++;
        w = it.ww[j];
      }
      x += w;
      continue;
    }
    // It does not fit: break before the last opportunity on this line (backtrack to it), or before this piece.
    if (lastOpp > lineFrom) {
      finish(lastOpp, false);
      p = lineFrom - 1;
      continue;
    }
    if (atStart) {
      x += w;
      continue;
    }
    finish(p, false);
    p--;
  }
  if (lineFrom < np || !lines.length || lines.at(-1).forced) lines.push({ from: lineFrom, to: np, forced: false });
  // Heights: Word's rule over each line's tallest single line, or the editor's CSS line boxes (each inline box as tall as the
  // line-height, centred on its font's ascent and descent; a picture's bottom on the line box's, a chart's on the baseline).
  const word = ctx.o.lines === 'word';
  const rule = pa.spacing?.line;
  const css = cssLine(P, ctx, B);
  const strutPx = sizeOf(P.base) * PX;
  const align = pa.textAlign ?? pa.align;
  // A number whose font rises higher than the text's raises the first line by the difference, drawn as the paragraph's padding
  // (paragraph/extension.js labelRaise): the fonts' own ascents, unrounded, as Word's rule takes them.
  let raise = 0;
  if (P.label?.m && P.label.text.trim() && rule?.rule !== 'exact' && !(P.label.lvl.fmt === 'bullet' && /^data:image\//.test(P.label.lvl.pic ?? ''))) {
    let asc = P.strutM.ascU;
    for (const it of items) if (it.k === T_TEXT && !it.noHeight) asc = Math.max(asc, it.m.ascU);
    raise = Math.max(0, P.label.m.ascU - asc);
  }
  let y = bt;
  P.objs = P.noteAt = null;
  P.lines = lines.map((ln, li) => {
    let single = 0;
    let boxH = 0; // pictures: their bottom on the line box's
    let baseH = 0; // charts: their bottom on the baseline
    // Each inline box's extent over and under the baseline: half its leading each side of its font's ascent and descent, shifted
    // where it is raised; negative where the line height is under the font's (exact spacing), so they start at -Infinity.
    let above = -Infinity;
    let below = -Infinity;
    const add = (asc, desc, px, shift = 0, own = null) => {
      const L = own ?? css.fixed ?? css.factor * px;
      above = Math.max(above, (L + asc - desc) / 2 + shift);
      below = Math.max(below, (L - asc + desc) / 2 - shift);
    };
    add(P.strutM.asc, P.strutM.desc, strutPx);
    let texts = 0;
    let w = li === 0 ? start0 : 0; // the line's width without its trailing spaces
    const objs = [];
    for (let p = ln.from; p < ln.to; p++) {
      const it = items[pieces[p * 2]];
      if (it.k === T_TEXT) {
        const j = pieces[p * 2 + 1];
        w += it.ww[j] + (p === ln.to - 1 ? 0 : it.sw[j]);
        if (it.note && j === 0) (P.noteAt ??= []).push([it.note, li]);
        if (it.noHeight) continue;
        texts++;
        const one = ctx.ratio(it.face, B) * it.px;
        // Text effects take room as a taller font (wp/paragraph/extension.js draws the same box): in pt, then px.
        const room = it.ts?.fx && fxRoom(it.ts.fx, it.px / PX, one / PX, it.m.descU / PX);
        if (word) single = Math.max(single, one * (it.tall ?? 1) + (room && rule?.rule !== 'exact' ? (room.up + room.down) * PX : 0));
        const own = it.ea && css.eaLine ? (it.eaL === undefined ? (it.eaL = css.eaLine(it)) : it.eaL) : null;
        if (own != null || css.runsAdd !== false) add(it.m.asc, it.m.desc, it.px, it.shift, own);
        const fx = room && fxBox(room, rule, (css.fixed ?? css.factor * it.px) / PX, one / PX);
        if (fx) {
          const mid = (it.m.asc - it.m.desc) / 2 + (fx.v * PX) + it.shift;
          above = Math.max(above, (fx.h * PX) / 2 + mid);
          below = Math.max(below, (fx.h * PX) / 2 - mid);
        }
      } else if (it.k === T_BOX) {
        const bh = Math.min(it.h, bodyH); // document.css img: max-height the page body
        if (it.va === 'baseline') baseH = Math.max(baseH, bh);
        else boxH = Math.max(boxH, bh);
        objs.push({ x: w, w: boxW(it), h: bh, va: it.va });
        w += boxW(it);
      } else w += tabW.get(p) ?? 0;
    }
    if (word && (!texts || li === lines.length - 1)) single = Math.max(single, ctx.ratio(P.mark.font ?? '+minor', B) * sizeOf(P.mark) * PX);
    above = Math.max(above, baseH);
    const pic = boxH ? boxH + (css.pic ?? 0) : 0; // a picture at the line's top, the multiple's room under it
    const h = Math.max(word ? linePitch(rule, Math.max(single, baseH) / PX) * PX : above + below, pic) + (li === 0 ? raise : 0);
    const out = { top: y, bottom: y + h };
    if (objs.length) {
      // Each object's place from the paragraph's left text edge and top: the line's alignment shifts it.
      const room = inner + ext - w;
      const shift = align === 'center' ? room / 2 : align === 'right' || align === 'end' ? room : 0;
      for (const o of objs) (P.objs ??= []).push({ line: li, x: left + o.x + Math.max(0, shift), y: o.va === 'baseline' && !word ? y + above - o.h : y + h - (css.pic ?? 0) - o.h, w: o.w, h: o.h });
    }
    y += h;
    if (ctx.o.keepText) {
      out.text = lineText(P, pieces, ln.from, ln.to);
      out.w = w;
    }
    return out;
  });
  P.avail = inner + ext;
  P.h = y + bb;
}

/** The text of pieces [from, to) of paragraph P: segment text with trailing spaces, tabs as \t, boxes as nothing. */
function lineText(P, pieces, from, to) {
  let s = '';
  for (let p = from; p < to; p++) {
    const it = P.items[pieces[p * 2]];
    const j = pieces[p * 2 + 1];
    if (it.k === T_TEXT) s += it.text.slice(it.sb[j], j + 1 < it.sb.length ? it.sb[j + 1] : it.text.length);
    else if (it.k === T_TAB || it.k === T_PTAB) s += '\t';
  }
  return s;
}

/** Paragraph P's own space before and after (Auto spacing as the editor draws it), in px. */
function spaceOf(P) {
  const sp = P.para.spacing ?? {};
  return [(sp.beforeAuto ? AUTO_SPACE : sp.before ?? 0) * PX, (sp.afterAuto ? AUTO_SPACE : sp.after ?? 0) * PX];
}

/** Flow entries `list` in a column `colW` px wide → their lines and heights. */
function breakBlocks(list, colW, ctx, B, bodyH) {
  for (const e of list) {
    if (e.k === 'para') {
      breakPara(e.P, e.w || colW, ctx, B, bodyH);
      [e.before, e.after] = spaceOf(e.P);
      if (e.P.dropBefore) e.before = 0;
      if (e.P.dropAfter) e.after = 0;
    } else if (e.k === 'table') breakTable(e, colW, ctx, B, bodyH);
    else if (e.k === 'cols') breakBlocks(e.inner, e.w, ctx, B, bodyH);
  }
}

/** The stacked height of flow entries `list` (margins collapsing between paragraphs, as CSS does) and every line's place →
 * {h, lines: [{top, bottom}]}. Used inside table cells and columns. */
function stack(list) {
  let y = 0;
  let after = 0;
  let firstTop = true;
  const lines = [];
  const block = (h) => {
    y += after;
    after = 0;
    lines.push({ top: y, bottom: y + h });
    y += h;
  };
  for (const e of list) {
    if (e.k === 'para') {
      y += firstTop ? e.before : collapse(after, e.before);
      for (const l of e.P.lines) lines.push({ top: y + l.top, bottom: y + l.bottom });
      y += e.P.h;
      after = e.after;
    } else if (e.k === 'table') for (const r of e.rowsOut) block(r.h);
    else if (e.k === 'box') block(e.top + e.h + e.bottom);
    else if (e.k === 'cols') {
      y += after;
      after = 0;
      const s = colsOf(e);
      for (const l of s.lines) lines.push({ top: y + l.top, bottom: y + l.bottom });
      y += s.h;
    }
    firstTop = false;
  }
  return { h: y + after, lines };
}

/** Balanced columns: the content's stacked lines folded into `count` columns of equal height. ponytail: an even fold, so column
 * breaks and lines that do not divide evenly are not modelled. */
function colsOf(e) {
  const s = stack(e.inner);
  const n = e.count;
  return { h: s.h / n, lines: s.lines.map((l) => ({ top: l.top / n, bottom: l.bottom / n })) };
}

/** A table in a column `colW` px wide: each cell's blocks at its width less its margins, each row's height (its cells, its height
 * rule, one border) and the lines of its tallest cell, where a row that may split breaks. */
function breakTable(T, colW, ctx, B, bodyH) {
  T.rowsOut = T.rows.map((row) => {
    let h = 0;
    let tall = null;
    for (const c of row.cells) {
      const w = c.w > 0 ? c.w : colW / Math.max(1, row.cells.length);
      breakBlocks(c.blocks, Math.max(1, w - (c.m.left + c.m.right) * PX), ctx, B, bodyH);
      const s = stack(c.blocks);
      const ch = s.h + (c.m.top + c.m.bottom) * PX;
      if (c.rowspan > 1) continue; // ponytail: a vertically merged cell does not size its rows
      if (ch > h) {
        h = ch;
        tall = s.lines.map((l) => ({ top: l.top + c.m.top * PX, bottom: l.bottom + c.m.top * PX }));
      }
    }
    const rule = row.attrs?.height;
    if (rule?.value) h = rule.rule === 'exact' ? rule.value * PX : Math.max(h, rule.value * PX);
    h += T.rowBorder;
    const keepNext = row.cells.every((c) => c.blocks.every((b) => b.k !== 'para' || keepsOf(ctx.doc, asBlock(b.P.node)).keepNext));
    return { h, lines: tall ?? [], cantSplit: !!row.attrs?.cantSplit || rule?.rule === 'exact', header: !!row.attrs?.header, keepNext };
  });
}

// page-engine's keepsOf reads ProseMirror nodes; a JSON textblock answers the same questions (attrs, type, isTextblock).
const asBlock = (node) => ({ isTextblock: true, type: node.type, attrs: node.attrs });

// ---------- footnotes ----------
// The footnote area as notes/area.js gives it to the page engine (footnoteLayer.notes): each note's height and its first line's,
// kept with its reference's line, and the separators' room above them. A note is drawn as notes/draw.js noteBox draws it: its
// blocks at the text width, its label in the reference style leading the first paragraph.
// ponytail: the label counts on through the document from the document's numbering start (no restart per section or page), a
// reference inside a table or columns keeps no room, and a note's first line ends at its line box (the editor reads its glyphs,
// a few px higher); endnotes collect at the document's end, which is not laid out.
const REF_MARKS = [{ type: 'textStyle', attrs: { charStyle: STYLE_IDS.footnote.ref } }, { type: 'superscript' }];

/** A record of `content` (block JSON) laid out on its own at `r`'s width, as a top-level block is. */
function storyOf(content, r, ctx) {
  const q = { node: { type: 'sdtBlock', content: content?.length ? content : [{ type: 'paragraph', attrs: {} }] }, width: r.width, bodyH: r.bodyH,
    entries: [], objs: [], est: 0, paras: [], fb: false, static: true };
  layoutBlocks([q], ctx, () => {});
  if (q.fb) r.fb = true; // a canvas ratio stood in: the block lays out again when the editor's arrives
  return q.entries;
}

/** Laid out entries `list` stacked as one box whose first and last margins collapse out of it (a div's, as the measurer reads its
 * offsetHeight) → {h, first (its first line's bottom)}. */
function boxOfEntries(list) {
  let y = 0;
  let after = 0;
  let first = null;
  list.forEach((e, i) => {
    if (e.k === 'para') {
      if (i) y += collapse(after, e.before);
      first ??= y + (e.unit.rel[0]?.bottom ?? e.unit.h);
      y += e.unit.h;
      after = e.after;
      return;
    }
    const us = e.units ?? (e.unit ? [e.unit] : []);
    y += after;
    after = 0;
    first ??= y + (us[0]?.rel?.[0]?.bottom ?? us[0]?.h ?? 0);
    for (const u of us) y += u.h;
  });
  return { h: y, first: first ?? 0 };
}

/** Footnote `node` (a noteRef) as the editor draws it below its page's text → {h, first}. */
function noteSize(node, r, ctx) {
  const pr = effectivePr('footnote', ctx.attrs.settings, null);
  const label = node.attrs.mark ?? noteNumber(pr.numStart + (node.__n ?? 1) - 1, pr.numFmt);
  const [head, ...rest] = node.attrs.content?.length ? node.attrs.content : [{ type: 'paragraph', attrs: {} }];
  const content = isText(head) ? [{ ...head, content: [{ type: 'text', text: label, marks: REF_MARKS }, { type: 'text', text: ' ' }, ...(head.content ?? [])] }, ...rest]
    : [head, ...rest];
  return boxOfEntries(storyOf(content, r, ctx));
}

/** The separators' room above a page's footnotes (area.js seps): the taller of the separator and the continuation separator, and
 * the continuation notice under them. Word's default separators are 12 pt boxes (notes/style.css) and its notice is empty. */
function sepsOf(r, ctx) {
  const sep = effectivePr('footnote', ctx.attrs.settings, null).sep;
  const h = (which, def) => (Array.isArray(sep?.[which]) ? boxOfEntries(storyOf(sep[which], r, ctx)).h : def);
  return Math.max(h('separator', 12 * PX), h('continuationSeparator', 12 * PX)) + h('continuationNotice', 0);
}

// ---------- a block's record ----------
/** The units (planPages' input, ft and fb set by the flow) and object frames of a laid out block's entries. */
function unitsOfEntries(r, ctx) {
  const base = { section: 0, child: 0, table: null, header: false, keepNext: false, keepLines: false, widow: false, breakBefore: false, k: 1 };
  r.entries.forEach((e, sub) => {
    if (e.k === 'para') {
      e.unit = { ...base, ...keepsOf(ctx.doc, asBlock(e.P.node)), kind: 'text', sub, h: e.P.h, rel: e.P.lines.map(({ top, bottom }) => ({ top, bottom })) };
      if (e.P.noteAt) e.unit.notes = e.P.noteAt.map(([node, line]) => ({ line, ...noteSize(node, r, ctx) }));
      for (const o of e.P.objs ?? []) r.objs.push({ sub, ...o });
      if (ctx.o.keepText) e.text = e.P.lines;
      [e.id, e.contextual] = [e.P.id, e.P.para.contextual];
      e.P = null; // the items and their widths are not kept: a block lays out whole again when its key changes
    } else if (e.k === 'table') {
      e.units = e.rowsOut.map((row, i) => ({ ...base, kind: row.cantSplit ? 'block' : 'text', sub: i, h: row.h, rel: row.lines, header: row.header, keepNext: row.keepNext }));
      e.rows = e.rowsOut = null;
    } else if (e.k === 'box') {
      e.unit = { ...base, kind: 'block', sub, h: e.top + e.h + e.bottom, rel: [] };
      r.objs.push({ sub, line: 0, x: 0, y: e.top, w: e.w, h: e.h });
    } else if (e.k === 'cols') {
      const s = colsOf(e);
      e.unit = { ...base, kind: 'text', sub, h: s.h, rel: s.lines };
      if (ctx.o.keepText) e.paras = e.inner.filter((k) => k.k === 'para').map((k) => k.P.lines);
      e.inner = null;
    } else if (e.k === 'break') e.unit = { ...base, kind: 'break', sub, h: 0, start: 'page' };
  });
}

// ---------- the layout ----------
/** The engine's state over measurer `m` (width(font, text), metrics(font)) with rules `opts` (RULES): open(doc JSON), edit(change),
 * correct(block, px), ratios({stack: ratio}), fonts(), run() → the layout, lines(blocks) → each block's lines with their text. */
export function createLayout(m, opts = {}) {
  const o = { ...RULES, ...opts };
  const ratios = new Map(Object.entries(o.ratios ?? {}));
  const cache = new WeakMap(); // top-level node → its record
  const dom = new WeakMap(); // top-level node → its height as the editor measured it
  let doc = null;
  let ctx = null;
  let ver = 0; // +1 per context: a key never matches across style changes
  let fbVer = 0; // +1 when the editor reports ratios a block took from the canvas
  let counting = true;
  let from = 0; // the first block changed since the last run
  let last = null;

  const self = {
    /** A fresh document: the doc JSON (top-level content array and attrs). */
    open(json) {
      doc = { ...json, content: [...(json.content ?? [])] };
      [ctx, counting, from, last] = [null, true, 0, null];
    },
    /** Top-level children [from, to) replaced by `nodes` (doc JSON), and doc `attrs` keys replaced by their new values. */
    edit({ from: a, to: b, nodes = null, attrs = null }) {
      if (nodes) {
        const old = doc.content.splice(a, b - a, ...nodes);
        if (!counting && !keepCount(old, nodes, doc)) counting = true;
        from = Math.min(from, a);
      }
      if (attrs) {
        doc.attrs = { ...doc.attrs, ...attrs };
        if (['styles', 'theme', 'numbering', 'settings'].some((k) => k in attrs)) ctx = null;
        if ('styles' in attrs || 'numbering' in attrs) counting = true;
        from = 0;
      }
    },
    /** The editor measured top-level block `i` at `px` tall: that figure stands until the block's content changes. */
    correct(i, px) {
      const node = doc.content[i];
      if (!node || !(px >= 0) || dom.get(node) === px) return;
      dom.set(node, px);
      from = Math.min(from, i);
    },
    /** A font finished loading (the measurer forgot its widths): every block lays out again. */
    fonts() {
      ctx = null;
    },
    /** The editor's single line ratios by font stack (RULES.ratios): new stacks lay out again the blocks that went without. */
    ratios(more) {
      let fresh = false;
      for (const [k, v] of Object.entries(more ?? {})) {
        if (ratios.get(k) === v) continue;
        if (ratios.has(k)) ctx = null; // a ratio changed (a font loaded): every block lays out again
        ratios.set(k, v);
        fresh = true;
      }
      if (fresh) {
        fbVer++;
        from = 0;
      }
    },
    run() {
      const t = {};
      const t00 = now();
      let t0 = t00;
      const lap = (k) => {
        const t1 = now();
        t[k] = (t[k] ?? 0) + t1 - t0;
        t0 = t1;
      };
      if (!ctx) {
        ctx = contextOf(doc.attrs, m, o, ratios, ++ver);
        from = 0;
      }
      if (counting) {
        count(doc);
        counting = false;
      }
      lap('count');
      const kids = doc.content;
      const n = kids.length;
      const { sects, secOf } = sectionsOfJson(kids, doc.attrs.sect);
      const set = doc.attrs.settings ?? {};
      const bodies = sects.map((s) => bodyOf(paperOf(s, { gutterAtTop: !!set.gutterAtTop }), []).height);
      const widths = sects.map((s) => columnWidthOf(s, set));
      const lineGrids = sects.map(gridOf);
      // The blocks whose key changed: their width, their section's body, the context and the labels and numbers they show.
      const recs = new Array(n);
      const dirty = [];
      for (let i = 0; i < n; i++) {
        const node = kids[i];
        const s = secOf[i];
        const sig = node.__sig ?? '';
        let r = cache.get(node);
        if (!r || r.width !== widths[s] || r.bodyH !== bodies[s] || r.grid !== lineGrids[s] || r.ver !== ctx.ver || r.sig !== sig || (r.fb && r.fbVer !== fbVer)) {
          r = { node, width: widths[s], bodyH: bodies[s], grid: lineGrids[s], ver: ctx.ver, sig, entries: [], objs: [], est: 0, paras: [], fb: false, fbVer };
          cache.set(node, r);
          dirty.push(r);
          from = Math.min(from, i);
        }
        recs[i] = r;
      }
      const m0 = { ...m.stats };
      layoutBlocks(dirty, ctx, lap);
      t.measureText = m.stats.ms - m0.ms;
      // The flow: every block's units at their place, margins collapsing between blocks, the editor's heights where it gave them.
      const units = [];
      const heights = new Float64Array(n);
      const tops = new Float64Array(n);
      const est = new Uint8Array(n);
      let y = 0;
      let after = 0;
      let drop = false;
      let section = 0;
      let tid = 0;
      for (let i = 0; i < n; i++) {
        const r = recs[i];
        const u0 = units.length;
        let top = null;
        for (const e of r.entries) {
          if (e.k === 'para') {
            let before = drop ? 0 : e.before;
            // Contextual spacing between top-level neighbours (resolveBlocks did it inside blocks).
            if (e === r.entries[0] && i > 0 && isText(r.node) && isText(kids[i - 1]) && recs[i - 1].entries.length === 1) {
              const p = recs[i - 1].entries[0];
              if (p.id === e.id) { // rules.mjs dropsNext: contextual spacing between two paragraphs of one style
                if (e.contextual) before = 0;
                if (p.contextual) after = 0;
              }
            }
            drop = false;
            y += units.length ? collapse(after, before) : before;
            after = e.after;
            top ??= y;
            place(e.unit, y, i, section);
            units.push(e.unit);
            y += e.unit.h;
          } else if (e.k === 'table') {
            y += after;
            after = 0;
            drop = false;
            top ??= y;
            tid++;
            for (const u of e.units) {
              place(u, y, i, section);
              u.table = tid;
              units.push(u);
              y += u.h;
            }
          } else if (e.k === 'box' || e.k === 'cols') {
            y += after;
            after = 0;
            drop = false;
            top ??= y;
            place(e.unit, y, i, section);
            units.push(e.unit);
            y += e.unit.h;
          } else if (e.k === 'break') {
            top ??= y;
            place(e.unit, y, i, section);
            units.push(e.unit);
            after = 0;
            drop = true;
          } else if (e.k === 'sbreak') {
            top ??= y;
            const start = startOf(e.node.attrs.kind, sects[section], sects[section + 1]);
            section = Math.min(section + 1, sects.length - 1);
            if (start !== 'none') {
              units.push({ kind: 'break', ft: y, fb: y, child: i, sub: 0, section, start, k: 1, rel: [] });
              after = 0;
            }
          }
        }
        top ??= y;
        let h = units.length > u0 ? y - top : r.box ?? 0;
        let bits = r.est;
        const px = dom.get(r.node);
        if (px != null && units.length > u0 && h > 0) {
          // The editor's figure: the block's units stretch to it, about the block's top.
          const k = px / h;
          for (let j = u0; j < units.length; j++) {
            const u = units[j];
            [u.ft, u.fb, u.k] = [top + (u.ft - top) * k, top + (u.fb - top) * k, k];
          }
          y = top + px;
          h = px;
          bits |= EST.dom;
        }
        if (h > bodies[secOf[i]] + 0.5) bits |= EST.oversize;
        heights[i] = h;
        tops[i] = top;
        est[i] = bits;
      }
      // The footnotes, each kept with its reference's line (at the line's middle, as the page engine reads a reference).
      const list = [];
      for (const u of units) {
        for (const nt of u.notes ?? []) {
          const l = u.rel[nt.line];
          if (l) list.push({ y: u.ft + ((l.top + l.bottom) / 2) * u.k, h: nt.h, first: nt.first, child: u.child });
        }
      }
      const notes = list.length ? { sep: (ctx.seps ??= sepsOf(recs[list[0].child], ctx)), list } : null;
      lap('flow');
      const sectOf = (s) => sects[s] ?? sects.at(-1);
      const linesOf = (j) => {
        const u = units[j];
        return u.rel.map((l) => ({ top: u.ft + l.top * u.k, bottom: u.ft + l.bottom * u.k }));
      };
      // ponytail: planPages runs over the whole flow after every change (1 to 3 ms for the Word fixture's 10,000 units); starting it
      // at the edited page would save that, and needs planPages to take a page's state (number, section, header rows) to start from.
      const planned = planPages({
        units, linesOf, sectOf,
        size: ({ section: s, number }) => {
          const b = bodyOf(paperOf(sectOf(s), { mirror: !!set.mirrorMargins, gutterAtTop: !!set.gutterAtTop, number }), []);
          return { topOff: b.topOff, botOff: b.botOff, bodyH: b.height };
        },
        v1Start: doc.attrs.sect?.pageNumber?.start ?? null,
        notes,
      });
      lap('paginate');
      // Page starts: the block, the unit in it (a row, a wrapper's paragraph), the line in that, and px down from the block's top.
      const pages = planned.map((p) => {
        const u = units[p.firstUnit];
        const s = sectOf(p.section);
        return { block: u ? u.child : n, sub: u ? u.sub : 0, line: p.firstLine, y: u ? Math.max(0, p.F - tops[u.child]) : 0, number: p.number,
          section: p.section, blank: !!p.blank, est: !!(s.hdr || s.ftr), F: p.F, push: p.push };
      });
      // Object frames on their pages: from the text area's top left, px.
      const frames = [];
      const pageAt = (fy) => { // the last page whose content starts at or above fy (a blank page shares its next page's F)
        let lo = 0;
        let hi = pages.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (pages[mid].F <= fy + 0.5) lo = mid;
          else hi = mid - 1;
        }
        return lo;
      };
      for (let i = 0; i < n; i++) {
        const r = recs[i];
        for (const f of r.objs) {
          const u = r.entries[f.sub]?.unit;
          if (!u || u.ft == null) continue;
          const fy = u.ft + f.y * u.k;
          const p = pageAt(fy);
          frames.push({ block: i, page: p, x: f.x, y: fy - pages[p].F + pages[p].push, w: f.w, h: f.h * u.k });
        }
      }
      for (const p of pages) delete p.F, delete p.push;
      // The first page whose start moved, for the change event.
      let changed = 0;
      if (last) while (changed < pages.length && changed < last.length && samePage(pages[changed], last[changed])) changed++;
      last = pages;
      lap('out');
      t.total = now() - t00;
      const result = { heights, est, pages, count: pages.length, blanks: pages.filter((p) => p.blank).length, frames, changed, from,
        t, counts: { blocks: n, relaid: dirty.length, units: units.length, ...m.stats } };
      from = n;
      return result;
    },
    /** Top-level blocks `list` laid out again with each line's text and width (diagnostics, not cached) → [[{text, w, h}] per
     * paragraph] per block. */
    lines(list) {
      if (!ctx || counting) self.run();
      const keep = o.keepText;
      o.keepText = true;
      const { sects, secOf } = sectionsOfJson(doc.content, doc.attrs.sect);
      const set = doc.attrs.settings ?? {};
      const out = list.map((i) => {
        const node = doc.content[i];
        if (!node) return null;
        const s = sects[secOf[i]];
        const r = { node, width: columnWidthOf(s, set), bodyH: bodyOf(paperOf(s, { gutterAtTop: !!set.gutterAtTop }), []).height, grid: gridOf(s), entries: [], objs: [], est: 0, paras: [], fb: false };
        layoutBlocks([r], ctx, () => {});
        return r.entries.flatMap((e) => (e.k === 'para' ? [e.text] : e.paras ?? [])).map((ls) => ls.map((l) => ({ text: l.text, w: l.w, h: l.bottom - l.top })));
      });
      o.keepText = keep;
      return out;
    },
  };
  return self;
}

const place = (u, y, child, section) => {
  u.ft = y;
  u.fb = y + u.h;
  u.child = child;
  u.section = section;
  u.k = 1;
};

const samePage = (a, b) => a.block === b.block && a.sub === b.sub && a.line === b.line && Math.abs(a.y - b.y) < 0.01 && a.number === b.number && a.blank === b.blank;

/** Lays out records `dirty` (their node, width and section body) in phases, `lap(phase)` timing each. */
function layoutBlocks(dirty, ctx, lap) {
  for (const r of dirty) resolveBlocks([r.node], ctx, r.entries, null, r.width, r);
  lap('resolve');
  for (const r of dirty) for (const P of r.paras) segmentPara(P);
  lap('segment');
  for (const r of dirty) for (const P of r.paras) measurePara(P, ctx);
  lap('measure');
  for (const r of dirty) {
    breakBlocks(r.entries, r.width, ctx, r, r.bodyH);
    unitsOfEntries(r, ctx);
    r.paras = null;
  }
  lap('break');
}
