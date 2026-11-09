//! The calls the canvas editor's accessibility copy and spelling add to the engine API (src/engine/a11y/blocks.js describes
//! their shapes): the paragraphs laid out on a page with their headings, lists, line starts and line boxes, pictures' alt
//! text, run languages and Do not check spelling runs, and the mapping between engine positions and (paragraph id, UTF-16
//! offset). Every story a page draws takes part: the body, and the header, footer, notes and text boxes as `part` blocks.
//! A paragraph's or table's id is its stable id (viewport-design.md section 10) as a string, unique in the session in every
//! story, so it holds while the text around it changes; a part block's id is the part's number and a colon ("7:").
//! EasyWriter's code (engine-a11y, engine-a11y-route, engine-box), not WordCraft's.
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use ew_doc_edit::doc::numbering::Numbering;
use ew_doc_edit::doc::para::{COLUMN_BREAK, NoteKind, OBJ, PAGE_BREAK};
use ew_doc_edit::doc::props::TextDirection;
use ew_doc_edit::doc::section::NumFormat;
use ew_doc_edit::doc::{Block, Document, InlineObject, PartKind, Path, Pos, StoryRef};
use ew_doc_edit::layout::{BlockIds, ParaLayout, Placed, turn_point};

use super::{Engine, err, pos, utf16_to_byte};

#[wasm_bindgen]
impl Engine {
    /// `[Block]`: the blocks with a line on `page`, in reading order (header, body with its notes and text boxes as the page
    /// places them, footer); a table holds its rows on the page with their cells' blocks, a part its own blocks. A paragraph
    /// split over pages comes back whole on each, with the boxes of its lines on this page.
    pub fn blocks(&mut self, page: usize) -> String {
        let l = self.laid_out();
        let mut out = Vec::new();
        if let Some(p) = l.pages.get(page) {
            for items in [&p.header, &p.items, &p.footer] {
                collect(&self.s.doc, &p.ids, items, &mut out);
            }
        }
        Value::Array(out).to_string()
    }

    /// `{id, offset}` of the paragraph `pos` is in, the offset in UTF-16 units of its text; null where there is none.
    pub fn locate(&self, pos_json: &str) -> Result<String, JsError> {
        let p = pos(pos_json)?;
        let para = self.s.doc.para(p.story, &p.path);
        Ok(para.map_or(Value::Null, |d| json!({"id": d.id.0.to_string(), "offset": u16_at(&d.text, p.off)})).to_string())
    }

    /// The position at UTF-16 offset `offset` of paragraph `id`'s text (clamped to its end).
    #[wasm_bindgen(js_name = posAt)]
    pub fn pos_at(&mut self, id: &str, offset: u32) -> Result<String, JsError> {
        let n: u32 = id.parse().map_err(|_| err(format!("not a paragraph id: {id}")))?;
        let ids = self.laid_out().ids.clone();
        let doc = &self.s.doc;
        // Kept as the layout names them (a body path's first index is its block's id: engine-layout-ids), so a block added
        // or taken away before a paragraph leaves its entry right.
        let found = |paths: &std::collections::HashMap<u32, (StoryRef, Path)>| {
            let (s, p) = paths.get(&n)?;
            let p = ids.doc_path(*s, p)?;
            doc.para(*s, &p).is_some_and(|d| d.id.0 == n).then_some((*s, p))
        };
        // Every paragraph's story and path, read again when the one asked for is not where they say.
        let (story, path) = match found(&self.paths) {
            Some(at) => at,
            None => {
                let stories = std::iter::once(StoryRef::Body).chain(doc.parts.keys().map(|k| StoryRef::Part(*k)));
                let ids = &ids;
                self.paths = stories
                    .flat_map(|s| {
                        doc.para_paths(s).into_iter().filter_map(move |p| Some((doc.para(s, &p)?.id.0, (s, ids.layout_path(s, &p)?))))
                    })
                    .collect();
                found(&self.paths).ok_or_else(|| err(format!("no paragraph {id}")))?
            }
        };
        let dp = doc.para(story, &path).ok_or_else(|| err(format!("no paragraph {id}")))?;
        Ok(json!(Pos::new(story, path, utf16_to_byte(&dp.text, offset))).to_string())
    }
}

