// File > Info > Protect Document (the panel backstage's Info page draws, _gaps-tracking.md G10) and the bar under the ribbon
// while the document is marked as final or open read-only, with Edit Anyway.
import { Button } from '@/components/ui/button';
import { confirmDialog } from '../../../app/actions.js';
import { both } from '../../../tooling/engine-provider.mjs';
import { REASONS } from '../../../tooling/reasons.mjs';
import { useWordCtx } from '../../../tooling/registry.js';
import { enforced, finalOf, protectionOf, sessionOf, setFinal, setSession, setWriteProtection, writeProtected } from './act.js';

/** The Protect Document status line under its button on the Info page; on a canvas draft from file.info (stage2.md G32). */
export function protectDesc(ctx) {
  if (ctx.engine) {
    const info = ctx.read('file.info', {});
    if (info?.final) return 'This document is marked as final to discourage editing.';
    if (info?.trackingLocked) return 'Track Changes is locked on for everyone who edits this document.';
    if (info?.protection) return info.protection === 'readOnly' ? 'This document is protected from changes.' : 'Some types of changes are restricted in this document.';
    return 'Anyone can open, copy and change any part of this document.';
  }
  const ed = ctx.ed;
  if (finalOf(ed)) return 'This document is marked as final to discourage editing.';
  if (enforced(ed)) return protectionOf(ed).edit === 'readOnly' ? 'This document is protected from changes.' : 'Some types of changes are restricted in this document.';
  if (writeProtected(ed)) return 'This document asks to be opened read-only.';
  return 'Anyone can open, copy and change any part of this document.';
}

/** Runs `mark` after the user confirms Mark as Final, so both editors ask the same question. */
async function confirmFinal(mark) {
  const yes = await confirmDialog({ title: 'Mark as final?', description: 'The document will open read-only until someone chooses Edit Anyway.',
    confirmText: 'Mark as Final' });
  if (yes) await mark();
}

/** Mark as Final after the user confirms. */
export function markFinal(ed) {
  return confirmFinal(() => setFinal(ed, true));
}

const ITEMS = [
  { id: 'readOnly', label: 'Always Open Read-Only', desc: 'Ask readers to open this document read-only.' },
  { id: 'encrypt', label: 'Encrypt with Password', reason: REASONS.encrypt },
  { id: 'restrict', label: 'Restrict Editing', desc: 'Control what types of changes others can make.' },
  { id: 'signature', label: 'Add a Digital Signature', reason: REASONS.signature },
  { id: 'final', label: 'Mark as Final', desc: 'Let readers know the document is final.' },
];

/** Mark as Final on a canvas draft after the user confirms (file.markAsFinal). */
function markFinalCanvas(ctx) {
  return confirmFinal(() => ctx.engine.exec('file.markAsFinal', { value: true }));
}

/** The menu on a canvas draft: Restrict Editing and Mark as Final; Always Open Read-Only is not kept in the engine's document. */
function CanvasProtectPanel({ ctx, close }) {
  const run = { restrict: () => ctx.pane('restrictEditing', true), final: () => markFinalCanvas(ctx) };
  const why = { readOnly: 'Canvas drafts do not keep this setting yet.' };
  return (
    <div role="menu" className="flex w-80 flex-col text-xs" data-feature="file.info.protectDocument.menu" data-canvas="">
      {ITEMS.map((it) => {
        const reason = it.reason ?? why[it.id];
        return (
          <button key={it.id} type="button" role="menuitem" disabled={!!reason} title={reason} data-protect-item={it.id}
            className="flex flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
            onClick={() => { close?.(); run[it.id]?.(); }}>
            <span className="font-medium">{it.label}</span>
            <span className="text-muted-foreground">{reason ?? it.desc}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The Protect Document menu ({ctx, close}), on a canvas draft too. */
export const ProtectDocumentPanel = both(ProtectPanel);

function ProtectPanel({ ctx, close }) {
  if (ctx?.engine) return <CanvasProtectPanel ctx={ctx} close={close} />;
  const ed = ctx.ed;
  if (!ed) return null;
  const run = {
    readOnly: () => setWriteProtection(ed, !writeProtected(ed)),
    restrict: () => ctx.pane('restrictEditing', true),
    final: () => markFinal(ed),
  };
  return (
    <div role="menu" className="flex w-80 flex-col text-xs" data-feature="file.info.protectDocument.menu">
      {ITEMS.map((it) => (
        <button key={it.id} type="button" role={it.id === 'readOnly' ? 'menuitemcheckbox' : 'menuitem'} disabled={!!it.reason}
          aria-checked={it.id === 'readOnly' ? writeProtected(ed) : undefined} title={it.reason} data-protect-item={it.id}
          className="flex flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
          onClick={() => { close?.(); run[it.id]?.(); }}>
          <span className="font-medium">{it.id === 'readOnly' && writeProtected(ed) ? '✓ ' : ''}{it.label}</span>
          <span className="text-muted-foreground">{it.reason ?? it.desc}</span>
        </button>
      ))}
    </div>
  );
}

/** The bar on a canvas draft while it is marked as final: Edit Anyway removes the mark (file.markAsFinal). */
function CanvasFinalBar({ ctx }) {
  const session = ctx.engine;
  if (!ctx.stateOf('file.markAsFinal')?.checked) return null;
  return (
    <div data-protect-bar="final" data-canvas="" className="flex items-center gap-3 border-b bg-amber-100 px-3 py-1 text-xs text-amber-950 dark:bg-amber-900/40 dark:text-amber-100">
      <span className="font-medium">Marked as final</span>
      <span className="min-w-0 flex-1 truncate">An author marked this document as final to discourage editing.</span>
      <Button size="xs" variant="outline" data-protect="editAnyway" onClick={() => session.exec('file.markAsFinal', { value: false })}>Edit Anyway</Button>
    </div>
  );
}

/** The bar under the ribbon while the document is marked as final or open read-only. */
export function FinalBar() {
  const ctx = useWordCtx();
  if (ctx.engine) return <CanvasFinalBar ctx={ctx} />;
  const ed = ctx.ed;
  const final = finalOf(ed);
  const session = sessionOf(ed).session;
  if (!ed || (!final && !session)) return null;
  const editAnyway = () => {
    if (final) setFinal(ed, false);
    if (session) setSession(ed, { session: false });
  };
  return (
    <div data-protect-bar={final ? 'final' : 'readOnly'} className="flex items-center gap-3 border-b bg-amber-100 px-3 py-1 text-xs text-amber-950 dark:bg-amber-900/40 dark:text-amber-100">
      <span className="font-medium">{final ? 'Marked as final' : 'Read-only'}</span>
      <span className="min-w-0 flex-1 truncate">{final ? 'An author marked this document as final to discourage editing.' : 'This document is open read-only.'}</span>
      <Button size="xs" variant="outline" data-protect="editAnyway" onClick={editAnyway}>Edit Anyway</Button>
    </div>
  );
}
