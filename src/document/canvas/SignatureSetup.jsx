import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { WordDialog } from '../../tooling/kit/WordDialog.jsx';

/** Insert > Signature Line > Signature Setup: Word's two suggested fields, which become the line's picture (signature-line.mjs). */
export function SignatureSetup({ onClose }) {
  const [signer, setSigner] = useState('');
  const [title, setTitle] = useState('');
  return (
    <WordDialog title="Signature Setup" size="sm" onClose={onClose} result={() => ({ signer, title })}>
      <label className="flex flex-col gap-1">
        Suggested signer (for example, John Doe):
        <Input size="xs" value={signer} onChange={(e) => setSigner(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        Suggested signer's title (for example, Manager):
        <Input size="xs" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
    </WordDialog>
  );
}
