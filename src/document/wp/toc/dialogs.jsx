// The toc package's dialogs (plan.md §1.6; labels, items and defaults from probe/dialogs/table-of-contents*.json, table-of-figures*.json,
// caption.json, caption-numbering.json, autocaption.json, new-label.json and mark-table-of-contents-entry.json). Sub-dialogs stack
// through openDialog and resolve to their parent.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { confirmDialog, openDialog, toast } from '../../../app/actions.js';
import { getState } from '../../../app/store.js';
import { commandOf, ctxOf } from '../../../tooling/registry.js';
import { REASONS } from '../../../tooling/reasons.mjs';
import { AccessText, accessProps, TabStrip, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { Check, Fieldset, Pick, Preview, Radio, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { closeHistory } from '@tiptap/pm/history';
import { ensureStyles } from '../../model/styles.mjs';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import {
  AUTO_KINDS, captionPrefix, captionTarget, insertCaption, insertToc, insertTof, markEntry, tableAt, updateTables,
} from './actions.js';
import { LEADERS, NUM_FORMATS, SEPARATORS, TOC_DEFAULTS, TOC_STYLES, TOF_DEFAULTS, TOF_STYLES, tcCode, tocCode, tocState, tofCode, leaderOf } from './toc.mjs';

const ed = () => ctxOf().ed;

// Word's Index and Tables dialog: four tabs, two of them index-toa's (plan.md §1.6 Index and Tables). A tab whose owner has not
// registered its command is drawn disabled.
const INDEX_TABS = [
  ['index', 'Inde&x', 'references.index.insertIndex'],
  ['tableOfContents', 'Table of &Contents', 'references.tableOfContents.tableOfContents.customTableOfContents'],
  ['tableOfFigures', 'Table of &Figures', 'references.captions.insertTableOfFigures'],
  ['tableOfAuthorities', 'Table of &Authorities', 'references.tableOfAuthorities.insertTableOfAuthorities'],
];

/** The four tabs over a table dialog; picking another closes this one and opens that id. */
function IndexTabs({ current, onClose }) {
  const go = (id) => {
    if (id === current) return;
    onClose(null);
    openDialog(id);
  };
  return <TabStrip value={current} onChange={go} tabs={INDEX_TABS.map(([id, label, cmd]) => ({ id, label, disabled: id !== current && !commandOf(cmd) }))} />;
}

const LEADER_CHAR = { none: ' ', dot: '.', hyphen: '-', underscore: '_', middleDot: '·' };
/** Print Preview: three sample entries drawn as the switches would draw them. */
function Sample({ v, rows }) {
  return (
    <Preview height="8rem">
      {rows.map(([text, indent, page]) => (
        <div key={text} className="flex text-[0.7rem] leading-tight" style={{ paddingLeft: `${indent}rem` }}>
          <span className={v.hyperlinks ? 'text-blue-700 underline' : undefined}>{text}</span>
          {v.pageNumbers && (v.rightAlign
            ? <><span className="mx-0.5 flex-1 overflow-hidden whitespace-nowrap">{LEADER_CHAR[v.leader].repeat(80)}</span><span>{page}</span></>
            : <span>&nbsp;{page}</span>)}
        </div>
      ))}
    </Preview>
  );
}

/** The general controls the Table of Contents and Table of Figures tabs share. */
function General({ v, set, formats }) {
  return (
    <>
      <Check label="&Show page numbers" checked={v.pageNumbers} onChange={set('pageNumbers')} />
      <Check label="&Right align page numbers" checked={v.rightAlign} disabled={!v.pageNumbers} onChange={set('rightAlign')} />
      <Row label="Ta&b leader:" htmlFor="toc-leader">
        <Pick id="toc-leader" value={v.leader} options={LEADERS} onChange={set('leader')} disabled={!v.pageNumbers || !v.rightAlign} width="8rem" />
      </Row>
      <Check label="Use &hyperlinks instead of page numbers" checked={v.hyperlinks} onChange={set('hyperlinks')} />
      <Row label="Forma&ts:" htmlFor="toc-format">
        <Pick id="toc-format" value={v.format} options={formats} onChange={set('format')} width="8rem" />
      </Row>
    </>
  );
}

const TOC_FORMAT_LIST = [['template', 'From template'], ['classic', 'Classic'], ['distinctive', 'Distinctive'], ['fancy', 'Fancy'], ['modern', 'Modern'], ['formal', 'Formal'], ['simple', 'Simple']];
const TOF_FORMAT_LIST = [['template', 'From template'], ['classic', 'Classic'], ['distinctive', 'Distinctive'], ['centered', 'Centered'], ['formal', 'Formal'], ['simple', 'Simple']];

/** Insert > Table of Contents (Custom Table of Contents...): a new table, or the existing one replaced after asking. */
export function TableOfContentsDialog({ onClose }) {
  const editor = ed();
  const old = editor && tableAt(editor.state);
  const existing = old && !old.figures && !old.manual ? old : null;
  const [v, setV] = useState(() => (existing ? tocState(existing.node.attrs.code, leaderOf(existing.node)) : { ...TOC_DEFAULTS }));
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const apply = async (val) => {
    if (!editor) return;
    if (existing && !(await confirmDialog({ title: 'Replace the table of contents?', description: 'The current table and its formatting go.', confirmText: 'Replace' }))) return;
    insertToc(editor, { code: tocCode(val), leader: val.leader, format: val.format });
  };
  const options = async () => {
    const r = await openDialog('tableOfContentsOptions', { value: v });
    if (r) setV((o) => ({ ...o, ...r }));
  };
  return (
    <WordDialog title="Table of Contents" size="lg" onClose={onClose} result={() => (apply(v), v)}>
      <IndexTabs current="tableOfContents" onClose={onClose} />
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2"><span>Print Preview</span>
          <Sample v={v} rows={[['Heading 1', 0, '1'], ['Heading 2', 0.8, '3'], ['Heading 3', 1.6, '5']].slice(0, Math.max(1, v.levels))} />
        </div>
        <div className="flex flex-col gap-2"><span>Web Preview</span>
          <Preview height="8rem">{['Heading 1', 'Heading 2', 'Heading 3'].slice(0, Math.max(1, v.levels)).map((t, i) => (
            <div key={t} className="text-[0.7rem] text-blue-700 underline" style={{ paddingLeft: `${i * 0.8}rem` }}>{t}</div>))}
          </Preview>
        </div>
      </div>
      <Fieldset legend="General">
        <General v={v} set={set} formats={TOC_FORMAT_LIST} />
        <Spin label="Show &levels:" value={v.levels} unit="int" min={1} max={9} onChange={(x) => set('levels')(Math.round(x ?? 3))} width="4rem" />
      </Fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={options} {...accessProps('&Options...')}><AccessText label="&Options..." /></Button>
        <Button type="button" variant="outline" size="sm" disabled={v.format !== 'template'} onClick={() => openDialog('tableOfContentsStyle', { ids: Object.keys(TOC_STYLES).slice(1) })}
          {...accessProps('&Modify...')}><AccessText label="&Modify..." /></Button>
      </div>
    </WordDialog>
  );
}

/** Table of Contents Options: styles with their TOC levels, outline levels and TC fields → {styles, levels, extra, outline, tcFields}. */
export function TableOfContentsOptionsDialog({ value, onClose }) {
  const editor = ed();
  const list = editor?.state.doc.attrs.styles?.list ?? {};
  const paras = Object.entries(list).filter(([id, s]) => (s.type ?? 'paragraph') === 'paragraph' && !/^TOC/.test(id)).map(([id, s]) => [id, s.name ?? id]);
  const headingLevel = (id) => (/^Heading([1-9])$/.exec(id)?.[1] ? +/^Heading([1-9])$/.exec(id)[1] : null);
  const initial = () => Object.fromEntries(paras.map(([id, name]) => {
    const extra = value.extra?.find(([n]) => n.toLowerCase() === String(name).toLowerCase() || n.toLowerCase() === id.toLowerCase());
    const h = headingLevel(id);
    return [id, extra ? extra[1] : h && h <= value.levels && value.styles ? h : null];
  }));
  const [levels, setLevels] = useState(initial);
  const [styles, setStyles] = useState(value.styles);
  const [outline, setOutline] = useState(value.outline);
  const [tc, setTc] = useState(value.tcFields);
  const result = () => {
    let n = 0;
    while (n < 9 && levels[`Heading${n + 1}`] === n + 1) n++;
    const extra = paras.filter(([id]) => levels[id] != null && !(headingLevel(id) && headingLevel(id) <= n && levels[id] === headingLevel(id)))
      .map(([id, name]) => [/^Heading\d$/.test(id) ? `Heading ${id.slice(7)}` : name, levels[id]]);
    return { styles, levels: n || value.levels, extra, outline, tcFields: tc };
  };
  const reset = () => {
    setStyles(true);
    setOutline(true);
    setTc(false);
    setLevels(Object.fromEntries(paras.map(([id]) => [id, headingLevel(id) && headingLevel(id) <= 3 ? headingLevel(id) : null])));
  };
  return (
    <WordDialog title="Table of Contents Options" size="sm" onClose={onClose} result={result} left={[{ label: '&Reset', onClick: reset }]}>
      <span>Build table of contents from:</span>
      <Check label="&Styles" checked={styles} onChange={setStyles} />
      <div className="max-h-48 overflow-auto rounded-md border">
        <div className="flex justify-between border-b px-2 py-0.5 text-xs text-muted-foreground"><span>Available styles:</span><span>TOC level:</span></div>
        {paras.map(([id, name]) => (
          <div key={id} className="flex items-center justify-between px-2 py-0.5 text-xs">
            <span>{name}</span>
            <Input size="xs" aria-label={`${name} TOC level`} className="h-5 w-10 px-1" disabled={!styles}
              value={levels[id] ?? ''} onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setLevels((o) => ({ ...o, [id]: n >= 1 && n <= 9 ? n : null }));
              }} />
          </div>
        ))}
      </div>
      <Check label="&Outline levels" checked={outline} onChange={setOutline} />
      <Check label="Tabl&e entry fields" checked={tc} onChange={setTc} />
    </WordDialog>
  );
}

