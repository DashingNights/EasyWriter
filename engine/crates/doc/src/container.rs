//! EasyWriter: a block that holds blocks — a quote, a code block or a titled box (docs/plans/engine/stage3-forum.md,
//! docs/plans/word/briefs/engine-container.md). It draws and lays out as a throwaway one-column table ([`Container::frame`]);
//! that table never reaches the model, the stored form or a command.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::props::{Align, CellProps, ParaProps, RowProps, TableLook, TableProps, VMerge};
use crate::table::{Cell, Row};
use crate::{Block, Blocks, DocError, Document, Id, Paragraph, Path, Result, StoryRef, Table, para_block};

/// What a container is. A new use adds a variant here and its rules in doc-edit's cmd/container.rs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContainerRole {
    Quote,
    Code,
    Box,
}

impl ContainerRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ContainerRole::Quote => "quote",
            ContainerRole::Code => "code",
            ContainerRole::Box => "box",
        }
    }

    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "quote" => Some(ContainerRole::Quote),
            "code" => Some(ContainerRole::Code),
            "box" => Some(ContainerRole::Box),
            _ => None,
        }
    }
}

/// A block holding blocks: a quote, code block or titled box. `frame` is how it lays out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    #[serde(default, skip_serializing_if = "crate::Id::is_unset")]
    pub id: Id,
    /// Not `kind`: `Block` is tagged `kind`, so the field would collide with the tag.
    pub role: ContainerRole,
    /// Id of the table style that draws it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    /// A code block's language, as the source named it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Points below it.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub space_after: f32,
    /// Points to the right of it, as its table's indent: a quote, code block or box inside a list item carries its level's
    /// indent, which tells the post writer it is part of the item (docs/plans/engine/stage3-forum.md section 3, A3).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub indent: f32,
    /// One paragraph, or empty for no title.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub title: Blocks,
    pub blocks: Blocks,
}

fn is_zero(v: &f32) -> bool {
    *v == 0.0
}

/// What a container's Word description starts with, so [`Container::from_word_table`] knows the table again.
const WORD_PREFIX: &str = "easywriter-container ";

impl Container {
    pub fn new(role: ContainerRole, blocks: Blocks) -> Container {
        Container { id: Id(0), role, style: None, language: None, space_after: 0.0, indent: 0.0, title: Blocks::new(), blocks }
    }

    /// The block lists with their region index: title first when there is one.
    pub fn regions(&self) -> Vec<(u32, &Blocks)> {
        if self.title.is_empty() { vec![(0, &self.blocks)] } else { vec![(0, &self.title), (1, &self.blocks)] }
    }

    pub fn region(&self, r: usize) -> Option<&Blocks> {
        if self.title.is_empty() {
            (r == 0).then_some(&self.blocks)
        } else {
            [&self.title, &self.blocks].get(r).copied()
        }
    }

    pub fn region_mut(&mut self, r: usize) -> Option<&mut Blocks> {
        if self.title.is_empty() {
            (r == 0).then_some(&mut self.blocks)
        } else {
            [&mut self.title, &mut self.blocks].into_iter().nth(r)
        }
    }

    pub fn is_title(&self, r: usize) -> bool {
        r == 0 && !self.title.is_empty()
    }

    /// The one-column table this container lays out as (see `table_flow::place_container` and `boxes::layout_box`).
    pub fn frame(&self, width: f32) -> Table {
        let titled = !self.title.is_empty();
        let mut rows = Vec::with_capacity(usize::from(titled) + 1);
        let cell = |blocks: &Blocks, hide_mark: bool| Cell {
            props: CellProps { span: 1, width: Some(width), hide_mark, ..CellProps::default() },
            blocks: blocks.clone(),
            controls: Default::default(),
        };
        if titled {
            rows.push(Row {
                props: RowProps { header: true, ..RowProps::default() },
                cells: vec![cell(&self.title, false)],
                controls: Default::default(),
            });
        }
        // The paragraph a nested block needs after it takes no room (a post's `blockquote > :last-child` margin rule).
        let hide_mark = self.blocks.len() >= 2
            && self.blocks.last().is_some_and(|b| b.as_para().is_some_and(crate::Paragraph::is_empty))
            && self.blocks.get(self.blocks.len() - 2).is_some_and(|b| b.as_para().is_none());
        rows.push(Row { props: RowProps::default(), cells: vec![cell(&self.blocks, hide_mark)], controls: Default::default() });
        Table {
            id: self.id,
            props: TableProps {
                style: self.style.clone(),
                width_pct: Some(100.0),
                fixed: true,
                align: Some(Align::Center),
                indent: (self.indent != 0.0).then_some(self.indent),
                // Set outright: `TableLook::default` turns on the first column and banding.
                look: TableLook { header_row: titled, ..no_look() },
                ..TableProps::default()
            },
            grid: vec![width],
            rows,
            controls: Default::default(),
        }
    }

