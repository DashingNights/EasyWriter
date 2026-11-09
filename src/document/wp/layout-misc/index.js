// Line numbers, hyphenation and drop caps (docs/plans/word plan.md §3 layout-misc; briefs/layout-misc.md). Line numbers: sect.lnNum
// per section, counted by an 'after' layout pass that reads every body line's boxes and drawn by a page layer keyed per page.
// Hyphenation: an optional hyphen command, Manual with a prompt per word, and Automatic as soft-hyphen widgets a 'before' pass places
// from our own Liang patterns (Chromium breaks nothing with hyphens: auto), never written into the document. Drop caps: the paragraph's
// frame attribute drawn with CSS initial-letter on its ::first-letter. The pure parts are logic.mjs and hyphenate.mjs.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { geometryOf, nodeDOMs, rangeIn, scaleOf } from '../../geometry.js';
import { unitOf } from '../../pages.mjs';
import { pageSetup } from '../../tools.js';
import { indexAt } from '../../geometry.mjs';
import { sectionAt, sectionsOf } from '../../model/sections.mjs';
import { DropCapDialog, HyphenationDialog, LineNumbersDialog, ManualHyphenationDialog } from './dialogs.jsx';
import { hyphenate } from './hyphenate.mjs';
import { textRects } from '../page-engine/cull.js';
import { applyDropCap, dropCapOf, edit, paraOf, setLineNumbers } from './edit.js';
import { capsAllowed, coreOf, LN_DEFAULTS, lnDistancePx, numberLines, planBreaks } from './logic.mjs';

const PX = 96 / 72;
const key = new PluginKey('layoutMisc');

// ---------- commands' helpers ----------

/** Patches doc.attrs.settings (keys a newer build wrote survive). */
const setSettings = (ctx, patch) => edit(ctx, (tr) => {
  const old = tr.doc.attrs.settings ?? {};
  if (Object.entries(patch).every(([k, v]) => old[k] === v)) return;
  tr.setDocAttribute('settings', { ...old, ...patch });
});

const paraToggle = (attr) => ({
  run: (ctx) => ctx.chain((c) => c.setParaProps({ [attr]: paraOf(ctx.state)?.attrs[attr] ? null : true })),
  active: (ctx) => !!paraOf(ctx.state)?.attrs[attr],
  enabled: (ctx) => !!ctx.target && !!paraOf(ctx.state)?.isTextblock,
});

const dropCapEnabled = (ctx) => !!ctx.ed && ctx.target === ctx.ed && !ctx.in.table && !!paraOf(ctx.state)?.isTextblock && paraOf(ctx.state).content.size > 0;

// ---------- measuring ----------

/** The text of paragraph element `el` as the browser draws it: widgets and non-editable atoms left out, a separator where text runs
 * are not adjacent in the document → {s, at: per character [textNode, offset] or null}. */
function textMap(view, el) {
  const d = el.ownerDocument;
  const walker = d.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.ProseMirror-widget, [contenteditable="false"]') && el.contains(n.parentElement.closest('.ProseMirror-widget, [contenteditable="false"]'))
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let s = '';
  const at = [];
  let end = null;
  for (let n; (n = walker.nextNode());) {
    let p;
    try { p = view.posAtDOM(n, 0); } catch { continue; }
    if (end != null && p !== end) {
      s += '￼';
      at.push(null);
    }
    for (let i = 0; i < n.data.length; i++) at.push([n, i]);
    s += n.data;
    end = p + n.data.length;
  }
  return { s, at };
}

const charRect = (d, [n, i]) => {
  const r = rangeIn(d);
  r.setStart(n, i);
  r.setEnd(n, i + 1);
  return r.getBoundingClientRect();
};

let canvas = null;
/** The px width of a hyphen in `el`'s font. */
function hyphenWidth(el) {
  canvas ??= el.ownerDocument.createElement('canvas');
  const g = canvas.getContext('2d');
  const cs = getComputedStyle(el);
  g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return g.measureText('-').width || parseFloat(cs.fontSize) * 0.33;
}