/** Opens Modify Style for `styleId` when the styles package has registered it; until then says it is not built yet. */
async function modifyStyle(styleId) {
  const editor = ed();
  if (editor) {
    const styles = ensureStyles(editor.state.doc, { ...TOC_STYLES, ...TOF_STYLES });
    if (styles) editor.view.dispatch(closeHistory(editor.state.tr.setDocAttribute('styles', styles)));
  }
  // Imported at call time: the registry imports every package, this one included, so a static import would be a cycle.
  const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js');
  if (WORD_DIALOGS.modifyStyle) openDialog('modifyStyle', { styleId });
  else toast(REASONS.pending); // an unregistered id would sit on the dialog stack drawing nothing
}

/** Style (the Modify... of the table dialogs): the TOC level styles, or Table of Figures, with Modify... for the picked one. */
export function TableOfContentsStyleDialog({ ids, onClose }) {
  const list = ed()?.state.doc.attrs.styles?.list ?? {};
  const all = { ...TOC_STYLES, ...TOF_STYLES };
  const [pick, setPick] = useState(ids[0]);
  const s = list[pick] ?? all[pick];
  const props = [s?.para?.spacing?.after != null && `Space After: ${s.para.spacing.after} pt`, `Based on: ${s?.basedOn ?? 'Normal'}`, `Following style: ${s?.next ?? 'Normal'}`].filter(Boolean);
  return (
    <WordDialog title="Style" size="sm" onClose={onClose} result={() => pick}>
      <span>Please select the appropriate style for your index or table entry</span>
      <Row label="&Styles:" htmlFor="toc-style-pick">
        <Pick id="toc-style-pick" value={pick} options={ids.map((id) => [id, all[id]?.name.replace(/^toc/, 'TOC') ?? id])} onChange={setPick} width="10rem" />
      </Row>
      <p className="text-xs text-muted-foreground">{props.join(', ')}</p>
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={() => modifyStyle(pick)} {...accessProps('&Modify...')}><AccessText label="&Modify..." /></Button>
      </div>
    </WordDialog>
  );
}

