//! EasyWriter: the engine's stored form of a document (docs/plans/engine/viewport-design.md section 10). The model's JSON
//! carries `"schema": "easywriter.document"` and an integer `"version"` at its root, so the engine checks bytes that arrive
//! without the draft record (clipboard, tests). WordCraft's form at commit 1be606de, which the canvas editor stored before this,
//! has neither and reads as version 0.
//!
//! The rule for a change to the stored form (docs/plans/engine/model.md, 'Schema versions'): a field or variant added, renamed or
//! dropped, or a new meaning for a value an older build already reads (a new character in a run's text), bumps
//! [`SCHEMA_VERSION`] and form.mjs `VERSION` in the same change, with its line in [`Document::upgrade`] and model.md's table.
//! An older build then refuses the newer record with the reason instead of reading it without the new field and dropping it
//! at its next save. One bump per change that lands on word-parity: packages built side by side each add their fields under
//! the version they found, and the merge settles them under one (engine-schema-settle did so for wave B). `#[serde(default)]`
//! for an added field and `alias` for a renamed one let the structs read the older form; a step that needs more runs before
//! the stamp in `upgrade` and raises [`READS_AS_IS_SINCE`]. A field the stored form never writes (`#[serde(skip)]`) needs no
//! bump. test/engine-schema.test.mjs reads the form from these types (scripts/schema-fields.mjs: every type the Document
//! reaches, each field and variant with the serde settings that change what is written) and fails on a change without a
//! bump, the version's `fields.txt` (test/fixtures/engine-models/) and its "N to N+1" line below; a branch whose types
//! changed since it left word-parity needs a version above word-parity's there. A new field still goes into a sample, so
//! the samples' bytes show it read and written.
use super::{Deserialize, Document};

/// The stored form's name at the model's root.
pub const SCHEMA: &str = "easywriter.document";
/// The version this build writes and the newest it reads.
pub const SCHEMA_VERSION: u32 = 17;
/// The oldest version these structs read with serde's defaults and aliases alone, with no step in [`Document::upgrade`] that
/// changes what was read. A part of a document stored apart from its record (the undo history beside it, history_file.rs) is
/// read by the structs without `upgrade`, so it opens from this version up. A step that rewrites the read document raises
/// this to that step's version.
pub const READS_AS_IS_SINCE: u32 = 0;

// The root fields are written from the constants, whatever a document read from older bytes holds: these structs are the
// current version's form, so a save is always that form (`save('engine')` needs no check of its own).
pub(crate) fn write_schema<S: serde::Serializer>(_: &str, s: S) -> std::result::Result<S::Ok, S::Error> {
    s.serialize_str(SCHEMA)
}

pub(crate) fn write_version<S: serde::Serializer>(_: &u32, s: S) -> std::result::Result<S::Ok, S::Error> {
    s.serialize_u32(SCHEMA_VERSION)
}

/// Why a model whose root says `schema` and `version` cannot open in this build. Its save would drop what this build cannot
/// read, so a newer model is refused, as form.mjs `unreadable` refuses a newer record.
fn refusal_of(schema: &str, version: u64) -> Option<String> {
    if !schema.is_empty() && schema != SCHEMA {
        return Some("it was saved in a form this version of EasyWriter does not know".into());
    }
    (version > u64::from(SCHEMA_VERSION)).then(|| "a newer version of EasyWriter saved it".into())
}

/// The reason stored-form `bytes` the structs could not read cannot open, when their root gives one (another kind of model, or
/// a newer version whose fields this build does not know); None leaves the reader's own error.
pub fn refusal(bytes: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct Root {
        #[serde(default)]
        schema: String,
        #[serde(default)]
        version: u64,
    }
    let root: Root = serde_json::from_slice(bytes).ok()?;
    refusal_of(&root.schema, root.version)
}

