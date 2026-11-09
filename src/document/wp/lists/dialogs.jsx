// The list dialogs (docs/plans/word plan.md §1.6, probe/dialogs/*.json): Define New Bullet, Define New Number Format, Define New
// Multilevel List (with Set for All Levels), Define New List Style, Set Numbering Value and Adjust List Indents, and the gallery
// previews. Each dialog returns its value (a level, levels or the dialog's choices) and the command that opened it applies it, so
// value mode (Modify Style's Format > Numbering, G10) is the same dialog.
import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ctxOf } from '../../../tooling/registry.js';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { Check, Fieldset, Pick, Preview, Radio, Row, rowClass, Spin } from '../../../tooling/kit/controls.jsx';
import { BULLETS, formatNumber, labelText, NUMBER_STYLES, styleIdOfLevel, styleLevel } from '../../numbering.mjs';
import { PICTURE_ACCEPT } from '../../../tooling/metafile.mjs';
import { shownPicture } from '../picture-format/edit.js';

const JC = [['left', 'Left'], ['center', 'Centered'], ['right', 'Right']];
const SUFF = [['tab', 'Tab character'], ['space', 'Space'], ['nothing', 'Nothing']];
const LEVELS = Array.from({ length: 9 }, (_, i) => i);

/** Opens dialog `id` over this one when a package registered it → its result, or null at once when none did (the symbol and font
 * dialogs belong to other packages). */
async function sub(id, props) {
  const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js'); // at click time: a load-time import would be circular
  return WORD_DIALOGS[id] ? ctxOf().dialog(id, props) : null;
}
const hasDialog = (id) => import('../../../tooling/dialogs.js').then((m) => !!m.WORD_DIALOGS[id]);
function useHas(id) {
  const [has, setHas] = useState(false);
  useEffect(() => void hasDialog(id).then(setHas), [id]);
  return has;
}

/** A dialog button with Word's access key. */
const Btn = ({ label, onClick, disabled, title }) => (
  <Button type="button" variant="outline" size="sm" className="w-fit" disabled={disabled} title={title} onClick={onClick} {...accessProps(label)}>
    <AccessText label={label} />
  </Button>
);

/** A level label drawn as Word draws it in a preview: the label at its aligned-at position (a right-aligned one ending there,
 * never past the left edge), the text line at its indent, or after the label where the label is longer ("Article I."). */
function LabelLine({ lvl, label, scale = 0.5 }) {
  const at = Math.max(0, (lvl.left ?? 0) - (lvl.hanging ?? 0)) * scale;
  const text = Math.max(at, (lvl.left ?? 0) * scale);
  const font = lvl.run?.font && !String(lvl.run.font).startsWith('+') ? lvl.run.font : undefined;
  const right = lvl.jc === 'right';
  return (
    <div className="flex h-4 items-center text-[10px] leading-none" style={{ paddingLeft: right ? 0 : at }}>
      <span className="shrink-0 whitespace-pre" style={right ? { minWidth: at, textAlign: 'right', marginRight: text - at } : { minWidth: text - at }}>
        {lvl.pic ? <img src={lvl.pic} alt="" className="inline size-2.5" />
          : <span style={{ fontFamily: font, fontWeight: lvl.run?.bold ? 'bold' : undefined }}>{label}</span>}
      </span>
      <span className="ml-1 h-1 min-w-2 flex-1 rounded-full bg-neutral-300" />
    </div>
  );
}

/** The labels of the first `n` levels of `levels`, each counted once ('1', '1.1', '1.1.1'). */
const firstLabels = (levels, n = 3) => levels.slice(0, n).map((l, i) => labelText(l, levels, Array(i + 1).fill(1)));

/** A gallery preview of a multilevel list: its first three levels on a white tile. */
export function ListPreview({ levels, n = 3 }) {
  const labels = firstLabels(levels, n);
  return (
    <div className="flex h-16 w-28 flex-col justify-center gap-0.5 border border-neutral-300 bg-white px-1.5 py-1 text-black">
      {levels.slice(0, n).map((l, i) => <LabelLine key={i} lvl={l} label={labels[i]} scale={0.35} />)}
    </div>
  );
}