/** Where automatic hyphenation breaks paragraph element `el` (laid out without our hyphens) under `opts` ({zone, limit, caps}, zone
 * in pt) → [{pos (document position of the break), word, k, breaks}] in order. */
function measureBreaks(view, el, opts) {
  const d = el.ownerDocument;
  const { s, at } = textMap(view, el);
  const scale = scaleOf(view);
  const toks = [];
  for (const m of s.matchAll(/[^\s￼]+/g)) {
    const a = m.index;
    const b = a + m[0].length;
    const r0 = charRect(d, at[a]);
    const r1 = charRect(d, at[b - 1]);
    const core = coreOf(m[0]);
    const ks = core && capsAllowed(core.word, opts.caps) ? hyphenate(core.word) : [];
    toks.push({ a, text: m[0], core, ks, L: r0.left, R: r1.right, top: r0.top, wraps: Math.abs(r1.top - r0.top) > r0.height / 2 });
  }
  if (toks.length < 2) return [];
  const cs = getComputedStyle(el);
  const colRight = el.getBoundingClientRect().right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
  const second = toks.find((t) => t.top > toks[0].top + 2);
  if (!second) return []; // one line: nothing to break
  const widths = [colRight - toks[0].L, colRight - second.L];
  const gaps = toks.slice(0, -1).map((t, i) => (Math.abs(toks[i + 1].top - t.top) < 2 ? toks[i + 1].L - t.R : null)).filter((g) => g != null && g >= 0);
  const space = gaps.length ? gaps.sort((x, y) => x - y)[gaps.length >> 1] : parseFloat(cs.fontSize) * scale * 0.28;
  const words = toks.map((t, i) => ({
    w: t.wraps ? widths[1] : t.R - t.L,
    space: i < toks.length - 1 && Math.abs(toks[i + 1].top - t.top) < 2 ? toks[i + 1].L - t.R : space,
    breaks: t.wraps ? [] : t.ks.map((k) => ({ k: t.core.at + k, w: charRect(d, at[t.a + t.core.at + k]).left - t.L })),
  }));
  const plan = planBreaks(words, { widths, hyphen: hyphenWidth(el) * scale, zone: opts.zone * PX * scale, limit: opts.limit });
  return plan.breaks.map(({ word, k }) => {
    const t = toks[word];
    const [n, i] = at[t.a + k];
    return { pos: view.posAtDOM(n, i), word: t.core.word, k: k - t.core.at, breaks: t.ks };
  });
}

/** Runs `fn` with the document laid out as without automatic hyphens: our widgets hidden, justified text set ragged so spaces
 * measure at their natural width. The class goes on view.dom, whose attribute changes ProseMirror ignores. */
function unhyphenated(view, fn) {
  view.dom.classList.add('lm-hy-measure');
  try {
    return fn();
  } finally {
    view.dom.classList.remove('lm-hy-measure');
  }
}

const docOpts = (doc) => {
  const s = doc.attrs.settings ?? {};
  return { zone: s.hyphenationZone ?? 18, limit: s.consecutiveHyphenLimit ?? 0, caps: !s.doNotHyphenateCaps };
};

/** The paragraphs hyphenation looks at: every textblock with letters but those marked Don't hyphenate. */
function eachPara(doc, fn, from = 0) {
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (pos + node.nodeSize > from && !node.attrs.suppressAutoHyphens && /[A-Za-z]{5}/.test(node.textContent)) fn(node, pos);
    return false;
  });
}

// ---------- the plugin: soft-hyphen widgets and drop cap decorations ----------

const shyDom = () => {
  const s = document.createElement('span');
  s.className = 'lm-shy';
  s.textContent = '­';
  return s;
};
const shyAt = (pos) => Decoration.widget(pos, shyDom, { side: -1, marks: [], ignoreSelection: true, key: 'lm-shy' });

/** The drop cap key its measured width is kept under: what the letter's width depends on. */
const dcKey = (node) => `${node.textContent[0]}|${JSON.stringify(node.firstChild?.marks ?? [])}|${node.attrs.styleId ?? ''}|${node.attrs.frame?.lines}`;

