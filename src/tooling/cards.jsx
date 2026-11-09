// Margin cards (docs/plans/word plan.md §1.7): the cards of every registered source (comments, revision balloons) in one column
// right of the sheet, in document space: sorted by their anchor's top, pushed apart so none overlaps, the active card level with
// its anchor. The layer lives in #page-wrap, so the page's zoom and scroll carry it. Each card sits in a wrapper with
// data-card="<source>:<id>", data-active on the active one and tabindex -1 (Alt+F12 focuses the card beside the caret). Agent
// suggestion cards (suggest/Review.jsx) keep their own layer until markup moves them in.
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterTyping, useStore } from '../app/store.js';
import { typing } from '../document/typing.mjs';

/** @typedef {{id: string, top: number, active?: boolean, Component: import('react').ComponentType<{card: object, active: boolean, activate: () => void}>}} Card
 *  top: layout px of its anchor in .ProseMirror coordinates.
 *  @typedef {{cards: (state: object, view: object) => Card[], version?: (state: object) => any}} CardSource */

const sources = new Map(); // id → CardSource
const listeners = new Set();
const GAP = 8; // px between stacked cards
const ASIDE = 16; // px between the sheet and the column
// An idle callback, at the latest after a second (a timer where the browser has none).
const whenIdle = (fn) => (globalThis.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 200));
const cancelIdle = (id) => (globalThis.cancelIdleCallback ? cancelIdleCallback(id) : clearTimeout(id));

/** Registers margin card source `id` (or replaces it); `source` null removes it. */
export function registerCards(id, source) {
  if (source) sources.set(id, source);
  else sources.delete(id);
  for (const fn of listeners) fn();
}

/** Tops for cards of heights `h` anchored at `tops` (sorted), the card at `active` (or -1) level with its anchor. Pure. */
export function stack(tops, h, active) {
  const out = [...tops];
  const from = active >= 0 ? active : 0;
  for (let i = from + 1; i < out.length; i++) out[i] = Math.max(tops[i], out[i - 1] + h[i - 1] + GAP);
  for (let i = from - 1; i >= 0; i--) out[i] = Math.min(tops[i], out[i + 1] - h[i] - GAP);
  return out;
}

/** The margin card column of the open Document; App.jsx mounts it next to SuggestionCards. */
export function MarginCards() {
  const ed = useStore((s) => s.editor);
  const isDocument = useStore((s) => s.draft?.format === 'document');
  const zoom = useStore((s) => s.zoomPct);
  const [, render] = useReducer((n) => n + 1, 0);
  const [picked, setPicked] = useState(null); // the card activated by a click or focus, when its source does not say
  const layer = useRef(null);
  useEffect(() => {
    // Typing re-renders the column once it pauses (store.js afterTyping): every source's tops and every card's height cost a
    // layout per keypress on long documents (plan.md section 6 risk 6). A transaction that moves neither the text nor the
    // selection (pagination's page ends, a plugin's state) re-renders once the main thread is idle: a document settling its
    // pages sends many, and each render lays it out again. Anything else re-renders at once.
    let idle = 0;
    const later = () => {
      idle ||= whenIdle(() => {
        idle = 0;
        render();
      });
    };
    const onTr = ({ transaction: tr }) => (typing(tr) ? afterTyping(render) : tr.docChanged || tr.selectionSet ? render() : later());
    listeners.add(render);
    ed?.on('transaction', onTr);
    return () => {
      cancelIdle(idle);
      listeners.delete(render);
      ed?.off('transaction', onTr);
    };
  }, [ed]);
  const on = !!ed && !ed.isDestroyed && isDocument;
  const cards = !on ? [] : [...sources].flatMap(([source, s]) => (s.cards(ed.state, ed.view) ?? []).map((card) => ({ ...card, key: `${source}:${card.id}` })))
    .sort((a, b) => a.top - b.top);
  const activeKey = cards.find((c) => c.active)?.key ?? picked;

  // Placed after render: heights are known only once the cards are drawn. One layout read for all cards, then the writes.
  useLayoutEffect(() => {
    const el = layer.current;
    const pm = ed?.view.dom;
    const page = pm?.closest('.page');
    if (!el || !page) return;
    let top = 0;
    for (let n = pm; n && n !== el.parentElement; n = n.offsetParent) top += n.offsetTop;
    el.style.left = `${page.offsetLeft + page.offsetWidth + ASIDE}px`;
    el.style.top = `${top}px`;
    const boxes = [...el.children];
    const tops = stack(cards.map((c) => c.top), boxes.map((b) => b.offsetHeight), cards.findIndex((c) => c.key === activeKey));
    boxes.forEach((b, i) => { b.style.top = `${tops[i]}px`; });
  });

  const wrap = on && document.getElementById('page-wrap');
  if (!wrap || !cards.length) return null;
  return createPortal(
    <div ref={layer} data-margin-cards="" data-zoom={zoom} className="absolute w-64">
      {cards.map((card) => {
        const active = card.key === activeKey;
        const activate = () => setPicked(card.key);
        const { Component } = card;
        return (
          <div key={card.key} data-card={card.key} data-active={active || undefined} tabIndex={-1} onFocus={activate} className="absolute inset-x-0">
            <Component card={card} active={active} activate={activate} />
          </div>
        );
      })}
    </div>,
    wrap,
  );
}
