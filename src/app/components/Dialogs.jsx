import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { refocusEditor, threadLabel } from '../actions.js';
import { setState, useStore } from '../store.js';
import { FLOW_FORMS } from './flows/forms.jsx';
import { FormDialog } from './FormDialog.jsx';
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

function AddThreadDialog({ validate, onClose }) {
  const [value, setValue] = useState('');
  return (
    <FormDialog title="Add thread URL" okText="Add" validate={() => validate(value)} result={() => value} onClose={onClose}>
      <Input type="url" className="h-8" value={value} placeholder="https://daf.staffs.ac.uk/topic/12345-.../" onChange={(e) => setValue(e.target.value)} />
    </FormDialog>
  );
}

function ChooseThreadDialog({ threads, selected, onClose }) {
  const [value, setValue] = useState(threads.some((t) => t.url === selected) ? selected : threads[0].url);
  return (
    <FormDialog title="Choose the thread for this draft" okText="Use thread" result={() => value} onClose={onClose}>
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {threads.map((t) => <SelectItem key={t.url} value={t.url}>{threadLabel(t)}</SelectItem>)}
        </SelectContent>
      </Select>
    </FormDialog>
  );
}

const CORE = { link: LinkDialog, addThread: AddThreadDialog, chooseThread: ChooseThreadDialog, settings: SettingsDialog };
const FORMS = { ...CORE, ...PLAN_FORMS, ...FLOW_FORMS };

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
          <AlertDialogTitle className="text-base">{confirm.title}</AlertDialogTitle>
          {confirm.description && <AlertDialogDescription>{confirm.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {!confirm.alert && <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>}
          <AlertDialogAction size="sm" variant={confirm.destructive ? 'destructive' : 'default'} onClick={() => close(true)}
            data-agent-risk={confirm.destructive && !confirm.alert ? 'destructive' : undefined}>
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
        <Loader2 className="size-4 animate-spin" />
        {text}
      </Card>
    </div>
  );
}

/** Renders the open form dialog (actions.openDialog), the confirmation and the push overlay. */
export function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  const Form = dialog && FORMS[dialog.type];
  const close = (result) => {
    setState({ dialog: null });
    dialog.resolve(result);
  };
  return (
    <>
      {Form && <Form {...dialog.props} onClose={close} />}
      <ConfirmDialog />
      <PushOverlay />
    </>
  );
}
