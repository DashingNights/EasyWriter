// Tab stops of a paragraph (docs/plans/word/plan.md §1.8 Style and numbering data). The tabs package lays them out; the ruler,
// lists and marks read stops only through tabStopsOf. Pure: Node tests load it.
import { styleChain, styleIdOf } from './styles.mjs';

/** Word keeps at most 64 custom tab stops per paragraph. */
export const MAX_TABS = 64;

/** The tab stops of paragraph or heading `node` in `doc`: {stops: [{pos, align, leader}] sorted by pos, at most 64, default: the
 * document's default stop in pt}. The style chain's para.tabs come first (base first), then the node's own tabs; an entry with
 * align 'clear' removes the stop inherited at its position. Positions match to the twip, as Word stores them. */
export function tabStopsOf(doc, node) {
  const at = new Map();
  const apply = (tabs) => {
    for (const t of tabs ?? []) {
      const key = Math.round(t.pos * 20);
      if (t.align === 'clear') at.delete(key);
      else at.set(key, { pos: t.pos, align: t.align ?? 'left', leader: t.leader ?? 'none' });
    }
  };
  for (const s of styleChain(doc, styleIdOf(node))) apply(s.para?.tabs);
  apply(node.attrs?.tabs);
  const stops = [...at.values()].sort((a, b) => a.pos - b.pos).slice(0, MAX_TABS);
  return { stops, default: (doc.attrs ?? doc).settings?.defaultTabStop ?? 36 };
}
