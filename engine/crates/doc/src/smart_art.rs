//! SmartArt graphics EasyWriter makes and edits (Insert › SmartArt): a layout, an outline of items
//! (text and level) and a colour variant.
//!
//! A SmartArt object ([`crate::graphic::Graphic`] with `smart_art` set) keeps this model next to
//! the items it is drawn with. EasyWriter lays it out with its own algorithms; the DOCX writer
//! saves it as diagram parts (data, layout, style, colours and the drawing of the shapes) and the
//! reader turns a diagram back into it only when its data part is exactly what EasyWriter writes.
//! SmartArt from other programs stays as it was read.
//!
//! Every value from outside (commands, files) goes through [`SmartArtSpec::sanitize`]: item
//! count, text length and levels are capped.

use serde::{Deserialize, Serialize};

use crate::props::Rgb;

/// Most items in a SmartArt graphic.
pub const MAX_ITEMS: usize = 100;
/// Longest item text, characters.
pub const MAX_TEXT: usize = 255;
/// Deepest item level (0 is the top).
pub const MAX_LEVEL: u8 = 7;
/// The presets a diagram shape can take: the ones the drawing reader draws (`ew_docx`'s read/diagram.rs).
pub const PRESETS: [&str; 24] = ["rect", "roundRect", "ellipse", "triangle", "rtTriangle", "diamond", "parallelogram", "trapezoid",
    "pentagon", "hexagon", "homePlate", "chevron", "rightArrow", "leftArrow", "upArrow", "downArrow", "leftRightArrow", "upDownArrow",
    "heart", "star4", "star5", "star6", "pie", "blockArc"];
/// An item's size against its laid-out size, percent.
pub const MIN_SCALE: u16 = 50;
pub const MAX_SCALE: u16 = 300;
/// The widest outline, hundredths of a point.
pub const MAX_LINE: u16 = 2000;

/// How a SmartArt graphic arranges its items.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SmartArtLayout {
    /// Blocks in rows.
    #[default]
    BasicList,
    /// Steps left to right with arrows between.
    Process,
    /// Steps around a circle with arrows between.
    Cycle,
    /// A tree: each item under the item one level up before it.
    Hierarchy,
    /// Stacked bands narrowing to the top.
    Pyramid,
    /// The first item in the middle, the items under it around it.
    Radial,
    /// Quadrants of a square.
    Matrix,
    /// Overlapping circles.
    Venn,
}

impl SmartArtLayout {
    pub const ALL: [SmartArtLayout; 8] = [
        SmartArtLayout::BasicList,
        SmartArtLayout::Process,
        SmartArtLayout::Cycle,
        SmartArtLayout::Hierarchy,
        SmartArtLayout::Pyramid,
        SmartArtLayout::Radial,
        SmartArtLayout::Matrix,
        SmartArtLayout::Venn,
    ];

