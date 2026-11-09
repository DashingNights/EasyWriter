// The numbers behind some chart drawings: Excel's trendline fits with their equation and R², waterfall bars, histogram bins,
// box and whisker statistics, the hierarchy of a treemap or sunburst and the squarified treemap layout. Pure and import-free.

/** Least squares: the coefficients c of y ≈ Σ c[i] row[i] over basis rows `rows` and targets `ys` → c, or null when singular. */
function solve(rows, ys) {
  const n = rows[0]?.length ?? 0;
  // The normal equations AᵀA c = Aᵀy, by Gauss-Jordan elimination with partial pivoting.
  const A = Array.from({ length: n }, (_, i) => [...Array.from({ length: n }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)), rows.reduce((s, r, k) => s + r[i] * ys[k], 0)]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

/**
 * Trendline `t` ({type: 'linear'|'exp'|'log'|'poly'|'power', order, intercept}) through points `pts` ([[x, y]]) → {f(x), coef, r2,
 * held} or null when it has no fit (too few points, or a logarithm of a value at or below zero, where Excel draws none either).
 * coef[i] multiplies X^i of the fitted form: Excel fits exp and power on ln y, log and power on ln x, and gives R² there.
 * ponytail: the normal equations lose precision for a sixth order fit over large x; Excel uses a QR decomposition.
 */
export function fitTrend(t, pts) {
  const type = t.type ?? 'linear';
  const lx = type === 'log' || type === 'power';
  const ly = type === 'exp' || type === 'power';
  if (pts.some(([x, y]) => (lx && x <= 0) || (ly && y <= 0))) return null;
  const X = pts.map(([x]) => (lx ? Math.log(x) : x));
  const Y = pts.map(([, y]) => (ly ? Math.log(y) : y));
  const deg = type === 'poly' ? Math.max(2, Math.min(6, t.order ?? 2)) : 1;
  // A set intercept (linear, poly and exp only, as in Excel) is held: the rest fits Y minus it with no constant term.
  let held = null;
  if (t.intercept != null && (type === 'linear' || type === 'poly' || type === 'exp')) {
    if (type === 'exp' && !(t.intercept > 0)) return null;
    held = type === 'exp' ? Math.log(t.intercept) : t.intercept;
  }
  const from = held == null ? 0 : 1;
  if (pts.length < deg + 1 - from || pts.length < 2) return null;
  const c = solve(X.map((x) => Array.from({ length: deg + 1 - from }, (_, i) => x ** (i + from))), Y.map((y) => y - (held ?? 0)));
  if (!c) return null;
  const coef = held == null ? c : [held, ...c];
  const F = (x) => coef.reduce((s, k, i) => s + k * x ** i, 0);
  // R² about the mean, or about the held intercept (LINEST with no constant).
  const mid = held ?? Y.reduce((a, b) => a + b, 0) / Y.length;
  const tot = Y.reduce((s, y) => s + (y - mid) ** 2, 0);
  const res = Y.reduce((s, y, k) => s + (y - F(X[k])) ** 2, 0);
  return { f: (x) => { const v = F(lx ? Math.log(x) : x); return ly ? Math.exp(v) : v; }, coef, r2: tot ? 1 - res / tot : 1, held: held != null, lx };
}

/** Excel's General in a trendline label: five significant digits, four decimals below 1, E notation outside 0.0001 to 100000. */
export function eqNum(v) {
  const a = Math.abs(v);
  if (a && (a >= 1e5 || a < 1e-4)) return v.toExponential(0).replace(/e([+-])(\d+)$/, (_, s, d) => `E${s}${d.padStart(2, '0')}`);
  return String(+v.toFixed(a >= 1 ? Math.max(0, 4 - Math.floor(Math.log10(a))) : 4));
}

/** The equation of `fit` (fitTrend's) for trendline type `type` in Excel's form → [[text, superscript?]]: y = 2x + 1,
 * y = 0.5x² - 3x + 2, y = 2ln(x) + 1, y = 3e^0.2x, y = 2x^1.5. `fmt` writes each number. */
export function equation(type, fit, fmt = eqNum) {
  const c = fit.coef;
  const term = (k, first) => (first ? `${k < 0 ? '-' : ''}${fmt(Math.abs(k))}` : `${k < 0 ? ' - ' : ' + '}${fmt(Math.abs(k))}`);
  if (type === 'exp') return [[`y = ${fmt(Math.exp(c[0]))}e`], [`${fmt(c[1])}x`, true]];
  if (type === 'power') return [[`y = ${fmt(Math.exp(c[0]))}x`], [fmt(c[1]), true]];
  if (type === 'log') return [[`y = ${term(c[1], true)}ln(x)${term(c[0])}`]];
  const out = [];
  let s = 'y = ';
  for (let i = c.length - 1; i >= 0; i--) {
    if (i === 0 && fit.held && c[0] === 0) break; // a held intercept of zero shows no constant
    s += term(c[i], i === c.length - 1);
    if (!i) continue;
    s += 'x';
    if (i >= 2) { out.push([s], [String(i), true]); s = ''; }
  }
  if (s) out.push([s]);
  return out;
}
/** R² in Excel's form → [[text, superscript?]]. */
export const rSquared = (r2, fmt = eqNum) => [['R'], ['2', true], [` = ${fmt(r2)}`]];

/** The moving average of `period` points over `pts` ([[x, y]]) → [[x, average]] from the period's last point on. */
export function movingAvg(pts, period = 2) {
  const p = Math.max(2, Math.round(period));
  return pts.slice(p - 1).map(([x], i) => [x, pts.slice(i, i + p).reduce((s, q) => s + q[1], 0) / p]);
}

/** A waterfall's bars over `vals`: each point floats from the running total; a subtotal (its index in `totals`) stands from zero at
 * its own value, which the next points float from → [{from, to, kind: 'up'|'down'|'total'} | null]. */
export function waterfall(vals, totals = []) {
  let run = 0;
  return vals.map((v, k) => {
    if (v == null) return null;
    if (totals.includes(k)) {
      run = v;
      return { from: 0, to: v, kind: 'total' };
    }
    const from = run;
    run += v;
    return { from, to: run, kind: v < 0 ? 'down' : 'up' };
  });
}

const edge = (v) => String(+v.toFixed(2));
/** Excel's histogram bins over `vals` (b: {size, count, closed: 'r'|'l', under, over}) → [{label, n}]. Without a size or count the
 * width is Scott's normal reference rule, 3.5 σ / ∛n; bins start at the smallest value (or the underflow), closed on the right.
 * ponytail: bin edges show two decimals, where Excel follows the data's number format. */
export function bins(vals, b = {}) {
  const v = vals.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return [];
  const right = (b.closed ?? 'r') !== 'l';
  const min = b.under ?? v[0];
  const max = b.over ?? v.at(-1);
  let w = b.size;
  if (!(w > 0) && b.count > 0) w = (max - min) / b.count;
  if (!(w > 0)) {
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, v.length - 1));
    w = (3.5 * sd) / Math.cbrt(v.length);
  }
  if (!(w > 0)) w = 1; // every value the same
  const count = b.count > 0 && !(b.size > 0) ? Math.round(b.count) : Math.max(1, Math.ceil((max - min) / w - 1e-9));
  const out = Array.from({ length: count }, (_, i) => {
    const [lo, hi] = [min + i * w, min + (i + 1) * w];
    const closedLo = right ? i === 0 && b.under == null : true;
    const closedHi = right ? true : i === count - 1 && b.over == null;
    return { label: `${closedLo ? '[' : '('}${edge(lo)}, ${edge(hi)}${closedHi ? ']' : ')'}`, n: 0 };
  });
  const under = b.under != null ? { label: `${right ? '≤' : '<'}${edge(b.under)}`, n: 0 } : null;
  const over = b.over != null ? { label: `${right ? '>' : '≥'}${edge(b.over)}`, n: 0 } : null;
  for (const x of v) {
    if (under && (right ? x <= b.under : x < b.under)) under.n++;
    else if (over && (right ? x > b.over : x >= b.over)) over.n++;
    else out[Math.max(0, Math.min(count - 1, right ? Math.ceil((x - min) / w - 1e-9) - 1 : Math.floor((x - min) / w + 1e-9)))].n++;
  }
  return [...(under ? [under] : []), ...out, ...(over ? [over] : [])];
}

