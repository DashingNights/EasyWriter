// The app's table style gallery on a canvas draft: a gallery style the document lacks goes in with its definition first, as Word
// adds a built-in style the document does not hold yet (the engine's table.style `define`, cmd/table_style.rs add_built_in).
// Pure: node tests load it.
import { THEME } from '../../defaults.mjs';
import { engineParts, tableStyleDef } from './styles.mjs';

/** Gallery style `id`'s definition as table.newStyle's params ({name, parts}) in the Office theme, or null for an id outside the
 * gallery. The engine reads it only when the document lacks the style. */
export function defineOf(id, theme = THEME) {
  if (!id) return null;
  const def = tableStyleDef(id, theme);
  return def ? { name: def.name, parts: engineParts(def) } : null;
}