let dcMemo = { doc: null, hang: null, set: null };
function dropCapDecos(doc, hang) {
  if (dcMemo.doc === doc && dcMemo.hang === hang) return dcMemo.set;
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const f = node.attrs.frame;
    if ((f?.dropCap === 'drop' || f?.dropCap === 'margin') && node.content.size) {
      const w = f.dropCap === 'margin' ? hang.get(dcKey(node)) : null;
      out.push(Decoration.node(pos, pos + node.nodeSize, {
        class: `lm-dropcap lm-dropcap-${f.dropCap}`,
        style: `--lm-dc-lines:${f.lines ?? 3};--lm-dc-gap:${f.hSpace ?? 0}pt${w != null ? `;--lm-dc-hang:${w}px` : ''}`,
      }));
    }
    return false;
  });
  dcMemo = { doc, hang, set: out.length ? DecorationSet.create(doc, out) : DecorationSet.empty };
  return dcMemo.set;
}

const LayoutMisc = Extension.create({
  name: 'wordLayoutMisc',
  addProseMirrorPlugins: () => [new Plugin({
    key,
    state: {
      init: () => ({ shy: DecorationSet.empty, hang: new Map() }),
      apply(tr, v) {
        const meta = tr.getMeta(key);
        if (meta) return { ...v, ...meta };
        return tr.docChanged ? { ...v, shy: v.shy.map(tr.mapping, tr.doc) } : v;
      },
    },
    props: {
      decorations(state) {
        const v = key.getState(state);
        const dc = dropCapDecos(state.doc, v.hang);
        if (dc === DecorationSet.empty) return v.shy;
        if (v.shy === DecorationSet.empty) return dc;
        return dc.add(state.doc, v.shy.find());
      },
    },
  })],
});

// ---------- layout passes ----------

const hyCache = new WeakMap(); // paragraph node → {width, sig, offs: break offsets from the paragraph's start}

/** 'before' pass: places a soft-hyphen widget at each break automatic hyphenation picks (cached per paragraph by its node, width and
 * the settings), so the browser breaks there and draws the hyphen. */
const hyphenPass = {
  id: 'layout-misc.hyphenation',
  phase: 'before',
  run(view) {
    const st = key.getState(view.state);
    if (!st) return false;
    const { doc } = view.state;
    const want = [];
    if (doc.attrs.settings?.autoHyphenation) {
      const opts = docOpts(doc);
      const sig = JSON.stringify(opts);
      const stale = [];
      eachPara(doc, (node, pos) => {
        const el = view.nodeDOM(pos);
        if (!el?.getBoundingClientRect) return;
        const c = hyCache.get(node);
        if (c && c.width === el.clientWidth && c.sig === sig) want.push(...c.offs.map((o) => pos + o));
        else stale.push({ node, pos, el });
      });
      // ponytail: every stale paragraph is measured with the whole document laid out unhyphenated (one class toggle, two relayouts
      // per frame that has one); per-paragraph measuring in a hidden copy if long documents stall while typing.
      if (stale.length) {
        unhyphenated(view, () => {
          for (const { node, pos, el } of stale) {
            const offs = measureBreaks(view, el, opts).map((b) => b.pos - pos);
            hyCache.set(node, { width: el.clientWidth, sig, offs });
            want.push(...offs.map((o) => pos + o));
          }
        });
      }
    }
    want.sort((a, b) => a - b);
    const now = st.shy.find().map((d) => d.from);
    if (now.join() === want.join()) return false;
    view.dispatch(view.state.tr.setMeta(key, { shy: DecorationSet.create(doc, want.map(shyAt)) }).setMeta('addToHistory', false));
    return true;
  },
};

/** The line boxes of paragraph element `el` (screen px): its text's client rects (textRects: a culled block's as kept) merged per line; rects much taller than the
 * paragraph's text (a drop cap's letter, a tall picture) are left out so they do not merge lines. An empty paragraph is one line. */
