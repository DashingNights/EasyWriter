// Paste Options as pure transforms (docs/plans/word plan.md §3 clipboard, index-editing.md "Paste and Paste Options"): where a
// paste comes from, which default the settings give it, which options fit the clipboard, and what each option does to the pasted
// slice's JSON (the node array of Slice.toJSON().content). Pure: the plugin builds the slice back with the schema, node tests load it.
import { resolveColor } from '../../../office.mjs';
import { LIST_ABSTRACTS } from '../../defaults.mjs';
import { listLabels } from '../../numbering.mjs';
import { styleChain, styleIdOf } from '../../model/styles.mjs';
import { NON_FORMAT, NOT_PARA } from './painter.mjs';

/** The Paste Options by Word's access letter → the item id the Paste menu and the button use. */
export const MODES = {
  K: 'keepSourceFormatting', M: 'mergeFormatting', S: 'useDestinationStyles', H: 'useDestinationTheme', U: 'picture', T: 'keepTextOnly',
};
/** Item id → Word's letter. */
export const LETTERS = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [v, k]));
/** Item id → Word's label. */
export const LABELS = {
  keepSourceFormatting: 'Keep Source Formatting', mergeFormatting: 'Merge Formatting', useDestinationStyles: 'Use Destination Styles',
  useDestinationTheme: 'Use Destination Theme', picture: 'Picture', keepTextOnly: 'Keep Text Only',
};

// settings.word.paste values (Options > Advanced > Cut, copy, and paste) → the option they pick.
const SETTING = { keep: 'keepSourceFormatting', merge: 'mergeFormatting', destination: 'useDestinationStyles', text: 'keepTextOnly',
  theme: 'useDestinationTheme' };

/** The kind of clipboard `data` ({html, text, image}): 'ours' (ProseMirror HTML, data-pm-slice), 'word' (Word's HTML, mso- markers),
 * 'html' (other HTML: web pages, other programs), 'text', 'picture', or null when it is empty. */
export function sourceKind({ html, text, image } = {}) {
  if (html && /data-pm-slice/.test(html)) return 'ours';
  if (html && /mso-|urn:schemas-microsoft-com:office/i.test(html)) return 'word';
  if (html && (/<img\b/i.test(html) || html.replace(/<[^>]*>|&nbsp;|\s/g, ''))) return 'html';
  if (text) return 'text';
  if (image) return 'picture';
  return null;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The style ids `content` uses: paragraph styles and character styles (textStyle charStyle). */
export function usedStyles(content) {
  const out = new Set();
  walk(content, (n) => {
    if (n.type === 'paragraph' || n.type === 'heading') out.add(styleIdOf(n));
    for (const m of n.marks ?? []) if (m.type === 'textStyle' && m.attrs?.charStyle) out.add(m.attrs.charStyle);
  });
  return [...out];
}

/** Whether a style `content` uses is defined in both `srcStyles` and `dstStyles` (doc.attrs.styles) with different definitions. */
export function stylesConflict(content, srcStyles, dstStyles) {
  const a = srcStyles?.list ?? {};
  const b = dstStyles?.list ?? {};
  return usedStyles(content).some((id) => a[id] && b[id] && !same(a[id], b[id]));
}

/** Which of the settings' cases a paste of `kind` is: 'within' the same Document, 'between' Documents, 'conflict' (between, with a
 * style defined differently on each side), 'other' (Word, web pages, other programs, plain text) or 'pictures'. `src` is the copy
 * record ({docKey, styles}) of our own copy, `dst` the destination's ({docKey, styles}). */
export function pasteCase(kind, content, src, dst) {
  if (kind === 'picture') return 'pictures';
  if (kind !== 'ours') return 'other';
  // Our HTML with no record came from another window or process: a paste between Documents, styles unknown.
  if (!src) return 'between';
  if (src.docKey && src.docKey === dst?.docKey) return 'within';
  return stylesConflict(content, src.styles, dst?.styles) ? 'conflict' : 'between';
}

/** The option the settings (settings.word.paste) give a paste of `pasteCaseName`. A picture keeps itself (Word's In line with text). */
export function defaultMode(pasteCaseName, paste = {}) {
  if (pasteCaseName === 'pictures') return 'keepSourceFormatting';
  return SETTING[paste[pasteCaseName]] ?? 'keepSourceFormatting';
}

/** The Paste Options that fit a clipboard of `kind`, in Word's order. `stylesDiffer` and `themeDiffer` add Use Destination Styles
 * and Use Destination Theme; `picture` says Paste as Picture is registered (picture-format). Unverified in Word (index-editing.md
 * Availability by source, U): our and Word text K M (S H) U T, browser HTML K M T, plain text M T, a picture U only. */
export function availableModes(kind, { stylesDiffer = false, themeDiffer = false, picture = false } = {}) {
  if (kind === 'picture') return ['picture'];
  if (kind === 'text') return ['mergeFormatting', 'keepTextOnly'];
  if (kind === 'html') return ['keepSourceFormatting', 'mergeFormatting', 'keepTextOnly'];
  if (kind !== 'ours' && kind !== 'word') return [];
  return ['keepSourceFormatting', 'mergeFormatting', ...(stylesDiffer ? ['useDestinationStyles'] : []), ...(themeDiffer ? ['useDestinationTheme'] : []),
    ...(picture ? ['picture'] : []), 'keepTextOnly'];
}

// ---------------------------------------------------------------------------------------------
// Transforms

// NON_FORMAT (painter.mjs): marks that carry no formatting, so a link, a comment or a revision stays whatever the option.
// NOT_PARA (painter.mjs): paragraph records (suggestions, revisions), never copied from the destination onto pasted paragraphs.
// A page break or a frame on the destination paragraph stays on that one paragraph, not on every pasted line (Word unverified).
const NOT_MERGED = new Set([...NOT_PARA, 'pageBreakBefore', 'frame']);
/** The destination paragraph attributes a pasted paragraph takes under Merge Formatting and Keep Text Only. */
const destFormat = (attrs) => Object.fromEntries(Object.entries(attrs ?? {}).filter(([k]) => !NOT_MERGED.has(k)));
const RUN_MARKS = new Set(['bold', 'italic', 'strike', 'subscript', 'superscript', 'underline']);
const MERGE_KEEP = new Set(['bold', 'italic', 'underline']);
const TEXTBLOCK = new Set(['paragraph', 'heading']);
/** The inline node types with text or a place in it (model/nodes.js): a slice of these without paragraphs is one paragraph's runs.
 * Pictures are left out: one pasted alone as text only is dropped, not an empty paragraph. */
const INLINE = new Set(['text', 'hardBreak', 'field', 'bookmark', 'noteRef', 'equation', 'sdtInline', 'ruby', 'ptab']);
// Style keys written by version 1 (plan.md §1.6 Props): read as their version 2 names.
const PARA_V1 = { align: 'textAlign', border: 'borders' };
const RUN_V1 = { charSpacing: 'spacing' };

/** Calls `fn` on every node of `nodes`, depth first. */
function walk(nodes, fn) {
  for (const n of nodes ?? []) {
    fn(n);
    walk(n.content, fn);
  }
}

/** `nodes` with `fn(node)` applied bottom up (fn sees the node with its content already mapped). */
function mapNodes(nodes, fn) {
  return (nodes ?? []).map((n) => fn(n.content ? { ...n, content: mapNodes(n.content, fn) } : n));
}

const rename = (obj, names) => Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [names[k] ?? k, v]));

