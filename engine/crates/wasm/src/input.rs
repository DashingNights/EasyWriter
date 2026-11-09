//! What the canvas editor's input reads from a session (src/engine/input, viewport-design.md sections 4.4 and 6, P9): the
//! selection event the worker sends after every change to a session's selection or layout, so a typed letter costs the
//! input no call besides the edit, and the engine clipboard's copy as RTF for the system clipboard. EasyWriter's code (the
//! engine-input-route package), not WordCraft's.
use serde_json::{Value, json};
use unicode_segmentation::UnicodeSegmentation;
use wasm_bindgen::prelude::*;
use ew_doc_edit::doc::{Pos, StoryRef};
use ew_doc_edit::layout::{DocLayout, Placed};

use super::Engine;

#[wasm_bindgen]
impl Engine {
    /// The selection event's body `{anchor, head, version, caret, rects, comp}` for the current layout `version`: `caret`
    /// `{page, x, y, h}` at the head (null where it is not laid out); `rects` `[{page, x, y, w, h}]`, the highlight, which
    /// for a column selection is each block row's piece (so it draws as a block) and for several ranges every range's;
    /// `ranges`, how many ranges, with several; `found` `[{page, x, y, w, h}]`, Reading Highlight's matches while it is on;
    /// `comp` `{anchor, head, text, boxes}` while
    /// an input method composes, `boxes` holding one `{page, x, y, w, h}` (or null) per grapheme of `text`. With `from` and
    /// `to` (the pages a view shows, engine-open), `rects` holds the highlight on pages `from..to` only: select all on a long
    /// document then costs what the view shows, not every page's lines, and so do a find's thousand ranges.
    // ponytail: the composition's boxes are not limited to the view; a composition spans a line or two.
    #[wasm_bindgen(js_name = selectionEvent)]
    pub fn selection_event(&mut self, from: Option<usize>, to: Option<usize>) -> String {
        self.sync();
        let l = self.laid_out();
        // Reading Highlight's matches in the body (Find's Highlight All, the Navigation pane's search), while it is on: those in
        // the paragraphs of the view's pages, searched again after an edit or a move of the view, and read in place below. The
        // whole body's search took about 10 ms a key on the Word fixture (engine-main-thread).
        let body = from.zip(to).and_then(|(f, t)| page_span(&l, StoryRef::Body, f..t));
        let lit = !self.s.find_highlights_in(body.clone()).is_empty();
        let doc = &self.s.doc;
        let hint = self.s.page_hint;
        // The view's span of the selection's story, once: every range of a multiple selection is in that story.
        let bounds = from.zip(to).and_then(|(f, t)| page_span(&l, self.s.sel.focus.story, f..t));
        let range = |a: &Pos, b: &Pos| {
            let (mut a, mut b) = if a <= b { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
            if let Some((lo, hi)) = bounds.as_ref().filter(|(lo, _)| lo.story == a.story) {
                (a, b) = (a.max(lo.clone()), b.min(hi.clone()));
            }
            let rects = if a <= b { l.selection_rects(doc, &a, &b, hint) } else { Vec::new() };
            rects.into_iter().map(|(p, r)| json!({"page": p, "x": r.x, "y": r.y, "w": r.w, "h": r.h}))
        };
        let (anchor, head) = (&self.s.sel.anchor, &self.s.sel.focus);
        let others = self.s.other_ranges();
        let rects: Vec<Value> = match self.s.column_segments() {
            Some(segs) => segs.iter().flat_map(|(a, b)| range(a, b)).collect(),
            None => others.iter().map(|r| (&r.anchor, &r.focus)).chain([(anchor, head)]).filter(|(a, b)| a != b).flat_map(|(a, b)| range(a, b)).collect(),
        };
        let caret = l.caret_on(head, hint).map_or(Value::Null, |c| json!({"page": c.page, "x": c.x, "y": c.top, "h": c.height}));
        let comp = self.comp.as_ref().map_or(Value::Null, |(a, b)| {
            let text = doc.para_at(a).and_then(|p| p.text.get(a.off..b.off)).unwrap_or_default();
            let at = |off: usize| Pos { off, ..a.clone() };
            let boxes: Vec<Value> =
                text.grapheme_indices(true).map(|(i, g)| range(&at(a.off + i), &at(a.off + i + g.len())).next().unwrap_or(Value::Null)).collect();
            json!({"anchor": a, "head": b, "text": text, "boxes": boxes})
        });
        let mut ev = json!({"anchor": anchor, "head": head, "version": self.version, "caret": caret, "rects": rects, "comp": comp});
        if !others.is_empty() {
            ev["ranges"] = json!(others.len() + 1);
        }
        if let Some((_, _, found)) = self.s.find.highlights.as_ref().filter(|_| lit) {
            // Only the matches on the view's pages (its first and last paragraphs run past them), as for the selection's own
            // rectangles.
            let shown = |(a, b): &&(Pos, Pos)| body.as_ref().is_none_or(|(lo, hi)| b >= lo && a <= hi);
            ev["found"] = found.iter().filter(shown).flat_map(|(a, b)| range(a, b)).collect();
        }
        ev.to_string()
    }

    /// The engine clipboard's last copy (`edit.copy` or `edit.cut`) as RTF, for the system clipboard beside its text and HTML;
    /// empty when there is none or it cannot be written.
    #[wasm_bindgen(js_name = clipboardRtf)]
    pub fn clipboard_rtf(&self) -> String {
        let Some(frag) = &self.s.clipboard else { return String::new() };
        ew_doc_edit::io::save_bytes("clip.rtf", &frag.to_document()).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
    }
}

/// The first and last positions of `story`'s lines on pages `pages`, or None when they hold none (a selection in a header,
/// say, which the view's pages do not bound).
fn page_span(l: &DocLayout, story: StoryRef, pages: std::ops::Range<usize>) -> Option<(Pos, Pos)> {
    let pages = l.pages.get(pages.start.min(l.pages.len())..pages.end.min(l.pages.len()))?;
    let mut span: Option<(Pos, Pos)> = None;
    for it in pages.iter().flat_map(|p| &p.items) {
        let Placed::Lines { story: s, path, para, l0, l1, .. } = it else { continue };
        let (Some(first), Some(last)) = (para.lines.get(*l0), l1.checked_sub(1).and_then(|i| para.lines.get(i))) else { continue };
        if *s != story {
            continue;
        }
        let Some(path) = l.ids.doc_path(story, path) else { continue };
        let (a, b) = (Pos::new(story, path.clone(), first.start), Pos::new(story, path, last.stop));
        span = Some(match span {
            Some((lo, hi)) => (lo.min(a), hi.max(b)),
            None => (a, b),
        });
    }
    span
}
