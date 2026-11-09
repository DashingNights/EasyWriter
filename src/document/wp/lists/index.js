// The lists package (docs/plans/word plan.md §3 lists, briefs/lists.md): the Bullets, Numbering and Multilevel List galleries with
// their menus, Change List Level, the five list dialogs and Adjust List Indents, Restart at 1 and Continue Numbering, List Bullet
// (Ctrl+Shift+L), the LISTNUM field (Ctrl+Alt+L) and the list paste choices. The model, keys, AutoFormat triggers and labels are
// src/document/lists.js and numbering.mjs, which the Document kit loads for every Document editor.
import { createElement as h } from 'react';
import { getState } from '../../../app/store.js';
import { insertField } from '../../fields/engine.js';
import { ensureStyles, styleIdOf } from '../../model/styles.mjs';
import { bindListSettings, listItems, numberingOf, pastedListOf, setNum, textblocks } from '../../lists.js';
import {
  ABSTRACTS, addNum, adjustIndents, BULLETS, continueAt, kindOf, labelText, levelOf, listNumText, MULTILEVEL,
  NUMBERINGS, numOf, previousList, restartAt, settle, valueAt,
} from '../../numbering.mjs';
import { wordSettings } from '../../word/settings.mjs';
import {
  AdjustListIndents, DefineNewBullet, DefineNewListStyle, DefineNewMultilevelList, DefineNewNumberFormat, LevelPreview, ListPreview,
  SetForAllLevels, SetNumberingValue,
} from './dialogs.jsx';

bindListSettings(() => wordSettings(getState().settings));

// ---------- what the caret is in ----------
/** The caret paragraph's list: {n, lvl, levels, items, index, numbering} or null outside a list. */
function caretList(ctx) {
  const st = ctx.state;
  if (!st) return null;
  const { $from } = st.selection;
  const n = numOf(st.doc, $from.parent);
  if (!n) return null;
  const numbering = numberingOf(st.doc);
  const levels = numbering.abstract[numbering.nums[n.numId]?.abstract]?.levels;
  if (!levels) return null;
  // items and index walk the whole document, so only the commands that use them pay for it (enabled and reason run on every
  // ribbon refresh).
  let items = null;
  const at = $from.depth ? $from.before() : 0;
  return { n, lvl: levels[n.ilvl], levels, numbering,
    get items() { return (items ??= listItems(st.doc)); },
    get index() { return this.items.findIndex((it) => it.pos === at); } };
}
const kindNow = (ctx) => {
  const c = caretList(ctx);
  return c ? kindOf(c.numbering, c.n.numId) : null;
};
/** Whether every selected paragraph is in a list of `kind`. */
const allOf = (ctx, kind) => {
  const st = ctx.state;
  const paras = st ? textblocks(st) : [];
  return paras.length > 0 && paras.every(({ node }) => {
    const n = numOf(st.doc, node);
    return n && kindOf(numberingOf(st.doc), n.numId) === kind;
  });
};
/** Level `lvl` as a one-level pick: its own %N token becomes %1 and the other tokens go. */
const asPick = (lvl, ilvl) => ({ ...lvl, text: (lvl.text ?? '').replaceAll(`%${ilvl + 1}`, '\u0000').replace(/%[1-9]/g, '').replaceAll('\u0000', '%1') });
const IN_LIST = 'Put the cursor in a list first.';
const IN_NUMBERED = 'Put the cursor in a numbered list first.';

// ---------- Bullets and Numbering ----------
const bulletPick = (b) => ({ fmt: 'bullet', text: b.char, glyph: b.char });
const numberPick = (n) => ({ fmt: n.fmt, text: n.text, ...(n.jc && { jc: n.jc }) });
const sameText = (a, b) => a && b && a.fmt === b.fmt && a.text === b.text && (a.jc ?? 'left') === (b.jc ?? 'left') && (a.pic ?? null) === (b.pic ?? null);
// The main parts toggle the last bullet and number format used ('•' and '1.' first), as Word's do; Recently Used shows the picks.
const last = { bullet: bulletPick(BULLETS[0]), number: numberPick(NUMBERINGS[0]) };
const recent = { bullet: [], number: [] };
const remember = (kind, pick) => {
  last[kind] = pick;
  recent[kind] = [pick, ...recent[kind].filter((p) => !sameText(p, pick))].slice(0, 6);
};

