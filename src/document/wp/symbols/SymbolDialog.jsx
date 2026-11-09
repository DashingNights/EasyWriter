// The Symbol dialog (probe/dialogs/symbol.json): the Symbols tab (font, subset, a 16-column grid that draws only its visible rows,
// recently used symbols, Unicode name, character code and shortcut key) and the Special Characters tab. Opened from the ribbon
// it inserts the pick (Insert); in value mode ({mode: 'value', value}) it returns {char, font} instead (plan.md §1.6).
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from 'cn';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tip } from '../../../app/components/Tip.jsx';
import { fontLabel, fontsNow, listFonts } from '../../fonts.js';
import { fontStack } from '../../../office.mjs';
import { Pick, Row, rowClass } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { ctxOf } from '../../../tooling/registry.js';
import { REASONS } from '../../../tooling/reasons.mjs';
import {
  BLOCKS, blockOf, charOf, CODE_FROM, codeOf, isSymbolFont, recentLabel, recentOf, shortcutOf, shownOf, SPECIAL, SYMBOL_FONTS, textCells,
} from './chars.mjs';
import { insertSymbol } from './insert.js';

const COLS = 16;
const ROWS = 4; // rows in view
const CELL = 36; // px
const NORMAL = '(normal text)';
const ASIAN = '(Asian text)';
const SYMBOL_CODES = Uint32Array.from({ length: 224 }, (_, i) => i + 32); // a symbol font's codes 32 to 255

/** The CSS font family of the text at the target's caret, for '(normal text)'. */
function caretFamily(ctx) {
  if (ctx.engine) return ctx.stateOf?.('format.font')?.value ?? 'inherit'; // a canvas draft: the engine's font at the caret
  try {
    const { view, state } = ctx.target;
    const { node } = view.domAtPos(state.selection.from);
    const el = node.nodeType === 1 ? node : node.parentElement;
    return getComputedStyle(el).fontFamily;
  } catch {
    return 'inherit';
  }
}

/** The font list: the caret's font, Asian text, then the app's fonts and the symbol fonts in name order. */
function useFonts() {
  const [list, setList] = useState(fontsNow);
  useEffect(() => {
    let live = true;
    listFonts().then((l) => live && setList(l));
    return () => { live = false; };
  }, []);
  return useMemo(() => [NORMAL, ASIAN, ...[...new Set([...list, ...Object.keys(SYMBOL_FONTS)])].sort((a, b) => a.localeCompare(b))], [list]);
}

/** Whether a dialog id is registered (dialogs.js imports the hub, so it loads late, never at this module's import). */
function useHasDialog(id) {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let live = true;
    import('../../../tooling/dialogs.js').then((m) => live && setHas(!!m.WORD_DIALOGS[id]), () => {});
    return () => { live = false; };
  }, [id]);
  return has;
}

/** A first binary search: index of code point `n` in the ascending `cells`, or -1. */
function indexOf(cells, n) {
  let lo = 0;
  let hi = cells.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cells[mid] < n) lo = mid + 1;
    else if (cells[mid] > n) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/** The first index at or after code point `n` in `cells`. */
function indexFrom(cells, n) {
  let lo = 0;
  let hi = cells.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cells[mid] < n) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, cells.length - 1);
}

