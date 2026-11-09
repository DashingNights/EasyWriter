// Equation Options, Recognized Math Functions and the AutoCorrect dialog's Math AutoCorrect tab (docs/plans/word plan.md §1.6,
// probe/dialogs/equation-options.json, recognized-math-functions.json, autocorrect.json). Document values go to
// doc.attrs.settings.mathPr (m:mathPr names), app values to settings.word.math.
import { useEffect, useMemo, useState } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { getState } from '../../../app/store.js';
import { openDialog } from '../../../app/actions.js';
import { Help } from '../../../app/components/Tip.jsx';
import { Check, FieldList, Fieldset, ListPick, Pick, Radio, Row, Spin, rowClass } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { activeSurface } from '../../../tooling/surface.js';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { ENTRIES, FUNCTIONS } from './data.mjs';
import { MATH_PR, mathPrOf } from './linear.mjs';

const MATH_FONTS = ['Cambria Math', 'STIX Two Math', 'Latin Modern Math', 'XITS Math', 'Asana Math', 'Fira Math', 'Libertinus Math', 'TeX Gyre Termes Math'];

/** The math fonts installed here: a font the canvas draws differently from both generic fallbacks is present. Cambria Math stays
 * first either way, as Word's default. */
function installedMathFonts() {
  const c = document.createElement('canvas').getContext('2d');
  const width = (font) => {
    c.font = `40px ${font}`;
    return c.measureText('∑∫xyz≈αβ').width;
  };
  const base = ['monospace', 'serif'].map(width);
  return MATH_FONTS.filter((f, i) => i === 0 || ['monospace', 'serif'].some((g, k) => width(`"${f}", ${g}`) !== base[k]));
}

const mathOfApp = () => wordSettings(getState().settings).math;

// A canvas draft keeps the document's options in the engine (equation.options, m:mathPr): its names for the dialog's keys.
const SUB = { '--': 'minusMinus', '-+': 'minusPlus', '+-': 'plusMinus' };
const SUB_BACK = Object.fromEntries(Object.entries(SUB).map(([k, v]) => [v, k]));
/** The engine's options (equation.optionsInfo) as the dialog's (MATH_PR's keys). */
export const prOfEngine = (m) => ({ ...MATH_PR, font: m.mathFont ?? MATH_PR.font, brkBin: m.brkBin ?? MATH_PR.brkBin, brkBinSub: SUB_BACK[m.brkBinSub] ?? '--',
  smallFrac: !!m.smallFrac, dispDef: m.dispDef ?? true, lMargin: m.lMargin ?? 0, rMargin: m.rMargin ?? 0, defJc: m.defJc ?? MATH_PR.defJc,
  wrapIndent: m.wrapIndent ?? MATH_PR.wrapIndent, wrapRight: !!m.wrapRight, intLim: m.intLim ?? MATH_PR.intLim, naryLim: m.naryLim ?? MATH_PR.naryLim });
/** The dialog's options as equation.options takes them. */
export const engineOfPr = (pr) => ({ mathFont: pr.font, brkBin: pr.brkBin, brkBinSub: SUB[pr.brkBinSub] ?? 'minusMinus', smallFrac: !!pr.smallFrac,
  dispDef: !!pr.dispDef, lMargin: pr.lMargin ?? 0, rMargin: pr.rMargin ?? 0, defJc: pr.defJc, wrapIndent: pr.wrapIndent ?? 72, wrapRight: !!pr.wrapRight,
  intLim: pr.intLim, naryLim: pr.naryLim });

const KitButton = ({ label, onClick, disabled }) => (
  <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onClick} {...accessProps(label)}><AccessText label={label} /></Button>
);

