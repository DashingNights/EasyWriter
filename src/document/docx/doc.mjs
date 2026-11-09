// Word 97-2003 .doc files (MS-DOC in an MS-CFB compound file): the main text and its paragraphs, read through the piece table.
// ponytail: text only. Formatting, tables, pictures, notes and headers live in binary property tables this does not read; the
// notice tells the user to save the file as .docx in Word to keep them.
import { newDocumentJson } from '../defaults.mjs';

/** The streams of compound file `u8` → Map(name → Uint8Array). Throws when it is not one. */
export function readCfb(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (v.getUint32(0, true) !== 0xE011CFD0 || v.getUint32(4, true) !== 0xE11AB1A1) throw new Error('This is not a Word 97-2003 file.');
  const size = 1 << v.getUint16(0x1E, true);
  const mini = 1 << v.getUint16(0x20, true);
  const cutoff = v.getUint32(0x38, true);
  const sector = (sid) => u8.subarray((sid + 1) * size, (sid + 2) * size);
  // The FAT's sectors: 109 in the header, the rest in the DIFAT chain.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) fatSectors.push(v.getInt32(0x4C + i * 4, true));
  for (let d = v.getInt32(0x44, true), n = v.getUint32(0x48, true); d >= 0 && n-- > 0;) {
    const s = new DataView(u8.buffer, u8.byteOffset + (d + 1) * size, size);
    for (let i = 0; i < size / 4 - 1; i++) fatSectors.push(s.getInt32(i * 4, true));
    d = s.getInt32(size - 4, true);
  }
  const fat = [];
  for (const sid of fatSectors.slice(0, v.getUint32(0x2C, true))) {
    if (sid < 0) continue;
    const s = new DataView(u8.buffer, u8.byteOffset + (sid + 1) * size, size);
    for (let i = 0; i < size / 4; i++) fat.push(s.getInt32(i * 4, true));
  }
  const chain = (start, table, guard = 1 << 20) => {
    const out = [];
    for (let s = start; s >= 0 && s < table.length && guard-- > 0; s = table[s]) out.push(s);
    return out;
  };
  const join = (parts, len) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out.subarray(0, len);
  };
  const dir = join(chain(v.getInt32(0x30, true), fat).map(sector));
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = dv.getUint16(o + 64, true);
    entries.push({ name: String.fromCharCode(...new Uint16Array(dir.slice(o, o + Math.max(0, nameLen - 2)).buffer)), type: dir[o + 66],
      start: dv.getInt32(o + 116, true), size: dv.getUint32(o + 120, true) });
  }
  const root = entries.find((e) => e.type === 5);
  const miniFat = [];
  for (const sid of chain(v.getInt32(0x3C, true), fat)) {
    const s = new DataView(u8.buffer, u8.byteOffset + (sid + 1) * size, size);
    for (let i = 0; i < size / 4; i++) miniFat.push(s.getInt32(i * 4, true));
  }
  const miniStream = root ? join(chain(root.start, fat).map(sector)) : new Uint8Array();
  const streams = new Map();
  for (const e of entries) {
    if (e.type !== 2) continue;
    streams.set(e.name, e.size < cutoff
      ? join(chain(e.start, miniFat).map((s) => miniStream.subarray(s * mini, (s + 1) * mini)), e.size)
      : join(chain(e.start, fat).map(sector), e.size));
  }
  return streams;
}

/** The main text of .doc streams (Word 97 and later) as a string with Word's control characters. */
export function docText(streams) {
  const word = streams.get('WordDocument');
  if (!word) throw new Error('This file has no Word document inside.');
  const v = new DataView(word.buffer, word.byteOffset, word.byteLength);
  if (v.getUint16(0, true) !== 0xA5EC) throw new Error('This Word file is older than Word 97, which EasyWriter cannot read.');
  const flags = v.getUint16(0x0A, true);
  if (flags & 0x0100) throw new Error('This Word file is password protected.');
  const table = streams.get(flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new Error('The Word file is damaged.');
  const csw = v.getUint16(32, true);
  const lw = 34 + csw * 2;
  const cslw = v.getUint16(lw, true);
  const ccpText = v.getInt32(lw + 2 + 3 * 4, true);
  const rg = lw + 2 + cslw * 4 + 2;
  const fcClx = v.getUint32(rg + 33 * 8, true);
  const lcbClx = v.getUint32(rg + 33 * 8 + 4, true);
  const t = new DataView(table.buffer, table.byteOffset, table.byteLength);
  // The Clx: property runs (0x01) to skip, then the piece table (0x02).
  let p = fcClx;
  while (p < fcClx + lcbClx && table[p] === 0x01) p += 3 + t.getInt16(p + 1, true);
  if (table[p] !== 0x02) throw new Error('The Word file is damaged (no piece table).');
  const lcb = t.getUint32(p + 1, true);
  const plc = p + 5;
  const n = (lcb - 4) / 12;
  const cp1252 = new TextDecoder('windows-1252');
  const utf16 = new TextDecoder('utf-16le');
  let out = '';
  for (let i = 0; i < n && out.length < ccpText; i++) {
    const cpStart = t.getUint32(plc + i * 4, true);
    const cpEnd = t.getUint32(plc + (i + 1) * 4, true);
    const fcRaw = t.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true);
    const len = Math.min(cpEnd, ccpText) - cpStart;
    if (len <= 0) continue;
    if (fcRaw & 0x40000000) {
      const fc = (fcRaw & 0x3FFFFFFF) / 2;
      out += cp1252.decode(word.subarray(fc, fc + len));
    } else out += utf16.decode(word.subarray(fcRaw, fcRaw + len * 2));
  }
  return out.slice(0, ccpText);
}

/** Text with Word's control characters → paragraphs as TipTap JSON (field codes go, their results stay). */
export function docBlocks(s) {
  // Fields: \x13 code \x14 result \x15, nested; keep the results.
  let text = '';
  const stack = [];
  for (const ch of s) {
    if (ch === '\x13') stack.push('code');
    else if (ch === '\x14') { if (stack.length) stack[stack.length - 1] = 'result'; }
    else if (ch === '\x15') stack.pop();
    else if (!stack.includes('code')) text += ch;
  }
  const blocks = [];
  for (const para of text.split(/\r|\x07/)) {
    const parts = para.split(/[\x0C\x0E]/);
    parts.forEach((part, i) => {
      if (i > 0) blocks.push({ type: 'pageBreak' });
      const clean = part.replace(/[\x00-\x08\x0F-\x1D]/g, '').replace(/\x1E/g, '‑').replace(/\x1F/g, '­');
      const lines = clean.split('\x0B');
      const content = lines.flatMap((l, k) => [...(k ? [{ type: 'hardBreak' }] : []), ...(l ? [{ type: 'text', text: l }] : [])]);
      if (content.length || i === parts.length - 1) blocks.push({ type: 'paragraph', ...(content.length && { content }) });
    });
  }
  while (blocks.length > 1 && blocks.at(-1).type === 'paragraph' && !blocks.at(-1).content) blocks.pop();
  return blocks.length ? blocks : [{ type: 'paragraph' }];
}

/** Reads .doc `buffer` → {doc, title, dropped}, like importDocx. */
export async function importDoc(buffer, { settings = null } = {}) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const doc = newDocumentJson(settings);
  doc.content = docBlocks(docText(readCfb(u8)));
  return { doc, title: '', dropped: ['the formatting, tables and pictures of this Word 97-2003 file (save it as .docx in Word to keep them)'] };
}
