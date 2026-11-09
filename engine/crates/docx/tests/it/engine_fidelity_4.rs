//! EasyWriter engine-fidelity-4: a picture linked to a file, a framed paragraph and a content control shown as Start/End Tag
//! survive opening and saving (docs/plans/engine/fidelity.md). The reader dropped a picture linked only (Word's
//! INCLUDEPICTURE `\d`) and every link.
use std::io::{Cursor, Read, Write};

use ew_doc::InlineObject;

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const LINK: &str = "file:///C:/pictures/linked.png";

fn package(body: &str) -> Vec<u8> {
    let rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let o = zip::write::SimpleFileOptions::default();
    let parts: [(&str, Vec<u8>); 4] = [
        ("_rels/.rels", format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{rel}/officeDocument" Target="word/document.xml"/></Relationships>"#).into_bytes()),
        ("word/_rels/document.xml.rels", format!(r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="{rel}/image" Target="media/img.png"/><Relationship Id="rIdLink" Type="{rel}/image" Target="{LINK}" TargetMode="External"/></Relationships>"#).into_bytes()),
        ("word/document.xml", format!(r#"<w:document xmlns:w="{W}" xmlns:r="{rel}" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:v="urn:schemas-microsoft-com:vml"><w:body>{body}</w:body></w:document>"#).into_bytes()),
        ("word/media/img.png", b"\x89PNG\r\n\x1a\nnot really a picture".to_vec()),
    ];
    for (name, bytes) in parts {
        zip.start_file(name, o).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn part(bytes: &[u8], name: &str) -> String {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut xml = String::new();
    zip.by_name(name).unwrap().read_to_string(&mut xml).unwrap();
    xml
}

fn drawing(blip: &str) -> String {
    format!(
        r#"<w:r><w:drawing><wp:inline><wp:extent cx="609600" cy="609600"/><wp:docPr id="1" name="p"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip {blip}/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="609600" cy="609600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#
    )
}

/// The pictures in the body, in order: whether each has stored data, its link and its size.
fn pictures(doc: &ew_doc::Document) -> Vec<(bool, Option<String>, f32)> {
    doc.body
        .iter()
        .filter_map(|b| b.as_para())
        .flat_map(|p| p.objects.iter())
        .filter_map(|o| match o {
            InlineObject::Image { media, w, float, .. } => Some((!media.is_empty(), float.link.clone(), *w)),
            _ => None,
        })
        .collect()
}

#[test]
fn a_linked_picture_a_frame_and_a_tag_control_survive_open_and_save() {
    let body = [
        format!("<w:p>{}</w:p>", drawing(r#"r:embed="rIdImg" r:link="rIdLink""#)),
        format!("<w:p>{}</w:p>", drawing(r#"r:link="rIdLink""#)),
        r##"<w:p><w:r><w:pict><v:shape id="s" type="#_x0000_t75" style="width:48pt;height:48pt"><v:imagedata r:id="rIdLink"/></v:shape></w:pict></w:r></w:p>"##.to_string(),
        r#"<w:p><w:pPr><w:framePr w:w="2880" w:wrap="around" w:vAnchor="text" w:hAnchor="text" w:xAlign="right" w:y="1"/></w:pPr><w:r><w:t>Framed</w:t></w:r></w:p>"#.to_string(),
        r#"<w:p><w:sdt><w:sdtPr><w:alias w:val="Shown as"/><w15:appearance w15:val="tags"/></w:sdtPr><w:sdtContent><w:r><w:t>inside</w:t></w:r></w:sdtContent></w:sdt></w:p>"#.to_string(),
    ]
    .concat();
    let link = Some(LINK.to_string());
    let want = vec![(true, link.clone(), 48.0), (false, link.clone(), 48.0), (false, link.clone(), 48.0)];
    let doc = ew_docx::read(&package(&body)).unwrap();
    assert_eq!(pictures(&doc), want, "read: the stored and linked picture, and the two linked only");
    let saved = ew_docx::write(&doc).unwrap();
    let xml = part(&saved, "word/document.xml");
    assert_eq!(xml.matches("r:link=").count(), 3, "{xml}");
    assert_eq!(xml.matches("r:embed=").count(), 1, "only the stored picture has data");
    assert!(part(&saved, "word/_rels/document.xml.rels").contains(&format!(r#"Target="{LINK}" TargetMode="External""#)));
    let again = ew_docx::read(&saved).unwrap();
    assert_eq!(pictures(&again), want, "read back");
    let frame = again.body.get(3).and_then(|b| b.as_para()).and_then(|p| p.props.frame.clone()).expect("the frame is kept");
    assert_eq!((frame.w, frame.x_align.as_deref(), frame.wrap.as_str()), (Some(144.0), Some("right"), "around"));
    let control = again.body.get(4).and_then(|b| b.as_para()).and_then(|p| {
        p.objects.iter().find_map(|o| match o {
            InlineObject::ControlStart { control } => Some(control.clone()),
            _ => None,
        })
    });
    assert!(control.is_some_and(|c| c.shows_tags() && c.title == "Shown as"), "the control keeps Start/End Tag");
}

/// A frame with no `w:vAnchor` is placed from the margin, as Word places it (the fixture's Word 408: "Frame 5" at `w:y="1441"`
/// 72 pt below the top margin).
#[test]
fn a_frame_without_a_vertical_anchor_is_placed_from_the_margin() {
    let body = r#"<w:p><w:pPr><w:framePr w:w="920" w:wrap="around" w:hAnchor="margin" w:x="8401" w:y="1441"/></w:pPr><w:r><w:t>Frame 5</w:t></w:r></w:p>"#;
    let doc = ew_docx::read(&package(body)).unwrap();
    let f = doc.body[0].as_para().unwrap().props.frame.clone().expect("a frame");
    assert_eq!(f.v_anchor, "margin");
}
