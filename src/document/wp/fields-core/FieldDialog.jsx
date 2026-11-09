// The Field dialog and its Field Options sub-dialog (docs/plans/word/plan.md §1.6; index-fields.md Field dialog and Per-field
// dialog panels; probe/dialogs/field.json, field-options-date.json and field-options-page.json win over the brief's wording).
// Default view: Categories, Field names and Description at the left, Field properties and Field options per field, Preserve
// formatting during updates; Field Codes view: the code box, the syntax line, Hide Codes and Options... (stacked over this one).
// → {code}. Fields whose middle pane is one button open their own dialog instead.
import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { getState } from '../../../app/store.js';
import { openDialog } from '../../../app/actions.js';
import { Check, Fieldset, ListPick, Pick, Row, rowClass } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { parseField } from '../../fields/registry.mjs';
import { CATEGORIES, FIELDS } from './catalogue.mjs';
import { datePicture } from './format.mjs';

/** The 17 date-time pictures of the en-US document language (index-fields.md Dialog lists). */
export const DATE_PICTURES = ['M/d/yyyy', 'dddd, MMMM d, yyyy', 'MMMM d, yyyy', 'M/d/yy', 'yyyy-MM-dd', 'd-MMM-yy', 'M.d.yyyy', 'MMM. d, yy',
  'd MMMM yyyy', 'MMMM yy', 'MMM-yy', 'M/d/yyyy h:mm am/pm', 'M/d/yyyy h:mm:ss am/pm', 'h:mm am/pm', 'h:mm:ss am/pm', 'HH:mm', 'HH:mm:ss'];
const NUMERIC = ['0', '0.00', '#,##0', '#,##0.00', '$#,##0.00;($#,##0.00)', '0%', '0.00%'];
const TEXT_FORMATS = [['', '(none)'], ['Upper', 'Uppercase'], ['Lower', 'Lowercase'], ['FirstCap', 'First capital'], ['Caps', 'Title case']];
// The PAGE list (probe), then the other number fields' extra entries (index-fields.md Number formats).
const PAGE_FORMATS = [['Arabic', '1, 2, 3, …'], ['ArabicDash', '- 1 -, - 2 -, - 3 -, …'], ['alphabetic', 'a, b, c, …'], ['ALPHABETIC', 'A, B, C, …'],
  ['roman', 'i, ii, iii, …'], ['ROMAN', 'I, II, III, …'], ['DBCHAR', 'Double byte …'], ['CHINESENUM3', '一, 二, 三 (简)…'],
  ['CHINESENUM2', '壹, 贰, 叁 …'], ['ZODIAC1', '甲, 乙, 丙 …'], ['ZODIAC2', '子, 丑, 寅 …'], ['ZODIAC3', '甲子, 乙丑, 丙寅 …'],
  ['GB1', '⒈, ⒉, ⒊ …'], ['GB2', '⑴, ⑵, ⑶ …'], ['GB3', '①, ②, ③ …'], ['GB4', '㈠, ㈡, ㈢ …'], ['CHINESENUM3 ', '一, 二, 三 (繁)…'],
  ['CHINESENUM2 ', '壹, 貳, 參 …'], ['', 'Use Default Numbering']];
const NUMBER_FORMATS = [['Arabic', '1, 2, 3, …'], ['alphabetic', 'a, b, c, …'], ['ALPHABETIC', 'A, B, C, …'], ['roman', 'i, ii, iii, …'],
  ['ROMAN', 'I, II, III, …'], ['Ordinal', '1st, 2nd, 3rd …'], ['CardText', 'One, Two, Three …'], ['OrdText', 'First Second, Third …'],
  ['Hex', 'hex …'], ['DollarText', 'Dollar Text'], ...PAGE_FORMATS.slice(6)];

