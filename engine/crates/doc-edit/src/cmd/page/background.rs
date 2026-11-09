//! Draw › Format Background's rule and grid lines (stage 2 gap G13) and the custom watermark's size (G44), on the engine.

use serde_json::{Value, json};
use ew_doc::PageRule;

use crate::{CmdError, CmdResult, CommandSpec, Session, p};

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("design.formatBackground", "Format Background", "Draw › Edit", format_background)
            .params(r#"{"kind"?: "none|narrowRuled|collegeRuled|standardRuled|wideRuled|smallGrid|mediumGrid|largeGrid|veryLargeGrid", "full"?: bool (Apply to Full Page)} → {"kind", "full"}"#)
            .state(|s| (Value::Null, rule_state(s))),
    ]
}

/// The page's lines as the menu shows them: {kind ("none" without lines), full}.
fn rule_state(s: &Session) -> Value {
    let r = s.doc.settings.page_rule.as_ref();
    let kind = r.map(|r| r.kind.as_str()).filter(|k| !k.is_empty()).unwrap_or("none");
    json!({"kind": kind, "full": r.is_some_and(|r| r.full)})
}

/// A kind sets the lines (none takes them away); `full` keeps or turns Apply to Full Page, which Word remembers with no lines
/// for the next kind.
fn format_background(s: &mut Session, v: &Value) -> CmdResult {
    let mut r = s.doc.settings.page_rule.clone().unwrap_or_default();
    if let Some(k) = p::str(v, "kind") {
        r.kind = match k {
            "none" => String::new(),
            k if PageRule::KINDS.iter().any(|(x, _)| *x == k) => k.to_string(),
            k => return Err(CmdError::Params(format!("unknown kind `{k}`"))),
        };
    }
    if let Some(full) = p::bool(v, "full") {
        r.full = full;
    }
    // A settings change lays the pages out again (doc-layout's changed_parts), so the view repaints them.
    s.doc.settings.page_rule = (!r.kind.is_empty() || r.full).then_some(r);
    Ok(rule_state(s))
}

/// The box a text watermark of `size` points fills: the text's width in `font` at that size, one em high (Word's Size box; Auto
/// is no box, see [`ew_doc::Watermark::frame`]).
pub(crate) fn watermark_box(font: &str, text: &str, size: f32) -> [f32; 2] {
    let size = size.clamp(1.0, 1638.0);
    let face = ew_fonts::word::resolve(font, false, false).face;
    let shaped = ew_fonts::shape(&face, text, &[], |c| c);
    let em: f32 = shaped.iter().map(|g| g.x_advance as f32).sum::<f32>() / face.upem.max(1.0) as f32;
    [(em * size).clamp(1.0, 4000.0), size]
}
