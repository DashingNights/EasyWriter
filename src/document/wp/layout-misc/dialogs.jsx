// The Line Numbers, Hyphenation, Manual Hyphenation and Drop Cap dialogs (probe/dialogs/line-numbers.json, hyphenation.json,
// drop-cap.json). Each applies its own change on OK and resolves null, as Page Setup does; Manual Hyphenation resolves the chosen
// break (Yes), false (No) or null (Cancel). On a canvas draft the row passes the current values as `value` (read from the engine) and
// the dialog resolves the edited values for the row to write (src/document/canvas/rows/page.mjs).
import { useState } from 'react';
import { ctxOf, run } from '../../../tooling/registry.js';
import { Check, Fieldset, ListPick, Radio, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { fontLabel, fontsNow } from '../../fonts.js';
import { sectionAt, sectionsOf } from '../../model/sections.mjs';
import { applyDropCap, dropCapOf, setLineNumbers } from './edit.js';
import { LN_DEFAULTS, lnNumOf } from './logic.mjs';

// A disabled fieldset greys every control inside it, as Word does until Add line numbering (or a drop cap position) is picked.
const Off = ({ off, children }) => (
  <fieldset disabled={off} className="flex min-w-0 flex-col gap-2 border-0 p-0 disabled:opacity-50">{children}</fieldset>
);

export function LineNumbersDialog({ section, value, onClose }) {
  const ctx = ctxOf();
  const doc = value ? null : ctx.ed?.state.doc;
  const ln = doc ? (section != null ? sectionsOf(doc)[section]?.sect.lnNum : sectionAt(sectionsOf(doc), ctx.ed.state.selection.from).sect.lnNum) : null;
  const [v, setV] = useState(() => value ?? { on: !!ln, ...LN_DEFAULTS, ...(ln ?? {}) });
  const set = (patch) => setV((old) => ({ ...old, ...patch }));
  const result = () => {
    if (value) return v;
    const next = lnNumOf(v);
    setLineNumbers(ctx, () => next, section);
    return null;
  };
  return (
    <WordDialog title="Line Numbers" size="sm" result={result} onClose={onClose}>
      <Check label="Add &line numbering" checked={v.on} onChange={(on) => set({ on })} />
      <Off off={!v.on}>
        <div className="flex flex-col gap-2 pl-6">
          <Spin label="St&art at:" unit="int" value={v.start} min={1} max={32767} onChange={(start) => set({ start })} />
          <Spin label="From &text:" unit="len" value={v.distance || null} auto="Auto" min={0} max={1584} onChange={(distance) => set({ distance: distance ?? 0 })} />
          <Spin label="Count &by:" unit="int" value={v.countBy} min={1} max={100} onChange={(countBy) => set({ countBy })} />
          <Row label="Numbering:" />
          <div className="pl-6">
            <Radio name="lnRestart" value={v.restart} onChange={(restart) => set({ restart })}
              options={[['newPage', 'Restart each &page'], ['newSection', 'Re&start each section'], ['continuous', '&Continuous']]} />
          </div>
        </div>
      </Off>
    </WordDialog>
  );
}

export function HyphenationDialog({ value, onClose }) {
  const ctx = ctxOf();
  const s = value ? { hyphenationZone: value.zone } : ctx.ed?.state.doc.attrs.settings ?? {};
  const [v, setV] = useState(() => value ?? { auto: !!s.autoHyphenation, caps: !s.doNotHyphenateCaps, limit: s.consecutiveHyphenLimit ?? 0 });
  const set = (patch) => setV((old) => ({ ...old, ...patch }));
  const apply = () => !value && ctx.ed?.chain().focus().command(({ tr }) => {
    const old = tr.doc.attrs.settings ?? {};
    const next = { ...old, autoHyphenation: v.auto, doNotHyphenateCaps: !v.caps, consecutiveHyphenLimit: v.limit };
    if (JSON.stringify(next) !== JSON.stringify(old)) tr.setDocAttribute('settings', next);
    return true;
  }).run();
  // Manual... keeps what the dialog holds and starts Manual hyphenation, as Word's button does.
  const manual = () => {
    if (value) return onClose({ ...v, manual: true }); // the row writes it, then starts Manual
    apply();
    onClose(null);
    setTimeout(() => run('layout.pageSetup.hyphenation.manual'));
  };
  return (
    <WordDialog title="Hyphenation" size="sm" result={() => (value ? v : (apply(), null))} onClose={onClose} left={[{ label: '&Manual...', onClick: manual }]}>
      <Check label="&Automatically hyphenate document" checked={v.auto} onChange={(auto) => set({ auto })} />
      <Check label="Hyphenate words in &CAPS" checked={v.caps} onChange={(caps) => set({ caps })} />
      {/* The probe drew the zone disabled: it shows the stored value and keeps it. */}
      <Off off>
        <Spin label="Hyphenation &zone:" unit="len" value={s.hyphenationZone ?? 18} min={0.05} max={1584} onChange={() => {}} />
      </Off>
      <Spin label="&Limit consecutive hyphens to:" unit="int" value={v.limit || null} auto="No limit" min={0} max={32767}
        onChange={(limit) => set({ limit: limit ?? 0 })} />
    </WordDialog>
  );
}

/** One prompt of Manual hyphenation: the word with its possible breaks marked and the proposed one selected; a click between two
 * letters (or Left and Right) moves it. */
export function ManualHyphenationDialog({ word = '', breaks = [], at, onClose }) {
  const [k, setK] = useState(at ?? breaks.at(-1) ?? 1);
  const move = (d) => setK((x) => Math.min(word.length - 1, Math.max(1, x + d)));
  return (
    <WordDialog title="Manual Hyphenation: English (United States)" size="sm" okText="Yes" result={() => k} onClose={onClose}
      left={[{ label: '&No', onClick: () => onClose(false) }]}>
      <Row label="Hyphenate &at:" htmlFor="manualHyphenationWord">
        <div id="manualHyphenationWord" tabIndex={0} role="slider" aria-valuemin={1} aria-valuemax={word.length - 1} aria-valuenow={k}
          data-word={word} data-at={k} className="flex rounded-md border border-input px-1.5 py-0.5 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); move(e.key === 'ArrowLeft' ? -1 : 1); } }}>
          {[...word].map((ch, i) => (
            <span key={i} className="flex">
              {i > 0 && (
                <button type="button" tabIndex={-1} aria-label={`Break after ${word.slice(0, i)}`} onClick={() => setK(i)}
                  className={i === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}>{breaks.includes(i) || i === k ? '-' : ' '}</button>
              )}
              <span>{ch}</span>
            </span>
          ))}
        </div>
      </Row>
    </WordDialog>
  );
}

const POSITIONS = [['none', '&None'], ['drop', '&Dropped'], ['margin', 'In &margin']];

export function DropCapDialog({ value, onClose }) {
  const ctx = ctxOf();
  const [v, setV] = useState(() => value ?? dropCapOf(ctx.state));
  const set = (patch) => setV((old) => ({ ...old, ...patch }));
  const fonts = [['', '+Body'], ...fontsNow().map((f) => [f, fontLabel(f)])];
  return (
    <WordDialog title="Drop Cap" size="sm" result={() => (value ? v : (applyDropCap(ctx.ed, v), null))} onClose={onClose}>
      <Fieldset legend="Position">
        <Radio name="dropCapPosition" value={v.position} onChange={(position) => set({ position })} options={POSITIONS} />
      </Fieldset>
      <Fieldset legend="Options">
        <Off off={v.position === 'none'}>
          <Row label="&Font:" />
          <ListPick items={fonts} value={v.font} onChange={(font) => set({ font: font ?? '' })} aria-label="Font" />
          <Spin label="&Lines to drop:" unit="int" value={v.lines} min={1} max={10} onChange={(lines) => set({ lines })} />
          <Spin label="Distance from te&xt:" unit="len" value={v.distance} min={0} max={1584} onChange={(distance) => set({ distance })} />
        </Off>
      </Fieldset>
    </WordDialog>
  );
}
