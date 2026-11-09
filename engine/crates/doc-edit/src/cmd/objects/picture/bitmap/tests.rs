//! EasyWriter engine-pictures-3: every pixel edit between two corrections and through a Word file, on a plain picture and on
//! one over Word's HD Photo original. engine-picture-writer: the compiler keeps every other writer of a picture's bitmap out
//! (ew-doc's picture fields are private), so the text scan that did is gone.
#![allow(clippy::unwrap_used, clippy::panic)]

use super::*;
use crate::cmd::insert::base64_encode;
use image::{DynamicImage, Rgba, RgbaImage};
use serde_json::json;
use ew_doc::adjust::{Artistic, Recolor};
use super::super::engine_pictures_2::as_in_file;
use ew_doc::{Document, StoryRef};

/// 64 × 32 px: a 4 px white border round noise, red on the left half and blue on the right (noise, so a JPEG of it is
/// smaller than its PNG and Compress Pictures has something to gain).
fn picture() -> Vec<u8> {
    let img = RgbaImage::from_fn(64, 32, |x, y| {
        let n = ((x * 7 + y * 13) % 50) as u8;
        if !(4..60).contains(&x) || !(4..28).contains(&y) {
            Rgba([255, 255, 255, 255])
        } else if x < 32 {
            Rgba([190 + n, n, 10 + n / 2, 255])
        } else {
            Rgba([40 + n / 2, 60 + n, 190 + n, 255])
        }
    });
    encode(&DynamicImage::ImageRgba8(img))
}

/// Change Picture's picture: 40 × 20 px of green noise.
fn other() -> Vec<u8> {
    encode(&DynamicImage::ImageRgba8(RgbaImage::from_fn(40, 20, |x, y| Rgba([20, 150 + ((x * 5 + y * 3) % 60) as u8, 40, 255]))))
}

fn encode(img: &DynamicImage) -> Vec<u8> {
    let mut b = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut b), image::ImageFormat::Png).unwrap();
    b
}

fn pixels(bytes: &[u8]) -> RgbaImage {
    ew_geom::picture::decode(bytes, ew_geom::MAX_DECODED_BYTES).unwrap().to_rgba8()
}

/// Word's HD Photo original: bytes the engine can't decode, as for media/hdphoto1.wdp.
const WDP: &[u8] = b"II\xBC\x01 an HD Photo";

/// A session with the picture 48 pt wide (its pixels at 96 ppi), its top tenth cropped. With `hd`, the picture Word showed
/// over an HD Photo original with Word's own soften, read from a Word file.
fn session(hd: bool) -> Session {
    let mut s = Session::new(Document::from_text("A picture: "));
    s.sel = crate::Selection::caret(s.doc.end_of(StoryRef::Body));
    s.run("insert.picture", &json!({"data": base64_encode(&picture()), "width": 48})).unwrap();
    s.run("picture.crop", &json!({"top": 0.1})).unwrap();
    if hd {
        let wdp = s.doc.add_media(WDP.to_vec(), "wdp");
        let (pos, _) = selected(&s).unwrap();
        // What Word's file says: the picture its corrections were drawn from is the HD Photo.
        as_in_file(&mut s, &pos, |p| {
            p.layer = Some(wdp.clone());
            p.adjust.sharpen = -100.0;
        });
        s = reopen(&s);
    }
    s
}

/// `s`'s draft saved as a .docx and opened again, its picture selected.
fn reopen(s: &Session) -> Session {
    let docx = crate::io::save_bytes("p.docx", &s.doc).unwrap();
    let mut back = Session::new(ew_docx::read(&docx).unwrap());
    back.sel = crate::Selection::caret(back.doc.end_of(StoryRef::Body));
    assert!(selected(&back).is_some(), "the picture is still there");
    back
}

/// What the selected picture is: its shown bytes, its layer's and Word copy's bytes, its settings and crop.
#[derive(Clone, PartialEq)]
struct Seen {
    shown: Vec<u8>,
    layer: Option<Vec<u8>>,
    word_copy: Option<(Vec<u8>, PictureAdjust)>,
    adjust: PictureAdjust,
    crop: [f32; 4],
}

