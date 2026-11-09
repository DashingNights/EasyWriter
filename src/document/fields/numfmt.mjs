// One number formatter for every ST_NumberFormat (docs/plans/word/plan.md §1.10). fields-core owns the formats (its numbers.mjs,
// next to the \* switches); symbols (the Number dialog) and lists import numberText from here.
export { numberText } from '../wp/fields-core/numbers.mjs';
