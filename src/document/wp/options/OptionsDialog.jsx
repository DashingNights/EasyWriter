// Word's Options dialog (docs/plans/word/briefs/options.md): a page list on the left, the page's sections scrolling on the right.
// Edits stay in the dialog until OK, which writes one saveWord patch, the app keys through changeSettings (so the theme applies),
// the draft's rows as one undoable setDocSettings step and the store's overtype. Cancel and Esc write nothing.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { changeSettings, openDialog, openSettings } from '../../../app/actions.js';
import { Help } from '../../../app/components/Tip.jsx';
import { getState, useStore } from '../../../app/store.js';
import { Check, Pick, rowClass, Row, Spin, TextArea } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { REASONS } from '../../../tooling/reasons.mjs';
import { commandOf, ctxOf, implemented, optionsPages, registered, run } from '../../../tooling/registry.js';
import { setWord } from '../../../tooling/ribbon/contexts.js';
import { activeSurface } from '../../../tooling/surface.js';
import { DOC_SETTINGS } from '../../defaults.mjs';
import { deepMerge, saveWord, wordSettings } from '../../word/settings.mjs';
import { EXCLUDED, initialOf, keyOf, PAGE_LABELS, PAGES, pageOf, patchesOf } from './pages.mjs';

// The dialog registry imports every module, this one among them, so it is read once the modules have loaded.
let dialogs = {};
import('../../../tooling/dialogs.js').then((m) => { dialogs = m.WORD_DIALOGS; });

export const UNBUILT = 'Saved now. It takes effect once that feature is built.';

// The open Options dialog's commit (apply the edits and close), so Customize Keyboard can leave it for Settings: openDialog keeps
// one Settings at a time over the stack, and the app's Settings dialog is a different window from this one.
let open = null;

/** Closes an open Options dialog as OK does, then opens Settings at `section`. */
export function leaveForSettings(section) {
  open?.commit();
  return openSettings(section);
}

/** Writes the patches of patchesOf. */
async function apply({ word, app, doc, state }) {
  if (word) await saveWord(word);
  if (app) await changeSettings(app);
  if (doc) activeSurface()?.editor?.chain().setDocSettings(doc).run();
  if (state) setWord(state);
}

const sectionId = (id) => `word-options-${id}`;

