// fields-draw (docs/plans/word/plan.md §3 fields-draw): the fields Word draws instead of printing text. DISPLAYBARCODE and
// MERGEBARCODE (QR and the linear codes, our own encoders), the legacy BARCODE, EQ as MathML, SYMBOL and ADVANCE, and the Enclose
// Characters dialog, which writes EQ \o\ac. Each type's compute gives Word's empty result (or the error), and draw() fills the
// field's element that fields-core's node view hands it (plan §1.10 FieldType.draw).
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { insertField } from '../../fields/engine.js';
import { fieldCtx, parseField } from '../../fields/registry.mjs';
import { barcodeOf, barcodeSvg, TYPE_NAMES } from './barcode.mjs';
import { EncloseDialog } from './EncloseDialog.jsx';
import { encloseCode, enclosedOf, parseEq } from './eq.mjs';
import { eqLayout, eqSvg } from './eqbox.mjs';
import { encodeQR } from './qr.mjs';
import { glyphRoom, overflowRoom, pictureRoom } from './room.mjs';
import { advanceOf, symbolOf } from './symbol.mjs';

const EMPTY = { text: '', raw: true };

// The inline styles the drawings set on the field's element, cleared before each draw so a code edited into another type starts clean.
const OWN_STYLES = ['display', 'width', 'margin-left', 'line-height', 'vertical-align'];
function clear(el) {
  for (const p of OWN_STYLES) el.style.removeProperty(p);
  el.replaceChildren();
}

/** Word draws an error as bold text in the field's font instead of the picture. */
function drawError(el, text) {
  const b = document.createElement('b');
  b.className = 'fd-error';
  b.textContent = text;
  el.append(b);
}

function drawHtml(el, html, cls) {
  el.insertAdjacentHTML('afterbegin', html);
  el.firstElementChild?.classList.add(cls);
}

// ---------- the font a field draws in ----------
let canvas = null;
const boxes = new Map(); // style, weight and family → {a, d}: the font's ascent and descent over its size, as the browser draws it
/** The ascent and descent over the size of the font `face` (style and weight) `family` (its first family the browser has). Read
 * at 1,000 px: the browser rounds them to whole pixels (Aptos at 16 px gave 1.25 em for its 1.2207). */
function boxOf(face, family) {
  const key = `${face} ${family}`;
  let b = boxes.get(key);
  if (!b) {
    canvas ??= document.createElement('canvas').getContext('2d');
    canvas.font = `${face} 1000px ${family}`;
    const m = canvas.measureText('H');
    b = { a: m.fontBoundingBoxAscent / 1000 || 0.9, d: m.fontBoundingBoxDescent / 1000 || 0.25 };
    boxes.set(key, b);
  }
  return b;
}

/** The font element `el` draws in → {s (pt), a, d (ascent and descent over the size), box(family, pt), width(text, k, family) (em)},
 * or null while it is not in the document (a node view draws before ProseMirror places it). */
function fontOf(el) {
  if (!el.isConnected) return null;
  const cs = getComputedStyle(el);
  const px = parseFloat(cs.fontSize) || 16;
  const face = `${cs.fontStyle} ${cs.fontWeight}`;
  const css = (fam, size = px) => `${face} ${size}px ${fam}`;
  const { a, d } = boxOf(face, cs.fontFamily);
  return {
    s: px * 0.75, a, d,
    /** The ascent and descent in pt of `family` at `pt`. */
    box: (family, pt) => {
      const b = boxOf(face, family);
      return { A: b.a * pt, D: b.d * pt };
    },
    width: (text, k = 1, family = null) => {
      canvas.font = css(family ?? cs.fontFamily, px * k);
      return canvas.measureText(text).width / px;
    },
  };
}

/** Runs `draw(font)` with the font `el` draws in: now, or once ProseMirror has placed it (the node view's first draw), as long as
 * `key` is still what the element shows. */
function withFont(el, key, draw) {
  el.dataset.fdKey = key;
  const go = (tries) => {
    if (el.dataset.fdKey !== key) return;
    const font = fontOf(el);
    if (font) draw(font);
    else if (tries < 20) requestAnimationFrame(() => go(tries + 1));
  };
  const font = fontOf(el);
  if (font) draw(font);
  else queueMicrotask(() => go(0));
}

