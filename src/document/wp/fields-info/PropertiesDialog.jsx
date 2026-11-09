// Advanced Properties (File > Info > Properties > Advanced Properties), titled "<draft title> Properties": General and Statistics read
// the draft record, Summary edits the core and app properties, Contents lists the title and headings, Custom edits the custom
// properties. Resolves with a patch of what changed (the command merges it as one step) or null. The probe has no capture of
// this dialog yet: labels and access keys follow Word's English dialog as remembered (recorded).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, ListPick, Pick, Radio, Row, rowClass } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { customText, parseValue } from './fields.mjs';
import { sizeText } from './info.js';

// Word's suggested custom property names, in its order.
const SUGGESTED = ['Checked by', 'Client', 'Date completed', 'Department', 'Destination', 'Disposition', 'Division', 'Document number', 'Editor',
  'Forward to', 'Group', 'Language', 'Mailstop', 'Matter', 'Office', 'Owner', 'Project', 'Publisher', 'Purpose', 'Received from', 'Recorded by',
  'Recorded date', 'Reference', 'Source', 'Status', 'Telephone number', 'Typist'];
const TYPES = [['text', 'Text'], ['date', 'Date'], ['number', 'Number'], ['bool', 'Yes or no']];
const TYPE_LABEL = Object.fromEntries(TYPES);

// Summary boxes: [label, props path, read only].
const SUMMARY = [
  ['&Title:', 'core.title'], ['&Subject:', 'core.subject'], ['&Author:', 'core.creator'], ['&Manager:', 'app.manager'],
  ['Comp&any:', 'app.company'], ['Cat&egory:', 'core.category'], ['&Keywords:', 'core.keywords'], ['&Comments:', 'core.description'],
  ['&Hyperlink base:', 'app.hyperlinkBase'], ['Template:', 'app.template', true],
];
const at = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
const idOf = (path) => `adv-${path.replace('.', '-')}`;

/** A read-only line: label left, value right. */
const Line = ({ label, children }) => (
  <div className="grid grid-cols-[9rem_1fr] gap-2"><span className="text-muted-foreground">{label}</span><span className="min-w-0 truncate">{children}</span></div>
);

/** A Summary box's starting text: Author shows the Word user name while no author is set, as the AUTHOR field and Info do. */
const shown = (info, path) => at(info.props, path) ?? (path === 'core.creator' ? info.user : '');