/** A gallery preview of a one-level pick (a bullet or a number format): three items. */
export function LevelPreview({ lvl }) {
  const levels = [lvl];
  return (
    <div className="flex h-16 w-20 flex-col justify-center gap-0.5 border border-neutral-300 bg-white px-1.5 py-1 text-black">
      {[1, 2, 3].map((n) => <LabelLine key={n} lvl={{ ...lvl, left: 18, hanging: 18 }} label={labelText(lvl, levels, [n])} scale={0.5} />)}
    </div>
  );
}

/** Word's number format box: text with each level number as a shaded token that typing goes around. `value` holds %1 to %9;
 * `sample(level)` gives a token's text. */
export function TokenEdit({ value, onChange, sample, label, id }) {
  const box = useRef(null);
  const own = useRef(null); // the value this box last sent, so typing does not redraw the box under the caret
  const draw = () => {
    const el = box.current;
    el.replaceChildren(...value.split(/(%[1-9])/).filter(Boolean).map((part) => {
      if (!/^%[1-9]$/.test(part)) return document.createTextNode(part);
      const t = document.createElement('span');
      t.contentEditable = 'false';
      t.dataset.token = part.slice(1);
      t.className = 'rounded-sm bg-neutral-300 px-0.5 text-black dark:bg-neutral-600 dark:text-white';
      t.textContent = sample(Number(part.slice(1)) - 1);
      return t;
    }));
  };
  useEffect(() => {
    if (value !== own.current) draw();
  });
  const read = () => {
    let s = '';
    for (const n of box.current.childNodes) s += n.dataset?.token ? `%${n.dataset.token}` : (n.textContent ?? '').replace(/%/g, '');
    own.current = s;
    onChange(s);
  };
  return (
    <div ref={box} id={id} role="textbox" aria-label={label} contentEditable suppressContentEditableWarning spellCheck={false} onInput={read}
      onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
      className="h-6 min-w-40 flex-1 overflow-hidden rounded-md border border-input bg-background px-1.5 text-xs leading-6 whitespace-pre outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
  );
}

/** Reads a picture file the user picks → {pic (a data URL), metafile?}, or null. */
// The picture is stored in doc.attrs.numbering, so it goes into every history step, the saved draft and a CSS variable on each
// list paragraph: it is drawn down to PIC_PX on its longer side first, as a bullet never shows larger. An EMF or WMF shows the
// metafile reader's drawing and keeps its original with that drawing, as an imported picture bullet does (export writes it back).
const PIC_PX = 64;
const pickPicture = () => new Promise((resolve) => {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: PICTURE_ACCEPT });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return resolve(null);
    const shown = await shownPicture(f, PIC_PX);
    if (shown?.metafile) return resolve({ pic: shown.src, metafile: { src: shown.metafile, pic: shown.src } });
    try {
      const bmp = await createImageBitmap(f);
      const s = Math.min(1, PIC_PX / Math.max(bmp.width, bmp.height));
      const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s)));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      const blob = await c.convertToBlob({ type: 'image/png' });
      const r = new FileReader();
      r.onload = () => resolve({ pic: String(r.result) });
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    } catch {
      resolve(null); // not a picture the browser can decode
    }
  });
  input.click();
});

// Glyphs offered when no Symbol dialog is registered yet (the symbols package owns it).
const GLYPHS = [...new Set([...BULLETS.map((b) => b.char), '◆', '◇', '■', '□', '○', '►', '→', '⇨', '★', '☆', '–', '✗', '✔', '♦', '♣', '♥', '♠'])];

