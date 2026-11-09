// The Content Control Properties dialog and the three legacy form field options dialogs (plan.md §1.6, §3 content-controls). No
// probe file exists for them, so the labels follow Word's as the brief lists them. Each takes its object (props.sdt or props.ff)
// and resolves with the edited copy, patched over the original, so the caller writes it in one step.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Fieldset, ListPick, Pick, Radio, rowClass, Row, Spin, TextArea } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { ctxOf } from '../../../tooling/registry.js';
import { BLOCK_GALLERIES } from '../../ribbon/spec.mjs';
import { addDropItem, DROP_MAX, ffForm, formFf, TEXT_FORMATS, TEXT_TYPES } from './model.mjs';
import { SDT_DEFAULTS } from '../../model/nodes.js';

/** A labelled text box ('&Title:'). */
function Text({ label, value, onChange, id, width = '14rem', ...props }) {
  return (
    <Row label={label} htmlFor={id}>
      <Input id={id} size="xs" spellCheck={false} style={{ width }} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...props} />
    </Row>
  );
}

/** A small dialog button with an access key. */
const Btn = ({ label, onClick, disabled }) => (
  <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={onClick} {...accessProps(label)}><AccessText label={label} /></Button>
);

const LOCKS = { none: [false, false], sdtLocked: [true, false], contentLocked: [false, true], sdtContentLocked: [true, true] };
const lockOf = (del, edit) => Object.keys(LOCKS).find((k) => LOCKS[k][0] === del && LOCKS[k][1] === edit);
const LOCALES = [['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['zh-HK', 'Chinese (Hong Kong SAR)'], ['zh-CN', 'Chinese (PRC)'],
  ['de-DE', 'German (Germany)'], ['fr-FR', 'French (France)'], ['ja-JP', 'Japanese']];
const STORES = [['text', 'Text (the same as the display)'], ['date', 'Date (xsd:date)'], ['dateTime', 'Date and Time (xsd:dateTime)']];

/** The character and linked styles of the open document → [[id, name]]. */
function charStyles() {
  const list = ctxOf().ed?.state.doc.attrs.styles?.list ?? {};
  return Object.entries(list).filter(([, s]) => s.type === 'character' || s.link).map(([id, s]) => [id, s.name ?? id]);
}

/** Content Control Properties: General, Locking and the settings of the control's type. → the edited sdt, or null. */
export function ContentControlProperties({ sdt, onClose }) {
  const [v, setV] = useState({ ...SDT_DEFAULTS, ...sdt });
  const set = (patch) => setV((o) => ({ ...o, ...patch }));
  const [del, edit] = LOCKS[v.lock] ?? LOCKS.none;
  const [pick, setPick] = useState(0);
  const styles = charStyles();
  const symbol = async (key) => {
    const r = await ctxOf().dialog('symbol', { mode: 'value', value: { char: v[key], font: null } });
    if (r?.char) set({ [key]: r.char });
  };
  const newStyle = async () => {
    const r = await ctxOf().dialog('createNewStyleFromFormatting', { type: 'character' });
    if (r?.id) set({ style: r.id });
  };
  const editItem = async (i) => {
    const taken = v.items.filter((_, j) => j !== i).map((it) => it.display);
    const item = await ctxOf().dialog('contentControlChoice', { title: i == null ? 'Add Choice' : 'Modify Choice', item: v.items[i], taken });
    if (!item) return;
    set({ items: i == null ? [...v.items, item] : v.items.map((it, j) => (j === i ? item : it)) });
    if (i == null) setPick(v.items.length);
  };
  const remove = () => {
    set({ items: v.items.filter((_, j) => j !== pick) });
    setPick(Math.max(0, Math.min(pick, v.items.length - 2)));
  };
  const move = (d) => {
    const j = pick + d;
    if (j < 0 || j >= v.items.length) return;
    const items = [...v.items];
    [items[pick], items[j]] = [items[j], items[pick]];
    set({ items });
    setPick(j);
  };
  const date = { format: 'M/d/yyyy', lang: 'en-US', store: 'dateTime', calendar: 'gregorian', ...v.date };
  return (
    <WordDialog title="Content Control Properties" size="md" onClose={onClose} result={() => ({ ...sdt, ...v })}>
      <Fieldset legend="General">
        <Text id="cc-title" label="&Title:" value={v.title} onChange={(t) => set({ title: t || null })} />
        <Text id="cc-tag" label="T&ag:" value={v.tag} onChange={(t) => set({ tag: t || null })} />
        <Row label="&Show as:" htmlFor="cc-show">
          <Pick id="cc-show" value={v.appearance} onChange={(a) => set({ appearance: a })}
            options={[['boundingBox', 'Bounding Box'], ['tags', 'Start/End Tag'], ['hidden', 'None']]} />
          <span className="ml-3"><AccessText label="&Color:" /></span>
          <ColorPick value={v.color} onChange={(c) => set({ color: c })} automatic="Automatic" />
        </Row>
        <Check label="&Use a style to format text typed into the empty control" checked={!!v.style} onChange={(on) => set({ style: on ? styles[0]?.[0] ?? 'DefaultParagraphFont' : null })} />
        <Row label="&Style:" htmlFor="cc-style">
          <Pick id="cc-style" value={v.style} disabled={!v.style} onChange={(s) => set({ style: s })} options={styles.length ? styles : [['DefaultParagraphFont', 'Default Paragraph Font']]} />
          <Btn label="Ne&w Style..." onClick={newStyle} disabled={!v.style} />
        </Row>
        <Check label="&Remove content control when contents are edited" checked={v.temporary} onChange={(t) => set({ temporary: t })} />
      </Fieldset>
      <Fieldset legend="Locking">
        <Check label="Content control cannot be &deleted" checked={del} onChange={(c) => set({ lock: lockOf(c, edit) })} />
        <Check label="Contents cannot be &edited" checked={edit} onChange={(c) => set({ lock: lockOf(del, c) })} />
      </Fieldset>
      {v.type === 'text' && (
        <Fieldset legend="Plain Text Properties">
          <Check label="Allow carriage returns (&multiple paragraphs)" checked={v.multiLine} onChange={(m) => set({ multiLine: m })} />
        </Fieldset>
      )}
      {v.type === 'checkbox' && (
        <Fieldset legend="Check Box Properties">
          <Row label="Checked symbol:"><span className="w-6 text-center text-base">{v.checkedChar}</span><Btn label="&Change..." onClick={() => symbol('checkedChar')} /></Row>
          <Row label="Unchecked symbol:"><span className="w-6 text-center text-base">{v.uncheckedChar}</span><Btn label="C&hange..." onClick={() => symbol('uncheckedChar')} /></Row>
        </Fieldset>
      )}
      {(v.type === 'comboBox' || v.type === 'dropDown') && (
        <Fieldset legend="Drop-Down List Properties">
          <div className="flex gap-2">
            <div role="listbox" aria-label="Display Name" className="h-28 min-w-0 flex-1 overflow-auto rounded-md border text-xs">
              <div className="grid grid-cols-2 border-b px-1.5 py-0.5 text-muted-foreground"><span>Display Name</span><span>Value</span></div>
              {v.items.map((it, i) => (
                <div key={i} role="option" aria-selected={i === pick} onClick={() => setPick(i)}
                  className={`grid cursor-default grid-cols-2 px-1.5 py-0.5 ${rowClass(i === pick)}`}>
                  <span className="truncate">{it.display}</span><span className="truncate">{it.value}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              <Btn label="&Add..." onClick={() => editItem(null)} />
              <Btn label="&Modify..." onClick={() => editItem(pick)} disabled={!v.items[pick]} />
              <Btn label="&Remove" onClick={remove} disabled={!v.items[pick]} />
              <Btn label="Move &Up" onClick={() => move(-1)} disabled={pick <= 0} />
              <Btn label="Move Do&wn" onClick={() => move(1)} disabled={pick >= v.items.length - 1} />
            </div>
          </div>
        </Fieldset>
      )}
      {v.type === 'date' && (
        <Fieldset legend="Date Picker Properties">
          <ListPick items={TEXT_FORMATS.date.filter(([f]) => f).map(([f]) => [f, f])} value={date.format} height="5rem"
            text={date.format} onText={(f) => set({ date: { ...date, format: f } })} onChange={(f) => set({ date: { ...date, format: f } })} aria-label="Display the date like this" />
          <Row label="&Locale:" htmlFor="cc-lang"><Pick id="cc-lang" value={date.lang} options={LOCALES} onChange={(l) => set({ date: { ...date, lang: l } })} /></Row>
          <Row label="Calendar type:" htmlFor="cc-cal"><Pick id="cc-cal" value={date.calendar} options={[['gregorian', 'Western']]} onChange={(c) => set({ date: { ...date, calendar: c } })} /></Row>
          <Row label="Store XML contents in the following format when mapped:" htmlFor="cc-store">
            <Pick id="cc-store" value={date.store} options={STORES} onChange={(s) => set({ date: { ...date, store: s } })} />
          </Row>
        </Fieldset>
      )}
      {v.type === 'repeating' && (
        <Fieldset legend="Repeating Section Properties">
          <Text id="cc-section" label="Section title:" value={v.repeat?.title} onChange={(t) => set({ repeat: { ...v.repeat, title: t || null } })} />
          <Check label="Allow users to add and remove sections" checked={v.repeat?.allowAddRemove !== false} onChange={(a) => set({ repeat: { ...v.repeat, allowAddRemove: a } })} />
        </Fieldset>
      )}
      {v.type === 'docPart' && (
        <Fieldset legend="Document Building Block Properties">
          <Row label="&Gallery:" htmlFor="cc-gallery">
            <Pick id="cc-gallery" value={v.docPart?.gallery ?? 'Quick Parts'} options={Object.keys(BLOCK_GALLERIES).map((g) => [g, g])}
              onChange={(g) => set({ docPart: { ...v.docPart, gallery: g } })} />
          </Row>
          <Text id="cc-category" label="&Category:" value={v.docPart?.category} onChange={(c) => set({ docPart: { ...v.docPart, category: c || null } })} />
        </Fieldset>
      )}
    </WordDialog>
  );
}

/** Add Choice and Modify Choice, opened over Content Control Properties: one list item's Display Name and Value. The Value follows
 * the Display Name until it is typed in. `taken`: the other items' display names. → {display, value}, or null. */
export function ContentControlChoice({ title, item, taken = [], onClose }) {
  const [v, setV] = useState({ display: item?.display ?? '', value: item?.value ?? '' });
  const [own, setOwn] = useState(!!item && item.value !== item.display);
  const display = v.display.trim();
  const validate = () => {
    if (!display) return 'Type a display name.';
    if (taken.includes(display)) return 'An item with this display name is already in the list.';
    return null;
  };
  return (
    <WordDialog title={title} size="sm" onClose={onClose} validate={validate} result={() => ({ display, value: v.value.trim() || display })}>
      <Text id="cc-choice-display" label="&Display Name:" value={v.display} autoFocus
        onChange={(d) => setV((o) => ({ display: d, value: own ? o.value : d }))} />
      <Text id="cc-choice-value" label="&Value:" value={v.value} onChange={(val) => {
        setOwn(true);
        setV((o) => ({ ...o, value: val }));
      }} />
    </WordDialog>
  );
}

// ---------- legacy form fields ----------

/** Run macro on, Field settings and Add Help Text, shared by the three options dialogs. */
function Common({ v, set, enabledLabel }) {
  const help = async () => {
    const r = await ctxOf().dialog('formFieldHelpText', { status: v.status, help: v.help });
    if (r) set(r);
  };
  return (
    <>
      <Fieldset legend="Run macro on">
        <Row label="Entr&y:"><Pick value="" options={[['', '']]} onChange={() => {}} disabled width="8rem" /></Row>
        <Row label="E&xit:"><Pick value="" options={[['', '']]} onChange={() => {}} disabled width="8rem" /></Row>
      </Fieldset>
      <Fieldset legend="Field settings">
        <Text id="ff-bookmark" label="&Bookmark:" value={v.name} onChange={(n) => set({ name: n.replace(/\s/g, '').slice(0, 40) })} width="10rem" />
        <Check label="Ca&lculate on exit" checked={v.calcOnExit} onChange={(c) => set({ calcOnExit: c })} />
        <Check label={enabledLabel} checked={v.enabled} onChange={(e) => set({ enabled: e })} />
      </Fieldset>
      <div><Btn label="Add Help &Text..." onClick={help} /></div>
    </>
  );
}

/** Form Field Help Text: the Status Bar and Help Key (F1) tabs, each None or Type your own. → {status, help}. ponytail: the
 * AutoText entry choice waits for building-blocks' store. */
export function FormFieldHelpText({ status, help, onClose }) {
  const [v, setV] = useState({ status: status ?? null, help: help ?? null });
  const pane = (key) => () => (
    <>
      <Radio name={`ff-${key}`} value={v[key] == null ? 'none' : 'own'} onChange={(m) => setV((o) => ({ ...o, [key]: m === 'none' ? null : o[key] ?? '' }))}
        options={[['none', '&None'], ['own', 'T&ype your own:']]} />
      <TextArea aria-label="Type your own" disabled={v[key] == null} value={v[key] ?? ''} onChange={(e) => setV((o) => ({ ...o, [key]: e.target.value }))}
        className="h-24" maxLength={key === 'status' ? 138 : 255} />
    </>
  );
  return (
    <WordDialog title="Form Field Help Text" size="sm" onClose={onClose} result={() => v}
      tabs={[{ id: 'status', label: '&Status Bar', render: pane('status') }, { id: 'help', label: 'Help &Key (F1)', render: pane('help') }]} />
  );
}

/** Text Form Field Options. props.ff → the edited ff. */
export function TextFormFieldOptions({ ff, onClose }) {
  const [v, setV] = useState(ffForm('text', ff));
  const set = (patch) => setV((o) => ({ ...o, ...patch }));
  const formats = TEXT_FORMATS[v.type] ?? TEXT_FORMATS.regular;
  const defaultLabel = { regular: 'Default te&xt:', number: 'Default num&ber:', date: 'Default d&ate:', calculated: 'E&xpression:' }[v.type] ?? 'Default te&xt:';
  return (
    <WordDialog title="Text Form Field Options" size="md" onClose={onClose} result={() => formFf(ff ?? {}, v)}>
      <Fieldset legend="Text form field">
        <div className="grid grid-cols-2 gap-2">
          <Row label="T&ype:" htmlFor="ff-type">
            <Pick id="ff-type" value={v.type} options={TEXT_TYPES} onChange={(t) => set({ type: t, format: '', default: t === 'calculated' ? '=' : '' })} />
          </Row>
          <Text id="ff-default" label={defaultLabel} value={v.default} onChange={(d) => set({ default: d })} width="9rem"
            disabled={v.type === 'currentDate' || v.type === 'currentTime'} />
          <Spin label="&Maximum length:" value={v.maxLength || null} unit="int" min={1} max={32767} auto="Unlimited" width="7rem" onChange={(n) => set({ maxLength: n ?? 0 })} />
          <Row label="Text &format:" htmlFor="ff-format">
            <Pick id="ff-format" value={v.format} options={formats} onChange={(f) => set({ format: f })} />
          </Row>
        </div>
      </Fieldset>
      <Common v={v} set={set} enabledLabel="Fill-in e&nabled" />
    </WordDialog>
  );
}

/** Check Box Form Field Options. props.ff → the edited ff. */
export function CheckBoxFormFieldOptions({ ff, onClose }) {
  const [v, setV] = useState(ffForm('checkBox', ff));
  const set = (patch) => setV((o) => ({ ...o, ...patch }));
  return (
    <WordDialog title="Check Box Form Field Options" size="md" onClose={onClose} result={() => formFf(ff ?? {}, v)}>
      <Fieldset legend="Check box size">
        <Radio name="ff-size" value={v.size == null ? 'auto' : 'exact'} onChange={(m) => set({ size: m === 'auto' ? null : v.size ?? 10 })}
          options={[['auto', '&Auto'], ['exact', 'E&xactly:']]} />
        <Spin label={null} value={v.size ?? 10} unit="pt" min={1} max={1584} width="6rem" onChange={(n) => set({ size: n })} />
      </Fieldset>
      <Fieldset legend="Default value">
        <Radio name="ff-default" value={v.default ? 'on' : 'off'} onChange={(m) => set({ default: m === 'on' })} options={[['off', 'Not chec&ked'], ['on', '&Checked']]} />
      </Fieldset>
      <Common v={v} set={set} enabledLabel="Check box e&nabled" />
    </WordDialog>
  );
}

/** Drop-Down Form Field Options: up to 25 items, the first the default. props.ff → the edited ff. */
export function DropDownFormFieldOptions({ ff, onClose }) {
  const [v, setV] = useState(ffForm('dropDown', ff));
  const set = (patch) => setV((o) => ({ ...o, ...patch }));
  const [text, setText] = useState('');
  const [pick, setPick] = useState(0);
  const [error, setError] = useState('');
  const add = () => {
    const r = addDropItem(v.items, text);
    if (typeof r === 'string') return setError(r);
    setError('');
    set({ items: r });
    setText('');
    setPick(r.length - 1);
  };
  // The shown item (ff.result, an index) stays the same item when the list changes around it.
  const result = v.result ?? 0;
  const move = (d) => {
    const j = pick + d;
    if (j < 0 || j >= v.items.length) return;
    const items = [...v.items];
    [items[pick], items[j]] = [items[j], items[pick]];
    set({ items, result: result === pick ? j : result === j ? pick : result });
    setPick(j);
  };
  const remove = () => {
    const items = v.items.filter((_, j) => j !== pick);
    set({ items, result: pick < result ? result - 1 : Math.min(result, Math.max(0, items.length - 1)) });
    setPick(Math.max(0, Math.min(pick, items.length - 1)));
  };
  return (
    <WordDialog title="Drop-Down Form Field Options" size="md" onClose={onClose} result={() => formFf(ff ?? {}, { ...v, result: Math.min(v.result ?? 0, Math.max(0, v.items.length - 1)) })}>
      <Fieldset legend="Drop-down item">
        <div className="flex items-start gap-2">
          <div className="flex flex-col gap-1">
            <Text id="ff-item" label="Drop-down &item:" value={text} onChange={setText} width="9rem" />
            <div className="flex gap-1"><Btn label="&Add >>" onClick={add} disabled={!text.trim() || v.items.length >= DROP_MAX} />
              <Btn label="&Remove" onClick={remove} disabled={!v.items[pick]} /></div>
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="flex flex-col gap-1">
            <span><AccessText label="Items in drop-&down list:" /></span>
            <ListPick items={v.items.map((it, i) => [i, it])} value={pick} onChange={setPick} height="7rem" width="10rem" aria-label="Items in drop-down list" />
          </div>
          <div className="flex flex-col gap-1 pt-5">
            <Btn label="Move ↑" onClick={() => move(-1)} disabled={pick <= 0} />
            <Btn label="Move ↓" onClick={() => move(1)} disabled={pick >= v.items.length - 1} />
          </div>
        </div>
      </Fieldset>
      <Common v={v} set={set} enabledLabel="Drop-down e&nabled" />
    </WordDialog>
  );
}
