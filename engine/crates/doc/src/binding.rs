//! EasyWriter engine-gaps-rest: content controls bound to document properties (the XML Mapping pane's Insert Content Control and
//! Word's Quick Parts › Document Property): a control's `w:dataBinding` into the core properties part (ISO/IEC 29500-1
//! §17.5.2.6). The binding stays in the control's verbatim children ([`ContentControl::extra`]), as Word writes it, so a Word
//! file's bindings round-trip unchanged; this module reads which property it names and keeps the two in step.
//!
//! The six properties the document model keeps (File › Info's Title, Subject, Author, Keywords, Comments and Category) can be
//! bound. A control and its property agree after [`Document::sync_bindings`]: a control whose text differs from its property
//! was edited, so the property takes its text, and then every control bound to that property shows it.

use crate::control::{ContentControl, ControlRange};
use crate::{CoreProps, Document, StoryRef};

/// Word's store item id of the core properties part.
pub const CORE_STORE: &str = "{6C3C8BC8-F283-45AE-878A-BAB7291924A1}";
/// The namespaces Word's core property bindings map (dc as ns0, cp as ns1).
const CORE_PREFIXES: &str = "xmlns:ns0='http://purl.org/dc/elements/1.1/' xmlns:ns1='http://schemas.openxmlformats.org/package/2006/metadata/core-properties' ";

/// The core properties a control can be bound to: the element's name in the part and its namespace prefix in Word's xpath.
pub const BOUND_PROPERTIES: [(&str, &str); 6] =
    [("title", "ns0"), ("subject", "ns0"), ("creator", "ns0"), ("keywords", "ns1"), ("description", "ns0"), ("category", "ns1")];

/// The `w:dataBinding` element Word writes for core property `name` → its XML; `None` for a property that cannot be bound.
pub fn binding_xml(name: &str) -> Option<String> {
    let (el, ns) = BOUND_PROPERTIES.iter().find(|(el, _)| *el == name)?;
    Some(format!(r#"<w:dataBinding w:prefixMappings="{CORE_PREFIXES}" w:xpath="/ns1:coreProperties[1]/{ns}:{el}[1]" w:storeItemID="{CORE_STORE}"/>"#))
}

/// The value of attribute `name` in element XML `x` (either quote; `&apos;` and `&quot;` read back).
fn attr<'a>(x: &'a str, name: &str) -> Option<std::borrow::Cow<'a, str>> {
    let i = x.find(&format!("{name}="))? + name.len() + 1;
    let q = x.get(i..)?.chars().next()?;
    let rest = x.get(i + 1..)?;
    let v = rest.get(..rest.find(q)?)?;
    Some(if v.contains('&') { v.replace("&apos;", "'").replace("&quot;", "\"").replace("&amp;", "&").into() } else { v.into() })
}

impl ContentControl {
    /// The core property this control is bound to (its `w:dataBinding` into the core properties part), by element name.
    pub fn bound_property(&self) -> Option<&'static str> {
        let x = self.extra.iter().find(|x| x.starts_with("<w:dataBinding"))?;
        if !attr(x, "w:storeItemID").is_some_and(|id| id.eq_ignore_ascii_case(CORE_STORE)) {
            return None;
        }
        let xpath = attr(x, "w:xpath")?;
        let last = xpath.rsplit('/').next()?;
        let local = last.split('[').next()?.rsplit(':').next()?;
        BOUND_PROPERTIES.iter().map(|(el, _)| *el).find(|el| *el == local)
    }

    /// Binds the control to core property `name` as Word does, replacing a binding it had → whether `name` can be bound.
    pub fn bind_property(&mut self, name: &str) -> bool {
        let Some(x) = binding_xml(name) else { return false };
        self.extra.retain(|e| !e.starts_with("<w:dataBinding"));
        self.extra.insert(0, x);
        true
    }
}

/// Core property `name` of `c`, to change.
fn field_mut<'a>(c: &'a mut CoreProps, name: &str) -> Option<&'a mut String> {
    Some(match name {
        "title" => &mut c.title,
        "subject" => &mut c.subject,
        "creator" => &mut c.creator,
        "keywords" => &mut c.keywords,
        "description" => &mut c.description,
        "category" => &mut c.category,
        _ => return None,
    })
}