/** The one-level looks of `kind` the document's lists use (Document Bullets, Document Number Formats). */
function documentLooks(ctx, kind) {
  const st = ctx.state;
  if (!st) return [];
  const numbering = numberingOf(st.doc);
  const out = [];
  for (const { n } of listItems(st.doc)) {
    const lvl = levelOf(numbering, n.numId, n.ilvl);
    if (!lvl || (lvl.fmt === 'bullet') !== (kind === 'bullet')) continue;
    const p = asPick(lvl, n.ilvl);
    if (!out.some((o) => sameText(o, p))) out.push(p);
  }
  return out;
}

const libraryPick = (kind, id) => {
  if (kind === 'bullet') {
    const b = BULLETS.find((x) => x.id === id);
    return b && bulletPick(b);
  }
  const n = NUMBERINGS.find((x) => x.id === ({ upperRoman: 'upperRomanRight', lowerRoman: 'lowerRomanRight' }[id] ?? id));
  return n && numberPick(n);
};
/** The pick a gallery item id names: a library id, recent:i or doc:i. */
function pickOf(ctx, kind, id) {
  const [src, i] = String(id).split(':');
  if (src === 'recent') return recent[kind][+i] ?? null;
  if (src === 'doc') return documentLooks(ctx, kind)[+i] ?? null;
  return libraryPick(kind, id);
}

/** The current one-level look of the caret's list level when it is of `kind`. */
const currentPick = (ctx, kind) => {
  const c = caretList(ctx);
  return c && (c.lvl.fmt === 'bullet') === (kind === 'bullet') ? asPick(c.lvl, c.n.ilvl) : null;
};

/** The Bullets or Numbering split button's command. */
const listCommand = (kind) => ({
  run: (ctx, arg) => {
    const base = kind === 'bullet' ? 'bullet' : 'decimal';
    const toggle = kind === 'bullet' ? 'toggleBulletList' : 'toggleOrderedList';
    if (arg === undefined) return allOf(ctx, kind) ? ctx.chain((c) => c[toggle]()) : ctx.chain((c) => c.applyListLevel(last[kind], base));
    if (arg === 'none') return allOf(ctx, kind) ? ctx.chain((c) => c[toggle]()) : false;
    const pick = pickOf(ctx, kind, arg);
    if (!pick) return false;
    remember(kind, pick);
    return ctx.chain((c) => c.applyListLevel(pick, base));
  },
  active: (ctx) => allOf(ctx, kind),
  value: (ctx) => {
    const p = currentPick(ctx, kind);
    if (!p) return 'none';
    const lib = kind === 'bullet' ? BULLETS.find((b) => sameText(bulletPick(b), p)) : NUMBERINGS.find((x) => sameText(numberPick(x), p));
    return lib?.id ?? null;
  },
  repeatable: true,
});

const glyphTile = (p) => h('span', { className: 'grid size-9 place-items-center rounded-sm border border-neutral-300 bg-white text-lg text-black' },
  p.pic ? h('img', { src: p.pic, alt: '', className: 'size-4' }) : p.text || ' ');

/** The Bullets gallery: Recently Used Bullets, Bullet Library (None first) and Document Bullets. */
function bulletGallery(ctx) {
  const cur = currentPick(ctx, 'bullet');
  const item = (id, p, group, label) => ({ id, label, group, preview: glyphTile(p), active: !!cur && sameText(cur, p) });
  return [
    ...recent.bullet.map((p, i) => item(`recent:${i}`, p, 'Recently Used Bullets', `Bulleted, ${p.text}`)),
    { id: 'none', label: 'None', group: 'Bullet Library', preview: h('span', { className: 'grid size-9 place-items-center rounded-sm border text-xs' }, 'None'), active: !cur },
    ...BULLETS.map((b) => item(b.id, bulletPick(b), 'Bullet Library', `Bulleted, ${b.label}`)),
    ...documentLooks(ctx, 'bullet').map((p, i) => item(`doc:${i}`, p, 'Document Bullets', `Bulleted, ${p.text}`)),
  ];
}

