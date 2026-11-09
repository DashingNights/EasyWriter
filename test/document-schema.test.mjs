import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor, getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { MarkdownManager } from '@tiptap/markdown';
import { Marked } from 'marked';
import { documentExtensions } from '../src/document/schema.js';
import { DOC_DEFAULTS, DOC_SETTINGS, newDocumentJson, THEME } from '../src/document/defaults.mjs';
import { kitOf } from '../src/editors.js';
import { borderRules, runCss, styleSheetCss } from '../src/document/stylesheet.js';

// Document schema v2 (docs/plans/document.md Version guard; docs/plans/word/plan.md §1.8): ProseMirror drops unknown attributes
// and TipTap blanks a doc with an unknown node, so a build that reads an older or newer Document must agree on these names.
// formatVersion 2, which a save in the DOM editor stamps (engine/model/form.mjs DOM_VERSION). formats.mjs DOCUMENT.version is 3
// for the canvas form, which keeps the engine's model rather than this schema. The schema freezes at the Word-parity merge gate,
// after which any change here needs a new DOM_VERSION above every version this build reads, and DOCUMENT.version with it. Kit-only nodes (canvas, planChart) and the suggest attribute are pinned by the scaffold-model
// harness case from the running app.
const RUN_V2 = ['border', 'caps', 'charStyle', 'cs', 'dstrike', 'eastAsianLayout', 'effects', 'em', 'emboss', 'fitText', 'fontCS', 'fontEA', 'hint', 'imprint',
  'kern', 'lang', 'noProof', 'outline', 'position', 'rtl', 'scale', 'shading', 'shadow', 'sizeCS', 'smallCaps', 'spacing', 'typography', 'vanish', 'webHidden'];
const PARA = ['asian', 'bidi', 'borders', 'collapsed', 'contextual', 'frame', 'indent', 'keepLines', 'keepNext', 'markRev', 'markRun', 'mirrorIndents', 'numbering',
  'outline', 'pChange', 'pageBreakBefore', 'shading', 'snapToGrid', 'spacing', 'specVanish', 'styleId', 'suppressAutoHyphens', 'suppressLineNumbers',
  'tabs', 'textAlign', 'tightWrap', 'widowControl'];
const CELL = ['align', 'borders', 'colspan', 'colwidth', 'fitText', 'hideMark', 'margins', 'noWrap', 'rowspan', 'shading', 'textDir', 'vAlign'];
const PINNED = {
  nodes: {
    doc: ['background', 'comments', 'merge', 'numbering', 'people', 'props', 'sect', 'settings', 'styles', 'theme', 'vars'],
    paragraph: PARA,
    heading: [...PARA, 'level'].sort(),
    text: [],
    hardBreak: ['clear'],
    table: ['align', 'bidiVisual', 'borders', 'caption', 'cellMargin', 'cellSpacing', 'description', 'float', 'indent', 'layout', 'look', 'styleId', 'width'],
    tableRow: ['cantSplit', 'header', 'height', 'rev', 'tblPrEx'],
    tableHeader: CELL,
    tableCell: CELL,
    pageBreak: ['rev'],
    image: ['adjust', 'alt', 'border', 'crop', 'cstate', 'decorative', 'effects', 'fallback', 'flipH', 'flipV', 'height', 'ink', 'layout', 'metafile', 'name', 'orig',
      'rotate', 'src', 'style', 'themeColors', 'title', 'width'],
    chart: ['alt', 'h', 'layout', 'model', 'name', 'parts', 'w'],
    field: ['code', 'dirty', 'ff', 'locked', 'result', 'runs'],
    fieldBlock: ['code', 'dirty', 'locked', 'rev'],
    bookmark: ['end', 'id', 'name'],
    noteRef: ['content', 'id', 'kind', 'mark'],
    sectionBreak: ['kind', 'rev', 'sect'],
    columnBreak: ['rev'],
    columns: ['count', 'equal', 'rev', 'sep', 'space', 'widths'],
    textBox: ['alt', 'autoFit', 'decorative', 'dir', 'effects', 'fill', 'gradient', 'h', 'hidden', 'id', 'inset', 'layout', 'line', 'link', 'name', 'noWrap', 'overflow', 'rev',
      'rotate', 'run', 'style', 'styleRefs', 'themeColors', 'upright', 'vAlign', 'w'],
    equation: ['align', 'display', 'linear', 'math', 'mml', 'omml'],
    sdtInline: ['sdt'],
    sdtBlock: ['rev', 'sdt'],
    ruby: ['align', 'base', 'font', 'hint', 'lang', 'offset', 'size', 'text'],
    ptab: ['align', 'leader', 'relativeTo'],
  },
  marks: {
    bold: [], italic: [], strike: [], subscript: [], superscript: [],
    underline: ['color', 'val'],
    link: ['anchor', 'class', 'frame', 'href', 'rel', 'target', 'title', 'tooltip'],
    textStyle: [...RUN_V2, 'color', 'font', 'highlight', 'size', 'themeColor'].sort(),
    comment: ['id'],
    insertion: ['author', 'date', 'id', 'move'],
    deletion: ['author', 'date', 'id', 'move'],
    formatChange: ['author', 'date', 'id', 'old'],
    permission: ['ed', 'id'],
  },
};

