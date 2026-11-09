// The AutoCorrect dialog and its Exceptions dialog (docs/plans/word plan.md §1.6; probe/dialogs/autocorrect.json and
// autocorrect-exceptions.json give the labels, defaults and access keys). OK saves settings.word.autocorrect, autoformat and
// autoformatNow; the replacement list is stored whole only once it is edited (entries null means our built-in list).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ctxOf, panelOf } from '../../../tooling/registry.js';
import { Check, FieldList, Fieldset, Radio } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { saveWord } from '../../word/settings.mjs';
import { DEFAULT_ENTRIES, DEFAULT_FIRST_LETTER } from './entries.mjs';

const Btn = ({ label, ...props }) => (
  <Button type="button" variant="outline" size="sm" {...accessProps(label)} {...props}><AccessText label={label} /></Button>
);

/** The selection's text and the marks of its first run, for a formatted entry → {text, marks} or null. */
function selectionRun() {
  const st = ctxOf().state;
  if (!st || st.selection.empty) return null;
  const { from, to } = st.selection;
  const text = st.doc.textBetween(from, to, ' ', '');
  let marks = [];
  st.doc.nodesBetween(from, to, (n) => {
    if (n.isText && !marks.length) marks = n.marks.map((m) => m.toJSON());
    return !marks.length;
  });
  return text.trim() ? { text, marks } : null;
}

