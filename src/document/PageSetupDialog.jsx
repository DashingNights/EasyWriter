// Word's Page Setup dialog (docs/plans/word briefs/sections.md; probe/dialogs/page-setup.json): Margins, Paper, Layout and Document
// Grid tabs with Apply to, Set As Default, OK and Cancel. It reads the open Document's section, writes its own change in one
// transaction (wp/sections/model.mjs applyPageSetup) and resolves null, so tools.js openPageSetup applies nothing a second time.
// Props: `tab` ('margins', 'paper', 'layout', 'documentGrid'; the older `focus` prop names the same), `section` (an index: a
// double-click on a section break). On a canvas draft the row passes `engine` {sect: the engine's layout.section, settings: its
// document.settings} and the dialog writes through the engine as one undo step: the fields changed, to the sections Apply to
// reaches (layout.pageSetup's patch), with Line Numbers' choice among them; Borders runs the Page Borders row.
import { useState } from 'react';
import { confirmDialog, openDialog, toast } from '../app/actions.js';
import { Button } from '@/components/ui/button';
import { RadioInput } from '@/components/ui/radio';
import { WORD_DIALOGS } from '../tooling/dialogs.js';
import { Check, Fieldset, Pick, Radio, Row, Spin, useUnit } from '../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../tooling/kit/WordDialog.jsx';
import { REASONS } from '../tooling/reasons.mjs';
import { commandOf, ctxOf, run as runTool } from '../tooling/registry.js';
import { defaultSect } from './defaults.mjs';
import { sectionAt, sectionsOf, withDefaults } from './model/sections.mjs';
import { saveWord } from './word/settings.mjs';
import { Tip } from '../app/components/Tip.jsx';
import { APPLY_LABELS, applyPageSetup, applyToOptions, checkSetup, orientSect, paperOf, PAPERS, presetOf, storedSect } from './wp/sections/model.mjs';

const MARGIN_KEYS = ['top', 'bottom', 'left', 'right', 'gutter', 'header', 'footer'];
const MULTIPLE = [['normal', 'Normal'], ['mirror', 'Mirror margins'], ['twoOnOne', '2 pages per sheet'], ['bookFold', 'Book fold'], ['reverseBookFold', 'Reverse book fold']];
const SHEETS = [[0, 'All'], ...Array.from({ length: 10 }, (_, i) => [(i + 1) * 4, String((i + 1) * 4)])];
const STARTS = [['continuous', 'Continuous'], ['nextColumn', 'New column'], ['nextPage', 'New page'], ['evenPage', 'Even page'], ['oddPage', 'Odd page']];
const VALIGNS = [['top', 'Top'], ['center', 'Center'], ['both', 'Justified'], ['bottom', 'Bottom']];
const GRIDS = [['default', '&No grid'], ['lines', 'Specify line grid &only'], ['linesAndChars', 'Specify line and c&haracter grid'], ['snapToChars', 'Te&xt snaps to character grid']];
const GRID_DEFAULT = { type: 'default', charsPerLine: 37, charPitch: 12, defaultPitch: false, linesPerPage: 38, linePitch: 18 };
const round = (pt) => Math.round(pt * 100) / 100;
// The engine's section start and vertical alignment names → the form's, and back.
const VALIGN_OF = { top: 'top', center: 'center', justify: 'both', bottom: 'bottom' };
const VALIGN_TO = { top: 'top', center: 'center', both: 'justify', bottom: 'bottom' };

/** The form's values from the engine's section `x` (layout.section) and document settings `st`. */
function engineInitial({ sect: x, settings: st }) {
  const g = x.docGrid;
  return {
    w: x.pageW, h: x.pageH, orient: x.landscape ? 'landscape' : 'portrait',
    margin: { top: x.marginTop, bottom: x.marginBottom, left: x.marginLeft, right: x.marginRight, gutter: x.gutter ?? 0, header: x.header, footer: x.footer },
    start: x.start ?? 'nextPage', titlePg: !!x.titlePage, vAlign: VALIGN_OF[x.valign] ?? 'top', noEndnote: false,
    docGrid: { ...GRID_DEFAULT, ...(g ? { type: g.type ?? 'default', linePitch: g.linePitch || GRID_DEFAULT.linePitch } : {}) },
    gutterAtTop: false, evenOdd: !!st.evenOddHeaders, multiple: st.mirrorMargins ? 'mirror' : 'normal', sheets: 0,
  };
}

