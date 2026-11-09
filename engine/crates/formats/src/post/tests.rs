#![allow(clippy::unwrap_used)]

use std::sync::Arc;

use serde_json::json;

use ew_doc::props::{LineSpacing, NumRef, VMerge};
use ew_doc::{Align, Block, CharProps, Container, ContainerRole, Document, InlineObject, Paragraph, RevisionKind, Table};
use ew_doc::post;

use ew_doc::{Blocks, Id, Run, para_block};

use super::{read, read_blocks, write};

fn fixture(name: &str) -> String {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/posts");
    std::fs::read_to_string(dir.join(name)).unwrap()
}

fn doc_of(name: &str) -> Document {
    read(&fixture(name)).unwrap()
}

fn collect<'a>(blocks: &'a [Arc<Block>], out: &mut Vec<&'a Paragraph>) {
    for b in blocks {
        match &**b {
            Block::Para(p) => out.push(p),
            Block::Table(t) => {
                for row in &t.rows {
                    for cell in &row.cells {
                        collect(&cell.blocks, out);
                    }
                }
            }
            Block::Container(c) => {
                collect(&c.title, out);
                collect(&c.blocks, out);
            }
        }
    }
}

fn paras(doc: &Document) -> Vec<&Paragraph> {
    let mut out = Vec::new();
    collect(&doc.body, &mut out);
    out
}

fn run<'a>(p: &'a Paragraph, word: &str) -> &'a CharProps {
    p.run_ranges().find(|(r, _)| p.text.get(r.clone()) == Some(word)).map(|(_, c)| c).unwrap()
}

fn table_of(block: &Block) -> &Table {
    block.as_table().unwrap()
}

fn container_of(block: &Block) -> &Container {
    block.as_container().unwrap()
}

fn image_of(p: &Paragraph) -> (&InlineObject, f32, f32) {
    let o = &p.objects[0];
    let (w, h, _) = o.frame().unwrap();
    (o, w, h)
}

fn box_of<'a>(o: &'a InlineObject) -> &'a ew_doc::para::ObjectBox {
    let (_, _, float) = o.frame().unwrap();
    float.r#box.as_ref().unwrap()
}

#[test]
fn every_fixture_reads_as_a_post() {
    for name in ["marks.json", "headings.json", "lists.json", "nested-lists.json", "tables.json", "table-widths.json", "quotes-code.json", "box.json", "objects.json", "suggestions.json"] {
        let doc = doc_of(name);
        assert_eq!(doc.settings.profile.as_deref(), Some("post"), "{name}");
        assert!(doc.body.last().is_some_and(|b| b.as_para().is_some()), "{name} ends with a paragraph");
        assert!(doc.styles.get(post::QUOTE).is_some(), "{name} has the post's styles");
        assert_eq!(doc.numbering.abstracts.len(), 2, "{name}");
    }
    // The format's reader is reachable through the crate's importers, as the engine opens `document.post`.
    let imported = super::super::import("post", fixture("marks.json").as_bytes()).unwrap().unwrap();
    assert_eq!(imported.settings.profile.as_deref(), Some("post"));
    let page = ew_doc::SectionProps::default();
    let imported = super::super::import_on("post", fixture("marks.json").as_bytes(), &page).unwrap().unwrap();
    assert_eq!(imported.settings.profile.as_deref(), Some("post"));
}

#[test]
fn a_paragraph_and_a_heading_keep_their_alignment_and_style() {
    let doc = doc_of("marks.json");
    let ps = paras(&doc);
    assert_eq!(ps[0].props.align, Some(Align::Left));
    assert_eq!(ps[1].props.align, Some(Align::Center));
    assert_eq!(ps[2].props.align, Some(Align::Right));
    assert_eq!(ps[0].props.style, None);

    let heading = json!({"type": "doc", "content": [{"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Title"}]}]});
    let doc = read(&heading.to_string()).unwrap();
    let p = paras(&doc)[0];
    assert_eq!(p.props.style.as_deref(), Some("Heading2"));
    assert_eq!(p.text, "Title");
    // The heading's own size is what a percent size in it scales.
    let sized = json!({"type": "doc", "content": [{"type": "heading", "attrs": {"level": 1}, "content": [
        {"type": "text", "text": "big", "marks": [{"type": "fontSize", "attrs": {"size": "80"}}]}]}]});
    let doc = read(&sized.to_string()).unwrap();
    assert_eq!(run(paras(&doc)[0], "big").size, Some(28.8));
}

#[test]
fn text_marks_map_to_the_forum_s_colours_and_sizes() {
    let doc = doc_of("marks.json");
    let ps = paras(&doc);
    assert_eq!(run(ps[0], "bold").bold, Some(true));
    assert_eq!(run(ps[0], "italic").italic, Some(true));
    assert_eq!(run(ps[0], "underline").underline, Some(ew_doc::props::Underline::Single));
    assert_eq!(run(ps[0], "strike").strike, Some(true));
    assert_eq!(run(ps[0], "sub").vert_align, Some(ew_doc::props::VertAlign::Subscript));
    assert_eq!(run(ps[0], "super").vert_align, Some(ew_doc::props::VertAlign::Superscript));
    let code = run(ps[0], "code");
    assert_eq!(code.style.as_deref(), Some(post::CODE));
    let both = run(ps[0], "more code");
    assert_eq!((both.style.as_deref(), both.bold), (Some(post::CODE), None));
    assert_eq!(run(ps[1], "small").size, Some(9.6));
    assert_eq!(run(ps[1], "large").size, Some(15.0));
    assert_eq!(run(ps[1], "huge").size, Some(24.0));
    assert_eq!(run(ps[1], "same size").size, Some(12.0));
    assert_eq!(run(ps[2], "faint").color, Some(ew_doc::TextColor::Rgb(post::SOFT)));
    assert_eq!(run(ps[2], "prominent").color, Some(ew_doc::TextColor::Rgb(post::HARD)));
    assert_eq!(run(ps[2], "violet").color, Some(ew_doc::TextColor::Rgb(post::VIOLET)));
    assert_eq!(run(ps[2], "marked red").shading, Some(post::blend(post::RED, post::PAPER)));
    assert_eq!(run(ps[2], "marked yellow").shading, Some(post::blend(post::YELLOW, post::PAPER)));
    assert_eq!(run(ps[3], "Georgia").font.as_deref(), Some("Georgia"));
    assert_eq!(run(ps[3], "Arial Black").font.as_deref(), Some("Arial Black"));
    let link = run(ps[4], "a link to the thread");
    assert_eq!((link.link.as_deref(), link.style.as_deref()), (Some("https://daf.staffs.ac.uk/topic/89849"), Some("Hyperlink")));
    assert_eq!(run(ps[4], "mail link").link.as_deref(), Some("mailto:help@example.com"));
}

