// The paragraph work package (docs/plans/word/briefs/paragraph.md, plan.md §3 paragraph): the Paragraph dialog, the alignment
// toggles with Distributed, Word's indent steps, right-to-left paragraphs, Ctrl+Q, the Asian Layout menu and its dialogs, and the
// drawing of Word's spacing and line-height rules (extension.js). Line and Page Breaks options are written here and laid out by
// page-engine, layout-misc and float-layout.
import { textblocks } from '../../lists.js';
import { styleIdOf } from '../../model/styles.mjs';
import { CombineCharacters, FitText, HorizontalInVertical, TwoLinesInOne } from './AsianDialogs.jsx';
import { EXTENSIONS, MIRROR_PASS } from './extension.js';
import { ParagraphDialog } from './ParagraphDialog.jsx';
import { effectivePara, styleProps } from './rules.mjs';

const parasOf = (ctx) => (ctx.state ? textblocks(ctx.state) : []);
const hasParas = (ctx) => parasOf(ctx).length > 0;

// ---------- alignment ----------
const ALIGN = { alignLeft: 'left', center: 'center', alignRight: 'right', justify: 'justify', distributed: 'distribute' };

/** Whether every selected paragraph shows alignment `v` (its own or its style's). */
const aligned = (ctx, v) => {
  const paras = parasOf(ctx);
  return paras.length > 0 && paras.every(({ node }) => (effectivePara(ctx.state.doc, node).textAlign ?? 'left') === v);
};

/** An alignment toggle: pressing the active one (other than Align Left) returns the paragraphs to left, as Word's buttons and
 * chords do. A value the style already gives is written as null (inherited). */
const alignCommand = (v) => ({
  run: (ctx) => {
    const want = v !== 'left' && aligned(ctx, v) ? 'left' : v;
    return ctx.chain((c) => c.command(({ tr }) => {
      for (const { pos } of textblocks({ doc: tr.doc, selection: tr.selection })) {
        const node = tr.doc.nodeAt(pos);
        const style = styleProps(tr.doc, styleIdOf(node)).para.textAlign ?? 'left';
        tr.setNodeAttribute(pos, 'textAlign', want === style ? null : want);
      }
      return true;
    }));
  },
  active: (ctx) => aligned(ctx, v),
  enabled: hasParas,
  repeatable: true,
});

// ---------- run properties of the Asian Layout menu ----------
const runAttrs = (ctx) => {
  const s = ctx.state;
  return (s?.storedMarks ?? s?.selection.$from.marks() ?? []).find((m) => m.type.name === 'textStyle')?.attrs ?? {};
};
const SCALES = [200, 150, 100, 90, 80, 66, 50, 33];
const SCALE = 'home.paragraph.asianLayout.characterScaling';
const scaleTo = (ctx, pct) => (Number.isFinite(+pct) && +pct > 0 ? ctx.chain((c) => c.setRunProps({ scale: +pct === 100 ? null : Math.round(+pct) })) : false);
const scaleNow = (ctx) => runAttrs(ctx).scale ?? 100;

// The dialog applies itself, so the command does not wait for it (a harness or tool search run returns at once).
const opens = (dialog, more) => ({ run: (ctx) => (ctx.dialog(dialog, more?.props), true), enabled: hasParas, ...more?.spec });
const chain = (fn) => ({ run: (ctx) => ctx.chain(fn), enabled: hasParas, repeatable: true });

const COMMANDS = {
  ...Object.fromEntries(Object.entries(ALIGN).map(([k, v]) => [`home.paragraph.${k}`, alignCommand(v)])),

  // Indents: Increase and Decrease Indent and their chords (Ctrl+M, Ctrl+Shift+M), Ctrl+T and Ctrl+Shift+T through the commands
  // extension.js puts in place of the schema's, so the native chords and the agents' doc.command reach the same steps.
  'home.paragraph.increaseIndent': chain((c) => c.increaseIndent()),
  'home.paragraph.decreaseIndent': chain((c) => c.decreaseIndent()),
  'indents.indentKey': chain((c) => c.increaseIndent()),
  'indents.unIndentKey': chain((c) => c.decreaseIndent()),
  'indents.hangingKey': chain((c) => c.setHanging(true)),
  'indents.unHangKey': chain((c) => c.setHanging(false)),

  // The Paragraph dialog
  'home.paragraph.launcher': opens('paragraph'),
  'home.paragraph.lineAndParagraphSpacing.lineSpacingOptions': opens('paragraph', { props: { focus: 'spacing' } }),

  // Asian Layout
  'home.paragraph.asianLayout': { run: () => false, enabled: hasParas }, // the menu itself; its items act
  'home.paragraph.asianLayout.horizontalInVertical': opens('horizontalInVertical'),
  'home.paragraph.asianLayout.combineCharacters': opens('combineCharacters'),
  'home.paragraph.asianLayout.twoLinesInOne': opens('twoLinesInOne'),
  'home.paragraph.asianLayout.fitText': opens('fitText', {
    spec: { enabled: (ctx) => hasParas(ctx) && !ctx.state.selection.empty, reason: () => 'Select the text to fit first.' },
  }),
  [SCALE]: { run: scaleTo, value: scaleNow, enabled: hasParas, repeatable: true },
  ...Object.fromEntries(SCALES.map((p) => [`${SCALE}.${p}`, { run: (ctx) => scaleTo(ctx, p), active: (ctx) => scaleNow(ctx) === p, enabled: hasParas }])),
  [`${SCALE}.more`]: opens('font', { props: { tab: 'advanced' } }),

  // Direction, Open or Close Up and Ctrl+Q (tool search finds them; Word has no ribbon control for the first three)
  'paragraph.rightToLeft': chain((c) => c.setParaProps({ bidi: true })),
  'paragraph.leftToRight': chain((c) => c.setParaProps({ bidi: false })),
  'paragraph.openCloseUp': {
    run: (ctx) => {
      const [first] = parasOf(ctx);
      const sp = first ? effectivePara(ctx.state.doc, first.node).spacing ?? {} : {};
      return ctx.chain((c) => c.setParaProps({ spacing: { before: sp.before > 0 || sp.beforeAuto ? 0 : 12, beforeAuto: null } }));
    },
    enabled: hasParas,
    repeatable: true,
  },
  'paragraph.resetParagraph': chain((c) => c.clearParagraph()),
};

export default {
  id: 'paragraph',
  extensions: EXTENSIONS,
  passes: [MIRROR_PASS],
  commands: COMMANDS,
  dialogs: { paragraph: ParagraphDialog, combineCharacters: CombineCharacters, twoLinesInOne: TwoLinesInOne, horizontalInVertical: HorizontalInVertical, fitText: FitText },
  // Behaviours and dialog options this package delivers without a command of their id (plan.md §1.2).
  implements: ['indents.mirror', 'indents.negative', 'paragraph.outlineLevel', 'paragraph.collapsedByDefault', 'paragraph.contextualSpacing',
    'paragraph.spacingCollapse', 'paragraph.autoSpacing', 'paragraph.lineRules', 'paragraph.widowControl', 'paragraph.keepWithNext',
    'paragraph.keepLinesTogether', 'paragraph.pageBreakBefore', 'paragraph.suppressLineNumbers', 'paragraph.dontHyphenate',
    'paragraph.textboxTightWrap', 'paragraph.snapToGrid', 'paragraph.asianTypography'],
};
