// The header and footer page layer (docs/plans/word/plan.md §1.9 PageLayer, §3 headers-footers): on every page the part the page
// shows, drawn with the kit schema's DOMSerializer at the header and footer distances across the text width, its PAGE, NUMPAGES,
// SECTIONPAGES and SECTION fields patched per page. The top and bottom margins take double-clicks (open the part) and right-clicks
// (a small Edit Header or Edit Footer menu). reserve() gives engine 2 the measured heights, so a tall header moves the body.
import { DOMSerializer } from '@tiptap/pm/model';
import { readJson } from '../../../office.mjs';
import { drawCanvas, injectStyle, loneShape } from '../../../whiteboard.js';
import { computeField } from '../../fields/engine.js';
import { fieldCtx } from '../../fields/registry.mjs';
import { geometryOf } from '../../geometry.js';
import { storyDoc } from '../../model/blocks.mjs';
import { classTables } from '../../stylesheet.js';
import { WRAPS_BESIDE } from '../float-layout/place.mjs';
import { placePartFloats } from '../float-layout/plugin.js';
import { drawnStyle } from '../paragraph/extension.js';
import { layoutTabs } from '../tabs/static.js';
import { drawnSects, hfKey, openStory } from './edit.js';
import { EDGE, fieldName, layoutFieldText, partOf, reserveOf, resolvePart } from './model.mjs';

// A number per part content object, so a key names the content without serialising it (a part changes by being replaced).
const ids = new WeakMap();
let nextId = 1;
const idOf = (o) => {
  if (!o) return 0;
  if (!ids.has(o)) ids.set(o, nextId++);
  return ids.get(o);
};
// A number per part content, equal for equal contents, for the measured sizes: a Word file gives each section its own copy of a
// part (the Word fixture's 414 sections hold 337 parts with 48 contents), and each copy was measured on its own.
const sames = new WeakMap();
const byJson = new Map();
const sameOf = (o) => {
  if (!o) return 0;
  let id = sames.get(o);
  if (id == null) {
    const json = JSON.stringify(o);
    id = byJson.get(json);
    if (id == null) byJson.set(json, (id = byJson.size + 1));
    sames.set(o, id);
  }
  return id;
};

/** Draws the canvases of a part's static DOM (div[data-canvas], a Word shape in a header or footer): their artboard at their
 * display width, as the body's canvas view draws it. */
function drawCanvases(part) {
  for (const el of part.querySelectorAll('div[data-canvas]')) {
    const a = readJson(el.getAttribute('data-json'));
    if (!(a?.w > 0 && a?.h > 0)) continue;
    injectStyle();
    const dw = a.dw > 0 ? a.dw : a.w;
    Object.assign(el.style, { position: 'relative', width: `${dw}px`, height: `${(dw * a.h) / a.w}px` });
    drawCanvas(el, { aw: a.w, ah: a.h, bg: a.bg, items: Array.isArray(a.items) ? a.items : [], overflow: loneShape(a) }).style.transform = `scale(${dw / a.w})`;
  }
}

/** `content` drawn as static DOM the way its story editor draws it, so the text and the floats anchored to it do not move when the
 * part opens: each textblock takes the line height and spacing the paragraph package decorates it with (drawnStyle, from the main
 * doc's styles and theme), and one that does not end in text gets the <br> ProseMirror gives it, so an empty paragraph or one
 * holding only a picture keeps its line. */
function serialize(view, content, d) {
  const { schema } = view.state;
  const { styles, theme } = view.state.doc.attrs;
  const doc = schema.topNodeType.create({ styles, theme }, storyDoc(schema, content).content);
  const at = new Map();
  doc.descendants((node, pos, parent, index) => {
    if (node.isTextblock) at.set(node, { pos, parent, index });
    return !node.isTextblock;
  });
  const base = DOMSerializer.fromSchema(schema);
  const nodes = { ...base.nodes };
  for (const type of Object.values(schema.nodes).filter((t) => t.isTextblock && base.nodes[t.name])) {
    nodes[type.name] = (node) => {
      const r = DOMSerializer.renderSpec(d, base.nodes[type.name](node), null, node.attrs);
      const w = at.get(node);
      if (w && r.dom.style) r.dom.style.cssText += `;${drawnStyle(doc, node, w.pos, w.parent, w.index)}`;
      if (r.contentDOM && (!node.lastChild?.isText || node.lastChild.text.endsWith('\n'))) r.contentDOM.setAttribute('data-hf-br', '');
      return r;
    };
  }
  const f = new DOMSerializer(nodes, base.marks).serializeFragment(doc.content, { document: d });
  for (const el of f.querySelectorAll('[data-hf-br]')) {
    el.removeAttribute('data-hf-br');
    el.append(d.createElement('br'));
  }
  return f;
}

