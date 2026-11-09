// Zip archives for .docx files: read (stored and deflated entries) and write (deflated), on the platform's Compression Streams,
// so the renderer and Node tests need no zip library. Pure. ponytail: no Zip64, so archives stay under 4 GB, which a .docx does.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bytes of `data` through a CompressionStream or DecompressionStream `stream`. */
async function pipe(data, stream) {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

let table = null;
/** CRC-32 of `bytes` (the zip checksum). */
export function crc32(bytes) {
  if (!table) table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = table[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** The entries of zip `buffer` (ArrayBuffer or Uint8Array) → Map(path → Uint8Array). Throws when it is not a zip. */
export async function readZip(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not a .docx file (no zip directory).');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('The .docx file is damaged.');
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + size);
    files.set(name, method === 0 ? raw.slice() : method === 8 ? await pipe(raw, new DecompressionStream('deflate-raw')) : null);
  }
  return files;
}

/** A zip of `files` (Map or [path, string | Uint8Array] pairs), every entry deflated → Uint8Array. */
export async function writeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const packed = await pipe(data, new CompressionStream('deflate-raw'));
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const head = (sig, extra) => {
      const h = new DataView(new ArrayBuffer(extra ? 46 : 30));
      let i = 0;
      const u32 = (x) => { h.setUint32(i, x, true); i += 4; };
      const u16 = (x) => { h.setUint16(i, x, true); i += 2; };
      u32(sig);
      if (extra) u16(20); // version made by
      u16(20); u16(0x0800); u16(8); u16(0); u16(0x21); // version needed, UTF-8 names, deflate, time, date (1980-01-01)
      u32(crc); u32(packed.length); u32(data.length); u16(nameBytes.length); u16(0);
      if (extra) { u16(0); u16(0); u16(0); u32(0); u32(offset); }
      return new Uint8Array(h.buffer);
    };
    const local = head(0x04034b50, false);
    parts.push(local, nameBytes, packed);
    central.push(head(0x02014b50, true), nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  const n = central.length / 2;
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, n, true);
  end.setUint16(10, n, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let at = 0;
  for (const b of all) { out.set(b, at); at += b.length; }
  return out;
}

/** The UTF-8 text of `bytes`, or null. */
export const text = (bytes) => (bytes ? dec.decode(bytes) : null);
