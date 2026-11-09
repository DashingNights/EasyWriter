// Word's Phonetic Guide (probe/dialogs/phonetic-guide.json wins: base and ruby rows per character, Group, Mono, Clear Readings,
// Default Readings, Alignment 1-2-1 by default, Offset 0 pt, Size 6 pt, Font Aptos, Preview). OK replaces each group that has a
// reading with a ruby node {base, text, align, size, offset, font} keeping the group's marks, and turns groups without one (Clear
// Readings on existing ruby) back into text. Each group remembers its own document range and OK rewrites only those ranges, so
// other inline nodes in the selection (breaks, fields, notes, images) and paragraph boundaries stay as they are.
import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Fieldset, Pick, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { REASONS } from '../../../tooling/reasons.mjs';
import { ctxOf } from '../../../tooling/registry.js';
import { fontLabel, fontsNow } from '../../fonts.js';
import { wordRange } from './extension.js';

const ALIGNS = [['center', 'Centered'], ['distributeLetter', '0-1-0'], ['distributeSpace', '1-2-1'], ['left', 'Left'], ['right', 'Right']];
const SIZES = [4, 5, 6, 7, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72].map((s) => [String(s), String(s)]);
const ROWS = 5; // rows shown before the list scrolls, as captured

/** The selection (or the word at the caret) as groups → {groups: [{base, text, marks, from, to, plain}], ruby: first ruby's attrs
 * | null}. A group is one text character or one ruby node; `plain` marks a text character nobody has changed yet. */
function groupsOf(state) {
  if (!state) return { groups: [], ruby: null };
  let { from, to, empty } = state.selection;
  if (empty) ({ from, to } = wordRange(state, true) ?? { from, to });
  const groups = [];
  let ruby = null;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const a = Math.max(from, pos) - pos;
      const b = Math.min(to, pos + node.nodeSize) - pos;
      // Text offsets count UTF-16 units, so a character outside the BMP spans two positions.
      let at = pos + a;
      for (const ch of node.text.slice(a, b)) {
        groups.push({ base: ch, text: '', marks: node.marks, from: at, to: at + ch.length, plain: ch });
        at += ch.length;
      }
    } else if (node.type.name === 'ruby') {
      ruby ??= node.attrs;
      groups.push({ base: node.attrs.base, text: node.attrs.text, marks: node.marks, from: pos, to: pos + 1 });
    }
    return !node.isInline;
  });
  return { groups, ruby };
}

/** `groups` with each stretch of touching groups joined into one (Group); groups split by another node stay apart. */
function joinTouching(groups) {
  const out = [];
  for (const g of groups) {
    const last = out[out.length - 1];
    if (last && last.to === g.from) out[out.length - 1] = { ...last, base: last.base + g.base, text: last.text + g.text, to: g.to, plain: undefined };
    else out.push({ ...g, plain: undefined });
  }
  return out;
}

/** The engine's phonetic guide at the selection (format.phonetic's state: {base, ruby, align, size, offset, existing}) as the
 * dialog's groups: one group over the selection, as the engine keeps one ruby per selection. */
const engineGroups = (e) => ({ groups: e?.base ? [{ base: e.base, text: e.ruby ?? '', from: 0, to: 0 }] : [],
  ruby: e?.existing ? { align: e.align, size: e.size, offset: e.offset } : null });

/** → true after replacing the text (null on Cancel). On a canvas draft the row passes the engine's guide (`engine`) and OK writes
 * format.phonetic: the base text is the selection's (read-only) and Mono, which needs a ruby per character, is off. */
