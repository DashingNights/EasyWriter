// The Equation tab's and Insert > Equation's commands (docs/plans/word plan.md §1.3, briefs/equations.md): insert an equation
// (Alt+= and the split button), the built-in gallery, the input formats, Convert, the Symbols gallery with its set switch and
// the Structures galleries. Commands act on the main editor (ctx.ed); the open equation box is the story.
import { NodeSelection } from '@tiptap/pm/state';
import { saveWord } from '../../word/settings.mjs';
import { fromInput, toInput } from './linear.mjs';
import { getState, setState } from '../../../app/store.js';
import { BUILT_INS, STRUCTURES, SYMBOL_SETS } from './templates.mjs';
import { aloneAt, boxOf, commit, mathSettings, mmlFor, openAt, sessionOf, typeInBox } from './view.js';

const NONE = 'Select an equation first.';

/** Inserts an equation holding UnicodeMath `math` at `ed`'s selection; with no math the selected text (one paragraph) becomes
 * the equation. `open` opens it for typing, else it stays node-selected. → true when inserted. */
export function insertEquation(ed, math = '', { open = !math } = {}) {
  if (!ed?.schema.nodes.equation) return false;
  if (sessionOf(ed)) commit(ed.view, 'after');
  const { state } = ed;
  const sel = state.selection;
  let text = math;
  if (!text && !sel.empty && !sel.node && sel.$from.sameParent(sel.$to) && sel.$from.parent.isTextblock) text = state.doc.textBetween(sel.from, sel.to);
  const tr = state.tr.replaceSelectionWith(state.schema.nodes.equation.create({ math: text }), false);
  let pos = tr.selection.from - 1;
  if (tr.doc.nodeAt(pos)?.type.name !== 'equation') {
    pos = null;
    tr.doc.nodesBetween(Math.max(0, sel.from - 1), Math.min(tr.doc.content.size, sel.from + 2), (n, p) => {
      if (n.type.name === 'equation' && pos == null) pos = p;
    });
    if (pos == null) return false;
  }
  const display = aloneAt(tr.doc, pos);
  tr.setNodeMarkup(pos, null, { ...tr.doc.nodeAt(pos).attrs, display, mml: mmlFor(text, display, tr.doc) });
  if (!open) tr.setSelection(NodeSelection.create(tr.doc, pos));
  ed.view.dispatch(tr.scrollIntoView());
  if (!open) {
    ed.view.focus();
    return true;
  }
  openAt(ed, pos, 'end');
  return true;
}

/** The equation the tab acts on → {pos, node}: the open one, else the node-selected one, else null. */
export function current(ctx) {
  const ed = ctx.ed;
  const s = sessionOf(ed);
  const pos = s ? s.nv.getPos() : ctx.obj?.kind === 'equation' ? ctx.obj.pos : null;
  const node = pos == null ? null : ed.state.doc.nodeAt(pos);
  return node?.type.name === 'equation' ? { pos, node } : null;
}

/** Shows the equations at `positions` of `ed` in linear (true) or professional form, as one undo step. */
function setLinear(ed, positions, linear) {
  if (sessionOf(ed)) commit(ed.view, 'select');
  const tr = ed.state.tr;
  for (const pos of positions) {
    const node = tr.doc.nodeAt(pos);
    if (node?.type.name === 'equation' && node.attrs.linear !== linear) tr.setNodeMarkup(pos, null, { ...node.attrs, linear });
  }
  // A leaf's new markup drops its node selection: keep it, so the tab still acts on the equation.
  const sel = ed.state.selection;
  if (sel.node?.type.name === 'equation') tr.setSelection(NodeSelection.create(tr.doc, sel.from));
  if (tr.docChanged) ed.view.dispatch(tr);
  return true;
}

const allOf = (doc) => {
  const out = [];
  doc.descendants((n, p) => {
    if (n.type.name === 'equation') out.push(p);
  });
  return out;
};

/** Types UnicodeMath `math` into the open equation (in the box's input format), opening the selected one or a new one first. */
function typeMath(ctx, math, placeholder) {
  const ed = ctx.ed;
  const s = boxOf(ed) ?? (insertEquation(ed, '', { open: true }) && sessionOf(ed));
  if (!s) return false;
  let text = math;
  try {
    text = toInput(math, mathSettings().input);
  } catch { /* the template stays UnicodeMath */ }
  typeInBox(s, text, { placeholder });
  return true;
}

const hasEd = (ctx) => !!ctx.ed?.schema.nodes.equation;
const builtIn = (id) => BUILT_INS.find((i) => i.id === id);

/** Inserts the built-in `id`, or a new empty equation when there is none. */
const insertRun = (ctx, id) => {
  const b = builtIn(id);
  return insertEquation(ctx.ed, b?.math ?? '', { open: !b });
};

const structure = (galleryId) => ({
  run: (ctx, id) => {
    const item = STRUCTURES[galleryId].find((i) => i.id === id);
    return item ? typeMath(ctx, item.math, true) : false;
  },
  enabled: hasEd,
});

