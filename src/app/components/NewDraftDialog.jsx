import { useState } from 'react';
import { FileText, MessageSquareText, Presentation, Sheet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { TITLE_LIMIT } from '../../doc-utils.mjs';
import { enabled } from '../../integrations/index.mjs';
import { useStore } from '../store.js';
import { FormDialog } from './FormDialog.jsx';
import { NONE } from './Toolbar.jsx';

// Formats still to come (docs/plans/document.md newDraftModal): shown disabled, never in FORMATS, so no draft can take them.
const COMING = [{ id: 'presentation', label: 'Presentation', Icon: Presentation }, { id: 'spreadsheet', label: 'Spreadsheet', Icon: Sheet }];

function Choice({ id, label, Icon, disabled, pick, children }) {
  return (
    <ToggleGroupItem value={id} disabled={disabled} aria-disabled={disabled || undefined} onFocus={() => pick(id)} data-new-draft-format={id}
      className="h-auto w-24 flex-col gap-1 py-2 text-xs">
      <Icon className="size-5" />
      {label}
      {children}
    </ToggleGroupItem>
  );
}

/** New draft (actions.startNewDraft, docs/plans/sidebar-menu.md decision 3): a title (focused first; empty: 'Untitled'), a
 * folder (`folders`, the Drafts list's for the selected project; `folderId` preselected, null: None) and a card per format,
 * `value` (formats.mjs defaultFormat) picked → {format, title, folderId}. The pick follows the focus, so the arrow keys pick
 * (they skip the disabled cards); Enter or a double-click on a card creates, and so does Enter in the title. Forum post only
 * while the forum is on; forum posts made earlier open in either state. */
export function NewDraftDialog({ value: initial, folders = [], folderId: initialFolder = null, onClose }) {
  const forum = useStore((s) => enabled(s.settings, 'forum'));
  const [value, setValue] = useState(initial);
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState(initialFolder ?? NONE);
  const create = (e) => {
    e.preventDefault();
    e.currentTarget.closest('form').requestSubmit();
  };
  return (
    <FormDialog title="New draft" okText="Create" className="sm:max-w-fit" onClose={onClose}
      result={() => ({ format: value, title, folderId: folder === NONE ? null : folder })}>
      {/* w-0 min-w-full: the fields take the cards' width and never set it, so a long folder name cannot widen the dialog. */}
      <div className="grid w-0 min-w-full gap-1.5">
        <Label htmlFor="new-draft-title">Title</Label>
        <Input id="new-draft-title" className="h-8" autoFocus maxLength={TITLE_LIMIT} placeholder="Untitled" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid w-0 min-w-full gap-1.5">
        <Label htmlFor="new-draft-folder">Folder</Label>
        <Select value={folder} onValueChange={setFolder}>
          <SelectTrigger id="new-draft-folder" size="sm" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {folders.map((f) => <SelectItem key={f.id} value={f.id}><span className="truncate">{f.name}</span></SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <ToggleGroup type="single" variant="outline" spacing={2} aria-label="Format" value={value} onValueChange={(v) => v && setValue(v)}
        onKeyDown={(e) => e.key === 'Enter' && create(e)} onDoubleClick={(e) => e.target.closest('[data-slot="toggle-group-item"]') && create(e)}>
        <Choice id="document" label="Document" Icon={FileText} pick={setValue} />
        {COMING.map((f) => (
          <Choice key={f.id} {...f} disabled pick={setValue}><Badge variant="outline" className="px-1.5 py-0">Coming soon</Badge></Choice>
        ))}
        {forum && (
          <>
            <Separator orientation="vertical" className="mx-1 h-12 self-center" />
            <Choice id="forum-post" label="Forum post" Icon={MessageSquareText} pick={setValue} />
          </>
        )}
      </ToggleGroup>
    </FormDialog>
  );
}
