// Word's border drawing for paragraphs and cells (briefs/borders.md Grouping, Distance from text; plan.md §1.8), as node
// decorations. A bordered or shaded paragraph draws its box on its ::after (style.css), outside the text by each edge's space,
// so adding a left or right border never moves the text; top and bottom space go into padding. Consecutive paragraphs with
// equal borders, shading and indents draw as one box: the margins between them become padding (the gap stays the larger of
// space after and space before), the between border sits on top of each following paragraph, and the left and right lines run
// on. Cells get their diagonals (tl2br, tr2bl) and the table's borders (table.borders) on the edges they do not set themselves.
// Decorations are rebuilt over the whole document on a change of blocks or attributes (a walk that skips into no paragraph) and only
// mapped on a change of text or marks inside a paragraph, which cannot change them: typing stays under its 0.5 ms (plan.md
// section 6 risk 6).
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { TableMap } from '@tiptap/pm/tables';
import { borderCss, isPlain, shadingCss } from '../../../office.mjs';
import { effectiveProps } from '../../schema.js';
import { cellEdges, groupRoles, isLine, lineWidth } from './model.mjs';
import { bordersOf, styleShading, tableEdges } from './select.js';
import { typing } from '../../typing.mjs';

const pt = (n) => `${Math.round(n * 100) / 100}pt`;
/** Line `e` as CSS. What CSS draws as two lines (double) or a groove or ridge fills the room Word gives the line (lineWidth), at
 * least 3 px so both halves show; the rest keep their own width (a wave drawn solid across its 3 pt of room would be a bar). */
const css = (e) => {
  if (!isLine(e)) return 'none';
  const [w, style, ...color] = borderCss(e).split(' ');
  return [/^(double|groove|ridge)$/.test(style) ? pt(Math.max(lineWidth(e), 2.25)) : w, style, ...color].join(' ');
};
/** The room line `e` takes in the paragraph, Word's (model.mjs lineWidth): the drawn width may differ. */
const thick = lineWidth;
/** The CSS colour of line `e` (borderCss is width, style, colour). */
const colorOf = (e) => css(e).split(' ').slice(2).join(' ');

/** The drawing facts of paragraph `node` in `doc`, or null when it has no line and no shading. */
function infoOf(doc, node) {
  const borders = bordersOf(doc, node);
  const shading = node.attrs.shading ?? styleShading(doc, node);
  const lined = Object.values(borders).some(isLine);
  if (!lined && !shadingCss(shading)) return null;
  const p = effectiveProps(doc, node).para;
  return { borders, shading, left: p.indent.left ?? 0, right: p.indent.right ?? 0, firstLine: p.indent.firstLine ?? 0,
    before: p.spacing.before ?? 0, after: p.spacing.after ?? 0, list: !!node.attrs.numbering };
}

/** The inline style of a paragraph drawn as `role` in its group, `next` the following paragraph's info. */
function paraStyle(info, role, next) {
  const b = info.borders;
  const first = role === 'single' || role === 'first';
  const last = role === 'single' || role === 'last';
  const out = { border: 'none', background: 'none', 'padding-left': '0', 'padding-right': '0' };
  if (first) {
    out['--bdr-t'] = css(b.top);
    out['padding-top'] = pt(isLine(b.top) ? (b.top.space ?? 0) + thick(b.top) : 0);
  } else {
    out['margin-top'] = '0';
    out['--bdr-t'] = css(b.between);
    out['padding-top'] = pt(isLine(b.between) ? (b.between.space ?? 0) + thick(b.between) : 0);
  }
  if (last) {
    out['--bdr-b'] = css(b.bottom);
    out['padding-bottom'] = pt(isLine(b.bottom) ? (b.bottom.space ?? 0) + thick(b.bottom) : 0);
  } else {
    out['margin-bottom'] = '0';
    out['--bdr-b'] = 'none';
    out['padding-bottom'] = pt(Math.max(info.after, next?.before ?? 0)); // the gap paragraph spacing draws (the larger of the two)
  }
  out['--bdr-l'] = css(b.left);
  out['--bdr-r'] = css(b.right);
  out['--bdr-il'] = pt(isLine(b.left) ? (b.left.space ?? 0) + thick(b.left) : 0);
  out['--bdr-ir'] = pt(isLine(b.right) ? (b.right.space ?? 0) + thick(b.right) : 0);
  if (!info.list && info.firstLine < 0) out['--bdr-hang'] = pt(-info.firstLine); // the box takes in a hanging first line
  out['--bdr-bg'] = shadingCss(info.shading) ?? 'transparent';
  const shadow = ['top', 'left', 'bottom', 'right'].map((e) => b[e]).find((e) => isLine(e) && e.shadow);
  if (shadow && last) out['--bdr-sh'] = `${pt(thick(shadow) + 1)} ${pt(thick(shadow) + 1)} 0 0 ${colorOf(shadow)}`;
  return Object.entries(out).map(([k, v]) => `${k}: ${v}`).join('; ');
}