    /// The id commands use (`basicList`, `process`…).
    pub fn id(self) -> &'static str {
        match self {
            SmartArtLayout::BasicList => "basicList",
            SmartArtLayout::Process => "process",
            SmartArtLayout::Cycle => "cycle",
            SmartArtLayout::Hierarchy => "hierarchy",
            SmartArtLayout::Pyramid => "pyramid",
            SmartArtLayout::Radial => "radial",
            SmartArtLayout::Matrix => "matrix",
            SmartArtLayout::Venn => "venn",
        }
    }

    /// The layout an id names (any ASCII case, ignoring hyphens, underscores and spaces;
    /// `list` is the basic list; `basic process` or `process` is process, etc.).
    pub fn from_id(id: &str) -> Option<SmartArtLayout> {
        let norm = id.chars().filter(|c| !c.is_whitespace() && *c != '-' && *c != '_').collect::<String>();
        if norm.eq_ignore_ascii_case("list") {
            return Some(SmartArtLayout::BasicList);
        }
        SmartArtLayout::ALL.into_iter().find(|l| l.id().eq_ignore_ascii_case(&norm) || l.label().replace(' ', "").eq_ignore_ascii_case(&norm))
    }

    /// The name shown for it.
    pub fn label(self) -> &'static str {
        match self {
            SmartArtLayout::BasicList => "Basic List",
            SmartArtLayout::Process => "Basic Process",
            SmartArtLayout::Cycle => "Basic Cycle",
            SmartArtLayout::Hierarchy => "Hierarchy",
            SmartArtLayout::Pyramid => "Basic Pyramid",
            SmartArtLayout::Radial => "Basic Radial",
            SmartArtLayout::Matrix => "Basic Matrix",
            SmartArtLayout::Venn => "Basic Venn",
        }
    }

    /// The gallery category it's shown under.
    pub fn category(self) -> &'static str {
        match self {
            SmartArtLayout::BasicList => "List",
            SmartArtLayout::Process => "Process",
            SmartArtLayout::Cycle => "Cycle",
            SmartArtLayout::Hierarchy => "Hierarchy",
            SmartArtLayout::Pyramid => "Pyramid",
            SmartArtLayout::Radial | SmartArtLayout::Venn => "Relationship",
            SmartArtLayout::Matrix => "Matrix",
        }
    }

    /// What it's for, in a sentence (the picker shows it).
    pub fn description(self) -> &'static str {
        match self {
            SmartArtLayout::BasicList => "Shows items of equal weight as blocks in rows.",
            SmartArtLayout::Process => "Shows steps in order, left to right, with arrows between them.",
            SmartArtLayout::Cycle => "Shows steps that repeat, around a circle.",
            SmartArtLayout::Hierarchy => "Shows a tree: each item below the item it belongs to.",
            SmartArtLayout::Pyramid => "Shows parts that build on each other, largest at the bottom.",
            SmartArtLayout::Radial => "Shows items around a central idea: the first item is the centre.",
            SmartArtLayout::Matrix => "Shows parts of a whole as quadrants.",
            SmartArtLayout::Venn => "Shows overlapping ideas as overlapping circles.",
        }
    }
}

/// The colours a SmartArt graphic takes from the document's theme.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SmartArtColors {
    /// Every shape in accent `n` (1–6).
    #[default]
    Accent1,
    Accent2,
    Accent3,
    Accent4,
    Accent5,
    Accent6,
    /// Shapes take the accents in turn.
    Colorful,
}

impl SmartArtColors {
    pub const ALL: [SmartArtColors; 7] = [
        SmartArtColors::Accent1,
        SmartArtColors::Accent2,
        SmartArtColors::Accent3,
        SmartArtColors::Accent4,
        SmartArtColors::Accent5,
        SmartArtColors::Accent6,
        SmartArtColors::Colorful,
    ];

    pub fn id(self) -> &'static str {
        match self {
            SmartArtColors::Accent1 => "accent1",
            SmartArtColors::Accent2 => "accent2",
            SmartArtColors::Accent3 => "accent3",
            SmartArtColors::Accent4 => "accent4",
            SmartArtColors::Accent5 => "accent5",
            SmartArtColors::Accent6 => "accent6",
            SmartArtColors::Colorful => "colorful",
        }
    }

    pub fn from_id(id: &str) -> Option<SmartArtColors> {
        let norm = id.chars().filter(|c| !c.is_whitespace() && *c != '-' && *c != '_').collect::<String>();
        SmartArtColors::ALL.into_iter().find(|c| c.id().eq_ignore_ascii_case(&norm) || c.label().replace(' ', "").eq_ignore_ascii_case(&norm))
    }

    /// The name shown for it.
    pub fn label(self) -> &'static str {
        match self {
            SmartArtColors::Accent1 => "Accent 1",
            SmartArtColors::Accent2 => "Accent 2",
            SmartArtColors::Accent3 => "Accent 3",
            SmartArtColors::Accent4 => "Accent 4",
            SmartArtColors::Accent5 => "Accent 5",
            SmartArtColors::Accent6 => "Accent 6",
            SmartArtColors::Colorful => "Colorful",
        }
    }

    /// The theme accent (1–6) of shape `i`.
    pub fn accent(self, i: usize) -> usize {
        match self {
            SmartArtColors::Accent1 => 1,
            SmartArtColors::Accent2 => 2,
            SmartArtColors::Accent3 => 3,
            SmartArtColors::Accent4 => 4,
            SmartArtColors::Accent5 => 5,
            SmartArtColors::Accent6 => 6,
            SmartArtColors::Colorful => i % 6 + 1,
        }
    }
}

