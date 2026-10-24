import { useState } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { refocusEditor } from '../actions.js';

/** Form dialog shell: title, body, error line, Cancel / OK. OK closes with `result()` unless `validate()` returns a message.
 * `destructive`: OK deletes something, so it is red. */
export function FormDialog({ title, okText = 'OK', destructive, className, validate, result, onClose, children }) {
  const [error, setError] = useState('');
  const submit = (e) => {
    e.preventDefault();
    const message = validate?.();
    if (message) setError(message);
    else onClose(result());
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(null)}>
      <DialogContent className={cn('p-3 text-sm *:data-[slot=dialog-close]:top-2 *:data-[slot=dialog-close]:right-2', className)}
        aria-describedby={undefined} onCloseAutoFocus={refocusEditor} onInteractOutside={(e) => e.preventDefault()}>
        <form onSubmit={submit} className="grid min-h-0 gap-2">
          <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
          {children}
          {error && <p className="text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onClose(null)}>Cancel</Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} size="sm">{okText}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