    /// The table this container is saved to .docx as: Word has no such block, so it gets a real one-column table with a line
    /// in its description that [`Container::from_word_table`] reads back.
    pub fn to_word_table(&self, width: f32) -> Table {
        let mut t = self.frame(width);
        t.props.fixed = false;
        t.props.align = None;
        for row in &mut t.rows {
            for cell in &mut row.cells {
                cell.props.width_pct = Some(100.0);
            }
        }
        let language = self.language.as_deref().unwrap_or("");
        t.props.caption = Some(match self.role {
            ContainerRole::Quote => "Quote",
            ContainerRole::Code => "Code",
            ContainerRole::Box => "Box",
        }
        .to_string());
        t.props.description = Some(format!("{WORD_PREFIX}{} {} {language}", self.role.as_str(), self.space_after));
        t
    }

    /// The container a table read from .docx holds, or the table back when it is a plain table.
    pub fn from_word_table(t: Table) -> std::result::Result<Container, Table> {
        let Some(rest) = t.props.description.as_deref().and_then(|d| d.strip_prefix(WORD_PREFIX)) else { return Err(t) };
        let mut words = rest.split_whitespace();
        let Some(role) = words.next().and_then(ContainerRole::from_name) else { return Err(t) };
        let space_after = words.next().and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
        let indent = t.props.indent.unwrap_or(0.0);
        let language = {
            let l = words.collect::<Vec<_>>().join(" ");
            (!l.is_empty()).then_some(l)
        };
        let one_cell = (1..=2).contains(&t.rows.len())
            && t.rows.iter().all(|r| r.cells.len() == 1 && r.controls.is_empty() && r.cells[0].controls.is_empty() && r.cells[0].props.vmerge == VMerge::None);
        if t.grid.len() != 1 || !one_cell || !t.controls.is_empty() {
            return Err(t);
        }
        let mut rows: Vec<Blocks> = t.rows.iter().map(|r| r.cells[0].blocks.clone()).collect();
        let mut title = Blocks::new();
        if rows.len() == 2 {
            let mut first = rows.remove(0);
            first.truncate(1);
            if !first.first().is_some_and(|b| b.as_para().is_some()) {
                return Err(t);
            }
            title = first;
        }
        Ok(Container { id: Id(0), role, style: t.props.style, language, space_after, indent, title, blocks: rows.pop().unwrap_or_default() })
    }
}

impl Document {
    /// Moves blocks `first..=last` of the list `at` names into `c` (their region is the body), in place. Returns the
    /// container's path.
    pub fn wrap_blocks(&mut self, story: StoryRef, at: &Path, last: usize, c: Container) -> Result<Path> {
        let first = at.last();
        let bad = || DocError::BadPath(at.to_string());
        let bl = self.container_mut(story, at)?;
        if first > last || last >= bl.len() {
            return Err(bad());
        }
        if c.role == ContainerRole::Code && bl[first..=last].iter().any(|b| b.as_para().is_none()) {
            return Err(DocError::Invalid("a code block holds one paragraph per line".into()));
        }
        // `Document::sections` reads only top-level paragraphs: a break moved in would vanish from the layout.
        if bl[first..=last].iter().any(|b| has_section(b)) {
            return Err(DocError::Invalid("A section break cannot go in a quote, a code block or a box".into()));
        }
        let mut c = c;
        c.blocks = bl.drain(first..=last).collect();
        bl.insert(first, Arc::new(Block::Container(c)));
        if bl.last().is_some_and(|b| b.as_para().is_none()) {
            bl.push(para_block(Paragraph::new()));
        }
        Ok(at.clone())
    }

    /// Replaces the container at `path` with its title and body. Returns the first block's path.
    pub fn unwrap_container(&mut self, story: StoryRef, path: &Path) -> Result<Path> {
        let c = self.block(story, path).and_then(Block::as_container).cloned().ok_or_else(|| DocError::BadPath(path.to_string()))?;
        let mut blocks: Vec<Block> = c.title.iter().chain(&c.blocks).map(|b| (**b).clone()).collect();
        // The title's and a code block's line properties belong to the container they came from.
        if !c.title.is_empty()
            && let Some(Block::Para(p)) = blocks.first_mut()
        {
            p.props = ParaProps::default();
            p.touch();
        }
        if c.role == ContainerRole::Code {
            for b in &mut blocks {
                if let Block::Para(p) = b {
                    p.props = ParaProps::default();
                    p.touch();
                }
            }
        }
        let i = path.last();
        let bl = self.container_mut(story, path)?;
        if i >= bl.len() {
            return Err(DocError::BadPath(path.to_string()));
        }
        bl.remove(i);
        for (k, b) in blocks.into_iter().enumerate() {
            bl.insert(i + k, Arc::new(b));
        }
        if bl.last().is_some_and(|b| b.as_para().is_none()) {
            bl.push(para_block(Paragraph::new()));
        }
        Ok(path.clone())
    }
}

/// Whether `b`, or any paragraph in it, ends a section.
fn has_section(b: &Block) -> bool {
    let mut found = false;
    crate::edit::each_para(b, 0, &mut |p| found |= p.section.is_some());
    found
}

/// No table style options at all (header row set by the caller).
fn no_look() -> TableLook {
    TableLook { header_row: false, total_row: false, banded_rows: false, first_column: false, last_column: false, banded_columns: false }
}