/// The id prefix of `story`'s part block: none for the body, the part's number and a colon for a part.
fn prefix(story: StoryRef) -> String {
    match story {
        StoryRef::Body => String::new(),
        StoryRef::Part(n) => format!("{n}:"),
    }
}

/// The UTF-16 offset of byte `byte` of `text` (a byte inside a character counts from that character's start).
fn u16_at(text: &str, byte: usize) -> usize {
    text.char_indices().take_while(|(i, _)| *i < byte).map(|(_, c)| c.len_utf16()).sum()
}

/// A length in points to two decimals, so the JSON carries 72.1 and not 72.0999984741211.
fn r2(v: f32) -> f64 {
    (f64::from(v) * 100.0).round() / 100.0
}

/// What a part is called in a `part` block, or None for a story the document does not hold (line numbers, note separators).
fn part_name(doc: &Document, n: u32) -> Option<&'static str> {
    Some(match doc.parts.get(&n)?.kind {
        PartKind::Header => "header",
        PartKind::Footer => "footer",
        PartKind::Footnote => "footnote",
        PartKind::Endnote => "endnote",
        PartKind::Comment => "comment",
        PartKind::TextBox => "textbox",
    })
}

/// The blocks of `items` (whose body blocks `ids` names) into `out`.
fn collect(doc: &Document, ids: &BlockIds, items: &[Placed], out: &mut Vec<Value>) {
    for it in items {
        match it {
            Placed::Lines { story, path, para, l0, l1, x, y, turn } => {
                let Some(path) = &ids.doc_path(*story, path) else { continue };
                let boxes = line_boxes(para, *l0, *l1, *x, *y, *turn);
                let pre = prefix(*story);
                let root = match story {
                    StoryRef::Body => &mut *out,
                    StoryRef::Part(n) => {
                        let Some(name) = part_name(doc, *n) else { continue };
                        let at = out.iter().position(|b| b["id"] == pre.as_str()).unwrap_or_else(|| {
                            out.push(json!({"id": pre, "kind": "part", "part": name, "blocks": []}));
                            out.len() - 1
                        });
                        let Some(blocks) = out[at]["blocks"].as_array_mut() else { continue };
                        blocks
                    }
                };
                let Some(list) = holder(doc, *story, root, &path.0, 0) else { continue };
                let Some(id) = doc.para(*story, path).map(|d| d.id.0.to_string()) else { continue };
                // A paragraph placed in two pieces on one page (two columns) is one block with the boxes of both.
                match list.iter_mut().find(|b| b["id"] == id.as_str()) {
                    Some(b) => {
                        if let Some(a) = b["boxes"].as_array_mut() {
                            a.extend(boxes);
                        }
                    }
                    None => {
                        if let Some(mut b) = para_block(doc, *story, &id, path, para) {
                            b["boxes"] = Value::Array(boxes);
                            list.push(b);
                        }
                    }
                }
            }
            Placed::Clip { items, .. } => collect(doc, ids, items, out),
            _ => {}
        }
    }
}

