// Restrict Editing on a canvas draft (docs/plans/engine/stage2b.md, engine-gaps-review): the same steps as Pane.jsx, written to
// the engine's review.restrict, and while enforced each exception with who may edit it (its `ranges`). The protection, its
// exceptions and its password live in the engine's document; Mark as Final is file.markAsFinal. File > Info reads file.info.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Check, Pick } from '../../../tooling/kit/controls.jsx';
import { useEngineValue } from '../../../tooling/engine-value.js';
import { EDIT_TYPES } from './act.js';

const Heading = ({ children }) => <div className="border-b pb-0.5 font-medium">{children}</div>;
const SAYS = {
  readOnly: 'You can read this document but not change it.',
  comments: 'You can only add comments to this document.',
  trackedChanges: 'You can edit this document, and every change is tracked.',
  forms: 'You can only fill in the forms in this document.',
};

/** Position `a` before `b` (story, path, offset). */
const before = (a, b) => {
  const pa = a?.path ?? [];
  const pb = b?.path ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return pa.length !== pb.length ? pa.length < pb.length : (a?.off ?? 0) <= (b?.off ?? 0);
};

async function restrict(ctx, args) {
  const r = await Promise.resolve(ctx.engine.exec('review.restrict', args)).catch((e) => ({ ok: false, error: String(e) }));
  if (!r?.ok) console.error('review.restrict failed:', r?.error);
  return r;
}

function Enforced({ ctx, st }) {
  const mine = (st.ranges ?? []).filter((r) => r.mine);
  const findNext = async () => {
    const sel = await Promise.resolve(ctx.engine.selection()).catch(() => null);
    const r = mine.find((x) => sel && !before(x.start, sel.head)) ?? mine[0];
    if (r) ctx.engine.exec('select.range', { anchor: r.start, focus: r.end });
  };
  const stop = async () => {
    const password = st.password ? (await ctx.dialog('protectDocument', { mode: 'unprotect' }))?.password : '';
    if (password == null) return;
    const r = await restrict(ctx, { stop: true, password });
    if (!r?.ok) ctx.toast('The password is not correct, so protection stays on.');
  };
  return (
    <div className="flex flex-col gap-3" data-protect="enforced">
      <Heading>Your permissions</Heading>
      <p>{SAYS[st.protection] ?? 'You can edit this document.'}</p>
      {st.formatting && <p>Formatting is limited to the styles allowed.</p>}
      {(st.ranges ?? []).length > 0 && (
        <>
          <p>{mine.length ? 'You can also edit these regions.' : 'These regions are open to other people.'}</p>
          <ul data-protect="regions" className="flex flex-col gap-1">
            {st.ranges.map((r, i) => (
              <li key={i} data-protect-region={r.editor} data-mine={r.mine || undefined}>
                <button type="button" className="w-full rounded-sm border px-2 py-1 text-left hover:bg-accent"
                  onClick={() => ctx.engine.exec('select.range', { anchor: r.start, focus: r.end })}>
                  Region {i + 1}: {r.everyone ? 'Everyone' : r.editor}{r.mine ? ' (you)' : ''}
                </button>
              </li>
            ))}
          </ul>
          {mine.length > 0 && <Button size="sm" variant="outline" data-protect="findNext" onClick={findNext}>Find Next Region I Can Edit</Button>}
        </>
      )}
      <Button size="sm" variant="outline" className="w-fit" data-protect="stop" onClick={stop}>Stop Protection</Button>
    </div>
  );
}

function Setup({ ctx, st }) {
  const [fmt, setFmt] = useState(false);
  const [editOn, setEditOn] = useState(false);
  const [edit, setEdit] = useState('readOnly');
  const [everyone, setEveryone] = useState(false);
  const exceptions = editOn && (edit === 'readOnly' || edit === 'comments');
  // Whether the selection lies inside an exception open to everyone, read again when the selection or the pane's state changes.
  useEffect(() => {
    let live = true;
    const read = () => Promise.resolve(ctx.engine.selection()).then((s) => {
      if (live && s) setEveryone((st.ranges ?? []).some((r) => r.everyone && before(r.start, s.anchor) && before(s.head, r.end)));
    }).catch(() => {});
    read();
    const off = ctx.engine.on?.('selection', read);
    return () => {
      live = false;
      off?.();
    };
  }, [ctx.engine, st]);
  const start = async () => {
    const r = await ctx.dialog('protectDocument', { mode: 'protect' });
    if (!r) return;
    await restrict(ctx, { mode: editOn ? edit : 'none', formatting: fmt, ...(r.password && { password: r.password }) });
  };
  return (
    <div className="flex flex-col gap-3">
      <Heading>1. Formatting restrictions</Heading>
      <div data-protect="limitFormatting">
        <Check label="Limit formatting to a selection of styles" checked={fmt} onChange={setFmt} />
      </div>
      <Heading>2. Editing restrictions</Heading>
      <div data-protect="allowEditing">
        <Check label="Allow only this type of editing in the document:" checked={editOn} onChange={setEditOn} />
      </div>
      <Pick aria-label="Type of editing" data-protect="editType" value={edit} options={EDIT_TYPES} onChange={setEdit} disabled={!editOn} />
      {exceptions && (
        <div className="flex flex-col gap-1.5">
          <div className="font-medium">Exceptions (optional)</div>
          <p className="text-muted-foreground">Select parts of the document and choose users who are allowed to freely edit them.</p>
          <div>Groups:</div>
          <div data-protect="everyone">
            <Check label="Everyone" checked={everyone} onChange={(v) => restrict(ctx, { exception: v ? 'add' : 'remove' })} />
          </div>
        </div>
      )}
      <Heading>3. Start enforcement</Heading>
      <p>Are you ready to apply these settings? (You can turn them off later)</p>
      <Button size="sm" className="w-fit" data-protect="start" disabled={!fmt && !editOn} onClick={start}>Yes, Start Enforcing Protection</Button>
    </div>
  );
}

/** The pane on a canvas draft: Setup before enforcement, Enforced while it is on (review.restrict's state). */
export function CanvasRestrictPane({ ctx }) {
  const st = useEngineValue(ctx.engine, 'review.restrictState');
  if (!st) return null;
  return <div className="p-3 text-xs" data-protect-pane="" data-canvas="">{st.protection ? <Enforced ctx={ctx} st={st} /> : <Setup ctx={ctx} st={st} />}</div>;
}
