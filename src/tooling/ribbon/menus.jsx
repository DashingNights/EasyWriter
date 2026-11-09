// The ribbon's menus (docs/plans/word/plan.md §1.4 MenuEntry): items with checks, descriptions and placeholder reasons,
// section headings, separators, galleries (list, grid or tiles, with group headings, item menus and panels), registered
// panels and submenus. MenuView draws one MENUS entry inside a ribbon dropdown, or as a plain list where no menu is open
// (tool search's option panels, which find it through the registry's menuViewOf). It draws only what the active profile
// grants (§1.19).
import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Check, Search } from 'lucide-react';
import {
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '../../app/components/Tip.jsx';
import { keepFocus } from '../../app/components/Toolbar.jsx';
import { grants } from '../profile.mjs';
import { REASONS } from '../reasons.mjs';
import { commandOf, galleryOf, panelOf, run, setMenuView, useWordCtx } from '../registry.js';
import { iconOf, ItemPop } from './parts.jsx';

// The spec and icon set of the ribbon drawn last, for a MenuView opened outside the ribbon (tool search) that names no spec.
let shared = { spec: null, icons: null };
/** Records the ribbon's spec and icons for MenuViews drawn outside it (Ribbon.jsx calls it as it renders). */
export const shareSpec = (spec, icons) => { shared = { spec, icons }; };

// Plain stand-ins for the Radix menu parts, for a MenuView drawn outside an open menu.
const PlainItem = ({ onSelect, disabled, className, children, ...props }) => (
  <button type="button" disabled={disabled} onMouseDown={keepFocus} onClick={(e) => onSelect?.(e)} {...props}
    className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/60 disabled:opacity-50', className)}>{children}</button>
);
const PlainLabel = ({ className, children }) => <div className={cn('px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground', className)}>{children}</div>;
const PlainSep = () => <div className="my-1 h-px bg-border" />;
const RADIX = { Item: DropdownMenuItem, Label: DropdownMenuLabel, Sep: DropdownMenuSeparator, menu: true };
const PLAIN = { Item: PlainItem, Label: PlainLabel, Sep: PlainSep, menu: false };

/** Menu `menu` of `spec` (or `entries`) for `ctx`. `cmd`: the owning control's command (gallery picks run it with the item
 * id). `close()`: closes the menu (panels call it). `fire(fn)`: inside a ribbon dropdown, runs fn once the menu has closed
 * and the editor has the focus back; without it a pick runs at once (plain mode). Tool search's options view passes `id`
 * (the menu) and `control` (the control's id) instead of `menu` and `cmd`, and no ctx: the live one is used. */
export function MenuView({ spec = shared.spec, icons = shared.icons, menu, id, control, entries, ctx, cmd, close, fire }) {
  const live = useWordCtx();
  ctx ??= live;
  menu ??= id;
  cmd ??= control && (spec?.CONTROLS?.[control]?.cmd ?? control);
  const P = fire ? RADIX : PLAIN;
  const go = (fn) => (fire ? fire(fn) : (fn(), close?.()));
  const list = entries ?? spec?.MENUS?.[menu] ?? [{ gallery: menu }];
  const env = { spec, icons, ctx, cmd, close, go, P };
  return <>{list.map((e, i) => <Entry key={i} e={e} env={env} />)}</>;
}

/** Whether the active profile grants `id` (no profile: everything). */
const granted = (ctx, id) => !ctx?.profile || grants(ctx.profile, id);

function Entry({ e, env }) {
  const { spec, ctx, P } = env;
  if (e.sep) return <P.Sep />;
  if (e.label) return <P.Label>{e.label}</P.Label>;
  if (e.item && !e.sub) return <ItemEntry id={e.item} env={env} />;
  // A gallery with a panel registered under its id draws as that panel (the shape picker draws the shape galleries).
  if (e.gallery && !panelOf(e.gallery)) return <GalleryEntry g={e} env={env} />;
  if (e.panel || e.gallery) {
    const Panel = panelOf(e.panel ?? e.gallery);
    if (!Panel) return null;
    // pick(fn): in a ribbon dropdown fn runs once the menu has closed, as a gallery item's pick does; elsewhere at once.
    const pick = (fn) => (P.menu ? (env.go(fn), env.close?.()) : env.go(fn));
    // A panel's own fields take the keys: the menu's type-ahead would move the focus off them.
    return <div className="p-1" onKeyDown={(ev) => ev.stopPropagation()}><Panel ctx={ctx} cmd={env.cmd} close={env.close} pick={pick} gallery={e.gallery} /></div>;
  }
  if (e.sub) {
    const it = spec.ITEMS?.[e.item] ?? { label: e.item };
    if (!granted(ctx, e.item)) return null;
    const body = <MenuView spec={spec} icons={env.icons} menu={e.sub} ctx={ctx} cmd={commandOf(e.item) ? e.item : env.cmd} close={env.close} fire={P.menu ? env.go : undefined} />;
    if (!P.menu) return <><PlainLabel>{it.label}</PlainLabel><div className="pl-2">{body}</div></>;
    const Icon = it.icon ? iconOf(env.icons, it.icon) : null;
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-feature={e.item} data-keytip={it.keytip}>
          {/* The items' icon column, so the labels line up with theirs. */}
          <span className="grid size-4 shrink-0 place-items-center">{Icon && <Icon className="size-4" />}</span>
          {it.label}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-w-[28rem]">{body}</DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }
  return null;
}

/** One ITEMS entry: its icon, label, check, description and shortcut text; a placeholder or disabled item shows its reason
 * in a tooltip. A derived list item (it.arg) runs its parent's command with that arg and is checked while the parent's value
 * equals it. */
function ItemEntry({ id, env }) {
  const { spec, icons, ctx, go, P } = env;
  const it = spec.ITEMS?.[id] ?? { id, label: id };
  const cmdId = it.cmd ?? id;
  if (!granted(ctx, it.id ?? id)) return null;
  const c = commandOf(cmdId);
  const own = it.arg === undefined && !it.cmd; // its own command, so the command's label and description are its own
  const off = !!it.needs || !c || (c.enabled ? !c.enabled(ctx) : false);
  const reason = it.needs ? REASONS[it.needs] : !c ? REASONS.pending : off ? c.reason?.(ctx) : null;
  const checked = it.arg !== undefined ? c?.value?.(ctx) === it.arg : (it.check || c?.active) ? !!c?.active?.(ctx) : undefined;
  const label = (own && (typeof c?.label === 'function' ? c.label(ctx) : c?.label)) || it.label;
  const desc = own ? c?.desc?.(ctx) : null;
  const Icon = it.icon ? iconOf(icons, it.icon) : null;
  const row = (
    <P.Item data-feature={id} data-keytip={it.keytip} aria-disabled={off || undefined} disabled={off} aria-checked={checked}
      onSelect={() => go(() => run(cmdId, it.arg))} className="gap-2">
      <span className="grid size-4 shrink-0 place-items-center">{checked ? <Check className="size-3.5" /> : Icon && <Icon className="size-4" />}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {desc && <span className="text-xs text-muted-foreground">{desc}</span>}
      </span>
    </P.Item>
  );
  return off && reason ? <Tip title={reason} side="right" wrap="w-full">{row}</Tip> : row;
}

const VIEW = { list: 'flex flex-col', grid: 'grid gap-1 p-1', tiles: 'grid gap-1 p-1' };
// From this many items a gallery draws as a picker (LongGallery): a search box, its groups in a column, the list in two columns.
const LONG = 30;
const plain = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** A gallery entry: the provider's items (§1.4 GalleryItem), a heading row wherever `group` changes. A pick runs item.run, else
 * the gallery's own command when one is registered under its id, else the owning control's, with the item id. */
function GalleryEntry({ g, env }) {
  const { ctx, cmd, go, P } = env;
  const items = galleryOf(g.gallery, ctx) ?? [];
  const owner = commandOf(g.gallery) ? g.gallery : cmd;
  const [pop, setPop] = useState(null);
  const box = useRef(null);
  if (!items.length) return null;
  const view = g.view ?? 'list';
  const pick = (it) => {
    if (it.active && it.panel && panelOf(it.panel)) {
      const r = box.current.getBoundingClientRect(); // a menu pick carries no pointer position
      return setPop({ it, kind: 'panel', x: r.left, y: r.bottom });
    }
    go(() => (it.run ? it.run(ctx) : run(owner, it.id)));
  };
  const runs = []; // [{group, items}] in order; an item of a group met before joins that group's run (one heading each)
  for (const it of items) {
    const group = it.group ?? null;
    const run = group ? runs.find((r) => r.group === group) : runs.at(-1)?.group === null && runs.at(-1);
    if (run) run.items.push(it);
    else runs.push({ group, items: [it] });
  }
  // In the picker (`two`) an item with a tile (a shape) is a tile: its picture large, its name under it, its description only
  // in the tooltip; other items run in two columns, a long name keeping its width and its description wrapping under it.
  const tiles = items.some((it) => it.tile);
  const item = (it, two) => (two && it.tile ? (
    <P.Item key={it.id} data-item={it.id} aria-label={it.label} title={it.desc ? `${it.label} (${it.desc.toLowerCase()})` : it.label} aria-checked={!!it.active}
      onSelect={() => pick(it)} className={cn('h-auto flex-col items-center justify-start gap-1 px-1 py-1.5 text-center', it.active && 'bg-accent')}>
      <span className="grid h-9 w-full place-items-center [&_path]:[stroke-width:1.5] [&_path]:[vector-effect:non-scaling-stroke] [&_svg]:h-7! [&_svg]:w-9!">{it.tile}</span>
      <span className="line-clamp-2 w-full text-[11px] leading-tight text-muted-foreground">{it.label}</span>
    </P.Item>
  ) : (
    <P.Item key={it.id} data-item={it.id} aria-label={it.label} aria-checked={!!it.active} title={view !== 'list' && it.preview ? it.label : undefined} onSelect={(e) => {
      if (it.active && it.panel) e.preventDefault();
      pick(it);
    }} onContextMenu={(e) => {
      if (!it.menu?.length) return;
      e.preventDefault();
      setPop({ it, kind: 'menu', x: e.clientX, y: e.clientY });
    }} className={cn(view !== 'list' && 'justify-center p-1', two && view === 'list' && 'flex-wrap gap-y-0', it.active && 'bg-accent')}>
      {two ? <span className="flex max-w-full min-w-0 shrink-0">{it.preview ?? it.label}</span> : it.preview ?? it.label}
      {view === 'list' && it.desc && <span className={cn('ml-auto pl-4 text-xs text-muted-foreground tabular-nums', !two && 'truncate')}>{it.desc}</span>}
    </P.Item>
  ));
  const cols = (two) => (two && tiles ? { className: 'grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1' } : view === 'list'
    ? { className: two ? 'grid grid-cols-2 gap-x-1' : VIEW.list }
    // A group of one item (Default, Use Contextual Alternates, Document Bullets) takes the whole row, at its start.
    : { className: cn(VIEW[view], '[&>:only-child]:col-span-full [&>:only-child]:justify-start'), style: { gridTemplateColumns: `repeat(${g.cols ?? (view === 'tiles' ? 3 : 8)}, minmax(0, 1fr))` } });
  return (
    <div ref={box} data-gallery={g.gallery}>
      {items.length >= LONG ? <LongGallery runs={runs} item={item} cols={cols} P={P} /> : runs.map((r, i) => (
        <div key={i}>
          {r.group && <P.Label>{r.group}</P.Label>}
          <div {...cols(false)}>{r.items.map((it) => item(it, false))}</div>
        </div>
      ))}
      {pop && <ItemPop pop={pop} cmd={owner} close={() => setPop(null)} />}
    </div>
  );
}

/** A long gallery as a picker, in the manner of the dictation language picker (SettingsDialog.jsx AddLanguage): a search box
 * that takes the focus as the menu opens, the gallery's groups in a column beside the list (a click jumps to one, the one at the
 * top of the list is marked) and the list in two columns of the wider menu. Typing searches every item's name, description and
 * group as one list. `item(it, two)` draws a row, `cols(two)` a run's grid. */
function LongGallery({ runs, item, cols, P }) {
  const [query, setQuery] = useState('');
  const groups = runs.map((r) => r.group).filter(Boolean);
  const [at, setAt] = useState(groups[0] ?? null);
  const listRef = useRef(null);
  const input = useRef(null);
  // After Radix has put the focus on the menu: the search box takes it, so typing searches.
  useEffect(() => { requestAnimationFrame(() => input.current?.focus()); }, []);
  const q = plain(query);
  const shown = q ? [{ group: null, items: runs.flatMap((r) => r.items).filter((it) => plain(`${it.label} ${it.desc ?? ''} ${it.group ?? ''}`).includes(q)) }] : runs;
  const top = (group) => listRef.current?.querySelector(`[data-gallery-group="${CSS.escape(group)}"]`)?.offsetTop ?? Infinity;
  const jump = (group) => {
    listRef.current.scrollTop = top(group);
    setAt(group);
  };
  const follow = () => {
    const el = listRef.current;
    const last = el.scrollTop + el.clientHeight >= el.scrollHeight - 2; // a short last group never reaches the top
    setAt(last ? groups.at(-1) : groups.findLast((gr) => top(gr) <= el.scrollTop + 8) ?? groups[0]);
  };
  return (
    <div data-long-gallery="" className="flex w-[60rem] max-w-full flex-col">
      <label className="flex items-center gap-2 border-b px-2 pb-1">
        <Search className="size-4 shrink-0 opacity-50" />
        {/* Its keys stay in the box: the menu's type-ahead would take the letters; arrows, Enter and Escape still reach it. */}
        <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" placeholder="Search"
          onKeyDown={(e) => !/^(Arrow(Up|Down)|Enter|Escape|Tab)$/.test(e.key) && e.stopPropagation()}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
      </label>
      <div className="flex min-h-0">
        {!q && groups.length > 1 && (
          <nav aria-label="Groups" className="grid w-40 shrink-0 content-start gap-0.5 border-r p-1">
            {groups.map((gr) => (
              <button key={gr} type="button" tabIndex={-1} onMouseDown={keepFocus} onClick={() => jump(gr)} aria-current={at === gr || undefined} data-gallery-jump={gr}
                className="rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground aria-[current]:bg-accent/60 aria-[current]:text-foreground">
                {gr}
              </button>
            ))}
          </nav>
        )}
        <div ref={listRef} onScroll={q ? undefined : follow} className="relative h-[24rem] min-w-0 flex-1 overflow-y-auto p-1">
          {shown.map((r, i) => (
            <section key={r.group ?? i} data-gallery-group={r.group ?? undefined}>
              {r.group && <P.Label>{r.group}</P.Label>}
              <div {...cols(true)}>{r.items.map((it) => item(it, true))}</div>
            </section>
          ))}
          {!shown.some((r) => r.items.length) && <p className="px-2 py-8 text-center text-sm text-muted-foreground">Nothing matches.</p>}
        </div>
      </div>
    </div>
  );
}

/** A gallery item's own commands (§1.4 GalleryItem.menu), run as run(id, arg ?? item id). */
export function ItemMenu({ it, close }) {
  return (
    <div role="menu" className="flex min-w-40 flex-col">
      {it.menu.map((m) => (
        <PlainItem key={m.id} role="menuitem" data-feature={m.id} onSelect={() => { close(); run(m.id, m.arg ?? it.id); }}>{m.label}</PlainItem>
      ))}
    </div>
  );
}

// Tool search draws an entry's options with the same view (§1.3 setMenuView).
setMenuView(MenuView);