const schema = getSchema(documentExtensions(50));
const names = (types) => Object.fromEntries(Object.entries(types).map(([n, t]) => [n, Object.keys(t.spec.attrs ?? {}).sort()]));

test('the Document schema holds exactly the pinned nodes, marks and attributes', () => {
  assert.deepEqual(names(schema.nodes), PINNED.nodes);
  assert.deepEqual(names(schema.marks), PINNED.marks);
});

// The forum post's kit (src/editors.js) shares no Document code, and forum posts must stay as they are (plan.md §1.8): its nodes
// with their group, content and attributes, and its marks with theirs.
const FORUM = {
  nodes: {
    paragraph: 'block|inline*|suggest,textAlign', blockquote: 'block|block+|suggest', bulletList: 'block list|listItem+|suggest',
    codeBlock: 'block|text*|language,suggest', doc: '|block+|suggest', hardBreak: 'inline||', heading: 'block|inline*|level,suggest,textAlign',
    horizontalRule: 'block||suggest', listItem: '|paragraph block*|', orderedList: 'block list|listItem+|start,suggest,type', text: 'inline||',
    table: 'block|tableRow+|suggest', tableRow: '|(tableCell | tableHeader)*|', tableHeader: '|block+|align,colspan,colwidth,rowspan',
    tableCell: '|block+|align,colspan,colwidth,rowspan', box: 'block|boxTitle boxContent|suggest', boxTitle: '|inline*|', boxContent: '|block+|',
    canvas: 'block||bg,dw,flow,frame,h,items,source,suggest,w', planChart: 'block||dw,frozen,id,options,planId,suggest,view', media: 'block||dw,name,src,suggest',
  },
  marks: { link: 'class,href,rel,target,title', bold: '', code: '', italic: '', strike: '', underline: '', subscript: '', superscript: '', fontSize: 'size',
    textColor: 'color', highlight: 'color', fontFamily: 'font' },
};

test('the forum post kit keeps its schema', () => {
  const s = kitOf('forum-post').schema;
  const keys = (t) => Object.keys(t.spec.attrs ?? {}).sort().join(',');
  assert.deepEqual(Object.fromEntries(Object.entries(s.nodes).map(([n, t]) => [n, `${t.spec.group ?? ''}|${t.spec.content ?? ''}|${keys(t)}`])), FORUM.nodes);
  assert.deepEqual(Object.fromEntries(Object.entries(s.marks).map(([n, t]) => [n, keys(t)])), FORUM.marks);
});

/** Whether JSON `out` holds everything `given` holds (objects key by key, arrays item by item): attributes left out of `given`
 * take their defaults in `out`. */
function holds(out, given, at = '') {
  if (at.endsWith('.marks')) { // ProseMirror orders a text's marks by their rank in the schema
    const byType = (a, b) => a.type.localeCompare(b.type);
    return holds([...out ?? []].sort(byType), [...given].sort(byType), `${at}*`);
  }
  if (Array.isArray(given)) {
    assert.equal(out?.length, given.length, `${at} length`);
    given.forEach((g, i) => holds(out[i], g, `${at}[${i}]`));
  } else if (given && typeof given === 'object') {
    for (const [k, v] of Object.entries(given)) holds(out?.[k], v, `${at}.${k}`);
  } else assert.deepEqual(out, given, at);
}

const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const p = (text, attrs) => ({ type: 'paragraph', ...(attrs && { attrs }), content: text ? [t(text)] : [] });

test('a v1 doc loads in schema v2 and keeps every v1 attribute; the new ones take their defaults', () => {
  const doc = {
    type: 'doc',
    attrs: { sect: { w: 612, h: 792, orient: 'portrait', margin: { top: 72, right: 72, bottom: 72, left: 72, header: 36, footer: 36, gutter: 0 }, pageNumber: null },
      styles: { defaults: { run: { font: '+minor', size: 12 }, para: {} }, list: {} }, numbering: { abstract: {}, nums: {} }, theme: THEME },
    content: [
      { type: 'heading', attrs: { level: 1, textAlign: 'center', styleId: null, spacing: { before: 12, after: 6, line: { rule: 'exact', value: 14 } }, indent: null, numbering: null }, content: [t('Report')] },
      { type: 'paragraph', attrs: { textAlign: 'justify', styleId: 'Quote', spacing: { line: { rule: 'auto', value: 1.5 } }, indent: { left: 36, firstLine: -18 }, numbering: { numId: 2, ilvl: 1 } }, content: [
        t('Run', [{ type: 'textStyle', attrs: { font: '+major', size: 14, color: '#0F4761', themeColor: { slot: 'accent1', lum: -0.25 }, highlight: 'yellow' } }]),
        t('under', [{ type: 'underline', attrs: { val: 'wave' } }, { type: 'bold' }, { type: 'italic' }, { type: 'strike' }]),
        t('2', [{ type: 'superscript' }]),
        t('link', [{ type: 'link', attrs: { href: 'https://a.test', target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: null } }]),
        { type: 'hardBreak' },
        t('x', [{ type: 'subscript' }]),
        { type: 'image', attrs: { src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'A chart', title: null, width: 320, height: 180 } },
      ] },
      { type: 'pageBreak' },
      { type: 'table', attrs: { styleId: 'TableGrid' }, content: [{ type: 'tableRow', content: [
        { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: [120], align: null, shading: '#E8E8E8', vAlign: 'center' }, content: [p('H')] },
        { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null, shading: null, vAlign: 'bottom' }, content: [p('C')] },
      ] }] },
    ],
  };
  const node = schema.nodeFromJSON(doc);
  node.check();
  const back = JSON.parse(JSON.stringify(node.toJSON())); // as the draft file holds it
  holds(back, doc);
  assert.equal(back.attrs.settings, null);
  assert.equal(back.content[2].attrs.rev, null);
  assert.deepEqual(back.content[3].attrs.look, { firstRow: true, lastRow: false, firstColumn: true, lastColumn: false, noHBand: false, noVBand: true });
});

