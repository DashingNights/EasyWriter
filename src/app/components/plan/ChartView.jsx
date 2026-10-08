import { Ban, ChevronDown, ChevronsUp, ChevronUp, CircleCheck, FileText, Flame, Milestone } from 'lucide-react';
import { fmt, fromWork, toDay } from '../../../plan/dates.mjs';
import { ganttLayout } from '../../../plan/gantt-layout.mjs';
import { blockers, cards as cardsOf, columnsOf, doneColumnOf, estimateDays, filterTickets, OPTION_DEFAULTS, statusOf, summary, unitOf } from '../../../plan/plan-model.mjs';
import { schedule } from '../../../plan/schedule.mjs';
import { backlogColumns, backlogRows, chartGantt, KANBAN_COL, KANBAN_GAP, PAD } from '../../../plan-chart.js';

// The plan chart renderer (Gantt plan §7.2): the document NodeView and the rasterizer of src/plan-chart.js draw a plan view
// with it, read-only, in the post colours (`palette`, pagePalette). Inline styles only, so the export looks like the page and
// the page's own CSS (tables, paragraphs) cannot reach it. The Gantt pieces (GanttTicks, GanttGrid, GanttDeps, GanttRows)
// also draw the workspace's Gantt tab (Gantt.jsx) in the app palette.

const PRIORITY = [null, ['Urgent', Flame], ['High', ChevronsUp], ['Medium', ChevronUp], ['Low', ChevronDown]];
const ICON = { size: 13, strokeWidth: 2, style: { flex: 'none' } };
const ROW = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 };
const TRUNC = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
const day = (s) => fmt(toDay(s), 'd MMM');
const dot = (color, p) => ({ width: 9, height: 9, borderRadius: 9, flex: 'none', boxSizing: 'border-box', ...(color ? { background: color } : { border: `1px solid ${p.muted}` }) });
const pill = (color) => ({ padding: '0 5px', borderRadius: 4, fontSize: 11, lineHeight: '16px', background: `${color}33`, color });

function Priority({ t, p }) {
  const [name, Icon] = PRIORITY[t.priority] ?? [];
  return Icon ? <Icon {...ICON} aria-label={name} color={t.priority === 1 ? p.critical : p.muted} /> : null;
}

const Labels = ({ plan, t }) => t.labels.map((id) => plan.labels.find((l) => l.id === id)).filter(Boolean)
  .map((l) => <span key={l.id} style={pill(l.color)}>{l.name}</span>);

const estimate = (plan, t) => (t.estimate == null ? null : `${t.estimate} ${unitOf(plan, t.unit).name}`);

/** One Board card (the workspace card's chips for `fields`; draft cards: title, "draft", pushed). */
function ChartCard({ card, ctx, o, p }) {
  const { plan } = ctx;
  const t = card.ticket;
  const has = (f) => o.fields.includes(f);
  const done = card.status === doneColumnOf(plan);
  const draft = t?.draftId && ctx.drafts.find((d) => d.id === t.draftId);
  const tag = card.status === null && ctx.tags.find((x) => x.id === ctx.draftTags[t ? t.draftId : card.id]);
  const checks = t?.checklist.length ? `${t.checklist.filter((c) => c.done).length}/${t.checklist.length}` : null;
  const chips = [
    t && has('num') && <span key="num">#{t.num}</span>,
    !t && <FileText key="file" {...ICON} />,
    !t && <span key="draft" style={{ border: `1px solid ${p.border}`, borderRadius: 4, padding: '0 4px', fontSize: 10, lineHeight: '14px' }}>draft</span>,
    t?.priority > 0 && has('priority') && <Priority key="prio" t={t} p={p} />,
    t?.labels.length > 0 && has('labels') && <Labels key="labels" plan={plan} t={t} />,
    t?.end && has('due') && <span key="due" style={!done && t.end < ctx.today ? { color: p.critical } : !done && t.end === ctx.today ? { color: p.conflict } : null}>{day(t.end)}</span>,
    checks && has('checklist') && <span key="checks">{checks}</span>,
    t && has('estimate') && estimate(plan, t) && <span key="est">{estimate(plan, t)}</span>,
    t && has('progress') && t.progress > 0 && <span key="prog">{t.progress}%</span>,
    t && has('blocked') && !done && blockers(ctx, t.id).length > 0 && <Ban key="blocked" {...ICON} color={p.conflict} aria-label="Blocked" />,
    draft && has('draft') && <span key="link" style={ROW}><FileText {...ICON} /><span style={{ ...TRUNC, maxWidth: 120 }}>{draft.title || 'Untitled draft'}</span></span>,
    card.pushedAt != null && has('pushed') && <CircleCheck key="pushed" {...ICON} color={p.done} aria-label="Pushed" />,
    tag && <span key="tag" style={{ ...ROW, gap: 3, fontSize: 10 }}><span style={dot(tag.color, p)} />{tag.name}</span>,
  ].filter(Boolean);
  return (
    <div style={{ background: p.card, border: `1px solid ${p.border}55`, borderRadius: 6, padding: 8 }}>
      <div style={{ color: p.strong, fontSize: 13, lineHeight: '17px', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }}>
        {t?.milestone && <Milestone {...ICON} style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }} color={p.muted} />}
        {card.title || 'Untitled'}
      </div>
      {chips.length > 0 && <div style={{ ...ROW, flexWrap: 'wrap', gap: 5, marginTop: 4, color: p.muted, fontSize: 11 }}>{chips}</div>}
    </div>
  );
}