impl Document {
    /// Brings a document read from the stored form to [`SCHEMA_VERSION`], or the reason it cannot open.
    pub fn upgrade(&mut self) -> std::result::Result<(), String> {
        if let Some(why) = refusal_of(&self.schema, u64::from(self.schema_version)) {
            return Err(why);
        }
        // The steps, oldest first, go here. Every step so far only adds fields that read as absent, so none needs code
        // ([`READS_AS_IS_SINCE`] is 0).
        // 0 to 1 is a relabel: the same fields, now with the root fields.
        // 1 to 2 adds stable ids and boxes (`ids.rs`, `para::ObjectBox`): the session gives every document it opens its ids
        // (`Ids::fill`), whatever it came from.
        // 2 to 3 adds a revision's suggestion group (`Revision::tag`, docs/plans/engine/stage2b.md decision 4).
        // 3 to 4 adds the document's mail merge (`Settings::mail_merge`, `mail_merge.rs`) and, under the same number while
        // wave B's packages built side by side, picture and pattern fills (`Fill::Picture`, `Fill::Pattern`) and the page's fill
        // effect (`Settings::page_fill`).
        // 4 to 5 (engine-schema-settle) settles the rest of wave B, which builds stamped 4 without knowing it: a picture's outline
        // and effects (`Float::outline`, `Float::fx`, `ShapeEffects`' inner shadow, reflection, bevel and 3-D rotation), the
        // regroup number (`Float::regroup`), a style's aliases and Hide (`Style::aliases`, `Style::hidden_always`), number forms,
        // spacing, stylistic sets, contextual alternates and Fit Text (`CharProps`), the rest of the equation options
        // (`MathProps`), Draw's rule and grid lines (`Settings::page_rule`), form field shading (`Settings::no_form_shading`)
        // and the text wrapping break in a run's text (U+000B, `TEXT_WRAP_BREAK`). Records at 4 load here (what they lack reads
        // as absent), and a build at 4 refuses a record at 5 instead of saving it without these.
        // 5 to 6 (engine-tools-2) adds the drawing grid's origin and every-n lines (`Settings::grid_show`) and a freeform's
        // Edit Points paths, its points with curve handles and point types (`ShapeExtra::edit_paths`, `freeform::EditPath`);
        // under the same number, built side by side, engine-gaps-rest's picture watermark and the watermark's language
        // (`Watermark::picture`, `Watermark::lang`). All read as absent from older records.
        // 6 to 7 (engine-pictures-2) adds a picture's colour and corrections (`Float::adjust`, `adjust::PictureAdjust`), the
        // picture Word 2010's corrections were drawn from (`Float::layer`), the picture Word showed when that is HD Photo
        // (`Float::word_copy`, `adjust::WordCopy`) and an SVG picture's PNG copy (`Float::fallback`). All read as absent from
        // older records, and a build at 6 refuses a record at 7 instead of saving it without them.
        // 7 to 8 (engine-rename) changes no field: the .docx reader's bookkeeping keys in `passthrough` (ew-docx's package.rs)
        // start `easywriter:` instead of `wordcraft:`, and byte_store.rs reads the old ones under the new names, so this step
        // needs no code. A build at 7 refuses a record at 8 instead of missing those keys (and a .docx save's kept parts).
        // 8 to 9 (engine-fixes-2-layout) changes no field: a freeform's Edit Points paths (`freeform::EditPath`,
        // `EditNode`, `NodeKind`) derive their form instead of writing it by hand, so the field list sees them. Serde writes
        // a coordinate from 1e-6 to under 1e-5 or from 1e13 to under 1e16 in the other notation, as the same number, so
        // this step needs no code.
        // 9 to 10 (engine-style-separator) adds `CharProps::spec_vanish` (`w:specVanish`), which on a hidden paragraph mark makes it a
        // style separator. It reads as absent from older records, and a build at 9 refuses a record at 10 instead of saving it
        // without its separators.
        // 10 to 11 (engine-picture-writer) changes no field: a picture's media key and what its bitmap is drawn from have one
        // owner with private fields (`para::Media`, `para::PictureFloat`, flattening the placement `Float`), in the same keys
        // and order, so this step needs no code. The settings and sources are a picture's own now: one a shape, chart or group
        // carried in its `float` (Group took a picture's whole frame) is not read.
        // 11 to 12 (ph-vertical-1) adds two `TextDirection` variants, `rotate90` and `asian270`, and a `TextVert` one, `eaVert`
        // (Word's Vertical in a text box). No field moves: older records cannot hold the new names, and a build at 11 refuses a
        // record at 12 instead of saving it without them. The sample `vertical-11.json` holds all three.
        // 12 to 13 (ph-charts-2) adds `ChartSpec::look`, a chart's look as one JSON object in text (`chart.rs`), written into
        // its chart part as `ew:look`. It reads as absent from older records, where the chart looks as it did.
        // 13 to 14 (engine-container) adds the container block (`Block::Container`, container.rs).
        // 14 to 15 (post-schema) adds the post profile (`Settings::profile`, `post.rs`) and, under the same number, a media
        // object's file (`ObjectBox::file`). Both read as absent from older records, and a build at 14 refuses a record at 15
        // instead of saving it without them.
        // 15 to 16 (ph-smartart-1) adds `SmartArtSpec::rtl` and `SmartArtItem::look`. Both read as absent from older records.
        // 16 to 17 (post-write) adds `Container::indent`, a container's table indent: a list item's child carries its level's,
        // so the post writer can tell it from a block after the list. It reads as absent (zero) from older records.
        self.schema = SCHEMA.into();
        self.schema_version = SCHEMA_VERSION;
        Ok(())
    }