/** Quartile `q` of sorted `v` by Excel's exclusive (QUARTILE.EXC) or inclusive (QUARTILE.INC) method. */
export function quartile(v, q, method = 'exclusive') {
  if (!v.length) return null;
  const h = method === 'inclusive' ? (v.length - 1) * q : (v.length + 1) * q - 1; // a 0-based position between two values
  if (h <= 0) return v[0];
  if (h >= v.length - 1) return v.at(-1);
  const i = Math.floor(h);
  return v[i] + (h - i) * (v[i + 1] - v[i]);
}
/** A box and whisker over `vals` → {q1, med, q3, lo, hi (the whiskers: the farthest values within 1.5 IQR), mean, out (outliers),
 * pts (every value, sorted)} or null without values. */
export function boxStats(vals, method) {
  const v = vals.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  const [q1, med, q3] = [0.25, 0.5, 0.75].map((q) => quartile(v, q, method));
  const [f0, f1] = [q1 - 1.5 * (q3 - q1), q3 + 1.5 * (q3 - q1)];
  const inside = v.filter((x) => x >= f0 && x <= f1);
  return { q1, med, q3, lo: inside[0] ?? q1, hi: inside.at(-1) ?? q3, mean: v.reduce((s, x) => s + x, 0) / v.length, out: v.filter((x) => x < f0 || x > f1), pts: v };
}

