// Word's single line of a font, read from the font file (docs/plans/word/briefs/font-metrics.md). Word's PDF of the fixture shows
// which figures Word takes (12 pt text with the fixture's 278/240 line multiple):
//   Aptos, which sets USE_TYPO_METRICS (OS/2 fsSelection bit 7): single 14.64 pt, so 1.2207 em, its typographic ascender plus
//     descender; its Windows figures (usWinAscent plus usWinDescent, 1.2847 em) would give 15.42 pt.
//   Gabriola, which sets it too: 1.7 em, the typographic figures with sTypoLineGap (0.7 em) on top; Windows would give 1.84.
//   Times New Roman, which does not: 1.15 em, usWinAscent plus usWinDescent (1.1074) plus hhea's line gap (0.0425).
//   Calibri, which does not: 1.2207 em, the Windows figures alone. Its hhea line gap (0.2207) only fills the room between hhea's
//     ascender and descender (1.0) and the Windows figures, so nothing is added.
// That is GDI's rule (the external leading is what of hhea's line gap the Windows figures leave over) and DirectWrite's, which
// LibreOffice also follows to match Word. A CJK font (one whose OS/2 code page bits name a Japanese, Chinese or Korean code page)
// gets at least 30% of its Windows figures as external leading, the rule LibreOffice's Windows font metrics copy from Word: in
// Word's PDF of the snap-grid-asian probe (fixture/walk/grid_probe_docx.py, cjk.docx) a CJK line at 12 pt single is 16.32 pt in
// DengXian (1.042 em x 1.3), 20.52 in Microsoft YaHei (1.32 x 1.3), 15.60 in SimSun and PMingLiU (1.0 x 1.3, over their own
// 1.14 and 1.2), 20.76 in Microsoft JhengHei and Malgun Gothic (1.33 x 1.3).
// Plain web APIs (Blob.slice, DataView), so the page, a worker and Node tests run it: only the table directory and the head, hhea and OS/2 tables (and in a collection, each face's name table) are read, never a whole
// 20 MB CJK font.

/** Word's single line over the font size from a font's numbers: {upm, useTypo, winAscent, winDescent, typoAscender,
 * typoDescender, typoLineGap, ascender, descender, lineGap (the last three hhea's; descenders negative), cjk}. */
export function singleLine(m) {
  const own = ownLine(m);
  const win = m.winAscent + m.winDescent;
  return m.cjk && win > 0 ? Math.max(own, (win * 1.3) / m.upm) : own;
}

function ownLine(m) {
  if (m.useTypo && m.typoAscender - m.typoDescender > 0) return (m.typoAscender - m.typoDescender + m.typoLineGap) / m.upm;
  const hhea = m.ascender - m.descender;
  if (m.winAscent + m.winDescent > 0) {
    const win = m.winAscent + m.winDescent;
    return (win + Math.max(0, m.lineGap - (win - hhea))) / m.upm;
  }
  return (hhea + m.lineGap) / m.upm;
}

/** Word's ascent over the font size from the same numbers: the single line less the descent singleLine takes (the typographic one
 * under USE_TYPO_METRICS, else the Windows one), so a line gap counts above the text. Calibri 0.9521, Aptos 0.939, Symbol 1.0054.
 * A list number in a font that rises higher than its text raises the line by the difference (paragraph/extension.js labelRaise).
 * A CJK font's added leading (singleLine) splits evenly above and below its text, as Word's East Asian lines do (font-pages'
 * probe), so half of it counts here. */
export function ascentOf(m) {
  const typo = m.useTypo && m.typoAscender - m.typoDescender > 0;
  const desc = typo ? -m.typoDescender : m.winAscent + m.winDescent > 0 ? m.winDescent : -m.descender;
  const own = ownLine(m);
  return own - desc / m.upm + (singleLine(m) - own) / 2;
}

const view = async (blob, at, n) => new DataView(await blob.slice(at, at + n).arrayBuffer());
const tagOf = (v, at) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

/** The table directory of the face starting at byte `at` of `blob` → {tag: {offset, length}}. */
async function tablesAt(blob, at) {
  const n = (await view(blob, at + 4, 2)).getUint16(0);
  const dir = await view(blob, at + 12, n * 16);
  const out = {};
  for (let i = 0; i < n; i++) out[tagOf(dir, i * 16)] = { offset: dir.getUint32(i * 16 + 8), length: dir.getUint32(i * 16 + 12) };
  return out;
}

