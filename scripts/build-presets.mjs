// Writes src/flow/preset-data.mjs from the vendored DrawingML preset shape definitions
// (src/vendor/ooxml-presets/presetShapeDefinitions.xml, Apache POI, Apache-2.0), which stays unchanged. Run it again only when that
// file changes: node scripts/build-presets.mjs
// Each preset becomes {av, gd, ah, cxn, rect, path} in the small text forms src/flow/presets.mjs reads:
//   av   {name: value} (avLst, all 'val n')
//   gd   'name op a b c;...' (gdLst in order)
//   ah   'xy refX minX maxX refY minY maxY posX posY;polar refR minR maxR refAng minAng maxAng posX posY' ('-' for an absent value)
//   cxn  'x y ang;...'
//   rect 'l t r b'
//   path [{d, w?, h?, fill?, stroke?}], d in M x y, L x y, A wR hR stAng swAng, Q x1 y1 x y, C x1 y1 x2 y2 x y, Z
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const xml = readFileSync(join(root, 'src/vendor/ooxml-presets/presetShapeDefinitions.xml'), 'utf8');

// A tiny XML reader: the file is regular (no CDATA, comments or text content that matters).
function parse(src) {
  const top = { name: '#root', attrs: {}, kids: [] };
  const stack = [top];
  for (const m of src.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, rest, self] = m;
    if (name.startsWith('?')) continue;
    if (close) { stack.pop(); continue; }
    const attrs = Object.fromEntries([...rest.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
    const n = { name, attrs, kids: [] };
    stack.at(-1).kids.push(n);
    if (!self) stack.push(n);
  }
  return top;
}
const kid = (n, name) => n.kids.find((k) => k.name === name) ?? null;
const kids = (n, name) => (n ? n.kids.filter((k) => !name || k.name === name) : []);

const rootEl = parse(xml).kids.find((k) => k.name === 'presetShapeDefinitons' || k.name === 'presetShapeDefinitions');
// star24's and star32's handle ranges read maxY="ssd2" (a length, half the short side) where their guide pins the same value to
// 50000 (a ratio): the handle would stop near the centre. The data takes 50000, as the guide does.
for (const name of ['star24', 'star32']) {
  for (const h of rootEl.kids.find((k) => k.name === name)?.kids.find((k) => k.name === 'ahLst')?.kids ?? []) if (h.attrs.maxY === 'ssd2') h.attrs.maxY = '50000';
}
// circularArrow with its head no wider than its body (adj5 at 0): the head's corners G and B meet, and the formulas that put the
// arc ends F and C where the head's side crosses the outer and inner ellipse divide by the distance between them (q4, v4), 0. The
// quotient 0 puts F and C at the centre, which rings the shape in two whole ellipses. Word draws those rings too when the same
// formulas come as custom geometry, but its own circularArrow puts F on G and C on B (measured 2026-10-30, the harness case
// shape-geometry-word): the arrow keeps its body and loses its head. Word's leftCircularArrow and leftRightCircularArrow follow
// the formulas.
const circular = rootEl.kids.find((k) => k.name === 'circularArrow')?.kids.find((k) => k.name === 'gdLst');
for (const [name, dist, end] of [['dxF', 'q4', 'x2O'], ['dyF', 'q4', 'y2O'], ['dxC', 'v4', 'x1I'], ['dyC', 'v4', 'y1I']]) {
  const at = circular.kids.findIndex((g) => g.attrs.name === name);
  circular.kids[at].attrs.name = `${name}0`;
  circular.kids.splice(at + 1, 0, { name: 'gd', attrs: { name, fmla: `?: ${dist} ${name}0 ${end}` }, kids: [] });
}
const out = {};
const dash = (v) => (v == null || v === '' ? '-' : v);
for (const p of rootEl.kids) {
  const def = {};
  const av = kids(kid(p, 'avLst'), 'gd');
  if (av.length) {
    def.av = Object.fromEntries(av.map((g) => {
      const m = /^val\s+(-?\d+)$/.exec(g.attrs.fmla.trim());
      if (!m) throw new Error(`${p.name}: avLst ${g.attrs.name} is not a value: ${g.attrs.fmla}`);
      return [g.attrs.name, +m[1]];
    }));
  }
  const gd = kids(kid(p, 'gdLst'), 'gd');
  if (gd.length) def.gd = gd.map((g) => `${g.attrs.name} ${g.attrs.fmla.trim().replace(/\s+/g, ' ')}`).join(';');
  const ah = kids(kid(p, 'ahLst')).map((h) => {
    const pos = kid(h, 'pos').attrs;
    const a = h.attrs;
    return h.name === 'ahXY'
      ? ['xy', a.gdRefX, a.minX, a.maxX, a.gdRefY, a.minY, a.maxY, pos.x, pos.y].map(dash).join(' ')
      : ['polar', a.gdRefR, a.minR, a.maxR, a.gdRefAng, a.minAng, a.maxAng, pos.x, pos.y].map(dash).join(' ');
  });
  if (ah.length) def.ah = ah.join(';');
  const cxn = kids(kid(p, 'cxnLst'), 'cxn').map((c) => `${kid(c, 'pos').attrs.x} ${kid(c, 'pos').attrs.y} ${c.attrs.ang}`);
  if (cxn.length) def.cxn = cxn.join(';');
  const r = kid(p, 'rect');
  if (r) def.rect = `${r.attrs.l} ${r.attrs.t} ${r.attrs.r} ${r.attrs.b}`;
  def.path = kids(kid(p, 'pathLst'), 'path').map((path) => {
    const d = kids(path).map((c) => {
      const pts = kids(c, 'pt').map((q) => `${q.attrs.x} ${q.attrs.y}`).join(' ');
      switch (c.name) {
        case 'moveTo': return `M ${pts}`;
        case 'lnTo': return `L ${pts}`;
        case 'quadBezTo': return `Q ${pts}`;
        case 'cubicBezTo': return `C ${pts}`;
        case 'arcTo': return `A ${c.attrs.wR} ${c.attrs.hR} ${c.attrs.stAng} ${c.attrs.swAng}`;
        case 'close': return 'Z';
        default: throw new Error(`${p.name}: unknown path command ${c.name}`);
      }
    }).join(' ');
    const a = path.attrs;
    return { d, ...(a.w && { w: +a.w }), ...(a.h && { h: +a.h }), ...(a.fill && a.fill !== 'norm' && { fill: a.fill }),
      ...(a.stroke && /^(0|false)$/.test(a.stroke) && { stroke: false }) };
  });
  out[p.name] = def;
}

const body = Object.entries(out).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`).join('\n');
writeFileSync(join(root, 'src/flow/preset-data.mjs'), `// Generated by scripts/build-presets.mjs from src/vendor/ooxml-presets/presetShapeDefinitions.xml (Apache POI, Apache-2.0;
// LICENSE and NOTICE beside it): the ${Object.keys(out).length} DrawingML preset shapes as data for src/flow/presets.mjs. Do not edit by hand.
export const PRESETS = {
${body}
};
`);
console.log(`${Object.keys(out).length} presets`);
