// Envelopes and Labels with Envelope Options, Label Options and Label Details (docs/plans/word/briefs/mailings.md; probe
// envelopes-and-labels.json, envelope-options.json, label-options.json). Label products carry generic names only, since vendor
// names are trademarks; New Label... keeps the user's own in settings.word.labels. Feed, printing and e-postage need printer and
// online features this build does not have, so those controls are drawn disabled.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { openDialog } from '../../../app/actions.js';
import { useStore } from '../../../app/store.js';
import { Check, Fieldset, ListPick, Pick, Radio, Row, Spin, TextArea, useUnit } from '../../../tooling/kit/controls.jsx';
import { formatLength } from '../../../tooling/kit/units.mjs';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { saveWord } from '../../word/settings.mjs';
import { PAPER_SIZES } from '../../../office.mjs';
import { DEFAULT_ENVELOPE, DEFAULT_LABEL, ENVELOPES, envelopeAttr, LABELS } from './merge.mjs';
import { Btn } from './Lists.jsx';

/** The labels Label Options lists: the built-in generic products, then the user's own. */
export function labelProducts(settings) {
  return [...LABELS, ...(settings?.word?.labels ?? []).map((l) => ({ ...l, custom: true }))];
}

/** A small envelope drawing: the return address top left, the delivery address near the middle. */
function EnvelopeSketch({ env, delivery, ret, omit }) {
  const w = 180;
  const h = Math.round((w * env.h) / env.w);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Preview" className="border bg-white">
      {!omit && String(ret).trim() && [0, 1, 2].map((i) => <rect key={i} x={6} y={6 + i * 5} width={40} height={2} fill="#999" />)}
      {[0, 1, 2].map((i) => <rect key={i} x={w * 0.42} y={h * 0.48 + i * 6} width={60} height={2.5} fill={String(delivery).trim() ? '#333' : '#ccc'} />)}
    </svg>
  );
}

/** Envelopes and Labels (tabs envelopes, labels). Props {tab, delivery, ret, envelope (merge.envelope shape), label}. Its buttons
 * resolve: Add to Document → {action: 'add', delivery, ret, envelope}; New Document → {action: 'newDocument', address, label, single,
 * row, col}. */