/** Props: info (info.js docInfo), tab ('general' | 'summary' | 'statistics' | 'contents' | 'custom'). */
export function AdvancedPropertiesDialog({ info, tab, onClose }) {
  const [summary, setSummary] = useState(() => Object.fromEntries(SUMMARY.map(([, p]) => [p, shown(info, p)])));
  const [custom, setCustom] = useState(() => [...(info.props.custom ?? [])]);
  const [name, setName] = useState('');
  const [hint, setHint] = useState(null); // the suggested name the list highlights; typing never replaces the typed name
  const [type, setType] = useState('text');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(tab ?? 'summary');
  const existing = custom.findIndex((c) => c.name.toLowerCase() === name.trim().toLowerCase());
  const date = info.date;

  const add = () => {
    const v = parseValue(type, value);
    if (v.error) return setError(v.error);
    setError('');
    const entry = { name: name.trim(), type, value: v.value };
    setCustom((list) => (existing >= 0 ? list.map((c, i) => (i === existing ? entry : c)) : [...list, entry]));
  };
  const remove = () => {
    setCustom((list) => list.filter((_, i) => i !== existing));
    setName('');
    setValue('');
  };
  const pickRow = (c) => {
    setName(c.name);
    setType(c.type);
    setValue(c.type === 'bool' ? (c.value ? 'yes' : 'no') : String(c.value ?? ''));
  };

  // Only what changed since the dialog opened, so OK merges with the current props (plan.md §1.8) and keeps edits made meanwhile.
  const result = () => {
    const patch = {};
    for (const [, path, readOnly] of SUMMARY) {
      const now = summary[path].trim();
      if (readOnly || now === shown(info, path)) continue; // the untouched user-name fallback writes no author
      const [group, key] = path.split('.');
      (patch[group] ??= {})[key] = now || null; // empty removes the key (deepPatch)
    }
    if (JSON.stringify(custom) !== JSON.stringify(info.props.custom ?? [])) patch.custom = custom;
    return patch;
  };

  const general = () => (
    <>
      <div className="text-base">{info.title}</div>
      <Line label="Type:">EasyWriter Document</Line>
      <Line label="Project:">{info.project || 'None'}</Line>
      <Line label="Size:">{sizeText(info.bytes, info.lang)}</Line>
      <Line label="Created:">{date(info.created)}</Line>
      <Line label="Modified:">{date(info.saved)}</Line>
    </>
  );
  const summaryTab = () => SUMMARY.map(([label, path, readOnly]) => (
    <Row key={path} label={label} htmlFor={idOf(path)}>
      <Input id={idOf(path)} size="xs" className="ml-auto w-72" readOnly={readOnly} disabled={readOnly}
        value={readOnly ? info.props.app?.template || 'Normal.dotm' : summary[path]}
        onChange={(e) => setSummary((s) => ({ ...s, [path]: e.target.value }))} />
    </Row>
  ));
  const statistics = () => (
    <>
      <Line label="Created:">{date(info.created)}</Line>
      <Line label="Modified:">{date(info.saved)}</Line>
      <Line label="Accessed:">{date(info.saved)}</Line>
      <Line label="Printed:">{date(info.printed)}</Line>
      <Line label="Last saved by:">{info.savedBy}</Line>
      <Line label="Revision number:">{info.revision}</Line>
      <Line label="Total editing time:">{`${info.editMinutes} Minutes`}</Line>
      <table className="mt-1 w-full border text-xs" data-statistics="">
        <thead><tr className="border-b text-left"><th className="px-2 py-1 font-normal">Statistic name</th><th className="px-2 py-1 font-normal">Value</th></tr></thead>
        <tbody>
          {[['Pages:', info.pages], ['Paragraphs:', info.paragraphs], ['Lines:', info.lines ?? ''], ['Words:', info.words],
            ['Characters:', info.noSpaces], ['Characters (with spaces):', info.chars]].map(([k, v]) => (
            <tr key={k}><td className="px-2 py-0.5">{k}</td><td className="px-2 py-0.5 tabular-nums">{v}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
  const contents = () => (
    <>
      <span>Document contents:</span>
      <div className="h-48 overflow-auto rounded-md border bg-background p-2 text-xs">
        <div>{info.props.core?.title || info.title}</div>
        {info.headings.map((h, i) => <div key={i} style={{ paddingLeft: `${h.level}rem` }}>{h.text}</div>)}
      </div>
    </>
  );
  const customTab = () => (
    <>
      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-2">
          <Row label="&Name:" htmlFor="adv-name">
            <ListPick id="adv-name" items={SUGGESTED.map((n) => [n, n])} value={hint} onChange={setHint} text={name} onText={setName} width="100%" />
          </Row>
          <Row label="&Type:" htmlFor="adv-type"><Pick id="adv-type" value={type} options={TYPES} onChange={(t) => { setType(t); setValue(''); }} width="10rem" /></Row>
          <Row label="&Value:" htmlFor="adv-value">
            {type === 'bool'
              ? <Radio value={value || 'yes'} options={[['yes', '&Yes'], ['no', '&No']]} onChange={setValue} />
              : <Input id="adv-value" size="xs" type={type === 'date' ? 'date' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} />}
          </Row>
          <Check label="Lin&k to content" checked={false} disabled onChange={() => {}} />
        </div>
        <div className="flex flex-col gap-2 pt-1">
          <Button type="button" size="sm" variant="outline" disabled={!name.trim() || (type !== 'bool' && !String(value).trim())} onClick={add} {...accessProps(existing >= 0 ? '&Modify' : '&Add')}>
            <AccessText label={existing >= 0 ? '&Modify' : '&Add'} />
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={existing < 0} onClick={remove} {...accessProps('&Delete')}><AccessText label="&Delete" /></Button>
        </div>
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <span {...accessProps('&Properties:')}><AccessText label="&Properties:" /></span>
      <div className="h-28 overflow-auto rounded-md border bg-background text-xs">
        <table className="w-full" data-custom-props="">
          <thead><tr className="border-b text-left"><th className="px-2 font-normal">Name</th><th className="px-2 font-normal">Value</th><th className="px-2 font-normal">Type</th></tr></thead>
          <tbody>
            {custom.map((c, i) => (
              <tr key={c.name} className={rowClass(i === existing)} onClick={() => pickRow(c)}>
                <td className="px-2">{c.name}</td><td className="px-2">{customText(c, info.lang)}</td><td className="px-2">{TYPE_LABEL[c.type]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );

  return (
    <WordDialog title={`${info.title} Properties`} size="md" onClose={onClose} result={result} tab={current} onTab={setCurrent}
      tabs={[
        { id: 'general', label: 'General', render: general },
        { id: 'summary', label: 'Summary', render: summaryTab },
        { id: 'statistics', label: 'Statistics', render: statistics },
        { id: 'contents', label: 'Contents', render: contents },
        { id: 'custom', label: 'Custom', render: customTab },
      ]} />
  );
}
