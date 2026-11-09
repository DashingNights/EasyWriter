// The Quick Access Toolbar's own menu (frame.qat.customize; probe/menus/frame.customize-quick-access-toolbar.json): check
// items for the buttons the bar shows, then More Commands..., Show Below (or Above) the Ribbon and Hide Quick Access Toolbar.
// A check edits settings.word.ribbon.qat in place (nav.mjs toggleQat). Drawn as a panel inside the ribbon's menu, so its rows
// are plain menu items that KeyTips find (role menuitem) with Word's M, S and H on the last three.
import { Check } from 'lucide-react';
import { cn } from 'cn';
import { keepFocus } from '../../../app/components/Toolbar.jsx';
import { useStore } from '../../../app/store.js';
import { REASONS } from '../../../tooling/reasons.mjs';
import { run } from '../../../tooling/registry.js';
import { wordSettings } from '../../word/settings.mjs';
import { QAT_MENU, toggleQat } from './nav.mjs';
import { saveRibbon } from './state.js';

const Row = ({ label, checked, disabled, title, keytip, onPick, id }) => (
  <button type="button" role="menuitem" data-feature={id} data-keytip={keytip} aria-checked={checked} aria-disabled={disabled || undefined}
    title={title} disabled={disabled} onMouseDown={keepFocus} onClick={onPick}
    className={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-50')}>
    <span className="grid size-4 shrink-0 place-items-center">{checked && <Check className="size-3.5" />}</span>
    <span className="truncate">{label}</span>
  </button>
);

/** The menu body ({close} from the ribbon's menu). */
export function QatMenu({ close }) {
  const ribbon = useStore((s) => wordSettings(s.settings).ribbon);
  const pick = (fn) => () => {
    close?.();
    fn();
  };
  return (
    <div role="group" aria-label="Customize Quick Access Toolbar" className="flex min-w-60 flex-col" data-qat-menu="">
      <div className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Customize Quick Access Toolbar</div>
      {QAT_MENU.map((it) => (
        <Row key={it.id} id={`frame.qat.customize.${it.id}`} label={it.label} checked={ribbon.qat.includes(it.id)} disabled={!!it.needs}
          title={it.needs ? REASONS[it.needs] : undefined} onPick={pick(() => saveRibbon({ qat: toggleQat(ribbon.qat, it.id) }))} />
      ))}
      <div className="my-1 h-px bg-border" />
      <Row id="frame.qat.customize.moreCommands" label="More Commands..." keytip="M" onPick={pick(() => run('options.qat'))} />
      <Row id="frame.qat.customize.position" label={ribbon.qatBelow ? 'Show Above the Ribbon' : 'Show Below the Ribbon'} keytip="S"
        onPick={pick(() => saveRibbon({ qatBelow: !ribbon.qatBelow }))} />
      <Row id="frame.qat.customize.hide" label="Hide Quick Access Toolbar" keytip="H" onPick={pick(() => saveRibbon({ qatHidden: true }))} />
    </div>
  );
}
