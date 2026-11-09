// Word's Font dialog (docs/plans/word/plan.md §1.6; probe/dialogs/font.json wins for labels, items, defaults and access keys):
// the Font and Advanced tabs over the selection's merged runs (a blank box or a mixed check box where the runs differ). OK applies
// only what changed, on the whole word when the caret is inside one; in value mode ({mode: 'value', value}) it returns the run
// object instead and leaves the document alone (G10). {tab: 'font'|'advanced'} opens a tab, {focus: 'font'|'size'|'underline'} a box.
import { useEffect, useMemo, useState } from 'react';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Fieldset, ListPick, Pick, Preview, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { ctxOf, run } from '../../../tooling/registry.js';
import { openDialog } from '../../../app/actions.js';
import { fontStack } from '../../../office.mjs';
import { THEME } from '../../defaults.mjs';
import { fontLabel, fontsNow } from '../../fonts.js';
import { applyRun, selectionRuns } from './commands.js';
import { changesOf, hasRtl, LIGATURES, mergeRuns, parseSize, runOfEngine, setKey, SIZES, UNDERLINE_STYLES, valueResult } from './run.mjs';

const STYLES = [['regular', 'Regular'], ['italic', 'Italic'], ['bold', 'Bold'], ['boldItalic', 'Bold Italic']];
const SCALES = [200, 150, 100, 90, 80, 66, 50, 33].map((s) => [s, `${s}%`]);
const SPACINGS = [['normal', 'Normal'], ['expanded', 'Expanded'], ['condensed', 'Condensed']];
const POSITIONS = [['normal', 'Normal'], ['raised', 'Raised'], ['lowered', 'Lowered']];
const NUM_SPACING = [['default', 'Default'], ['proportional', 'Proportional'], ['tabular', 'Tabular']];
const NUM_FORMS = [['default', 'Default'], ['lining', 'Lining'], ['oldStyle', 'Old-style']];
const SETS = [['default', 'Default'], ...Array.from({ length: 20 }, (_, i) => [String(i + 1), String(i + 1)])];
const EMPHASIS = [['none', '(none)'], ['dot', '·']];
// The Font list's first item: Latin text takes the Asian text font. A theme Asian font maps to the same theme slot for Latin text,
// an approximation (Word keeps the East Asian theme font).
const USE_EA = '(asian)';
const latin = (o) => (o.font === USE_EA ? { ...o, font: o.fontEA ?? '+minor' } : o);

// What a run shows when nothing sets a property: the dialog's boxes in value mode for a style that leaves them out.
const DEFAULTS = { font: '+minor', fontEA: null, fontCS: null, size: 12, sizeCS: null, bold: false, italic: false, color: null, themeColor: null, underline: null,
  em: null, strike: false, dstrike: false, superscript: false, subscript: false, smallCaps: false, caps: false, vanish: false, scale: 100, spacing: 0,
  position: 0, kern: null, typography: {}, effects: null };
/** A run object from a caller (value mode: a style's run, v1 charSpacing read as spacing) with the defaults where it holds nothing. */
const filled = (v) => ({ ...DEFAULTS, ...(v.charSpacing != null && { spacing: v.charSpacing }), ...v });

/** The CSS the preview draws run `r` with (an approximation of the text's own drawing). */
function previewCss(r, theme) {
  const deco = [r.underline && 'underline', (r.strike || r.dstrike) && 'line-through'].filter(Boolean).join(' ');
  return {
    fontFamily: r.font ? fontStack(r.font, theme) : undefined, fontSize: r.size ? `${Math.min(r.size, 36)}pt` : undefined,
    fontWeight: r.bold ? 700 : undefined, fontStyle: r.italic ? 'italic' : undefined, color: r.color ?? undefined,
    textDecorationLine: deco || undefined, textDecorationStyle: r.dstrike ? 'double' : r.underline?.val === 'double' ? 'double' : undefined,
    textDecorationColor: r.underline?.color ?? undefined, textTransform: r.caps ? 'uppercase' : undefined,
    fontVariantCaps: r.smallCaps ? 'small-caps' : undefined, letterSpacing: r.spacing ? `${r.spacing}pt` : undefined,
    verticalAlign: r.superscript ? 'super' : r.subscript ? 'sub' : r.position ? `${r.position}pt` : undefined,
    display: 'inline-block', transform: r.scale && r.scale !== 100 ? `scaleX(${r.scale / 100})` : undefined,
    transformOrigin: 'left', opacity: r.vanish ? 0.5 : undefined,
  };
}

