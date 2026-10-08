import { DASHES, HEADS, JUMPS, MAX_POINTS, ROUTES } from '../../flow/model.mjs';
import { KINDS } from '../../flow/shapes.mjs';
import { FILLS, WB_BG } from '../../whiteboard.js';

// Shared argument schemas of the command catalogue (SPEC §8; agent-automation plan §3.5): referenced as `{$ref: '#/$defs/X'}`
// and listed in `$defs` (catalogue.mjs). Plain JSON; ITEM takes its enums from the board model (whiteboard.js, flow/*.mjs).

export const ID = { type: 'string', pattern: '^[a-f0-9-]{36}$' };
export const PATH = { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 16 };
export const URL = { type: 'string', pattern: '^https://daf\\.staffs\\.ac\\.uk/topic/\\d+' };
export const TAG_ID = { type: 'string', minLength: 1, maxLength: 64 };

// `description`: kept beside the $ref; the model form (tools-schema.mjs rewrite) and invalid_args messages show it.
export const ref = (name, description) => ({ $ref: `#/$defs/${name}`, ...(description && { description }) });

// draftId of the commands that work on another draft without opening it, in a background session (SPEC §8 Background drafts).
export const DRAFT_ID = ref('ID', "Another draft's id");

// The content forms of doc.insert / doc.replace / drafts.create (exactly one key; SPEC §8 Content).
export const CONTENT = {
  type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1,
  properties: {
    json: {},
    html: { type: 'string', maxLength: 4000000 },
    markdown: { type: 'string', maxLength: 4000000 },
    images: {
      type: 'array', minItems: 1, maxItems: 20,
      items: {
        type: 'object', required: ['dataUrl'], additionalProperties: false,
        properties: { dataUrl: { type: 'string', pattern: '^data:image/', maxLength: 20000000 }, w: { type: 'integer', minimum: 1 } },
      },
    },
  },
};

export const NO_ARGS = { type: 'object', additionalProperties: false, properties: {} };

// --- board items (SPEC §6, §6b–§6d): the JSON-Schema transcription of whiteboard.js validItem / cleanItem. Sizes in board px
// (a canvas: artboard px). Fields not listed pass (board.get answers carry derived ones: a text item's measured h, a
// connector's x y w h d tips lps); the commands still run the board's own checks on every item.

