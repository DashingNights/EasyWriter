// Ribbon spec generator (docs/plans/word/plan.md §1.4): `node scripts/word-spec.mjs [planDir]` writes
// src/document/ribbon/spec.mjs and the lucide import block of src/document/ribbon/icons.jsx from the probe (ribbon, menus,
// keytips), index.json and plan.json in the planning folder, with the hand data in scripts/word-spec-data.mjs. The planning
// folder is gitignored, so the output is committed and no src module reads the folder. It fails on an id index.json does not
// know (derived items aside) and on a copy lint failure, and lists the controls without an icon.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { lint as styleLint } from '../src/app/assistant/style-lint.mjs';
import * as D from './word-spec-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLAN_DIR = path.join(ROOT, 'docs/plans/word');
const SPEC = path.join(ROOT, 'src/document/ribbon/spec.mjs');
const ICONS_JSX = path.join(ROOT, 'src/document/ribbon/icons.jsx');

const DENY_RE = new RegExp(`\\b(?:${D.DENY.map((d) => d.replace('.', '\\.')).join('|')})\\b`);
const STYLE_RULES = ['contrast', 'filler', 'hedge', 'intensifiers', 'symbol']; // style-lint.mjs rules that fit a label or a tooltip

/** The copy lint (§1.4 Tips and names) of one label or tip `text` → the problems found, [] when it passes. A tip is our own
 * sentence, so it also meets the assistant's style rules; a label is Word's and keeps its symbols (Rotate Right 90°). */
export function lintText(text, tip = false) {
  const s = String(text ?? '');
  const bare = D.ALLOWED.reduce((t, a) => t.split(a).join(''), s);
  const out = [];
  if (/:\s/.test(s)) out.push('colon pivot');
  if (/[\u2013\u2014]/.test(s)) out.push('dash');
  if (/EasyWriter/.test(s)) out.push('EasyWriter');
  const m = bare.match(DENY_RE);
  if (m) out.push(`names ${m[0]}`);
  if (tip) for (const i of styleLint(s)) if (STYLE_RULES.includes(i.rule)) out.push(`${i.rule} "${i.match}"`);
  // index.json summaries that point at another control are notes for the planner, not tooltips.
  if (tip && (/^(As|Same controls as) /.test(s) || / > /.test(s))) out.push('cross-reference');
  return out;
}

const PROBE_TYPES = { button: 'button', toggle: 'toggle', 'split button': 'split', 'split toggle': 'splitToggle', dropdown: 'dropdown',
  'dropdown list': 'list', 'combo box': 'combo', spinner: 'spinner', 'check box': 'checkbox', edit: 'edit', gallery: 'gallery', list: 'gallery' };
const INDEX_TYPES = { button: 'button', toggle: 'toggle', split: 'split', menu: 'dropdown', gallery: 'gallery', combo: 'combo', edit: 'edit',
  spinner: 'spinner', checkbox: 'checkbox', launcher: 'button', group: 'dropdown', command: 'button', tabs: 'button' };
const TSV_TYPES = { SplitButton: 'split', MenuItem: 'dropdown', Button: 'button', CheckBox: 'checkbox', Spinner: 'spinner', ComboBox: 'combo' };
const MENU_TYPES = ['dropdown', 'split', 'splitToggle', 'list', 'gallery'];
const COLOR_HEADS = ['Gallery Filters', 'Theme Colors', 'Standard Colors', 'Recent Colors'];
const SCALE = 1.25; // the probe's display scale: rect px / 1.25 = CSS px
const REM = 13; // CSS px per rem (app.css html font-size)

/** The KeyTip keys a control or item adds to its parent's: 'Alt, H, F F' → 'F F', 'ALT+B' → 'B'. */
const ownKeys = (k) => {
  if (!k) return undefined;
  if (/^ALT\+.$/i.test(k)) return k.slice(-1).toUpperCase();
  const parts = k.split(', ');
  return parts.length > 1 ? parts.at(-1) : undefined;
};

/** A JSON file of the planning folder (some carry a BOM). */
export const readJson = (f) => {
  const t = fs.readFileSync(f, 'utf8');
  return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
};

/** The owner of a feature id by the longest prefix (§4) in plan.json `plan`: a work package or scaffold id, or
 * 'placeholder:<reason>'. → ownerOf(id) → owner or null. */