// The serialised DOM of each part content, cloned per page; drawn again when the styles or theme it was drawn with change.
const frags = new WeakMap();
function fragmentOf(view, content) {
  const { styles, theme } = view.state.doc.attrs;
  let f = frags.get(content);
  if (f?.styles !== styles || f?.theme !== theme) {
    const d = view.dom.ownerDocument;
    f = { styles, theme };
    try {
      f.dom = serialize(view, content, d);
      classTables(f.dom); // the table style's class (stylesheet.js tableStyleClass)
    } catch (e) {
      console.warn('headers-footers: a part does not fit the schema', e);
      f.dom = d.createDocumentFragment();
    }
    frags.set(content, f);
  }
  return f.dom.cloneNode(true);
}

// chapterAt's results per doc, so the layer key and the drawing share one walk per page.
const chapters = new WeakMap();

/** The list label of the last heading of level `level` at or before `pos` (Include chapter number), without its trailing dot. */
function chapterAt(doc, pos, level) {
  let memo = chapters.get(doc);
  if (!memo) chapters.set(doc, (memo = new Map()));
  const k = `${pos}|${level}`;
  if (!memo.has(k)) memo.set(k, findChapter(doc, pos, level));
  return memo.get(k);
}

function findChapter(doc, pos, level) {
  let at = null;
  doc.descendants((node, p) => {
    if (p > pos) return false;
    if (node.type.name === 'heading' ? node.attrs.level === level : node.attrs?.styleId === `Heading${level}`) at = p;
    return !node.isTextblock;
  });
  if (at == null) return null;
  const label = fieldCtx({ doc }).listLabel(at + 1)?.text;
  return label ? label.replace(/[.)\s]+$/, '') : null;
}

/** Each field of `root` with its text for `page`: a registered type's result, else the layout fallback, else the stored one. */
function fillFields(root, { doc, page, geo, kind, sect }) {
  const fields = root.querySelectorAll('[data-field]');
  if (!fields.length) return;
  const sec = geo.sections[page.section];
  let chapter;
  const info = () => ({
    page, pages: geo.pages.length, sectionPages: sec?.pages ?? 1, pgNum: sect.pgNum,
    chapter: sect.pgNum?.chapStyle ? (chapter ??= chapterAt(doc, page.from, Number(sect.pgNum.chapStyle)) ?? '') : null,
  });
  for (const f of fields) {
    const code = f.dataset.code ?? '';
    const own = layoutFieldText(code, info());
    let text = fieldName(code) === 'PAGE' && sect.pgNum?.chapStyle ? own : null;
    if (text == null) {
      const r = computeField(code, fieldCtx({ doc, pos: 0, story: kind, page, geometry: geo }));
      text = r == null ? own : typeof r === 'string' ? r : r.error ?? r.text ?? own;
    }
    if (text != null) f.textContent = text;
  }
}

// Measured part heights per page index (px), for reserve(), with the parts' floats in the flow (placePartFloats) for floats(); a
// change asks engine 2 for a relayout.
// ponytail: keyed by page index across editors; only the open Document's main editor paginates on screen.
const heights = new Map();
// The heights of each header and footer pair at each width as measured on any page, for the pages not drawn yet: engine 2 draws
// the layers of the pages near the view only, and a part's height rarely depends on its page (a PAGE field that wraps would).
const sizes = new Map();
let relayout = 0;

// What a part's height can depend on besides its content and width: its page number fields' digits, or the page itself (STYLEREF
// shows text from the page). Per part content object.
const DIGITS = new Set(['PAGE', 'NUMPAGES', 'SECTIONPAGES', 'SECTION']);
const names = new WeakMap();
/** The names of the fields in part `content` (a Set), per content object. */
function fieldsIn(content) {
  if (!content) return new Set();
  let v = names.get(content);
  if (!v) {
    v = new Set();
    const walk = (n) => {
      if (!n) return;
      if (n.type === 'field' || n.type === 'fieldBlock') v.add(fieldName(n.attrs?.code));
      if (Array.isArray(n.content)) n.content.forEach(walk);
    };
    content.forEach(walk);
    names.set(content, v);
  }
  return v;
}
function depOf(content) {
  const v = fieldsIn(content);
  return v.has('STYLEREF') ? 'page' : [...v].some((n) => DIGITS.has(n)) ? 'digits' : 'none';
}