/** The Numbering gallery: Recently Used Number Formats, Numbering Library (None first) and Document Number Formats. */
function numberGallery(ctx) {
  const cur = currentPick(ctx, 'number');
  const item = (id, p, group) => ({ id, label: labelText(p, [p], [1]), group, preview: h(LevelPreview, { lvl: p }), active: !!cur && sameText(cur, p) });
  return [
    ...recent.number.map((p, i) => item(`recent:${i}`, p, 'Recently Used Number Formats')),
    { id: 'none', label: 'None', group: 'Numbering Library', preview: h('span', { className: 'grid h-16 w-20 place-items-center rounded-sm border text-xs' }, 'None'), active: !cur },
    ...NUMBERINGS.map((n) => item(n.id, numberPick(n), 'Numbering Library')),
    ...documentLooks(ctx, 'number').map((p, i) => item(`doc:${i}`, p, 'Document Number Formats')),
  ];
}

// ---------- Multilevel List ----------
let mlFilter = 'all'; // Gallery Filters: 'all', 'current' or 'library'

/** Applies multilevel definition `levels` to the selection (Word's gallery pick and Define New Multilevel List): with the caret in a
 * list, the whole list (or, `applyTo` 'forward', the list from the caret on) takes it; other selected paragraphs join that list,
 * except paragraphs of a style a level links to (pStyle), which the style numbers. Linked styles get para.numbering. */
function applyMultilevel(ctx, levels, { applyTo = 'whole', name = null } = {}) {
  return ctx.chain((c) => c.command(({ tr, state }) => {
    const doc = state.doc;
    let numbering = numberingOf(doc);
    const s = settle(numbering, structuredClone(levels), name ? { name } : {});
    numbering = s.numbering;
    const caret = numOf(doc, state.selection.$from.parent);
    let numId;
    const items = listItems(doc);
    if (caret && applyTo === 'whole') {
      numId = caret.numId;
      numbering = { ...numbering, nums: { ...numbering.nums, [numId]: { ...numbering.nums[numId], abstract: s.abstract } } };
    } else {
      const add = addNum(numbering, s.abstract);
      numbering = add.numbering;
      numId = add.numId;
      if (caret && applyTo === 'forward') {
        const at = state.selection.$from.before();
        const i = items.findIndex((it) => it.pos === at);
        for (const it of items.slice(i)) if (it.n.numId === caret.numId) tr.setNodeAttribute(it.pos, 'numbering', { numId, ilvl: it.n.ilvl });
      }
    }
    tr.setDocAttribute('numbering', numbering);
    const linked = new Map(levels.map((l, i) => [l.pStyle, i]).filter(([p]) => p));
    if (linked.size) {
      const styles = doc.attrs.styles ?? {};
      const list = { ...styles.list };
      for (const [id, ilvl] of linked) if (list[id]) list[id] = { ...list[id], para: { ...list[id].para, numbering: { numId, ilvl } } };
      tr.setDocAttribute('styles', { ...styles, list });
    }
    for (const { node, pos } of textblocks(state)) {
      if (linked.has(styleIdOf(node))) {
        if (node.attrs.numbering) tr.setNodeAttribute(pos, 'numbering', null);
        continue;
      }
      const n = numOf(doc, node);
      if (n?.numId !== numId) setNum(tr, pos, tr.doc.nodeAt(pos), { numId, ilvl: n?.ilvl ?? 0 });
    }
    return true;
  }));
}

/** Removes the selected paragraphs from their lists: their own numbering goes, and over a numbered style Word's numId 0 stops it. */
const removeLists = (ctx) => ctx.chain((c) => c.command(({ tr, state }) => {
  for (const { node, pos } of textblocks(state)) {
    if (node.attrs.numbering) setNum(tr, pos, node, null);
    else if (numOf(state.doc, node)) tr.setNodeAttribute(pos, 'numbering', { numId: 0, ilvl: 0 });
  }
  return true;
}));

const numberingStyles = (ctx) => Object.entries(ctx.state?.doc.attrs.styles?.list ?? {}).filter(([, s]) => s.type === 'numbering' && s.para?.numbering?.numId);

/** The Multilevel List gallery: Current List, List Library (None first), Lists in Current Documents and List Styles, as the
 * Gallery Filters allow. */
