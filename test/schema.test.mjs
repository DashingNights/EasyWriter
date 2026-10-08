import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema, validate, withDefaults } from '../src/app/schema.mjs';

const $defs = { PATH: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 16 } };
const ARGS = {
  type: 'object', required: ['at', 'content'], additionalProperties: false,
  properties: {
    at: { oneOf: [{ $ref: '#/$defs/PATH' }, { enum: ['start', 'end', 'cursor'] }] },
    position: { enum: ['before', 'after'], default: 'after' },
    content: { type: 'object', minProperties: 1, maxProperties: 1, properties: { markdown: { type: 'string', maxLength: 5 } } },
    tag: { type: ['string', 'null'], pattern: '^[a-z]+$' },
  },
};

test('valid values give no errors', () => {
  assert.deepEqual(validate(ARGS, { at: [3, 0], content: { markdown: '# a' } }, $defs), []);
  assert.deepEqual(validate(ARGS, { at: 'end', content: { markdown: '' }, tag: null }, $defs), []);
  assert.deepEqual(validate({}, 42), []);
});

test('errors carry a JSON pointer, a message and the expected schema ($ref resolved)', () => {
  const [e] = validate(ARGS, { at: [-1], content: { markdown: 'x' } }, $defs);
  assert.equal(e.path, '/at');
  assert.match(e.message, /one of 2 forms/);
  assert.equal(validate(ARGS, { content: { markdown: 'x' } }, $defs)[0].path, '/at');
  assert.equal(validate(ARGS, { at: 'end' }, $defs)[0].message, 'is required');
  const extra = validate(ARGS, { at: 'end', content: { markdown: 'x' }, nope: 1 }, $defs)[0];
  assert.equal(extra.path, '/nope');
  assert.match(extra.message, /not allowed/);
  assert.equal(validate(ARGS, { at: 'end', content: { markdown: 'toolong' } }, $defs)[0].path, '/content/markdown');
  assert.equal(validate(ARGS, { at: 'end', content: {} }, $defs)[0].message, 'must have at least 1 properties');
  assert.equal(validate(ARGS, { at: 'end', content: { markdown: 'x' }, tag: 'A1' }, $defs)[0].path, '/tag');
  const ref = validate({ type: 'object', properties: { p: { $ref: '#/$defs/PATH' } } }, { p: [1.5] }, $defs)[0];
  assert.deepEqual([ref.path, ref.expected], ['/p/0', { type: 'integer', minimum: 0 }]);
});

test('types, ranges, enum / const, anyOf, oneOf ambiguity', () => {
  assert.equal(validate({ type: 'integer' }, 1.5).length, 1);
  assert.equal(validate({ type: 'number' }, Infinity).length, 1);
  assert.equal(validate({ type: 'object' }, []).length, 1);
  assert.equal(validate({ type: 'array', maxItems: 1 }, [1, 2]).length, 1);
  assert.equal(validate({ minimum: 1, maximum: 3 }, 4).length, 1);
  assert.equal(validate({ const: 'a' }, 'b').length, 1);
  assert.equal(validate({ anyOf: [{ type: 'string' }, { type: 'null' }] }, null).length, 0);
  assert.match(validate({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 2)[0].message, /more than one/);
  assert.equal(validate({ oneOf: [{ type: 'string' }] }, 2)[0].message, 'must be string'); // one branch: its own error
});

test('withDefaults fills missing properties without mutating', () => {
  const v = { at: 'end' };
  assert.deepEqual(withDefaults(ARGS, v, $defs), { at: 'end', position: 'after' });
  assert.deepEqual(v, { at: 'end' });
});

test('checkSchema refuses unknown keywords and types', () => {
  checkSchema(ARGS);
  assert.throws(() => checkSchema({ type: 'object', properties: { a: { tpye: 'string' } } }), /unknown keyword tpye/);
  assert.throws(() => checkSchema({ type: 'str' }), /unknown type/);
});