#[test]
fn a_hard_break_is_a_line_break_in_the_paragraph() {
    let doc = doc_of("marks.json");
    let ps = paras(&doc);
    assert_eq!(ps[5].text, "line one\nline two");
}

#[test]
fn a_quote_is_a_container_that_holds_blocks_and_quotes() {
    let doc = doc_of("quotes-code.json");
    let quote = container_of(&doc.body[0]);
    assert_eq!(quote.role, ContainerRole::Quote);
    assert_eq!(quote.style.as_deref(), Some(post::QUOTE));
    assert_eq!(quote.space_after, 12.0);
    assert!(quote.title.is_empty());
    assert_eq!(quote.blocks.len(), 3);
    assert_eq!(quote.blocks[0].as_para().unwrap().text, "A quote, said twice: once here");
    let inner = container_of(&quote.blocks[1]);
    assert_eq!((inner.role, inner.blocks[0].as_para().unwrap().text.as_str()), (ContainerRole::Quote, "and once inside it"));
    assert_eq!(quote.blocks[2].as_para().unwrap().text, "after the nested quote");
}

#[test]
fn a_code_block_splits_on_new_lines_and_keeps_its_language() {
    let doc = doc_of("quotes-code.json");
    let code = container_of(&doc.body[1]);
    assert_eq!(code.role, ContainerRole::Code);
    assert_eq!((code.style.as_deref(), code.language.as_deref()), (Some(post::CODE_BLOCK), Some("javascript")));
    let lines: Vec<(&str, Option<&str>)> = code.blocks.iter().map(|b| {
        let p = b.as_para().unwrap();
        (p.text.as_str(), p.props.style.as_deref())
    }).collect();
    assert_eq!(lines, [("const answer = 42;", Some(post::CODE_TEXT)), ("console.log(answer);", Some(post::CODE_TEXT)), ("", Some(post::CODE_TEXT))]);
    // A code block with no language and one empty code block.
    let plain = container_of(&doc.body[2]);
    assert_eq!((plain.language.as_deref(), plain.blocks.len(), plain.blocks[0].as_para().unwrap().text.as_str()), (None, 1, "no language named"));
    let empty = json!({"type": "doc", "content": [{"type": "codeBlock"}]});
    let doc = read(&empty.to_string()).unwrap();
    let code = container_of(&doc.body[0]);
    assert_eq!(code.blocks.len(), 1);
    assert!(code.blocks[0].as_para().unwrap().is_empty());
}

#[test]
fn a_horizontal_rule_is_an_empty_paragraph_in_the_rule_style() {
    let doc = doc_of("quotes-code.json");
    let p = doc.body[3].as_para().unwrap();
    assert!(p.is_empty());
    assert_eq!(p.props.style.as_deref(), Some(post::RULE));
}

#[test]
fn a_list_is_a_numbering_instance_with_its_start_and_levels() {
    let doc = doc_of("lists.json");
    let ps = paras(&doc);
    assert_eq!(ps[0].props.numbering, Some(NumRef { num: 1, level: 0 }));
    assert_eq!(ps[1].props.numbering, Some(NumRef { num: 1, level: 0 }));
    assert_eq!(doc.numbering.nums[0].abstract_id, post::BULLET_ABSTRACT);
    // The ordered list starting at 3.
    assert_eq!(ps[2].props.numbering, Some(NumRef { num: 2, level: 0 }));
    assert_eq!(doc.numbering.nums[1].abstract_id, post::NUMBER_ABSTRACT);
    assert_eq!(doc.numbering.nums[1].start_overrides, [(0, 3)]);
    assert_eq!(ps[4].props.numbering, Some(NumRef { num: 3, level: 0 }));
    assert!(doc.numbering.nums[2].start_overrides.is_empty());

    let nested = doc_of("nested-lists.json");
    let ps = paras(&nested);
    assert_eq!((ps[0].text.as_str(), ps[0].props.numbering), ("top", Some(NumRef { num: 1, level: 0 })));
    assert_eq!((ps[1].text.as_str(), ps[1].props.numbering), ("second level", Some(NumRef { num: 2, level: 1 })));
    assert_eq!((ps[2].text.as_str(), ps[2].props.numbering), ("third level, item two", Some(NumRef { num: 3, level: 2 })));
    assert_eq!(nested.numbering.nums[2].start_overrides, [(2, 2)]);
    // A block after the item's first paragraph is indented one level past the list's.
    let more = ps[5];
    assert_eq!((more.text.as_str(), more.props.style.as_deref()), ("a second paragraph in the same item", Some(post::LIST_MORE)));
    assert_eq!(more.props.indent_left, Some(18.0));
    assert_eq!(ps[0].props.space_after, Some(0.0));
}

