//! EasyWriter: the part that carries EasyWriter's own objects through a Word file (docs/plans/engine/viewport-design.md section
//! 5.3). Word holds a smart canvas or a plan chart only as the drawing or picture drawn for it, so the object rides along in
//! docProps/easywriter.json (`STASH` in src/document/docx/export.mjs), keyed by that drawing's `wp:docPr` id, with a hash of
//! every other part: `{hash, nodes: {"<docPr id>": {type, attrs}}}`. The rule is import.mjs's: the objects come back only
//! while the hash matches, so a file Word (or anything else) has changed opens with Word's drawings. Each object becomes a box
//! on its drawing (`Float::box`, its kind the node's type and its data the node's attrs as JSON); writing does the reverse.
use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use sha2::{Digest, Sha256};
use ew_doc::para::ObjectBox;

use crate::package::Package;

/// The part's name.
pub(crate) const STASH: &str = "docProps/easywriter.json";
/// The node types import.mjs takes from it (anything else leaves the drawing a drawing).
const KINDS: [&str; 2] = ["canvas", "planChart"];

/// SHA-256 of a package's parts but STASH, in name order, each as its name, a NUL, its length in bytes, a NUL and its bytes
/// (export.mjs packageHash) → lowercase hex.
pub(crate) fn package_hash<'a>(parts: impl Iterator<Item = (&'a str, &'a [u8])>) -> String {
    let mut list: Vec<(&str, &[u8])> = parts.filter(|(n, _)| *n != STASH).collect();
    list.sort_by(|a, b| a.0.cmp(b.0));
    let mut h = Sha256::new();
    for (name, bytes) in list {
        h.update(format!("{name}\0{}\0", bytes.len()).as_bytes());
        h.update(bytes);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The objects of package `pkg` by drawing id, when its stash is there and every other part is as the stash's writer left it.
pub(crate) fn read(pkg: &Package) -> HashMap<u32, Arc<ObjectBox>> {
    let Some(v) = pkg.get(STASH).and_then(|b| serde_json::from_slice::<Value>(b).ok()) else { return HashMap::new() };
    let (Some(hash), Some(nodes)) = (v["hash"].as_str(), v["nodes"].as_object()) else { return HashMap::new() };
    if hash != package_hash(pkg.parts()) {
        return HashMap::new();
    }
    nodes
        .iter()
        .filter_map(|(id, n)| {
            let kind = n["type"].as_str().filter(|k| KINDS.contains(k))?;
            let data = n["attrs"].as_object().map(|a| Value::Object(a.clone()).to_string())?;
            Some((id.parse().ok().filter(|id| *id != 0)?, Arc::new(ObjectBox { kind: kind.into(), data, ..Default::default() })))
        })
        .collect()
}

/// The stash for `boxes` (drawing id → box, as written) over package `entries`, the part to add last, or None without boxes.
pub(crate) fn write(entries: &[(String, Vec<u8>)], boxes: &[(String, Arc<ObjectBox>)]) -> Option<(String, Vec<u8>)> {
    if boxes.is_empty() {
        return None;
    }
    let nodes: serde_json::Map<String, Value> = boxes
        .iter()
        .filter_map(|(id, b)| {
            let attrs = serde_json::from_str::<Value>(&b.data).ok().filter(Value::is_object)?;
            Some((id.clone(), serde_json::json!({"type": b.kind, "attrs": attrs})))
        })
        .collect();
    let hash = package_hash(entries.iter().map(|(n, b)| (n.as_str(), b.as_slice())));
    Some((STASH.into(), serde_json::json!({"hash": hash, "nodes": nodes}).to_string().into_bytes()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_hash_is_export_mjs_packagehash() {
        // packageHash([['b', 'yy'], ['a', 'x'], [STASH, '{}']]) in node.
        let parts = [("b", &b"yy"[..]), ("a", &b"x"[..]), (STASH, &b"{}"[..])];
        assert_eq!(package_hash(parts.into_iter()), "c797c321d9f898365c9beee448a9d3a043a09dcafc8afdac37e79b64e7fbecf2");
    }
}
