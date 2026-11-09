// SYMBOL and ADVANCE field arguments (docs/plans/word/plan.md §3 fields-draw; index-fields.md SYMBOL, ADVANCE). Pure.

// The Symbol font's encoding to Unicode, codes 32 to 126 and 160 to 254 (Adobe's Symbol encoding table).
const SYMBOL_LOW = ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼';
const SYMBOL_HIGH = '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓◊〈®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪\u0000〉∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭';

/** The Unicode character the Symbol font draws for `code` (32 to 254, or the same codes at 0xF020 to 0xF0FE), or null. */
export function symbolFontChar(code) {
  const c = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code;
  const ch = c >= 32 && c <= 126 ? SYMBOL_LOW[c - 32] : c >= 160 && c <= 254 ? [...SYMBOL_HIGH][c - 160] : null;
  return ch && ch !== '\u0000' ? ch : null;
}

/** A character number as Word reads it: decimal or 0x hex → a number, or null. */
export function charNumber(v) {
  const s = String(v ?? '').trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s.slice(2), 16);
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

const decode = (enc, bytes) => {
  try {
    return new TextDecoder(enc, { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
};

/** SYMBOL's drawing from its parsed field `f` → {char, font, size (pt or null), keepLine} or {error}. \u reads the number as Unicode,
 * \j draws Word's ###, \a (and no flag below 256) as ANSI (windows-1252); \f Symbol maps through the Symbol font encoding to Unicode;
 * another \f font draws the code in that font, which must be installed (Wingdings 252 is its check mark). */
export function symbolOf(f) {
  const code = charNumber(f.args[0]);
  if (code == null) return { error: 'Error!' };
  const font = typeof f.sw.f === 'string' ? f.sw.f : null;
  const size = Number(f.sw.s);
  let char;
  if (font && /^symbol$/i.test(font)) char = symbolFontChar(code);
  else if (f.sw.u) char = code <= 0x10ffff ? String.fromCodePoint(code) : null;
  // \j: Word drew bold ### for SYMBOL 0x82A0 \j (Shift-JIS あ) in all-features.pdf page 91, in place of the character.
  else if (f.sw.j) return { error: '###' };
  else if (font) char = String.fromCharCode(code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code);
  else char = code < 256 ? decode('windows-1252', [code]) ?? String.fromCharCode(code) : String.fromCodePoint(Math.min(code, 0x10ffff));
  if (!char) return { error: 'Error!' };
  return { char, font: font && !/^symbol$/i.test(font) ? font : null, size: Number.isFinite(size) && size > 0 ? size : null, keepLine: !!f.sw.h };
}

/** ADVANCE's moves from its switches → {left, right, up, down, x, y} in pt (null when absent). */
export function advanceOf(f) {
  const n = (k) => {
    const v = Number(f.sw[k]);
    return f.sw[k] == null || f.sw[k] === true || !Number.isFinite(v) ? null : v;
  };
  return { left: n('l'), right: n('r'), up: n('u'), down: n('d'), x: n('x'), y: n('y') };
}