/** The AutoCorrect dialog; props {tab, replace, with} open a tab and fill the boxes → true after OK saves. */
export function AutoCorrectDialog({ tab: first = 'autoCorrect', replace = '', with: withText, onClose }) {
  const word = ctxOf().settings.word;
  const [tab, setTab] = useState(first);
  const [ac, setAc] = useState(word.autocorrect);
  const [af, setAf] = useState(word.autoformat);
  const [now, setNow] = useState(word.autoformatNow);
  const [entries, setEntries] = useState(word.autocorrect.entries);
  const [ex, setEx] = useState(word.autocorrect.exceptions);
  const [sel] = useState(selectionRun);
  const [name, setName] = useState(replace);
  const [text, setText] = useState(withText ?? sel?.text ?? '');
  const [formatted, setFormatted] = useState(false);
  const list = entries ?? DEFAULT_ENTRIES;
  const found = list.find((e) => e.name === name);
  const near = name && (found ?? list.find((e) => e.name.toLowerCase().startsWith(name.toLowerCase())));
  const flag = (set) => (key) => (v) => set((o) => ({ ...o, [key]: v }));
  const acKey = flag(setAc);
  const afKey = flag(setAf);
  const nowKey = flag(setNow);

  const pick = (key) => {
    const e = list.find((x) => x.name === key);
    setName(e.name);
    setText(e.text);
    setFormatted(!!e.marks);
  };
  const add = () => {
    const entry = formatted && sel ? { name, text: sel.text, marks: sel.marks } : { name, text };
    setEntries([...list.filter((e) => e.name !== name), entry].sort((a, b) => a.name.localeCompare(b.name)));
  };
  const remove = () => {
    setEntries(list.filter((e) => e.name !== name));
    setName('');
    setText('');
  };
  const exceptions = async () => {
    const r = await ctxOf().dialog('autoCorrectExceptions', { exceptions: ex });
    if (r) setEx(r);
  };
  const save = () => {
    saveWord({ autocorrect: { ...ac, entries, exceptions: ex }, autoformat: af, autoformatNow: now });
    return true;
  };

  const autoCorrect = () => (
    <>
      <Check label="S&how AutoCorrect Options buttons" checked={ac.buttons} onChange={acKey('buttons')} />
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <Check label="C&orrect TWo INitial CApitals" checked={ac.twoCaps} onChange={acKey('twoCaps')} />
          <Check label="Capitalize fir&st letter of sentences" checked={ac.sentences} onChange={acKey('sentences')} />
          <Check label="Capitalize first letter of table &cells" checked={ac.cells} onChange={acKey('cells')} />
          <Check label="Capitalize &names of days" checked={ac.days} onChange={acKey('days')} />
          <Check label="Correct accidental usage of cAPS &LOCK key" checked={ac.capsLock} onChange={acKey('capsLock')} />
        </div>
        <Btn label="&Exceptions..." onClick={exceptions} />
      </div>
      <div className="flex flex-col gap-2 border-t pt-2">
        <div className="flex items-center gap-6">
          <Check label="Replace &text as you type" checked={ac.replace} onChange={acKey('replace')} />
          <Radio name="ac-format" value={formatted} onChange={setFormatted} options={[[false, '&Plain text'], [true, '&Formatted text']]} />
        </div>
        <FieldList label="Entries" rows={list.map((e) => [e.name, e.name, e.text])} value={near?.name} onPick={pick} fields={[
          ['&Replace:', 'ac-replace', { value: name, onChange: (e) => setName(e.target.value) }],
          ['&With:', 'ac-with', { value: formatted && sel ? sel.text : text, onChange: (e) => setText(e.target.value), disabled: formatted && !!sel }],
        ]} />
        <div className="flex justify-end gap-2">
          <Btn label={found ? '&Replace' : '&Add'} disabled={!name || !(formatted && sel ? sel.text : text)} onClick={add} />
          <Btn label="&Delete" disabled={!found} onClick={remove} />
        </div>
        <Check label="Automatically use su&ggestions from the spelling checker" checked={ac.spelling} onChange={acKey('spelling')} />
      </div>
    </>
  );

  const MathPanel = panelOf('autocorrect.mathAutoCorrect');
  const math = () => (MathPanel ? <MathPanel ctx={ctxOf()} /> : <p className="text-muted-foreground">Math AutoCorrect arrives with the equation tools.</p>);

  const asYouType = () => (
    <>
      <Fieldset legend="Replace as you type">
        <Check label={'"Straight quotes" with “smart quotes”'} checked={af.quotes} onChange={afKey('quotes')} />
        <Check label="Ordinals (1st) with superscript" checked={af.ordinals} onChange={afKey('ordinals')} />
        <Check label="Fractions (1/2) with fraction character (½)" checked={af.fractions} onChange={afKey('fractions')} />
        <Check label="Hyphens (--) with dash (—)" checked={af.dashes} onChange={afKey('dashes')} />
        {/* Stored only: the kit's Markdown input rules live in shared files (schema.js), so the integrator gates them on this setting. */}
        <Check label="Markdown for Heading, Bold, Italic and Strikethrough" checked={af.markdown} onChange={afKey('markdown')} />
        <Check label="*Bold* and _italic_ with real formatting" checked={af.boldItalic} onChange={afKey('boldItalic')} />
        <Check label="Internet and network paths with hyperlinks" checked={af.links} onChange={afKey('links')} />
        <Check label="Spaces at beginning of paragraph with first-line indent" checked={af.firstLineIndentSpaces} onChange={afKey('firstLineIndentSpaces')} />
      </Fieldset>
      <Fieldset legend="Apply as you type">
        <Check label="Automatic bulleted lists" checked={af.bulletedLists} onChange={afKey('bulletedLists')} />
        <Check label="Automatic numbered lists" checked={af.numberedLists} onChange={afKey('numberedLists')} />
        <Check label="Border lines" checked={af.borders} onChange={afKey('borders')} />
        <Check label="Tables" checked={af.tables} onChange={afKey('tables')} />
        <Check label="Built-in Heading styles" checked={af.headings} onChange={afKey('headings')} />
        <Check label="Date style" checked={af.dateStyle} onChange={afKey('dateStyle')} />
      </Fieldset>
      <Fieldset legend="Automatically as you type">
        <Check label="Format beginning of list item like the one before it" checked={af.listLead} onChange={afKey('listLead')} />
        <Check label="Set left- and first-indent with tabs and backspaces" checked={af.tabIndent} onChange={afKey('tabIndent')} />
        <Check label="Define styles based on your formatting" checked={af.defineStyles} onChange={afKey('defineStyles')} />
        <Check label="Match opening and closing parentheses" checked={af.matchParentheses} onChange={afKey('matchParentheses')} />
        <Check label="Delete needless spaces between Asian and Western text" checked={af.asianSpaces} onChange={afKey('asianSpaces')} />
        <Check label="Insert closing phrase to match memo style" checked={af.memoClosing} onChange={afKey('memoClosing')} />
      </Fieldset>
    </>
  );

  const autoFormat = () => (
    <>
      <Fieldset legend="Apply">
        <Check label="Built-in Hea&ding styles" checked={now.headings} onChange={nowKey('headings')} />
        <Check label="&List styles" checked={now.lists} onChange={nowKey('lists')} />
        <Check label="A&utomatic bulleted lists" checked={now.bulletedLists} onChange={nowKey('bulletedLists')} />
        <Check label="Other &paragraph styles" checked={now.otherParas} onChange={nowKey('otherParas')} />
      </Fieldset>
      <Fieldset legend="Replace">
        <Check label={'"Straight &quotes" with “smart quotes”'} checked={now.quotes} onChange={nowKey('quotes')} />
        <Check label="&Ordinals (1st) with superscript" checked={now.ordinals} onChange={nowKey('ordinals')} />
        <Check label="&Fractions (1/2) with fraction character (½)" checked={now.fractions} onChange={nowKey('fractions')} />
        <Check label="H&yphens (--) with dash (—)" checked={now.dashes} onChange={nowKey('dashes')} />
        <Check label="*&Bold* and _italic_ with real formatting" checked={now.boldItalic} onChange={nowKey('boldItalic')} />
        <Check label="&Internet and network paths with hyperlinks" checked={now.links} onChange={nowKey('links')} />
        <Check label="Spac&es at beginning of paragraph with first-line indent" checked={now.spaces ?? true} onChange={nowKey('spaces')} />
        <Check label="&Match opening and closing parentheses" checked={now.parentheses ?? true} onChange={nowKey('parentheses')} />
        <Check label="Delete needless spa&ces between Asian and Western text" checked={now.asianSpaces ?? true} onChange={nowKey('asianSpaces')} />
      </Fieldset>
      <Fieldset legend="Preserve">
        <Check label="&Styles" checked={now.preserveStyles} onChange={nowKey('preserveStyles')} />
      </Fieldset>
      <Fieldset legend="Always AutoFormat">
        <Check label="Plain &text e-mail documents" checked={now.plainTextEmail} onChange={nowKey('plainTextEmail')} />
      </Fieldset>
    </>
  );

  const actions = () => (
    <>
      <p className="text-muted-foreground">Extra actions for words and phrases in the right-click menu are not available.</p>
      <Check label="Enab&le additional actions in the right-click menu" checked={false} disabled onChange={() => {}} />
    </>
  );

  return (
    <WordDialog title="AutoCorrect" size="md" tab={tab} onTab={setTab} onClose={onClose} result={save}
      tabs={[
        { id: 'autoCorrect', label: 'AutoCorrect', render: autoCorrect },
        { id: 'mathAutoCorrect', label: 'Math AutoCorrect', render: math },
        { id: 'autoFormatAsYouType', label: 'AutoFormat As You Type', render: asYouType },
        { id: 'autoFormat', label: 'AutoFormat', render: autoFormat },
        { id: 'actions', label: 'Actions', render: actions },
      ]} />
  );
}