/** → in value mode the edited run object, else true after applying the changes (null on Cancel). */
export function FontDialog({ mode, value, tab: openTab, focus, onClose, engineRun }) {
  const ctx = ctxOf();
  const theme = ctx.state?.doc.attrs.theme ?? THEME;
  // On a canvas draft its row reads the engine's formatting first (engineRun, format.state's value).
  const initial = useMemo(() => (mode === 'value' ? filled(value ?? {}) : ctx.engine ? runOfEngine(engineRun)
    : mergeRuns(ctx.state ? selectionRuns(ctx.state) : [])), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [r, setR] = useState(initial);
  const [tab, setTab] = useState(openTab === 'advanced' ? 'advanced' : 'font');
  const [fontText, setFontText] = useState(null);
  const [sizeText, setSizeText] = useState(null);
  const [scaleText, setScaleText] = useState(null);
  const set = (key) => (v) => setR((o) => setKey(o, key, v));
  const fonts = useMemo(() => fontsNow().map((f) => [f, fontLabel(f)]), []);
  const fontList = useMemo(() => [[USE_EA, '(Use Asian text font)'], ['+minor', '+Body'], ['+major', '+Headings'], ...fonts], [fonts]);
  const rtl = hasRtl(ctx.settings?.word?.proofing?.languages);
  const sample = useMemo(() => {
    const s = ctx.state;
    const t = s && !s.selection.empty ? s.doc.textBetween(s.selection.from, s.selection.to, ' ', '').trim().slice(0, 60) : '';
    return t || null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!focus) return undefined;
    const id = setTimeout(() => {
      const el = document.querySelector(`[data-font-box="${focus}"]`);
      el?.focus();
      el?.select?.();
    }, 60);
    return () => clearTimeout(id);
  }, [focus]);

  // The edited run with what is typed in the Font and Size boxes (a name that is not installed is accepted, as in Word).
  const final = () => {
    let out = r;
    const label = fontList.find(([v]) => v === r.font)?.[1];
    if (fontText != null && fontText.trim() && fontText !== label) out = { ...out, font: fontList.find(([, l]) => l.toLowerCase() === fontText.trim().toLowerCase())?.[0] ?? fontText.trim() };
    if (sizeText != null && parseSize(sizeText) != null) out = { ...out, size: parseSize(sizeText) };
    return latin(out);
  };
  const badScale = () => scaleText != null && !(Number(scaleText.replace('%', '').trim()) >= 1 && Number(scaleText.replace('%', '').trim()) <= 600);
  const validate = () => (sizeText != null && sizeText.trim() && parseSize(sizeText) == null ? 'The size must be a number from 1 to 1638.'
    : badScale() ? 'The scale must be from 1% to 600%.' : null);
  const result = () => {
    const changes = changesOf(initial, final());
    if (mode === 'value') return valueResult(value ?? {}, changes);
    if (Object.keys(changes).length) applyRun(ctxOf(), changes);
    return true;
  };

  const style = r.bold == null || r.italic == null ? null : r.bold ? (r.italic ? 'boldItalic' : 'bold') : r.italic ? 'italic' : 'regular';
  const spacingKind = r.spacing == null ? null : r.spacing > 0 ? 'expanded' : r.spacing < 0 ? 'condensed' : 'normal';
  const positionKind = r.position == null ? null : r.position > 0 ? 'raised' : r.position < 0 ? 'lowered' : 'normal';
  const ty = r.typography ?? {};
  const setTy = (k) => (v) => setR((o) => ({ ...o, typography: { ...o.typography, [k]: v } }));
  const installed = (() => {
    const f = latin(r).font;
    const fam = f && !f.startsWith('+') ? f : null;
    try {
      return !fam || document.fonts.check(`12px "${fam}"`);
    } catch {
      return true;
    }
  })();
  const note = latin(r).font?.startsWith('+') ? 'This is a theme font: it follows the document\'s theme.'
    : !installed ? 'This font is not installed, so the sample uses a similar one.' : '';

  const preview = (
    <Fieldset legend="Preview">
      <Preview height="5rem"><span style={previewCss(latin(r), theme)}>{sample ?? (fontList.find(([v]) => v === r.font)?.[1] ?? r.font ?? '')}</span></Preview>
      <p className="text-xs text-muted-foreground">{note}</p>
    </Fieldset>
  );

  const fontTab = () => (
    <div data-font-dialog="font" className="flex flex-col gap-3">
      <Fieldset legend="Latin text">
      <div className="grid grid-cols-[1fr_9rem_5rem] gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <Row label="Asian &text font:" htmlFor="font-ea"><span /></Row>
            <Pick id="font-ea" value={r.fontEA ?? '+minor'} options={[['+minor', '+Body Asian'], ['+major', '+Headings Asian'], ...fonts]} onChange={set('fontEA')} width="100%" />
          </div>
          <div className="flex flex-col gap-1">
            <Row label="&Font:" htmlFor="font-font"><span /></Row>
            <ListPick id="font-font" data-font-box="font" items={fontList} value={r.font} text={fontText ?? undefined} onText={setFontText} height="5rem"
              onChange={(v) => { set('font')(v); setFontText(null); }} />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Row label="Font st&yle:" htmlFor="font-style"><span /></Row>
          <ListPick id="font-style" items={STYLES} value={style} height="8.4rem"
            onChange={(v) => setR((o) => ({ ...o, bold: v === 'bold' || v === 'boldItalic', italic: v === 'italic' || v === 'boldItalic' }))} />
        </div>
        <div className="flex flex-col gap-1">
          <Row label="&Size:" htmlFor="font-size"><span /></Row>
          <ListPick id="font-size" data-font-box="size" items={SIZES.map((s) => [s, String(s)])} value={r.size} height="8.4rem"
            text={sizeText ?? (r.size == null ? '' : String(r.size))} onText={(t) => { setSizeText(t); const n = parseSize(t); if (n != null) set('size')(n); }}
            onChange={(v) => { set('size')(v); setSizeText(null); }} />
        </div>
      </div>
      </Fieldset>
      {rtl && (
        <Fieldset legend="Complex scripts">
          <div className="flex gap-3">
            <Row label="F&ont:" htmlFor="font-cs"><Pick id="font-cs" value={r.fontCS ?? '+minor'} options={[['+minor', '+Body CS'], ['+major', '+Headings CS'], ...fonts]} onChange={set('fontCS')} width="12rem" /></Row>
            <Spin label="Si&ze:" value={r.sizeCS} onChange={set('sizeCS')} unit="pt" min={1} max={1638} step={0.5} width="5rem" />
          </div>
        </Fieldset>
      )}
      <Fieldset legend="All text">
        <div className="grid grid-cols-4 gap-3">
          <Row label="Font &color:" htmlFor="font-color"><span /></Row>
          <Row label="&Underline style:" htmlFor="font-uline"><span /></Row>
          <Row label="Underl&ine color:" htmlFor="font-ucolor"><span /></Row>
          <Row label="Emphasis mark&:" htmlFor="font-em"><span /></Row>
          <ColorPick id="font-color" value={r.color} themeColor={r.themeColor} onChange={(hex, link) => setR((o) => ({ ...o, color: hex, themeColor: link }))} />
          <Pick id="font-uline" value={r.underline?.val ?? 'none'} options={UNDERLINE_STYLES.map(([v, l]) => [v ?? 'none', l])} width="100%"
            onChange={(v) => setR((o) => ({ ...o, underline: v === 'none' ? null : { val: v, color: o.underline?.color ?? null } }))} />
          <div inert={!r.underline || undefined} aria-disabled={!r.underline || undefined} className={r.underline ? '' : 'opacity-50'}>
            <ColorPick id="font-ucolor" value={r.underline?.color ?? null} onChange={(hex) => setR((o) => ({ ...o, underline: o.underline && { ...o.underline, color: hex } }))} />
          </div>
          <Pick id="font-em" value={r.em ?? 'none'} options={EMPHASIS} onChange={(v) => set('em')(v === 'none' ? null : v)} width="100%" />
        </div>
      </Fieldset>
      <Fieldset legend="Effects">
        <div className="grid grid-cols-2 gap-1.5">
          <div className="flex flex-col gap-1.5">
            {/* Each effect's name is drawn with that effect. */}
            <Check label="Stri&kethrough" labelClass="line-through" checked={r.strike} onChange={set('strike')} />
            <Check label="Doub&le strikethrough" labelClass="line-through decoration-double" checked={r.dstrike} onChange={set('dstrike')} />
            {/* Raised and lowered text reads only beside full-size text: a sample, the name itself on the line */}
            <Check label="Su&perscript" sample={<>A<sup>BC</sup></>} checked={r.superscript} onChange={set('superscript')} />
            <Check label="Su&bscript" sample={<>A<sub>BC</sub></>} checked={r.subscript} onChange={set('subscript')} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Check label="S&mall caps" labelClass="[font-variant:small-caps]" checked={r.smallCaps} onChange={set('smallCaps')} />
            <Check label="&All caps" labelClass="uppercase" checked={r.caps} onChange={set('caps')} />
            <Check label="&Hidden" labelClass="underline decoration-dotted" checked={r.vanish} onChange={set('vanish')} />
          </div>
        </div>
      </Fieldset>
      {preview}
    </div>
  );

  const advancedTab = () => (
    <div data-font-dialog="advanced" className="flex flex-col gap-3">
      <Fieldset legend="Character Spacing">
        <Row label="S&cale:" htmlFor="font-scale">
          <ListPick id="font-scale" items={SCALES} value={r.scale} height="3.5rem" width="8rem"
            text={scaleText ?? (r.scale == null ? '' : `${r.scale}%`)}
            onText={(t) => { setScaleText(t); const n = Number(String(t).replace('%', '').trim()); if (n >= 1 && n <= 600) set('scale')(Math.round(n)); }}
            onChange={(v) => { set('scale')(v); setScaleText(null); }} />
        </Row>
        <div className="flex items-center gap-3">
          <Row label="&Spacing:" htmlFor="font-spacing">
            <Pick id="font-spacing" value={spacingKind} options={SPACINGS} width="8rem"
              onChange={(k) => setR((o) => ({ ...o, spacing: k === 'normal' ? 0 : (k === 'condensed' ? -1 : 1) * (Math.abs(o.spacing ?? 0) || 1) }))} />
          </Row>
          <Spin label="&By:" value={r.spacing == null ? null : Math.abs(r.spacing)} unit="pt" min={0} max={1584} step={0.1} width="5.5rem"
            onChange={(v) => setR((o) => ({ ...o, spacing: v == null ? o.spacing : (o.spacing < 0 ? -1 : 1) * v }))} />
        </div>
        <div className="flex items-center gap-3">
          <Row label="&Position:" htmlFor="font-position">
            <Pick id="font-position" value={positionKind} options={POSITIONS} width="8rem"
              onChange={(k) => setR((o) => ({ ...o, position: k === 'normal' ? 0 : (k === 'lowered' ? -1 : 1) * (Math.abs(o.position ?? 0) || 3) }))} />
          </Row>
          <Spin label="B&y:" value={r.position == null ? null : Math.abs(r.position)} unit="pt" min={0} max={1584} step={0.5} width="5.5rem"
            onChange={(v) => setR((o) => ({ ...o, position: v == null ? o.position : (o.position < 0 ? -1 : 1) * v }))} />
        </div>
        <div className="flex items-center gap-3">
          <Check label="&Kerning for fonts:" checked={r.kern != null} onChange={(on) => set('kern')(on ? r.size ?? 12 : null)} />
          <Spin label="P&oints and above" value={r.kern} unit="pt" min={1} max={1638} step={0.5} width="5.5rem" onChange={(v) => set('kern')(v)} />
        </div>
        {/* Kept checked and without effect: a Document has no document grid. */}
        <Check label="Snap to grid &when document grid is defined" checked onChange={() => {}} />
      </Fieldset>
      <Fieldset legend="OpenType Features">
        <Row label="&Ligatures:" htmlFor="font-lig"><Pick id="font-lig" value={ty.ligatures ?? 'none'} options={LIGATURES} onChange={setTy('ligatures')} width="13rem" /></Row>
        <Row label="Nu&mber spacing:" htmlFor="font-numsp">
          <Pick id="font-numsp" value={ty.numSpacing ?? 'default'} options={NUM_SPACING} onChange={(v) => setTy('numSpacing')(v === 'default' ? null : v)} width="13rem" />
        </Row>
        <Row label="Number &forms:" htmlFor="font-numform">
          <Pick id="font-numform" value={ty.numForm ?? 'default'} options={NUM_FORMS} onChange={(v) => setTy('numForm')(v === 'default' ? null : v)} width="13rem" />
        </Row>
        <Row label="S&tylistic sets:" htmlFor="font-sets">
          <Pick id="font-sets" value={ty.stylisticSet ? String(ty.stylisticSet) : 'default'} options={SETS} onChange={(v) => setTy('stylisticSet')(v === 'default' ? null : Number(v))} width="13rem" />
        </Row>
        <Check label="Use Contextual &Alternates" checked={ty.contextual ?? false} onChange={(v) => setTy('contextual')(v || null)} />
      </Fieldset>
      {preview}
    </div>
  );

  const textEffects = async () => {
    const effects = await openDialog('formatTextEffects', { mode: 'value', value: r.effects ?? {} });
    if (effects) setR((o) => ({ ...o, effects }));
  };
  const setDefault = () => {
    // styles owns where defaults go (font.setAsDefault); until it merges the registry toasts its reason.
    run('font.setAsDefault', valueResult({}, Object.fromEntries(Object.entries(final()).filter(([, v]) => v != null))));
  };

  return (
    <WordDialog title="Font" size="lg" tab={tab} onTab={setTab} onClose={onClose} validate={validate} result={result}
      left={[{ label: 'Set As &Default', onClick: setDefault }, { label: 'Text &Effects...', onClick: textEffects }]}
      tabs={[{ id: 'font', label: 'Fo&nt', render: fontTab }, { id: 'advanced', label: 'Ad&vanced', render: advancedTab }]} />
  );
}