/** The labels the Caption, AutoCaption and Table of Figures lists offer: Equation, Figure, Table, then the custom ones. */
const labelsOf = (settings) => ['Equation', 'Figure', 'Table', ...(wordSettings(settings).captions?.labels ?? [])];

/** Insert Table of Figures. */
export function TableOfFiguresDialog({ onClose }) {
  const editor = ed();
  const [v, setV] = useState({ ...TOF_DEFAULTS });
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const labels = labelsOf(getState().settings);
  const options = async () => {
    const r = await openDialog('tableOfFiguresOptions', { value: v });
    if (r) setV((o) => ({ ...o, ...r }));
  };
  const apply = async (val) => {
    if (!editor) return;
    const existing = tableAt(editor.state, { figures: true, here: true });
    if (existing && !(await confirmDialog({ title: 'Replace the table of figures?', description: 'The current table and its formatting go.', confirmText: 'Replace' }))) return;
    insertTof(editor, { code: tofCode(val), leader: val.leader, replace: existing });
  };
  return (
    <WordDialog title="Table of Figures" size="lg" onClose={onClose} result={() => (apply(v), v)}>
      <IndexTabs current="tableOfFigures" onClose={onClose} />
      <Sample v={v} rows={[[`${v.includeLabel && v.label ? `${v.label} 1: ` : ''}Text`, 0, '1'], [`${v.includeLabel && v.label ? `${v.label} 2: ` : ''}Text`, 0, '3'],
        [`${v.includeLabel && v.label ? `${v.label} 3: ` : ''}Text`, 0, '5']]} />
      <Fieldset legend="General">
        <General v={v} set={set} formats={TOF_FORMAT_LIST} />
        <Row label="Caption &label:" htmlFor="tof-label">
          <Pick id="tof-label" value={v.label ?? ''} options={[['', '(none)'], ...labels.map((l) => [l, l])]} onChange={(x) => set('label')(x || null)} width="8rem" />
        </Row>
        <Check label="I&nclude label and number" checked={v.includeLabel} disabled={!v.label} onChange={set('includeLabel')} />
      </Fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={options} {...accessProps('&Options...')}><AccessText label="&Options..." /></Button>
        <Button type="button" variant="outline" size="sm" onClick={() => openDialog('tableOfContentsStyle', { ids: ['TableofFigures'] })} {...accessProps('&Modify...')}>
          <AccessText label="&Modify..." />
        </Button>
      </div>
    </WordDialog>
  );
}