export const ITEM_ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' };
const NUM = { type: 'number' };
const SIZE = { type: 'number', minimum: 1 };
const COLOR = { type: 'string', pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$' };
const OPACITY = { type: 'number', minimum: 0, maximum: 1 };
const BOOL = { type: 'boolean' };
const XY = { x: NUM, y: NUM };
const BOX = { ...XY, w: SIZE, h: SIZE };
// The description names the required fields, so a wrong item's invalid_args message lists what each type needs (define.mjs unionText).
const item = (type, required, properties) => ({
  title: type, description: `type ${type} needs ${required.join(' ')}`, type: 'object', required: ['type', ...required],
  properties: { id: ITEM_ID, type: { const: type }, ...properties },
});

const TEXT = item('text', ['x', 'y', 'w', 'html'], {
  ...XY, w: SIZE, html: { type: 'string', maxLength: 100000 }, size: SIZE, color: COLOR, bold: BOOL,
  align: { enum: ['left', 'center', 'right'] }, bg: { anyOf: [COLOR, { type: 'null' }] },
});
const IMAGE = item('image', ['src', 'x', 'y', 'w', 'h'], {
  ...BOX, src: { type: 'string', pattern: '^data:image/', maxLength: 20000000 },
  crop: { type: 'object', required: ['x', 'y', 'w', 'h'], properties: { x: OPACITY, y: OPACITY, w: OPACITY, h: OPACITY } },
});
const SHAPE = item('shape', ['shape', 'x', 'y', 'w', 'h'], {
  ...BOX, shape: { enum: KINDS.map((k) => k.kind) }, color: COLOR, width: { type: 'number', minimum: 0 }, opacity: OPACITY,
  fill: { enum: FILLS.map(([k]) => k) }, fillColor: COLOR, rot: NUM, flipX: BOOL, flipY: BOOL,
  // its label
  html: { type: 'string', maxLength: 100000 }, size: SIZE, textColor: COLOR, align: { enum: ['left', 'center', 'right'] },
  valign: { enum: ['top', 'middle', 'bottom'] },
});
const STROKE = item('stroke', ['x', 'y', 'w', 'h', 'vw', 'vh', 'd', 'color', 'width', 'opacity'], {
  ...BOX, vw: SIZE, vh: SIZE, d: { type: 'string', maxLength: 1000000 }, color: COLOR, width: SIZE, opacity: OPACITY,
});
// A connector end: bound to an item (anchor null: floating; a name or [rx, ry] in 0..1: that point) or free at x, y.
const END = {
  anyOf: [
    {
      type: 'object', required: ['item'],
      properties: {
        item: ITEM_ID,
        anchor: { anyOf: [{ type: 'null' }, { enum: ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw', 'c'] },
          { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, minItems: 2, maxItems: 2 }] },
      },
    },
    { type: 'object', required: ['x', 'y'], properties: XY },
  ],
};
// A label slot; null removes it (board.items.update).
const LABEL = {
  type: ['object', 'null'],
  properties: { html: { type: 'string', minLength: 1, maxLength: 10000 }, t: OPACITY, dx: NUM, dy: NUM, size: SIZE, textColor: COLOR, bold: BOOL },
};
const CONNECTOR = item('connector', ['from', 'to'], {
  from: END, to: END, route: { enum: ROUTES }, corner: { type: 'number', minimum: 0 },
  points: { type: 'array', maxItems: MAX_POINTS, items: { type: 'object', required: ['x', 'y'], properties: XY } },
  heads: { type: 'object', properties: { start: { enum: HEADS }, end: { enum: HEADS } } },
  color: COLOR, width: SIZE, opacity: OPACITY, dash: { enum: DASHES }, jump: { enum: JUMPS },
  labels: { type: 'object', additionalProperties: false, properties: { start: LABEL, mid: LABEL, end: LABEL } },
});
const FLAT = [TEXT, IMAGE, SHAPE, STROKE, CONNECTOR];
// A canvas item (a whiteboard's only): its artboard aw × ah shown at w × h; its own items never hold a canvas.
const CANVAS = item('canvas', ['x', 'y', 'w', 'h', 'aw', 'ah'], {
  ...BOX, aw: { type: 'number', minimum: 1, maximum: 8000 }, ah: { type: 'number', minimum: 1, maximum: 8000 },
  frame: { anyOf: [{ type: 'null' }, { type: 'object', required: ['x', 'y', 'w', 'h'], properties: { ...BOX, item: ITEM_ID } }] },
  bg: { enum: Object.keys(WB_BG) }, items: { type: 'array', maxItems: 2000, items: { oneOf: FLAT } },
});

export const ITEM = { oneOf: [...FLAT, CANVAS] };

// ITEM as the assistant sees it (MODEL_DEFS, catalogue.mjs; SPEC §8 Tool schemas): one flat object with the union of the
// fields and the shape enums, a sixth of ITEM's size (connector ends, heads and labels described in words). The executor still
// validates every item against ITEM.
const S = { type: 'string' };
const OBJ = { type: 'object' };
export const ITEM_BRIEF = {
  type: 'object', required: ['type'],
  description: 'Fields by type. text: x y w html. shape: shape x y w h, html its label. connector: from, to as {item, anchor} or '
    + '{x, y}, anchor n e s w ne nw se sw c. image: src x y w h. canvas (whiteboard only): x y w h aw ah items, no canvas in them. '
    + 'Colours #rrggbb.',
  properties: {
    type: { enum: ['text', 'shape', 'connector', 'image', 'stroke', 'canvas'] }, id: S, ...BOX,
    html: S, size: NUM, color: S, bold: BOOL, align: TEXT.properties.align, valign: SHAPE.properties.valign, bg: S,
    shape: SHAPE.properties.shape, width: NUM, opacity: NUM, fill: SHAPE.properties.fill, fillColor: S, rot: NUM, textColor: S,
    // heads: the common ones only (wave 1c, board.items.add within MAX_TOOL); a wrong name's invalid_args lists them all.
    from: OBJ, to: OBJ, route: { enum: ROUTES }, heads: { ...OBJ, description: 'start, end: such as none, arrow, triangle, diamond, circle, bar' }, dash: { enum: DASHES },
    labels: { ...OBJ, description: 'start, mid, end: {html}' },
    src: S, aw: NUM, ah: NUM, frame: OBJ, items: { type: 'array' },
  },
};
