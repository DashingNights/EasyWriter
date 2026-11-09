// The Borders and Shading dialog (plan.md §1.6 id bordersAndShading; probe/dialogs/borders-and-shading.json) with its Borders,
// Page Border and Shading tabs, and the two Border and Shading Options dialogs (border-and-shading-options.json, -page.json),
// opened stacked over it. Props: {tab: 'borders'|'pageBorder'|'shading', apply: 'text'|'paragraph'|'cell'|'table'}; in
// {mode: 'value', value} it edits {para: {borders, shading}} or {run: {border, shading}} and returns it instead of applying.
// On a canvas draft the row passes what the engine holds (`engineRead`, canvas.mjs canvasRead) and OK writes engine steps.
// ponytail: Options... for cells and tables (cell margins) is left out.
import { useState } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { openDialog } from '../../../app/actions.js';
import { getState, setState } from '../../../app/store.js';
import { borderCss, shadingCss } from '../../../office.mjs';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Fieldset, ListPick, Pick, Preview, Radio, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { Help } from '../../../app/components/Tip.jsx';
import { ctxOf } from '../../../tooling/registry.js';
import { sectionOf, sectionsOf } from '../../model/sections.mjs';
import { OWN } from '../../ribbon/icons.jsx';
import { textblocks } from '../../lists.js';
import { DEFAULT_PEN, edgeOf, isLine, mirrored, PATTERN_NAMES, presetBorders, settingOf, SPACE, STYLE_NAMES, WIDTHS } from './model.mjs';
import { bordersOf, cellList, patchAttr, runBorder, styleBorders, tableEdges, targetOf } from './select.js';
import { ART, BASIC_ART, artLabel, canvasSteps, isArt } from './canvas.mjs';

const APPLY = { text: 'Text', paragraph: 'Paragraph', cell: 'Cell', table: 'Table' };
const PAGE_APPLY = [['whole', 'Whole document'], ['section', 'This section'], ['first', 'This section - First page only'], ['notFirst', 'This section - All except first page']];
const SETTINGS = [['none', '&None'], ['box', 'Bo&x'], ['shadow', 'Sh&adow'], ['threeD', '3-&D'], ['custom', 'C&ustom']];
const PAGE_MARGIN = { top: 24, bottom: 24, left: 24, right: 24 };
const TEXT_MARGIN = { top: SPACE.top, bottom: SPACE.bottom, left: SPACE.left, right: SPACE.right };
const FOUR = ['top', 'left', 'bottom', 'right'];
// The preview's edge buttons: edge → [label, icon].
const EDGE_BUTTONS = {
  top: ['Top Border', 'borderTop'], between: ['Inside Horizontal Border', 'borderInsideH'], insideH: ['Inside Horizontal Border', 'borderInsideH'],
  bottom: ['Bottom Border', 'borderBottom'], tl2br: ['Diagonal Down Border', 'borderDiagonalDown'], left: ['Left Border', 'borderLeft'],
  insideV: ['Inside Vertical Border', 'borderInsideV'], right: ['Right Border', 'borderRight'], tr2bl: ['Diagonal Up Border', 'borderDiagonalUp'],
};
const nil = { style: 'nil' };
/** The cell-level target of `t`: the selected cells, or the cell holding selected text. */
const cellsIn = (t) => (t?.kind === 'cells' ? t : t?.cell ?? null);

/** The edges the Borders tab offers for `apply` (between only for several paragraphs, inside ones for several cells). */
function edgesFor(apply, t) {
  if (apply === 'text') return FOUR;
  if (apply === 'paragraph') return [...FOUR, ...(t?.kind === 'paras' && t.paras.length > 1 ? ['between'] : [])];
  const r = cellsIn(t)?.rect;
  const many = apply === 'table' || (r && (r.right - r.left > 1 || r.bottom - r.top > 1));
  const wide = apply === 'table' || (r && r.right - r.left > 1);
  const tall = apply === 'table' || (r && r.bottom - r.top > 1);
  return [...FOUR, ...(many && tall ? ['insideH'] : []), ...(many && wide ? ['insideV'] : []), ...(apply === 'cell' ? ['tl2br', 'tr2bl'] : [])];
}

