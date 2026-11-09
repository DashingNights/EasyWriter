// File > Info > Version History (docs/plans/word plan.md §3 compare): the pane 'versionHistory' listing the current version, the local
// versions from the draft's history file (versions.mjs) and the GitHub backup's versions (api.word.versions, plan.md §1.17). Open
// shows a version read-only with Compare (that version as Original, the current doc as Revised, in a new document) and Restore.
// On a canvas draft (engine-canvas-read, G37) the current version comes from its session and a backup version, a canvas record or a
// DOM one, is read through the engine's .docx (files.js docOfDraft); Restore puts it in the engine as one undo step
// (`file.restoreVersion`) and Compare runs in the engine (run.js compareSides). Its local versions come from the engine's undo
// history (file.localVersions, engine-gaps-rest): each is the draft before a run of edits, named by them, with no time, since
// the engine's steps keep none.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { confirmDialog, toast } from '../../../app/actions.js';
import { getState, useStore } from '../../../app/store.js';
import { isCanvas, modelBytes } from '../../../engine/model/form.mjs';
import { FORMATS } from '../../../formats.mjs';
import { strip } from '../../../suggest/core.mjs';
import { base64, bytesOf } from '../../../tooling/base64.mjs';
import { useEngineValue } from '../../../tooling/engine-value.js';
import { docOfDraft, docxOfDoc, readDocx } from '../../docx/files.js';
import { DEFAULTS, refusal } from './compare.mjs';
import { compareSides, setDoc, sideOf, userName } from './run.js';
import { Sheet } from './Sheet.jsx';
import { docAt, localVersions } from './versions.mjs';

// The backup's endpoints; a harness case stubs them through window.__wordTest (plan.md §1.16), since the backup is real data.
const backup = () => ({ versions: globalThis.__wordTest?.versions ?? window.api.word.versions, versionAt: globalThis.__wordTest?.versionAt ?? window.api.word.versionAt });