/// Bytes as their length and a hash, to keep a failure short.
fn digest(b: &[u8]) -> String {
    let h = b.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, x| (h ^ u64::from(*x)).wrapping_mul(0x100_0000_01b3));
    format!("{} bytes #{h:016x}", b.len())
}

impl std::fmt::Debug for Seen {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Seen")
            .field("shown", &digest(&self.shown))
            .field("layer", &self.layer.as_deref().map(digest))
            .field("word_copy", &self.word_copy.as_ref().map(|(b, a)| (digest(b), a)))
            .field("adjust", &self.adjust)
            .field("crop", &self.crop)
            .finish()
    }
}

fn seen(s: &Session) -> Seen {
    seen_in(&s.doc, &selected(s).unwrap().1)
}

/// What picture `o` of `doc` is.
fn seen_in(doc: &Document, o: &InlineObject) -> Seen {
    let InlineObject::Image { media, float, crop, .. } = o else { panic!("a picture") };
    let bytes = |k: &str| doc.media[k].to_vec();
    Seen {
        shown: bytes(media),
        layer: float.layer().map(bytes),
        word_copy: float.word_copy().map(|w| (bytes(&w.media), w.adjust.clone())),
        adjust: float.adjust().clone(),
        crop: *crop,
    }
}

/// The selected picture's source (the bitmap pixel edits apply to), decoded, and whether Word's HD Photo original is kept.
fn source_of(s: &Session) -> (RgbaImage, bool) {
    let (_, InlineObject::Image { media, float, .. }) = selected(s).unwrap() else { panic!("a picture") };
    let b = bitmap(s, &media, &float);
    let hd = b.hd.is_some_and(|(k, _)| s.doc.media[&k].as_slice() == WDP);
    (pixels(&s.doc.media[&b.key]), hd)
}

/// The picture shows its source with the settings in the pixels drawn in, once: `put`'s promise.
fn check_drawn(s: &Session, at: &str) {
    let (_, InlineObject::Image { media, float, .. }) = selected(s).unwrap() else { panic!("a picture") };
    let b = bitmap(s, &media, &float);
    let base = match &b.hd {
        Some((_, w)) => w.clone(),
        None => PictureAdjust::default(),
    };
    let shown = pixels(&s.doc.media[media.as_str()]);
    if float.adjust().same_pixels(&base) {
        assert_eq!(shown, pixels(&s.doc.media[&b.key]), "{at}: the picture is its source");
        assert!(b.hd.is_some() || float.layer().is_none(), "{at}: no layer without corrections in the pixels");
    } else {
        let want = super::super::in_pixels(DynamicImage::ImageRgba8(pixels(&s.doc.media[&b.key])), float.adjust()).to_rgba8();
        assert!(shown == want, "{at}: the picture is its source with its corrections drawn in once");
        assert!(float.layer().is_some(), "{at}: the source is kept as the layer");
    }
}

/// Pixels that are clearly red (the left half of [`picture`]): what Delete cropped areas takes away.
fn reds(img: &RgbaImage) -> usize {
    img.pixels().filter(|p| p.0[3] > 0 && i32::from(p.0[0]) > i32::from(p.0[2]) + 60).count()
}

struct Op {
    name: &'static str,
    run: fn(&mut Session),
    /// The source keeps Word's HD Photo original.
    keeps_hd: bool,
    crop: [f32; 4],
    /// What stays true of the source and the settings after the next correction and a Word file.
    effect: fn(&RgbaImage, &PictureAdjust) -> Result<(), String>,
}

fn ok(cond: bool, why: impl Fn() -> String) -> Result<(), String> {
    if cond { Ok(()) } else { Err(why()) }
}

const CROPPED: [f32; 4] = [0.0, 0.1, 0.0, 0.0];

