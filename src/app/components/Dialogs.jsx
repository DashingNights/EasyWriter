import { useState } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TITLE_LIMIT } from '../../doc-utils.mjs';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { PageSetupDialog } from '../../document/PageSetupDialog.jsx';
import { PlaceDraft } from '../../board/PlaceDraft.jsx';
import { all } from '../../integrations/ui.js';
import { WORD_DIALOGS } from '../../tooling/dialogs.js';
import { closeDialog, dialogStack, refocusEditor } from '../actions.js';
import { setState, useStore } from '../store.js';
import { FLOW_FORMS } from './flows/forms.jsx';
import { FormDialog } from './FormDialog.jsx';
import { NewDraftDialog } from './NewDraftDialog.jsx';
import { PLAN_FORMS } from './plan/forms.jsx';
import { SettingsDialog } from './SettingsDialog.jsx';

function LinkDialog({ href, onClose }) {
  const [value, setValue] = useState(href);
  return (
    <FormDialog title="Link" okText="Apply" result={() => value} onClose={onClose}>
      <Input className="h-8" value={value} placeholder="https://..." onChange={(e) => setValue(e.target.value)} />
    </FormDialog>
  );
}

/** A Document picture's alt text (document/tools.js editAltText): the text, empty for none. */
function AltTextDialog({ alt, onClose }) {
  const [value, setValue] = useState(alt);
  return (
    <FormDialog title="Alt text" okText="Apply" result={() => value} onClose={onClose}>
      <Textarea aria-label="Alt text" maxLength={2000} value={value} placeholder="Describe the picture for people who cannot see it"
        onChange={(e) => setValue(e.target.value)} />
    </FormDialog>
  );
}

/** New project: a name → the name. */
function AddThreadDialog({ validate, onClose }) {
  const [name, setName] = useState('');
  return (
    <FormDialog title="New project" okText="Create" validate={() => validate(name)} result={() => name} onClose={onClose}>
      <Input aria-label="Project name" className="h-8" maxLength={200} value={name} placeholder="Project name" onChange={(e) => setName(e.target.value)} />
    </FormDialog>
  );
}

/** Rename (the title bar's document name in Word): the draft's title `value` → the new one. */
function RenameDraftDialog({ value, onClose }) {
  const [name, setName] = useState(value ?? '');
  return (
    <FormDialog title="Rename" okText="Rename" validate={() => (name.trim() ? '' : 'Enter a name.')} result={() => name} onClose={onClose}>
      <Input aria-label="Name" className="h-8" maxLength={TITLE_LIMIT} value={name} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
    </FormDialog>
  );
}

const CORE = { newDraft: NewDraftDialog, link: LinkDialog, altText: AltTextDialog, pageSetup: PageSetupDialog, addThread: AddThreadDialog, settings: SettingsDialog,
  renameDraft: RenameDraftDialog, placeDraft: PlaceDraft };
// Object.assign: all('FORMS') is one object per integration.
const FORMS = Object.assign({ ...CORE, ...PLAN_FORMS, ...FLOW_FORMS, ...WORD_DIALOGS }, ...all('FORMS'));

/** confirmDialog(): AlertDialog with Cancel and a confirm button (only OK for an alert). */
function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  if (!confirm) return null;
  const close = (ok) => {
    setState({ confirm: null });
    confirm.resolve(ok);
  };
  return (
    <AlertDialog open onOpenChange={(open) => !open && close(false)}>
      <AlertDialogContent className="gap-2 p-3" {...(confirm.description ? {} : { 'aria-describedby': undefined })} onCloseAutoFocus={refocusEditor}>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
          {confirm.description && <AlertDialogDescription>{confirm.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {!confirm.alert && <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>}
          <AlertDialogAction size="sm" variant={confirm.destructive ? 'destructive' : 'default'} onClick={() => close(true)}
            data-agent-risk={confirm.destructive && !confirm.alert ? 'destructive' : undefined} data-agent-deny={confirm.human || undefined}>
            {confirm.alert ? 'OK' : confirm.confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PushOverlay() {
  const text = useStore((s) => s.overlay);
  if (!text) return null;
  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/60">
      <Card className="flex-row items-center gap-2 p-3 text-sm">
        <Spinner />
        {text}
      </Card>
    </div>
  );
}

/** Renders the open form dialogs (actions.openDialog), the confirmation and the push overlay. Dialogs stack (plan.md §1.6): every
 * entry stays mounted with its state, and Radix keeps only the top one interactive and focused. */
export function DialogHost() {
  useStore((s) => s.dialogs);
  useStore((s) => s.dialog); // plans.js, flows.js and prefabs.js still set it directly; dialogStack() takes such an entry too
  return (
    <>
      {dialogStack().map((d, i) => {
        const Form = FORMS[d.type];
        return Form && <Form key={d.n ?? `legacy${i}`} {...d.props} onClose={(result) => closeDialog(d, result)} />;
      })}
      <ConfirmDialog />
      <PushOverlay />
    </>
  );
}
