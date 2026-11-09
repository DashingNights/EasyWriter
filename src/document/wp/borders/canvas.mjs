// Borders and Shading on a canvas draft (docs/plans/engine/stage2b.md, engine-gaps-styles): what the dialog reads from the engine
// (format.state, para.state, document.context and design.pageBorders' state) in its own form, and the engine steps its OK writes
// (format.set and format.border, para.borders, table.borders, the shading commands and design.pageBorders) as one undo step.
// Pure: node tests load it.
import { engineHex as hex6 } from '../font/run.mjs';
import { hexOf } from '../styles/engine.mjs';
import { isLine } from './model.mjs';

const FOUR = ['top', 'left', 'bottom', 'right'];

/** An engine Border ({style: 'single' | {art}, width, color [r, g, b], space}) → the dialog's edge ({style, width, color, space}). */
export function edgeOfEngine(b) {
  if (!b) return null;
  const style = b.style && typeof b.style === 'object' ? b.style.art : b.style;
  if (!style || style === 'none') return null;
  return { style, width: b.width ?? 0.5, color: hexOf(b.color) ?? 'auto', space: b.space ?? 0 };
}
/** The dialog's edge → a side of para.borders' and design.pageBorders' `sides`. */
export const sideOf = (e) => ({ style: e.style, width: e.width ?? 0.5, space: e.space ?? 0, ...(hex6(e.color) && { color: hex6(e.color) }) });

const shadingOf = (hex) => (hex ? { val: 'clear', color: 'auto', fill: hex } : null);

/** What the dialog reads on a canvas draft: {t (a target in select.js's form, for Apply to and the edges offered), read: {text,
 * paragraph, cell, table} ({borders, shading} each), page (sectPr's pgBorders form)} from the engine's states `fs` (format.state),
 * `ps` (para.state), `context` (document.context), `pages` (design.pageBorders), `kind` ('run' | 'paras' | 'cells') and `paras`
 * (how many paragraphs the selection touches). */
export function canvasRead({ fs, ps, context, pages, kind, paras = 1 }) {
  const runEdge = edgeOfEngine(fs?.borderDetail);
  const pb = ps?.borders ?? {};
  const cell = context?.table ? { rect: { left: 0, top: 0, right: 2, bottom: 2 } } : null;
  const t = { kind, paras: Array.from({ length: Math.max(1, paras) }, () => ({})), cell, whole: false, rect: cell?.rect };
  const read = {
    text: { borders: runEdge ? Object.fromEntries(FOUR.map((e) => [e, runEdge])) : {}, shading: shadingOf(hexOf(fs?.shading)) },
    paragraph: { borders: Object.fromEntries(['top', 'left', 'bottom', 'right', 'between'].map((k) => [k, edgeOfEngine(pb[k])]).filter(([, e]) => e)),
      shading: shadingOf(hexOf(ps?.shading)) },
    // ponytail: a table's and a cell's own edges are not read (no table.get yet, stage2.md G31): the tabs start empty there.
    cell: { borders: {}, shading: null },
    table: { borders: {}, shading: null },
  };
  const sides = pages?.sides ?? null;
  const page = sides ? {
    offsetFrom: pages.measureFrom === 'text' ? 'text' : 'page', zOrder: pages.behind ? 'back' : 'front',
    display: { firstPage: 'firstPage', notFirstPage: 'notFirstPage' }[pages.display] ?? 'allPages',
    ...Object.fromEntries(FOUR.map((k) => [k, edgeOfEngine(sides[k])])),
  } : null;
  return { t, read, page };
}

const TABLE_SIDES = ['top', 'bottom', 'left', 'right'];
/** The table.borders steps that draw `b`'s edges on the selected cells or the table (its kinds, in the pen's width and colour;
 * the engine draws them single). */
function tableSteps(b) {
  const on = (k) => isLine(b[k]);
  const first = [...TABLE_SIDES, 'insideH', 'insideV'].map((k) => b[k]).find(isLine);
  const pen = first ? { width: first.width ?? 0.5, ...(hex6(first.color) && { color: hex6(first.color) }) } : {};
  const inside = on('insideH') || on('insideV');
  if (TABLE_SIDES.every(on) && inside) return [['table.borders', { kind: 'all', ...pen }]];
  const steps = [['table.borders', { kind: 'none' }]];
  if (TABLE_SIDES.every(on)) steps.push(['table.borders', { kind: 'outside', ...pen }]);
  else for (const k of TABLE_SIDES.filter(on)) steps.push(['table.borders', { kind: k, ...pen }]);
  if (inside) steps.push(['table.borders', { kind: 'inside', ...pen }]);
  return steps;
}