/** What the selection holds for `apply`: {borders, shading}. */
function readOf(apply, state, t) {
  if (!state || !t) return { borders: {}, shading: null };
  const para = t.kind === 'paras' ? t.paras[0].node : state.selection.$from.parent;
  if (apply === 'text') {
    const b = runBorder(state);
    const mark = state.schema.marks.textStyle?.isInSet(state.doc.resolve(state.selection.from + (state.selection.empty ? 0 : 1)).marks());
    return { borders: isLine(b) ? Object.fromEntries(FOUR.map((e) => [e, b])) : {}, shading: mark?.attrs.shading ?? null };
  }
  if (apply === 'paragraph') return { borders: bordersOf(state.doc, para), shading: para.attrs.shading ?? null };
  const ct = cellsIn(t);
  if (apply === 'table') return { borders: ct ? tableEdges(state.doc, ct.table) : {}, shading: null };
  const cell = ct ? cellList(ct)[0] : null;
  return { borders: cell?.borders ?? {}, shading: cell?.node.attrs.shading ? { val: 'clear', fill: cell.node.attrs.shading } : null };
}

/** The Apply to choices for target `t` → [ids], the first the default. */
function applyChoices(t, wanted, value) {
  if (value) return value.run ? ['text'] : ['paragraph'];
  const inCell = t?.cell ? ['cell', 'table'] : [];
  const list = !t ? ['paragraph'] : t.kind === 'run' ? ['text', 'paragraph', ...inCell] : t.kind === 'paras' ? ['paragraph', ...inCell] : t.whole ? ['table', 'cell', 'paragraph'] : ['cell', 'table', 'paragraph'];
  return wanted && list.includes(wanted) ? [wanted, ...list.filter((x) => x !== wanted)] : list;
}

/** The preview: a sample box with the chosen edges, its edges clickable, and the edge buttons around it. */
function EdgePreview({ edges, borders, onToggle, shading, page }) {
  const btn = (edge) => {
    const [label, icon] = EDGE_BUTTONS[edge];
    const Icon = OWN[icon];
    const on = isLine(borders[edge]);
    return (
      <label key={edge} title={label} className={cn('grid size-7 cursor-default place-items-center rounded-sm border', on ? 'border-primary bg-accent' : 'border-input')}>
        <input type="checkbox" className="sr-only" aria-label={label} checked={on} onChange={() => onToggle(edge)} />
        <Icon className="size-5" />
      </label>
    );
  };
  const zone = (edge, cls) => edges.includes(edge) && (
    <button key={edge} type="button" tabIndex={-1} aria-hidden="true" data-edge={edge} onClick={() => onToggle(edge)} className={cn('absolute', cls)} />
  );
  const line = (e) => (isLine(borders[e]) ? borderCss(borders[e]) : '1px dashed #c8c8c8');
  const left = edges.filter((e) => ['top', 'between', 'insideH', 'bottom'].includes(e));
  const below = edges.filter((e) => ['tl2br', 'left', 'insideV', 'right', 'tr2bl'].includes(e));
  return (
    <div className="flex flex-col gap-2">
      <Help className="self-end">Click on diagram below or use buttons to apply borders</Help>
      <div className="flex gap-2">
        <div className="flex flex-col justify-around">{left.map(btn)}</div>
        <div className="relative flex-1">
          <Preview height="9rem" page={page}>
            <div className="relative px-1" style={{ borderTop: line('top'), borderBottom: line('bottom'), borderLeft: line('left'), borderRight: line('right'),
              background: shadingCss(shading) ?? undefined }}>
              <div className="h-1.5 rounded-full bg-neutral-400" />
              <div className="my-1.5" style={{ borderTop: edges.some((e) => e === 'between' || e === 'insideH') ? line(edges.includes('between') ? 'between' : 'insideH') : 'none' }} />
              <div className="h-1.5 w-3/4 rounded-full bg-neutral-400" />
            </div>
          </Preview>
          {zone('top', 'inset-x-4 top-0 h-5')}
          {zone('bottom', 'inset-x-4 bottom-0 h-5')}
          {zone('left', 'inset-y-4 left-0 w-5')}
          {zone('right', 'inset-y-4 right-0 w-5')}
          {zone('between', 'inset-x-8 top-1/2 h-4 -translate-y-1/2')}
          {zone('insideH', 'inset-x-8 top-1/2 h-4 -translate-y-1/2')}
        </div>
      </div>
      <div className="flex justify-around pl-9">{below.map(btn)}</div>
    </div>
  );
}

