// The Write & Insert Fields and Rules dialogs (docs/plans/word/briefs/mailings.md): Address Block, Greeting Line, Insert Merge Field,
// Match Fields, the Insert Word Field dialogs of Rules (one dialog configured per rule), Check for Errors and the merge range of
// Finish & Merge. Each resolves with the field code or the choice; the commands insert or act.
import { useMemo, useState } from 'react';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { openDialog } from '../../../app/actions.js';
import { Help } from '../../../app/components/Tip.jsx';
import { Check, Fieldset, ListPick, Pick, Preview, Radio, Row, TextArea } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { parseField } from '../../fields/registry.mjs';
import { active, ADDRESS_FIELDS } from './data.mjs';
import { addressBlock, addressCode, greetingCode, greetingLine, makeCursor, mergeFieldCode } from './fields.mjs';
import { Btn } from './Lists.jsx';

/** The record arrows under a preview: First, Previous, the position, Next, Last over `count` records. */
function RecordArrows({ at, setAt, count }) {
  const go = (n) => setAt(Math.max(0, Math.min(count - 1, n)));
  const arrow = (label, Icon, n, off) => (
    <Button type="button" variant="ghost" size="icon-xs" aria-label={label} disabled={off} onClick={() => go(n)}><Icon /></Button>
  );
  return (
    <div className="flex items-center gap-0.5 text-xs">
      {arrow('First', ChevronFirst, 0, at <= 0)}
      {arrow('Previous', ChevronLeft, at - 1, at <= 0)}
      <span className="px-1 tabular-nums">{count ? at + 1 : 0}</span>
      {arrow('Next', ChevronRight, at + 1, at >= count - 1)}
      {arrow('Last', ChevronLast, count - 1, at >= count - 1)}
    </div>
  );
}

/** A preview of field `code` for the records of `source`: `fn(parsed, cursor)` gives the text. */
function useRecordPreview(source, merge, map) {
  const list = useMemo(() => (source ? active(source, merge) : []), [source, merge]);
  const [at, setAt] = useState(0);
  const cursor = source && list.length ? makeCursor(source, { ...merge, map }, list, at) : null;
  return { list, at, setAt, cursor };
}

const NAME_FORMATS = [
  ['<<_FIRST0_>>', 'Sam'],
  ['<<_FIRST0_>><< _LAST0_>>', 'Sam Lee'],
  ['<<_TITLE0_ >><<_FIRST0_>><< _LAST0_>><< _SUFFIX0_>>', 'Mr. Sam Lee Jr.'],
  ['<<_TITLE0_ >><<_FIRST0_>><< _MIDDLE0_>><< _LAST0_>><< _SUFFIX0_>>', 'Mr. Sam Q. Lee Jr.'],
  ['<<_TITLE0_ >><<_LAST0_>>', 'Mr. Lee'],
  ['<<_FIRST0_>><< _MIDDLE0_>><< _LAST0_>>', 'Sam Q. Lee'],
  ['<<_LAST0_>><<, _FIRST0_>>', 'Lee, Sam'],
  ['<<_LAST0_>><<, _TITLE0_>><< _FIRST0_>>', 'Lee, Mr. Sam'],
];
const POSTAL = '<<_STREET1_\\n>><<_STREET2_\\n>><<_CITY_>><<, _STATE_>><< _POSTAL_>><<\\n_COUNTRY_>>';