fn ops() -> Vec<Op> {
    vec![
        Op {
            name: "crop, then Compress Pictures with Delete cropped areas",
            run: |s| {
                s.run("picture.crop", &json!({"left": 0.5, "top": 0.1})).unwrap();
                assert_eq!(s.run("picture.compress", &json!({"deleteCropped": true})).unwrap()["compressed"], 1);
            },
            keeps_hd: false,
            crop: [0.0; 4],
            // The right half, less the top tenth: 32 × 29 px, and none of the red half.
            effect: |src, _| ok(src.dimensions() == (32, 29) && reds(src) == 0, || format!("{:?}, {} red", src.dimensions(), reds(src))),
        },
        Op {
            name: "Compress Pictures at 48 ppi",
            run: |s| assert_eq!(s.run("picture.compress", &json!({"ppi": 48})).unwrap()["compressed"], 1),
            keeps_hd: true,
            crop: CROPPED,
            // 48 pt drawn at 48 ppi: 32 px wide.
            effect: |src, _| ok(src.width() == 32, || format!("{:?}", src.dimensions())),
        },
        Op {
            name: "Compress Pictures to 32 px (the original form)",
            run: |s| drop(s.run("picture.compress", &json!({"maxPixels": 32})).unwrap()),
            keeps_hd: true,
            crop: CROPPED,
            effect: |src, _| ok(src.dimensions() == (32, 16), || format!("{:?}", src.dimensions())),
        },
        Op {
            name: "Remove Background",
            run: |s| drop(s.run("picture.removeBackground", &json!({})).unwrap()),
            keeps_hd: false,
            crop: CROPPED,
            effect: |src, _| ok(src.get_pixel(0, 0).0[3] == 0 && src.get_pixel(20, 16).0[3] == 255, || format!("{:?}", src.get_pixel(0, 0))),
        },
        Op {
            name: "Recolor",
            run: |s| drop(s.run("picture.color", &json!({"mode": "grayscale"})).unwrap()),
            keeps_hd: true,
            crop: CROPPED,
            effect: |src, a| ok(a.recolor == Some(Recolor::Grayscale) && src.dimensions() == (64, 32), || format!("{a:?}")),
        },
        Op {
            name: "Artistic Effects",
            run: |s| drop(s.run("picture.effects", &json!({"effect": "blur"})).unwrap()),
            keeps_hd: true,
            crop: CROPPED,
            effect: |_, a| ok(a.artistic.as_ref().map(|e: &Artistic| e.effect.as_str()) == Some("Blur"), || format!("{a:?}")),
        },
        Op {
            name: "Picture Styles",
            run: |s| drop(s.run("picture.style", &json!({"style": "thickFrame"})).unwrap()),
            keeps_hd: false,
            crop: CROPPED,
            // A frame round the picture, its dark edge outermost.
            effect: |src, _| ok(src.width() > 64 && src.get_pixel(0, 0).0 == [40, 40, 40, 255], || format!("{:?} {:?}", src.dimensions(), src.get_pixel(0, 0))),
        },
        Op {
            name: "Picture Border",
            run: |s| drop(s.run("picture.border", &json!({"color": "00B050", "width": 3})).unwrap()),
            keeps_hd: false,
            crop: CROPPED,
            effect: |src, _| ok(src.dimensions() == (70, 38) && src.get_pixel(0, 0).0 == [0, 0xB0, 0x50, 255], || format!("{:?} {:?}", src.dimensions(), src.get_pixel(0, 0))),
        },
        Op {
            name: "Change Picture",
            run: |s| drop(s.run("picture.change", &json!({"data": base64_encode(&other())})).unwrap()),
            keeps_hd: false,
            crop: CROPPED,
            effect: |src, _| ok(*src == pixels(&other()), || format!("{:?}", src.dimensions())),
        },
        Op {
            name: "Reset Picture",
            run: |s| drop(s.run("picture.reset", &json!({})).unwrap()),
            keeps_hd: true,
            crop: [0.0; 4],
            effect: |src, a| ok(*src == pixels(&picture()) && a.recolor.is_none() && a.artistic.is_none(), || format!("{a:?}")),
        },
    ]
}

