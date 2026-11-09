//! EasyWriter engine-fidelity-3: what the Word fixture's pages showed the reader got wrong (docs/plans/engine/fidelity.md).
use std::io::{Cursor, Read, Write};

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

fn package(body: &str, styles: &str) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let o = zip::write::SimpleFileOptions::default();
    let parts = [
        ("_rels/.rels", format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#)),
        ("word/_rels/document.xml.rels", format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#)),
        ("word/document.xml", format!(r#"<w:document xmlns:w="{W}" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w:body>{body}</w:body></w:document>"#)),
        ("word/styles.xml", format!(r#"<w:styles xmlns:w="{W}">{styles}</w:styles>"#)),
    ];
    for (name, xml) in parts {
        zip.start_file(name, o).unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn document_xml(bytes: &[u8]) -> String {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut xml = String::new();
    zip.by_name("word/document.xml").unwrap().read_to_string(&mut xml).unwrap();
    xml
}

/// A paragraph's own `w:framePr` changes only what it sets of its style's frame (Word page 140: wrap around on a paragraph in
/// a style framed 144 pt wide at the right of the column).
#[test]
fn a_paragraph_frame_keeps_its_style_frame_settings() {
    let style = r#"<w:style w:type="paragraph" w:styleId="Framed"><w:name w:val="Framed"/><w:pPr><w:framePr w:w="2880" w:wrap="around" w:vAnchor="text" w:hAnchor="text" w:xAlign="right" w:y="1"/></w:pPr></w:style>"#;
    let body = r#"<w:p><w:pPr><w:pStyle w:val="Framed"/><w:framePr w:wrap="notBeside"/></w:pPr><w:r><w:t>Framed</w:t></w:r></w:p>"#;
    let doc = ew_docx::read(&package(body, style)).unwrap();
    let f = doc.body[0].as_para().unwrap().props.frame.clone().expect("a frame");
    assert_eq!((f.w, f.x_align.as_deref(), f.h_anchor.as_str(), f.v_anchor.as_str(), f.y), (Some(144.0), Some("right"), "text", "text", 0.05));
    assert_eq!(f.wrap, "notBeside", "the paragraph's own setting wins");
}

/// Collapsed by default (`w15:collapsed`) is read and written back where Word writes it.
#[test]
fn collapsed_by_default_survives_a_save() {
    let body = r#"<w:p><w:pPr><w:outlineLvl w:val="2"/><w15:collapsed/></w:pPr><w:r><w:t>Heading</w:t></w:r></w:p><w:p><w:r><w:t>Body</w:t></w:r></w:p>"#;
    let doc = ew_docx::read(&package(body, "")).unwrap();
    assert_eq!(doc.body[0].as_para().unwrap().props.collapsed, Some(true));
    assert_eq!(doc.body[1].as_para().unwrap().props.collapsed, None);
    let bytes = ew_docx::write(&doc).unwrap();
    assert!(document_xml(&bytes).contains(r#"<w:outlineLvl w:val="2"/><w15:collapsed/>"#), "{}", document_xml(&bytes));
    assert_eq!(ew_docx::read(&bytes).unwrap().body[0].as_para().unwrap().props.collapsed, Some(true));
}

/// Word's drop cap is a frame paragraph holding the letter, sized and lowered by Word; merged into the text's paragraph, the
/// paragraph mark is the text's (Word pages 97 to 99).
#[test]
fn a_merged_drop_cap_keeps_the_text_paragraph_mark() {
    let body = r#"<w:p><w:pPr><w:framePr w:dropCap="drop" w:lines="3" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/><w:rPr><w:position w:val="-9"/><w:sz w:val="129"/></w:rPr></w:pPr><w:r><w:rPr><w:position w:val="-9"/><w:sz w:val="129"/></w:rPr><w:t>T</w:t></w:r></w:p><w:p><w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>his sample</w:t></w:r></w:p>"#;
    let doc = ew_docx::read(&package(body, "")).unwrap();
    assert_eq!(doc.body.len(), 1);
    let p = doc.body[0].as_para().unwrap();
    assert_eq!((p.text.as_str(), p.props.drop_cap), ("This sample", Some(3)));
    assert_eq!(p.mark.size, Some(12.0));
    assert_eq!(p.runs[0].props.size, Some(64.5), "the letter keeps Word's size");
}

/// A size relative to a page area (`wp14:sizeRelH`, `wp14:sizeRelV`) is read and written back (Word pages 398 to 402).
#[test]
fn a_relative_size_survives_a_save() {
    use ew_doc::para::{Anchor, Float, ShapeKind, Wrap};
    let mut doc = ew_doc::Document::from_text("x");
    let float = Float { wrap: Wrap::TopAndBottom, rel_w: Some((Anchor::InsideMargin, 0.25)), rel_h: Some((Anchor::Page, 0.1)), ..Default::default() };
    let shape = ew_doc::InlineObject::Shape {
        kind: ShapeKind::Rectangle,
        w: 160.0,
        h: 100.0,
        fill: None,
        stroke: None,
        stroke_width: 1.0,
        float,
        story: None,
        freeform: None,
        effects: Default::default(),
        extra: Default::default(),
    };
    doc.insert_object(&ew_doc::Pos::body(0, 0), shape, &Default::default()).unwrap();
    let bytes = ew_docx::write(&doc).unwrap();
    let xml = document_xml(&bytes);
    assert!(xml.contains(r#"<wp14:sizeRelH relativeFrom="insideMargin"><wp14:pctWidth>25000</wp14:pctWidth></wp14:sizeRelH>"#), "{xml}");
    let back = ew_docx::read(&bytes).unwrap();
    let (_, _, f) = back.body[0].as_para().unwrap().objects[0].frame().unwrap();
    assert_eq!((f.rel_w, f.rel_h), (Some((Anchor::InsideMargin, 0.25)), Some((Anchor::Page, 0.1))));
}