#[test]
fn a_table_takes_its_grid_from_the_cell_widths_and_merges() {
    let doc = doc_of("tables.json");
    let t = table_of(&doc.body[1]);
    assert_eq!(t.props.style.as_deref(), Some(post::TABLE));
    assert_eq!(t.grid, [90.0, 180.0]);
    assert_eq!(t.props.width, Some(270.0));
    assert!(t.props.look.header_row);
    assert!(t.rows[0].props.header);
    assert!(!t.rows[1].props.header);
    let th = t.rows[0].cells[0].blocks[0].as_para().unwrap();
    assert_eq!((th.text.as_str(), th.props.style.as_deref()), ("Name", Some(post::TABLE_HEAD)));
    assert_eq!(t.rows[1].cells[0].props.width, Some(90.0));
    assert_eq!(t.rows[1].cells[1].blocks[0].as_para().unwrap().text, "Writes the notes");
    // The table in the second cell's second block, at its own cell's width.
    let inner = table_of(&t.rows[1].cells[1].blocks[1]);
    assert_eq!(inner.grid, [135.0]);
    // The cell across both columns, with no colwidth of its own: the post did not give one, and the writer must not add one.
    let across = &t.rows[2].cells[0];
    assert_eq!((across.props.span, across.props.width), (2, None));
    assert_eq!(across.blocks[0].as_para().unwrap().text, "Across both columns");
}

#[test]
fn a_box_is_a_container_with_its_title_and_content() {
    let doc = doc_of("box.json");
    let b = container_of(&doc.body[1]);
    assert_eq!((b.role, b.style.as_deref()), (ContainerRole::Box, Some(post::BOX)));
    assert_eq!(b.title.len(), 1);
    let title = b.title[0].as_para().unwrap();
    assert_eq!((title.text.as_str(), title.props.style.as_deref()), ("Spoiler", Some(post::BOX_TITLE)));
    assert_eq!(b.blocks[0].as_para().unwrap().text, "The answer is 42.");
    assert_eq!(b.blocks[1].as_para().unwrap().props.numbering, Some(NumRef { num: 1, level: 0 }));
}

#[test]
fn a_canvas_plan_chart_and_media_are_boxes_sized_to_the_column() {
    let doc = doc_of("objects.json");
    let canvas = image_of(doc.body[1].as_para().unwrap());
    assert_eq!((canvas.1, canvas.2, box_of(canvas.0).kind.as_str()), (400.0, 140.0, "canvas"));
    let chart = image_of(doc.body[3].as_para().unwrap());
    assert_eq!((chart.1, chart.2, box_of(chart.0).kind.as_str()), (600.0, 450.0, "planChart"));
    let video = image_of(doc.body[4].as_para().unwrap());
    assert_eq!((video.1, video.2), (360.0, 202.8));
    assert!(box_of(video.0).file.starts_with("data:video/mp4"));
    let gif = image_of(doc.body[5].as_para().unwrap());
    assert_eq!((gif.1, gif.2), (300.0, 169.0));
    // An https medium with no hints is 300 by 169 points, its source the file.
    let remote = image_of(doc.body[6].as_para().unwrap());
    assert_eq!((remote.1, remote.2), (300.0, 169.0));
    let b = box_of(remote.0);
    assert_eq!(b.kind, "media");
    assert_eq!(b.file, "https://daf.staffs.ac.uk/uploads/monthly_2026_10/photo.jpg");
    // The hints and the source stay out of the data, the rest of the attrs stay in.
    let data: serde_json::Value = serde_json::from_str(&b.data).unwrap();
    assert_eq!(data["name"], "photo.jpg");
    assert!(data.get("src").is_none() && data.get("nw").is_none() && data.get("nh").is_none());
    let canvas_data: serde_json::Value = serde_json::from_str(&box_of(canvas.0).data).unwrap();
    assert_eq!(canvas_data["bg"], "post");
    assert!(canvas_data.get("ch").is_none());
}

#[test]
fn a_suggestion_becomes_tracked_revisions_and_deleted_blocks() {
    let doc = doc_of("suggestions.json");
    let kinds: Vec<RevisionKind> = doc.revisions.iter().map(|r| r.kind).collect();
    assert_eq!(kinds, [RevisionKind::Insert, RevisionKind::Delete, RevisionKind::Insert]);
    let tags: Vec<Option<&str>> = doc.revisions.iter().map(|r| r.tag.as_deref()).collect();
    assert_eq!(tags, [Some("g1"), Some("g1"), Some("g2")]);
    assert!(doc.revisions.iter().all(|r| r.author == "Assistant" && r.date.ends_with('Z') && r.date.len() == 20));

    assert_eq!(doc.body.len(), 5);
    let old = doc.body[0].as_para().unwrap();
    assert_eq!(old.text, "The first version of this line.");
    assert_eq!(old.runs.iter().map(|r| r.props.del).collect::<Vec<_>>(), [Some(1)]);
    let new = doc.body[1].as_para().unwrap();
    assert_eq!(new.text, "The assistant rewritten line.");
    assert_eq!((new.runs[0].props.ins, new.mark.ins), (Some(0), Some(0)));
    let kept = doc.body[2].as_para().unwrap();
    assert_eq!(kept.text, "Kept, with a line taken out after it.");
    assert_eq!(kept.runs[0].props.del, None);
    let removed = doc.body[3].as_para().unwrap();
    assert_eq!((removed.text.as_str(), removed.mark.del), ("A line the assistant removed.", Some(1)));
    let added = doc.body[4].as_para().unwrap();
    assert_eq!((added.text.as_str(), added.runs.last().unwrap().props.ins), ("A whole new paragraph, with bold", Some(2)));
    assert_eq!(run(added, "with bold").bold, Some(true));
}