    /// The stored form: compact JSON, `serde_json::to_vec`'s bytes.
    pub fn to_json(&self) -> serde_json::Result<Vec<u8>> {
        let mut out = Vec::with_capacity(128);
        self.write_json(&mut out).map(|()| out)
    }

    /// The stored form appended to `out`, as `serde_json::to_writer` writes it.
    pub fn write_json(&self, out: &mut Vec<u8>) -> serde_json::Result<()> {
        serde_json::to_writer(out, self)
    }

    /// The styles, the numbering, the default tab stop and the footnote format as compact JSON: what the layout cache keys its
    /// paragraph environment on.
    pub fn format_json(&self) -> String {
        serde_json::to_string(&(&self.styles, &self.numbering, self.settings.default_tab, &self.settings.footnote_format)).unwrap_or_default()
    }
}

// The engine's crates write the model's compact JSON through `to_json`, `write_json`, `format_json` and `write_block`. A
// release build compiles a generic into every crate that calls it (rustc shares generics between crates in debug builds only),
// so each crate that called serde_json on the model held its own copy of the model's serialiser (engine-size-2,
// docs/plans/engine/bench.log).

/// A block's stored form appended to `out`, as `serde_json::to_writer` writes it.
pub fn write_block(out: &mut Vec<u8>, b: &super::Block) -> serde_json::Result<()> {
    serde_json::to_writer(out, b)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_root_fields_first_and_reads_wordcrafts_form_as_version_0() {
        let json = serde_json::to_string(&Document::from_text("x")).unwrap();
        assert!(json.starts_with(&format!(r#"{{"schema":"easywriter.document","version":{SCHEMA_VERSION},"body":"#)), "{}", &json[..80]);
        // WordCraft's form at 1be606de: no root fields.
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v.as_object_mut().unwrap().retain(|k, _| k != "schema" && k != "version");
        let mut doc: Document = serde_json::from_value(v).unwrap();
        assert_eq!((doc.schema.as_str(), doc.schema_version), ("", 0));
        doc.upgrade().unwrap();
        assert_eq!(doc, Document::from_text("x"));
    }

    #[test]
    fn refuses_a_newer_version_and_another_schema() {
        let mut doc = Document::from_text("x");
        doc.schema_version = SCHEMA_VERSION + 1;
        assert_eq!(doc.upgrade().unwrap_err(), "a newer version of EasyWriter saved it");
        let mut doc = Document::from_text("x");
        doc.schema = "easywriter.deck".into();
        assert!(doc.upgrade().unwrap_err().contains("does not know"));
        // Bytes the structs cannot read say why when their root does.
        let at = |v: u32| format!(r#"{{"schema":"easywriter.document","version":{v},"body":7}}"#);
        assert_eq!(refusal(at(SCHEMA_VERSION + 1).as_bytes()).unwrap(), "a newer version of EasyWriter saved it");
        assert_eq!(refusal(at(SCHEMA_VERSION).as_bytes()), None);
        assert_eq!(refusal(b"not json"), None);
    }
}
