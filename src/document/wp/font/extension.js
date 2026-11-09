// The font package's editor extension (docs/plans/word/briefs/font.md, plan.md §1.2): Word's whole-word rule for character
// commands, the overrides of the kit's toggle and size commands so the native chords (Ctrl+B, I, U, Ctrl+[ and ], Ctrl+Shift+. and
// ,) follow it, the drawing the scaffold leaves to font (character scale, text effects, the kerning threshold), the highlighter pen
// and the ruby node view. Works in hidden session editors and story sub-editors too (no DOM assumption beyond view.dom).
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { deepPatch, fontStack, growSize, isPlain, shrinkSize, size1 } from '../../../office.mjs';
import { effectiveProps } from '../../schema.js';
import { wordAround } from './case.mjs';
import { RUBY_JUSTIFY, piecesOf } from './ruby.mjs';
import { effectsCss } from './run.mjs';

// ---------- the whole-word rule ----------
/** The text of textblock `node`, one character per position of its content: each text character as itself, an inline atom as
 * U+FFFC and the open and close token of an inline node with content (a content control) as U+200B, which ends a word. textBetween
 * leaves those tokens out, so its offsets drift from the positions after a content control. */
export function posText(node) {
  const out = Array(node.content.size).fill('​');
  node.descendants((child, pos) => {
    if (child.isText) for (let i = 0; i < child.text.length; i++) out[pos + i] = child.text[i];
    else if (child.isLeaf) out[pos] = '￼';
  });
  return out.join('');
}

/** The word around a collapsed selection in `state` → {from, to}, or null (a range selected, the caret at a word edge or in white
 * space). `edge` also takes a word the caret touches (Shift+F3, Phonetic Guide). The word is read in the textblock around the
 * caret, inside a content control too. */
export function wordRange(state, edge = false) {
  const { empty, $from } = state.selection;
  if (!empty) return null;
  let d = $from.depth;
  while (d > 0 && !$from.node(d).isTextblock) d--;
  if (!$from.node(d).isTextblock) return null;
  const start = $from.start(d);
  const r = wordAround(posText($from.node(d)), $from.pos - start, edge);
  if (!r) return null;
  return { from: start + r[0], to: start + r[1] };
}

/** Runs `fn()` inside command props `p` on the whole word when the caret is strictly inside one (Word's rule), else as is; the caret
 * comes back where it was. Skipped while an input method composes. */
export function onWord(p, fn, edge = false) {
  const r = p.view?.composing ? null : wordRange(p.state, edge);
  if (!r) return fn();
  const { tr } = p;
  const at = tr.selection.from;
  tr.setSelection(TextSelection.create(tr.doc, r.from, r.to));
  const ok = fn();
  tr.setSelection(TextSelection.create(tr.doc, Math.min(at, tr.doc.content.size)));
  return ok;
}

// ---------- run patches ----------
// A JSON attribute is patched key by key (plan.md §1.8), its nulls removing keys; an object left empty is unset.
const merge = (old = {}, patch) => {
  const out = { ...old };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlain(v) ? deepPatch(isPlain(old[k]) ? old[k] : {}, v) : v;
    if (isPlain(out[k]) && !Object.keys(out[k]).length) out[k] = null;
  }
  return out;
};

/** Patches the textStyle of every inline node in `p`'s selection with `patchOf(oldAttrs, parent)` (a patch object, or null to leave
 * the node), as setRunProps does but per node, so a toggle can write against each paragraph's style. At a caret it patches the
 * marks typing goes on with. A textStyle left with nothing set is removed. */
export function patchRuns(p, patchOf) {
  const { state, tr, dispatch } = p;
  const type = state.schema.marks.textStyle;
  const make = (old, patch) => {
    const attrs = merge(old, patch);
    return Object.values(attrs).some((v) => v != null) ? type.create(attrs) : null;
  };
  if (!dispatch) return true;
  const { empty, $from, ranges } = state.selection;
  if (empty) {
    const old = type.isInSet(state.storedMarks ?? $from.marks())?.attrs;
    const patch = patchOf(old ?? {}, $from.parent);
    if (!patch) return true;
    const m = make(old, patch);
    if (m) tr.addStoredMark(m);
    else tr.removeStoredMark(type);
    return true;
  }
  for (const { $from: { pos: from }, $to: { pos: to } } of ranges) {
    state.doc.nodesBetween(from, to, (node, pos, parent) => {
      if (!node.isInline || !parent.type.allowsMarkType(type)) return;
      const old = type.isInSet(node.marks)?.attrs;
      const patch = patchOf(old ?? {}, parent);
      if (!patch) return;
      const a = Math.max(from, pos);
      const b = Math.min(to, pos + node.nodeSize);
      const m = make(old, patch);
      if (m) tr.addMark(a, b, m);
      else tr.removeMark(a, b, type);
    });
  }
  return true;
}

