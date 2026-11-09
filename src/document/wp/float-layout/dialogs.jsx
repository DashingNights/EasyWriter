// float-layout's dialogs (docs/plans/word/plan.md §1.6): Layout (tabs position, textWrapping, size; probe/dialogs/layout.json and
// layout-picture.json for every label, list and default) and Frame (index-layout.md Text boxes and frames; no capture). Both apply
// on OK as one undo step; Frame also takes {mode: 'value', value} and then returns the edited frame instead (Modify Style).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ctxOf } from '../../../tooling/registry.js';
import { Check, Fieldset, Pick, Radio, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { full, newFloat, PT, round, withWrap } from './place.mjs';
import { drawnAt, floatObj, layoutOf } from './plugin.js';
import { layoutSteps, stateOfObject } from './engine-layout.mjs';

const MARGIN = ['margin', 'Margin'];
const PAGE = ['page', 'Page'];
const H_REL = [MARGIN, PAGE, ['column', 'Column'], ['character', 'Character'], ['leftMargin', 'Left Margin'], ['rightMargin', 'Right Margin'],
  ['insideMargin', 'Inside Margin'], ['outsideMargin', 'Outside Margin']];
const H_PCT_REL = [MARGIN, PAGE, ['leftMargin', 'Left Margin'], ['rightMargin', 'Right Margin'], ['insideMargin', 'Inside Margin'], ['outsideMargin', 'Outside Margin']];
const V_ALIGN_REL = [MARGIN, PAGE, ['line', 'Line'], ['topMargin', 'Top Margin'], ['bottomMargin', 'Bottom Margin'], ['insideMargin', 'Inside Margin'],
  ['outsideMargin', 'Outside Margin']];
const V_ABS_REL = [MARGIN, PAGE, ['paragraph', 'Paragraph'], ['line', 'Line'], ['topMargin', 'Top Margin'], ['bottomMargin', 'Bottom Margin'],
  ['insideMargin', 'Inside Margin'], ['outsideMargin', 'Outside Margin']];
const V_PCT_REL = [MARGIN, PAGE, ['topMargin', 'Top Margin'], ['bottomMargin', 'Bottom Margin'], ['insideMargin', 'Inside Margin'], ['outsideMargin', 'Outside Margin']];
const SIZE_REL_H = [MARGIN, PAGE, ['topMargin', 'Top Margin'], ['bottomMargin', 'Bottom Margin'], ['insideMargin', 'Inside Margin'], ['outsideMargin', 'Outside Margin']];
const SIZE_REL_W = H_PCT_REL;
const WRAPS = [['inline', '&In line with text'], ['square', 'S&quare'], ['tight', '&Tight'], ['through', 'T&hrough'], ['topBottom', 'T&op and bottom'],
  ['behind', '&Behind text'], ['front', 'In &front of text']];
const SIDES = [['both', 'Both &sides'], ['left', '&Left only'], ['right', '&Right only'], ['largest', 'L&argest only']];

/** A spin box the harness and screen readers find by name while Word draws it without a label of its own. */
const Named = ({ name, children }) => <div data-label={name} aria-label={name}>{children}</div>;

/** The dialog's state from layout `l` (full, or null for In Line) and the object `node` of `kind`. */
function stateOf(l, node, kind, dom) {
  const f = l ?? { ...newFloat('inline'), h: { rel: 'column', offset: 0 }, v: { rel: 'paragraph', offset: 0 } };
  const h = f.h ?? {};
  const v = f.v ?? {};
  const book = h.align === 'inside' || h.align === 'outside';
  const picture = kind === 'picture' || kind === 'graphic';
  const w = picture ? (node.attrs.width ?? dom?.offsetWidth ?? 0) * 0.75 : kind === 'textbox' ? node.attrs.w : (dom?.offsetWidth ?? 0) * 0.75;
  const ht = picture ? (node.attrs.height ?? dom?.offsetHeight ?? 0) * 0.75 : kind === 'textbox' ? node.attrs.h : (dom?.offsetHeight ?? 0) * 0.75;
  const img = dom?.querySelector?.('img');
  const orig = picture ? { w: (node.attrs.orig?.w ?? img?.naturalWidth ?? w / 0.75) * 0.75, h: (node.attrs.orig?.h ?? img?.naturalHeight ?? ht / 0.75) * 0.75 } : null;
  return {
    wrap: l?.wrap ?? 'inline', side: f.side, dist: { ...f.dist },
    hMode: h.pct != null ? 'pct' : book ? 'book' : h.align ? 'align' : 'abs',
    hAlign: !book && h.align ? h.align : 'left', hAlignRel: h.rel ?? 'column', hBook: book ? h.align : 'inside', hBookRel: h.rel === 'page' ? 'page' : 'margin',
    hAbs: h.offset ?? 0, hAbsRel: h.rel ?? 'column', hPct: h.pct ?? 0, hPctRel: h.pct != null ? h.rel : 'page',
    vMode: v.pct != null ? 'pct' : v.align ? 'align' : 'abs',
    vAlign: v.align ?? 'top', vAlignRel: v.align ? v.rel : 'page', vAbs: v.offset ?? 0, vAbsRel: v.rel ?? 'paragraph', vPct: v.pct ?? 0, vPctRel: v.pct != null ? v.rel : 'page',
    moveWithText: f.moveWithText, lockAnchor: f.lockAnchor, allowOverlap: f.allowOverlap, inCell: f.inCell,
    w, h: ht, wRel: f.relSize?.w ?? null, hRel: f.relSize?.h ?? null, rotate: node.attrs.rotate ?? 0,
    lock: picture, relOrig: false, orig,
  };
}

/** The Layout dialog (plan.md §1.6 dialog `layout`, tabs position, textWrapping and size). → true when applied, else null. On a
 * canvas draft `object` is the engine's (object.get, canvas/rows/objects.mjs layoutDialog) and OK applies what changed through the
 * engine in one undo step (engine-layout.mjs); relative positions, Lock anchor and Allow overlap are not in the engine's model. */
export function LayoutDialog({ tab = 'position', onClose, object }) {
  const ctx = ctxOf();
  const eng = !!object && !!ctx.engine;
  const o = eng ? null : floatObj(ctx);
  const node = o && ctx.state.doc.nodeAt(o.pos);
  const dom = node && ctx.target.view.nodeDOM(o.pos);
  const [s, setS] = useState(() => (eng ? stateOfObject(object) : node ? stateOf(full(layoutOf(node)), node, o.kind, dom) : null));
  const [start] = useState(s);
  const [now, setTab] = useState(tab);
  if (!eng && !node) {
    return <WordDialog title="Layout" size="sm" onClose={onClose} result={() => null}><p>Select a picture, text box or canvas first.</p></WordDialog>;
  }
  const set = (key) => (value) => setS((x) => ({ ...x, [key]: value }));
  const setDist = (key) => (value) => setS((x) => ({ ...x, dist: { ...x.dist, [key]: value ?? 0 } }));
  const picture = eng ? object.type === 'image' : o.kind === 'picture' || o.kind === 'graphic';
  const sizable = eng || picture || o.kind === 'textbox';
  // Scale and the absolute size move together; Lock aspect ratio keeps width over height.
  const setSize = (key, value) => setS((x) => {
    if (value == null) return x;
    const next = { ...x, [key]: value };
    if (x.lock && x[key]) {
      const other = key === 'w' ? 'h' : 'w';
      next[other] = round((x[other] * value) / x[key]);
    }
    return next;
  });
  const scaleOf = (key) => (s.orig?.[key] ? round((s[key] / s.orig[key]) * 100) : 100);
  const setScale = (key) => (pct) => s.orig && pct != null && setSize(key, round((s.orig[key] * pct) / 100));
  const pick = (key, list, label, id) => <Row label={label} htmlFor={id}><Pick id={id} value={s[key]} options={list} onChange={set(key)} width="9rem" /></Row>;

  const position = () => (
    <div className="flex flex-col gap-3">
      <Fieldset legend="Horizontal">
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <Radio name="fl-h" value={s.hMode} options={[['align', '&Alignment']]} onChange={set('hMode')} />
          <div className="flex gap-3"><Pick aria-label="Horizontal Alignment" value={s.hAlign} options={[['left', 'Left'], ['center', 'Centered'], ['right', 'Right']]}
            onChange={set('hAlign')} width="8rem" />{pick('hAlignRel', H_REL, '&relative to', 'fl-h-align-rel')}</div>
          <Radio name="fl-h" value={s.hMode} options={[['book', '&Book layout']]} onChange={set('hMode')} />
          <div className="flex gap-3"><Pick aria-label="Book layout" value={s.hBook} options={[['inside', 'Inside'], ['outside', 'Outside']]} onChange={set('hBook')}
            width="8rem" />{pick('hBookRel', [MARGIN, PAGE], 'o&f', 'fl-h-book-rel')}</div>
          <Radio name="fl-h" value={s.hMode} options={[['abs', 'Absolute &position']]} onChange={set('hMode')} />
          <div className="flex gap-3"><Named name="Horizontal absolute position"><Spin value={s.hAbs} onChange={(v) => setS((x) => ({ ...x, hAbs: v ?? 0, hMode: 'abs' }))}
            unit="len" min={-1584} max={1584} width="8rem" /></Named>{pick('hAbsRel', H_REL, '&to the right of', 'fl-h-abs-rel')}</div>
          {!eng && <Radio name="fl-h" value={s.hMode} options={[['pct', '&Relative position']]} onChange={set('hMode')} />}
          {!eng && <div className="flex gap-3"><Named name="Horizontal relative position"><Spin value={s.hPct} onChange={set('hPct')} unit="pct" min={-1000} max={1000}
            width="8rem" /></Named>{pick('hPctRel', H_PCT_REL, 'r&elative to', 'fl-h-pct-rel')}</div>}
        </div>
      </Fieldset>
      <Fieldset legend="Vertical">
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <Radio name="fl-v" value={s.vMode} options={[['align', 'Ali&gnment']]} onChange={set('vMode')} />
          <div className="flex gap-3"><Pick aria-label="Vertical Alignment" value={s.vAlign} onChange={set('vAlign')} width="8rem"
            options={[['top', 'Top'], ['center', 'Centered'], ['bottom', 'Bottom'], ['inside', 'Inside'], ['outside', 'Outside']]} />
            {pick('vAlignRel', V_ALIGN_REL, 'r&elative to', 'fl-v-align-rel')}</div>
          <Radio name="fl-v" value={s.vMode} options={[['abs', 'Ab&solute position']]} onChange={set('vMode')} />
          <div className="flex gap-3"><Named name="Vertical absolute position"><Spin value={s.vAbs} onChange={(v) => setS((x) => ({ ...x, vAbs: v ?? 0, vMode: 'abs' }))}
            unit="len" min={-1584} max={1584} width="8rem" /></Named>{pick('vAbsRel', V_ABS_REL, 'belo&w', 'fl-v-abs-rel')}</div>
          {!eng && <Radio name="fl-v" value={s.vMode} options={[['pct', 'Relat&ive position']]} onChange={set('vMode')} />}
          {!eng && <div className="flex gap-3"><Named name="Vertical relative position"><Spin value={s.vPct} onChange={set('vPct')} unit="pct" min={-1000} max={1000}
            width="8rem" /></Named>{pick('vPctRel', V_PCT_REL, 'relative t&o', 'fl-v-pct-rel')}</div>}
        </div>
      </Fieldset>
      <Fieldset legend="Options">
        <div className="grid grid-cols-2 gap-2">
          <Check label="&Move object with text" checked={s.moveWithText} onChange={set('moveWithText')} />
          <Check label="Allow o&verlap" checked={s.allowOverlap} onChange={set('allowOverlap')} disabled={eng} />
          <Check label="&Lock anchor" checked={s.lockAnchor} onChange={set('lockAnchor')} disabled={eng} />
          <Check label="Layout in table &cell" checked={s.inCell} onChange={set('inCell')} />
        </div>
      </Fieldset>
    </div>
  );

  const wrapping = () => (
    <div className="flex flex-col gap-3">
      <Fieldset legend="Wrapping style"><div className="grid grid-cols-4 gap-2"><Radio name="fl-wrap" value={s.wrap} options={WRAPS} onChange={set('wrap')} /></div></Fieldset>
      <Fieldset legend="Wrap text"><Radio name="fl-side" value={s.side} options={SIDES} onChange={set('side')} /></Fieldset>
      <Fieldset legend="Distance from text">
        <div className="grid grid-cols-2 gap-2">
          <Spin label="To&p" value={s.dist.t} onChange={setDist('t')} unit="len" min={0} max={1584} />
          <Spin label="L&eft" value={s.dist.l} onChange={setDist('l')} unit="len" min={0} max={1584} />
          <Spin label="Botto&m" value={s.dist.b} onChange={setDist('b')} unit="len" min={0} max={1584} />
          <Spin label="Ri&ght" value={s.dist.r} onChange={setDist('r')} unit="len" min={0} max={1584} />
        </div>
      </Fieldset>
    </div>
  );

  const size = () => (
    <div className="flex flex-col gap-3">
      <Fieldset legend="Height">
        <div className="flex items-center gap-3">
          <Radio name="fl-sh" value={s.hRel ? 'rel' : 'abs'} options={[['abs', 'Absolut&e']]} onChange={() => set('hRel')(null)} />
          <Named name="Absolute height"><Spin value={s.h} onChange={(v) => setSize('h', v)} unit="len" min={1} max={1584} /></Named>
        </div>
        <div className="flex items-center gap-3">
          <Radio name="fl-sh" value={s.hRel ? 'rel' : 'abs'} options={[['rel', 'Re&lative']]} onChange={() => set('hRel')({ pct: 100, rel: 'margin' })} />
          <Named name="Relative height"><Spin value={s.hRel?.pct ?? null} onChange={(v) => set('hRel')({ ...(s.hRel ?? { rel: 'margin' }), pct: v ?? 0 })} unit="pct" min={1} max={1000} /></Named>
          <Row label="rela&tive to" htmlFor="fl-sh-rel"><Pick id="fl-sh-rel" value={s.hRel?.rel ?? 'margin'} options={SIZE_REL_H} disabled={!s.hRel}
            onChange={(rel) => set('hRel')({ ...(s.hRel ?? { pct: 100 }), rel })} /></Row>
        </div>
      </Fieldset>
      <Fieldset legend="Width">
        <div className="flex items-center gap-3">
          <Radio name="fl-sw" value={s.wRel ? 'rel' : 'abs'} options={[['abs', 'A&bsolute']]} onChange={() => set('wRel')(null)} />
          <Named name="Absolute width"><Spin value={s.w} onChange={(v) => setSize('w', v)} unit="len" min={1} max={1584} /></Named>
        </div>
        <div className="flex items-center gap-3">
          <Radio name="fl-sw" value={s.wRel ? 'rel' : 'abs'} options={[['rel', 'Relat&ive']]} onChange={() => set('wRel')({ pct: 100, rel: 'margin' })} />
          <Named name="Relative width"><Spin value={s.wRel?.pct ?? null} onChange={(v) => set('wRel')({ ...(s.wRel ?? { rel: 'margin' }), pct: v ?? 0 })} unit="pct" min={1} max={1000} /></Named>
          <Row label="r&elative to" htmlFor="fl-sw-rel"><Pick id="fl-sw-rel" value={s.wRel?.rel ?? 'margin'} options={SIZE_REL_W} disabled={!s.wRel}
            onChange={(rel) => set('wRel')({ ...(s.wRel ?? { pct: 100 }), rel })} /></Row>
        </div>
      </Fieldset>
      <Fieldset legend="Rotate">
        <Spin label="Ro&tation:" value={s.rotate} onChange={(v) => set('rotate')(v ?? 0)} unit="int" min={-3600} max={3600} />
      </Fieldset>
      <Fieldset legend="Scale">
        <div className="flex gap-3">
          <Spin label="&Height:" value={scaleOf('h')} onChange={setScale('h')} unit="pct" min={1} max={10000} />
          <Spin label="&Width:" value={scaleOf('w')} onChange={setScale('w')} unit="pct" min={1} max={10000} />
        </div>
        <Check label="Lock &aspect ratio" checked={s.lock} onChange={set('lock')} />
        <Check label="&Relative to original picture size" checked={s.relOrig} onChange={set('relOrig')} disabled={!picture} />
      </Fieldset>
      <Fieldset legend="Original size">
        <div className="flex items-center gap-6 text-xs">
          <span>Height: {s.orig ? `${round(s.orig.h / 28.3465)} cm` : ''}</span>
          <span>Width: {s.orig ? `${round(s.orig.w / 28.3465)} cm` : ''}</span>
          <Button type="button" variant="outline" size="xs" disabled={!s.orig} className="ml-auto"
            onClick={() => setS((x) => ({ ...x, w: x.orig.w, h: x.orig.h, rotate: 0, wRel: null, hRel: null }))}>Re<u>s</u>et</Button>
        </div>
      </Fieldset>
      {!sizable && <p className="text-xs text-muted-foreground">This object keeps its own size.</p>}
    </div>
  );

  const apply = () => {
    if (eng) {
      const steps = layoutSteps(start, s, object);
      return steps.length ? Promise.resolve(ctx.engine.execMany(steps)).then((r) => (r?.ok ? true : null), () => null) : true;
    }
    const view = ctx.target.view;
    const { state } = view;
    const n = state.doc.nodeAt(o.pos);
    if (!n) return null;
    const stored = layoutOf(n);
    const h = s.hMode === 'align' ? { rel: s.hAlignRel, align: s.hAlign } : s.hMode === 'book' ? { rel: s.hBookRel, align: s.hBook }
      : s.hMode === 'pct' ? { rel: s.hPctRel, pct: s.hPct } : { rel: s.hAbsRel, offset: s.hAbs };
    const v = s.vMode === 'align' ? { rel: s.vAlignRel, align: s.vAlign } : s.vMode === 'pct' ? { rel: s.vPctRel, pct: s.vPct } : { rel: s.vAbsRel, offset: s.vAbs };
    let layout;
    if (s.wrap === 'inline') layout = withWrap(stored, 'inline', o.kind);
    else {
      const base = full(stored) ? stored : withWrap(stored, s.wrap, o.kind, drawnAt(view, o.pos));
      const relSize = s.wRel || s.hRel ? { ...(s.wRel && { w: s.wRel }), ...(s.hRel && { h: s.hRel }) } : null;
      layout = { ...base, wrap: s.wrap, side: s.side, dist: s.dist, h, v, moveWithText: s.moveWithText, lockAnchor: s.lockAnchor, allowOverlap: s.allowOverlap,
        inCell: s.inCell, relSize };
    }
    const tr = state.tr.setNodeAttribute(o.pos, 'layout', layout);
    if (picture) {
      tr.setNodeAttribute(o.pos, 'width', Math.round(s.w / 0.75)).setNodeAttribute(o.pos, 'height', Math.round(s.h / 0.75));
      tr.setNodeAttribute(o.pos, 'rotate', s.rotate || null);
    } else if (o.kind === 'textbox') {
      tr.setNodeAttribute(o.pos, 'w', round(s.w)).setNodeAttribute(o.pos, 'h', round(s.h)).setNodeAttribute(o.pos, 'rotate', s.rotate || 0);
    }
    view.dispatch(tr);
    return true;
  };

  return (
    <WordDialog title="Layout" size="lg" onClose={onClose} tab={now} onTab={setTab} result={apply}
      tabs={[{ id: 'position', label: 'Position', render: position }, { id: 'textWrapping', label: 'Text Wrapping', render: wrapping },
        { id: 'size', label: 'Size', render: size }]} />
  );
}

// ---------------------------------------------------------------------------------------------

const H_POS = [['left', 'Left'], ['right', 'Right'], ['center', 'Center'], ['inside', 'Inside'], ['outside', 'Outside'], ['', '(Exactly)']];
const V_POS = [['top', 'Top'], ['bottom', 'Bottom'], ['center', 'Center'], ['', '(Exactly)']];

/** The paragraphs the Frame dialog edits: the selection's textblocks → [pos]. */
function framedParas(state) {
  const out = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (n, pos) => {
    if (n.isTextblock && n.type.spec.attrs?.frame !== undefined) out.push(pos);
    return !n.isTextblock;
  });
  return out;
}

