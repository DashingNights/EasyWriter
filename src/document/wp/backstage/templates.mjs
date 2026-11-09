// File > New templates (docs/plans/word/briefs/backstage.md; brief.md decision 12): our own Document content, no Word template
// copied. Each builds block JSON only, so createDraft merges it into newDocumentJson and the new Document keeps its attrs
// (codemap.md §7). Pure: Node tests load it.

const text = (t) => (t ? [{ type: 'text', text: t }] : undefined);
const para = (t, attrs) => ({ type: 'paragraph', ...(attrs && { attrs }), ...(t && { content: text(t) }) });
const h1 = (t) => ({ type: 'heading', attrs: { level: 1 }, content: text(t) });

/** Four left tab stops at equal steps across the text width of `sect` (points), the first a quarter step in, so options A to D
 * line up in four columns. */
export function quizStops(sect) {
  const width = sect.w - sect.margin.left - sect.margin.right;
  const r = (n) => Math.round(n * 20) / 20; // twentieths of a point, Word's twips
  const step = r(width / 4);
  const first = r(step / 4);
  return [0, 1, 2, 3].map((i) => ({ pos: r(first + i * step), align: 'left', leader: 'none' }));
}

const QUESTIONS = [
  ['Which planet is closest to the Sun?', ['Venus', 'Mercury', 'Mars', 'Earth']],
  ['How many sides does a hexagon have?', ['Five', 'Six', 'Seven', 'Eight']],
  ['Which gas do plants take in from the air?', ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Helium']],
];

/** The templates in New's order after Blank document: {id, label, desc, build(sect) → block JSON array}. */
export const TEMPLATES = [
  {
    id: 'report',
    label: 'Report',
    desc: 'A title, a subtitle and headed sections.',
    build: () => [
      para('Report title', { styleId: 'Title' }),
      para('Subtitle or date', { styleId: 'Subtitle' }),
      h1('Introduction'),
      para('Say what the report is about and who it is for.'),
      h1('Findings'),
      para('Set out what you found, one point per paragraph.'),
      h1('Conclusion'),
      para('Say what the findings mean and what should happen next.'),
    ],
  },
  {
    id: 'letter',
    label: 'Letter',
    desc: 'Addresses, a greeting and a closing.',
    build: () => [
      para('Your name'),
      para('Street and number'),
      para('Town and postcode'),
      para(),
      para('Date'),
      para(),
      para('Recipient name'),
      para('Recipient address'),
      para(),
      para('Dear recipient,'),
      para('Write the letter here.'),
      para('Yours sincerely,'),
      para(),
      para('Your name'),
    ],
  },
  {
    id: 'quiz',
    label: 'Multiple-choice quiz',
    desc: 'Numbered questions with options A to D on tab stops.',
    build: (sect) => {
      const tabs = quizStops(sect);
      return [
        para('Quiz', { styleId: 'Title' }),
        para('Name:'),
        ...QUESTIONS.flatMap(([q, opts], i) => [
          para(`${i + 1}. ${q}`, { spacing: { before: 12 } }),
          para(opts.map((o, j) => `\t${'ABCD'[j]}. ${o}`).join(''), { tabs }),
        ]),
      ];
    },
  },
];