/// Each pixel operation between two corrections, then through a .docx save and reopen and a third correction: what the
/// operation did stays (the shown pixels, the crop, the source and the settings), and the reopened draft shows and corrects
/// the picture as the draft that was never saved does.
#[test]
fn every_pixel_operation_survives_the_next_correction_and_a_word_file() {
    for hd in [false, true] {
        for op in ops() {
            let at = |step: &str| format!("{} ({}), {step}", op.name, if hd { "over an HD Photo original" } else { "a plain picture" });
            let mut s = session(hd);
            s.run("picture.corrections", &json!({"brightness": 20})).unwrap();
            (op.run)(&mut s);
            s.run("picture.corrections", &json!({"brightness": 20, "contrast": -10})).unwrap();
            check_drawn(&s, &at("after the next correction"));
            let now = seen(&s);
            let (src, kept) = source_of(&s);
            assert_eq!(kept, hd && op.keeps_hd, "{}: Word's HD Photo original", at("after the next correction"));
            assert_eq!(now.crop, op.crop, "{}: the crop", at("after the next correction"));
            assert_eq!((now.adjust.brightness, now.adjust.contrast), (20.0, -10.0), "{}: {:?}", at("the settings"), now.adjust);
            if let Err(e) = (op.effect)(&src, &now.adjust) {
                panic!("{}: {e}", at("after the next correction"));
            }

            let mut back = reopen(&s);
            assert_eq!(seen(&back), now, "{}", at("through a Word file"));
            check_drawn(&back, &at("through a Word file"));
            for d in [&mut s, &mut back] {
                d.run("picture.corrections", &json!({"brightness": -15, "contrast": -10})).unwrap();
            }
            check_drawn(&back, &at("a correction after the Word file"));
            assert!(seen(&back).shown == seen(&s).shown, "{}: as the draft never saved shows it", at("a correction after the Word file"));
            let (src, _) = source_of(&back);
            if let Err(e) = (op.effect)(&src, &seen(&back).adjust) {
                panic!("{}: {e}", at("a correction after the Word file"));
            }
        }
    }
}

/// The reviewer's crop probe (engine-pictures-2): corrected, cropped, cropped areas deleted, corrected again. The cropped
/// part does not come back squeezed into the frame.
#[test]
fn deleted_cropped_areas_stay_deleted_after_the_next_correction() {
    let mut s = session(false);
    s.run("picture.corrections", &json!({"brightness": 20})).unwrap();
    s.run("picture.crop", &json!({"left": 0.5})).unwrap();
    s.run("picture.compress", &json!({"deleteCropped": true})).unwrap();
    s.run("picture.corrections", &json!({"brightness": 20, "contrast": -10})).unwrap();
    let shown = pixels(&seen(&s).shown);
    assert_eq!((shown.width(), reds(&shown), seen(&s).crop), (32, 0, [0.0; 4]));
}

/// engine-fixes-2-edit: after Delete cropped areas, the part kept is the picture's original, as in Word: Original Size gives
/// its own size (its pixels at 96 ppi, as Insert › Pictures sizes a picture) and Reset Picture shows it, not the picture
/// before the crop stretched to the kept part's frame.
#[test]
fn deleted_cropped_areas_leave_the_kept_part_as_the_original() {
    let mut s = session(false);
    s.run("picture.crop", &json!({"left": 0.5, "top": 0.1})).unwrap();
    s.run("picture.compress", &json!({"deleteCropped": true})).unwrap();
    s.run("picture.corrections", &json!({"brightness": 20})).unwrap();
    s.run("picture.size", &json!({"original": true})).unwrap();
    let (_, InlineObject::Image { w, h, .. }) = selected(&s).unwrap() else { panic!("a picture") };
    // The kept part is 32 × 29 px: 24 × 21.75 pt.
    assert_eq!((w, h), (24.0, 21.75), "Original Size");
    s.run("picture.reset", &json!({})).unwrap();
    let shown = pixels(&seen(&s).shown);
    assert_eq!((shown.dimensions(), reds(&shown), seen(&s).crop), ((32, 29), 0, [0.0; 4]), "Reset Picture");
}