/** Adds the room inline (room.mjs) after the drawing, when the drawing needs room in its line. */
function room(el, css) {
  if (!css) return;
  const r = document.createElement('span');
  r.className = 'fd-room';
  r.style.cssText = css;
  r.textContent = '‌';
  el.append(r);
}

// ---------- barcodes ----------
/** The symbol of a DISPLAYBARCODE or MERGEBARCODE field, or {text} for MERGEBARCODE without merge data (Word's «Address QR Code»). */
function barcodeFor(f, ctx) {
  const type = String(f.args[1] ?? '').toUpperCase();
  if (f.name !== 'MERGEBARCODE') return barcodeOf(f.args[0], type, f.sw);
  const record = ctx.get('record');
  if (!record) return { text: `«${f.args[0] ?? ''} ${TYPE_NAMES[type] ?? type}»` };
  return barcodeOf(record.value(f.args[0]) ?? '', type, f.sw);
}

const barcodeType = (category, updates) => ({
  category,
  updates,
  bare: 'tdx',
  compute(f, ctx) {
    const b = barcodeFor(f, ctx);
    return b.error ? { error: b.error } : b.text ? { text: b.text, raw: true } : EMPTY;
  },
  draw(f, ctx, el) {
    clear(el);
    const b = barcodeFor(f, ctx);
    if (b.error) return drawError(el, b.error);
    if (b.text) return void (el.textContent = b.text);
    const pic = barcodeSvg(b, f.sw);
    drawHtml(el, pic.svg, 'fd-barcode');
    // Word sizes the line by the picture under the line spacing's multiple (room.mjs).
    withFont(el, f.code, (font) => {
      el.querySelector(':scope > .fd-room')?.remove();
      room(el, pictureRoom(pic.height, font.a * font.s, font.d * font.s));
    });
  },
});

// The legacy POSTNET and FIM field is dead in Word's build: every probe drew this (index-fields.md).
const ZIP_INVALID = 'Zip code not valid!';

// ---------- EQ, SYMBOL, ADVANCE ----------
/** The parsed EQ code, or null on Word's "Error!". */
function eqNodes(code) {
  try {
    return parseEq(code);
  } catch {
    return null;
  }
}

const EQ = {
  category: 'Equations and Formulas',
  updates: 'manual',
  compute: (f) => (eqNodes(f.code) ? EMPTY : { error: 'Error!' }),
  draw(f, ctx, el) {
    clear(el);
    const nodes = eqNodes(f.code);
    if (!nodes) return drawError(el, 'Error!');
    // Word's EQ layout needs the font's measures (eqbox.mjs): drawn once the element is placed.
    withFont(el, f.code, (font) => {
      el.replaceChildren();
      const box = eqLayout(nodes, font);
      el.insertAdjacentHTML('afterbegin', eqSvg(box));
      room(el, overflowRoom((box.asc - font.a) * font.s, (box.desc - font.d) * font.s));
    });
  },
};

