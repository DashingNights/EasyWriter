//! Review tab: comments, track changes, word count, spelling (via the proofing hook).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};
use ew_doc::para::InlineObject;
use ew_doc::{Comment, Paragraph, PartKind, Pos, StoryRef, para_block};

use super::{fmt_revisions, now_iso, pos_json, sel_result};
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

mod changes;
mod comments;
mod proofing;

pub use changes::{
    DELETION_TEXT_CHARS, DeletionBalloon, deletion_balloons, format_changes, has_deletions, has_format_changes, move_changes, tracking_json,
};
use changes::{list_changes, nav_change, resolve_all_then, resolve_by, resolve_sel_then, tracking_options};
use comments::{
    comment_at_caret, comments_change, delete_comment, edit_comment, list_comments, nav_comment, new_comment, reply, validate_comment_id,
};
pub use comments::{comment_list, comment_range_at_caret};
use proofing::{all_issues, issue_at, next_issue, suggestions, word_count};

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("review.newComment", "New Comment", "Review › Comments", new_comment).key(super::mac_or("Mod+Alt+A / Mod+Alt+M", "Mod+Alt+M")).params(r#"{"text"?: string, "paras"?: [[{"text", "b"?, "i"?, "u"?, "s"?}]] (formatted text, one list of runs per paragraph)}"#),
        CommandSpec::new("review.reply", "Reply", "Review › Comments", reply)
            .params(r#"{"id": non-negative JSON integer, "text"?: string, "paras"?: as review.newComment's}"#)
            .when(comments_change),
        CommandSpec::new("review.editComment", "Edit Comment", "Review › Comments", edit_comment)
            .params(r#"{"id": non-negative JSON integer, "text"?: string, "paras"?: as review.newComment's}"#)
            .when(comments_change),
        CommandSpec::new("review.deleteComment", "Delete", "Review › Comments", delete_comment)
            .params(r#"{"id"?: non-negative JSON integer (omit to use the caret), "all"?: bool}"#),
        CommandSpec::new("review.resolveComment", "Resolve", "Review › Comments", |s, v| {
            validate_comment_id(v)?;
            let id = p::u64(v, "id").map(|x| x as u32).or_else(|| comment_at_caret(s)).ok_or_else(|| CmdError::Params("`id` required".into()))?;
            let c = s.doc.comments.get_mut(&id).ok_or_else(|| CmdError::Params("no such comment".into()))?;
            c.resolved = p::bool(v, "value").unwrap_or(!c.resolved);
            sel_result(s)
        })
        .params(r#"{"id"?: non-negative JSON integer (omit to use the caret), "value"?: bool (omit to toggle)}"#),
        CommandSpec::new("review.nextComment", "Next", "Review › Comments", |s, _| nav_comment(s, 1)).pure(),
        CommandSpec::new("review.previousComment", "Previous", "Review › Comments", |s, _| nav_comment(s, -1)).pure(),
        CommandSpec::new("review.comments", "Show Comments", "Review › Comments", list_comments).pure(),
        // Whether any tracked change or comment is left, for the commands that act on them. Cheap, for every change: every
        // tracked change names an entry of the revision list and Accept All and Reject All empty it, so an empty list means no
        // change; a list that outlived its changes (one change resolved at a time) says one may be left.
        CommandSpec::new("review.counts", "Review Counts", "Review", |s, _| {
            Ok(json!({"changes": !s.doc.revisions.is_empty(), "comments": s.doc.comments.len()}))
        })
        .params(r#"{} → {"changes": bool (a tracked change may be left: Accept All and Reject All empty the list), "comments": n}"#)
        .pure(),
        CommandSpec::new("review.trackChanges", "Track Changes", "Review › Tracking", |s, v| {
            s.doc.settings.track_changes = p::bool(v, "value").unwrap_or(!s.doc.settings.track_changes);
            Ok(json!({"value": s.doc.settings.track_changes}))
        })
        .params(r#"{"value"?: bool (omit to toggle)}"#)
        .key("Mod+Shift+E")
        // The value says whether Lock Tracking holds it on (Restrict Editing's tracked changes mode).
        .state(|s| (json!(s.doc.settings.track_changes), if s.doc.settings.protection.as_deref() == Some("trackedChanges") { json!("locked") } else { Value::Null })),
        CommandSpec::new("review.acceptAll", "Accept All Changes", "Review › Changes", |s, v| resolve_all_then(s, v, true))
            .params(r#"{"shown"?: bool (only the kinds Track Changes Options shows), "stopTracking"?: bool (also turn Track Changes off)}"#),
        CommandSpec::new("review.rejectAll", "Reject All Changes", "Review › Changes", |s, v| resolve_all_then(s, v, false))
            .params(r#"{"shown"?: bool (only the kinds Track Changes Options shows), "stopTracking"?: bool (also turn Track Changes off)}"#),
        CommandSpec::new("review.accept", "Accept", "Review › Changes", |s, v| resolve_sel_then(s, v, true))
            .params(r#"{"next"?: bool (then select the next change)}"#),
        CommandSpec::new("review.reject", "Reject", "Review › Changes", |s, v| resolve_sel_then(s, v, false))
            .params(r#"{"next"?: bool (then select the next change)}"#),
        // EasyWriter (docs/plans/engine/stage2b.md decision 4): the suggestion cards' Accept and Reject, which leave the caret.
        CommandSpec::new("review.resolve", "Accept or Reject Changes", "Review › Changes", resolve_by).params(
            r#"{"accept": bool, "revs": [n] (review.changes `rev`: those revisions wherever they are) | "start": Pos, "end": Pos | "para": id, "from"?: n, "to"?: n, "toPara"?: id (UTF-16 offsets), "keep"?: true (with accept and revs: they stay tracked changes and leave their suggestion group)} → the selection, which stays where it was"#,
        ),
        CommandSpec::new("review.nextChange", "Next Change", "Review › Changes", |s, _| nav_change(s, 1)).pure(),
        CommandSpec::new("review.previousChange", "Previous Change", "Review › Changes", |s, _| nav_change(s, -1)).pure(),
        CommandSpec::new("review.markup", "Display for Review", "Review › Tracking", |s, v| {
            use crate::view::ReviewDisplay;
            let d = match p::str(v, "value") {
                Some(m) => serde_json::from_value(json!(m))
                    .map_err(|_| CmdError::Params("`value`: simpleMarkup, allMarkup, noMarkup or original".into()))?,
                None if s.view.show_markup => ReviewDisplay::NoMarkup,
                None => ReviewDisplay::AllMarkup,
            };
            s.view.display_for_review = d;
            s.view.show_markup = d == ReviewDisplay::AllMarkup;
            // Without markup, deletions leave the layout (Original: insertions do).
            s.relayout();
            Ok(json!({"showMarkup": s.view.show_markup, "value": d}))
        })
        .state(|s| (Value::Null, json!(s.view.display_for_review)))
        .pure(),
        CommandSpec::new("review.trackingOptions", "Track Changes Options", "Review › Tracking", tracking_options)
            .params(
                r#"{"comments"?: bool, "ink"?: bool, "insertionsDeletions"?: bool, "formatting"?: bool, "balloons"?: "revisions|inline|commentsAndFormatting", "commentDisplay"?: "margin|selected", "insertMark"?: "underline|doubleUnderline|bold|italic|strikethrough|colorOnly|none", "insertColor"?: "byAuthor" | "RRGGBB", "deleteMark"?: "strikethrough|doubleStrikethrough|hidden|caret|hash|underline|doubleUnderline|bold|italic|colorOnly|none", "deleteColor"?: "byAuthor" | "RRGGBB", "changedLines"?: "outside|left|right|none", "changedLinesColor"?: "auto" | "RRGGBB", "trackFormatting"?: bool, "moveFromMark"?: (as deleteMark; none = plain text, no colour), "moveFromColor"?: "byAuthor" | "RRGGBB", "moveToMark"?: (as insertMark; none = plain text, no colour), "moveToColor"?: "byAuthor" | "RRGGBB", "trackMoves"?: bool (the document's setting; off = a cut and paste is a deletion and an insertion, not a move), "people"?: [reviewer name] | null (Show Markup › Specific People: the reviewers whose changes show; null shows everyone)} → the options (omit all to read them)"#,
            )
            .pure(),
        CommandSpec::new("review.wordCount", "Word Count", "Review › Proofing", word_count)
            .params(r#"{"includeTextBoxes"?: bool}"#)
            // ⌘⇧G is Find Previous on macOS.
            .key(super::non_mac("Mod+Shift+G"))
            .pure(),
        CommandSpec::new("review.changes", "Reviewing Pane", "Review › Tracking", list_changes)
            .params(r#"{} → [{kind, start, end, text, author, date, rev (review.resolve takes it), tag? (an assistant's suggestion group), description?, props?, move?}] in the body, in document order"#)
            .pure(),
        // EasyWriter (stage2.md G43): what the margin column beside the page shows besides the comment cards, as Track Changes
        // Options' balloons say; the cards are drawn by the app (comments/CanvasCards.jsx) at each anchor.
        CommandSpec::new("review.balloons", "Revision Balloons", "Review › Tracking", balloons)
            .params(r#"{} → [{"kind": "delete|format|moveFrom|moveTo", "at": Pos, "author", "text"? (delete: the deleted text; format: the change in words), "props"? (format: the properties set)}] in document order; empty when no balloon shows"#)
            .pure(),
        CommandSpec::new("review.spelling", "Spelling & Grammar", "Review › Proofing", next_issue)
            .key(super::mac_or("F7 / Alt+F7 / Mod+Alt+L", "F7 / Alt+F7"))
            .pure(),
        CommandSpec::new("review.issues", "Proofing Issues", "Review › Proofing", all_issues)
            .pure()
            .params(r#"{"kind"?: "grammar"} (grammar issues only)"#),
        CommandSpec::new("review.suggestions", "Spelling Suggestions", "Review › Proofing", suggestions).params(r#"{"pos"?: Pos}"#).pure(),
        CommandSpec::new("review.addToDictionary", "Add to Dictionary", "Review › Proofing", |s, v| {
            let w = match p::str(v, "word") {
                Some(w) => w.to_string(),
                None => issue_at(s, &s.sel.focus.clone())
                    .map(|(a, b, _)| s.doc.para_at(&a).and_then(|p| p.text.get(a.off..b.off).map(str::to_string)).unwrap_or_default())
                    .unwrap_or_default(),
            };
            if w.is_empty() {
                return Err(CmdError::Params("no word".into()));
            }
            // The same rule as loading the dictionary file, so a word added is never dropped later.
            if ew_proof::custom_word(&w).is_none() {
                let max = ew_proof::MAX_CUSTOM_WORD_CHARS;
                return Err(CmdError::Params(format!("{w:?} isn't a single word of at most {max} characters")));
            }
            ew_proof::add_word(w.trim());
            s.persist_user_dictionary(&[]);
            s.relayout();
            Ok(json!({"added": w}))
        })
        .params(r#"{"word"?: string}"#)
        .pure(),
        CommandSpec::new("review.ignoreAll", "Ignore All", "Review › Proofing", |s, v| {
            let w = match p::str(v, "word") {
                Some(w) => w.to_string(),
                None => issue_at(s, &s.sel.focus.clone())
                    .map(|(a, b, _)| s.doc.para_at(&a).and_then(|p| p.text.get(a.off..b.off).map(str::to_string)).unwrap_or_default())
                    .unwrap_or_default(),
            };
            // For this session only, as in Word: not added to (or saved with) the dictionary.
            if !w.trim().is_empty() {
                ew_proof::ignore_word(w.trim());
            }
            s.relayout();
            Ok(json!({"ignored": w}))
        })
        .pure(),
        CommandSpec::new("review.applySuggestion", "Change", "Review › Proofing", |s, v| {
            let text = p::req_str(v, "text")?.to_string();
            let at = s.sel.focus.clone();
            if let Some((a, b, _)) = issue_at(s, &at) {
                s.sel = Selection { anchor: a, focus: b };
            }
            super::type_text(s, &text)?;
            sel_result(s)
        })
        .params(r#"{"text": string}"#),
        CommandSpec::new("review.proofing", "Check Spelling as You Type", "File › Options › Proofing", |s, v| {
            s.view.proofing = p::bool(v, "value").unwrap_or(!s.view.proofing);
            s.prefs.check_spelling = s.view.proofing;
            Ok(json!({"value": s.view.proofing}))
        })
        .pure(),
    ]
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod gaps_tests;

/// `review.balloons`: the revision balloons the margin shows, of the reviewers Specific People shows. Deletions and moves
/// only with Show Revisions in Balloons (they then leave the text), formatting with that or Show Only Formatting.
// ponytail: walks every change (`changes`) on each read, about 10 ms native on the Word fixture, once typing pauses; keep the
// list per revision if that shows in a long session.
fn balloons(s: &mut Session, _: &Value) -> CmdResult {
    use ew_doc_layout::display::BalloonMode;
    let m = &s.prefs.markup;
    // Every tracked change names an entry of the revision list, so an empty list means no balloon (read after each edit).
    if !s.balloons_shown() || s.doc.revisions.is_empty() {
        return Ok(json!([]));
    }
    let shown = |author: &str| m.people.as_ref().is_none_or(|p| p.iter().any(|n| n == author));
    let mut out: Vec<(Pos, Value)> = Vec::new();
    if m.formatting {
        for (at, author, props) in format_changes(s).into_iter().filter(|c| shown(&c.1)) {
            let v = json!({"kind": "format", "at": pos_json(&at), "author": author, "text": fmt_revisions::describe(&props), "props": props});
            out.push((at, v));
        }
    }
    if m.balloons == BalloonMode::Revisions && m.insertions_deletions {
        for d in deletion_balloons(s).into_iter().filter(|d| shown(&d.author)) {
            out.push((d.at.clone(), json!({"kind": "delete", "at": pos_json(&d.at), "author": d.author, "text": d.text})));
        }
        for (at, author, from) in move_changes(s).into_iter().filter(|c| shown(&c.1)) {
            let v = json!({"kind": if from { "moveFrom" } else { "moveTo" }, "at": pos_json(&at), "author": author});
            out.push((at, v));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(Value::Array(out.into_iter().map(|(_, v)| v).collect()))
}