#[test]
fn an_unknown_node_or_mark_is_an_error_naming_it() {
    let node = read(r#"{"type":"doc","content":[{"type":"widget"}]}"#).unwrap_err();
    assert!(node.contains("widget"), "{node}");
    let mark = read(r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"glow"}]}]}]}"#).unwrap_err();
    assert!(mark.contains("glow"), "{mark}");
}

#[test]
fn a_container_clamps_the_width_by_its_padding() {
    let j = json!({
        "doc": {"type": "doc", "content": [{"type": "blockquote", "content": [{"type": "table", "content": [
            {"type": "tableRow", "content": [
                {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a"}]}]},
                {"type": "tableCell", "content": [{"type": "paragraph"}]},
                {"type": "tableCell", "content": [{"type": "paragraph"}]}
            ]}
        ]}]}]},
        "width": 500,
        "pad": 0
    });
    let doc = read(&j.to_string()).unwrap();
    let quote = container_of(&doc.body[0]);
    let t = table_of(&quote.blocks[0]);
    // 500 px is 375 points; a quote pads 15 each side, and three columns split 345 equally.
    assert!((t.grid[0] - 115.0).abs() < 0.01, "{:?}", t.grid);
}

#[test]
fn a_container_last_in_a_story_or_a_container_gets_a_trailing_paragraph() {
    let cell = json!({"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "x"}]}]});
    let table = json!({"type": "table", "content": [{"type": "tableRow", "content": [cell]}]});
    let j = json!({"type": "doc", "content": [
        {"type": "blockquote", "content": [table.clone()]},
        {"type": "blockquote", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "last"}]}]}
    ]});
    let doc = read(&j.to_string()).unwrap();
    let first = container_of(&doc.body[0]);
    assert!(first.blocks.last().unwrap().as_para().is_some_and(Paragraph::is_empty));
    // The quote at the end of the story is followed by an empty paragraph.
    assert_eq!(doc.body.len(), 3);
    assert_eq!(container_of(&doc.body[1]).blocks[0].as_para().unwrap().text, "last");
    assert!(doc.body[2].as_para().unwrap().is_empty());
}

#[test]
fn nesting_past_nine_containers_is_an_error_naming_it() {
    let mut node = json!({"type": "paragraph", "content": [{"type": "text", "text": "deep"}]});
    for _ in 0..10 {
        node = json!({"type": "blockquote", "content": [node]});
    }
    let err = read(&json!({"type": "doc", "content": [node]}).to_string()).unwrap_err();
    assert!(err.contains("blockquote") && err.contains('9'), "{err}");
}

#[test]
fn a_rowspan_is_a_vertical_merge_with_continuation_cells() {
    let j = json!({"type": "doc", "content": [{"type": "table", "content": [
        {"type": "tableRow", "content": [
            {"type": "tableCell", "attrs": {"rowspan": 2, "colspan": 1, "colwidth": [120]}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "tall"}]}]},
            {"type": "tableCell", "attrs": {"colspan": 1, "colwidth": [120]}, "content": [{"type": "paragraph"}]}
        ]},
        {"type": "tableRow", "content": [
            {"type": "tableCell", "attrs": {"colspan": 1, "colwidth": [120]}, "content": [{"type": "paragraph"}]}
        ]}
    ]}]});
    let doc = read(&j.to_string()).unwrap();
    let t = table_of(&doc.body[0]);
    assert_eq!(t.grid, [90.0, 90.0]);
    assert_eq!(t.rows[0].cells[0].props.vmerge, VMerge::Restart);
    assert_eq!(t.rows[1].cells[0].props.vmerge, VMerge::Continue);
    assert_eq!(t.rows[1].cells.len(), 2);
}

#[test]
fn a_list_in_a_suggestion_s_old_blocks_takes_the_numbering_read_registered_for_it() {
    let j = json!({"type": "doc", "content": [
        {"type": "paragraph", "attrs": {"suggest": {"ins": {"id": "s", "g": "g", "by": "Assistant", "at": 1793500000000_i64, "old": [
            {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "old"}]}]}]}
        ]}}}, "content": [{"type": "text", "text": "new"}]},
        {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "after"}]}]}]}
    ]});
    let doc = read(&j.to_string()).unwrap();
    assert_eq!(doc.numbering.nums.len(), 2);
    let old = doc.body[0].as_para().unwrap();
    assert_eq!(old.text, "old");
    assert_eq!(old.props.numbering, Some(NumRef { num: 1, level: 0 }));
    assert_eq!(doc.body[2].as_para().unwrap().props.numbering, Some(NumRef { num: 2, level: 0 }));
}

#[test]
fn read_blocks_reads_a_fragment_into_a_document_that_prepared_its_numbering() {
    let doc = doc_of("lists.json");
    let frag = read_blocks(&doc, 500.0, &json!([{"type": "paragraph", "content": [{"type": "text", "text": "hi"}]}])).unwrap();
    assert_eq!(frag.blocks.len(), 1);
    assert_eq!(frag.blocks[0].as_para().unwrap().text, "hi");

    let list = json!([{"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph"}]}]}]);
    let err = read_blocks(&Document::new(), 500.0, &list).unwrap_err();
    assert!(err.contains("numbering"), "{err}");
}

fn written(name: &str) -> serde_json::Value {
    serde_json::from_str(&write(&doc_of(name))).unwrap()
}

fn written_of(doc: &Document) -> serde_json::Value {
    serde_json::from_str(&write(doc)).unwrap()
}