/** The part of `sizes`' key a part `content` on page `page` adds: the digits of the numbers its fields show, or the page for a
 * page-dependent part. Only the numbers it shows: a part with PAGE alone was measured again for every page count's digits (the
 * first layout has no page count yet). */
function depKey(state, content, page) {
  const d = depOf(content);
  if (d === 'none') return '';
  if (d === 'page') return `@${page.index}`;
  const used = fieldsIn(content);
  const geo = geometryOf(state);
  const digits = (on, v) => (on ? String(v ?? '').length : '');
  return `#${digits(used.has('PAGE'), page.label)}/${digits(used.has('NUMPAGES'), geo?.pages.length ?? 0)}`
    + `/${digits(used.has('SECTIONPAGES'), geo?.sections[page.section]?.pages ?? 0)}/${digits(used.has('SECTION'), page.section + 1)}`;
}

let sizesOf = null; // the drawn sects `sizes` was last pruned for
/** Drops the `sizes` entries of part contents no section holds any more (an edited part is replaced, so its old id is gone). */
function pruneSizes(sects) {
  if (sects === sizesOf) return;
  sizesOf = sects;
  const live = new Set([0]);
  for (const s of sects) for (const edge of ['hdr', 'ftr']) for (const c of Object.values(s?.[edge] ?? {})) if (Array.isArray(c)) live.add(sameOf(c));
  for (const k of sizes.keys()) {
    const [h, f] = k.split('|');
    if (!live.has(Number(h)) || !live.has(Number(f))) sizes.delete(k);
  }
}

// Whether a part content holds a picture, text box or canvas that text wraps round (Square, Tight, Through, Top and Bottom), per
// part content object: parts without one skip the float work below.
const wrapping = new WeakMap();
function wrapsText(content) {
  if (!content) return false;
  if (!wrapping.has(content)) {
    const walk = (n) => !!n && ((WRAPS_BESIDE.has(n.attrs?.layout?.wrap) || n.attrs?.layout?.wrap === 'topBottom') || (n.content ?? []).some(walk));
    wrapping.set(content, content.some(walk));
  }
  return wrapping.get(content);
}

/** The parts page `page` shows, the width they take and what of the page their height depends on, as a key of `sizes`. Parts
 * whose text wraps round a float also key by the box they are placed in and the page's parity: their floats place by the paper
 * and mirror on even pages. */
function sizeKey(state, page, deps = true) {
  const sects = drawnSects(state.doc);
  pruneSizes(sects);
  const part = partOf(page.part);
  const h = resolvePart(sects, page.section, 'hdr', part).content;
  const f = resolvePart(sects, page.section, 'ftr', part).content;
  const { box } = page;
  const key = [sameOf(h), sameOf(f), box.text, deps ? depKey(state, h, page) : '*', deps ? depKey(state, f, page) : '*'];
  if (wrapsText(h) || wrapsText(f)) key.push(box.w, box.h, box.left, box.top, box.bottom, box.header, box.footer, (page.number ?? 1) % 2);
  return key.join('|');
}

/** Draws page `page`'s header and footer into `el` → their measured heights {headerH, footerH} and their floats in the flow
 * {floats: [{x, y, w, h, layout}]} (paper px, placePartFloats) (engine 2 only). */
