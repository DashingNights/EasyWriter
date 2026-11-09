// Insert > Bookmark (probe/dialogs/bookmark.json): the name box over the list, Add, Delete, Go To, Sort by Name or Location,
// Hidden bookmarks, and Cancel, which reads Close once the dialog changed something.
import { useEffect, useReducer, useState } from 'react';
import { targetEditor } from '../../../tooling/registry.js';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { Check, ListPick, Radio } from '../../../tooling/kit/controls.jsx';
import { bookmarkNamed, listedBookmarks, validName } from './bookmarks.mjs';
import { addBookmark, deleteBookmark, goToPlace } from './edit.js';

/** The label above a control, Word's way, with its access key. */
export const Label = ({ htmlFor, label }) => (
  <label htmlFor={htmlFor} className="w-fit" {...accessProps(label)}><AccessText label={label} /></label>
);

/** Engine positions ({story, path, off}) in document order: the body first, then by path and offset. */
const byPlace = (a, b) => {
  const sa = a.at?.story === 'body' ? 0 : 1;
  const sb = b.at?.story === 'body' ? 0 : 1;
  if (sa !== sb) return sa - sb;
  const pa = a.at?.path ?? [];
  const pb = b.at?.path ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return pa.length - pb.length || (a.at?.off ?? 0) - (b.at?.off ?? 0);
};

/** On a canvas draft `engine` ({list, add, remove, go}) stands in for the editor: the bookmarks come from link.targets and the
 * buttons run the engine's commands. */
export function BookmarkDialog({ editor = targetEditor(), engine = null, onClose }) {
  const [, refresh] = useReducer((n) => n + 1, 0);
  const [marks, setMarks] = useState([]);
  const reload = () => engine?.list().then((l) => setMarks(l ?? []));
  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [sort, setSort] = useState('name');
  const [hidden, setHidden] = useState(false);
  const [changed, setChanged] = useState(false);
  const doc = editor?.state.doc;
  // Word opens on the bookmark around the selection, if there is one.
  const [name, setName] = useState(() => {
    const { from, to } = editor?.state.selection ?? {};
    return doc ? listedBookmarks(doc, { sort: 'location' }).find((b) => b.from <= from && to <= b.to)?.name ?? '' : '';
  });
  if (!editor && !engine) return null;
  const list = engine ? marks.filter((b) => hidden || !b.hidden).sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : byPlace)
    : listedBookmarks(doc, { hidden, sort });
  const existing = engine ? marks.find((b) => b.name.toLowerCase() === name.trim().toLowerCase()) ?? null : bookmarkNamed(doc, name);
  const did = () => {
    setChanged(true);
    refresh();
  };
  const add = async () => {
    if (engine) await engine.add(name.trim());
    else addBookmark(editor, name);
    onClose(name);
  };
  const remove = async () => {
    if (engine) {
      await engine.remove(existing.name);
      await reload();
    } else deleteBookmark(editor, existing.name);
    setName('');
    did();
  };
  const go = async () => {
    if (engine) await engine.go(existing.name);
    else goToPlace(editor, existing.name, { focus: false });
    did();
  };
  return (
    <WordDialog id="bookmark" title="Bookmark" size="sm" onClose={onClose} buttons={[
      { label: '&Delete', disabled: !existing, onClick: remove },
      { label: '&Go To', disabled: !existing, onClick: go },
      { label: changed ? 'Close' : 'Cancel', onClick: () => onClose(null) },
      { label: '&Add', primary: true, disabled: !validName(name), onClick: add },
    ]}>
      <Label htmlFor="fr-bookmark-name" label="&Bookmark name:" />
      <ListPick id="fr-bookmark-name" items={list.map((b) => [b.name, b.name])} value={existing?.name ?? null} text={name} onText={setName}
        onChange={() => {}} height="10rem" autoFocus />
      <div className="flex items-center gap-3">
        <span>Sort by:</span>
        <div className="[&_[role=radiogroup]]:flex-row [&_[role=radiogroup]]:gap-4">
          <Radio value={sort} options={[['name', '&Name'], ['location', '&Location']]} onChange={setSort} />
        </div>
      </div>
      <Check label="&Hidden bookmarks" checked={hidden} onChange={setHidden} />
    </WordDialog>
  );
}