/// Every node of a post, the one given and its content after it.
fn nodes(v: &serde_json::Value) -> Vec<&serde_json::Value> {
    let mut out = vec![v];
    for c in v.get("content").and_then(serde_json::Value::as_array).into_iter().flatten() {
        out.extend(nodes(c));
    }
    out
}

fn node_with_text<'a>(v: &'a serde_json::Value, text: &str) -> &'a serde_json::Value {
    nodes(v)
        .into_iter()
        .find(|n| n.get("type").and_then(serde_json::Value::as_str) == Some("text") && n.get("text").and_then(serde_json::Value::as_str) == Some(text))
        .unwrap()
}

#[test]
fn every_fixture_writes_a_post_that_reads_back_the_same() {
    for name in ["marks.json", "headings.json", "lists.json", "nested-lists.json", "tables.json", "table-widths.json", "quotes-code.json", "box.json", "objects.json", "suggestions.json"] {
        let first = write(&doc_of(name));
        let second = write(&read(&first).unwrap());
        let v: serde_json::Value = serde_json::from_str(&first).unwrap();
        // The post itself is stable once the reader has merged the runs the writer left apart; `pending` is the model's
        // revisions, and the written post holds none.
        assert_eq!(second, write(&read(&second).unwrap()), "{name} is the same post written twice");
        assert_eq!(v["doc"]["type"], "doc", "{name}");
        assert!(v["doc"]["content"].is_array(), "{name}");
    }
    // A post with no waiting suggestion has nothing pending; the suggestions fixture holds three revisions.
    assert_eq!(written("marks.json")["pending"], 0);
    assert_eq!(written("suggestions.json")["pending"].as_u64(), Some(3));
}

#[test]
fn a_tracked_deletion_is_left_out() {
    let v = written("suggestions.json");
    let joined: String = nodes(&v["doc"])
        .iter()
        .filter_map(|n| n.get("text").and_then(serde_json::Value::as_str))
        .collect();
    assert!(joined.contains("The assistant rewritten line."), "{joined}");
    assert!(joined.contains("Kept, with a line taken out after it."), "{joined}");
    // The blocks and runs the assistant removed are not written: the post is the accepted view.
    assert!(!joined.contains("The first version of this line."), "{joined}");
    assert!(!joined.contains("A line the assistant removed."), "{joined}");
    assert_eq!(v["doc"]["content"].as_array().unwrap().len(), 3);
}

#[test]
fn a_size_that_snaps_to_the_base_size_drops_its_mark() {
    let v = written("marks.json");
    let same = node_with_text(&v["doc"], "same size");
    assert!(same.get("marks").is_none(), "{same}");
    let small = node_with_text(&v["doc"], "small");
    assert_eq!(small["marks"], json!([{ "type": "fontSize", "attrs": { "size": "80" } }]));
    // Inline code is the only mark a code run keeps.
    let both = node_with_text(&v["doc"], "more code");
    assert_eq!(both["marks"], json!([{ "type": "code" }]));
}

