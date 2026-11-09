// Manage Styles (tabs edit, recommend, restrict, setDefaults), the Organizer, Style Pane Options and Assign Value
// (docs/plans/word briefs/style-panes.md; labels, items and defaults from probe/dialogs/manage-styles.json and
// style-pane-options.json). Each writes the document in one undoable step on OK; Delete, Modify and the Organizer's Copy act at
// once, as Word's do.
import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioInput } from '@/components/ui/radio';
import { getState, useStore } from '../../../app/store.js';
import { deepPatch } from '../../../office.mjs';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Fieldset, Pick, Preview, rowClass, Row, Spin, useUnit } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { useWordCtx } from '../../../tooling/registry.js';
import { saveWord } from '../../word/settings.mjs';
import {
  allStyles, filterStyles, infoOf, isBuiltIn, nameOf, PANE_FILTER, patchStyles, recommendPatch, restrictPatch, SHOW, shownPriority, SORTS, sortStyles,
  styleDescription, visibilityOf, withCopies, DEFAULT_FONT,
} from './model.mjs';
import { askStyle, deleteStyle, openDlg, writeStyles } from './ops.js';
import { countsOf, previewCss } from './StylesPane.jsx';
import { canvasEd } from './canvas-ed.mjs';

const SCOPES = [['doc', 'Only in this document'], ['new', 'New documents based on this template']];

/** A list where a click picks one row, Ctrl+click adds or removes one and Shift+click a run, as Word's style lists do. */
function MultiList({ rows, sel, onSel, label, height = '10rem' }) {
  const [anchor, setAnchor] = useState(null);
  const click = (e, id) => {
    const ids = rows.map((r) => r.id);
    if (e.shiftKey && anchor) {
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
      onSel(ids.slice(a, b + 1));
    } else if (e.ctrlKey || e.metaKey) onSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
    else onSel([id]);
    if (!e.shiftKey) setAnchor(id);
  };
  return (
    <div role="listbox" aria-label={label} aria-multiselectable style={{ height }} className="overflow-auto rounded-md border border-input bg-background text-xs">
      {rows.map((r) => (
        <div key={r.id} role="option" data-style-item={r.id} aria-selected={sel.includes(r.id)} onClick={(e) => click(e, r.id)}
          className={cn('flex cursor-default items-center gap-1 truncate px-1.5 py-0.5', rowClass(sel.includes(r.id)))}>
          {r.label}
        </div>
      ))}
    </div>
  );
}

const ALIGNS = [['left', 'Left'], ['center', 'Centered'], ['right', 'Right'], ['justify', 'Justified'], ['distribute', 'Distributed']];
const SPECIAL = [['none', '(none)'], ['firstLine', 'First line'], ['hanging', 'Hanging']];
const LINES = [['single', 'Single'], ['1.5', '1.5 lines'], ['double', 'Double'], ['atLeast', 'At least'], ['exact', 'Exactly'], ['multiple', 'Multiple']];
const lineKind = (l) => (!l ? 'multiple' : l.rule === 'exact' ? 'exact' : l.rule === 'atLeast' ? 'atLeast' : ({ 1: 'single', 1.5: '1.5', 2: 'double' }[l.value] ?? 'multiple'));
const lineOf = (kind, at) => ({ single: { rule: 'auto', value: 1 }, '1.5': { rule: 'auto', value: 1.5 }, double: { rule: 'auto', value: 2 },
  atLeast: { rule: 'atLeast', value: at > 3 ? at : 12 }, exact: { rule: 'exact', value: at > 3 ? at : 12 }, multiple: { rule: 'auto', value: at > 0 && at <= 3 ? at : 1.15 } }[kind]);