/** Apply to's choices for the engine's section `x` (layout.section: its count, the selection's first and last section, whether
 * it is collapsed) as applyToOptions gives them for the DOM editor; from a section break (`fixed`) This section or the whole. */
function engineApply(x, fixed) {
  if (fixed) return { options: ['section', 'whole'], value: 'section' };
  const spans = (x.selection?.[0] ?? 0) !== (x.selection?.[1] ?? 0);
  const options = x.count === 1 ? (x.collapsed !== false ? ['whole', 'forward'] : ['whole', 'selected'])
    : x.collapsed !== false ? ['section', 'forward', 'whole'] : spans ? ['sections', 'whole'] : ['section', 'selected', 'whole'];
  return { options, value: options[0] };
}

// Line Numbers' restart (layout-misc/logic.mjs) ↔ the engine's LineNumbering restart.
const LN_TO = { newPage: 'page', newSection: 'section', continuous: 'continuous' };
const LN_OF = { page: 'newPage', section: 'newSection', continuous: 'continuous' };
/** The engine section's line numbers as the Line Numbers dialog's value. */
const lineNumbersOf = (ln) => ({ on: !!ln, start: ln?.start ?? 1, countBy: ln?.countBy ?? 1, distance: ln?.distance ?? 0, restart: LN_OF[ln?.restart] ?? 'newPage' });

/** The engine steps (one undo step) that write form `v` over `start` to the sections Apply to `apply` reaches: only the fields
 * changed, so each section keeps the rest of its own (its headers and footers always). */
function engineSteps({ sect }, start, v, apply) {
  const { index, count: _c, selection: _s, collapsed: _k, ...old } = sect;
  const m = v.margin;
  const next = { ...old, pageW: round(v.w), pageH: round(v.h), landscape: v.orient === 'landscape', marginTop: round(m.top), marginBottom: round(m.bottom),
    marginLeft: round(m.left), marginRight: round(m.right), gutter: round(m.gutter), header: round(m.header), footer: round(m.footer), start: v.start,
    titlePage: v.titlePg, valign: VALIGN_TO[v.vAlign] ?? 'top' };
  if (v.lineNumbers) {
    const l = v.lineNumbers;
    next.lineNumbers = l.on ? { start: l.start, countBy: l.countBy, distance: l.distance || 0, restart: LN_TO[l.restart] ?? 'page' } : null;
  }
  const patch = Object.fromEntries(Object.entries(next).filter(([k, x]) => JSON.stringify(x ?? null) !== JSON.stringify(old[k] ?? null)));
  const steps = Object.keys(patch).length ? [['layout.pageSetup', { patch, apply, ...(apply === 'section' ? { index } : {}) }]] : [];
  if (start.evenOdd !== v.evenOdd) steps.push(['layout.differentOddEven', { value: v.evenOdd }]);
  if ((start.multiple === 'mirror') !== (v.multiple === 'mirror')) steps.push(['layout.margins', { mirror: v.multiple === 'mirror' }]);
  if (JSON.stringify(start.docGrid) !== JSON.stringify(v.docGrid)) {
    const g = v.docGrid;
    // ponytail: the grid goes to the dialog's section (or the selection's with another Apply to); per target once the patch
    // carries a grid of its own.
    steps.push(['layout.documentGrid', { ...(apply === 'section' ? { index } : {}), type: g.type === 'default' ? 'none' : g.type, linePitch: g.linePitch,
      ...(g.type === 'default' || g.type === 'lines' ? {} : { charsPerLine: g.charsPerLine }) }]);
  }
  return steps;
}

