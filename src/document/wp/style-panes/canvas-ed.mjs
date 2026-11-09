// An editor stand-in for the style dialogs on a canvas draft (Manage Styles and the Organizer; docs/plans/engine/stage2b.md,
// engine-gaps-styles). Those dialogs read ed.state.doc.attrs (styles, theme, settings) and write a whole styles attribute in one
// transaction; here state.doc.attrs holds the engine's sheet in the DOM form (styles/engine.mjs), and a transaction's styles go to
// the engine as styles.define, styles.delete and styles.setDefaults steps in one execMany (one undo step). Pure: node tests load it.
import { chrOfRun, defineSteps, ppOfPara, stylesOfSheet } from '../styles/engine.mjs';

/** The engine steps that turn DOM styles `a` into `b`: each style added or changed, each one dropped (built-ins stay), and the
 * document defaults when they changed. */
export function stylesSteps(a, b) {
  const steps = defineSteps(a, b);
  const was = a?.list ?? {};
  for (const id of Object.keys(was)) if (!b?.list?.[id] && !was[id].builtIn) steps.push(['styles.delete', { style: id }]);
  const da = a?.defaults ?? {};
  const db = b?.defaults ?? {};
  const chr = JSON.stringify(da.run ?? {}) !== JSON.stringify(db.run ?? {});
  const para = JSON.stringify(da.para ?? {}) !== JSON.stringify(db.para ?? {});
  if (chr || para) steps.push(['styles.setDefaults', { ...(chr && { chr: chrOfRun(db.run) }), ...(para && { para: ppOfPara(db.para) }) }]);
  return steps;
}

/** The stand-in for `engine` (a canvas draft's client) holding `attrs` ({styles, theme}) and the style counts `counts`
 * (styles.usage). chain().command(fn).run() runs `fn` against a transaction that only records setDocAttribute, then sends the
 * styles' changes to the engine; the stand-in's attrs follow at once, so the dialog reads its own writes. When the engine refuses
 * them (a taken name), the stand-in reads the engine's sheet back and `refused(error)` tells the dialog to say so and draw again. */
export function canvasEd(engine, attrs, counts = {}, refused = () => {}) {
  const doc = (a) => ({ attrs: a, counts, descendants: () => {} });
  const ed = {
    engine,
    state: { doc: doc({ settings: {}, ...attrs }) },
    chain() {
      const fns = [];
      const c = {
        focus: () => c,
        command: (fn) => (fns.push(fn), c),
        setDocSettings: () => c, // the pane options live in the DOM document's settings only
        run: () => {
          const before = ed.state.doc.attrs;
          const next = { ...before };
          const tr = { doc: { attrs: next }, setDocAttribute: (k, v) => ((next[k] = v), tr), setNodeAttribute: () => tr };
          for (const fn of fns) fn({ tr });
          const steps = stylesSteps(before.styles, next.styles);
          ed.state = { doc: doc(next) };
          if (steps.length) {
            Promise.resolve(engine.execMany(steps)).catch((e) => ({ ok: false, error: e?.message })).then(async (r) => {
              if (r?.ok !== false) return;
              const sheet = await Promise.resolve(engine.exec('styles.get', {})).catch(() => null);
              const styles = stylesOfSheet(sheet?.value);
              if (styles) ed.state = { doc: doc({ ...ed.state.doc.attrs, styles }) };
              refused(r.error ?? 'the engine refused them');
            });
          }
          return true;
        },
      };
      return c;
    },
  };
  return ed;
}
