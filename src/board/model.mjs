// A board item as an engine model (docs/plans/board/design.md section 2, briefs/bd-paint.md). ew-board lays the model out in a
// scratch session and keeps its first page as the item's stamp, so everything an item draws is built here as the engine's own
// stored form: one paragraph holding the shape or picture (floating, in front of the text), or the item's story. The keys are the
// ones `save('engine')` writes, read from test/fixtures/board/shape-model.json (a shape's object sits in its paragraph's
// `objects`, its outline width is `stroke_width`). Pure, with no DOM or engine call, so it runs in the page, the worker and node.
//
// Each model carries only the styles and lists its paragraphs use: the engine reads the whole stored form on every stamp, and
// the 57 built-in styles are 90 percent of a blank model.

const enc = new TextEncoder();
const dec = new TextDecoder();
const OBJ = '\uFFFC';

/** The styles every document resolves without being named: a paragraph with none is Normal, text with none has the default
 * character style, a table with none Table Normal. */
const DEFAULTS = ['Normal', 'DefaultParagraphFont', 'TableNormal', 'NoList'];

/** A connector's label box when its derived fields give none, points. */
const LABEL = { w: 160, h: 24 };

/** The page a text without a stored height is laid out on: tall enough that a board item never breaks a page. */
const TALL = 20000;

let current = null;

const parse = (saved) => (typeof saved === 'string' ? JSON.parse(saved) : saved instanceof Uint8Array ? JSON.parse(dec.decode(saved)) : saved);

/** The base every model is made from: `saved`, the item session's `save('engine')` of an empty document (bytes, text or the
 * parsed object), read once. It is also the default base of `modelOf`. */
export function blankModel(saved) {
  current = parse(saved);
  return current;
}

/** The ids of the styles, lists and parts that `blocks` use, following what each names: a style's basedOn, next and link and its
 * list, a list level's style, a text box's next box. The default styles are always in. */
function used(blocks, parts, styles, numbering) {
  const u = { styles: new Set(DEFAULTS), nums: new Set(), parts: new Set() };
  const scan = (node) => {
    if (Array.isArray(node)) return node.forEach(scan);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'noteRef' && typeof node.id === 'number') u.parts.add(node.id);
    for (const k in node) {
      const v = node[k];
      if (k === 'style' && typeof v === 'string') u.styles.add(v);
      else if (k === 'numbering' && v && typeof v.num === 'number') u.nums.add(v.num);
      else if (k === 'story' && typeof v === 'number') u.parts.add(v);
      else if (v && typeof v === 'object') scan(v);
    }
  };
  const byStyle = new Map((styles?.styles ?? []).map((s) => [s.id, s]));
  const byNum = new Map((numbering?.nums ?? []).map((n) => [n.id, n]));
  const byAbstract = new Map((numbering?.abstracts ?? []).map((a) => [a.id, a]));
  const seen = { styles: new Set(), nums: new Set(), parts: new Set() };
  scan(blocks);
  // Each pass reads what the last one added, until nothing new is named.
  for (let more = true; more; ) {
    more = false;
    for (const id of u.parts) {
      if (seen.parts.has(id)) continue;
      seen.parts.add(id);
      const part = parts?.[id];
      if (part) scan(part.blocks);
      if (typeof part?.body?.next === 'number') u.parts.add(part.body.next);
      more = true;
    }
    for (const id of u.styles) {
      if (seen.styles.has(id)) continue;
      seen.styles.add(id);
      const s = byStyle.get(id);
      for (const link of [s?.basedOn, s?.next, s?.linked]) if (typeof link === 'string') u.styles.add(link);
      scan(s?.para);
      more = true;
    }
    for (const id of u.nums) {
      if (seen.nums.has(id)) continue;
      seen.nums.add(id);
      for (const level of byAbstract.get(byNum.get(id)?.abstractId)?.levels ?? []) if (typeof level.style === 'string') u.styles.add(level.style);
      more = true;
    }
  }
  return { u, byNum };
}

