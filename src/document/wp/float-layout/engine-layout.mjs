// The Layout dialog on a canvas draft (docs/plans/engine/stage2b.md, engine-gaps-shapes): its state from the engine's object
// (object.get) and the engine steps that apply what the dialog changed, one undo step through execMany. Only what changed is
// sent, so an object whose position the dialog left alone keeps it. Pure: node tests load it.

const TO_DIALOG = { inline: 'inline', square: 'square', tight: 'tight', through: 'through', topAndBottom: 'topBottom', behindText: 'behind',
  inFrontOfText: 'front' };
const TO_ENGINE = Object.fromEntries(Object.entries(TO_DIALOG).map(([k, v]) => [v, k]));
const SIDE_IN = { bothSides: 'both', left: 'left', right: 'right', largest: 'largest' };
const SIDE_OUT = Object.fromEntries(Object.entries(SIDE_IN).map(([k, v]) => [v, k]));

/** The dialog's state (dialogs.jsx stateOf's keys) from object.get's `o`. */
export function stateOfObject(o) {
  const p = o.position ?? {};
  const book = p.hAlign === 'inside' || p.hAlign === 'outside';
  return {
    wrap: TO_DIALOG[o.wrap] ?? 'inline', side: SIDE_IN[o.wrapText] ?? 'both',
    dist: { t: o.dist?.top ?? 0, b: o.dist?.bottom ?? 0, l: o.dist?.left ?? 0, r: o.dist?.right ?? 0 },
    hMode: book ? 'book' : p.hAlign ? 'align' : 'abs',
    hAlign: !book && p.hAlign ? p.hAlign : 'left', hAlignRel: p.hRel ?? 'column', hBook: book ? p.hAlign : 'inside', hBookRel: p.hRel === 'page' ? 'page' : 'margin',
    hAbs: p.x ?? 0, hAbsRel: p.hRel ?? 'column', hPct: 0, hPctRel: 'page',
    vMode: p.vAlign ? 'align' : 'abs',
    vAlign: p.vAlign ?? 'top', vAlignRel: p.vAlign ? p.vRel : 'page', vAbs: p.y ?? 0, vAbsRel: p.vRel ?? 'paragraph', vPct: 0, vPctRel: 'page',
    moveWithText: !!o.moveWithText, lockAnchor: false, allowOverlap: true, inCell: o.layoutInCell ?? true,
    w: o.w, h: o.h, wRel: o.relWidth ?? null, hRel: o.relHeight ?? null, rotate: Math.round(o.rotation ?? 0),
    lock: o.type === 'image', relOrig: false, orig: o.picture?.original ? { w: o.picture.original.w, h: o.picture.original.h } : null,
  };
}

/** The engine steps ([[id, params]]) for the dialog's state `s`, changed from `start`, on object.get's `o`. */
export function layoutSteps(start, s, o) {
  const changed = (...keys) => keys.some((k) => JSON.stringify(start[k]) !== JSON.stringify(s[k]));
  const steps = [];
  if (s.wrap !== start.wrap) steps.push(['arrange.wrap', { wrap: TO_ENGINE[s.wrap] }]);
  if (s.wrap !== 'inline') {
    const f = {};
    if (changed('side')) f.wrapText = SIDE_OUT[s.side];
    if (changed('dist')) f.dist = { top: s.dist.t, bottom: s.dist.b, left: s.dist.l, right: s.dist.r };
    if (changed('hMode', 'hAlign', 'hAlignRel', 'hBook', 'hBookRel', 'hAbs', 'hAbsRel')) {
      f.h = s.hMode === 'align' ? { rel: s.hAlignRel, align: s.hAlign } : s.hMode === 'book' ? { rel: s.hBookRel, align: s.hBook } : { rel: s.hAbsRel, offset: s.hAbs };
    }
    if (changed('vMode', 'vAlign', 'vAlignRel', 'vAbs', 'vAbsRel')) {
      f.v = s.vMode === 'align' ? { rel: s.vAlignRel, align: s.vAlign } : { rel: s.vAbsRel, offset: s.vAbs };
    }
    if (changed('wRel')) f.relWidth = s.wRel ? { rel: s.wRel.rel, pct: s.wRel.pct } : null;
    if (changed('hRel')) f.relHeight = s.hRel ? { rel: s.hRel.rel, pct: s.hRel.pct } : null;
    if (changed('inCell')) f.layoutInCell = !!s.inCell;
    if (Object.keys(f).length) steps.push(['arrange.float', f]);
    // A position set above already says what the object moves with.
    if (s.moveWithText !== start.moveWithText && !f.v) steps.push(['arrange.moveWithText', { value: !!s.moveWithText }]);
  }
  if (changed('w', 'h')) steps.push([o.type === 'image' ? 'picture.size' : 'arrange.bounds', { width: s.w, height: s.h }]);
  if (changed('rotate')) steps.push(['arrange.rotation', { degrees: s.rotate }]);
  return steps;
}