export function ownersOf(plan) {
  const owners = [];
  for (const w of plan.wps) for (const p of w.features) owners.push([p, w.id]);
  for (const s of plan.scaffold) for (const p of s.features ?? []) owners.push([p, s.id]);
  for (const [r, ps] of Object.entries(plan.placeholders)) for (const p of ps) owners.push([p, `placeholder:${r}`]);
  return (id) => {
    let best = null;
    for (const [p, o] of owners) if ((id === p || id.startsWith(`${p}.`)) && (!best || p.length > best[0].length)) best = [p, o];
    return best?.[1] ?? null;
  };
}

/** Builds the spec from `planDir` → {spec, errors, lint, noIcon}. Pure apart from reading the planning folder. */
export function buildSpec(planDir = PLAN_DIR) {
  const require = createRequire(import.meta.url);
  const { ribbon, camel, cleanLabel, read } = require(path.join(planDir, 'probe/scripts/ribbon-ids.js'));
  const index = read(path.join(planDir, 'index.json'));
  const plan = read(path.join(planDir, 'plan.json'));
  const tsv = fs.readFileSync(path.join(planDir, 'probe/keytips.tsv'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).slice(1).map((l) => l.split('\t'));
  const { tabs: probeTabs, menus } = ribbon();
  const ix = new Map(index.map((f) => [f.id, f]));
  const errors = [];
  const lintFails = [];
  const noIcon = [];

  // Owners by the longest prefix (§4) decide the placeholder reasons.
  const ownerOf = ownersOf(plan);
  /** `needs` of a feature: its placeholder reason, else 'cloud' for status cloud (its own, or its parent's for a derived item). */
  const needsOf = (id, parent) => {
    const o = ownerOf(id);
    if (o?.startsWith('placeholder:')) return o.slice(12);
    const f = ix.get(id) ?? (parent && ix.get(parent));
    return f?.status === 'cloud' ? 'cloud' : undefined;
  };
  const excluded = (id) => ix.get(id)?.status === 'excluded';
  const canonical = (id) => {
    let f = ix.get(id);
    const seen = new Set();
    while (f?.same && !(f.id in D.SAME) && !seen.has(f.id)) {
      seen.add(f.id);
      f = ix.get(f.same);
    }
    return f?.id ?? id;
  };
  const rename = (label) => {
    const generic = D.RENAMES[label] ?? D.LABELS[label];
    return generic ? { label: generic, wordLabel: label } : { label };
  };
  const firstSentence = (s) => {
    const t = String(s ?? '').replace(/\s*\bEasyWriter('s)?\b/g, '').trim();
    const m = t.match(/^.*?[.!?](?=\s|$)/);
    return (m ? m[0] : t).trim();
  };
  const iconFor = (id, label, fallback) => D.ICON_IDS[id] ?? D.ICONS[label] ?? fallback;

  const CONTROLS = {};
  const ITEMS = {};
  const MENUS = {};
  const builtinsEnd = new Map(); // menu key → the entry index after its last list item that is a feature (the built-ins)

  /** Adds an item to ITEMS (once). */
  const addItem = (id, o) => {
    if (!ITEMS[id]) ITEMS[id] = { id, ...o };
    return id;
  };

  /** An index.json feature as an ITEMS entry. */
  const featureItem = (id, probeItem, menuChecks) => {
    const f = ix.get(id);
    const o = { ...rename(f.label) };
    const icon = D.ICON_IDS[id];
    if (icon) o.icon = icon;
    const kt = ownKeys(probeItem?.keytip || f.keytip);
    if (kt) o.keytip = kt;
    if (probeItem && ('checked' in probeItem || (menuChecks && probeItem.kind === 'listitem'))) o.check = true;
    if (f.dialog && (/\.\.\.|…/.test(probeItem?.name ?? '') || D.HAND_DIALOGS.includes(id))) o.dialog = camel(f.dialog);
    const needs = needsOf(id);
    if (needs) o.needs = needs;
    return addItem(id, o);
  };

  /** A derived item (§1.4): `extra` holds cmd and arg for list items. */
  const derivedItem = (id, name, parent, extra = {}) => {
    const o = { ...rename(cleanLabel(name)), ...extra, derived: true };
    const icon = D.ICON_IDS[id];
    if (icon) o.icon = icon;
    const needs = needsOf(id, parent) ?? (D.CLOUD_LABELS.test(name) ? 'cloud' : undefined);
    if (needs) o.needs = needs;
    return addItem(id, o);
  };

  /** Menu entries of probe `items` for the menu `key`. top: the control's own menu (index.json item ids, the merge-index
   * rule); else a submenu (derived ids). gallery: the id a run of list items that are not features becomes. */
  function menuOf(key, items, { top, menuFile, gallery, derivedList }) {
    const out = [];
    const counted = top ? items.filter((i) => (i.kind === 'listitem' ? D.MERGE_EXPAND.includes(menuFile) : !/heading|separator|text/.test(i.kind))
      && !/^High-contrast only$/.test(i.name) && !/<recent file>/.test(i.name))
      : items.filter((i) => !/heading|separator|text|button/.test(i.kind));
    const idOf = new Map();
    const seen = {};
    for (const i of counted) {
      let iid = camel(i.name);
      if (seen[iid]) iid += ++seen[iid];
      else seen[iid] = 1;
      idOf.set(i, `${key}.${iid}`);
    }
    const colours = items.some((i) => i.kind === 'heading' && i.name === 'Theme Colors');
    const checks = items.some((i) => 'checked' in i);
    let heading = null;
    let galleryAt = -1;
    let panelAt = -1;
    const push = (e) => {
      const prev = out.at(-1);
      const block = (x) => x && ('gallery' in x || 'panel' in x);
      if (prev && block(prev) !== block(e) && !('label' in e) && !('label' in prev)) out.push({ sep: true });
      out.push(e);
    };
    for (const i of items) {
      if (i.kind === 'text') continue;
      if (i.kind === 'button' && /^High-contrast only$/.test(i.name)) {
        if (heading === 'Gallery Filters') heading = null; // the dropped filter row was all the heading had
        continue;
      }
      if (colours && (i.kind === 'listitem' || (i.kind === 'heading' && COLOR_HEADS.includes(i.name)))) {
        if (panelAt < 0) {
          panelAt = out.length;
          push({ panel: 'colors' });
        }
        continue;
      }
      if (i.kind === 'heading') {
        heading = i.name.trim();
        continue;
      }
      const id = idOf.get(i);
      const feature = top && id && ix.has(id);
      if (i.kind === 'listitem' && !feature) { // a gallery run: one entry per control, headings become its groups
        if (derivedList && top) derivedItem(`${key}.${camel(i.name)}`, i.name, key, { cmd: key, arg: camel(i.name) });
        if (galleryAt < 0) {
          galleryAt = out.length;
          push(/^\d+x\d+ Table$/.test(i.name) ? { panel: 'tableGrid' } : { gallery }); // Insert Table's grid
        }
        heading = null;
        continue;
      }
      if (heading) {
        push({ label: heading });
        heading = null;
      }
      if (!id) continue;
      if (top && !feature) {
        if (!/Document\d/.test(i.name)) errors.push(`menu item unknown to index.json: ${id} (${menuFile})`);
        continue;
      }
      if (excluded(id)) continue;
      if (top) featureItem(id, i, checks);
      else if (D.HAND_ITEMS[id]) handItem(id);
      else derivedItem(id, i.name, key);
      const needs = (ITEMS[id] ?? {}).needs;
      if ((i.submenu || i.items) && !needs) {
        MENUS[id] = D.PROVIDER_SUBMENUS.includes(id) || !(i.items ?? []).length ? [{ gallery: id }]
          : menuOf(id, i.items, { top: false, gallery: id });
        push({ sub: id, item: id });
      } else push({ item: id });
      if (top && i.kind === 'listitem') builtinsEnd.set(key, out.length);
    }
    return out;
  }

  function handItem(id) {
    const { menu, at, ...o } = D.HAND_ITEMS[id];
    return addItem(id, { ...o, ...rename(o.label), derived: true });
  }

  /** The type of a control from the probe or index.json. */
  const typeOf = (id, probe) => D.TYPES[id] ?? (probe ? PROBE_TYPES[probe.kind] : INDEX_TYPES[ix.get(id)?.kind]) ?? 'button';

  /** Adds a control to CONTROLS from its index.json feature and, when probed, the probe's control `c`. */
  function addControl(id, c, more = {}) {
    const f = ix.get(id);
    if (!f && !more.extra) {
      errors.push(`control unknown to index.json: ${id}`);
      return null;
    }
    const type = more.type ?? typeOf(id, c);
    const label = more.label ?? f.label;
    const o = { id };
    const canon = more.extra ? id : canonical(id);
    if (canon !== id) o.cmd = canon;
    o.type = type;
    o.size = more.size ?? c?.size ?? D.SIZES[id] ?? 'large';
    Object.assign(o, rename(label));
    o.icon = iconFor(id, label, canon !== id ? CONTROLS[canon]?.icon ?? iconFor(canon, ix.get(canon)?.label) : undefined) ?? more.icon;
    if (!o.icon) {
      noIcon.push(`${id} (${label})`);
      o.icon = 'Square';
    }
    const kt = more.keytip ?? ownKeys(c?.keytip || f?.keytip);
    if (kt) o.keytip = kt;
    const tip = more.tip ?? D.TIPS[id] ?? (canon !== id ? D.TIPS[canon] ?? CONTROLS[canon]?.tip : undefined) ?? firstSentence(f?.summary);
    if (tip) o.tip = tip;
    if (f?.dialog && !/pane$/i.test(f.dialog) && (type === 'button' || /\.launcher$/.test(id))) o.dialog = camel(f.dialog);
    const needs = more.extra ? undefined : needsOf(id);
    if (needs) o.needs = needs;
    if (['combo', 'spinner', 'edit'].includes(type) && c?.rect) o.width = Math.round((c.rect[2] / SCALE / REM) * 2) / 2;
    if (type === 'spinner') o.unit = D.UNITS[id] ?? 'len';
    if (more.extra) o.extra = true;
    CONTROLS[id] = o;
    return o;
  }

  /** Gives a control its menu: the canonical one for a `same` control, the probe's, the hand menu, or a gallery slot. */
  function menuFor(o, c, menuFile) {
    const id = o.id;
    if (D.MENU_OF[id]) {
      o.menu = D.MENU_OF[id];
      return;
    }
    if (o.cmd && !(id in D.HAND_MENUS)) {
      const canon = CONTROLS[o.cmd];
      if (canon?.menu) o.menu = canon.menu;
      else if (MENUS[o.cmd]) o.menu = o.cmd;
      if (o.type === 'gallery' && canon?.gallery) {
        o.gallery = canon.gallery;
        if (canon.grid) o.grid = canon.grid;
      }
      return;
    }
    if (D.HAND_MENUS[id]) {
      MENUS[id] = D.HAND_MENUS[id];
    } else if (menuFile && (menus[menuFile].items ?? []).length) {
      MENUS[id] = menuOf(id, menus[menuFile].items, { top: true, menuFile, gallery: id, derivedList: D.DERIVED_LISTS.includes(id) });
      if (!MENUS[id].length) MENUS[id] = [{ gallery: id }]; // every item was the user's own (Switch Windows lists open windows)
    } else {
      const kids = o.type === 'spinner' ? [] : index.filter((k) => k.parent === id && !excluded(k.id));
      if (kids.length) MENUS[id] = kids.map((k) => ({ item: featureItem(k.id) }));
      else if (MENU_TYPES.includes(o.type) || o.type === 'combo') MENUS[id] = [{ gallery: id }];
    }
    if (MENUS[id] && D.GALLERY_SLOTS[id] && !MENUS[id].some((e) => e.gallery === id)) {
      const m = MENUS[id];
      if (D.GALLERY_SLOTS[id] === 'start') m.unshift({ gallery: id }, { sep: true });
      else m.splice(builtinsEnd.get(id) ?? 0, 0, { gallery: id }, { sep: true });
    }
    if (MENUS[id]) o.menu = id;
    if (o.type === 'gallery' && (c?.items || c?.kind === 'list' || !c)) {
      o.gallery = id;
      if (D.GRIDS[id]) o.grid = D.GRIDS[id];
    }
  }

  // ---- probed tabs
  const tabs = {};
  const groupsDone = new Set();
  for (const t of probeTabs) {
    const groups = [];
    for (const g of t.groups) {
      if (g.org) continue;
      const gid = `${t.tab}.${g.id}`;
      const kept = g.controls.filter(({ id }) => !excluded(`${gid}.${id}`));
      if (!kept.length) continue;
      const parts = new Set();
      for (const { id, c, menuFile } of kept) {
        if (/\.(more|less)$/.test(id)) continue;
        const cid = `${gid}.${id}`;
        const o = addControl(cid, c);
        if (!o) continue;
        if (o.type === 'spinner') {
          const more = `${cid}.more`;
          const less = `${cid}.less`;
          if (ix.has(more) && ix.has(less)) {
            o.parts = { more, less };
            parts.add(`${id}.more`).add(`${id}.less`);
          }
        }
        menuFor(o, c, menuFile);
      }
      const group = { id: gid, ...rename(g.name) };
      const gk = ownKeys(g.keytip);
      if (gk) group.keytip = gk;
      if (g.launcher && !excluded(`${gid}.launcher`)) {
        const lo = addControl(`${gid}.launcher`, { ...g.launcher, kind: 'button', size: 'small' });
        if (lo) {
          group.launcher = lo.id;
          if (lo.cmd && CONTROLS[lo.cmd]?.dialog) lo.dialog = CONTROLS[lo.cmd].dialog;
        }
      }
      group.layout = D.LAYOUTS[gid] ?? layoutOf(gid, kept.filter(({ id }) => !parts.has(id) && CONTROLS[`${gid}.${id}`]));
      groups.push(group);
      groupsDone.add(gid);
    }
    tabs[t.tab] = { id: t.tab, ...rename(t.tabLabel), keytip: t.keytip.replace(/^Alt, /, ''), groups };
  }

  /** Columns of a probed group (§1.4 generation rules). */
  function layoutOf(gid, kept) {
    const cols = new Map();
    for (const k of kept) {
      const n = k.c.col ?? 1;
      if (!cols.has(n)) cols.set(n, []);
      cols.get(n).push(k);
    }
    const ordered = [...cols.keys()].sort((a, b) => a - b).map((n) => cols.get(n));
    const out = [];
    let joined = [];
    const rowNums = (list) => [...new Set(list.map((k) => k.c.row))].filter((r) => r !== 'all').sort((a, b) => a - b);
    const flush = () => {
      if (!joined.length) return;
      const rows = rowNums(joined.flat()).map((r) => joined.flatMap((col) => {
        const inRow = col.filter((k) => k.c.row === r).map((k) => `${gid}.${k.id}`);
        if (inRow.length > 1 && inRow.every((x) => CONTROLS[x].type !== 'combo')) return [inRow];
        return inRow;
      }));
      out.push({ rows });
      joined = [];
    };
    const small = (k) => k.c.size === 'small' || CONTROLS[`${gid}.${k.id}`].type === 'combo';
    for (const col of ordered) {
      if (col.every((k) => k.c.row !== 'all' && small(k))) {
        joined.push(col);
        continue;
      }
      flush();
      const rest = [];
      for (const k of col) {
        const cid = `${gid}.${k.id}`;
        if (k.c.row === 'all') out.push(CONTROLS[cid].gallery ? { gallery: cid } : { large: cid });
        else rest.push(k);
      }
      if (rest.length) out.push({ rows: rowNums(rest).map((r) => rest.filter((k) => k.c.row === r).map((k) => `${gid}.${k.id}`)) });
    }
    flush();
    for (const col of out) {
      const first = col.large ?? col.gallery ?? [col.rows?.[0]?.[0]].flat()[0];
      if (D.CAPTIONS[first]) col.caption = D.CAPTIONS[first];
    }
    return out;
  }

  // ---- where-built tabs and groups (index.json `where` paths, KeyTips from probe/keytips.tsv)
  const tsvKey = (tab, label) => {
    const name = D.KEYTIP_TABS[tab];
    if (!name) return null;
    const row = tsv.find((r) => r[0] === name && r[3]?.replace(/\.\.\.$/, '') === label);
    return row ? { keytip: ownKeys(row[4]), type: TSV_TYPES[row[2]] } : null;
  };
  const whereGroups = new Map();
  for (const f of index) {
    const p = f.id.split('.');
    if (p.length !== 3 || f.parent || !D.TAB_ORDER.includes(p[0]) || excluded(f.id)) continue;
    const gid = `${p[0]}.${p[1]}`;
    if (groupsDone.has(gid) && CONTROLS[f.id]) continue;
    if (CONTROLS[f.id] || /\.(more|less)$/.test(f.id)) continue;
    if (!whereGroups.has(gid)) whereGroups.set(gid, []);
    whereGroups.get(gid).push(f);
  }
  for (const [gid, feats] of whereGroups) {
    const [tab] = gid.split('.');
    if (!tabs[tab]) {
      const w = D.WHERE_TABS[tab];
      if (!w) {
        errors.push(`no tab for where-built group ${gid}`);
        continue;
      }
      tabs[tab] = { id: tab, ...rename(w.label), ...(w.keytip && { keytip: w.keytip }), ...(w.hidden && { hidden: true }), groups: [] };
    }
    let group = tabs[tab].groups.find((g) => g.id === gid);
    if (!group) {
      group = { id: gid, ...rename(feats[0].where.split(' > ')[1].replace(/\s*\[.*$/, '')), layout: [] };
      tabs[tab].groups.push(group);
    }
    for (const f of feats) {
      const k = tsvKey(tab, f.label.replace(/\.\.\.$/, ''));
      const keytip = D.KEYTIPS[f.id] ?? k?.keytip;
      if (/\.launcher$/.test(f.id)) {
        const lo = addControl(f.id, null, { type: 'button', size: 'small', keytip });
        if (lo) group.launcher = lo.id;
        continue;
      }
      const type = D.TYPES[f.id] ?? (f.kind === 'toggle' ? 'toggle' : k?.type && k.type !== 'button' ? k.type : INDEX_TYPES[f.kind]);
      const o = addControl(f.id, null, { type, keytip });
      if (!o) continue;
      menuFor(o, null, null);
      if (!D.LAYOUTS[gid]) group.layout.push(o.gallery ? { gallery: o.id } : o.size === 'large' ? { large: o.id } : { rows: [[o.id]] });
    }
    if (D.LAYOUTS[gid]) group.layout = D.LAYOUTS[gid];
  }

  // ---- EasyWriter's own groups
  for (const x of D.EXTRA_GROUPS) {
    const list = tabs[x.tab].groups;
    const at = list.findIndex((g) => g.id === x.after) + 1;
    for (const c of x.controls) addControl(c.id, null, { ...c, extra: true });
    list.splice(at, 0, { id: x.id, label: x.label, extra: true, layout: x.controls.map((c) => ({ large: c.id })) });
  }

  // Group order where where-built groups joined a probed tab.
  for (const [tab, order] of Object.entries(D.GROUP_ORDER)) {
    tabs[tab].groups.sort((a, b) => order.indexOf(a.id.split('.')[1]) - order.indexOf(b.id.split('.')[1]));
  }

  // ---- frame: QAT, title strip and tab row with their menus
  const frameMenus = Object.fromEntries(Object.entries(D.FRAME_MENUS).map(([file, id]) => [id, file]));
  for (const id of [...D.QAT, ...D.TITLE, ...D.TAB_ROW]) {
    const size = D.QAT.includes(id) ? 'small' : 'medium';
    const o = addControl(id, null, { size, type: id === 'frame.tabRow.editingMode' ? 'dropdown' : undefined });
    if (o) menuFor(o, null, frameMenus[id]);
  }

  for (const key of D.COLOR_MENUS) if (MENUS[key] && !MENUS[key].some((e) => e.panel)) MENUS[key].unshift({ panel: 'colors' }, { sep: true });

  // A `same` control met before its canonical one was built (a where-built canonical) takes its menu now.
  for (const o of Object.values(CONTROLS)) {
    const canon = o.cmd && CONTROLS[o.cmd];
    if (!canon || o.menu || o.id in D.HAND_MENUS) continue;
    if (canon.menu) o.menu = canon.menu;
    if (o.type === 'gallery' && canon.gallery) Object.assign(o, { gallery: canon.gallery }, canon.grid && { grid: canon.grid });
  }

  // ---- hand menus for derived or where-built ids, hand items, derived items of `same` canonical menus
  for (const [key, entries] of Object.entries(D.HAND_MENUS)) {
    if (!MENUS[key] || CONTROLS[key]?.menu !== key) MENUS[key] = entries;
    for (const e of entries) if (e.item && !ITEMS[e.item] && ix.has(e.item)) featureItem(e.item);
  }
  for (const [id, h] of Object.entries(D.HAND_ITEMS)) {
    if (!ITEMS[id]) handItem(id);
    if (h.menu && MENUS[h.menu] && !MENUS[h.menu].some((e) => e.item === id)) MENUS[h.menu].splice(h.at ?? MENUS[h.menu].length, 0, { item: id });
  }
  for (const entries of Object.values(MENUS)) for (const e of entries) if (e.gallery && D.GALLERY_VIEWS[e.gallery]) Object.assign(e, D.GALLERY_VIEWS[e.gallery]);
  for (const [key, entries] of Object.entries(MENUS)) {
    for (const e of entries) {
      if (e.item && !ITEMS[e.item]) errors.push(`menu ${key} holds an unknown item ${e.item}`);
      if (e.sub && !MENUS[e.sub]) errors.push(`menu ${key} opens a missing submenu ${e.sub}`);
    }
  }

  // ---- tabs in Word's order with their contexts
  const TABS = D.TAB_ORDER.filter((t) => tabs[t]).map((t) => {
    const x = tabs[t];
    const out = { id: x.id, label: x.label, ...(x.wordLabel && { wordLabel: x.wordLabel }), keytip: x.keytip ?? '', context: D.CONTEXT_OF[t] ?? null };
    if (D.FIRST_TABS.includes(t)) out.first = true;
    if (x.hidden) out.hidden = true;
    out.groups = x.groups;
    return out;
  });

  // ---- backstage
  const BACKSTAGE = D.BACKSTAGE.map((id) => {
    const f = ix.get(id);
    if (!f) {
      errors.push(`backstage entry unknown to index.json: ${id}`);
      return null;
    }
    const o = { id, ...rename(f.label), kind: f.kind === 'page' ? 'page' : 'command' };
    const kt = ownKeys(f.keytip);
    if (kt) o.keytip = kt;
    const needs = needsOf(id);
    if (needs) o.needs = needs;
    return o;
  }).filter(Boolean);
  const FILE = { id: 'file', label: 'File', keytip: 'F' };

  // ---- features outside the spec that a package may register as commands: their labels for tool search (§1.14)
  const inSpec = new Set([...Object.keys(CONTROLS), ...Object.keys(ITEMS), ...BACKSTAGE.map((b) => b.id)]);
  const FEATURES = {};
  for (const f of index) {
    if (inSpec.has(f.id) || excluded(f.id) || !D.FEATURE_KINDS.includes(f.kind)) continue;
    const area = f.id.split('.')[0];
    if (!D.AREAS[area] && !D.TAB_ORDER.includes(area)) continue;
    const o = { ...rename(f.label), area };
    const needs = needsOf(f.id);
    if (needs) o.needs = needs;
    FEATURES[f.id] = o;
  }

  // ---- checks: every layout id is a control, the lint over every label and tip
  for (const t of TABS) {
    for (const g of t.groups) {
      const ids = g.layout.flatMap((c) => [c.large, c.gallery, ...(c.rows ?? []).flat(2)]).filter(Boolean);
      for (const id of ids) if (!CONTROLS[id]) errors.push(`layout of ${g.id} names a missing control ${id}`);
    }
  }
  const texts = [];
  for (const t of TABS) {
    texts.push([t.id, t.label]);
    for (const g of t.groups) texts.push([g.id, g.label]);
  }
  for (const c of Object.values(CONTROLS)) texts.push([c.id, c.label], [c.id, c.tip, true]);
  for (const i of Object.values(ITEMS)) texts.push([i.id, i.label]);
  for (const b of BACKSTAGE) texts.push([b.id, b.label]);
  for (const [id, f] of Object.entries(FEATURES)) texts.push([id, f.label]);
  for (const [id, text, tip] of texts) {
    if (text == null) continue;
    const problems = lintText(text, tip);
    if (problems.length) lintFails.push(`${id}: ${problems.join(', ')} :: ${text}`);
  }

  const spec = {
    SPEC_VERSION: 1, FILE, QAT: D.QAT, TITLE: D.TITLE, TAB_ROW: D.TAB_ROW, TABS, CONTROLS, ITEMS,
    BLOCK_GALLERIES: D.BLOCK_GALLERIES, MENUS, BACKSTAGE, CONTEXTS: D.CONTEXTS, SHARED_GALLERIES: D.SHARED_GALLERIES, FEATURES, AREAS: D.AREAS,
  };
  return { spec, errors, lint: lintFails, noIcon };
}

/** spec.mjs source text for `spec`: one line per entry, so diffs stay readable. */
export function specSource(spec) {
  const J = (v) => JSON.stringify(v);
  const obj = (o) => `{\n${Object.entries(o).map(([k, v]) => `  ${J(k)}: ${J(v)},`).join('\n')}\n}`;
  const arr = (a) => `[\n${a.map((v) => `  ${J(v)},`).join('\n')}\n]`;
  return [
    '// Word\'s ribbon as data (docs/plans/word/plan.md §1.4). GENERATED by scripts/word-spec.mjs from the probe, index.json and',
    '// plan.json in docs/plans/word and the hand data in scripts/word-spec-data.mjs: never edit it by hand; change the data and',
    '// run `node scripts/word-spec.mjs`. Pure data, so node tests import it.',
    '',
    `export const SPEC_VERSION = ${spec.SPEC_VERSION};`,
    `export const FILE = ${J(spec.FILE)};`,
    `export const QAT = ${J(spec.QAT)};`,
    `export const TITLE = ${J(spec.TITLE)};`,
    `export const TAB_ROW = ${J(spec.TAB_ROW)};`,
    `export const CONTEXTS = ${J(spec.CONTEXTS)};`,
    `export const SHARED_GALLERIES = ${J(spec.SHARED_GALLERIES)};`,
    `export const BLOCK_GALLERIES = ${obj(spec.BLOCK_GALLERIES)};`,
    `export const BACKSTAGE = ${arr(spec.BACKSTAGE)};`,
    `export const TABS = ${arr(spec.TABS)};`,
    `export const CONTROLS = ${obj(spec.CONTROLS)};`,
    `export const ITEMS = ${obj(spec.ITEMS)};`,
    `export const MENUS = ${obj(spec.MENUS)};`,
    '// Features outside the ribbon that packages may register as commands: their labels and areas for tool search (§1.14).',
    `export const AREAS = ${J(spec.AREAS)};`,
    `export const FEATURES = ${obj(spec.FEATURES)};`,
    '',
  ].join('\n');
}

/** Every icon name the spec uses. */
export const iconNames = (spec) => [...new Set([...Object.values(spec.CONTROLS), ...Object.values(spec.ITEMS)].map((x) => x.icon)
  .concat(D.EXTRA_ICONS).filter(Boolean))].sort();

const BEGIN = '// BEGIN lucide icons (generated by scripts/word-spec.mjs)';
const END = '// END lucide icons';

/** icons.jsx `text` with its generated block importing and mapping every lucide icon of `names`. */
export function iconsSource(text, names) {
  const lucide = names.filter((n) => !n.startsWith('own:'));
  const lines = [];
  for (let i = 0; i < lucide.length; i += 8) lines.push(`  ${lucide.slice(i, i + 8).join(', ')},`);
  const block = [BEGIN, 'import {', ...lines, '} from \'lucide-react\';', '', 'const LUCIDE = {', ...lines, '};', END].join('\n');
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < 0) throw new Error('icons.jsx has no generated block');
  return text.slice(0, a) + block + text.slice(b + END.length);
}

async function main() {
  const planDir = process.argv[2] ?? PLAN_DIR;
  const { spec, errors, lint, noIcon } = buildSpec(planDir);
  const L = await import('lucide-react');
  const badIcons = iconNames(spec).filter((n) => !n.startsWith('own:') && !L[n]);
  if (noIcon.length) console.log(`Controls without an icon (${noIcon.length}):\n  ${noIcon.join('\n  ')}`);
  if (badIcons.length) errors.push(...badIcons.map((n) => `not a lucide-react icon: ${n}`));
  if (lint.length) console.error(`Copy lint failures (${lint.length}), add a hand tip or a generic label in scripts/word-spec-data.mjs:\n  ${lint.join('\n  ')}`);
  if (errors.length) console.error(`Errors (${errors.length}):\n  ${errors.join('\n  ')}`);
  if (lint.length || errors.length) process.exit(1);
  fs.writeFileSync(SPEC, specSource(spec));
  fs.writeFileSync(ICONS_JSX, iconsSource(fs.readFileSync(ICONS_JSX, 'utf8'), iconNames(spec)));
  const n = (o) => Object.keys(o).length;
  console.log(`spec.mjs: ${spec.TABS.length} tabs, ${spec.TABS.reduce((s, t) => s + t.groups.length, 0)} groups, ${n(spec.CONTROLS)} controls, ${n(spec.ITEMS)} items, ${n(spec.MENUS)} menus`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