/// An item's own look over what the layout and colours give it (the Format tab): fill, outline, text colour, preset and
/// size. Kept as its JSON text on the item ([`SmartArtItem::look`], the way a chart keeps its look), so the stored form needs
/// no serde code of its own; [`ItemLook::parse`] and [`ItemLook::text`] move between the two. Empty text keeps the layout's.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ItemLook {
    pub fill: Option<Rgb>,
    pub no_fill: bool,
    pub line: Option<Rgb>,
    pub no_line: bool,
    /// Hundredths of a point.
    pub line_width: Option<u16>,
    pub text_color: Option<Rgb>,
    /// One of [`PRESETS`].
    pub shape: Option<String>,
    /// Percent; 100 is the laid-out size.
    pub scale: Option<u16>,
}

impl ItemLook {
    /// `text` as the look it holds: the keys [`ItemLook::text`] writes, read here without serde's JSON reader (kilobytes of
    /// generic code for one struct). A colour is `RRGGBB`, `lineWidth` points; any other key is ignored.
    pub fn parse(text: &str) -> ItemLook {
        let mut l = ItemLook::default();
        for (k, v) in pairs(text) {
            match k {
                "fill" => l.fill = Rgb::parse(v),
                "line" => l.line = Rgb::parse(v),
                "textColor" => l.text_color = Rgb::parse(v),
                "noFill" => l.no_fill = v == "true",
                "noLine" => l.no_line = v == "true",
                "lineWidth" => l.line_width = v.parse::<f64>().ok().map(|p| whole(p * 100.0)),
                "shape" => l.shape = Some(v.to_string()),
                "scale" => l.scale = v.parse::<f64>().ok().map(whole),
                _ => {}
            }
        }
        l
    }

    /// The look as JSON text, only the keys it sets.
    pub fn text(&self) -> String {
        self.to_json().to_string()
    }

    /// The look as the object `object.get` hands the pane.
    pub fn to_json(&self) -> serde_json::Value {
        let mut m = serde_json::Map::new();
        if let Some(c) = self.fill {
            m.insert("fill".to_string(), c.hex().into());
        }
        if self.no_fill {
            m.insert("noFill".to_string(), true.into());
        }
        if let Some(c) = self.line {
            m.insert("line".to_string(), c.hex().into());
        }
        if self.no_line {
            m.insert("noLine".to_string(), true.into());
        }
        if let Some(w) = self.line_width {
            m.insert("lineWidth".to_string(), (f64::from(w) / 100.0).into());
        }
        if let Some(c) = self.text_color {
            m.insert("textColor".to_string(), c.hex().into());
        }
        if let Some(p) = &self.shape {
            m.insert("shape".to_string(), p.clone().into());
        }
        if let Some(k) = self.scale {
            m.insert("scale".to_string(), u64::from(k).into());
        }
        serde_json::Value::Object(m)
    }

    /// Whether it sets nothing (the layout's own look).
    pub fn is_empty(&self) -> bool {
        *self == ItemLook::default()
    }

    fn sanitize(&mut self) {
        self.scale = self.scale.map(|v| v.clamp(MIN_SCALE, MAX_SCALE)).filter(|v| *v != 100);
        self.line_width = self.line_width.map(|v| v.min(MAX_LINE));
        if self.shape.as_deref().is_some_and(|p| !PRESETS.contains(&p)) {
            self.shape = None;
        }
        if self.no_fill {
            self.fill = None;
        }
        if self.no_line {
            self.line = None;
        }
    }
}

