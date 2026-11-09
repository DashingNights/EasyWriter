// The diagram layouts and colour variants the galleries, the Choose a Diagram dialog and the buttons read. The ids are the
// engine's (ew_doc smart_art.rs); the labels are Word's (probe/dialogs/choose-a-smartart-graphic.json,
// probe/menus/smartart.smartart-design.change-colors.json). `basicVenn` is not in the probe list, but `venn1` is Word's Basic
// Venn. Descriptions are EasyWriter's own. Pure: node tests load it.

import { GALLERY } from '../../../flow/gallery.mjs';

export const CATEGORIES = ['All', 'List', 'Process', 'Cycle', 'Hierarchy', 'Relationship', 'Matrix', 'Pyramid'];

export const LAYOUTS = [
  { id: 'basicList', label: 'Basic Block List', icon: 'LayoutGrid', groups: ['List'], desc: 'Shows items of equal weight as blocks in rows.' },
  { id: 'process', label: 'Basic Process', icon: 'Workflow', groups: ['Process'], desc: 'Shows steps in order, left to right, with arrows between them.' },
  { id: 'cycle', label: 'Basic Cycle', icon: 'RefreshCw', groups: ['Cycle'], desc: 'Shows steps that repeat, around a circle.' },
  { id: 'hierarchy', label: 'Hierarchy', icon: 'Network', groups: ['Hierarchy'], desc: 'Shows a tree, each item below the item it belongs to.' },
  { id: 'radial', label: 'Basic Radial', icon: 'Orbit', groups: ['Cycle', 'Relationship'], desc: 'Shows items around a central idea. The first item is the centre.' },
  { id: 'venn', label: 'Basic Venn', icon: 'Blend', groups: ['Relationship'], desc: 'Shows overlapping ideas as overlapping circles.' },
  { id: 'matrix', label: 'Basic Matrix', icon: 'Grid2x2', groups: ['Matrix'], desc: 'Shows parts of a whole as quadrants.' },
  { id: 'pyramid', label: 'Basic Pyramid', icon: 'Triangle', groups: ['Pyramid'], desc: 'Shows parts that build on each other, largest at the bottom.' },
];

export const SHAPE_PRESETS = new Set(['rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'parallelogram', 'trapezoid', 'pentagon', 'hexagon',
  'homePlate', 'chevron', 'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow', 'upDownArrow', 'heart', 'star4', 'star5', 'star6', 'pie', 'blockArc']);

/** Word's name of each preset a diagram draws, under its Change Shape group: [{prst, name, group}]. */
export const SHAPE_CHOICES = GALLERY.flatMap((s) => s.shapes.filter(([prst]) => SHAPE_PRESETS.has(prst)).map(([prst, name]) => ({ prst, name, group: s.title })));

export const COLORS = [
  { id: 'colorful', label: 'Colorful - Accent Colors', group: 'Colorful', slots: ['accent1', 'accent2', 'accent3'] },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `accent${n}`, label: `Colored Fill - Accent ${n}`, group: `Accent ${n}`, slots: [`accent${n}`] })),
];
