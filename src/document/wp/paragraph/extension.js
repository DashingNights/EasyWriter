// The paragraph work package's editor extensions (docs/plans/word/briefs/paragraph.md): Word's indent steps, Ctrl+T and Ctrl+Q
// over the schema's commands of the same names, the alignment chords as toggles, and one decoration plugin that draws Word's
// line heights, Auto and contextual spacing, mirror indents and the Asian layouts (Fit Text, Two Lines in One, Combine Characters).
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { keyAmong } from '../../../app/keybinds.js';
import { eaFamily, eastAsianRuns, fontStack } from '../../../office.mjs';
import { run } from '../../../tooling/registry.js';
import { localFace } from '../../fonts.js';
import { ascentOf, singleLine, stackMetrics } from '../../fonts/metrics.mjs';
import { geometryOf } from '../../geometry.js';
import { labelRun, numberingOf, textblocks } from '../../lists.js';
import { levelOf, numOf } from '../../numbering.mjs';
import { changedSet } from '../page-engine/decorations.js';
import { sectionAt, sectionsOf } from '../../model/sections.mjs';
import { styleIdOf } from '../../model/styles.mjs';
import { drawnAsBlock, fxBox, fxRoom } from '../font/run.mjs';
import { boxOf, rubyRoom } from '../font/ruby.mjs';
import { AUTO_SPACE, DIRECT, LINE_REACH, dropsNext, effectivePara, gridOf, gridPitch, hang, lineCss, lineExtra, linePitch, nextStop, prevStop, round2, styleProps } from './rules.mjs';

const stepOf = (doc) => doc.attrs.settings?.defaultTabStop || 36;
const inList = (state) => textblocks(state).some(({ node }) => node.attrs.numbering);

/** A command running `fn(tr, node, pos)` on every paragraph and heading the selection touches; false where there is none. */
const each = (fn) => ({ state, tr, dispatch }) => {
  const paras = textblocks(state);
  if (!paras.length) return false;
  if (dispatch) for (const { node, pos } of paras) fn(tr, tr.doc.nodeAt(pos) ?? node, pos);
  return true;
};

/** `node`'s indent with `patch` ({left, firstLine}) written so that a value its style already gives is null (inherited). */
function writeIndent(tr, node, pos, patch) {
  const style = styleProps(tr.doc, styleIdOf(node)).para.indent ?? {};
  const indent = { ...node.attrs.indent };
  for (const [k, v] of Object.entries(patch)) {
    const want = v ?? 0;
    if (round2(want) === round2(style[k] ?? 0)) delete indent[k];
    else indent[k] = round2(want);
  }
  tr.setNodeAttribute(pos, 'indent', Object.keys(indent).length ? indent : null);
}

const leftOf = (doc, node) => effectivePara(doc, node).indent?.left ?? 0;

/** Word's indent commands and Ctrl+Q, replacing the schema's (a lower priority than ParaProps' 101 wins the command name). */
export const ParagraphCommands = Extension.create({
  name: 'wordParagraphCommands',
  priority: 50,
  addCommands() {
    return {
      // Increase and Decrease Indent (and Ctrl+M, Ctrl+Shift+M): the next or previous multiple of the default tab stop from the
      // margin, never below 0; in a list, one level (lists.js).
      increaseIndent: () => ({ state, commands }) => (inList(state) ? commands.sinkListLevel()
        : commands.command(each((tr, node, pos) => writeIndent(tr, node, pos, { left: nextStop(leftOf(tr.doc, node), stepOf(tr.doc)) })))),
      decreaseIndent: () => ({ state, commands }) => (inList(state) ? commands.liftListLevel()
        : commands.command(each((tr, node, pos) => writeIndent(tr, node, pos, { left: prevStop(leftOf(tr.doc, node), stepOf(tr.doc)) })))),
      // Ctrl+T and Ctrl+Shift+T: one default tab stop more or less hanging indent, the first line staying put.
      setHanging: (on) => each((tr, node, pos) => {
        const i = effectivePara(tr.doc, node).indent ?? {};
        writeIndent(tr, node, pos, hang({ left: i.left ?? 0, firstLine: i.firstLine ?? 0 }, stepOf(tr.doc), on !== false));
      }),
      // Ctrl+Q: every direct paragraph property goes back to the style; the style and the list stay.
      clearParagraph: () => each((tr, node, pos) => {
        tr.setNodeMarkup(pos, null, { ...node.attrs, ...Object.fromEntries(DIRECT.filter((k) => k in node.attrs).map((k) => [k, null])) });
      }),
    };
  },
});

// The app's alignment chords (Ctrl+L, E, R, J through their keybinding ids, so a user's own binding still counts) run the ribbon
// toggles, so pressing Ctrl+E on a centred paragraph aligns it left again, as in Word.
const ALIGN_KEYS = { 'document.alignLeft': 'home.paragraph.alignLeft', 'document.alignCenter': 'home.paragraph.center',
  'document.alignRight': 'home.paragraph.alignRight', 'document.justify': 'home.paragraph.justify' };
const ALIGN_IDS = Object.keys(ALIGN_KEYS);

