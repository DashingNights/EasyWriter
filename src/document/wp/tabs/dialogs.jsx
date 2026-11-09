// The Tabs and Alignment Tab dialogs (docs/plans/word/plan.md §1.6; labels, order and defaults from probe/dialogs/tabs.json).
// Tabs: nothing applies until OK; Set keeps the dialog open, Clear and Clear All queue stops in "Tab stops to be cleared".
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ctxOf } from '../../../tooling/registry.js';
import { useUnit, Fieldset, ListPick, Pick, Radio, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { formatLength, LIMITS, parseLength } from '../../../tooling/kit/units.mjs';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { MAX_TABS, tabStopsOf } from '../../model/tabs.mjs';
import { textblocks } from '../../lists.js';
import { addStop, ownTabs, same, valueTabs } from './stops.mjs';

const ALIGNS = [['left', '&Left'], ['center', '&Center'], ['right', '&Right'], ['decimal', '&Decimal'], ['bar', '&Bar']];
const LEADERS = [['none', '&1 None'], ['dot', '&2 .......'], ['hyphen', '&3 -------'], ['underscore', '&4 ____'], ['middleDot', '&5 ········']];
const TOO_MANY = 'A paragraph can hold at most 64 tab stops.';

/** Radio buttons laid out in rows of three, as Word's dialog draws them. */
const Grid = (props) => <div className="[&_[role=radiogroup]]:grid [&_[role=radiogroup]]:grid-cols-3 [&_[role=radiogroup]]:gap-x-4"><Radio {...props} /></div>;

/** A button with Word's access key. */
const Btn = ({ label, ...props }) => (
  <Button type="button" variant="outline" size="sm" className="flex-1" {...accessProps(label)} {...props}><AccessText label={label} /></Button>
);

/** Every selected paragraph's own `tabs` so that it shows its stops less `cleared` plus `set`, and the document's default stop
 * `def`, in one transaction of the dialog's editor. */
function apply(ctx, { set, cleared, def }) {
  return ctx.chain((c) => c.command(({ tr }) => {
    const { doc } = tr;
    for (const { node, pos } of textblocks({ doc, selection: tr.selection })) {
      const inherited = tabStopsOf(doc, { type: node.type, attrs: { ...node.attrs, tabs: null } }).stops;
      let want = tabStopsOf(doc, node).stops.filter((s) => !cleared.some((p) => same(p, s.pos)));
      for (const s of set) want = addStop(want, s) ?? want;
      const tabs = ownTabs(inherited, want.slice(0, MAX_TABS));
      if (JSON.stringify(tabs) !== JSON.stringify(node.attrs.tabs ?? null)) tr.setNodeAttribute(pos, 'tabs', tabs);
    }
    if (def !== (doc.attrs.settings?.defaultTabStop ?? 36)) tr.setDocAttribute('settings', { ...doc.attrs.settings, defaultTabStop: def });
    return true;
  }));
}

/** Format > Tabs. With {mode: 'value', value} it edits value.tabs and returns {tabs} instead of applying (G10); value.inherited, when
 * the caller passes the based-on chain's stops, lists them too so they can be cleared. Default tab stops is a document setting, not
 * part of the value, so value mode hides it. → {tabs} or null. */
export function TabsDialog({ mode, value, onClose, enginePara, engineSettings }) {
  const ctx = ctxOf();
  const unit = useUnit();
  const id = useId();
  const valued = mode === 'value';
  const [start] = useState(() => {
    if (valued) return tabStopsOf({}, { attrs: { tabs: [...(value?.inherited ?? []), ...(value?.tabs ?? [])] } }).stops;
    // A canvas draft: its row read the caret paragraph (para.state) and the document settings from the engine first.
    if (ctx.engine) return (enginePara?.tabs ?? []).filter((s) => s.align !== 'clear').map(({ pos, align, leader }) => ({ pos, align, leader }));
    const first = ctx.state && textblocks(ctx.state)[0]?.node;
    return first ? tabStopsOf(ctx.state.doc, first).stops : [];
  });
  const def0 = ctx.engine ? engineSettings?.defaultTab ?? 36 : ctx.state?.doc.attrs.settings?.defaultTabStop ?? 36;
  const [list, setList] = useState(start);
  const [cleared, setCleared] = useState([]);
  const [def, setDef] = useState(def0);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState(null);
  const [align, setAlign] = useState('left');
  const [leader, setLeader] = useState('none');

  const typed = () => {
    const pos = parseLength(text, unit);
    return pos != null && pos >= LIMITS.tab[0] && pos <= LIMITS.tab[1] ? pos : null;
  };
  const pick = (pos) => {
    const s = list.find((x) => x.pos === pos);
    setPicked(pos);
    if (s) {
      setAlign(s.align);
      setLeader(s.leader);
    }
  };
  /** Adds the typed stop to `l` → the new list, or null after saying why it cannot. */
  const withTyped = (l) => {
    const pos = typed();
    if (pos == null) {
      ctx.toast('Type a position such as 2.5 cm or 1".');
      return null;
    }
    const next = addStop(l, { pos, align, leader: align === 'bar' ? 'none' : leader });
    if (!next) ctx.toast(TOO_MANY);
    return next;
  };
  const doSet = () => {
    const next = withTyped(list);
    if (!next) return;
    const pos = typed();
    setList(next);
    setCleared((c) => c.filter((p) => !same(p, pos)));
    setPicked(pos);
    setText(formatLength(pos, unit));
  };
  const doClear = () => {
    setList((l) => l.filter((s) => s.pos !== picked));
    setCleared((c) => [...c, picked]);
    setPicked(null);
    setText('');
  };
  const doClearAll = () => {
    setCleared((c) => [...c, ...list.map((s) => s.pos)]);
    setList([]);
    setPicked(null);
    setText('');
  };
  // Word sets a typed position that was never Set when OK is pressed.
  const final = () => (text.trim() && typed() != null && !list.some((s) => same(s.pos, typed())) ? withTyped(list) : list);
  const validate = () => (final() ? null : TOO_MANY);
  const result = () => {
    const tabs = final();
    if (valued) return { tabs: valueTabs(value?.tabs, tabs, cleared, value?.inherited ?? null) };
    const set = tabs.filter((s) => !start.some((o) => same(o.pos, s.pos) && o.align === s.align && o.leader === s.leader));
    const clear = cleared.filter((p) => !tabs.some((s) => same(s.pos, p)));
    const now = ctxOf();
    if (now.engine) now.engine.exec('para.tabs', { set, clear, ...(def !== def0 && { default: def }) });
    else apply(now, { set, cleared: clear, def });
    return { tabs };
  };

  const canClear = picked != null && list.some((s) => s.pos === picked);
  return (
    <WordDialog title="Tabs" size="sm" onClose={onClose} validate={validate} result={result}>
      <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2" data-tabs-dialog="">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-pos`} {...accessProps('&Tab stop position:')}><AccessText label="&Tab stop position:" /></label>
          <ListPick id={`${id}-pos`} aria-label="Tab stop position" items={list.map((s) => [s.pos, formatLength(s.pos, unit)])} value={picked}
            onChange={pick} text={text} onText={(t) => { setText(t); setPicked(null); }} height="6.5rem" />
        </div>
        <div className="flex flex-col gap-2">
          {!valued && <Spin label="De&fault tab stops:" value={def} onChange={(v) => setDef(Math.max(0, v ?? def))} unit="len" min={0} max={LIMITS.tab[1]} width="6.5rem" />}
          <div className="text-xs">Tab stops to be cleared:</div>
          <div className="min-h-8 text-xs text-muted-foreground" data-cleared="">{cleared.map((p) => formatLength(p, unit)).join(', ')}</div>
        </div>
      </div>
      <Fieldset legend="Alignment"><Grid value={align} options={ALIGNS} onChange={setAlign} /></Fieldset>
      <Fieldset legend="Leader"><Grid value={leader} options={LEADERS} onChange={setLeader} /></Fieldset>
      <div className="flex gap-2">
        <Btn label="&Set" disabled={!text.trim()} onClick={doSet} />
        <Btn label="Cl&ear" disabled={!canClear} onClick={doClear} />
        <Btn label="Clear &All" onClick={doClearAll} />
      </div>
    </WordDialog>
  );
}

const PTAB_ALIGNS = [['left', '&Left'], ['center', '&Center'], ['right', '&Right']];

/** Header & Footer > Insert Alignment Tab: inserts a ptab {align, relativeTo, leader} at the selection on OK. → its attrs or null.
 * With `engine` (a canvas draft) it only returns them: the row inserts through the engine (text.alignmentTab). */
export function AlignmentTabDialog({ onClose, engine = false }) {
  const id = useId();
  const [v, setV] = useState({ align: 'left', relativeTo: 'margin', leader: 'none' });
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const result = () => {
    if (!engine) ctxOf().chain((c) => c.insertContent({ type: 'ptab', attrs: v }));
    return v;
  };
  return (
    <WordDialog title="Alignment Tab" size="sm" onClose={onClose} result={result}>
      <Fieldset legend="Alignment"><Grid value={v.align} options={PTAB_ALIGNS} onChange={set('align')} /></Fieldset>
      <Row label="Align relati&ve to:" htmlFor={`${id}-rel`}>
        <Pick id={`${id}-rel`} value={v.relativeTo} options={[['margin', 'Margin'], ['indent', 'Indent']]} onChange={set('relativeTo')} />
      </Row>
      <Fieldset legend="Leader"><Grid value={v.leader} options={LEADERS} onChange={set('leader')} /></Fieldset>
    </WordDialog>
  );
}