const IDS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => [c, c]);

/** Table of Figures Options: a style and TC fields with an identifier → {style, tcFields, tcId}. */
export function TableOfFiguresOptionsDialog({ value, onClose }) {
  const list = ed()?.state.doc.attrs.styles?.list ?? {};
  const names = Object.values(list).filter((s) => (s.type ?? 'paragraph') === 'paragraph').map((s) => s.name).filter(Boolean).sort();
  const [style, setStyle] = useState(value.style ?? null);
  const [name, setName] = useState(value.style ?? 'Caption');
  const [tc, setTc] = useState(value.tcFields);
  const [id, setId] = useState(value.tcId ?? 'F');
  return (
    <WordDialog title="Table of Figures Options" size="sm" onClose={onClose} result={() => ({ style: style ? name : null, tcFields: tc, tcId: id })}>
      <span>Build table of figures from:</span>
      <div className="flex items-center gap-2">
        <Check label="&Style:" checked={!!style} onChange={(on) => setStyle(on ? name : null)} />
        <Pick aria-label="Style name" value={name} options={names.map((n) => [n, n])} onChange={(n) => { setName(n); if (style) setStyle(n); }} width="10rem" />
      </div>
      <Check label="Tabl&e entry fields" checked={tc} onChange={setTc} />
      <Row label="Table &identifier:" htmlFor="tof-id"><Pick id="tof-id" value={id} options={IDS} onChange={setId} disabled={!tc} width="4rem" /></Row>
    </WordDialog>
  );
}

