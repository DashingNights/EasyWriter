// The XML Mapping pane (plan.md §1.7 pane xmlMapping, §3 content-controls): one custom XML part, the document properties, as a tree
// of its elements with each one's value; Insert Content Control on an element puts a control bound to it at the caret.
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Pick } from '../../../tooling/kit/controls.jsx';
import { propValue } from './model.mjs';
import { insertBound } from './commands.js';

// The part's elements in Word's order: [element, props path, kind of value].
const PARTS = [
  ['coreProperties', [['title', 'core.title'], ['subject', 'core.subject'], ['creator', 'core.creator'], ['keywords', 'core.keywords'],
    ['description', 'core.description'], ['category', 'core.category'], ['contentStatus', 'core.contentStatus']]],
  ['extended-properties', [['Company', 'app.company'], ['Manager', 'app.manager']]],
  ['CoverPageProperties', [['PublishDate', 'cover.publishDate'], ['Abstract', 'cover.abstract'], ['CompanyAddress', 'cover.address'],
    ['CompanyPhone', 'cover.phone'], ['CompanyFax', 'cover.fax'], ['CompanyEmail', 'cover.email']]],
];
// No Picture: every element here holds text, and Word offers Picture only for an element holding an image.
const KINDS = [['text', 'Plain Text'], ['date', 'Date'], ['checkbox', 'Check Box']];

// On a canvas draft file.info reads the six properties the engine keeps, and Insert puts a control bound to one of them
// (developer.insertBound, engine-gaps-rest); the engine brings edited controls and their properties into step when the pane
// opens (developer.syncBindings) and whenever a property is set.
const ENGINE_PROPS = { 'core.title': 'title', 'core.subject': 'subject', 'core.creator': 'creator', 'core.keywords': 'keywords',
  'core.description': 'description', 'core.category': 'category' };
const NOT_ON_CANVAS = 'Canvas drafts do not keep this property yet.';
const NO_CHECKBOX = 'Check boxes bound to a property are not on the canvas yet.';

/** The pane: the part picker, then each element with its value and an Insert Content Control menu. */
export function XmlMappingPane({ ctx }) {
  const engine = !!ctx.engine;
  useEffect(() => { if (engine) ctx.engine.exec('developer.syncBindings', {}); }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps
  const info = engine ? ctx.read('file.info', {})?.properties ?? {} : null;
  const props = ctx.ed?.state.doc.attrs.props ?? {}; // the main editor's: a header story only mirrors them
  const valueOf = (path) => (engine ? info[ENGINE_PROPS[path]] ?? '' : propValue(props, path));
  const [open, setOpen] = useState({ coreProperties: true, 'extended-properties': true, CoverPageProperties: true });
  const [kind, setKind] = useState('text');
  return (
    <div className="flex flex-col gap-2 p-2 text-xs">
      <label className="flex flex-col gap-1">
        <span>Custom XML Part:</span>
        <Pick value="props" options={[['props', 'Document properties']]} onChange={() => {}} />
      </label>
      <label className="flex items-center gap-2">
        <span className="shrink-0">Insert as:</span>
        <Pick value={kind} options={KINDS} onChange={setKind} aria-label="Insert Content Control" />
      </label>
      <div role="tree" className="flex flex-col">
        {PARTS.map(([part, elements]) => (
          <div key={part} role="treeitem" aria-expanded={!!open[part]}>
            <button type="button" className="flex w-full items-center gap-1 py-0.5 text-left hover:bg-accent"
              onClick={() => setOpen((o) => ({ ...o, [part]: !o[part] }))}>
              {open[part] ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}{part}
            </button>
            {open[part] && elements.map(([name, path]) => (
              <div key={path} role="treeitem" data-prop={path} className="group flex items-center gap-1 py-0.5 pl-5">
                <span className="min-w-0 flex-1 truncate" title={valueOf(path) || undefined}>
                  {name}<span className="ml-2 text-muted-foreground">{valueOf(path)}</span>
                </span>
                <Button type="button" variant="ghost" size="xs" className="opacity-60 group-hover:opacity-100"
                  disabled={engine ? !ENGINE_PROPS[path] || kind === 'checkbox' : !ctx.target}
                  title={engine && !ENGINE_PROPS[path] ? NOT_ON_CANVAS : engine && kind === 'checkbox' ? NO_CHECKBOX
                    : `Insert a ${KINDS.find((k) => k[0] === kind)[1]} content control bound to ${name}`}
                  onClick={() => (engine ? ctx.engine.exec('developer.insertBound', { property: ENGINE_PROPS[path], kind }) : insertBound(ctx, kind, path, name))}>Insert</Button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
