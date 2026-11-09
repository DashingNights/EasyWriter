//! engine-container: quote, code block and box are a real block (`Block::Container`, container.rs), stored at version 12.

use std::sync::Arc;

use serde_json::json;

use crate::layout::Placed;
use crate::Session;
use ew_doc::props::{Border, Borders, CharProps, HeightRule, Rgb, RowProps};
use ew_doc::styles::TableStyleParts;
use ew_doc::{Block, Blocks, Container, ContainerRole, Document, Paragraph, Path, StoryRef, Style, StyleKind, Table};

fn blocks(v: Vec<Block>) -> Blocks {
    v.into_iter().map(Arc::new).collect()
}

fn para(s: &str) -> Block {
    Block::Para(Paragraph::with_text(s, CharProps::default()))
}

fn quote(inner: Vec<Block>) -> Container {
    Container::new(ContainerRole::Quote, blocks(inner))
}

/// A titled box holding a quote holding a paragraph and a table.
fn nested_document() -> Document {
    let mut table = Table::new(1, 1, 300.0);
    table.rows[0].cells[0].blocks = blocks(vec![para("deep")]);
    let inner = quote(vec![para("in quote"), Block::Table(table)]);
    let mut boxed = Container::new(ContainerRole::Box, blocks(vec![Block::Container(inner), para("after")]));
    boxed.title = blocks(vec![para("Titled box")]);
    let mut d = Document::new();
    d.body = blocks(vec![Block::Container(boxed), para("end")]);
    d
}

#[test]
fn walkers_cross_every_container_edge() {
    let d = nested_document();
    let paths = d.para_paths(StoryRef::Body);
    assert_eq!(
        paths.iter().map(|p| p.0.clone()).collect::<Vec<_>>(),
        vec![vec![0, 0, 0, 0], vec![0, 1, 0, 0, 0, 0, 0], vec![0, 1, 0, 0, 0, 0, 1, 0, 0, 0], vec![0, 1, 0, 1], vec![1]]
    );
    for w in paths.windows(2) {
        assert_eq!(d.next_para(StoryRef::Body, &w[0]), Some(w[1].clone()), "next of {}", w[0]);
        assert_eq!(d.prev_para(StoryRef::Body, &w[1]), Some(w[0].clone()), "previous of {}", w[1]);
    }
    // The paragraph in the table's cell: `cell_of` finds that cell past the quote and the box.
    let deep = paths[2].clone();
    assert_eq!(d.cell_of(StoryRef::Body, &deep), Some((Path(vec![0, 1, 0, 0, 0, 0, 1]), 0, 0)));
    // The paragraph directly in the quote's region: `container_of` finds the quote.
    let (cp, region, c) = d.container_of(StoryRef::Body, &paths[1]).expect("the quote");
    assert_eq!((cp, region), (Path(vec![0, 1, 0, 0]), 0));
    assert_eq!(c.role, ContainerRole::Quote);
    assert!(d.container_of(StoryRef::Body, &deep).is_none(), "a paragraph in a table in the quote is in the table");
    assert_eq!(d.plain_text(StoryRef::Body), "Titled box\nin quote\ndeep\nafter\nend");
}

#[test]
fn tab_in_a_quote_in_a_cell_moves_to_the_next_cell() {
    let mut t = Table::new(1, 2, 400.0);
    t.rows[0].cells[0].blocks = blocks(vec![Block::Container(quote(vec![para("a")]))]);
    let mut d = Document::new();
    d.body = blocks(vec![Block::Table(t)]);
    let mut s = Session::new(d);
    s.run("caret.set", &json!({"pos": {"story": "body", "path": [0, 0, 0, 0, 0, 0, 0], "off": 0}})).unwrap();
    s.run("text.tab", &json!({})).unwrap();
    let (tp, row, cell) = s.doc.cell_of(s.sel.focus.story, &s.sel.focus.path).expect("a cell");
    assert_eq!((tp, row, cell), (Path(vec![0]), 0, 1), "{:?}", s.sel.focus);
}

