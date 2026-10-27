// The renderer's integration registry (docs/plans/integrations.md Registry): each integration's contributions (its ui.jsx),
// and the hooks core calls them through. Only enabled integrations take part, read from the store's settings at call time.
import { createElement as h, Fragment } from 'react';
import { getState, useStore } from '../app/store.js';
import forum from './forum/ui.jsx';
import { enabled, INTEGRATIONS, wakes } from './index.mjs';

export const UI = { forum };

const live = (settings = getState().settings) => INTEGRATIONS.filter((i) => enabled(settings, i.id)).map((i) => UI[i.id]);

/** The first answer of hook `key` among the enabled integrations, skipping undefined, null and false; undefined for none. */
export function first(key, ...args) {
  for (const ui of live()) {
    const r = ui[key]?.(...args);
    if (r != null && r !== false) return r;
  }
  return undefined;
}

/** Calls hook `key` of each enabled integration. onSettings(prev, next) also reaches one that `next` just turned off, so it
 * can drop its state (the forum's sign-in status). */
export function each(key, ...args) {
  const uis = new Set([...live(), ...(key === 'onSettings' ? live(args[0]) : [])]);
  for (const ui of uis) ui[key]?.(...args);
}

/** Contribution `key` of every integration, on or off, flattened (an array contribution adds its items). */
export const all = (key) => Object.values(UI).flatMap((ui) => ui[key] ?? []);

/** Each integration's settings section ({id, title, icon, hint, Section, read, check, write}) with its `integration` id: Settings
 * lists one only while that integration is switched on in the dialog. */
export const settingsSections = () => Object.entries(UI).filter(([, ui]) => ui.settings).map(([id, ui]) => ({ ...ui.settings, integration: id }));

/** Renders contribution `name` of each enabled integration with `props`, and of an off one whose manifest wakes it there
 * (index.mjs wakes: the open forum draft's row); it follows the Settings switch live. */
export function Slot({ name, ...props }) {
  const settings = useStore((s) => s.settings);
  const draft = useStore((s) => s.draft);
  const uis = INTEGRATIONS.filter((i) => enabled(settings, i.id) || wakes(i.id, name, props, { settings, draft })).map((i) => UI[i.id]);
  return h(Fragment, null, ...uis.filter((ui) => ui[name]).map((ui, i) => h(ui[name], { key: i, ...props })));
}

/** The setup's integration pages (docs/plans/onboarding.md, Integration setup pages): the SetupPages ({id, title, help?, Page}) of
 * each integration on with `settings`, in manifest order, each with its `integration` id. */
export const setupPages = (settings = getState().settings) => INTEGRATIONS.filter((i) => enabled(settings, i.id))
  .flatMap((i) => (UI[i.id].SetupPages ?? []).map((p) => ({ ...p, integration: i.id })));

/** ctx.integrations of commands (app/commands.js makeCtx): each integration's actions. Its commands run only while it is on. */
export const integrationsCtx = () => Object.fromEntries(Object.entries(UI).map(([id, ui]) => [id, ui.actions]));