impl Document {
    /// Core property `name`'s value.
    pub fn core_value(&self, name: &str) -> Option<&str> {
        let c = &self.core;
        Some(match name {
            "title" => &c.title,
            "subject" => &c.subject,
            "creator" => &c.creator,
            "keywords" => &c.keywords,
            "description" => &c.description,
            "category" => &c.category,
            _ => return None,
        })
    }

    /// Sets core property `name`.
    pub fn set_core_value(&mut self, name: &str, v: &str) {
        if let Some(dst) = field_mut(&mut self.core, name) {
            *dst = v.to_string();
        }
    }

    /// Every bound control in every story, with the property it is bound to and the text it shows (empty while it shows its
    /// placeholder).
    pub fn bound_controls(&self) -> Vec<(ControlRange, &'static str, String)> {
        let stories = std::iter::once(StoryRef::Body).chain(self.parts.keys().map(|k| StoryRef::Part(*k)));
        let mut out = Vec::new();
        for story in stories {
            for r in self.control_ranges(story) {
                if let Some(name) = r.control.bound_property() {
                    let text = if r.control.showing_placeholder { String::new() } else { self.control_text(&r) };
                    out.push((r, name, text));
                }
            }
        }
        out
    }

    /// The properties as the document shows them: a bound control edited since its property was last set wins.
    pub fn effective_core(&self) -> CoreProps {
        let mut core = self.core.clone();
        let mut seen = Vec::new();
        for (_, name, text) in self.bound_controls() {
            if !seen.contains(&name) && self.core_value(name) != Some(text.as_str()) {
                seen.push(name);
                if let Some(dst) = field_mut(&mut core, name) {
                    *dst = text;
                }
            }
        }
        core
    }

    /// Brings bound controls and their properties into step: a control whose text differs from its property gives the
    /// property its text (the first such control of a property wins) → the bound controls that now show another text, last
    /// first, each with the text to show, for the caller to rewrite.
    pub fn sync_bindings(&mut self) -> Vec<(ControlRange, String)> {
        let bound = self.bound_controls();
        let mut taken: Vec<&str> = Vec::new();
        for (_, name, text) in &bound {
            if !taken.contains(name) && self.core_value(name) != Some(text.as_str()) {
                taken.push(name);
                self.set_core_value(name, text);
            }
        }
        let mut stale: Vec<(ControlRange, String)> = bound
            .into_iter()
            .filter_map(|(r, name, text)| self.core_value(name).filter(|v| *v != text).map(|v| (r, v.to_string())))
            .collect();
        stale.sort_by(|a, b| (b.0.start.story, &b.0.start.path, b.0.start.off).cmp(&(a.0.start.story, &a.0.start.path, a.0.start.off)));
        stale
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::ControlKind;

    #[test]
    fn binding_reads_words_xml() {
        let mut c = ContentControl::new(ControlKind::Text { multi_line: false });
        assert!(c.bind_property("keywords"));
        assert_eq!(c.bound_property(), Some("keywords"));
        assert!(c.extra[0].contains("/ns1:coreProperties[1]/ns1:keywords[1]"));
        // As the reader keeps Word's element (attribute order and quoting its own).
        c.extra = vec![r#"<w:dataBinding w:xpath="/ns1:coreProperties[1]/ns0:title[1]" w:storeItemID="{6c3c8bc8-f283-45ae-878a-bab7291924a1}" w:prefixMappings="xmlns:ns0=&apos;http://purl.org/dc/elements/1.1/&apos;"/>"#.into()];
        assert_eq!(c.bound_property(), Some("title"));
        c.extra = vec![r#"<w:dataBinding w:xpath="/root[1]/title[1]" w:storeItemID="{00000000-0000-0000-0000-000000000000}"/>"#.into()];
        assert_eq!(c.bound_property(), None, "a custom XML part is not the document's properties");
        assert!(!c.bind_property("company"));
    }
}