/// The picture Word showed over an HD Photo original rides in the .docx beside the picture it was written with; a file whose
/// picture another program changed (Word draws its next change from the HD Photo) draws the next change over the picture it
/// shows instead. engine-fixes-2-edit: a changed picture of the same byte length counts as changed too.
#[test]
fn a_word_copy_comes_back_only_beside_the_picture_it_was_written_with() {
    let mut s = session(true);
    s.run("picture.corrections", &json!({"brightness": 20})).unwrap();
    let docx = crate::io::save_bytes("p.docx", &s.doc).unwrap();
    let copy = |docx: &[u8]| {
        let doc = ew_docx::read(docx).unwrap();
        let p = doc.body.iter().find_map(|b| b.as_para().filter(|p| !p.objects.is_empty())).unwrap();
        let InlineObject::Image { float, .. } = &p.objects[0] else { panic!("a picture") };
        float.word_copy().map(|w| (digest(&doc.media[&w.media]), w.adjust.clone()))
    };
    assert_eq!(copy(&docx), seen(&s).word_copy.map(|(b, a)| (digest(&b), a)), "kept");
    // `docx` with each part `f` changes: (name, bytes) → its new bytes.
    let rewrite = |f: &dyn Fn(&str, Vec<u8>) -> Vec<u8>| {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(&docx)).unwrap();
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for i in 0..z.len() {
            let mut part = z.by_index(i).unwrap();
            let name = part.name().to_string();
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut part, &mut bytes).unwrap();
            zw.start_file(name.as_str(), zip::write::SimpleFileOptions::default()).unwrap();
            std::io::Write::write_all(&mut zw, &f(&name, bytes)).unwrap();
        }
        zw.finish().unwrap().into_inner()
    };
    // The shown picture changed by another program to bytes of the same length.
    let shown = seen(&s).shown;
    let same_length = rewrite(&|_, mut bytes| {
        if bytes == shown {
            let last = bytes.len() - 1;
            bytes[last] ^= 0xff;
        }
        bytes
    });
    assert_eq!(copy(&same_length), None, "dropped for a changed picture of the same length");
    // Another picture's record, as after another program wrote the picture.
    let other = rewrite(&|name, bytes| {
        if name != "word/document.xml" {
            return bytes;
        }
        let xml = String::from_utf8(bytes).unwrap();
        let at = xml.find(" sha256=\"").unwrap() + 9;
        format!("{}{}{}", &xml[..at], "0".repeat(64), &xml[at + 64..]).into_bytes()
    });
    assert_eq!(copy(&other), None, "dropped for another picture's record");
}

/// engine-picture-writer: a picture pasted from another draft (`pasteFrom`, paste::adopt) brings what it is drawn from. Its
/// layer, Word copy and SVG copy named the other draft's keys, which this draft may use for other pictures: each lands under
/// this draft's key for the same bytes, as its own media does (adopt renamed only that before).
#[test]
fn a_picture_pasted_from_another_draft_keeps_what_it_is_drawn_from() {
    let mut from = session(true);
    from.run("picture.corrections", &json!({"brightness": 40})).unwrap();
    let was = seen(&from);
    assert!(was.layer.is_some() && was.word_copy.is_some(), "{was:?}");
    // Every key the other draft uses names other bytes here.
    let mut to = Session::new(Document::from_text("Another draft"));
    for (i, k) in from.doc.media.keys().enumerate() {
        let mut bytes = other();
        bytes.push(i as u8);
        to.doc.media.insert(k.clone(), std::sync::Arc::new(bytes));
    }
    let frag = crate::cmd::paste::adopt(&mut to, from.doc.clone());
    let mut got = None;
    for b in &frag.blocks {
        let mut b = b.clone();
        crate::cmd::paste::each_para(&mut b, 0, &mut |p| {
            got = got.take().or_else(|| p.objects.iter().find(|o| matches!(o, InlineObject::Image { .. })).map(|o| seen_in(&to.doc, o)));
        });
    }
    assert_eq!(got, Some(was));
}

