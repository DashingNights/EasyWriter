import { useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { citedTags } from '../../document/wp/citations/fields.mjs';
import { citation, labels, nextNumber, numbered, styleOf, wordCitation, wordLabels, WORD_STYLES } from '../../references.mjs';
import { Pick } from '../../tooling/kit/controls.jsx';
import { refocusEditor, toast } from '../actions.js';
import { addNewSource, insertCitation, setDefaultStyle, setStyle } from '../references.js';
import { getState, setState, useStore } from '../store.js';

// Word's Insert Citation menu at the text cursor (openCitePicker: the toolbar's Insert reference, the tool search) and the
// reference style picker (Source Manager in a forum post, the tool search's Reference style). docs/wiki/references.md.

const EMPTY = [];
const STYLE_OPTIONS = WORD_STYLES.map((r) => [r.id, r.label]);
const fail = (err) => toast(err.message, true);

/** The open draft's style and Make default while it is not the default. */
export function ReferenceStyle() {
  const style = useStore((s) => styleOf(s.draft, s.settings, true));
  const preferred = useStore((s) => styleOf(null, s.settings, true));
  return (
    <div data-reference-style className="flex items-center gap-2 text-xs">
      <label htmlFor="ref-style">Style</label>
      <Pick id="ref-style" value={style} options={STYLE_OPTIONS} onChange={(v) => v && setStyle(v).catch(fail)} width="14rem" />
      {style === preferred
        ? <span className="text-muted-foreground">Your default</span>
        : <Button type="button" variant="outline" size="xs" onClick={() => Promise.resolve(setDefaultStyle(style)).catch(fail)}>Make default</Button>}
    </div>
  );
}

/** Each source as the menu lists it: its citation in the draft's style (a forum post's narrative one too), then the authors and
 * title. A Document numbers by first citation (wordLabels); a forum post by each source's fixed number, the next one for a
 * source not cited yet. */
function rows(sources, style, doc) {
  if (doc) {
    const lab = wordLabels(sources, style, citedTags(doc));
    return sources.map((s) => ({ s, cite: wordCitation([{ s, label: lab.get(s.id) ?? '' }], style), narrative: null }));
  }
  const lab = labels(sources, style);
  return sources.map((s) => {
    const label = numbered(style) && !s.num ? String(nextNumber(sources)) : lab.get(s.id) ?? '';
    const cite = citation(s, label, false, style);
    const narrative = citation(s, label, true, style);
    return { s, cite, narrative: narrative !== cite ? narrative : null };
  });
}

function CiteMenu({ at }) {
  const sources = useStore((s) => s.draft?.sources) ?? EMPTY;
  const style = useStore((s) => styleOf(s.draft, s.settings, true));
  const doc = getState().draft?.format === 'document' ? getState().editor?.state.doc : null;
  const items = useMemo(() => rows(sources, style, doc), [sources, style, doc]);
  const shift = useRef(false); // Shift+click or Shift+Enter: the narrative citation
  const close = () => setState({ citePicker: null });
  const go = (fn) => {
    close();
    Promise.resolve().then(fn).catch(fail);
  };
  const keep = (e) => { shift.current = e.shiftKey; };
  return (
    <DropdownMenu open onOpenChange={(open) => !open && close()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden="true" className="pointer-events-none fixed size-0" style={{ left: at.x, top: at.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent data-cite-picker align="start" sideOffset={6} className="max-w-[28rem] min-w-56" onCloseAutoFocus={(e) => {
        e.preventDefault();
        refocusEditor();
      }}>
        {items.map(({ s, cite, narrative }) => (
          <DropdownMenuItem key={s.id} data-source={s.id} title={narrative ? `Shift+click inserts ${narrative}` : undefined} onPointerDown={keep} onKeyDown={keep}
            onSelect={() => go(() => insertCitation(s.id, shift.current))}>
            <span className="flex min-w-0 flex-col">
              <span>{cite}</span>
              <span className="truncate text-xs text-muted-foreground">{[s.authors.join('; '), s.title].filter(Boolean).join(', ') || s.tag}</span>
            </span>
          </DropdownMenuItem>
        ))}
        {items.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem data-feature="references.addSource" onSelect={() => go(addNewSource)}>Add New Source...</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Insert Citation: the draft's sources (a pick cites it at the cursor) and Add New Source... Mounted once in App. */
export function CitePicker() {
  const at = useStore((s) => s.citePicker);
  return at ? <CiteMenu at={at} /> : null;
}
