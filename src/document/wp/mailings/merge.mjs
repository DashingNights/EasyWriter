// Finish & Merge, label sheets and envelopes as block JSON (docs/plans/word/plan.md §3 mailings, briefs/mailings.md). A merge makes
// one copy of the body per active record: merge fields become their text, ASK and FILLIN ask per record (once with \o), other fields
// stay fields with their nested merge fields filled in. Letters and envelopes are separated by Next Page section breaks, a directory
// runs on, labels fill one table. The merged document copies the main one's styles, numbering, theme, sect and settings and drops
// merge, comments and agent suggestions. Pure: node tests load it.
import { fieldType, parseField, updateState, fieldCtx } from '../../fields/registry.mjs';
import { isMergeName, makeCursor, resultText } from './fields.mjs';

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Text `text` as inline JSON with `marks`: line breaks become hard breaks. */
export function inlineText(text, marks) {
  const out = [];
  String(text ?? '').split('\n').forEach((line, i) => {
    if (i) out.push({ type: 'hardBreak', ...(marks?.length && { marks }) });
    if (line) out.push({ type: 'text', text: line, ...(marks?.length && { marks }) });
  });
  return out;
}

/** Field code `code` with every nested merge field replaced by its quoted value in `ctx` (an IF over { MERGEFIELD City } keeps working
 * in the merged copy without the data source). */
