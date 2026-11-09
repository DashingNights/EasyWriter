// The Mailings tab's commands (docs/plans/word/plan.md §1.3, §3 mailings; briefs/mailings.md). Every control and item id of the tab
// that is not a placeholder by decision (e-mail and contacts) runs here. Dialogs return data; these commands write it: the list to the
// draft record, choices to doc.attrs.merge (one undo step each), fields through the field engine, merged documents as new drafts.
import { closeHistory } from '@tiptap/pm/history';
import { confirmDialog, createDraft, toast } from '../../../app/actions.js';
import { getState } from '../../../app/store.js';
import { run } from '../../../tooling/registry.js';
import { newDocumentJson } from '../../defaults.mjs';
import { insertField } from '../../fields/engine.js';
import { parseField } from '../../fields/registry.mjs';
import { sectionsOf, withDefaults } from '../../model/sections.mjs';
import { docOfDraft } from '../../docx/files.js';
import { findIn, parseDelimited, sourceOfDoc } from './data.mjs';
import { chevron, mergeFieldCode, missingFields } from './fields.mjs';
import { addressSheet, derivedAttrs, envelopeBlocks, envelopeSect, isEnvelopeSect, labelAttr, labelSect, mergeDocument, mergeLabelTable,
  updateLabels } from './merge.mjs';
import { activeOf, highlightOf, mergeOf, patchMerge, previewOf, setHighlight, setPreview, setSource, sourceOf, typeOf } from './state.js';

const P = 'mailings.';
const NO_LIST = 'Select a recipient list first.';
const hasList = () => !!sourceOf()?.fields?.length;
const withList = (spec) => ({ enabled: (ctx) => !!ctx.ed && hasList(), reason: () => (hasList() ? null : NO_LIST), ...spec });
const inMerge = (spec) => ({ enabled: (ctx) => !!typeOf(ctx.ed) || hasList(), reason: (ctx) => (typeOf(ctx.ed) || hasList() ? null : 'Start a mail merge first.'), ...spec });
const editorOf = (ctx) => ctx.target ?? ctx.ed;
// The file picker, through the test seam (plan.md §1.16: contextBridge's api cannot be replaced in the page).
const openFile = (opts) => (globalThis.__wordTest?.openFile ?? window.api.word.openFile)(opts);

/** Inserts field `code` at the selection of the editor commands act on, with `result` as its shown text. */
function insert(ctx, code, result) {
  const ed = editorOf(ctx);
  if (!ed) return false;
  return insertField(ed, code, result === undefined ? {} : { result });
}

/** The chevron text a merge field shows before a preview (MERGEFIELD Name → «Name»). */
function placeholderOf(code) {
  const f = parseField(code);
  if (f.name === 'MERGEFIELD') return chevron(f.args[0] ?? '');
  return { ADDRESSBLOCK: chevron('AddressBlock'), GREETINGLINE: chevron('GreetingLine'), MERGEREC: chevron('Merge Record #'),
    MERGESEQ: chevron('Merge Sequence #'), NEXT: chevron('Next Record'), NEXTIF: chevron('Next Record If'), SKIPIF: chevron('Skip Record If') }[f.name];
}

/** Makes `ed` a merge of `type` (null: a normal document, which also ends a preview). */
function setType(ed, type) {
  if (!type) setPreview(null);
  patchMerge(ed, { type });
  return true;
}

const hasText = (ed) => ed.state.doc.textContent.trim().length > 0 || ed.state.doc.childCount > 1;

/** Asks before a label or envelope merge replaces the document's content (undo brings it back). */
const replaceOk = (ed, what) => !hasText(ed) || confirmDialog({ title: 'Replace the document’s content?',
  description: `Starting ${what} lays the page out again and replaces what the document holds. Undo brings it back.`, confirmText: 'Replace' });

/** Replaces `ed`'s content with `blocks` (JSON), its last section's sect with `sect` and patches merge with `patch`, as one undo step. */
function relayout(ed, blocks, sect, patch) {
  const { state } = ed;
  const tr = state.tr.replaceWith(0, state.doc.content.size, blocks.map((b) => state.schema.nodeFromJSON(b)));
  tr.setDocAttribute('sect', sect);
  patchMerge(ed, patch, tr);
  ed.view.dispatch(closeHistory(tr));
  return true;
}