/// A table style with a left border, a fill and 12 pt side margins.
fn quote_style(id: &str) -> Style {
    Style {
        id: id.into(),
        name: id.into(),
        kind: StyleKind::Table,
        table: Some(TableStyleParts {
            borders: Some(Borders { left: Some(Border::single(2.0)), ..Borders::default() }),
            fill: Some(Rgb(0xEE, 0xEE, 0xEE)),
            cell_margins: Some([0.0, 12.0, 0.0, 12.0]),
            ..TableStyleParts::default()
        }),
        ..Style::default()
    }
}

/// The first line of the paragraph at document path `path` on `page`: its x and its top.
fn lines(page: &crate::layout::Page, path: &[u32]) -> Option<(f32, f32)> {
    page.items.iter().find_map(|i| match i {
        Placed::Lines { story, path: p, x, y, .. } if page.ids.doc_path(*story, p).is_some_and(|q| q.0 == path) => Some((*x, *y)),
        _ => None,
    })
}

#[test]
fn a_quote_lays_out_as_its_frame_and_leaves_its_space_below() {
    let new_doc = |space_after: f32| {
        let mut d = Document::new();
        d.styles_mut().upsert(quote_style("PostQuote"));
        let mut c = quote(vec![para("Text")]);
        c.style = Some("PostQuote".into());
        c.space_after = space_after;
        d.body = blocks(vec![Block::Container(c), para("After")]);
        d
    };
    let mut s = Session::new(new_doc(12.0));
    let l = s.layout();
    let page = &l.pages[0];
    let fills: Vec<_> = page.items.iter().filter_map(|i| if let Placed::Fill { rect, .. } = i { Some(*rect) } else { None }).collect();
    assert_eq!(fills.len(), 1, "the quote's fill");
    let fill = fills[0];
    assert!((fill.x - page.body.x).abs() < 0.5, "the fill starts at the body's left edge: {} vs {}", fill.x, page.body.x);
    assert!((fill.w - 468.0).abs() < 0.5, "a 468 pt column: {}", fill.w);
    let (x, _) = lines(page, &[0, 0, 0, 0]).expect("the quote's text");
    assert!(x >= fill.x + 11.5 && x <= fill.x + 12.5, "the text sits inside the style's left margin: {x}");
    let (_, y) = lines(page, &[1]).expect("the paragraph after");
    assert!((y - (fill.bottom() + 12.0)).abs() < 3.0, "the next paragraph starts space_after below the quote: {y} vs {}", fill.bottom() + 12.0);
    // The space below is the container's, not the frame's: none means none.
    let mut s = Session::new(new_doc(0.0));
    let l = s.layout();
    let (_, y0) = lines(&l.pages[0], &[1]).expect("the paragraph after");
    assert!((y - y0 - 12.0).abs() < 0.5, "space_after moves it: {y} vs {y0}");
}

fn filled_style(id: &str) -> Style {
    Style {
        id: id.into(),
        name: id.into(),
        kind: StyleKind::Table,
        table: Some(TableStyleParts { fill: Some(Rgb(0xEE, 0xEE, 0xEE)), ..TableStyleParts::default() }),
        ..Style::default()
    }
}

