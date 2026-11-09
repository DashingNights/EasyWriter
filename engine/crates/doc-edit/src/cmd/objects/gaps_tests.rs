//! engine-gaps-shapes (docs/plans/engine/stage2b.md): shape fills (picture, texture, pattern), patterned outlines, the
//! page's fill effects, the Layout dialog's float settings, Regroup, the text wrapping break, frames, Add Text and the
//! document's equation options, each through its command and back through a Word file where it is saved.

use super::select::all_objects;
use super::*;
use ew_doc::Path;
use ew_doc::fill::Fill;

/// A 4 by 2 PNG (the harness's sample picture).
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGM4YGAARwzIHAB5mgkBGtifxgAAAABJRU5ErkJggg==";

fn with_shape() -> Session {
    let mut s = Session::new(ew_doc::Document::new());
    s.run("document.setText", &json!({"text": "one two three four five six seven eight nine ten\nsecond\nthird"})).unwrap();
    s.sel = Selection::caret(s.doc.start_of(StoryRef::Body));
    s.run("insert.shape", &json!({"kind": "rectangle", "width": 100, "height": 60})).unwrap();
    s
}

fn shape_fill(s: &Session) -> Option<Fill> {
    match selected(s) {
        Some((_, InlineObject::Shape { fill, .. })) => fill,
        _ => None,
    }
}

fn round_trip(s: &Session) -> ew_doc::Document {
    ew_docx::read(&ew_docx::write(&s.doc).unwrap()).unwrap()
}

fn first_shape(d: &ew_doc::Document) -> InlineObject {
    let p = d.body.iter().find_map(|b| b.as_para().filter(|p| !p.objects.is_empty())).unwrap();
    p.objects[0].clone()
}

#[test]
fn picture_texture_and_pattern_fills_are_set_read_and_saved() {
    let mut s = with_shape();
    s.run("shape.fill", &json!({"picture": {"data": PNG, "tile": true}})).unwrap();
    let Some(Fill::Picture(p)) = shape_fill(&s) else { panic!("{:?}", shape_fill(&s)) };
    assert!(p.tile && p.size == [3.0, 1.5] && s.doc.media.contains_key(&p.media), "{p:?}");
    let got = s.run("object.get", &json!({})).unwrap();
    assert_eq!(got["shape"]["fill"]["picture"]["tile"], true, "{got}");
    // Saved as a texture fill and read back as one, the shape still a shape.
    let InlineObject::Shape { fill: Some(Fill::Picture(back)), .. } = first_shape(&round_trip(&s)) else { panic!("not a picture-filled shape") };
    assert!(back.tile);

    s.run("shape.fill", &json!({"pattern": {"preset": "dkDnDiag", "fg": "C00000", "bg": "FFFF00"}})).unwrap();
    let got = s.run("object.get", &json!({})).unwrap();
    assert_eq!(got["shape"]["fill"]["pattern"], json!({"preset": "dkDnDiag", "fg": "C00000", "bg": "FFFF00"}), "{got}");
    let InlineObject::Shape { fill: Some(Fill::Pattern(p)), .. } = first_shape(&round_trip(&s)) else { panic!("not a pattern fill") };
    assert_eq!((p.preset.as_str(), p.fg.hex(), p.bg.hex()), ("dkDnDiag", "C00000".to_string(), "FFFF00".to_string()));
    // Drawn as a pattern paint over the shape.
    let page = s.layout().pages[0].clone();
    let list = ew_doc_layout::display::page_list(&s.doc, &page, &Default::default());
    assert!(format!("{list:?}").contains("Pattern"), "the shape paints its pattern");
    assert!(s.run("shape.fill", &json!({"pattern": {"preset": "nope"}})).is_err());
}

#[test]
fn a_patterned_outline_is_set_and_saved() {
    let mut s = with_shape();
    s.run("shape.outline", &json!({"pattern": {"preset": "pct50", "fg": "0000FF", "bg": "FFFFFF"}, "width": 4})).unwrap();
    let got = s.run("object.get", &json!({})).unwrap();
    assert_eq!((got["shape"]["outline"]["pattern"]["preset"].clone(), got["shape"]["outline"]["color"].clone()), (json!("pct50"), json!("0000FF")), "{got}");
    let InlineObject::Shape { extra, stroke, .. } = first_shape(&round_trip(&s)) else { panic!() };
    assert!(matches!(extra.outline_fill, Some(Fill::Pattern(_))) && stroke.map(|c| c.hex()) == Some("0000FF".into()));
    // A plain colour replaces it.
    s.run("shape.outline", &json!({"color": "00FF00"})).unwrap();
    assert_eq!(s.run("object.get", &json!({})).unwrap()["shape"]["outline"]["pattern"], Value::Null);
}