const userAddress = (ctx) => {
  const u = ctx.settings?.word?.user ?? {};
  return [u.name, u.address].filter((s) => String(s ?? '').trim()).join('\n');
};
const lastSect = (ed) => withDefaults(ed.state.doc.attrs.sect);

/** Start Mail Merge > Envelopes...: Envelope Options, then the page becomes the envelope with the return address and a place for
 * the delivery address. */
async function startEnvelopes(ctx) {
  const ed = ctx.ed;
  const env = await ctx.dialog('envelopeOptions', { value: mergeOf(ed).envelope });
  if (!env || !(await replaceOk(ed, 'an envelope merge'))) return false;
  return relayout(ed, envelopeBlocks(env, { ret: env.ret?.omit ? '' : userAddress(ctx) }), envelopeSect(env, lastSect(ed)), { type: 'envelopes', envelope: env });
}

/** Start Mail Merge > Labels...: Label Options, then the page becomes one sheet of the label with a NEXT field in every cell but the
 * first. */
async function startLabels(ctx) {
  const ed = ctx.ed;
  const label = await ctx.dialog('labelOptions', { value: mergeOf(ed).label });
  if (!label || !(await replaceOk(ed, 'a label merge'))) return false;
  return relayout(ed, [mergeLabelTable(label), { type: 'paragraph' }], labelSect(label, lastSect(ed)), { type: 'labels', label: labelAttr(label) });
}

/** Loads a recipient list: `arg` {draftId} reads that Document draft's first table, else the open dialog reads a CSV, TSV or TXT file. */
async function useExisting(ctx, arg) {
  let source = null;
  if (arg?.draftId) {
    const draft = await window.api.drafts.load(arg.draftId);
    const doc = await docOfDraft(draft); // a canvas draft's through the engine (engine-canvas-read)
    source = doc && sourceOfDoc(doc, draft.title || 'Draft');
    if (!source) return toast('That draft has no table to use as a list.', true), false;
  } else {
    const file = await openFile({ filters: [{ name: 'Lists', extensions: ['csv', 'tsv', 'txt'] }], as: 'text' });
    if (!file) return false;
    source = parseDelimited(file.data, file.name);
  }
  return setSource(ctx.ed, source);
}

/** The field codes of `doc`, in order (Check for Errors). */
function codesOf(doc) {
  const out = [];
  doc.descendants((n) => {
    if (n.type.name === 'field' || n.type.name === 'fieldBlock') out.push(n.attrs.code);
  });
  return out;
}

/** A new document's doc attrs from the main document's, every key the new document needs present. */
const fullAttrs = (ctx, attrs) => ({ ...newDocumentJson(getState().settings).attrs,
  ...Object.fromEntries(Object.entries(attrs).filter(([, v]) => v != null)), merge: null, comments: null });

const TITLES = { letters: 'Letters', envelopes: 'Envelopes', labels: 'Labels', directory: 'Directory' };
let made = 0; // Word numbers its merge results Letters1, Letters2 for the session

/** Edit Individual Documents and Print Documents: the merge range, then a new Document draft with one copy per record; Print also
 * prints it (Word prints without a document; recorded). */
async function finish(ctx, print) {
  const ed = ctx.ed;
  const list = activeOf(ed);
  if (!list.length) return toast('No recipient is ticked in the list.'), false;
  const range = await ctx.dialog(print ? 'printDocuments' : 'editIndividualDocuments', { current: previewOf() ?? 1, count: list.length });
  if (!range) return false;
  const merge = mergeOf(ed);
  const out = await mergeDocument(ed.getJSON(), list, sourceOf(), merge, { ...range, pmDoc: ed.state.doc });
  if (!out.doc) return toast('Every record was skipped, so the merge made nothing.'), false;
  out.doc.attrs = fullAttrs(ctx, out.doc.attrs);
  setPreview(null);
  await createDraft({ title: `${TITLES[merge.type] ?? 'Letters'}${++made}`, doc: out.doc, format: 'document' });
  if (print) run('file.print');
  return true;
}