/** Define New Bullet: Symbol..., Picture..., Font..., Alignment and Preview → the bullet level {fmt, text, glyph, pic, run, jc}. */
export function DefineNewBullet({ level, onClose }) {
  const [lvl, setLvl] = useState(() => ({ fmt: 'bullet', text: level?.fmt === 'bullet' ? level.text : '•', jc: level?.jc ?? 'left',
    ...(level?.pic && { pic: level.pic }), ...(level?.metafile && { metafile: level.metafile }), ...(level?.run && { run: level.run }) }));
  const [glyphs, setGlyphs] = useState(false);
  const symbol = useHas('symbol');
  const font = useHas('font');
  const set = (patch) => setLvl((o) => ({ ...o, ...patch }));
  const setChar = (char) => setLvl(({ pic, metafile, ...o }) => ({ ...o, text: char }));
  const onSymbol = async () => {
    if (!symbol) return setGlyphs((g) => !g);
    const r = await sub('symbol', { mode: 'value', value: { char: lvl.text } });
    if (r?.char) setChar(r.char);
  };
  const onPicture = async () => {
    const r = await pickPicture();
    if (r) setLvl(({ metafile, ...o }) => ({ ...o, ...r, text: '•' }));
  };
  const onFont = async () => {
    const r = await sub('font', { mode: 'value', value: lvl.run ?? {} });
    if (r) set({ run: { ...lvl.run, ...r } });
  };
  return (
    <WordDialog title="Define New Bullet" size="sm" onClose={onClose} result={() => ({ ...lvl, glyph: lvl.text })}>
      <Fieldset legend="Bullet character">
        <div className="flex gap-2">
          <Btn label="&Symbol..." onClick={onSymbol} />
          <Btn label="&Picture..." onClick={onPicture} />
          <Btn label="&Font..." onClick={onFont} disabled={!font} title={font ? undefined : 'The Font dialog is not available yet'} />
        </div>
        {glyphs && (
          <div role="listbox" aria-label="Symbols" className="grid grid-cols-10 gap-0.5">
            {GLYPHS.map((g) => (
              <button key={g} type="button" role="option" aria-selected={g === lvl.text && !lvl.pic} onClick={() => setChar(g)}
                className="h-6 rounded-sm border text-sm aria-selected:bg-accent aria-selected:text-accent-foreground">{g}</button>
            ))}
          </div>
        )}
        <Row label="Align&ment:" htmlFor="dnb-jc"><Pick id="dnb-jc" value={lvl.jc} options={JC} onChange={(jc) => set({ jc })} width="8rem" /></Row>
      </Fieldset>
      <Fieldset legend="Preview">
        <Preview height="7rem">{[1, 2, 3].map((n) => <LabelLine key={n} lvl={{ ...lvl, left: 36, hanging: 18 }} label={lvl.text} scale={1} />)}</Preview>
      </Fieldset>
    </WordDialog>
  );
}

/** Define New Number Format: Number style, Font..., Number format (the number a shaded token), Alignment and Preview → the level. */
export function DefineNewNumberFormat({ level, onClose }) {
  const [lvl, setLvl] = useState(() => {
    const l = level && level.fmt !== 'bullet' ? level : { fmt: 'decimal', text: '%1.', jc: 'left' };
    return { fmt: l.fmt, text: (l.text ?? '%1.').replace(/%[1-9]/g, (m) => (m === '%1' ? m : '')), jc: l.jc ?? 'left',
      ...(l.format && { format: l.format }), ...(l.run && { run: l.run }) };
  });
  const font = useHas('font');
  const set = (patch) => setLvl((o) => ({ ...o, ...patch }));
  const onFont = async () => {
    const r = await sub('font', { mode: 'value', value: lvl.run ?? {} });
    if (r) set({ run: { ...lvl.run, ...r } });
  };
  const sample = () => formatNumber(1, lvl.fmt, lvl.format) || ' ';
  return (
    <WordDialog title="Define New Number Format" size="sm" onClose={onClose} result={() => lvl}
      validate={() => (lvl.fmt !== 'none' && !lvl.text.includes('%1') ? 'The number format needs the number.' : null)}>
      <Fieldset legend="Number format">
        <div className="flex items-end gap-2">
          <Row label="&Number style:" htmlFor="dnf-style">
            <Pick id="dnf-style" value={styleIdOfLevel(lvl)} width="12rem" options={NUMBER_STYLES.map(([id, label]) => [id, label])}
              onChange={(id) => setLvl(({ format, ...o }) => ({ ...o, ...styleLevel(id), text: o.text.includes('%1') || id === 'none' ? o.text : `%1${o.text}` }))} />
          </Row>
          <Btn label="&Font..." onClick={onFont} disabled={!font} title={font ? undefined : 'The Font dialog is not available yet'} />
        </div>
        <Row label="Number f&ormat:" htmlFor="dnf-text"><TokenEdit id="dnf-text" label="Number format" value={lvl.text} sample={sample} onChange={(text) => set({ text })} /></Row>
        <Row label="Align&ment:" htmlFor="dnf-jc"><Pick id="dnf-jc" value={lvl.jc} options={JC} onChange={(jc) => set({ jc })} width="8rem" /></Row>
      </Fieldset>
      <Fieldset legend="Preview">
        <Preview height="7rem">{[1, 2, 3].map((n) => <LabelLine key={n} lvl={{ ...lvl, left: 36, hanging: 18 }} label={labelText(lvl, [lvl], [n])} scale={1} />)}</Preview>
      </Fieldset>
    </WordDialog>
  );
}

