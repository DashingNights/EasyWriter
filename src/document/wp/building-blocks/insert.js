// Taking building blocks from the selection and putting them back (docs/plans/word briefs/building-blocks.md): what each gallery
// saves, when its Save Selection item is enabled, and how a block of each gallery inserts (Options rules, a section's header,
// footer or watermark, a replaced table of contents or bibliography, a cover at the document's start).
import { sectionsOf } from '../../model/sections.mjs';
import { insertionOf } from './blocks.mjs';

const sdtId = () => String(Math.floor(Math.random() * 2 ** 31));

/** `json` with every content control given a fresh id (a block inserted twice must not share ids). */
export function withSdtIds(json) {
  if (Array.isArray(json)) return json.map(withSdtIds);
  if (!json || typeof json !== 'object') return json;
  const out = { ...json };
  if (out.attrs?.sdt) out.attrs = { ...out.attrs, sdt: { ...out.attrs.sdt, id: sdtId() } };
  if (out.content) out.content = withSdtIds(out.content);
  return out;
}

/** The innermost ancestor of the selection start matching `test(node)` → {node, pos} | null. */
function ancestor(state, test) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if (test($from.node(d))) return { node: $from.node(d), pos: $from.before(d) };
  const n = state.selection.node;
  return n && test(n) ? { node: n, pos: state.selection.from } : null;
}

const code = (n) => (n.type.name === 'fieldBlock' ? String(n.attrs.code).trim().split(/\s+/)[0].toUpperCase() : null);
const part = (n) => n.type.name === 'sdtBlock' && n.attrs.sdt;
/** Block controls a gallery replaces instead of adding a second one. */
const CONTROL = {
  'Table of Contents': (n) => code(n) === 'TOC' || part(n)?.docPart?.gallery === 'Table of Contents',
  Bibliographies: (n) => code(n) === 'BIBLIOGRAPHY' || part(n)?.type === 'bibliography' || part(n)?.docPart?.gallery === 'Bibliographies',
};

/** What Save Selection to `gallery` would save from `ctx` → {content (block JSON), text, data?} | null when the selection does
 * not fit: an empty selection, Text Boxes without a text box, Equations without an equation, Table of Contents and Bibliographies
 * outside their control; Watermarks take the section's watermark object instead. */
export function selectionBlock(ctx, gallery) {
  const st = ctx.state;
  if (!st) return null;
  const base = gallery.replace(/^Custom /, '');
  if (base === 'Watermarks') {
    const wm = ctx.sect?.watermark;
    return wm ? { content: [{ type: 'paragraph', content: wm.text ? [{ type: 'text', text: wm.text }] : [] }], text: wm.text ?? 'Watermark', data: { watermark: wm } } : null;
  }
  const whole = (hit) => hit && { content: [hit.node.toJSON()], text: hit.node.textContent };
  if (CONTROL[base]) return whole(ancestor(st, CONTROL[base]));
  if (base === 'Text Boxes') return whole(ancestor(st, (n) => n.type.name === 'textBox'));
  if (base === 'Equations') {
    const n = st.selection.node;
    return n?.type.name === 'equation' ? { content: [{ type: 'paragraph', content: [n.toJSON()] }], text: n.attrs.math } : null;
  }
  if (st.selection.empty) return null;
  return { content: st.selection.content().content.toJSON(), text: st.doc.textBetween(st.selection.from, st.selection.to, ' ', ' ') };
}

// ---------------------------------------------------------------------------------------------
// Covers

/** The document's cover: the top-level content control of the Cover Pages gallery → {node, pos} | null. */
export function coverOf(doc) {
  let hit = null;
  doc.forEach((node, pos) => {
    if (!hit && part(node)?.docPart?.gallery === 'Cover Pages') hit = { node, pos };
  });
  return hit;
}

/** Puts a cover holding `blocks` at the start of the main document whatever the selection, ending in a page break, in place of a
 * cover already there, and sets the first section's titlePg so headers skip it (remembered on the control, so removing the cover
 * clears only what it set). One undo step. */
