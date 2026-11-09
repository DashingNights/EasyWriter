// DISPLAYBARCODE and MERGEBARCODE drawings (docs/plans/word/plan.md §3 fields-draw): the data and type checked as Word checks
// them, the switches read, and the symbol drawn as an SVG string sized in pt (shown at CSS px, 1 pt = 4/3 px). Pure.
// Sizes measured on Word's PDF drawings (docs/plans/word/probe/fields/out2.pdf): QR 2.8515 pt a module with a 4-module quiet zone
// (a version 2 symbol is 94.1 pt wide at 100 %), linear codes 84 pt tall, ITF 72 pt, JPPOST 23.76 pt; \h sets the height and
// scales the width with it, as Word's CODE128 \h 720 drew 59.42 by 36 pt.
import { encodeQR, qrSupports } from './qr.mjs';
import { code128, code39, ean13, ean8, ERR, itf14, jppost, nw7, upca, upce } from './linear.mjs';

export { ERR };
export const QR_MODULE = 2.8515;
/** The level Word draws: the format bits of Word's own symbol read Q (out2.pdf), with or without \q. */
export const QR_DEFAULT_LEVEL = 'Q';
const LINEAR_HEIGHT = 84;
const GUARD_DROP = 1.54;

/** The types and the name MERGEBARCODE shows without merge data («Address QR Code», «Zip Code 128»; the other names are ours). */
export const TYPE_NAMES = { QR: 'QR Code', CODE128: 'Code 128', CODE39: 'Code 39', EAN8: 'EAN-8', EAN13: 'EAN-13', UPCA: 'UPC-A', UPCE: 'UPC-E',
  ITF14: 'ITF-14', CASE: 'Case Code', NW7: 'NW-7', JPPOST: 'Japan Post' };

/** A 0xBBGGRR colour switch value → '#rrggbb', or null when it is no number. */
export function bgrColor(v) {
  if (v == null || v === true) return null;
  const s = String(v).trim();
  const n = /^0x[0-9a-f]+$/i.test(s) ? parseInt(s.slice(2), 16) : /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isFinite(n) || n > 0xffffff) return null;
  const hex = (x) => x.toString(16).padStart(2, '0');
  return `#${hex(n & 0xff)}${hex((n >> 8) & 0xff)}${hex((n >> 16) & 0xff)}`;
}

const num = (v) => (v == null || v === true || !/^-?\d+$/.test(String(v).trim()) ? null : Number(v));

