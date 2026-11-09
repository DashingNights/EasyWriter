// The styles work package's pure logic (docs/plans/word/plan.md §3 styles, briefs/styles.md): Word's quick style list and the
// character and linked styles it adds on first use, the gallery order, which half of a linked style a selection takes, the
// definitions Create a Style, Update to Match Selection and Automatically update write, outline levels, Add Text and Set As
// Default. No DOM or app import, so test/word-styles.test.mjs loads it.
import { deepPatch, isPlain } from '../../../office.mjs';

// Colours of the probe's styles.xml with their theme links (themeShade BF is lum -0.25; themeTint BF 0.25, A5 0.35).
const ACCENT1_DARK = { color: '#0F4761', themeColor: { slot: 'accent1', lum: -0.25 } };
const TEXT1_BF = { color: '#404040', themeColor: { slot: 'dk1', lum: 0.25 } };
const TEXT1_A5 = { color: '#5A5A5A', themeColor: { slot: 'dk1', lum: 0.35 } };

/** Word's character quick styles, added to a document by ensureStyles the first time one is applied. Intense Emphasis and Intense
 * Reference as the probe's styles.xml holds them; the other five from Word's latent definitions (not probed). */
export const CHAR_STYLES = {
  SubtleEmphasis: { type: 'character', name: 'Subtle Emphasis', uiPriority: 19, qFormat: true, run: { italic: true, ...TEXT1_BF } },
  Emphasis: { type: 'character', name: 'Emphasis', uiPriority: 20, qFormat: true, run: { italic: true } },
  IntenseEmphasis: { type: 'character', name: 'Intense Emphasis', uiPriority: 21, qFormat: true, run: { italic: true, ...ACCENT1_DARK } },
  Strong: { type: 'character', name: 'Strong', uiPriority: 22, qFormat: true, run: { bold: true } },
  SubtleReference: { type: 'character', name: 'Subtle Reference', uiPriority: 31, qFormat: true, run: { smallCaps: true, ...TEXT1_A5 } },
  IntenseReference: { type: 'character', name: 'Intense Reference', uiPriority: 32, qFormat: true, run: { bold: true, smallCaps: true, spacing: 0.25, ...ACCENT1_DARK } },
  BookTitle: { type: 'character', name: 'Book Title', uiPriority: 33, qFormat: true, run: { bold: true, italic: true, spacing: 0.25 } },
};

/** The names Word shows for the built-in styles (styles.xml keeps some in lower case, 'heading 1'). */
export const BUILTIN_NAMES = {
  Normal: 'Normal', NoSpacing: 'No Spacing', Title: 'Title', Subtitle: 'Subtitle', Quote: 'Quote', IntenseQuote: 'Intense Quote',
  ListParagraph: 'List Paragraph', Hyperlink: 'Hyperlink', TableNormal: 'Normal Table', TableGrid: 'Table Grid',
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Heading${i + 1}`, `Heading ${i + 1}`])),
  ...Object.fromEntries(Object.entries(CHAR_STYLES).map(([id, s]) => [id, s.name])),
};

// Built-in names a new style may not take, besides those above: the probe's latent styles Word lists in Style based on.
const RESERVED = ['Default Paragraph Font', 'Caption', 'Bibliography', 'TOC Heading', ...Array.from({ length: 9 }, (_, i) => `TOC ${i + 1}`)];

/** The quick styles' gallery order (w:uiPriority in the probe's latent style list); Heading 3 to 9 share Heading 1's 9. */
export const PRIORITY = {
  Normal: 0, NoSpacing: 1, Title: 10, Subtitle: 11, Quote: 29, IntenseQuote: 30, ListParagraph: 34,
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Heading${i + 1}`, 9])),
  ...Object.fromEntries(Object.entries(CHAR_STYLES).map(([id, s]) => [id, s.uiPriority])),
};
// In the gallery from the start (qFormat); Heading 3 to 9 join as the heading above them is used (unhideWhenUsed).
const QUICK = new Set(['Normal', 'NoSpacing', 'Heading1', 'Heading2', 'Title', 'Subtitle', 'Quote', 'IntenseQuote', 'ListParagraph', ...Object.keys(CHAR_STYLES)]);