#[test]
fn the_typing_room_after_a_container_is_dropped_at_story_level_and_inside_a_container() {
    let cell = json!({"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "x"}]}]});
    let table = json!({"type": "table", "content": [{"type": "tableRow", "content": [cell]}]});
    let j = json!({"type": "doc", "content": [{"type": "blockquote", "content": [table]}]});
    let doc = read(&j.to_string()).unwrap();
    assert_eq!(doc.body.len(), 2, "the reader adds a paragraph after the quote");
    let v = written_of(&doc);
    let content = v["doc"]["content"].as_array().unwrap();
    assert_eq!(content.len(), 1);
    assert_eq!(content[0]["type"], "blockquote");
    assert_eq!(content[0]["content"].as_array().unwrap().len(), 1, "the quote holds its table alone");

    // A table at the end of the story takes no trailing paragraph either.
    let j = json!({"type": "doc", "content": [table]});
    let doc = read(&j.to_string()).unwrap();
    assert_eq!(written_of(&doc)["doc"]["content"].as_array().unwrap().len(), 1);
}

#[test]
fn a_code_block_s_paragraphs_join_with_line_breaks() {
    let v = written("quotes-code.json");
    let code = nodes(&v["doc"]).into_iter().find(|n| n.get("type").and_then(serde_json::Value::as_str) == Some("codeBlock")).unwrap();
    assert_eq!(code["attrs"]["language"], "javascript");
    assert_eq!(code["content"], json!([{ "type": "text", "text": "const answer = 42;\nconsole.log(answer);\n" }]));

    // A line break inside one of the code's paragraphs is a line of its own.
    let mut doc = Document::new();
    doc.styles = std::sync::Arc::new(post::styles("Helvetica", 100));
    doc.numbering = std::sync::Arc::new(post::numbering());
    let mut p = Paragraph::with_text("one\ntwo", CharProps::default());
    p.props.style = Some(post::CODE_TEXT.into());
    let code = Container {
        id: Id(0),
        role: ContainerRole::Code,
        style: Some(post::CODE_BLOCK.into()),
        language: None,
        space_after: 12.0,
        indent: 0.0,
        title: Blocks::new(),
        blocks: vec![para_block(p)],
    };
    doc.body = vec![Arc::new(Block::Container(code))];
    let v = written_of(&doc);
    assert_eq!(v["doc"]["content"][0]["content"][0]["text"], "one\ntwo");
}

#[test]
fn an_object_carries_its_shown_width_and_keeps_its_display_width() {
    let v = written("objects.json");
    let objects: Vec<&serde_json::Value> = nodes(&v["doc"])
        .into_iter()
        .filter(|n| matches!(n.get("type").and_then(serde_json::Value::as_str), Some("canvas" | "planChart" | "media")))
        .collect();
    assert_eq!(objects.len(), 6);
    let canvas = objects[0];
    assert_eq!((canvas["attrs"]["dw"].as_f64(), canvas["attrs"]["shown"].as_f64()), (Some(400.0), Some(400.0)));
    let video = objects[3];
    assert_eq!(video["attrs"]["dw"].as_f64(), Some(360.0));
    assert!(video["attrs"]["src"].as_str().unwrap().starts_with("data:video/mp4"));
    assert_eq!(video["attrs"]["name"], "clip.mp4");
    // A GIF shown at its own width has no display width of its own, but says where it is shown.
    let gif = objects[4];
    assert!(gif["attrs"]["dw"].is_null(), "{gif}");
    assert_eq!(gif["attrs"]["shown"].as_f64(), Some(300.0));
    // A medium and a plan chart write the height hints the reader sizes them from, so a canvas draft reopened without the DOM
    // editor keeps its size; a canvas takes its size from its own artboard and writes none.
    assert!(canvas["attrs"].get("ch").is_none() && canvas["attrs"].get("nw").is_none());
    let chart = objects[2];
    assert_eq!(chart["attrs"]["ch"].as_f64(), Some(450.0));
    assert_eq!((video["attrs"]["nw"].as_f64(), video["attrs"]["nh"].as_f64()), (Some(360.0), Some(202.8)));
    assert_eq!((gif["attrs"]["nw"].as_f64(), gif["attrs"]["nh"].as_f64()), (Some(300.0), Some(169.0)));
}

#[test]
fn a_resized_medium_writes_its_display_width_and_reads_back_at_it() {
    // boxes.jsx's resize sends the new size and `dw` in the data: the post's own form (the forum push, a DOM reopen) reads
    // `dw`, not the reader's hints, so the width must reach the written node.
    let mut doc = doc_of("objects.json");
    doc.objects_mut(&|o| box_of(o).kind == "media", &mut |o| {
        if let Some(f) = o.float_mut() {
            if let Some(b) = f.r#box.as_ref() {
                let mut resized = (**b).clone();
                resized.data = "{\"name\":\"clip.mp4\",\"dw\":500}".into();
                f.r#box = Some(Arc::new(resized));
            }
        }
        o.set_size(500.0, 281.25);
    });
    let written = written_of(&doc);
    let media: Vec<&serde_json::Value> = nodes(&written["doc"]).into_iter()
        .filter(|n| n.get("type").and_then(serde_json::Value::as_str) == Some("media"))
        .collect();
    assert!(media.len() >= 3 && media.iter().all(|n| n["attrs"]["dw"].as_f64() == Some(500.0)), "{media:?}");
    // And reading it back keeps 500 wide, not the 300-point fallback.
    let read_back = read(&written.to_string()).unwrap();
    let (w, _, _) = image_of(read_back.body[4].as_para().unwrap()).0.frame().unwrap();
    assert_eq!(w, 500.0);
}

#[test]
fn a_table_writes_integer_pixel_widths_and_its_merges() {
    let v = written("tables.json");
    let table = &v["doc"]["content"][1];
    assert_eq!(table["type"], "table");
    let rows = table["content"].as_array().unwrap();
    let head = &rows[0]["content"][0];
    assert_eq!((head["type"].as_str(), head["attrs"]["colwidth"].as_array().unwrap()[0].as_i64()), (Some("tableHeader"), Some(120)));
    assert_eq!(rows[1]["content"][1]["attrs"]["colwidth"].as_array().unwrap()[0].as_i64(), Some(240));
    // A cell across two columns names no width, and its text is kept.
    let across = &rows[2]["content"][0];
    assert_eq!(across["attrs"]["colspan"], 2);
    assert!(across["attrs"].get("colwidth").is_none());

    // A rowspan is one cell with a continuation cell below it, written as its rowspan again.
    let j = json!({"type": "doc", "content": [{"type": "table", "content": [
        {"type": "tableRow", "content": [
            {"type": "tableCell", "attrs": {"rowspan": 2, "colwidth": [120]}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "tall"}]}]},
            {"type": "tableCell", "attrs": {"colwidth": [120]}, "content": [{"type": "paragraph"}]}
        ]},
        {"type": "tableRow", "content": [
            {"type": "tableCell", "attrs": {"colwidth": [120]}, "content": [{"type": "paragraph"}]}
        ]}
    ]}]});
    let v = written_of(&read(&j.to_string()).unwrap());
    let rows = v["doc"]["content"][0]["content"].as_array().unwrap();
    assert_eq!(rows[0]["content"][0]["attrs"]["rowspan"], 2);
    assert_eq!(rows[1]["content"].as_array().unwrap().len(), 1, "the continuation cell is not a cell of its own");
}

#[test]
fn lists_nest_by_their_numbering_instances() {
    let v = written("nested-lists.json");
    let content = v["doc"]["content"].as_array().unwrap();
    assert_eq!(content.len(), 1);
    let top = &content[0];
    assert_eq!(top["type"], "bulletList");
    let items = top["content"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let first = items[0]["content"].as_array().unwrap();
    assert_eq!(first[0]["content"][0]["text"], "top");
    assert_eq!(first[1]["type"], "bulletList");
    let inner = first[1]["content"].as_array().unwrap();
    assert_eq!(inner[0]["content"][0]["content"][0]["text"], "second level");
    assert_eq!(inner[0]["content"][1]["type"], "orderedList");
    assert_eq!(inner[0]["content"][1]["attrs"]["start"], 2);
    assert_eq!(inner[1]["content"][0]["content"][0]["text"], "second level again");
    let second = items[1]["content"].as_array().unwrap();
    assert_eq!(second[1]["content"][0]["text"], "a second paragraph in the same item");
    assert_eq!(second[2]["type"], "blockquote");

    // An ordered list's start, and one that starts at 1.
    let v = written("lists.json");
    let content = v["doc"]["content"].as_array().unwrap();
    assert_eq!(content[1]["attrs"]["start"], 3);
    assert!(content[2].get("attrs").is_none(), "{}", content[2]);

    // A paragraph after a list is not one of its items.
    let j = json!({"type": "doc", "content": [
        {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "item"}]}]}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "after"}]}
    ]});
    let v = written_of(&read(&j.to_string()).unwrap());
    let content = v["doc"]["content"].as_array().unwrap();
    assert_eq!(content.len(), 2);
    assert_eq!(content[1]["content"][0]["text"], "after");
}