function lineBoxes(el, empty) {
  const cs = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  const one = () => [{ top: box.top + parseFloat(cs.paddingTop), bottom: box.bottom - parseFloat(cs.paddingBottom) }];
  if (empty) return one();
  const rects = textRects(el).filter((x) => x.height > 0).sort((a, b) => a.top - b.top);
  if (!rects.length) return one();
  const hs = rects.map((x) => x.height).sort((a, b) => a - b);
  const cap = hs[hs.length >> 1] * 1.8;
  const lines = [];
  for (const x of rects) {
    if (x.height > cap) continue;
    const mid = (x.top + x.bottom) / 2;
    const l = lines.find((y) => mid >= y.top - 1 && mid <= y.bottom + 1);
    if (l) {
      l.top = Math.min(l.top, x.top);
      l.bottom = Math.max(l.bottom, x.bottom);
    } else lines.push({ top: x.top, bottom: x.bottom });
  }
  return lines.length ? lines : one();
}

const lnByDoc = new WeakMap(); // doc → {version, pages: Map(page index → {key, items: [{n, y, h, dist}]})}

/** 'after' pass: measures every counted line and numbers it per section (numberLines); the layer draws the result per page. */
const lineNumberPass = {
  id: 'layout-misc.lineNumbers',
  phase: 'after',
  run(view) {
    if (!key.getState(view.state)) return false;
    const { doc } = view.state;
    const secs = sectionsOf(doc);
    if (!secs.some((s) => s.sect.lnNum)) return false;
    const geo = geometryOf(view.state);
    if (!geo?.pages.length) return false;
    if (lnByDoc.get(doc)?.version === geo.version) return false;
    const scale = scaleOf(view);
    const top = view.dom.getBoundingClientRect().top;
    const bodyTops = geo.pages.map((p) => p.bodyTop);
    const lines = [];
    const doms = nodeDOMs(view); // one walk: view.nodeDOM per paragraph walked the blocks from the start each time
    // ponytail: every line of the document is measured once per relayout while numbering is on; measure only the visible pages
    // (and count the rest by height) if long documents lag.
    doc.descendants((node, pos) => {
      const t = node.type.name;
      if (t === 'table' || t === 'textBox') return false; // Word does not count tables, notes and text boxes
      if (!node.isTextblock) return true;
      const el = doms.get(pos);
      if (!el?.getBoundingClientRect) return false;
      const section = sectionAt(secs, pos).index;
      if (!secs[section].sect.lnNum) return false;
      for (const b of lineBoxes(el, !node.content.size)) {
        const y = (b.top - top) / scale;
        lines.push({ y, h: (b.bottom - b.top) / scale, page: geo.pages[indexAt(bodyTops, y + 0.5)].index, section, suppressed: !!node.attrs.suppressLineNumbers });
      }
      return false;
    });
    const nums = numberLines(lines, secs.map((s) => s.sect.lnNum));
    const pages = new Map();
    lines.forEach((l, i) => {
      if (!nums[i]?.show) return;
      const page = geo.pages[l.page];
      const ln = secs[l.section].sect.lnNum;
      const item = { n: nums[i].n, y: l.y - page.top, h: l.h, dist: lnDistancePx(ln, !!geo.sections?.[l.section]?.cols) };
      if (!pages.has(l.page)) pages.set(l.page, { key: '', items: [] });
      pages.get(l.page).items.push(item);
    });
    for (const p of pages.values()) p.key = p.items.map((i) => `${i.n}@${i.y.toFixed(1)}/${i.h.toFixed(1)}/${i.dist.toFixed(1)}`).join();
    lnByDoc.set(doc, { version: geo.version, pages });
    return false; // numbers sit in the margin: no text moves
  },
};