#[test]
fn a_titled_box_runs_over_pages_with_its_title_and_starts_a_page_whole() {
    let mut d = Document::new();
    d.styles_mut().upsert(filled_style("PostBox"));
    let mut c = Container::new(ContainerRole::Box, blocks((0..200).map(|i| para(&format!("line {i}"))).collect()));
    c.title = blocks(vec![para("Titled")]);
    c.style = Some("PostBox".into());
    d.body = blocks(vec![Block::Container(c)]);
    let mut s = Session::new(d);
    let l = s.layout();
    assert!(l.pages.len() > 1, "200 paragraphs run over pages");
    for (i, page) in l.pages.iter().enumerate() {
        assert!(page.items.iter().any(|it| matches!(it, Placed::Fill { .. })), "page {i} holds the box's fill");
        assert!(lines(page, &[0, 0, 0, 0]).is_some(), "page {i} holds the title");
    }

    // A page with room for the title but not one body line: the box starts on the next page.
    let mut spacer = Table::new(1, 1, 468.0);
    spacer.rows[0].props = RowProps { height: Some(600.0), height_rule: HeightRule::Exact, ..RowProps::default() };
    let mut d = Document::new();
    let big = Paragraph::with_text("Big", CharProps { size: Some(200.0), ..CharProps::default() });
    let mut c = Container::new(ContainerRole::Box, blocks(vec![Block::Para(big)]));
    c.title = blocks(vec![para("Titled")]);
    d.body = blocks(vec![Block::Table(spacer), Block::Container(c)]);
    let mut s = Session::new(d);
    let l = s.layout();
    assert!(l.pages.len() >= 2, "the box moved on");
    assert!(lines(&l.pages[0], &[1, 0, 0, 0]).is_none(), "the title does not stay at the bottom of page 1");
    assert!(lines(&l.pages[1], &[1, 0, 0, 0]).is_some(), "it starts page 2");
}

fn last_empty_paragraph_doc(text: Option<&str>) -> Document {
    let nested = quote(vec![para("b")]);
    let mut inner = vec![Block::Container(nested), para("")];
    if let Some(t) = text {
        inner[1] = para(t);
    }
    let mut d = Document::new();
    d.body = blocks(vec![Block::Container(quote(inner)), para("after")]);
    d
}

#[test]
fn an_empty_last_paragraph_after_a_nested_block_takes_no_height() {
    let after = |d: Document| {
        let mut s = Session::new(d);
        let l = s.layout();
        lines(&l.pages[0], &[1]).expect("the paragraph after the quote").1
    };
    let empty = after(last_empty_paragraph_doc(None));
    let typed = after(last_empty_paragraph_doc(Some("x")));
    assert!(typed - empty > 8.0, "an empty paragraph that holds no mark takes no room: {empty} vs {typed}");
}

/// The sample model for `test/fixtures/engine-models/container-<SCHEMA_VERSION>.json`.
fn sample_document() -> Document {
    let mut table = Table::new(1, 1, 200.0);
    table.rows[0].cells[0].blocks = blocks(vec![para("in a cell")]);
    let mut q = quote(vec![Block::Container(quote(vec![para("nested quote")])), Block::Table(table)]);
    q.style = Some("PostQuote".into());
    q.space_after = 8.0;
    let mut code = Container::new(ContainerRole::Code, blocks(vec![para("let x = 1;"), para("let y = 2;")]));
    code.language = Some("rust".into());
    code.style = Some("PostCodeBlock".into());
    let mut boxed = Container::new(ContainerRole::Box, blocks(vec![para("body text")]));
    boxed.title = blocks(vec![para("Title")]);
    boxed.style = Some("PostBox".into());
    boxed.space_after = 12.0;
    let mut d = Document::new();
    d.body = blocks(vec![Block::Container(q), para("between"), Block::Container(code), Block::Container(boxed), para("end")]);
    d
}

#[test]
fn the_sample_model_opens_and_saves_to_its_own_bytes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../../test/fixtures/engine-models/container-{}.json", ew_doc::SCHEMA_VERSION));
    // As a session opens it: the document fixed as an open fixes it, then its ids (the golden carries both).
    let mut doc = sample_document();
    doc.ensure_nonempty();
    ew_doc::Ids::fill(&mut doc);
    let bytes = doc.to_json().unwrap();
    if std::env::var("EW_CONTAINER_WRITE").is_ok() {
        std::fs::write(&path, &bytes).unwrap();
    }
    let saved = std::fs::read(&path).unwrap();
    assert_eq!(saved, bytes, "regenerate with EW_CONTAINER_WRITE=1, then EW_SCHEMA_WRITE=1 node --test test/engine-schema.test.mjs");
    let mut doc: Document = serde_json::from_slice(&saved).unwrap();
    doc.upgrade().unwrap();
    assert_eq!(doc.to_json().unwrap(), saved);
}