/** The symbol grid: `count` cells, COLS per row, drawing only the rows in view. `charAt(i)` is cell i's character or ''. */
function Grid({ count, charAt, family, picked, onPick, onInsert, onScrollRow, jump }) {
  const box = useRef(null);
  const [top, setTop] = useState(0);
  const rows = Math.ceil(count / COLS);
  // Scrolls to `y` and draws the rows there at once: a scroll event can come late (or not at all in a window in the background).
  const scrollTo = (y) => {
    const el = box.current;
    el.scrollTop = y;
    setTop(el.scrollTop);
    onScrollRow(Math.floor(el.scrollTop / CELL));
  };
  // Keep the picked cell in view when it moves by keys or by a typed code.
  useEffect(() => {
    const el = box.current;
    if (!el || picked < 0) return;
    const row = Math.floor(picked / COLS);
    if (row * CELL < el.scrollTop) scrollTo(row * CELL);
    else if ((row + 1) * CELL > el.scrollTop + ROWS * CELL) scrollTo((row + 1 - ROWS) * CELL);
  }, [picked]); // eslint-disable-line react-hooks/exhaustive-deps
  // A subset pick scrolls its first row to the top.
  useEffect(() => {
    if (jump && box.current) scrollTo(jump.row * CELL);
  }, [jump]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = Math.max(0, Math.floor(top / CELL) - 1);
  const last = Math.min(rows, first + ROWS + 3);
  const cells = [];
  for (let r = first; r < last; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (i >= count) break;
      const ch = charAt(i);
      cells.push(
        <div key={i} role="gridcell" data-cell={i} aria-selected={i === picked} aria-disabled={!ch || undefined}
          style={{ top: r * CELL, left: c * CELL, width: CELL, height: CELL, fontFamily: family }}
          className="sym-cell absolute grid place-items-center border-r border-b border-neutral-300 text-xl leading-none"
          onMouseDown={(e) => { e.preventDefault(); box.current.focus(); if (ch) onPick(i); }}
          onDoubleClick={() => ch && onInsert(i)}>{ch}</div>,
      );
    }
  }
  const move = (d) => {
    let i = Math.min(count - 1, Math.max(0, (picked < 0 ? 0 : picked) + d));
    // Skip empty cells (a symbol font's codes without a Unicode equivalent) in the direction of travel.
    while (!charAt(i) && i + Math.sign(d) >= 0 && i + Math.sign(d) < count) i += Math.sign(d);
    if (charAt(i)) onPick(i);
  };
  const onKeyDown = (e) => {
    const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS, PageUp: -COLS * ROWS, PageDown: COLS * ROWS }[e.key];
    if (d) {
      e.preventDefault();
      move(d);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const start = Math.floor(Math.max(0, picked) / COLS) * COLS;
      move((e.key === 'Home' ? start : Math.min(count - 1, start + COLS - 1)) - picked);
    }
  };
  return (
    <div ref={box} role="grid" tabIndex={0} aria-label="Symbols" data-symbol-grid="" onKeyDown={onKeyDown}
      onScroll={(e) => { setTop(e.currentTarget.scrollTop); onScrollRow(Math.floor(e.currentTarget.scrollTop / CELL)); }}
      className="relative shrink-0 overflow-y-auto border border-neutral-300 bg-white text-black outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      style={{ height: ROWS * CELL + 2, width: COLS * CELL + 18 }}>
      <div style={{ height: rows * CELL, width: COLS * CELL }} className="relative">{cells}</div>
    </div>
  );
}

/** The Symbols tab's recently used row: 16 symbols, each in its own font where it is a text font. */
function RecentRow({ recent, family, onPick, onInsert }) {
  return (
    <div role="listbox" aria-label="Recently used symbols" data-recent-row="" tabIndex={-1} className="flex shrink-0 border border-neutral-300 bg-white text-black"
      style={{ width: COLS * CELL + 2 }}>
      {Array.from({ length: COLS }, (_, i) => {
        const e = recent[i];
        return (
          <div key={i} role="option" aria-selected={false} aria-label={e ? recentLabel(e) : undefined} data-recent={i}
            style={{ width: CELL, height: CELL, fontFamily: e?.font && !isSymbolFont(e.font) ? fontStack(e.font) : family }}
            className="grid shrink-0 place-items-center border-r border-neutral-300 text-xl leading-none last:border-r-0"
            onMouseDown={(ev) => { ev.preventDefault(); if (e) onPick(e); }} onDoubleClick={() => e && onInsert(e)}>{e?.char}</div>
        );
      })}
    </div>
  );
}