// Block JSON holding v2 nodes, as note text, a header and comment text hold it.
const STORY = [
  { type: 'paragraph', content: [t('Page '), { type: 'field', attrs: { code: 'PAGE', result: '3' } }, { type: 'ptab', attrs: { align: 'right', relativeTo: 'margin', leader: 'dot' } },
    { type: 'bookmark', attrs: { name: '_Ref1', id: '1' } }, t('x', [{ type: 'insertion', attrs: { id: 'r1', author: 'Kelvin', date: '2026-10-27T10:00:00Z', move: null } }])] },
  { type: 'fieldBlock', attrs: { code: 'TOC \\o "1-3"' }, content: [p('Contents')] },
];
const BORDER = { style: 'thickThinSmallGap', width: 1.5, space: 4, color: '#156082', shadow: true, frame: false, future: 'kept' };

/** A doc using every v2 node, mark and attribute (each with a value other than its default), the stories included. */
function v2Doc() {
  const base = newDocumentJson({ paper: 'a4' });
  const sect = { ...base.attrs.sect, type: 'nextPage', pgNum: { fmt: 'lowerRoman', start: 1, chapStyle: null, chapSep: 'hyphen' }, titlePg: true,
    hdr: { default: STORY, first: null, even: null }, ftr: null };
  return {
    ...base,
    attrs: {
      ...base.attrs,
      sect: { ...sect, type: 'continuous' },
      settings: { ...base.attrs.settings, defaultTabStop: 42, trackRevisions: true, unknownFromV3: { a: 1 } },
      props: { core: { title: 'T', creator: 'K' }, app: { company: 'C' }, custom: [{ name: 'n', type: 'text', value: 'v' }], cover: { abstract: 'A' } },
      vars: { client: 'Acme' },
      comments: { c1: { author: 'Kelvin', initials: 'K', date: '2026-10-27T10:00:00Z', done: false, parent: null, content: STORY } },
      people: [{ name: 'Kelvin', initials: 'K', color: '#B4009E' }],
      background: { color: '#FFF2CC', themeColor: null, fill: null },
      merge: { type: 'letters', sourceName: 'list.csv', fields: ['Name'], filter: null, sort: null, map: {}, exclude: [2], label: null, envelope: null },
    },
    content: [
      { type: 'paragraph', attrs: {
        tabs: [{ pos: 72, align: 'decimal', leader: 'dot' }, { pos: 144, align: 'clear', leader: 'none' }], keepNext: true, keepLines: false, widowControl: false,
        pageBreakBefore: true, outline: 2, contextual: true, borders: { top: BORDER, between: BORDER, bar: null }, shading: { fill: '#D9D9D9', color: 'auto', val: 'pct15' },
        bidi: true, mirrorIndents: true, suppressLineNumbers: true, suppressAutoHyphens: true, snapToGrid: false,
        asian: { kinsoku: false, wordWrap: true, overflowPunct: true, topLinePunct: false, autoSpaceDE: true, autoSpaceDN: true, adjustRightInd: true, textAlignment: 'auto' },
        frame: { dropCap: 'drop', lines: 3, hSpace: 0 }, collapsed: true, specVanish: true, tightWrap: 'allLines',
        markRev: { ins: { id: 'r2', author: 'Kelvin', date: '2026-10-27T10:00:00Z' } }, pChange: { id: 'r3', author: 'Kelvin', date: '2026-10-27T10:00:00Z', old: { textAlign: null } },
        textAlign: 'distribute', spacing: { before: 6, beforeAuto: true, afterLines: 100 }, indent: { left: 36, leftChars: 200, firstLineChars: 100 },
      }, content: [
        t('Run', [{ type: 'textStyle', attrs: { caps: true, smallCaps: false, dstrike: true, vanish: false, outline: true, shadow: true, emboss: false, imprint: false,
          spacing: 1.5, scale: 150, position: 3, kern: 14, fitText: { w: 72, id: 'f1' }, border: BORDER, shading: { fill: 'auto', color: '#FF0000', val: 'horzStripe' },
          lang: { val: 'en-GB', eastAsia: 'zh-HK', bidi: 'ar-SA' }, noProof: true, effects: { glow: { color: '#FF0000', size: 5 } },
          typography: { ligatures: 'all', numForm: 'oldStyle', numSpacing: 'tabular', stylisticSet: 3, contextual: false }, em: 'dot', fontEA: 'MS Mincho',
          fontCS: 'Arial', sizeCS: 14, rtl: true, cs: true, charStyle: 'Strong', eastAsianLayout: { combine: true, combineBrackets: 'round', vert: false, vertCompress: false },
          font: 'Arial', size: 11, color: '#FF0000', themeColor: null, highlight: 'green' } }]),
        t('u', [{ type: 'underline', attrs: { val: 'double', color: '#00FF00' } }, { type: 'comment', attrs: { id: 'c1' } }, { type: 'permission', attrs: { id: 'p1', ed: 'everyone' } }]),
        t('del', [{ type: 'deletion', attrs: { id: 'r4', author: 'Kelvin', date: '2026-10-27T10:00:00Z', move: 'm1' } }]),
        t('fmt', [{ type: 'formatChange', attrs: { id: 'r5', author: 'Kelvin', date: '2026-10-27T10:00:00Z', old: [{ type: 'bold' }] } }, { type: 'bold' }]),
        t('link', [{ type: 'link', attrs: { href: null, anchor: '_Ref1', tooltip: 'Go', target: null, rel: null, class: null, title: null } }]),
        { type: 'hardBreak', attrs: { clear: 'all' } },
        { type: 'image', attrs: { src: 'data:image/png;base64,iVBORw0KGgo=', alt: '', title: null, width: 200, height: 100,
          layout: { wrap: 'square', side: 'both', dist: { t: 0, r: 9, b: 0, l: 9 }, h: { rel: 'column', offset: 18 }, v: { rel: 'paragraph', offset: 0 }, z: 3,
            moveWithText: true, lockAnchor: false, allowOverlap: true, inCell: true, hidden: false, poly: null, relSize: null },
          crop: { t: 0.1, r: 0, b: 0.2, l: 0.05, shape: 'ellipse' }, adjust: { brightness: 20, contrast: -10, saturation: 50, transparency: 25, transparentColor: '#FFFFFF' },
          border: { color: '#000000', width: 1, dash: 'dash', sketched: null }, effects: { shadow: { preset: 'outer' } }, style: 'simpleFrame', rotate: 15, flipH: true,
          flipV: false, orig: { w: 400, h: 200 }, decorative: true, name: 'Picture 1' },
          marks: [{ type: 'insertion', attrs: { id: 'r6', author: 'Kelvin', date: '2026-10-27T10:00:00Z', move: null } }] },
        { type: 'field', attrs: { code: 'DATE \\@ "d MMMM yyyy"', result: '27 October 2026', locked: true, dirty: true, ff: { type: 'text', name: 'Text1' } },
          marks: [{ type: 'deletion', attrs: { id: 'r7', author: 'Kelvin', date: '2026-10-27T10:00:00Z', move: null } }] },
        { type: 'noteRef', attrs: { kind: 'endnote', id: 'n1', content: STORY, mark: '†' } },
        { type: 'equation', attrs: { math: 'a^2+b^2=c^2', display: true, align: 'left', mml: '<math><mi>a</mi></math>', linear: true } },
        { type: 'sdtInline', attrs: { sdt: { id: 's1', type: 'date', date: { format: 'd/M/yyyy', lang: 'en-GB', full: null, store: 'dateTime', calendar: 'gregorian' } } }, content: [t('27/10/2026')] },
        { type: 'ruby', attrs: { base: '漢', text: 'かん', align: 'center', size: 5, offset: 1, font: 'MS Mincho' } },
        { type: 'ptab', attrs: { align: 'right', relativeTo: 'indent', leader: 'underscore' } },
        { type: 'bookmark', attrs: { name: '_Ref1', id: '1', end: true } },
      ] },
      { type: 'heading', attrs: { level: 2, outline: 1, keepNext: false }, content: [t('Head')] },
      { type: 'sectionBreak', attrs: { kind: 'oddPage', sect, rev: { del: { id: 'r8', author: 'Kelvin', date: '2026-10-27T10:00:00Z' } } } },
      { type: 'columns', attrs: { count: 3, space: 18, sep: true, equal: false, widths: [{ w: 100, space: 18 }, { w: 120, space: 18 }, { w: 100 }],
        rev: { ins: { id: 'r9', author: 'Kelvin', date: '2026-10-27T10:00:00Z' } } }, content: [p('In columns'), { type: 'columnBreak', attrs: { rev: null } }, p('Next')] },
      { type: 'pageBreak', attrs: { rev: { ins: { id: 'r10', author: 'Kelvin', date: '2026-10-27T10:00:00Z' } } } },
      { type: 'textBox', attrs: { w: 200, h: 90, autoFit: true, inset: { t: 1, r: 2, b: 3, l: 4 }, vAlign: 'center', dir: 'tbRl', fill: '#FFF2CC',
        line: { color: '#156082', width: 1, dash: 'dash' }, effects: { shadow: true }, style: 'subtle', link: 'tb2', name: 'Text Box 1', id: 'tb1', rotate: 90,
        alt: 'Box', decorative: true, noWrap: true, upright: true, layout: { wrap: 'square', h: { rel: 'page', align: 'center' }, v: { rel: 'margin', offset: 36 } } },
        content: [p('Boxed')] },
      { type: 'sdtBlock', attrs: { sdt: { id: 's2', tag: 'toc', type: 'docPart', docPart: { gallery: 'Table of Contents', category: null }, appearance: 'hidden' } },
        content: [{ type: 'fieldBlock', attrs: { code: 'TOC \\o "1-3" \\h', locked: false, dirty: true }, content: [p('Head 1')] }] },
      { type: 'table', attrs: { styleId: 'TableGrid', look: { firstRow: false, lastRow: true, firstColumn: false, lastColumn: true, noHBand: true, noVBand: false },
        width: { w: 80, type: 'pct' }, layout: 'fixed', align: 'center', indent: 18, borders: { top: BORDER, insideH: BORDER }, cellMargin: { top: 1, right: 2, bottom: 3, left: 4 },
        cellSpacing: 2, float: { hAnchor: 'page', vAnchor: 'text', x: 10, y: 20, xAlign: null, yAlign: null, dist: {}, overlap: false }, caption: 'Cap', description: 'Desc', bidiVisual: true },
      content: [{ type: 'tableRow', attrs: { height: { value: 20, rule: 'exact' }, cantSplit: true, header: true, rev: { ins: { id: 'r11', author: 'K', date: '2026-10-27T10:00:00Z' } } }, content: [
        { type: 'tableHeader', attrs: { borders: { tl2br: BORDER, left: BORDER }, margins: { top: 1, right: 1, bottom: 1, left: 1 }, textDir: 'btLr', noWrap: true, fitText: true, hideMark: true }, content: [p('H')] },
        { type: 'tableCell', attrs: { textDir: 'tbRl' }, content: [p('C')] },
      ] }] },
      p('End'),
    ],
  };
}