/**
 * The hierarchy of a treemap or sunburst: category `levels` (outermost first, a [name | null] per level) and sizes `vals` →
 * [{name, value, own, kids}] roots in data order. An empty cell under a named row continues the group above it, and a row ends at
 * its last named level. Sizes at or below zero are left out, as Excel leaves them.
 */
export function treeOf(levels, vals) {
  const roots = [];
  const last = [];
  vals.forEach((v, k) => {
    if (!(v > 0)) return;
    let deepest = -1;
    levels.forEach((lv, d) => { if (lv[k] != null && lv[k] !== '') deepest = d; });
    let list = roots;
    let node = null;
    for (let d = 0; d <= deepest; d++) {
      const name = levels[d][k];
      if (name != null && name !== '') { last[d] = name; last.length = d + 1; }
      const key = last[d] ?? '';
      node = list.find((n) => n.name === key) ?? (list.push({ name: key, value: 0, own: 0, kids: [] }), list.at(-1));
      node.value += v;
      list = node.kids;
    }
    if (node) node.own += v;
  });
  return roots;
}
/** What a node of treeOf divides into: its children, and its own size as one more part when it has both. */
export const partsOf = (n) => (n.kids.length && n.own > 0 ? [...n.kids, { name: n.name, value: n.own, own: n.own, kids: [] }] : n.kids);

/** The squarified treemap layout (Bruls, Huizing and van Wijk) of `sizes` (largest first) in rect {x, y, w, h} → a rect each. */
export function squarify(sizes, rect) {
  const total = sizes.reduce((a, b) => a + Math.max(0, b), 0);
  let { x, y, w, h } = rect;
  if (!(total > 0) || w <= 0 || h <= 0) return sizes.map(() => ({ x, y, w: 0, h: 0 }));
  const areas = sizes.map((s) => (Math.max(0, s) * w * h) / total);
  const out = [];
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const worst = (row) => {
      const s = row.reduce((a, b) => a + b, 0);
      return Math.max((side * side * Math.max(...row)) / (s * s), (s * s) / (side * side * Math.min(...row)));
    };
    const row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && areas[j] > 0 && worst([...row, areas[j]]) <= worst(row)) row.push(areas[j++]);
    const thick = row.reduce((a, b) => a + b, 0) / side;
    let off = 0;
    for (const a of row) {
      const len = thick ? a / thick : 0;
      out.push(w >= h ? { x, y: y + off, w: thick, h: len } : { x: x + off, y, w: len, h: thick });
      off += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i = j;
  }
  return out;
}