/** Set Numbering Value: Start new list or Continue from previous list, Advance value, Set value to, Preview → {mode, advance, value}.
 * `label(value, mode, advance)` draws the preview. */
export function SetNumberingValue({ value = 1, canContinue = true, label, onClose }) {
  const [mode, setMode] = useState('start');
  const [advance, setAdvance] = useState(false);
  const [v, setV] = useState(value);
  const live = mode === 'start' || advance;
  return (
    <WordDialog title="Set Numbering Value" size="sm" onClose={onClose} result={() => ({ mode, advance, value: v })}>
      <Radio value={mode} onChange={setMode} options={[['start', '&Start new list'], ...(canContinue ? [['continue', '&Continue from previous list']] : [])]} />
      <div className="pl-5"><Check label="&Advance value (skip numbers)" checked={advance} disabled={mode !== 'continue'} onChange={setAdvance} /></div>
      <fieldset disabled={!live} className={live ? undefined : 'opacity-50'}>
        <Spin label="Set &value to:" value={v} onChange={(n) => setV(Math.max(0, Math.round(n ?? 0)))} unit="int" min={0} max={32767} />
      </fieldset>
      <p className="text-xs text-muted-foreground">Preview: {label?.(v, mode, advance) ?? v}</p>
    </WordDialog>
  );
}

/** Adjust List Indents: Number position, Text indent, Follow number with, Add tab stop at → {pos, text, suff, tab}. */
export function AdjustListIndents({ pos = 18, text = 36, suff = 'tab', tab = null, onClose }) {
  const [v, setV] = useState({ pos, text, suff, tab: tab ?? text, withTab: tab != null });
  const set = (key) => (x) => setV((o) => ({ ...o, [key]: x }));
  return (
    <WordDialog title="Adjust List Indents" size="sm" onClose={onClose}
      result={() => ({ pos: v.pos, text: v.text, suff: v.suff, tab: v.withTab && v.suff === 'tab' ? v.tab : null })}>
      <Spin label="Number &position:" value={v.pos} onChange={set('pos')} unit="len" min={-1584} max={1584} />
      <Spin label="&Text indent:" value={v.text} onChange={set('text')} unit="len" min={-1584} max={1584} />
      <Row label="Follo&w number with:" htmlFor="ali-suff"><Pick id="ali-suff" value={v.suff} options={SUFF} onChange={set('suff')} width="9rem" /></Row>
      <div className="flex items-center gap-2">
        <Check label="Add ta&b stop at:" checked={v.withTab} disabled={v.suff !== 'tab'} onChange={set('withTab')} />
        <fieldset disabled={!v.withTab || v.suff !== 'tab'} className={v.withTab && v.suff === 'tab' ? undefined : 'opacity-50'}>
          <Spin value={v.tab} onChange={set('tab')} unit="len" min={0} max={1584} />
        </fieldset>
      </div>
    </WordDialog>
  );
}

/** Set for All Levels (Define New Multilevel List): the first level's number and text positions and the indent added per level →
 * {pos, text, step}. */
export function SetForAllLevels({ pos = 0, text = 18, step = 18, onClose }) {
  const [v, setV] = useState({ pos, text, step });
  const set = (key) => (x) => setV((o) => ({ ...o, [key]: x }));
  return (
    <WordDialog title="Set for All Levels" size="sm" onClose={onClose} result={() => v}>
      <Spin label="&Bullet/Number position for first level:" value={v.pos} onChange={set('pos')} unit="len" min={-1584} max={1584} />
      <Spin label="&Text position for first level:" value={v.text} onChange={set('text')} unit="len" min={-1584} max={1584} />
      <Spin label="&Additional indent for each level:" value={v.step} onChange={set('step')} unit="len" min={0} max={1584} />
    </WordDialog>
  );
}