test('a doc using every v2 node, mark and attribute survives fromJSON and toJSON, its stories valid in the kit schema', () => {
  const doc = v2Doc();
  const node = schema.nodeFromJSON(doc);
  node.check();
  const back = JSON.parse(JSON.stringify(node.toJSON()));
  holds(back, doc);
  // A note, a header and a comment hold block JSON with v2 nodes, which the kit schema loads (editors.js loadable).
  for (const story of [back.content[0].content.find((n) => n.type === 'noteRef').attrs.content, back.attrs.sect.hdr.default, back.attrs.comments.c1.content]) {
    schema.nodeFromJSON({ type: 'doc', content: story }).check();
  }
  // Keys this build does not know survive in JSON attributes.
  assert.deepEqual(back.attrs.settings.unknownFromV3, { a: 1 });
  assert.equal(back.content[0].attrs.borders.top.future, 'kept');
});

test('columns refuse a section break or nested columns; a text box and the wrappers hold blocks', () => {
  assert.throws(() => schema.nodeFromJSON({ type: 'columns', content: [{ type: 'sectionBreak' }] }).check());
  assert.throws(() => schema.nodeFromJSON({ type: 'columns', content: [{ type: 'columns', content: [p('a')] }] }).check());
  assert.throws(() => schema.nodeFromJSON({ type: 'textBox', content: [] }).check());
});