/** The paragraph styles Word links to a character half ('Heading 1 Char'), by id → the half's id. */
export const LINKED = Object.fromEntries(['Title', 'Subtitle', 'Quote', 'IntenseQuote', ...Array.from({ length: 9 }, (_, i) => `Heading${i + 1}`)]
  .map((id) => [id, `${id}Char`]));

/** The name Word shows for style `id` of `list`, with any aliases Rename added ('Heading 1,Chapter'). */
export function displayName(list, id) {
  const s = list?.[id] ?? CHAR_STYLES[id];
  const base = BUILTIN_NAMES[id] ?? s?.name ?? id;
  return s?.aliases ? `${base},${s.aliases}` : base;
}

/** The character half of paragraph style `id` in `list`, or null: its `link`, else the pairing by id older documents use. */
export function charHalfOf(list, id) {
  const s = list?.[id];
  if (!s || s.type !== 'paragraph') return null;
  return s.link ?? (list[`${id}Char`] ? `${id}Char` : LINKED[id] ?? null);
}

/** The paragraph style that character style `id` of `list` is the half of, or null. */
export function linkedParaOf(list, id) {
  const s = list?.[id];
  if (!s || s.type !== 'character') return null;
  const pid = s.link ?? (id.endsWith('Char') ? id.slice(0, -4) : null);
  return pid && list[pid]?.type === 'paragraph' ? pid : null;
}

/** The definition of the character half of paragraph style `pid` in `list` (named '<name> Char', linked both ways), holding
 * the paragraph style's own run properties as Word's does. */
export function charHalfDef(list, pid) {
  const s = list[pid];
  return { type: 'character', name: `${displayName(list, pid).split(',')[0]} Char`, link: pid, uiPriority: s.uiPriority ?? PRIORITY[pid] ?? 99,
    ...(s.run && { run: structuredClone(s.run) }) };
}

/** The definitions `apply` needs in `list` before style `id` is applied → {[id]: definition} to add (ensureStyles) and the
 * patches of styles already there ({[id]: patch}), or nulls. `half` asks for the character half of a paragraph style. */
export function needs(list, id, half = false) {
  const add = {};
  const patch = {};
  if (!list[id] && CHAR_STYLES[id]) add[id] = structuredClone(CHAR_STYLES[id]);
  if (half && list[id]?.type === 'paragraph') {
    const cid = charHalfOf(list, id) ?? `${id}Char`;
    if (!list[cid]) add[cid] = charHalfDef(list, id);
    if (list[id].link !== cid) patch[id] = { link: cid };
  }
  return { add: Object.keys(add).length ? add : null, patch: Object.keys(patch).length ? patch : null };
}

/** The styles a document uses and how often: {[styleId]: count} over paragraphs (a heading's HeadingN) and character style
 * instances. `blocks` is [{styleId, chars: [charStyle or null per inline node, in order]}]; neighbours with the same charStyle
 * are one instance (a bold word inside it splits the nodes, not the run), as Word counts them. */
export function usage(blocks) {
  const n = {};
  const add = (id) => {
    n[id] = (n[id] ?? 0) + 1;
  };
  for (const b of blocks) {
    add(b.styleId);
    (b.chars ?? []).forEach((c, i, all) => c && c !== all[i - 1] && add(c));
  }
  return n;
}

/** The ids of the Styles gallery for `list` and the `used` counts, in Word's order: uiPriority, then name. A style is in it while
 * qFormat holds (Word's quick styles by default, a new style's own flag; Remove from Style Gallery sets it false), never hidden or
 * semi-hidden; Heading 3 to 9 join once they or the heading above them are used. The quick character styles show before a
 * document holds them. Character halves of linked styles never show. */
export function galleryIds(list = {}, used = {}) {
  const ids = new Set([...Object.keys(list), ...Object.keys(CHAR_STYLES)]);
  const out = [];
  for (const id of ids) {
    const s = list[id] ?? CHAR_STYLES[id];
    if (!s || !['paragraph', 'character'].includes(s.type) || s.hidden || s.semiHidden || linkedParaOf(list, id)) continue;
    const h = /^Heading([3-9])$/.exec(id);
    const shown = s.qFormat ?? (QUICK.has(id) || (!!h && (used[id] > 0 || used[`Heading${h[1] - 1}`] > 0)));
    if (shown) out.push(id);
  }
  const prio = (id) => (list[id] ?? CHAR_STYLES[id]).uiPriority ?? PRIORITY[id] ?? 99;
  return out.sort((a, b) => prio(a) - prio(b) || displayName(list, a).localeCompare(displayName(list, b), 'en', { numeric: true }));
}

