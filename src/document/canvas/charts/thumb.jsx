// ph-charts-1: a chart type's picture for the Insert Chart and Change Chart Type tiles and the preview. Every kind draws the
// same fixed sample; ph-charts-2 adds a look and a title and legend from its options, so the same picture draws a layout or a
// style.
import { THEME } from '../../defaults.mjs';
import { tokenCss } from './look.mjs';

const SERIES = [
  [3.2, 4.1, 3.6, 5.0],
  [2.0, 2.7, 3.9, 3.3],
  [1.5, 2.2, 2.4, 3.8],
];
const SLICES = [38, 24, 21, 17];
const COLORS = [THEME.colors.accent1, THEME.colors.accent2, THEME.colors.accent3, THEME.colors.accent4];

const X = 4;
const Y = 4;
const W = 56;
const H = 40;
const BASE = Y + H;
const yOf = (v, max) => BASE - (v / max) * H;
const xAt = (i) => X + (i / 3) * W;

const columnMarks = (colors) => {
  const slot = W / 4;
  const out = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      const h = (SERIES[j][i] / 6) * H;
      out.push(<rect key={`${i}-${j}`} x={X + i * slot + 0.8 + j * 4.1} y={BASE - h} width={3.5} height={h} fill={colors[j]} />);
    }
  }
  return out;
};

const stackedColumnMarks = (colors) => {
  const slot = W / 4;
  const out = [];
  for (let i = 0; i < 4; i++) {
    let top = BASE;
    for (let j = 0; j < 3; j++) {
      const h = (SERIES[j][i] / 13) * H;
      top -= h;
      out.push(<rect key={`${i}-${j}`} x={X + i * slot + 4} y={top} width={6} height={h} fill={colors[j]} />);
    }
  }
  return out;
};

const barMarks = (colors) => {
  const slot = H / 4;
  const out = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      const w = (SERIES[j][i] / 6) * W;
      out.push(<rect key={`${i}-${j}`} x={X} y={Y + i * slot + 0.8 + j * 4.1} width={w} height={3.5} fill={colors[j]} />);
    }
  }
  return out;
};

const stackedBarMarks = (colors) => {
  const slot = H / 4;
  const out = [];
  for (let i = 0; i < 4; i++) {
    let x = X;
    for (let j = 0; j < 3; j++) {
      const w = (SERIES[j][i] / 13) * W;
      out.push(<rect key={`${i}-${j}`} x={x} y={Y + i * slot + 2} width={w} height={6} fill={colors[j]} />);
      x += w;
    }
  }
  return out;
};

const lineMarks = (colors) => SERIES.map((values, j) => (
  <polyline key={j} points={values.map((v, i) => `${xAt(i)},${yOf(v, 6)}`).join(' ')} fill="none" stroke={colors[j]} strokeWidth={1.5} />
));

const areaMarks = (colors) => SERIES.map((values, j) => (
  <polygon key={j} points={`${X},${BASE} ${values.map((v, i) => `${xAt(i)},${yOf(v, 6)}`).join(' ')} ${X + W},${BASE}`} fill={colors[j]} />
));

const polar = (r, a) => [32 + r * Math.sin(a), 24 - r * Math.cos(a)];

const pieMarks = (colors) => {
  const total = SLICES.reduce((a, b) => a + b, 0);
  const out = [];
  let start = 0;
  SLICES.forEach((v, i) => {
    const a0 = (start / total) * Math.PI * 2;
    start += v;
    const a1 = (start / total) * Math.PI * 2;
    const [x0, y0] = polar(20, a0);
    const [x1, y1] = polar(20, a1);
    out.push(<path key={i} d={`M 32 24 L ${x0} ${y0} A 20 20 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1} Z`} fill={colors[i]} />);
  });
  return out;
};

const doughnutMarks = (colors) => [...pieMarks(colors), <circle key="hole" cx="32" cy="24" r="10" fill="var(--background)" />];

const scatterMarks = (colors) => {
  const out = [];
  for (let j = 0; j < 2; j++) {
    SERIES[j].forEach((v, i) => out.push(
      <circle key={`${j}-${i}`} cx={X + 2 + (i / 3) * (W - 4)} cy={yOf(v, 6)} r={2} fill={colors[j]} />,
    ));
  }
  return out;
};

const MARKS = {
  column: columnMarks,
  columnStacked: stackedColumnMarks,
  bar: barMarks,
  barStacked: stackedBarMarks,
  line: lineMarks,
  area: areaMarks,
  pie: pieMarks,
  doughnut: doughnutMarks,
  scatter: scatterMarks,
};

/** The picture of chart `type`, `width` × `height` pixels. `colors` defaults to the look's palette, else the theme's first
 * four accents; `look` fills the area and the plot and hides the gridlines; `opts` `{title, legend}` draw a title bar at the
 * top and a legend at `legend` (right, top, left or bottom). */
export function ChartThumb({ type, width = 64, height = 48, colors, look, opts }) {
  const marks = MARKS[type] ?? MARKS.column;
  const tokens = look?.colors?.length ? look.colors : null;
  const palette = tokens ? Array.from({ length: 6 }, (_, i) => tokenCss(tokens[i % tokens.length])) : null;
  const area = tokenCss(look?.area?.fill);
  const plot = tokenCss(look?.plot?.fill);
  const legend = opts?.legend;
  return (
    <svg viewBox="0 0 64 48" width={width} height={height} aria-hidden="true">
      {area !== 'transparent' && <rect x="0" y="0" width="64" height="48" fill={area} />}
      {plot !== 'transparent' && <rect x={X} y={Y} width={W} height={H} fill={plot} />}
      {!look?.noValGrid && [12, 20, 28, 36].map((y) => (
        <line key={y} x1={X} x2={X + W} y1={y} y2={y} stroke="#d9d9d9" strokeWidth={0.5} />
      ))}
      {marks(palette ?? colors ?? COLORS)}
      {opts?.title && <rect x="24" y="2" width="16" height="2" fill="#595959" />}
      {legend && legend !== 'none' && [0, 1, 2].map((i) => {
        const [x, y] = {
          right: [57, 18 + i * 4], left: [1, 18 + i * 4], top: [22 + i * 4, 2], bottom: [22 + i * 4, 45],
        }[legend] ?? [];
        return <rect key={i} x={x} y={y} width={2} height={2} fill={COLORS[i]} />;
      })}
    </svg>
  );
}
