// The Step-by-Step Mail Merge Wizard as the right pane `mailMerge` (docs/plans/word/briefs/mailings.md Start Mail Merge): six steps
// from the document type to the merge, each running the Mailings commands, with Next and Previous links at the bottom.
import { useState } from 'react';
import { useStore } from '../../../app/store.js';
import { run } from '../../../tooling/registry.js';
import { Pick, Radio } from '../../../tooling/kit/controls.jsx';
import { Link } from './Lists.jsx';
import { activeOf, previewOf, sourceOf, typeOf } from './state.js';

const P = 'mailings.';
const STEPS = ['Select document type', 'Select starting document', 'Select recipients', 'Write your letter', 'Preview your letters', 'Complete the merge'];
const TYPES = [['letters', 'Letters'], ['email', 'E-mail messages'], ['envelopes', 'Envelopes'], ['labels', 'Labels'], ['directory', 'Directory']];
const START = { letters: 'letters', envelopes: 'envelopes', labels: 'labels', directory: 'directory' };

const H = ({ children }) => <h3 className="text-xs font-semibold">{children}</h3>;
const Note = ({ children }) => <p className="text-xs text-muted-foreground">{children}</p>;

/** The merge the wizard shows: the DOM editor's, or on a canvas draft the engine's (mailings.state) → {type, source ({name,
 * count}) | null, count (records that merge), at (the record previewed) | null}. */
function mergeView(ctx) {
  if (!ctx.engine) {
    const source = sourceOf();
    return { type: typeOf(ctx.ed) ?? 'letters', source: source && { name: source.name, count: source.records.length },
      count: source ? activeOf(ctx.ed).length : 0, at: previewOf() };
  }
  const m = ctx.stateOf?.('mailings.state')?.value ?? null;
  return { type: !m || m.kind === 'normal' ? 'letters' : m.kind, source: m?.hasList ? { name: m.source, count: m.total } : null,
    count: m?.records ?? 0, at: m?.preview ? m.record : null };
}

/** The wizard's body for the current step. */
function Step({ n, ctx }) {
  const { type, source, count, at } = mergeView(ctx);
  const drafts = useStore((s) => s.drafts);
  const openId = useStore((s) => s.draft?.id);
  const [draftId, setDraftId] = useState('');
  if (n === 0) {
    return (
      <>
        <H>Select document type</H>
        <Note>What type of document are you working on?</Note>
        <Radio name="mm-wiz-type" value={type} options={TYPES.map(([v, l]) => [v, l])}
          onChange={(v) => START[v] && run(`${P}startMailMerge.startMailMerge.${START[v]}`)} />
      </>
    );
  }
  if (n === 1) {
    return (
      <>
        <H>Select starting document</H>
        <Radio name="mm-wiz-start" value="current" onChange={() => {}} options={[['current', 'Use the current document']]} />
        <Note>Starting from a template or another document comes later.</Note>
        {type === 'envelopes' && <Link label="Envelope options..." onClick={() => run(`${P}startMailMerge.startMailMerge.envelopes`)} />}
        {type === 'labels' && <Link label="Label options..." onClick={() => run(`${P}startMailMerge.startMailMerge.labels`)} />}
      </>
    );
  }
  if (n === 2) {
    const others = (drafts ?? []).filter((d) => d.id !== openId && (!d.format || d.format === 'document'));
    return (
      <>
        <H>Select recipients</H>
        {source ? <Note>Recipients come from {source.name} ({source.count}).</Note> : <Note>Pick where the names and addresses come from.</Note>}
        <Link label="Type a new list..." onClick={() => run(`${P}startMailMerge.selectRecipients.typeANewList`)} />
        <Link label="Use a list from a file..." onClick={() => run(`${P}startMailMerge.selectRecipients.useAnExistingList`)} />
        <div className="flex flex-col gap-1">
          <Note>Or use the first table of another draft:</Note>
          <div className="flex gap-1">
            <Pick aria-label="Draft with the list" value={draftId} width="100%" options={[['', ''], ...others.map((d) => [d.id, d.title || 'Untitled'])]} onChange={setDraftId} />
            <Link label="Use" disabled={!draftId} onClick={() => run(`${P}startMailMerge.selectRecipients.useAnExistingList`, { draftId })} />
          </div>
        </div>
        <Link label="Edit recipient list..." disabled={!source} onClick={() => run(`${P}startMailMerge.editRecipientList`)} />
      </>
    );
  }
  if (n === 3) {
    return (
      <>
        <H>Write your letter</H>
        <Note>Write the letter, then click where a recipient's details go and pick one of these.</Note>
        <Link label="Address block..." onClick={() => run(`${P}writeInsertFields.addressBlock`)} />
        <Link label="Greeting line..." onClick={() => run(`${P}writeInsertFields.greetingLine`)} />
        <Link label="More items..." disabled={!source} onClick={() => run(`${P}writeInsertFields.insertMergeField`)} />
        {type === 'labels' && <Link label="Update all labels" onClick={() => run(`${P}writeInsertFields.updateLabels`)} />}
      </>
    );
  }
  if (n === 4) {
    return (
      <>
        <H>Preview your letters</H>
        <div className="flex items-center gap-2 text-xs">
          <Link label="«" disabled={at == null || at <= 1} onClick={() => run(`${P}previewResults.previous`)} />
          <span>Recipient: {at ?? '-'} of {count}</span>
          <Link label="»" disabled={at == null || at >= count} onClick={() => run(`${P}previewResults.next`)} />
        </div>
        {at == null && <Link label="Show the preview" disabled={!source} onClick={() => run(`${P}previewResults.previewResults`)} />}
        <Link label="Find a recipient..." disabled={!source} onClick={() => run(`${P}previewResults.findRecipient`)} />
        <Link label="Edit recipient list..." disabled={!source} onClick={() => run(`${P}startMailMerge.editRecipientList`)} />
      </>
    );
  }
  return (
    <>
      <H>Complete the merge</H>
      <Note>The merge makes a new draft with one copy per recipient, which you can change before you print it.</Note>
      <Link label="Print..." disabled={!source} onClick={() => run(`${P}finish.finishMerge.printDocuments`)} />
      <Link label="Edit individual letters..." disabled={!source} onClick={() => run(`${P}finish.finishMerge.editIndividualDocuments`)} />
    </>
  );
}

/** The wizard pane. */
export function MailMergePane({ ctx }) {
  const [n, setN] = useState(0);
  return (
    <div className="flex h-full flex-col gap-2 p-3 text-xs" data-merge-step={n + 1}>
      <div className="flex flex-1 flex-col gap-2 overflow-auto"><Step n={n} ctx={ctx} /></div>
      <div className="flex flex-col gap-1 border-t pt-2">
        <span className="text-muted-foreground">Step {n + 1} of 6</span>
        {n < 5 && <Link label={`Next: ${STEPS[n + 1]}`} onClick={() => setN(n + 1)} />}
        {n > 0 && <Link label={`Previous: ${STEPS[n - 1]}`} onClick={() => setN(n - 1)} />}
      </div>
    </div>
  );
}
