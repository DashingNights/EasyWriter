//! Insert tab: pages, tables, pictures, shapes, links, bookmarks, headers/footers, text, symbols.

use serde_json::{Value, json};
use ew_doc::para::{Float, InlineObject, ShapeKind, Wrap};
use ew_doc::props::{Align, Border, Borders, CharProps, Rgb, TabAlign, TabStop, TextColor};
use ew_doc::{Block, Paragraph, PartKind, Path, Pos, StoryRef, Table, para_block};

use super::{delete_selection, sel_result, split_para, type_text};
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

mod blocks;
mod forms;
mod header_footer;
mod items;
mod links;
mod objects;

pub(crate) use header_footer::saved_copy;
use header_footer::{create_hf, edit_hf, header_footer, new_empty_headers, strip_headers};
pub use items::{DropCapState, drop_cap_state, format_date, format_date_parts};
pub(crate) use items::{has_margin_numbers, remove_margin_numbers};
use items::{cover_page, date_time, drop_cap, drop_cap_off, field, page_number, symbol};
use links::{bookmark, delete_bookmark, link, link_targets};
pub use links::{bookmark_name_ok, bookmark_range, bookmark_span};
pub use objects::{base64_decode, base64_encode};
use objects::{icon, shape, table, text_box};
pub(crate) use objects::{image_ext, picture};

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("insert.pageBreak", "Page Break", "Insert › Pages", |s, _| {
            type_text(s, "\u{000C}")?;
            sel_result(s)
        }),
        CommandSpec::new("insert.blankPage", "Blank Page", "Insert › Pages", |s, _| {
            type_text(s, "\u{000C}")?;
            let at = s.sel.focus.clone();
            let at = split_para(s, &at)?;
            s.doc.insert_text(&at, "\u{000C}", &CharProps::default())?;
            s.sel = Selection::caret(at);
            sel_result(s)
        }),
        CommandSpec::new("insert.buildingBlocks", "Building Blocks Organizer", "Insert › Text › Quick Parts", blocks::list)
            .params(r#"{} → [{name, gallery: "docParts|autoTxt|hdrs|ftrs|coverPg|tbls|txtBox|eq|…" (as the file writes it), category, description, behavior: "content|p|pg"}] (the document's own building blocks)"#)
            .pure(),
        CommandSpec::new("insert.saveBuildingBlock", "Create New Building Block", "Insert › Text › Quick Parts", blocks::save)
            .params(r#"{"name": string, "gallery": file gallery value, "category"?: string (General), "description"?: string, "behavior"?: "content|p|pg"} (the selection, into the document's building blocks)"#)
            .when(|s| {
                let t = blocks::save_targets(s);
                let whole = ["toc", "bibliography", "watermark"].iter().any(|k| t[*k] == json!(true));
                (s.sel.is_collapsed() && !whole).then_some("select what to save first")
            }),
        // What the Watermark, Table of Contents and Bibliography galleries can save at the caret without a selection.
        CommandSpec::new("insert.saveTargets", "Save Selection to Gallery", "Insert › Text › Quick Parts", |s, _| Ok(blocks::save_targets(s)))
            .params(r#"{} → {"toc", "bibliography", "watermark"}: whether the caret is in a table of contents or a bibliography, and whether the document has a watermark"#)
            .state(|s| (Value::Null, blocks::save_targets(s)))
            .pure(),
        // F3: the building block named by the text before the caret (Word's Insert AutoText; the engine's own F3 is Find Next).
        CommandSpec::new("insert.autoTextF3", "Insert AutoText", "Insert › Text › Quick Parts", blocks::auto_text)
            .params(r#"{} (the document's building block whose name the text before the caret ends with, or starts the last word of, replaces that text)"#),
        // EasyWriter engine-gaps-rest: what F3 reads, so the app's own building blocks (kept outside the document) can be
        // matched against it when none of the document's is named there.
        CommandSpec::new("insert.textBeforeCaret", "Insert AutoText", "Insert › Text › Quick Parts", |s, _| {
            let at = s.sel.focus.clone();
            let before = if s.sel.is_collapsed() { s.doc.para_at(&at).and_then(|p| p.text.get(..at.off)).unwrap_or("") } else { "" };
            Ok(json!({"text": before, "at": crate::cmd::pos_json(&at)}))
        })
        .params(r#"{} → {"text": the caret's paragraph up to the caret (objects as U+FFFC; empty with a selection), "at": the caret}"#)
        .pure(),
        CommandSpec::new("insert.buildingBlock", "Insert Building Block", "Insert › Text › Quick Parts", blocks::insert)
            .params(r#"{"name": string, "gallery"?: file gallery value}"#),
        CommandSpec::new("insert.deleteBuildingBlock", "Delete Building Block", "Insert › Text › Quick Parts", blocks::delete)
            .params(r#"{"name": string, "gallery"?: file gallery value}"#),
        CommandSpec::new("developer.formField", "Legacy Form Field", "Developer › Controls › Legacy Tools", forms::form_field)
            .params(r#"{"kind": "text|checkBox|dropDown"} → the selection and the field's name (Text1, Check1, Dropdown1…, its bookmark)"#),
        CommandSpec::new("insert.coverPage", "Cover Page", "Insert › Pages", cover_page)
            .params(r#"{"title"?: string, "subtitle"?: string, "author"?: string} (in place of a cover page already there)"#),
        CommandSpec::new("insert.removeCoverPage", "Remove Current Cover Page", "Insert › Pages › Cover Page", items::remove_cover_page)
            .when(|s| items::cover_range(s).is_none().then_some("this document has no cover page")),
        CommandSpec::new("insert.table", "Table", "Insert › Tables", table).params(r#"{"rows": n, "cols": n, "style"?: string}"#),
        CommandSpec::new("insert.picture", "Pictures", "Insert › Illustrations", picture).params(r#"{"path"?: string, "data"?: base64, "width"?: pt, "alt"?: string}"#),
        CommandSpec::new("insert.icon", "Icons", "Insert › Illustrations", icon)
            .params(r#"{"id"?: string (omit to list the library), "color"?: "RRGGBB", "size"?: pt, "query"?: string, "category"?: string}"#),
        CommandSpec::new("insert.shape", "Shapes", "Insert › Illustrations", shape)
            .params(r#"{"kind": "rectangle|roundedRectangle|ellipse|triangle|diamond|line|arrow|star|heart|straightConnector|elbowConnector|curvedConnector", "width"?: pt, "height"?: pt, "fill"?: "RRGGBB", "stroke"?: "RRGGBB", "arrow"?: "none"|"start"|"end"|"both" (lines and connectors; glue a connector's ends with shape.connect)}"#),
        CommandSpec::new("insert.textBox", "Text Box", "Insert › Text", text_box)
            .params(r#"{"text"?: string, "width"?: pt, "height"?: pt}"#)
            .when(|s| {
                // As in Word: no text box inside a text box.
                matches!(s.sel.focus.story, StoryRef::Part(id) if s.doc.parts.get(&id).is_some_and(|p| p.kind == PartKind::TextBox))
                    .then_some("text boxes can't go inside a text box")
            }),
        CommandSpec::new("insert.link", "Link", "Insert › Links", link).key("Mod+K").params(
            r#"{"url": string} | {"bookmark": name} | {"heading": block (see link.targets)} | {"top": true}, "text"?: string (Place in This Document: a bookmark, a heading or the top of the document)"#,
        ),
        CommandSpec::new("link.targets", "Link", "Insert › Links", link_targets).pure(),
        CommandSpec::new("insert.removeLink", "Remove Hyperlink", "Insert › Links", |s, _| super::format::apply(s, &|c| {
            c.link = None;
            if c.style.as_deref() == Some("Hyperlink") {
                c.style = None;
            }
        })),
        CommandSpec::new("insert.bookmark", "Bookmark", "Insert › Links", bookmark).params(r#"{"name": string}"#).key("Mod+Shift+F5"),
        CommandSpec::new("insert.deleteBookmark", "Delete Bookmark", "Insert › Links", delete_bookmark).params(r#"{"name": string}"#),
        CommandSpec::new("insert.header", "Header", "Insert › Header & Footer", |s, v| header_footer(s, v, true)).params(r#"{"text"?: string, "preset"?: "blank|blankThree|title|titleRule|titleNumber"}"#),
        CommandSpec::new("insert.footer", "Footer", "Insert › Header & Footer", |s, v| header_footer(s, v, false)).params(r#"{"text"?: string, "preset"?: "blank|blankThree|pageNumber|titleRule|titleNumber"}"#),
        CommandSpec::new("insert.pageNumber", "Page Number", "Insert › Header & Footer", page_number).params(r#"{"position"?: "top|bottom|current|margin", "align"?: "left|center|right" (margin: left or right), "format"?: "x of y"}"#),
        // Pure: going into an existing header/footer changes nothing; one the page doesn't have yet
        // is made by the mutating `insert.createHeader`/`insert.createFooter` (undoable, refused in
        // a protected document).
        CommandSpec::new("insert.editHeader", "Edit Header", "Insert › Header & Footer › Header", |s, v| edit_hf(s, v, true))
            .params(r#"{"page"?: number (0-based: the header that page shows, created if it has none)}"#)
            .pure(),
        CommandSpec::new("insert.editFooter", "Edit Footer", "Insert › Header & Footer › Footer", |s, v| edit_hf(s, v, false))
            .params(r#"{"page"?: number (0-based: the footer that page shows, created if it has none)}"#)
            .pure(),
        CommandSpec::new("insert.createHeader", "Header", "Insert › Header & Footer", |s, v| create_hf(s, v, true))
            .params(r#"{"page"?: number (0-based; default: the caret's section)} — the header that page shows, created if it has none, with the caret in it"#),
        CommandSpec::new("insert.createFooter", "Footer", "Insert › Header & Footer", |s, v| create_hf(s, v, false))
            .params(r#"{"page"?: number (0-based; default: the caret's section)} — the footer that page shows, created if it has none, with the caret in it"#),
        CommandSpec::new("insert.closeHeader", "Close Header and Footer", "Header & Footer", |s, _| {
            // Back where the caret was in the body, as Word does, not on page 1.
            let back = s.hf_return.take().filter(|_| s.in_header_footer());
            if !new_empty_headers(s).is_empty() {
                // Its own undo step; a protected document keeps it, and the caret still leaves.
                let _ = s.run("insert.removeEmptyHeaders", &json!({}));
            }
            s.sel = back.unwrap_or_else(|| Selection::caret(s.doc.start_of(StoryRef::Body)));
            // The body shows again (Show Document Text is about the header being edited).
            super::page::set_show_document_text(s, true);
            sel_result(s)
        })
        .pure(),
        CommandSpec::new("insert.removeEmptyHeaders", "Close Header and Footer", "Header & Footer", |s, _| {
            let ids = new_empty_headers(s);
            if strip_headers(&mut s.doc, &ids) {
                s.touch();
            }
            sel_result(s)
        }),
        CommandSpec::new("insert.removeHeader", "Remove Header", "Insert › Header & Footer › Header", |s, _| {
            s.doc.last_section.headers = Default::default();
            for path in s.doc.para_paths(StoryRef::Body) {
                if s.doc.para(StoryRef::Body, &path).is_some_and(|p| p.section.is_some())
                    && let Ok(p) = s.doc.para_mut(StoryRef::Body, &path)
                    && let Some(sec) = p.section.as_mut()
                {
                    sec.headers = Default::default();
                }
            }
            sel_result(s)
        }),
        CommandSpec::new("insert.removeFooter", "Remove Footer", "Insert › Header & Footer › Footer", |s, _| {
            s.doc.last_section.footers = Default::default();
            sel_result(s)
        }),
        CommandSpec::new("insert.dateTime", "Date & Time", "Insert › Text", date_time).params(r#"{"format"?: "M/d/yyyy", "update"?: bool}"#),
        CommandSpec::new("insert.symbol", "Symbol", "Insert › Symbols", symbol).params(r#"{"char": string, "font"?: family (the symbol's own font)}"#),
        CommandSpec::new("insert.field", "Field", "Insert › Text › Quick Parts", field).key("Mod+F9").params(r#"{"instr": string, "result"?: string}"#),
        // Word's Alt+Shift+D / T / P (Control+Shift+… in Word for Mac): DATE, TIME and PAGE fields.
        CommandSpec::new("insert.dateField", "Insert Date Field", "Insert › Text › Quick Parts", |s, _| field(s, &json!({"instr": "DATE"})))
            .key(super::mac_or("Ctrl+Shift+D", "Alt+Shift+D")),
        CommandSpec::new("insert.timeField", "Insert Time Field", "Insert › Text › Quick Parts", |s, _| field(s, &json!({"instr": "TIME"})))
            .key(super::mac_or("Ctrl+Shift+T", "Alt+Shift+T")),
        CommandSpec::new("insert.pageField", "Insert Page Field", "Insert › Text › Quick Parts", |s, _| field(s, &json!({"instr": "PAGE"})))
            .key(super::mac_or("Ctrl+Shift+P", "Alt+Shift+P")),
        CommandSpec::new("insert.dropCap", "Drop Cap", "Insert › Text", drop_cap)
            .params(r#"{"position"?: "none"|"dropped"|"margin" (default dropped), "lines"?: 1..10 (default 3; 0 = none), "distance"?: pt from the text (0..1584, default 0), "font"?: family (omit for the text's font)}"#)
            .when(drop_cap_off),
        CommandSpec::new("insert.horizontalLine", "Horizontal Line", "Home › Paragraph › Borders", |s, _| {
            super::para::fmt(s, &|p| {
                p.borders = Some(ew_doc::props::Borders { bottom: Some(ew_doc::props::Border::single(1.5)), ..Default::default() })
            })
        }),
        CommandSpec::new("insert.textFromFile", "Text from File", "Insert › Text › Object", |s, v| {
            let path = p::req_str(v, "path")?;
            let doc = crate::io::open_path(std::path::Path::new(path)).map_err(CmdError::Failed)?;
            let mut frag = doc.body_fragment();
            super::paste::unlink_sections(&mut frag.blocks);
            let at = delete_selection(s)?;
            let end = s.doc.insert_fragment(&at, &frag)?;
            s.sel = Selection::caret(end);
            sel_result(s)
        })
        .params(r#"{"path": string}"#),
    ]
}

#[cfg(test)]
mod tests;
