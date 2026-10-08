// Mermaid flowchart text ↔ the flowchart graph (flowchart plan §3.7, §9 Phase 4; SPEC §6d Formats). Own parser for the
// flowchart subset: `flowchart|graph` TB|TD|BT|LR|RL, bracket shapes and `id@{ shape, label }` (Mermaid v11 shape names),
// links `--> --- -.-> ==> --o --x <--> o--o x--x` (any length, `~~~` skipped), labels `|yes|` and `-- yes -->`, chains and
// `&`, `subgraph … end` (+ `direction`), `classDef` / `class` / `:::` / `style` fills, `%%` comments. Pure: no DOM.
//
// Graph: {dir, nodes: [{id, kind, label, style?}], edges: [{id, from, to, label?, heads: {start, end}, dash, thick?}],
// groups: [{id, kind: 'frame', label, members: [node or group ids], dir?}]}; labels are plain text, '\n' a line break;
// style {fill?, stroke?, text?} (CSS colours). Node positions and sizes (x y w h rot) are graph.mjs's business.

const DIRS = { TB: 'TB', TD: 'TB', BT: 'BT', LR: 'LR', RL: 'RL' };
export const MAX_TEXT = 1_000_000; // import cap (plan §4)

// Bracket shapes ↔ registry kinds; longest opener first. `>text]` (Mermaid's asymmetric shape) has no kind.
const BRACKETS = [
  ['(((', ')))', 'ellipse'], ['((', '))', 'ellipse'], ['([', '])', 'stadium'], ['[[', ']]', 'fr-rect'], ['[(', ')]', 'cyl'],
  ['{{', '}}', 'hex'], ['[/', '/]', 'lean-r'], ['[/', '\\]', 'trap-b'], ['[\\', '\\]', 'lean-l'], ['[\\', '/]', 'trap-t'],
  ['>', ']', null], ['[', ']', 'rect'], ['(', ')', 'round'], ['{', '}', 'diam'],
];
const OPENERS = [...new Set(BRACKETS.map(([o]) => o))];
// Export: these kinds as brackets (the first pair listed for a kind), the others below as `@{ shape }`.
const BRACKET_OF = Object.fromEntries([...BRACKETS].reverse().filter(([, , k]) => k).map(([o, c, k]) => [k, [o, c]]));
BRACKET_OF.ellipse = ['((', '))'];
const SHAPE_OF = Object.fromEntries(['doc', 'docs', 'delay', 'h-cyl', 'curv-trap', 'win-pane', 'sm-circ', 'notch-pent', 'cross-circ',
  'hourglass', 'notch-rect', 'flag', 'brace', 'fork', 'sl-rect', 'bow-rect', 'text'].map((k) => [k, k]).concat([['triangle', 'tri']]));