export function fillNested(code, ctx) {
  let out = '';
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quoted && ch === '\\') {
      out += ch + (code[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch !== '{') {
      out += ch;
      continue;
    }
    let depth = 0;
    let q = false;
    let k = i;
    for (; k < code.length; k++) {
      const c = code[k];
      if (q && c === '\\') k++;
      else if (c === '"') q = !q;
      else if (!q && c === '{') depth++;
      else if (!q && c === '}' && --depth === 0) break;
    }
    const inner = code.slice(i + 1, k).trim();
    const f = parseField(inner);
    if (isMergeName(f.name)) {
      const v = resultText(fieldType(f.name)?.compute(f, ctx));
      out += quoted ? v.replace(/(["\\])/g, '\\$1') : quote(v);
    } else out += `{ ${fillNested(inner, ctx)} }`;
    i = k;
  }
  return out;
}

/** Drops what a merged or new document never carries: comment marks and agent suggestions. */
function scrub(node) {
  if (!node || typeof node !== 'object') return node;
  const out = { ...node };
  if (out.attrs && 'suggest' in out.attrs) out.attrs = { ...out.attrs, suggest: null };
  if (out.marks) {
    out.marks = out.marks.filter((m) => m.type !== 'comment');
    if (!out.marks.length) delete out.marks;
  }
  if (out.content) out.content = out.content.map(scrub);
  return out;
}

/** Doc attrs for a document made from `attrs` (a merge, an envelope or label document): the main one's styles, numbering, theme,
 * sect and settings; no merge, comments or people. */
export function derivedAttrs(attrs, patch = {}) {
  const a = attrs ?? {};
  return { sect: clone(a.sect ?? null), styles: clone(a.styles ?? null), numbering: clone(a.numbering ?? null), theme: clone(a.theme ?? null),
    settings: clone(a.settings ?? null), props: null, vars: null, comments: null, people: null, background: null, merge: null, ...patch };
}

/** One copy of `content` (block JSON) for the cursor: merge fields become text, ASK and FILLIN ask through `prompt`. → blocks. */
async function copyOf(content, cursor, { prompt, asked, pmDoc, errors }) {
  const shared = updateState();
  shared.cache.set('record', cursor);
  const ctxAt = (extra = {}) => fieldCtx({ doc: pmDoc ?? null, shared, ...extra });
  const walk = async (node) => {
    if (node.type !== 'field') {
      if (!node.content) return [node];
      const kids = [];
      for (const c of node.content) kids.push(...(await walk(c)));
      return [{ ...node, content: kids }];
    }
    const code = node.attrs?.code ?? '';
    const f = parseField(code);
    const type = fieldType(f.name);
    if (isMergeName(f.name) && type) {
      const r = type.compute(f, ctxAt());
      if (r && typeof r === 'object' && r.error) errors.push({ record: cursor.index, code, error: r.error });
      return inlineText(resultText(r), node.marks);
    }
    const attrs = { ...node.attrs, code: fillNested(code, ctxAt()) };
    if ((f.name === 'ASK' || f.name === 'FILLIN') && (type?.prompt || prompt)) {
      let answer = f.sw.o && asked.has(code) ? asked.get(code) : undefined;
      if (answer === undefined) {
        answer = await (prompt ? prompt(f, ctxAt(), cursor) : type.prompt(f, ctxAt()));
        asked.set(code, answer);
      }
      if (answer != null && type) {
        const r = type.compute(f, ctxAt({ answer }));
        if (r != null) attrs.result = resultText(r);
      } else if (answer != null) attrs.result = f.name === 'FILLIN' ? answer : attrs.result;
    }
    return [{ ...node, attrs }];
  };
  const out = [];
  for (const b of content) out.push(...(await walk(clone(b))));
  return out;
}

/** The section break between two copies: Next Page, holding the sect of the section it ends (the main document's last). */
const pageBreakOf = (sect) => ({ type: 'sectionBreak', attrs: { kind: 'nextPage', sect: clone(sect) } });

/** Merges `doc` (the main document's JSON) over `list` (active records [{n, values}]) of `source` with `merge` (doc.attrs.merge).
 * `from` and `to` are 1-based positions in list (Edit Individual Documents' From and To); `prompt(f, ctx, cursor)` answers ASK and
 * FILLIN when given (else their types' prompt). → {doc (JSON) | null when no copy was made, copies, errors: [{record, code, error}]}. */
export async function mergeDocument(doc, list, source, merge, { from = 1, to = list.length, prompt = null, pmDoc = null } = {}) {
  const content = doc?.content ?? [];
  const end = Math.min(to, list.length);
  const errors = [];
  const asked = new Map();
  const copies = [];
  let pos = Math.max(0, from - 1);
  let seq = 1;
  while (pos < end) {
    const cursor = makeCursor(source, merge, list, pos, seq, end);
    const blocks = await copyOf(content, cursor, { prompt, asked, pmDoc, errors });
    if (!cursor.skipped) {
      copies.push(blocks);
      seq = cursor.seq + 1;
    }
    pos = cursor.pos + 1;
  }
  if (!copies.length) return { doc: null, copies: 0, errors };
  const type = merge?.type ?? 'letters';
  let body;
  const tableOnly = (c) => c.filter((b) => !(b.type === 'paragraph' && !b.content?.length)).length === 1 && c.some((b) => b.type === 'table');
  if (type === 'labels' && copies.every(tableOnly)) {
    // One table: the rows of every sheet in order, so the label grid flows on from page to page.
    const tables = copies.map((c) => c.find((b) => b.type === 'table'));
    body = [{ ...tables[0], content: tables.flatMap((t) => t.content ?? []) }, { type: 'paragraph' }];
  } else if (type === 'directory') body = copies.flat();
  else body = copies.flatMap((c, i) => (i ? [pageBreakOf(doc.attrs?.sect), ...c] : c));
  return { doc: scrub({ type: 'doc', attrs: derivedAttrs(doc?.attrs), content: body }), copies: copies.length, errors };
}

// ---------- labels ----------

const IN = 72;
const MM = 72 / 25.4;
const LETTER = { w: 8.5 * IN, h: 11 * IN };
const A4 = { w: 210 * MM, h: 297 * MM };
const r2 = (n) => Math.round(n * 100) / 100;
const product = (id, name, type, page, [w, h], [across, down], [top, side], [vPitch, hPitch]) =>
  ({ id, name, type, w: r2(w), h: r2(h), across, down, top: r2(top), side: r2(side), vPitch: r2(vPitch), hPitch: r2(hPitch), page });

/** Label products with generic names only (vendor names are trademarks): sizes of common sheets, in points. */
export const LABELS = [
  product('half-letter', '1/2 Letter', 'Postcard', LETTER, [8.5 * IN, 5.5 * IN], [1, 2], [0, 0], [5.5 * IN, 8.5 * IN]),
  product('30-per-page', '30 Per Page', 'Address labels', LETTER, [2.625 * IN, 1 * IN], [3, 10], [0.5 * IN, 0.1875 * IN], [1 * IN, 2.75 * IN]),
  product('20-per-page', '20 Per Page', 'Address labels', LETTER, [4 * IN, 1 * IN], [2, 10], [0.5 * IN, 0.15625 * IN], [1 * IN, 4.1875 * IN]),
  product('14-per-page', '14 Per Page', 'Address labels', LETTER, [4 * IN, 1.33 * IN], [2, 7], [0.83 * IN, 0.15625 * IN], [1.33 * IN, 4.1875 * IN]),
  product('10-per-page', '10 Per Page', 'Shipping labels', LETTER, [4 * IN, 2 * IN], [2, 5], [0.5 * IN, 0.15625 * IN], [2 * IN, 4.1875 * IN]),
  product('80-per-page', '80 Per Page', 'Return address labels', LETTER, [1.75 * IN, 0.5 * IN], [4, 20], [0.5 * IN, 0.28125 * IN], [0.5 * IN, 2.05 * IN]),
  product('a4-21', 'A4 21 Per Page', 'Address labels', A4, [63.5 * MM, 38.1 * MM], [3, 7], [15.15 * MM, 7.25 * MM], [38.1 * MM, 66.04 * MM]),
  product('a4-14', 'A4 14 Per Page', 'Address labels', A4, [99.1 * MM, 38.1 * MM], [2, 7], [15.15 * MM, 4.65 * MM], [38.1 * MM, 101.6 * MM]),
  product('a4-8', 'A4 8 Per Page', 'Shipping labels', A4, [99.1 * MM, 67.7 * MM], [2, 4], [13.1 * MM, 4.65 * MM], [67.7 * MM, 101.6 * MM]),
  product('a4-full', 'A4 (Portrait)', 'Full sheet', A4, [210 * MM, 297 * MM], [1, 1], [0, 0], [297 * MM, 210 * MM]),
];
/** The label Word's Label Options shows first. */
export const DEFAULT_LABEL = LABELS[0];

/** The label as doc.attrs.merge.label keeps it (plan.md §1.8). */
export const labelAttr = (l) => ({ name: l.name, w: l.w, h: l.h, across: l.across, down: l.down, top: l.top, side: l.side, vPitch: l.vPitch,
  hPitch: l.hPitch, page: { w: l.page.w, h: l.page.h } });

/** The page setup of a sheet of `label`: its page size, the top and side margins, no header or footer. */
export function labelSect(label, base = {}) {
  const right = Math.max(0, label.page.w - label.side - (label.across - 1) * label.hPitch - label.w);
  return { ...base, w: label.page.w, h: label.page.h, orient: label.page.w > label.page.h ? 'landscape' : 'portrait',
    margin: { ...base.margin, top: label.top, left: label.side, right: r2(right), bottom: 0, header: 0, footer: 0, gutter: 0 } };
}

const px = (pt) => Math.round((pt * 96) / 72);

/** A sheet of `label` as table JSON: `across` columns at the horizontal pitch, `down` rows at the vertical pitch (exact), the gap
 * between labels as the cell's right margin. `cell(i)` gives cell i's blocks (0-based, row by row). */
export function labelTable(label, cell) {
  const gap = Math.max(0, label.hPitch - label.w);
  const rows = [];
  for (let r = 0; r < label.down; r++) {
    const cells = [];
    for (let c = 0; c < label.across; c++) {
      cells.push({ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: [px(label.hPitch)], margins: { top: 0, bottom: 0, left: 5.4, right: r2(gap + 5.4) } },
        content: cell(r * label.across + c) });
    }
    rows.push({ type: 'tableRow', attrs: { height: { value: label.vPitch, rule: 'exact' } }, content: cells });
  }
  return { type: 'table', attrs: { styleId: 'TableNormal', layout: 'fixed', width: { type: 'pt', w: r2(label.hPitch * label.across) } }, content: rows };
}

const NEXT = { type: 'field', attrs: { code: 'NEXT', result: '\u00ABNext Record\u00BB' } };

/** Label merge's sheet: the first cell empty, every other one holding a NEXT field (Word's «Next Record»). */
export const mergeLabelTable = (label) => labelTable(label, (i) => [{ type: 'paragraph', content: i ? [clone(NEXT)] : [] }]);

/** Update Labels: every cell after the first gets a NEXT field followed by a copy of the first cell's content. → table JSON. */
export function updateLabels(table) {
  const t = clone(table);
  const cells = (t.content ?? []).flatMap((row) => row.content ?? []);
  if (cells.length < 2) return t;
  const first = clone(cells[0].content ?? [{ type: 'paragraph' }]);
  const isNext = (n) => n?.type === 'field' && parseField(n.attrs?.code).name === 'NEXT';
  // A first cell that itself starts with NEXT is copied without it.
  if (isNext(first[0]?.content?.[0])) first[0].content = first[0].content.slice(1);
  for (const cell of cells.slice(1)) {
    const blocks = clone(first);
    if (blocks[0]?.type === 'paragraph') blocks[0] = { ...blocks[0], content: [clone(NEXT), ...(blocks[0].content ?? [])] };
    else blocks.unshift({ type: 'paragraph', content: [clone(NEXT)] });
    cell.content = blocks;
  }
  return t;
}

/** Full page of the same label, or one label at `row` and `col` (1-based): the address in each filled cell. → table JSON. */
export function addressSheet(label, address, { single = false, row = 1, col = 1 } = {}) {
  const at = (row - 1) * label.across + (col - 1);
  const lines = String(address ?? '').split(/\r?\n/);
  const filled = () => lines.map((l) => ({ type: 'paragraph', attrs: { spacing: { before: 0, after: 0 } }, content: l ? [{ type: 'text', text: l }] : [] }));
  return labelTable(label, (i) => (!single || i === at ? filled() : [{ type: 'paragraph' }]));
}

// ---------- envelopes ----------

const frac = (s) => s.trim().split(/\s+/).reduce((n, part) => {
  const [a, b] = part.split('/');
  return n + (b ? Number(a) / Number(b) : Number(a));
}, 0);
/** An envelope from Word's list label ("Size 10 (4 1/8 x 9 1/2 in)") → {id, label, w, h} in points, w the long side. */
function envelope(label) {
  const m = label.match(/^(.*?)\s*\((.+?) x (.+?) (in|mm)\)$/);
  const unit = m[4] === 'in' ? IN : MM;
  const [a, b] = [frac(m[2]) * unit, frac(m[3]) * unit];
  return { id: m[1].trim(), label: `${m[1].trim()} (${m[2]} x ${m[3]} ${m[4]})`, w: r2(Math.max(a, b)), h: r2(Math.min(a, b)) };
}

/** Word's envelope sizes (probe envelope-options.json), Size 10 first by default; Custom size is the dialog's own entry. */
export const ENVELOPES = ['Size 6 3/4 (3 5/8 x 6 1/2 in)', 'Size 9 (3 7/8 x 8 7/8 in)', 'Size 10 (4 1/8 x 9 1/2 in)', 'Size 11 (4 1/2 x 10 3/8 in)',
  'Size 12 (4 3/4 x 11 in)', 'Size 14 (5 x 11 1/2 in)', 'B4 (250 x 353 mm)', 'B5 (176 x 250 mm)', 'B6 (125 x 176 mm)', 'C3 (324 x 458 mm)',
  'C4 (229 x 324 mm)', 'C5 (162 x 229 mm)', 'C6 (114 x 162 mm)', 'C65 (114 x 229 mm)', 'DL (110 x 220 mm)', 'E4 (220 x 310 mm)',
  'E5 (155 x 220 mm)', 'E6 (110 x 155 mm)', 'E65 (110 x 220 mm)', 'Italian (110 x 230 mm)', 'M5 (155 x 223 mm)', 'M65 (112 x 223 mm)',
  'Monarch (3 7/8 x 7 1/2 in)', 'US Legal (8 1/2 x 14 in)', 'US Letter (8 1/2 x 11 in)'].map(envelope);
export const DEFAULT_ENVELOPE = ENVELOPES.find((e) => e.id === 'Size 10');

const ENV_MARGIN = { top: 18, right: 18, bottom: 18, left: 27, header: 0, footer: 0, gutter: 0 };
const LINE = 14; // pt, a line of 11 pt text with Word's single spacing, for placing the delivery address under the return address

/** The envelope of doc.attrs.merge.envelope shape for size `e` with positions and fonts (null = Auto, Word's default). */
export const envelopeAttr = (e, { delivery = {}, ret = {} } = {}) => ({ size: e.id, w: e.w, h: e.h,
  delivery: { left: delivery.left ?? null, top: delivery.top ?? null, font: delivery.font ?? null },
  ret: { left: ret.left ?? null, top: ret.top ?? null, font: ret.font ?? null, omit: !!ret.omit } });

/** Auto positions: the delivery address a little left of the middle and just under it, as Word places it (approximate). */
export const autoDelivery = (env) => ({ left: r2(env.w * 0.42), top: r2(env.h * 0.48) });

/** The sect of an envelope: its size, landscape, small margins (Word feeds envelopes landscape). */
export const envelopeSect = (env, base = {}) => ({ ...base, w: env.w, h: env.h, orient: 'landscape', margin: { ...base.margin, ...ENV_MARGIN } });

const runMarks = (font) => (font && Object.keys(font).length ? [{ type: 'textStyle', attrs: font }] : undefined);
const lineBlocks = (text, attrs, font) => String(text ?? '').split(/\r?\n/).map((l, i) => ({
  type: 'paragraph', attrs: { ...attrs, spacing: { ...attrs.spacing, before: i ? 0 : attrs.spacing?.before ?? 0, after: 0 } },
  content: l ? [{ type: 'text', text: l, ...(runMarks(font) && { marks: runMarks(font) }) }] : [],
}));

/** The envelope's blocks: the return address at the top left (unless omitted), then the delivery address (text, or `deliveryContent`
 * inline JSON such as an ADDRESSBLOCK field) indented to its From left and From top. */
export function envelopeBlocks(env, { delivery = '', ret = '', deliveryContent = null } = {}) {
  const d = autoDelivery(env);
  const left = env.delivery?.left ?? d.left;
  const top = env.delivery?.top ?? d.top;
  const omit = env.ret?.omit || !String(ret).trim();
  const back = omit ? [] : lineBlocks(ret, { indent: env.ret?.left != null ? { left: Math.max(0, env.ret.left - ENV_MARGIN.left) } : null,
    spacing: { before: env.ret?.top != null ? Math.max(0, env.ret.top - ENV_MARGIN.top) : 0 } }, env.ret?.font);
  const used = (back.length ? back.length * LINE : 0) + (env.ret?.top != null && !omit ? Math.max(0, env.ret.top - ENV_MARGIN.top) : 0);
  const attrs = { indent: { left: r2(Math.max(0, left - ENV_MARGIN.left)) }, spacing: { before: r2(Math.max(0, top - ENV_MARGIN.top - used)) } };
  const front = deliveryContent ? [{ type: 'paragraph', attrs: { ...attrs, spacing: { ...attrs.spacing, after: 0 } }, content: deliveryContent }]
    : lineBlocks(delivery, attrs, env.delivery?.font);
  return [...back, ...front];
}

/** Whether section sect `s` is an envelope of ours (Add to Document replaces it instead of adding a second one). */
export const isEnvelopeSect = (s) => !!s && s.orient === 'landscape' && ENVELOPES.some((e) => Math.abs(e.w - s.w) < 0.5 && Math.abs(e.h - s.h) < 0.5);