const THEME_FONTS = [['+minor', '+Body'], ['+major', '+Headings']];
const fontShown = (f) => THEME_FONTS.find(([v]) => v === f)?.[1] ?? f ?? '';
const fontRead = (t) => THEME_FONTS.find(([, l]) => l.toLowerCase() === t.trim().toLowerCase())?.[0] ?? (t.trim() || null);
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** A labelled text box with a list of suggestions (Word's editable combo boxes). */
function Combo({ label, value, onChange, options, width = '11rem' }) {
  const id = `wsp-${label.replace(/\W/g, '')}`;
  return (
    <Row label={label} htmlFor={id}>
      <Input id={id} size="xs" style={{ width }} value={value} list={`${id}-list`} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <datalist id={`${id}-list`}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </Row>
  );
}

/** Set Defaults: the document defaults (doc.attrs.styles.defaults) Normal and every style build on. */
function SetDefaults({ defs, setDefs, theme }) {
  const run = defs.run ?? {};
  const para = defs.para ?? {};
  const ind = para.indent ?? {};
  const sp = para.spacing ?? {};
  const setRun = (patch) => setDefs({ ...defs, run: { ...run, ...patch } });
  const setPara = (patch) => setDefs({ ...defs, para: deepPatch(para, patch) });
  const special = ind.firstLine > 0 ? 'firstLine' : ind.firstLine < 0 ? 'hanging' : 'none';
  const kind = lineKind(sp.line);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Combo label="Latin text f&ont:" value={fontShown(run.font)} onChange={(t) => setRun({ font: fontRead(t) })}
          options={['+Body', '+Headings', theme?.fonts?.minor, theme?.fonts?.major].filter(Boolean)} />
        <Combo label="Si&ze:" width="5rem" value={String(run.size ?? '')} onChange={(t) => setRun({ size: Number(t) > 0 ? Math.min(1638, Math.round(Number(t) * 2) / 2) : run.size })}
          options={SIZES.map(String)} />
        <Combo label="Asian &text font:" value={run.fontEA ?? '+Body Asian'} onChange={(t) => setRun({ fontEA: t.trim() && t.trim() !== '+Body Asian' ? t.trim() : null })} options={['+Body Asian']} />
        <Row label="Font &color:"><ColorPick value={run.color ?? null} themeColor={run.themeColor ?? null} onChange={(color, themeColor) => setRun({ color, themeColor })} /></Row>
      </div>
      <Fieldset legend="Paragraph Position">
        <div className="flex flex-wrap items-center gap-3">
          <Spin label="&Left:" unit="len" value={ind.left ?? 0} onChange={(v) => setPara({ indent: { left: v } })} />
          <Spin label="&Right:" unit="len" value={ind.right ?? 0} onChange={(v) => setPara({ indent: { right: v } })} />
          <Row label="S&pecial:"><Pick value={special} options={SPECIAL} onChange={(v) => setPara({ indent: { firstLine: v === 'none' ? null : v === 'hanging' ? -Math.abs(ind.firstLine || 36) : Math.abs(ind.firstLine || 36) } })} /></Row>
          {special !== 'none' && <Spin label="B&y:" unit="len" min={0} value={Math.abs(ind.firstLine)} onChange={(v) => setPara({ indent: { firstLine: special === 'hanging' ? -v : v } })} />}
        </div>
        <Row label="Ali&gnment:"><Pick value={para.textAlign ?? 'left'} options={ALIGNS} onChange={(v) => setPara({ textAlign: v === 'left' ? null : v })} /></Row>
      </Fieldset>
      <Fieldset legend="Paragraph Spacing">
        <div className="flex flex-wrap items-center gap-3">
          <Spin label="&Before:" unit="pt" min={0} value={sp.before ?? 0} onChange={(v) => setPara({ spacing: { before: v } })} />
          <Spin label="&After:" unit="pt" min={0} value={sp.after ?? 0} onChange={(v) => setPara({ spacing: { after: v } })} />
          <Row label="Li&ne spacing:"><Pick value={kind} options={LINES} onChange={(v) => setPara({ spacing: { line: lineOf(v, sp.line?.value) } })} /></Row>
          {['atLeast', 'exact', 'multiple'].includes(kind) && (
            <Spin label="&At:" unit={kind === 'multiple' ? 'int' : 'pt'} step={kind === 'multiple' ? 0.01 : 1} min={0} value={sp.line?.value ?? 1.15}
              onChange={(v) => setPara({ spacing: { line: { rule: sp.line?.rule ?? 'auto', value: v } } })} />
          )}
        </div>
      </Fieldset>
    </>
  );
}

const PROTECT = [['formatting', '&Limit formatting to permitted styles'], ['autoFormatOverride', 'Allow A&utoFormat to override formatting'],
  ['lockTheme', 'Block Theme or Scheme s&witching'], ['lockQFSet', 'Bloc&k switching to a different style set']];

/** A canvas stand-in's refusal: say why, and draw the engine's styles it read back. */
const refusedBy = (ctx, redraw) => (error) => {
  ctx.toast(`Could not save the styles: ${error}`);
  redraw((n) => n + 1);
};

