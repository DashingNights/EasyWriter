// Style lookups (docs/plans/word/plan.md §1.8 Style and numbering data). Each work package keeps its built-in style definitions
// in its own module and brings them into a document on first use through ensureStyles. Pure: Node tests load it.

const stylesOf = (doc) => (doc.attrs ?? doc).styles ?? {};

/** The style id paragraph or heading `node` uses: its own styleId, else a heading's HeadingN, else Normal. */
export const styleIdOf = (node) => node.attrs?.styleId ?? (node.type?.name === 'heading' || node.type === 'heading' ? `Heading${node.attrs?.level ?? 1}` : 'Normal');

/** Style `id` of `doc` with its basedOn chain, base first: [{id, ...definition}]; [] for an unknown id. A loop stops at the first
 * style seen twice. */
export function styleChain(doc, id) {
  const list = stylesOf(doc).list ?? {};
  const out = [];
  const seen = new Set();
  for (let s = id; s && list[s] && !seen.has(s); s = list[s].basedOn) {
    seen.add(s);
    out.unshift({ id: s, ...list[s] });
  }
  return out;
}

/** The styles attribute of `doc` with the definitions of `defs` ({[id]: definition}) it lacks added, or null when it has them all.
 * A style the document already holds stays as the user left it. */
export function ensureStyles(doc, defs) {
  const styles = stylesOf(doc);
  const list = styles.list ?? {};
  const add = Object.entries(defs ?? {}).filter(([id]) => !Object.hasOwn(list, id));
  return add.length ? { ...styles, list: { ...list, ...Object.fromEntries(add) } } : null;
}