/** The Format: list of a property kind and field. Values with a trailing space are Word's traditional-script twins of a switch. */
const formatsOf = (kind, name) => (kind === 'text' ? TEXT_FORMATS : kind === 'number' ? (name === 'PAGE' ? PAGE_FORMATS : NUMBER_FORMATS)
  : [...TEXT_FORMATS, ...NUMBER_FORMATS.slice(0, 10)]);

/** Every text argument of the document's bookmarks, styles or the AutoText entries a list property draws. */
function sourceItems(src) {
  const ed = getState().editor;
  const doc = ed?.state.doc;
  if (src === 'bookmarks' && doc) {
    const names = new Set();
    doc.descendants((n) => {
      if (n.type.name === 'bookmark' && !n.attrs.end && !/^_/.test(n.attrs.name)) names.add(n.attrs.name);
    });
    return [...names].sort();
  }
  if (src === 'styles' && doc) return Object.values(doc.attrs.styles ?? {}).map((s) => s?.name).filter(Boolean).sort();
  return [];
}

const quote = (s) => (/[\s"\\]/.test(s) || s === '' ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s);

/** Whether Preserve formatting applies to a field: every field with a result, so every field with general switches (Word writes
 * DATE \@ "M/d/yyyy" \* MERGEFORMAT although DATE takes no \* of its own). Fields without a result (XE, SET, ASK) keep it off. */
const keepsFormat = (row) => row[5] !== '';

/** The field code the default view's choices give (Word's order: name, arguments, field switches, general switches). */
export function buildCode(row, v, preserve) {
  const [, name, , , , , props, opts, , switches] = row;
  const parts = [name === '=' ? '=' : name];
  const first = (p) => p[0] === 'list' || /(Bookmark|Macro) name/.test(p[1]);
  for (const p of [...props.filter(first), ...props.filter((p) => !first(p))]) {
    const val = v.props[p[1]];
    if ((p[0] === 'box' || p[0] === 'list') && val) parts.push(quote(val));
  }
  opts.forEach(([, at, takes], i) => {
    const on = v.opts[i];
    if (!on || at < 0) return;
    parts.push(switches[at][0]);
    if (takes && v.vals[i]) parts.push(quote(v.vals[i]));
  });
  for (const p of props) {
    const val = v.props[p[1]];
    if (!val) continue;
    if (p[0] === 'date') parts.push(`\\@ "${val}"`);
    else if (p[0] === 'numeric') parts.push(`\\# ${quote(val)}`);
    else if (p[0] === 'text' || p[0] === 'number' || p[0] === 'both') parts.push(`\\* ${val.trim()}`);
  }
  if (preserve && keepsFormat(row)) parts.push('\\* MERGEFORMAT');
  return parts.join(' ');
}

/** The default view's values read back from `code` (Edit Field...). */
function valuesOf(row, code) {
  const v = { props: {}, opts: {}, vals: {} };
  if (!code) return v;
  const f = parseField(code);
  const [, , , , , , props, opts, , switches] = row;
  let arg = 0;
  const first = (p) => p[0] === 'list' || /(Bookmark|Macro) name/.test(p[1]);
  for (const p of [...props.filter(first), ...props.filter((p) => !first(p))]) {
    if (p[0] === 'box' || p[0] === 'list') v.props[p[1]] = f.args[arg++] ?? '';
    if (p[0] === 'date' && f.date != null) v.props[p[1]] = f.date;
    if (p[0] === 'numeric' && f.numeric != null) v.props[p[1]] = f.numeric;
    if (['text', 'number', 'both'].includes(p[0])) v.props[p[1]] = f.format.find((x) => !/^(merge|char)format/i.test(x)) ?? '';
  }
  opts.forEach(([, at], i) => {
    const key = switches[at]?.[0]?.[1]?.toLowerCase();
    if (key && f.sw[key] !== undefined) {
      v.opts[i] = true;
      if (typeof f.sw[key] === 'string') v.vals[i] = f.sw[key];
    }
  });
  return v;
}

// The fields whose middle pane is one button, and the dialog it opens (index-fields.md Field dialog).
const BUTTONS = { '=': 'formula', HYPERLINK: 'insertHyperlink', INDEX: 'index', TA: 'markCitation', TOA: 'tableOfAuthorities',
  TOC: 'tableOfContents', XE: 'markIndexEntry', DATABASE: null };
// Fields with no properties open straight into Field Codes view.
const CODES_ONLY = new Set(['AUTONUMOUT', 'BIBLIOGRAPHY', 'BIDIOUTLINE', 'CITATION', 'COMPARE', 'EQ', 'IF', 'MERGEREC', 'MERGESEQ', 'NEXT',
  'NEXTIF', 'PRINT', 'PRIVATE', 'SEQ', 'SKIPIF']);

/** A plain list box (Word's Field names list). */
function ListBox({ items, value, onChange, height = '16rem', label }) {
  return (
    <div role="listbox" aria-label={label} tabIndex={0} style={{ height }} className="overflow-auto rounded-md border border-input bg-background text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const i = items.findIndex(([v]) => v === value);
        const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) onChange(next[0]);
      }}>
      {items.map(([v, text]) => (
        <div key={v} role="option" aria-selected={v === value} data-value={v} onClick={() => onChange(v)}
          className={`cursor-default truncate px-1.5 py-0.5 ${rowClass(v === value)}`}>{text}</div>
      ))}
    </div>
  );
}

