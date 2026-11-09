//! engine-gaps-views (docs/plans/engine/stage2b.md): Read Mode's and Immersive Reader's page colour is how the tiles paint. The
//! surfaces report it as their paper, it shows only in those views, and a change of it repaints every surface.
//!   cargo test -p ew-wasm --test views
use ew::Engine;
use serde_json::Value;

fn paper(e: &mut Engine) -> String {
    let s: Value = serde_json::from_str(&e.surfaces()).expect("surfaces");
    s["list"][0]["paper"].as_str().expect("paper").to_string()
}

/// The layout event a change left, as JSON, or Null.
fn event(e: &mut Engine) -> Value {
    e.take_layout().map_or(Value::Null, |s| serde_json::from_str(&s).expect("event"))
}

#[test]
fn the_reading_page_colour_paints_the_paper_and_repaints_every_surface() {
    let mut e = Engine::new();
    e.insert_text("Reading text in a column.");
    event(&mut e);
    e.exec("view.readPageColor", r#"{"value": "sepia"}"#);
    assert_eq!(paper(&mut e), "#ffffff", "Print Layout keeps its own paper");
    e.exec("view.immersiveReader", r#"{"value": true}"#);
    event(&mut e);
    assert_eq!(paper(&mut e), "#e2d9d0", "the Reader shows sepia paper");
    e.exec("view.readPageColor", r#"{"value": "inverse"}"#);
    let ev = event(&mut e);
    assert_eq!((ev["from"].as_u64(), ev["to"].as_u64()), (Some(0), ev["count"].as_u64()), "every surface repaints: {ev}");
    assert_eq!(paper(&mut e), "#333333", "Inverse is Switch Modes' dark page");
    assert!(event(&mut e).is_null(), "nothing more to repaint");
    e.exec("view.immersiveReader", r#"{"value": false}"#);
    assert_eq!(paper(&mut e), "#ffffff");
}