/** Style `id` of `styles` resolved through its basedOn chain → {para, run} in version 2 names. */
export function resolvedStyle(styles, id) {
  const chain = styleChain({ styles }, id);
  const para = {};
  const run = {};
  for (const s of chain) {
    Object.assign(para, rename(s.para, PARA_V1));
    Object.assign(run, rename(s.run, RUN_V1));
  }
  return { para, run, known: chain.length > 0 };
}

/** The definitions of `id` and the styles it is based on, from `styles` → {id: definition}. */
function withChain(styles, id) {
  return Object.fromEntries(styleChain({ styles }, id).map(({ id: sid, ...def }) => [sid, def]));
}

/** Style run properties `run` laid under a text node's own marks (its own values win). */
function runUnder(node, run) {
  if (node.type !== 'text' || !run || !Object.keys(run).length) return node;
  const marks = [...(node.marks ?? [])];
  const has = (t) => marks.some((m) => m.type === t);
  const style = {};
  for (const [k, v] of Object.entries(run)) {
    if (v == null || v === false) continue;
    if (RUN_MARKS.has(k)) {
      if (!has(k)) marks.push(k === 'underline' ? { type: 'underline', attrs: { val: v?.val ?? 'single' } } : { type: k });
    } else style[k] = v;
  }
  if (Object.keys(style).length) {
    const i = marks.findIndex((m) => m.type === 'textStyle');
    const own = i < 0 ? {} : Object.fromEntries(Object.entries(marks[i].attrs ?? {}).filter(([, v]) => v != null));
    const attrs = { ...style, ...own };
    if (i < 0) marks.push({ type: 'textStyle', attrs });
    else marks[i] = { ...marks[i], attrs: { ...marks[i].attrs, ...attrs } };
  }
  return { ...node, marks };
}

