//! EasyWriter engine-compare-keep-3: the parts a chart, SmartArt diagram or OLE object read from a file refers to (its
//! `Embedded` markup's targets, kept in `Document::passthrough` with the manifest of their content types and own relationships),
//! brought from the revised document into the original when Compare meets the object, so every reference in the result
//! resolves. A part the original holds already under its name, with the same bytes and the same parts behind it, is shared;
//! any other part comes over, under a name of its own where the original uses its name.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use ew_doc::Document;
use ew_doc::graphic::Embedded;
use ew_doc::para::InlineObject;
use ew_docx::{EMBEDDED_PARTS, EmbeddedManifest};

/// The `Embedded` markup `o` holds (an OLE object's, a graphic's read from a file, its group members'), to repoint.
pub(in crate::cmd::tools) fn slots(o: &mut InlineObject) -> Vec<&mut Embedded> {
    match o {
        InlineObject::Image { ole: Some(e), .. } => vec![Arc::make_mut(e)],
        InlineObject::Graphic { graphic, .. } if graphic.source.is_some() => Arc::make_mut(graphic).source.as_mut().map(Arc::make_mut).into_iter().collect(),
        InlineObject::Group { children, .. } => children.iter_mut().flat_map(|c| slots(&mut c.obj)).collect(),
        _ => Vec::new(),
    }
}

/// The revised document's parts and what has been named in the original for them.
pub(in crate::cmd::tools) struct Parts {
    rev: BTreeMap<String, Arc<Vec<u8>>>,
    rev_manifest: EmbeddedManifest,
    manifest: EmbeddedManifest,
    /// Each revised part met → its name in the original.
    names: BTreeMap<String, String>,
    /// Names given that the original does not hold yet.
    used: BTreeSet<String>,
    /// Revised parts named but not copied yet.
    todo: Vec<String>,
    changed: bool,
}

impl Parts {
    pub(in crate::cmd::tools) fn new(orig: &Document, rev: BTreeMap<String, Arc<Vec<u8>>>) -> Parts {
        let manifest = |d: &BTreeMap<String, Arc<Vec<u8>>>| d.get(EMBEDDED_PARTS).map(|m| EmbeddedManifest::parse(m)).unwrap_or_default();
        let rev_manifest = manifest(&rev);
        Parts { manifest: manifest(&orig.passthrough), rev, rev_manifest, names: BTreeMap::new(), used: BTreeSet::new(), todo: Vec::new(), changed: false }
    }

    /// `e`'s targets made the original's names for them.
    pub(in crate::cmd::tools) fn repoint(&mut self, orig: &mut Document, e: &mut Embedded) {
        for r in e.refs.iter_mut().filter(|r| !r.external) {
            r.target = self.name(orig, &r.target);
        }
        self.copy(orig);
    }

    /// The original's name for revised part `name`, the part queued to come over unless the original shares it.
    fn name(&mut self, orig: &Document, name: &str) -> String {
        if let Some(n) = self.names.get(name) {
            return n.clone();
        }
        let taken = |n: &str| orig.passthrough.contains_key(n) || self.manifest.parts.contains_key(n) || self.used.contains(n);
        let new = if !taken(name) {
            name.to_string()
        } else if self.shared(orig, name) {
            self.names.insert(name.into(), name.into());
            return name.into();
        } else {
            let file = name.rfind('/').map_or(0, |i| i + 1);
            let (stem, ext) = name.rfind('.').filter(|i| *i > file).map_or((name, ""), |i| (name.get(..i).unwrap_or(name), name.get(i..).unwrap_or("")));
            (2u32..).map(|n| format!("{stem}_{n}{ext}")).find(|n| !taken(n)).unwrap_or_default()
        };
        self.used.insert(new.clone());
        self.names.insert(name.into(), new.clone());
        self.todo.push(name.into());
        new
    }

    /// Whether the original holds revised part `name` and every part behind it under the same names, as they are.
    fn shared(&self, orig: &Document, name: &str) -> bool {
        let mut todo = vec![name.to_string()];
        let mut seen = BTreeSet::new();
        while let Some(n) = todo.pop() {
            if !seen.insert(n.clone()) {
                continue;
            }
            let (Some(a), Some(b)) = (self.manifest.parts.get(&n), self.rev_manifest.parts.get(&n)) else { return false };
            let same_rels = a.rels.len() == b.rels.len()
                && a.rels.iter().zip(&b.rels).all(|(x, y)| (&x.id, &x.kind, &x.target, x.external) == (&y.id, &y.kind, &y.target, y.external));
            if orig.passthrough.get(&n) != self.rev.get(&n) || a.content_type != b.content_type || !same_rels {
                return false;
            }
            todo.extend(b.rels.iter().filter(|r| !r.external).map(|r| r.target.clone()));
        }
        true
    }

    /// The parts named so far copied into the original, each with its relationships pointing at the original's names.
    fn copy(&mut self, orig: &mut Document) {
        while let Some(name) = self.todo.pop() {
            let (Some(bytes), Some(part)) = (self.rev.get(&name).cloned(), self.rev_manifest.parts.get(&name).cloned()) else { continue };
            let mut part = part;
            for r in part.rels.iter_mut().filter(|r| !r.external) {
                r.target = self.name(orig, &r.target);
            }
            let new = self.names.get(&name).cloned().unwrap_or(name);
            orig.passthrough.insert(new.clone(), bytes);
            self.manifest.parts.insert(new, part);
            self.changed = true;
        }
    }

    /// The original's manifest written back, when parts came over.
    pub(in crate::cmd::tools) fn finish(self, orig: &mut Document) {
        if self.changed {
            orig.passthrough.insert(EMBEDDED_PARTS.into(), Arc::new(self.manifest.to_bytes()));
        }
    }
}
