// The names and revision of each face in a font file (TrueType, OpenType or a collection of them), for the font index
// (electron/fonts-main.js) and fonts a user adds in the web app. Only the table directory, the name table and head are read,
// through `read(at, n)`, so indexing a 20 MB CJK collection reads a few kilobytes. Plain JavaScript over Uint8Array.

const tag = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u16 = (b, at) => (b[at] << 8) | b[at + 1];
const u32 = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const LATIN1 = new TextDecoder('latin1');

/** A reader over the bytes of a whole file. */
export const bytesReader = (bytes) => (at, n) => bytes.subarray(at, at + n);

/** The face offsets of the file `read` reads: one for a single font, each member's for a collection; [] when it is not a font. */
async function offsets(read) {
  const head = await read(0, 12);
  if (head.length < 12) return [];
  const t = tag(head, 0);
  if (t === 'ttcf') {
    const n = Math.min(u32(head, 8), 256);
    const dir = await read(12, n * 4);
    return Array.from({ length: Math.floor(dir.length / 4) }, (_, i) => u32(dir, i * 4));
  }
  return t === 'OTTO' || t === 'true' || u32(head, 0) === 0x00010000 ? [0] : [];
}

/** Name records of name table bytes `b` → [{id, platform, lang, text}]. */
function names(b) {
  const out = [];
  if (b.length < 6) return out;
  const count = u16(b, 2);
  const strings = u16(b, 4);
  for (let i = 0; i < count && 6 + i * 12 + 12 <= b.length; i++) {
    const r = 6 + i * 12;
    const platform = u16(b, r);
    const id = u16(b, r + 6);
    if (![1, 2, 4, 5, 6, 16, 17].includes(id)) continue;
    const len = u16(b, r + 8);
    const at = strings + u16(b, r + 10);
    if (at + len > b.length) continue;
    let text = '';
    if (platform === 0 || platform === 3) for (let k = 0; k + 1 < len; k += 2) text += String.fromCharCode(u16(b, at + k));
    else if (platform === 1) text = LATIN1.decode(b.subarray(at, at + len));
    else continue;
    text = text.replace(/\0/g, '').trim();
    if (text) out.push({ id, platform, lang: u16(b, r + 4), text });
  }
  return out;
}

// English first (Windows US English, then Mac English), then any Windows name, then the rest.
const rank = (r) => (r.platform === 3 && r.lang === 0x409 ? 0 : r.platform === 1 && r.lang === 0 ? 1 : r.platform === 3 ? 2 : 3);
const best = (recs, id) => recs.filter((r) => r.id === id).sort((a, b) => rank(a) - rank(b))[0]?.text ?? '';

/** The faces of the font file `read(at, n)` reads (→ Uint8Array or a promise of one) → [{index, family, style, names, full,
 * postscript, revision}]: family and style are the typographic ones (name IDs 16 and 17, else 1 and 2) in English where the face
 * has them; names every family name it answers to in any language (IDs 1 and 16, so "Calibri Light" and 微軟正黑體 too) and its
 * full name; revision head's fontRevision. A face without a family name is left out. */
export async function readFaces(read) {
  const faces = [];
  for (const [index, at] of (await offsets(read)).entries()) {
    const dirHead = await read(at, 12);
    if (dirHead.length < 12) continue;
    const n = Math.min(u16(dirHead, 4), 512);
    const dir = await read(at + 12, n * 16);
    const tables = {};
    for (let i = 0; i + 16 <= dir.length; i += 16) tables[tag(dir, i)] = { offset: u32(dir, i + 8), length: u32(dir, i + 12) };
    if (!tables.name) continue;
    const recs = names(await read(tables.name.offset, Math.min(tables.name.length, 1 << 20)));
    const family = best(recs, 16) || best(recs, 1);
    if (!family) continue;
    const head = tables.head ? await read(tables.head.offset, 8) : null;
    const full = best(recs, 4);
    const all = new Set([family, ...recs.filter((r) => r.id === 1 || r.id === 16).map((r) => r.text), ...(full ? [full] : [])]);
    faces.push({
      index,
      family,
      style: best(recs, 17) || best(recs, 2) || 'Regular',
      names: [...all],
      full,
      postscript: best(recs, 6),
      // Fixed 16.16; Version 1.10 is 1.1, so revisions order as numbers.
      revision: head?.length >= 8 ? u32(head, 4) / 65536 : 0,
    });
  }
  return faces;
}

/** The family names of font file `bytes`, for a font a user adds. */
export const familiesOf = async (bytes) => [...new Set((await readFaces(bytesReader(bytes))).map((f) => f.family))];