/** A text node's theme references made fixed in `theme`: theme colours to their hex, the heading and body fonts to their names. */
function resolveTheme(node, theme) {
  const i = (node.marks ?? []).findIndex((m) => m.type === 'textStyle');
  if (i < 0 || !theme) return node;
  const a = { ...node.marks[i].attrs };
  if (a.themeColor?.slot && theme.colors?.[a.themeColor.slot]) {
    a.color = resolveColor(theme, a.themeColor);
    a.themeColor = null;
  }
  if (a.font === '+major' || a.font === '+minor') a.font = theme.fonts?.[a.font === '+major' ? 'major' : 'minor'] ?? a.font;
  const marks = [...node.marks];
  marks[i] = { ...marks[i], attrs: a };
  return { ...node, marks };
}

/** The paragraph attrs of `node` with `para` laid under them (its own non-null values win). */
const paraUnder = (node, para) => ({ ...node, attrs: { ...para, ...Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([, v]) => v != null)) } });

/** Keep Source Formatting (`theme` true) or Use Destination Theme (`theme` false): a source style the destination lacks is added
 * (with its basedOn chain); one defined differently there becomes direct formatting over the destination's style; with `theme`,
 * theme colours and fonts are fixed to the source theme's when the themes differ. */
function keepSource(content, o, theme) {
  const addStyles = {};
  const src = o.srcStyles?.list ?? {};
  const dst = o.dstStyles?.list ?? {};
  const fixTheme = theme && o.srcTheme && !same(o.srcTheme, o.dstTheme);
  const out = mapNodes(content, (n) => {
    if (n.type === 'text') return fixTheme ? resolveTheme(n, o.srcTheme) : n;
    if (!TEXTBLOCK.has(n.type)) return n;
    const id = styleIdOf(n);
    if (!src[id]) return n;
    if (!dst[id]) {
      Object.assign(addStyles, withChain(o.srcStyles, id));
      return n;
    }
    if (same(src[id], dst[id])) return n;
    const { para, run } = resolvedStyle(o.srcStyles, id);
    const base = resolvedStyle(o.dstStyles, id);
    // Only what differs from the destination's definition needs writing as direct formatting.
    const diff = (a, b) => Object.fromEntries(Object.entries(a).filter(([k, v]) => !same(v, b[k])));
    const p = paraUnder(n, diff(para, base.para));
    return { ...p, content: (p.content ?? []).map((c) => runUnder(c, diff(run, base.run))) };
  });
  // Character styles the slice uses come along too.
  walk(content, (n) => {
    for (const m of n.marks ?? []) {
      const id = m.type === 'textStyle' && m.attrs?.charStyle;
      if (id && src[id] && !dst[id]) Object.assign(addStyles, withChain(o.srcStyles, id));
    }
  });
  return { content: out, addStyles: Object.keys(addStyles).length ? addStyles : null };
}

/** Use Destination Styles: style ids kept (a style the destination lacks is added), direct formatting equal to the source style's
 * definition dropped, so the destination's definitions show. */
function destinationStyles(content, o) {
  const missing = {};
  for (const id of usedStyles(content)) if (o.srcStyles?.list?.[id] && !o.dstStyles?.list?.[id]) Object.assign(missing, withChain(o.srcStyles, id));
  const out = mapNodes(content, (n) => {
    if (!TEXTBLOCK.has(n.type)) return n;
    const { para, run, known } = resolvedStyle(o.srcStyles, styleIdOf(n));
    if (!known) return n;
    const attrs = Object.fromEntries(Object.entries(n.attrs ?? {}).map(([k, v]) => [k, k !== 'styleId' && k in para && same(v, para[k]) ? null : v]));
    const strip = (c) => {
      if (c.type !== 'text') return c;
      const marks = (c.marks ?? []).flatMap((m) => {
        if (RUN_MARKS.has(m.type)) return m.type in run && run[m.type] ? [] : [m];
        if (m.type !== 'textStyle') return [m];
        const a = Object.fromEntries(Object.entries(m.attrs ?? {}).map(([k, v]) => [k, k in run && same(v, run[k]) ? null : v]));
        return Object.values(a).some((v) => v != null) ? [{ ...m, attrs: a }] : [];
      });
      return { ...c, marks };
    };
    return { ...n, attrs, content: (n.content ?? []).map(strip) };
  });
  return { content: out, addStyles: Object.keys(missing).length ? missing : null };
}

/** Merge Formatting: each paragraph takes the destination paragraph's style and properties (keeping its own list), text takes the
 * destination's character formatting and keeps only its own bold, italic and underline (and its links, comments and revisions). */
function merge(content, o) {
  const destMarks = (o.destMarks ?? []).filter((m) => !MERGE_KEEP.has(m.type) && !NON_FORMAT.has(m.type));
  const out = mapNodes(content, (n) => {
    if (n.type === 'text') {
      const own = (n.marks ?? []).filter((m) => MERGE_KEEP.has(m.type) || NON_FORMAT.has(m.type));
      const marks = [...destMarks, ...own];
      return marks.length ? { ...n, marks } : { type: 'text', text: n.text };
    }
    if (!TEXTBLOCK.has(n.type)) return n;
    return { ...n, type: 'paragraph', attrs: { ...destFormat(o.destAttrs), numbering: n.attrs?.numbering ?? null } };
  });
  return { content: out, addStyles: null };
}

