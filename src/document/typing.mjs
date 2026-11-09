// Which transactions only typed text. The shell's readers wait for a typing pause (app/store.js afterTyping) and the paragraph
// decorations map instead of rebuilding (wp/borders/group.js): both are keypress costs on long documents (plan.md section 6 risk 6).
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform';

/** Whether `step` (on `doc`, the doc before it) replaced text inside one textblock with inline content only. */
export function inlineReplace(step, doc) {
  if (!(step instanceof ReplaceStep) || step.structure || step.slice.openStart || step.slice.openEnd) return false;
  let inline = true;
  step.slice.content.forEach((n) => { inline &&= n.isInline; });
  const $from = doc.resolve(step.from);
  return inline && $from.parent.isTextblock && step.to <= $from.end();
}

const markStep = (s) => s instanceof AddMarkStep || s instanceof RemoveMarkStep;

/** Whether transaction `tr` only typed or deleted text inside paragraphs (with `marks`, or added and removed marks too). */
export const typing = (tr, marks = false) => !!tr?.docChanged && tr.steps.every((s, i) => (marks && markStep(s)) || inlineReplace(s, tr.docs[i]));