const EX_TABS = [
  ['firstLetter', 'First Letter', "D&on't capitalize after:"],
  ['initialCaps', 'INitial CAps', "D&on't correct:"],
  ['other', 'Other Corrections', "D&on't correct:"],
];

/** The AutoCorrect Exceptions dialog; prop exceptions (settings.word.autocorrect.exceptions) → the edited exceptions or null. */
export function ExceptionsDialog({ exceptions = {}, onClose }) {
  const [lists, setLists] = useState(() => ({
    firstLetter: exceptions.firstLetter ?? DEFAULT_FIRST_LETTER, initialCaps: exceptions.initialCaps ?? [], other: exceptions.other ?? [],
  }));
  const [autoAdd, setAutoAdd] = useState(() => ({ firstLetter: true, initialCaps: true, other: true, ...exceptions.autoAdd }));
  const [box, setBox] = useState('');
  const [tab, setTab] = useState('firstLetter');
  const page = (id, label) => () => {
    const items = lists[id];
    const has = items.includes(box);
    return (
      <>
        <div className="flex gap-2">
          <div className="flex-1">
            <FieldList label={label} rows={items.map((w) => [w, w])} value={has ? box : null} onPick={setBox}
              fields={[[label, `ac-ex-${id}`, { value: box, onChange: (e) => setBox(e.target.value) }]]} />
          </div>
          {/* Level with the list, under the box's row (Input xs h-6, then the grid's gap-2) */}
          <div className="flex flex-col gap-2 pt-[2rem]">
            <Btn label="&Add" disabled={!box.trim() || has} onClick={() => setLists((o) => ({ ...o, [id]: [...o[id], box.trim()].sort() }))} />
            <Btn label="&Delete" disabled={!has} onClick={() => setLists((o) => ({ ...o, [id]: o[id].filter((w) => w !== box) }))} />
          </div>
        </div>
        <Check label="A&utomatically add words to list" checked={autoAdd[id]} onChange={(v) => setAutoAdd((o) => ({ ...o, [id]: v }))} />
      </>
    );
  };
  // The built-in First Letter list stays unstored (null) until it is edited.
  return (
    <WordDialog title="AutoCorrect Exceptions" size="sm" onClose={onClose} tab={tab} onTab={(id) => { setTab(id); setBox(''); }}
      result={() => ({ ...exceptions, ...lists, firstLetter: lists.firstLetter === DEFAULT_FIRST_LETTER ? null : lists.firstLetter, autoAdd })}
      tabs={EX_TABS.map(([id, title, label]) => ({ id, label: title, render: page(id, label) }))} />
  );
}