/** The Field dialog. Props: `code` and `pos` for Edit Field... → {code} or null. */
export function FieldDialog({ code: start = '', onClose }) {
  const startName = start ? parseField(start).name : '=';
  const [cat, setCat] = useState(-1);
  const [name, setName] = useState(FIELDS.find((r) => r[1] === startName)?.[1] ?? '=');
  const row = FIELDS.find((r) => r[1] === name) ?? FIELDS[0];
  const [values, setValues] = useState(() => ({ [row[1]]: valuesOf(row, start) }));
  const v = values[name] ?? { props: {}, opts: {}, vals: {} };
  const setV = (patch) => setValues((o) => ({ ...o, [name]: { ...v, ...patch } }));
  const [preserve, setPreserve] = useState(!start || /\\\*\s*MERGEFORMAT/i.test(start));
  const [codes, setCodes] = useState(CODES_ONLY.has(startName));
  const [typed, setTyped] = useState(start ? null : '');
  const names = FIELDS.filter((r) => cat < 0 || r[2].includes(cat)).map((r) => [r[1], r[0]]);
  const pick = (n) => {
    setName(n);
    setCodes(CODES_ONLY.has(n));
    setTyped(null);
  };
  const button = Object.hasOwn(BUTTONS, name);
  const built = buildCode(row, v, preserve);
  const code = codes && typed != null ? typed : codes ? (start && name === startName ? start : `${name} `) : built;
  const now = useMemo(() => new Date(), []);

  const prop = (p) => {
    const [kind, label, items] = p;
    const val = v.props[label] ?? '';
    const set = (x) => setV({ props: { ...v.props, [label]: x } });
    const id = `fld-${label.replace(/\W/g, '')}`;
    if (kind === 'date') {
      return (
        <Row key={label} label={label} htmlFor={id}>
          <ListPick id={id} width="16rem" height="9rem" items={DATE_PICTURES.map((x) => [x, datePicture(now, x)])} value={val}
            text={val} onText={set} onChange={set} />
        </Row>
      );
    }
    if (kind === 'numeric') {
      return (
        <Row key={label} label={label} htmlFor={id}>
          <ListPick id={id} width="12rem" height="6rem" items={NUMERIC.map((x) => [x, x])} value={val} text={val} onText={set} onChange={set} />
        </Row>
      );
    }
    if (kind === 'text' || kind === 'number' || kind === 'both') {
      return (
        <Row key={label} label={label} htmlFor={id}>
          <ListBox label={label} height="9rem" items={formatsOf(kind, name)} value={val} onChange={set} />
        </Row>
      );
    }
    const list = Array.isArray(items) ? items : items ? sourceItems(items) : null;
    return (
      <Row key={label} label={label} htmlFor={id}>
        {list ? (
          <ListPick id={id} width="14rem" height="6rem" items={list.map((x) => [x, x])} value={val} text={val} onText={set} onChange={set} />
        ) : (
          <Input id={id} aria-label={label} value={val} onChange={(e) => set(e.target.value)} size="xs" className="w-56" />
        )}
      </Row>
    );
  };

  const options = async () => {
    const r = await openDialog('fieldOptions', { name, code, general: row[5], switches: row[9] });
    if (r?.code) setTyped(r.code);
  };

  const left = codes
    ? [{ label: 'H&ide Codes', onClick: () => setCodes(false), disabled: CODES_ONLY.has(name) }]
    : [{ label: 'F&ield Codes', onClick: () => setCodes(true), disabled: button }];

  return (
    <WordDialog title="Field" size="lg" onClose={onClose} left={left}
      validate={() => (button ? 'Use the button in Field properties for this field.' : null)}
      result={() => ({ code: code.trim() })}>
      <div className="flex min-h-[24rem] gap-3">
        <div className="flex w-56 shrink-0 flex-col gap-2">
          <span>Please choose a field</span>
          <Row label="&Categories:" htmlFor="fld-cat">
            <Pick id="fld-cat" value={cat} options={[[-1, '(All)'], ...CATEGORIES.map((c, i) => [i, c])]} onChange={(c) => setCat(Number(c))} />
          </Row>
          <span {...accessProps('&Field names:')}><AccessText label="&Field names:" /></span>
          <ListBox label="Field names" items={names} value={name} onChange={pick} />
          <span>Description:</span>
          <span className="text-muted-foreground" data-field-description="">{row[3]}</span>
        </div>
        <div className="w-px shrink-0 bg-border" />
        {codes ? (
          <div className="flex flex-1 flex-col gap-2">
            <span>Advanced field properties</span>
            <Row label="Field codes&:" htmlFor="fld-codes">
              <Input id="fld-codes" aria-label="Field codes" value={code} onChange={(e) => setTyped(e.target.value)} spellCheck={false} size="xs" className="font-mono" />
            </Row>
            <span className="text-muted-foreground" data-field-syntax="">{row[4]}</span>
            <div><Button type="button" variant="outline" size="xs" onClick={options} {...accessProps('&Options...')}><AccessText label="&Options..." /></Button></div>
          </div>
        ) : button ? (
          <div className="flex flex-1 flex-col gap-2">
            <span>Field properties</span>
            <span className="text-muted-foreground">Click the button below to set advanced field options</span>
            <div>
              <Button type="button" variant="outline" size="xs" disabled={!BUTTONS[name]}
                title={BUTTONS[name] ? undefined : 'This needs a database connection, which the app does not have.'}
                onClick={() => {
                  onClose(null);
                  openDialog(BUTTONS[name], {});
                }}>{row[8]}</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-1 flex-col gap-2">
              <Fieldset legend="Field properties">{row[6].length ? row[6].map(prop) : <span className="text-muted-foreground">No field properties</span>}</Fieldset>
            </div>
            <div className="w-px shrink-0 bg-border" />
            <div className="flex w-64 shrink-0 flex-col gap-2">
              <Fieldset legend="Field options">
                {row[7].length ? row[7].map(([label, , takes], i) => (
                  <div key={label} className="flex flex-col gap-1">
                    <Check label={label} checked={!!v.opts[i]} onChange={(on) => setV({ opts: { ...v.opts, [i]: on } })} />
                    {takes ? (
                      <Input aria-label={label} value={v.vals[i] ?? ''} disabled={!v.opts[i]} onChange={(e) => setV({ vals: { ...v.vals, [i]: e.target.value } })} size="xs" className="ml-5 w-40" />
                    ) : null}
                  </div>
                )) : <span className="text-muted-foreground">No field options available for this field</span>}
              </Fieldset>
            </div>
          </>
        )}
      </div>
      <Check label="Preser&ve formatting during updates" checked={preserve} onChange={setPreserve} disabled={!keepsFormat(row)} />
    </WordDialog>
  );
}

