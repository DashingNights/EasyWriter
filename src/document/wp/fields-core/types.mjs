// The field types fields-core registers (docs/plans/word/plan.md §1.10, briefs/fields-core.md Types): date and time, page and
// section numbers, QUOTE, the AUTONUM family, BIDIOUTLINE, the legacy picture fields and the kept-but-silent ones. Pure: each
// compute reads only its ParsedField and FieldCtx (fields.json notes and examples are the tests).
import { datePicture, star } from './format.mjs';

/** The default pictures (index-fields.md: the en-US document language of the probe). */
export const DEFAULT_DATE = 'M/d/yyyy';
export const DEFAULT_TIME = 'h:mm am/pm';
const LONG = 'M/d/yyyy h:mm:ss am/pm';

/** The calendar switch of `f` ('h', 's' or 'u') or null. */
const calOf = (f) => (f.sw.h ? 'h' : f.sw.s ? 's' : f.sw.u ? 'u' : null);

/** A date field: `when(ctx)` gives the Date (null: never happened) and `pic(f, ctx)` the picture when \@ is absent. The type
 * applies \@ itself (`picture: true`), so the engine does not read its own text back as a date. */
const dateType = (when, pic, updates = 'manual') => ({
  category: 'Date and Time',
  updates,
  picture: true,
  compute: (f, ctx) => {
    const lang = ctx.get('dateLang') ?? 'en-US';
    return datePicture(when(ctx), f.date || pic(f, ctx), { lang, cal: calOf(f) });
  },
});

const stamp = (ms) => (ms ? new Date(ms) : null);

/** The page `ctx` draws: the page being drawn in a header or footer, else the exact page of the field's position. */
export const pageOfCtx = (ctx) => (ctx.story === 'header' || ctx.story === 'footer' ? ctx.page : ctx.pageAt?.(ctx.pos) ?? ctx.page);

/** Whether `f` carries a \* number format, which then numbers the plain page number instead of the section's label. */
const numbered = (f) => f.format.some((x) => !/^(mergeformat|mergeformatinet|charformat|caps|firstcap|upper|lower)$/i.test(x));

// ---------- AUTONUM, AUTONUMLGL, AUTONUMOUT ----------
const AUTO = new Set(['AUTONUM', 'AUTONUMLGL', 'AUTONUMOUT']);
const autoMemo = new WeakMap();
/** The outline level (1 to 9) of textblock `node`, or 1 for body text. */
const levelOf = (node) => (node.type.name === 'heading' ? node.attrs.level ?? 1 : Number.isInteger(node.attrs.outline) ? node.attrs.outline + 1 : 1);

/** The paragraphs of `doc` that hold an AUTONUM-family field, each with its counters: one counter over all of them (Word's probe
 * drew 1. b. 3, 4. 5 6. across AUTONUM, AUTONUMLGL and AUTONUMOUT), nested by outline level. → [{from, to, level, counts}] */
function autoParas(doc, parse) {
  let list = autoMemo.get(doc);
  if (list) return list;
  list = [];
  const counts = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let has = false;
    node.forEach((c) => {
      if (c.type.name === 'field' && AUTO.has(parse(c.attrs.code).name)) has = true;
    });
    if (has) {
      const level = levelOf(node);
      counts[level - 1] = (counts[level - 1] ?? 0) + 1;
      counts.length = level;
      for (let i = 0; i < level - 1; i++) counts[i] ??= 1;
      const outline = node.type.name === 'heading' || Number.isInteger(node.attrs.outline);
      list.push({ from: pos, to: pos + node.nodeSize, level, outline, counts: [...counts] });
    }
    return false;
  });
  autoMemo.set(doc, list);
  return list;
}

// Outline numbering by level (Word's AUTONUMOUT: I. A. 1. a) (1) (a) (i) (a) (i)); body text counts in Arabic.
const OUTLINE = [['ROMAN', '.'], ['ALPHABETIC', '.'], ['Arabic', '.'], ['alphabetic', ')'], ['Arabic', ')', '('], ['alphabetic', ')', '('],
  ['roman', ')', '('], ['alphabetic', '.'], ['roman', '.']];