/** 'after' pass: measures the letter of each In margin drop cap, so its paragraph hangs it fully left of the text column. */
const dropCapPass = {
  id: 'layout-misc.dropCaps',
  phase: 'after',
  run(view) {
    const st = key.getState(view.state);
    if (!st) return false;
    const scale = scaleOf(view);
    let hang = null;
    view.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      if (node.attrs.frame?.dropCap !== 'margin' || !node.content.size || !node.firstChild?.isText) return false;
      const k = dcKey(node);
      let w = null;
      try {
        const a = view.domAtPos(pos + 1);
        const b = view.domAtPos(pos + 2);
        const r = rangeIn(view.dom.ownerDocument);
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
        w = r.getBoundingClientRect().width / scale;
      } catch { /* not drawn yet */ }
      if (w && !(Math.abs((st.hang.get(k) ?? -99) - w) < 0.5)) (hang ??= new Map(st.hang)).set(k, Math.round(w * 10) / 10);
      return false;
    });
    if (!hang) return false;
    view.dispatch(view.state.tr.setMeta(key, { hang }).setMeta('addToHistory', false));
    return true;
  },
};

// ---------- the page layer ----------

const lineNumberLayer = {
  id: 'layout-misc.lineNumbers',
  z: 1,
  key: (state, page) => lnByDoc.get(state.doc)?.pages.get(page.index)?.key ?? '',
  render(el, page, view) {
    const data = lnByDoc.get(view.state.doc)?.pages.get(page.index);
    if (!data) return;
    for (const it of data.items) {
      const d = el.ownerDocument.createElement('div');
      d.className = 'lm-ln';
      d.dataset.cstyle = 'LineNumber';
      d.textContent = String(it.n);
      d.style.cssText = `top:${it.y}px;height:${it.h}px;line-height:${it.h}px;right:${page.box.w - page.box.left + it.dist}px`;
      el.append(d);
    }
  },
};

// ---------- Manual hyphenation ----------

/** Layout > Hyphenation > Manual: from the selection on, each word automatic hyphenation would break at a line end is offered with
 * its proposed break; Yes writes an optional hyphen (U+00AD) at the chosen point, No skips it, Cancel stops. */
async function manualHyphenation(ctx) {
  const ed = ctx.ed;
  if (!ed) return false;
  const view = ed.view;
  const opts = docOpts(ed.state.doc);
  const found = [];
  unhyphenated(view, () => eachPara(ed.state.doc, (node, pos) => {
    const el = view.nodeDOM(pos);
    if (el?.getBoundingClientRect) found.push(...measureBreaks(view, el, opts).filter((b) => b.pos >= ed.state.selection.from));
  }, ed.state.selection.from));
  // ponytail: the words are found from the layout before any answer; Word lays out again after each Yes. Re-measure per word if
  // later prompts land on words that no longer reach a line end.
  let doc = ed.state.doc;
  let shift = []; // positions where an optional hyphen went in, to map later words past them
  for (const f of found) {
    const at = f.pos - f.k; // the word's first letter
    const moved = at + shift.filter((p) => p <= at).length;
    const k = await ctx.dialog('manualHyphenation', { word: f.word, breaks: f.breaks, at: f.k });
    if (k == null) break;
    if (k === false || ed.state.doc !== doc) {
      if (ed.state.doc !== doc) break; // the text changed under the prompt
      continue;
    }
    ed.chain().focus().command(({ tr }) => (tr.insertText('­', moved + k), true)).run();
    doc = ed.state.doc;
    shift.push(at + k);
  }
  ctx.toast('Hyphenation is complete.');
  return true;
}

// ---------- commands ----------

const onEd = (ctx) => !!ctx.ed;
const lnRestart = (restart) => ({
  run: (ctx) => setLineNumbers(ctx, (old) => ({ ...LN_DEFAULTS, ...(old ?? {}), restart })),
  active: (ctx) => ctx.sect?.lnNum?.restart === restart,
  enabled: onEd,
});
const LN_ITEMS = { none: null, continuous: 'continuous', restartEachPage: 'newPage', restartEachSection: 'newSection' };
const auto = (ctx) => !!ctx.ed?.state.doc.attrs.settings?.autoHyphenation;

