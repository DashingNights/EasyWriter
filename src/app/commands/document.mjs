import { defaultSect } from '../../document/defaults.mjs';
import { MAX_PAPER, sectFor, tooSmall } from '../../document/pages.mjs';
import { MARGIN_PRESETS, PAPER_SIZES } from '../../office.mjs';
import { can } from '../gates.mjs';
import { define, fail } from './define.mjs';
import { DRAFT_ID } from './schema-defs.mjs';

// A Document's own commands (docs/plans/document.md agentsAndTools): doc.pageSetup, the Layout tab's Margins, Orientation and
// Size, and Insert > Page number. Gate format.document as a check, as doc.format's run and paragraph.

const LENGTH = { type: 'number', minimum: 0, maximum: MAX_PAPER };
const PAPER = { type: 'number', minimum: 7.2, maximum: MAX_PAPER };

export const defs = [
  define({
    id: 'doc.pageSetup',
    title: "Set a document's paper, orientation, margins and page number",
    brief: 'Use it to change the page of a document (not a forum post). draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'doc',
    risk: 'write',
    undo: 'doc',
    needs: ['doc.open'],
    check: (a, draft) => (can('format.document', draft) ? [] : ['format.document']),
    args: {
      type: 'object', additionalProperties: false,
      anyOf: [{ required: ['size'] }, { required: ['orientation'] }, { required: ['margins'] }, { required: ['pageNumber'] }],
      properties: {
        size: {
          description: 'A paper name, or a width and height in points',
          anyOf: [{ enum: Object.keys(PAPER_SIZES) },
            { type: 'object', required: ['widthPt', 'heightPt'], additionalProperties: false, properties: { widthPt: PAPER, heightPt: PAPER } }],
        },
        orientation: { enum: ['portrait', 'landscape'], description: 'Landscape swaps width and height' },
        margins: {
          description: 'A preset name, or the four margins in points',
          anyOf: [{ enum: Object.keys(MARGIN_PRESETS) }, {
            type: 'object', required: ['topPt', 'rightPt', 'bottomPt', 'leftPt'], additionalProperties: false,
            properties: { topPt: LENGTH, rightPt: LENGTH, bottomPt: LENGTH, leftPt: LENGTH },
          }],
        },
        pageNumber: {
          description: 'null removes it',
          anyOf: [{ type: 'null' }, { type: 'object', required: ['at', 'align'], additionalProperties: false,
            properties: { at: { enum: ['top', 'bottom'] }, align: { enum: ['left', 'center', 'right'] } } }],
        },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['sect'] },
    examples: [
      { args: { size: 'letter', orientation: 'landscape', margins: 'narrow' } },
      { args: { margins: { topPt: 72, rightPt: 90, bottomPt: 72, leftPt: 90 } } },
      { args: { size: { widthPt: 420, heightPt: 595 } } },
      { args: { pageNumber: { at: 'bottom', align: 'center' } } },
    ],
    plan: (ctx, a) => {
      const { state } = ctx.editor;
      const sect = sectFor(state.doc.attrs.sect ?? defaultSect(ctx.state.settings.paper), a);
      const small = tooSmall(sect);
      if (small) fail('invalid_args', small, { path: '/margins', message: 'leaves no room for text', expected: {} });
      return { tr: state.tr.setDocAttribute('sect', sect), result: { sect } };
    },
  }),
];