fn word_document() -> Document {
    let mut q = quote(vec![para("quoted")]);
    q.style = Some("PostQuote".into());
    q.space_after = 5.0;
    let mut code = Container::new(ContainerRole::Code, blocks(vec![para("one"), para("two")]));
    code.language = Some("rust".into());
    let mut boxed = Container::new(ContainerRole::Box, blocks(vec![para("body")]));
    boxed.title = blocks(vec![para("Title")]);
    let mut d = Document::new();
    d.body = blocks(vec![Block::Container(q), Block::Container(code), Block::Container(boxed), para("end")]);
    d
}

#[test]
fn a_container_saves_to_docx_as_a_marked_table_and_reads_back() {
    let d = word_document();
    let bytes = ew_docx::write(&d).unwrap();
    let back = ew_docx::read(&bytes).unwrap();
    for i in 0..3 {
        let want = d.body[i].as_container().expect("a container");
        let got = back.body[i].as_container().unwrap_or_else(|| panic!("block {i} came back as {:?}", back.body[i]));
        assert_eq!(want, got, "block {i}");
    }
    // A marked table of three rows is a plain table in a file edited in Word.
    let mut t = Table::new(3, 1, 400.0);
    t.props.description = Some("easywriter-container quote 0 ".into());
    let mut d = Document::new();
    d.body = blocks(vec![Block::Table(t), para("x")]);
    let back = ew_docx::read(&ew_docx::write(&d).unwrap()).unwrap();
    assert!(back.body[0].as_table().is_some(), "a third row makes it a table");
}

#[test]
fn text_formats_write_quotes_code_blocks_and_boxes() {
    let d = word_document();
    let md = ew_formats::markdown::export(&d);
    assert!(md.contains("> quoted"), "{md}");
    assert!(md.contains("```") && md.contains("one") && md.contains("two"), "{md}");
    let html = ew_formats::html::export(&d);
    assert!(html.contains("<blockquote>"), "{html}");
    assert!(html.contains("<pre><code"), "{html}");
    assert!(html.contains("<table"), "the box is a table: {html}");
}

#[test]
fn table_tools_skip_a_container_and_its_style_can_be_deleted() {
    let mut d = Document::new();
    d.styles_mut().upsert(quote_style("PostQuote"));
    let mut c = quote(vec![para("Text")]);
    c.style = Some("PostQuote".into());
    d.body = blocks(vec![Block::Container(c), para("After")]);
    let mut s = Session::new(d);
    let l = s.layout();
    assert!(crate::cmd::table_resize::cell_boxes(&l, &s.doc, 0).is_empty(), "a container's frame is not a table to the table tools");
    s.run("table.deleteStyle", &json!({"style": "PostQuote"})).unwrap();
    assert_eq!(s.doc.body[0].as_container().expect("the quote").style, None, "a deleted style leaves no dangling id");
}

#[test]
fn typing_in_a_quote_is_a_bounded_edit() {
    let mut s = Session::new(nested_document());
    let p = json!({"story": "body", "path": [0, 1, 0, 0, 0, 0, 0], "off": 1});
    s.run("caret.set", &json!({"pos": p})).unwrap();
    // A key a quote's paragraph is in walks its frame table and container, and changes one block of it: bounded, as a key in
    // a table cell is. The first key after an open marks the document tidy and takes the whole-document path (agent-guards).
    s.run("text.insert", &json!({"text": "x"})).unwrap();
    let first = s.light_edits();
    s.run("text.insert", &json!({"text": "y"})).unwrap();
    assert_eq!(s.light_edits(), first + 1, "first key {first}, then {}", s.light_edits());
}

/// engine-container-edit: wrap and unwrap, and the Enter and Backspace rules that leave a container.
mod edit {
    use super::*;
    use ew_doc::{Revision, RevisionKind, SectionProps};

    fn run(s: &mut Session, id: &str, v: &serde_json::Value) {
        s.run(id, v).unwrap_or_else(|e| panic!("{id}: {e}"));
    }