/** {tab?: 'symbols'|'specialCharacters', mode?: 'value', value?: {char, font}} → {char, font} or null. */
export function SymbolDialog({ tab: startTab = 'symbols', mode, value, onClose }) {
  const ctx = ctxOf();
  const valueMode = mode === 'value';
  const fonts = useFonts();
  const hasAutoCorrect = useHasDialog('autoCorrect');
  const recent = recentOf(ctx.settings?.word?.recentSymbols);
  const normalFamily = useMemo(() => caretFamily(ctx), []); // eslint-disable-line react-hooks/exhaustive-deps

  const startFont = value?.font && (isSymbolFont(value.font) || fonts.includes(value.font)) ? value.font : NORMAL;
  const [tab, setTab] = useState(startTab);
  const [font, setFont] = useState(startFont);
  const symbolFont = isSymbolFont(font) ? SYMBOL_FONTS[font] : null;
  const cells = symbolFont ? SYMBOL_CODES : textCells();
  const charAt = (i) => (symbolFont ? symbolFont[cells[i]] ?? '' : i >= 0 && i < cells.length ? String.fromCodePoint(cells[i]) : '');
  const family = font === NORMAL || font === ASIAN ? normalFamily : symbolFont ? normalFamily : fontStack(font);

  const pickOf = (f, char) => {
    if (isSymbolFont(f)) {
      const code = Object.entries(SYMBOL_FONTS[f]).find(([, c]) => c === char)?.[0];
      return code ? Number(code) - 32 : -1;
    }
    return char ? indexOf(textCells(), char.codePointAt(0)) : -1;
  };
  const [picked, setPicked] = useState(() => {
    const start = value?.char ?? (recent.find((e) => !isSymbolFont(e.font))?.char ?? '€');
    return Math.max(0, pickOf(startFont, start));
  });
  const [from, setFrom] = useState('unicode');
  const [codeText, setCodeText] = useState(null); // the box's text while the user types; null shows the picked code
  const [topRow, setTopRow] = useState(0);
  const [jump, setJump] = useState(null);
  const [special, setSpecial] = useState(0);

  const char = charAt(picked);
  const shownCode = symbolFont ? String(cells[picked] ?? '') : char ? codeOf(char, from) : '';
  const subset = symbolFont ? null : blockOf(cells[Math.min(cells.length - 1, topRow * COLS)]);

  const changeFont = (f) => {
    const keep = char;
    setFont(f);
    setCodeText(null);
    setPicked(Math.max(0, pickOf(f, keep)));
    if (isSymbolFont(f)) setFrom('symbol');
    else if (from === 'symbol') setFrom('unicode');
  };
  const pickSubset = (name) => {
    const b = BLOCKS.find((x) => x[2] === name);
    if (!b) return;
    const i = indexFrom(textCells(), b[0]);
    setPicked(i);
    setCodeText(null);
    setJump({ row: Math.floor(i / COLS) });
  };
  const typeCode = (t) => {
    setCodeText(t);
    if (symbolFont) {
      const n = /^\d{1,3}$/.test(t.trim()) ? Number(t) : -1;
      if (n >= 32 && n <= 255 && symbolFont[n]) setPicked(n - 32);
      return;
    }
    const c = charOf(t, from);
    const i = c ? indexOf(textCells(), c.codePointAt(0)) : -1;
    if (i >= 0) setPicked(i);
  };
  const pickRecent = (e) => {
    const f = e.font && (isSymbolFont(e.font) || fonts.includes(e.font)) ? e.font : font === ASIAN || isSymbolFont(font) ? NORMAL : font;
    if (f !== font) {
      setFont(f);
      if (isSymbolFont(f)) setFrom('symbol');
      else if (from === 'symbol') setFrom('unicode');
    }
    setCodeText(null);
    setPicked(Math.max(0, pickOf(f, e.char)));
  };

  // What Insert (or OK in value mode) takes: the Special Characters row on that tab, else the picked symbol and its font.
  const choice = (i = picked, f = font) => {
    if (tab === 'specialCharacters') return { char: SPECIAL[special].char, font: null };
    const c = charAt(i);
    return c ? { char: c, font: f === NORMAL || f === ASIAN ? null : f } : null;
  };
  const finish = (r) => {
    if (r && !valueMode) insertSymbol(ctxOf(), r);
    return r;
  };
  const insertNow = (r) => r && onClose(finish(r));

  const shortcut = (tab === 'specialCharacters' ? SPECIAL[special].char : char) && shortcutOf(tab === 'specialCharacters' ? SPECIAL[special].char : char);
  const buttons = (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={!hasAutoCorrect} {...accessProps('&AutoCorrect...')}
        title={hasAutoCorrect ? undefined : REASONS.pending}
        onClick={() => { const c = choice(); if (c) ctxOf().dialog('autoCorrect', { tab: 'autoCorrect', with: c.char }); }}>
        <span><AccessText label="&AutoCorrect..." /></span>
      </Button>
      <Tip title="Keys for single symbols are not offered. Use the keys listed here or Alt+X.">
        <span><Button type="button" variant="outline" size="sm" disabled {...accessProps('Shortcut &Key...')}><span><AccessText label="Shortcut &Key..." /></span></Button></span>
      </Tip>
      <span className="ml-auto text-xs" data-shortcut="">Shortcut key: {shortcut}</span>
    </div>
  );

  const symbolsTab = () => (
    <>
      <div className="flex items-center gap-3">
        <Row label="&Font:" htmlFor="sym-font"><Pick id="sym-font" value={font} options={fonts.map((f) => [f, fontLabel(f)])} onChange={changeFont} width="15rem" /></Row>
        <Row label="S&ubset:" htmlFor="sym-subset">
          <Pick id="sym-subset" value={subset?.[2] ?? ''} disabled={!!symbolFont} onChange={pickSubset} width="15rem"
            options={symbolFont ? [['', '']] : BLOCKS.map((b) => [b[2], b[2]])} />
        </Row>
      </div>
      <Grid count={cells.length} charAt={charAt} family={family} picked={picked} jump={jump} onScrollRow={setTopRow}
        onPick={(i) => { setPicked(i); setCodeText(null); }} onInsert={(i) => insertNow(choice(i))} />
      <div className="flex flex-col gap-1">
        <span {...accessProps('&Recently used symbols:')} onClick={() => document.querySelector('[data-recent-row]')?.focus()}>
          <AccessText label="&Recently used symbols:" />
        </span>
        <RecentRow recent={recent} family={normalFamily} onPick={pickRecent}
          onInsert={(e) => insertNow({ char: e.char, font: e.font ?? null })} />
      </div>
      <div className="flex items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span>Unicode name:</span>
          <span data-unicode-name="" className="truncate">{char ? recentLabel({ char, font: symbolFont ? font : null }) : ''}</span>
        </div>
        <Row label="&Character code:" htmlFor="sym-code">
          <Input id="sym-code" value={codeText ?? shownCode} spellCheck={false} onChange={(e) => typeCode(e.target.value)} onBlur={() => setCodeText(null)} size="xs" className="w-20 uppercase tabular-nums" />
        </Row>
        <Row label="fro&m:" htmlFor="sym-from">
          <Pick id="sym-from" value={from} disabled={!!symbolFont} width="9rem" onChange={(v) => { setFrom(v); setCodeText(null); }}
            options={symbolFont ? [['symbol', `${font} (decimal)`]] : CODE_FROM} />
        </Row>
      </div>
      {buttons}
    </>
  );

  const specialTab = () => (
    <>
      <div className="grid grid-cols-[3rem_1fr_12rem] px-1 text-xs">
        <span {...accessProps('&Character:')} className="col-span-2" onClick={() => document.querySelector('[data-special-list]')?.focus()}>
          <AccessText label="&Character:" />
        </span>
        <span>Shortcut key:</span>
      </div>
      <div role="listbox" tabIndex={0} aria-label="Character" data-special-list=""
        className="h-72 shrink-0 overflow-y-auto border border-neutral-300 bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onKeyDown={(e) => {
          const d = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[e.key];
          if (!d) return;
          e.preventDefault();
          setSpecial((s) => Math.min(SPECIAL.length - 1, Math.max(0, s + d)));
        }}>
        {SPECIAL.map((s, i) => (
          <div key={s.name} role="option" aria-selected={i === special} data-special={s.name}
            ref={(el) => i === special && el?.scrollIntoView({ block: 'nearest' })}
            className={cn('grid cursor-default grid-cols-[3rem_1fr_12rem] px-1 py-0.5 text-xs', rowClass(i === special))}
            onMouseDown={(e) => { e.preventDefault(); e.currentTarget.parentElement.focus(); setSpecial(i); }}
            onDoubleClick={() => insertNow({ char: s.char, font: null })}>
            <span className="text-center">{shownOf(s.char)}</span><span>{s.name}</span><span>{shortcutOf(s.char)}</span>
          </div>
        ))}
      </div>
      {buttons}
    </>
  );

  return (
    <WordDialog title="Symbol" size="lg" tab={tab} onTab={setTab} okText={valueMode ? 'OK' : 'Insert'} onClose={onClose}
      validate={() => (choice() ? null : 'Pick a symbol first.')} result={() => finish(choice())}
      tabs={[{ id: 'symbols', label: '&Symbols', render: symbolsTab }, { id: 'specialCharacters', label: 'S&pecial Characters', render: specialTab }]} />
  );
}