/** Check for Errors: simulate (report in a new document, or say there are none) or complete the merge. */
async function checkErrors(ctx) {
  const ed = ctx.ed;
  const how = await ctx.dialog('checkingAndReportingErrors', {});
  if (!how) return false;
  const missing = missingFields(codesOf(ed.state.doc), sourceOf(), mergeOf(ed));
  if (how !== 'simulate') {
    if (missing.length && how === 'pause') toast(`The list has no column named ${missing.map((m) => `"${m}"`).join(', ')}.`, true);
    return finish(ctx, false);
  }
  if (!missing.length) return toast('No mail merge errors were found.'), true;
  const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const doc = { type: 'doc', attrs: fullAttrs(ctx, derivedAttrs(ed.state.doc.attrs)),
    content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Mail merge errors' }] },
      ...missing.map((m) => p(`The merge field ${chevron(m)} names a column the recipient list does not have.`))] };
  await createDraft({ title: 'Mail merge errors', doc, format: 'document' });
  return true;
}

/** Envelopes and Labels: Add to Document puts the envelope in its own first section; New Document makes a label sheet draft. */
async function envelopesAndLabels(ctx, tab) {
  const ed = ctx.ed;
  const { state } = ed;
  const sel = state.selection;
  const selected = sel.empty ? '' : state.doc.textBetween(sel.from, sel.to, '\n');
  const merge = mergeOf(ed);
  const r = await ctx.dialog('envelopesAndLabels', { tab, delivery: selected, ret: userAddress(ctx), envelope: merge.envelope, label: merge.label });
  if (!r) return false;
  if (r.action === 'newDocument') {
    const doc = { type: 'doc', attrs: fullAttrs(ctx, derivedAttrs(state.doc.attrs, { sect: labelSect(r.label, lastSect(ed)) })),
      content: [addressSheet(r.label, r.address, r), { type: 'paragraph' }] };
    await createDraft({ title: 'Labels', doc, format: 'document' });
    return true;
  }
  // Add to Document: a first section of the envelope's size before the body; a second Add replaces the envelope already there.
  const first = sectionsOf(state.doc)[0];
  const replace = first?.holder != null && isEnvelopeSect(first.sect);
  const blocks = [...envelopeBlocks(r.envelope, { delivery: r.delivery, ret: r.envelope.ret?.omit ? '' : r.ret }),
    { type: 'sectionBreak', attrs: { kind: 'nextPage', sect: envelopeSect(r.envelope, first?.sect ?? lastSect(ed)) } }];
  const tr = state.tr.replaceWith(0, replace ? first.to : 0, blocks.map((b) => state.schema.nodeFromJSON(b)));
  patchMerge(ed, { envelope: r.envelope }, tr);
  ed.view.dispatch(closeHistory(tr));
  return true;
}

/** Update Labels: the first label's content copied into every other label after its NEXT field. */
function doUpdateLabels(ctx) {
  const ed = ctx.ed;
  let at = null;
  ed.state.doc.descendants((n, pos) => {
    if (at || n.type.name !== 'table') return !at;
    at = { pos, node: n };
    return false;
  });
  if (!at) return false;
  const table = ed.state.schema.nodeFromJSON(updateLabels(at.node.toJSON()));
  ed.view.dispatch(closeHistory(ed.state.tr.replaceWith(at.pos, at.pos + at.node.nodeSize, table)));
  return true;
}

/** Moves the preview to position `n` of the active list (clamped). */
function go(ctx, n) {
  const count = activeOf(ctx.ed).length;
  if (!count) return toast('No recipient is ticked in the list.'), false;
  setPreview(Math.max(1, Math.min(count, n)));
  return true;
}

/** Turns Preview Results on (at the record shown last) or off; the switch is kept in merge.preview, one undo step. */
function togglePreview(ctx) {
  const on = previewOf() == null;
  const count = activeOf(ctx.ed).length;
  const n = on ? Math.max(1, Math.min(count || 1, Number(mergeOf(ctx.ed).preview) || 1)) : null;
  setPreview(n);
  patchMerge(ctx.ed, { preview: n });
  return true;
}