/// The block list under `out` (the container at `path[..depth]`) that holds the paragraph at `path`: a table step in the
/// path (table, row, cell) makes or finds that table, row and cell.
fn holder<'a>(doc: &Document, story: StoryRef, out: &'a mut Vec<Value>, path: &[u32], depth: usize) -> Option<&'a mut Vec<Value>> {
    if path.len() < depth + 4 {
        return Some(out);
    }
    let at = Path(path[..=depth].to_vec());
    if let Some(Block::Container(c)) = doc.block(story, &at) {
        let id = c.id.0.to_string();
        let i = out.iter().position(|x| x["id"] == id.as_str()).unwrap_or_else(|| {
            out.push(json!({"id": id, "kind": "container", "role": c.role.as_str(), "language": c.language, "titled": !c.title.is_empty(), "blocks": []}));
            out.len() - 1
        });
        return holder(doc, story, out[i]["blocks"].as_array_mut()?, path, depth + 3);
    }
    let tid = doc.table(story, &at).map_or(0, |t| t.id.0).to_string();
    let ti = out.iter().position(|x| x["id"] == tid.as_str()).unwrap_or_else(|| {
        out.push(json!({"id": tid, "kind": "table", "rows": []}));
        out.len() - 1
    });
    let (row, col) = (path[depth + 1], path[depth + 2]);
    let rows = out[ti]["rows"].as_array_mut()?;
    let ri = rows.iter().position(|r| r["index"] == row).unwrap_or_else(|| {
        rows.push(json!({"index": row, "cells": []}));
        rows.len() - 1
    });
    let cells = rows[ri]["cells"].as_array_mut()?;
    let ci = match cells.iter().position(|c| c["col"] == col) {
        Some(i) => i,
        None => {
            let at = cells.iter().take_while(|c| c["col"].as_u64().is_some_and(|x| x < u64::from(col))).count();
            cells.insert(at, json!({"col": col, "blocks": []}));
            at
        }
    };
    holder(doc, story, cells[ci]["blocks"].as_array_mut()?, path, depth + 3)
}

/// `[{line, x, y, w, h, size}]`: where lines `l0..l1` of `pl`, placed at (`x`, `y`) running `turn`, sit on the page in points
/// (the text's extent across the line, the line's height), with the largest font size on each. The accessibility copy lays
/// its lines over them.
fn line_boxes(pl: &ParaLayout, l0: usize, l1: usize, x: f32, y: f32, turn: TextDirection) -> Vec<Value> {
    let Some(first) = pl.lines.get(l0) else { return Vec::new() };
    (l0..l1)
        .filter_map(|li| {
            let l = pl.lines.get(li)?;
            let (a, b) = pl.x_spans(li, l.start, l.stop).iter().fold((f32::MAX, f32::MIN), |(a, b), s| (a.min(s.0.min(s.1)), b.max(s.0.max(s.1))));
            let (a, b) = if a <= b { (a, b) } else { (l.left, l.left) };
            let top = l.top - first.top;
            // Turned lines (a table cell's text direction) turn their box about the placed point, as selection_rects does.
            let (p, q) = (turn_point(turn, x, y, a, top), turn_point(turn, x, y, b, top + l.height));
            let size = pl.clusters.get(l.c0..l.c1).into_iter().flatten().filter_map(|c| pl.styles.get(c.style as usize)).map(|s| s.size).fold(0.0, f32::max);
            Some(json!({"line": li, "x": r2(p.0.min(q.0)), "y": r2(p.1.min(q.1)), "w": r2((q.0 - p.0).abs()), "h": r2((q.1 - p.1).abs()), "size": r2(size)}))
        })
        .collect()
}