/** The alignment chords, ahead of the Document's text keys (textKeys, priority 1100). */
export const ParagraphKeys = Extension.create({
  name: 'wordParagraphKeys',
  priority: 1150,
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleKeyDown(_view, e) {
          const id = keyAmong(ALIGN_IDS, e);
          if (!id) return false;
          run(ALIGN_KEYS[id]);
          return true;
        },
      },
    })];
  },
});

// ---------- drawing ----------
// font-family stack → its single line over the font size: Word's, from the font file where it can be read, else line-height
// normal as measured (the layout predictor reads it, so the editor and the predictor draw the same lines).
export const ratios = new Map();
const files = new Map(); // stack → a promise of Word's single line from its font file, or null (none readable)
const fromFile = new Map(); // stack → that figure once read: the measured one stays where it is null
const ascents = new Map(); // stack → Word's ascent over the size from its font file (ascOf)
const guessed = new Set(); // stacks whose ascent a drawing took before their file was read, redrawn when it is
const drawings = new Set(); // the views the drawing plugin runs in, redrawn when a file's ratio replaces a measured one
let reading = null; // the promises of the stacks whose files are being read, each true when it changed a drawn ratio

/** The single line of font stack `stack` over its size (1.15 without a DOM). */
function ratioOf(stack) {
  if (!ratios.has(stack)) measureRatios([stack]);
  return ratios.get(stack);
}

/** Reads Word's single line of `stack` from its font file (fonts/metrics.mjs) → a promise that settles once it is in `ratios`. The
 * browser's line-height normal is close (Chromium takes the same font tables) but rounds each part to whole pixels; on Times New
 * Roman 1.145 against Word's 1.15. The reads of one task settle together, and the drawing is redrawn once if any changed a ratio
 * it had drawn with (preloadRatios reads a document's before its first draw, so that it lays out once).
 * ponytail: the regular face stands for the family, as the measure did; bold and italic faces share it in the fonts checked
 * (Aptos, Calibri, Times New Roman, Arial), and Arial Narrow's differ by 1%: a stack per face if a family's faces ever differ more. */
function readFile(stack) {
  if (files.has(stack)) return files.get(stack);
  const p = stackMetrics(stack, localFace).catch(() => null).then((m) => {
    const r = m && singleLine(m);
    fromFile.set(stack, r);
    if (r == null) return false;
    ascents.set(stack, ascentOf(m));
    const drawn = (ratios.has(stack) && Math.abs(r - ratios.get(stack)) >= 1e-6) || guessed.has(stack);
    ratios.set(stack, r);
    return drawn;
  });
  files.set(stack, p);
  if (!reading) {
    reading = [];
    setTimeout(async () => {
      const batch = reading;
      reading = null;
      if (!(await Promise.all(batch)).some(Boolean)) return;
      for (const view of drawings) if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(KEY, 'full').setMeta('addToHistory', false));
    });
  }
  reading.push(p);
  return p;
}

/** Reads Word's single lines of the fonts Document JSON `doc` names (its theme's, its styles' and its runs') before its editor first
 * draws, so its pages lay out once rather than again when the files arrive → a promise that settles when they are read, or after
 * half a second at most (a browser that asks the user for font access). */
export function preloadRatios(doc) {
  if (typeof document === 'undefined' || !doc) return Promise.resolve();
  const names = new Set(['+minor', '+major']);
  // The theme's East Asian fonts, whose single lines size the lines of East Asian text (decosOf).
  for (const t of ['+minor', '+major']) if (eaFamily(t, doc.attrs?.theme)) names.add(eaFamily(t, doc.attrs.theme));
  const styles = doc.attrs?.styles;
  for (const s of [styles?.defaults, ...Object.values(styles?.list ?? {})]) if (s?.run?.font) names.add(s.run.font);
  const walk = (n) => {
    if (n.attrs?.markRun?.font) names.add(n.attrs.markRun.font);
    for (const m of n.marks ?? []) if (m.type === 'textStyle' && m.attrs?.font) names.add(m.attrs.font);
    for (const k of n.content ?? []) walk(k);
  };
  walk(doc);
  const reads = [...names].map((n) => readFile(fontStack(n, doc.attrs?.theme)));
  return Promise.race([Promise.all(reads), new Promise((r) => setTimeout(r, 500))]);
}

/** Measures the single lines of `stacks` together: one layout read for all of them (each read lays out whatever the document has
 * pending, which on a long document costs seconds), in a box whose layout is its own. A stack whose file was read keeps Word's. */