export function OptionsDialog({ tab, page, section, onClose }) {
  const settings = useStore((s) => s.settings);
  const ed = activeSurface()?.editor ?? null;
  const [initial] = useState(() => initialOf({
    word: wordSettings(settings), app: settings, doc: deepMerge(DOC_SETTINGS, ed?.state.doc.attrs.settings ?? {}), state: getState().word,
  }));
  const [edits, setEdits] = useState({});
  const extra = useMemo(() => optionsPages().filter(([id]) => !EXCLUDED.includes(id)), []);
  const list = [...PAGES, ...extra.map(([id, Component]) => ({ id, label: PAGE_LABELS[id] ?? id, Component }))];
  const [at, setAt] = useState(() => pageOf({ tab, page }, list.map((p) => p.id)));
  const known = useMemo(() => [...registered(), ...Object.keys(implemented())], []);
  const pane = useRef(null);

  const commit = () => {
    const patches = patchesOf(edits, initial);
    apply(patches);
    return patches;
  };
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => {
    const own = { commit: () => onClose(latest.current()) };
    open = own;
    return () => { if (open === own) open = null; };
  }, [onClose]);
  // {section} opens the page scrolled to that heading.
  useLayoutEffect(() => {
    if (section) document.getElementById(sectionId(section))?.scrollIntoView({ block: 'start' });
  }, [section]);

  const value = (r) => (keyOf(r) in edits ? edits[keyOf(r)] : initial[keyOf(r)]);
  const set = (r) => (v) => setEdits((e) => ({ ...e, [keyOf(r)]: v }));
  const shown = list.find((p) => p.id === at) ?? list[0];
  const go = (id) => {
    setAt(id);
    if (pane.current) pane.current.scrollTop = 0;
  };

  return (
    <WordDialog title="Options" size="lg" onClose={onClose} result={commit}>
      <div data-word-options="" className="flex h-[min(34rem,65vh)] min-h-0 gap-3">
        {/* 2 px between the pages, so the open one's ground and a hovered one's never touch (as the sidebar's rows) */}
        <nav aria-label="Options pages" className="flex w-44 shrink-0 flex-col gap-0.5 overflow-auto border-r pr-2">
          {list.map((p) => (
            <Button key={p.id} type="button" variant="ghost" size="sm" data-options-page={p.id} aria-current={p === shown ? 'page' : undefined} onClick={() => go(p.id)}
              className="h-auto justify-start py-1 text-left whitespace-normal text-muted-foreground aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground">{p.label}</Button>
          ))}
        </nav>
        <div ref={pane} data-options-body={shown.id} className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto pr-2">
          {shown.Component ? <shown.Component ctx={ctxOf()} /> : (
            <>
              <p>{shown.title}</p>
              {shown.sections.map((s) => (
                <section key={s.id} id={sectionId(s.id)} data-section={s.id} className="flex scroll-mt-1 flex-col gap-2">
                  <h3 className="border-b pb-1 font-semibold">{s.title}</h3>
                  <div className="flex flex-col gap-2 pl-1">
                    {s.rows.map((r, i) => <OptionRow key={r.label ?? i} row={r} value={value(r)} onChange={set(r)} known={known} ed={ed} />)}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </WordDialog>
  );
}

/** The (?) of a row: why it is disabled, or that it is stored but waits for its reader. */
function rowHelp(row, known, ed) {
  if (row.store === 'doc' && !ed) return 'Open a document to change this.';
  if (row.kind !== 'button' && 'needs' in row) return row.help ?? REASONS[row.needs];
  if (row.path && row.reader !== undefined && (row.reader === null || !known.includes(row.reader))) return UNBUILT;
  return null;
}

function OptionRow({ row, value, onChange, known, ed }) {
  const id = useId();
  const help = rowHelp(row, known, ed);
  const disabled = 'needs' in row || (row.store === 'doc' && !ed);
  const tail = help && <Help>{help}</Help>;
  const mark = { 'data-option': row.path ?? row.label, 'data-unbuilt': help === UNBUILT || undefined };
  switch (row.kind) {
    case 'check':
      return (
        <div className="flex items-center gap-1" {...mark}>
          <Check label={row.label} checked={row.invert ? !value : !!value} disabled={disabled} onChange={(c) => onChange(row.invert ? !c : c)} />
          {tail}
        </div>
      );
    case 'pick':
      return (
        <div className="flex items-center gap-1" {...mark}>
          <Row label={row.label} htmlFor={id}>
            <Pick id={id} value={row.in ? row.in(value) : value ?? row.value} options={row.options} disabled={disabled} className="max-w-72"
              onChange={(v) => onChange(row.out ? row.out(v) : v)} />
          </Row>
          {tail}
        </div>
      );
    case 'text':
      return (
        <div className="flex items-center gap-1" {...mark}>
          <Row label={row.label} htmlFor={id}>
            <Input id={id} size="xs" value={value ?? ''} style={{ width: row.width ?? '16rem' }} onChange={(e) => onChange(e.target.value)} />
          </Row>
          {tail}
        </div>
      );
    case 'area':
      return (
        <div className="flex flex-col gap-1" {...mark}>
          <div className="flex items-center gap-1">
            <label htmlFor={id} {...accessProps(row.label)}><AccessText label={row.label} /></label>
            {tail}
          </div>
          <TextArea id={id} rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)}
            className="w-80" />
        </div>
      );
    case 'spin':
      return (
        <div className="flex items-center gap-1" {...mark}>
          <Spin label={row.label} value={value ?? 0} onChange={onChange} unit={row.unit} min={row.min} max={row.max} />
          {tail}
        </div>
      );
    case 'draftFont':
      return <DraftFont row={row} value={value} onChange={onChange} tail={tail} mark={mark} />;
    case 'languages':
      return <Languages value={value ?? []} onChange={onChange} tail={tail} mark={mark} />;
    case 'note':
      return <p className="text-muted-foreground">{row.text}</p>;
    case 'button':
      return <ActionButton row={row} />;
    default:
      return null;
  }
}

/** A button that opens another dialog (stacked over Options), runs a command, or leaves for the app's Settings. Its target not
 * built yet: drawn disabled with the pending reason. */
function ActionButton({ row }) {
  const ready = row.dialog ? !!dialogs[row.dialog] : row.command ? !!commandOf(row.command) : true;
  const press = () => {
    if (row.dialog) openDialog(row.dialog, {});
    else if (row.command) run(row.command, row.arg);
    else if (row.settings) leaveForSettings(row.settings);
  };
  return (
    <div className="flex items-center gap-2" data-option={row.label}>
      {row.text && <span>{row.text}</span>}
      <Button type="button" variant="outline" size="sm" disabled={!ready} onClick={press} {...accessProps(row.label)}>
        <AccessText label={row.label} />
      </Button>
      {!ready && <Help>{REASONS.pending}</Help>}
    </div>
  );
}

/** Use draft font in Draft and Outline views with its Name and Size: display.draftFont null (off) or {name, size}. */
function DraftFont({ row, value, onChange, tail, mark }) {
  const id = useId();
  const font = value ?? { name: 'Courier New', size: 10 };
  return (
    <div className="flex flex-col gap-1.5" {...mark}>
      <div className="flex items-center gap-1">
        <Check label={row.label} checked={!!value} onChange={(c) => onChange(c ? font : null)} />
        {tail}
      </div>
      <div className={cn('flex items-center gap-4 pl-6', !value && 'pointer-events-none opacity-50')}>
        <Row label="Nam&e:" htmlFor={id}>
          <Input id={id} size="xs" className="w-40" value={font.name} disabled={!value} onChange={(e) => onChange({ ...font, name: e.target.value })} />
        </Row>
        <Spin label="Si&ze:" value={font.size} unit="pt" min={1} max={1638} width="5rem" onChange={(size) => onChange({ ...font, size })} />
      </div>
    </div>
  );
}

const names = new Intl.DisplayNames(['en'], { type: 'language' });
const nameOf = (code) => {
  try { return `${names.of(code)} (${code})`; } catch { return code; }
};

/** The editing and proofing languages (proofing.languages, Chromium spell checker codes), the first preferred. */
function Languages({ value, onChange, tail, mark }) {
  const [picked, setPicked] = useState(0);
  const [code, setCode] = useState('');
  const [have, setHave] = useState([]);
  const listId = useId();
  useEffect(() => {
    Promise.resolve((globalThis.__wordTest?.spell ?? window.api?.word?.spell)?.languages?.()).then((l) => setHave(Array.isArray(l) ? l : []), () => {});
  }, []);
  const add = () => {
    const c = code.trim();
    if (!c || value.includes(c)) return;
    onChange([...value, c]);
    setCode('');
  };
  const sel = value[picked];
  return (
    <div className="flex flex-col gap-1.5" {...mark}>
      <div className="flex items-center gap-1"><span>Editing languages</span>{tail}</div>
      <div role="listbox" aria-label="Editing languages" className="h-28 w-96 overflow-auto rounded-md border border-input bg-background text-xs">
        {value.map((c, i) => (
          <div key={c} role="option" aria-selected={i === picked} onClick={() => setPicked(i)}
            className={cn('cursor-default px-1.5 py-0.5', rowClass(i === picked))}>
            {nameOf(c)}{i === 0 ? ' <preferred>' : ''}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Input size="xs" className="w-32" list={listId} placeholder="en-GB" aria-label="Language code" value={code} onChange={(e) => setCode(e.target.value)} />
        <datalist id={listId}>{have.filter((c) => !value.includes(c)).map((c) => <option key={c} value={c}>{nameOf(c)}</option>)}</datalist>
        <Button type="button" variant="outline" size="sm" onClick={add} {...accessProps('&Add a Language')}><AccessText label="&Add a Language" /></Button>
        <Button type="button" variant="outline" size="sm" disabled={!sel || value.length < 2} {...accessProps('&Remove')}
          onClick={() => { onChange(value.filter((c) => c !== sel)); setPicked(0); }}><AccessText label="&Remove" /></Button>
        <Button type="button" variant="outline" size="sm" disabled={!sel || picked === 0} {...accessProps('Set as &Preferred')}
          onClick={() => { onChange([sel, ...value.filter((c) => c !== sel)]); setPicked(0); }}><AccessText label="Set as &Preferred" /></Button>
      </div>
    </div>
  );
}