/** The symbol for `data` of `type` with switches `sw` (ParsedField.sw) → {kind: 'qr'|'linear'|'jp', ...} or {error}. */
export function barcodeOf(data, type, sw = {}) {
  const t = String(type ?? '').toUpperCase();
  if (!TYPE_NAMES[t]) return { error: ERR.params };
  const text = String(data ?? '');
  if (t === 'QR') {
    // ponytail: Word disagrees with itself on empty data (out2.pdf: the length error; out4.pdf: unsupported characters), so the
    // length error stays until a new probe settles it.
    if (!text) return { error: ERR.length };
    if (!qrSupports(text)) return { error: ERR.chars };
    // Word draws level Q whatever \q says: all-features.pdf page 84 has \q 0, 1, 2 and 3 as one symbol, module for module.
    const qr = encodeQR(text, QR_DEFAULT_LEVEL);
    return qr ? { kind: 'qr', qr } : { error: ERR.length };
  }
  const style = typeof sw.p === 'string' ? sw.p.toUpperCase() : 'STD';
  let sym;
  if (t === 'CODE128') sym = code128(text);
  else if (t === 'CODE39') sym = code39(text, { check: !!sw.x, stops: !!sw.d });
  else if (t === 'EAN8') sym = ean8(text);
  else if (t === 'EAN13') sym = ean13(text, style);
  else if (t === 'UPCA') sym = upca(text, style);
  else if (t === 'UPCE') sym = upce(text);
  else if (t === 'ITF14') sym = itf14(text, { ext: typeof sw.c === 'string' ? sw.c.toUpperCase() : 'STD' });
  else if (t === 'CASE') sym = itf14(text, { kind: 'CASE' });
  else if (t === 'NW7') sym = nw7(text, { stops: !!sw.d, check: !!sw.x });
  else sym = jppost(text);
  if (sym.error) return sym;
  return { kind: t === 'JPPOST' ? 'jp' : 'linear', type: t, sym };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const r2 = (x) => Math.round(x * 1000) / 1000;

/** The drawing of symbol `b` (from barcodeOf) with switches `sw` → {svg, width, height} (pt, after scale and rotation). */
export function barcodeSvg(b, sw = {}) {
  const s = num(sw.s);
  const scale = s != null && s >= 10 && s <= 1000 ? s / 100 : 1;
  const rot = ((num(sw.r) ?? 0) % 4 + 4) % 4;
  const fg = bgrColor(sw.f) ?? '#000000';
  const bg = bgrColor(sw.b) ?? '#ffffff';
  let w;
  let h;
  let body;
  let attrs = '';
  if (b.kind === 'qr') {
    const n = b.qr.size + 8;
    w = h = n;
    let d = '';
    b.qr.modules.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + 4} ${y + 4}h1v1h-1z`)));
    body = `<rect width="${n}" height="${n}" fill="${bg}"/><path d="${d}" fill="${fg}"/>`;
    attrs = ` data-qr-version="${b.qr.version}" data-qr-level="${b.qr.level}" data-qr-mask="${b.qr.mask}"`;
    const pt = n * QR_MODULE * scale;
    return wrap(body, w, h, pt, pt, rot, attrs);
  }
  if (b.kind === 'jp') {
    const { states, pitch, barWidth, height } = b.sym;
    w = (states.length - 1) * pitch + barWidth;
    h = height;
    const third = height / 3;
    const rects = [...states].map((st, i) => {
      const [y0, y1] = { 1: [0, 3], 2: [0, 2], 3: [1, 3], 4: [1, 2] }[st];
      return `<rect x="${r2(i * pitch)}" y="${r2(y0 * third)}" width="${barWidth}" height="${r2((y1 - y0) * third)}"/>`;
    }).join('');
    body = `<rect width="${r2(w)}" height="${h}" fill="${bg}"/><g fill="${fg}">${rects}</g>`;
    const k = scale;
    return wrap(body, w, h, w * k, h * k, rot);
  }
  // Linear codes, drawn in pt at the default height, then scaled by \h and \s together.
  const sym = b.sym;
  const u = sym.unit;
  const bearer = (sym.bearer ?? 0) * u;
  const frame = sym.frame ? 5 * u : 0; // EAN \p CASE: a bearer frame around the symbol with a gap
  const pad = bearer + frame * 2;
  const total = sym.bars.reduce((a, x) => a + x, 0);
  const left = pad + sym.quiet * u;
  w = left * 2 + total * u;
  // ITF-14 and CASE are 72 pt tall with their bearers (out2.pdf; all-features.pdf page 83: 72.1 and 72.0 pt).
  const tall = sym.bearer ? 72 - pad * 2 : LINEAR_HEIGHT;
  const guards = sym.guards ?? null;
  // The EAN and UPC guard bars reach 1.54 pt below the others, inside the picture (Word's EAN-8 85.5 pt, EAN-13 85.6, page 82).
  h = tall + pad * 2 + (guards ? GUARD_DROP : 0);
  const showText = !!sw.t;
  const fontSize = 9;
  const textH = showText ? fontSize * 1.25 : 0;
  const top = pad;
  const barH = tall - textH;
  const moduleAt = (x) => left + x * u;
  const parts = [];
  let x = 0;
  sym.bars.forEach((bw, i) => {
    if (i % 2 === 0) {
      const isGuard = guards?.some(([a, z]) => x >= a && x < z);
      const inAddon = sym.addon && x >= sym.addon.at;
      // Guard bars run longer than the data bars (and past the text with \t); add-on bars start lower to leave room for its digits.
      const y0 = inAddon && showText ? top + textH : top;
      const y1 = isGuard ? top + tall - (showText ? textH / 2 : -GUARD_DROP) : top + barH;
      parts.push(`<rect x="${r2(moduleAt(x))}" y="${r2(y0)}" width="${r2(bw * u)}" height="${r2(y1 - y0)}"/>`);
    }
    x += bw;
  });
  if (bearer) {
    parts.push(`<rect x="0" y="0" width="${r2(w)}" height="${r2(bearer)}"/>`, `<rect x="0" y="${r2(h - bearer)}" width="${r2(w)}" height="${r2(bearer)}"/>`,
      `<rect x="0" y="0" width="${r2(bearer)}" height="${r2(h)}"/>`, `<rect x="${r2(w - bearer)}" y="0" width="${r2(bearer)}" height="${r2(h)}"/>`);
  }
  if (frame) {
    const f = frame;
    parts.push(`<path fill="none" stroke="${fg}" stroke-width="${r2(f)}" d="M${r2(f / 2)} ${r2(f / 2)}H${r2(w - f / 2)}V${r2(h - f / 2)}H${r2(f / 2)}Z"/>`);
  }
  if (showText) {
    const ty = top + tall - textH * 0.2;
    for (const g of sym.text ?? []) {
      if (g.at === 'all') {
        parts.push(`<text x="${r2(w / 2)}" y="${r2(ty)}" text-anchor="middle">${esc(g.text)}</text>`);
      } else {
        const cx = moduleAt(g.left + g.width / 2);
        const spread = g.text.length > 1 ? ` textLength="${r2(g.width * u * 0.86)}" lengthAdjust="spacing"` : '';
        parts.push(`<text x="${r2(cx)}" y="${r2(ty)}" text-anchor="middle"${spread}>${esc(g.text)}</text>`);
      }
    }
    if (sym.addon) {
      const cx = moduleAt(sym.addon.at + (sym.addon.text.length === 2 ? 10 : 23.5));
      parts.push(`<text x="${r2(cx)}" y="${r2(top + textH * 0.8)}" text-anchor="middle">${esc(sym.addon.text)}</text>`);
    }
  }
  body = `<rect width="${r2(w)}" height="${r2(h)}" fill="${bg}"/><g fill="${fg}" font-size="${fontSize}" font-family="Arial, sans-serif">${parts.join('')}</g>`;
  const hs = num(sw.h);
  const k = (hs != null && hs > 0 ? hs / 20 / h : 1) * scale;
  return wrap(body, w, h, w * k, h * k, rot);
}

/** The outer <svg>: viewBox in drawing units, size in px, rotated clockwise by `rot` quarter turns. */
function wrap(body, w, h, wPt, hPt, rot, attrs = '') {
  const odd = rot % 2 === 1;
  const vw = odd ? h : w;
  const vh = odd ? w : h;
  const t = ['', `translate(${r2(h)} 0) rotate(90)`, `translate(${r2(w)} ${r2(h)}) rotate(180)`, `translate(0 ${r2(w)}) rotate(270)`][rot];
  const outW = odd ? hPt : wPt;
  const outH = odd ? wPt : hPt;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r2(vw)} ${r2(vh)}" width="${r2((outW * 4) / 3)}" height="${r2((outH * 4) / 3)}" ` +
    `shape-rendering="crispEdges" data-rotate="${rot * 90}"${attrs}>${t ? `<g transform="${t}">${body}</g>` : body}</svg>`;
  return { svg, width: outW, height: outH };
}

/** DISPLAYBARCODE's result: Word's Result.Text is empty, so the result is '' or the error. */
export function barcodeResult(data, type, sw) {
  const b = barcodeOf(data, type, sw);
  return b.error ? { error: b.error } : { text: '', raw: true };
}
