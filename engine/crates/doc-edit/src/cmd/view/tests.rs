//! EasyWriter engine-gaps-views: Web Layout, Draft, Read Mode and Immersive Reader flow to the room `view.window` gives them,
//! and the Reader's Text Spacing and Syllables change only how the text is laid out on screen.
use super::*;
use ew_doc_layout::DocLayout;

fn doc() -> Session {
    let mut s = Session::new(ew_doc::Document::new());
    s.run("text.insert", &json!({"text": "Reading comfortably needs words with several syllables, separated generously. ".repeat(40)})).unwrap();
    s
}

fn run(s: &mut Session, id: &str, v: Value) -> Value {
    s.run(id, &v).unwrap_or_else(|e| panic!("{id}: {e}"))
}

/// The first page's lines of body text.
fn lines(l: &DocLayout) -> usize {
    l.pages[0].items.iter().map(|it| if let ew_doc_layout::Placed::Lines { l0, l1, .. } = it { l1 - l0 } else { 0 }).sum()
}

/// The page's text column with the continuous views' margins.
fn text_column(s: &Session) -> f32 {
    s.doc.sections()[0].1.text_width() + 2.0 * s.view.web_margin
}

#[test]
fn web_layout_and_draft_flow_to_the_window_they_are_given() {
    let mut s = doc();
    run(&mut s, "view.window", json!({"web": 900, "read": [300, 400]}));
    run(&mut s, "view.webLayout", json!({}));
    assert_eq!(s.layout().pages.len(), 1, "Web Layout has no page breaks");
    assert_eq!(s.layout().pages[0].w, 900.0);
    run(&mut s, "view.window", json!({"web": 600}));
    assert_eq!(s.layout().pages[0].w, 600.0, "a narrower window lays it out again");
    run(&mut s, "view.draft", json!({}));
    assert_eq!(s.layout().pages[0].w, text_column(&s), "Draft breaks lines as the printed page does");
    run(&mut s, "view.window", json!({"wrap": true}));
    assert_eq!(s.layout().pages[0].w, 600.0, "with wrap to window, Draft flows to the window");
    let st = s.registry.get("view.draft").unwrap().state.unwrap()(&s);
    assert_eq!(st.0, json!(true));
    for bad in [json!({"web": "wide"}), json!({"read": [300]}), json!({"reader": -1}), json!({"web": f64::NAN})] {
        assert!(s.run("view.window", &bad).is_err() || bad["web"].is_null(), "{bad}");
    }
}

#[test]
fn the_window_margin_is_the_room_round_the_text() {
    let mut s = doc();
    assert_eq!(s.view.web_margin, 18.0, "Word's Web Layout margin");
    run(&mut s, "view.webLayout", json!({}));
    run(&mut s, "view.window", json!({"margin": 40}));
    let w = s.layout().pages[0].w;
    let x = s.layout().pages[0].items.iter().find_map(|it| if let ew_doc_layout::Placed::Lines { x, .. } = it { Some(*x) } else { None });
    assert_eq!((x, w), (Some(40.0), 800.0), "the text starts a margin in, the page keeps the window's width");
    let r = run(&mut s, "view.window", json!({"margin": 500}));
    assert_eq!(r["margin"], json!(144.0), "a margin past two inches is clamped");
    assert!(s.run("view.window", &json!({"margin": "wide"})).is_err());
}

#[test]
fn a_post_opens_in_web_layout_and_wears_its_theme() {
    let mut d = ew_doc::Document::new();
    d.settings.profile = Some(ew_doc::post::PROFILE.into());
    let mut s = Session::new(d);
    assert_eq!((s.view.mode, s.view.read_mode), (ViewMode::Web, false), "a post opens as the forum shows it");
    assert_eq!(Session::new(ew_doc::Document::new()).view.mode, ViewMode::Print, "a document opens in Print Layout");
    let r = run(&mut s, "view.postTheme", json!({"light": true}));
    assert_eq!((r["light"].clone(), s.view.post_theme), (json!(true), true));
    run(&mut s, "view.postTheme", json!({}));
    assert!(!s.view.post_theme, "no value toggles it");
}

#[test]
fn read_mode_pages_to_the_screen_it_is_given() {
    let mut s = doc();
    run(&mut s, "view.readMode", json!({}));
    run(&mut s, "view.window", json!({"read": [260, 300]}));
    let l = s.layout();
    assert!(l.pages.len() > 1 && l.pages.iter().all(|p| p.w == 260.0 && p.h == 300.0), "{}", l.pages.len());
    run(&mut s, "view.readerSpacing", json!({"value": true}));
    assert!(s.layout().pages.len() > l.pages.len() * 3 / 2, "Read Mode's Text Spacing spaces the text out too");
    run(&mut s, "view.readPageColor", json!({"value": "sepia"}));
    let st = s.registry.get("view.readPageColor").unwrap().state.unwrap()(&s);
    assert_eq!(st.1, json!("sepia"));
}

#[test]
fn immersive_reader_is_a_column_with_its_own_text_options() {
    let mut s = doc();
    let original = s.doc.clone();
    run(&mut s, "view.window", json!({"web": 1200}));
    let r = run(&mut s, "view.immersiveReader", json!({}));
    assert_eq!(r["value"], json!(true));
    assert!(s.view.immersive && s.view.mode == ViewMode::Web);
    assert_eq!(s.layout().pages[0].w, text_column(&s), "Default keeps the page's text width");
    run(&mut s, "view.window", json!({"reader": 300}));
    let plain = s.layout();
    assert_eq!(plain.pages[0].w, 300.0);
    run(&mut s, "view.readerSpacing", json!({}));
    let spaced = s.layout();
    assert!(lines(&spaced) > lines(&plain) && spaced.pages[0].h > plain.pages[0].h * 1.5, "{} {}", lines(&plain), lines(&spaced));
    run(&mut s, "view.readerSpacing", json!({"value": false}));
    run(&mut s, "view.readerSyllables", json!({}));
    let split = s.layout();
    assert!(lines(&split) > lines(&plain), "the syllable dots take room: {} {}", lines(&plain), lines(&split));
    let st = s.registry.get("view.immersiveReader").unwrap().state.unwrap()(&s);
    assert_eq!(st, (json!(true), json!({"spacing": false, "syllables": true})));
    assert_eq!(s.doc, original, "the Reader leaves the document alone");
    run(&mut s, "view.webLayout", json!({}));
    assert!(!s.view.immersive, "another view ends the Reader");
    assert_eq!(s.layout().pages[0].w, 1200.0);
    run(&mut s, "view.immersiveReader", json!({"value": true}));
    run(&mut s, "view.immersiveReader", json!({"value": false}));
    assert!(!s.view.immersive && s.view.mode == ViewMode::Print);
    assert!(serde_json::to_value(&s.view).unwrap().get("immersive").is_none(), "screen only, never saved");
}
