// The character formatting the forum keeps (SPEC §5) and the font preset chain: pure and import-free, so the command
// catalogue (src/app/commands/*.mjs, node --test) shares them with extensions.js, which re-exports the values.

export const FONT_SIZES = [80, 90, 100, 125, 150, 175, 200];
export const TEXT_COLORS = { root: 'Default', soft: 'Faint', hard: 'Prominent', red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', indigo: 'Indigo', violet: 'Violet' };
export const HIGHLIGHTS = ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'];
export const FONTS = [
  'Helvetica', 'Arial', 'Arial Black', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Gill Sans',
  'Times New Roman', 'Georgia', 'Palatino', 'Baskerville', 'Andalé Mono', 'Courier', 'Monaco',
  'Bradley Hand', 'Brush Script MT', 'Luminari',
].map((label) => ({ label, css: label === 'Andalé Mono' ? 'Andale Mono' : label }));

/** Adds to a TipTap command chain the steps that replace the selection's character formatting with `preset`'s. */
export function presetChain(chain, preset) {
  chain.unsetFontFamily().unsetFontSize().unsetTextColor().unsetHighlight().unsetBold().unsetItalic().unsetUnderline();
  if (preset.fontFamily) chain.setFontFamily(preset.fontFamily);
  if (preset.size && Number(preset.size) !== 100) chain.setFontSize(preset.size);
  if (preset.color && preset.color !== 'root') chain.setTextColor(preset.color);
  if (preset.highlight) chain.setHighlight(preset.highlight);
  if (preset.bold) chain.setBold();
  if (preset.italic) chain.setItalic();
  if (preset.underline) chain.setUnderline();
  return chain;
}