function KanbanChart({ ctx, o, p }) {
  const all = cardsOf(ctx, o);
  return (
    <div style={{ display: 'flex', gap: KANBAN_GAP, alignItems: 'flex-start' }}>
      {columnsOf(ctx, o).map((col) => {
        const list = all.filter((c) => c.status === col.id);
        return (
          <div key={col.id ?? ''} style={{ flex: '1 1 0', minWidth: KANBAN_COL, boxSizing: 'border-box', background: p.panel, borderRadius: 8, padding: 8 }}>
            <div style={{ ...ROW, marginBottom: 8, color: p.strong, fontWeight: 600 }}>
              <span style={dot(col.color, p)} />
              <span style={TRUNC}>{col.name}</span>
              <span style={{ color: p.muted, fontWeight: 400 }}>{list.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {list.map((card) => <ChartCard key={card.id} card={card} ctx={ctx} o={o} p={p} />)}
              {!list.length && <div style={{ color: p.muted, fontSize: 12 }}>No cards</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// One Backlog chart cell; a parent's dates, estimate and progress are its summary (muted).
function Cell({ k, node, ctx, o, p }) {
  const { plan } = ctx;
  const t = node.ticket;
  const sum = node.children.length ? summary(plan, t.id) : null;
  const muted = sum ? { color: p.muted } : null;
  switch (k) {
    case 'num': return <span style={{ color: p.muted }}>#{t.num}</span>;
    case 'title': return (
      <span style={{ ...ROW, paddingLeft: node.depth * 16, color: p.strong }}>
        {t.milestone && <Milestone {...ICON} color={p.muted} />}<span style={TRUNC}>{t.title || 'Untitled'}</span>
      </span>
    );
    case 'status': {
      const col = plan.columns.find((c) => c.id === statusOf(t, ctx));
      return <span style={ROW}><span style={dot(col?.color, p)} /><span style={TRUNC}>{col?.name ?? 'No status'}</span></span>;
    }
    case 'priority': return <span style={ROW}><Priority t={t} p={p} />{PRIORITY[t.priority]?.[0] ?? ''}</span>;
    case 'labels': return <span style={{ ...ROW, flexWrap: 'wrap', gap: 4 }}><Labels plan={plan} t={t} /></span>;
    case 'estimate': return sum ? <span style={muted}>{sum.estimateDays != null ? `${+sum.estimateDays.toFixed(2)} d` : ''}</span> : estimate(plan, t);
    case 'start': case 'end': {
      const v = sum ? sum[k] : t[k];
      return v ? <span style={muted}>{day(v)}</span> : null;
    }
    case 'progress': return <span style={muted}>{`${sum ? sum.progress : t.progress}%`}</span>;
    case 'deps': {
      const blocked = o.fields.includes('blocked') && statusOf(t, ctx) !== doneColumnOf(plan) && blockers(ctx, t.id).length > 0;
      const nums = o.fields.includes('deps') ? t.deps.map((d) => `#${plan.tickets.find((x) => x.id === d.on)?.num}`).join(', ') : '';
      return <span style={ROW}>{blocked && <Ban {...ICON} color={p.conflict} aria-label="Blocked" />}<span style={TRUNC}>{nums}</span></span>;
    }
    case 'draft': {
      const draft = t.draftId && ctx.drafts.find((d) => d.id === t.draftId);
      if (!draft) return null;
      return (
        <span style={ROW}>
          {o.fields.includes('draft') && <><FileText {...ICON} /><span style={TRUNC}>{draft.title || 'Untitled draft'}</span></>}
          {o.fields.includes('pushed') && draft.pushedAt != null && <CircleCheck {...ICON} color={p.done} aria-label="Pushed" />}
        </span>
      );
    }
    case 'checklist': return t.checklist.length ? `${t.checklist.filter((c) => c.done).length}/${t.checklist.length}` : null;
    default: return null;
  }
}

function BacklogChart({ ctx, o, p }) {
  const cols = backlogColumns(o.fields);
  const grid = { display: 'grid', gridTemplateColumns: cols.map(([k, , w]) => (k === 'title' ? `minmax(${w}px, 1fr)` : `${w}px`)).join(' '), alignItems: 'center' };
  const cell = { padding: '5px 6px', minWidth: 0, overflow: 'hidden' };
  const rows = backlogRows(ctx, o);
  return (
    <div style={{ border: `1px solid ${p.border}`, borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ ...grid, background: p.panel, color: p.muted, fontSize: 12, fontWeight: 600 }}>
        {cols.map(([k, label]) => <div key={k} style={{ ...cell, ...TRUNC }}>{label}</div>)}
      </div>
      {rows.map((node) => (
        <div key={node.ticket.id} style={{ ...grid, borderTop: `1px solid ${p.border}66` }}>
          {cols.map(([k]) => <div key={k} style={cell}><Cell k={k} node={node} ctx={ctx} o={o} p={p} /></div>)}
        </div>
      ))}
      {!rows.length && <div style={{ ...cell, color: p.muted, borderTop: `1px solid ${p.border}66` }}>No tickets</div>}
    </div>
  );
}

// --- Gantt (§6.5 drawing; geometry from gantt-layout.mjs) ---

const BAR_H = 18; // gantt-layout's bar band, centred in the 28 px row
const CHAR_W = 6.6; // ≈ px per character at 12 px: titles are fitted without measuring, so the export draws as the editor
const SANS = 'system-ui, Helvetica, Arial, sans-serif';
const barTop = (L, r) => r.y + (L.rowH - BAR_H) / 2;
// Text that reads on a fill: dark on light colours.
const ink = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150 ? '#111111' : '#ffffff';
};
const clip = (text, chars) => (text.length <= chars ? text : `${text.slice(0, Math.max(1, Math.floor(chars) - 3))}...`);

/** A bar's fill: the ticket's first label colour, else its column's, else #555 (No status). */
export function barColor(ctx, t) {
  const label = ctx.plan.labels.find((l) => l.id === t.labels[0]);
  return label?.color ?? ctx.plan.columns.find((c) => c.id === statusOf(t, ctx))?.color ?? '#555555';
}

/** The two header tick rows of a Gantt layout (y 0 … 40); a major label too close to the next one is left out. */
export function GanttTicks({ L, p }) {
  const majors = L.ticks.filter((t) => t.major);
  return (
    <g fontFamily={SANS}>
      {L.ticks.map((t, i) => {
        if (!t.major) return <g key={i}><line x1={t.x} x2={t.x} y1={20} y2={40} stroke={p.border} strokeOpacity={0.6} /><text x={t.x + 3} y={34} fill={p.muted} fontSize={11}>{t.label}</text></g>;
        const next = majors[majors.indexOf(t) + 1];
        return (
          <g key={i}>
            <line x1={t.x} x2={t.x} y1={0} y2={40} stroke={p.border} />
            {(!next || next.x - t.x >= t.label.length * 7 + 8) && <text x={t.x + 4} y={14} fill={p.strong} fontSize={12} fontWeight={600}>{t.label}</text>}
          </g>
        );
      })}
      <line x1={L.left} x2={L.width} y1={39.5} y2={39.5} stroke={p.border} />
    </g>
  );
}

/** Weekend and holiday shading, a line per minor tick, row separators and the dashed today line, below the header. */
export function GanttGrid({ L, p }) {
  const top = L.headerH;
  return (
    <g>
      {L.shading.map((s, i) => <rect key={i} x={s.x} y={top} width={s.w} height={L.height - top} fill={s.kind === 'holiday' ? p.conflict : p.muted} fillOpacity={s.kind === 'holiday' ? 0.18 : 0.12} />)}
      {L.ticks.filter((t) => !t.major).map((t, i) => <line key={i} x1={t.x} x2={t.x} y1={top} y2={L.height} stroke={p.border} strokeOpacity={0.3} />)}
      {L.rows.map((r) => <line key={r.id} x1={0} x2={L.width} y1={r.y + L.rowH - 0.5} y2={r.y + L.rowH - 0.5} stroke={p.border} strokeOpacity={0.25} />)}
      {L.today !== null && <line x1={L.today} x2={L.today} y1={top} y2={L.height} stroke={p.accent} strokeWidth={1.5} strokeDasharray="4 3" />}
    </g>
  );
}

/** Dependency lines with an arrowhead at the successor (critical ones red); `selected` {from, to} is drawn thicker. */
export function GanttDeps({ L, p, selected }) {
  return (
    <g fill="none">
      {L.deps.map((d) => {
        const color = d.critical ? p.critical : p.muted;
        const [tx, ty] = d.points.at(-1);
        const dir = Math.sign(tx - d.points.at(-2)[0]) || 1;
        const sel = selected?.from === d.from && selected?.to === d.to;
        return (
          <g key={`${d.from}>${d.to}`} data-dep={`${d.from}>${d.to}`}>
            <polyline points={d.points.map((pt) => pt.join(',')).join(' ')} stroke={color} strokeWidth={sel ? 3 : 1.5} strokeLinejoin="round" />
            <path d={`M${tx} ${ty}L${tx - dir * 6} ${ty - 3.5}L${tx - dir * 6} ${ty + 3.5}Z`} fill={color} />
          </g>
        );
      })}
    </g>
  );
}

/** The rows of a Gantt layout: bars (first label or column colour, progress darker, title inside when it fits, else after
 * it, before it where it would run past the grid's end, cut to fit), milestone diamonds, parent brackets, baseline ghosts, the
 * critical (red) and conflict (orange) outlines and a Ban glyph on blocked bars. With `sched`, a conflict carries its tooltip (the workspace). */
export function GanttRows({ L, ctx, p, sched }) {
  const byId = new Map(ctx.plan.tickets.map((t) => [t.id, t]));
  return (
    <g fontFamily={SANS} fontSize={12}>
      {L.rows.map((r) => {
        const t = byId.get(r.id);
        const top = barTop(L, r);
        const cy = r.y + L.rowH / 2;
        const { x, w } = r.bar;
        const title = t.title || 'Untitled';
        const outline = r.conflict ? p.conflict : r.critical ? p.critical : null;
        const stroke = outline ? { stroke: outline, strokeWidth: 2 } : {};
        // The title after the bar (from x `a`, past a dependency's 12 px stub), or before it (up to x `b`) when it would run past
        // the grid's end and has more room there; cut to its side, so it is never drawn outside the grid.
        const label = (a, b, props = { fill: p.text }) => {
          const [room, back] = [L.width - a, b - L.left];
          const before = title.length * CHAR_W > room && back > room;
          return <text x={before ? b : a} y={cy + 4} textAnchor={before ? 'end' : undefined} {...props}>{clip(title, (before ? back : room) / CHAR_W)}</text>;
        };
        const tip = r.conflict && sched && <title>{`Starts before its predecessors allow (earliest ${fmt(fromWork(sched.byId[r.id].es, ctx.plan.calendar), 'd MMM')})`}</title>;
        if (r.kind === 'summary') {
          return (
            <g key={r.id} data-bar={r.id}>
              <path d={`M${x} ${top + 13}V${top + 3}H${x + w}V${top + 13}`} fill="none" stroke={p.strong} strokeWidth={3} />
              {label(x + w + 6, x - 6, { fill: p.strong, fontWeight: 600 })}
            </g>
          );
        }
        const color = barColor(ctx, t);
        if (r.kind === 'milestone') {
          return (
            <g key={r.id} data-bar={r.id} data-critical={r.critical || undefined}>
              {tip}
              <path d={`M${x} ${cy - 7}L${x + 7} ${cy}L${x} ${cy + 7}L${x - 7} ${cy}Z`} fill={color} {...stroke} />
              {label(x + 22, x - 22)}
            </g>
          );
        }
        const glyph = r.blocked && w >= 18;
        const inside = title.length * CHAR_W + 12 + (glyph ? 14 : 0) <= w;
        return (
          <g key={r.id} data-bar={r.id} data-critical={r.critical || undefined}>
            {tip}
            {r.baseline && <rect x={r.baseline.x} y={top + BAR_H + 1} width={r.baseline.w} height={4} rx={1} fill={p.muted} fillOpacity={0.6} />}
            <rect x={x} y={top} width={w} height={BAR_H} rx={4} fill={color} {...stroke} />
            {r.progressW > 0 && <rect x={x} y={top} width={r.progressW} height={BAR_H} rx={4} fill="#000000" fillOpacity={0.25} />}
            {glyph && <Ban x={x + 3} y={top + 3} size={12} strokeWidth={2.5} color={ink(color) === '#111111' ? '#b45309' : p.conflict} aria-label="Blocked" />}
            {inside ? <text x={x + (glyph ? 18 : 6)} y={cy + 4} fill={ink(color)}>{title}</text> : label(x + w + 16, x - 16)}
          </g>
        );
      })}
    </g>
  );
}

/** A Gantt chart: the task list (titles by depth, `showTaskList`), the header, the grid, the dependencies and the bars. */
function GanttChart({ ctx, o, p, L }) {
  const rows = L.rows.length ? L.height : L.height + L.rowH;
  return (
    <svg width={L.width} height={rows} style={{ display: 'block', overflow: 'hidden' }}>
      <GanttGrid L={L} p={p} />
      {o.showTaskList && (
        <g fontFamily={SANS}>
          <text x={8} y={34} fill={p.muted} fontSize={11} fontWeight={600}>Task</text>
          {L.rows.map((r) => {
            const t = ctx.plan.tickets.find((x) => x.id === r.id);
            return <text key={r.id} x={8 + r.depth * 12} y={r.y + 18} fontSize={12} fill={r.summary ? p.strong : p.text} fontWeight={r.summary ? 600 : 400}>{clip(t.title || 'Untitled', (L.left - 16 - r.depth * 12) / CHAR_W)}</text>;
          })}
          <line x1={L.left - 0.5} x2={L.left - 0.5} y1={0} y2={rows} stroke={p.border} />
        </g>
      )}
      <GanttTicks L={L} p={p} />
      <GanttDeps L={L} p={p} />
      <GanttRows L={L} ctx={ctx} p={p} />
      {!L.rows.length && <text x={L.left + 8} y={L.headerH + 18} fill={p.muted} fontSize={12} fontFamily={SANS}>No scheduled tickets</text>}
    </svg>
  );
}

/** A plan view drawn read-only: `view` 'kanban' | 'backlog' | 'gantt', `options` the chart options (missing keys: their
 * defaults), `palette` the post colours, `width` the layout width in px (null: the parent's width). Title bar, the view,
 * the label legend and the footer as the options say (a Gantt whose zoom fell back says so in the footer). */
export const VIEW_TITLES = { kanban: 'Kanban Board', backlog: 'Backlog', gantt: 'Gantt Chart' };

export function ChartView({ ctx, view, options, palette: p, width }) {
  const o = { ...OPTION_DEFAULTS, ...options };
  const { plan } = ctx;
  // Gantt: the export layout; a refused one is still drawn (the editor's pill says why).
  let gantt = view === 'gantt' ? chartGantt(ctx, o, width ?? 800) : null;
  if (gantt?.error) gantt = ganttLayout(ctx, schedule(ctx), o, (width ?? 800) - 2 * PAD, { fill: {} }); // still across the node's width
  const title = o.title === '' ? null : o.title || VIEW_TITLES[view]; // a generic name by default, not the plan (thread) title
  const shown = filterTickets(ctx, o);
  const done = doneColumnOf(plan);
  const used = plan.labels.filter((l) => shown.some((t) => t.labels.includes(l.id)));
  const today = toDay(ctx.today);
  const days = shown.reduce((s, t) => s + (estimateDays(plan, t) ?? 0), 0);
  return (
    <div style={{ width: width ? `${width}px` : '100%', boxSizing: 'border-box', padding: PAD, background: p.bg, color: p.text, font: '13px/1.35 system-ui, Helvetica, Arial, sans-serif', textAlign: 'left' }}>
      {title && <div style={{ ...TRUNC, marginBottom: 10, color: p.strong, fontSize: 16, fontWeight: 600 }}>{title}</div>}
      {view === 'kanban' && <KanbanChart ctx={ctx} o={o} p={p} />}
      {view === 'backlog' && <BacklogChart ctx={ctx} o={o} p={p} />}
      {gantt && <GanttChart ctx={ctx} o={o} p={p} L={gantt} />}
      {o.legend && used.length > 0 && (
        <div style={{ ...ROW, flexWrap: 'wrap', marginTop: 10, fontSize: 11, color: p.muted }}>
          Labels: {used.map((l) => <span key={l.id} style={pill(l.color)}>{l.name}</span>)}
        </div>
      )}
      {o.footer && (
        <div style={{ marginTop: 8, color: p.muted, fontSize: 12 }}>
          {[`${shown.length} ticket${shown.length === 1 ? '' : 's'}`, `${shown.filter((t) => statusOf(t, ctx) === done).length} done`,
            ...(days ? [`${+days.toFixed(2)} d estimated`] : []), today !== null && `generated as of ${fmt(today, 'd MMM')} ${fmt(today, 'yyyy')}`, gantt?.note].filter(Boolean).join(', ')}
        </div>
      )}
      {!o.footer && gantt?.note && <div style={{ marginTop: 8, color: p.muted, fontSize: 12 }}>{gantt.note}</div>}
    </div>
  );
}