/** Whether every run of `state`'s selection is underlined; read from the chain's state, which onWord has moved to the word. */
export const underlined = (state) => runsOf(state).every((r) => r.marks.some((m) => m.type.name === 'underline'));

/** The text runs of `state`'s selection → [{marks, parent}] (at a caret, the marks typing goes on with). */
export function runsOf(state) {
  const { empty, from, to, $from } = state.selection;
  if (empty) return [{ marks: state.storedMarks ?? $from.marks(), parent: $from.parent }];
  const out = [];
  state.doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (node.isText) out.push({ marks: node.marks, parent });
  });
  return out.length ? out : [{ marks: $from.marks(), parent: $from.parent }];
}

/** A size step command (Grow and Shrink Font, one point) over each selected run from its own size, on the whole word inside one. */
const stepSize = (fn) => () => (p) => onWord(p, () => patchRuns(p, (old, parent) => ({ size: fn(old.size ?? effectiveProps(p.state.doc, parent).run.size ?? 12) })));

// The last underline style picked in the Underline menu: its main part and Ctrl+U apply it (Single first, as in Word).
export const lastUnderline = { val: 'single' };

/** toggleMark on the whole word inside one. */
const toggleOnWord = (name, attrs) => () => (p) => onWord(p, () => p.commands.toggleMark(name, attrs));

// ---------- drawing ----------
const key = new PluginKey('wordFont');

/** The decorations for scale, text effects and the kerning threshold in `doc`: one inline decoration per text node that needs
 * one. ponytail: rebuilt by a walk of every text node on each doc change (linear, about 1 ms per 100 pages); map and patch the
 * changed ranges if long documents show it. */
function decorate(doc) {
  const decos = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText) return true;
    const ts = node.marks.find((m) => m.type.name === 'textStyle')?.attrs;
    if (!ts || (ts.scale == null && !ts.effects && ts.kern == null)) return false;
    const css = { ...effectsCss(ts.effects) };
    const attrs = {};
    if (ts.scale != null && ts.scale !== 100) {
      css.display = 'inline-block';
      css.transform = `scaleX(${ts.scale / 100})`;
      css['transform-origin'] = 'left';
      css['white-space'] = 'pre';
      attrs['data-w-scale'] = String(ts.scale);
      attrs['data-w-at'] = String(pos);
    }
    if (ts.kern != null && (ts.size ?? effectiveProps(doc, parent).run.size ?? 12) < ts.kern) css['font-kerning'] = 'none';
    const fx = ts.effects;
    if (fx?.outline?.width || fx?.shadow || fx?.glow?.size || fx?.reflection) attrs['data-w-fx'] = String(pos);
    const style = Object.entries(css).map(([k, v]) => `${k}: ${v}`).join('; ');
    if (style) decos.push(Decoration.inline(pos, pos + node.nodeSize, { ...attrs, class: 'w-font-run', style }));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/** Corrects the advance of every scaled run: scaleX leaves the layout width unscaled, so a margin of (scale - 1) times the width
 * moves the text after it, per piece where the run draws as several. The run is an inline-block, so it keeps to one line
 * (recorded in the report). The margins go into a style sheet of the view's own, keyed by the run's position: a style written on
 * the decoration's element is a DOM mutation ProseMirror redraws, which undid the margin and looped. */
let views = 0;
function scaleSheet(view) {
  const id = String(++views);
  view.dom.setAttribute('data-w-font-view', id);
  const sheet = document.createElement('style');
  document.head.append(sheet);
  const fit = () => {
    const rules = [];
    let prev = null;
    let k = 0;
    for (const el of view.dom.querySelectorAll('[data-w-scale]')) {
      // Another decoration inside the run (spellcheck off on its digits) splits it into sibling pieces of one position: the
      // k-th piece's rule chains k sibling selectors, so each piece gets its own width's margin.
      const at = `[data-w-at="${el.getAttribute('data-w-at')}"]`;
      k = prev && el.previousElementSibling === prev && prev.matches(at) ? k + 1 : 0;
      prev = el;
      const s = Number(el.getAttribute('data-w-scale')) / 100;
      rules.push(`[data-w-font-view="${id}"] ${Array(k + 1).fill(at).join(' + ')} { margin-right: ${((s - 1) * el.offsetWidth).toFixed(2)}px; }`);
    }
    const css = rules.join('\n');
    if (sheet.textContent !== css) sheet.textContent = css;
  };
  return { fit, remove: () => sheet.remove() };
}

/** The highlighter pen of the highlight state in `state`: the colour name while armed, else null. */
export const armedPen = (state) => (state && key.getState(state)?.pen) ?? null;
/** Arms (`pen`, a highlight name) or disarms (null) the highlighter pen of `editor`. */
export const setPen = (editor, pen) => editor?.view.dispatch(editor.state.tr.setMeta(key, { pen }));