const SYMBOL = {
  category: 'Equations and Formulas',
  updates: 'manual',
  bare: 'haju',
  compute: (f) => {
    const s = symbolOf(f);
    return s.error ? { error: s.error } : EMPTY;
  },
  draw(f, ctx, el) {
    clear(el);
    const s = symbolOf(f);
    if (s.error) return drawError(el, s.error);
    const span = document.createElement('span');
    span.className = 'fd-symbol';
    span.textContent = s.char;
    const family = s.font ? `"${s.font.replace(/"/g, '')}"` : null;
    if (family) span.style.fontFamily = family;
    if (s.size) span.style.fontSize = `${s.size}pt`;
    // Until its font is read the glyph takes no line height of its own; \h keeps the line's height for good, so the glyph may
    // overlap the line above, as in Word.
    span.style.lineHeight = '0';
    el.append(span);
    if (s.keepLine) return;
    withFont(el, f.code, (font) => {
      el.replaceChildren(span);
      const pt = s.size ?? font.s;
      // Word adds what the glyph's font box reaches past the text's to the line, unscaled (room.mjs; \s 14 in Wingdings grew
      // the line by 1.32 pt).  Symbol draws its Unicode character in the text's font, but Word sizes the line by the Symbol font.
      const named = typeof f.sw.f === 'string' ? `"${f.sw.f.replace(/"/g, '')}"` : null;
      const g = font.box(named ?? getComputedStyle(el).fontFamily, pt);
      span.style.cssText += `;${glyphRoom(g.A - font.a * font.s, g.D - font.d * font.s)}`;
      // A glyph wider than the column breaks out of its word as Word breaks a word wider than a line: the text before it stays
      // on its line (\s 1638: "x" stays beside the label, the glyph takes the next line and "y" the one after).
      const column = el.closest('p, h1, h2, h3, h4, h5, h6, li, td, th')?.clientWidth ?? Infinity;
      if (font.width(s.char, pt / font.s, family) * font.s * (4 / 3) > column) {
        span.before(document.createElement('wbr'));
        span.after(document.createElement('wbr'));
      }
    });
  },
};

const ADVANCE = {
  category: 'Equations and Formulas',
  updates: 'manual',
  compute: () => EMPTY,
  draw(f, ctx, el) {
    clear(el);
    const a = advanceOf(f);
    // \r and \l move what follows through the element's width or a negative margin; \u and \d are the plugin's decoration below;
    // \y (from the page top) is not drawn.
    if (a.right != null || a.x != null) el.style.display = 'inline-block';
    if (a.right != null) el.style.width = `${Math.max(0, a.right)}pt`;
    if (a.left != null) el.style.marginLeft = `${-a.left}pt`;
    if (a.x != null) requestAnimationFrame(() => placeAt(el, a.x));
  },
};

/** ADVANCE \x: widens the element so the text after it starts `x` pt from the column's left edge, measured now. */
function placeAt(el, x) {
  const root = el.isConnected ? el.closest('.ProseMirror') : null;
  if (!root) return;
  el.style.width = '0px';
  const box = root.getBoundingClientRect();
  const zoom = box.width / (root.offsetWidth || box.width || 1);
  const left = box.left + (parseFloat(getComputedStyle(root).paddingLeft) || 0) * zoom;
  const at = (el.getBoundingClientRect().left - left) / zoom;
  el.style.width = `${Math.max(0, (x * 4) / 3 - at)}px`;
}

// ADVANCE \u and \d raise or lower the rest of the field's paragraph.
// ponytail: the move runs to the paragraph's end, not the end of the drawn line; a line-aware split needs the line boxes.
const advanceKey = new PluginKey('fieldsDrawAdvance');
/** Whether a transaction's changed ranges, or the paragraph they start in, hold a field node (text typed after an ADVANCE that
 * ended its paragraph needs the shift). A step with no ranges, such as an attribute step, counts as yes. */
function touchesField(tr) {
  const isField = (n) => n.type.name === 'field';
  for (let i = 0; i < tr.steps.length; i++) {
    const after = tr.mapping.slice(i + 1);
    let any = false;
    let hit = false;
    tr.mapping.maps[i].forEach((_a, _b, from, to) => {
      any = true;
      const a = after.map(from, -1);
      const b = after.map(to, 1);
      tr.doc.resolve(a).parent.forEach((n) => { hit ||= isField(n); });
      if (!hit) tr.doc.nodesBetween(a, b, (n) => !(hit ||= isField(n)));
    });
    if (hit || !any) return true;
  }
  return false;
}

function advanceDecorations(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'field') return true;
    if (!/^\s*ADVANCE\b/i.test(node.attrs.code ?? '')) return false;
    const a = advanceOf(parseField(node.attrs.code));
    const shift = (a.down ?? 0) - (a.up ?? 0);
    const end = doc.resolve(pos).end();
    if (shift && end > pos + node.nodeSize) out.push(Decoration.inline(pos + node.nodeSize, end, { style: `position:relative;top:${shift}pt` }));
    return false;
  });
  return out.length ? DecorationSet.create(doc, out) : DecorationSet.empty;
}

