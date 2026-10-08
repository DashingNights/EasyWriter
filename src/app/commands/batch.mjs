import { define } from './define.mjs';

// batch (SPEC §8 Batch): several precise edits as one undo step and one ask. The executor runs it (commands.js runBatch):
// its risk is the highest of its steps', and every PATH in its steps refers to the doc at its start (or at `ifRev`).

export const defs = [
  define({
    id: 'batch',
    title: 'Run several commands as one undo step and one approval',
    brief: 'Use it for several changes, after you read the paths.',
    guide: { playbook: 'edit-draft-text' },
    group: 'batch',
    risk: 'write', // the executor uses the highest risk of the steps
    undo: 'doc',
    batch: true,
    args: {
      type: 'object', required: ['steps'], additionalProperties: false,
      properties: {
        steps: {
          type: 'array', minItems: 1, maxItems: 100, description: 'Commands in order',
          items: {
            type: 'object', required: ['id'], additionalProperties: false,
            properties: { id: { type: 'string', maxLength: 48, description: 'A tool name or command id' }, args: { type: 'object', description: 'The arguments of that command' } },
          },
        },
        atomic: { type: 'boolean', default: true, description: 'Undo all steps when one fails' },
      },
    },
    result: { type: 'object', required: ['results'] },
    examples: [
      { args: { steps: [{ id: 'doc.delete', args: { paths: [[4]] } }, { id: 'doc.insert', args: { at: [3], content: { markdown: 'New text' } } }] } },
      { args: { steps: [{ id: 'doc_replace', args: { path: [1], content: { markdown: 'New text' } } }, { id: 'doc_delete', args: { paths: [[2]] } }] } },
    ],
    run: (ctx, a) => ctx.lib.batch(a),
  }),
];