export function placeCover(ctx, blocks, category = 'Built-In') {
  const ed = ctx.ed;
  if (!ed) return false;
  const old = coverOf(ed.state.doc);
  const firstSect = sectionsOf(ed.state.doc)[0]?.sect;
  const setTitlePg = old ? !!old.node.attrs.sdt.docPart?.setTitlePg : !firstSect?.titlePg;
  const body = blocks.at(-1)?.type === 'pageBreak' ? blocks : [...blocks, { type: 'pageBreak' }];
  const sdt = { id: sdtId(), type: 'docPart', docPart: { gallery: 'Cover Pages', category, ...(setTitlePg && { setTitlePg: true }) } };
  const node = ed.schema.nodeFromJSON({ type: 'sdtBlock', attrs: { sdt }, content: withSdtIds(body) });
  return ed.chain().focus().command(({ tr }) => {
    if (old) tr.replaceWith(old.pos, old.pos + old.node.nodeSize, node);
    else tr.insert(0, node);
    return true;
  }).setSectionProps({ titlePg: true }, { section: 0 }).run();
}

/** Remove Current Cover Page: deletes the cover control with its page break, and the titlePg it set. */
export function removeCover(ctx) {
  const ed = ctx.ed;
  const old = ed && coverOf(ed.state.doc);
  if (!old) return false;
  const c = ed.chain().focus().command(({ tr }) => (tr.delete(old.pos, old.pos + old.node.nodeSize), true));
  return (old.node.attrs.sdt.docPart?.setTitlePg ? c.setSectionProps({ titlePg: null }, { section: 0 }) : c).run();
}

// ---------------------------------------------------------------------------------------------
// Inserting

/** Inserts block JSON `content` at the selection of ctx.target by Options rule `insert`, replacing `range` ({from, to}) first. */
export function insertContent(ctx, content, insert, range = null) {
  const t = ctx.target;
  if (!t) return false;
  const atStart = (range?.from ?? t.state.selection.from) <= 1;
  const ins = insertionOf(withSdtIds(content), insert, { atStart });
  return ctx.chain((c) => (range ? c.deleteRange(range) : c).insertContent(ins.inline ?? ins.blocks));
}

/** Inserts `entry` the way its gallery does (brief: Inserting by gallery). `range`: text F3 or AutoComplete replaces. */
export function insertEntry(ctx, entry, range = null) {
  const gallery = entry.gallery.replace(/^Custom /, '');
  // A page number at the top of the page or in its margins fills the header, at the bottom the footer, as Word's galleries do.
  if (/^(Headers|Footers|Page Numbers \((Top of Page|Bottom of Page|Margins)\))$/.test(gallery)) {
    const key = /^(Footers|Page Numbers \(Bottom)/.test(gallery) ? 'ftr' : 'hdr';
    return !!ctx.ed?.chain().focus().setSectionProps({ [key]: { default: withSdtIds(entry.content) } }).run();
  }
  if (gallery === 'Watermarks') return !!entry.data?.watermark && !!ctx.ed?.chain().focus().setSectionProps({ watermark: entry.data.watermark }).run();
  if (gallery === 'Cover Pages') return placeCover(ctx, entry.content, entry.category);
  const test = CONTROL[gallery];
  const old = test && ctx.target && (() => {
    let hit = null;
    ctx.target.state.doc.descendants((n, pos) => {
      if (hit) return false;
      if (test(n)) hit = { node: n, pos };
      return !hit;
    });
    return hit;
  })();
  if (old) {
    const nodes = withSdtIds(entry.content).map((b) => ctx.target.schema.nodeFromJSON(b));
    return ctx.chain((c) => c.command(({ tr }) => (tr.replaceWith(old.pos, old.pos + old.node.nodeSize, nodes), true)));
  }
  return insertContent(ctx, entry.content, entry.insert, range);
}
