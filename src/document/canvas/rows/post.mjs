// The forum post's rows of the engine table (docs/plans/engine/stage3-forum.md C2, section 2): the post kit's pool commands
// (src/app/pool.js POOL_IDS) and the rest of the text profile's grants on a post's canvas draft. Every row that runs an engine
// command reads the post's one state, post.context {block, align, marks, size, color, highlight, font, list, quote, code, box,
// inTable, canFormat} (B1), so the toolbar's toggles and value boxes show what the caret is in. A preset is the format.mjs
// presetChain list as post.mark steps. The dialogs, the boards and the plan chart act on the app (APP): insert.* has an own row
// for the kit's three, the rest of that prefix and references.*, board.*, plan.* and view.* run as registered.
// Pure: node tests load it.
import { APP, exec } from './forms.mjs';

const CTX = 'post.context';

/** What the caret is in (B1's post.context), or null until the state call answers. */
const read = (ctx) => ctx.stateOf?.(CTX)?.value ?? null;

/** Whether mark `name` is on: post.context's marks as a list of names or as flags by name. */
const has = (state, name) => (Array.isArray(state?.marks) ? state.marks.includes(name) : !!state?.marks?.[name]);

/** A mark toggle (post.mark {mark}), pressed from post.context's marks. */
const mark = (name) => exec('post.mark', { mark: name }, { state: CTX, active: (e) => has(e?.value, name) });

/** A table command's reason it is off, or null. */
const inTable = (ctx) => (read(ctx)?.inTable ? null : 'Put the cursor in a table first.');

/** Alt+1..9 preset `i` as post.mark steps in one undo step: drop the run's character formatting, then the preset's (format.mjs
 * presetChain, which the DOM editor runs). */
function preset(ctx, i) {
  const p = ctx.settings?.presets?.[i];
  if (!p || !ctx.engine) return false;
  const steps = [['post.mark', { font: null }], ['post.mark', { size: null }], ['post.mark', { color: null }],
    ['post.mark', { highlight: null }], ['post.mark', { mark: 'bold', on: false }], ['post.mark', { mark: 'italic', on: false }],
    ['post.mark', { mark: 'underline', on: false }]];
  if (p.fontFamily) steps.push(['post.mark', { font: p.fontFamily }]);
  if (p.size && Number(p.size) !== 100) steps.push(['post.mark', { size: Number(p.size) }]);
  if (p.color && p.color !== 'root') steps.push(['post.mark', { color: p.color }]);
  if (p.highlight) steps.push(['post.mark', { highlight: p.highlight }]);
  for (const name of ['bold', 'italic', 'underline']) if (p[name]) steps.push(['post.mark', { mark: name, on: true }]);
  return Promise.resolve(ctx.engine.execMany(steps)).then((r) => !!r?.ok);
}

/** A size in percent from the control or a caller: '150' or '150%' → 150, anything else NaN (pool.js text.size strips it). */
const percent = (v) => Number(String(v ?? '').replace('%', '').trim());

export const POST_ROWS = {
  'edit.undo': exec('edit.undo', {}, { state: CTX }),
  'edit.redo': exec('edit.redo', {}, { state: CTX }),

  'text.bold': mark('bold'),
  'text.italic': mark('italic'),
  'text.underline': mark('underline'),
  'text.strike': mark('strike'),
  'text.subscript': mark('subscript'),
  'text.superscript': mark('superscript'),
  'text.code': mark('code'),
  'text.clear': exec('post.clear', {}, { state: CTX }),
  // The value boxes: a font's name ('' or null is the base font), a size in percent, a colour or highlight key (root is none).
  'text.font': exec('post.mark', (v) => ({ font: v || null }), { state: CTX, value: (e) => e?.value?.font || '' }),
  'text.size': exec('post.mark', (v) => (Number.isFinite(percent(v)) ? { size: percent(v) } : null), { state: CTX, value: (e) => e?.value?.size ?? 100 }),
  'text.color': exec('post.mark', (v) => ({ color: v && v !== 'root' ? v : null }), { state: CTX, value: (e) => e?.value?.color || 'root' }),
  'text.highlight': exec('post.mark', (v) => ({ highlight: v || null }), { state: CTX, value: (e) => e?.value?.highlight || null }),
  'text.preset': { run: preset, enabled: (ctx) => !!ctx.engine, reads: [CTX] },

  'para.block': exec('post.block', (v) => (v ? { kind: v } : null), { state: CTX, value: (e) => e?.value?.block ?? 'p' }),
  'para.align': exec('para.align', (v) => ({ value: v }), { state: CTX, value: (e) => e?.value?.align ?? 'left' }),
  'para.bulletList': exec('post.list', { kind: 'bullet' }, { state: CTX, active: (e) => e?.value?.list === 'bullet' }),
  'para.orderedList': exec('post.list', { kind: 'ordered' }, { state: CTX, active: (e) => e?.value?.list === 'ordered' }),
  'para.quote': exec('post.toggle', { kind: 'quote' }, { state: CTX, active: (e) => !!e?.value?.quote }),
  'para.codeBlock': exec('post.toggle', { kind: 'code' }, { state: CTX, active: (e) => !!e?.value?.code }),

  'insert.rule': exec('post.rule', {}, { state: CTX }),
  'insert.table': exec('insert.table', { rows: 3, cols: 3 }, { state: CTX }),
  'insert.box': exec('post.toggle', { kind: 'box' }, { state: CTX, active: (e) => !!e?.value?.box }),

  'table.addRowAfter': exec('table.insertRowBelow', {}, { state: CTX, when: inTable }),
  'table.addColumnAfter': exec('table.insertColumnRight', {}, { state: CTX, when: inTable }),
  'table.deleteRow': exec('table.deleteRow', {}, { state: CTX, when: inTable }),
  'table.deleteColumn': exec('table.deleteColumn', {}, { state: CTX, when: inTable }),
  'table.deleteTable': exec('table.deleteTable', {}, { state: CTX, when: inTable }),

  'insert.*': APP,
  'references.*': APP,
  'board.*': APP,
  'plan.*': APP,
  'view.*': APP,
};