/** Update Table of Contents (and of Figures): page numbers only or the entire table → 'pages' | 'all'. */
export function UpdateTableOfContentsDialog({ figures = false, onClose }) {
  const [mode, setMode] = useState('pages');
  return (
    <WordDialog title={figures ? 'Update Table of Figures' : 'Update Table of Contents'} size="sm" onClose={onClose} result={() => mode}>
      <p>{figures ? 'Update the table of figures:' : 'Update the table of contents:'}</p>
      <Radio value={mode} options={[['pages', 'Update &page numbers only'], ['all', 'Update &entire table']]} onChange={setMode} />
    </WordDialog>
  );
}

/** Mark Table of Contents Entry (Alt+Shift+O): writes a hidden TC field after the selection; on a canvas draft through
 * `engine.mark(code)`. */
export function MarkTableOfContentsEntryDialog({ text = '', engine = null, onClose }) {
  const [entry, setEntry] = useState(text);
  const [id, setId] = useState('C');
  const [level, setLevel] = useState(1);
  // Mark writes the entry and keeps the dialog open for the next one, as Word's does: a non-empty validate message stops OK from
  // closing, and a single space shows nothing. Cancel closes it.
  const mark = () => {
    if (!entry.trim()) return 'Type the entry text.';
    const editor = ed();
    if (engine) engine.mark(tcCode(entry, { id, level }));
    else if (editor) markEntry(editor, tcCode(entry, { id, level }));
    return ' ';
  };
  return (
    <WordDialog title="Mark Table of Contents Entry" size="sm" okText="Mark" modeless onClose={onClose} validate={mark}>
      <Row label="&Entry:" htmlFor="tc-entry">
        <Input size="xs" id="tc-entry" value={entry} onChange={(e) => setEntry(e.target.value)} className="flex-1" />
      </Row>
      <Row label="Table &identifier:" htmlFor="tc-id"><Pick id="tc-id" value={id} options={IDS} onChange={setId} width="4rem" /></Row>
      <Spin label="&Level:" value={level} unit="int" min={1} max={9} onChange={(x) => setLevel(Math.round(x ?? 1))} width="4rem" />
    </WordDialog>
  );
}

/** New Label → the label typed. */
export function NewCaptionLabelDialog({ onClose }) {
  const [label, setLabel] = useState('');
  return (
    <WordDialog title="New Label" size="sm" onClose={onClose} result={() => label.trim()} validate={() => (label.trim() ? null : 'Type a label.')}>
      <Row label="&Label:" htmlFor="new-label"><Input size="xs" id="new-label" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} className="flex-1" /></Row>
    </WordDialog>
  );
}

/** Adds custom label `label` to settings.word.captions.labels (a built-in or known label is not added twice). */
async function addLabel(label) {
  const caps = wordSettings(getState().settings).captions;
  if (!label || labelsOf(getState().settings).some((l) => l.toLowerCase() === label.toLowerCase())) return;
  await saveWord({ captions: { ...caps, labels: [...(caps.labels ?? []), label] } });
}