    fn caret(s: &mut Session, path: &[u32], off: usize) {
        run(s, "caret.set", &json!({"pos": {"story": "body", "path": path, "off": off}}));
    }

    fn range(s: &mut Session, a: (&[u32], usize), b: (&[u32], usize)) {
        run(s, "select.range", &json!({"anchor": {"story": "body", "path": a.0, "off": a.1}, "focus": {"story": "body", "path": b.0, "off": b.1}}));
    }

    fn code(lines: &[&str]) -> Block {
        Block::Container(Container::new(ContainerRole::Code, blocks(lines.iter().map(|l| para(l)).collect())))
    }

    fn titled(role: ContainerRole, title: &str, body: Vec<Block>) -> Block {
        let mut c = Container::new(role, blocks(body));
        c.title = blocks(vec![para(title)]);
        Block::Container(c)
    }

    fn doc(inner: Vec<Block>) -> Document {
        let mut d = Document::new();
        d.body = blocks(inner);
        d
    }

    fn texts(s: &Session) -> Vec<String> {
        s.doc.body.iter().map(|b| b.as_para().map_or_else(|| "<block>".to_string(), |p| p.text.clone())).collect()
    }

    fn container(s: &Session) -> &Container {
        s.doc.body[0].as_container().expect("the first block is a container")
    }

    // ---- Enter ----

    #[test]
    fn enter_in_a_title_goes_to_the_body_without_splitting() {
        let mut s = Session::new(doc(vec![titled(ContainerRole::Box, "Title", vec![para("body"), para("")]), para("after")]));
        caret(&mut s, &[0, 0, 0, 0], 3);
        run(&mut s, "text.newParagraph", &json!({}));
        assert_eq!(s.doc.body[0].as_container().unwrap().title[0].as_para().unwrap().text, "Title", "the title never splits");
        assert_eq!(s.sel.focus.path.0, vec![0, 1, 0, 0], "the caret moves to the start of the body");
    }

    #[test]
    fn enter_in_a_code_block_splits_the_line() {
        let mut s = Session::new(doc(vec![code(&["a"]), para("after")]));
        caret(&mut s, &[0, 0, 0, 0], 1);
        run(&mut s, "text.newParagraph", &json!({}));
        assert_eq!(container(&s).blocks.len(), 2, "a new line");
        assert_eq!(s.sel.focus.path.0, vec![0, 0, 0, 1]);
        assert_eq!(s.sel.focus.off, 0);
    }

    #[test]
    fn the_third_enter_leaves_a_code_block_and_one_undo_returns_the_empty_lines() {
        let mut s = Session::new(doc(vec![code(&["a"]), para("after")]));
        caret(&mut s, &[0, 0, 0, 0], 1);
        run(&mut s, "text.newParagraph", &json!({}));
        run(&mut s, "text.newParagraph", &json!({}));
        assert_eq!(container(&s).blocks.len(), 3);
        run(&mut s, "text.newParagraph", &json!({}));
        assert_eq!(container(&s).blocks.len(), 1, "the two empty lines go");
        assert_eq!(container(&s).blocks[0].as_para().unwrap().text, "a");
        assert!(s.doc.body.get(1).is_some_and(|b| b.as_para().is_some_and(Paragraph::is_empty)), "a paragraph after the code block");
        assert_eq!(s.sel.focus.path.0, vec![1]);
        run(&mut s, "edit.undo", &json!({}));
        assert_eq!(container(&s).blocks.len(), 3, "one undo brings both empty lines back");
    }

    #[test]
    fn enter_on_a_quotes_empty_last_line_leaves_the_quote() {
        let mut s = Session::new(doc(vec![Block::Container(quote(vec![para("a"), para("")])), para("after")]));
        caret(&mut s, &[0, 0, 0, 1], 0);
        run(&mut s, "text.newParagraph", &json!({}));
        assert_eq!(container(&s).blocks.len(), 1, "the empty line goes");
        assert_eq!(texts(&s), vec!["<block>".to_string(), String::new(), "after".into()], "a paragraph after the quote");
        assert_eq!(s.sel.focus.path.0, vec![1]);
    }

