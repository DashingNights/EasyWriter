//! A font that arrives after the first layout (the browser adds a document's fonts as their bytes
//! come in) lays out again only the paragraphs set in it (EasyWriter patch, CHANGES.md).
use super::*;
use ew_doc::Path;

/// JetBrains Mono (bundled) renamed to `name` (14 characters), so adding it adds a new family.
fn renamed(name: &str) -> Vec<u8> {
    assert_eq!(name.len(), 14);
    let mut data = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/fonts/JetBrainsMono-Regular.ttf")).unwrap();
    let utf16 = |s: &str| s.encode_utf16().flat_map(u16::to_be_bytes).collect::<Vec<u8>>();
    for (from, to) in [(utf16("JetBrains Mono"), utf16(name)), (b"JetBrains Mono".to_vec(), name.as_bytes().to_vec())] {
        while let Some(at) = data.windows(from.len()).position(|w| w == from) {
            data[at..at + to.len()].copy_from_slice(&to);
        }
    }
    data
}

#[test]
fn a_font_arriving_lays_out_only_its_paragraphs() {
    let mut d = Document::from_text(&"some text here\n".repeat(20));
    // A bundled face for the rest, so neither the host's fonts nor fonts other tests add touch them.
    d.styles_mut().default_chr.font = Some("Source Serif 4".into());
    let p = d.para_mut(StoryRef::Body, &Path::top(3)).unwrap();
    p.runs[0].props.font = Some("EngineLateFont".into());
    // A family nobody supplies keeps its stand-in when another font arrives, and so its layout.
    let p = d.para_mut(StoryRef::Body, &Path::top(7)).unwrap();
    p.runs[0].props.font = Some("Engine Never Font".into());
    let opts = LayoutOptions::default();
    let mut c = LayoutCache::new();
    layout(&d, &mut c, &opts);
    let misses = c.misses;
    layout(&d, &mut c, &opts);
    assert_eq!(c.misses, misses, "nothing changed, nothing laid out again");
    assert!(ew_fonts::FontDb::global().add_font(renamed("EngineLateFont")) > 0);
    let l = layout(&d, &mut c, &opts);
    assert_eq!(c.misses, misses + 1, "only the paragraph set in the new font, not the one in a missing family");
    let face = l.pages[0]
        .items
        .iter()
        .find_map(|i| match i {
            Placed::Lines { path, para, .. } if path.0.first() == Some(&3) => Some(para.styles[para.clusters[0].style as usize].face),
            _ => None,
        })
        .unwrap();
    assert_eq!(face.id(), ew_fonts::FontDb::global().face("EngineLateFont", "Regular").id(), "drawn in the font that arrived");
}
