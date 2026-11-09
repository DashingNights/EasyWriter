// The styles work package's dialogs (docs/plans/word/plan.md §1.6; probe/dialogs/create-new-style-from-formatting.json and
// -full.json): Create New Style from Formatting with its short and full forms, Modify Style (the same full form with the type
// fixed), the Format menu opening the property dialogs in value mode, the shortcut key dialog, the update prompt, Set As Default
// and Rename. Each writes on OK and resolves with what it wrote.
import { useState } from 'react';
import { Bold, Italic, Underline } from 'lucide-react';
import { cn } from 'cn';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { chordOf, normalize, windowsUse } from '../../../app/keys.mjs';
import { FONT_SIZES, fontStack } from '../../../office.mjs';
import { ctxOf } from '../../../tooling/registry.js';
import { REASONS } from '../../../tooling/reasons.mjs';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Fieldset, Pick, Preview, Radio, Row } from '../../../tooling/kit/controls.jsx';
import { AccessText, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { saveWord } from '../../word/settings.mjs';
import { fontLabel, fontsNow } from '../../fonts.js';
import { THEME } from '../../defaults.mjs';
import { styleIdOf } from '../../model/styles.mjs';
import { paraCss, resolved, runCss } from '../../stylesheet.js';
import { WORD_KEYS } from '../../word/keymap.mjs';
import { applyStyle, blocksOf, selectionFormatting, setStyles, stylesOf } from './apply.js';
import { defineOf, defineSteps } from './engine.mjs';
import {
  BUILTIN_NAMES, camelCss, CHAR_STYLES, charHalfDef, charHalfOf, describe, displayName, idFor, nameProblem, newDocumentPatch, nextStyleName,
  patchStyle, styleFromFormatting, v2, withStyle,
} from './model.mjs';

const TYPES = [['paragraph', 'Paragraph'], ['character', 'Character'], ['linked', 'Linked (paragraph and character)'], ['table', 'Table'], ['list', 'List']];
// Table and List styles are edited in their owners' dialogs (table-design, lists).
const OTHER = { table: 'modifyTableStyle', list: 'defineNewListStyle' };
const DRAFT = '\u0000draft'; // the id the draft resolves under, which no document style can hold

/** Opens dialog `id` with `props` when a package registered it, else shows the placeholder reason → its result or null. */
async function openRegistered(id, props) {
  const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js');
  const ctx = ctxOf();
  if (!WORD_DIALOGS[id]) {
    ctx.toast(REASONS.pending);
    return null;
  }
  return ctx.dialog(id, props);
}

// The Format menu (Word's labels): the dialog each item opens in value mode and the half of the style it edits.
const FORMAT = [
  ['&Font...', 'font', 'run'], ['&Paragraph...', 'paragraph', 'para'], ['&Tabs...', 'tabs', 'para'], ['&Border...', 'bordersAndShading', 'both'],
  ['&Language...', 'language', 'run'], ['Fra&me...', 'frame', 'para'], ['&Numbering...', 'defineNewNumberFormat', 'numbering'],
  ['Shortcut &key...', 'styleShortcutKey', 'shortcut'], ['Te&xt Effects...', 'formatTextEffects', 'run'],
];

/** The sample a style draws: its resolved run and paragraph CSS over the document defaults, with the theme's fonts. */
function Sample({ list, defaults, theme, draft }) {
  const r = resolved({ ...list, [DRAFT]: draft }, DRAFT);
  const vars = { '--doc-major': fontStack('+major', theme), '--doc-minor': fontStack('+minor', theme) };
  const block = camelCss({ ...paraCss(v2({ para: defaults.para }).para), ...paraCss(r.para), 'margin-top': '0', 'margin-bottom': '0' });
  const run = camelCss(runCss({ ...defaults.run, ...r.run }));
  return (
    <Preview height="7rem">
      <div style={{ ...vars, ...block }}><span style={run}>Sample Text Sample Text Sample Text Sample Text Sample Text</span></div>
    </Preview>
  );
}

const Toggle = ({ label, on, onClick, children }) => (
  <button type="button" aria-label={label} title={label} aria-pressed={!!on} onClick={onClick}
    className={cn('grid size-6 place-items-center rounded-sm border border-transparent text-xs hover:bg-accent', on && 'border-[var(--ui-accent)] bg-accent')}>{children}</button>
);

/** Create New Style from Formatting (`createNewStyleFromFormatting`, short form first; Modify... opens the full form) and Modify
 * Style (`modifyStyle`, {styleId}). OK writes the style, applies a new one, and resolves with its id. On a canvas draft the rows
 * pass the engine's styles, theme and selection formatting (engine.mjs engineStyleProps) and OK writes through styles.define. */
export function StyleDialog({ styleId = null, onClose, engineStyles = null, engineTheme = null, engineFmt = null }) {
  const [init] = useState(() => {
    const ctx = ctxOf();
    const styles = engineStyles ?? stylesOf(ctx.state);
    const list = styles.list ?? {};
    const theme = engineTheme ?? ctx.state?.doc.attrs.theme ?? THEME;
    // A quick character style the document does not hold yet is modified from Word's definition (the gallery shows it).
    const known = styleId && (list[styleId] ?? CHAR_STYLES[styleId]);
    if (known) {
      const s = v2(known);
      const type = s.type === 'paragraph' && charHalfOf(list, styleId) ? 'linked' : s.type;
      return { list, styles, theme, draft: { ...s, name: (BUILTIN_NAMES[styleId] ?? s.name ?? styleId), type, scope: 'doc' } };
    }
    const block = !engineFmt && ctx.state && blocksOf(ctx.state)[0]?.node;
    const fmt = engineFmt ?? (ctx.state ? selectionFormatting(ctx.state) : { run: {}, para: {} });
    const basedOn = engineFmt ? engineFmt.styleId ?? 'Normal' : block ? styleIdOf(block) : 'Normal';
    return { list, styles, theme, draft: { type: 'linked', name: nextStyleName(list), basedOn, next: null, qFormat: true, run: fmt.run, para: fmt.para, scope: 'doc' } };
  });
  const { list, theme } = init;
  const defaults = init.styles.defaults ?? {};
  const modify = !!(styleId && (list[styleId] ?? CHAR_STYLES[styleId]));
  const [full, setFull] = useState(modify);
  const [d, setD] = useState(init.draft);
  const [menu, setMenu] = useState(null); // {x, y} of the Format menu inside the dialog
  const set = (patch) => setD((o) => ({ ...o, ...patch }));
  const eff = resolved({ ...list, [DRAFT]: d }, DRAFT);
  const effRun = { ...defaults.run, ...eff.run };
  const effPara = eff.para ?? {};
  const setRun = (patch) => setD((o) => ({ ...o, run: patchStyle({ type: 'character', run: o.run }, { run: patch }).run }));
  const setPara = (patch) => setD((o) => ({ ...o, para: patchStyle({ type: 'paragraph', para: o.para }, { para: patch }).para }));
  const id = modify ? styleId : idFor(list, d.name);

  const others = Object.entries(list).filter(([sid, s]) => s.type === 'paragraph' && sid !== styleId).map(([sid]) => [sid, displayName(list, sid)]);
  const typeStyles = Object.entries(list).filter(([sid, s]) => s.type === (d.type === 'character' ? 'character' : 'paragraph') && sid !== styleId)
    .map(([sid]) => [sid, displayName(list, sid)]);

  const pickType = (type) => {
    if (OTHER[type]) {
      onClose(null);
      openRegistered(OTHER[type], {});
      return;
    }
    // A character style is based on a character style or none (Word's Default Paragraph Font), never the paragraph's style,
    // whose run it would otherwise draw over any paragraph.
    const fits = (sid) => list[sid]?.type === (type === 'character' ? 'character' : 'paragraph');
    set({ type, basedOn: fits(d.basedOn) ? d.basedOn : type === 'character' ? undefined : init.draft.basedOn });
  };

  const format = async ([, dialog, half]) => {
    setMenu(null);
    if (half === 'shortcut') {
      const r = await ctxOf().dialog('styleShortcutKey', { name: d.name, value: d.shortcut ?? null });
      if (r) set({ shortcut: r.shortcut ?? undefined });
      return;
    }
    const value = half === 'run' ? d.run ?? {} : half === 'para' ? d.para ?? {} : half === 'both' ? { para: d.para ?? {}, run: d.run ?? {} } : d.numLevel ?? null;
    const r = await openRegistered(dialog, { mode: 'value', value });
    if (!r) return;
    if (half === 'run') set({ run: r });
    else if (half === 'para') set({ para: r });
    else if (half === 'both') setD((o) => patchStyle(o, { run: r.run ?? {}, para: r.para ?? {} }));
    // ponytail: the style keeps the level as numLevel until lists draws a paragraph style's numbering from it.
    else set({ numLevel: r });
  };

  const validate = () => nameProblem(list, d.name, modify ? styleId : null);

  const result = () => {
    const ctx = ctxOf();
    const styles = engineStyles ?? stylesOf(ctx.state);
    const now = styles.list ?? {};
    const linked = d.type === 'linked';
    const type = linked ? 'paragraph' : d.type;
    const { scope, name, ...rest } = d;
    let style;
    if (modify) {
      const builtin = BUILTIN_NAMES[styleId];
      const naming = builtin ? (name !== builtin ? { aliases: name } : {}) : { name };
      style = { ...(now[styleId] ?? CHAR_STYLES[styleId]), ...rest, ...naming, type };
    } else {
      style = { ...styleFromFormatting(now, name, d.basedOn, { run: d.run, para: d.para }, id).style, ...rest, type };
      if (!style.next) style.next = id;
      if (type === 'character') delete style.para;
    }
    if (type === 'character') delete style.next;
    if (!linked) delete style.link;
    if (!style.basedOn) delete style.basedOn;
    for (const k of ['run', 'para']) if (style[k] && !Object.keys(style[k]).length) delete style[k];
    if (engineStyles && ctx.engine) {
      // The engine makes a linked style's character half itself, and para.style puts a character style on the runs. Modify sends
      // only what changed (defineSteps), so what the dialog does not show (a heading's list numbering, bidi) stays.
      const full = { ...style, ...(linked && { link: style.link ?? `${id}Char` }) };
      const steps = modify ? defineSteps(styles, { list: { [id]: full } })
        : [['styles.define', { ...defineOf(id, full, { create: true }), style: id, name: name || id }], ['para.style', { style: id }]];
      if (steps.length) Promise.resolve(ctx.engine.execMany(steps)).then((r) => r?.ok === false && ctx.toast(`Could not save the style: ${r.error ?? 'the engine refused it'}`));
      if (scope === 'new') saveWord({ newDocument: newDocumentPatch(ctx.settings?.word?.newDocument, { id, style }) });
      return id;
    }
    let next = { ...styles, list: { ...now, [id]: style } };
    if (linked) {
      const half = style.link ?? `${id}Char`;
      next = withStyle(next, id, { link: half });
      next = withStyle(next, half, next.list[half] ? { run: style.run } : charHalfDef(next.list, id));
    }
    setStyles(ctx, next);
    // setStyle takes paragraph styles only; applyStyle puts a character style on the selection's runs.
    if (!modify) {
      if (type === 'character') applyStyle(ctxOf(), id);
      else ctxOf().chain((c) => c.setStyle(id));
    }
    if (scope === 'new') saveWord({ newDocument: newDocumentPatch(ctx.settings?.word?.newDocument, { id, style: next.list[id] }) });
    return id;
  };

  const sample = <Sample list={list} defaults={defaults} theme={theme} draft={{ ...d, type: d.type === 'linked' ? 'paragraph' : d.type }} />;
  const short = (
    <div className="flex flex-col gap-2">
      <Row label="&Name:" htmlFor="style-name"><Input id="style-name" size="xs" autoFocus value={d.name} onChange={(e) => set({ name: e.target.value })} /></Row>
      <span>Paragraph style preview:</span>
      {sample}
    </div>
  );
  const fonts = [['+major', `${fontLabel(theme.fonts?.major ?? 'Aptos Display')} (Headings)`], ['+minor', `${fontLabel(theme.fonts?.minor ?? 'Aptos')} (Body)`],
    ...fontsNow().map((f) => [f, fontLabel(f)])];
  const align = effPara.textAlign ?? 'left';
  const line = effPara.spacing?.line?.rule === 'auto' ? effPara.spacing.line.value : null;
  const step = (k, by) => setPara({ spacing: { [k]: Math.max(0, (effPara.spacing?.[k] ?? 0) + by) } });
  const isChar = d.type === 'character';
  const long = (
    <div className="flex flex-col gap-3">
      <Fieldset legend="Properties">
        <Row label="&Name:" htmlFor="style-name"><Input id="style-name" size="xs" autoFocus value={d.name} onChange={(e) => set({ name: e.target.value })} /></Row>
        <Row label="S&tyle type:" htmlFor="style-type">
          <Pick id="style-type" value={d.type} options={TYPES} onChange={pickType} disabled={modify} width="16rem" />
        </Row>
        <Row label="Style &based on:" htmlFor="style-based">
          <Pick id="style-based" value={d.basedOn ?? ''} options={[['', '(no style)'], ...typeStyles]} onChange={(v) => set({ basedOn: v || undefined })} width="16rem" />
        </Row>
        <Row label="&Style for following paragraph:" htmlFor="style-next">
          <Pick id="style-next" value={d.next ?? (modify ? styleId : '')} disabled={isChar}
            options={[...(modify ? [] : [['', d.name || 'Style1']]), ...(modify ? [[styleId, displayName(list, styleId)]] : []), ...others]}
            onChange={(v) => set({ next: v || null })} width="16rem" />
        </Row>
      </Fieldset>
      <Fieldset legend="Formatting">
        <div className="flex flex-wrap items-center gap-1">
          <Pick aria-label="Font" value={effRun.font ?? '+minor'} options={fonts} onChange={(v) => setRun({ font: v })} width="11rem" />
          <Pick aria-label="Font Size" value={effRun.size ?? 12} options={FONT_SIZES.map((s) => [s, String(s)])} onChange={(v) => setRun({ size: v })} width="4rem" />
          <Toggle label="Bold" on={effRun.bold} onClick={() => setRun({ bold: !effRun.bold })}><Bold className="size-3.5" /></Toggle>
          <Toggle label="Italic" on={effRun.italic} onClick={() => setRun({ italic: !effRun.italic })}><Italic className="size-3.5" /></Toggle>
          <Toggle label="Underline" on={effRun.underline && (effRun.underline.val ?? effRun.underline) !== 'none'}
            onClick={() => setRun({ underline: effRun.underline && (effRun.underline.val ?? effRun.underline) !== 'none' ? { val: 'none' } : { val: 'single' } })}>
            <Underline className="size-3.5" />
          </Toggle>
          <ColorPick value={effRun.color ?? null} themeColor={effRun.themeColor ?? null} onChange={(color, themeColor) => setRun({ color, themeColor })} />
          {/* ponytail: the script choice only labels the boxes; Asian and complex script fonts are the Font dialog's (fontEA, fontCS). */}
          <Row label="&Formatting script:" htmlFor="style-script">
            <Pick id="style-script" value="latin" options={[['all', '(all scripts)'], ['latin', 'Latin'], ['asian', 'Asian']]} onChange={() => {}} width="7rem" />
          </Row>
        </div>
        {!isChar && (
          <div className="flex flex-wrap items-center gap-1">
            {[['left', 'Align Left', 'L'], ['center', 'Center', 'C'], ['right', 'Align Right', 'R'], ['justify', 'Justify', 'J']].map(([v, label, t]) => (
              <Toggle key={v} label={label} on={align === v} onClick={() => setPara({ textAlign: v })}>{t}</Toggle>
            ))}
            <span className="w-2" />
            {[[1, 'Single Spacing', '1'], [1.5, '1.5 Spacing', '1.5'], [2, 'Double Spacing', '2']].map(([v, label, t]) => (
              <Toggle key={v} label={label} on={line === v} onClick={() => setPara({ spacing: { line: { rule: 'auto', value: v } } })}>{t}</Toggle>
            ))}
            <span className="w-2" />
            <Toggle label="Increase Paragraph Spacing" onClick={() => { step('before', 6); step('after', 6); }}>+</Toggle>
            <Toggle label="Decrease Paragraph Spacing" onClick={() => { step('before', -6); step('after', -6); }}>-</Toggle>
            <Toggle label="Decrease Indent" onClick={() => setPara({ indent: { left: Math.max(0, (effPara.indent?.left ?? 0) - 36) } })}>&lt;</Toggle>
            <Toggle label="Increase Indent" onClick={() => setPara({ indent: { left: (effPara.indent?.left ?? 0) + 36 } })}>&gt;</Toggle>
          </div>
        )}
      </Fieldset>
      {sample}
      <p aria-label="Style properties" className="text-xs whitespace-pre-line text-muted-foreground">{describe(list, { ...d, type: isChar ? 'character' : 'paragraph' })}</p>
      <div className="flex flex-wrap items-center gap-4">
        <Check label="Add to the &Styles gallery" checked={d.qFormat !== false} onChange={(v) => set({ qFormat: v })} />
        <Check label="A&utomatically update" checked={!!d.autoRedefine} disabled={isChar} onChange={(v) => set({ autoRedefine: v || undefined })} />
      </div>
      <Radio value={d.scope} onChange={(v) => set({ scope: v })} options={[['doc', 'Only in this &document'], ['new', 'New documents based on this template']]} />
      {menu && (
        <div role="menu" className="absolute z-10 flex min-w-40 flex-col rounded-island border bg-island p-1 text-popover-foreground shadow-xl" style={{ left: menu.x, bottom: menu.y }}>
          {FORMAT.map((f) => (
            <button key={f[1]} type="button" role="menuitem" data-format={f[1]} onClick={() => format(f)}
              className="rounded-md px-2 py-1 text-left hover:bg-accent/60"><AccessText label={f[0]} /></button>
          ))}
        </div>
      )}
    </div>
  );
  const openMenu = (e) => {
    const root = e.currentTarget.closest('[data-word-dialog]').getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu((m) => (m ? null : { x: r.left - root.left, y: root.bottom - r.top }));
  };
  const title = modify ? 'Modify Style' : 'Create New Style from Formatting';
  return (
    <WordDialog title={title} size={full ? 'lg' : 'md'} onClose={onClose} validate={validate} result={result}
      left={full ? [{ label: 'F&ormat', onClick: openMenu }] : [{ label: '&Modify...', onClick: () => setFull(true) }]}>
      {full ? long : short}
    </WordDialog>
  );
}

/** The style shortcut key dialog (Word's Customize Keyboard for a style): records a chord, refuses one the system or typing
 * needs, and says which Word command holds it now. → {shortcut: chord | null}. */
export function ShortcutDialog({ name, value = null, onClose }) {
  const [chord, setChord] = useState(null);
  const [current, setCurrent] = useState(value);
  const holder = chord && WORD_KEYS.find((r) => r.kind !== 'off' && normalize(r.chord) === normalize(chord));
  const os = chord && windowsUse(chord);
  const record = (e) => {
    if (e.key === 'Tab' || e.key === 'Escape' || e.key === 'Enter') return;
    e.preventDefault();
    const c = chordOf(e.nativeEvent);
    if (c && /\+/.test(c) && !/^(Ctrl|Alt|Shift|Cmd|Fn)$/.test(c.split('+').at(-1))) setChord(c);
  };
  return (
    <WordDialog title="Customize Keyboard" size="sm" onClose={onClose} okText="Assign"
      validate={() => (chord && os ? `That key ${os.what}, so a style cannot take it.` : null)}
      result={() => ({ shortcut: chord ?? current })}>
      <Row label="Commands:"><span className="truncate">{name}</span></Row>
      <Row label="Current &keys:" htmlFor="style-keys">
        <span id="style-keys" className="min-w-0 flex-1 truncate rounded-md border px-2 py-0.5 text-xs">{current ?? ''}</span>
        <Button type="button" variant="outline" size="xs" disabled={!current} onClick={() => setCurrent(null)}>Remove</Button>
      </Row>
      <Row label="Press &new shortcut key:" htmlFor="style-chord">
        <Input id="style-chord" size="xs" readOnly autoFocus value={chord ?? ''} onKeyDown={record} />
      </Row>
      <p className="text-xs text-muted-foreground">
        {!chord ? 'Press the keys the style should take.' : os ? `That key ${os.what}.` : holder ? `Currently assigned to ${holder.label}. The style takes it in documents.` : 'Currently unassigned.'}
      </p>
    </WordDialog>
  );
}

/** The question when a style is reapplied over direct formatting (Options' Prompt to update style). → {choice, auto}. */
export function UpdatePromptDialog({ styleId, onClose }) {
  const [choice, setChoice] = useState('update');
  const [auto, setAuto] = useState(false);
  const name = displayName(stylesOf(ctxOf().state).list, styleId);
  return (
    <WordDialog title="Modify Style" size="sm" onClose={onClose} result={() => ({ choice, auto })}>
      <p>The text has formatting of its own on top of {name}.</p>
      <Radio value={choice} onChange={setChoice} options={[['update', `&Update ${name} to match the selection`], ['reapply', '&Reapply the style and drop the formatting']]} />
      <Check label="&Automatically update the style from now on" checked={auto} onChange={setAuto} />
    </WordDialog>
  );
}

/** Set As Default from the Font or Paragraph dialog: this document only, or every new document too. → 'doc' | 'all'. */
export function SetAsDefaultDialog({ what = 'font', onClose }) {
  const [v, setV] = useState('doc');
  return (
    <WordDialog title="Set As Default" size="sm" onClose={onClose} result={() => v}>
      <p>Use these {what === 'font' ? 'font' : 'paragraph'} settings as the default for</p>
      <Radio value={v} onChange={setV} options={[['doc', 'This &document only'], ['all', '&All new documents too']]} />
    </WordDialog>
  );
}

/** Rename Style: a built-in style keeps its name and takes the new one as an alias, as Word does. → the name. */
export function RenameDialog({ styleId, styleName, onClose, engineStyles = null }) {
  // A canvas draft has no DOM styles: the row passes the name the engine shows ('Heading 1,Chapter'), and the engine checks the
  // new one (styles.define refuses a taken name or alias). The DOM editor passes no styleName.
  const state = ctxOf().state;
  const list = engineStyles?.list ?? (state ? stylesOf(state).list ?? {} : {});
  const [name, setName] = useState(styleName ?? (BUILTIN_NAMES[styleId] ? list[styleId]?.aliases ?? BUILTIN_NAMES[styleId] : list[styleId]?.name ?? styleId));
  return (
    <WordDialog title="Rename Style" size="sm" onClose={onClose} result={() => name.trim()}
      validate={() => (BUILTIN_NAMES[styleId] && name.trim() === BUILTIN_NAMES[styleId] ? null : nameProblem(list, name, styleId))}>
      <Row label="&Name:" htmlFor="style-rename"><Input id="style-rename" size="xs" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Row>
    </WordDialog>
  );
}
