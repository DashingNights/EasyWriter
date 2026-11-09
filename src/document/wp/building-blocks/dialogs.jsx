// Create New Building Block (also Modify Building Block and every Save Selection to ... Gallery) and the Building Blocks Organizer
// (docs/plans/word briefs/building-blocks.md; labels from probe/dialogs/create-new-building-block.json and
// building-blocks-organizer.json). Deviations, recorded: Save in offers one place, "Building Blocks" (every Document on this
// computer; Word's templates do not exist here), and the Organizer closes with the kit's OK labelled Close plus Cancel.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { Input } from '@/components/ui/input';
import { confirmDialog, openDialog } from '../../../app/actions.js';
import { getState } from '../../../app/store.js';
import { BLOCK_GALLERIES } from '../../ribbon/spec.mjs';
import { ctxOf, galleryOf } from '../../../tooling/registry.js';
import { Pick, rowClass, Row, TextArea } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { CATEGORY, defaultInsert, firstWords, flatText, GALLERIES, INSERTS, sortRows } from './blocks.mjs';
import { dropFromGlossary, FILE_GALLERIES, patchGlossary } from './doc-blocks.mjs';
import { insertEntry, selectionBlock } from './insert.js';
import { allEntries, deleteEntry, newId, onStore, saveEntry, storeVersion, writeGlossary } from './store.js';

const NEW = '\u0000new'; // the Create New Category... item
const useEntries = () => {
  useSyncExternalStore(onStore, storeVersion);
  return allEntries(ctxOf().ed?.state.doc);
};
/** The Template column's name for the document's own blocks (Word shows the document there). */
const docName = () => getState().draft?.title || 'Document';
const glossaryOf = (ed) => ed?.state.doc.attrs.settings?.glossary ?? [];

/** Create New Building Block. Props: `gallery` (preset), or `entry` to modify (Edit Properties...). It saves on OK and resolves
 * with the saved entry; without a fitting selection OK explains why. On a canvas draft `engine` ({text: the selected text,
 * save(values) → whether it saved}) saves into the document's own building blocks, the one place a canvas draft saves to. */
export function CreateBuildingBlock({ gallery = 'Quick Parts', entry = null, engine = null, onClose }) {
  // On a canvas draft `engine.whole`: the gallery saves what the caret is in (a table of contents, a bibliography) or the watermark.
  const [picked] = useState(() => (entry ? null : engine ? (engine.text || engine.whole ? { text: engine.text } : null) : selectionBlock(ctxOf(), gallery)));
  const all = useEntries();
  const [v, setV] = useState(() => entry ?? {
    name: firstWords(picked?.text), gallery, category: CATEGORY, description: '', insert: defaultInsert(gallery),
  });
  const [extra, setExtra] = useState([]);
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x }));
  const categories = [...new Set([CATEGORY, ...all.filter((e) => e.gallery === v.gallery).map((e) => e.category), ...extra, v.category])];
  const pickCategory = async (c) => {
    if (c !== NEW) return set('category')(c);
    const name = await openDialog('createNewCategory');
    if (name) {
      setExtra((x) => [...x, name]);
      set('category')(name);
    }
  };
  const validate = () => {
    if (!v.name?.trim()) return 'Type a name for the building block.';
    if (!entry && !picked) return 'Select what to save first.';
    return null;
  };
  const save = async () => {
    if (engine) return (await engine.save({ ...v, name: v.name.trim() })) ? { ...v, name: v.name.trim() } : null;
    const next = entry ? { ...entry, ...v, name: v.name.trim() }
      : { id: newId(), ...v, name: v.name.trim(), content: picked.content, ...(picked.data && { data: picked.data }), created: new Date().toISOString() };
    if (entry && !(await confirmDialog({ title: `Redefine the building block ${next.name}?`, confirmText: 'Redefine' }))) return null;
    if (entry?.source !== 'doc') return saveEntry(next);
    // A block of the document changes in the document (one undo step).
    const ed = ctxOf().ed;
    return writeGlossary(ed, patchGlossary(glossaryOf(ed), entry, next)) ? next : null;
  };
  const box = 'h-6 w-full text-xs';
  return (
    <WordDialog title={entry ? 'Modify Building Block' : 'Create New Building Block'} size="sm" validate={validate}
      onClose={(r) => (r ? save().then(onClose) : onClose(null))}>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        <Row label="&Name:" htmlFor="bb-name" />
        <Input id="bb-name" size="xs" className={box} autoFocus value={v.name} onChange={(e) => set('name')(e.target.value)} />
        <Row label="&Gallery:" htmlFor="bb-gallery" />
        <Pick id="bb-gallery" className={box} value={v.gallery} options={GALLERIES.map((g) => [g, g])} onChange={set('gallery')} />
        <Row label="&Category:" htmlFor="bb-category" />
        <Pick id="bb-category" className={box} value={v.category} options={[...categories.map((c) => [c, c]), [NEW, 'Create New Category...']]} onChange={pickCategory} />
        <Row label="&Description:" htmlFor="bb-desc" />
        <TextArea id="bb-desc" rows={3} value={v.description} onChange={(e) => set('description')(e.target.value)}
          className="resize-none" />
        <Row label="&Save in:" htmlFor="bb-save" />
        <Pick id="bb-save" className={box} value="blocks" options={[['blocks', engine || entry?.source === 'doc' ? docName() : 'Building Blocks']]} onChange={() => {}} />
        <Row label="&Options:" htmlFor="bb-insert" />
        <Pick id="bb-insert" className={box} value={v.insert} options={INSERTS} onChange={set('insert')} />
      </div>
    </WordDialog>
  );
}