export function EnvelopesAndLabels({ tab = 'envelopes', delivery: d0 = '', ret: r0 = '', envelope: e0 = null, label: l0 = null, onClose }) {
  const [shown, setShown] = useState(tab);
  const [delivery, setDelivery] = useState(d0);
  const [ret, setRet] = useState(r0);
  const [omit, setOmit] = useState(!!e0?.ret?.omit);
  const [envelope, setEnvelope] = useState(() => e0 ?? envelopeAttr(DEFAULT_ENVELOPE));
  const [address, setAddress] = useState(d0);
  const [useReturn, setUseReturn] = useState(false);
  const [single, setSingle] = useState(false);
  const [row, setRow] = useState(1);
  const [col, setCol] = useState(1);
  const [label, setLabel] = useState(() => l0 ?? DEFAULT_LABEL);
  const envOptions = async () => {
    const e = await openDialog('envelopeOptions', { value: { ...envelope, ret: { ...envelope.ret, omit } } });
    if (e) setEnvelope(e);
  };
  const labelOptions = async () => {
    const l = await openDialog('labelOptions', { value: label });
    if (l) setLabel(l);
  };
  const envelopes = () => (
    <>
      <Row label="&Delivery address:" htmlFor="mm-env-delivery" />
      <TextArea id="mm-env-delivery" className="h-24" value={delivery} onChange={(e) => setDelivery(e.target.value)} />
      <Check label="Add ele&ctronic postage" checked={false} disabled onChange={() => {}} />
      <div className="flex gap-4">
        <div className="flex flex-1 flex-col gap-1">
          <div className="flex items-center justify-between">
            <Row label="&Return address:" htmlFor="mm-env-ret" />
            <Check label="O&mit" checked={omit} onChange={setOmit} />
          </div>
          <TextArea id="mm-env-ret" className="h-24" value={ret} disabled={omit} onChange={(e) => setRet(e.target.value)} />
        </div>
        <Fieldset legend="Preview">
          <EnvelopeSketch env={envelope} delivery={delivery} ret={ret} omit={omit} />
        </Fieldset>
        <Fieldset legend="Feed">
          <span className="w-24 text-xs text-muted-foreground">Needs printer driver features.</span>
        </Fieldset>
      </div>
      <p className="text-xs text-muted-foreground">{envelope.size}</p>
    </>
  );
  const labels = () => (
    <>
      <div className="flex items-center justify-between">
        <Row label="&Address:" htmlFor="mm-lbl-address" />
        <Check label="Use &return address" checked={useReturn} onChange={(on) => {
          setUseReturn(on);
          setAddress(on ? ret : d0);
        }} />
      </div>
      <TextArea id="mm-lbl-address" className="h-24" value={address} onChange={(e) => setAddress(e.target.value)} />
      <div className="flex gap-4">
        <Fieldset legend="Print">
          <Radio name="mm-lbl-print" value={single} onChange={setSingle} options={[[false, '&Full page of the same label'], [true, 'Si&ngle label']]} />
          <div className="flex gap-3 pl-5">
            <Spin label="Ro&w:" unit="int" value={row} min={1} max={label.down} onChange={setRow} width="4rem" />
            <Spin label="&Column:" unit="int" value={col} min={1} max={label.across} onChange={setCol} width="4rem" />
          </div>
        </Fieldset>
        <Fieldset legend="Label">
          <span className="text-xs" data-label-name="">{label.name}</span>
          <span className="text-xs text-muted-foreground">{label.type}</span>
        </Fieldset>
      </div>
    </>
  );
  const add = () => onClose({ action: 'add', delivery, ret, envelope: { ...envelope, ret: { ...envelope.ret, omit } } });
  const make = () => onClose({ action: 'newDocument', address, label, single, row, col });
  const left = shown === 'envelopes'
    ? [{ label: '&Print', disabled: true }, { label: '&Add to Document', onClick: add }, { label: '&Options...', onClick: envOptions }]
    : [{ label: '&Print', disabled: true }, { label: 'New &Document', onClick: make }, { label: '&Options...', onClick: labelOptions }];
  return (
    <WordDialog title="Envelopes and Labels" size="lg" okText="Close" result={() => null} onClose={onClose} tab={shown} onTab={setShown} left={left}
      tabs={[{ id: 'envelopes', label: '&Envelopes', render: envelopes }, { id: 'labels', label: '&Labels', render: labels }]} />
  );
}

/** The font dialog's value mode, when the font package registered it (WORD_DIALOGS.font). → the run value, or `value` when absent. */
async function pickFont(value) {
  const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js');
  if (!WORD_DIALOGS.font) return value;
  return (await openDialog('font', { mode: 'value', value: value ?? {} })) ?? value;
}