/** Insert Address Block. Props {source, merge}. → {code, map} or null. */
export function InsertAddressBlock({ source, merge, onClose }) {
  const [name, setName] = useState(NAME_FORMATS[2][0]);
  const [company, setCompany] = useState(true);
  const [postal, setPostal] = useState(true);
  const [country, setCountry] = useState(2);
  const [exclude, setExclude] = useState('United States');
  const [destination, setDestination] = useState(true);
  const [map, setMap] = useState(merge?.map ?? {});
  const format = `${name}\\n${company ? '<<_COMPANY_\\n>>' : ''}${postal ? POSTAL : ''}`;
  const code = addressCode({ format, country: postal ? country : 0, exclude, destination });
  const { list, at, setAt, cursor } = useRecordPreview(source, merge, map);
  const match = async () => {
    const m = await openDialog('matchFields', { fields: source?.fields ?? [], map });
    if (m) setMap(m);
  };
  return (
    <WordDialog title="Insert Address Block" size="lg" onClose={onClose} result={() => ({ code, map })}>
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-3">
          <Fieldset legend="Specify address elements">
            <span className="text-xs">Insert recipient's name in this format:</span>
            <ListPick aria-label="Name format" items={NAME_FORMATS} value={name} onChange={setName} height="7rem" />
            <Check label="Insert &company name" checked={company} onChange={setCompany} />
            <Check label="Insert postal &address:" checked={postal} onChange={setPostal} />
            <div className="pl-5">
              <Radio name="mm-country" value={country} onChange={setCountry}
                options={[[0, '&Never include the country/region in the address'], [1, 'Al&ways include the country/region in the address'],
                  [2, 'Only include the country/region if &different than:']]} />
              <Input size="xs" aria-label="Excluded country/region" className="mt-1 ml-5 w-48" value={exclude} disabled={country !== 2}
                onChange={(e) => setExclude(e.target.value)} />
            </div>
            <Check label="&Format address according to the destination country/region" checked={destination} onChange={setDestination} />
          </Fieldset>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs">Here is a preview from your recipient list:</span>
          <RecordArrows at={at} setAt={setAt} count={list.length} />
          <Preview height="9rem">
            <div className="text-xs whitespace-pre-line" data-merge-sample="">
              {cursor ? addressBlock(parseField(code), cursor) : '«AddressBlock»'}
            </div>
          </Preview>
          <span className="flex items-center gap-1 text-xs">Correct problems<Help>If items in your address block are missing or out of order, use Match Fields to pick the right columns.</Help></span>
          <Btn label="&Match Fields..." onClick={match} className="w-fit" />
        </div>
      </div>
    </WordDialog>
  );
}

const GREETING_NAMES = [
  ['<<_TITLE0_>><< _LAST0_>>', 'Mr. Lee'],
  ['<<_FIRST0_>>', 'Sam'],
  ['<<_TITLE0_>><< _FIRST0_>><< _LAST0_>>', 'Mr. Sam Lee'],
  ['<<_FIRST0_>><< _LAST0_>>', 'Sam Lee'],
  ['<<_NICK0_>>', 'Sammy'],
  ['<<_TITLE0_>><< _FIRST0_>>', 'Mr. Sam'],
];

/** Insert Greeting Line. Props {source, merge}. → {code, map} or null. */
export function InsertGreetingLine({ source, merge, onClose }) {
  const [word, setWord] = useState('Dear');
  const [name, setName] = useState(GREETING_NAMES[0][0]);
  const [punct, setPunct] = useState(',');
  const [empty, setEmpty] = useState('Dear Sir or Madam,');
  const [map, setMap] = useState(merge?.map ?? {});
  const format = `${word ? `<<_BEFORE_ ${word} >>` : ''}${name}${punct ? `<<_AFTER_ ${punct}>>` : ''}`;
  const code = greetingCode({ format, empty });
  const { list, at, setAt, cursor } = useRecordPreview(source, merge, map);
  const match = async () => {
    const m = await openDialog('matchFields', { fields: source?.fields ?? [], map });
    if (m) setMap(m);
  };
  return (
    <WordDialog title="Insert Greeting Line" size="md" onClose={onClose} result={() => ({ code, map })}>
      <Fieldset legend="Greeting line format:">
        <div className="flex gap-2">
          <Pick aria-label="Greeting" value={word} options={[['Dear', 'Dear'], ['To', 'To'], ['', '(none)']]} onChange={setWord} />
          <Pick aria-label="Name format" value={name} options={GREETING_NAMES} onChange={setName} />
          <Pick aria-label="Punctuation" value={punct} options={[[',', ','], [':', ':'], ['!', '!'], ['', '(none)']]} onChange={setPunct} />
        </div>
      </Fieldset>
      <Fieldset legend="Greeting line for invalid recipient names:">
        <Pick aria-label="Greeting line for invalid recipient names" value={empty} onChange={setEmpty}
          options={[['Dear Sir or Madam,', 'Dear Sir or Madam,'], ['To Whom It May Concern:', 'To Whom It May Concern:'], ['', '(none)']]} />
      </Fieldset>
      <Fieldset legend="Preview">
        <RecordArrows at={at} setAt={setAt} count={list.length} />
        <Preview height="4.5rem"><span className="text-xs" data-merge-sample="">{cursor ? greetingLine(parseField(code), cursor) : '«GreetingLine»'}</span></Preview>
      </Fieldset>
      <Btn label="&Match Fields..." onClick={match} className="w-fit" />
    </WordDialog>
  );
}

