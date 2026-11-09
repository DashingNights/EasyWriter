// Word's right-click menu in a Document (docs/plans/word/briefs/context-menu.md): the entries menus.mjs gives for the hit, drawn at
// the pointer (or the caret for Shift+F10 and the Menu key) with the access key underlined. A letter runs its entry; a picked entry
// runs once the menu has closed and the editor has the focus back (DraftMenu's pattern), so a paste lands in the document. The mini
// toolbar shows above it while it is open.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clipboard, ClipboardPaste, ClipboardType, Image } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TITLEBAR } from '@/components/ui/bounds';
import { refocusEditor } from '../../../app/actions.js';
import { CHROME } from '../../../app/components/board/controls.jsx';
import { Tip } from '../../../app/components/Tip.jsx';
import { commandOf, ctxOf, galleryOf, run, useWordCtx } from '../../../tooling/registry.js';
import { MenuView } from '../../../tooling/ribbon/menus.jsx';
import { iconOf } from '../../ribbon/icons.jsx';
import * as SPEC from '../../ribbon/spec.mjs';
import { changeAll } from './changeAll.mjs';
import { wordAt } from './hit.js';
import { entriesForKey, menuFor } from './menus.mjs';
import { mini } from './MiniToolbar.jsx';

const SIDE_OFFSET = 2; // px between the anchor and the menu
const FIT_MARGIN = 4; // px kept free below a menu that slid up, so a part-pixel overflow never makes Radix flip it
const PASTE_ICONS ={ keepSourceFormatting: ClipboardPaste, mergeFormatting: Clipboard, keepTextOnly: ClipboardType, picture: Image };

/** The menu entries for `hit` with the commands registered now (commandOf also applies the profile's grants). */
export const entriesFor = (hit) => menuFor(hit, { has: (id) => !!id && !!commandOf(id), menus: SPEC.MENUS });

/** The range of the misspelled `word` in `state`: the selection when it holds the word (Chromium selected it), else the word at
 * the caret when it is that word. */
function wordRange(state, word) {
  const { from, to } = state.selection;
  if (state.doc.textBetween(from, to) === word) return { from, to };
  const w = wordAt(state);
  return w?.text === word ? w : null;
}

/** Runs the spelling card's own entry `e` for the misspelled `word`. */
function act(e, word) {
  const ctx = ctxOf();
  const ed = ctx.target;
  if (!ed) return;
  if (e.act === 'replace') {
    const r = wordRange(ed.state, word);
    if (r) ed.commands.command(({ tr }) => !!tr.insertText(e.arg, r.from, r.to)); // keeps the word's marks
  } else if (e.act === 'changeAll') ed.commands.command(({ tr }) => changeAll(tr, word, e.arg) > 0);
  else if (e.act === 'speak') {
    const speech = globalThis.__wordTest?.speech ?? speechSynthesis;
    speech.cancel?.();
    speech.speak(new SpeechSynthesisUtterance(e.arg));
  } else if (e.act === 'learn') {
    // The word itself: main's own 'learn' adds the last right-clicked word, wrong for a menu opened from the keyboard.
    (globalThis.__wordTest?.spell ?? window.api.word.spell).add(e.arg);
  }
  else if (e.act === 'ignoreAll') {
    // The list proofing's own Ignore All writes (doc.attrs.settings.ignored), on the main editor that holds the doc settings.
    const main = ctx.ed ?? ed;
    const ignored = main.state.doc.attrs.settings?.ignored ?? [];
    if (!ignored.includes(word)) main.commands.setDocSettings({ ignored: [...ignored, word] });
  }
}

/** `text` with access key `k` underlined: the copy at `at` (the & position in Word's caption) when given, else the first. */
function Keyed({ text, k, at }) {
  const i = at ?? (k ? text.toLowerCase().indexOf(k.toLowerCase()) : -1);
  if (i < 0) return <span>{text}</span>;
  return <span>{text.slice(0, i)}<span className="underline underline-offset-2">{text[i]}</span>{text.slice(i + 1)}</span>;
}

/** The keydown handler of one menu level: a letter runs (or opens) the entry whose access key it is; a letter several entries
 * share moves the focus to the next of them and runs none, as Word does. Letters never reach the level above, so a submenu's keys
 * stay its own. */
const accessKeys = (entries, level) => (ev) => {
  if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.key.length !== 1 || !/\p{L}/u.test(ev.key)) return;
  ev.stopPropagation();
  const all = entriesForKey(entries, ev.key);
  if (!all.length) return;
  ev.preventDefault(); // no type-ahead
  const elOf = (x) => ev.currentTarget.querySelector(`[data-entry="${level}:${entries.indexOf(x)}"]`);
  if (all.length > 1) {
    const at = all.findIndex((x) => elOf(x)?.contains(document.activeElement));
    elOf(all[(at + 1) % all.length])?.focus();
    return;
  }
  const e = all[0];
  const el = elOf(e);
  if (!el) return;
  if (e.sub || e.menu) {
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  } else el.click();
};

function Level({ entries, level, env }) {
  return entries.map((e, i) => <Entry key={i} e={e} tag={`${level}:${i}`} level={`${level}.${i}`} env={env} />);
}