// The Number style list of a multilevel level: Word's 20 number styles, its bullets and New Bullet...
const STYLE_OPTIONS = [...NUMBER_STYLES.map(([id, label]) => [id, label]), ...BULLETS.map((b) => [`bullet:${b.char}`, `Bullet, ${b.label}: ${b.char}`]),
  ['newBullet', 'New Bullet…']];
const levelStyleId = (l) => (l.fmt === 'bullet' ? `bullet:${l.text}` : styleIdOfLevel(l));
const LINKS = [['', '(no style)'], ...['Normal', 'NoSpacing', ...LEVELS.map((i) => `Heading${i + 1}`), 'Title', 'Subtitle', 'Quote', 'IntenseQuote',
  'ListParagraph'].map((id) => [id, id.replace(/([a-z])([A-Z\d])/g, '$1 $2')])];

/** Define New Multilevel List with its More state → {levels, name, applyTo}. `levels` starts the dialog (the caret's list, else Word's
 * 1) a) i)). */
export function DefineNewMultilevelList({ levels: start, inList = false, onClose }) {
  const [levels, setLevels] = useState(() => structuredClone(start));
  const [k, setK] = useState(0);
  const [more, setMore] = useState(false);
  const [name, setName] = useState('');
  const [applyTo, setApplyTo] = useState(inList ? 'whole' : 'selected');
  const [show, setShow] = useState(0);
  const lvl = levels[k];
  const patch = (p) => setLevels((ls) => ls.map((l, i) => (i === k ? { ...l, ...p } : l)));
  const font = useHas('font');
  const onStyle = async (id) => {
    if (id === 'newBullet') {
      const r = await sub('defineNewBullet', { level: lvl });
      if (r) patch({ ...r, text: r.text });
      return;
    }
    if (id.startsWith('bullet:')) return patch({ fmt: 'bullet', text: id.slice(7), glyph: id.slice(7), format: undefined });
    const s = styleLevel(id);
    setLevels((ls) => ls.map((l, i) => {
      if (i !== k) return l;
      const { glyph, pic, format, ...o } = l;
      return { ...o, ...s, ...(s.format && { format: s.format }), text: l.fmt === 'bullet' ? `%${k + 1}.` : l.text };
    }));
  };
  const onFont = async () => {
    const r = await sub('font', { mode: 'value', value: lvl.run ?? {} });
    if (r) patch({ run: { ...lvl.run, ...r } });
  };
  const onAll = async () => {
    const first = levels[0];
    const r = await ctxOf().dialog('setForAllLevels', { pos: first.left - first.hanging, text: first.left, step: (levels[1]?.left ?? 36) - first.left });
    if (r) setLevels((ls) => ls.map((l, i) => ({ ...l, left: r.text + i * r.step, hanging: r.text - r.pos })));
  };
  const sample = (i) => formatNumber(1, levels[i]?.fmt ?? 'decimal', levels[i]?.format) || ' ';
  const labels = levels.map((l, i) => labelText(l, levels, Array(i + 1).fill(1)));
  const aligned = lvl.left - lvl.hanging;
  return (
    <WordDialog title="Define new Multilevel list" size="lg" onClose={onClose} result={() => ({ levels, name: name.trim() || null, applyTo, show })}
      validate={() => (levels.some((l, i) => l.fmt !== 'bullet' && l.fmt !== 'none' && !l.text.includes(`%${i + 1}`)) ? 'Each numbered level needs its own number.' : null)}
      left={[{ label: more ? '<< &Less' : '&More >>', onClick: () => setMore((m) => !m) }]}>
      <div className="flex gap-3">
        <div className="flex flex-col gap-1">
          <span {...accessProps('Click le&vel to modify:')}><AccessText label="Click le&vel to modify:" /></span>
          <div role="listbox" aria-label="Click level to modify" tabIndex={0} className="flex w-10 flex-col rounded-md border text-xs"
            onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setK((x) => Math.min(8, Math.max(0, x + (e.key === 'ArrowDown' ? 1 : -1)))); } }}>
            {LEVELS.map((i) => (
              <div key={i} role="option" aria-selected={i === k} onClick={() => setK(i)}
                className={cn('px-2', rowClass(i === k))}>{i + 1}</div>
            ))}
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-0.5 border border-neutral-300 bg-white p-2 text-black" aria-label="Preview">
          {levels.map((l, i) => <LabelLine key={i} lvl={l} label={labels[i]} scale={0.6} />)}
        </div>
      </div>
      <Fieldset legend="Number format">
        <div className="flex items-center gap-2">
          <Row label="Enter f&ormatting for number:" htmlFor="ml-text">
            <TokenEdit id="ml-text" label="Enter formatting for number" value={lvl.fmt === 'bullet' ? lvl.text : lvl.text} sample={sample} onChange={(text) => patch({ text })} />
          </Row>
          <Btn label="&Font..." onClick={onFont} disabled={!font} title={font ? undefined : 'The Font dialog is not available yet'} />
        </div>
        <div className="flex flex-wrap gap-3">
          <Row label="&Number style for this level:" htmlFor="ml-style">
            <Pick id="ml-style" value={levelStyleId(lvl)} options={STYLE_OPTIONS} onChange={onStyle} width="12rem" />
          </Row>
          <Row label="Inclu&de level number from:" htmlFor="ml-from">
            <Pick id="ml-from" value="" disabled={k === 0} width="6rem" options={[['', ''], ...LEVELS.slice(0, k).map((i) => [String(i + 1), `Level ${i + 1}`])]}
              onChange={(j) => j && patch({ text: `%${j}${lvl.text}` })} />
          </Row>
        </div>
      </Fieldset>
      <Fieldset legend="Position">
        <div className="flex flex-wrap items-center gap-3">
          <Row label="N&umber alignment:" htmlFor="ml-jc"><Pick id="ml-jc" value={lvl.jc ?? 'left'} options={JC} onChange={(jc) => patch({ jc })} width="7rem" /></Row>
          <Spin label="&Aligned at:" value={aligned} onChange={(a) => patch({ hanging: lvl.left - a })} unit="len" min={-1584} max={1584} />
          <Spin label="Text &indent at:" value={lvl.left} onChange={(t) => patch({ left: t, hanging: t - aligned })} unit="len" min={-1584} max={1584} />
          <Btn label="S&et for All Levels..." onClick={onAll} />
        </div>
      </Fieldset>
      {more && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Row label="Apply &changes to:" htmlFor="ml-apply">
            <Pick id="ml-apply" value={applyTo} width="9rem" onChange={setApplyTo}
              options={inList ? [['whole', 'Whole list'], ['forward', 'This point forward'], ['selected', 'Selected text']] : [['selected', 'Selected text']]} />
          </Row>
          <Row label="Lin&k level to style:" htmlFor="ml-link">
            <Pick id="ml-link" value={lvl.pStyle ?? ''} options={LINKS} onChange={(s) => patch({ pStyle: s || undefined })} width="9rem" />
          </Row>
          <Row label="Level to s&how in gallery:" htmlFor="ml-show">
            <Pick id="ml-show" value={String(show)} options={LEVELS.map((i) => [String(i), `Level ${i + 1}`])} onChange={(s) => setShow(Number(s))} width="7rem" />
          </Row>
          <Row label="Lis&tNum field list name:" htmlFor="ml-name">
            <Input id="ml-name" value={name} onChange={(e) => setName(e.target.value)} size="xs" className="w-32" />
          </Row>
          <Spin label="&Start at:" value={lvl.start ?? 1} onChange={(s) => patch({ start: Math.max(0, Math.round(s ?? 1)) })} unit="int" min={0} max={32767} />
          <div className="flex items-center gap-2">
            <Check label="&Restart list after:" checked={k > 0 && lvl.restart !== 0} disabled={k === 0} onChange={(on) => patch({ restart: on ? k : 0 })} />
            <Pick aria-label="Restart after level" value={String(lvl.restart ?? k)} disabled={k === 0 || lvl.restart === 0} width="6rem"
              options={LEVELS.slice(0, Math.max(1, k)).map((i) => [String(i + 1), `Level ${i + 1}`])} onChange={(r) => patch({ restart: Number(r) })} />
          </div>
          <Check label="Le&gal style numbering" checked={!!lvl.isLgl} onChange={(on) => patch({ isLgl: on || undefined })} />
          <Row label="Follo&w number with:" htmlFor="ml-suff"><Pick id="ml-suff" value={lvl.suff ?? 'tab'} options={SUFF} onChange={(suff) => patch({ suff })} width="8rem" /></Row>
          <div className="flex items-center gap-2">
            <Check label="Add ta&b stop at:" checked={lvl.tab != null} onChange={(on) => patch({ tab: on ? lvl.left : undefined })} />
            <fieldset disabled={lvl.tab == null} className={lvl.tab == null ? 'opacity-50' : undefined}>
              <Spin value={lvl.tab ?? lvl.left} onChange={(t) => patch({ tab: t })} unit="len" min={0} max={1584} />
            </fieldset>
          </div>
        </div>
      )}
    </WordDialog>
  );
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

