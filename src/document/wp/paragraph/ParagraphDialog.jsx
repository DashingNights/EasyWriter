// The Paragraph dialog (docs/plans/word/briefs/paragraph.md; probe/dialogs/paragraph.json): Indents and Spacing, Line and Page
// Breaks and Asian Typography over the selected paragraphs. A field the selected paragraphs disagree on starts blank and only the
// fields the user touches are written. With {mode: 'value', value} it edits a style's para object and returns it (plan.md §1.6).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { deepPatch } from '../../../office.mjs';
import { Check, Fieldset, Pick, Preview, Row, Spin, useUnit } from '../../../tooling/kit/controls.jsx';
import { LIMITS } from '../../../tooling/kit/units.mjs';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { ctxOf, run } from '../../../tooling/registry.js';
import { textblocks } from '../../lists.js';
import { styleIdOf } from '../../model/styles.mjs';
import {
  ALIAS, DEFAULT_AT, DEFAULT_BY, LINE_PT, effectivePara, firstLineOf, lineOf, lineRuleOf, paraOfEngine, paraPropsOf, rangeMessage, specialOf,
} from './rules.mjs';

const ALIGNS = [['left', 'Left'], ['center', 'Centered'], ['right', 'Right'], ['justify', 'Justified'], ['distribute', 'Distributed']];
const OUTLINES = [[9, 'Body Text'], ...Array.from({ length: 9 }, (_, i) => [i, `Level ${i + 1}`])];
const SPECIALS = [['none', '(none)'], ['firstLine', 'First line'], ['hanging', 'Hanging']];
const RULES = [['single', 'Single'], ['onePt5', '1.5 lines'], ['double', 'Double'], ['atLeast', 'At least'], ['exact', 'Exactly'], ['multiple', 'Multiple']];
const TIGHT = [['none', 'None'], ['all', 'All'], ['firstAndLastLine', 'First and Last Lines'], ['firstLineOnly', 'First Line Only'], ['lastLineOnly', 'Last Line Only']];
const TEXT_ALIGN = [['top', 'Top'], ['center', 'Center'], ['baseline', 'Baseline'], ['bottom', 'Bottom'], ['auto', 'Auto']];

/** The dialog's fields of one paragraph's effective properties `p` (v2 names). Auto spacing is null. */
function fieldsOf(p) {
  const sp = p.spacing ?? {};
  const i = p.indent ?? {};
  const a = p.asian ?? {};
  const { special, by } = specialOf(i.firstLine);
  const { rule, at } = lineRuleOf(sp.line);
  return {
    align: p.textAlign ?? 'left', outline: p.outline ?? 9, collapsed: !!p.collapsed,
    left: i.left ?? 0, right: i.right ?? 0, special, by, mirror: !!p.mirrorIndents, adjustRight: a.adjustRightInd ?? true,
    before: sp.beforeAuto ? null : sp.before ?? 0, after: sp.afterAuto ? null : sp.after ?? 0, rule, at,
    contextual: !!p.contextual, snapToGrid: p.snapToGrid ?? true,
    widow: p.widowControl ?? true, keepNext: !!p.keepNext, keepLines: !!p.keepLines, pageBreakBefore: !!p.pageBreakBefore,
    suppressLineNumbers: !!p.suppressLineNumbers, dontHyphenate: !!p.suppressAutoHyphens, tightWrap: p.tightWrap ?? 'none',
    kinsoku: a.kinsoku ?? true, latinWrap: a.wordWrap === false, overflowPunct: a.overflowPunct ?? true, topLinePunct: !!a.topLinePunct,
    autoSpaceDE: a.autoSpaceDE ?? true, autoSpaceDN: a.autoSpaceDN ?? true, textAlignment: a.textAlignment ?? 'auto',
  };
}

/** The fields of several paragraphs: where they disagree, undefined (drawn blank or mixed). */
function common(list) {
  const out = { ...list[0] };
  for (const f of list.slice(1)) for (const k of Object.keys(out)) if (JSON.stringify(out[k]) !== JSON.stringify(f[k])) out[k] = undefined;
  return out;
}

const space = (key, v) => (v === null ? { [`${key}Auto`]: true, [key]: null } : { [key]: v, [`${key}Auto`]: null });

