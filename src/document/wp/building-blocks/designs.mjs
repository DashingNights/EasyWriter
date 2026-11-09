// Our own built-in designs (docs/plans/word briefs/building-blocks.md): six cover pages and nine Quick Tables. Names, layouts,
// colours and sample data are ours; only the kinds of Quick Tables follow Word's list. Pure block JSON builders, so node tests
// check every design against the Document schema.

const run = (text, style) => ({ type: 'text', text, ...(style && { marks: [{ type: 'textStyle', attrs: style }] }) });
const para = (content, attrs = {}) => ({ type: 'paragraph', attrs, content: content.filter(Boolean) });
const gap = (before) => para([], { spacing: { before, after: 0 } });

// The six properties a cover binds (content-controls draws the binding; plan.md §1.8 props).
export const COVER_PROPS = [
  ['core.title', 'Document title'], ['core.subject', 'Subtitle'], ['core.creator', 'Author name'], ['cover.publishDate', 'Date'],
  ['app.company', 'Company name'], ['cover.abstract', 'Abstract'],
];
const LABEL = Object.fromEntries(COVER_PROPS);

/** A plain text (or date) content control bound to doc.attrs.props at `prop`, showing its placeholder. */
const bound = (prop, style) => ({
  type: 'sdtInline',
  attrs: {
    sdt: {
      id: '', type: prop === 'cover.publishDate' ? 'date' : 'text', title: LABEL[prop], placeholder: LABEL[prop], showingPlaceholder: true,
      binding: { prop },
      ...(prop === 'cover.publishDate' && { date: { format: 'd MMMM yyyy', lang: 'en-GB', full: null, store: 'dateTime', calendar: 'gregorian' } }),
    },
  },
  content: [run(LABEL[prop], style)],
});

const ink = (color) => (size) => ({ size, color });

