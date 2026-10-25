import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { FormDialog } from '../app/components/FormDialog.jsx';
import { MAX_PAPER, sectFor, showIn, tooSmall } from './pages.mjs';

// Layout > Margins > Custom margins and Size > More sizes (docs/plans/document.md Ribbon Layout): the four margins and the
// paper's width and height in cm or inches (the region's unit, pages.mjs unitOf). Its result is doc.pageSetup's {margins, size}
// in points; tools.js openPageSetup applies it.

const MARGINS = [['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']];
const PAPER = [['w', 'Width'], ['h', 'Height']];

/** `sect`: the open Document's; `unit`: {name, pt}; `focus`: 'margins' or 'paper', whose first field takes the focus. */
export function PageSetupDialog({ sect, unit, focus, onClose }) {
  const orig = (k) => (k in sect.margin ? sect.margin[k] : sect[k]);
  const [shown] = useState(() => Object.fromEntries([...MARGINS, ...PAPER].map(([k]) => [k, showIn(orig(k), unit)])));
  const [v, setV] = useState(shown);
  // A field left as shown keeps its exact length: the shown text is rounded, and converting it back would move the page.
  const pt = (k) => (v[k] === shown[k] ? orig(k) : Math.round(Number(v[k]) * unit.pt * 20) / 20); // whole twips
  const args = () => ({
    margins: { topPt: pt('top'), rightPt: pt('right'), bottomPt: pt('bottom'), leftPt: pt('left') },
    size: { widthPt: pt('w'), heightPt: pt('h') },
  });
  const validate = () => {
    if (Object.values(v).some((x) => x.trim() === '' || !Number.isFinite(Number(x)) || Number(x) < 0)) return 'Each length is a number of 0 or more';
    if (pt('w') < 7.2 || pt('h') < 7.2 || pt('w') > MAX_PAPER || pt('h') > MAX_PAPER) return `The paper is ${showIn(7.2, unit)} to ${showIn(MAX_PAPER, unit)} ${unit.name} on each side`;
    return tooSmall(sectFor(sect, args()));
  };
  const field = ([k, label], first) => (
    <label key={k} className="grid grid-cols-[4rem_1fr_1.5rem] items-center gap-2">
      {label}
      <Input type="number" min={0} step="any" aria-label={label} autoFocus={first} value={v[k]} className="h-8 tabular-nums"
        onChange={(e) => setV((o) => ({ ...o, [k]: e.target.value }))} />
      <span className="text-muted-foreground">{unit.name}</span>
    </label>
  );
  return (
    <FormDialog title="Page setup" okText="Apply" validate={validate} result={args} onClose={onClose} className="sm:max-w-sm">
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 font-medium">Margins</legend>
        {MARGINS.map((m, i) => field(m, focus !== 'paper' && i === 0))}
      </fieldset>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 font-medium">Paper</legend>
        {PAPER.map((p, i) => field(p, focus === 'paper' && i === 0))}
      </fieldset>
    </FormDialog>
  );
}