/** `{parts, styles, numbering}` cut to what `blocks` (and the parts they name) use. */
function kept(blocks, parts, styles, numbering) {
  const { u, byNum } = used(blocks, parts, styles, numbering);
  const abstracts = new Set([...u.nums].map((n) => byNum.get(n)?.abstractId));
  return {
    parts: Object.fromEntries(Object.entries(parts ?? {}).filter(([id]) => u.parts.has(Number(id)))),
    styles: { ...styles, styles: (styles?.styles ?? []).filter((s) => u.styles.has(s.id)) },
    numbering: {
      abstracts: (numbering?.abstracts ?? []).filter((a) => abstracts.has(a.id)),
      nums: (numbering?.nums ?? []).filter((n) => u.nums.has(n.id)),
    },
  };
}

/** A saved model (bytes, text or the parsed object) → its story, `{blocks, parts, styles, numbering}`, with the styles, lists and
 * parts its blocks use and nothing else. */
export function storyOf(model) {
  const m = parse(model);
  return { blocks: m.body, ...kept(m.body, m.parts, m.styles, m.numbering) };
}

/** `base`'s styles with `extra`'s on top: a style of the same id is replaced in place, a new one follows. */
function mergeStyles(base, extra) {
  if (!extra) return base;
  const { styles: added = [], ...defaults } = extra;
  const own = new Map(added.map((s) => [s.id, s]));
  const have = new Set((base.styles ?? []).map((s) => s.id));
  return { ...base, ...defaults, styles: [...(base.styles ?? []).map((s) => own.get(s.id) ?? s), ...added.filter((s) => !have.has(s.id))] };
}

/** `base` with `story`'s blocks, parts, styles and numbering: a new object, with `base` untouched. The base's own styles stay
 * for what the story does not name, so the model can be edited with the whole gallery. */
export function mergeStory(base, story) {
  return {
    ...base,
    body: story.blocks,
    parts: story.parts ?? {},
    styles: mergeStyles(base.styles, story.styles),
    numbering: story.numbering ?? base.numbering,
  };
}

const float = (wrap) => ({ wrap, hRel: 'page', vRel: 'page', x: 0, y: 0, dist: 0, distTop: 0, distBottom: 0, effect: [0, 0, 0, 0] });

/** A paragraph holding the objects `objs`, one object character each. */
const holder = (objs) => ({ kind: 'para', text: OBJ.repeat(objs.length), runs: [{ len: 3 * objs.length }], objects: objs });

/** A shape's object for the item's fields (the stored form of `insert.shape`). `story` is the label's part id. */
function shapeObject(item, w, h, story = null) {
  const o = {
    type: 'shape',
    kind: item.kind ?? (item.type === 'ink' ? 'freeform' : 'rectangle'),
    w,
    h,
    fill: item.fill ?? null,
    stroke: item.stroke ?? null,
    stroke_width: item.strokeWidth ?? item.stroke_width ?? 1,
    float: float('inFrontOfText'),
    story,
  };
  if (item.freeform) o.freeform = item.freeform;
  if (item.effects) o.effects = item.effects;
  // The board's extra names an arrow at the end in camelCase; the stored form's field is the engine's arrow_end.
  if (item.extra) o.extra = item.extra.arrowEnd === undefined ? item.extra : { ...item.extra, arrow_end: !!item.extra.arrowEnd };
  return o;
}

const empty = (story) => !story?.blocks?.some((b) => b.kind !== 'para' || b.text || b.objects?.length);

/** Adds `story` to `m` as a text box part and gives the part's id (null for a story with no content): its parts come along, its
 * styles and the lists it defines join the model's. */
function addStory(m, story) {
  if (empty(story)) return null;
  const id = Math.max(0, ...Object.keys(m.parts).map(Number), ...Object.keys(story.parts ?? {}).map(Number)) + 1;
  m.parts = { ...m.parts, ...story.parts, [id]: { kind: 'textBox', blocks: story.blocks, body: { vert: 'horz', anchor: 'center' } } };
  m.styles = mergeStyles(m.styles, story.styles);
  if (story.numbering) {
    const n = m.numbering ?? { abstracts: [], nums: [] };
    const has = (list, e) => list.some((x) => x.id === e.id);
    m.numbering = {
      abstracts: [...n.abstracts, ...story.numbering.abstracts.filter((a) => !has(n.abstracts, a))],
      nums: [...n.nums, ...story.numbering.nums.filter((x) => !has(n.nums, x))],
    };
  }
  return id;
}

const bytesToBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** A label's box at its point `p` (`[x, y]` or `{x, y}`, the box's frame), centred. */
function labelShape(p, size) {
  const [x, y] = Array.isArray(p) ? p : [p.x, p.y];
  const w = p.w ?? size.w;
  const h = p.h ?? size.h;
  return { ...shapeObject({ kind: 'rectangle' }, w, h, null), float: { ...float('inFrontOfText'), x: x - w / 2, y: y - h / 2 } };
}

/**
 * The stamp input of `item` → the model as bytes, or null for an item with no stamp (a group, an instance). `base` is the
 * blank model (default: the last `blankModel`), `media` the board's pictures as a Map or object from key to bytes or a data URL.
 * A picture's key is a hash of its bytes (bd-pictures' `mediaKey`), so equal keys are equal bytes: the engine's board keeps one copy
 * of each key for all the stamps that name it, and lets it go with the last of them.
 * Only a text item's `story` and a shape's label need the story's styles; `opts.allStyles` keeps the base's whole gallery for a
 * model that is opened for editing rather than stamped.
 */
export function modelOf(item, base = current, media = {}, opts = {}) {
  if (!base) throw new Error('modelOf needs a base model: call blankModel(saved) first.');
  const w = Number.isFinite(item.w) ? item.w : 0;
  const h = Number.isFinite(item.h) ? item.h : 0;
  const m = { ...base, parts: {} };
  switch (item.type) {
    case 'shape':
    case 'ink':
    case 'connector': {
      const objs = [shapeObject(item, w, h, null)];
      objs[0].story = addStory(m, item.story);
      if (item.type === 'connector') {
        for (const slot of ['start', 'mid', 'end']) {
          const at = item.labelAt?.[slot];
          const part = at && addStory(m, item.labels?.[slot]);
          if (part) objs.push({ ...labelShape(at, LABEL), story: part });
        }
      }
      m.body = [holder(objs)];
      break;
    }
    case 'picture': {
      const bytes = media.get?.(item.media) ?? media[item.media];
      const obj = {
        type: 'image',
        media: item.media,
        w,
        h,
        alt: item.alt ?? '',
        float: { ...float('inFrontOfText'), ...item.look },
        crop: item.crop ?? [0, 0, 0, 0],
      };
      m.body = [holder([obj])];
      if (bytes) m.media = { [item.media]: typeof bytes === 'string' ? bytes : bytesToBase64(bytes) };
      break;
    }
    case 'text': {
      Object.assign(m, mergeStory(base, item.story ?? { blocks: [{ kind: 'para', text: '', runs: [] }] }));
      if (item.fill || item.stroke) {
        // The backdrop is a shape behind the text, held by the first paragraph (its object character takes no room).
        const back = { ...shapeObject({ kind: 'rectangle', fill: item.fill, stroke: item.stroke, strokeWidth: item.strokeWidth }, w, h), float: float('behindText') };
        const [first, ...rest] = m.body;
        m.body = first.kind === 'para'
          ? [{ ...first, text: first.text + OBJ, runs: [...first.runs, { len: 3 }], objects: [...(first.objects ?? []), back] }, ...rest]
          : [holder([back]), first, ...rest];
      }
      break;
    }
    default:
      return null;
  }
  // ponytail: a page at least 1 pt each way, so a line with no height still has a page; its stroke gives the stamp its size.
  // A fitted text's height is its text's (a previous stamp's, which `derive` gives it), so its page is a tall one that never
  // breaks it; only a fixed text's box is its page. Laid out as a page (ew-board, a width under the Web view's 144 pt floor),
  // both are the item's own width.
  const pageH = item.type === 'text' && item.fit !== 'fixed' ? TALL : Math.max(1, h);
  m.lastSection = { ...base.lastSection, pageW: Math.max(1, w), pageH, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, header: 0, footer: 0 };
  if (!opts.allStyles) Object.assign(m, kept(m.body, m.parts, m.styles, m.numbering));
  return enc.encode(JSON.stringify(m));
}