/// The `"key":value` pairs of a look's text (its own small JSON object of strings, numbers and booleans), a string's quotes
/// off. Text that is not an object reads as no keys.
fn pairs(text: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let body = text.trim().trim_start_matches('{').trim_end_matches('}');
    for part in body.split(',') {
        if let Some((k, v)) = part.split_once(':') {
            out.push((k.trim().trim_matches('"'), v.trim().trim_matches('"')));
        }
    }
    out
}

/// A JSON number as a whole unsigned value, bounded.
fn whole(v: f64) -> u16 {
    let v = if v.is_finite() { v.round() } else { 0.0 };
    v.clamp(0.0, f64::from(u16::MAX)) as u16
}

/// One item of the outline: its text and level (0 is the top).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartArtItem {
    pub text: String,
    #[serde(default)]
    pub level: u8,
    /// [`ItemLook::text`]: the item's own look, absent for the layout's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub look: Option<String>,
}

impl SmartArtItem {
    pub fn new(text: impl Into<String>, level: u8) -> SmartArtItem {
        SmartArtItem { text: text.into(), level, look: None }
    }
}

/// A SmartArt graphic EasyWriter can edit.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartArtSpec {
    pub layout: SmartArtLayout,
    #[serde(default)]
    pub items: Vec<SmartArtItem>,
    #[serde(default)]
    pub colors: SmartArtColors,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub rtl: bool,
}

impl SmartArtSpec {
    /// A new graphic of `layout` with EasyWriter's sample items.
    pub fn sample(layout: SmartArtLayout) -> SmartArtSpec {
        let items: Vec<SmartArtItem> = match layout {
            SmartArtLayout::Hierarchy => vec![
                SmartArtItem::new("Lead", 0),
                SmartArtItem::new("Design", 1),
                SmartArtItem::new("Sketches", 2),
                SmartArtItem::new("Build", 1),
                SmartArtItem::new("Code", 2),
                SmartArtItem::new("Tests", 2),
            ],
            SmartArtLayout::Radial => {
                let mut v = vec![SmartArtItem::new("Goal", 0)];
                v.extend(["Plan", "Build", "Test", "Ship"].map(|t| SmartArtItem::new(t, 1)));
                v
            }
            SmartArtLayout::Process | SmartArtLayout::Cycle => ["Plan", "Build", "Test", "Ship"].map(|t| SmartArtItem::new(t, 0)).to_vec(),
            SmartArtLayout::Pyramid | SmartArtLayout::Venn => ["People", "Process", "Tools"].map(|t| SmartArtItem::new(t, 0)).to_vec(),
            SmartArtLayout::Matrix => ["Strengths", "Weaknesses", "Chances", "Risks"].map(|t| SmartArtItem::new(t, 0)).to_vec(),
            SmartArtLayout::BasicList => ["Ideas", "Notes", "Drafts", "Edits", "Final"].map(|t| SmartArtItem::new(t, 0)).to_vec(),
        };
        SmartArtSpec { layout, items, colors: SmartArtColors::default(), rtl: false }
    }

    /// Make the graphic safe to store and draw: at most [`MAX_ITEMS`] items, text cut to
    /// [`MAX_TEXT`] characters with control characters as spaces and the ends trimmed, and levels
    /// that follow on (the first item at level 0, each item at most one level below the one
    /// before it, never below [`MAX_LEVEL`]).
    pub fn sanitize(&mut self) {
        self.items.truncate(MAX_ITEMS);
        let mut prev: Option<u8> = None;
        for it in &mut self.items {
            it.text = clean_text(&it.text);
            let most = prev.map_or(0, |p| p.saturating_add(1)).min(MAX_LEVEL);
            it.level = it.level.min(most);
            prev = Some(it.level);
            if let Some(t) = it.look.take() {
                let mut l = ItemLook::parse(&t);
                l.sanitize();
                it.look = if l.is_empty() { None } else { Some(l.text()) };
            }
        }
    }

