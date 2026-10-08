import { useEffect, useMemo, useState } from 'react';
import { cn } from 'cn';
import { Plus, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { chordOf, collisions, DEFS, effective, GROUPS, windowsUse } from '../keys.mjs';

// Settings > Keybinds (SPEC §7k): every binding of the registry with its chords. A chord button records a new chord in its place,
// + adds one, x removes one, the reset arrow brings the defaults back. Warnings (Windows's own use of a chord, and two bindings
// on one chord where both can act) show under the row and never block Save.

const DEFAULTS = effective(DEFS);
const BY_ID = Object.fromEntries(DEFS.map((d) => [d.id, d]));
// Where a plain typing key is harmless: these handlers already ignore keys typed into a text box.
const NO_TYPING_WARNING = ['board', 'plan', 'flows'];

/** The warnings of binding `d` with chords `keys` ([] when none): Windows's use of a chord the user chose (the defaults are the
 * app's known choices) and the other bindings on the same chord. */
function warningsOf(d, keys, clashes) {
  const out = [];
  for (const chord of keys) {
    if (DEFAULTS[d.id].includes(chord)) continue;
    const w = windowsUse(chord);
    if (!w || (w.level === 'typing' && NO_TYPING_WARNING.includes(d.scope))) continue;
    out.push(w.level === 'system' ? `Windows uses ${chord} (it ${w.what}), so the app never gets this key.`
      : w.level === 'standard' ? `In Windows ${chord} ${w.what}. This keybind takes it over in the app.`
        : `${chord} ${w.what}.`);
  }
  for (const c of clashes ?? []) out.push(`${c.chord} is also ${BY_ID[c.id].label} (${BY_ID[c.id].group}).`);
  return out;
}

/** One chord: a button that records a replacement when clicked, and its remove button. */
function Chord({ chord, recording, onRecord, onRemove }) {
  return (
    <span className={cn('inline-flex items-center rounded-md border bg-muted/40 text-xs', recording && 'ring-2 ring-ring')}>
      <button type="button" className="px-1.5 py-0.5 font-mono" aria-label={recording ? 'Press the new keys' : `Change ${chord}`} onClick={onRecord}>
        {recording ? 'Press keys...' : chord}
      </button>
      <button type="button" className="px-1 text-muted-foreground hover:text-foreground" aria-label={`Remove ${chord}`} onClick={onRemove}><X className="size-3" /></button>
    </span>
  );
}

/** `value` {id: [chord]}, every binding's chords; `onChange(next)`. */
export function KeybindsSection({ value, onChange }) {
  const [filter, setFilter] = useState('');
  const [rec, setRec] = useState(null); // {id, index}: the chord being recorded (index: its place, or null for a new one)
  const clashes = useMemo(() => collisions(DEFS, value), [value]);

  useEffect(() => { // the next chord pressed goes to `rec`; Escape cancels; nothing else in the app sees the keys meanwhile
    if (!rec) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'keydown') return;
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return setRec(null);
      const chord = chordOf(e);
      if (!chord) return; // a modifier alone: wait for the key
      const list = [...(value[rec.id] ?? [])];
      if (rec.index == null) list.push(chord);
      else list[rec.index] = chord;
      onChange({ ...value, [rec.id]: [...new Set(list)] });
      setRec(null);
    };
    const away = (e) => !e.target.closest?.('[data-recording]') && setRec(null);
    addEventListener('keydown', onKey, true);
    addEventListener('keyup', onKey, true);
    addEventListener('pointerdown', away, true);
    return () => {
      removeEventListener('keydown', onKey, true);
      removeEventListener('keyup', onKey, true);
      removeEventListener('pointerdown', away, true);
    };
  }, [rec, value]);

  const q = filter.trim().toLowerCase();
  const shown = (d) => !q || d.label.toLowerCase().includes(q) || d.group.toLowerCase().includes(q)
    || (value[d.id] ?? []).some((c) => c.toLowerCase().includes(q));
  const changed = DEFS.filter((d) => (value[d.id] ?? []).join() !== DEFAULTS[d.id].join()).length;
  const warned = DEFS.filter((d) => warningsOf(d, value[d.id] ?? [], clashes[d.id]).length).length;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter keybinds" aria-label="Filter keybinds" className="h-8 w-56" />
        <Button type="button" variant="outline" size="sm" disabled={!changed} onClick={() => onChange(DEFAULTS)}><RotateCcw />Reset all</Button>
        {warned > 0 && <span className="flex items-center gap-1 text-xs text-amber-400"><TriangleAlert className="size-3.5" />{warned === 1 ? '1 keybind has a warning' : `${warned} keybinds have warnings`}</span>}
      </div>
      {GROUPS.map((group) => {
        const defs = DEFS.filter((d) => d.group === group && shown(d));
        if (!defs.length) return null;
        return (
          <div key={group} className="grid gap-1">
            <h4 className="text-xs font-medium text-muted-foreground">{group}</h4>
            {defs.map((d) => {
              const keys = value[d.id] ?? [];
              const warnings = warningsOf(d, keys, clashes[d.id]);
              const isDefault = keys.join() === DEFAULTS[d.id].join();
              return (
                <div key={d.id} data-keybind={d.id} className="grid grid-cols-[minmax(10rem,15rem)_1fr_auto] items-start gap-x-3 rounded-md px-1 py-1 hover:bg-accent/30">
                  <span className="pt-0.5 text-sm">{d.label}</span>
                  <div className="flex flex-wrap items-center gap-1" data-recording={rec?.id === d.id ? '' : undefined}>
                    {keys.map((c, i) => (
                      <Chord key={c} chord={c} recording={rec?.id === d.id && rec.index === i} onRecord={() => setRec({ id: d.id, index: i })}
                        onRemove={() => onChange({ ...value, [d.id]: keys.filter((x) => x !== c) })} />
                    ))}
                    {rec?.id === d.id && rec.index == null
                      ? <span className="rounded-md px-1.5 py-0.5 text-xs ring-2 ring-ring">Press keys...</span>
                      : <Button type="button" variant="ghost" size="icon-xs" aria-label={`Add a key to ${d.label}`} onClick={() => setRec({ id: d.id, index: null })}><Plus /></Button>}
                    {!keys.length && rec?.id !== d.id && <span className="text-xs text-muted-foreground">No key</span>}
                    {warnings.map((w) => (
                      <p key={w} className="flex w-full items-start gap-1 text-xs text-amber-400"><TriangleAlert className="mt-px size-3 shrink-0" />{w}</p>
                    ))}
                  </div>
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={`Reset ${d.label}`} className={cn(isDefault && 'invisible')}
                    onClick={() => onChange({ ...value, [d.id]: DEFAULTS[d.id] })}><RotateCcw /></Button>
                </div>
              );
            })}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Keys that move inside lists, menus, dialogs and text (Enter, Esc, Tab and the arrows) stay as they are. Press Esc to stop recording.
      </p>
    </div>
  );
}