/** Whether gallery tile `id` draws ¶ before its name: a paragraph style with no character half (Normal, No Spacing, List
 * Paragraph), as Word's tiles do. */
export const pilcrow = (list, id) => (list[id] ?? CHAR_STYLES[id])?.type === 'paragraph' && !charHalfOf(list, id);

/** Which part of linked style `id` a selection takes: 'char' (its character half) on part of one paragraph, else 'para' (a
 * caret, whole paragraphs, or several paragraphs), and always 'para' with the Styles pane's Disable Linked Styles. `sel` is
 * {empty, from, to, blocks: [{from, to}]}, the blocks' text ranges. */
export function linkedPart(sel, noLinked = false) {
  if (noLinked || sel.empty || sel.blocks.length !== 1) return 'para';
  const [b] = sel.blocks;
  return sel.from <= b.from && sel.to >= b.to ? 'para' : 'char';
}

/** The next free name for Create a Style: Style1, Style2 and up, skipping every id and name `list` holds. */
export function nextStyleName(list = {}) {
  const taken = new Set(Object.entries(list).flatMap(([id, s]) => [id.toLowerCase(), (s.name ?? '').toLowerCase()]));
  let n = 1;
  while (taken.has(`style${n}`)) n++;
  return `Style${n}`;
}

/** A new style id for `name`: its letters and digits, made unique in `list`. */
export function idFor(list = {}, name) {
  const base = String(name).replace(/[^A-Za-z0-9]/g, '') || 'Style';
  let id = base;
  for (let n = 2; list[id] || BUILTIN_NAMES[id]; n++) id = `${base}${n}`;
  return id;
}

/** Why `name` cannot name style `id` in `list`, in our words, or null: it is empty, reserved for a built-in style, or another
 * style's name. */
export function nameProblem(list = {}, name, id = null) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return 'Type a name for the style.';
  const builtin = [...Object.entries(BUILTIN_NAMES), ...RESERVED.map((r) => [null, r])].find(([bid, b]) => b.toLowerCase() === n && bid !== id);
  if (builtin) return 'That name belongs to a built-in style.';
  const other = Object.entries(list).find(([sid, s]) => sid !== id && (s.name ?? sid).toLowerCase() === n);
  return other ? 'Another style already has that name.' : null;
}

// Run keys that are marks of their own in the Document schema rather than textStyle attributes.
const MARK_KEYS = { bold: 'bold', italic: 'italic', strike: 'strike', subscript: 'subscript', superscript: 'superscript' };
// textStyle attributes that never go into a style: the style itself, Fit Text's per-run id.
const NOT_STYLE = new Set(['charStyle', 'fitText']);
/** The paragraph attributes a style can hold (plan.md §1.8): everything but the paragraph's identity, list and revisions. */
export const PARA_KEYS = ['textAlign', 'spacing', 'indent', 'tabs', 'keepNext', 'keepLines', 'widowControl', 'pageBreakBefore', 'outline', 'contextual',
  'borders', 'shading', 'bidi', 'mirrorIndents', 'suppressLineNumbers', 'suppressAutoHyphens', 'snapToGrid', 'asian', 'frame'];

/** A selection's direct formatting as a style's halves: `marks` [{type, attrs}] of its first run (or the caret's) → run, the
 * paragraph's own `paraAttrs` → para. Only set values count. */
export function formattingOf(marks = [], paraAttrs = {}) {
  const run = {};
  for (const m of marks) {
    if (MARK_KEYS[m.type]) run[MARK_KEYS[m.type]] = true;
    else if (m.type === 'underline') run.underline = { val: m.attrs?.val ?? 'single', ...(m.attrs?.color && { color: m.attrs.color }) };
    else if (m.type === 'textStyle') for (const [k, v] of Object.entries(m.attrs ?? {})) if (v != null && !NOT_STYLE.has(k)) run[k] = v;
  }
  const para = {};
  for (const k of PARA_KEYS) if (paraAttrs[k] != null) para[k] = paraAttrs[k];
  return { run, para };
}