    /// The graphic after `sanitize`.
    pub fn sanitized(mut self) -> SmartArtSpec {
        self.sanitize();
        self
    }

    /// The index of the item each item belongs to (the nearest item before it one level up);
    /// `None` for the top-level items. Expects a sanitized graphic.
    pub fn parents(&self) -> Vec<Option<usize>> {
        let mut out = Vec::with_capacity(self.items.len());
        // The last item seen at each level.
        let mut last: Vec<usize> = Vec::new();
        for (i, it) in self.items.iter().enumerate() {
            let l = usize::from(it.level);
            last.truncate(l);
            out.push(if l == 0 { None } else { last.last().copied() });
            last.push(i);
        }
        out
    }

    /// The items that belong to item `i` (directly or deeper): the run after it at deeper levels.
    pub fn descendants(&self, i: usize) -> std::ops::Range<usize> {
        let Some(level) = self.items.get(i).map(|it| it.level) else { return 0..0 };
        let start = i + 1;
        let end = self.items.iter().skip(start).position(|it| it.level <= level).map_or(self.items.len(), |p| start + p);
        start..end
    }
}

/// `s` as item text: control characters as spaces, ends trimmed, at most [`MAX_TEXT`] characters.
pub fn clean_text(s: &str) -> String {
    let trimmed = s.trim_start_matches(|c: char| c.is_whitespace() || c.is_control());
    let s: String = trimmed.chars().take(MAX_TEXT).map(|c| if c.is_control() { ' ' } else { c }).collect();
    s.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_caps_items_text_and_levels() {
        let mut s = SmartArtSpec {
            items: (0..MAX_ITEMS + 20).map(|i| SmartArtItem::new(format!("{}\n{i}", "x".repeat(400)), if i == 0 { 5 } else { 200 })).collect(),
            ..Default::default()
        };
        s.sanitize();
        assert_eq!(s.items.len(), MAX_ITEMS);
        assert_eq!(s.items[0].level, 0, "the first item is at the top");
        assert_eq!(s.items[1].level, 1, "one level below the item before");
        assert!(s.items.iter().all(|it| it.level <= MAX_LEVEL));
        assert_eq!(s.items[0].text.chars().count(), MAX_TEXT);
        assert!(!s.items[0].text.contains('\n'));
    }

    #[test]
    fn parents_and_descendants_follow_levels() {
        let s = SmartArtSpec::sample(SmartArtLayout::Hierarchy).sanitized();
        assert_eq!(s.parents(), vec![None, Some(0), Some(1), Some(0), Some(3), Some(3)]);
        assert_eq!(s.descendants(0), 1..6);
        assert_eq!(s.descendants(1), 2..3);
        assert_eq!(s.descendants(5), 6..6);
        assert_eq!(s.descendants(99), 0..0);
        assert_eq!(SmartArtLayout::from_id("VENN"), Some(SmartArtLayout::Venn));
        assert_eq!(SmartArtLayout::from_id("basic-list"), Some(SmartArtLayout::BasicList));
        assert_eq!(SmartArtLayout::from_id("Basic Process"), Some(SmartArtLayout::Process));
        assert_eq!(SmartArtLayout::from_id("basic_cycle"), Some(SmartArtLayout::Cycle));
        assert_eq!(SmartArtLayout::from_id("list"), Some(SmartArtLayout::BasicList));
        assert_eq!(SmartArtColors::from_id("colorful"), Some(SmartArtColors::Colorful));
        assert_eq!(SmartArtColors::from_id("Accent 2"), Some(SmartArtColors::Accent2));
        assert_eq!(SmartArtColors::from_id("accent-4"), Some(SmartArtColors::Accent4));
        assert_eq!(clean_text(&format!("{}Valid Text", " ".repeat(1500))), "Valid Text");
    }
}