const setInput = (input) => ({
  run: (ctx) => {
    const s = sessionOf(ctx.ed);
    const before = mathSettings().input;
    if (s && before !== input) {
      // The open box changes format with its text, as Word converts the linear form.
      try {
        s.input.value = toInput(fromInput(s.input.value, before), input);
      } catch { /* the text stays as typed */ }
    }
    saveWord({ math: { input } });
    return true;
  },
  active: (ctx) => ctx.settings.word.math.input === input,
});

// The Symbols gallery shows one set at a time; the Gallery Filters submenu switches it. The set lives in the store (word.eqSymbols)
// so the ribbon redraws when it changes.
const setOf = () => (SYMBOL_SETS[getState().word?.eqSymbols] ? getState().word.eqSymbols : 'basicMath');
const symbolCh = (id) => Object.values(SYMBOL_SETS).flatMap((s) => s.items).find((i) => i.id === id)?.ch;

export const COMMANDS = {
  'insert.symbols.equation': { run: insertRun, enabled: hasEd },
  'insert.symbols.equation.insertNewEquation': { run: (ctx) => insertEquation(ctx.ed), enabled: hasEd },
  'equation.tools.equation': { run: (ctx, id) => (builtIn(id) ? insertRun(ctx, id) : false), enabled: hasEd },
  'equation.conversions.unicode': setInput('unicode'),
  'equation.conversions.laTeX': setInput('latex'),
  // Text types normal text: a quoted run in UnicodeMath, with the caret inside the quotes.
  'equation.conversions.text': {
    run: (ctx) => {
      const s = boxOf(ctx.ed);
      if (!s) return false;
      typeInBox(s, '""');
      const at = s.input.selectionStart - 1;
      s.input.setSelectionRange(at, at);
      return true;
    },
    active: (ctx) => {
      const s = sessionOf(ctx.ed);
      if (!s) return false;
      const before = s.input.value.slice(0, s.input.selectionStart);
      return (before.match(/"/g)?.length ?? 0) % 2 === 1;
    },
    enabled: (ctx) => !!current(ctx),
    reason: () => NONE,
  },
  'equation.conversions.convert': {
    run: (ctx) => {
      const c = current(ctx);
      return c ? setLinear(ctx.ed, [c.pos], !c.node.attrs.linear) : false;
    },
    active: (ctx) => !!current(ctx)?.node.attrs.linear,
    enabled: (ctx) => !!current(ctx),
    reason: () => NONE,
  },
  'equation.conversions.convert.currentProfessional': { run: (ctx) => { const c = current(ctx); return c ? setLinear(ctx.ed, [c.pos], false) : false; },
    active: (ctx) => current(ctx)?.node.attrs.linear === false, enabled: (ctx) => !!current(ctx), reason: () => NONE },
  'equation.conversions.convert.currentLinear': { run: (ctx) => { const c = current(ctx); return c ? setLinear(ctx.ed, [c.pos], true) : false; },
    active: (ctx) => !!current(ctx)?.node.attrs.linear, enabled: (ctx) => !!current(ctx), reason: () => NONE },
  'equation.conversions.convert.allProfessional': { run: (ctx) => setLinear(ctx.ed, allOf(ctx.ed.state.doc), false), enabled: hasEd },
  'equation.conversions.convert.allLinear': { run: (ctx) => setLinear(ctx.ed, allOf(ctx.ed.state.doc), true), enabled: hasEd },
  'equation.conversions.launcher': { run: (ctx) => ctx.dialog('equationOptions') },
  'equation.symbols.symbols': { run: (ctx, id) => { const ch = symbolCh(id); return ch ? typeMath(ctx, ch, false) : false; }, enabled: hasEd },
  'equation.symbols.symbols.basicMath': { run: () => true, label: () => SYMBOL_SETS[setOf()].label },
  ...Object.fromEntries(Object.keys(STRUCTURES).map((id) => [id, structure(id)])),
};

const mathPreview = (math) => {
  const mml = mmlFor(math, false, { attrs: {} });
  return mml ? { __html: mml } : null;
};

/** Gallery items with a MathML preview. */
const withPreview = (items, h, big) => items.map((it) => {
  const html = mathPreview(it.math);
  return { id: it.id, label: it.label, group: it.group, preview: html ? h(html, it.label, big) : undefined };
});

/** The galleries: built-ins (Insert > Equation and Equation > Equation), the Structures menus, the symbol set and its switch.
 * None reads the editor, so each serves a canvas draft too (`engine: true`). */
export function galleries(h) {
  const all = galleriesOf(h, () => withPreview(BUILT_INS, h));
  for (const p of Object.values(all)) p.engine = true;
  return all;
}

function galleriesOf(h, built) {
  return {
    'insert.symbols.equation': built,
    'equation.tools.equation': built,
    'equation.symbols.symbols': () => SYMBOL_SETS[setOf()].items.map((i) => ({ id: i.id, label: i.label, preview: i.ch })),
    'equation.symbols.symbols.basicMath': () => Object.entries(SYMBOL_SETS).map(([id, s]) => ({
      id, label: s.label, active: id === setOf(), run: () => setState((st) => ({ word: { ...st.word, eqSymbols: id } })),
    })),
    ...Object.fromEntries(Object.keys(STRUCTURES).map((id) => [id, () => withPreview(STRUCTURES[id], h, true)])),
  };
}