/** Manage Styles. `tab` opens it on edit, recommend, restrict or setDefaults (Design's Custom Paragraph Spacing opens setDefaults). */
export function ManageStylesDialog({ tab = 'edit', onClose, canvas = null }) {
  const ctx = useWordCtx();
  // On a canvas draft the row reads the engine's styles first (`canvas`: {attrs, counts}) and a stand-in writes to the engine.
  const [, redraw] = useState(0);
  const [stand] = useState(() => (canvas && ctx.engine ? canvasEd(ctx.engine, canvas.attrs, canvas.counts, refusedBy(ctx, redraw)) : null));
  const ed = stand ?? ctx.ed;
  const unit = useUnit();
  const docStyles = ed?.state.doc.attrs.styles;
  const settings = ed?.state.doc.attrs.settings;
  const [current, setCurrent] = useState(tab);
  const [patch, setPatch] = useState({}); // pending Recommend and Restrict edits, {id: fields}
  const [sel, setSel] = useState(['Normal']);
  const [sort, setSort] = useState('recommended');
  const [recOnly, setRecOnly] = useState(false);
  const [scope, setScope] = useState('doc');
  const [defs, setDefs] = useState(() => structuredClone(docStyles?.defaults ?? {}));
  const [prot, setProt] = useState(() => ({ ...settings?.protection }));
  if (!ed) return null;
  const styles = patchStyles(docStyles, patch);
  const counts = countsOf(ed.state.doc);
  const list = sortStyles(filterStyles(styles, counts, { show: recOnly ? 'recommended' : 'all' }), sort, styles);
  const theme = ed.state.doc.attrs.theme;
  const edit = (p) => setPatch((old) => {
    const out = { ...old };
    for (const [id, f] of Object.entries(p)) out[id] = { ...out[id], ...f };
    return out;
  });
  const rows = (labelOf) => list.map((s) => ({ id: s.id, label: labelOf(s) }));
  const one = sel[0] ?? 'Normal';
  const oneStyle = list.find((s) => s.id === one) ?? { id: one };
  const head = (
    <div className="flex items-center gap-4">
      <Row label="S&ort order:"><Pick value={sort} options={SORTS} onChange={setSort} /></Row>
      <Check label="Show recommended st&yles only" checked={recOnly} onChange={setRecOnly} />
    </div>
  );
  const scopeRow = <Radio2 value={scope} onChange={setScope} />;
  const btn = (label, onClick, disabled) => (
    <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onClick} {...accessProps(label)}><AccessText label={label} /></Button>
  );
  const tabs = [
    { id: 'edit', label: '&Edit', render: () => (
      <>
        {head}
        <Fieldset legend="Select a style to edit">
          <MultiList label="Styles" rows={rows((s) => `${nameOf(s)}${visibilityOf(s)}`)} sel={sel} onSel={(ids) => setSel(ids.slice(-1))} />
        </Fieldset>
        <Fieldset legend={`Preview of ${nameOf(oneStyle)}:`}>
          <Preview height="4rem"><span style={previewCss(styles, theme, one)}>AaBbCcDdEeXxYyZz</span></Preview>
          <div className="flex gap-2">
            {btn('&Modify...', () => openDlg(ctx, 'modifyStyle', { styleId: one }))}
            {btn('&Delete', () => deleteStyle(ed, one).then((ok) => ok && setSel(['Normal'])), isBuiltIn(one))}
          </div>
          <p data-style-description="" className="text-xs text-muted-foreground">{styleDescription(styles, one, { unit, theme })}</p>
          {btn('&New Style...', () => openDlg(ctx, 'createNewStyleFromFormatting'))}
        </Fieldset>
        {scopeRow}
      </>
    ) },
    { id: 'recommend', label: '&Recommend', render: () => (
      <>
        {head}
        <p className="text-xs">Select one or more styles to set whether the style appears by default in the recommended list and the order in which the styles appear</p>
        <MultiList label="Styles" rows={rows((s) => `${shownPriority(s)} ${nameOf(s)}${visibilityOf(s)}`)} sel={sel} onSel={setSel} />
        <div className="flex gap-2">{btn('Select &All', () => setSel(list.map((s) => s.id)))}{btn('Select &Built-in', () => setSel(list.filter((s) => isBuiltIn(s.id)).map((s) => s.id)))}</div>
        <Fieldset legend="Set priority to use when sorting in recommended order">
          <div className="flex flex-wrap gap-2">
            {btn('&Move Up', () => edit(recommendPatch(styles, sel, 'up')))}
            {btn('Move &Down', () => edit(recommendPatch(styles, sel, 'down')))}
            {btn('Make &Last', () => edit(recommendPatch(styles, sel, 'last')))}
            {btn('Assign &Value...', async () => {
              const v = await ctx.dialog('assignStyleValue', { value: shownPriority(oneStyle) });
              if (v != null) edit(recommendPatch(styles, sel, { value: v }));
            })}
          </div>
        </Fieldset>
        <Fieldset legend="Set whether style shows when viewing recommended styles">
          <div className="flex flex-wrap gap-2">
            {btn('Sho&w', () => edit(recommendPatch(styles, sel, 'show')))}
            {btn('Hide &until used', () => edit(recommendPatch(styles, sel, 'hideUntilUsed')))}
            {btn('&Hide', () => edit(recommendPatch(styles, sel, 'hide')))}
          </div>
        </Fieldset>
        {scopeRow}
      </>
    ) },
    { id: 'restrict', label: 'Re&strict', render: () => (
      <>
        {head}
        <p className="text-xs">Select one or more styles to set their availability when a document is protected for formatting changes</p>
        <MultiList label="Styles" sel={sel} onSel={setSel}
          rows={list.map((s) => ({ id: s.id, label: <>{s.locked ? <Lock aria-label="Restricted" className="size-3" /> : <span className="w-3" />}{nameOf(s)}{visibilityOf(s)}</> }))} />
        <div className="flex gap-2">
          {btn('Select &Visible', () => setSel(list.filter((s) => !s.semiHidden).map((s) => s.id)))}
          {btn('Select &Built-in', () => setSel(list.filter((s) => isBuiltIn(s.id)).map((s) => s.id)))}
          {btn('Select &All', () => setSel(list.map((s) => s.id)))}
        </div>
        <p className="text-xs">Set availability of selected styles</p>
        <div className="flex gap-2">
          {btn('&Permit', () => edit(restrictPatch(sel, false)), !sel.some((id) => styles.list?.[id]?.locked))}
          {btn('Restri&ct', () => edit(restrictPatch(sel, true)), sel.every((id) => styles.list?.[id]?.locked))}
        </div>
        {PROTECT.map(([k, label]) => (
          <Check key={k} label={label} checked={!!prot[k]} disabled={k === 'autoFormatOverride' && !prot.formatting} onChange={(v) => setProt({ ...prot, [k]: v })} />
        ))}
        {scopeRow}
      </>
    ) },
    { id: 'setDefaults', label: 'Set De&faults', render: () => (
      <>
        <SetDefaults defs={defs} setDefs={setDefs} theme={theme} />
        {scopeRow}
      </>
    ) },
  ];
  const result = () => {
    const now = ed.state.doc.attrs.styles; // newer than docStyles when Modify or Delete ran meanwhile
    const protChanged = PROTECT.some(([k]) => !!prot[k] !== !!settings?.protection?.[k]);
    // Defaults are written only when this dialog changed them, so a change another dialog made meanwhile survives.
    const defsChanged = JSON.stringify(defs) !== JSON.stringify(docStyles?.defaults ?? {});
    const final = { ...patchStyles(now, patch), ...(defsChanged && { defaults: defs }) };
    if (Object.keys(patch).length || defsChanged || protChanged) ed.chain().command(({ tr }) => {
      if (Object.keys(patch).length || defsChanged) tr.setDocAttribute('styles', final);
      if (protChanged) tr.setDocAttribute('settings', deepPatch(tr.doc.attrs.settings ?? {}, { protection: Object.fromEntries(PROTECT.map(([k]) => [k, !!prot[k]])) }));
      return true;
    }).run();
    if (scope === 'new') {
      const nd = ctx.settings?.word?.newDocument?.styles ?? {};
      const changed = Object.fromEntries(Object.keys(patch).map((id) => [id, final.list[id]]));
      saveWord({ newDocument: { styles: { defaults: defs, list: { ...nd.list, ...changed } } } });
    }
    return true;
  };
  return (
    <WordDialog title="Manage Styles" size="lg" tabs={tabs} tab={current} onTab={setCurrent} result={result} onClose={onClose}
      left={[{ label: 'Import/E&xport...', onClick: () => ctx.run('styles.organizer') }]} />
  );
}