/** Insert Merge Field: Address Fields (mapped, \m) or Database Fields (the columns). Props {source, merge}. → {name, mapped, map} or
 * null. */
export function InsertMergeField({ source, merge, onClose }) {
  const fields = source?.fields ?? [];
  const [map, setMap] = useState(merge?.map ?? {});
  const [kind, setKind] = useState(fields.length ? 'database' : 'address');
  const names = kind === 'database' ? fields : ADDRESS_FIELDS.map((a) => a.label);
  const [pick, setPick] = useState(names[0] ?? '');
  const choose = (k) => {
    setKind(k);
    setPick((k === 'database' ? fields : ADDRESS_FIELDS.map((a) => a.label))[0] ?? '');
  };
  return (
    <WordDialog title="Insert Merge Field" size="sm" okText="Insert" onClose={onClose} result={() => (pick ? { name: pick, mapped: kind === 'address', map } : null)}>
      <Fieldset legend="Insert:">
        <div className="flex gap-4"><Radio name="mm-imf" value={kind} onChange={choose} options={[['address', '&Address Fields'], ['database', '&Database Fields']]} /></div>
      </Fieldset>
      <span className="text-xs">&nbsp;Fields:</span>
      <ListPick aria-label="Fields" items={names.map((n) => [n, n])} value={pick} onChange={setPick} height="9rem" />
      <Btn label="&Match Fields..." disabled={kind !== 'address'} onClick={async () => setMap((await openDialog('matchFields', { fields, map })) ?? map)} className="w-fit" />
    </WordDialog>
  );
}

/** Match Fields: each of Word's address fields against a column or (not matched). Props {fields, map}. → map or null. */
export function MatchFields({ fields, map, onClose }) {
  const [m, setM] = useState(() => ({ ...map }));
  const options = [['', '(not matched)'], ...fields.map((f) => [f, f])];
  return (
    <WordDialog title="Match Fields" size="md" onClose={onClose} result={() => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v || null]))}>
      <p className="text-xs">Mail merge uses these columns of your list for its address parts. Pick the column for each part.</p>
      <div className="grid max-h-80 grid-cols-[10rem_1fr] items-center gap-x-3 gap-y-1 overflow-auto text-xs" data-match-fields="">
        {ADDRESS_FIELDS.map((a) => [
          <label key={`l${a.key}`} htmlFor={`mm-match-${a.key}`}>{a.label}</label>,
          <Pick key={a.key} id={`mm-match-${a.key}`} value={m[a.key] ?? ''} options={options} onChange={(v) => setM((o) => ({ ...o, [a.key]: v }))} />,
        ])}
      </div>
    </WordDialog>
  );
}

// ---------- Rules ----------

const RULE_OPS = [['eq', 'Equal to'], ['ne', 'Not equal to'], ['lt', 'Less than'], ['gt', 'Greater than'], ['le', 'Less than or equal'],
  ['ge', 'Greater than or equal'], ['blank', 'Is blank'], ['nonblank', 'Is not blank']];