/** The para patch (v2 names) of the fields in `touched`, read from `f`. */
export function patchOf(f, touched) {
  const p = {};
  const put = (path, v) => {
    const [a, b] = path.split('.');
    if (b) p[a] = { ...p[a], [b]: v };
    else p[a] = v;
  };
  const MAP = {
    align: () => put('textAlign', f.align), outline: () => put('outline', f.outline), collapsed: () => put('collapsed', f.collapsed),
    left: () => put('indent.left', f.left), right: () => put('indent.right', f.right),
    special: () => put('indent.firstLine', firstLineOf(f.special, f.by)),
    // With a mixed Special, By alone would clear every paragraph's first-line and hanging indent, so it writes nothing.
    by: () => f.special != null && put('indent.firstLine', firstLineOf(f.special, f.by)),
    mirror: () => put('mirrorIndents', f.mirror), adjustRight: () => put('asian.adjustRightInd', f.adjustRight),
    before: () => { p.spacing = { ...p.spacing, ...space('before', f.before) }; },
    after: () => { p.spacing = { ...p.spacing, ...space('after', f.after) }; },
    rule: () => put('spacing.line', lineOf(f.rule, f.at)), at: () => put('spacing.line', lineOf(f.rule, f.at)),
    contextual: () => put('contextual', f.contextual), snapToGrid: () => put('snapToGrid', f.snapToGrid),
    widow: () => put('widowControl', f.widow), keepNext: () => put('keepNext', f.keepNext), keepLines: () => put('keepLines', f.keepLines),
    pageBreakBefore: () => put('pageBreakBefore', f.pageBreakBefore), suppressLineNumbers: () => put('suppressLineNumbers', f.suppressLineNumbers),
    dontHyphenate: () => put('suppressAutoHyphens', f.dontHyphenate), tightWrap: () => put('tightWrap', f.tightWrap === 'none' ? null : f.tightWrap),
    kinsoku: () => put('asian.kinsoku', f.kinsoku), latinWrap: () => put('asian.wordWrap', !f.latinWrap), overflowPunct: () => put('asian.overflowPunct', f.overflowPunct),
    topLinePunct: () => put('asian.topLinePunct', f.topLinePunct), autoSpaceDE: () => put('asian.autoSpaceDE', f.autoSpaceDE),
    autoSpaceDN: () => put('asian.autoSpaceDN', f.autoSpaceDN), textAlignment: () => put('asian.textAlignment', f.textAlignment),
  };
  for (const k of touched) MAP[k]?.();
  return p;
}

/** The selection's paragraphs in the editor commands act on → [{para, heading}]. */
function selected(enginePara) {
  const { target, engine } = ctxOf();
  // A canvas draft: its row read the caret paragraph from the engine (para.state) before opening.
  if (engine) return enginePara ? [{ para: paraOfEngine(enginePara), heading: /^Heading\d$/.test(enginePara.style ?? '') }] : [];
  if (!target) return [];
  return textblocks(target.state).map(({ node }) => ({ para: effectivePara(target.state.doc, node), heading: /^Heading\d$/.test(styleIdOf(node)) }));
}

/** The Paragraph dialog. Props: tab ('indents' | 'breaks' | 'asian'), focus ('spacing'), mode 'value' with value (a para object).
 * Applies to the selected paragraphs on OK and resolves the patch it wrote; in value mode resolves the edited para object. */