#[test]
fn text_beside_an_object_splits_into_paragraphs() {
    let mut doc = doc_of("objects.json");
    let Block::Para(p) = Arc::get_mut(&mut doc.body[1]).unwrap() else { panic!("an object paragraph") };
    p.text.insert_str(0, "before ");
    p.runs.insert(0, Run { len: 7, props: CharProps::default() });
    p.text.push_str(" after");
    p.runs.push(Run { len: 6, props: CharProps::default() });
    let v = written_of(&doc);
    let content = v["doc"]["content"].as_array().unwrap();
    assert_eq!(content[1]["content"][0]["text"], "before ");
    assert_eq!(content[2]["type"], "canvas");
    assert_eq!(content[3]["content"][0]["text"], " after");
}

#[test]
fn a_colwidth_entry_keeps_its_column() {
    let j = json!({"type": "doc", "content": [{"type": "table", "content": [
        {"type": "tableRow", "content": [
            {"type": "tableCell", "attrs": {"colspan": 2, "colwidth": [0, 200]}, "content": [{"type": "paragraph"}]}
        ]}
    ]}]});
    let doc = read(&j.to_string()).unwrap();
    let t = table_of(&doc.body[0]);
    // 200 px is 150 points on the second column; the first takes the rest of the page's text width.
    assert_eq!(t.grid[1], 150.0);
    assert!((t.grid[0] - (1057.5 - 150.0)).abs() < 0.01, "{:?}", t.grid);
}

#[test]
fn a_paragraph_merges_runs_whose_formatting_is_the_same() {
    let j = json!({"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "a"},
        {"type": "text", "text": "b"},
        {"type": "hardBreak"},
        {"type": "text", "text": "c"}
    ]}]});
    let doc = read(&j.to_string()).unwrap();
    let p = paras(&doc)[0];
    assert_eq!(p.text, "ab\nc");
    assert_eq!(p.runs.len(), 1);
}

#[test]
fn a_post_that_is_not_a_document_is_refused() {
    for (json, problem) in [
        ("null", "object"),
        ("[]", "object"),
        (r#"{"doc":"x"}"#, "doc"),
        (r#"{"type":"doc","content":[{"type":"text","text":5}]}"#, "text"),
        (r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":"bold"}]}]}"#, "marks"),
    ] {
        let err = read(json).unwrap_err();
        assert!(err.contains(problem), "{json}: {err}");
    }
}

#[test]
fn an_absurd_page_width_is_clamped() {
    let j = json!({"doc": {"type": "doc", "content": [{"type": "paragraph"}]}, "width": 1e300, "pad": 0});
    let doc = read(&j.to_string()).unwrap();
    assert!(doc.last_section.page_w.is_finite());
    assert!(doc.last_section.page_w <= 4036.0, "{}", doc.last_section.page_w);
}


/// Whether two JSON values are the same, keys in any order: the post's structure, not the order the writer emits it in.
fn same_json(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    match (a, b) {
        (serde_json::Value::Object(x), serde_json::Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same_json(v, w))),
        (serde_json::Value::Array(x), serde_json::Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(v, w)| same_json(v, w)),
        (x, y) => x == y,
    }
}

#[test]
fn a_list_keeps_its_own_children_and_leaves_the_blocks_after_it_alone() {
    let list = json!({"type": "bulletList", "content": [{"type": "listItem", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "item"}]}]}]});
    let quote = json!({"type": "blockquote", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "quoted"}]}]});
    let code = json!({"type": "codeBlock", "content": [{"type": "text", "text": "code"}]});
    let table = json!({"type": "table", "content": [{"type": "tableRow", "content": [
        {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "cell"}]}]}]}]});
    let boxed = json!({"type": "box", "content": [{"type": "boxContent", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "boxed"}]}]}]});

    // After the list, at the top level: each stays a block after it.
    let after = json!({"type": "doc", "content": [list.clone(), quote.clone(), code.clone(), table.clone(), boxed.clone()]});
    let back = written_of(&read(&after.to_string()).unwrap());
    assert!(same_json(&back["doc"], &after), "after the list: {back}");

    // Inside an item, each stays in it.
    let item = json!({"type": "doc", "content": [{"type": "bulletList", "content": [{"type": "listItem", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "item"}]}, quote.clone(), code.clone(), table.clone(), boxed.clone()]}]}]});
    let back = written_of(&read(&item.to_string()).unwrap());
    assert!(same_json(&back["doc"], &item), "in the item: {back}");

    // Inside a nested item, each stays in that item.
    let inner = json!({"type": "bulletList", "content": [{"type": "listItem", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "deep"}]}, quote.clone(), code.clone(), table.clone(), boxed.clone()]}]});
    let nested = json!({"type": "doc", "content": [{"type": "bulletList", "content": [{"type": "listItem", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "top"}]}, inner]}]}]});
    let back = written_of(&read(&nested.to_string()).unwrap());
    assert!(same_json(&back["doc"], &nested), "in the nested item: {back}");
}

