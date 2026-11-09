// Word Options pages this package registers (module `options`; probe/dialogs/word-options.json): Customize Ribbon and Quick
// Access Toolbar. The options package draws them in its dialog. A page edits the dialog's working copy through `set` when the
// dialog passes one (written on OK, as its brief says), else it saves at once.
import { useState } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Tip } from '../../../app/components/Tip.jsx';
import { useStore } from '../../../app/store.js';
import { Check, Pick, Row } from '../../../tooling/kit/controls.jsx';
import { REASONS } from '../../../tooling/reasons.mjs';
import { run } from '../../../tooling/registry.js';
import * as SPEC from '../../ribbon/spec.mjs';
import { wordSettings, WORD_DEFAULTS } from '../../word/settings.mjs';
import { moveQat, QAT_MENU } from './nav.mjs';
import { saveRibbon } from './state.js';

/** The ribbon choices a page shows and how it changes them: the dialog's working copy (`word`, `set`) or the saved ones. */
function useRibbonChoices({ word, set }) {
  const saved = useStore((s) => wordSettings(s.settings).ribbon);
  const ribbon = word?.ribbon ? { ...saved, ...word.ribbon } : saved;
  const change = (patch) => (set ? set({ ribbon: patch }) : saveRibbon(patch));
  return [ribbon, change];
}

const pending = REASONS.pending;

/** A button the page shows but cannot do yet: drawn disabled with the reason in its tooltip. */
const Later = ({ children }) => (
  <Tip title={pending}><Button type="button" size="xs" variant="outline" disabled>{children}</Button></Tip>
);

/** A command's label in the pages' lists: the spec control's or menu item's, else the Quick Access Toolbar menu's. */
const labelOf = (id) => SPEC.CONTROLS[id]?.label ?? SPEC.ITEMS[id]?.label ?? QAT_MENU.find((x) => x.id === id)?.label ?? id;

const POPULAR = [...new Set([...QAT_MENU.filter((x) => !x.needs).map((x) => x.id), 'home.clipboard.copy', 'home.clipboard.cut',
  'home.clipboard.paste', 'home.clipboard.formatPainter', 'home.font.font', 'home.font.fontSize', 'home.font.fontColor', 'home.paragraph.bullets',
  'home.paragraph.numbering', 'home.paragraph.alignLeft', 'home.paragraph.center', 'home.editing.find', 'insert.tables.table', 'insert.links.link',
  'references.footnotes.insertFootnote', 'review.changes.accept'])].filter((id) => labelOf(id) !== id).sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
const ALL = Object.keys(SPEC.CONTROLS).filter((id) => !SPEC.CONTROLS[id].extra).sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
const SOURCES = [['popular', 'Popular Commands'], ['all', 'All Commands']];