/** The form's values for the section at index `i` of the open Document. */
function initial(ed, i, paper) {
  const { doc } = ed.state;
  const list = sectionsOf(doc);
  const sect = withDefaults(storedSect(doc, list[i], defaultSect(paper)));
  const st = doc.attrs.settings ?? {};
  const multiple = st.bookFold ? (st.bookFold.reverse ? 'reverseBookFold' : 'bookFold') : st.printTwoOnOne ? 'twoOnOne' : st.mirrorMargins ? 'mirror' : 'normal';
  return {
    w: sect.w, h: sect.h, orient: sect.orient ?? (sect.w > sect.h ? 'landscape' : 'portrait'),
    margin: Object.fromEntries(MARGIN_KEYS.map((k) => [k, sect.margin[k] ?? 0])),
    // The kind of the break before the section decides how it starts (§1.8); sect.type only mirrors it.
    start: i ? doc.nodeAt(list[i - 1].holder)?.attrs.kind ?? sect.type ?? 'nextPage' : 'nextPage', titlePg: !!sect.titlePg, vAlign: sect.vAlign ?? 'top', noEndnote: !!sect.noEndnote,
    docGrid: { ...GRID_DEFAULT, ...sect.docGrid },
    gutterAtTop: !!st.gutterAtTop, evenOdd: !!st.evenAndOddHeaders, multiple, sheets: st.bookFold?.sheets ?? 0,
  };
}

/** The document settings `multiple` and `sheets` stand for. */
const pagesOf = (multiple, sheets) => ({
  mirrorMargins: multiple === 'mirror',
  printTwoOnOne: multiple === 'twoOnOne',
  bookFold: multiple === 'bookFold' || multiple === 'reverseBookFold' ? { sheets, reverse: multiple === 'reverseBookFold' } : null,
});

/** The change from `a` to `b` → {sect, start, settings} patches holding only what the user changed. */
function changes(a, b) {
  const sect = {};
  // Orientation and paper travel as operations (applyPageSetup turns and sizes each target section), so a section that already had
  // another orientation keeps its own margins. Margins count as changed against `a` turned the same way.
  const turned = orientSect(a, b.orient);
  const pair = (x) => `${Math.min(x.w, x.h)}x${Math.max(x.w, x.h)}`;
  if (a.orient !== b.orient) sect.orient = b.orient;
  if (pair(a) !== pair(b)) sect.paper = { w: round(b.w), h: round(b.h) };
  const margin = Object.fromEntries(MARGIN_KEYS.filter((k) => turned.margin[k] !== b.margin[k]).map((k) => [k, round(b.margin[k])]));
  if (Object.keys(margin).length) sect.margin = margin;
  for (const k of ['titlePg', 'vAlign', 'noEndnote']) if (a[k] !== b[k]) sect[k] = b[k];
  if (JSON.stringify(a.docGrid) !== JSON.stringify(b.docGrid)) sect.docGrid = b.docGrid;
  const settings = {};
  if (a.gutterAtTop !== b.gutterAtTop) settings.gutterAtTop = b.gutterAtTop;
  if (a.evenOdd !== b.evenOdd) settings.evenAndOddHeaders = b.evenOdd;
  if (a.multiple !== b.multiple || a.sheets !== b.sheets) Object.assign(settings, pagesOf(b.multiple, b.sheets));
  return { sect, start: a.start !== b.start ? b.start : undefined, settings };
}

/** A button that runs tooling row `id` (a canvas draft's Borders: the Page Borders row, which opens Borders and Shading where
 * it reads the engine), drawn disabled with the row's reason while it is off. */
function Runs({ label, id }) {
  const spec = commandOf(id);
  const ctx = ctxOf();
  const on = !!spec && (!spec.enabled || spec.enabled(ctx));
  const button = (
    <Button type="button" variant="outline" size="sm" disabled={!on} {...accessProps(label)} onClick={() => runTool(id)}>
      <span><AccessText label={label} /></span>
    </Button>
  );
  return on ? button : <Tip title={spec?.reason?.(ctx) ?? 'Not on the canvas engine yet.'}>{button}</Tip>;
}

