// A read-only, scaled preview of a Document's doc JSON (Show Source Documents and Version History): the schema's DOMSerializer into
// a white sheet the width of the doc's page, scrolled to the block `at` (the block holding the selection in the open draft).
import { useEffect, useRef } from 'react';
import { DOMSerializer } from '@tiptap/pm/model';

const PX = 96 / 72;

/** The preview of `doc` (JSON) in `schema`, `zoom` times its size; `at`: the top-level block index to scroll to. */
export function Sheet({ doc, schema, at = 0, zoom = 0.4, ...props }) {
  const box = useRef(null);
  const page = useRef(null);
  useEffect(() => {
    if (!page.current || !schema || !doc) return;
    try {
      const node = schema.nodeFromJSON(doc);
      page.current.replaceChildren(DOMSerializer.fromSchema(schema).serializeFragment(node.content));
    } catch {
      page.current.textContent = 'This version cannot be shown.';
    }
  }, [doc, schema]);
  useEffect(() => {
    const el = page.current?.children[Math.min(at, (page.current?.children.length ?? 1) - 1)];
    if (el && box.current) box.current.scrollTop = Math.max(0, el.offsetTop * zoom - 16);
  }, [doc, at, zoom]);
  const sect = doc?.attrs?.sect;
  const w = (sect?.w ?? 595.3) * PX;
  const pad = (sect?.margin?.left ?? 72) * PX;
  return (
    <div ref={box} className="compare-sheet-box min-h-0 flex-1 overflow-auto bg-muted p-2" {...props}>
      <div ref={page} className="compare-sheet bg-white text-black shadow-sm" style={{ width: w, padding: pad, zoom }} />
    </div>
  );
}