/** The Frame dialog (plan.md §1.6 dialog `frame`). Applies to the selection's paragraphs → true, 'removed', the edited frame in
 * value mode, or null. Positions entered as lengths use '(Exactly)' with the box under the list (deviation: Word types them into
 * the list itself). */
export function FrameDialog({ mode, value, onClose }) {
  const ctx = mode === 'value' ? null : ctxOf();
  const paras = ctx?.state ? framedParas(ctx.state) : [];
  const first = ctx && paras.length ? ctx.state.doc.nodeAt(paras[0]).attrs.frame : null;
  const [f, setF] = useState(() => ({ wrap: 'around', w: null, h: null, hRule: 'auto', hAnchor: 'column', vAnchor: 'paragraph', x: 0, xAlign: 'left',
    y: 0, yAlign: null, hSpace: 0, vSpace: 0, lockAnchor: false, ...(mode === 'value' ? value : first) }));
  const set = (key) => (v) => setF((x) => ({ ...x, [key]: v }));
  const result = () => {
    const frame = { dropCap: null, lines: null, ...f };
    if (mode === 'value') return frame;
    const view = ctx?.target?.view;
    if (!view || !paras.length) return null;
    const tr = view.state.tr;
    for (const pos of paras) tr.setNodeAttribute(pos, 'frame', { ...(view.state.doc.nodeAt(pos).attrs.frame ?? {}), ...frame });
    view.dispatch(tr);
    return true;
  };
  const remove = () => {
    if (mode === 'value') return onClose(null);
    const view = ctx?.target?.view;
    if (view && paras.length) {
      const tr = view.state.tr;
      for (const pos of paras) tr.setNodeAttribute(pos, 'frame', null);
      view.dispatch(tr);
    }
    onClose('removed');
  };
  const anchorOfH = { margin: 'margin', page: 'page', column: 'text', text: 'text' };
  return (
    <WordDialog title="Frame" size="md" onClose={onClose} result={result} left={[{ label: '&Remove Frame', onClick: remove }]}>
      <div className="flex flex-col gap-3">
        <Fieldset legend="Text wrapping"><Radio name="fl-fw" value={f.wrap === 'none' ? 'none' : 'around'} options={[['none', '&None'], ['around', '&Around']]} onChange={set('wrap')} /></Fieldset>
        <Fieldset legend="Size">
          <div className="flex items-center gap-3">
            <Row label="W&idth:" htmlFor="fl-fw-rule"><Pick id="fl-fw-rule" value={f.w == null ? 'auto' : 'exact'} options={[['auto', 'Auto'], ['exact', 'Exactly']]}
              onChange={(k) => set('w')(k === 'auto' ? null : f.w ?? 144)} /></Row>
            {f.w != null && <Spin label="&At:" value={f.w} onChange={(v) => set('w')(v ?? 144)} unit="len" min={1} max={1584} />}
          </div>
          <div className="flex items-center gap-3">
            <Row label="H&eight:" htmlFor="fl-fh-rule"><Pick id="fl-fh-rule" value={f.hRule ?? 'auto'} options={[['auto', 'Auto'], ['atLeast', 'At least'], ['exact', 'Exactly']]}
              onChange={(k) => setF((x) => ({ ...x, hRule: k, h: k === 'auto' ? null : x.h ?? 72 }))} /></Row>
            {f.hRule && f.hRule !== 'auto' && <Spin label="A&t:" value={f.h} onChange={(v) => set('h')(v ?? 72)} unit="len" min={1} max={1584} />}
          </div>
        </Fieldset>
        <Fieldset legend="Horizontal">
          <div className="flex items-center gap-3">
            <Row label="P&osition:" htmlFor="fl-fx"><Pick id="fl-fx" value={f.xAlign ?? ''} options={H_POS} onChange={(a) => set('xAlign')(a || null)} /></Row>
            {!f.xAlign && <Named name="Horizontal position"><Spin value={f.x ?? 0} onChange={(v) => set('x')(v ?? 0)} unit="len" min={-1584} max={1584} /></Named>}
            <Row label="Rela&tive to:" htmlFor="fl-fxa"><Pick id="fl-fxa" value={anchorOfH[f.hAnchor] ?? 'text'} onChange={set('hAnchor')}
              options={[['margin', 'Margin'], ['page', 'Page'], ['text', 'Column']]} /></Row>
          </div>
          <Spin label="&Distance from text:" value={f.hSpace ?? 0} onChange={(v) => set('hSpace')(v ?? 0)} unit="len" min={0} max={1584} />
        </Fieldset>
        <Fieldset legend="Vertical">
          <div className="flex items-center gap-3">
            <Row label="Po&sition:" htmlFor="fl-fy"><Pick id="fl-fy" value={f.yAlign ?? ''} options={V_POS} onChange={(a) => set('yAlign')(a || null)} /></Row>
            {!f.yAlign && <Named name="Vertical position"><Spin value={f.y ?? 0} onChange={(v) => set('y')(v ?? 0)} unit="len" min={-1584} max={1584} /></Named>}
            <Row label="Rel&ative to:" htmlFor="fl-fya"><Pick id="fl-fya" value={f.vAnchor === 'paragraph' ? 'text' : f.vAnchor ?? 'text'} onChange={set('vAnchor')}
              options={[['margin', 'Margin'], ['page', 'Page'], ['text', 'Paragraph']]} /></Row>
          </div>
          <Spin label="Distance from te&xt:" value={f.vSpace ?? 0} onChange={(v) => set('vSpace')(v ?? 0)} unit="len" min={0} max={1584} />
          <div className="flex gap-6">
            <Check label="&Move with text" checked={f.vAnchor === 'text' || f.vAnchor === 'paragraph'} onChange={(on) => set('vAnchor')(on ? 'text' : 'page')} />
            <Check label="&Lock anchor" checked={!!f.lockAnchor} onChange={set('lockAnchor')} />
          </div>
        </Fieldset>
      </div>
    </WordDialog>
  );
}