// Mermaid v11 shape names (short names and their aliases) → kinds ('text': a text item). Others import as rect.
const ALIASES = {
  rect: 'rect', rectangle: 'rect', proc: 'rect', process: 'rect', 'st-rect': 'rect', 'lin-rect': 'rect', 'div-rect': 'rect', 'tag-rect': 'rect',
  rounded: 'round', event: 'round', stadium: 'stadium', pill: 'stadium', terminal: 'stadium',
  'fr-rect': 'fr-rect', subroutine: 'fr-rect', subproc: 'fr-rect', subprocess: 'fr-rect', 'framed-rectangle': 'fr-rect',
  cyl: 'cyl', cylinder: 'cyl', database: 'cyl', db: 'cyl', 'lin-cyl': 'cyl', disk: 'cyl',
  circle: 'ellipse', circ: 'ellipse', 'dbl-circ': 'ellipse', 'double-circle': 'ellipse', 'fr-circ': 'ellipse', 'framed-circle': 'ellipse', stop: 'ellipse',
  diam: 'diam', diamond: 'diam', decision: 'diam', question: 'diam', hex: 'hex', hexagon: 'hex', prepare: 'hex',
  'lean-r': 'lean-r', 'lean-right': 'lean-r', 'in-out': 'lean-r', 'lean-l': 'lean-l', 'lean-left': 'lean-l', 'out-in': 'lean-l',
  'trap-b': 'trap-b', 'trapezoid-bottom': 'trap-b', trapezoid: 'trap-b', priority: 'trap-b',
  'trap-t': 'trap-t', 'trapezoid-top': 'trap-t', 'inv-trapezoid': 'trap-t', manual: 'trap-t',
  doc: 'doc', document: 'doc', 'lin-doc': 'doc', 'tag-doc': 'doc', docs: 'docs', documents: 'docs', 'st-doc': 'docs', 'stacked-document': 'docs',
  delay: 'delay', 'half-rounded-rectangle': 'delay', 'h-cyl': 'h-cyl', das: 'h-cyl', 'horizontal-cylinder': 'h-cyl',
  'curv-trap': 'curv-trap', 'curved-trapezoid': 'curv-trap', display: 'curv-trap',
  'win-pane': 'win-pane', 'window-pane': 'win-pane', 'internal-storage': 'win-pane',
  'sm-circ': 'sm-circ', 'small-circle': 'sm-circ', start: 'sm-circ', 'f-circ': 'sm-circ', 'filled-circle': 'sm-circ', junction: 'sm-circ',
  'notch-pent': 'notch-pent', 'loop-limit': 'notch-pent', 'notched-pentagon': 'notch-pent',
  'cross-circ': 'cross-circ', 'crossed-circle': 'cross-circ', summary: 'cross-circ', hourglass: 'hourglass', collate: 'hourglass',
  'notch-rect': 'notch-rect', card: 'notch-rect', 'notched-rectangle': 'notch-rect', flag: 'flag', 'paper-tape': 'flag',
  brace: 'brace', 'brace-l': 'brace', comment: 'brace', fork: 'fork', join: 'fork',
  'sl-rect': 'sl-rect', 'manual-input': 'sl-rect', 'sloped-rectangle': 'sl-rect',
  'bow-rect': 'bow-rect', 'stored-data': 'bow-rect', tri: 'triangle', triangle: 'triangle', extract: 'triangle', text: 'text',
};