/// The block of paragraph `id` at `path` of `story`, laid out as `pl`.
fn para_block(doc: &Document, story: StoryRef, id: &str, path: &Path, pl: &ParaLayout) -> Option<Value> {
    let dp = doc.para(story, path)?;
    let t = &dp.text;
    // Breaks read as line ends; each stand-in is one UTF-16 unit like the character it replaces, so offsets hold.
    let text: String = t.chars().map(|c| if c == PAGE_BREAK || c == COLUMN_BREAK { '\n' } else { c }).collect();
    let mut b = json!({"id": id, "kind": "p", "text": text});
    let lines: Vec<usize> = pl.lines.iter().skip(1).map(|l| u16_at(t, l.start)).collect();
    if !lines.is_empty() {
        b["lines"] = json!(lines);
    }
    if let Some(l) = pl.rp.outline_level.filter(|l| *l < 9) {
        b["level"] = json!(l + 1);
    }
    if let (Some(n), Some(label)) = (pl.rp.numbering.filter(|n| n.num != 0), &pl.label) {
        // Symbol-font bullets are private-use characters: say them as bullets.
        let marker: String = label.text.trim().chars().map(|c| if ('\u{E000}'..='\u{F8FF}').contains(&c) { '•' } else { c }).collect();
        if !marker.is_empty() {
            b["list"] = json!({"ordered": !bullet(&doc.numbering, n.num, n.level), "level": n.level, "marker": marker});
        }
    }
    // What each object reads as: a picture, shape or equation by its alt text, a note mark by its kind, a field by its result;
    // the marks with nothing to read (bookmarks, comment anchors, a field's or a control's ends) are hidden.
    let objects: Vec<Value> = t
        .char_indices()
        .filter(|(_, c)| *c == OBJ)
        .filter_map(|(i, _)| {
            let at = u16_at(t, i);
            Some(match dp.object_at(i)? {
                InlineObject::Image { alt, .. } | InlineObject::Graphic { alt, .. } => json!({"offset": at, "alt": alt}),
                o @ (InlineObject::Shape { .. } | InlineObject::Group { .. }) => {
                    json!({"offset": at, "alt": ew_doc_edit::layout::shape_figure_alt(o).unwrap_or("")})
                }
                InlineObject::Equation { linear, .. } => json!({"offset": at, "alt": linear}),
                // ponytail: an automatic note mark reads as its kind; its number when the layout hands out note numbers.
                InlineObject::NoteRef { kind, custom, .. } => {
                    let name = if *kind == NoteKind::Endnote { "Endnote" } else { "Footnote" };
                    json!({"offset": at, "alt": if custom.is_empty() { name.to_string() } else { format!("{name} {custom}") }})
                }
                InlineObject::Field { result, .. } if !result.is_empty() => json!({"offset": at, "text": result}),
                _ => json!({"offset": at, "hidden": true}),
            })
        })
        .collect();
    if !objects.is_empty() {
        b["objects"] = json!(objects);
    }
    // The run languages and Do not check spelling runs, from the laid-out clusters' resolved formatting.
    let (mut langs, mut noproof): (Vec<(usize, usize, String)>, Vec<(usize, usize)>) = (Vec::new(), Vec::new());
    for cl in &pl.clusters {
        let Some(rc) = pl.styles.get(cl.style as usize).map(|s| &s.rc) else { continue };
        if let Some(lang) = &rc.lang {
            match langs.last_mut() {
                Some(r) if r.1 == cl.start && &r.2 == lang => r.1 = cl.end,
                _ => langs.push((cl.start, cl.end, lang.clone())),
            }
        }
        if rc.no_proof {
            match noproof.last_mut() {
                Some(r) if r.1 == cl.start => r.1 = cl.end,
                _ => noproof.push((cl.start, cl.end)),
            }
        }
    }
    if !langs.is_empty() {
        b["langs"] = json!(langs.iter().map(|(s, e, l)| json!([u16_at(t, *s), u16_at(t, *e), l])).collect::<Vec<_>>());
    }
    if !noproof.is_empty() {
        b["noproof"] = json!(noproof.iter().map(|(s, e)| [u16_at(t, *s), u16_at(t, *e)]).collect::<Vec<_>>());
    }
    Some(b)
}

fn bullet(n: &Numbering, num: u32, level: u8) -> bool {
    n.level(num, level.min(8)).is_some_and(|l| l.format == NumFormat::Bullet)
}

#[cfg(test)]
mod tests {
    use super::u16_at;

    #[test]
    fn utf16_offsets() {
        assert_eq!(u16_at("a你😀b", 0), 0);
        assert_eq!(u16_at("a你😀b", 4), 2);
        assert_eq!(u16_at("a你😀b", 8), 4);
        assert_eq!(u16_at("a你😀b", 9), 5);
    }
}
