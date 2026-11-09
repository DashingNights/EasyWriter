// The Footnote and Endnote dialog, Convert Notes and the Show Notes choice (docs/plans/word/plan.md §1.6; probe/dialogs/
// footnote-and-endnote.json and convert-notes.json give the labels, items, defaults and access keys). Apply writes the format to
// the whole document or the selection's section; Insert writes it and inserts a note, with the custom mark when one is typed.
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioInput } from '@/components/ui/radio';
import { ctxOf, run } from '../../../tooling/registry.js';
import { Fieldset, Pick, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { sectionOf, sectionsOf } from '../../model/sections.mjs';
import { BODY_ONLY, insertNoteTr } from './commands.js';
import { openWhenDrawn } from './edit.js';
import { effectivePr, MAX_START, notesOf, NUM_FORMATS } from './model.mjs';

const FOOT_POS = [['pageBottom', 'Bottom of page'], ['beneathText', 'Below text']];
const END_POS = [['sectEnd', 'End of section'], ['docEnd', 'End of document']];
const COLUMNS = [[0, 'Match section layout'], [1, '1 column'], [2, '2 column'], [3, '3 column'], [4, '4 column']];
const RESTART = [['continuous', 'Continuous'], ['eachSect', 'Restart each section'], ['eachPage', 'Restart each page']];
const FORMAT_KEYS = ['numFmt', 'numStart', 'numRestart', 'columns'];

/** One radio button with its access key, for radios that sit in rows with other controls or are disabled one by one. */
function RadioItem({ name, checked, label, onChange, disabled }) {
  return (
    <label className="flex w-fit items-center gap-2 aria-disabled:opacity-50" aria-disabled={disabled || undefined} {...(disabled ? {} : accessProps(label))}>
      <RadioInput name={name} checked={checked} disabled={disabled} onChange={onChange} />
      <AccessText label={label} />
    </label>
  );
}

/** Writes `kind`'s properties `patch` to the whole document (`apply` 'doc': the settings, and the sections that set those keys
 * lose them) or to the selection's section ('sect'), in one undo step; `then(tr)` adds to that step. */
function writeFormat(ed, kind, patch, apply, then) {
  const key = `${kind}Pr`;
  let c = ed.chain();
  if (apply === 'sect') c = c.setSectionProps({ [key]: patch });
  else {
    c = c.setDocSettings({ [key]: patch });
    const clear = Object.fromEntries(Object.keys(patch).map((k) => [k, null]));
    sectionsOf(ed.state.doc).forEach((s, i) => {
      const own = s.sect[key];
      if (own && Object.keys(patch).some((k) => own[k] != null)) c = c.setSectionProps({ [key]: clear }, { section: i });
    });
  }
  if (then) c = c.command(({ tr }) => (then(tr), true));
  return c.run();
}

/** The Footnote and Endnote dialog (References > Footnotes launcher). → 'insert', 'apply' or null. On a canvas draft `engine`
 * ({now: references.noteOptions' answer, apply(kind, patch, scope), insert(kind, mark)}) reads and writes the engine's options;
 * the footnote columns are not on the canvas yet. */
export function FootnoteAndEndnote({ engine = null, onClose }) {
  const ed = ctxOf().ed;
  const name = useId();
  const [kind, setKind] = useState(() => (ctxOf().story === 'endnote' ? 'endnote' : 'footnote'));
  const prOf = (k) => {
    if (engine) return { ...effectivePr(k), ...engine.now?.[k], columns: 0 };
    const doc = ed?.state.doc;
    return doc ? effectivePr(k, doc.attrs.settings, sectionOf(doc, ed.state.selection.from).sect) : effectivePr(k);
  };
  const [pos, setPos] = useState(() => ({ footnote: prOf('footnote').pos, endnote: prOf('endnote').pos }));
  const [fmt, setFmt] = useState(() => prOf(kind));
  const [mark, setMark] = useState('');
  const [apply, setApply] = useState('doc');
  const [symbol, setSymbol] = useState(false);
  // Apply starts disabled, as in Word, and enables once a format field changes.
  const [dirty, setDirty] = useState(false);
  const touch = (fn) => (...a) => {
    setDirty(true);
    fn(...a);
  };
  // Symbol... works once the Symbol dialog is registered (the symbols package); the registry is read after load to avoid an import cycle.
  useEffect(() => {
    import('../../../tooling/dialogs.js').then((m) => setSymbol(!!m.WORD_DIALOGS.symbol), () => {});
  }, []);
  const pick = (k) => {
    setKind(k);
    setFmt(prOf(k));
  };
  const set = (k) => touch((v) => setFmt((o) => ({ ...o, [k]: v })));
  const patch = () => ({ pos: pos[kind], ...Object.fromEntries(FORMAT_KEYS.map((k) => [k, fmt[k]])) });
  const save = (then) => ed && writeFormat(ed, kind, patch(), apply, then);
  const enginePatch = () => {
    const { columns, ...rest } = patch(); // eslint-disable-line no-unused-vars
    return rest;
  };
  const validFormat = () => (Number.isInteger(fmt.numStart) && fmt.numStart >= 1 && fmt.numStart <= MAX_START ? null : `Start at takes a number from 1 to ${MAX_START}.`);
  // Insert, like the ribbon's Insert Footnote, puts a reference only in the main text.
  const validate = () => validFormat() ?? (ctxOf().story === 'body' ? null : BODY_ONLY);
  const convert = async () => {
    const mode = await ctxOf().dialog('convertNotes', {});
    if (mode) run('notes.convert', mode);
  };
  const chooseSymbol = async () => {
    const r = await ctxOf().dialog('symbol', { mode: 'value' });
    if (r?.char) setMark(r.char);
  };
  const id = (k) => `${name}-${k}`;
  return (
    <WordDialog title="Footnote and Endnote" size="sm" okText="Insert" onClose={onClose} validate={validate}
      result={() => {
        if (engine) {
          Promise.resolve(dirty && engine.apply(kind, enginePatch(), apply)).then(() => engine.insert(kind, mark.trim() || null));
          return 'insert';
        }
        // The format and the new note are one undo step.
        let id = null;
        save((tr) => { id = insertNoteTr(tr, kind, { mark: mark.trim() || null }); });
        if (id) openWhenDrawn(ed, id);
        return 'insert';
      }}
      left={[{ label: '&Apply', disabled: (!ed && !engine) || !dirty, onClick: () => {
        if (validFormat()) return;
        if (engine) engine.apply(kind, enginePatch(), apply);
        else save();
        onClose('apply');
      } }]}>
      <Fieldset legend="Location">
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <RadioItem name={name} label="&Footnotes:" checked={kind === 'footnote'} onChange={() => pick('footnote')} />
          <Pick aria-label="Footnote location" value={pos.footnote} options={FOOT_POS} disabled={kind !== 'footnote'} width="100%"
            onChange={touch((v) => setPos((o) => ({ ...o, footnote: v })))} />
          <RadioItem name={name} label="&Endnotes:" checked={kind === 'endnote'} onChange={() => pick('endnote')} />
          <Pick aria-label="Endnote location" value={pos.endnote} options={END_POS} disabled={kind !== 'endnote'} width="100%"
            onChange={touch((v) => setPos((o) => ({ ...o, endnote: v })))} />
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={convert} disabled={!ed || !notesOf(ed.state.doc).length} {...accessProps('&Convert...')}>
            <AccessText label="&Convert..." />
          </Button>
        </div>
      </Fieldset>
      <Fieldset legend="Footnote layout">
        <Row label="C&olumns:" htmlFor={id('cols')}>
          <Pick id={id('cols')} value={fmt.columns ?? 0} options={COLUMNS} onChange={set('columns')} width="12rem" />
        </Row>
      </Fieldset>
      <Fieldset legend="Format">
        <Row label="&Number format:" htmlFor={id('fmt')}>
          <Pick id={id('fmt')} value={fmt.numFmt} options={NUM_FORMATS} onChange={set('numFmt')} width="12rem" />
        </Row>
        <Row label="C&ustom mark:" htmlFor={id('mark')}>
          <Input id={id('mark')} size="xs" className="w-20" value={mark} maxLength={10} spellCheck={false} onChange={(e) => setMark(e.target.value)} />
          <Button type="button" variant="outline" size="sm" className="ml-auto" disabled={!symbol} onClick={chooseSymbol} {...accessProps('S&ymbol...')}>
            <AccessText label="S&ymbol..." />
          </Button>
        </Row>
        <Spin label="&Start at:" value={fmt.numStart} unit="int" min={1} max={MAX_START} step={1} width="5rem" onChange={set('numStart')} />
        <Row label="Nu&mbering:" htmlFor={id('restart')}>
          <Pick id={id('restart')} value={fmt.numRestart} options={kind === 'footnote' ? RESTART : RESTART.slice(0, 2)} onChange={set('numRestart')} width="12rem" />
        </Row>
      </Fieldset>
      <Fieldset legend="Apply changes">
        <Row label="A&pply changes to:" htmlFor={id('apply')}>
          <Pick id={id('apply')} value={apply} options={[['doc', 'Whole document'], ['sect', 'This section']]} onChange={touch(setApply)} width="12rem" />
        </Row>
      </Fieldset>
    </WordDialog>
  );
}

/** Convert Notes: a choice is enabled only when that kind of note exists (`kinds` on a canvas draft, from the engine). →
 * 'toEndnotes', 'toFootnotes', 'swap' or null. */
export function ConvertNotes({ kinds: given = null, onClose }) {
  const ed = ctxOf().ed;
  const kinds = new Set(given ?? (ed ? notesOf(ed.state.doc).map((n) => n.node.attrs.kind) : []));
  const options = [
    ['toEndnotes', 'Convert all &footnotes to endnotes', kinds.has('footnote')],
    ['toFootnotes', 'Conv&ert all endnotes to footnotes', kinds.has('endnote')],
    ['swap', '&Swap footnotes and endnotes', kinds.has('footnote') && kinds.has('endnote')],
  ];
  const [mode, setMode] = useState(() => options.find((o) => o[2])?.[0] ?? null);
  const name = useId();
  return (
    <WordDialog title="Convert Notes" size="sm" onClose={onClose} result={() => mode} validate={() => (mode ? null : 'The document has no notes to convert.')}>
      <div role="radiogroup" className="flex flex-col gap-1.5">
        {options.map(([v, label, on]) => <RadioItem key={v} name={name} label={label} checked={mode === v} disabled={!on} onChange={() => setMode(v)} />)}
      </div>
    </WordDialog>
  );
}

/** Show Notes with both kinds in the document: which note area to go to. → 'footnote', 'endnote' or null. */
export function ShowNotes({ onClose }) {
  const [kind, setKind] = useState('footnote');
  const name = useId();
  return (
    <WordDialog title="Show Notes" size="sm" onClose={onClose} result={() => kind}>
      <p>This document has footnotes and endnotes. Which do you want to see?</p>
      <div role="radiogroup" className="flex flex-col gap-1.5">
        <RadioItem name={name} label="View &footnote area" checked={kind === 'footnote'} onChange={() => setKind('footnote')} />
        <RadioItem name={name} label="View &endnote area" checked={kind === 'endnote'} onChange={() => setKind('endnote')} />
      </div>
    </WordDialog>
  );
}