export function ParagraphDialog({ tab: tab0 = 'indents', focus, mode, value, onClose, enginePara }) {
  const valueMode = mode === 'value';
  const [init] = useState(() => {
    if (valueMode) {
      const v = Object.fromEntries(Object.entries(value ?? {}).map(([k, x]) => [ALIAS[k] ?? k, x]));
      return { base: v, fields: fieldsOf(v), heading: false };
    }
    const paras = selected(enginePara);
    // first: Set As Default takes every value the dialog shows, read from the first paragraph as Word does.
    return { base: null, first: paras[0]?.para, fields: paras.length ? common(paras.map((x) => fieldsOf(x.para))) : fieldsOf({}),
      heading: paras.some((x) => x.heading) };
  });
  const [f, setF] = useState(init.fields);
  const [touched, setTouched] = useState(() => new Set());
  const [tab, setTab] = useState(tab0);
  const unit = useUnit();

  const set = (k, extra) => (v) => {
    setF((o) => ({ ...o, [k]: v, ...extra?.(v, o) }));
    setTouched((t) => new Set([...t, k, ...Object.keys(extra?.(v, f) ?? {})]));
  };
  // Spacing below 0 is Auto, as Word's arrows go from 0 pt to Auto. A length typed in lines ('1 li') is stored as 12 pt a line (v):
  // the schema has no beforeLines or afterLines.
  const setSpace = (k) => (v) => set(k)(v?.lines != null ? v.lines * LINE_PT : typeof v === 'number' && v < 0 ? null : v);
  const patch = () => patchOf(f, touched);
  const edited = () => deepPatch(init.base ?? init.first ?? {}, patch());

  const validate = () => {
    const [lo, hi] = LIMITS.lineMultiple;
    if (f.rule === 'multiple' && f.at != null && (f.at < lo || f.at > hi)) return `The value must be between ${lo} and ${hi}.`;
    const checks = [[f.left, LIMITS.indent, unit], [f.right, LIMITS.indent, unit], [f.by, [0, LIMITS.indent[1]], unit], [f.before, LIMITS.spacing, 'pt'],
      [f.after, LIMITS.spacing, 'pt'], [f.rule === 'exact' || f.rule === 'atLeast' ? f.at : null, LIMITS.lineExact, 'pt']];
    for (const [v, range, u] of checks) {
      const m = rangeMessage(v, range, u);
      if (m) return m;
    }
    return null;
  };
  const apply = () => {
    const p = patch();
    const ctx = ctxOf();
    if (Object.keys(p).length && ctx.engine) ctx.engine.exec('para.set', { props: paraPropsOf(p) });
    else if (Object.keys(p).length) ctx.chain((c) => c.setParaProps(p));
    return p;
  };
  const result = () => (valueMode ? edited() : apply());
  const tabs = () => {
    const message = validate();
    if (message) return;
    onClose(result());
    queueMicrotask(() => (ctxOf().engine ? ctxOf().run('tabs.dialog') : ctxOf().dialog('tabs')));
  };
  const setDefault = () => run('paragraph.setAsDefault', edited());

  const rule = f.rule;
  const atUnit = rule === 'multiple' ? 'int' : 'pt';
  const atOff = rule === 'single' || rule === 'onePt5' || rule === 'double' || rule == null;
  const mirror = f.mirror;
  const outlineOff = init.heading;

  const preview = () => (
    <Preview height="7rem">
      <div style={{ marginLeft: Math.max(-24, (f.left ?? 0) / 4), marginRight: Math.max(-24, (f.right ?? 0) / 4),
        textIndent: (firstLineOf(f.special, f.by) ?? 0) / 4, textAlign: f.align === 'distribute' ? 'justify' : f.align ?? 'left',
        textAlignLast: f.align === 'distribute' ? 'justify' : undefined, fontSize: 9, lineHeight: rule === 'double' ? 2 : rule === 'onePt5' ? 1.5 : 1.2 }}>
        Sample Text Sample Text Sample Text Sample Text Sample Text Sample Text Sample Text Sample Text Sample Text Sample Text
      </div>
    </Preview>
  );

  const indents = () => (
    <>
      <Fieldset legend="General">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Row label="Ali&gnment:" htmlFor="para-align">
            <Pick id="para-align" value={f.align} options={ALIGNS} onChange={set('align')} width="8rem" />
          </Row>
          <Row label="&Outline level:" htmlFor="para-outline">
            <Pick id="para-outline" value={f.outline} options={OUTLINES} onChange={set('outline')} width="8rem" disabled={outlineOff} />
          </Row>
          <Check label="Collaps&ed by default" checked={f.collapsed} disabled={!(f.outline < 9)} onChange={set('collapsed')} />
        </div>
      </Fieldset>
      <Fieldset legend="Indentation">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          <Spin label={mirror ? '&Inside:' : '&Left:'} value={f.left ?? null} onChange={set('left')} unit="len" />
          <Row label="&Special:" htmlFor="para-special">
            <Pick id="para-special" value={f.special ?? ''} options={SPECIALS} width="7rem"
              onChange={set('special', (v, o) => ({ by: v === 'none' ? null : o.by ?? DEFAULT_BY }))} />
          </Row>
          <Spin label={mirror ? 'O&utside:' : '&Right:'} value={f.right ?? null} onChange={set('right')} unit="len" />
          <fieldset disabled={f.special == null || f.special === 'none'} className="contents">
            <Spin label="B&y:" value={f.special == null || f.special === 'none' ? null : f.by ?? null} onChange={set('by')} unit="len" min={0} />
          </fieldset>
        </div>
        <Check label="&Mirror indents" checked={f.mirror} onChange={set('mirror')} />
        <Check label="Automatically a&djust right indent when document grid is defined" checked={f.adjustRight} onChange={set('adjustRight')} />
      </Fieldset>
      <Fieldset legend="Spacing">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          <Spin label="&Before:" value={f.before} auto={f.before === undefined ? undefined : 'Auto'} onChange={setSpace('before')} unit="lines" min={-6} max={1584} />
          <Row label="Li&ne spacing:" htmlFor="para-rule">
            <Pick id="para-rule" autoFocus={focus === 'spacing'} value={rule ?? ''} options={RULES} width="7rem"
              onChange={set('rule', (v) => ({ at: DEFAULT_AT[v] ?? null }))} />
          </Row>
          <Spin label="A&fter:" value={f.after} auto={f.after === undefined ? undefined : 'Auto'} onChange={setSpace('after')} unit="lines" min={-6} max={1584} />
          <fieldset disabled={atOff} className="contents">
            <Spin label="&At:" value={atOff ? null : f.at ?? null} onChange={set('at')} unit={atUnit} step={rule === 'multiple' ? 0.5 : 1} />
          </fieldset>
        </div>
        <Check label="Don't add spa&ce between paragraphs of the same style" checked={f.contextual} onChange={set('contextual')} />
        <Check label="Snap to grid &when document grid is defined" checked={f.snapToGrid} onChange={set('snapToGrid')} />
      </Fieldset>
      <Fieldset legend="Preview">{preview()}</Fieldset>
    </>
  );

  const breaks = () => (
    <>
      <Fieldset legend="Pagination">
        <Check label="&Widow/Orphan control" checked={f.widow} onChange={set('widow')} />
        <Check label="Keep with ne&xt" checked={f.keepNext} onChange={set('keepNext')} />
        <Check label="&Keep lines together" checked={f.keepLines} onChange={set('keepLines')} />
        <Check label="Page &break before" checked={f.pageBreakBefore} onChange={set('pageBreakBefore')} />
      </Fieldset>
      <Fieldset legend="Formatting exceptions">
        <Check label="&Suppress line numbers" checked={f.suppressLineNumbers} onChange={set('suppressLineNumbers')} />
        <Check label="&Don't hyphenate" checked={f.dontHyphenate} onChange={set('dontHyphenate')} />
      </Fieldset>
      <Fieldset legend="Textbox options">
        <Row label="Tight w&rap:" htmlFor="para-tight">
          <Pick id="para-tight" value={f.tightWrap ?? ''} options={TIGHT} onChange={set('tightWrap')} width="11rem" disabled={!ctxOf().in?.textbox} />
        </Row>
      </Fieldset>
      <Fieldset legend="Preview">{preview()}</Fieldset>
    </>
  );

  const asian = () => (
    <>
      <Fieldset legend="Line break">
        <Check label="&Use Asian rules for controlling first and last characters" checked={f.kinsoku} onChange={set('kinsoku')} />
        <Check label="Allo&w Latin text to wrap in the middle of a word" checked={f.latinWrap} onChange={set('latinWrap')} />
        <Check label="Allow ha&nging punctuation" checked={f.overflowPunct} onChange={set('overflowPunct')} />
      </Fieldset>
      <Fieldset legend="Character spacing">
        <Check label="Allow pun&ctuation at the start of a line to compress" checked={f.topLinePunct} onChange={set('topLinePunct')} />
        <Check label="Automatically adjust spac&e between Asian and Latin text" checked={f.autoSpaceDE} onChange={set('autoSpaceDE')} />
        <Check label="Automatically adju&st space between Asian text and numbers" checked={f.autoSpaceDN} onChange={set('autoSpaceDN')} />
        <Row label="Text &alignment:" htmlFor="para-text-align">
          <Pick id="para-text-align" value={f.textAlignment ?? ''} options={TEXT_ALIGN} onChange={set('textAlignment')} width="7rem" />
        </Row>
        {/* Word's Options... opens a page of the Options dialog this build does not have. */}
        <Button type="button" variant="outline" size="xs" disabled className="w-fit">Options...</Button>
      </Fieldset>
      <Fieldset legend="Preview">{preview()}</Fieldset>
    </>
  );

  return (
    <WordDialog title="Paragraph" size="md" tab={tab} onTab={setTab} onClose={onClose} validate={validate} result={result}
      left={[{ label: '&Tabs...', onClick: tabs, disabled: valueMode }, { label: 'Set As &Default', onClick: setDefault, disabled: valueMode }]}
      tabs={[{ id: 'indents', label: '&Indents and Spacing', render: indents }, { id: 'breaks', label: 'Line and &Page Breaks', render: breaks },
        { id: 'asian', label: 'Asian T&ypography', render: asian }]} />
  );
}