/** Create New Category: a name → the name, or null. */
export function CreateNewCategory({ onClose }) {
  const [name, setName] = useState('');
  return (
    <WordDialog title="Create New Category" size="sm" onClose={onClose} result={() => name.trim()}
      validate={() => (name.trim() ? null : 'Type a name for the category.')}>
      <Row label="&Name:" htmlFor="bb-cat"><Input id="bb-cat" size="xs" className="h-6 text-xs" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Row>
    </WordDialog>
  );
}

const COLUMNS = [['name', 'Name'], ['gallery', 'Gallery'], ['category', 'Category'], ['template', 'Template']];

/** The Organizer's rows: the document's and the user's blocks, then the built-in items the galleries' providers give. */
function rowsOf(list, ctx) {
  const rows = list.map((e) => ({ key: e.id, name: e.name, gallery: e.gallery, category: e.category, template: e.source === 'doc' ? docName() : 'Building Blocks', entry: e }));
  for (const [gallery, id] of Object.entries(BLOCK_GALLERIES)) {
    for (const it of galleryOf(id, ctx)) {
      if (it.id.startsWith('bb:') || it.id.startsWith('eb:')) continue; // the blocks themselves are listed above
      rows.push({ key: `${id}:${it.id}`, name: it.label, gallery, category: it.group ?? 'Built-In', template: 'Built-In Building Blocks', item: it, galleryId: id });
    }
  }
  return rows;
}

/** The document's building blocks on a canvas draft (the engine's insert.buildingBlocks) as Organizer rows. */
const engineRows = (blocks) => blocks.map((b) => ({ key: `eb:${b.gallery}:${b.name}`, name: b.name, gallery: FILE_GALLERIES[b.gallery] ?? b.gallery,
  category: b.category, template: docName(), block: b }));

/** Building Blocks Organizer: the list (sortable by each column), a preview, Edit Properties..., Delete, Insert. On a canvas draft
 * `engine` ({list, insert(name, gallery), remove(name, gallery)}) lists the document's blocks from the engine; the user's own
 * blocks are the DOM editor's until the canvas can insert them. */
export function BuildingBlocksOrganizer({ engine = null, onClose }) {
  const stored = useEntries();
  const [blocks, setBlocks] = useState([]);
  const reload = () => engine?.list().then((l) => setBlocks(l ?? []));
  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [sort, setSort] = useState({ key: 'gallery', dir: 1 });
  const [sel, setSel] = useState(null);
  const rows = sortRows(engine ? [...engineRows(blocks), ...rowsOf([], ctxOf())] : rowsOf(stored, ctxOf()), sort.key, sort.dir);
  const row = rows.find((r) => r.key === sel) ?? null;
  const insert = () => {
    const ctx = ctxOf();
    if (row.block) engine.insert(row.block.name, row.block.gallery);
    else if (row.entry) insertEntry(ctx, row.entry);
    else if (row.item.run) row.item.run(ctx);
    else ctx.run(row.galleryId, row.item.id);
    onClose(true);
  };
  const remove = async () => {
    if (row.block) {
      if (await confirmDialog({ title: `Delete the building block ${row.name}?`, description: 'It goes from this document.', confirmText: 'Delete', destructive: true })) {
        await engine.remove(row.block.name, row.block.gallery);
        await reload();
        setSel(null);
      }
      return;
    }
    const own = row.entry.source === 'doc';
    const description = own ? 'It goes from this document.' : 'It goes from every Document on this computer.';
    if (await confirmDialog({ title: `Delete the building block ${row.name}?`, description, confirmText: 'Delete', destructive: true })) {
      if (own) writeGlossary(ctxOf().ed, dropFromGlossary(glossaryOf(ctxOf().ed), row.entry));
      else await deleteEntry(row.entry.id);
      setSel(null);
    }
  };
  const left = [
    { label: '&Edit Properties...', disabled: !row?.entry, onClick: () => openDialog('createNewBuildingBlock', { entry: row.entry }) },
    { label: '&Delete', disabled: !row?.entry && !row?.block, onClick: remove },
    { label: '&Insert', disabled: !row, onClick: insert },
  ];
  return (
    <WordDialog title="Building Blocks Organizer" size="lg" okText="Close" left={left} onClose={onClose}>
      <div className="flex min-h-0 gap-3">
        <div className="flex min-w-0 flex-[1.3] flex-col gap-1">
          <span>Building blocks:</span>
          <div data-bb-list="" className="h-80 overflow-auto rounded-md border border-input bg-background text-xs">
            <table className="w-full table-fixed border-collapse">
              <thead className="sticky top-0 bg-muted">
                <tr>{COLUMNS.map(([k, label]) => (
                  <th key={k} className="p-0 text-left font-normal">
                    <button type="button" className="w-full truncate px-1.5 py-0.5 text-left hover:bg-accent" aria-sort={sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined}
                      onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : 1 }))}>{label}</button>
                  </th>
                ))}</tr>
              </thead>
              <tbody>{rows.map((r) => (
                <tr key={r.key} data-bb-row={r.entry?.id ?? r.key} aria-selected={r.key === sel} onClick={() => setSel(r.key)}
                  className={cn('cursor-default', rowClass(r.key === sel))}>
                  {COLUMNS.map(([k]) => <td key={k} className="truncate px-1.5 py-0.5">{r[k]}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="h-72 overflow-hidden border border-neutral-300 bg-white p-3 text-xs text-black">
            {row ? (row.block ? row.name : row.entry ? flatText(row.entry.content) : row.item.preview ?? row.item.label) : 'Click a building block to see its preview'}
          </div>
          <div data-bb-preview-name="" className="truncate font-medium">{row?.name ?? ''}</div>
          <div className="line-clamp-3 text-xs text-muted-foreground">{row?.entry?.description ?? row?.block?.description ?? ''}</div>
        </div>
      </div>
    </WordDialog>
  );
}