const OP_CODE = { eq: '=', ne: '<>', lt: '<', gt: '>', le: '<=', ge: '>=', blank: '=', nonblank: '<>' };
const q = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const condition = (v) => `{ ${mergeFieldCode(v.field)} } ${OP_CODE[v.op]} ${v.op === 'blank' || v.op === 'nonblank' ? '""' : q(v.value)}`;

// Each rule: its title, the parts it asks for and the code it writes.
const RULES = {
  insertWordFieldAsk: { title: 'Insert Word Field: Ask', parts: ['bookmark', 'prompt', 'defaultText:&Default bookmark text:', 'once'],
    code: (v) => `ASK ${v.bookmark} ${q(v.prompt)}${v.defaultText ? ` \\d ${q(v.defaultText)}` : ''}${v.once ? ' \\o' : ''}`, valid: (v) => v.bookmark },
  insertWordFieldFillIn: { title: 'Insert Word Field: Fill-in', parts: ['prompt', 'defaultText:&Default fill-in text:', 'once'],
    code: (v) => `FILLIN ${q(v.prompt)}${v.defaultText ? ` \\d ${q(v.defaultText)}` : ''}${v.once ? ' \\o' : ''}`, valid: () => true },
  ifThenElse: { title: 'Insert Word Field: IF', parts: ['condition', 'then', 'otherwise'],
    code: (v) => `IF ${condition(v)} ${q(v.then)} ${q(v.otherwise)}`, valid: (v) => v.field },
  nextRecordIf: { title: 'Insert Word Field: Next Record If', parts: ['condition'], code: (v) => `NEXTIF ${condition(v)}`, valid: (v) => v.field },
  skipRecordIf: { title: 'Insert Word Field: Skip Record If', parts: ['condition'], code: (v) => `SKIPIF ${condition(v)}`, valid: (v) => v.field },
  setBookmark: { title: 'Insert Word Field: Set', parts: ['bookmark', 'value'], code: (v) => `SET ${v.bookmark} ${q(v.value)}`, valid: (v) => v.bookmark },
};

/** One Insert Word Field dialog configured per rule (`rule`: a RULES key). Props {rule, fields, bookmarks}. → field code or null. */
export function RuleDialog({ rule, fields = [], bookmarks = [], onClose }) {
  const spec = RULES[rule];
  const [v, setV] = useState({ bookmark: bookmarks[0] ?? '', prompt: '', defaultText: '', once: false, field: fields[0] ?? '', op: 'eq', value: '', then: '', otherwise: '' });
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const text = (key, label, area = false) => (
    <div key={key} className="flex flex-col gap-1">
      <Row label={label} htmlFor={`mm-rule-${key}`} />
      {area ? <TextArea id={`mm-rule-${key}`} className="h-14" value={v[key]} onChange={(e) => set(key)(e.target.value)} />
        : <Input id={`mm-rule-${key}`} size="xs" value={v[key]} onChange={(e) => set(key)(e.target.value)} />}
    </div>
  );
  const parts = spec.parts.map((p) => {
    const [key, label] = p.split(':&').length > 1 ? [p.split(':')[0], p.slice(p.indexOf(':') + 1)] : [p, null];
    if (key === 'bookmark') {
      return (
        <div key="bookmark" className="flex flex-col gap-1">
          <Row label="&Bookmark:" htmlFor="mm-rule-bookmark" />
          <ListPick id="mm-rule-bookmark" items={bookmarks.map((b) => [b, b])} value={v.bookmark} text={v.bookmark} onText={set('bookmark')} onChange={set('bookmark')} height="3.5rem" />
        </div>
      );
    }
    if (key === 'prompt') return text('prompt', '&Prompt:', true);
    if (key === 'defaultText') return text('defaultText', label);
    if (key === 'once') return <Check key="once" label="Ask &once" checked={v.once} onChange={set('once')} />;
    if (key === 'value') return text('value', '&Value:', true);
    if (key === 'then') return text('then', '&Insert this text:', true);
    if (key === 'otherwise') return text('otherwise', '&Otherwise insert this text:', true);
    return (
      <div key="condition" className="grid grid-cols-3 gap-2 text-xs">
        <Row label="&Field name:" htmlFor="mm-rule-field" />
        <Row label="&Comparison:" htmlFor="mm-rule-op" />
        <Row label="Compare &to:" htmlFor="mm-rule-value" />
        <Pick id="mm-rule-field" value={v.field} options={fields.map((f) => [f, f])} onChange={set('field')} />
        <Pick id="mm-rule-op" value={v.op} options={RULE_OPS} onChange={set('op')} />
        <Input id="mm-rule-value" size="xs" value={v.value} disabled={v.op === 'blank' || v.op === 'nonblank'} onChange={(e) => set('value')(e.target.value)} />
      </div>
    );
  });
  return (
    <WordDialog title={spec.title} size="md" onClose={onClose} result={() => spec.code(v)}
      validate={() => (spec.valid(v) ? null : key0(spec) === 'bookmark' ? 'Type a bookmark name.' : 'Pick a field.')}>
      {parts}
    </WordDialog>
  );
}
const key0 = (spec) => spec.parts[0].split(':')[0];

