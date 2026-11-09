//! EasyWriter engine-gaps-rest: File › Info › Version History's local versions on a canvas draft. The DOM editor rebuilds them
//! from its history file's timed steps; a canvas draft's undo history (saved beside its record, stage2b decision 3) holds each
//! step's document before it, so a version is that document, read back without touching the live one.
//!
//! ponytail: the engine's steps keep no time, so versions are named by the step that followed them, and runs of steps with the
//! same name (a stretch of typing) count as one; time stamps on steps would let them group into bursts as the DOM's do.

use serde_json::{Value, json};

use crate::cmd::insert::base64_encode;
use crate::{CmdError, CmdResult, Session, p};

/// The most versions listed: the oldest kept and the newest after it.
const MAX_LISTED: usize = 30;

/// The versions newest first: `k` is how many undo steps back each one is.
pub(super) fn list(s: &mut Session, _: &Value) -> CmdResult {
    let steps = s.history_steps(false);
    let n = steps.len();
    // Newest first: step i (oldest first) holds the document before it, k = n - i steps back; a run of steps with one name is
    // one version, before the run's first step.
    let mut groups: Vec<(usize, &str)> = Vec::new();
    for (i, (label, ..)) in steps.iter().enumerate().rev() {
        match groups.last_mut() {
            Some(g) if g.1 == *label => g.0 = n - i,
            _ => groups.push((n - i, label)),
        }
    }
    let base = groups.pop();
    let mut out: Vec<Value> = groups.into_iter().take(MAX_LISTED - 1).map(|(k, label)| json!({"k": k, "label": label})).collect();
    out.extend(base.map(|(k, label)| json!({"k": k, "label": label, "base": true})));
    Ok(json!({"versions": out}))
}

/// The document before the last `k` undo steps, as .docx and as the engine's own form (base64).
pub(super) fn version(s: &mut Session, v: &Value) -> CmdResult {
    let k = p::f32(v, "k").filter(|k| *k >= 1.0).map(|k| k as usize).ok_or_else(|| CmdError::Params("k: steps back, 1 or more".into()))?;
    let steps = s.history_steps(false);
    let doc = steps.len().checked_sub(k).and_then(|i| steps.get(i)).map(|(_, d, ..)| *d).ok_or_else(|| CmdError::Failed("no such version".into()))?;
    let docx = crate::io::save_bytes("document.docx", doc).map_err(CmdError::Failed)?;
    let engine = serde_json::to_vec(doc).map_err(|e| CmdError::Failed(e.to_string()))?;
    Ok(json!({"docx": base64_encode(&docx), "engine": base64_encode(&engine)}))
}

#[cfg(test)]
mod tests {
    use crate::Session;
    use serde_json::json;
    use ew_doc::{Document, StoryRef};

    #[test]
    fn local_versions_are_the_undo_steps_documents() {
        let mut s = Session::new(Document::from_text("One."));
        s.run("caret.docEnd", &json!({})).unwrap();
        s.run("text.insert", &json!({"text": " Two."})).unwrap();
        s.run("select.all", &json!({})).unwrap();
        s.run("format.bold", &json!({})).unwrap();
        let v = s.run("file.localVersions", &json!({})).unwrap();
        let list = v["versions"].as_array().unwrap().clone();
        assert_eq!(list.len(), 2, "{list:?}");
        assert_eq!(list[1]["base"], json!(true));
        let k = list[1]["k"].as_u64().unwrap();
        let got = s.run("file.localVersion", &json!({"k": k})).unwrap();
        let bytes = crate::cmd::insert::base64_decode(got["docx"].as_str().unwrap()).unwrap();
        let doc = ew_docx::read(&bytes).unwrap();
        assert_eq!(doc.plain_text(StoryRef::Body), "One.", "before the edits");
        assert_eq!(s.doc.plain_text(StoryRef::Body), "One. Two.", "the live document is untouched");
    }
}
