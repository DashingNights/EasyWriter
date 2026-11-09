// Author colours and the markup sheet (docs/plans/word/briefs/tracking.md Display for Review): authors in doc.attrs.people order take
// one fixed list of eight colours, and one scoped <style> per editor draws every mark, colour, line, cell, show and people choice
// of settings.word.tracking. Pure: Node tests read it.

/** Eight reviewer colours, readable on a white page and in the dark page theme. */
export const AUTHOR_COLORS = ['#b4009e', '#2b6cd4', '#2e8b57', '#c0392b', '#8e44ad', '#c06000', '#00838f', '#6d7a00'];

/** The colour of author `name`: their place in `people`, or the next free place for a new author. */
export function authorColor(people, name) {
  const i = (people ?? []).findIndex((p) => p.name === name);
  return AUTHOR_COLORS[(i < 0 ? (people ?? []).length : i) % AUTHOR_COLORS.length];
}

// The colours of the Advanced Track Changes Options lists (camelCase names) that CSS does not name the same way.
const NAMED = {
  brightGreen: '#00ff00', darkBlue: '#000080', darkRed: '#800000', darkYellow: '#808000', gray25: '#c0c0c0', gray50: '#808080',
  lightBlue: '#cfe8ff', lightYellow: '#fff4b3', lightOrange: '#ffd8b0', pink: '#ffc8d8', turquoise: '#00ffff', teal: '#008080',
};
const BY_AUTHOR = 'var(--trk-c, #b4009e)';

/** A colour choice → CSS: 'byAuthor' the author's colour, 'auto' the text's own, else the named colour. */
export const colorCss = (c) => (!c || c === 'byAuthor' ? BY_AUTHOR : c === 'auto' ? 'inherit' : NAMED[c] ?? c.toLowerCase());

/** A mark choice ({mark, color}) → CSS declarations for the run. */
export function markCss({ mark = 'none', color = 'byAuthor' } = {}) {
  const c = `color: ${colorCss(color)};`;
  const deco = (d) => `${c} text-decoration: ${d}; text-decoration-color: ${colorCss(color)};`;
  switch (mark) {
    case 'color': return `${c} text-decoration: none;`;
    case 'bold': return `${c} font-weight: bold; text-decoration: none;`;
    case 'italic': return `${c} font-style: italic; text-decoration: none;`;
    case 'underline': return deco('underline');
    case 'dunderline': return deco('underline double');
    case 'strike': return deco('line-through');
    case 'dstrike': return deco('line-through double');
    case 'hidden': return 'display: none;';
    case 'caret': case 'pound': return `${c} font-size: 0; text-decoration: none;`;
    default: return 'color: inherit; text-decoration: none;';
  }
}
const SYMBOL = { caret: '^', pound: '#' };
const PLAIN = 'color: inherit; text-decoration: none; font-weight: inherit; font-style: inherit; font-size: inherit;';

// A paragraph with a change (bars.mjs decorates it).
export const CHANGED = '[data-changed]';

/** The markup sheet of the editor whose root matches `scope`: author colours from `people`, then each Display for Review mode
 * (data-markup on the root) drawn from `t` (settings.word.tracking). */
export function markupCss(scope, t = {}, people = []) {
  const all = `${scope}[data-markup="all"]`;
  const rules = [];
  people.forEach((p, i) => rules.push(`${scope} [data-author="${cssString(p.name)}"] { --trk-c: ${AUTHOR_COLORS[i % AUTHOR_COLORS.length]}; }`));
  const show = t.show ?? {};
  const insDel = show.insDel !== false;
  const run = (sel, m) => {
    rules.push(`${all} ${sel} { ${markCss(m)} }`);
    if (SYMBOL[m?.mark]) rules.push(`${all} ${sel}::before { content: "${SYMBOL[m.mark]}"; font-size: 0.8rem; }`);
  };
  if (insDel) {
    run('ins[data-rev]:not([data-move])', t.ins ?? { mark: 'underline' });
    run('del[data-rev]:not([data-move])', t.del ?? { mark: 'strike' });
    run('ins[data-rev][data-move]', t.moveTo ?? { mark: 'dunderline', color: 'green' });
    run('del[data-rev][data-move]', t.moveFrom ?? { mark: 'dstrike', color: 'green' });
    const cells = t.cells ?? {};
    rules.push(`${all} tr[data-rev*='"ins"'] > :is(td, th) { background: ${colorCss(cells.inserted ?? 'lightBlue')}; }`);
    rules.push(`${all} tr[data-rev*='"del"'] > :is(td, th) { background: ${colorCss(cells.deleted ?? 'pink')}; }`);
  }
  // Insertions and deletions not shown, and those of reviewers the people filter hides, draw as No Markup.
  const hidden = !insDel ? '' : Array.isArray(t.people) ? t.people.map((n) => `:not([data-author="${cssString(n)}"])`).join('') : null;
  if (hidden != null) {
    rules.push(`${all} ins[data-rev]${hidden} { ${PLAIN} }`);
    rules.push(`${all} del[data-rev]${hidden} { display: none; }`);
  }
  if (show.formatting !== false) run('span[data-fmt-change]', t.fmt ?? { mark: 'none' });
  const side = t.lines === 'right' ? 'right' : 'left';
  const bar = (mode, color) => {
    rules.push(`${scope}[data-markup="${mode}"] ${CHANGED} { position: relative; }`);
    // A bordered or shaded paragraph draws its box on ::after (borders/group.js), so its bar goes on ::before; a list paragraph's
    // ::before is its number, so a bordered list paragraph shows no bar.
    // ponytail: no bar on bordered list paragraphs; draw the bars in an overlay if that case matters.
    const at = `${scope}[data-markup="${mode}"] ${CHANGED}`;
    rules.push(`${at}:not([data-bdr])::after, ${at}[data-bdr]:not([data-label])::before { content: ""; position: absolute; top: 0; bottom: 0; ${side}: -14px; width: 2px; background: ${color}; cursor: pointer; }`);
  };
  if (t.lines !== 'none') bar('all', '#808080');
  bar('simple', '#d13438');
  return rules.join('\n');
}

/** `s` safe inside a double-quoted CSS string. */
export const cssString = (s) => String(s ?? '').replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ');