#[test]
fn a_heading_round_trips_with_its_level_alignment_and_marks() {
    let v = written("headings.json");
    let heads: Vec<&serde_json::Value> = v["doc"]["content"].as_array().unwrap().iter().filter(|n| n["type"] == "heading").collect();
    assert_eq!(heads.len(), 8);
    for (i, h) in heads.iter().take(6).enumerate() {
        assert_eq!(h["attrs"]["level"], i + 1, "{h}");
    }
    assert_eq!(heads[6]["attrs"]["textAlign"], "center");
    // Marks in a heading keep their own sizes, scaled from the heading's own.
    let small = node_with_text(&v["doc"], "small");
    assert_eq!(small["marks"], json!([{ "type": "fontSize", "attrs": { "size": "80" } }]));
    assert_eq!(node_with_text(&v["doc"], "heading")["marks"], json!([{ "type": "bold" }]));
}

#[test]
fn a_table_writes_only_the_widths_the_post_gave_and_each_cells_own_kind() {
    let v = written("table-widths.json");
    let rows = v["doc"]["content"][0]["content"].as_array().unwrap();
    // A spanning cell keeps one entry per column it spans.
    assert_eq!(rows[1]["content"][1]["attrs"]["colwidth"], json!([90, 200]));
    // A cell the post gave no width stays without one.
    assert!(rows[2]["content"][0]["attrs"].get("colwidth").is_none(), "{}", rows[2]["content"][0]);
    // A row of a header and a body cell keeps each cell's kind.
    assert_eq!(rows[3]["content"][0]["type"], "tableHeader");
    assert_eq!(rows[3]["content"][1]["type"], "tableCell");
}



#[test]
fn the_post_opens_with_the_forum_s_css_line_height() {
    // section 2: 1.8 for text (at least), and 1.1 for H1 to H3 (exact: the DOM's line box is shorter than the glyphs).
    let doc = read(&json!({"doc": {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "body"}]},
        {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "H1"}]},
        {"type": "heading", "attrs": {"level": 4}, "content": [{"type": "text", "text": "H4"}]}
    ]}}).to_string())
    .unwrap();
    let spacing = |id: &str| doc.styles.get(id).unwrap().para.line_spacing;
    assert_eq!(spacing("Normal"), Some(LineSpacing::AtLeast(21.6)));
    assert_eq!(spacing("Heading1"), Some(LineSpacing::Exactly(39.6)));
    assert_eq!(spacing("Heading4"), Some(LineSpacing::AtLeast(32.4)));
    assert_eq!(spacing("PostCodeText"), Some(LineSpacing::AtLeast(19.44)));
    // A larger base scales the text, not the headings.
    let big = read(&json!({"doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "body"}]}]},
        "base": {"font": "", "size": 150}}).to_string())
    .unwrap();
    assert_eq!(big.styles.get("Normal").unwrap().para.line_spacing, Some(LineSpacing::AtLeast(32.4)));
    assert_eq!(big.styles.get("Heading1").unwrap().para.line_spacing, Some(LineSpacing::Exactly(39.6)));
}

#[test]
fn a_list_and_a_table_end_with_the_forum_s_1em_gap() {
    // ul, ol { margin-bottom: 0 } and li > p { margin: 0 }: the gap after is the last item's own 1em after.
    let list = read(&json!({"doc": {"type": "doc", "content": [
        {"type": "bulletList", "content": [
            {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "one"}]}]},
            {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "two"}]}]}
        ]}
    ]}}).to_string())
    .unwrap();
    let items = paras(&list);
    assert_eq!((items[0].props.space_after, items[1].props.space_after), (Some(0.0), Some(post::CONTAINER_GAP)));

    // table { margin-bottom: 1em } and td > p { margin: 0 }: the last row's last paragraphs carry the gap.
    let table = read(&json!({"doc": {"type": "doc", "content": [
        {"type": "table", "content": [
            {"type": "tableRow", "content": [{"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "first"}]}]}]},
            {"type": "tableRow", "content": [{"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "last"}]}]}]}
        ]}
    ]}}).to_string())
    .unwrap();
    let cells = paras(&table);
    assert_eq!((cells[0].props.space_after, cells[1].props.space_after), (Some(0.0), Some(post::CONTAINER_GAP)));
}

#[test]
fn a_quote_s_last_child_adds_no_gap_of_its_own() {
    // blockquote > :last-child { margin-bottom: 0 }: the quote's 1em gap below sits outside the quote.
    let doc = read(&json!({"doc": {"type": "doc", "content": [
        {"type": "blockquote", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "one"}]},
            {"type": "paragraph", "content": [{"type": "text", "text": "two"}]}
        ]}
    ]}}).to_string())
    .unwrap();
    let quote = container_of(doc.body.first().unwrap());
    let mut inner = Vec::new();
    collect(&quote.blocks, &mut inner);
    // The first keeps Normal's 1em after (None: the style's); the last adds none of its own.
    assert_eq!((inner[0].props.space_after, inner[1].props.space_after), (None, Some(0.0)));
    assert_eq!(quote.space_after, post::CONTAINER_GAP);
}

#[test]
fn a_code_block_ends_with_the_other_containers_1em_gap() {
    // pre { margin-bottom: 1em } as the DOM has it: the code block's container carries the same 12 pt after as a quote and a box.
    let doc = read(&json!({"doc": {"type": "doc", "content": [
        {"type": "codeBlock", "content": [{"type": "text", "text": "c1\nc2"}]}
    ]}}).to_string())
    .unwrap();
    let code = container_of(doc.body.first().unwrap());
    assert_eq!((code.role, code.space_after), (ContainerRole::Code, post::CONTAINER_GAP));
}
