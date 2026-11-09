// File > Info's Properties column (panel 'file.info.properties', drawn by backstage's Info page): size and counts, the properties
// the user types (edited in place: an empty one shows its prompt), Show All Properties, Related Dates and Related People, and a
// Properties menu that opens Advanced Properties.
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { run, useWordCtx } from '../../../tooling/registry.js';
import { docInfo, sizeText, writeProps } from './info.js';

/** A property value edited in place: the value (or its prompt, greyed) until clicked, then a box; Enter or leaving writes it. */
function Editable({ value, prompt, onSave }) {
  const [text, setText] = useState(null);
  if (text == null) {
    return (
      <button type="button" className={value ? 'text-left' : 'text-left text-muted-foreground'} onClick={() => setText(value ?? '')}>{value || prompt}</button>
    );
  }
  const save = () => {
    if (text.trim() !== (value ?? '')) onSave(text.trim() || null);
    setText(null);
  };
  return (
    <Input size="xs" autoFocus aria-label={prompt} value={text} onChange={(e) => setText(e.target.value)} onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') setText(null); }} />
  );
}

const Item = ({ label, children }) => (
  <div className="grid grid-cols-[9rem_1fr] items-baseline gap-2 py-0.5"><span className="text-muted-foreground">{label}</span><div className="min-w-0">{children}</div></div>
);

export function InfoPropertiesPanel() {
  const ctx = useWordCtx();
  const [all, setAll] = useState(false);
  const ed = ctx.ed;
  if (!ed) return null;
  const info = docInfo(ed);
  const p = info.props;
  const set = (path) => (v) => {
    const [group, key] = path.split('.');
    writeProps(ed, { [group]: { [key]: v } }, { patch: true });
  };
  const edit = (label, path, prompt) => (
    <Item key={path} label={label}><Editable value={path.split('.').reduce((o, k) => o?.[k], p)} prompt={prompt} onSave={set(path)} /></Item>
  );
  return (
    <div className="flex flex-col gap-3 text-sm" data-info-properties="">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="w-fit px-1 text-base font-normal">Properties<ChevronDown className="size-4" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => run('file.info.properties')}>Advanced Properties</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div>
        <Item label="Size">{sizeText(info.bytes, info.lang)}</Item>
        <Item label="Pages">{info.pages}</Item>
        <Item label="Words">{info.words}</Item>
        <Item label="Total Editing Time">{`${info.editMinutes} Minutes`}</Item>
        {edit('Title', 'core.title', 'Add a title')}
        {edit('Tags', 'core.keywords', 'Add a tag')}
        {edit('Comments', 'core.description', 'Add comments')}
        {all && (
          <>
            <Item label="Template">{p.app?.template || 'Normal.dotm'}</Item>
            {edit('Status', 'core.contentStatus', 'Add text')}
            {edit('Categories', 'core.category', 'Add a category')}
            {edit('Subject', 'core.subject', 'Specify the subject')}
            {edit('Hyperlink Base', 'app.hyperlinkBase', 'Add text')}
            {edit('Company', 'app.company', 'Specify the company')}
            {edit('Manager', 'app.manager', 'Specify the manager')}
          </>
        )}
      </div>
      <div>
        <div className="mb-1 font-medium">Related Dates</div>
        <Item label="Last Modified">{info.date(info.saved)}</Item>
        <Item label="Created">{info.date(info.created)}</Item>
        <Item label="Last Printed">{info.date(info.printed)}</Item>
      </div>
      <div>
        <div className="mb-1 font-medium">Related People</div>
        <Item label="Author"><Editable value={p.core?.creator ?? info.user} prompt="Add an author" onSave={set('core.creator')} /></Item>
        <Item label="Last Modified By">{info.savedBy}</Item>
      </div>
      <Button variant="link" size="sm" className="w-fit px-0" onClick={() => setAll((v) => !v)}>
        {all ? 'Show Fewer Properties' : 'Show All Properties'}
      </Button>
    </div>
  );
}