const when = (at) => (at ? new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown time');

function Row({ id, title, sub, onOpen }) {
  return (
    <li data-version={id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent">
      <div className="min-w-0 flex-1"><div className="truncate">{title}</div>{sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}</div>
      <Button size="xs" variant="outline" onClick={onOpen}>Open</Button>
    </li>
  );
}

/** The pane. */
export function HistoryPane({ ctx }) {
  const id = useStore((s) => s.draft?.id);
  const canvas = useStore((s) => isCanvas(s.draft));
  // A canvas draft's versions follow its undo history while the pane is open (engine-fixes-edit): read again after each edit.
  const engineLocal = useEngineValue(canvas ? ctx.engine : null, 'file.localVersions');
  const [file, setFile] = useState(null);
  const [domLocal, setLocal] = useState(null);
  const local = canvas ? engineLocal?.versions ?? null : domLocal;
  const [remote, setRemote] = useState(null);
  const [open, setOpen] = useState(null); // {id, title, sub, doc, record (the version's draft record, when it is one)}
  useEffect(() => {
    setOpen(null);
    setLocal(null);
    setRemote(null);
    if (!id) return;
    let live = true;
    if (!isCanvas(getState().draft)) window.api.drafts.loadHistory(id).catch(() => null).then((f) => live && (setFile(f), setLocal(localVersions(f))));
    Promise.resolve(backup().versions(id)).catch(() => []).then((v) => live && setRemote(v ?? []));
    return () => { live = false; };
  }, [id]);
  const ed = ctx.ed;
  const session = ed ? null : ctx.engine; // a canvas draft's
  if ((!ed && !session) || !id) return <p className="p-3 text-muted-foreground">Open a saved Document to see its versions.</p>;
  const schema = ed?.schema ?? getState().editor?.schema; // the hidden DOM editor's under a canvas draft
  const current = async () => (ed ? ed.getJSON() : readDocx(await session.save('docx'), 'Current version'));

  const openLocal = async (v) => {
    if (session) {
      // A canvas draft's version: the engine's document before those steps, previewed from its .docx, restored from its own form.
      const r = await session.query('file.localVersion', { k: v.k });
      if (!r?.value) return toast('This version could not be read from the undo history.', true);
      setOpen({ id: `local:${v.k}`, title: v.base ? 'Before the edits' : `Before ${v.label}`, sub: '', doc: await readDocx(bytesOf(r.value.docx), 'Local version'),
        bytes: { bytes: bytesOf(r.value.engine), kind: 'engine' } });
      return;
    }
    try {
      setOpen({ id: `local:${v.k}`, title: v.base ? 'Before the edits' : 'Local version', sub: when(v.at), doc: docAt(file, schema, v.k).toJSON() });
    } catch {
      toast('This version could not be rebuilt from the draft history.', true);
    }
  };
  const openRemote = async (v) => {
    const draft = await Promise.resolve(backup().versionAt(id, v.ref)).catch(() => null);
    const why = refusal(draft, FORMATS.document.version);
    if (why) return toast(why, true);
    const doc = await docOfDraft(draft);
    if (doc) setOpen({ id: `backup:${v.ref}`, title: v.message?.split('\n')[0] || 'Backup version', sub: when(v.date), doc, record: draft });
  };
  const openCurrent = async () => {
    try {
      setOpen({ id: 'current', title: 'Current version', sub: '', doc: await current() });
    } catch (e) {
      toast(`Could not read the current version: ${e.message || e}`, true);
    }
  };
  // The open version's bytes for the engine: a canvas record's model, else its doc as .docx.
  const versionBytes = async () => open.bytes ?? (isCanvas(open.record) ? { bytes: modelBytes(open.record.engine), kind: 'engine' }
    : { bytes: (await docxOfDoc(strip(open.doc), open.title)).bytes, kind: 'docx' });
  const restore = async () => {
    const ok = await confirmDialog({ title: 'Restore this version?', description: 'The draft goes back to this version. Undo brings the current text back.',
      confirmText: 'Restore', destructive: true });
    if (!ok) return;
    try {
      if (ed) setDoc(ed, strip(open.doc));
      else {
        const { bytes, kind } = await versionBytes();
        const r = await session.exec('file.restoreVersion', { data: base64(bytes), kind });
        if (!r?.ok) throw new Error(r?.error ?? 'the engine refused it');
      }
      setOpen(null);
    } catch (e) {
      toast(`Could not restore this version: ${e.message || e}`, true);
    }
  };
  // The version as the original (a backup holds the draft's own id, which must not read the open draft) and the draft now as the
  // revised: in the DOM editor from the doc read already, in the engine from the record's bytes.
  const compare = () => compareSides({ a: sideOf(ed || !open.record ? { doc: open.doc } : { ...open.record, id: null }, open.title),
    b: sideOf(ed ? { ...getState().draft, doc: ed.getJSON() } : getState().draft, 'Current version'), label: userName(), opts: DEFAULTS, kind: 'compare' });

  if (open) {
    return (
      <div data-version-open={open.id} className="flex h-full flex-col">
        <div className="px-3 pb-1"><div>{open.title}</div><div className="text-xs text-muted-foreground">{open.sub}</div></div>
        <Sheet doc={open.doc} schema={schema} />
        <div className="flex gap-1.5 p-2">
          <Button size="sm" variant="outline" data-version-action="back" onClick={() => setOpen(null)}>Back</Button>
          <span className="flex-1" />
          <Button size="sm" variant="outline" data-version-action="compare" onClick={compare}>Compare</Button>
          <Button size="sm" data-version-action="restore" onClick={restore}>Restore</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col pb-2">
      <ul>
        <Row id="current" title="Current version" sub="What the draft holds now" onOpen={openCurrent} />
      </ul>
      <h3 className="px-3 pt-2 pb-1 text-xs text-muted-foreground">On this device</h3>
      {local == null ? <p className="px-3 text-muted-foreground">Loading...</p>
        : local.length ? <ul>{local.map((v) => <Row key={v.k} id={`local:${v.k}`} title={v.base ? 'Before the edits' : v.label ? `Before ${v.label}` : when(v.at)}
          sub={v.at ? (v.base ? when(v.at) : null) : v.base && v.label ? `Before ${v.label}` : null} onOpen={() => openLocal(v)} />)}</ul>
          : <p className="px-3 text-muted-foreground">No earlier versions since the draft's undo history began.</p>}
      <h3 className="px-3 pt-2 pb-1 text-xs text-muted-foreground">In the GitHub backup</h3>
      {remote == null ? <p className="px-3 text-muted-foreground">Loading...</p>
        : remote.length ? <ul>{remote.map((v) => <Row key={v.ref} id={`backup:${v.ref}`} title={when(v.date)} sub={v.message?.split('\n')[0]} onOpen={() => openRemote(v)} />)}</ul>
          : <p className="px-3 text-muted-foreground">No backup versions. Turn on the GitHub backup in Settings to keep them.</p>}
    </div>
  );
}