    #[test]
    fn enter_on_the_only_line_of_a_quote_replaces_the_quote() {
        let mut s = Session::new(doc(vec![Block::Container(quote(vec![para("")])), para("after")]));
        caret(&mut s, &[0, 0, 0, 0], 0);
        run(&mut s, "text.newParagraph", &json!({}));
        assert!(s.doc.body[0].as_para().is_some(), "the quote is gone: {:?}", s.doc.body[0]);
        assert_eq!(s.sel.focus.path.0, vec![0]);
    }

    #[test]
    fn enter_on_the_only_line_of_a_titled_box_stays() {
        let mut s = Session::new(doc(vec![titled(ContainerRole::Box, "T", vec![para("")]), para("after")]));
        caret(&mut s, &[0, 1, 0, 0], 0);
        run(&mut s, "text.newParagraph", &json!({}));
        assert!(s.doc.body[0].as_container().is_some(), "the box stays");
        assert_eq!(s.doc.body[0].as_container().unwrap().blocks.len(), 1, "its empty body stays");
        assert_eq!(s.sel.focus.path.0, vec![1]);
    }

    #[test]
    fn enter_in_a_quote_with_text_splits_as_usual() {
        let mut s = Session::new(doc(vec![Block::Container(quote(vec![para("ab"), para("cd")])), para("after")]));
        caret(&mut s, &[0, 0, 0, 0], 1);
        run(&mut s, "text.newParagraph", &json!({}));
        assert_eq!(container(&s).blocks.len(), 3);
        assert_eq!(s.sel.focus.path.0, vec![0, 0, 0, 1]);
    }

    // ---- Backspace ----

    #[test]
    fn backspace_at_a_titles_start_lifts_the_container_out() {
        let mut s = Session::new(doc(vec![titled(ContainerRole::Box, "T", vec![para("b")]), para("after")]));
        caret(&mut s, &[0, 0, 0, 0], 0);
        run(&mut s, "text.backspace", &json!({}));
        assert_eq!(texts(&s), vec!["T".to_string(), "b".into(), "after".into()]);
        assert_eq!(s.sel.focus.path.0, vec![0]);
        assert_eq!(s.sel.focus.off, 0);
    }

    #[test]
    fn backspace_at_a_code_blocks_first_line_lifts_it_out() {
        let mut s = Session::new(doc(vec![code(&["a", "b"]), para("after")]));
        caret(&mut s, &[0, 0, 0, 0], 0);
        run(&mut s, "text.backspace", &json!({}));
        assert_eq!(texts(&s), vec!["a".to_string(), "b".into(), "after".into()]);
        assert_eq!(s.sel.focus.path.0, vec![0]);
    }

    #[test]
    fn backspace_in_a_titled_boxes_body_goes_to_the_title() {
        let mut s = Session::new(doc(vec![titled(ContainerRole::Box, "T", vec![para("b")]), para("after")]));
        caret(&mut s, &[0, 1, 0, 0], 0);
        run(&mut s, "text.backspace", &json!({}));
        assert_eq!(s.sel.focus.path.0, vec![0, 0, 0, 0], "the caret is at the end of the title");
        assert_eq!(s.sel.focus.off, 1);
        assert_eq!(container(&s).blocks.len(), 1, "nothing joins");
    }

    #[test]
    fn backspace_at_a_quotes_first_block_moves_it_out() {
        let mut s = Session::new(doc(vec![Block::Container(quote(vec![para("a"), para("b")])), para("after")]));
        caret(&mut s, &[0, 0, 0, 0], 0);
        run(&mut s, "text.backspace", &json!({}));
        assert_eq!(texts(&s), vec!["a".to_string(), "<block>".into(), "after".into()]);
        assert_eq!(s.doc.body[1].as_container().expect("the quote is still second").blocks.len(), 1, "it keeps its other line");
        assert_eq!(s.sel.focus.path.0, vec![0]);
    }