/** A plain list box of command ids with one picked. */
function CommandList({ ids, value, onPick, label }) {
  return (
    <div role="listbox" aria-label={label} className="h-64 w-56 overflow-auto rounded-md border border-input bg-background text-xs">
      {ids.map((id, i) => (
        <div key={`${id}-${i}`} role="option" aria-selected={id === value} data-command={id} onClick={() => onPick(id)}
          className={cn('cursor-default truncate px-1.5 py-0.5', id === value ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}>{labelOf(id)}</div>
      ))}
    </div>
  );
}

/** Options > Customize Ribbon: the commands beside the main tabs, each with its box; only Developer's is live. */
export function CustomizeRibbonPage(props) {
  const [ribbon, change] = useRibbonChoices(props);
  const [from, setFrom] = useState('popular');
  const [pick, setPick] = useState(null);
  const tabs = SPEC.TABS.filter((t) => !t.context);
  return (
    <div data-options-page="customizeRibbon" className="flex flex-col gap-3 text-xs">
      <p className="font-medium">Customize the Ribbon and keyboard shortcuts.</p>
      <div className="flex gap-3">
        <div className="flex flex-col gap-1.5">
          <Row label="&Choose commands from"><Pick aria-label="Choose commands from" value={from} options={SOURCES} onChange={setFrom} /></Row>
          <CommandList label="Commands" ids={from === 'all' ? ALL : POPULAR} value={pick} onPick={setPick} />
        </div>
        <div className="flex flex-col justify-center gap-2"><Later>Add &gt;&gt;</Later><Later>&lt;&lt; Remove</Later></div>
        <div className="flex flex-col gap-1.5">
          <Row label="Customize the Ri&bbon"><Pick aria-label="Customize the Ribbon" value="main" options={[['main', 'Main Tabs']]} onChange={() => {}} /></Row>
          <div role="tree" aria-label="Ribbon" className="flex h-64 w-56 flex-col gap-1 overflow-auto rounded-md border border-input bg-background p-1.5">
            <span className="font-medium">Main Tabs</span>
            {tabs.map((t) => (t.hidden
              ? <div key={t.id} role="treeitem" data-tab-box={t.id}><Check label={t.label} checked={!!ribbon.developer} onChange={(on) => change({ developer: on })} /></div>
              : <Tip key={t.id} title={pending} wrap="w-fit"><div role="treeitem" data-tab-box={t.id}><Check label={t.label} checked disabled onChange={() => {}} /></div></Tip>))}
          </div>
          <div className="flex flex-wrap gap-1.5"><Later>New Tab</Later><Later>New Group</Later><Later>Rename...</Later></div>
          <div className="flex items-center gap-1.5">Customizations: <Later>Reset</Later><Later>Import/Export</Later></div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        Keyboard shortcuts:
        <Button type="button" size="xs" variant="outline" data-feature="options.customizeKeyboard" onClick={() => run('options.customizeKeyboard')}>Customize...</Button>
      </div>
    </div>
  );
}

/** Options > Quick Access Toolbar: the commands beside the bar's own, with Add, Remove, Move Up, Move Down, the position,
 * Show Quick Access Toolbar and Reset. */
export function QatPage(props) {
  const [ribbon, change] = useRibbonChoices(props);
  const [from, setFrom] = useState('popular');
  const [left, setLeft] = useState(null);
  const [right, setRight] = useState(null);
  const qat = ribbon.qat;
  const add = () => left && !qat.includes(left) && (change({ qat: [...qat, left] }), setRight(left));
  const remove = () => right && change({ qat: qat.filter((x) => x !== right) });
  return (
    <div data-options-page="qat" className="flex flex-col gap-3 text-xs">
      <p className="font-medium">Customize the Quick Access Toolbar.</p>
      <div className="flex gap-3">
        <div className="flex flex-col gap-1.5">
          <Row label="&Choose commands from"><Pick aria-label="Choose commands from" value={from} options={SOURCES} onChange={setFrom} /></Row>
          <CommandList label="Commands" ids={from === 'all' ? ALL : POPULAR} value={left} onPick={setLeft} />
        </div>
        <div className="flex flex-col justify-center gap-2">
          <Button type="button" size="xs" variant="outline" data-qat-add disabled={!left || qat.includes(left)} onClick={add}>Add &gt;&gt;</Button>
          <Button type="button" size="xs" variant="outline" data-qat-remove disabled={!right} onClick={remove}>&lt;&lt; Remove</Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="h-6 leading-6">Customize Quick Access Toolbar</span>
          <CommandList label="Customize Quick Access Toolbar" ids={qat} value={right} onPick={setRight} />
        </div>
        <div className="flex flex-col justify-center gap-2">
          <Button type="button" size="xs" variant="outline" aria-label="Move Up" disabled={!right || qat[0] === right} onClick={() => change({ qat: moveQat(qat, right, -1) })}>Move Up</Button>
          <Button type="button" size="xs" variant="outline" aria-label="Move Down" disabled={!right || qat.at(-1) === right} onClick={() => change({ qat: moveQat(qat, right, 1) })}>Move Down</Button>
        </div>
      </div>
      <Check label="&Show Quick Access Toolbar" checked={!ribbon.qatHidden} onChange={(on) => change({ qatHidden: !on })} />
      <Row label="T&oolbar Position">
        <Pick aria-label="Toolbar Position" value={ribbon.qatBelow ? 'below' : 'above'} options={[['below', 'Below Ribbon'], ['above', 'Above Ribbon']]}
          onChange={(v) => change({ qatBelow: v === 'below' })} />
      </Row>
      <Tip title={pending} wrap="w-fit"><Check label="A&lways show command labels" checked={false} disabled onChange={() => {}} /></Tip>
      <div className="flex items-center gap-2">Customizations:
        <Button type="button" size="xs" variant="outline" onClick={() => change({ qat: WORD_DEFAULTS.ribbon.qat, qatBelow: false, qatHidden: false })}>Reset</Button>
        <Later>Import/Export</Later>
      </div>
    </div>
  );
}