function drawParts(el, page, view) {
  const { state } = view;
  const geo = geometryOf(state);
  const sects = drawnSects(state.doc);
  const sect = sects[page.section] ?? {};
  const part = partOf(page.part);
  const editing = hfKey.getState(state)?.edit;
  const { box } = page;
  const d = view.dom.ownerDocument;
  const measured = {};
  const floats = [];
  for (const kind of ['header', 'footer']) {
    const edge = EDGE[kind];
    const { content } = resolvePart(sects, page.section, edge, part);
    const div = d.createElement('div');
    div.className = 'hf-part';
    div.dataset.hf = kind;
    div.style.cssText = `position:absolute;left:${box.left}px;width:${box.text}px;`
      + (kind === 'header' ? `top:${box.header}px` : `bottom:${box.footer}px`)
      // The part being edited is drawn by its story editor on this page; it stays here unseen so it still measures.
      + (editing?.page === page.index && editing.kind === kind ? ';visibility:hidden' : '');
    if (content?.length) {
      div.append(fragmentOf(view, content));
      drawCanvases(div);
      if (geo) fillFields(div, { doc: state.doc, page, geo, kind, sect });
    }
    el.append(div);
    // Floating pictures and text boxes go where their layout puts them; the part's text wraps round them and its height stays its
    // text's, so a float moves the body only where it reaches into it (floats(), float-layout's page wraps).
    floats.push(...placePartFloats(div, page).map((f) => ({ ...f, part: kind })));
    layoutTabs(div, { defaultTabStop: state.doc.attrs.settings?.defaultTabStop ?? 36, width: box.text });
    // Only engine 2 reads reserve(); measuring forces a synchronous layout per page.
    if (geo?.engine !== 1) measured[kind === 'header' ? 'headerH' : 'footerH'] = content?.length ? div.offsetHeight : 0;
  }
  if (geo?.engine !== 1) measured.floats = floats;
  return measured;
}

/** Page `page`'s part heights from a drawing off screen, in the first page's sheet, for a page whose parts no page has drawn. The
 * drawing's layout and size are contained, so reading its heights lays out the drawing alone (the page engine asks inside its
 * layout round, where a read laid the whole document out again per page). */
function measureParts(view, page) {
  const host = view?.dom.querySelector(':scope > .pg-start > .pg-page');
  if (!host || view.dom.closest('[data-story]')) return null;
  const el = view.dom.ownerDocument.createElement('div');
  el.style.cssText = `position:absolute;left:${-page.box.left}px;top:0;width:${page.box.w}px;height:${page.box.h}px;visibility:hidden;pointer-events:none;contain:strict`;
  host.append(el);
  try {
    return drawParts(el, page, view);
  } finally {
    el.remove();
  }
}

/** Asks engine 2 to lay the pages out again (a part's height changed): a meta-only transaction on the next frame. */
function askRelayout(view) {
  if (relayout) return;
  relayout = requestAnimationFrame(() => {
    relayout = 0;
    if (view.isDestroyed || !view.dom.isConnected) return;
    view.dispatch(view.state.tr.setMeta(hfKey, { rev: (hfKey.getState(view.state)?.rev ?? 0) + 1 }).setMeta('addToHistory', false));
  });
}

/** A margin area that takes the pointer: double-click opens `kind` of page `page`. A right-click goes on to Word's context menu
 * (context-menu), whose header band offers Edit Header or Edit Footer. A plain click does
 * nothing, as in Word (the body's caret stays). */
function zone(view, kind, page, css) {
  const z = Object.assign(view.dom.ownerDocument.createElement('div'), { className: 'hf-zone' });
  z.dataset.hfZone = kind;
  z.style.cssText = `position:absolute;left:0;width:100%;pointer-events:auto;${css}`;
  z.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  z.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    e.preventDefault();
    openStory(view.dom.editor, { kind, page });
  });
  return z;
}