export function PhoneticGuide({ onClose, engine = null }) {
  const ctx = ctxOf();
  const canvas = !!engine && !!ctx.engine;
  const init = useMemo(() => (canvas ? engineGroups(engine) : groupsOf(ctx.state)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [groups, setGroups] = useState(init.groups);
  const [align, setAlign] = useState(init.ruby?.align ?? 'distributeSpace');
  const [offset, setOffset] = useState(init.ruby?.offset ?? 0);
  const [size, setSize] = useState(String(init.ruby?.size ?? 6));
  const [font, setFont] = useState(init.ruby?.font ?? 'Aptos');
  const fonts = useMemo(() => fontsNow().map((f) => [f, fontLabel(f)]), []);
  const edit = (i, key) => (e) => setGroups((g) => g.map((x, j) => (j === i ? { ...x, [key]: e.target.value } : x)));
  const many = groups.length > 1;
  const long = groups.some((g) => g.base.length > 1);
  const read = groups.some((g) => g.text);

  const group = () => setGroups(joinTouching);
  // Mono splits every group into its characters; a reading stays with the group's first character, which takes the group's range,
  // and the others are inserted after it.
  const mono = () => setGroups((g) => g.flatMap((x) => [...x.base].map((ch, i) => ({
    base: ch, text: i ? '' : x.text, marks: x.marks, from: i ? x.to : x.from, to: x.to,
  }))));
  const clear = () => setGroups((g) => g.map((x) => ({ ...x, text: '' })));

  const result = () => {
    const c = ctxOf();
    if (canvas) {
      if (groups.length) {
        // ponytail: the engine's ruby has no font of its own; it takes the base text's.
        Promise.resolve(c.engine.exec('format.phonetic', { ruby: groups.map((g) => g.text).join('') || null, align, size: Number(size) || 6, offset }))
          .then((r) => r?.ok === false && c.toast(`Could not set the phonetic guide: ${r.error ?? 'the engine refused it'}`));
      }
      return true;
    }
    const schema = c.state?.schema;
    if (!schema || !groups.length) return true;
    const attrs = { align, size: Number(size) || 6, offset, font };
    c.chain((ch) => ch.command(({ tr }) => {
      // Last to first, so the earlier ranges keep their positions.
      for (const g of [...groups].reverse()) {
        if (!g.text && g.plain !== undefined && g.base === g.plain) continue;
        const node = !g.base ? null : g.text ? schema.nodes.ruby.create({ base: g.base, text: g.text, ...attrs }, null, g.marks) : schema.text(g.base, g.marks);
        if (node) tr.replaceWith(g.from, g.to, node);
        else tr.delete(g.from, g.to);
      }
      return true;
    }));
    return true;
  };

  const btn = (label, onClick, disabled) => (
    <Button type="button" variant="outline" size="sm" className="w-32" disabled={disabled} onClick={onClick} {...accessProps(label)}><AccessText label={label} /></Button>
  );
  return (
    <WordDialog title="Phonetic Guide" size="md" onClose={onClose} result={result}>
      <div data-phonetic-guide="" className="flex flex-col gap-3">
        <div className="flex gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="grid grid-cols-[2fr_3fr] gap-1 text-xs">
              <label htmlFor="pg-base-0" {...accessProps('&Base text:')}><AccessText label="&Base text:" /></label>
              <label htmlFor="pg-ruby-0" {...accessProps('&Ruby text:')}><AccessText label="&Ruby text:" /></label>
            </div>
            <div className="flex flex-col gap-1 overflow-auto" style={{ maxHeight: `${ROWS * 1.75}rem` }}>
              {!groups.length && <p className="text-xs text-muted-foreground">Select the text to add a reading to.</p>}
              {groups.map((g, i) => (
                <div key={i} className="grid grid-cols-[2fr_3fr] gap-1">
                  <Input size="xs" id={`pg-base-${i}`} aria-label={`Base text ${i + 1}`} value={g.base} onChange={edit(i, 'base')} readOnly={canvas} />
                  <Input size="xs" id={`pg-ruby-${i}`} aria-label={`Ruby text ${i + 1}`} value={g.text} onChange={edit(i, 'text')} />
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {btn('&Group', group, !many)}
            {btn('&Mono', mono, !long || canvas)}
            {btn('&Clear Readings', clear, !read)}
            {btn('&Default Readings', () => ctx.toast(REASONS.ime))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Row label="A&lignment:" htmlFor="pg-align"><Pick id="pg-align" value={align} options={ALIGNS} onChange={setAlign} width="10rem" /></Row>
          <Spin label="&Offset:" value={offset} unit="pt" min={0} max={100} onChange={(v) => setOffset(v ?? 0)} width="5rem" />
          {/* Editable combo boxes, as in Word: a typed font name or size is accepted. */}
          <Row label="&Font:" htmlFor="pg-font">
            <Combobox size="xs" id="pg-font" aria-label="Font" className="w-40" value={font} text={font} options={fonts}
              onCommit={(t) => t.trim() && setFont(t.trim())} onPick={setFont} onDone={() => {}} contentProps={{ className: 'max-h-60 overflow-y-auto' }} />
          </Row>
          <Row label="&Size:" htmlFor="pg-size">
            <Combobox size="xs" id="pg-size" aria-label="Size" className="w-20 tabular-nums" value={size} text={size} options={SIZES}
              onCommit={(t) => Number(t) > 0 && setSize(String(Number(t)))} onPick={setSize} onDone={() => {}} contentProps={{ className: 'max-h-60 overflow-y-auto' }} />
          </Row>
        </div>
        <Fieldset legend="Preview">
          <div className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-xl text-black">
            {groups.map((g, i) => (g.text ? (
              <ruby key={i} style={{ rubyAlign: { center: 'center', distributeLetter: 'space-between', left: 'start' }[align] ?? 'space-around' }}>
                {g.base}<rt style={{ fontSize: `${Number(size) || 6}pt`, fontFamily: `"${font}"`, marginBottom: offset ? `${offset}pt` : undefined }}>{g.text}</rt>
              </ruby>
            ) : <span key={i}>{g.base}</span>))}
          </div>
        </Fieldset>
      </div>
    </WordDialog>
  );
}
