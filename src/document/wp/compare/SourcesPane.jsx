// Show Source Documents (docs/plans/word plan.md §3 compare): the pane 'sources' beside a comparison result, with read-only previews
// of the original and the revised document (Show Original, Show Revised or Show Both), scrolled to the block holding the selection.
// A result the engine made (a canvas draft's) reads its sources when the pane first shows them (run.js compareInEngine).
import { useEffect, useState } from 'react';
import { getState, useStore } from '../../../app/store.js';
import { sources } from './run.js';
import { Sheet } from './Sheet.jsx';

/** The pane: `props.show` 'original', 'revised' or 'both' (the default). */
export function SourcesPane({ ctx, props }) {
  const id = useStore((s) => s.draft?.id);
  const src = sources.get(id);
  const [docs, setDocs] = useState(null);
  useEffect(() => {
    setDocs(null);
    if (!src) return undefined;
    if (!src.read) return void setDocs({ original: src.original, revised: src.revised });
    let live = true;
    src.read().then(([original, revised]) => live && setDocs({ original, revised }), () => live && setDocs({ failed: true }));
    return () => {
      live = false;
    };
  }, [src]);
  if (!src) return <p className="p-3 text-muted-foreground">This draft is not a comparison result.</p>;
  if (!docs) return <p className="p-3 text-muted-foreground">Reading the documents...</p>;
  if (docs.failed) return <p className="p-3 text-muted-foreground">The documents could not be read.</p>;
  const show = props.show ?? 'both';
  const at = ctx.state?.selection.$from.index(0) ?? 0;
  // A canvas draft has no editor of its own: the hidden DOM editor's schema draws the previews.
  const schema = ctx.ed?.schema ?? getState().editor?.schema;
  const one = (side) => (
    <section key={side} data-source={side} className="flex min-h-0 flex-1 flex-col">
      <h3 className="px-3 py-1 text-xs text-muted-foreground">{side === 'original' ? 'Original' : 'Revised'}: {src[`${side}Title`]}</h3>
      <Sheet doc={docs[side]} schema={schema} at={at} />
    </section>
  );
  return <div className="flex h-full flex-col gap-1">{(show === 'both' ? ['original', 'revised'] : [show]).map(one)}</div>;
}