function multilevelGallery(ctx) {
  const c = caretList(ctx);
  const st = ctx.state;
  const numbering = st ? numberingOf(st.doc) : null;
  const tile = (levels) => h(ListPreview, { levels });
  const out = [];
  if (c && mlFilter !== 'library') out.push({ id: 'current', label: 'Current List', group: 'Current List', preview: tile(c.levels), active: true });
  if (mlFilter === 'current') return out;
  out.push({ id: 'none', label: 'None', group: 'List Library', preview: h('span', { className: 'grid h-16 w-28 place-items-center rounded-sm border text-xs' }, 'None'), active: !c });
  for (const m of MULTILEVEL) out.push({ id: `lib:${m.id}`, label: m.label, group: 'List Library', preview: tile(m.levels) });
  if (mlFilter === 'library' || !numbering) return out;
  const used = [...new Set(listItems(st.doc).map((it) => numbering.nums[it.n.numId]?.abstract).filter(Boolean))];
  for (const a of used) if (a !== numbering.nums[c?.n.numId]?.abstract) out.push({ id: `doc:${a}`, label: a, group: 'Lists in Current Documents', preview: tile(numbering.abstract[a].levels) });
  for (const [id, s] of numberingStyles(ctx)) {
    const levels = numbering.abstract[numbering.nums[s.para.numbering.numId]?.abstract]?.levels;
    if (levels) out.push({ id: `style:${id}`, label: s.name ?? id, group: 'List Styles', preview: tile(levels) });
  }
  return out;
}

const multilevelCommand = {
  run: (ctx, arg) => {
    const st = ctx.state;
    if (!st || arg === undefined || arg === 'current') return !!st;
    if (arg === 'none') return removeLists(ctx);
    const [src, id] = String(arg).split(/:(.*)/);
    if (src === 'lib') {
      const m = MULTILEVEL.find((x) => x.id === id);
      return !!m && applyMultilevel(ctx, m.levels);
    }
    const numbering = numberingOf(st.doc);
    if (src === 'doc') return !!numbering.abstract[id] && applyMultilevel(ctx, numbering.abstract[id].levels);
    if (src === 'style') {
      const n = st.doc.attrs.styles?.list?.[id]?.para?.numbering;
      if (!n?.numId) return false;
      return ctx.chain((c) => c.command(({ tr, state }) => {
        for (const { node, pos } of textblocks(state)) setNum(tr, pos, node, { numId: n.numId, ilvl: numOf(state.doc, node)?.ilvl ?? 0 });
        return true;
      }));
    }
    return false;
  },
};

// ---------- Change List Level ----------
/** Change List Level's nine levels of the caret's list: each one's label and a text line at its indent, in a column of their own,
 * then its name. */
function levelGallery(ctx) {
  const c = caretList(ctx);
  if (!c) return [];
  return c.levels.map((l, i) => ({ id: String(i), label: `Level ${i + 1}`, active: i === c.n.ilvl,
    preview: h('span', { className: 'flex w-full items-center gap-3' },
      h('span', { className: 'flex w-28 shrink-0 items-center overflow-hidden', style: { paddingLeft: `${i * 0.4}rem` } },
        h('span', { className: 'shrink-0 whitespace-pre' }, labelText(l, c.levels, Array(i + 1).fill(1))),
        h('span', { className: 'ml-1 h-1 min-w-3 flex-1 rounded-full bg-muted-foreground/40' })),
      h('span', { className: 'text-muted-foreground' }, `Level ${i + 1}`)) }));
}
const changeLevel = {
  run: (ctx, arg) => {
    const ilvl = Number(arg);
    if (!Number.isInteger(ilvl) || ilvl < 0 || ilvl > 8) return false;
    return ctx.chain((c) => c.command(({ tr, state }) => {
      for (const { node, pos } of textblocks(state)) {
        const n = numOf(state.doc, node);
        if (n && n.ilvl !== ilvl) tr.setNodeAttribute(pos, 'numbering', { numId: n.numId, ilvl });
      }
      return true;
    }));
  },
  enabled: (ctx) => !!caretList(ctx),
  reason: (ctx) => (caretList(ctx) ? null : IN_LIST),
  value: (ctx) => {
    const c = caretList(ctx);
    return c ? String(c.n.ilvl) : null;
  },
};

// ---------- canvas drafts ----------
// The library galleries read no editor, so a canvas draft shows them too (the canvas rows in src/document/canvas/rows/home.mjs
// apply a pick through list.define); the recently used and document looks are the DOM editor's, so they stay out there.
const onCanvas = (provider) => Object.assign((ctx) => {
  const items = provider(ctx);
  return ctx.engine ? items.filter((it) => !/^(recent|doc|style):/.test(it.id)) : items;
}, { engine: true });

