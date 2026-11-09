// The Document Inspector (dialog documentInspector; docs/plans/word/briefs/backstage.md): Word's check boxes, then per category
// what was found with Remove All. Each Remove All asks first, then removes in one transaction that keeps every doc attr it does
// not clear, so one Undo brings it back. Tracked changes go through the tracking package's Accept All Changes.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { closeHistory } from '@tiptap/pm/history';
import { confirmDialog } from '../../../app/actions.js';
import { Check } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { commandOf, ctxOf, run } from '../../../tooling/registry.js';
import { CATEGORIES, describe, ENGINE_REMOVE, engineFindings, foundIn, removeCategory } from './inspect.mjs';
import { ACCEPT_ALL, findings } from './pages.jsx';

/** Replaces `editor`'s doc with `json` in one transaction, its own undo step: the content, and each doc attr that changed. */
export function replaceDoc(editor, json) {
  const { state, view } = editor;
  const next = state.schema.nodeFromJSON(json);
  const tr = closeHistory(state.tr).replaceWith(0, state.doc.content.size, next.content);
  for (const [k, v] of Object.entries(next.attrs)) if (JSON.stringify(v) !== JSON.stringify(state.doc.attrs[k])) tr.setDocAttribute(k, v);
  view.dispatch(tr);
}

export function Inspector({ onClose }) {
  const [on, setOn] = useState(() => Object.fromEntries(CATEGORIES.map((c) => [c.id, true])));
  const [found, setFound] = useState(null);
  const editor = () => ctxOf().ed;
  // A canvas draft: the engine's findings (file.inspectFindings) and its removals (file.inspect, one undo step).
  const engine = () => ctxOf().engine;
  const inspectNow = async () => {
    if (engine()) return setFound(engineFindings((await Promise.resolve(engine().query('file.inspectFindings', {})).catch(() => null))?.value?.found));
    return editor() && setFound(findings(editor().getJSON()));
  };
  const removeAll = async (c) => {
    const ok = await confirmDialog({ title: `Remove all ${c.label.toLowerCase()}?`, description: `${describe(found, c.id)} Undo brings them back.`,
      confirmText: 'Remove All', destructive: true });
    if (ok && engine()) {
      const r = await Promise.resolve(engine().exec('file.inspect', { remove: ENGINE_REMOVE[c.id] ?? [] })).catch((e) => ({ ok: false, error: String(e) }));
      if (!r?.ok) ctxOf().toast(/tracks changes/.test(r?.error ?? '') ? 'Turn off Track Changes first, so the removal is not tracked.' : 'This could not be removed.');
      return inspectNow();
    }
    const ed = editor();
    if (!ok || !ed) return;
    replaceDoc(ed, removeCategory(ed.getJSON(), c.id));
    if (c.id === 'comments' && found.revisions && commandOf(ACCEPT_ALL)) run(ACCEPT_ALL);
    inspectNow();
  };
  const left = found ? [{ label: '&Reinspect', onClick: () => setFound(null) }] : [{ label: '&Inspect', onClick: inspectNow }];
  return (
    <WordDialog title="Document Inspector" size="md" okText="Close" left={left} onClose={onClose}>
      {!found ? (
        <div data-inspector="pick" className="flex flex-col gap-2">
          <p>To check the document for the selected content, click Inspect.</p>
          {CATEGORIES.map((c) => <Check key={c.id} label={c.label} checked={on[c.id]} onChange={(v) => setOn({ ...on, [c.id]: v })} />)}
        </div>
      ) : (
        <ul data-inspector="results" className="flex flex-col divide-y">
          {CATEGORIES.filter((c) => on[c.id]).map((c) => (
            <li key={c.id} data-category={c.id} data-found={foundIn(found, c.id) || undefined} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{c.label}</span>
                <span className="block text-muted-foreground">{describe(found, c.id)}</span>
              </span>
              {foundIn(found, c.id) && (
                <Button type="button" variant="outline" size="sm" data-remove={c.id} onClick={() => removeAll(c)} className="shrink-0">Remove All</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </WordDialog>
  );
}