// Art border widths, points (Word's art Width box: 1 to 31 pt).
const ART_WIDTHS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 31];

/** The line controls and Setting radios shared by the Borders and Page Border tabs. An art border (Page Border's Art box) takes
 * the art's name as its style and a width in points; `art` is 'all' or the list of arts the engine draws (a canvas draft), 'none'
 * on the DOM editor (as captured: (none)), else no Art box. */
function LineControls({ v, set, art }) {
  const arts = Array.isArray(art) ? art : art === 'all' ? ART : [];
  const onArt = arts.includes(v.style) && isArt(v.style);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="bs-style" {...accessProps('St&yle:')}><AccessText label="St&yle:" /></label>
      <ListPick id="bs-style" items={STYLE_NAMES.map(([n, s]) => [s, n])} value={onArt ? null : v.style} onChange={(s) => set({ style: s })} height="8rem" width="13rem" />
      <Row label="&Color:" htmlFor="bs-color"><ColorPick id="bs-color" value={v.color} onChange={(hex) => set({ color: hex })} /></Row>
      <Row label="&Width:" htmlFor="bs-width">
        <Pick id="bs-width" value={v.width} options={onArt ? ART_WIDTHS.map((pt) => [pt, `${pt} pt`]) : WIDTHS.map(([n, pt]) => [pt, n])}
          onChange={(w) => set({ width: w })} width="8rem" />
      </Row>
      {art && (
        <Row label="A&rt:" htmlFor="bs-art">
          <Pick id="bs-art" value={onArt ? v.style : 'none'} options={[['none', '(none)'], ...arts.map((a) => [a, artLabel(a)])]} width="10rem"
            onChange={(a) => set(a === 'none' ? { style: 'single', width: 0.5 } : { style: a, width: isArt(v.style) ? v.width : 16 })} />
        </Row>
      )}
    </div>
  );
}

/** One borders tab's state handlers: Setting, edge toggles and line changes keep `key` ('b' or 'p') of the dialog state. */
function useBorderTab(v, setV, key) {
  const tab = v[key];
  const put = (patch) => setV((o) => ({ ...o, [key]: { ...o[key], ...patch }, touched: { ...o.touched, [key]: true } }));
  const edge = (t, e) => edgeOf({ style: t.style, width: t.width, color: t.color }, t.space[e] ?? SPACE[e]);
  return {
    tab,
    setting: (s) => {
      if (s === 'custom') return put({ setting: 'custom' });
      put({ setting: s, borders: presetBorders(s, { style: tab.style, width: tab.width, color: tab.color }, tab.space) });
    },
    toggle: (e) => {
      const b = { ...tab.borders };
      if (isLine(b[e])) delete b[e];
      else b[e] = edge(tab, e);
      put({ borders: b, setting: settingOf(b) });
    },
    line: (patch) => {
      const next = { ...tab, ...patch };
      // A preset follows the line chosen, as Word redraws the box; a custom setting keeps its edges for the next click.
      if (['box', 'shadow', 'threeD'].includes(tab.setting)) put({ ...patch, borders: presetBorders(tab.setting, next, tab.space) });
      else put(patch);
    },
    put,
  };
}