/** Style `s` with v1's key names read as v2 (plan.md §1.6): align is textAlign, border is borders, charSpacing is spacing. */
export function v2(s) {
  if (!s) return s;
  const out = { ...s };
  if (s.para && ('align' in s.para || 'border' in s.para)) {
    const { align, border, ...para } = s.para;
    out.para = { ...(align != null && { textAlign: align }), ...(border != null && { borders: border }), ...para };
  }
  if (s.run && 'charSpacing' in s.run) {
    const { charSpacing, ...run } = s.run;
    out.run = { ...(charSpacing != null && { spacing: charSpacing }), ...run };
  }
  return out;
}

/** `half` (a style's run or para) with `patch` merged in key by key (null removes a key), or undefined when nothing is left. */
const merged = (half, patch) => {
  const out = deepPatch(half ?? {}, patch);
  return Object.keys(out).length ? out : undefined;
};

/** Style `s` redefined with formatting `fmt` ({run, para}), written under v2 names: Update to Match Selection, a Format dialog's
 * value, Automatically update. A character style takes only the run. */
export function patchStyle(s, fmt) {
  const out = v2(s);
  if (fmt.run && Object.keys(fmt.run).length) out.run = merged(out.run, fmt.run);
  if (s.type !== 'character' && fmt.para && Object.keys(fmt.para).length) out.para = merged(out.para, fmt.para);
  for (const k of ['run', 'para']) if (out[k] === undefined) delete out[k];
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** What `eff` sets differently from `base` (one style half each): its own keys, and false for a toggle `base` turns on that
 * `eff` lacks. */
function ownOver(eff = {}, base = {}) {
  const out = {};
  for (const [k, v] of Object.entries(eff)) if (v != null && !same(v, base[k])) out[k] = v;
  // ponytail: only toggles are turned off; a non-toggle key the base chain sets and the selection lacks stays inherited.
  for (const [k, v] of Object.entries(base)) if (v === true && eff[k] == null) out[k] = false;
  return out;
}

/** Update to Match Selection from a selection in another style: style `s` redefined to draw `eff` ({run, para}, the selection's
 * effective formatting) over `base` ({run, para} its basedOn chain and the document defaults give). Its halves become what
 * differs from `base`; a paragraph style keeps its own outline level, which the paragraph takes with the style. */
export function matchedStyle(s, eff, base) {
  const out = { ...v2(s), run: ownOver(eff.run, base.run) };
  if (s.type === 'character') delete out.para;
  else out.para = { ...ownOver(eff.para, base.para), ...(out.para?.outline != null && { outline: out.para.outline }) };
  for (const k of ['run', 'para']) if (out[k] && !Object.keys(out[k]).length) delete out[k];
  return out;
}

/** The definition Create a Style writes for `name` from formatting `fmt`, based on the paragraph's style `basedOn`: a linked
 * paragraph style in the gallery whose next style is itself, as Word's (its character half is added with it). */
export function styleFromFormatting(list, name, basedOn, fmt, id = idFor(list, name)) {
  const s = { type: 'paragraph', name, ...(basedOn && { basedOn }), next: id, qFormat: true, link: `${id}Char` };
  if (Object.keys(fmt.run ?? {}).length) s.run = structuredClone(fmt.run);
  if (Object.keys(fmt.para ?? {}).length) s.para = structuredClone(fmt.para);
  return { id, style: s };
}

/** The paragraph keys a change folds into an Automatically update style: those of `now` (the paragraph's own attributes) that
 * differ from `before` while the paragraph kept its style. → {para patch for the style, keys to clear on the paragraph}. */
export function foldDirect(before, now) {
  const para = {};
  for (const k of PARA_KEYS) {
    if (now[k] == null || JSON.stringify(now[k]) === JSON.stringify(before?.[k] ?? null)) continue;
    para[k] = now[k];
  }
  return { para, clear: Object.keys(para) };
}

/** The outline level of a paragraph: its own `outline`, else its style chain's (`stylePara`, resolved), else a heading's level
 * minus 1, else 9 (Body Text). Levels are 0 to 9 as w:outlineLvl. */
export function outlineLevel(own, stylePara, headingLevel = null) {
  const v = own ?? stylePara?.outline ?? (headingLevel ? headingLevel - 1 : null);
  return v == null || v < 0 || v > 9 ? 9 : v;
}

/** What References > Add Text's item `item` ('doNotShowInTableOfContents', 'level1' to 'level3') does to a paragraph that is
 * a heading or not: {style} applies a style, {para} sets its own outline level. */
export function addTextAction(item, isHeading) {
  const m = /^level([1-3])$/.exec(item);
  if (m) return { style: `Heading${m[1]}` };
  return isHeading ? { style: 'Normal' } : { para: { outline: 9 } };
}

/** The Add Text item checked for outline level `level` (0 to 9), or null for levels 4 to 9 of a heading-free list. */
export const addTextItemOf = (level) => (level === 9 ? 'doNotShowInTableOfContents' : level <= 2 ? `level${level + 1}` : null);

/** The styles attribute `styles` with `half` ('run' or 'para') of its document defaults patched by `value` (Set As Default for
 * this document; Word writes docDefaults). */
export function withDefaults(styles, half, value) {
  const defaults = styles?.defaults ?? {};
  return { ...styles, defaults: { ...defaults, [half]: deepPatch(defaults[half] ?? {}, value) } };
}

/** settings.word.newDocument patched so new documents take `half` of `value` as their defaults ("All documents based on the
 * Normal template"), or style `id` as `style` ("New documents based on this template"). */
export function newDocumentPatch(nd, { half, value, id, style }) {
  const styles = nd?.styles ?? {};
  if (id) return { ...nd, styles: { ...styles, list: { ...styles.list, [id]: style } } };
  const defaults = styles.defaults ?? {};
  return { ...nd, styles: { ...styles, defaults: { ...defaults, [half]: deepPatch(defaults[half] ?? {}, value) } } };
}

/** The styles attribute `styles` with style `id` patched by `patch` (or added when new), keeping every key it does not name. */
export function withStyle(styles, id, patch) {
  const list = styles?.list ?? {};
  const old = list[id];
  return { ...styles, list: { ...list, [id]: old && isPlain(patch) ? { ...old, ...patch } : patch } };
}

/** A short description of style `s` for the Style properties box, in Word's terms ("Font: Bold, 24 pt, Font color: #C00000,
 * Centered, Style: Show in the Styles gallery, Based on: Normal"). */
export function describe(list, s) {
  const r = v2(s).run ?? {};
  const p = v2(s).para ?? {};
  const font = [r.font && (r.font.startsWith('+') ? (r.font === '+major' ? '+Headings' : '+Body') : r.font), r.size && `${r.size} pt`,
    r.bold && 'Bold', r.italic && 'Italic', r.underline && 'Underline', r.smallCaps && 'Small caps', r.color && `Font color: ${r.color}`].filter(Boolean);
  const ALIGN = { left: 'Left', center: 'Centered', right: 'Right', justify: 'Justified', distribute: 'Distributed' };
  const parts = [font.length && `Font: ${font.join(', ')}`, ALIGN[p.textAlign], p.indent?.left != null && `Indent: Left ${p.indent.left} pt`,
    p.spacing?.before != null && `Space Before: ${p.spacing.before} pt`, p.spacing?.after != null && `After: ${p.spacing.after} pt`,
    s.qFormat !== false && 'Style: Show in the Styles gallery', s.autoRedefine && 'Automatically update'].filter(Boolean);
  const base = s.basedOn ? `Based on: ${displayName(list, s.basedOn)}` : '';
  return [parts.join(', '), base].filter(Boolean).join('\n');
}

/** CSS declarations `css` ({'font-size': '12pt'}) as a React style object ({fontSize: '12pt'}), leaving out unset values and
 * Word's mso- properties; custom properties keep their names. */
export const camelCss = (css) => Object.fromEntries(Object.entries(css ?? {}).filter(([k, v]) => v != null && !k.startsWith('mso-'))
  .map(([k, v]) => [k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