/** Caption Numbering for `label`: saved in settings.word.captions.numbering. */
export function CaptionNumberingDialog({ label = 'Figure', onClose }) {
  const caps = wordSettings(getState().settings).captions;
  const now = caps.numbering?.[label] ?? {};
  const [v, setV] = useState({ format: now.format ?? 'ARABIC', chapter: !!now.chapter, level: now.level ?? 1, sep: now.sep ?? 'hyphen' });
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const save = () => {
    saveWord({ captions: { ...caps, numbering: { ...caps.numbering, [label]: v } } });
    return v;
  };
  const sepLabel = { hyphen: '(hyphen)', period: '(period)', colon: '(colon)', emDash: '(em-dash)', enDash: '(en-dash)' };
  return (
    <WordDialog title="Caption Numbering" size="sm" onClose={onClose} result={save}>
      <Row label="&Format:" htmlFor="cap-format"><Pick id="cap-format" value={v.format} options={Object.entries(NUM_FORMATS)} onChange={set('format')} width="8rem" /></Row>
      <Check label="In&clude chapter number" checked={v.chapter} onChange={set('chapter')} />
      <Row label="Cha&pter starts with style" htmlFor="cap-style">
        <Pick id="cap-style" value={v.level} disabled={!v.chapter} options={Array.from({ length: 9 }, (_, i) => [i + 1, `Heading ${i + 1}`])} onChange={set('level')} width="8rem" />
      </Row>
      <Row label="Us&e separator:" htmlFor="cap-sep" help="Examples: Figure II-1, Table 1-A">
        <Pick id="cap-sep" value={v.sep} disabled={!v.chapter} options={Object.entries(SEPARATORS).map(([k, c]) => [k, `${c} ${sepLabel[k]}`])} onChange={set('sep')} width="8rem" />
      </Row>
    </WordDialog>
  );
}

const POSITIONS = [['above', 'Above selected item'], ['below', 'Below selected item']];

/** Insert Caption: label, number and typed text in a Caption paragraph next to the selected object. */
export function CaptionDialog({ onClose }) {
  const editor = ed();
  const [labels, setLabels] = useState(() => labelsOf(getState().settings));
  const [label, setLabel] = useState('Figure');
  const [exclude, setExclude] = useState(false);
  const [position, setPosition] = useState('below');
  const [text, setText] = useState('');
  const [, bump] = useState(0);
  // A canvas draft's selected object comes from the engine's document.context (base.js contextOf).
  const hasObject = editor ? !!captionTarget(editor.state) : !!ctxOf().obj;
  const prefix = editor ? captionPrefix(editor.state, label, { exclude }) : label;
  const custom = !['Equation', 'Figure', 'Table'].includes(label);
  const newLabel = async () => {
    const l = await openDialog('newCaptionLabel');
    if (!l) return;
    await addLabel(l);
    setLabels(labelsOf(getState().settings));
    setLabel(l);
  };
  const deleteLabel = async () => {
    const caps = wordSettings(getState().settings).captions;
    await saveWord({ captions: { ...caps, labels: (caps.labels ?? []).filter((l) => l !== label) } });
    setLabels(labelsOf(getState().settings));
    setLabel('Figure');
  };
  const insert = () => {
    if (editor) insertCaption(editor, { label, text, position: hasObject ? position : 'below', exclude });
    return { label, text, position: hasObject ? position : 'below', exclude };
  };
  return (
    <WordDialog title="Caption" size="md" onClose={onClose} result={insert}>
      <Row label="&Caption:" htmlFor="cap-text">
        <div className="flex h-6 flex-1 items-center rounded-md border border-input bg-transparent px-2 text-xs shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
          <span className="shrink-0 text-muted-foreground">{prefix}</span>
          <input id="cap-text" autoFocus value={text} onChange={(e) => setText(e.target.value)} className="min-w-0 flex-1 bg-transparent outline-none" />
        </div>
      </Row>
      <Fieldset legend="Options">
        <Row label="&Label:" htmlFor="cap-label"><Pick id="cap-label" value={label} options={labels.map((l) => [l, l])} onChange={setLabel} width="10rem" /></Row>
        <Row label="&Position:" htmlFor="cap-pos"><Pick id="cap-pos" value={position} options={POSITIONS} onChange={setPosition} disabled={!hasObject} width="10rem" /></Row>
        <Check label="&Exclude label from caption" checked={exclude} onChange={setExclude} />
      </Fieldset>
      <div className="flex flex-wrap justify-end gap-2">
        {[['&New Label...', newLabel, false], ['&Delete Label', deleteLabel, !custom],
          ['N&umbering...', async () => { await openDialog('captionNumbering', { label }); bump((n) => n + 1); }, false],
          ['&AutoCaption...', () => openDialog('autoCaption'), false]].map(([l, fn, off]) => (
          <Button key={l} type="button" variant="outline" size="sm" disabled={off} onClick={fn} {...accessProps(l)}><AccessText label={l} /></Button>
        ))}
      </div>
    </WordDialog>
  );
}