#[test]
fn page_fill_effects_replace_the_colour_and_round_trip() {
    let mut s = Session::new(ew_doc::Document::new());
    s.run("design.pageColor", &json!({"color": "FF0000"})).unwrap();
    let grad = json!({"gradient": {"stops": [{"pos": 0, "color": "1B1F5E"}, {"pos": 50, "color": "7A2E8C"}, {"pos": 100, "color": "F07F3C"}], "type": "linear", "angle": 90}});
    s.run("design.pageFill", &grad).unwrap();
    assert_eq!(s.doc.settings.page_color, None);
    assert_eq!(s.run("design.pageFillInfo", &json!({})).unwrap()["gradient"]["stops"].as_array().map(Vec::len), Some(3));
    let back = round_trip(&s);
    let Some(Fill::Gradient(g)) = back.settings.page_fill else { panic!("{:?}", back.settings.page_fill) };
    assert_eq!(g.stops.len(), 3);

    s.run("design.pageFill", &json!({"pattern": {"preset": "ltUpDiag", "fg": "4472C4", "bg": "FFFFFF"}})).unwrap();
    let back = round_trip(&s);
    assert!(matches!(&back.settings.page_fill, Some(Fill::Pattern(p)) if p.preset == "ltUpDiag" && p.fg.hex() == "4472C4"), "{:?}", back.settings.page_fill);

    s.run("design.pageFill", &json!({"picture": {"data": PNG, "tile": true, "title": "papyrus"}})).unwrap();
    let info = s.run("design.pageFillInfo", &json!({})).unwrap();
    assert_eq!((info["picture"]["tile"].clone(), info["picture"]["title"].clone()), (json!(true), json!("papyrus")), "{info}");
    assert!(s.doc.settings.page_fill.is_none());
    // A plain colour replaces any fill effect.
    s.run("design.pageColor", &json!({"color": "00FF00"})).unwrap();
    assert_eq!(s.run("design.pageFillInfo", &json!({})).unwrap(), Value::Null);
}

#[test]
fn the_layout_dialogs_float_settings_apply_in_one_step() {
    let mut s = with_shape();
    s.run("arrange.wrap", &json!({"wrap": "square"})).unwrap();
    s.run(
        "arrange.float",
        &json!({"wrapText": "left", "dist": {"top": 6, "bottom": 12, "left": 18, "right": 18}, "h": {"rel": "page", "align": "right"},
            "v": {"rel": "margin", "offset": 72}, "layoutInCell": false}),
    )
    .unwrap();
    let o = s.run("object.get", &json!({})).unwrap();
    assert_eq!(o["wrapText"], "left");
    assert_eq!(o["position"], json!({"hRel": "page", "vRel": "margin", "x": 0.0, "y": 72.0, "hAlign": "right", "vAlign": null}), "{o}");
    assert_eq!(o["dist"], json!({"left": 18.0, "right": 18.0, "top": 6.0, "bottom": 12.0}));
    s.run("edit.undo", &json!({})).unwrap();
    assert_eq!(s.run("object.get", &json!({})).unwrap()["wrapText"], "bothSides", "one undo step");
    assert!(s.run("arrange.float", &json!({"h": {"rel": "nowhere"}})).is_err());
}

#[test]
fn regroup_puts_the_last_ungrouped_objects_together_again() {
    let mut s = Session::new(ew_doc::Document::new());
    s.run("document.setText", &json!({"text": "one\ntwo\nthree"})).unwrap();
    s.sel = Selection::caret(s.doc.start_of(StoryRef::Body));
    s.run("insert.shape", &json!({"kind": "rectangle", "width": 100, "height": 50})).unwrap();
    s.run("arrange.bounds", &json!({"page": 0, "x": 100, "y": 150})).unwrap();
    s.run("select.collapse", &json!({"end": true})).unwrap();
    s.run("insert.shape", &json!({"kind": "ellipse", "width": 60, "height": 40})).unwrap();
    s.run("arrange.bounds", &json!({"page": 0, "x": 300, "y": 200})).unwrap();
    assert!(s.run("arrange.regroup", &json!({})).is_err(), "nothing ungrouped yet");
    s.run("select.addObject", &json!({"index": 0})).unwrap();
    s.run("arrange.group", &json!({})).unwrap();
    s.run("arrange.ungroup", &json!({})).unwrap();
    // Select something else: Regroup still finds them.
    s.sel = Selection::caret(s.doc.start_of(StoryRef::Body));
    s.also_selected.clear();
    s.run("arrange.regroup", &json!({})).unwrap();
    let list = all_objects(&s);
    assert_eq!(list.len(), 1);
    assert!(matches!(&list[0].1, InlineObject::Group { float, .. } if float.regroup == 0));
}