/** Change List Level's nine levels of the caret's list on a canvas draft (list.get): each one's label as its first item shows it. */
function canvasLevels(ctx) {
  const list = ctx.read('list.get', {});
  const at = ctx.engineState?.['document.context']?.value?.list?.level;
  if (!list?.levels || at == null) return [];
  return list.levels.map((l, i) => ({
    id: String(i), label: `Level ${i + 1}`, active: i === at,
    preview: h('span', { className: 'flex w-full items-center gap-3' },
      h('span', { className: 'w-28 shrink-0 truncate', style: { paddingLeft: `${i * 0.4}rem` } }, l.format === 'bullet' ? l.text : (l.text ?? '').replace(/%\d/g, '1')),
      h('span', { className: 'text-muted-foreground' }, `Level ${i + 1}`)),
  }));
}

// ---------- dialogs ----------
const listOpAt = (ctx, f) => ctx.chain((c) => c.listOp(({ numbering, all, sel }) => (sel.length ? f(numbering, all, sel[0]) : null)));

const commands = {
  'home.paragraph.bullets': listCommand('bullet'),
  'home.paragraph.numbering': listCommand('number'),
  'home.paragraph.multilevelList': multilevelCommand,
  'home.paragraph.bullets.changeListLevel': changeLevel,
  'home.paragraph.numbering.changeListLevel': changeLevel,
  'home.paragraph.multilevelList.changeListLevel': changeLevel,
  'home.paragraph.multilevelList.all': {
    run: (_ctx, arg) => {
      if (!['all', 'current', 'library'].includes(arg)) return false;
      mlFilter = arg;
      return true;
    },
    value: () => mlFilter,
  },
  'home.paragraph.bullets.defineNewBullet': {
    run: async (ctx) => {
      const r = await ctx.dialog('defineNewBullet', { level: currentPick(ctx, 'bullet') ?? last.bullet });
      if (!r) return false;
      remember('bullet', r);
      return ctx.chain((c) => c.applyListLevel(r, 'bullet'));
    },
  },
  'home.paragraph.numbering.defineNewNumberFormat': {
    run: async (ctx) => {
      const r = await ctx.dialog('defineNewNumberFormat', { level: currentPick(ctx, 'number') ?? last.number });
      if (!r) return false;
      remember('number', r);
      return ctx.chain((c) => c.applyListLevel(r, 'decimal'));
    },
  },
  'home.paragraph.numbering.setNumberingValue': {
    run: async (ctx) => {
      const c = caretList(ctx);
      if (!c || c.index < 0) return false;
      const all = c.items.map((it) => it.n);
      const value = valueAt(c.numbering, all, c.index);
      const label = (v) => labelText(c.lvl, c.levels, [...listLabelsCounts(c, all), v]);
      const r = await ctx.dialog('setNumberingValue', { value, canContinue: previousList(c.numbering, all, c.index) >= 0, label });
      if (!r) return false;
      return r.mode === 'continue' ? listOpAt(ctx, (numbering, a, i) => continueAt(numbering, a, i, r.advance ? r.value : null))
        : listOpAt(ctx, (numbering, a, i) => restartAt(numbering, a, i, r.value));
    },
    enabled: (ctx) => kindNow(ctx) === 'number',
    reason: (ctx) => (kindNow(ctx) === 'number' ? null : IN_NUMBERED),
  },
  'home.paragraph.multilevelList.defineNewMultilevelList': {
    run: async (ctx) => {
      const c = caretList(ctx);
      const r = await ctx.dialog('defineNewMultilevelList', { levels: c?.levels ?? MULTILEVEL[0].levels, inList: !!c });
      if (!r) return false;
      return applyMultilevel(ctx, r.levels, { applyTo: r.applyTo, name: r.name });
    },
  },
  'home.paragraph.multilevelList.defineNewListStyle': {
    run: async (ctx) => {
      const r = await ctx.dialog('defineNewListStyle', { levels: caretList(ctx)?.levels ?? ABSTRACTS['ml.paren'].levels });
      if (!r) return false;
      // ponytail: "New documents based on this template" keeps the style in this document only; settings.word.newDocument.styles
      // could carry it once a list style there can bring its numbering along.
      return ctx.chain((ch) => ch.command(({ tr, state }) => {
        const s = settle(numberingOf(state.doc), structuredClone(r.levels));
        const add = addNum(s.numbering, s.abstract);
        tr.setDocAttribute('numbering', add.numbering);
        const styles = state.doc.attrs.styles ?? {};
        const base = r.name.replace(/[^\p{L}\p{N}]+/gu, '') || 'ListStyle';
        let id = base;
        for (let i = 2; styles.list?.[id]; i++) id = `${base}${i}`;
        tr.setDocAttribute('styles', { ...styles, list: { ...styles.list, [id]: { type: 'numbering', name: r.name, para: { numbering: { numId: add.numId, ilvl: 0 } } } } });
        for (const { node, pos } of textblocks(state)) setNum(tr, pos, tr.doc.nodeAt(pos), { numId: add.numId, ilvl: numOf(state.doc, node)?.ilvl ?? 0 });
        return true;
      }));
    },
  },
  'lists.restart': {
    run: (ctx) => listOpAt(ctx, (numbering, all, i) => restartAt(numbering, all, i, levelOf(numbering, all[i].numId, all[i].ilvl)?.start ?? 1)),
    enabled: (ctx) => kindNow(ctx) === 'number',
    reason: (ctx) => (kindNow(ctx) === 'number' ? null : IN_NUMBERED),
  },
  'lists.continue': {
    run: (ctx) => listOpAt(ctx, (numbering, all, i) => continueAt(numbering, all, i)),
    enabled: (ctx) => {
      const c = caretList(ctx);
      return !!c && c.index >= 0 && previousList(c.numbering, c.items.map((it) => it.n), c.index) >= 0;
    },
    reason: () => 'No list above this one to continue.',
  },
  'lists.adjustIndents': {
    run: async (ctx) => {
      const c = caretList(ctx);
      if (!c) return false;
      const { n, lvl } = c;
      const r = await ctx.dialog('adjustListIndents', { pos: lvl.left - lvl.hanging, text: lvl.left, suff: lvl.suff ?? 'tab', tab: lvl.tab ?? null });
      if (!r) return false;
      return ctx.chain((ch) => ch.listOp(({ numbering }) => ({ numbering: adjustIndents(numbering, n.numId, n.ilvl, r), set: new Map() })));
    },
    enabled: (ctx) => !!caretList(ctx),
    reason: (ctx) => (caretList(ctx) ? null : IN_LIST),
  },
  // Ctrl+Shift+L: the List Bullet style (a bullet list at 18 pt with the text at 36 pt, Word's), brought in on first use.
  'styles.listBulletKey': {
    run: (ctx) => ctx.chain((c) => c.command(({ tr, state }) => {
      const doc = state.doc;
      if (!doc.attrs.styles?.list?.ListBullet) {
        const s = settle(numberingOf(doc), ABSTRACTS.bullet.levels.map((l, i) => (i ? l : { ...l, left: 18, hanging: 18 })));
        const add = addNum(s.numbering, s.abstract);
        tr.setDocAttribute('numbering', add.numbering);
        tr.setDocAttribute('styles', ensureStyles(doc, { ListBullet: { type: 'paragraph', name: 'List Bullet', basedOn: 'Normal',
          para: { numbering: { numId: add.numId, ilvl: 0 }, indent: { left: 18, firstLine: -18 }, contextual: true } } }));
      }
      for (const { node, pos } of textblocks(state)) {
        if (node.type.name !== 'paragraph') continue;
        tr.setNodeAttribute(pos, 'styleId', 'ListBullet');
        if (node.attrs.numbering) tr.setNodeAttribute(pos, 'numbering', null);
      }
      return true;
    })),
    repeatable: true,
  },
  // Ctrl+Alt+L: a LISTNUM field at the caret.
  'fieldsUi.listNumField': { run: (ctx) => !!ctx.target && insertField(ctx.target, 'LISTNUM'), repeatable: true },
  // Paste Options' list choices after a paste of list items (the clipboard package appends this gallery to its menu).
  'paste.listChoices': {
    run: (ctx, arg) => {
      const pos = ctx.state && pastedListOf(ctx.state);
      if (pos == null || !['continue', 'new'].includes(arg)) return false;
      return ctx.chain((c) => c.listOp(({ numbering, all, items }) => {
        const i = items.findIndex((it) => it.pos === pos);
        if (i < 0) return null;
        if (arg === 'new') return restartAt(numbering, all, i, 1);
        let k = previousList(numbering, all, i);
        if (k < 0) for (k = i - 1; k >= 0 && all[k].numId === all[i].numId; k--);
        if (k < 0) return null;
        return { numbering, set: new Map(all.map((n, j) => (j >= i && n.numId === all[i].numId ? [j, { numId: all[k].numId, ilvl: n.ilvl }] : null)).filter(Boolean)) };
      }));
    },
    enabled: (ctx) => !!ctx.state && pastedListOf(ctx.state) != null,
  },
};