/** Field Options (Field Codes > Options...): General Switches and Field Specific Switches, or one Options tab for a field without
 * switches of its own. Each tab: a list, Add to Field, Undo Add, the code and the selected item's description. → {code}. */
export function FieldOptionsDialog({ name, code: start, general = '', switches = [], onClose }) {
  const [code, setCode] = useState(start);
  const [undo, setUndo] = useState([]);
  const [picked, setPicked] = useState({});
  const now = useMemo(() => new Date(), []);
  const add = (text) => {
    setUndo((u) => [...u, code]);
    setCode(`${code.trimEnd()} ${text} `);
  };
  const lists = [];
  if (general.includes('@')) lists.push({ id: 'date', label: '&Date-time:', items: DATE_PICTURES.map((x) => [x, x]), sw: (x) => `\\@ "${x}"`, desc: (x) => `Date-Time display options (date-time picture switch). ${datePicture(now, x)}` });
  if (general.includes('#')) lists.push({ id: 'numeric', label: '&Numeric formats:', items: NUMERIC.map((x) => [x, x]), sw: (x) => `\\# ${quote(x)}`, desc: () => 'Numeric display options (numeric picture switch)' });
  if (general.includes('*')) lists.push({ id: 'format', label: switches.length ? 'F&ormatting:' : 'F&ormatting:', items: formatsOf(name === 'PAGE' ? 'number' : 'both', name).filter(([x]) => x), sw: (x) => `\\* ${x.trim()}`, desc: () => 'Formatting options (format switch)' });
  const specific = { id: 'switch', label: 'S&witches:', items: switches.map(([s]) => [s, s]), sw: (x) => x, desc: (x) => `${x} ${switches.find(([s]) => s === x)?.[1] ?? ''}` };
  const tabBody = (group) => () => (
    <div className="flex gap-3">
      <div className="flex flex-col gap-2">
        {group.map((l) => (
          <Row key={l.id} label={l.label} htmlFor={`fo-${l.id}`}>
            <ListBox label={l.label.replace('&', '')} height="8rem" items={l.items} value={picked[l.id]} onChange={(x) => setPicked({ ...picked, [l.id]: x, last: l.id })} />
          </Row>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-2">
        <Button type="button" variant="outline" size="xs" disabled={!group.some((l) => picked[l.id] != null)}
          {...accessProps('&Add to Field')} onClick={() => {
            const l = group.find((x) => x.id === picked.last) ?? group.find((x) => picked[x.id] != null);
            if (l) add(l.sw(picked[l.id]));
          }}><AccessText label="&Add to Field" /></Button>
        <Button type="button" variant="outline" size="xs" disabled={!undo.length} {...accessProps('&Undo Add')}
          onClick={() => {
            setCode(undo[undo.length - 1]);
            setUndo(undo.slice(0, -1));
          }}><AccessText label="&Undo Add" /></Button>
        <Row label="&Field codes:" htmlFor="fo-code">
          <Input id="fo-code" aria-label="Field codes" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} size="xs" className="font-mono" />
        </Row>
        <Fieldset legend="Description">
          <span className="text-muted-foreground">{(() => {
            const l = group.find((x) => x.id === picked.last) ?? group[0];
            return l && picked[l.id] != null ? l.desc(picked[l.id]) : '';
          })()}</span>
        </Fieldset>
      </div>
    </div>
  );
  const tabs = switches.length && lists.length
    ? [{ id: 'general', label: '&General Switches', render: tabBody(lists) }, { id: 'specific', label: 'Field &Specific Switches', render: tabBody([specific]) }]
    : [{ id: 'options', label: '&Options', render: tabBody(lists.length ? lists : [specific]) }];
  return <WordDialog title="Field Options" size="md" onClose={onClose} tabs={tabs} result={() => ({ code: code.trim() })} />;
}