#[test]
fn a_text_wrapping_break_starts_the_next_line_below_the_object() {
    let mut s = Session::new(ew_doc::Document::new());
    s.run("document.setText", &json!({"text": "Before the break after the break"})).unwrap();
    s.sel = Selection::caret(s.doc.start_of(StoryRef::Body));
    s.run("insert.shape", &json!({"kind": "rectangle", "width": 100, "height": 200})).unwrap();
    s.run("arrange.wrap", &json!({"wrap": "square"})).unwrap();
    // The caret after "Before the break".
    let at = Pos { story: StoryRef::Body, path: Path::top(0), off: OBJ_LEN + "Before the break".len() };
    s.sel = Selection::caret(at);
    s.run("layout.break", &json!({"kind": "textWrapping"})).unwrap();
    assert!(s.doc.plain_text(StoryRef::Body).contains(ew_doc::para::TEXT_WRAP_BREAK));
    let obj = s.layout().find_object(0, |_| true).unwrap();
    let lines = line_tops(&mut s);
    assert!(lines.len() >= 2 && lines[1] >= obj.rect.bottom() - 0.5, "the second line clears the shape: {lines:?} {:?}", obj.rect);
    // Saved as Word's break, read back as one.
    let back = round_trip(&s);
    assert!(back.para(StoryRef::Body, &Path::top(0)).unwrap().text.contains(ew_doc::para::TEXT_WRAP_BREAK));
}

const OBJ_LEN: usize = 3;

/// The tops of the first paragraph's lines on page 1.
fn line_tops(s: &mut Session) -> Vec<f32> {
    let layout = s.layout();
    let mut out = Vec::new();
    for item in &layout.pages[0].items {
        if let ew_doc_layout::Placed::Lines { y, para, l0, l1, story: StoryRef::Body, .. } = item {
            let base = para.lines.get(*l0).map_or(0.0, |l| l.top);
            out.extend(para.lines.get(*l0..*l1).unwrap_or_default().iter().map(|l| y + l.top - base));
        }
    }
    out
}

#[test]
fn insert_frame_and_convert_to_frame_make_framed_paragraphs() {
    let mut s = Session::new(ew_doc::Document::new());
    s.run("document.setText", &json!({"text": "framed\nnot framed"})).unwrap();
    s.sel = Selection::caret(s.doc.start_of(StoryRef::Body));
    s.run("insert.frame", &json!({})).unwrap();
    let p0 = s.doc.para(StoryRef::Body, &Path::top(0)).unwrap();
    assert!(p0.props.frame.as_ref().is_some_and(|f| f.wrap == "around"));
    assert!(s.doc.para(StoryRef::Body, &Path::top(1)).unwrap().props.frame.is_none());

    let mut s = Session::new(ew_doc::Document::new());
    s.run("document.setText", &json!({"text": "body"})).unwrap();
    s.sel = Selection::caret(s.doc.start_of(StoryRef::Body));
    s.run("insert.textBox", &json!({"text": "in the box", "width": 150, "height": 80})).unwrap();
    s.run("arrange.wrap", &json!({"wrap": "square"})).ok();
    s.run("shape.toFrame", &json!({})).unwrap();
    assert!(all_objects(&s).is_empty(), "the box goes");
    let framed = s.doc.para(StoryRef::Body, &Path::top(0)).unwrap();
    assert_eq!(framed.text, "in the box");
    let f = framed.props.frame.clone().unwrap();
    assert_eq!((f.w, f.h, f.h_anchor.as_str(), f.v_anchor.as_str()), (Some(150.0), Some(80.0), "page", "page"));
    // One undo step brings the box back.
    s.run("edit.undo", &json!({})).unwrap();
    assert_eq!(all_objects(&s).len(), 1);
}

#[test]
fn add_text_gives_a_shape_its_own_centred_text() {
    let mut s = with_shape();
    s.run("shape.addText", &json!({})).unwrap();
    let StoryRef::Part(id) = s.sel.focus.story else { panic!("the caret is not in the shape") };
    s.run("text.insert", &json!({"text": "Label"})).unwrap();
    assert_eq!(s.doc.plain_text(StoryRef::Part(id)).trim(), "Label");
    assert_eq!(s.doc.parts[&id].body.anchor, ew_doc::props::VAlign::Center);
    // Saved with its text; a rectangle holding text reads back as a text box (the reader's rule for `wps:txbx`).
    let InlineObject::Shape { story, .. } = first_shape(&round_trip(&s)) else { panic!() };
    assert!(story.is_some());
}

#[test]
fn equation_options_are_the_documents_and_saved() {
    let mut s = Session::new(ew_doc::Document::new());
    let d = s.run("equation.optionsInfo", &json!({})).unwrap();
    assert_eq!((d["mathFont"].clone(), d["naryLim"].clone(), d["defJc"].clone()), (json!("Cambria Math"), json!("undOvr"), json!("centerGroup")));
    s.run("equation.options", &json!({"smallFrac": true, "naryLim": "subSup", "defJc": "left", "lMargin": 18, "wrapRight": true})).unwrap();
    let back = round_trip(&s).settings.math.unwrap();
    assert!(back.small_frac && back.wrap_right && back.l_margin == 18.0);
    assert_eq!((back.nary_lim, back.def_jc), (ew_doc::math::LimLoc::SubSup, ew_doc::math::MathJc::Left));
    assert!(s.run("equation.options", &json!({"nope": 1})).is_err());
    s.run("edit.undo", &json!({})).unwrap();
    assert!(s.doc.settings.math.is_none(), "one undo step");
}