    #[test]
    fn backspace_out_of_a_quote_with_one_block_removes_the_quote() {
        let mut s = Session::new(doc(vec![Block::Container(quote(vec![para("a")])), para("after")]));
        caret(&mut s, &[0, 0, 0, 0], 0);
        run(&mut s, "text.backspace", &json!({}));
        assert_eq!(texts(&s), vec!["a".to_string(), "after".into()]);
        assert_eq!(s.sel.focus.path.0, vec![0]);
    }

    #[test]
    fn backspace_outside_a_container_runs_as_usual() {
        let mut s = Session::new(doc(vec![para("a"), para("b")]));
        caret(&mut s, &[1], 0);
        run(&mut s, "text.backspace", &json!({}));
        assert_eq!(texts(&s), vec!["ab".to_string()], "the paragraphs joined");
    }

    // ---- Commands ----

    #[test]
    fn wrap_then_unwrap_gives_the_blocks_back_and_moves_both_ends() {
        let mut s = Session::new(doc(vec![para("one"), para("two")]));
        range(&mut s, (&[0], 0), (&[1], 3));
        run(&mut s, "container.wrap", &json!({"role": "quote"}));
        let c = container(&s);
        assert_eq!(c.role, ContainerRole::Quote);
        assert_eq!(c.blocks.iter().map(|b| b.as_para().unwrap().text.clone()).collect::<Vec<_>>(), vec!["one", "two"]);
        assert_eq!((s.sel.anchor.path.0.clone(), s.sel.anchor.off), (vec![0, 0, 0, 0], 0), "the start moved with its block");
        assert_eq!((s.sel.focus.path.0.clone(), s.sel.focus.off), (vec![0, 0, 0, 1], 3), "the end too");
        run(&mut s, "container.unwrap", &json!({}));
        assert_eq!(texts(&s), vec!["one".to_string(), "two".into(), String::new()]);
        assert_eq!(s.sel.focus.path.0, vec![0]);
    }

    #[test]
    fn a_code_wrap_over_a_table_is_refused() {
        let mut t = Table::new(1, 1, 300.0);
        t.rows[0].cells[0].blocks = blocks(vec![para("x")]);
        let mut s = Session::new(doc(vec![Block::Table(t), para("after")]));
        range(&mut s, (&[0, 0, 0, 0], 0), (&[1], 0));
        let err = s.run("container.wrap", &json!({"role": "code"})).unwrap_err();
        assert!(err.to_string().contains("one paragraph per line"), "{err}");
        assert!(s.doc.body[0].as_table().is_some(), "nothing wrapped");
    }

