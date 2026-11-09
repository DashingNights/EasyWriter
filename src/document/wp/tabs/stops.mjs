// Editing a paragraph's tab stops (docs/plans/word/briefs/tabs.md, the Tabs dialog): the list the dialog shows and the own `tabs`
// attribute it writes. Pure: Node tests load it.
import { MAX_TABS } from '../../model/tabs.mjs';

// Word stores positions in twips, so two positions within half a twip are one stop.
export const same = (a, b) => Math.round(a * 20) === Math.round(b * 20);

/** `list` with `stop` set: the same position replaces that stop. → the new sorted list, or null when it already holds 64 stops
 * (Word refuses the 65th). */
export function addStop(list, stop) {
  const rest = list.filter((s) => !same(s.pos, stop.pos));
  if (rest.length >= MAX_TABS) return null;
  return [...rest, stop].sort((a, b) => a.pos - b.pos);
}

/** The own `tabs` attribute that gives a paragraph the stops `list` over the stops `inherited` from its style chain: every listed stop
 * the style lacks or sets differently, and a 'clear' entry for each inherited stop the list drops. → the entries, or null for none. */
export function ownTabs(inherited, list) {
  const out = list.filter((s) => !inherited.some((i) => same(i.pos, s.pos) && i.align === s.align && i.leader === s.leader))
    .map(({ pos, align, leader }) => ({ pos, align, leader }));
  for (const i of inherited) if (!list.some((s) => same(s.pos, i.pos))) out.push({ pos: i.pos, align: 'clear', leader: 'none' });
  return out.length ? out.sort((a, b) => a.pos - b.pos) : null;
}

/** The `tabs` a value-mode Tabs dialog returns (Modify Style, Find Format): the stops `list` it shows, written over `inherited` (the
 * based-on chain's stops, when the caller passed them) as ownTabs does, plus a 'clear' entry for each 'clear' in `given` (the value's
 * own tabs) and each position in `cleared` that the list does not set again. A style's 'clear' entry removes a stop its based-on
 * style holds, so dropping it would bring that stop back in every paragraph of the style. */
export function valueTabs(given, list, cleared, inherited = null) {
  const out = inherited ? ownTabs(inherited, list) ?? [] : list.map(({ pos, align, leader }) => ({ pos, align, leader }));
  const clear = (pos) => { if (![...list, ...out].some((s) => same(s.pos, pos))) out.push({ pos, align: 'clear', leader: 'none' }); };
  for (const t of given ?? []) if (t.align === 'clear') clear(t.pos);
  for (const p of cleared) clear(p);
  return out.sort((a, b) => a.pos - b.pos);
}