/** Word's two scope radios under every Manage Styles tab and Style Pane Options. */
function Radio2({ value, onChange, newDisabled = false }) {
  return (
    <div role="radiogroup" className="flex gap-4">
      {SCOPES.map(([v, label]) => (
        <label key={v} className={cn('flex items-center gap-2', v === 'new' && newDisabled && 'opacity-50')} title={v === 'new' && newDisabled ? 'Not built yet.' : undefined}>
          <RadioInput checked={value === v} disabled={v === 'new' && newDisabled} onChange={() => onChange(v)} />
          {label}
        </label>
      ))}
    </div>
  );
}

/** Assign Value...: the priority (1 to 100, as shown) for the selected styles. */
export function AssignValueDialog({ value = 1, onClose }) {
  const [v, setV] = useState(value);
  return (
    <WordDialog title="Assign Value" size="sm" result={() => v} onClose={onClose}>
      <Spin label="&Value:" unit="int" min={1} max={100} value={v} onChange={setV} />
    </WordDialog>
  );
}

/** Word's Yes/No message box for Delete and the Organizer's overwrite, through the kit so it stacks over Manage Styles or the
 * Organizer and centres like them. The kit's second button says Cancel where Word's says No. */
export function StyleQuestionDialog({ text, onClose }) {
  return (
    <WordDialog title="Styles" size="sm" okText="Yes" onClose={onClose}>
      <p>{text}</p>
    </WordDialog>
  );
}

