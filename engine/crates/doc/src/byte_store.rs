//! How [`crate::Document::media`] and [`crate::Document::passthrough`] are written in the native
//! JSON form (`.json` files and crash-recovery copies): each part's bytes as one base64 string.
//! serde's default for bytes, an array of numbers, took about 3.6 times their size compact and
//! over six times pretty-printed (a 27 MB picture made a 99 MB recovery copy, #586).
//!
//! Reading takes either form, so `.json` files and recovery copies written before still open.
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use base64::Engine as _;
use base64::display::Base64Display;
use base64::engine::general_purpose::STANDARD;
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, Serializer};

type Store = BTreeMap<String, Arc<Vec<u8>>>;

/// One part's bytes, encoded as it is written out: no second copy of a large picture is made. A part named like a picture
/// goes out as a data URL (`data:image/png;base64,...`), so EasyWriter's draft store keeps each picture once beside the
/// record instead of inside every save (EasyWriter, docs/plans/engine/model.md).
struct Encoded<'a>(&'a str, &'a [u8]);

/// Extensions of the parts written as data URLs.
const PICTURES: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "emf", "wmf", "svg", "webp", "ico", "wdp", "jxr"];

fn picture_ext(name: &str) -> Option<String> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    PICTURES.contains(&ext.as_str()).then_some(ext)
}

impl Serialize for Encoded<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let b64 = Base64Display::new(self.1, &STANDARD);
        match picture_ext(self.0) {
            Some(ext) => s.collect_str(&format_args!("data:image/{ext};base64,{b64}")),
            None => s.collect_str(&b64),
        }
    }
}

/// A stored part, picture or kept-part key under its current name. The .docx reader's own bookkeeping keys (ew-docx's
/// package.rs) start `easywriter:`; records and undo histories written before the rename (schema 7 and older) hold them as
/// `wordcraft:`. Every stored place that names such a key reads it through here: the maps below and an undo step's list of
/// keys it lacks (doc-edit's history_file.rs).
pub fn current_key(name: String) -> String {
    match name.strip_prefix("wordcraft:") {
        Some(rest) => format!("easywriter:{rest}"),
        None => name,
    }
}

pub(crate) fn serialize<S: Serializer>(store: &Store, s: S) -> Result<S::Ok, S::Error> {
    s.collect_map(store.iter().map(|(name, bytes)| (name, Encoded(name, bytes))))
}

pub(crate) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Store, D::Error> {
    d.deserialize_map(StoreVisitor)
}

struct StoreVisitor;

impl<'de> Visitor<'de> for StoreVisitor {
    type Value = Store;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a map of part names to base64 text or byte arrays")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Store, A::Error> {
        let mut store = Store::new();
        while let Some((name, Bytes(bytes))) = map.next_entry::<String, Bytes>()? {
            store.insert(current_key(name), Arc::new(bytes));
        }
        Ok(store)
    }
}

/// A part's bytes as either form.
struct Bytes(Vec<u8>);

impl<'de> de::Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(BytesVisitor).map(Bytes)
    }
}

struct BytesVisitor;

impl<'de> Visitor<'de> for BytesVisitor {
    type Value = Vec<u8>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("base64 text or an array of bytes")
    }

    fn visit_str<E: de::Error>(self, text: &str) -> Result<Vec<u8>, E> {
        let text = match text.strip_prefix("data:") {
            Some(url) => url.split_once(";base64,").map_or(text, |(_, b64)| b64),
            None => text,
        };
        STANDARD.decode(text).map_err(|e| E::custom(format!("bytes are not valid base64: {e}")))
    }

    fn visit_bytes<E: de::Error>(self, bytes: &[u8]) -> Result<Vec<u8>, E> {
        Ok(bytes.to_vec())
    }

    /// The form written before: one number per byte.
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<u8>, A::Error> {
        // The length hint comes from the file: trust it only so far.
        let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(1 << 20));
        while let Some(b) = seq.next_element::<u8>()? {
            out.push(b);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug, Default)]
    struct Parts {
        #[serde(default, with = "super")]
        media: Store,
    }

    fn parts(entries: &[(&str, &[u8])]) -> Parts {
        Parts { media: entries.iter().map(|(n, b)| ((*n).to_string(), Arc::new(b.to_vec()))).collect() }
    }

    #[test]
    fn bytes_are_written_as_base64_and_read_back() {
        let all: Vec<u8> = (0..=255).collect();
        for n in [0, 1, 2, 3, 4, 255, 256] {
            let p = parts(&[("a.png", &all[..n.min(all.len())])]);
            let text = serde_json::to_string(&p).unwrap();
            assert_eq!(serde_json::from_str::<Parts>(&text).unwrap(), p, "{n}");
        }
        assert_eq!(serde_json::to_string(&parts(&[("m", b"Man"), ("ma", b"Ma")])).unwrap(), r#"{"media":{"m":"TWFu","ma":"TWE="}}"#);
    }

    #[test]
    fn pictures_are_written_as_data_urls_and_read_back() {
        let p = parts(&[("word/media/a.PNG", b"Man"), ("item.xml", b"Ma")]);
        let text = serde_json::to_string(&p).unwrap();
        assert_eq!(text, r#"{"media":{"item.xml":"TWE=","word/media/a.PNG":"data:image/png;base64,TWFu"}}"#);
        assert_eq!(serde_json::from_str::<Parts>(&text).unwrap(), p);
    }

    #[test]
    fn number_arrays_written_before_still_read() {
        let old = r#"{"media":{"a.png":[0,1,127,128,254,255],"empty":[]}}"#;
        assert_eq!(serde_json::from_str::<Parts>(old).unwrap(), parts(&[("a.png", &[0, 1, 127, 128, 254, 255]), ("empty", &[])]));
    }

    #[test]
    fn bookkeeping_keys_written_before_the_rename_read_under_their_new_names() {
        let old = r#"{"media":{"wordcraft:app.kept":"TWFu","item.xml":"TWE="}}"#;
        assert_eq!(serde_json::from_str::<Parts>(old).unwrap(), parts(&[("easywriter:app.kept", b"Man"), ("item.xml", b"Ma")]));
    }

    #[test]
    fn hostile_values_are_errors_not_panics() {
        for bad in [r#""T""#, r#""TWFu!""#, r#""-_""#, r#""TQ=x""#, "[256]", "[-1]", "[1.5]", "true", "{}", r#"["a"]"#] {
            let text = format!(r#"{{"media":{{"a.png":{bad}}}}}"#);
            assert!(serde_json::from_str::<Parts>(&text).is_err(), "{bad}");
        }
        assert!(serde_json::from_str::<Parts>(r#"{"media":"x"}"#).is_err());
    }
}