    #[test]
    fn a_paste_in_code_is_lines_in_the_code_style_and_in_a_title_is_one_line() {
        let mut styled = Paragraph::new();
        styled.props.style = Some("PostCodeText".into());
        let mut c = Container::new(ContainerRole::Code, blocks(vec![Block::Para(styled)]));
        c.style = Some("PostCodeBlock".into());
        let mut s = Session::new(doc(vec![Block::Container(c), para("after")]));
        caret(&mut s, &[0, 0, 0, 0], 0);
        s.clipboard = Some(ew_doc::edit::Fragment::from_text("a\nb"));
        run(&mut s, "edit.paste", &json!({}));
        let lines = &container(&s).blocks;
        assert_eq!(lines.iter().map(|b| b.as_para().unwrap().text.clone()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert!(lines.iter().all(|b| b.as_para().unwrap().props.style.as_deref() == Some("PostCodeText")), "each line takes the code style");

        let mut s = Session::new(doc(vec![titled(ContainerRole::Box, "T", vec![para("b")]), para("after")]));
        caret(&mut s, &[0, 0, 0, 0], 1);
        s.clipboard = Some(ew_doc::edit::Fragment::from_text("a\nb"));
        run(&mut s, "edit.paste", &json!({}));
        let title = &s.doc.body[0].as_container().unwrap().title;
        assert_eq!(title.len(), 1, "the title stays one paragraph");
        assert_eq!(title[0].as_para().unwrap().text, "Ta b", "line ends become spaces");
    }

    #[test]
    fn deleting_from_a_paragraph_into_a_quote_leaves_no_blank_lines() {
        let mut s = Session::new(doc(vec![
            para("above"),
            Block::Container(quote(vec![para("first"), para("second"), para("third"), para("fourth")])),
            para("after"),
        ]));
        range(&mut s, (&[0], 0), (&[1, 0, 0, 2], 2));
        run(&mut s, "text.delete", &json!({}));
        let texts: Vec<String> = s.doc.body[1].as_container().unwrap().blocks.iter().map(|b| b.as_para().unwrap().text.clone()).collect();
        assert_eq!(texts, vec!["ird".to_string(), "fourth".into()], "line 3's tail and line 4, no blanks");
    }

    fn tracked_quote() -> Document {
        let mut p = Paragraph::with_text("quoted", CharProps { ins: Some(0), ..CharProps::default() });
        p.mark.ins = Some(0);
        let mut d = doc(vec![Block::Container(quote(vec![Block::Para(p)])), para("after")]);
        d.revisions.push(Revision::new(RevisionKind::Insert, "A", "2026-01-01T00:00:00Z"));
        d
    }

    #[test]
    fn a_rejected_tracked_quote_leaves_no_container() {
        let mut s = Session::new(tracked_quote());
        run(&mut s, "review.rejectAll", &json!({}));
        assert!(s.doc.body.iter().all(|b| b.as_container().is_none()), "the empty quote is gone: {:?}", s.doc.body);
        assert_eq!(texts(&s), vec!["after".to_string()]);
    }

    #[test]
    fn an_accepted_tracked_quote_stays_with_no_revision() {
        let mut s = Session::new(tracked_quote());
        run(&mut s, "review.acceptAll", &json!({}));
        let q = s.doc.body[0].as_container().expect("the quote stays");
        let p = q.blocks[0].as_para().unwrap();
        assert_eq!(p.text, "quoted");
        assert!(p.mark.ins.is_none() && p.runs.iter().all(|r| r.props.ins.is_none()), "no revision is left");
    }

    #[test]
    fn delete_before_a_container_keeps_the_section_break_on_the_paragraph() {
        let mut p = Paragraph::new();
        p.section = Some(Box::new(SectionProps::default()));
        let mut s = Session::new(doc(vec![para(""), Block::Para(p), Block::Container(quote(vec![para("a")]))]));
        caret(&mut s, &[1], 0);
        run(&mut s, "text.delete", &json!({}));
        assert!(s.doc.body[1].as_para().is_some_and(|p| p.section.is_some()), "the section break survives: {:?}", s.doc.body[1]);
    }

    #[test]
    fn a_wrap_over_a_section_break_is_refused() {
        let mut p = Paragraph::with_text("x", CharProps::default());
        p.section = Some(Box::new(SectionProps::default()));
        let mut s = Session::new(doc(vec![Block::Para(p), para("after")]));
        caret(&mut s, &[0], 1);
        let err = s.run("container.wrap", &json!({"role": "quote"})).unwrap_err();
        assert!(err.to_string().contains("A section break cannot go in a quote, a code block or a box"), "{err}");
        assert!(s.doc.body[0].as_para().is_some(), "nothing wrapped");
    }

    #[test]
    fn with_track_changes_enter_on_a_quotes_empty_last_line_adds_a_line_and_leaves() {
        let mut s = Session::new(doc(vec![Block::Container(quote(vec![para("a"), para("")])), para("after")]));
        run(&mut s, "review.trackChanges", &json!({"value": true}));
        caret(&mut s, &[0, 0, 0, 1], 0);
        run(&mut s, "text.newParagraph", &json!({}));
        assert_eq!(s.doc.body.len(), 2, "nothing is added outside the quote");
        assert_eq!(container(&s).blocks.len(), 3, "the line is added in the quote");
    }
}