const commands = {
  'layout.pageSetup.lineNumbers': {
    run: (ctx, arg) => (arg ? ctx.run(`layout.pageSetup.lineNumbers.${arg}`) : false),
    value: (ctx) => Object.entries(LN_ITEMS).find(([, r]) => (ctx.sect?.lnNum?.restart ?? null) === r)?.[0] ?? null,
    enabled: onEd,
  },
  'layout.pageSetup.lineNumbers.none': { run: (ctx) => setLineNumbers(ctx, () => null), active: (ctx) => !ctx.sect?.lnNum, enabled: onEd },
  'layout.pageSetup.lineNumbers.continuous': lnRestart('continuous'),
  'layout.pageSetup.lineNumbers.restartEachPage': lnRestart('newPage'),
  'layout.pageSetup.lineNumbers.restartEachSection': lnRestart('newSection'),
  'layout.pageSetup.lineNumbers.suppressForCurrentParagraph': paraToggle('suppressLineNumbers'),
  // Word opens Page Setup on its Layout tab, whose Line Numbers... button (sections) opens our lineNumbers dialog.
  'layout.pageSetup.lineNumbers.lineNumberingOptions': {
    run: (ctx) => {
      if (!ctx.ed) return false;
      // Both Page Setup dialogs: sections' takes tab and applies itself; the older one takes sect, unit and focus and resolves its value.
      const sect = ctx.ed.state.doc.attrs.sect;
      ctx.dialog('pageSetup', { tab: 'layout', sect, unit: unitOf(ctx.settings?.paper), focus: 'margins' }).then((v) => v && pageSetup(v));
      return true;
    },
    enabled: onEd,
  },
  'paragraph.suppressLineNumbers': paraToggle('suppressLineNumbers'),

  'layout.pageSetup.hyphenation': {
    run: (ctx, arg) => (arg ? ctx.run(`layout.pageSetup.hyphenation.${arg}`) : false),
    value: (ctx) => (auto(ctx) ? 'automatic' : 'none'),
    enabled: onEd,
  },
  'layout.pageSetup.hyphenation.none': { run: (ctx) => setSettings(ctx, { autoHyphenation: false }), active: (ctx) => !auto(ctx), enabled: onEd },
  'layout.pageSetup.hyphenation.automatic': { run: (ctx) => setSettings(ctx, { autoHyphenation: true }), active: auto, enabled: onEd },
  'layout.pageSetup.hyphenation.manual': { run: (ctx) => (ctx.ed ? (manualHyphenation(ctx), true) : false), enabled: onEd },
  'layout.pageSetup.hyphenation.hyphenationOptions': { run: (ctx) => (ctx.ed ? (ctx.dialog('hyphenation'), true) : false), enabled: onEd },
  'paragraph.dontHyphenate': paraToggle('suppressAutoHyphens'),
  'chars.optionalHyphen': {
    run: (ctx) => ctx.chain((c) => c.command(({ tr }) => (tr.insertText('­'), true))),
    enabled: (ctx) => !!ctx.target,
  },

  'insert.text.dropCap': {
    run: (ctx, arg) => (arg ? ctx.run(`insert.text.dropCap.${arg}`) : false),
    value: (ctx) => ({ none: 'none', drop: 'dropped', margin: 'inMargin' })[dropCapOf(ctx.state).position] ?? 'none',
    enabled: dropCapEnabled,
  },
  ...Object.fromEntries(['none', 'dropped', 'inMargin'].map((id) => [`insert.text.dropCap.${id}`, {
    run: (ctx) => applyDropCap(ctx.ed, { ...dropCapOf(ctx.state), position: { none: 'none', dropped: 'drop', inMargin: 'margin' }[id], font: '' }),
    active: (ctx) => dropCapOf(ctx.state).position === ({ none: 'none', dropped: 'drop', inMargin: 'margin' }[id]),
    enabled: dropCapEnabled,
  }])),
  'insert.text.dropCap.dropCapOptions': { run: (ctx) => (ctx.ed ? (ctx.dialog('dropCap'), true) : false), enabled: dropCapEnabled },
};

export default {
  id: 'layout-misc',
  extensions: [LayoutMisc],
  commands,
  dialogs: { lineNumbers: LineNumbersDialog, hyphenation: HyphenationDialog, manualHyphenation: ManualHyphenationDialog, dropCap: DropCapDialog },
  layers: [lineNumberLayer],
  passes: [hyphenPass, lineNumberPass, dropCapPass],
};