/** The counts of the caret item's list at each level above it, so Set Numbering Value's preview shows '2.5' under a 1.1 list. */
function listLabelsCounts(c, all) {
  const counts = [];
  for (let k = 0; k <= c.index; k++) {
    const m = all[k];
    if (m.numId !== c.n.numId) continue;
    counts[m.ilvl] = (counts[m.ilvl] ?? (c.levels[m.ilvl]?.start ?? 1) - 1) + 1;
    counts.length = m.ilvl + 1;
  }
  return Array.from({ length: c.n.ilvl }, (_, i) => counts[i] ?? 1);
}

// ---------- LISTNUM ----------
/** The document up to `pos` as listNumText reads it: each paragraph's numbering and each LISTNUM field before or at `pos`. */
function listNumSeq(doc, pos) {
  const seq = [];
  doc.descendants((node, at) => {
    if (at > pos) return false;
    if (!node.isTextblock) return true;
    seq.push({ para: numOf(doc, node) });
    node.forEach((child, off) => {
      const p = at + 1 + off;
      if (p > pos || child.type.name !== 'field' || !/^\s*LISTNUM\b/i.test(child.attrs.code)) return;
      const words = child.attrs.code.trim().split(/\s+/).slice(1);
      const quoted = /^\s*LISTNUM\s+"([^"]*)"/i.exec(child.attrs.code)?.[1];
      const name = quoted ?? (words[0] && !words[0].startsWith('\\') ? words[0] : null);
      const sw = (k) => {
        const m = new RegExp(`\\\\${k}\\s+"?(\\d+)`, 'i').exec(child.attrs.code);
        return m ? Number(m[1]) : null;
      };
      seq.push({ field: { name, level: sw('l'), start: sw('s') } });
    });
    return false;
  });
  return seq;
}
const LISTNUM = {
  category: 'Numbering',
  updates: 'layout',
  compute: (f, ctx) => ({ text: ctx.get('listNum', ctx.pos) ?? '' }),
};
// What a LISTNUM field at `pos` shows: a field being inserted (not in the doc yet) counts as one more at that place.
const listNumProvider = (ctx, pos) => {
  const seq = listNumSeq(ctx.doc, pos);
  const at = ctx.doc.nodeAt(pos);
  if (at?.type.name !== 'field') seq.push({ field: { name: null, level: null, start: null } });
  return listNumText(seq, numberingOf(ctx.doc));
};