test('Markdown for doc.get: a field shows its result, notes number in order, breaks and wrappers read plainly', () => {
  const md = new MarkdownManager({ marked: new Marked(), extensions: documentExtensions(50) });
  const doc = { type: 'doc', attrs: newDocumentJson({}).attrs, content: [
    { type: 'paragraph', content: [t('On '), { type: 'field', attrs: { code: 'DATE', result: '27/10/2026' } }, t(' see'), { type: 'noteRef', attrs: { id: 'a' } },
      t(' and'), { type: 'noteRef', attrs: { id: 'b' } }, { type: 'bookmark', attrs: { name: 'x' } }, t(' '), { type: 'equation', attrs: { math: 'x^2' } }] },
    { type: 'sectionBreak', attrs: { kind: 'continuous' } },
    { type: 'sdtBlock', content: [{ type: 'fieldBlock', attrs: { code: 'TOC' }, content: [p('Intro')] }] },
    { type: 'columns', content: [p('Left'), { type: 'columnBreak' }, p('Right')] },
  ] };
  const out = md.serialize(doc);
  assert.match(out, /^On 27\/10\/2026 see\[\^1\] and\[\^2\] \$x\^2\$/);
  assert.match(out, /<!-- section break \(continuous\) -->/);
  assert.match(out, /Intro/);
  assert.match(out, /Left\n\n<!-- column break -->\n\nRight/);
});

// A headless editor on the Document's extensions holding `content` (paragraph JSON), the caret or selection at `sel`.
const editorOn = (content, sel, attrs) => {
  const ed = new Editor({ extensions: documentExtensions(50), content: { ...newDocumentJson({ paper: 'a4' }), ...(attrs && { attrs }), content } });
  ed.commands.setTextSelection(sel);
  return ed;
};