/** Equation Options → true when applied. */
export function EquationOptions({ onClose }) {
  const surface = activeSurface();
  const ed = surface?.editor ?? null;
  const engine = ed ? null : surface?.session ?? null;
  const fonts = useMemo(installedMathFonts, []);
  const [pr, setPr] = useState(() => mathPrOf(ed?.state.doc.attrs.settings));
  // A canvas draft: the document's own options from the engine once it answers.
  useEffect(() => {
    if (!engine) return;
    Promise.resolve(engine.query?.('equation.optionsInfo', {})).then((r) => r?.ok && r.value && setPr(prOfEngine(r.value)), () => {});
  }, [engine]);
  const [app, setApp] = useState(() => ({ autoBuildUp: mathOfApp().autoBuildUp, copyLinear: mathOfApp().copyLinear }));
  const set = (k) => (v) => setPr((o) => ({ ...o, [k]: v }));
  const apply = () => {
    saveWord({ math: app });
    if (ed && !ed.isDestroyed) ed.commands.setDocSettings({ mathPr: pr });
    // A refused or failed command answers null, as the Layout dialog's engine branch does.
    else if (engine) return Promise.resolve(engine.exec('equation.options', engineOfPr(pr))).then((r) => (r?.ok ? true : null), () => null);
    return true;
  };
  // ponytail: Word's Defaults ... saves these settings for new documents (Normal template); here it resets the dialog to
  // Word's built-in values. Saving them needs an app setting that new documents read.
  return (
    <WordDialog title="Equation Options" size="md" onClose={onClose} result={apply}
      left={[{ label: '&Defaults ...', onClick: () => setPr({ ...MATH_PR }) }]}>
      <Fieldset legend="General">
        <Row label="De&fault font for math regions" htmlFor="eq-font">
          <Pick id="eq-font" value={pr.font} options={[...new Set([pr.font, ...fonts])].map((f) => [f, f])} onChange={set('font')} />
        </Row>
        <Check label="Automatically convert expressions to professional format" checked={app.autoBuildUp}
          onChange={(v) => setApp((o) => ({ ...o, autoBuildUp: v }))} />
        <Check label="Reduce si&ze of nested fractions in display equations" checked={pr.smallFrac} onChange={set('smallFrac')} />
        <div>When copying an equation,</div>
        <div className="pl-5">
          <Radio name="eq-copy" value={app.copyLinear} onChange={(v) => setApp((o) => ({ ...o, copyLinear: v }))}
            options={[[false, 'Co&py MathML to the clipboard as plain text'], [true, 'Copy Li&near Format to the clipboard as plain text']]} />
        </div>
        <Row label="B&reak lines with binary and relational operators" htmlFor="eq-brk">
          <Pick id="eq-brk" value={pr.brkBin} options={[['before', 'Before'], ['after', 'After'], ['repeat', 'Duplicate']]} onChange={set('brkBin')} />
        </Row>
        <Row label="Duplicate operators for subtraction as" htmlFor="eq-sub">
          <Pick id="eq-sub" value={pr.brkBinSub} disabled={pr.brkBin !== 'repeat'} options={[['--', '--'], ['-+', '-+'], ['+-', '+-']]} onChange={set('brkBinSub')} />
        </Row>
        <div className="flex gap-2 pl-5">
          <KitButton label="&Math AutoCorrect..." onClick={() => openDialog('autoCorrect', { tab: 'mathAutoCorrect' })} />
          <KitButton label="R&ecognized Functions..." onClick={() => openDialog('recognizedMathFunctions')} />
        </div>
      </Fieldset>
      <Fieldset legend="Display Math">
        <div>When building up integrals,</div>
        <div className="pl-5">
          <Radio name="eq-int" value={pr.intLim} onChange={set('intLim')}
            options={[['subSup', 'Place integral limit&s to the side'], ['undOvr', 'Place integral limits centered above and belo&w']]} />
        </div>
        <div>When building up other n-ary operators,</div>
        <div className="pl-5">
          <Radio name="eq-nary" value={pr.naryLim} onChange={set('naryLim')}
            options={[['subSup', 'Place n-ary limi&ts to the side'], ['undOvr', 'Place n-ary limits directly abo&ve and below']]} />
        </div>
        <Check label="&Use the following settings for math on its own line." checked={pr.dispDef} onChange={set('dispDef')} />
        <div className="flex gap-4 pl-5">
          <Spin label="&Left Margin" value={pr.lMargin} onChange={set('lMargin')} unit="len" min={0} max={1584} />
          <Spin label="Ri&ght Margin" value={pr.rMargin} onChange={set('rMargin')} unit="len" min={0} max={1584} />
        </div>
        <Help className="self-end">Math margins are added to paragraph margins.</Help>
        <Row label="&Justification" htmlFor="eq-jc">
          <Pick id="eq-jc" value={pr.defJc} onChange={set('defJc')}
            options={[['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['centerGroup', 'Centered as group']]} />
        </Row>
        <div>For math that wraps to a new line</div>
        <div className="flex flex-col gap-1.5 pl-5">
          <Radio name="eq-wrap" value={pr.wrapRight} onChange={set('wrapRight')}
            options={[[false, '&Indent wrapped lines by'], [true, 'Rig&ht align wrapped lines']]} />
          <Spin label="Indent wrapped lines by" value={pr.wrapIndent} onChange={set('wrapIndent')} unit="len" min={0} max={1584} />
        </div>
      </Fieldset>
    </WordDialog>
  );
}

/** A list with Add and Delete beside it, the shape both math lists share. `items`: [[key, label]]; `list` replaces the plain
 * list (Recognized Math Functions uses the kit's ListPick, a text box over the list). */
function EditList({ label, items, text, onPick, onAdd, onDelete, canAdd, canDelete, extra, list }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-1 flex-col gap-1">
        {label}
        {list ?? (
          <div role="listbox" className="h-48 overflow-auto rounded-md border border-input bg-background text-xs">
            {items.map(([k, l]) => (
              <div key={k} role="option" aria-selected={k === text} onClick={() => onPick(k)}
                className={cn('cursor-default px-1.5 py-0.5', rowClass(k === text))}>{l}</div>
            ))}
          </div>
        )}
        {extra}
      </div>
      {/* Level with the list: under the label, or under a FieldList's boxes (Input xs h-6, then its gap-2) */}
      <div className={cn('flex flex-col gap-2', label ? 'pt-6' : 'pt-[2rem]')}>
        <KitButton label="&Add" onClick={onAdd} disabled={!canAdd} />
        <KitButton label="&Delete" onClick={onDelete} disabled={!canDelete} />
      </div>
    </div>
  );
}

/** Recognized Math Functions → true when saved (settings.word.math.functions). */
export function RecognizedMathFunctions({ onClose }) {
  const [list, setList] = useState(() => [...(mathOfApp().functions ?? FUNCTIONS)]);
  const [text, setText] = useState('');
  const has = list.includes(text.trim());
  return (
    <WordDialog title="Recognized Math Functions" size="md" onClose={onClose} result={() => {
      saveWord({ math: { functions: list } });
      return true;
    }}>
      <EditList
        label={<label htmlFor="eq-fn">The following expressions are recognized math expressions. They will not be automatically italicized.</label>}
        list={<ListPick id="eq-fn" items={list.map((f) => [f, f])} value={has ? text.trim() : null} onChange={setText} text={text} onText={setText} height="12rem" />}
        onAdd={() => setList((l) => [...l, text.trim()].sort())} canAdd={!!text.trim() && !has}
        onDelete={() => setList((l) => l.filter((f) => f !== text.trim()))} canDelete={has} />
    </WordDialog>
  );
}

/** The Math AutoCorrect tab of the AutoCorrect dialog (panel 'autocorrect.mathAutoCorrect'): changes save at once. */
export function MathAutoCorrectPanel() {
  const [m, setM] = useState(mathOfApp);
  const save = (patch) => {
    setM((o) => ({ ...o, ...patch }));
    saveWord({ math: patch });
  };
  const entries = m.entries ?? ENTRIES;
  const [rep, setRep] = useState('');
  const [wth, setWith] = useState('');
  const hit = entries.find(([k]) => k === rep);
  return (
    <div className="flex flex-col gap-2" data-panel="autocorrect.mathAutoCorrect">
      <Check label="&Use Math AutoCorrect rules outside of math regions" checked={m.outside} onChange={(v) => save({ outside: v })} />
      <Help className="self-end">When Math AutoCorrect and AutoCorrect rules conflict, AutoCorrect rules will be used.</Help>
      <Check label="Replace &text as you type" checked={m.replace} onChange={(v) => save({ replace: v })} />
      <EditList
        list={(
          <FieldList label="Entries" className="h-48" rows={entries.map(([k, v]) => [k, k, v])} value={hit ? rep : null} fields={[
            ['&Replace:', 'eq-rep', { value: rep, onChange: (e) => setRep(e.target.value) }],
            ['&With:', 'eq-with', { value: wth, onChange: (e) => setWith(e.target.value) }],
          ]} onPick={(k) => {
            setRep(k);
            setWith(entries.find(([x]) => x === k)?.[1] ?? '');
          }} />
        )}
        onAdd={() => save({ entries: [...entries.filter(([k]) => k !== rep), [rep, wth]] })} canAdd={!!rep && !!wth && hit?.[1] !== wth}
        onDelete={() => save({ entries: entries.filter(([k]) => k !== rep) })} canDelete={!!hit}
        extra={<div><KitButton label="R&ecognized Functions..." onClick={() => openDialog('recognizedMathFunctions')} /></div>} />
    </div>
  );
}