/** The dialogs of Rules, by dialog id. */
export const RULE_DIALOGS = Object.fromEntries(Object.keys(RULES).map((id) => [id, (props) => <RuleDialog {...props} rule={id} />]));

// ---------- Check for Errors and the merge range ----------

/** Checking and Reporting Errors. → 'simulate' | 'pause' | 'complete' or null. */
export function CheckingAndReportingErrors({ onClose }) {
  const [v, setV] = useState('simulate');
  return (
    <WordDialog title="Checking and Reporting Errors" size="md" onClose={onClose} result={() => v}>
      <Radio name="mm-errors" value={v} onChange={setV} options={[
        ['simulate', '&Simulate the merge and report errors in a new document.'],
        ['pause', '&Complete the merge, pausing to report each error as it occurs.'],
        ['complete', 'Complete the merge &without pausing. Report errors in a new document.'],
      ]} />
    </WordDialog>
  );
}

/** Merge to New Document and Merge to Printer: All, Current record, or From and To. Props {title, current, count}. → {from, to} or null. */
export function MergeRange({ title, current = 1, count = 1, onClose }) {
  const [which, setWhich] = useState('all');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState(String(count));
  const result = () => (which === 'all' ? { from: 1, to: count } : which === 'current' ? { from: current, to: current }
    : { from: Math.max(1, Number(from) || 1), to: Math.min(count, Number(to) || count) });
  return (
    <WordDialog title={title} size="sm" onClose={onClose} result={result}
      validate={() => (which === 'range' && (Number(from) || 0) > (Number(to) || 0) ? 'From must not be after To.' : null)}>
      <Fieldset legend="Merge records">
        <Radio name="mm-range" value={which} onChange={setWhich} options={[['all', '&All'], ['current', 'Current r&ecord'], ['range', '&From:']]} />
        <div className="flex items-center gap-2 pl-5 text-xs">
          <Input size="xs" aria-label="From" className="w-16" value={from} disabled={which !== 'range'} onChange={(e) => setFrom(e.target.value)} />
          <Row label="&To:" htmlFor="mm-range-to">
            <Input id="mm-range-to" size="xs" className="w-16" value={to} disabled={which !== 'range'} onChange={(e) => setTo(e.target.value)} />
          </Row>
        </div>
      </Fieldset>
    </WordDialog>
  );
}
export const EditIndividualDocuments = (props) => <MergeRange {...props} title="Merge to New Document" />;
export const PrintDocuments = (props) => <MergeRange {...props} title="Merge to Printer" />;