/// engine-picture-writer: Group and Ungroup move a picture's placement, not what it is drawn from. Each copied whole frames,
/// which held the picture's settings and layer, so a grouped picture lost them, and a group took its first member's.
#[test]
fn group_and_ungroup_keep_what_a_picture_is_drawn_from() {
    let mut s = session(false);
    s.run("picture.corrections", &json!({"brightness": 40})).unwrap();
    s.run("picture.transparency", &json!({"percent": 30})).unwrap();
    s.run("arrange.wrap", &json!({"wrap": "square"})).unwrap();
    let was = seen(&s);
    s.run("select.collapse", &json!({"end": true})).unwrap();
    s.run("insert.shape", &json!({"kind": "rectangle", "width": 40, "height": 20})).unwrap();
    s.run("arrange.wrap", &json!({"wrap": "square"})).unwrap();
    s.run("select.addObject", &json!({"index": 0})).unwrap();
    s.run("arrange.group", &json!({})).unwrap();
    let picture = |s: &Session| {
        let mut out = Vec::new();
        s.doc.objects_in_reading_order(&mut |o| {
            let members = match o {
                InlineObject::Group { children, .. } => children.iter().map(|c| &c.obj).collect(),
                o => vec![o],
            };
            out.extend(members.into_iter().filter(|o| matches!(o, InlineObject::Image { .. })).map(|o| seen_in(&s.doc, o)));
        });
        out
    };
    assert_eq!(picture(&s), [was.clone()], "grouped");
    s.run("arrange.ungroup", &json!({})).unwrap();
    assert_eq!(picture(&s), [was], "ungrouped");
}

// ---------- the Word probe ----------

/// The Word probe of briefs/engine-pictures-3.md item 4. With `EW_PICTURE_PROBE` naming a folder that holds `original.png`
/// and `original.wdp` (the same picture as HD Photo), writes there pictures over that HD Photo original as Word's file has
/// them, with Word's brightness 40 drawn into the picture Word showed:
/// - hd-copy.docx: after an EasyWriter correction, with the picture Word showed beside it (`ew:wordCopy`, which Word must
///   ignore): Word shows the corrected picture;
/// - hd-cut.docx: its cropped areas deleted while the HD Photo original stays beside it uncropped (the choice not taken):
///   what Word shows of a file whose picture and original disagree;
/// - hd-word.docx: as Word wrote it.
///
/// `pdf.ps1` renders them in Word. Run with `--ignored`.
#[test]
#[ignore]
fn word_probe_of_hd_photo_pictures() {
    let Ok(dir) = std::env::var("EW_PICTURE_PROBE") else { return };
    let dir = std::path::Path::new(&dir);
    let png = std::fs::read(dir.join("original.png")).unwrap();
    let wdp = std::fs::read(dir.join("original.wdp")).unwrap();
    // Word's file: the picture it showed (the original with brightness 40) over the HD Photo original.
    let mut s = Session::new(Document::from_text("A picture over an HD Photo original: "));
    s.sel = crate::Selection::caret(s.doc.end_of(StoryRef::Body));
    s.run("insert.picture", &json!({"data": base64_encode(&png), "width": 240})).unwrap();
    s.run("picture.corrections", &json!({"brightness": 40})).unwrap();
    let wdp = s.doc.add_media(wdp, "wdp");
    let (pos, _) = selected(&s).unwrap();
    as_in_file(&mut s, &pos, |p| p.layer = Some(wdp.clone()));
    let word = reopen(&s);
    std::fs::write(dir.join("hd-word.docx"), crate::io::save_bytes("p.docx", &word.doc).unwrap()).unwrap();

    let mut copy = reopen(&s);
    copy.run("picture.corrections", &json!({"brightness": 40, "contrast": -40})).unwrap();
    let docx = crate::io::save_bytes("p.docx", &copy.doc).unwrap();
    let xml = std::io::read_to_string(zip::ZipArchive::new(std::io::Cursor::new(&docx)).unwrap().by_name("word/document.xml").unwrap()).unwrap();
    assert!(xml.contains("ew:wordCopy") && xml.contains("a14:imgLayer"), "{xml}");
    std::fs::write(dir.join("hd-copy.docx"), docx).unwrap();

    let mut cut = reopen(&s);
    let (pos, InlineObject::Image { media, .. }) = selected(&cut).unwrap() else { panic!("a picture") };
    let half = DynamicImage::ImageRgba8(pixels(&cut.doc.media[media.as_str()])).crop_imm(320, 0, 320, 240);
    let key = cut.doc.add_media(encode(&half), "png");
    as_in_file(&mut cut, &pos, |p| {
        p.media = key.clone();
        p.w = 120.0;
    });
    std::fs::write(dir.join("hd-cut.docx"), crate::io::save_bytes("p.docx", &cut.doc).unwrap()).unwrap();
}
