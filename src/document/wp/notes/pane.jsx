// The Notes pane (docs/plans/word/plan.md §1.7 panes; briefs/notes.md): Draft view has no pages, so Show Notes opens this pane,
// which lists every note of a kind with its text, edits one in place on a click, and edits the separators, the continuation
// separator and the continuation notice through its menu. Word's pane sits at the bottom of the window; this one docks right.
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { deepPatch } from '../../../office.mjs';
import { mountStory, writeBack } from '../../word/story.js';
import { Pick } from '../../../tooling/kit/controls.jsx';
import { noteBox } from './draw.js';
import { closeNote, openNote, openOf } from './edit.js';
import { effectivePr, notesOf } from './model.mjs';
import { labelsFor } from './view.js';

const SHOW = [['footnote', 'All Footnotes'], ['footnote:separator', 'Footnote Separator'],
  ['footnote:continuationSeparator', 'Footnote Continuation Separator'], ['footnote:continuationNotice', 'Footnote Continuation Notice'],
  ['endnote', 'All Endnotes'], ['endnote:separator', 'Endnote Separator'], ['endnote:continuationSeparator', 'Endnote Continuation Separator'],
  ['endnote:continuationNotice', 'Endnote Continuation Notice']];

/** Re-renders on every change of `ed`'s doc and whenever a note opens or closes for editing. */
function useDoc(ed) {
  const [, bump] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    if (!ed) return undefined;
    const on = ({ transaction }) => transaction.docChanged && bump();
    const dom = ed.view.dom;
    ed.on('transaction', on);
    dom.addEventListener('w-notes-session', bump);
    return () => {
      ed.off('transaction', on);
      dom.removeEventListener('w-notes-session', bump);
    };
  }, [ed]);
  return ed?.state.doc ?? null;
}

/** One note in the list: its drawing, or its editor while it is the open note. */
function NoteRow({ ed, note, label, open }) {
  const ref = useRef(null);
  const { id, kind, content } = note.node.attrs;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const view = ed.view;
    el.replaceChildren(noteBox({ schema: view.state.schema, doc: view.state.doc, width: el.clientWidth, ownerDocument: el.ownerDocument }, { id, kind, label, content }));
  }, [ed, id, kind, label, content, open]);
  return (
    <div ref={ref} data-note-row={id} className="cursor-text rounded-sm border border-transparent px-2 py-1 text-xs hover:border-border"
      onMouseDown={(e) => {
        if (open || e.button !== 0) return;
        e.preventDefault();
        ref.current.replaceChildren();
        openNote(ed, id, { host: ref.current });
      }} />
  );
}

/** A separator part of `kind` edited in a story editor; its blocks go into the document's footnotePr or endnotePr sep. */
function SepEditor({ ed, kind, which }) {
  const ref = useRef(null);
  const key = `${kind}Pr`;
  const sep = effectivePr(kind, ed.state.doc.attrs.settings, null).sep;
  useEffect(() => {
    const story = mountStory({
      kind,
      host: ref.current,
      content: sep?.[which] ?? [{ type: 'paragraph' }],
      onChange: ({ content, attrs }) => writeBack(ed, attrs, (tr) => {
        const settings = tr.doc.attrs.settings ?? {};
        const now = settings[key] ?? {};
        tr.setDocAttribute('settings', deepPatch(settings, { [key]: { ...now, sep: { ...(now.sep ?? {}), [which]: content } } }));
      }),
    });
    return () => story.destroy();
  }, [ed, kind, which]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = () => ed.chain().setDocSettings({ [key]: { sep: { [which]: null } } }).run();
  return (
    <div className="flex flex-col gap-2">
      <div ref={ref} data-note-sep-edit={which} className="min-h-12 rounded-sm border px-2 py-1 text-xs" />
      <p className="text-xs text-muted-foreground">{sep?.[which] ? 'Your own text replaces the default here.' : 'Shows the default until you type here.'}</p>
      <Button type="button" variant="outline" size="sm" className="w-fit" disabled={!sep?.[which]} onClick={reset}>Reset</Button>
    </div>
  );
}

/** The Notes pane body. props.id opens that note's editor; props.show picks the list ('footnote', 'endnote' or a separator). */
export function NotesPane({ ctx, props }) {
  const ed = ctx.ed;
  const doc = useDoc(ed);
  const first = props?.id && doc ? notesOf(doc).find((n) => n.node.attrs.id === props.id)?.node.attrs.kind : null;
  const [show, setShow] = useState(props?.show ?? first ?? (doc && notesOf(doc).some((n) => n.node.attrs.kind === 'footnote') ? 'footnote' : 'endnote'));
  const list = useRef(null);
  useEffect(() => {
    if (!props?.id || !ed) return;
    const row = list.current?.querySelector(`[data-note-row="${CSS.escape(props.id)}"]`);
    if (row) {
      row.replaceChildren();
      openNote(ed, props.id, { host: row });
    }
  }, [props?.id, ed]);
  useEffect(() => () => ed && openOf(ed)?.host.closest('[data-note-row]') && closeNote(ed), [ed]);
  if (!ed || !doc) return <p className="p-3 text-xs text-muted-foreground">Open a document to see its notes.</p>;
  const [kind, which] = show.split(':');
  const labels = labelsFor(ed.view);
  const open = openOf(ed)?.id;
  const notes = notesOf(doc).filter((n) => n.node.attrs.kind === kind);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2" data-notes-pane="">
      <Pick aria-label="Notes" value={show} options={SHOW} onChange={(v) => { closeNote(ed); setShow(v); }} />
      {which ? <SepEditor key={show} ed={ed} kind={kind} which={which} /> : (
        <div ref={list} className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
          {notes.length ? notes.map((n) => (
            <NoteRow key={n.node.attrs.id} ed={ed} note={n} label={labels.get(n.pos)?.label ?? ''} open={open === n.node.attrs.id} />
          )) : <p className="text-xs text-muted-foreground">{kind === 'footnote' ? 'No footnotes yet.' : 'No endnotes yet.'}</p>}
        </div>
      )}
    </div>
  );
}
