// The Document's style definitions as CSS (docs/plans/document.md Document-level data): one <style> per editor, scoped by a
// data-doc id on its .ProseMirror, so the assistant's background session editors keep their own. Built from doc.attrs styles
// (docDefaults and styles.xml) and theme, and rebuilt when a transaction changes either. Direct formatting is inline style on
// the nodes and marks (schema.js), so it wins over these rules.
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { fontStack } from '../office.mjs';

const HEADINGS = [1, 2, 3, 4, 5, 6];
const decl = (props) => Object.entries(props).filter(([, v]) => v != null).map(([k, v]) => `${k}:${v}`).join(';');
const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] ? merge(out[k], v) : v;
  return out;
};

/** Style `id` of `list` with its basedOn chain merged in (the nearest wins). */
export function resolved(list, id, seen = new Set()) {
  const s = list[id];
  if (!s || seen.has(id)) return {};
  seen.add(id);
  return merge(s.basedOn ? resolved(list, s.basedOn, seen) : {}, s);
}

const fontCss = (font) => (!font ? null : font.startsWith('+') ? `var(--doc-${font.slice(1)})` : fontStack(font));

function runCss(run = {}) {
  return {
    'font-family': fontCss(run.font),
    'font-size': run.size ? `${run.size}pt` : null,
    color: run.color ?? null,
    'font-weight': run.bold == null ? null : run.bold ? 'bold' : 'normal',
    'font-style': run.italic == null ? null : run.italic ? 'italic' : 'normal',
    'text-decoration': run.underline ? 'underline' : null,
    'letter-spacing': run.charSpacing ? `${run.charSpacing}pt` : null,
  };
}

function paraCss(para = {}) {
  const { spacing: s = {}, indent: i = {}, border: b = {} } = para;
  const line = s.line && (s.line.rule === 'auto' ? String(s.line.value) : `${s.line.value}pt`);
  const edge = (e) => e && `${e.width}pt solid ${e.color ?? 'currentColor'}`;
  return {
    'margin-top': s.before != null ? `${s.before}pt` : null,
    'margin-bottom': s.after != null ? `${s.after}pt` : null,
    'line-height': line ?? null,
    'margin-left': i.left != null ? `${i.left}pt` : null,
    'margin-right': i.right != null ? `${i.right}pt` : null,
    'text-indent': i.firstLine != null ? `${i.firstLine}pt` : null,
    'text-align': para.align ?? null,
    'border-top': edge(b.top),
    'padding-top': b.top ? `${b.top.space}pt` : null,
    'border-bottom': edge(b.bottom),
    'padding-bottom': b.bottom ? `${b.bottom.space}pt` : null,
  };
}

/** The CSS of a Document's `styles` and `theme` (doc.attrs) under `scope`. */
export function styleSheetCss(scope, styles, theme) {
  const list = styles?.list ?? {};
  const defaults = styles?.defaults ?? {};
  const out = [];
  const rule = (sel, props) => {
    const d = decl(props);
    if (d) out.push(`${sel}{${d}}`);
  };
  rule(scope, {
    '--doc-major': fontStack('+major', theme),
    '--doc-minor': fontStack('+minor', theme),
    color: theme?.colors?.dk1 ?? '#000000',
    ...runCss(defaults.run),
  });
  rule(`${scope} :is(p,h1,h2,h3,h4,h5,h6)`, { 'margin-top': '0', 'margin-bottom': '0', ...paraCss(defaults.para) });
  // Headings first: a paragraph style on a heading ([data-style], more specific) wins over its implied HeadingN.
  for (const n of HEADINGS) {
    const s = resolved(list, `Heading${n}`);
    rule(`${scope} h${n}`, { ...paraCss(s.para), ...runCss(s.run) });
  }
  for (const [id, s] of Object.entries(list)) {
    if (s.type !== 'paragraph' || /^(Normal|Heading\d)$/.test(id)) continue;
    const r = resolved(list, id);
    rule(`${scope} [data-style="${id}"]`, { ...paraCss(r.para), ...runCss(r.run) });
  }
  if (list.Hyperlink) rule(`${scope} a`, runCss(list.Hyperlink.run));
  for (const [id, s] of Object.entries(list)) {
    if (s.type !== 'table') continue;
    const { table = {}, para } = resolved(list, id);
    const m = table.cellMargin;
    const b = table.borders;
    const cells = `${scope} table[data-style="${id}"] :is(td,th)`;
    rule(cells, {
      border: b ? `${b.width}pt solid ${b.color ?? theme?.colors?.dk1 ?? '#000000'}` : null,
      padding: m ? `${m.top}pt ${m.right}pt ${m.bottom}pt ${m.left}pt` : null,
    });
    rule(`${cells} p`, paraCss(para));
    // The row grids overlap by one border (document.css), so a row moved to the next page keeps its top border.
    rule(`${scope} table[data-style="${id}"]`, { '--cell-border': b ? `${b.width}pt` : null });
  }
  return out.join('\n');
}

let ids = 0;

/** Renders the open doc's styles into its own <style> element, scoped by data-doc on the editor's .ProseMirror. */
export const StyleSheet = Extension.create({
  name: 'styleSheet',
  addProseMirrorPlugins() {
    const id = `d${++ids}`;
    const scope = `.ProseMirror[data-doc="${id}"]`;
    return [new Plugin({
      props: { attributes: { 'data-doc': id } },
      view(view) {
        const el = view.dom.ownerDocument.createElement('style');
        el.dataset.docStyles = id;
        view.dom.ownerDocument.head.append(el);
        const render = ({ styles, theme }) => {
          el.textContent = styleSheetCss(scope, styles, theme);
        };
        render(view.state.doc.attrs);
        return {
          update(v, prev) {
            const a = v.state.doc.attrs;
            if (a.styles !== prev.doc.attrs.styles || a.theme !== prev.doc.attrs.theme) render(a);
          },
          destroy: () => el.remove(),
        };
      },
    })];
  },
});