const read = (blob, t) => (t ? view(blob, t.offset, t.length) : null);

/** The PostScript name (name ID 6) of a face's name table `v`, or null. */
function psName(v) {
  const count = v.getUint16(2);
  const strings = v.getUint16(4);
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (v.getUint16(r + 6) !== 6) continue;
    const platform = v.getUint16(r);
    const len = v.getUint16(r + 8);
    const at = strings + v.getUint16(r + 10);
    if (at + len > v.byteLength) continue;
    let s = '';
    if (platform === 3 || platform === 0) for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(v.getUint16(at + k));
    else for (let k = 0; k < len; k++) s += String.fromCharCode(v.getUint8(at + k));
    return s;
  }
  return null;
}

/** The numbers singleLine takes, of face `name` (its PostScript name; a collection's first face where none matches) in font file
 * `blob` (TrueType, OpenType or a collection of them), or null where the file is not one or lacks head or hhea. */
export async function readMetrics(blob, name = null) {
  const top = await view(blob, 0, 12);
  const sig = tagOf(top, 0);
  let faces = [0];
  if (sig === 'ttcf') {
    const n = top.getUint32(8);
    const offs = await view(blob, 12, n * 4);
    faces = Array.from({ length: n }, (_, i) => offs.getUint32(i * 4));
  } else if (top.getUint32(0) !== 0x10000 && sig !== 'OTTO' && sig !== 'true') return null;
  let tables = await tablesAt(blob, faces[0]);
  if (faces.length > 1 && name) {
    for (const at of faces) {
      const t = at === faces[0] ? tables : await tablesAt(blob, at);
      const nm = await read(blob, t.name);
      if (nm && psName(nm) === name) {
        tables = t;
        break;
      }
    }
  }
  const [head, hhea, os2] = await Promise.all([read(blob, tables.head), read(blob, tables.hhea), read(blob, tables['OS/2'])]);
  if (!head || !hhea) return null;
  const m = { upm: head.getUint16(18), ascender: hhea.getInt16(4), descender: hhea.getInt16(6), lineGap: hhea.getInt16(8),
    useTypo: false, winAscent: 0, winDescent: 0, typoAscender: 0, typoDescender: 0, typoLineGap: 0, cjk: false };
  if (os2 && os2.byteLength >= 78) {
    Object.assign(m, { useTypo: !!(os2.getUint16(62) & 0x80), typoAscender: os2.getInt16(68), typoDescender: os2.getInt16(70),
      typoLineGap: os2.getInt16(72), winAscent: os2.getUint16(74), winDescent: os2.getUint16(76) });
    // ulCodePageRange1 (OS/2 version 1 on): bits 17 to 21 are the Japanese, Chinese and Korean code pages.
    if (os2.byteLength >= 86) m.cjk = !!(os2.getUint32(78) & 0x3e0000);
  }
  return m.upm ? m : null;
}

const byFace = new Map(); // PostScript name → a promise of its numbers (readMetrics), or null

/** The numbers singleLine takes of installed face `face` (a FontData of the Local Font Access API: postscriptName and blob()), read
 * once per face for the session → a promise of them, or null where the file cannot be read. */
function faceMetrics(face) {
  const key = face.postscriptName;
  let p = byFace.get(key);
  if (!p) {
    p = Promise.resolve().then(() => face.blob()).then((b) => readMetrics(b, key)).catch(() => null);
    byFace.set(key, p);
  }
  return p;
}

/** Word's single line over the font size of installed face `face` → a promise of the ratio, or null where the file cannot be read. */
export const faceRatio = (face) => faceMetrics(face).then((m) => (m ? singleLine(m) : null));

/** The families of CSS font-family list `stack`, quotes removed. */
export const familiesOf = (stack) => stack.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean);

/** Word's single line of font stack `stack`: the ratio of the first family that `faceOf(family)` (→ a promise of an installed
 * FontData, or null) finds, as the browser draws with that family → a promise of the ratio, or null where none is installed or its
 * file cannot be read (the browser's own fallback then draws, and its measured line stays). */
export async function stackRatio(stack, faceOf) {
  const m = await stackMetrics(stack, faceOf);
  return m && singleLine(m);
}

/** The numbers (readMetrics) of the first family of `stack` that `faceOf` finds → a promise of them, or null (as stackRatio). */
export async function stackMetrics(stack, faceOf) {
  for (const family of familiesOf(stack)) {
    const face = await faceOf(family);
    if (face) return faceMetrics(face);
  }
  return null;
}