function measureRatios(stacks) {
  if (typeof document === 'undefined' || !document.body) {
    for (const s of stacks) ratios.set(s, 1.15);
    return;
  }
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;width:0;height:0;contain:strict';
  const els = stacks.map((stack) => {
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;top:0;left:0;white-space:nowrap;line-height:normal;font-size:200px;font-family:${stack}`;
    el.textContent = 'Hxg';
    return el;
  });
  box.append(...els);
  document.body.appendChild(box);
  els.forEach((el, i) => {
    const r = el.getBoundingClientRect().height / 200;
    const stack = stacks[i];
    ratios.set(stack, fromFile.get(stack) ?? (r > 0.5 && r < 3 ? Math.round(r * 10000) / 10000 : 1.15));
    readFile(stack);
  });
  box.remove();
}

// font-family stack → the middle of the box CSS gives a run of it (its content area: the font's ascent and descent as Chromium takes
// them), above the baseline, over the font size. CSS centres each run's line box on its own content area, so runs of fonts whose
// middles differ stretch a line by the difference (an Aptos label beside a Gabriola sample: 34.07 px for a 31.5 px line); Word sizes
// a line by its tallest ascent and descent, so decosOf takes the difference off the line height.
// ponytail: measured once per stack, so a web font measured before it loaded keeps its fallback's middle until reload.
const centres = new Map();
const descents = new Map(); // stack → the content area's descent over the size, read with the middle (text effect room)
function centreOf(stack) {
  if (!centres.has(stack)) measureCentres([stack]);
  return centres.get(stack);
}
function descentOf(stack) {
  if (!descents.has(stack)) measureCentres([stack]);
  return descents.get(stack);
}
/** Measures the content area middles of `stacks` together (one layout read), as measureRatios does their single lines. */
function measureCentres(stacks) {
  if (typeof document === 'undefined' || !document.body) {
    for (const s of stacks) {
      centres.set(s, 0);
      descents.set(s, 0.25);
    }
    return;
  }
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;width:0;height:0;contain:strict';
  const els = stacks.map((stack) => {
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;top:0;left:0;white-space:nowrap;line-height:normal;font-size:200px;font-family:${stack}`;
    const mark = document.createElement('span'); // a box of no size on the baseline
    mark.style.cssText = 'display:inline-block;width:0;height:0';
    el.append('Hxg', mark);
    return el;
  });
  box.append(...els);
  document.body.appendChild(box);
  const range = document.createRange();
  els.forEach((el, i) => {
    range.selectNodeContents(el.firstChild);
    const t = range.getBoundingClientRect();
    const base = el.lastChild.getBoundingClientRect().bottom;
    const c = (base - t.top - (t.bottom - base)) / 2 / 200;
    centres.set(stacks[i], Number.isFinite(c) && Math.abs(c) < 1 ? Math.round(c * 10000) / 10000 : 0);
    const d = (t.bottom - base) / 200;
    descents.set(stacks[i], Number.isFinite(d) && d >= 0 && d < 1 ? Math.round(d * 10000) / 10000 : 0.25);
  });
  box.remove();
}

/** Word's ascent in pt of a font measure ({r, s, stack}: its single line, size and stack): from its font file (fonts/metrics.mjs
 * ascentOf), else half the single line plus its box's middle until the file is read. */
function ascOf(x) {
  const a = ascents.get(x.stack);
  if (a == null) guessed.add(x.stack);
  return (a ?? x.r / 2 + centreOf(x.stack)) * x.s;
}

let canvas = null;
/** Width in points of `text` in `size` pt of `stack`, bold and italic as `bold` and `italic` say.
 * ponytail: character scaling (textStyle scale) is not measured, so a scaled run fits by its unscaled width. */