test('the generic commands merge into JSON attributes and keep keys they do not know (plan.md §1.8)', () => {
  const base = newDocumentJson({ paper: 'a4' }).attrs;
  const attrs = { ...base, settings: { ...base.settings, futureKey: { x: 1 } } };
  const ed = editorOn([
    { type: 'paragraph', attrs: { borders: { top: BORDER, futureEdge: 1 } }, content: [t('one')] },
    { type: 'sectionBreak', attrs: { kind: 'nextPage', sect: { ...base.sect, futureSect: true } } },
    { type: 'paragraph', content: [t('two', [{ type: 'textStyle', attrs: { typography: { ligatures: 'none', futureFeature: 2 } } }])] },
  ], 2, attrs);
  ed.chain().setParaProps({ borders: { bottom: BORDER }, keepNext: true }).run();
  let p0 = ed.state.doc.firstChild.attrs;
  assert.deepEqual([p0.borders.futureEdge, p0.borders.top.style, p0.borders.bottom.width, p0.keepNext], [1, 'thickThinSmallGap', 1.5, true]);
  ed.chain().setParaProps({ borders: { top: null }, keepNext: null }).run();
  p0 = ed.state.doc.firstChild.attrs;
  assert.deepEqual([Object.keys(p0.borders).sort(), p0.keepNext], [['bottom', 'futureEdge'], null]);

  ed.chain().setDocSettings({ trackRevisions: true, grid: { h: 9 } }).run();
  assert.deepEqual([ed.state.doc.attrs.settings.futureKey, ed.state.doc.attrs.settings.trackRevisions, ed.state.doc.attrs.settings.grid], [{ x: 1 }, true, { h: 9 }]);

  // The first section's sect is its break's; the selection is in the first section, then section 1 is the doc's.
  ed.chain().setSectionProps({ margin: { gutter: 18 }, titlePg: true }).run();
  const brk = ed.state.doc.child(1).attrs.sect;
  assert.deepEqual([brk.futureSect, brk.margin.gutter, brk.margin.top, brk.titlePg], [true, 18, 72, true]);
  ed.chain().setSectionProps({ orient: 'landscape' }, { section: 1 }).run();
  assert.deepEqual([ed.state.doc.attrs.sect.orient, ed.state.doc.child(1).attrs.sect.orient], ['landscape', 'portrait']);
  assert.equal(ed.can().setSectionProps({}, { section: 2 }), false);

  const end = ed.state.doc.content.size - 1;
  ed.commands.setTextSelection({ from: end - 3, to: end });
  ed.chain().setRunProps({ typography: { numForm: 'lining' }, caps: true }).run();
  const run = ed.state.doc.lastChild.firstChild.marks.find((m) => m.type.name === 'textStyle').attrs;
  assert.deepEqual([run.typography, run.caps], [{ ligatures: 'none', futureFeature: 2, numForm: 'lining' }, true]);
  ed.chain().setRunProps({ typography: null, caps: null }).run();
  assert.equal(ed.state.doc.lastChild.firstChild.marks.some((m) => m.type.name === 'textStyle'), false); // nothing set: removed
  ed.destroy();
});

test('setRunProps formats every cell of a CellSelection, and Font Color Automatic keeps false and 0 values', async () => {
  const { CellSelection } = await import('@tiptap/pm/tables');
  const cell = (text) => ({ type: 'tableCell', content: [p(text)] });
  const ed = editorOn([{ type: 'table', content: [{ type: 'tableRow', content: [cell('a1'), cell('b1')] }, { type: 'tableRow', content: [cell('a2'), cell('b2')] }] }], 1);
  const cells = [];
  ed.state.doc.descendants((n, pos) => { if (n.type.name === 'tableCell') cells.push(pos); });
  ed.commands.command(({ tr }) => !!tr.setSelection(CellSelection.create(tr.doc, cells[0], cells[2]))); // first column
  ed.chain().setRunProps({ caps: true }).run();
  const capsOf = (i) => ed.state.doc.nodeAt(cells[i] + 2).marks.find((m) => m.type.name === 'textStyle')?.attrs.caps ?? null;
  assert.deepEqual([0, 1, 2, 3].map(capsOf), [true, null, true, null]);

  const ed2 = editorOn([p('x')], 1);
  ed2.commands.setTextSelection({ from: 1, to: 2 });
  ed2.chain().setRunProps({ caps: false, spacing: 0, color: '#FF0000' }).run();
  ed2.chain().setMark('textStyle', { color: null }).removeEmptyTextStyle().run(); // Font Color Automatic (document/tools.js)
  const run = ed2.state.doc.firstChild.firstChild.marks.find((m) => m.type.name === 'textStyle')?.attrs;
  assert.deepEqual([run?.caps, run?.spacing, run?.color], [false, 0, null]);
  ed.destroy();
  ed2.destroy();
});