/** The engine steps the dialog's OK writes on a canvas draft for its state `v` (the touched tabs only) and shading `sh`. */
export function canvasSteps(v, sh) {
  const steps = [];
  if (v.touched.b) {
    const b = v.b.borders;
    const a = v.b.apply;
    if (a === 'text') {
      const e = FOUR.map((k) => b[k]).find(isLine);
      steps.push(e ? ['format.set', { props: { border: sideOf(e) } }] : ['format.border', { value: false }]);
    } else if (a === 'paragraph') {
      steps.push(['para.borders', { sides: Object.fromEntries(['top', 'left', 'bottom', 'right', 'between'].filter((k) => isLine(b[k])).map((k) => [k, sideOf(b[k])])) }]);
    } else steps.push(...tableSteps(b));
  }
  if (v.touched.s) {
    const fill = hex6(sh?.fill);
    const a = v.s.apply;
    steps.push([a === 'text' ? 'format.shading' : a === 'paragraph' ? 'para.shading' : 'table.shading', { color: fill }]);
  }
  if (v.touched.p) {
    const p = v.p;
    const lined = FOUR.filter((k) => isLine(p.borders[k]));
    steps.push(['design.pageBorders', {
      ...(lined.length ? { sides: Object.fromEntries(lined.map((k) => [k, sideOf({ ...p.borders[k], space: p.space[k] })])) } : { kind: 'none' }),
      applyTo: p.apply === 'whole' ? 'document' : 'section', measureFrom: p.offsetFrom === 'text' ? 'text' : 'edge',
      display: { first: 'firstPage', notFirst: 'notFirstPage' }[p.apply] ?? 'all', behind: !p.front,
    }]);
  }
  return steps;
}

// Word's page art borders (ST_Border's art values, ECMA-376 Part 1 17.18.2), as engine/crates/doc's ART_BORDERS names them: the
// Page Border tab's Art box. The engine draws each as a stand-in of its width, since Word's pictures are Microsoft's.
/** The art borders the engine draws as Word does (engine-gaps-rest: engine/crates/doc-layout/src/display/art.rs, from a Word probe). */
export const BASIC_ART = ['basicBlackDashes', 'basicBlackDots', 'basicBlackSquares', 'basicThinLines', 'basicWhiteDashes', 'basicWhiteDots',
  'basicWhiteSquares', 'basicWideInline', 'basicWideMidline', 'basicWideOutline'];
export const ART = ['apples', 'archedScallops', 'babyPacifier', 'babyRattle', 'balloons3Colors', 'balloonsHotAir', 'basicBlackDashes',
  'basicBlackDots', 'basicBlackSquares', 'basicThinLines', 'basicWhiteDashes', 'basicWhiteDots', 'basicWhiteSquares', 'basicWideInline',
  'basicWideMidline', 'basicWideOutline', 'bats', 'birds', 'birdsFlight', 'cabins', 'cakeSlice', 'candyCorn', 'celticKnotwork', 'certificateBanner',
  'chainLink', 'champagneBottle', 'checkedBarBlack', 'checkedBarColor', 'checkered', 'christmasTree', 'circlesLines', 'circlesRectangles',
  'classicalWave', 'clocks', 'compass', 'confetti', 'confettiGrays', 'confettiOutline', 'confettiStreamers', 'confettiWhite', 'cornerTriangles',
  'couponCutoutDashes', 'couponCutoutDots', 'crazyMaze', 'creaturesButterfly', 'creaturesFish', 'creaturesInsects', 'creaturesLadyBug',
  'crossStitch', 'cup', 'decoArch', 'decoArchColor', 'decoBlocks', 'diamondsGray', 'doubleD', 'doubleDiamonds', 'earth1', 'earth2', 'earth3',
  'eclipsingSquares1', 'eclipsingSquares2', 'eggsBlack', 'fans', 'film', 'firecrackers', 'flowersBlockPrint', 'flowersDaisies', 'flowersModern1',
  'flowersModern2', 'flowersPansy', 'flowersRedRose', 'flowersRoses', 'flowersTeacup', 'flowersTiny', 'gems', 'gingerbreadMan', 'gradient',
  'handmade1', 'handmade2', 'heartBalloon', 'heartGray', 'hearts', 'heebieJeebies', 'holly', 'houseFunky', 'hypnotic', 'iceCreamCones',
  'lightBulb', 'lightning1', 'lightning2', 'mapPins', 'mapleLeaf', 'mapleMuffins', 'marquee', 'marqueeToothed', 'moons', 'mosaic', 'musicNotes',
  'northwest', 'ovals', 'packages', 'palmsBlack', 'palmsColor', 'paperClips', 'papyrus', 'partyFavor', 'partyGlass', 'pencils', 'people',
  'peopleWaving', 'peopleHats', 'poinsettias', 'postageStamp', 'pumpkin1', 'pushPinNote2', 'pushPinNote1', 'pyramids', 'pyramidsAbove', 'quadrants',
  'rings', 'safari', 'sawtooth', 'sawtoothGray', 'scaredCat', 'seattle', 'shadowedSquares', 'sharksTeeth', 'shorebirdTracks', 'skyrocket',
  'snowflakeFancy', 'snowflakes', 'sombrero', 'southwest', 'stars', 'starsTop', 'stars3d', 'starsBlack', 'starsShadowed', 'sun', 'swirligig',
  'tornPaper', 'tornPaperBlack', 'trees', 'triangleParty', 'triangles', 'triangle1', 'triangle2', 'triangleCircle1', 'triangleCircle2', 'shapes1',
  'shapes2', 'twistedLines1', 'twistedLines2', 'vine', 'waveline', 'weavingAngles', 'weavingBraid', 'weavingRibbon', 'weavingStrips', 'whiteFlowers',
  'woodwork', 'xIllusions', 'zanyTriangles', 'zigZag', 'zigZagStitch'];
/** An art name as the Art box shows it ('balloons3Colors' → 'Balloons 3 colors'). */
export const artLabel = (name) => name.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase());
export const isArt = (style) => ART.includes(style);