/** Inserts one of Rules' fields from its Insert Word Field dialog `dialog`. */
async function rule(ctx, dialog) {
  const bookmarks = [];
  ctx.ed?.state.doc.descendants((n) => {
    if (n.type.name === 'bookmark' && !n.attrs.end && n.attrs.name) bookmarks.push(n.attrs.name);
  });
  const code = await ctx.dialog(dialog, { fields: sourceOf()?.fields ?? [], bookmarks });
  return code ? insert(ctx, code, placeholderOf(code)) : false;
}

/** Inserts the merge field `name` (`mapped`: an address field through Match Fields). */
const mergeField = (ctx, name, mapped = false) => insert(ctx, mergeFieldCode(name, { mapped }), chevron(name));

/** The commands by feature id (module `commands`). */
export const COMMANDS = {
  [`${P}create.envelopes`]: { run: (ctx) => envelopesAndLabels(ctx, 'envelopes') },
  [`${P}create.labels`]: { run: (ctx) => envelopesAndLabels(ctx, 'labels') },

  [`${P}startMailMerge.startMailMerge.letters`]: { run: (ctx) => setType(ctx.ed, 'letters'), active: (ctx) => typeOf(ctx.ed) === 'letters' },
  [`${P}startMailMerge.startMailMerge.envelopes`]: { run: startEnvelopes, active: (ctx) => typeOf(ctx.ed) === 'envelopes' },
  [`${P}startMailMerge.startMailMerge.labels`]: { run: startLabels, active: (ctx) => typeOf(ctx.ed) === 'labels' },
  [`${P}startMailMerge.startMailMerge.directory`]: { run: (ctx) => setType(ctx.ed, 'directory'), active: (ctx) => typeOf(ctx.ed) === 'directory' },
  [`${P}startMailMerge.startMailMerge.normalWordDocument`]: { run: (ctx) => setType(ctx.ed, null), active: (ctx) => !typeOf(ctx.ed) },
  [`${P}startMailMerge.startMailMerge.stepByStepMailMergeWizard`]: { run: (ctx) => ctx.pane('mailMerge', true) },

  [`${P}startMailMerge.selectRecipients.typeANewList`]: {
    run: async (ctx) => {
      const source = await ctx.dialog('typeANewList', {});
      return source ? setSource(ctx.ed, source) : false;
    },
  },
  [`${P}startMailMerge.selectRecipients.useAnExistingList`]: { run: useExisting },
  [`${P}startMailMerge.editRecipientList`]: withList({
    run: async (ctx) => {
      const r = await ctx.dialog('mailMergeRecipients', { source: sourceOf(), merge: mergeOf(ctx.ed) });
      if (!r) return false;
      const { source, ...patch } = r;
      if (source && !(await setSource(ctx.ed, source, { keep: true }))) return false;
      patchMerge(ctx.ed, patch);
      if (previewOf() != null) go(ctx, previewOf());
      return true;
    },
  }),
  'keys.mailMergeEditSource': withList({
    run: async (ctx) => {
      const source = await ctx.dialog('typeANewList', { source: sourceOf() });
      return source ? setSource(ctx.ed, source, { keep: true }) : false;
    },
  }),

  [`${P}writeInsertFields.highlightMergeFields`]: { run: () => setHighlight(!highlightOf()) || true, active: () => highlightOf() },
  [`${P}writeInsertFields.addressBlock`]: inMerge({
    run: async (ctx) => {
      const r = await ctx.dialog('insertAddressBlock', { source: sourceOf(), merge: mergeOf(ctx.ed) });
      if (!r) return false;
      if (hasList()) patchMerge(ctx.ed, { map: r.map });
      return insert(ctx, r.code, chevron('AddressBlock'));
    },
  }),
  [`${P}writeInsertFields.greetingLine`]: inMerge({
    run: async (ctx) => {
      const r = await ctx.dialog('insertGreetingLine', { source: sourceOf(), merge: mergeOf(ctx.ed) });
      if (!r) return false;
      if (hasList()) patchMerge(ctx.ed, { map: r.map });
      return insert(ctx, r.code, chevron('GreetingLine'));
    },
  }),
  [`${P}writeInsertFields.insertMergeField`]: withList({
    run: async (ctx, arg) => {
      if (typeof arg === 'string' && arg) return mergeField(ctx, arg);
      const r = await ctx.dialog('insertMergeField', { source: sourceOf(), merge: mergeOf(ctx.ed) });
      if (!r) return false;
      if (r.mapped) patchMerge(ctx.ed, { map: r.map });
      return mergeField(ctx, r.name, r.mapped);
    },
  }),
  [`${P}writeInsertFields.matchFields`]: withList({
    run: async (ctx) => {
      const map = await ctx.dialog('matchFields', { fields: sourceOf().fields, map: mergeOf(ctx.ed).map });
      return map ? (patchMerge(ctx.ed, { map }), true) : false;
    },
  }),
  [`${P}writeInsertFields.updateLabels`]: {
    run: doUpdateLabels,
    enabled: (ctx) => typeOf(ctx.ed) === 'labels',
    reason: (ctx) => (typeOf(ctx.ed) === 'labels' ? null : 'Start a label merge first.'),
  },
  [`${P}writeInsertFields.rules.ask`]: inMerge({ run: (ctx) => rule(ctx, 'insertWordFieldAsk') }),
  [`${P}writeInsertFields.rules.fillIn`]: inMerge({ run: (ctx) => rule(ctx, 'insertWordFieldFillIn') }),
  [`${P}writeInsertFields.rules.ifThenElse`]: inMerge({ run: (ctx) => rule(ctx, 'ifThenElse') }),
  [`${P}writeInsertFields.rules.mergeRecord`]: inMerge({ run: (ctx) => insert(ctx, 'MERGEREC', chevron('Merge Record #')) }),
  [`${P}writeInsertFields.rules.mergeSequence`]: inMerge({ run: (ctx) => insert(ctx, 'MERGESEQ', chevron('Merge Sequence #')) }),
  [`${P}writeInsertFields.rules.nextRecord`]: inMerge({ run: (ctx) => insert(ctx, 'NEXT', chevron('Next Record')) }),
  [`${P}writeInsertFields.rules.nextRecordIf`]: inMerge({ run: (ctx) => rule(ctx, 'nextRecordIf') }),
  [`${P}writeInsertFields.rules.setBookmark`]: inMerge({ run: (ctx) => rule(ctx, 'setBookmark') }),
  [`${P}writeInsertFields.rules.skipRecordIf`]: inMerge({ run: (ctx) => rule(ctx, 'skipRecordIf') }),

  [`${P}previewResults.previewResults`]: withList({ run: togglePreview, active: () => previewOf() != null && hasList() }),
  ...Object.fromEntries([['first', () => 1], ['previous', (n) => n - 1], ['next', (n) => n + 1], ['last', (n, count) => count]].map(([id, to]) => [
    `${P}previewResults.${id}`, {
      run: (ctx) => go(ctx, to(previewOf(), activeOf(ctx.ed).length)),
      enabled: (ctx) => previewOf() != null && hasList() && activeOf(ctx.ed).length > 1,
      reason: () => (previewOf() == null ? 'Turn on Preview Results first.' : null),
    }])),
  [`${P}previewResults.record`]: {
    run: (ctx, text) => (/^\s*\d+\s*$/.test(String(text ?? '')) ? go(ctx, Number(text)) : false),
    value: () => (previewOf() == null ? '' : String(previewOf())),
    enabled: () => previewOf() != null && hasList(),
    reason: () => (previewOf() == null ? 'Turn on Preview Results first.' : null),
  },
  [`${P}previewResults.findRecipient`]: withList({
    run: (ctx) => ctx.dialog('findEntry', { fields: sourceOf().fields, onFind: (text, field) => {
      const i = findIn(sourceOf().fields, activeOf(ctx.ed), text, field, (previewOf() ?? 0) - 1);
      if (i < 0) return false;
      if (previewOf() == null) patchMerge(ctx.ed, { preview: i + 1 });
      setPreview(i + 1);
      return true;
    } }),
  }),
  [`${P}previewResults.checkForErrors`]: withList({ run: checkErrors }),
  [`${P}finish.finishMerge.editIndividualDocuments`]: withList({ run: (ctx) => finish(ctx, false) }),
  [`${P}finish.finishMerge.printDocuments`]: withList({ run: (ctx) => finish(ctx, true) }),
};

/** The Insert Merge Field arrow's gallery: the list's columns (picking one inserts it). */
export const mergeFieldGallery = () => (sourceOf()?.fields ?? []).map((f) => ({ id: f, label: f }));