export default {
  id: 'lists',
  commands,
  galleries: {
    'home.paragraph.bullets': onCanvas(bulletGallery),
    'home.paragraph.numbering': onCanvas(numberGallery),
    'home.paragraph.multilevelList': onCanvas(multilevelGallery),
    'home.paragraph.multilevelList.all': onCanvas(() => [['all', 'All'], ['current', 'Current List'], ['library', 'List Library']]
      .map(([id, label]) => ({ id, label, active: mlFilter === id }))),
    'lists.changeListLevel': onCanvas((ctx) => (ctx.engine ? canvasLevels(ctx) : levelGallery(ctx))),
    'paste.listChoices': (ctx) => (ctx.state && pastedListOf(ctx.state) != null ? [{ id: 'continue', label: 'Continue List' }, { id: 'new', label: 'New List' }] : []),
  },
  dialogs: {
    defineNewBullet: DefineNewBullet,
    defineNewNumberFormat: DefineNewNumberFormat,
    defineNewMultilevelList: DefineNewMultilevelList,
    defineNewListStyle: DefineNewListStyle,
    setNumberingValue: SetNumberingValue,
    adjustListIndents: AdjustListIndents,
    setForAllLevels: SetForAllLevels,
  },
  fields: { LISTNUM },
  providers: { listNum: listNumProvider },
  implements: ['editing.enterEmptyList', 'editing.backspaceList', 'editing.tabListLevel', 'editing.tabFirstIndent', 'autoformat.tabIndent',
    'fields.LISTNUM', 'lists.legal', 'lists.linkToHeadings', 'lists.pictureBullets', 'styles.listStyles'],
};