test('a section break without its sect takes a copy of the following section\'s', () => {
  // A headless editor runs no plugins until it mounts, so the kit's plugins run on a plain state.
  const ed = editorOn([p('a')], 1);
  const state = EditorState.create({ doc: ed.state.doc, plugins: ed.extensionManager.plugins });
  const sect = state.doc.attrs.sect;
  const own = { ...sect, orient: 'landscape' };
  const { nodes } = state.schema;
  const add = (attrs) => [nodes.sectionBreak.create(attrs), nodes.paragraph.create()];
  const { state: next } = state.applyTransaction(state.tr.insert(state.doc.content.size, [...add(null), ...add({ sect: own }), ...add(null)]));
  const breaks = [];
  next.doc.forEach((n) => n.type.name === 'sectionBreak' && breaks.push(n.attrs.sect));
  assert.deepEqual(breaks, [own, own, sect]);
  assert.notEqual(breaks[2], sect); // a copy, not the same object
  ed.destroy();
});

test('newDocumentJson writes the v2 doc attrs, Word\'s run defaults and settings.word.newDocument', () => {
  const plain = newDocumentJson({ paper: 'a4' });
  assert.deepEqual(plain.attrs.settings, DOC_SETTINGS);
  assert.notEqual(plain.attrs.settings, DOC_SETTINGS);
  assert.deepEqual(plain.attrs.styles.defaults.run, { font: '+minor', size: 12, typography: { ligatures: 'standardContextual' }, lang: { val: 'en-US', eastAsia: 'zh-CN', bidi: 'ar-SA' } });
  for (const k of ['props', 'vars', 'comments', 'people', 'background', 'merge']) assert.equal(plain.attrs[k], null);
  const theme = { ...THEME, name: 'Mine' };
  const doc = newDocumentJson({ paper: 'letter', word: { proofing: { languages: ['en-GB'] }, newDocument: {
    styles: { defaults: { run: { size: 11 } }, list: { Normal: { type: 'paragraph', name: 'Normal', run: { font: 'Arial' } } } }, theme,
    pageSetup: { orient: 'landscape', w: 792, h: 612, margin: { left: 54 }, mirrorMargins: true, gutterAtTop: true } } } });
  assert.deepEqual(doc.attrs.styles.defaults.run.lang.val, 'en-GB');
  assert.equal(doc.attrs.styles.defaults.run.size, 11);
  assert.equal(doc.attrs.styles.defaults.run.font, '+minor');
  assert.equal(doc.attrs.styles.list.Normal.run.font, 'Arial');
  assert.ok(doc.attrs.styles.list.Heading1);
  assert.equal(doc.attrs.theme.name, 'Mine');
  assert.deepEqual([doc.attrs.sect.orient, doc.attrs.sect.w, doc.attrs.sect.margin.left, doc.attrs.sect.margin.top], ['landscape', 792, 54, 72]);
  assert.deepEqual([doc.attrs.settings.mirrorMargins, doc.attrs.settings.gutterAtTop], [true, true]);
  assert.equal(DOC_DEFAULTS.run.lang, undefined); // the module's defaults stay unchanged
});

test('sub- and superscript exclude each other (w:vertAlign holds one)', () => {
  const sub = schema.marks.subscript.create();
  assert.deepEqual(schema.marks.superscript.create().addToSet([sub]).map((m) => m.type.name), ['superscript']);
});

test('markdown code comes in as plain text', () => {
  const md = new MarkdownManager({ marked: new Marked(), extensions: documentExtensions(50) });
  const doc = schema.nodeFromJSON(md.parse('use `a<b` here\n\n```js\nx < 1\n\ny\n```\n'));
  assert.deepEqual(doc.content.content.map((b) => [b.type.name, b.textContent]),
    [['paragraph', 'use a<b here'], ['paragraph', 'x < 1'], ['paragraph', ''], ['paragraph', 'y']]);
});

test('markdown pictures keep only data URLs', () => {
  const md = new MarkdownManager({ marked: new Marked(), extensions: documentExtensions(50) });
  const doc = schema.nodeFromJSON(md.parse('a ![x](https://x.test/y.png) ![](picture) ![d](data:image/png;base64,AA==)\n'));
  const inline = doc.firstChild.content.content.map((n) => (n.isText ? n.text : `${n.type.name}:${n.attrs.src}:${n.attrs.alt}`));
  assert.deepEqual(inline, ['a x  ', 'image:data:image/png;base64,AA==:d']);
});

test("heading keys and setHeading apply Word's Heading style: a Title or Quote paragraph loses its styleId", () => {
  const ed = editorOn([{ type: 'paragraph', attrs: { styleId: 'Title' }, content: [{ type: 'text', text: 'Hello' }] }], 2);
  ed.chain().toggleHeading({ level: 1 }).run();
  assert.deepEqual([ed.state.doc.firstChild.type.name, ed.state.doc.firstChild.attrs.level, ed.state.doc.firstChild.attrs.styleId], ['heading', 1, null]);
  ed.chain().toggleHeading({ level: 1 }).run();
  assert.deepEqual([ed.state.doc.firstChild.type.name, ed.state.doc.firstChild.attrs.styleId], ['paragraph', null]);
  ed.chain().setStyle('Quote').setHeading({ level: 2 }).run();
  assert.deepEqual([ed.state.doc.firstChild.type.name, ed.state.doc.firstChild.attrs.level, ed.state.doc.firstChild.attrs.styleId], ['heading', 2, null]);
  ed.destroy();
});

