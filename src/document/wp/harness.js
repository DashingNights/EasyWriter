// Hooks for the Word harness cases (.smoke-data/word/cases): window.__word.test reaches the scaffold's hosts and story editors,
// which a case cannot import. App.jsx mounts the pane hosts and margin cards in a Document; pane and cards register plain test
// sources that show what they were given.
import { createElement as h } from 'react';
import { registerCards } from '../../tooling/cards.jsx';
import { closePane, openPane, paneOpen, registerPanes } from '../../tooling/panes.jsx';
import { menuViewOf, register } from '../../tooling/registry.js';
import { activeSurface } from '../../tooling/surface.js';
import { fieldNames } from '../fields/registry.mjs';
import { geometryOf, registerPageLayer } from '../geometry.js';
import { mountStory, writeBack } from '../word/story.js';

/** Registers test pane `id` on `side`; its body shows the props it was opened with as JSON. */
const pane = (id, side) => registerPanes('harness', {
  [id]: { title: `Test ${side}`, side, Component: ({ props }) => h('pre', { 'data-test-pane': id }, JSON.stringify(props)) },
});

/** Registers test card source `id` drawing one card per {id, top} of `list`, its text the card id. */
const cards = (id, list) => registerCards(id, list && {
  cards: () => list.map((c) => ({ ...c, Component: ({ card, active }) => h('div', { 'data-test-card': card.id, 'data-test-active': active || undefined }, card.id) })),
});

window.__word = Object.assign(window.__word ?? {}, {
  geometry: () => {
    const ed = activeSurface()?.editor;
    return ed ? geometryOf(ed.state) : null;
  },
  layer: (pageLayer) => registerPageLayer(pageLayer),
  fields: fieldNames, // the registered field types, for the benchmark's registered.json
  test: { register, menuViewOf, pane, cards, openPane, closePane, paneOpen, mountStory, writeBack },
});
