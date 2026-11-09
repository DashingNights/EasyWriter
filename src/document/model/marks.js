// Schema v2 marks (docs/plans/word/plan.md §1.8 Marks): comment anchors, tracked insertions, deletions and format changes, and
// editing permissions. Definition, parse and render only; comments, tracking and protect add the behaviour. Each excludes
// nothing, so ranges of the same kind may overlap (two comments on one word, two reviewers' insertions). None writes Markdown:
// doc.get shows their text plain, and scaffold-fields' doc.get leaves deletion-marked text out. The underline colour and the
// link's anchor and tooltip are global attributes in attrs.js.
import { Mark } from '@tiptap/core';
import { readJson } from '../../office.mjs';

// Attributes parsed from a data attribute; each mark's renderHTML writes them all at once.
const str = (data) => ({ default: null, parseHTML: (el) => el.getAttribute(data), renderHTML: () => ({}) });
const json = (data) => ({ default: null, parseHTML: (el) => readJson(el.getAttribute(data)), renderHTML: () => ({}) });
// The revision attributes every tracked change carries, rendered by each mark's renderHTML below.
const REV = { id: str('data-rev'), author: str('data-author'), date: str('data-date') };
const revHtml = ({ id, author, date }) => ({ 'data-rev': id ?? '', ...(author && { 'data-author': author }), ...(date && { 'data-date': date }) });

/** A comment's anchor (w:commentRangeStart to w:commentRangeEnd): id keys doc.attrs.comments. */
const Comment = Mark.create({
  name: 'comment',
  excludes: '',
  inclusive: false,
  addAttributes: () => ({ id: { default: '', parseHTML: (el) => el.getAttribute('data-comment') ?? '', renderHTML: () => ({}) } }),
  parseHTML: () => [{ tag: 'span[data-comment]', consuming: false }],
  renderHTML: ({ mark }) => ['span', { 'data-comment': mark.attrs.id }, 0],
});

/** Tracked inserted text (w:ins; w:moveTo when move names the move). */
const Insertion = Mark.create({
  name: 'insertion',
  excludes: '',
  inclusive: false,
  addAttributes: () => ({ ...REV, move: str('data-move') }),
  parseHTML: () => [{ tag: 'ins[data-rev]', priority: 60 }],
  renderHTML: ({ mark }) => ['ins', { ...revHtml(mark.attrs), ...(mark.attrs.move && { 'data-move': mark.attrs.move }) }, 0],
});

/** Tracked deleted text (w:del with w:delText; w:moveFrom). Its priority beats Strike's del rule. */
const Deletion = Mark.create({
  name: 'deletion',
  excludes: '',
  inclusive: false,
  addAttributes: () => ({ ...REV, move: str('data-move') }),
  parseHTML: () => [{ tag: 'del[data-rev]', priority: 60 }],
  renderHTML: ({ mark }) => ['del', { ...revHtml(mark.attrs), ...(mark.attrs.move && { 'data-move': mark.attrs.move }) }, 0],
});

/** Tracked formatting (w:rPrChange): old holds the marks the text had before, as mark JSON. */
const FormatChange = Mark.create({
  name: 'formatChange',
  excludes: '',
  addAttributes: () => ({ id: str('data-fmt-change'), author: str('data-author'), date: str('data-date'), old: json('data-old') }),
  parseHTML: () => [{ tag: 'span[data-fmt-change]', consuming: false }],
  renderHTML: ({ mark: { attrs: a } }) => ['span', { 'data-fmt-change': a.id ?? '', ...(a.author && { 'data-author': a.author }), ...(a.date && { 'data-date': a.date }),
    ...(a.old && { 'data-old': JSON.stringify(a.old) }) }, 0],
});

/** A range one editor or everyone may change in a protected document (w:permStart, w:permEnd). */
const Permission = Mark.create({
  name: 'permission',
  excludes: '',
  addAttributes: () => ({ id: str('data-perm'), ed: str('data-ed') }),
  parseHTML: () => [{ tag: 'span[data-perm]', consuming: false }],
  renderHTML: ({ mark: { attrs: a } }) => ['span', { 'data-perm': a.id ?? '', ...(a.ed && { 'data-ed': a.ed }) }, 0],
});

export const MARKS_V2 = [Comment, Insertion, Deletion, FormatChange, Permission];