test('Clear formatting removes run formatting and the style but keeps a hyperlink and a comment, as Word does', () => {
  const link = { type: 'link', attrs: { href: 'https://a.test' } };
  const ed = editorOn([{ type: 'paragraph', attrs: { styleId: 'Quote', textAlign: 'right' }, content: [
    { type: 'text', text: 'bold ', marks: [{ type: 'bold' }, { type: 'comment', attrs: { id: 'c1' } }] }, { type: 'text', text: 'link', marks: [link, { type: 'italic' }] }] }], { from: 1, to: 10 });
  ed.chain().clearFormatting().run();
  const para = ed.state.doc.firstChild;
  assert.deepEqual([para.attrs.styleId, para.attrs.textAlign], [null, null]);
  assert.deepEqual(para.content.content.map((n) => [n.text, n.marks.map((m) => m.type.name)]), [['bold ', ['comment']], ['link', ['link']]]);
  ed.destroy();
});

test("a conditional format's borders draw on its region's edges: a header row's bottom rule on a three-row table", () => {
  const red = { style: 'single', width: 1, color: '#FF0000' };
  const list = { T: { type: 'table', name: 'T', table: { cond: { firstRow: { cell: { borders: { bottom: red } } } } } } };
  const rules = styleSheetCss('.s', { list }, null).split('\n').filter((r) => r.includes('#FF0000'));
  // Every first-row cell takes it, whichever row is the table's last; repeating header rows from the top are first rows too.
  const head = ':is(tr:first-child, tr[data-header]:not(tr:not([data-header]) ~ tr))';
  assert.deepEqual(rules, [`.s table.ts-T:where([data-look~="firstRow"]) td:where(${head} > *),`
    + `.s table.ts-T:where([data-look~="firstRow"]) th:where(${head} > *){border-bottom:1pt solid #FF0000}`]);
  const by = (pairs) => Object.fromEntries(pairs.map(([sel, css]) => [`${Object.keys(css)[0]} ${sel}`, Object.values(css)[0]]));
  const b = { top: red, bottom: red, left: red, right: red, insideH: { style: 'nil' }, insideV: { style: 'dotted', width: 1, color: '#00FF00' } };
  // A row: top and bottom on every cell, left and right at the row's ends, insideV between.
  assert.deepEqual(by(borderRules(b, 'row')), {
    'border-top ': '1pt solid #FF0000', 'border-bottom ': '1pt solid #FF0000',
    'border-left :where(tr > :first-child)': '1pt solid #FF0000', 'border-left :where(:not(tr > :first-child))': '1pt dotted #00FF00',
    'border-right :where(tr > :last-child)': '1pt solid #FF0000', 'border-right :where(:not(tr > :last-child))': '1pt dotted #00FF00' });
  // A column is the transpose; a corner cell takes all four; the whole table keeps the table's edges.
  assert.equal(by(borderRules(b, 'col'))['border-bottom :where(:not(tr:last-child > *))'], 'none');
  assert.equal(by(borderRules(b, 'col'))['border-left '], '1pt solid #FF0000');
  assert.deepEqual(Object.keys(by(borderRules(b, 'cell'))), ['border-top ', 'border-bottom ', 'border-left ', 'border-right ']);
  assert.equal(by(borderRules(b))['border-bottom :where(tr:last-child > *)'], '1pt solid #FF0000');
});

test('style run properties: box properties only on runs, highlight over shading, a false that switches off what a style turns on', () => {
  const run = { shading: { val: 'clear', fill: '#00FF00' }, border: { style: 'single', width: 1 }, position: 3, highlight: 'yellow', vanish: false, size: 11 };
  const block = runCss(run, true);
  assert.deepEqual([block.background, block.border, block['vertical-align'], block['background-color'], block.display, block['font-size']],
    [undefined, undefined, undefined, null, undefined, '11pt']);
  const own = Object.keys(runCss(run));
  assert.ok(own.indexOf('background-color') > own.indexOf('background'), own);
  assert.equal(runCss(run).display, 'inline');
  const span = (attrs) => schema.marks.textStyle.spec.toDOM(schema.marks.textStyle.create(attrs))[1].style;
  assert.match(span({ emboss: false }), /text-shadow: none/);
  assert.match(span({ shadow: true, emboss: false, imprint: false }), /text-shadow: 0\.06em/);
  assert.match(span({ outline: false }), /-webkit-text-stroke: 0/);
  // Word draws an automatic border black.
  assert.match(span({ border: { style: 'single', width: 1, color: 'auto' } }), /border: 1pt solid #000000/);
});

test('a row at least so high and a bottom-to-top cell draw as Word lays them out', () => {
  const row = (height) => schema.nodes.tableRow.spec.toDOM(schema.nodes.tableRow.create({ height }, schema.nodes.tableCell.createAndFill()))[1].style;
  assert.equal(row({ value: 20, rule: 'atLeast' }), 'min-height: 20pt; --row-min: 20pt');
  assert.equal(row({ value: 20, rule: 'exact' }), 'height: 20pt');
  const cell = schema.nodes.tableCell.spec.toDOM(schema.nodes.tableCell.createAndFill({ textDir: 'btLr' }))[1].style;
  assert.equal(cell, 'writing-mode: sideways-lr');
});