const AdvanceShift = Extension.create({
  name: 'fieldsDrawAdvance',
  addProseMirrorPlugins: () => [
    new Plugin({
      key: advanceKey,
      state: {
        init: (_, state) => advanceDecorations(state.doc),
        // Typing in a document with no shifted text and no field in the edit skips the walk.
        // ponytail: any edit rescans the whole document while one ADVANCE shift exists; map the set and rescan ranges if that shows.
        apply: (tr, old) => (!tr.docChanged || (old === DecorationSet.empty && !touchesField(tr)) ? old : advanceDecorations(tr.doc)),
      },
      props: { decorations: (state) => advanceKey.getState(state) },
    }),
  ],
});

// ---------- Enclose Characters ----------
/** The field node selected, when the selection is one Enclose Characters field → {node, enclosed}. */
function enclosedSelection(state) {
  const node = state.selection.node;
  if (node?.type.name !== 'field') return null;
  const enclosed = enclosedOf(node.attrs.code);
  return enclosed ? { node, enclosed } : null;
}

const encloseCharacters = {
  enabled: (ctx) => !!ctx.target,
  async run(ctx) {
    const ed = ctx.target;
    if (!ed) return false;
    const was = enclosedSelection(ed.state);
    const { from, to } = ed.state.selection;
    // Word encloses the selection's first character only, so that character is the range OK replaces.
    let range = null;
    if (!was) {
      ed.state.doc.nodesBetween(from, to, (n, pos) => {
        if (range || !n.isText) return !range;
        const at = Math.max(from, pos);
        const ch = String.fromCodePoint(n.text.codePointAt(at - pos));
        range = { from: at, to: at + ch.length, ch };
        return false;
      });
    }
    const first = was ? was.enclosed.text : range?.ch ?? '';
    const r = await ctx.dialog('encloseCharacters', { text: first, ...(was ? { enclosure: was.enclosed.enclosure } : {}) });
    if (!r) return false;
    if (r.style === 'none') {
      // None on an enclosed character writes its text back; on plain text there is nothing to undo.
      if (!was) return false;
      return ed.chain().focus().insertContent({ type: 'text', text: was.enclosed.text, marks: was.node.marks.map((m) => m.toJSON()) }).run();
    }
    if (!r.text) return false;
    const marks = (was ? was.node.marks : ed.state.doc.nodeAt(range?.from ?? from)?.marks ?? []).map((m) => m.toJSON());
    if (range) ed.chain().focus().setTextSelection(range).run();
    else ed.commands.focus();
    return insertField(ed, encloseCode(r.enclosure, r.text), { result: '', marks });
  },
};

// The harness's hook (plan §1.16): the encoder, and a draw into any element while no field node view calls draw().
if (typeof window !== 'undefined') {
  window.__fieldsDraw = {
    qr: (text, level) => {
      const q = encodeQR(text, level);
      return q && { version: q.version, mask: q.mask, level: q.level, modules: q.modules.map((row) => row.map((c) => (c ? 1 : 0)).join('')) };
    },
    draw: (el, code) => {
      const f = parseField(code);
      const type = MODULE.fields[f.name];
      type?.draw(f, fieldCtx({ doc: null }), el, {});
      return !!type;
    },
  };
}

const MODULE = {
  id: 'fields-draw',
  fields: {
    DISPLAYBARCODE: barcodeType('All', 'manual'),
    MERGEBARCODE: barcodeType('Mail Merge', 'merge'),
    BARCODE: {
      category: 'Numbering',
      updates: 'manual',
      compute: () => ({ error: ZIP_INVALID }),
      draw(f, ctx, el) {
        clear(el);
        drawError(el, ZIP_INVALID);
      },
    },
    EQ,
    SYMBOL,
    ADVANCE,
  },
  commands: { 'home.font.encloseCharacters': encloseCharacters },
  dialogs: { encloseCharacters: EncloseDialog },
  extensions: [AdvanceShift],
  implements: ['fields.EQ', 'fields.DISPLAYBARCODE', 'fields.MERGEBARCODE', 'fields.BARCODE', 'fields.SYMBOL', 'fields.ADVANCE'],
};

export default MODULE;
