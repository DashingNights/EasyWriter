use super::tagged::reread;
use super::{Arc, Container, Deserialize, Paragraph, Serialize, Table};
use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::de::value::MapAccessDeserializer;

/// A block in a story. (Blocks are always behind an `Arc`, so the size difference is fine.)
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Block {
    Para(Paragraph),
    Table(Table),
    Container(Container),
}

/// The variants' `kind` values, in the order an unknown one is reported.
const KINDS: &[&str] = &["para", "table", "container"];

/// Reads `kind` first and hands the rest of the map to the variant. Serde's derive for an internally tagged enum buffers the
/// whole block into its `Content` type and reads it again, which cost code size and open time (engine-size-3). A map whose keys
/// come in another order takes [`reread`].
impl<'de> Deserialize<'de> for Block {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        crate::tagged::read(d, BlockVisitor)
    }
}

struct BlockVisitor;

impl<'de> Visitor<'de> for BlockVisitor {
    type Value = Block;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a block")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Block, M::Error> {
        let first = map.next_key::<String>()?.ok_or_else(|| de::Error::missing_field("kind"))?;
        if first != "kind" {
            return reread(first, map, "kind");
        }
        let kind = map.next_value::<String>()?;
        match kind.as_str() {
            "para" => Paragraph::deserialize(MapAccessDeserializer::new(map)).map(Block::Para),
            "table" => Table::deserialize(MapAccessDeserializer::new(map)).map(Block::Table),
            "container" => Container::deserialize(MapAccessDeserializer::new(map)).map(Block::Container),
            other => Err(de::Error::unknown_variant(other, KINDS)),
        }
    }
}

impl Block {
    pub fn as_para(&self) -> Option<&Paragraph> {
        match self {
            Block::Para(p) => Some(p),
            Block::Table(_) | Block::Container(_) => None,
        }
    }
    pub fn as_table(&self) -> Option<&Table> {
        match self {
            Block::Table(t) => Some(t),
            Block::Para(_) | Block::Container(_) => None,
        }
    }
    pub fn as_container(&self) -> Option<&Container> {
        match self {
            Block::Container(c) => Some(c),
            Block::Para(_) | Block::Table(_) => None,
        }
    }

    /// The block list at `(r, c)` inside this block: a table's cell, a container's region (`c` is 0).
    pub fn list(&self, r: usize, c: usize) -> Option<&Blocks> {
        match self {
            Block::Para(_) => None,
            Block::Table(t) => t.rows.get(r)?.cells.get(c).map(|x| &x.blocks),
            Block::Container(x) => x.region(r),
        }
    }

    pub fn list_mut(&mut self, r: usize, c: usize) -> Option<&mut Blocks> {
        match self {
            Block::Para(_) => None,
            Block::Table(t) => Some(&mut t.rows.get_mut(r)?.cells.get_mut(c)?.blocks),
            Block::Container(x) => x.region_mut(r),
        }
    }

    /// Every block list directly inside, in document order, with the two path indexes that reach it. Empty for a paragraph.
    pub fn lists(&self) -> Vec<(u32, u32, &Blocks)> {
        match self {
            Block::Para(_) => Vec::new(),
            Block::Table(t) => {
                let mut out = Vec::new();
                for (r, row) in t.rows.iter().enumerate() {
                    for (c, cell) in row.cells.iter().enumerate() {
                        out.push((r as u32, c as u32, &cell.blocks));
                    }
                }
                out
            }
            Block::Container(x) => x.regions().into_iter().map(|(r, bl)| (r, 0, bl)).collect(),
        }
    }

    pub fn lists_mut(&mut self) -> Vec<&mut Blocks> {
        match self {
            Block::Para(_) => Vec::new(),
            Block::Table(t) => t.rows.iter_mut().flat_map(|r| r.cells.iter_mut()).map(|c| &mut c.blocks).collect(),
            Block::Container(x) => {
                if x.title.is_empty() {
                    vec![&mut x.blocks]
                } else {
                    vec![&mut x.title, &mut x.blocks]
                }
            }
        }
    }
}

pub type Blocks = Vec<Arc<Block>>;

/// Text boxes inside text boxes count (and show) this many levels deep.
pub const MAX_TEXT_BOX_DEPTH: usize = 4;

/// Bounds the work of expanding text boxes inside text boxes (layout, walks, saving), whatever a
/// document says: a box isn't expanded inside itself, nesting stops at [`MAX_TEXT_BOX_DEPTH`], and
/// an outermost box expands at most [`BoxBudget::MAX_NESTED`] boxes inside it. (A box whose
/// shapes all show that same box, or chains of boxes each showing the next many times, would
/// otherwise grow exponentially.) Outermost boxes aren't capped: their number is the document's
/// (or its pages', for headers), so the work stays linear and no box is left blank for budget.
#[derive(Debug, Default)]
pub struct BoxBudget {
    open: Vec<u32>,
    nested: usize,
    total: usize,
}

impl BoxBudget {
    /// Boxes expanded inside one outermost box.
    pub const MAX_NESTED: usize = 64;

    /// Start expanding text box story `id`; false if it mustn't be (pair a true with `leave`).
    pub fn enter(&mut self, id: u32) -> bool {
        if self.open.contains(&id) || self.open.len() >= MAX_TEXT_BOX_DEPTH {
            return false;
        }
        if self.open.is_empty() {
            self.nested = 0;
        } else if self.nested >= Self::MAX_NESTED {
            return false;
        } else {
            self.nested += 1;
        }
        self.total += 1;
        self.open.push(id);
        true
    }

    /// Done expanding the box last entered.
    pub fn leave(&mut self) {
        self.open.pop();
    }

    /// Whether a text box is being expanded now.
    pub fn inside(&self) -> bool {
        !self.open.is_empty()
    }

    /// Boxes expanded so far.
    pub fn total(&self) -> usize {
        self.total
    }
}