/** The Organizer: this document's styles and another Document's (picked from the user's Documents), Copy (into this document),
 * Delete and Rename (here). The other draft is read once per pick through the drafts API. */
export function OrganizerDialog({ onClose, canvas = null }) {
  const ctx = useWordCtx();
  const [, redraw] = useState(0); // the stand-in's styles change in place: draw again after a write
  const [stand] = useState(() => (canvas && ctx.engine ? canvasEd(ctx.engine, canvas.attrs, canvas.counts, refusedBy(ctx, redraw)) : null));
  const ed = stand ?? ctx.ed;
  const here = getState().draft?.id;
  const stored = useStore((s) => s.drafts);
  const [listed, setListed] = useState(null); // the drafts API's list, read once: the store's list can be one project's
  useEffect(() => {
    Promise.resolve(window.api?.drafts?.list?.()).then((l) => setListed(Array.isArray(l) ? l : null), () => {});
  }, []);
  const others = (listed ?? stored ?? []).filter((d) => d.format === 'document' && d.id !== here);
  const [picked, setOther] = useState(null);
  const other = picked ?? others[0]?.id ?? null;
  const [theirs, setTheirs] = useState(null);
  const [selL, setSelL] = useState([]);
  const [selR, setSelR] = useState([]);
  const [renaming, setRenaming] = useState(null); // the new name while Rename is open
  useEffect(() => {
    let live = true;
    setTheirs(null);
    setSelR([]);
    if (other) Promise.resolve(window.api?.drafts?.load(other)).then((d) => live && setTheirs(d?.doc?.attrs?.styles ?? { list: {} }), () => live && setTheirs({ list: {} }));
    return () => {
      live = false;
    };
  }, [other]);
  if (!ed) return null;
  const mine = ed.state.doc.attrs.styles;
  const rowsOf = (styles) => sortStyles(allStyles(styles).filter((s) => s.id !== DEFAULT_FONT.id || styles?.list?.[s.id]), 'name', styles)
    .map((s) => ({ id: s.id, label: nameOf(s) }));
  const copy = async () => {
    const ids = [];
    for (const id of selR.filter((x) => theirs?.list?.[x])) {
      // Word asks before replacing a style this document already holds (Normal included).
      if (!mine?.list?.[id] || await askStyle(`Do you want to overwrite the existing style entry ${nameOf(infoOf(id, mine.list[id]))}?`)) ids.push(id);
    }
    if (!ids.length) return;
    const copies = Object.fromEntries(ids.map((id) => [id, structuredClone(theirs.list[id])]));
    writeStyles(ed, withCopies(ed.state.doc.attrs.styles, copies));
    setSelL(Object.keys(copies));
    redraw((n) => n + 1);
  };
  const remove = async () => {
    for (const id of selL) await deleteStyle(ed, id);
    setSelL([]);
    redraw((n) => n + 1);
  };
  const rename = () => {
    if (renaming?.trim()) writeStyles(ed, patchStyles(ed.state.doc.attrs.styles, { [selL[0]]: { name: renaming.trim() } }));
    setRenaming(null);
    redraw((n) => n + 1);
  };
  const otherTitle = others.find((d) => d.id === other)?.title;
  return (
    <WordDialog title="Organizer" size="lg" okText="Close" onClose={onClose}>
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3">
        <div className="flex flex-col gap-1">
          <span>In this document:</span>
          <MultiList label="This document's styles" rows={rowsOf(mine)} sel={selL} onSel={(ids) => { setSelL(ids); setSelR([]); }} height="14rem" />
          <span className="text-xs text-muted-foreground">Styles available in this document</span>
        </div>
        <div className="flex flex-col justify-center gap-2">
          <Button type="button" variant="outline" size="sm" data-organizer="copy" disabled={!selR.length} onClick={copy}
            title={selL.length && !selR.length ? 'Copies into this document only.' : undefined}>&lt;- Copy</Button>
          <Button type="button" variant="outline" size="sm" data-organizer="delete" disabled={!selL.length || selL.some(isBuiltIn)} onClick={remove}>Delete</Button>
          <Button type="button" variant="outline" size="sm" data-organizer="rename" disabled={selL.length !== 1} onClick={() => setRenaming(nameOf({ id: selL[0], ...mine.list?.[selL[0]] }))}>Rename...</Button>
        </div>
        <div className="flex flex-col gap-1">
          <Row label="In:">
            <Pick aria-label="Other document" value={other ?? ''} options={others.map((d) => [d.id, d.title || 'Untitled'])} onChange={setOther} width="100%" />
          </Row>
          {theirs ? <MultiList label={`${otherTitle ?? 'Other document'} styles`} rows={rowsOf(theirs)} sel={selR} onSel={(ids) => { setSelR(ids); setSelL([]); }} height="14rem" />
            : <p className="text-xs text-muted-foreground">{others.length ? 'Loading...' : 'No other Documents.'}</p>}
        </div>
      </div>
      {renaming != null && (
        <Row label="New name:" htmlFor="wsp-rename">
          <Input id="wsp-rename" size="xs" autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); rename(); } }} />
          <Button type="button" size="sm" onClick={rename}>Rename</Button>
        </Row>
      )}
    </WordDialog>
  );
}