/** Envelope Options (tabs envelopeOptions, printingOptions). Props {value: merge.envelope shape}. → that shape or null. */
export function EnvelopeOptions({ value, onClose }) {
  const start = value ?? envelopeAttr(DEFAULT_ENVELOPE);
  const known = ENVELOPES.find((e) => e.id === start.size);
  const [size, setSize] = useState(known ? known.id : 'custom');
  const [w, setW] = useState(start.w);
  const [h, setH] = useState(start.h);
  const [delivery, setDelivery] = useState(start.delivery);
  const [ret, setRet] = useState(start.ret);
  const pick = (id) => {
    setSize(id);
    const e = ENVELOPES.find((x) => x.id === id);
    if (e) {
      setW(e.w);
      setH(e.h);
    }
  };
  const options = () => (
    <>
      <Row label="Envelope &size:" htmlFor="mm-env-size">
        <Pick id="mm-env-size" value={size} onChange={pick} options={[...ENVELOPES.map((e) => [e.id, e.label]), ['custom', 'Custom size...']]} />
      </Row>
      {size === 'custom' && (
        <div className="flex gap-3 pl-3">
          <Spin label="&Width:" unit="len" value={w} min={72} max={1584} onChange={setW} />
          <Spin label="&Height:" unit="len" value={h} min={72} max={1584} onChange={setH} />
        </div>
      )}
      <Fieldset legend="Delivery address">
        <div className="flex items-start gap-4">
          <Btn label="&Font..." onClick={async () => setDelivery({ ...delivery, font: await pickFont(delivery.font) })} />
          <div className="flex flex-col gap-1">
            <Spin label="From &left:" unit="len" value={delivery.left} auto="Auto" min={0} max={1584} onChange={(v) => setDelivery({ ...delivery, left: v })} />
            <Spin label="From &top:" unit="len" value={delivery.top} auto="Auto" min={0} max={1584} onChange={(v) => setDelivery({ ...delivery, top: v })} />
          </div>
        </div>
      </Fieldset>
      <Fieldset legend="Return address">
        <div className="flex items-start gap-4">
          <Btn label="F&ont..." onClick={async () => setRet({ ...ret, font: await pickFont(ret.font) })} />
          <div className="flex flex-col gap-1">
            <Spin label="Fro&m left:" unit="len" value={ret.left} auto="Auto" min={0} max={1584} onChange={(v) => setRet({ ...ret, left: v })} />
            <Spin label="F&rom top:" unit="len" value={ret.top} auto="Auto" min={0} max={1584} onChange={(v) => setRet({ ...ret, top: v })} />
          </div>
        </div>
      </Fieldset>
    </>
  );
  const printing = () => (
    <>
      <Fieldset legend="Feed method">
        <span className="text-xs text-muted-foreground">Needs printer driver features.</span>
        <Check label="&Clockwise rotation" checked={false} disabled onChange={() => {}} />
      </Fieldset>
    </>
  );
  return (
    <WordDialog title="Envelope Options" size="md" onClose={onClose}
      tabs={[{ id: 'envelopeOptions', label: '&Envelope Options', render: options }, { id: 'printingOptions', label: '&Printing Options', render: printing }]}
      result={() => ({ ...start, size: size === 'custom' ? 'Custom' : size, w: Math.max(w, h), h: Math.min(w, h), delivery, ret })} />
  );
}

const PAGES = [['letter', 'Letter'], ['a4', 'A4'], ['legal', 'Legal'], ['a5', 'A5']];
const pageId = (p) => PAGES.find(([id]) => Math.abs(PAPER_SIZES[id].w - p.w) < 1 && Math.abs(PAPER_SIZES[id].h - p.h) < 1)?.[0] ?? 'letter';

/** Label Options: page printers, the generic vendor and its products, the label's details. Props {value}. → the label or null. */
export function LabelOptions({ value, onClose }) {
  const settings = useStore((s) => s.settings);
  const unit = useUnit();
  const products = labelProducts(settings);
  const [id, setId] = useState(() => products.find((p) => p.name === value?.name)?.id ?? DEFAULT_LABEL.id);
  const [printer, setPrinter] = useState('page');
  const label = products.find((p) => p.id === id) ?? DEFAULT_LABEL;
  const len = (pt) => formatLength(pt, unit);
  const details = async (make) => {
    const l = await openDialog('labelDetails', { value: make ? { ...label, name: '', custom: true } : label, title: make ? 'Label Details' : `${label.name} Information` });
    if (!l) return;
    if (make || label.custom) {
      const own = settings?.word?.labels ?? [];
      const next = make ? [...own, { ...l, id: `custom-${Date.now()}` }] : own.map((x) => (x.id === label.id ? { ...l, id: label.id } : x));
      await saveWord({ labels: next });
      setId(make ? next.at(-1).id : label.id);
    }
  };
  const remove = async () => {
    await saveWord({ labels: (settings?.word?.labels ?? []).filter((x) => x.id !== label.id) });
    setId(DEFAULT_LABEL.id);
  };
  return (
    <WordDialog title="Label Options" size="lg" onClose={onClose} result={() => label}
      left={[{ label: '&Details...', onClick: () => details(false) }, { label: '&New Label...', onClick: () => details(true) },
        { label: 'D&elete', onClick: remove, disabled: !label.custom }]}>
      <Fieldset legend="Printer information">
        <Radio name="mm-lbl-printer" value={printer} onChange={setPrinter} options={[['continuous', '&Continuous-feed printers'], ['page', 'P&age printers']]} />
        <Row label="&Tray:" htmlFor="mm-lbl-tray"><Pick id="mm-lbl-tray" value="default" options={[['default', 'Default tray']]} onChange={() => {}} disabled /></Row>
      </Fieldset>
      <Fieldset legend="Label information">
        <Row label="Label &vendors:" htmlFor="mm-lbl-vendor"><Pick id="mm-lbl-vendor" value="generic" options={[['generic', 'Generic']]} onChange={() => {}} /></Row>
        <div className="flex gap-4">
          <div className="flex flex-col gap-1">
            <Row label="Prod&uct number:" htmlFor="mm-lbl-product" />
            <ListPick id="mm-lbl-product" aria-label="Product number" items={products.map((p) => [p.id, p.name])} value={id} onChange={setId} height="8rem" width="14rem" />
          </div>
          <div className="grid h-fit grid-cols-[6rem_1fr] gap-1 text-xs" data-label-info="">
            <span>Type:</span><span>{label.type}</span>
            <span>Height:</span><span>{len(label.h)}</span>
            <span>Width:</span><span>{len(label.w)}</span>
            <span>Page size:</span><span>{len(label.page.w)} × {len(label.page.h)}</span>
          </div>
        </div>
      </Fieldset>
    </WordDialog>
  );
}