function Entry({ e, tag, level, env }) {
  const { pick, ctx, word } = env;
  if (e.sep) return <DropdownMenuSeparator />;
  if (e.gallery) {
    // Word's Paste Options icon row: each item runs the paste command with its id.
    const items = galleryOf(e.gallery, ctx);
    if (!items.length) return null;
    return (
      <div data-entry={tag} data-cm={e.label}>
        <DropdownMenuLabel className="py-1 text-xs font-normal text-muted-foreground">{e.label}</DropdownMenuLabel>
        <div className="flex gap-0.5 px-1 pb-1">
          {items.map((it) => {
            const Icon = PASTE_ICONS[it.id] ?? ClipboardPaste;
            return (
              <Tip key={it.id} title={it.label} side="bottom">
                <DropdownMenuItem data-item={it.id} aria-label={it.label} className="size-8 justify-center p-0"
                  onSelect={() => pick(() => (it.run ? it.run(ctxOf()) : run(e.cmd, it.id)))}><Icon className="size-4" /></DropdownMenuItem>
              </Tip>
            );
          })}
        </div>
      </div>
    );
  }
  if (e.sub || e.menu) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-entry={tag} data-cm={e.label} data-cmd={e.cmd}><Keyed text={e.label} k={e.key} at={e.at} /></DropdownMenuSubTrigger>
        <DropdownMenuSubContent {...CHROME} className="min-w-48 max-w-[28rem]" onKeyDown={e.sub ? accessKeys(e.sub, level) : (ev) => ev.stopPropagation()}>
          {e.sub ? <Level entries={e.sub} level={level} env={env} />
            : <MenuView spec={SPEC} icons={iconOf} menu={e.menu} ctx={ctx} cmd={commandOf(e.cmd) ? e.cmd : undefined} fire={pick} />}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }
  const row = (
    <DropdownMenuItem data-entry={tag} data-cm={e.label} data-cmd={e.cmd} data-reason={e.reason} disabled={!!e.disabled} aria-disabled={e.disabled || undefined}
      className={e.bold ? 'font-semibold' : undefined} onSelect={() => pick(() => (e.act ? act(e, word) : run(e.cmd, e.arg)))}>
      <Keyed text={e.label} k={e.key} at={e.at} />
    </DropdownMenuItem>
  );
  return e.disabled ? <Tip title={e.reason} side="right" wrap="w-full">{row}</Tip> : row;
}

/** The open menu: {at, hit, n} → drawn at `at`; onClose() when it closes. */
export function WordMenu({ menu, onClose }) {
  const ctx = useWordCtx();
  const picked = useRef(null);
  const { id, entries } = entriesFor(menu.hit);
  const pick = (fn) => {
    picked.current = fn;
  };
  const toBar = useRef(false); // the menu closed for a press on the bar, which stays for that press
  // The menu opens downward from the anchor. One too tall for the room below slides up just enough, where Radix would flip it
  // above the anchor (away from the caret, and with no room left for the mini toolbar above it).
  const [y, setY] = useState(null); // the anchor's y once the menu's height is known
  const box = useRef(null); // the menu's box at that y, for the bar
  const aboveMenu = () => {
    const b = mini.get();
    if (box.current && b?.menu) mini.set({ ...b, rect: box.current, n: b.n }); // the bar sits clear of the menu's whole box
  };
  const fit = (el) => {
    if (!el || box.current) return;
    const h = el.scrollHeight + el.offsetHeight - el.clientHeight; // its full height, before Radix caps it to the room it finds
    const top = Math.max(TITLEBAR, Math.min(menu.at.y, innerHeight - FIT_MARGIN - SIDE_OFFSET - Math.ceil(h)));
    box.current = { left: menu.at.x, top: top + SIDE_OFFSET, right: menu.at.x + el.offsetWidth, bottom: top + SIDE_OFFSET + h };
    setY(top);
    aboveMenu();
  };
  useEffect(() => {
    mini.show(menu.at, { menu: true });
    aboveMenu();
    return () => {
      const b = mini.get();
      if (!b?.menu) return;
      if (toBar.current) mini.set({ ...b, menu: false, n: b.n });
      else mini.hide(); // the floatie closes with its menu
    };
  }, [menu.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const env = { pick, ctx, word: menu.hit.spelling?.word ?? null };
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      {createPortal(
        // Keyed by y: a new anchor makes Radix place the menu again.
        <DropdownMenuTrigger asChild key={y ?? 'at'}>
          <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu.at.x, top: y ?? menu.at.y }} />
        </DropdownMenuTrigger>,
        document.body,
      )}
      <DropdownMenuContent ref={fit} {...CHROME} data-word-menu={id} align="start" sideOffset={SIDE_OFFSET} className="min-w-56" onKeyDown={accessKeys(entries, 'root')}
        onPointerDownOutside={(e) => {
          toBar.current = !!e.target?.closest?.('[data-mini-toolbar]');
        }}
        onCloseAutoFocus={(e) => {
          refocusEditor(e);
          const fn = picked.current;
          picked.current = null;
          fn?.();
        }}>
        <Level entries={entries} level="root" env={env} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