/** The Borders and Shading dialog. */
export function BordersAndShadingDialog({ tab: start = 'borders', apply: wanted, mode, value, onClose, engineRead = null }) {
  const valueMode = mode === 'value';
  const [init] = useState(() => {
    const ctx = ctxOf();
    const canvas = !valueMode && engineRead && ctx.engine ? engineRead : null;
    const state = canvas ? null : ctx.state;
    const t = valueMode ? null : canvas ? canvas.t : targetOf(state);
    const choices = applyChoices(t, wanted, valueMode ? value ?? { para: {} } : null);
    const pen = getState().word?.pen ?? DEFAULT_PEN;
    const read = valueMode
      ? value?.run ? { borders: isLine(value.run.border) ? Object.fromEntries(FOUR.map((e) => [e, value.run.border])) : {}, shading: value.run.shading ?? null }
        : { borders: value?.para?.borders ?? {}, shading: value?.para?.shading ?? null }
      : canvas ? canvas.read[choices[0]] : readOf(choices[0], state, t);
    const first = FOUR.map((e) => read.borders[e]).find(isLine);
    const line = { style: first?.style ?? pen.style ?? 'single', width: first?.width ?? pen.width ?? 0.5, color: first?.color && first.color !== 'auto' ? first.color : pen.color ?? null };
    const space = { ...SPACE, ...Object.fromEntries(Object.entries(read.borders).filter(([, e]) => e?.space != null).map(([k, e]) => [k, e.space])) };
    const pg = canvas ? canvas.page : state ? sectionOf(state.doc, state.selection.from).sect.pgBorders : null;
    const pgFirst = FOUR.map((e) => pg?.[e]).find(isLine);
    const doc = state?.doc.attrs.settings ?? {};
    return {
      t, state, choices, canvas,
      b: { borders: read.borders, setting: settingOf(read.borders), ...line, space, apply: choices[0] },
      p: {
        borders: pg ? Object.fromEntries(FOUR.filter((e) => isLine(pg[e])).map((e) => [e, pg[e]])) : {}, setting: settingOf(pg ?? {}),
        style: pgFirst?.style ?? 'single', width: pgFirst?.width ?? 0.5, color: pgFirst?.color && pgFirst.color !== 'auto' ? pgFirst.color : null,
        space: Object.fromEntries(FOUR.map((e) => [e, pg?.[e]?.space ?? (pg?.offsetFrom === 'text' ? TEXT_MARGIN : PAGE_MARGIN)[e]])),
        apply: { firstPage: 'first', notFirstPage: 'notFirst' }[pg?.display] ?? 'whole', offsetFrom: pg?.offsetFrom ?? 'page',
        front: (pg?.zOrder ?? 'front') === 'front',
        surroundHeader: !doc.bordersDoNotSurroundHeader, surroundFooter: !doc.bordersDoNotSurroundFooter, align: !!doc.alignBordersAndEdges,
      },
      s: { fill: read.shading?.fill && read.shading.fill !== 'auto' ? read.shading.fill : null, val: read.shading?.val ?? 'clear',
        color: read.shading?.color && read.shading.color !== 'auto' ? read.shading.color : null, apply: choices[0] },
      touched: {},
    };
  });
  const [v, setV] = useState(init);
  const [tab, setTab] = useState(valueMode && start === 'pageBorder' ? 'borders' : start);
  const bt = useBorderTab(v, setV, 'b');
  const pt = useBorderTab(v, setV, 'p');
  const setS = (patch) => setV((o) => ({ ...o, s: { ...o.s, ...patch }, touched: { ...o.touched, s: true } }));
  const shading = () => (v.s.val === 'clear' && !v.s.fill ? null : { val: v.s.val, color: v.s.color ?? 'auto', fill: v.s.fill ?? 'auto' });

  const changeApply = (a) => {
    const read = init.canvas ? init.canvas.read[a] : readOf(a, init.state, init.t);
    setV((o) => ({ ...o, b: { ...o.b, apply: a, borders: read.borders, setting: settingOf(read.borders) }, touched: { ...o.touched, b: true } }));
  };

  const options = async () => {
    const r = await openDialog('borderAndShadingOptions', { value: v.b.space });
    if (!r) return;
    const borders = Object.fromEntries(Object.entries(v.b.borders).map(([k, e]) => [k, isLine(e) && r[k] != null ? { ...e, space: r[k] } : e]));
    bt.put({ space: { ...v.b.space, ...r }, borders });
  };
  const pageOptions = async () => {
    const r = await openDialog('borderAndShadingOptionsPage', { value: { margin: v.p.space, offsetFrom: v.p.offsetFrom, front: v.p.front,
      surroundHeader: v.p.surroundHeader, surroundFooter: v.p.surroundFooter, align: v.p.align } });
    if (!r) return;
    const { margin, ...rest } = r;
    const borders = Object.fromEntries(Object.entries(v.p.borders).map(([k, e]) => [k, { ...e, space: margin[k] }]));
    pt.put({ ...rest, space: margin, borders });
  };

  const result = () => {
    const sh = shading();
    if (valueMode) {
      const b = v.b.borders;
      if (v.b.apply === 'text') return { run: { border: FOUR.map((e) => b[e]).find(isLine) ?? null, shading: sh } };
      return { para: { borders: Object.keys(b).length ? b : null, shading: sh } };
    }
    if (init.canvas) {
      const steps = canvasSteps(v, sh);
      const ctx = ctxOf();
      if (steps.length) Promise.resolve(ctx.engine?.execMany(steps)).then((r) => r?.ok === false && ctx.toast(`Could not apply the borders: ${r.error ?? 'the engine refused them'}`));
      savePen(v);
      return true;
    }
    apply(v, sh, init);
    return true;
  };

  const lineTab = (key, h, page) => {
    const tb = h.tab;
    const edges = page ? FOUR : edgesFor(tb.apply, init.t);
    return (
      <div className="grid grid-cols-[auto_13rem_1fr] gap-4">
        <div className="flex flex-col gap-1">
          <span>Setting:</span>
          <Radio name={`bs-setting-${key}`} value={tb.setting} options={SETTINGS} onChange={h.setting} />
        </div>
        {/* The engine draws Word's ten basic art borders as Word does (engine-gaps-rest, Word probe fixture/out/probe/art); the
            pictorial ones are Microsoft's pictures, so a canvas draft offers the basic ones and the DOM editor (none). */}
        <LineControls v={tb} set={h.line} art={page ? (init.canvas ? BASIC_ART : 'none') : null} />
        <div className="flex flex-col gap-2">
          <EdgePreview edges={edges} borders={tb.borders} onToggle={h.toggle} shading={page ? null : shading()} page={page} />
          {page ? (
            <Row label="App&ly to:" htmlFor="bs-papply"><Pick id="bs-papply" value={tb.apply} options={PAGE_APPLY} onChange={(a) => pt.put({ apply: a })} /></Row>
          ) : (
            <Row label="App&ly to:" htmlFor="bs-apply"><Pick id="bs-apply" value={tb.apply} options={init.choices.map((a) => [a, APPLY[a]])} onChange={changeApply} /></Row>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="xs" {...accessProps('&Options...')}
              disabled={page ? false : !Object.values(tb.borders).some(isLine) || !['text', 'paragraph'].includes(tb.apply)}
              onClick={page ? pageOptions : options}><AccessText label="&Options..." /></Button>
          </div>
        </div>
      </div>
    );
  };

  const shadingTab = () => (
    <div className="grid grid-cols-[1fr_1fr] gap-4">
      <div className="flex flex-col gap-3">
        <Fieldset legend="Fill">
          <ColorPick id="bs-fill" value={v.s.fill} automatic="No Color" onChange={(hex) => setS({ fill: hex })} />
        </Fieldset>
        <Fieldset legend="Patterns">
          <Row label="St&yle:" htmlFor="bs-pattern">
            <Pick id="bs-pattern" value={v.s.val} options={PATTERN_NAMES.map(([n, val]) => [val, n])} onChange={(val) => setS({ val })} width="9rem" />
          </Row>
          <fieldset disabled={v.s.val === 'clear'} className="disabled:opacity-50">
            <Row label="&Color:" htmlFor="bs-pcolor"><ColorPick id="bs-pcolor" value={v.s.color} onChange={(hex) => setS({ color: hex })} /></Row>
          </fieldset>
        </Fieldset>
      </div>
      <div className="flex flex-col gap-2">
        <Preview height="8rem"><div className="h-12" style={{ background: shadingCss(shading() ?? {}) ?? undefined }} /></Preview>
        <Row label="App&ly to:" htmlFor="bs-sapply">
          <Pick id="bs-sapply" value={v.s.apply} options={init.choices.map((a) => [a, APPLY[a]])} onChange={(a) => setS({ apply: a })} />
        </Row>
      </div>
    </div>
  );

  const tabs = [
    { id: 'borders', label: '&Borders', render: () => lineTab('b', bt, false) },
    ...(valueMode ? [] : [{ id: 'pageBorder', label: '&Page Border', render: () => lineTab('p', pt, true) }]),
    { id: 'shading', label: '&Shading', render: shadingTab },
  ];
  return <WordDialog title="Borders and Shading" size="lg" tabs={tabs} tab={tab} onTab={setTab} result={result} onClose={onClose} />;
}

/** Writes what the dialog's touched tabs hold, in one transaction, and the pen (G14: Word's last used border). */
function apply(v, sh, init) {
  const ctx = ctxOf();
  const state = ctx.state;
  if (!state) return;
  const t = cellsIn(targetOf(state) ?? init.t);
  const b = v.b.borders;
  const full = (keys) => Object.fromEntries(keys.map((k) => [k, isLine(b[k]) ? b[k] : nil]));
  ctx.chain((c) => {
    let ch = c;
    if (v.touched.b) {
      const a = v.b.apply;
      if (a === 'text') ch = ch.setRunProps({ border: FOUR.map((e) => b[e]).find(isLine) ?? null });
      else if (a === 'paragraph') {
        const paras = textblocks(state);
        ch = ch.command(({ tr }) => {
          for (const { node, pos } of paras) {
            const inherited = styleBorders(state.doc, node);
            const patch = Object.fromEntries(['top', 'bottom', 'left', 'right', 'between'].map((k) => [k, isLine(b[k]) ? b[k] : isLine(inherited[k]) ? nil : null]));
            patchAttr(tr, pos, 'borders', patch);
          }
          return true;
        });
      } else if (a === 'table' && t) {
        // The cells' own sides go, or they would keep drawing over the table's edges.
        const all = cellList({ ...t, rect: { left: 0, top: 0, right: t.map.width, bottom: t.map.height } });
        ch = ch.command(({ tr }) => {
          patchAttr(tr, t.tablePos, 'borders', full(['top', 'left', 'bottom', 'right', 'insideH', 'insideV']));
          for (const cell of all) patchAttr(tr, cell.id, 'borders', { top: null, left: null, bottom: null, right: null });
          return true;
        });
      } else if (a === 'cell' && t) {
        ch = ch.command(({ tr }) => {
          const patches = [];
          for (const cell of cellList(t)) {
            const r = cell.rect;
            const pick = (k, outer, inner) => [k, (outer ? b[k] : b[inner]) ?? null];
            const edges = Object.fromEntries([pick('top', r.top === t.rect.top, 'insideH'), pick('bottom', r.bottom === t.rect.bottom, 'insideH'),
              pick('left', r.left === t.rect.left, 'insideV'), pick('right', r.right === t.rect.right, 'insideV'), ['tl2br', b.tl2br], ['tr2bl', b.tr2bl]]
              .map(([k, e]) => [k, isLine(e) ? e : nil]));
            patches.push({ id: cell.id, borders: edges });
          }
          for (const c of mirrored(patches, t.map, t.start)) patchAttr(tr, c.id, 'borders', c.borders);
          return true;
        });
      }
    }
    if (v.touched.s) {
      const a = v.s.apply;
      if (a === 'text') ch = ch.setRunProps({ shading: sh });
      else if (a === 'paragraph') ch = ch.command(({ tr }) => (textblocks(state).forEach(({ pos }) => patchAttr(tr, pos, 'shading', sh)), true));
      else if (t) {
        // Cells keep only the fill (cell shading is a hex, plan.md §1.8).
        const cells = a === 'table' ? cellList({ ...t, rect: { left: 0, top: 0, right: t.map.width, bottom: t.map.height } }) : cellList(t);
        ch = ch.command(({ tr }) => (cells.forEach((cell) => tr.setNodeAttribute(cell.id, 'shading', v.s.fill ?? null)), true));
      }
    }
    if (v.touched.p) {
      const p = v.p;
      const lined = FOUR.some((e) => isLine(p.borders[e]));
      const pg = lined ? { offsetFrom: p.offsetFrom, zOrder: p.front ? 'front' : 'back',
        display: { first: 'firstPage', notFirst: 'notFirstPage' }[p.apply] ?? 'allPages',
        ...Object.fromEntries(FOUR.map((e) => [e, isLine(p.borders[e]) ? { ...p.borders[e], space: p.space[e] } : null])) } : null;
      const all = sectionsOf(state.doc).map((s) => s.index);
      const here = sectionOf(state.doc, state.selection.from).index;
      // The whole object replaces the old one, so an edge switched off goes (setSectionProps patches; null removes the key first).
      for (const i of p.apply === 'whole' ? all : [here]) ch = ch.setSectionProps({ pgBorders: null }, { section: i }).setSectionProps(pg ? { pgBorders: pg } : {}, { section: i });
      ch = ch.setDocSettings({ alignBordersAndEdges: p.align, bordersDoNotSurroundHeader: !p.surroundHeader, bordersDoNotSurroundFooter: !p.surroundFooter });
    }
    return ch;
  });
  savePen(v);
}

/** The pen takes the last border the dialog drew (Word's last used border, G14); an art border leaves it. */
function savePen(v) {
  const src = v.touched.b ? v.b : v.touched.p ? v.p : null;
  if (src && !isArt(src.style)) setState({ word: { ...getState().word, pen: { style: src.style, width: src.width, color: src.color ?? null } } });
}

/** Border and Shading Options for paragraphs and text: From text Top, Bottom, Left, Right in pt. → {top, bottom, left, right}. */
export function BorderOptionsDialog({ value, onClose }) {
  const [m, setM] = useState({ top: value?.top ?? 1, bottom: value?.bottom ?? 1, left: value?.left ?? 4, right: value?.right ?? 4 });
  const spin = (k, label) => <Spin label={label} value={m[k]} unit="pt" min={0} max={31} onChange={(x) => setM((o) => ({ ...o, [k]: x }))} />;
  return (
    <WordDialog title="Border and Shading Options" size="sm" result={() => m} onClose={onClose}>
      <Fieldset legend="From text">
        <div className="grid grid-cols-2 gap-2">{spin('top', 'T&op:')}{spin('left', 'L&eft:')}{spin('bottom', 'Botto&m:')}{spin('right', 'Ri&ght:')}</div>
      </Fieldset>
    </WordDialog>
  );
}

/** Border and Shading Options for page borders: Margin, Measure from, and the Options check boxes. → the same shape it took. */
export function PageBorderOptionsDialog({ value, onClose }) {
  const [o, setO] = useState({ margin: { ...PAGE_MARGIN, ...value?.margin }, offsetFrom: value?.offsetFrom ?? 'page', front: value?.front ?? true,
    surroundHeader: value?.surroundHeader ?? true, surroundFooter: value?.surroundFooter ?? true, align: value?.align ?? false });
  const spin = (k, label) => <Spin label={label} value={o.margin[k]} unit="pt" min={0} max={31} onChange={(x) => setO((s) => ({ ...s, margin: { ...s.margin, [k]: x } }))} />;
  const text = o.offsetFrom === 'text';
  return (
    <WordDialog title="Border and Shading Options" size="sm" result={() => o} onClose={onClose}>
      <Fieldset legend="Margin">
        <div className="grid grid-cols-2 gap-2">{spin('top', 'T&op:')}{spin('left', 'L&eft:')}{spin('bottom', 'Botto&m:')}{spin('right', 'Ri&ght:')}</div>
        <Row label="Measu&re from:" htmlFor="bs-from">
          <Pick id="bs-from" value={o.offsetFrom} options={[['text', 'Text'], ['page', 'Edge of page']]}
            onChange={(f) => setO((s) => ({ ...s, offsetFrom: f, margin: f === 'text' ? TEXT_MARGIN : PAGE_MARGIN }))} />
        </Row>
      </Fieldset>
      <Fieldset legend="Options">
        <Check label="&Align paragraph borders and table edges with page border" checked={o.align} disabled={!text} onChange={(x) => setO((s) => ({ ...s, align: x }))} />
        <Check label="A&lways display in front" checked={o.front} onChange={(x) => setO((s) => ({ ...s, front: x }))} />
        <Check label="Surround &header" checked={o.surroundHeader} disabled={!text} onChange={(x) => setO((s) => ({ ...s, surroundHeader: x }))} />
        <Check label="Surround &footer" checked={o.surroundFooter} disabled={!text} onChange={(x) => setO((s) => ({ ...s, surroundFooter: x }))} />
      </Fieldset>
    </WordDialog>
  );
}