/** Style Pane Options: which styles the pane shows and in what order, kept in the document's settings as Word keeps them. */
export function StylePaneOptionsDialog({ onClose }) {
  const ctx = useWordCtx();
  const ed = ctx.ed;
  const docSettings = ed?.state.doc.attrs.settings;
  const [f, setF] = useState(() => ({ ...PANE_FILTER, ...docSettings?.stylePaneFormatFilter }));
  const [sort, setSort] = useState(docSettings?.stylePaneSortMethod ?? 'recommended');
  const set = (k) => (v) => setF({ ...f, [k]: v });
  const result = () => ed?.chain().setDocSettings({ stylePaneFormatFilter: f, stylePaneSortMethod: sort }).run();
  return (
    <WordDialog title="Style Pane Options" result={result} onClose={onClose}>
      <Row label="&Select styles to show:"><Pick value={f.show} options={SHOW} onChange={set('show')} width="16rem" /></Row>
      <Row label="S&ort order:"><Pick value={sort} options={SORTS} onChange={setSort} width="16rem" /></Row>
      <Fieldset legend="Select formatting to show as styles:">
        <Check label="&Paragraph level formatting" checked={f.para} onChange={set('para')} />
        <Check label="F&ont formatting" checked={f.font} onChange={set('font')} />
        <Check label="&Bullet and numbering formatting" checked={f.numbering} onChange={set('numbering')} />
      </Fieldset>
      <Fieldset legend="Select how built-in style names are shown">
        <Check label="Sho&w next heading when previous level is used" checked={f.nextHeading} onChange={set('nextHeading')} />
        <Check label="&Hide built-in name when alternate name exists" checked={f.hideBuiltInAlt} onChange={set('hideBuiltInAlt')} />
      </Fieldset>
      <Radio2 value="doc" onChange={() => {}} newDisabled />
    </WordDialog>
  );
}