function textWidth(text, stack, size, bold, italic) {
  if (typeof document === 'undefined') return text.length * size * 0.5;
  canvas ??= document.createElement('canvas').getContext('2d');
  canvas.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}pt ${stack}`;
  return canvas.measureText(text).width * 0.75;
}

/** The attributes giving a run its effect room `box` (fxBox) on its line, `L` its CSS line height in pt. An inline run gets a
 * zero-width pseudo element at each end (document.css [data-fx]) as tall as the box, centred where the box is: the line grows as
 * for a taller font. A run drawn as an inline-block (a reflection, character scale) gets margins instead, outside its border box,
 * so the reflection draws in the room. ponytail: the pseudo elements sit on a run's first and last line only, so a run over three
 * or more lines leaves its middle lines without room; split the decoration per line if that shows. */
function fxAttrs({ h, v }, L, block) {
  if (block) return { style: `margin-top: ${round2(Math.max(0, (h - L) / 2 + v))}pt; margin-bottom: ${round2(Math.max(0, (h - L) / 2 - v))}pt` };
  return { 'data-fx': '', style: `--fx-h: ${round2(h)}pt; --fx-v: ${round2(v)}pt` };
}

const KEY = new PluginKey('wordParagraph');
const textStyleOf = (node) => node.marks.find((m) => m.type.name === 'textStyle')?.attrs ?? null;
const isWide = (ch) => ch.codePointAt(0) >= 0x2e80; // CJK and full-width forms take a whole em
const units = (text) => [...text].reduce((n, ch) => n + (isWide(ch) ? 2 : 1), 0);

const hasMark = (node, name) => node.marks.some((m) => m.type.name === name);

/** The run decorations of textblock `node` at `pos`: Fit Text widths and the two-row Asian layouts, one stretch of runs carrying the
 * same setting at a time. ProseMirror wraps each text node in its own element, so Fit Text gives every node its share of the width.
 * ponytail: a two-row layout over runs with different marks draws one two-row block per run, not one for the stretch. */
function runDecos(doc, node, pos, run) {
  const out = [];
  let open = null;
  const close = () => {
    if (!open) return;
    const { parts, kind, v } = open;
    if (kind === 'fit') {
      // ponytail: letter spacing from a canvas measure of the run's font, so a fallback font in the text can miss by a pixel or two.
      const widths = parts.map((p) => textWidth(p.text, fontStack(p.ts?.font ?? run.font ?? '+minor', doc.attrs.theme), p.ts?.size ?? run.size ?? 12,
        hasMark(p.node, 'bold'), hasMark(p.node, 'italic')));
      const count = (p) => [...p.text].length;
      const ls = round2((v.w - widths.reduce((a, b) => a + b, 0)) / Math.max(1, parts.reduce((n, p) => n + count(p), 0)));
      parts.forEach((p, i) => out.push(Decoration.inline(p.from, p.to, { 'data-fit': '', style: `width: ${round2(widths[i] + ls * count(p))}pt; letter-spacing: ${ls}pt` })));
    } else {
      const cc = v.combineChars;
      const text = parts.map((p) => p.text).join('');
      const font = cc?.font ? `font-family: ${fontStack(cc.font, doc.attrs.theme)}; ` : '';
      const fs = cc?.size ? `${cc.size}pt` : '50%';
      out.push(Decoration.inline(parts[0].from, parts.at(-1).to, { 'data-two-lines': cc ? 'chars' : 'lines', style: `${font}font-size: ${fs}; width: ${Math.ceil(units(text) / 2) + 0.3}ch` }));
    }
    open = null;
  };
  node.forEach((child, offset) => {
    const ts = child.isText ? textStyleOf(child) : null;
    const eal = ts?.eastAsianLayout;
    const kind = ts?.fitText?.w > 0 ? 'fit' : eal?.combine || eal?.combineChars ? 'two' : null;
    const v = kind === 'fit' ? ts.fitText : eal;
    const key = kind && `${kind}:${JSON.stringify(v)}`;
    const from = pos + 1 + offset;
    const part = { node: child, ts, from, to: from + child.nodeSize, text: child.text };
    if (open && open.key === key) {
      open.parts.push(part);
      return;
    }
    close();
    if (kind) open = { key, kind, v, parts: [part] };
  });
  close();
  return out;
}

/** The style id of the table holding position `pos` of `doc`, or null outside a table. */
function tableStyleAt(doc, pos) {
  const $p = doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'table') return $p.node(d).attrs.styleId ?? null;
  return null;
}

const grids = new WeakMap(); // sectionsOf's list → each section's line grid pitch (gridOf), or null where none has one

/** The line grid pitch in pt of the section of `doc` holding position `pos`, or null: Word lays out the body and table cells on
 * the document grid, not a text box. */
function gridAt(doc, pos, parent) {
  if (parent.type.name === 'textBox') return null;
  const secs = sectionsOf(doc);
  let g = grids.get(secs);
  if (g === undefined) {
    const list = secs.map((s) => gridOf(s.sect));
    grids.set(secs, (g = list.some(Boolean) ? list : null));
  }
  return g ? g[sectionAt(secs, pos).index] : null;
}

/** The line grid pitches of `doc`'s sections, joined: a change to it draws every paragraph again. */
const gridKey = (doc) => sectionsOf(doc).map((s) => gridOf(s.sect)).join();

/** How much higher (pt) a list paragraph's first line is than its text makes it, with the number's font measure: {up, label}, or
 * null. Word sizes a numbered line by its text and lets a number whose font rises higher than the text's raise the line by the
 * difference, its descent and the line spacing's leading never counting (all-features.pdf: 12 pt Aptos lines 16.92 pt apart, 17.76
 * beside a 12 pt Symbol bullet, 25.80 beside a 20 pt one, unchanged beside Courier New's deeper descent). The drawing puts it above
 * the paragraph's first line as padding: the number's box has no height of its own (lists' style.css), and padding is free of the
 * browser's pixel rounding of each font's ascent, which put the box's top up to 1.5 px off. `faces` are the font measures of the
 * text runs and the paragraph mark (decosOf), `metric` makes one. Exact spacing never grows; a picture bullet stands on the baseline
 * (lists' style.css). */
function labelRaise(doc, node, para, faces, metric) {
  const n = numOf(doc, node);
  const lvl = n && levelOf(numberingOf(doc), n.numId, n.ilvl);
  if (!lvl?.text || para.spacing?.line?.rule === 'exact' || (lvl.fmt === 'bullet' && /^data:image\//.test(lvl.pic ?? ''))) return null;
  const label = metric(labelRun(node, lvl));
  const up = ascOf(label) - Math.max(...faces.map(ascOf));
  return up > 0.01 ? { up: round2(up), label } : null;
}

/** The decorations of textblock `node` at `pos`, the `index`th child of `parent`. A paragraph or heading in the body or in columns
 * that draws only `base` (baseOf) takes none: style.css gives it that line height. */
function decosOf(state, node, pos, parent, index, geo, base = null, tableStyle = undefined) {
  const { doc } = state;
  // `tableStyle`: the caller's walk knows the table holding the paragraph; resolving the position per paragraph cost seconds on a
  // long document.
  const table = BODY.has(parent.type.name) ? null : tableStyle !== undefined ? tableStyle : tableStyleAt(doc, pos);
  const para = effectivePara(doc, node, table);
  const { run } = styleProps(doc, styleIdOf(node), table);
  // Word sizes a line by the tallest font on it: of the text runs and the paragraph mark, the one with the largest single line (its
  // font's ratio times its size) decides; with no text, the mark alone. The mark counts where it has run properties of its own
  // (markRun, from a .docx): ours keeps none, so in a paragraph typed here the text decides, as when Word formats the mark with it.
  // Inline nodes with no text of their own (a heading's _Toc bookmark, a widget) never do.
  // ponytail: one metric for the whole paragraph, so a line holding only smaller or shorter-metric runs than another line of the
  // same paragraph, or a line before the last beside a taller mark, draws as tall as that line; per-line heights if it shows.
  const metric = (ts) => {
    // A right-to-left or complex script run draws at its complex-script size (model/attrs.js sizeCS).
    const s = (ts?.rtl || ts?.cs) && ts?.sizeCS ? ts.sizeCS : ts?.size ?? run.size ?? 12;
    const stack = fontStack(ts?.font ?? run.font ?? '+minor', doc.attrs.theme);
    const r = ratioOf(stack);
    return { s, r, h: r * s, stack };
  };
  const strut = metric(null); // the paragraph element's own font: the style's
  let top = node.attrs.markRun ? metric(node.attrs.markRun) : null;
  const faces = [top ?? strut]; // the font measures of the text runs and the mark (or the style's strut where it has none)
  // Each run's size and its box's middle (centreOf) in pt above the baseline, the strut's first.
  const mids = [{ m: centreOf(strut.stack) * strut.s, s: strut.s }];
  const fx = []; // the runs whose text effects take room on their line (fxRoom): [from, to, room, metric, ts]
  // A run's East Asian characters draw in its East Asian font, and Word sizes a line by each font's ascent and descent with half a
  // CJK font's 30% leading on each (fonts/metrics.mjs): where that font's single line is the taller, each stretch of them draws in
  // it at its own line height (the decorations below), so its box centres on its own font as Word's does and a line of Latin
  // text keeps its own height (Word's PDF of grid_probe_docx.py's cjk.docx: 14.90 pt from a Latin line to a DengXian one and
  // 15.96 back, at 12 pt single).
  const eas = [];
  node.descendants((child, at) => {
    if (!child.isText) return true;
    const ts = textStyleOf(child);
    if (ts?.vanish) return false;
    const m = metric(ts);
    mids.push({ m: centreOf(m.stack) * m.s, s: m.s });
    const room = ts?.effects && fxRoom(ts.effects, m.s, m.h, descentOf(m.stack) * m.s);
    if (room) fx.push([pos + 1 + at, pos + 1 + at + child.nodeSize, room, m, ts]);
    faces.push(m);
    if (!top || m.h > top.h) top = m;
    const ranges = eastAsianRuns(child.text);
    const name = ranges.length ? eaFamily(ts?.fontEA ?? run.fontEA ?? '+minor', doc.attrs.theme) : null;
    const stack = name ? fontStack(name, doc.attrs.theme) : null;
    const r = stack ? ratioOf(stack) : 0;
    const s = ts?.size ?? run.size ?? 12;
    if (r > m.r + 1e-6) for (const [a, b] of ranges) eas.push({ from: pos + 1 + at + a, to: pos + 1 + at + b, r, s, stack });
    return false;
  });
  top ??= strut;
  // How much taller than the tallest run's own box the union of the boxes CSS draws is, for a line height of `h` pt (fixed) or `f`
  // times each run's size (unitless): a box is that tall around its middle.
  const excess = (box) => {
    let hi = -Infinity;
    let lo = Infinity;
    for (const { m, s } of mids) {
      hi = Math.max(hi, m + box(s) / 2);
      lo = Math.min(lo, m - box(s) / 2);
    }
    return Math.max(0, hi - lo - box(top.s));
  };
  // A unitless line height multiplies the element's own font size too, so where the style's font is taller than every font on
  // the line (Arial 10 pt runs and mark in an Aptos 11 pt paragraph) its strut would set the line: the pitch is drawn in points.
  // Runs whose boxes have other middles stretch the line (centreOf): drawn that much shorter, the line is Word's. A multiple stays
  // unitless (a larger run on the line still grows it), less the stretch over the tallest run's size.
  // On a section's line grid a paragraph that snaps to it (Snap to grid, on unless turned off) takes whole grid lines (gridPitch).
  // ponytail: one pitch for the whole paragraph, so a line without the tallest run takes as many grid lines as the line with it.
  const pitch = para.snapToGrid === false ? null : gridAt(doc, pos, parent);
  const drawn = pitch ? `${round2(gridPitch(para.spacing?.line, top.h, pitch))}pt`
    : strut.h > top.h + 1e-6 ? `${round2(linePitch(para.spacing?.line, top.h))}pt` : lineCss(para.spacing?.line, top.r, top.s);
  const v = parseFloat(drawn);
  const fixed = drawn.endsWith('pt');
  // Exactly and the grid make every line the pitch whatever its runs (Word clips a taller run under Exactly): the runs' own boxes
  // take no room (data-line-fixed, style.css), so no line stretches and none is drawn shorter for another line's stretch.
  const fixedLines = !!pitch || para.spacing?.line?.rule === 'exact';
  const extra = fixedLines ? 0 : excess(fixed ? () => v : (sz) => v * sz);
  const line = extra <= 0.01 ? drawn : fixed ? `${round2(v - extra)}pt` : String(Math.round((v - extra / top.s) * 10000) / 10000);
  // The room Multiple spacing adds (rules.mjs lineExtra): document.css draws it under an inline picture, and content controls'
  // tags read it. Every decorated paragraph names it, so none takes the body's from the editor root.
  const css = [`line-height: ${line}`, `--line-extra: ${round2(lineExtra(para.spacing?.line, top.h))}pt`];
  const rubies = rubyDecos(doc, node, pos, para, run, top, line);
  const raise = labelRaise(doc, node, para, faces, metric);
  if (raise != null) {
    // Padding is exact, but pagination slices a block's padding at a page end, so a number taller than its whole line (Word's
    // 1638 pt bullet, a line taller than the page, which Word gives a page of its own) grows the line instead: the number's box
    // reaches up from its middle (centreOf) to the text boxes' top plus the raise, within a pixel of the browser's rounding.
    const lh = parseFloat(line);
    const fixedLh = line.endsWith('pt');
    const { up, label } = raise;
    if (up <= (fixedLh ? lh : lh * top.s)) css.push(`padding-top: ${up}pt`);
    else {
      const textTop = Math.max(...mids.map(({ m, s }) => m + (fixedLh ? lh : lh * s) / 2));
      css.push(`--list-raise: ${round2(textTop + up - centreOf(label.stack) * label.s)}pt`);
    }
  }
  // Auto spacing, and contextual spacing between two paragraphs of one style (the stored space stays; only the drawing drops it).
  const me = { style: styleIdOf(node), contextual: para.contextual };
  const near = (i) => {
    const n = i >= 0 && i < parent.childCount ? parent.child(i) : null;
    return n?.isTextblock ? { style: styleIdOf(n) } : null;
  };
  const sp = para.spacing ?? {};
  if (dropsNext(me, near(index - 1))) css.push('margin-top: 0');
  else if (sp.beforeAuto) css.push(`margin-top: ${AUTO_SPACE}pt`);
  if (dropsNext(me, near(index + 1))) css.push('margin-bottom: 0');
  else if (sp.afterAuto) css.push(`margin-bottom: ${AUTO_SPACE}pt`);
  // Mirror indents: on even pages left and right swap (inside and outside).
  const mirror = !!para.mirrorIndents;
  let right = para.indent?.right ?? 0;
  if (mirror && geo && geo.pageOf(pos + 1) % 2 === 1) {
    right = para.indent?.left ?? 0;
    css.push(`margin-left: ${para.indent?.right ?? 0}pt`, `margin-right: ${right}pt`);
  }
  // A negative right indent widens the lines only up to LINE_REACH from the column's left edge (reachRight; 100% is the column).
  if (right < 0) css.push(`margin-right: max(${right}pt, calc(100% - ${LINE_REACH}pt))`);
  const runs = runDecos(doc, node, pos, run);
  for (const [from, to, room, m, ts] of fx) {
    const L = fixed ? parseFloat(line) : parseFloat(line) * m.s;
    const box = fxBox(room, para.spacing?.line, L, m.h);
    if (box) runs.push(Decoration.inline(from, to, fxAttrs(box, L, drawnAsBlock(ts))));
  }
  // The East Asian stretches in their font at their line height. Exactly keeps every line at its value, and on the grid a stretch
  // only sets its own where it needs more grid lines than the paragraph's (two boxes of one pitch on other middles would stretch it).
  const exact = para.spacing?.line?.rule === 'exact';
  for (const e of eas) {
    const grid = pitch ? round2(gridPitch(para.spacing?.line, e.r * e.s, pitch)) : null;
    const lh = exact || (grid != null && grid <= v + 0.01) ? null : grid != null ? `${grid}pt` : lineCss(para.spacing?.line, e.r, e.s);
    runs.push(Decoration.inline(e.from, e.to, { 'data-ea-line': '', style: `font-family: ${e.stack}${lh ? `; line-height: ${lh}` : ''}` }));
  }
  if (css.length === 2 && css.join('; ') === base && !runs.length && !rubies.length && !fixedLines && node.attrs.spacing == null && PLAIN.has(node.type.name)
    && BODY.has(parent.type.name)) return { decos: [], mirror };
  const attrs = fixedLines ? { style: css.join('; '), 'data-line-fixed': '' } : { style: css.join('; ') };
  return { decos: [Decoration.node(pos, pos + node.nodeSize, attrs), ...runs, ...rubies], mirror, css };
}

/** The room each phonetic guide of textblock `node` (at `pos`) opens in its line (font/ruby.mjs rubyRoom, Word's rule), as the
 * --w-ruby-up and --w-ruby-down its view's strut reads. `top` is the paragraph's tallest font (decosOf metric) and `line` the CSS
 * line height drawn. ponytail: the paragraph's tallest font stands for the guide's own line, as decosOf's one metric does. */
function rubyDecos(doc, node, pos, para, run, top, line) {
  const out = [];
  node.descendants((child, at) => {
    if (child.type.name !== 'ruby') return true;
    const box = boxOf(top.stack);
    const A = box.asc * top.s;
    const css = line.endsWith('pt') ? parseFloat(line) : parseFloat(line) * top.s;
    const ts = textStyleOf(child);
    const reading = boxOf(fontStack(child.attrs.font ?? ts?.font ?? run.font ?? '+minor', doc.attrs.theme));
    const below = css / 2 - centreOf(top.stack) * top.s; // CSS centres the line box on the text's middle
    const room = rubyRoom(child.attrs, { A, D: top.h - A, rule: para.spacing?.line, css, below, base: ts?.size ?? run.size ?? 12, box: reading });
    if (room) out.push(Decoration.node(pos + 1 + at, pos + 1 + at + child.nodeSize, { style: `--w-ruby-up: ${room.up}pt; --w-ruby-down: ${room.down}pt` }));
    return false;
  });
  return out;
}

/** The style textblock `node` (at `pos`, the `index`th child of `parent` in `doc`) draws with in an editor: its line height and
 * spacing as its decoration gives them. For static copies no plugin decorates (the header and footer layer). */
export const drawnStyle = (doc, node, pos, parent, index) => decosOf({ doc }, node, pos, parent, index, null).css.join('; ');

// Body paragraphs drawn at the base line height take no node decoration, through style.css's [data-para-lh] rule: thousands of
// decorations at one level made every keypress map them all and walk them once per paragraph (plan.md section 6 risk 6). Only
// nodes whose tags that rule covers (p, h1 to h6) under parents it covers (the body and [data-columns]) qualify, and only without
// direct spacing, which draws inline and would beat the rule.
const PLAIN = new Set(['paragraph', 'heading']);
const BODY = new Set(['doc', 'columns']);

/** The line height and Multiple room a Normal paragraph without direct formatting draws: 'line-height: x; --line-extra: y'. */
function baseOf(state) {
  const p = state.schema.nodes.paragraph.create();
  return decosOf(state, p, 0, p, 0, null).css.join('; ');
}

/** The page geometry of `state`, or null where there is none (a hidden session editor without pagination). */
function safeGeometry(state) {
  try {
    return geometryOf(state);
  } catch {
    return null;
  }
}

/** Decorations of every textblock between `from` and `to` (the nodes nodesBetween visits) → {decos, mirror}. The walk carries the
 * style of the table it is in. */
function build(state, from, to, geo, base) {
  const decos = [];
  let mirror = false;
  const walk = (parent, start, table) => {
    parent.forEach((node, off, index) => {
      const pos = start + off;
      if (pos >= to || pos + node.nodeSize <= from) return;
      if (node.isTextblock) {
        const r = decosOf(state, node, pos, parent, index, geo, base, table);
        for (const d of r.decos) decos.push(d);
        mirror ||= r.mirror;
      } else if (node.content.size) walk(node, pos + 1, node.type.name === 'table' ? node.attrs.styleId ?? null : table);
    });
  };
  walk(state.doc, 0, null);
  return { decos, mirror };
}

/** The decorations of the textblocks at `positions` drawn again in `set` (their page parity changed: mirror indents). */
function redraw(state, set, positions, geo, base) {
  const { doc } = state;
  const decos = [];
  for (const pos of positions) {
    const node = doc.nodeAt(pos);
    if (!node?.isTextblock) continue;
    set = set.remove(set.find(pos + 1, pos + node.nodeSize - 1));
    const $p = doc.resolve(pos);
    for (const d of decosOf(state, node, pos, $p.parent, $p.index(), geo, base).decos) decos.push(d);
  }
  return set.add(doc, decos);
}

const full = (state, geo) => {
  const base = baseOf(state);
  const { decos, mirror } = build(state, 0, state.doc.content.size, geo, base);
  return { set: DecorationSet.create(state.doc, decos), mirror, base };
};

/** `full` for a doc whose paragraphs mostly draw as they did (a font's line height read from its file, a web font loaded): only
 * the decorations that differ from `value`'s are swapped (changedSet). */
function refresh(state, geo, value) {
  const base = baseOf(state);
  const { decos, mirror } = build(state, 0, state.doc.content.size, geo, base);
  return { set: changedSet(state.doc, value.set, decos), mirror, base };
}

/** The range of `tr`'s steps in the new doc, widened to the top-level block before and after (contextual spacing reads the
 * neighbours) → [from, to] or null. */
function changed(tr) {
  let a = Infinity;
  let b = -Infinity;
  tr.steps.forEach((step, i) => {
    const from = step.from ?? step.pos;
    if (from == null) return;
    const to = step.to ?? from + 1;
    const m = tr.mapping.slice(i);
    a = Math.min(a, m.map(from, -1));
    b = Math.max(b, m.map(to, 1));
  });
  if (a > b) return null;
  const { doc } = tr;
  const size = doc.content.size;
  const $a = doc.resolve(Math.max(0, Math.min(size, a)));
  const $b = doc.resolve(Math.max(0, Math.min(size, b)));
  return [$a.posAtIndex(Math.max(0, $a.index(0) - 1), 0), $b.posAtIndex(Math.min(doc.childCount, $b.index(0) + 2), 0)];
}

/** The paragraph drawing plugin. Decorations map through each transaction and only the paragraphs a change touches (and their
 * neighbours) are recomputed; a change of the styles, theme, settings or numbering, a font that finished loading and, with mirrored
 * paragraphs, a new page layout recompute them all. */
export const ParagraphDrawing = Extension.create({
  name: 'wordParagraphDrawing',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: KEY,
      state: {
        init: (_config, state) => full(state, null),
        apply(tr, value, old, state) {
          const a = old.doc.attrs;
          const b = state.doc.attrs;
          // Inside apply the pagination plugin's new state may not exist yet, so a layout that has not changed is read from `old`.
          const geo = safeGeometry(state) ?? safeGeometry(old);
          const meta = tr.getMeta(KEY);
          // The numbering too: a level's own font raises its numbered lines (labelRaise).
          if (a.styles !== b.styles || a.theme !== b.theme || a.settings !== b.settings || a.numbering !== b.numbering) return full(state, geo);
          if (tr.docChanged && gridKey(old.doc) !== gridKey(state.doc)) return full(state, geo);
          if (meta === 'full') return tr.docChanged ? full(state, geo) : refresh(state, geo, value);
          if (meta?.redraw && !tr.docChanged) return { ...value, set: redraw(state, value.set, meta.redraw, geo, value.base) };
          if (!tr.docChanged) return value;
          let set = value.set.map(tr.mapping, tr.doc);
          const range = changed(tr);
          if (!range) return { ...value, set };
          const [from, to] = range;
          set = set.remove(set.find(from + 1, Math.max(from + 1, to - 1)));
          const { decos, mirror } = build(state, from, to, geo, value.base);
          return { set: set.add(state.doc, decos), mirror: value.mirror || mirror, base: value.base };
        },
      },
      props: {
        decorations: (state) => KEY.getState(state)?.set,
        attributes: (state) => {
          const base = KEY.getState(state)?.base;
          return base ? { 'data-para-lh': '', style: base.replace('line-height:', '--para-lh:') } : {};
        },
      },
      view(view) {
        // A web font (or a fallback) that loads later changes the measured single lines.
        const onFonts = () => {
          const stacks = [...ratios.keys()];
          ratios.clear();
          measureRatios(stacks); // together, before the decorations ask for them one by one
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(KEY, 'full').setMeta('addToHistory', false));
        };
        document.fonts?.addEventListener?.('loadingdone', onFonts);
        drawings.add(view);
        return {
          destroy: () => {
            document.fonts?.removeEventListener?.('loadingdone', onFonts);
            drawings.delete(view);
          },
        };
      },
    })];
  },
});

const parities = new WeakMap(); // view → {nodes: WeakMap node → page parity, at: Map textblock index → parity} as last drawn
const mirrors = new WeakMap(); // textblock node → {attrs (the doc's, whose styles decide), on}

/** Whether textblock `node` of `doc` mirrors its indents, cached per node while the doc's attributes stay. */
function mirrored(doc, node) {
  let m = mirrors.get(node);
  if (!m || m.attrs !== doc.attrs) mirrors.set(node, (m = { attrs: doc.attrs, on: !!effectivePara(doc, node).mirrorIndents }));
  return m.on;
}

/** Mirror indents depend on the page, which engine 1 publishes without a transaction: this layout pass, after each page measure,
 * redraws the mirrored paragraphs whose page parity changed (so equal layouts never loop) and asks for a measure again. Keyed by
 * the paragraph's node, so typing before a mirrored paragraph does not count as a change, and the whole set is not rebuilt. */
export const MIRROR_PASS = {
  id: 'paragraph.mirrorIndents',
  phase: 'after',
  run(view) {
    if (!view.dom.isConnected || view.dom.closest('[data-story]') || !KEY.getState(view.state)?.mirror) return false;
    const geo = safeGeometry(view.state);
    if (!geo) return false;
    const { doc } = view.state;
    const drawn = parities.get(view);
    const now = { nodes: new WeakMap(), at: new Map() };
    const moved = [];
    let i = 0;
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      i += 1;
      if (!mirrored(doc, node)) return false;
      const odd = geo.pageOf(pos + 1) % 2;
      now.nodes.set(node, odd);
      now.at.set(i, odd);
      // An edited paragraph is a new node: it is compared with the one drawn at its index (textblock count) before.
      // The first run redraws every mirrored paragraph (what was drawn before the pages existed is not known): rebuilding the
      // whole set instead took about 220 ms on the Word fixture.
      if (!drawn || (drawn.nodes.has(node) ? drawn.nodes.get(node) : drawn.at.get(i)) !== odd) moved.push(pos);
      return false;
    });
    parities.set(view, now);
    if (!moved.length) return false;
    view.dispatch(view.state.tr.setMeta(KEY, { redraw: moved }).setMeta('addToHistory', false));
    return true;
  },
};

export const EXTENSIONS = [ParagraphCommands, ParagraphKeys, ParagraphDrawing];