/** Label Details: the name and measurements of a label (New Label... and Details...). Props {value, title}. → the label or null. */
export function LabelDetails({ value, title = 'Label Details', onClose }) {
  const [l, setL] = useState(() => ({ ...value }));
  const [page, setPage] = useState(() => pageId(value.page));
  const set = (k) => (v) => setL((o) => ({ ...o, [k]: v }));
  const fits = l.side + (l.across - 1) * l.hPitch + l.w <= l.page.w + 0.5 && l.top + (l.down - 1) * l.vPitch + l.h <= l.page.h + 0.5;
  return (
    <WordDialog title={title} size="md" onClose={onClose} result={() => ({ ...l, type: l.type || 'Custom' })}
      validate={() => (!String(l.name ?? '').trim() ? 'Type a label name.' : l.hPitch < l.w || l.vPitch < l.h ? 'The pitch must be at least the label size.'
        : !fits ? 'The labels do not fit on the page.' : null)}>
      <Row label="&Label name:" htmlFor="mm-lbl-name"><Input id="mm-lbl-name" size="xs" value={l.name ?? ''} onChange={(e) => set('name')(e.target.value)} disabled={!value.custom} /></Row>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <Spin label="&Top margin:" unit="len" value={l.top} min={0} max={1584} onChange={set('top')} />
        <Spin label="&Side margin:" unit="len" value={l.side} min={0} max={1584} onChange={set('side')} />
        <Spin label="&Vertical pitch:" unit="len" value={l.vPitch} min={1} max={1584} onChange={set('vPitch')} />
        <Spin label="&Horizontal pitch:" unit="len" value={l.hPitch} min={1} max={1584} onChange={set('hPitch')} />
        <Spin label="Label h&eight:" unit="len" value={l.h} min={1} max={1584} onChange={set('h')} />
        <Spin label="Label &width:" unit="len" value={l.w} min={1} max={1584} onChange={set('w')} />
        <Spin label="Number &across:" unit="int" value={l.across} min={1} max={30} onChange={set('across')} />
        <Spin label="Number &down:" unit="int" value={l.down} min={1} max={60} onChange={set('down')} />
      </div>
      <Row label="Page si&ze:" htmlFor="mm-lbl-page">
        <Pick id="mm-lbl-page" value={page} options={PAGES} onChange={(id) => {
          setPage(id);
          setL((o) => ({ ...o, page: { w: PAPER_SIZES[id].w, h: PAPER_SIZES[id].h } }));
        }} />
      </Row>
    </WordDialog>
  );
}