/** The page layer: z 1, over the text. */
export const headersFootersLayer = {
  id: 'headersFooters',
  z: 1,
  key(state, page) {
    const sects = drawnSects(state.doc);
    const part = partOf(page.part);
    const sect = sects[page.section] ?? {};
    const hf = hfKey.getState(state) ?? {};
    const geo = geometryOf(state);
    const { box } = page;
    const h = resolvePart(sects, page.section, 'hdr', part).content;
    const f = resolvePart(sects, page.section, 'ftr', part).content;
    // The page's number and the page counts only for parts whose fields show them: while a long document lays out the count
    // changes every frame, and every page near the view drew its parts again each time. A field this layer does not work out
    // itself (fillFields asks the field registry) may read any of them.
    const used = new Set([...fieldsIn(h), ...fieldsIn(f)]);
    const any = [...used].some((n) => !DIGITS.has(n));
    return [
      idOf(h), idOf(f), page.section, any || used.has('PAGE') ? page.label : '', any || used.has('NUMPAGES') ? geo?.pages.length : '',
      any || used.has('SECTIONPAGES') ? geo?.sections[page.section]?.pages : '', JSON.stringify(sect.pgNum),
      idOf(state.doc.attrs.styles), idOf(state.doc.attrs.theme), // a part draws with their line heights
      // The page's chapter label, not the doc: a keystroke elsewhere must not redraw every page.
      sect.pgNum?.chapStyle ? chapterAt(state.doc, page.from, Number(sect.pgNum.chapStyle)) : '', hf.edit?.page === page.index ? hf.edit.kind : '', hf.rev,
      box.w, box.h, box.left, box.text, box.top, box.bottom, box.header, box.footer,
    ].join('|');
  },
  render(el, page, view) {
    if (view.dom.closest('[data-story]')) return;
    const { state } = view;
    const geo = geometryOf(state);
    if (!geo) return;
    const { box } = page;
    el.append(zone(view, 'header', page.index, `top:0;height:${Math.max(0, box.top)}px`),
      zone(view, 'footer', page.index, `bottom:0;height:${Math.max(0, box.bottom)}px`));
    const measured = drawParts(el, page, view);
    if (geo.engine !== 2) return;
    // The heights reserve() gave this page: its own last drawing, else the same parts drawn on another page.
    const key = sizeKey(state, page);
    const last = heights.get(page.index) ?? sizes.get(key);
    heights.set(page.index, measured);
    sizes.set(key, measured);
    const base = sizeKey(state, page, false);
    if (!sizes.has(base)) sizes.set(base, measured);
    if (!last || last.headerH !== measured.headerH || last.footerH !== measured.footerH
      || JSON.stringify(last.floats) !== JSON.stringify(measured.floats)) askRelayout(view);
  },
  // `view` (engine 2 passes it): parts no page has drawn yet are measured off screen once.
  reserve(page, state, view) {
    return reserveOf(page.box, measuredOf(page, state, view) ?? {});
  },
  // The header's and footer's floats on `page` that text wraps round, which the body wraps round where they reach into it
  // (float-layout PAGE_WRAP_PASS).
  floats(page, state, view) {
    const sects = drawnSects(state.doc);
    const part = partOf(page.part);
    if (!['hdr', 'ftr'].some((edge) => wrapsText(resolvePart(sects, page.section, edge, part).content))) return [];
    return measuredOf(page, state, view)?.floats ?? [];
  },
};

/** What page `page`'s parts measured: its own last drawing, else the same parts drawn on another page, else a drawing off screen.
 * Parts measured already with other page numbers (or on another page, for STYLEREF) give that height at once and are measured
 * for this page later (measureLater): a number rarely changes a part's height, and the Word fixture's page labels (roman, with
 * dashes, with chapters) came in 62 lengths, each a drawing off screen in the open's first frames (about 12 ms each). */
function measuredOf(page, state, view) {
  let h = heights.get(page.index);
  if (!h && state) {
    const key = sizeKey(state, page);
    h = sizes.get(key);
    if (!h) {
      const base = sizeKey(state, page, false);
      h = sizes.get(base);
      if (h && view) measureLater(key, page, view, h);
      else {
        h = measureParts(view, page);
        if (h) {
          sizes.set(key, h);
          if (!sizes.has(base)) sizes.set(base, h);
        }
      }
    }
  }
  return h;
}

// The measurements measuredOf put off (key → {page, view, guess}), taken a few at a time between frames.
const later = new Map();
let laterTask = 0;
const MEASURE_SLICE = 12; // ms of measuring per task

function measureLater(key, page, view, guess) {
  if (later.has(key)) return;
  later.set(key, { page, view, guess });
  laterTask ||= setTimeout(measureSome, 0);
}

/** Measures put-off parts for up to MEASURE_SLICE ms; one that differs from the height the layout used asks for a relayout. */
function measureSome() {
  laterTask = 0;
  const t0 = performance.now();
  for (const [key, { page, view, guess }] of later) {
    later.delete(key);
    if (view.isDestroyed || !view.dom.isConnected || sizes.has(key)) continue;
    const h = measureParts(view, page);
    if (!h) continue;
    sizes.set(key, h);
    if (h.headerH !== guess.headerH || h.footerH !== guess.footerH || JSON.stringify(h.floats) !== JSON.stringify(guess.floats)) askRelayout(view);
    if (performance.now() - t0 > MEASURE_SLICE) break;
  }
  if (later.size) laterTask = setTimeout(measureSome, 0);
}