/** The AUTONUM family type `name`; `parse` is the registry's parseField (the counter scan reads each field's name). */
const autoType = (name, parse) => ({
  category: 'Numbering',
  updates: 'layout',
  compute: (f, ctx) => {
    const p = autoParas(ctx.doc, parse).find((x) => x.from <= ctx.pos && ctx.pos < x.to);
    if (!p) return { text: '', raw: true };
    const n = p.counts[p.level - 1];
    const fmt = (v) => {
      let t = String(v);
      for (const x of f.format) {
        const r = star(t, x);
        if (r.error) return r;
        t = r;
      }
      return t;
    };
    const sep = typeof f.sw.s === 'string' ? f.sw.s : '.';
    let text;
    if (name === 'AUTONUM') text = fmt(n);
    else if (name === 'AUTONUMLGL') text = p.counts.map((v) => fmt(v)).join('.');
    else if (!p.outline) text = fmt(n); // body text counts in Arabic: the probe drew 6. for AUTONUMOUT
    else {
      const [style, close, open = ''] = OUTLINE[(p.level - 1) % 9];
      return { text: open + star(String(n), style) + close, raw: true };
    }
    if (text.error) return text;
    return { text: name === 'AUTONUMLGL' && f.sw.e ? text : text + sep, raw: true };
  },
});

/** The picture field INCLUDEPICTURE (and its old name IMPORT): an img for data: and http(s) sources, else the broken-picture
 * frame Word draws for a missing file (a local path cannot be read from the page). */
const pictureType = {
  category: 'Links and References',
  updates: 'manual',
  compute: () => ({ text: '', raw: true }),
  draw: (f, ctx, el) => {
    const src = String(f.args[0] ?? '');
    el.replaceChildren();
    if (/^(data:image\/|https?:)/i.test(src)) {
      const img = el.ownerDocument.createElement('img');
      img.src = src;
      img.alt = '';
      img.setAttribute('data-field-picture', '');
      el.append(img);
    } else {
      const box = el.ownerDocument.createElement('span');
      box.setAttribute('data-field-broken', '');
      box.title = src;
      el.append(box);
    }
  },
};

/** A field Word keeps with no visible result and never updates (PRIVATE, ADDIN, SHAPE), or an ActiveX control we cannot run
 * (CONTROL, HTMLCONTROL): the code stays, nothing computes. */
const kept = (category) => ({ category, updates: 'never', compute: () => null });

/** Every type of this package, by name; `parse` is the registry's parseField. */
export function fieldTypes(parse) {
  return {
    DATE: dateType((ctx) => ctx.now, (f, ctx) => (f.sw.l ? ctx.get('lastDate') ?? DEFAULT_DATE : DEFAULT_DATE), 'open'),
    TIME: dateType((ctx) => ctx.now, () => DEFAULT_TIME, 'open'),
    CREATEDATE: dateType((ctx) => stamp(ctx.draft.created), () => LONG),
    SAVEDATE: dateType((ctx) => stamp(ctx.draft.saved), () => LONG, 'open'),
    PRINTDATE: dateType((ctx) => stamp(ctx.draft.printed), () => LONG),
    EDITTIME: { category: 'Date and Time', updates: 'manual', compute: (f, ctx) => String(ctx.draft.editMinutes ?? 0) },
    PAGE: {
      category: 'Numbering',
      updates: 'layout',
      compute: (f, ctx) => {
        const page = pageOfCtx(ctx);
        if (!page) return '1';
        return numbered(f) ? String(page.number) : page.label ?? String(page.number);
      },
    },
    NUMPAGES: { category: 'Document Information', updates: 'layout', compute: (f, ctx) => String(ctx.geometry?.pages?.length || 1) },
    SECTION: {
      category: 'Numbering',
      updates: 'layout',
      compute: (f, ctx) => String((pageOfCtx(ctx)?.section ?? 0) + 1),
    },
    SECTIONPAGES: {
      category: 'Numbering',
      updates: 'layout',
      compute: (f, ctx) => {
        const s = pageOfCtx(ctx)?.section ?? 0;
        const box = ctx.geometry?.sections?.[s];
        return String(box?.pages ?? (ctx.geometry?.pages?.filter((p) => p.section === s).length || 1));
      },
    },
    // QUOTE joins its arguments without spaces (QUOTE noquotes here gave noquoteshere); apostrophes are no quotes.
    QUOTE: { category: 'Links and References', updates: 'manual', compute: (f) => f.args.join('') },
    PRIVATE: kept('All'),
    ADDIN: kept('All'),
    SHAPE: kept('All'),
    CONTROL: kept('All'),
    HTMLCONTROL: kept('All'),
    AUTONUM: autoType('AUTONUM', parse),
    AUTONUMLGL: autoType('AUTONUMLGL', parse),
    AUTONUMOUT: autoType('AUTONUMOUT', parse),
    // In a left-to-right paragraph Word draws ### in bold (probe); right-to-left outline numbering is not built.
    BIDIOUTLINE: { category: 'All', updates: 'layout', compute: () => ({ error: '###' }) },
    INCLUDEPICTURE: pictureType,
    IMPORT: pictureType,
  };
}