/** A button that opens another package's dialog over this one, drawn disabled with the pending reason until that dialog exists. */
function Opens({ label, id, props, canvas }) {
  // A canvas draft: these dialogs read the DOM editor, so they wait (their own rows open them on the canvas).
  const there = !!WORD_DIALOGS[id] && !canvas;
  const button = (
    <Button type="button" variant="outline" size="sm" disabled={!there} {...accessProps(label)} onClick={() => openDialog(id, props)}>
      <span><AccessText label={label} /></span>
    </Button>
  );
  // A disabled button takes no pointer events, so the reason sits on a wrapper (as the ribbon's menus do).
  return there ? button : <Tip title={canvas ? 'Not on the canvas engine yet.' : REASONS.pending}>{button}</Tip>;
}

/** A small page with its text area, drawn to the paper's proportions. */
function PagePreview({ v }) {
  const k = 90 / Math.max(v.w, v.h, 1);
  const m = v.margin;
  const g = m.gutter ?? 0;
  const pad = { top: (Math.abs(m.top) + (v.gutterAtTop ? g : 0)) * k, bottom: Math.abs(m.bottom) * k, left: (Math.abs(m.left) + (v.gutterAtTop ? 0 : g)) * k, right: Math.abs(m.right) * k };
  return (
    <div className="grid h-28 place-items-center">
      <div className="relative border border-neutral-400 bg-white shadow-sm" style={{ width: v.w * k, height: v.h * k }}>
        <div className="absolute flex flex-col gap-0.5 overflow-hidden" style={{ ...Object.fromEntries(Object.entries(pad).map(([s, x]) => [s, Math.max(0, x)])) }}>
          {Array.from({ length: 12 }, (_, i) => <div key={i} className="h-0.5 shrink-0 bg-neutral-300" />)}
        </div>
      </div>
    </div>
  );
}