/** The ruby node's view (ruby.mjs has Word's rules): an empty box that opens the line as far as the reading needs (its room comes
 * from the paragraph drawing as --w-ruby-up and --w-ruby-down), then a one-cell grid holding the base and the reading on one
 * baseline, as wide as the wider of them, the reading moved up by its offset. The reading's line height is 0, so its box and
 * descent add nothing to the line. */
function rubyView(node) {
  const dom = document.createElement('ruby');
  dom.className = 'w-ruby';
  const strut = document.createElement('span');
  strut.className = 'w-ruby-strut';
  const box = document.createElement('span');
  box.className = 'w-ruby-box';
  const rb = document.createElement('span');
  rb.className = 'w-rb';
  const rt = document.createElement('rt');
  box.append(rb, rt);
  dom.append(strut, box);
  const fill = (el, text, align) => {
    const pieces = piecesOf(text, align);
    el.replaceChildren(...pieces.map((t) => Object.assign(document.createElement('span'), { textContent: t })));
    // One piece cannot spread: it stays centred.
    el.style.justifyContent = pieces.length > 1 || !/^distribute/.test(align) ? RUBY_JUSTIFY[align] ?? 'space-around' : 'center';
  };
  const draw = (n) => {
    const { base, text, size, offset, font, align } = n.attrs;
    dom.dataset.align = align;
    fill(rb, base, align);
    fill(rt, text, align);
    rt.style.fontSize = size ? `${size}pt` : '';
    rt.style.fontFamily = font ? fontStack(font) : '';
    rt.style.top = offset ? `${-offset}pt` : '';
  };
  draw(node);
  return { dom, update: (n) => n.type === node.type && (draw(n), true), ignoreMutation: () => true };
}

/** The font package's extension: priority 50, after the kit's marks and RunProps, so its commands of the same names win
 * (TipTap collects commands in priority order, later ones replacing earlier ones). */
export const FontKit = Extension.create({
  name: 'wordFont',
  priority: 50,
  addCommands() {
    return {
      toggleBold: toggleOnWord('bold'),
      toggleItalic: toggleOnWord('italic'),
      toggleStrike: toggleOnWord('strike'),
      toggleSubscript: toggleOnWord('subscript'),
      toggleSuperscript: toggleOnWord('superscript'),
      // Ctrl+U and the main part toggle the last style picked, as Word's Underline button does.
      toggleUnderline: () => (p) => onWord(p, () => (underlined(p.state) ? p.commands.unsetMark('underline') : p.commands.setMark('underline', { val: lastUnderline.val }))),
      growFont: stepSize(growSize),
      shrinkFont: stepSize(shrinkSize),
      growFont1: stepSize((pt) => size1(pt, 1)),
      shrinkFont1: stepSize((pt) => size1(pt, -1)),
    };
  },
  addProseMirrorPlugins() {
    let timer = null;
    return [new Plugin({
      key,
      state: {
        init: (_c, state) => ({ deco: decorate(state.doc), pen: null }),
        apply: (tr, old) => {
          const meta = tr.getMeta(key);
          return { deco: tr.docChanged ? decorate(tr.doc) : old.deco, pen: meta ? meta.pen : old.pen };
        },
      },
      props: {
        decorations: (state) => key.getState(state).deco,
        attributes: (state) => (key.getState(state).pen ? { 'data-highlighter': key.getState(state).pen } : {}),
        nodeViews: { ruby: rubyView },
        handleKeyDown: (view, e) => {
          if (e.key !== 'Escape' || !key.getState(view.state).pen) return false;
          view.dispatch(view.state.tr.setMeta(key, { pen: null }));
          return true;
        },
        handleDOMEvents: {
          // Armed, each selection the mouse makes is highlighted once the button comes up.
          mouseup: (view) => {
            if (!key.getState(view.state).pen) return false;
            clearTimeout(timer);
            timer = setTimeout(() => {
              const pen = key.getState(view.state)?.pen;
              if (!pen || view.isDestroyed || view.state.selection.empty) return;
              const tr = view.state.tr;
              patchRuns({ state: view.state, tr, dispatch: true }, () => ({ highlight: pen }));
              view.dispatch(tr);
            }, 0);
            return false;
          },
        },
      },
      view: (view) => {
        const scaled = scaleSheet(view);
        // A fit reads the scaled runs' widths, which lays the whole document out: once a frame at most, after the text changed
        // (the rules are keyed by position), never inside a transaction (on a long document every page-end transaction laid
        // the document out again).
        let frame = 0;
        const soon = () => {
          frame ||= requestAnimationFrame(() => {
            frame = 0;
            if (!view.isDestroyed) scaled.fit();
          });
        };
        soon();
        return { update: (v, prev) => v.state.doc !== prev.doc && soon(), destroy: () => (clearTimeout(timer), cancelAnimationFrame(frame), scaled.remove()) };
      },
    })];
  },
});