/** Cover designs: id → {label, colour (the menu swatch), blocks()}; each holds the six bound controls. */
export const COVERS = {
  plain: {
    label: 'Plain', colour: '#3b3b3b', blocks: () => {
      const s = ink('#262626');
      return [gap(180), para([bound('core.title', s(36))]), para([bound('core.subject', s(16))]), gap(220),
        para([bound('core.creator', s(12))]), para([bound('app.company', s(12))]), para([bound('cover.publishDate', s(12))]), gap(24),
        para([bound('cover.abstract', s(10))])];
    },
  },
  band: {
    label: 'Band', colour: '#1f4e79', blocks: () => {
      const band = { shading: { fill: '#1F4E79', val: 'clear', color: 'auto' }, indent: { left: 0, right: 0 } };
      return [gap(120), para([bound('core.title', ink('#FFFFFF')(34))], { ...band, spacing: { before: 0, after: 0 } }),
        para([bound('core.subject', ink('#DCE6F2')(15))], { ...band, spacing: { before: 0, after: 0 } }), gap(36),
        para([bound('cover.abstract', ink('#404040')(10))]), gap(200), para([bound('core.creator', ink('#1F4E79')(12))]),
        para([bound('app.company', ink('#404040')(11))]), para([bound('cover.publishDate', ink('#404040')(11))])];
    },
  },
  frame: {
    label: 'Frame', colour: '#7a4b12', blocks: () => {
      const edge = { style: 'single', width: 1.5, space: 8, color: '#7A4B12' };
      const box = { borders: { top: edge, bottom: edge, left: edge, right: edge }, textAlign: 'center' };
      return [gap(200), para([bound('core.title', ink('#7A4B12')(32))], box), para([bound('core.subject', ink('#595959')(14))], box), gap(160),
        para([bound('core.creator', ink('#262626')(12))], { textAlign: 'center' }), para([bound('app.company', ink('#595959')(11))], { textAlign: 'center' }),
        para([bound('cover.publishDate', ink('#595959')(11))], { textAlign: 'center' }), gap(24),
        para([bound('cover.abstract', ink('#595959')(10))], { textAlign: 'center' })];
    },
  },
  corner: {
    label: 'Corner', colour: '#2e7d4f', blocks: () => {
      const right = { textAlign: 'right' };
      const rule = { borders: { right: { style: 'single', width: 6, space: 8, color: '#2E7D4F' } }, textAlign: 'right' };
      return [para([bound('cover.publishDate', ink('#2E7D4F')(11))], right), gap(240), para([bound('core.title', ink('#1B4D30')(34))], rule),
        para([bound('core.subject', ink('#2E7D4F')(14))], rule), gap(36), para([bound('cover.abstract', ink('#404040')(10))], right), gap(160),
        para([bound('core.creator', ink('#262626')(12))], right), para([bound('app.company', ink('#404040')(11))], right)];
    },
  },
  split: {
    label: 'Split', colour: '#5b3f8c', blocks: () => {
      const top = { shading: { fill: '#EDE7F6', val: 'clear', color: 'auto' } };
      return [para([bound('app.company', ink('#5B3F8C')(11))], top), para([bound('core.title', ink('#3E2A61')(32))], top),
        para([bound('core.subject', ink('#5B3F8C')(14))], top), para([], top), gap(220),
        para([bound('cover.abstract', ink('#404040')(10))]), gap(24), para([bound('core.creator', ink('#262626')(12))]),
        para([bound('cover.publishDate', ink('#5B3F8C')(11))])];
    },
  },
  stripe: {
    label: 'Stripe', colour: '#b23a3a', blocks: () => {
      const stripe = { borders: { left: { style: 'single', width: 12, space: 12, color: '#B23A3A' } }, indent: { left: 18 } };
      return [gap(160), para([bound('core.title', ink('#B23A3A')(36))], stripe), para([bound('core.subject', ink('#404040')(14))], stripe),
        para([bound('cover.publishDate', ink('#404040')(11))], stripe), gap(200), para([bound('cover.abstract', ink('#404040')(10))]), gap(24),
        para([bound('core.creator', ink('#262626')(12))]), para([bound('app.company', ink('#404040')(11))])];
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Quick Tables

const cell = (text, { head = false, bold = false } = {}) => ({
  type: head ? 'tableHeader' : 'tableCell',
  content: [para(text === '' ? [] : [{ type: 'text', text: String(text), ...((head || bold) && { marks: [{ type: 'bold' }] }) }])],
});
/** A table of `rows` (arrays of cell texts); the first row is a header row when `head`; rows listed in `bold` (indexes) are subheads. */
const table = (rows, { head = true, bold = [] } = {}) => ({
  type: 'table',
  content: rows.map((r, i) => ({ type: 'tableRow', content: r.map((t) => cell(t, { head: head && i === 0, bold: bold.includes(i) })) })),
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The weeks of `month` (0-11) of `year` as rows of seven day numbers ('' outside the month); `sunday` starts weeks on Sunday. */
export function monthWeeks(year, month, { sunday = false } = {}) {
  const first = new Date(year, month, 1).getDay(); // 0 = Sunday
  const lead = sunday ? first : (first + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [...Array(lead).fill(''), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push('');
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

const title = (text, size) => para([run(text, { size, color: '#1F4E79' })]);

/** Quick Tables: id → {label, group, blocks(now)}. The calendars show the month of `now`. */
export const QUICK_TABLES = {
  calendar1: {
    label: 'Calendar 1', blocks: (now) => [title(`${MONTHS[now.getMonth()]} ${now.getFullYear()}`, 20),
      table([DAYS.map((d) => d.slice(0, 3)), ...monthWeeks(now.getFullYear(), now.getMonth())])],
  },
  calendar2: {
    label: 'Calendar 2', blocks: (now) => [title(MONTHS[now.getMonth()], 28),
      table([['Sun', ...DAYS.slice(0, 6).map((d) => d.slice(0, 3))], ...monthWeeks(now.getFullYear(), now.getMonth(), { sunday: true })])],
  },
  calendar3: {
    label: 'Calendar 3', blocks: (now) => [para([run(MONTHS[now.getMonth()], { size: 16, color: '#2E7D4F' }), run(` ${now.getFullYear()}`, { size: 16 })]),
      table([DAYS.map((d) => d[0]), ...monthWeeks(now.getFullYear(), now.getMonth())])],
  },
  calendar4: {
    label: 'Calendar 4', blocks: (now) => [title(`${MONTHS[now.getMonth()].toUpperCase()} ${now.getFullYear()}`, 14),
      table([DAYS, ...monthWeeks(now.getFullYear(), now.getMonth()).map((w) => w.map((d) => (d === '' ? '' : `${d}`)))]),
      para([run('Notes', { size: 11, color: '#595959' })])],
  },
  doubleTable: {
    label: 'Double Table', blocks: () => [para([run('Allotment harvest, kilograms per plot')]),
      table([['Crop', 'Plot A', 'Plot B', 'Crop', 'Plot A', 'Plot B'], ['Beans', '12', '9', 'Leeks', '7', '8'], ['Carrots', '18', '21', 'Onions', '15', '13'],
        ['Courgettes', '25', '19', 'Potatoes', '40', '36'], ['Kale', '6', '8', 'Squash', '22', '17']])],
  },
  matrix: {
    label: 'Matrix', blocks: () => [para([run('Walking time between villages, minutes')]),
      table([['', 'Ashby', 'Brook End', 'Cotley', 'Dunmore'], ['Ashby', '-', '35', '50', '80'], ['Brook End', '35', '-', '20', '55'],
        ['Cotley', '50', '20', '-', '40'], ['Dunmore', '80', '55', '40', '-']])],
  },
  tabularList: {
    label: 'Tabular List', blocks: () => [table([['Item', 'Needed'], ['Tent pegs', '12'], ['Sleeping mats', '4'], ['Head torches', '4'],
      ['Water filter', '1'], ['Camping stove', '1'], ['Gas canisters', '3']])],
  },
  withSubheads1: {
    label: 'With Subheads 1', blocks: () => [para([run('Evening classes, autumn term')]),
      table([['Class', 'Places', 'Booked', 'Waiting'], ['Arts', '', '', ''], ['Pottery', '12', '12', '5'], ['Life drawing', '15', '11', '0'],
        ['Languages', '', '', ''], ['Spanish', '20', '18', '0'], ['Japanese', '14', '14', '3'], ['Total', '61', '55', '8']], { bold: [1, 4, 7] })],
  },
  withSubheads2: {
    label: 'With Subheads 2', blocks: () => [para([run('Bus timetable, weekdays')]),
      table([['Stop', 'Route 4', 'Route 9'], ['Morning', '', ''], ['Market Square', '07:10', '07:25'], ['Station Road', '07:18', '07:40'],
        ['Evening', '', ''], ['Market Square', '17:05', '17:30'], ['Station Road', '17:14', '17:46']], { bold: [1, 4] })],
  },
};