/** The list labels of `content`'s list paragraphs (document order) → Map node → label, using `numbering` for known nums and the
 * pasted `abstract` (lists.js tags it on copy and paste) for new lists. */
function labelsOf(content, numbering) {
  const items = [];
  walk(content, (n) => { if (TEXTBLOCK.has(n.type) && n.attrs?.numbering) items.push(n); });
  const nums = { ...numbering?.nums };
  for (const n of items) {
    const { numId, abstract } = n.attrs.numbering;
    if (!nums[numId] && abstract) nums[numId] = { abstract };
  }
  const labels = listLabels(items.map((n) => n.attrs.numbering), { abstract: { ...LIST_ABSTRACTS, ...numbering?.abstract }, nums });
  return new Map(items.map((n, i) => [n, labels[i]]));
}

/** The plain inline content of textblock `n`: its text without marks (or with `marks`), line breaks kept, objects dropped. */
function plainInline(n, marks) {
  const out = [];
  for (const c of n.content ?? []) {
    if (c.type === 'text' && c.text) out.push(marks.length ? { type: 'text', text: c.text, marks } : { type: 'text', text: c.text });
    else if (c.type === 'hardBreak') out.push({ type: 'hardBreak' });
    // A field pastes its result as text, as Word's Keep Text Only does.
    else if (c.type === 'field' && c.attrs?.result) out.push(marks.length ? { type: 'text', text: c.attrs.result, marks } : { type: 'text', text: c.attrs.result });
  }
  return out;
}

const textOf = (n) => {
  let s = '';
  walk([n], (c) => { if (c.type === 'text') s += c.text; });
  return s;
};

/** Keep Text Only: one plain paragraph per paragraph and table row, cells joined by tabs, pictures and other objects dropped; with
 * `keepBullets` a list paragraph starts with its label typed as text. Paragraphs take the destination paragraph's properties (not
 * its list) and the destination's character formatting. */
function textOnly(content, o) {
  const labels = o.keepBullets ? labelsOf(content, o.numbering) : new Map();
  const marks = (o.destMarks ?? []).filter((m) => !NON_FORMAT.has(m.type));
  const attrs = { ...destFormat(o.destAttrs), numbering: null };
  const para = (inline) => ({ type: 'paragraph', attrs, ...(inline.length && { content: inline }) });
  const withText = (inline, text) => (text ? [{ type: 'text', text, ...(marks.length && { marks }) }, ...inline] : inline);
  const out = [];
  // Inline content alone (a bold word: ProseMirror parses it in the context of the paragraph at the caret) is one paragraph's
  // runs; skipped as a non-block, it pasted nothing.
  if (content.some((n) => INLINE.has(n.type)) && !content.some((n) => TEXTBLOCK.has(n.type))) content = [{ type: 'paragraph', content }];
  const blocks = (nodes) => {
    for (const n of nodes ?? []) {
      if (TEXTBLOCK.has(n.type)) {
        const label = labels.get(n);
        out.push(para(withText(plainInline(n, marks), label ? `${label} ` : '')));
      } else if (n.type === 'table') {
        for (const row of n.content ?? []) {
          // A cell's paragraphs join with spaces; a nested table's text stays in its cell.
          const cells = (row.content ?? []).map((cell) => (cell.content ?? []).map(textOf).filter(Boolean).join(' '));
          out.push(para(withText([], cells.join('\t'))));
        }
      } else if (n.content && !n.type.startsWith('table')) blocks(n.content);
    }
  };
  blocks(content);
  return { content: out, addStyles: null, flat: true };
}

/** `content` (a pasted slice's nodes as JSON) under paste option `mode`. `o`: {srcStyles, dstStyles, srcTheme, dstTheme (doc
 * attrs), destAttrs (the destination paragraph's attrs), destMarks (marks JSON at the destination), keepBullets, numbering (the
 * numbering labels count under), sameDoc}. → {content, addStyles ({id: definition} the destination must gain, or null), flat
 * (the structure changed: the slice opens at most one level)}. */
export function applyMode(mode, content, o = {}) {
  if (mode === 'keepTextOnly') return textOnly(content, o);
  if (mode === 'mergeFormatting') return merge(content, o);
  if (o.sameDoc) return { content, addStyles: null };
  if (mode === 'useDestinationStyles') return destinationStyles(content, o);
  if (mode === 'useDestinationTheme') return keepSource(content, o, false);
  if (mode === 'keepSourceFormatting') return keepSource(content, o, true);
  return { content, addStyles: null };
}