/** AutoCaption: the app's object kinds (in place of Word's OLE classes), each with its label and position, in
 * settings.word.captions.autoCaption. */
export function AutoCaptionDialog({ onClose }) {
  const caps = wordSettings(getState().settings).captions;
  const [auto, setAuto] = useState(() => ({ ...caps.autoCaption }));
  const [current, setCurrent] = useState(AUTO_KINDS[0][0]);
  const [labels, setLabels] = useState(() => labelsOf(getState().settings));
  const cur = auto[current] ?? {};
  const patch = (kind, p) => setAuto((o) => ({ ...o, [kind]: { label: 'Figure', position: 'below', ...o[kind], ...p } }));
  const newLabel = async () => {
    const l = await openDialog('newCaptionLabel');
    if (!l) return;
    await addLabel(l);
    setLabels(labelsOf(getState().settings));
    patch(current, { label: l });
  };
  const save = () => {
    saveWord({ captions: { ...wordSettings(getState().settings).captions, autoCaption: auto } });
    return auto;
  };
  return (
    <WordDialog title="AutoCaption" size="sm" onClose={onClose} result={save}>
      <span {...accessProps('&Add caption when inserting:')}><AccessText label="&Add caption when inserting:" /></span>
      <div role="listbox" className="flex max-h-40 flex-col overflow-auto rounded-md border p-1">
        {AUTO_KINDS.map(([kind, name]) => (
          <div key={kind} role="option" aria-selected={kind === current} onClick={() => setCurrent(kind)}
            className={kind === current ? 'rounded-sm bg-accent px-1' : 'px-1'}>
            <Check label={name} checked={!!auto[kind]?.on} onChange={(on) => { setCurrent(kind); patch(kind, { on }); }} />
          </div>
        ))}
      </div>
      <Fieldset legend="Options">
        <Row label="Use &label:" htmlFor="auto-label">
          <Pick id="auto-label" value={cur.label ?? 'Figure'} options={labels.map((l) => [l, l])} onChange={(l) => patch(current, { label: l })} width="8rem" />
        </Row>
        <Row label="&Position:" htmlFor="auto-pos">
          <Pick id="auto-pos" value={cur.position ?? 'below'} options={[['above', 'Above item'], ['below', 'Below item']]} onChange={(p) => patch(current, { position: p })} width="8rem" />
        </Row>
      </Fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={newLabel} {...accessProps('&New Label...')}><AccessText label="&New Label..." /></Button>
        <Button type="button" variant="outline" size="sm" onClick={() => openDialog('captionNumbering', { label: cur.label ?? 'Figure' })} {...accessProps('N&umbering...')}>
          <AccessText label="N&umbering..." />
        </Button>
      </div>
    </WordDialog>
  );
}

/** Runs the Update dialog for the table of contents (or `figures`) and applies the mode picked. */
export async function askUpdate({ figures = false } = {}) {
  const editor = ed();
  if (!editor) return false;
  const mode = await openDialog('updateTableOfContents', { figures });
  return mode ? updateTables(editor, mode, { figures }) : false;
}

export const DIALOGS = {
  tableOfContents: TableOfContentsDialog,
  tableOfContentsOptions: TableOfContentsOptionsDialog,
  tableOfContentsStyle: TableOfContentsStyleDialog,
  tableOfFigures: TableOfFiguresDialog,
  tableOfFiguresOptions: TableOfFiguresOptionsDialog,
  updateTableOfContents: UpdateTableOfContentsDialog,
  markTableOfContentsEntry: MarkTableOfContentsEntryDialog,
  caption: CaptionDialog,
  newCaptionLabel: NewCaptionLabelDialog,
  captionNumbering: CaptionNumberingDialog,
  autoCaption: AutoCaptionDialog,
};
