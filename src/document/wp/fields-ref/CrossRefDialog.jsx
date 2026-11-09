// Cross-reference (probe/dialogs/cross-reference.json; Insert > Cross-reference, References > Cross-reference): Reference type,
// Insert reference to, Insert as hyperlink, Include above/below, Separate numbers with, the For which list, and Insert, which
// wraps the target in a hidden _Ref bookmark (reusing one already there), writes REF, PAGEREF or NOTEREF and leaves the dialog
// open; Cancel then reads Close.
import { useEffect, useMemo, useReducer, useState } from 'react';
import { Input } from '@/components/ui/input';
import { targetEditor } from '../../../tooling/registry.js';
import { Check, Pick, rowClass } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { insertField } from '../../fields/engine.js';
import { Label } from './BookmarkDialog.jsx';
import { ensureRef } from './edit.js';
import { forWhichLabel, insertKinds, rangeFor, refCode, targetsOf, TYPES } from './xref.mjs';

/** Inserts a cross-reference to `item` (from targetsOf) of `type` as `kind` at the selection of `editor`. → the field code. */
export function insertCrossReference(editor, type, item, kind, options) {
  const name = type === 'bookmark' ? item.name : ensureRef(editor, rangeFor(item, kind));
  const note = type === 'footnote' || type === 'endnote';
  const code = refCode(note && kind === 'text' ? 'note' : kind, name, options);
  insertField(editor, code);
  return code;
}

// On a canvas draft (`engine`: {list(to), insert(args)}) the engine's insert.crossReference lists and writes the targets it knows:
// headings, bookmarks and captions, shown as text, page number, number or above/below (numbered items and notes are gap G48).
const ENGINE_TO = { heading: 'heading', bookmark: 'bookmark', Equation: 'equation', Figure: 'figure', Table: 'table' };
const ENGINE_SHOW = { text: 'text', page: 'page', number: 'number', position: 'aboveBelow' };

export function CrossRefDialog({ editor = targetEditor(), engine = null, onClose }) {
  const [, refresh] = useReducer((n) => n + 1, 0);
  const [type, setTypeId] = useState(engine ? 'heading' : 'numbered');
  const [kind, setKind] = useState(engine ? 'text' : 'number');
  const [listed, setListed] = useState([]);
  useEffect(() => {
    if (!engine) return;
    setListed([]);
    if (ENGINE_TO[type]) engine.list(ENGINE_TO[type]).then((l) => setListed((l ?? []).map((t, i) => ({ id: i, label: t, target: t }))));
  }, [engine, type]);
  const [hyperlink, setHyperlink] = useState(true);
  const [aboveBelow, setAboveBelow] = useState(false);
  const [separate, setSeparate] = useState(false);
  const [separator, setSeparator] = useState(' ');
  const [pick, setPick] = useState(0);
  const [changed, setChanged] = useState(false);
  const doc = editor?.state.doc;
  const items = useMemo(() => (engine ? listed : doc ? targetsOf(doc, type) : []), [doc, type, engine, listed]);
  if (!editor && !engine) return null;
  const kinds = insertKinds(type);
  const setType = (t) => {
    setTypeId(t);
    setKind(insertKinds(t)[t === 'numbered' ? 1 : 0][0]);
    setPick(0);
  };
  const item = items[pick] ?? null;
  const full = kind === 'numberFull';
  const insert = async () => {
    if (!item) return;
    if (engine) {
      if (!ENGINE_SHOW[kind]) return;
      if (await engine.insert({ to: ENGINE_TO[type], target: item.target, show: ENGINE_SHOW[kind] })) setChanged(true);
      return;
    }
    insertCrossReference(editor, type, item, kind, { hyperlink, aboveBelow, separator: full && separate ? separator : null });
    setChanged(true);
    refresh();
  };
  return (
    <WordDialog id="crossReference" title="Cross-reference" size="md" onClose={onClose} buttons={[
      { label: changed ? 'Close' : 'Cancel', onClick: () => onClose(changed || null) },
      { label: '&Insert', primary: true, disabled: !item || (engine && !ENGINE_SHOW[kind]), onClick: insert },
    ]}>
      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="fr-xref-type" label="Reference &type:" />
          <Pick id="fr-xref-type" value={type} options={TYPES} onChange={setType} />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="fr-xref-kind" label="Inse&rt reference to:" />
          <Pick id="fr-xref-kind" value={kind} options={kinds} onChange={setKind} />
        </div>
      </div>
      <Check label="Insert as &hyperlink" checked={hyperlink} onChange={setHyperlink} />
      <div className="flex items-center gap-6">
        <Check label="I&nclude above/below" checked={aboveBelow} disabled={kind === 'position'} onChange={setAboveBelow} />
        <div className="flex items-center gap-2">
          <Check label="&Separate numbers with" checked={separate} disabled={!full} onChange={setSeparate} />
          <Input size="xs" aria-label="Separator character" className="w-12" value={separator} disabled={!full || !separate} onChange={(e) => setSeparator(e.target.value)} />
        </div>
      </div>
      <Label htmlFor="fr-xref-list" label={forWhichLabel(type)} />
      <div id="fr-xref-list" role="listbox" tabIndex={0} className="h-40 overflow-auto rounded-md border border-input bg-transparent dark:bg-input/30 text-xs"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          setPick((i) => Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1))));
        }}>
        {items.map((x, i) => (
          <div key={x.id} role="option" aria-selected={i === pick} data-index={i} onClick={() => setPick(i)} onDoubleClick={insert}
            className={`cursor-default truncate px-1.5 py-0.5 whitespace-pre ${rowClass(i === pick)}`}>{x.label}</div>
        ))}
      </div>
    </WordDialog>
  );
}