/** Decorations of a run of sibling blocks: paragraph groups. */
function siblings(doc, parent, offset, out) {
  const kids = [];
  parent.forEach((node, at) => kids.push({ node, pos: offset + at }));
  const infos = kids.map(({ node }) => (node.isTextblock && node.attrs.numbering !== undefined ? infoOf(doc, node) : null));
  const roles = groupRoles(infos);
  kids.forEach(({ node, pos }, i) => {
    if (!roles[i]) return;
    out.push(Decoration.node(pos, pos + node.nodeSize, { 'data-bdr': roles[i], style: paraStyle(infos[i], roles[i], infos[i + 1]) }));
  });
}

const diag = (e, dir) => (isLine(e) ? `linear-gradient(${dir}, transparent calc(50% - 0.6px), ${colorOf(e)} 50%, transparent calc(50% + 0.6px))` : null);

/** Decorations of a table's cells: the table's borders where the cell sets no edge, and the diagonals. A line between two cells
 * in a row is drawn once, as the left cell's right side (document.css td + td), so a cell's left side gives way to it. */
function cellDecos(doc, table, pos, out) {
  const tb = isPlain(table.attrs.borders) ? table.attrs.borders : null;
  const map = TableMap.get(table);
  const te = tableEdges(doc, table);
  const start = pos + 1;
  const seen = new Set();
  for (const rel of map.map) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const cell = table.nodeAt(rel);
    const own = cell.attrs.borders ?? {};
    const r = map.findCell(rel);
    const style = [];
    if (tb) {
      const edge = { top: r.top === 0 ? tb.top : tb.insideH, bottom: r.bottom === map.height ? tb.bottom : tb.insideH,
        left: r.left === 0 ? tb.left : tb.insideV, right: r.right === map.width ? tb.right : tb.insideV };
      for (const [k, e] of Object.entries(edge)) if (e && own[k] == null && !(k === 'left' && r.left > 0 && isLine(e))) style.push(`border-${k}: ${css(e)}`);
    }
    if (r.left > 0 && isLine(own.left)) {
      const prev = map.map[r.top * map.width + r.left - 1];
      if (isLine(cellEdges(table.nodeAt(prev).attrs.borders, map.findCell(prev), map.width, map.height, te).right)) style.push('border-left-style: none');
    }
    const lines = [diag(own.tl2br, 'to top right'), diag(own.tr2bl, 'to bottom right')].filter(Boolean);
    if (lines.length) style.push(`background-image: ${lines.join(', ')}`);
    if (style.length) out.push(Decoration.node(start + rel, start + rel + cell.nodeSize, { style: style.join('; ') }));
  }
}

/** Every border decoration of `doc`. */
export function decorationsOf(doc) {
  const out = [];
  const walk = (node, offset) => {
    if (node.type.name === 'table') cellDecos(doc, node, offset - 1, out);
    if (node.isTextblock || node.isLeaf) return;
    if (node.firstChild?.isBlock) siblings(doc, node, offset, out);
    node.forEach((child, at) => {
      if (!child.isTextblock && !child.isLeaf) walk(child, offset + at + 1);
    });
  };
  walk(doc, 0);
  return DecorationSet.create(doc, out);
}

const key = new PluginKey('wordBorders');

/** The editor extension drawing paragraph groups, cell diagonals and table borders. */
export const BorderDrawing = Extension.create({
  name: 'wordBorders',
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        init: (_, state) => decorationsOf(state.doc),
        // Text and marks inside textblocks move the decorations but never change them.
        apply: (tr, set) => (!tr.docChanged ? set : typing(tr, true) ? set.map(tr.mapping, tr.doc) : decorationsOf(tr.doc)),
      },
      props: { decorations: (state) => key.getState(state) },
    })];
  },
});
