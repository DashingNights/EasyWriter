// Restrict Editing's dialogs: Start Enforcing Protection and Unprotect Document (protectDocument), Formatting Restrictions,
// Add Users (More users...) and Section Protection (Select sections...). Each resolves with its value; the pane applies it.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioInput } from '@/components/ui/radio';
import { Check, Fieldset, Radio, Row } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';

/** mode 'protect' → {password} ('' for none); mode 'unprotect' → {password}. A mismatch keeps the dialog open. The password lives
 * only in this dialog and the caller that hashes or checks it. */
export function ProtectDocument({ mode = 'protect', onClose }) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  if (mode === 'unprotect') {
    return (
      <WordDialog title="Unprotect Document" size="sm" onClose={onClose} result={() => ({ password: pw })}>
        <Row label="&Password:" htmlFor="protect-pw">
          <Input id="protect-pw" size="xs" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        </Row>
      </WordDialog>
    );
  }
  return (
    <WordDialog title="Start Enforcing Protection" size="sm" onClose={onClose} result={() => ({ password: pw })}
      validate={() => (pw !== again ? 'The passwords do not match.' : null)}>
      <Fieldset legend="Protection method">
        <Radio value="password" options={[['password', 'Pass&word']]} onChange={() => {}} />
        <div className="flex flex-col gap-2 pl-5">
          <Row label="&Enter new password (optional):" htmlFor="protect-pw">
            <Input id="protect-pw" size="xs" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
          </Row>
          <Row label="&Reenter password to confirm:" htmlFor="protect-again">
            <Input id="protect-again" size="xs" type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </Row>
        </div>
        <label className="flex w-fit items-center gap-2 opacity-50">
          <RadioInput disabled />User authentication
        </label>
        <p className="pl-5 text-muted-foreground">Needs an online service EasyWriter does not use.</p>
      </Fieldset>
    </WordDialog>
  );
}

// Word's Recommended Minimum: the styles a plain document uses.
const MINIMUM = ['Normal', 'Title', 'Subtitle', 'Heading1', 'Heading2', 'Heading3', 'Quote', 'ListParagraph'];

/** styles [[id, name]], value {locked: ids, autoFormatOverride, lockTheme, lockQFSet} → the same shape. Checked styles are allowed. */
export function FormattingRestrictions({ styles = [], value, onClose }) {
  const [locked, setLocked] = useState(() => new Set(value?.locked ?? []));
  const [flags, setFlags] = useState({ autoFormatOverride: !!value?.autoFormatOverride, lockTheme: !!value?.lockTheme, lockQFSet: !!value?.lockQFSet });
  const toggle = (id, allowed) => setLocked((s) => {
    const n = new Set(s);
    if (allowed) n.delete(id);
    else n.add(id);
    return n;
  });
  const flag = (k) => (v) => setFlags((f) => ({ ...f, [k]: v }));
  const buttons = [
    ['&All', () => setLocked(new Set())],
    ['&Recommended Minimum', () => setLocked(new Set(styles.map(([id]) => id).filter((id) => !MINIMUM.includes(id))))],
    ['&None', () => setLocked(new Set(styles.map(([id]) => id)))],
  ];
  return (
    <WordDialog title="Formatting Restrictions" size="sm" onClose={onClose} result={() => ({ locked: [...locked], ...flags })}>
      <Fieldset legend="Styles">
        <p>Limit formatting to a selection of styles. Checked styles are allowed.</p>
        <div className="flex h-48 flex-col gap-1 overflow-auto rounded-md border p-1.5" data-protect="styles">
          {styles.map(([id, name]) => <Check key={id} label={name} checked={!locked.has(id)} onChange={(v) => toggle(id, v)} />)}
        </div>
        <div className="flex gap-2">
          {buttons.map(([label, fn]) => (
            <Button key={label} type="button" variant="outline" size="xs" onClick={fn} {...accessProps(label)}>
              <AccessText label={label} />
            </Button>
          ))}
        </div>
      </Fieldset>
      <Fieldset legend="Formatting">
        <Check label="Allow AutoFormat to &override formatting restrictions" checked={flags.autoFormatOverride} onChange={flag('autoFormatOverride')} />
        <Check label="Block &Theme or Scheme switching" checked={flags.lockTheme} onChange={flag('lockTheme')} />
        <Check label="Block &Quick Style Set switching" checked={flags.lockQFSet} onChange={flag('lockQFSet')} />
      </Fieldset>
    </WordDialog>
  );
}

/** → the names typed, split at semicolons. */
export function AddUsers({ onClose }) {
  const [text, setText] = useState('');
  return (
    <WordDialog title="Add Users" size="sm" onClose={onClose} result={() => text.split(';').map((s) => s.trim()).filter(Boolean)}>
      <Row label="&Enter user names, separated by semicolons:" htmlFor="protect-users" />
      <Input id="protect-users" size="xs" autoFocus value={text} onChange={(e) => setText(e.target.value)} />
    </WordDialog>
  );
}

/** count sections, value bool[] → bool[] (true = protected for filling in forms). */
export function SectionProtection({ count = 1, value, onClose }) {
  const [on, setOn] = useState(() => Array.from({ length: count }, (_, i) => value?.[i] ?? true));
  return (
    <WordDialog title="Section Protection" size="sm" onClose={onClose} result={() => on}>
      <p>Protected sections:</p>
      <div className="flex max-h-48 flex-col gap-1 overflow-auto rounded-md border p-1.5">
        {on.map((v, i) => (
          <Check key={i} label={`Section ${i + 1}`} checked={v} onChange={(c) => setOn((a) => a.map((x, j) => (j === i ? c : x)))} />
        ))}
      </div>
    </WordDialog>
  );
}