export function PageSetupDialog({ tab, focus, section, engine, onClose }) {
  const ctx = ctxOf();
  const ed = ctx.ed;
  const unit = useUnit();
  const paper = ctx.settings?.paper;
  // Fixed at opening: the section shown, the selection Apply to works from, and the starting values.
  const [setup] = useState(() => {
    if (engine?.sect) return { index: engine.sect.index ?? 0, sel: null, apply: engineApply(engine.sect, section != null), start: engineInitial(engine) };
    if (!ed) return null;
    const { doc, selection } = ed.state;
    const list = sectionsOf(doc);
    const index = section ?? sectionAt(list, selection.from).index;
    const sel = section == null ? { from: selection.from, to: selection.to, empty: selection.empty }
      : { from: list[index].holder ?? list[index].from, to: list[index].holder ?? list[index].from, empty: true };
    // From a break: This section or the whole document (This point forward would put a break in front of it, an empty section).
    const apply = section == null ? applyToOptions(doc, sel) : { options: ['section', 'whole'], value: 'section' };
    return { index, sel, apply, start: initial(ed, index, paper) };
  });
  const [v, setV] = useState(() => setup?.start);
  const [apply, setApply] = useState(() => setup?.apply.value);
  const [shown, setShown] = useState(() => ({ paper: 'paper', layout: 'layout', documentGrid: 'documentGrid' })[tab ?? focus] ?? 'margins');
  if (!setup) {
    queueMicrotask(() => onClose(null));
    return null;
  }

  const set = (patch) => setV((o) => ({ ...o, ...patch }));
  const setMargin = (k) => (pt) => setV((o) => ({ ...o, margin: { ...o.margin, [k]: pt } }));
  const inside = v.multiple !== 'normal';
  // Orientation turns the paper and its margins in the boxes, as Word's dialog does.
  const orient = (o) => setV((old) => ({ ...old, ...orientSect(old, o) }));
  const pickPaper = (key) => {
    if (!(key in PAPERS)) return;
    const [, a, b] = PAPERS[key];
    set(v.orient === 'landscape' ? { w: Math.max(a, b), h: Math.min(a, b) } : { w: Math.min(a, b), h: Math.max(a, b) });
  };
  const size = (k) => (pt) => setV((o) => {
    const next = { ...o, [k]: pt };
    return { ...next, orient: next.w > next.h ? 'landscape' : 'portrait' };
  });
  const grid = (patch) => set({ docGrid: { ...v.docGrid, ...patch } });

  const validate = () => checkSetup(v, unit);
  const result = () => {
    const { sect, start, settings } = changes(setup.start, v);
    if (engine) {
      const steps = engineSteps(engine, setup.start, v, apply);
      if (steps.length) {
        Promise.resolve(ctx.engine?.execMany(steps)).then((r) => r?.ok === false && toast(`Could not change the page setup: ${r.error ?? 'the engine refused it'}`, true))
          .catch((e) => toast(`Could not change the page setup: ${e?.message ?? e}`, true));
      }
    } else ed.chain().focus().command(({ tr }) => {
      applyPageSetup(tr, { apply, sel: setup.sel, sect, start, settings }, defaultSect(paper));
      return true;
    }).run();
    // Margins that match no preset become the Margins menu's Last Custom Setting.
    if (sect.margin && !presetOf(v, v.multiple === 'mirror')) {
      const m = v.margin;
      saveWord({ lastMargins: { top: round(m.top), bottom: round(m.bottom), left: round(m.left), right: round(m.right), mirror: v.multiple === 'mirror' } })
        .catch(() => {});
    }
    return null;
  };
  const setDefault = async () => {
    const message = checkSetup(v, unit);
    if (message) return toast(message, true);
    const yes = await confirmDialog({ title: 'Use these page settings for new documents?', description: 'Documents you have now keep their own.', confirmText: 'Yes' });
    if (!yes) return;
    const word = ctx.settings?.word ?? {};
    const m = Object.fromEntries(MARGIN_KEYS.map((k) => [k, round(v.margin[k])]));
    await saveWord({ newDocument: { ...word.newDocument, pageSetup: { w: round(v.w), h: round(v.h), orient: v.orient, margin: m, mirrorMargins: v.multiple === 'mirror', gutterAtTop: v.gutterAtTop } } });
  };

  const len = (label, k, disabled) => (
    <div className={disabled ? 'pointer-events-none opacity-50' : undefined}><Spin label={label} value={v.margin[k]} onChange={setMargin(k)} unit="len" width="7rem" /></div>
  );
  const preview = (more) => (
    <Fieldset legend="Preview">
      <div className="flex items-end gap-3">
        <div className="flex flex-col gap-2">
          <PagePreview v={v} />
          <Row label="Appl&y to:" htmlFor="pageSetupApply">
            <Pick id="pageSetupApply" value={apply} onChange={setApply} options={setup.apply.options.map((o) => [o, APPLY_LABELS[o]])} />
          </Row>
        </div>
        <div className="ml-auto flex gap-2">{more}</div>
      </div>
    </Fieldset>
  );

  const tabs = [
    { id: 'margins', label: 'Margins', render: () => (
      <>
        <Fieldset legend="Margins">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 [&_label]:w-24">
            {len('&Top:', 'top')}{len('&Bottom:', 'bottom')}
            {len(inside ? 'I&nside:' : '&Left:', 'left')}{len(inside ? '&Outside:' : '&Right:', 'right')}
            {len('&Gutter:', 'gutter')}
            <Row label="G&utter position:" htmlFor="pageSetupGutterPos">
              <Pick id="pageSetupGutterPos" value={v.gutterAtTop ? 'top' : 'left'} disabled={inside} onChange={(x) => set({ gutterAtTop: x === 'top' })}
                options={[['left', 'Left'], ['top', 'Top']]} />
            </Row>
          </div>
        </Fieldset>
        <Fieldset legend="Orientation">
          <div className="[&_[role=radiogroup]]:flex-row [&_[role=radiogroup]]:gap-6">
            <Radio name="pageSetupOrient" value={v.orient} onChange={orient} options={[['portrait', '&Portrait'], ['landscape', 'Land&scape']]} />
          </div>
        </Fieldset>
        <Fieldset legend="Pages">
          <div className="flex flex-wrap items-center gap-4">
            <Row label="&Multiple pages:" htmlFor="pageSetupMultiple">
              <Pick id="pageSetupMultiple" value={v.multiple} onChange={(x) => set({ multiple: x })} options={MULTIPLE} />
            </Row>
            {(v.multiple === 'bookFold' || v.multiple === 'reverseBookFold') && (
              <Row label="Sheets per booklet:" htmlFor="pageSetupSheets">
                <Pick id="pageSetupSheets" value={v.sheets} onChange={(x) => set({ sheets: Number(x) })} options={SHEETS} />
              </Row>
            )}
          </div>
        </Fieldset>
        {preview()}
      </>
    ) },
    { id: 'paper', label: 'Paper', render: () => (
      <>
        <Row label="Pape&r size:" htmlFor="pageSetupPaper">
          <Pick id="pageSetupPaper" value={paperOf(v) ?? 'custom'} onChange={pickPaper}
            options={[...Object.entries(PAPERS).map(([k, [label]]) => [k, label]), ['custom', 'Custom size']]} />
        </Row>
        <div className="flex flex-col gap-2 [&_label]:w-14">
          <Spin label="&Width:" value={v.w} onChange={size('w')} unit="len" />
          <Spin label="H&eight:" value={v.h} onChange={size('h')} unit="len" />
        </div>
        <Fieldset legend="Paper source">
          <div className="grid grid-cols-2 gap-4" title={REASONS.printer}>
            {['&First page:', '&Other pages:'].map((label) => (
              <div key={label} className="flex flex-col gap-1 opacity-50">
                <AccessText label={label} />
                <div role="listbox" aria-disabled="true" aria-label={label.replace('&', '')} className="h-24 rounded-md border border-input bg-background px-1.5 py-0.5 text-xs">Default tray</div>
              </div>
            ))}
          </div>
        </Fieldset>
        {preview(<Opens label="Prin&t Options..." id="wordOptions" props={{ tab: 'display' }} />)}
      </>
    ) },
    { id: 'layout', label: 'Layout', render: () => (
      <>
        <Fieldset legend="Section">
          <Row label="Section sta&rt:" htmlFor="pageSetupStart">
            <Pick id="pageSetupStart" value={v.start} onChange={(x) => set({ start: x })} options={STARTS} />
          </Row>
          <Check label="S&uppress endnotes" checked={v.noEndnote} onChange={(x) => set({ noEndnote: x })}
            disabled={!ed || ed.state.doc.attrs.settings?.endnotePr?.pos !== 'sectEnd'} />
        </Fieldset>
        <Fieldset legend="Headers and footers">
          <Check label="Different &odd and even" checked={v.evenOdd} onChange={(x) => set({ evenOdd: x })} />
          <Check label="Different first &page" checked={v.titlePg} onChange={(x) => set({ titlePg: x })} />
          <div className="flex items-start gap-6 [&_label]:w-16">
            <span className="pt-1">From edge:</span>
            <div className="flex flex-col gap-2">{len('&Header:', 'header')}{len('&Footer:', 'footer')}</div>
          </div>
        </Fieldset>
        <Fieldset legend="Page">
          <Row label="&Vertical alignment:" htmlFor="pageSetupVAlign">
            <Pick id="pageSetupVAlign" value={v.vAlign} onChange={(x) => set({ vAlign: x })} options={VALIGNS} />
          </Row>
        </Fieldset>
        {preview(engine ? <>
          {/* On a canvas draft Line Numbers' choice joins the patch OK writes, to the sections Apply to reaches. */}
          <Button type="button" variant="outline" size="sm" {...accessProps('Line &Numbers...')} onClick={async () => {
            const ln = await openDialog('lineNumbers', { value: v.lineNumbers ?? lineNumbersOf(engine.sect.lineNumbers) });
            if (ln) set({ lineNumbers: ln });
          }}><span><AccessText label="Line &Numbers..." /></span></Button>
          <Runs label="&Borders..." id="design.pageBackground.pageBorders" />
        </> : <>
          <Opens label="Line &Numbers..." id="lineNumbers" props={{ section: setup.index }} />
          <Opens label="&Borders..." id="bordersAndShading" props={{ tab: 'pageBorder' }} />
        </>)}
      </>
    ) },
    { id: 'documentGrid', label: 'Document Grid', render: () => {
      const g = v.docGrid;
      const chars = g.type === 'linesAndChars' || g.type === 'snapToChars';
      const lines = g.type !== 'default';
      return (
        <>
          <Fieldset legend="Text flow">
            <div className="flex items-center gap-4" title={REASONS.verticalText}>
              <span>Direction:</span>
              <label className="flex items-center gap-2"><RadioInput checked readOnly /> <span><AccessText label="Hori&zontal" /></span></label>
              <label className="flex items-center gap-2 opacity-50"><RadioInput disabled /> <span><AccessText label="&Vertical" /></span></label>
            </div>
            {/* Text columns are set by Layout > Columns, so this box shows 1 and waits for that package. */}
            <div className="pointer-events-none mt-2 opacity-50" title={REASONS.pending}>
              <Spin label="&Columns:" value={1} onChange={() => {}} unit="int" min={1} max={1} width="5rem" />
            </div>
          </Fieldset>
          <Fieldset legend="Grid">
            <div className="grid grid-cols-2 [&_[role=radiogroup]]:contents">
              <Radio name="pageSetupGrid" value={g.type} onChange={(x) => grid({ type: x })} options={GRIDS} />
            </div>
          </Fieldset>
          <Fieldset legend="Characters">
            <div className={chars ? 'flex gap-6' : 'pointer-events-none flex gap-6 opacity-50'}>
              <div className="flex items-end gap-2">
                <Spin label="P&er line:" value={g.charsPerLine} onChange={(x) => grid({ charsPerLine: Math.round(x) })} unit="int" min={1} max={41} width="5rem" />
                <span className="pb-1">(1-41)</span>
              </div>
              <div className="flex flex-col gap-2">
                <div className={g.defaultPitch ? 'pointer-events-none opacity-50' : undefined}>
                  <Spin label="P&itch:" value={g.charPitch} onChange={(x) => grid({ charPitch: x })} unit="pt" min={1} max={1584} width="5rem" />
                </div>
                {/* Word's default pitch follows the Normal style's font size; ours is the 12 pt the grid starts with. */}
                <Check label="Use def&ault pitch" checked={g.defaultPitch} onChange={(x) => grid(x ? { defaultPitch: true, charPitch: GRID_DEFAULT.charPitch } : { defaultPitch: false })} />
              </div>
            </div>
          </Fieldset>
          <Fieldset legend="Lines">
            <div className={lines ? 'flex gap-6' : 'pointer-events-none flex gap-6 opacity-50'}>
              <div className="flex items-end gap-2">
                <Spin label="Pe&r page:" value={g.linesPerPage} onChange={(x) => grid({ linesPerPage: Math.round(x) })} unit="int" min={1} max={42} width="5rem" />
                <span className="pb-1">(1-42)</span>
              </div>
              <Spin label="Pi&tch:" value={g.linePitch} onChange={(x) => grid({ linePitch: x })} unit="pt" min={1} max={1584} width="5rem" />
            </div>
          </Fieldset>
          {/* Set Font picks the grid's own font, which nothing stores yet: no id, so it stays disabled with the pending reason. */}
          {preview(<><Opens label="Dra&wing Grid..." id="gridSettings" /><Opens label="Set &Font..." /></>)}
        </>
      );
    } },
  ];

  return (
    <WordDialog title="Page Setup" tabs={tabs} tab={shown} onTab={setShown} size="md" validate={validate} result={result} onClose={onClose}
      left={[{ label: 'Set As &Default', onClick: setDefault }]} />
  );
}
