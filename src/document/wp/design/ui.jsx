// The Design tab's drawings and dialogs (docs/plans/word/plan.md §1.6, briefs/design.md): gallery tiles for themes, colour sets, font
// sets, effects and style sets, and the dialogs Create New Theme Colors and Create New Theme Fonts (probe/dialogs/
// create-new-theme-colors.json and create-new-theme-fonts.json), Save as a New Style Set and Templates and Add-ins.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { fontStack, FONTS, THEME_SLOTS } from '../../../office.mjs';
import { ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { Check, Fieldset, Pick, Preview, Row } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { THEME } from '../../defaults.mjs';
import { nextCustom } from './model.mjs';

const ACCENTS = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
const Swatches = ({ colors, slots = ['dk2', 'lt2', ...ACCENTS] }) => (
  <span className="flex">{slots.map((s) => <span key={s} className="size-3.5 ring-1 ring-black/10 ring-inset" style={{ background: colors[s] }} />)}</span>
);

/** A theme tile: "Aa" in its fonts over its accent colours. */
export const ThemeTile = ({ theme }) => (
  <span className="flex w-full items-center gap-2">
    <span className="grid h-10 w-14 shrink-0 place-items-center border bg-white text-black" style={{ borderBottom: `4px solid ${theme.colors.accent1}` }}>
      <span style={{ fontFamily: fontStack(theme.fonts.major), fontSize: 16 }}>A<span style={{ fontFamily: fontStack(theme.fonts.minor) }}>a</span></span>
    </span>
    <span className="flex min-w-0 flex-col gap-1">
      <span className="truncate">{theme.name}</span>
      <Swatches colors={theme.colors} slots={ACCENTS} />
    </span>
  </span>
);

/** A colour set row: its eight colours and its name. */
export const ColorsRow = ({ set }) => (
  <span className="flex w-full items-center gap-2"><Swatches colors={set.colors} /><span className="truncate">{set.name}</span></span>
);

/** A font set row: "Aa", the name, and the heading and body fonts each in its face. */
export const FontsRow = ({ set }) => (
  <span className="flex w-full items-center gap-2">
    <span className="w-8 shrink-0 text-lg" style={{ fontFamily: fontStack(set.major) }}>Aa</span>
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-xs text-muted-foreground">{set.name}</span>
      <span className="truncate" style={{ fontFamily: fontStack(set.major) }}>{set.major}</span>
      <span className="truncate text-xs" style={{ fontFamily: fontStack(set.minor) }}>{set.minor}</span>
    </span>
  </span>
);

/** A style set tile: a small page with a title, a heading and body lines drawn from the set's definitions in `theme`. */
export function StyleSetTile({ set, theme = THEME }) {
  const run = (id) => ({ ...set.defaults?.run, ...set.list?.Normal?.run, ...set.list?.[id]?.run });
  const css = (r) => ({
    fontFamily: fontStack(r.font ?? '+minor', theme), color: r.color ?? '#000', fontWeight: r.bold ? 700 : 400, fontStyle: r.italic ? 'italic' : undefined,
    textTransform: r.caps ? 'uppercase' : undefined, fontVariantCaps: r.smallCaps ? 'small-caps' : undefined,
  });
  const fill = (id) => set.list?.[id]?.para?.shading?.fill;
  const rule = (id) => set.list?.[id]?.para?.borders?.bottom?.color;
  return (
    <span className="flex h-[58px] w-[4.75rem] flex-col items-stretch gap-[2px] overflow-hidden border border-neutral-300 bg-white px-1 py-0.5 text-left leading-none">
      <span className="truncate text-[11px]" style={{ ...css(run('Title')), background: fill('Title'), borderBottom: rule('Title') && `1px solid ${rule('Title')}` }}>Title</span>
      <span className="truncate text-[8px]" style={{ ...css(run('Heading1')), background: fill('Heading1'), borderBottom: rule('Heading1') && `1px solid ${rule('Heading1')}` }}>Heading 1</span>
      {[100, 90, 100, 60].map((w, i) => <span key={i} className="h-[2px] shrink-0 rounded-full bg-neutral-300" style={{ width: `${w}%` }} />)}
    </span>
  );
}

/** A style set's gallery tile with its name under the page. */
export const StyleSetItem = ({ set, theme }) => (
  <span className="flex flex-col items-center gap-0.5"><StyleSetTile set={set} theme={theme} /><span className="max-w-[5rem] truncate text-[10px]">{set.name}</span></span>
);

// ---------- Create New Theme Colors ----------

// Word's labels and access keys (probe/dialogs/create-new-theme-colors.json), in theme slot order.
const COLOR_LABELS = {
  dk1: '&Text/Background - Dark 1', lt1: 'Text/&Background - Light 1', dk2: 'Text/Background - &Dark 2', lt2: 'Text/Background - &Light 2',
  accent1: 'Accent &1', accent2: 'Accent &2', accent3: 'Accent &3', accent4: 'Accent &4', accent5: 'Accent &5', accent6: 'Accent &6',
  hlink: '&Hyperlink', folHlink: '&Followed Hyperlink',
};

/** The sample Word draws: a dark and a light half, each with text, a heading, accent bars and the two link colours. */
function ColorsSample({ colors }) {
  const half = (bg, fg) => (
    <div className="flex flex-1 flex-col gap-1 p-2" style={{ background: bg, color: fg }}>
      <span className="text-sm">Text</span>
      <span className="flex h-10 items-end gap-0.5">{ACCENTS.map((a, i) => <span key={a} className="w-3" style={{ background: colors[a], height: `${40 + i * 10}%` }} />)}</span>
      <span className="text-xs underline" style={{ color: colors.hlink }}>Hyperlink</span>
      <span className="text-xs underline" style={{ color: colors.folHlink }}>Hyperlink</span>
    </div>
  );
  return <div className="flex h-40 border">{half(colors.dk2, colors.lt1)}{half(colors.lt2, colors.dk1)}</div>;
}

/** Create New Theme Colors: the 12 theme colours, a sample, Name ("Custom 1" first), Reset, Save and Cancel → {name, colors} | null.
 * `colors` is the Document's set it starts from; `names` the saved sets' names. */
export function CreateNewThemeColors({ colors = THEME.colors, names = [], onClose }) {
  const [c, setC] = useState(colors);
  const [name, setName] = useState(() => nextCustom(names));
  const changed = THEME_SLOTS.some((s) => c[s] !== colors[s]);
  return (
    <WordDialog title="Create New Theme Colors" size="lg" okText="Save" onClose={onClose} result={() => ({ name: name.trim(), colors: c })}
      validate={() => (name.trim() ? null : 'Type a name for the colour set.')} left={[{ label: '&Reset', disabled: !changed, onClick: () => setC(colors) }]}>
      <div data-design-dialog="createNewThemeColors" className="flex gap-4">
        <Fieldset legend="Theme colors">
          {THEME_SLOTS.map((s) => (
            <Row key={s} label={COLOR_LABELS[s]} htmlFor={`theme-color-${s}`}>
              <span className="flex-1" />
              <ColorPick id={`theme-color-${s}`} value={c[s]} automatic={null} onChange={(hex) => hex && setC((o) => ({ ...o, [s]: hex }))} />
            </Row>
          ))}
        </Fieldset>
        <div className="flex flex-1 flex-col gap-2"><span>Sample</span><ColorsSample colors={c} /></div>
      </div>
      <Row label="&Name:" htmlFor="theme-colors-name"><Input id="theme-colors-name" size="xs" value={name} onChange={(e) => setName(e.target.value)} /></Row>
    </WordDialog>
  );
}

// ---------- Create New Theme Fonts ----------

const fontOptions = (value) => [...new Set([...(value ? [value] : []), ...FONTS])].sort().map((f) => [f, f]);

function FontsSample({ major, minor }) {
  return (
    <Preview height="5.5rem">
      <div className="text-base" style={{ fontFamily: fontStack(major) }}>Heading</div>
      <div className="text-xs" style={{ fontFamily: fontStack(minor) }}>Body text body text body text. Body text body text.</div>
    </Preview>
  );
}

/** Create New Theme Fonts: the heading and body fonts (and the Asian pair while `asian`), a sample each, Name, Save and Cancel →
 * {name, major, minor, majorEA, minorEA} | null. `fonts` is the Document's theme fonts. */
export function CreateNewThemeFonts({ fonts = THEME.fonts, names = [], asian = false, onClose }) {
  const [f, setF] = useState({ major: fonts.major, minor: fonts.minor, majorEA: fonts.majorEA ?? '', minorEA: fonts.minorEA ?? '' });
  const [name, setName] = useState(() => nextCustom(names));
  const set = (k) => (v) => setF((o) => ({ ...o, [k]: v }));
  const pair = (legend, mk, nk, suffix) => (
    <Fieldset legend={legend}>
      <div className="flex gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor={`tf-${mk}`}>Heading font{suffix}:</label>
          <Pick id={`tf-${mk}`} aria-label={`Heading font${suffix}`} width="12rem" value={f[mk]} options={fontOptions(f[mk])} onChange={set(mk)} />
          <label htmlFor={`tf-${nk}`}>Body font{suffix}:</label>
          <Pick id={`tf-${nk}`} aria-label={`Body font${suffix}`} width="12rem" value={f[nk]} options={fontOptions(f[nk])} onChange={set(nk)} />
        </div>
        <div className="flex flex-1 flex-col gap-1"><span>Sample</span><FontsSample major={f[mk] || f.major} minor={f[nk] || f.minor} /></div>
      </div>
    </Fieldset>
  );
  const result = () => ({ name: name.trim(), major: f.major, minor: f.minor, ...(asian && { majorEA: f.majorEA || null, minorEA: f.minorEA || null }) });
  return (
    <WordDialog title="Create New Theme Fonts" size="lg" okText="Save" onClose={onClose} result={result}
      validate={() => (name.trim() ? null : 'Type a name for the font set.')}>
      <div data-design-dialog="createNewThemeFonts" className="flex flex-col gap-3">
        {pair('Latin text', 'major', 'minor', ' (Latin)')}
        {asian && pair('East Asian text', 'majorEA', 'minorEA', ' (Asian)')}
        <Row label="&Name:" htmlFor="theme-fonts-name"><Input id="theme-fonts-name" size="xs" value={name} onChange={(e) => setName(e.target.value)} /></Row>
      </div>
    </WordDialog>
  );
}

// ---------- Save as a New Style Set ----------

/** Save as a New Style Set: a name → the name | null. Word saves a .dotx file; EasyWriter keeps the set in the word store. */
export function SaveAsANewStyleSet({ names = [], onClose }) {
  const [name, setName] = useState('');
  return (
    <WordDialog title="Save as a New Style Set" size="sm" okText="Save" onClose={onClose} result={() => name.trim()}
      validate={() => (!name.trim() ? 'Type a name for the style set.' : names.includes(name.trim()) ? 'A style set with this name exists. Pick another name.' : null)}>
      <div data-design-dialog="saveAsANewStyleSet">
        <Row label="File &name:" htmlFor="style-set-name"><Input id="style-set-name" size="xs" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Row>
      </div>
    </WordDialog>
  );
}

// ---------- Templates and Add-ins ----------

/** Templates and Add-ins: the attached template (one of the user's Documents), Automatically update document styles, the global
 * templates and add-ins list (empty: add-ins are left out) and Organizer → {template, linkStyles} | null. `documents` is [{id, title}]. */
export function TemplatesAndAddIns({ template = null, linkStyles = false, documents = [], organizer, onClose }) {
  const [tpl, setTpl] = useState(template ?? '');
  const [link, setLink] = useState(!!linkStyles);
  const options = [['', 'Normal'], ...documents.map((d) => [d.id, d.title || 'Untitled'])];
  return (
    <WordDialog title="Templates and Add-ins" size="md" onClose={onClose} result={() => ({ template: tpl || null, linkStyles: link })}
      left={[{ label: '&Organizer...', disabled: !organizer, onClick: organizer }]}>
      <div data-design-dialog="templatesAndAddIns" className="flex flex-col gap-3">
        <Fieldset legend="Document &template">
          <Row label="Attach:" htmlFor="tpl-pick"><Pick id="tpl-pick" aria-label="Document template" width="18rem" value={tpl} options={options} onChange={setTpl} /></Row>
          <Check label="Automatically &update document styles" checked={link} onChange={setLink} />
        </Fieldset>
        <Fieldset legend="&Global templates and add-ins">
          <div role="listbox" aria-disabled="true" className="h-20 rounded-md border bg-muted/40 p-1 text-xs text-muted-foreground">Add-ins are not part of EasyWriter.</div>
        </Fieldset>
      </div>
    </WordDialog>
  );
}
