// Table Design's previews: a small table drawn in a table style (the gallery tiles and the Modify Table Style sample), and a
// line drawn in a pen style (Pen Style, Pen Weight and Border Styles). Pure drawing from styles.mjs cellLook; the document
// itself draws through stylesheet.js. Inline styles: the menus are portalled outside every scope a package stylesheet may use.
import { useLayoutEffect, useRef, useState } from 'react';
import { borderCss } from '../../../office.mjs';
import { cellLook } from './styles.mjs';

const DIMS = { rows: 5, cols: 5 };
const LOOK = { firstRow: true, lastRow: false, firstColumn: true, lastColumn: false, noHBand: false, noVBand: true };
const BIG_TEXT = { row: ['', 'Jan', 'Feb', 'Mar', 'Total'], col: ['', 'East', 'West', 'South', 'Total'] };
// A border in the preview: its style and colour at a width that still shows at this scale.
const px = (e, scale) => {
  const css = borderCss(e);
  if (css === 'none') return 'none';
  const [, style, color] = css.split(' ');
  return `${Math.max(1, Math.round(e.width * scale))}px ${style === 'double' && e.width * scale < 2 ? 'solid' : style} ${color}`;
};

/** Style `def` (resolved) on a 5 x 5 table under `look`; `big` draws the dialog's sample with text instead of bars. */
export function MiniTable({ def, look = LOOK, big = false }) {
  const scale = big ? 1.4 : 0.8;
  return (
    <span style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gridTemplateRows: 'repeat(5, 1fr)', background: '#FFFFFF',
      width: big ? '22rem' : '4.6rem', height: big ? '8rem' : '3.2rem', fontSize: big ? 11 : undefined }}>
      {Array.from({ length: DIMS.rows }, (_, r) => Array.from({ length: DIMS.cols }, (_, c) => {
        const l = cellLook(def, r, c, DIMS, look);
        const b = l.borders;
        return (
          <span key={`${r}.${c}`} style={{
            display: 'flex', alignItems: 'center', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', padding: big ? '0 4px' : '0 2px',
            background: l.fill ?? '#FFFFFF', borderTop: px(b.top, scale), borderLeft: px(b.left, scale), borderBottom: px(b.bottom, scale),
            borderRight: px(b.right, scale), color: l.color ?? '#000000', fontWeight: l.bold ? 700 : 400, fontStyle: l.italic ? 'italic' : 'normal',
            justifyContent: { center: 'center', right: 'flex-end' }[l.align] ?? 'flex-start',
          }}>
            {big ? (r === 0 ? BIG_TEXT.row[c] : c === 0 ? BIG_TEXT.col[r] : String(r * 3 + c * 2))
              : <i style={{ display: 'block', height: 2, borderRadius: 1, background: l.color ?? '#000000', width: l.bold ? '70%' : '55%' }} />}
          </span>
        );
      }))}
    </span>
  );
}

/** A gallery tile: the style's sample, with its name beside it where the gallery is a menu list ([data-gallery]); the ribbon's
 * tiles name the style in their tooltip. */
export function StyleTile({ def, label, look }) {
  const ref = useRef(null);
  const [named, setNamed] = useState(false);
  useLayoutEffect(() => setNamed(!!ref.current?.closest('[data-gallery]')), []);
  return (
    <span ref={ref} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <MiniTable def={def} look={look} />{named && <span>{label}</span>}
    </span>
  );
}

/** A line in pen style `style` at `width` pt in `color` (null: black); 'none' shows its label. */
export const PenLine = ({ style, width = 0.75, color = null, label }) => (style === 'none'
  ? <span style={{ fontSize: 12 }}>{label}</span>
  : <span aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', width: '6rem', height: 14 }}>
    <span style={{ display: 'block', width: '100%', height: 0, borderTop: borderCss({ style, width, color }) }} />
  </span>);

/** A Pen Weight row: the label and a line of that width. */
export const WeightLine = ({ label, ...pen }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
    <span style={{ width: '3rem', fontSize: 12 }}>{label}</span><PenLine {...pen} />
  </span>
);
