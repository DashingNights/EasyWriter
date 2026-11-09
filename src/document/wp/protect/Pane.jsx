// The Restrict Editing pane (probe/dialogs/restrict-editing-pane.json): before enforcement its three numbered steps, formatting
// restrictions, editing restrictions with exceptions, and Start Enforcing; while enforced what may be done here, the regions the
// user may edit and Stop Protection. The choices before enforcement live in the pane until Start Enforcing writes them.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { registered } from '../../../tooling/registry.js';
import { Check, Pick } from '../../../tooling/kit/controls.jsx';
import { sectionsOf } from '../../model/sections.mjs';
import { CanvasRestrictPane } from './CanvasPane.jsx';
import {
  EDIT_TYPES, enforced, findNextRegion, myRegions, namesIn, permitted, protectionOf, sessionOf, setPermission, setSession, startEnforcing,
  stopProtection,
} from './act.js';

const Heading = ({ children }) => <div className="border-b pb-0.5 font-medium">{children}</div>;
const Link = ({ children, ...props }) => (
  <button type="button" className="w-fit text-primary underline-offset-2 hover:underline disabled:opacity-50" {...props}>{children}</button>
);

const SAYS = {
  readOnly: 'You can read this document but not change it.',
  comments: 'You can only add comments to this document.',
  trackedChanges: 'You can edit this document, and every change is tracked.',
  forms: 'You can only fill in the forms in this document.',
};

function Enforced({ ctx }) {
  const ed = ctx.ed;
  const p = protectionOf(ed);
  const regions = myRegions(ed);
  const { highlight } = sessionOf(ed);
  const showAll = () => {
    setSession(ed, { highlight: true });
    if (registered().includes('x.selection.multi')) ctx.run('x.selection.multi', regions);
    else findNextRegion(ed); // until editing-keys' multiple selection lands: shade every region and select the first
  };
  const stop = () => stopProtection(ed, async () => (await ctx.dialog('protectDocument', { mode: 'unprotect' }))?.password ?? null)
    .then((ok) => !ok && ctx.toast('The password is not correct, so protection stays on.'));
  return (
    <div className="flex flex-col gap-3" data-protect="enforced">
      <Heading>Your permissions</Heading>
      <p>{SAYS[p.edit] ?? 'You can edit this document.'}</p>
      {p.formatting && <p>Formatting is limited to the styles allowed.</p>}
      {regions.length > 0 && (p.edit === 'readOnly' || p.edit === 'comments') && (
        <>
          <p>You can also edit the regions shaded for you.</p>
          <Button size="sm" variant="outline" data-protect="findNext" onClick={() => findNextRegion(ed)}>Find Next Region I Can Edit</Button>
          <Button size="sm" variant="outline" data-protect="showAll" onClick={showAll}>Show All Regions I Can Edit</Button>
          <div data-protect="highlight">
            <Check label="Highlight the regions I can edit" checked={highlight} onChange={(v) => setSession(ed, { highlight: v })} />
          </div>
        </>
      )}
      <Button size="sm" variant="outline" className="w-fit" data-protect="stop" onClick={stop}>Stop Protection</Button>
    </div>
  );
}

function Setup({ ctx }) {
  const ed = ctx.ed;
  const [fmt, setFmt] = useState(false);
  const [fmtOpts, setFmtOpts] = useState(null);
  const [editOn, setEditOn] = useState(false);
  const [edit, setEdit] = useState('readOnly');
  const [users, setUsers] = useState([]);
  const [sections, setSections] = useState(null);
  const names = [...new Set([...namesIn(ed), ...users])];
  const exceptions = editOn && (edit === 'readOnly' || edit === 'comments');
  const settings = async () => {
    const list = ed.state.doc.attrs.styles?.list ?? {};
    const styles = Object.entries(list).filter(([, s]) => s?.type !== 'numbering').map(([id, s]) => [id, s?.name ?? id]);
    const value = fmtOpts ?? { locked: Object.keys(list).filter((id) => list[id]?.locked) };
    const r = await ctx.dialog('formattingRestrictions', { styles, value });
    if (r) setFmtOpts(r);
  };
  const more = async () => {
    const r = await ctx.dialog('addUsers');
    if (r?.length) setUsers((u) => [...u, ...r]);
  };
  const pickSections = async () => {
    const r = await ctx.dialog('sectionProtection', { count: sectionsOf(ed.state.doc).length, value: sections });
    if (r) setSections(r);
  };
  const start = async () => {
    const r = await ctx.dialog('protectDocument', { mode: 'protect' });
    if (!r) return;
    await startEnforcing(ed, { edit: editOn ? edit : null, formatting: fmt, fmt: fmtOpts, sections }, r.password);
  };
  const person = (name, label = name) => (
    <div key={name} data-protect={name === 'everyone' ? 'everyone' : `user:${name}`}>
      <Check label={label} checked={permitted(ed, name)} onChange={(v) => setPermission(ed, name, v)} />
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <Heading>1. Formatting restrictions</Heading>
      <div data-protect="limitFormatting">
        <Check label="Limit formatting to a selection of styles" checked={fmt} onChange={setFmt} />
      </div>
      <Link data-protect="settings" onClick={settings}>Settings...</Link>
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
          {person('everyone', 'Everyone')}
          {names.length > 0 && <div>Individuals:</div>}
          {names.map((n) => person(n))}
          <Link data-protect="moreUsers" onClick={more}>More users...</Link>
        </div>
      )}
      {editOn && edit === 'forms' && <Link data-protect="sections" onClick={pickSections}>Select sections...</Link>}
      <Heading>3. Start enforcement</Heading>
      <p>Are you ready to apply these settings? (You can turn them off later)</p>
      <Button size="sm" className="w-fit" data-protect="start" disabled={!fmt && !editOn} onClick={start}>Yes, Start Enforcing Protection</Button>
    </div>
  );
}

/** The pane: Setup before enforcement, Enforced while it is on. */
export function RestrictEditingPane({ ctx }) {
  if (ctx.engine) return <CanvasRestrictPane ctx={ctx} />;
  if (!ctx.ed) return null;
  return <div className="p-3 text-xs" data-protect-pane="">{enforced(ctx.ed) ? <Enforced ctx={ctx} /> : <Setup ctx={ctx} />}</div>;
}