const HEAD_IN = { '<': 'arrow', '>': 'arrow', o: 'circle', x: 'cross' };
const HEAD_OUT = { none: '', arrow: '>', triangle: '>', 'triangle-open': '>', circle: 'o', 'circle-open': 'o', cross: 'x' };
const ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', apos: "'", num: '#', semi: ';' };
const ID = /[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*/uy;
const KEYWORD = /(subgraph|end|direction|classDef|class|style|click|linkStyle|accTitle|accDescr)(?![\p{L}\p{N}_-])/uy;
const SKIPPED = new Set(['click', 'linkStyle', 'accTitle', 'accDescr']);

/** Whether `text` is a Mermaid flowchart: its first line that is not blank or a `%%` comment is `flowchart` or `graph`,
 * optionally with a direction (a paste of such text onto a board offers to import it). */
export const isMermaid = (text) => typeof text === 'string' &&
  /^(?:[ \t]*(?:%%[^\n]*)?\r?\n)*[ \t]*(?:flowchart|graph)(?:[ \t]+(?:TB|TD|BT|LR|RL))?[ \t]*(?:;|%%|\r?\n|$)/.test(text);

// Mermaid label text → plain text: entity codes (#quot; #35;), <br> → '\n'.
const unescape = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/#(\w+);/g, (m, e) => (/^\d+$/.test(e) ? String.fromCodePoint(Number(e)) : ENTITIES[e] ?? m));

/** The graph of Mermaid flowchart `text` → {graph, warnings: [{code, message, line}]}, or {error: {line, col, message}}
 * (1-based) for the first thing it cannot read. Unknown shapes import as rect, skipped statements (click, linkStyle, …)
 * are warnings. */
export function parseMermaid(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) return { error: { line: 1, col: 1, message: 'The text is larger than 1 MB.' } };
  const src = text.replace(/\r\n?/g, '\n');
  let i = 0;
  const where = (k = i) => {
    const before = src.slice(0, k);
    return { line: before.split('\n').length, col: k - before.lastIndexOf('\n') };
  };
  const fail = (message, k = i) => {
    throw Object.assign(new Error(message), { at: where(k) });
  };
  const eat = (re) => {
    re.lastIndex = i;
    const m = re.exec(src);
    if (m) i = re.lastIndex;
    return m;
  };
  const ws = () => eat(/[ \t]*/y);
  const atEnd = () => i >= src.length || src[i] === '\n' || src[i] === ';' || src.startsWith('%%', i);
  const rest = () => eat(/[^;\n]*/y)[0].replace(/%%.*$/, '').trim(); // the rest of the statement
  const quoted = () => (src[i] === '"' ? eat(/"([^"\n]*)"/y)?.[1] ?? fail('Unclosed quote') : null);
  const warnings = [];
  const warn = (code, message, k = i) => warnings.push({ code, message, line: where(k).line });

  const nodes = new Map(); // id → {id, kind, label}
  const edges = [];
  const groups = [];
  const stack = []; // open subgraphs
  const groupOf = new Map(); // node id → the innermost subgraph it was first mentioned in
  const classes = new Map(); // classDef name → style
  const applied = []; // [ids, class name | style] in order
  let dir = 'TB';

  const style = (s) => {
    const out = {};
    for (const part of s.split(',')) {
      const [k, v = ''] = part.split(':').map((x) => x.trim());
      const c = /^#[0-9a-f]{3}$/i.test(v) ? `#${[...v.slice(1)].map((d) => d + d).join('')}` : v;
      if (!/^(#[0-9a-f]{6}|[a-z]+)$/i.test(c)) continue;
      if (k === 'fill') out.fill = c;
      else if (k === 'stroke') out.stroke = c;
      else if (k === 'color') out.text = c;
    }
    return out;
  };

  const shapeData = () => { // after `@{`: a YAML-like map up to the closing brace; shape and label are read
    const m = eat(/((?:[^}"]|"[^"]*")*)\}/y) ?? fail('Unclosed "@{"');
    const out = {};
    for (const [, k, v] of m[1].matchAll(/([\w-]+)\s*:\s*("[^"]*"|[^,\n]*)/g)) out[k] = v.trim().replace(/^"(.*)"$/s, '$1');
    return out;
  };

  const node = () => {
    const k0 = i;
    const id = eat(ID)?.[0] ?? fail('Expected a node id');
    if (stack.length && !groupOf.has(id)) groupOf.set(id, stack.at(-1).id);
    const n = nodes.get(id) ?? nodes.set(id, { id, kind: 'rect', label: id }).get(id);
    const save = i;
    ws();
    if (src.startsWith('@{', i)) {
      i += 2;
      const d = shapeData();
      if (d.shape != null) {
        n.kind = ALIASES[d.shape] ?? 'rect';
        if (!ALIASES[d.shape]) warn('unknown_kind', `Unknown shape "${d.shape}": imported as a box.`, k0);
      }
      if (d.label != null) n.label = unescape(d.label);
    } else {
      const open = OPENERS.find((o) => src.startsWith(o, i));
      if (open) {
        const at = i;
        i += open.length;
        const pairs = BRACKETS.filter(([o]) => o === open);
        const q = quoted();
        let label = q;
        let pair;
        if (q == null) {
          const line = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
          const ends = pairs.map((p) => [src.indexOf(p[1], i), p]).filter(([e]) => e >= 0 && e < line).sort((a, b) => a[0] - b[0]);
          if (!ends.length) fail(`Expected "${pairs[0][1]}" to close the shape`, at);
          [, pair] = ends[0];
          label = src.slice(i, ends[0][0]).trim();
          i = ends[0][0];
        } else pair = pairs.find((p) => src.startsWith(p[1], i)) ?? fail(`Expected "${pairs[0][1]}" after the label`);
        i += pair[1].length;
        n.label = unescape(label);
        n.kind = pair[2] ?? 'rect';
        if (!pair[2]) warn('unknown_kind', 'The asymmetric shape ">text]" was imported as a box.', at);
      } else i = save;
    }
    if (src.startsWith(':::', i)) {
      i += 3;
      applied.push([[id], eat(/[\w-]+/y)?.[0] ?? fail('Expected a class name')]);
    }
    return id;
  };

  const ampersands = () => {
    const ids = [node()];
    for (;;) {
      const save = i;
      ws();
      if (src[i] !== '&') {
        i = save;
        return ids;
      }
      i++;
      ws();
      ids.push(node());
    }
  };

  // A link at i → {heads, dash, thick, label} ({invisible} for ~~~), or null when there is none. As in Mermaid, an o / x
  // right after the line is a head even when glued to the next id (`A---oB`: a circle head to B).
  const link = () => {
    const k0 = i;
    const made = (s, e, kind, label) => ({
      heads: { start: HEAD_IN[s] ?? 'none', end: HEAD_IN[e] ?? 'none' }, dash: kind === 'dotted' ? 'dotted' : 'solid', thick: kind === 'thick', label,
    });
    const kindOf = (line) => (line.includes('.') ? 'dotted' : line[0] === '=' ? 'thick' : 'normal');
    let m = eat(/([<ox]?)(-\.+-|-{2,}|={2,}|~{3,})([>ox]?)/y);
    if (m) {
      const [, s, line, e] = m;
      if (line[0] === '~') return { invisible: true };
      if (line.includes('.') || e || line.length >= 3) {
        const save = i;
        ws();
        if (src[i] !== '|') {
          i = save;
          return made(s, e, kindOf(line), null);
        }
        i++;
        const q = quoted();
        const label = q ?? eat(/[^|\n]*/y)[0].trim();
        if (src[i] !== '|') fail('Expected "|" to close the link label');
        i++;
        return made(s, e, kindOf(line), unescape(label));
      }
      i = k0; // `--` or `==` opening a labelled link
    }
    m = eat(/([<ox]?)(--|==|-\.)/y);
    if (!m) {
      i = k0;
      return null;
    }
    const kind = kindOf(m[2]);
    const close = { normal: /(-{3,})()|(-{2,})([>ox])/g, thick: /(={3,})()|(={2,})([>ox])/g, dotted: /(\.+-)([>ox]?)/g }[kind];
    const lineEnd = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
    close.lastIndex = i;
    const c = close.exec(src);
    if (!c || c.index >= lineEnd) fail(`Expected the end of the link (${kind === 'dotted' ? '.->' : kind === 'thick' ? '==>' : '-->'})`, k0);
    const label = src.slice(i, c.index).trim();
    i = c.index + c[0].length;
    return made(m[1], c[2] || c[4] || '', kind, unescape(label.replace(/^"(.*)"$/s, '$1')));
  };

  const chain = () => {
    let left = ampersands();
    for (;;) {
      const save = i;
      ws();
      const l = link();
      if (!l) {
        i = save;
        return;
      }
      ws();
      const right = ampersands();
      if (!l.invisible) {
        for (const a of left) {
          for (const b of right) {
            edges.push({ id: `e${edges.length + 1}`, from: a, to: b, ...(l.label && { label: l.label }), heads: l.heads, dash: l.dash,
              ...(l.thick && { thick: true }) });
          }
        }
      }
      left = right;
    }
  };

  const statement = () => {
    const k0 = i;
    const kw = eat(KEYWORD)?.[1];
    if (!kw) return chain();
    ws();
    if (kw === 'subgraph') {
      let id;
      let label = quoted();
      if (label == null) {
        id = eat(ID)?.[0] ?? fail('Expected a subgraph id or title');
        ws();
        if (src[i] === '[') {
          i++;
          label = quoted() ?? eat(/[^\]\n]*/y)[0].trim();
          if (src[i] !== ']') fail('Expected "]" to close the subgraph title');
          i++;
        } else {
          const more = rest();
          label = more ? `${id} ${more}` : id;
          if (more) id = null;
        }
      }
      const g = { id: id ?? `subGraph${groups.length}`, kind: 'frame', label: unescape(label), members: [] };
      if (groups.some((x) => x.id === g.id)) fail(`Subgraph "${g.id}" is defined twice`, k0); // one item per id, no nesting cycle
      stack.at(-1)?.members.push(g.id);
      groups.push(g);
      stack.push(g);
    } else if (kw === 'end') {
      if (!stack.pop()) fail('"end" without an open subgraph', k0);
    } else if (kw === 'direction') {
      const d = DIRS[eat(/[A-Z]{2}/y)?.[0]] ?? fail('Expected a direction: TB, TD, BT, LR or RL');
      if (stack.length) stack.at(-1).dir = d;
      else dir = d;
    } else if (kw === 'classDef') {
      const names = eat(/[\w-]+(?:\s*,\s*[\w-]+)*/y)?.[0] ?? fail('Expected a class name');
      ws();
      const s = style(rest());
      for (const name of names.split(',')) classes.set(name.trim(), s);
    } else if (kw === 'class' || kw === 'style') {
      const ids = eat(kw === 'class' ? /[\p{L}\p{N}_.-]+(?:\s*,\s*[\p{L}\p{N}_.-]+)*/uy : ID)?.[0] ?? fail('Expected a node id');
      ws();
      const v = rest();
      if (!v) fail(kw === 'class' ? 'Expected a class name' : 'Expected a style');
      applied.push([ids.split(',').map((s) => s.trim()), kw === 'class' ? v : style(v)]);
    } else if (SKIPPED.has(kw)) {
      rest();
      warn('unsupported', `"${kw}" is not imported.`, k0);
    }
  };

  try {
    const skip = () => eat(/(?:[ \t\n;]|%%[^\n]*)*/y);
    skip();
    if (!eat(/(?:flowchart|graph)(?![\p{L}\p{N}_-])/uy)) fail('Expected "flowchart" or "graph" with a direction, e.g. "flowchart LR"');
    ws();
    const d = eat(/[A-Z]{2}(?![\w-])/y)?.[0];
    if (d) dir = DIRS[d] ?? fail('Expected a direction: TB, TD, BT, LR or RL', i - 2);
    for (;;) {
      ws();
      if (!atEnd()) fail('Expected the end of the line');
      skip();
      if (i >= src.length) break;
      statement();
    }
    if (stack.length) fail(`Subgraph "${stack.at(-1).label}" has no "end"`, src.length);
  } catch (e) {
    if (!e.at) throw e;
    return { error: { ...e.at, message: e.message } };
  }

  const groupIds = new Set(groups.map((g) => g.id));
  const list = [...nodes.values()].filter((n) => !groupIds.has(n.id));
  for (const n of list) if (groupOf.has(n.id)) groups.find((g) => g.id === groupOf.get(n.id)).members.push(n.id);
  const def = classes.get('default');
  for (const n of list) {
    const s = { ...def };
    for (const [ids, c] of applied) if (ids.includes(n.id)) Object.assign(s, typeof c === 'string' ? classes.get(c) : c);
    if (Object.keys(s).length) n.style = s;
  }
  return { graph: { dir, nodes: list, edges, groups }, warnings };
}

// --- export ---

const RESERVED = new Set(['end', 'graph', 'flowchart', 'subgraph', 'direction', 'classDef', 'class', 'style', 'click', 'linkStyle', 'default']);
// A label as Mermaid text: quoted unless plain words; '"' as #quot;, '\n' as <br>.
const label = (s) => {
  const t = String(s ?? '');
  return /^[\p{L}\p{N} ,.?!'_-]+$/u.test(t) && t.trim() === t ? t : `"${t.replace(/"/g, '#quot;').replace(/\n/g, '<br>')}"`;
};

/** Mermaid flowchart text for `graph` → {text, warnings: [{code: 'lossy', message}]}. Mermaid has one label per link, no
 * rotation and fewer shapes and heads: start / end labels and `rot` are left out, kinds without a Mermaid shape become
 * boxes, and a start head is kept only as the mirror of the end head; each is a warning. Ids that are not plain Mermaid
 * ids become n1, n2, … */
export function toMermaid(graph) {
  const warnings = [];
  const lossy = (message) => warnings.some((w) => w.message === message) || warnings.push({ code: 'lossy', message });
  const ids = new Map();
  let next = 1; // the next generated id's number
  const mid = (id) => {
    if (ids.has(id)) return ids.get(id);
    const used = new Set(ids.values());
    let out = id;
    while (!/^[A-Za-z0-9_]+$/.test(out) || RESERVED.has(out) || used.has(out)) out = `n${next++}`;
    ids.set(id, out);
    return out;
  };
  const nodes = graph.nodes ?? [];
  const groups = graph.groups ?? [];
  const known = new Set([...nodes, ...groups].map((n) => n.id));
  const parent = new Map();
  for (const g of groups) for (const m of g.members ?? []) if (known.has(m)) parent.set(m, g.id);
  const lines = [`flowchart ${DIRS[graph.dir] ?? 'TB'}`];
  const nodeLine = (n) => {
    if (n.rot) lossy('Mermaid has no rotation: shapes are not turned.');
    const id = mid(n.id);
    let kind = n.kind;
    if (!BRACKET_OF[kind] && !SHAPE_OF[kind]) {
      lossy('Shapes Mermaid does not have became boxes.');
      kind = 'rect';
    }
    if (SHAPE_OF[kind]) return `${id}@{ shape: ${SHAPE_OF[kind]}, label: "${String(n.label ?? '').replace(/"/g, '#quot;').replace(/\n/g, '<br>')}" }`;
    if (kind === 'rect' && n.label === id) return id;
    const [o, c] = BRACKET_OF[kind];
    return `${id}${o}${label(n.label)}${c}`;
  };
  const byId = new Map([...nodes, ...groups].map((n) => [n.id, n]));
  const emit = (n, pad) => {
    if (!n.members) return void lines.push(pad + nodeLine(n));
    if (n.kind && n.kind !== 'frame') lossy('Swimlanes became subgraphs (frames).');
    lines.push(`${pad}subgraph ${mid(n.id)}${n.label === mid(n.id) ? '' : ` [${label(n.label)}]`}`);
    if (DIRS[n.dir]) lines.push(`${pad}  direction ${DIRS[n.dir]}`);
    for (const m of n.members) if (parent.get(m) === n.id) emit(byId.get(m), `${pad}  `);
    lines.push(`${pad}end`);
  };
  for (const n of [...groups, ...nodes]) if (!parent.has(n.id)) emit(n, '  ');
  for (const e of graph.edges ?? []) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    const sym = (h) => {
      if (h in HEAD_OUT) return HEAD_OUT[h];
      lossy('Heads Mermaid does not have became arrows.');
      return '>';
    };
    const t = sym(e.heads?.end ?? 'arrow');
    let s = sym(e.heads?.start ?? 'none');
    if (s && s !== t) {
      lossy('Mermaid draws a start head only as the mirror of the end head: other start heads were left out.');
      s = '';
    }
    const body = e.dash && e.dash !== 'solid' ? '-.-' : e.thick ? (t ? '==' : '===') : t ? '--' : '---';
    if (e.startLabel || e.endLabel) lossy('Mermaid has one label per link: start and end labels were left out.');
    lines.push(`  ${mid(e.from)} ${s === '>' ? '<' : s}${body}${t}${e.label ? `|${label(e.label)}|` : ''} ${mid(e.to)}`);
  }
  const styled = new Map(); // style text → [ids]
  for (const n of nodes) {
    const s = n.style ?? {};
    const text = [['fill', s.fill], ['stroke', s.stroke], ['color', s.text]].filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(',');
    if (text) styled.set(text, [...(styled.get(text) ?? []), mid(n.id)]);
  }
  [...styled].forEach(([text, list], k) => lines.push(`  classDef s${k + 1} ${text}`, `  class ${list.join(',')} s${k + 1}`));
  return { text: `${lines.join('\n')}\n`, warnings };
}
