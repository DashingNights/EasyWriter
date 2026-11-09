// Lock Tracking and its unlock prompt (Review > Track Changes > Lock Tracking). Both password boxes are optional. The dialog only
// returns what was typed; the command hashes it (hashOf in index.js), and nothing here stores, logs or sends it.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { Row } from '../../../tooling/kit/controls.jsx';

/** `unlock`: the prompt that turning tracking off asks while it is locked. → onClose({password}) or onClose(null). */
export function LockTracking({ unlock = false, onClose }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  if (unlock) {
    return (
      <WordDialog title="Unlock Tracking" size="sm" onClose={onClose} result={() => ({ password })}>
        <div className="flex flex-col gap-3">
          <Row label="&Password:" htmlFor="trk-unlock"><Input id="trk-unlock" size="xs" type="password" className="flex-1" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} /></Row>
        </div>
      </WordDialog>
    );
  }
  return (
    <WordDialog title="Lock Tracking" size="sm" onClose={onClose} result={() => ({ password })}
      validate={() => (password !== again ? 'The two passwords are not the same.' : null)}>
      <div className="flex flex-col gap-3">
        <p className="text-sm">Stops other authors from turning off Track Changes.</p>
        <Row label="&Enter password (optional):" htmlFor="trk-pw"><Input id="trk-pw" size="xs" type="password" className="flex-1" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} /></Row>
        <Row label="&Reenter to confirm:" htmlFor="trk-pw2"><Input id="trk-pw2" size="xs" type="password" className="flex-1" value={again} onChange={(e) => setAgain(e.target.value)} /></Row>
        <p className="text-xs text-muted-foreground">This is not a security feature.</p>
      </div>
    </WordDialog>
  );
}
