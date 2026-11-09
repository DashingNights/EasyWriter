// The Fill-in and Ask prompts (FILLIN and ASK fields, fields.json): the prompt text over a box holding the default answer, OK and
// Cancel. Resolves with the typed text, or null on Cancel, which keeps the old result.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';

function Prompt({ title, prompt, value = '', onClose }) {
  const [text, setText] = useState(value);
  return (
    <WordDialog title={title} size="sm" onClose={onClose} result={() => text}>
      <p className="whitespace-pre-wrap">{prompt}</p>
      <Input size="xs" aria-label="Answer" autoFocus value={text} onFocus={(e) => e.target.select()} onChange={(e) => setText(e.target.value)} />
    </WordDialog>
  );
}

export const FillInDialog = (props) => <Prompt title="Fill-in" {...props} />;
export const AskDialog = (props) => <Prompt title="Ask" {...props} />;
