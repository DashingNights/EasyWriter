//! Original partial-cell-margin fixture (ECMA-376 §17.4.69).
use std::io::{Cursor, Read, Write};

fn fixture() -> Vec<u8> {
    let document = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tblPr><w:tblCellMar><w:top w:w="55" w:type="dxa"/><w:left w:w="45" w:type="dxa"/><w:bottom w:w="55" w:type="dxa"/><w:right w:w="55" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="4320"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcMar><w:left w:w="0" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:r><w:t>Point</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"#;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("word/document.xml", zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(document.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

#[test]
fn partial_margin_stays_partial() {
    let doc = ew_docx::read(&fixture()).unwrap();
    let table = doc.body[0].as_table().unwrap();
    assert_eq!(table.rows[0].cells[0].props.margins, None, "a left-only margin is not a complete override");
    assert_eq!(table.rows[0].cells[0].props.resolved_margins([6.0, 7.0, 8.0, 9.0]), [6.0, 0.0, 8.0, 9.0]);
    let bytes = ew_docx::write(&doc).unwrap();
    let reopened = ew_docx::read(&bytes).unwrap();
    let cell = &reopened.body[0].as_table().unwrap().rows[0].cells[0];
    assert_eq!(cell.props.resolved_margins([6.0, 7.0, 8.0, 9.0]), [6.0, 0.0, 8.0, 9.0]);
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut xml = String::new();
    zip.by_name("word/document.xml").unwrap().read_to_string(&mut xml).unwrap();
    let margins = xml.split("<w:tcMar>").nth(1).unwrap().split("</w:tcMar>").next().unwrap();
    assert!(margins.contains("<w:left w:w=\"0\""));
    assert!(!margins.contains("<w:top"));
    assert!(!margins.contains("<w:bottom"));
    assert!(!margins.contains("<w:right"));
}

/// EasyWriter engine-fidelity-5: a table's own `w:tblCellMar` that names only its bottom takes its other sides from the
/// table style, not Word's 5.4 pt default.
#[test]
fn table_margin_sides_left_out_come_from_the_style() {
    let w = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;
    let styles = format!(
        r#"<w:styles {w}><w:style w:type="table" w:styleId="Wide"><w:name w:val="Wide"/><w:tblPr><w:tblCellMar><w:left w:w="200" w:type="dxa"/><w:right w:w="300" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>"#
    );
    let document = format!(
        r#"<w:document {w}><w:body><w:tbl><w:tblPr><w:tblStyle w:val="Wide"/><w:tblCellMar><w:bottom w:w="400" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="4320"/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:body></w:document>"#
    );
    let rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, body) in [("word/document.xml", document.as_str()), ("word/styles.xml", styles.as_str()), ("word/_rels/document.xml.rels", rels)] {
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    let doc = ew_docx::read(&zip.finish().unwrap().into_inner()).unwrap();
    assert_eq!(doc.body[0].as_table().unwrap().props.cell_margins, Some([0.0, 10.0, 20.0, 15.0]));
}

/// A package of `document` (a `w:body`'s content) with a table style "Wide" whose cell margins are 10 pt left and 15 pt right.
fn styled(body: &str) -> Vec<u8> {
    let w = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;
    let styles = format!(
        r#"<w:styles {w}><w:style w:type="table" w:styleId="Wide"><w:name w:val="Wide"/><w:tblPr><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="200" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="300" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>"#
    );
    let document = format!(r#"<w:document {w}><w:body>{body}</w:body></w:document>"#);
    let rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, body) in [("word/document.xml", document.as_str()), ("word/styles.xml", styles.as_str()), ("word/_rels/document.xml.rels", rels)] {
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// Each `<tag>`...`</tag>` element of the saved document.xml, in order.
fn saved_elements(doc: &ew_doc::Document, tag: &str) -> Vec<String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(ew_docx::write(doc).unwrap())).unwrap();
    let mut xml = String::new();
    zip.by_name("word/document.xml").unwrap().read_to_string(&mut xml).unwrap();
    xml.split(&format!("<{tag}>")).skip(1).map(|s| s.split(&format!("</{tag}>")).next().unwrap().to_string()).collect()
}

/// EasyWriter engine-fixes-layout: saving writes only the `w:tblCellMar` sides that differ from what a side left out reads
/// as (the table style's, else Word's default), so a file's partial margins stay partial: a table naming only its bottom, a
/// row's `w:tblPrEx` naming only its left (its other sides are the table's), and the properties before a tracked change.
#[test]
fn saving_writes_only_the_table_margin_sides_the_file_had() {
    let grid = r#"<w:tblGrid><w:gridCol w:w="4320"/></w:tblGrid>"#;
    let cell = r#"<w:tc><w:p/></w:tc>"#;
    let body = format!(
        r#"<w:tbl><w:tblPr><w:tblStyle w:val="Wide"/><w:tblCellMar><w:bottom w:w="400" w:type="dxa"/></w:tblCellMar><w:tblPrChange w:id="1" w:author="A"><w:tblPr><w:tblStyle w:val="Wide"/><w:tblCellMar><w:top w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:tblPrChange></w:tblPr>{grid}<w:tr>{cell}</w:tr><w:tr><w:tblPrEx><w:tblCellMar><w:left w:w="500" w:type="dxa"/></w:tblCellMar></w:tblPrEx>{cell}</w:tr></w:tbl><w:tbl><w:tblPr><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr>{grid}<w:tr>{cell}</w:tr></w:tbl><w:p/>"#
    );
    let doc = ew_docx::read(&styled(&body)).unwrap();
    let (a, b) = (doc.body[0].as_table().unwrap(), doc.body[1].as_table().unwrap());
    assert_eq!(a.props.cell_margins, Some([0.0, 10.0, 20.0, 15.0]), "the style's sides");
    assert_eq!(a.props.fmt_change.as_ref().unwrap().old.cell_margins, Some([5.0, 10.0, 0.0, 15.0]), "before the change too");
    assert_eq!(a.rows[1].props.exceptions.as_ref().unwrap().cell_margins, Some([0.0, 25.0, 20.0, 15.0]), "the row's other sides are the table's");
    assert_eq!(b.props.cell_margins, Some([3.0, 5.4, 3.0, 5.4]), "no style: Word's default sides");
    let saved = saved_elements(&doc, "w:tblCellMar");
    let sides = |xml: &str| ["top", "left", "bottom", "right"].into_iter().filter(|s| xml.contains(&format!("<w:{s} "))).collect::<Vec<_>>();
    let written: Vec<Vec<&str>> = saved.iter().map(|m| sides(m)).collect();
    assert_eq!(written, [vec!["bottom"], vec!["top"], vec!["left"], vec!["top", "bottom"]], "{saved:?}");
    let reread = ew_docx::read(&ew_docx::write(&doc).unwrap()).unwrap();
    let (ra, rb) = (reread.body[0].as_table().unwrap(), reread.body[1].as_table().unwrap());
    assert_eq!((ra.props.cell_margins, rb.props.cell_margins), (a.props.cell_margins, b.props.cell_margins));
    assert_eq!(ra.rows[1].props.exceptions.as_ref().unwrap().cell_margins, a.rows[1].props.exceptions.as_ref().unwrap().cell_margins);
}