/** Define New List Style: Name, Style type, Start at, Apply formatting to, the level's font style and number style, indents, Preview
 * and where it is kept → {name, levels, newDocuments}. ponytail: the Format menu (Font, Numbering, Shortcut key) and the font name,
 * size and colour boxes are left out; Define New Multilevel List edits every level key. */
export function DefineNewListStyle({ levels: start, onClose }) {
  const [name, setName] = useState('Style1');
  const [levels, setLevels] = useState(() => structuredClone(start));
  const [k, setK] = useState(0);
  const [where, setWhere] = useState('doc');
  const lvl = levels[k];
  const patch = (p) => setLevels((ls) => ls.map((l, i) => (i === k ? { ...l, ...p } : l)));
  const run = (key) => (on) => patch({ run: { ...lvl.run, [key]: on ? (key === 'underline' ? { val: 'single' } : true) : null } });
  const onStyle = (id) => {
    if (id.startsWith('bullet:')) return patch({ fmt: 'bullet', text: id.slice(7), glyph: id.slice(7), format: undefined });
    const { glyph, pic, format, ...o } = lvl;
    setLevels((ls) => ls.map((l, i) => (i === k ? { ...o, ...styleLevel(id), text: lvl.fmt === 'bullet' ? `%${k + 1}.` : lvl.text } : l)));
  };
  const labels = levels.map((l, i) => labelText(l, levels, Array(i + 1).fill(1)));
  return (
    <WordDialog title="Define New List Style" size="lg" onClose={onClose} result={() => ({ name: name.trim(), levels, newDocuments: where === 'new' })}
      validate={() => (!name.trim() ? 'The style needs a name.' : null)}>
      <Fieldset legend="Properties">
        <Row label="&Name:" htmlFor="dls-name">
          <Input id="dls-name" value={name} onChange={(e) => setName(e.target.value)} size="xs" className="w-56" />
        </Row>
        <Row label="S&tyle type:" htmlFor="dls-type"><Pick id="dls-type" value="list" disabled options={[['list', 'List']]} onChange={() => {}} width="8rem" /></Row>
      </Fieldset>
      <Fieldset legend="Formatting">
        <div className="flex flex-wrap items-center gap-3">
          <Spin label="&Start at:" value={lvl.start ?? 1} onChange={(s) => patch({ start: Math.max(0, Math.round(s ?? 1)) })} unit="int" min={0} max={32767} />
          <Row label="A&pply formatting to:" htmlFor="dls-level">
            <Pick id="dls-level" value={String(k)} options={LEVELS.map((i) => [String(i), `${ORDINALS[i]} level`])} onChange={(s) => setK(Number(s))} width="7rem" />
          </Row>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Check label="Bold" checked={!!lvl.run?.bold} onChange={run('bold')} />
          <Check label="Italic" checked={!!lvl.run?.italic} onChange={run('italic')} />
          <Check label="Underline" checked={!!lvl.run?.underline} onChange={run('underline')} />
          <Pick aria-label="List style" value={levelStyleId(lvl)} options={STYLE_OPTIONS.filter(([id]) => id !== 'newBullet')} onChange={onStyle} width="12rem" />
          <Btn label="Decrease Indent" onClick={() => patch({ left: Math.max(lvl.hanging, lvl.left - 18) })} />
          <Btn label="Increase Indent" onClick={() => patch({ left: lvl.left + 18 })} />
        </div>
        <div className="flex flex-col gap-0.5 border border-neutral-300 bg-white p-2 text-black" aria-label="Preview">
          {levels.map((l, i) => <LabelLine key={i} lvl={l} label={labels[i]} scale={0.6} />)}
        </div>
      </Fieldset>
      <Radio value={where} onChange={setWhere} options={[['doc', 'Only in this &document'], ['new', 'New documents based on this template']]} />
    </WordDialog>
  );
}
