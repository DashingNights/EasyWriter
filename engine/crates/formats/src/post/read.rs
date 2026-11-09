//! The post reader: docs/plans/engine/stage3-forum.md section 2's model mapping, from the post's ProseMirror JSON to the engine
//! model. CSS pixels times 0.75 are points; the forum's typography comes from `ew_doc::post`'s style sheet.

use std::sync::Arc;

use serde_json::Value;

use ew_doc::edit::Fragment;
use ew_doc::numbering::{Num, Numbering};
use ew_doc::para::{Float, OBJ, ObjectBox, Picture};
use ew_doc::post;
use ew_doc::props::{CellProps, NumRef, RowProps, TableLook, TableProps, Underline, VertAlign, VMerge};
use ew_doc::table::MAX_TABLE_DEPTH;
use ew_doc::{
    Align, Block, Blocks, Cell, CharProps, Container, ContainerRole, Document, Id, InlineObject, ParaProps, Paragraph, Revision, RevisionKind,
    Row, Run, Table, TextColor, para_block,
};

/// The forum page's width and padding when the post says neither (src/formats.mjs `DEFAULT_PAGE_WIDTH`, the forum manifest).
const DEFAULT_WIDTH_PX: f32 = 1454.0;
const DEFAULT_PAD_PX: f32 = 22.0;
/// The base text's size at 100 %, points (16 px, `ew_doc::post`'s `BASE_PT`).
const BASE_PT: f32 = 12.0;
/// Each container's padding on one side (src/page.css): 20 px for a quote, 18 px for a code block, 16 px for a box.
const QUOTE_PAD: f32 = 15.0;
const CODE_BLOCK_PAD: f32 = 13.5;
const BOX_PAD: f32 = 12.0;
/// A table cell's padding on one side (11 px).
const CELL_PAD: f32 = 8.25;
/// The room a post's page keeps around its text (A5's web view margin).
const WEB_MARGIN: f32 = 18.0;
/// The deepest container nesting a post may have; the layout shows no more.
const MAX_CONTAINERS: usize = 9;
/// A media object's size when its source gives none (a still downloading https medium).
const MEDIA_W: f32 = 300.0;
const MEDIA_H: f32 = 169.0;
/// A plan chart's height when its measured height is not in its attrs, as a fraction of its width.
const CHART_H: f32 = 0.75;

/// Read a post's stored JSON. It is the host's `{doc, width, pad, base}` (`base` is the post's font and percent size), or the
/// document alone.
pub fn read(json: &str) -> Result<Document, String> {
    // The engine's one JSON value reader, as a chart's look has: serde_json's reader stays compiled once.
    let root: Value = ew_doc::chart::read_value(json).map_err(|e| ["post: ", &e].concat())?;
    let node = match root.get("doc") {
        Some(doc) if is_doc(doc) => doc,
        Some(_) => return Err("post: `doc` is not a document node".into()),
        None if is_doc(&root) => &root,
        None if root.is_object() => return Err("post: the post is not a document node".into()),
        None => return Err("post: the post is not a JSON object".into()),
    };
    let base = root.get("base");
    let font = base.and_then(|b| b.get("font")).and_then(Value::as_str).unwrap_or_default();
    let pct = base.and_then(|b| b.get("size")).and_then(percent).unwrap_or(100);
    let avail = avail_pt(&root);
    let nodes = content(node);

    let mut numbering = post::numbering();
    let mut revisions = Vec::new();
    prescan(nodes, 0, &mut numbering, &mut revisions);

    let mut doc = Document::new();
    doc.settings.profile = Some(post::PROFILE.to_string());
    doc.styles = Arc::new(post::styles(font, pct));
    doc.numbering = Arc::new(numbering);
    doc.revisions = revisions;
    // The page's width is the post's text width, so the fit a file reader gives pictures changes nothing here.
    doc.last_section.page_w = avail + 2.0 * WEB_MARGIN;
    doc.last_section.margin_top = WEB_MARGIN;
    doc.last_section.margin_bottom = WEB_MARGIN;
    doc.last_section.margin_left = WEB_MARGIN;
    doc.last_section.margin_right = WEB_MARGIN;
    doc.body = story(&doc, avail, nodes)?;
    Ok(doc)
}

/// Read the block list `blocks` (an array, or a document node holding one) into a fragment, at `avail_pt` points wide.
pub fn read_blocks(doc: &Document, avail_pt: f32, blocks: &Value) -> Result<Fragment, String> {
    let nodes: &[Value] = match blocks {
        Value::Array(a) => a.as_slice(),
        Value::Object(_) => content(blocks),
        _ => return Err("post: the blocks are not a JSON array".into()),
    };
    let blocks = story(doc, avail_pt, nodes)?;
    let mut out = Vec::with_capacity(blocks.len());
    for block in blocks {
        // The story's Arcs are the reader's own, so this never needs a copy of a block.
        let Some(block) = Arc::into_inner(block) else { return Err("post: a block of the story is shared".into()) };
        out.push(block);
    }
    Ok(Fragment { blocks: out, parts: Default::default() })
}

/// A block list read as a story: at the top, a deletion that climbed past it has no wrapper left to sit beside, so it stays
/// at the end rather than being lost.
fn story(doc: &Document, avail_pt: f32, nodes: &[Value]) -> Result<Blocks, String> {
    let scope = Scope { avail: avail_pt.max(18.0), level: 0, depth: 0, tables: 0, plain: false };
    let (mut blocks, pass) = Reader { doc, num: 1 }.block_list(nodes, scope)?;
    for d in pass {
        blocks.extend(d.blocks);
    }
    Ok(blocks)
}

/// The widest page a post may ask for, points (about 4000 px): a width past this, or one whose float overflows, is clamped.
const MAX_PAGE_PT: f32 = 4000.0;

/// The width the post's text has, points: `width` less `pad` on each side, at 0.75 points a pixel.
fn avail_pt(root: &Value) -> f32 {
    let number = |key: &str, default: f32| {
        root.get(key).and_then(Value::as_f64).filter(|n| n.is_finite()).map(|n| n as f32).unwrap_or(default)
    };
    let width = number("width", DEFAULT_WIDTH_PX);
    let pad = number("pad", DEFAULT_PAD_PX);
    ((width - 2.0 * pad).max(72.0) * post::PX).clamp(72.0, MAX_PAGE_PT)
}

/// A node's child nodes.
fn content(node: &Value) -> &[Value] {
    node.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn node_type(node: &Value) -> Result<&str, String> {
    node.get("type").and_then(Value::as_str).ok_or_else(|| "post: a node has no type".to_string())
}

/// Whether `v` is the post document's root node.
fn is_doc(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) == Some("doc")
}

fn attr<'a>(node: &'a Value, key: &str) -> Option<&'a Value> {
    node.get("attrs").and_then(|a| a.get(key))
}

fn percent(v: &Value) -> Option<u16> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())).and_then(|n| u16::try_from(n).ok())
}

/// A suggestion's `at` (Unix milliseconds) as an ISO 8601 stamp, as a revision dates its change (`doc-edit`'s
/// `iso_from_unix_secs`): the date from chrono, the clock worked out here, so the engine's copy of chrono keeps no formatter.
fn iso_at(at: Option<&Value>) -> String {
    use chrono::Datelike;
    let Some(ms) = at.and_then(Value::as_i64) else { return String::new() };
    let Ok(secs) = u64::try_from(ms.div_euclid(1000)) else { return String::new() };
    let t = secs % 86_400;
    let Some(d) = i64::try_from(secs).ok().and_then(|s| chrono::DateTime::from_timestamp(s, 0)) else { return String::new() };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", d.year(), d.month(), d.day(), t / 3600, t / 60 % 60, t % 60)
}

fn suggestion_author(rec: &Value) -> &str {
    rec.get("by").and_then(Value::as_str).unwrap_or("Assistant")
}

fn suggestion_tag(rec: &Value) -> Option<&str> {
    rec.get("g").and_then(Value::as_str)
}

/// The revision a suggestion record is, which `read` has already put in the document.
fn find_revision(doc: &Document, kind: RevisionKind, rec: &Value) -> Result<u32, String> {
    let (author, date, tag) = (suggestion_author(rec), iso_at(rec.get("at")), suggestion_tag(rec));
    doc.revisions
        .iter()
        .position(|r| r.kind == kind && r.author == author && r.date == date && r.tag.as_deref() == tag)
        .and_then(|i| u32::try_from(i).ok())
        .ok_or_else(|| format!("post: the suggestion `{}` has no revision in this document", tag.unwrap_or("")))
}

/// Put every numbering instance and revision the post's lists and suggestions need into `numbering` and `revisions`. The
/// numbering instances come in the order `read_blocks` asks for them: a list's own instance first, then its items' content,
/// then the blocks a suggestion on the same node removed.
fn prescan(nodes: &[Value], level: usize, numbering: &mut Numbering, revisions: &mut Vec<Revision>) {
    for node in nodes {
        let Ok(ty) = node_type(node) else { continue };
        let list = matches!(ty, "bulletList" | "orderedList");
        if list {
            let bullet = ty == "bulletList";
            let start = if bullet { 1 } else { attr(node, "start").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(1) };
            let id = u32::try_from(numbering.nums.len()).unwrap_or(0) + 1;
            numbering.nums.push(Num {
                id,
                abstract_id: if bullet { post::BULLET_ABSTRACT } else { post::NUMBER_ABSTRACT },
                start_overrides: if start == 1 { Vec::new() } else { vec![(level.min(8) as u8, start)] },
                level_overrides: Vec::new(),
            });
        }
        prescan(content(node), if list { level + 1 } else { level }, numbering, revisions);
        // Only a block node's own suggestion is read (not a list item's, a row's or a box part's), and after its content.
        if !matches!(ty, "paragraph" | "heading" | "blockquote" | "codeBlock" | "box" | "horizontalRule" | "bulletList" | "orderedList" | "table" | "canvas" | "planChart" | "media") {
            continue;
        }
        let Some(suggest) = attr(node, "suggest") else { continue };
        if let Some(ins) = suggest.get("ins").filter(|v| v.is_object()) {
            push_revision(revisions, RevisionKind::Insert, ins);
            if ins.get("old").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
                push_revision(revisions, RevisionKind::Delete, ins);
                prescan(ins.get("old").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]), level, numbering, revisions);
            }
        }
        for d in suggest.get("del").and_then(Value::as_array).into_iter().flatten() {
            push_revision(revisions, RevisionKind::Delete, d);
            prescan(d.get("old").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]), level, numbering, revisions);
        }
    }
}

fn push_revision(revisions: &mut Vec<Revision>, kind: RevisionKind, rec: &Value) {
    let (author, date, tag) = (suggestion_author(rec), iso_at(rec.get("at")), suggestion_tag(rec));
    if revisions.iter().any(|r| r.kind == kind && r.author == author && r.date == date && r.tag.as_deref() == tag) {
        return;
    }
    revisions.push(Revision { kind, author: author.to_string(), date, move_name: None, tag: tag.map(str::to_string) });
}

/// Where a block list stands: its width, the list level a nested list takes, the containers and tables open, and whether it is
/// a suggestion's old blocks (which carry no suggestions of their own).
#[derive(Clone, Copy)]
struct Scope {
    avail: f32,
    level: usize,
    depth: usize,
    tables: usize,
    plain: bool,
}

/// Which side of its carrier a tracked deletion's blocks go.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Before,
    After,
}

/// Blocks a suggestion removed, waiting for the level `up` wrappers above their carrier.
struct Del {
    side: Side,
    up: usize,
    blocks: Blocks,
}

/// Which tracked change a suggestion's blocks are.
#[derive(Clone, Copy)]
enum Track {
    Ins,
    Del,
}

struct Reader<'a> {
    doc: &'a Document,
    /// The next list's numbering instance.
    num: u32,
}

impl Reader<'_> {
    fn block_list(&mut self, nodes: &[Value], scope: Scope) -> Result<(Blocks, Vec<Del>), String> {
        let mut out = Blocks::new();
        let mut pass = Vec::new();
        for node in nodes {
            let (blocks, dels) = self.block(node, scope)?;
            let mut after = Vec::new();
            for d in dels {
                if d.up > 0 {
                    pass.push(Del { up: d.up - 1, ..d });
                } else if d.side == Side::Before {
                    out.extend(d.blocks);
                } else {
                    after.push(d.blocks);
                }
            }
            out.extend(blocks);
            for blocks in after {
                out.extend(blocks);
            }
        }
        Ok((close(out), pass))
    }

    fn block(&mut self, node: &Value, scope: Scope) -> Result<(Blocks, Vec<Del>), String> {
        let ty = node_type(node)?;
        let (mut blocks, mut dels) = match ty {
            "paragraph" => (self.paragraph(node, scope, None)?, Vec::new()),
            "heading" => {
                let level = attr(node, "level").and_then(Value::as_u64).unwrap_or(1).clamp(1, 6);
                (self.paragraph(node, scope, Some(post::HEADINGS[level as usize - 1]))?, Vec::new())
            }
            "blockquote" => self.container(node, scope, ContainerRole::Quote)?,
            "codeBlock" => self.code_block(node, scope)?,
            "box" => self.boxed(node, scope)?,
            "horizontalRule" => (vec![para_block(Paragraph::new().styled(post::RULE))], Vec::new()),
            "bulletList" | "orderedList" => self.list(node, scope)?,
            "table" => self.table(node, scope)?,
            "canvas" | "planChart" | "media" => (vec![para_block(self.object_paragraph(node, scope)?)], Vec::new()),
            _ => return Err(["post: unknown node `", ty, "`"].concat()),
        };
        if !scope.plain {
            self.suggest(node, &mut blocks, &mut dels, scope)?;
        }
        Ok((blocks, dels))
    }

    /// A paragraph or heading: its text and marks, split at any object it holds.
    fn paragraph(&mut self, node: &Value, scope: Scope, style: Option<&str>) -> Result<Blocks, String> {
        let props = ParaProps { style: style.map(str::to_string), align: attach_align(node), ..ParaProps::default() };
        let base = self.style_size(style);
        self.inlines(content(node), &props, base, scope)
    }

    /// The size a style's text has, points: the post's base size scaled, or the heading's own size.
    fn style_size(&self, style: Option<&str>) -> f32 {
        style
            .and_then(|s| self.doc.styles.get(s))
            .and_then(|s| s.chr.size)
            .or(self.doc.styles.default_chr.size)
            .unwrap_or(BASE_PT)
    }

    fn inlines(&mut self, nodes: &[Value], props: &ParaProps, base: f32, scope: Scope) -> Result<Blocks, String> {
        let mut out = Blocks::new();
        let mut cur = Paragraph::new();
        cur.props = props.clone();
        let mut has_text = false;
        for node in nodes {
            let ty = node_type(node)?;
            let cp = self.run_props(node, base)?;
            match ty {
                "text" => {
                    let Some(text) = node.get("text").and_then(Value::as_str) else {
                        return Err("post: a text node's text is not a string".into());
                    };
                    if !text.is_empty() {
                        push_text(&mut cur, text, &cp);
                        has_text = true;
                    }
                }
                "hardBreak" => {
                    push_text(&mut cur, "\n", &CharProps::default());
                    has_text = true;
                }
                "canvas" | "planChart" | "media" => {
                    let obj = self.object(node, scope)?;
                    if has_text {
                        out.push(para_block(std::mem::replace(&mut cur, empty_para(props))));
                        has_text = false;
                    }
                    let mut p = empty_para(props);
                    push_object(&mut p, obj, &CharProps::default());
                    out.push(para_block(p));
                }
                _ => return Err(["post: unknown node `", ty, "`"].concat()),
            }
        }
        if has_text || out.is_empty() {
            out.push(para_block(cur));
        }
        Ok(out)
    }

    /// The character formatting a text node's marks give it; inline code drops every other mark.
    fn run_props(&self, node: &Value, base: f32) -> Result<CharProps, String> {
        let marks: &[Value] = match node.get("marks") {
            Some(Value::Array(marks)) => marks,
            Some(_) => return Err("post: a text node's marks are not a list".into()),
            None => &[],
        };
        let mut props = CharProps::default();
        let mut code = false;
        for mark in marks {
            let ty = mark.get("type").and_then(Value::as_str).ok_or_else(|| "post: a mark has no type".to_string())?;
            if !post::MARKS.contains(&ty) {
                return Err(["post: unknown mark `", ty, "`"].concat());
            }
            match ty {
                "bold" => props.bold = Some(true),
                "italic" => props.italic = Some(true),
                "underline" => props.underline = Some(Underline::Single),
                "strike" => props.strike = Some(true),
                "subscript" => props.vert_align = Some(VertAlign::Subscript),
                "superscript" => props.vert_align = Some(VertAlign::Superscript),
                "code" => code = true,
                "link" => {
                    if let Some(href) = attr(mark, "href").and_then(Value::as_str).filter(|h| !h.is_empty()) {
                        props.link = Some(href.to_string());
                        props.style = Some(post::LINK.to_string());
                    }
                }
                "fontSize" => {
                    if let Some(pct) = attr(mark, "size").and_then(percent) {
                        props.size = Some(round3(base * f32::from(pct) / 100.0));
                    }
                }
                "textColor" => {
                    if let Some(c) = attr(mark, "color").and_then(Value::as_str).and_then(colour) {
                        props.color = Some(TextColor::Rgb(c));
                    }
                }
                "highlight" => {
                    if let Some(hue) = attr(mark, "color").and_then(Value::as_str).and_then(highlight_hue) {
                        props.shading = Some(post::blend(hue, post::PAPER));
                    }
                }
                "fontFamily" => {
                    if let Some(font) = attr(mark, "font").and_then(Value::as_str).filter(|f| post::FONTS.contains(f)) {
                        props.font = Some(font.to_string());
                    }
                }
                _ => {}
            }
        }
        if code {
            return Ok(CharProps { style: Some(post::CODE.to_string()), ..CharProps::default() });
        }
        Ok(props)
    }

    fn container(&mut self, node: &Value, scope: Scope, role: ContainerRole) -> Result<(Blocks, Vec<Del>), String> {
        let ty = node_type(node)?;
        if scope.depth >= MAX_CONTAINERS {
            return Err(format!("post: this {ty} is nested more than {MAX_CONTAINERS} containers deep"));
        }
        let pad = match role {
            ContainerRole::Quote => QUOTE_PAD,
            ContainerRole::Code => CODE_BLOCK_PAD,
            ContainerRole::Box => BOX_PAD,
        };
        let inner = Scope { depth: scope.depth + 1, avail: (scope.avail - 2.0 * pad).max(1.0), plain: scope.plain, ..scope };
        let style = match role {
            ContainerRole::Quote => post::QUOTE,
            ContainerRole::Code => post::CODE_BLOCK,
            ContainerRole::Box => post::BOX,
        };
        let (title, mut blocks, pass) = if role == ContainerRole::Box {
            let mut title = Blocks::new();
            let mut blocks = Blocks::new();
            let mut pass = Vec::new();
            for child in content(node) {
                match node_type(child)? {
                    "boxTitle" => {
                        let props = ParaProps { style: Some(post::BOX_TITLE.to_string()), ..ParaProps::default() };
                        let base = self.style_size(Some(post::BOX_TITLE));
                        title = self.inlines(content(child), &props, base, inner)?;
                    }
                    "boxContent" => {
                        let (b, p) = self.block_list(content(child), inner)?;
                        blocks = b;
                        pass = p;
                    }
                    other => return Err(["post: unknown node `", other, "` in a box"].concat()),
                }
            }
            (title, close(blocks), pass)
        } else {
            let (blocks, pass) = self.block_list(content(node), inner)?;
            (Blocks::new(), close(blocks), pass)
        };
        // `blockquote > :last-child { margin-bottom: 0 }`: the quote's own 1em gap below sits outside it, so its last child
        // adds none of its own (src/page.css).
        if role == ContainerRole::Quote
            && let Some(p) = blocks.iter_mut().rev().find_map(para_mut)
        {
            p.props.space_after = Some(0.0);
        }
        let container = Container {
            id: Id(0),
            role,
            style: Some(style.to_string()),
            language: if role == ContainerRole::Code { code_language(node) } else { None },
            space_after: post::CONTAINER_GAP,
            indent: 0.0,
            title,
            blocks,
        };
        Ok((vec![Arc::new(Block::Container(container))], pass))
    }

    /// A code block: one paragraph per line, in the code block's text style.
    fn code_block(&mut self, node: &Value, scope: Scope) -> Result<(Blocks, Vec<Del>), String> {
        let mut text = String::new();
        for child in content(node) {
            match node_type(child)? {
                "text" => text.push_str(child.get("text").and_then(Value::as_str).unwrap_or_default()),
                "hardBreak" => text.push('\n'),
                other => return Err(["post: unknown node `", other, "` in a code block"].concat()),
            }
        }
        if scope.depth >= MAX_CONTAINERS {
            return Err(format!("post: a codeBlock is nested more than {MAX_CONTAINERS} containers deep"));
        }
        let mut blocks = Blocks::new();
        for line in text.split('\n') {
            let p = Paragraph::with_text(line, CharProps::default()).styled(post::CODE_TEXT);
            blocks.push(para_block(p));
        }
        let container = Container {
            id: Id(0),
            role: ContainerRole::Code,
            style: Some(post::CODE_BLOCK.to_string()),
            language: code_language(node),
            space_after: post::CONTAINER_GAP,
            indent: 0.0,
            title: Blocks::new(),
            blocks,
        };
        Ok((vec![Arc::new(Block::Container(container))], Vec::new()))
    }

    fn boxed(&mut self, node: &Value, scope: Scope) -> Result<(Blocks, Vec<Del>), String> {
        self.container(node, scope, ContainerRole::Box)
    }

    fn list(&mut self, node: &Value, scope: Scope) -> Result<(Blocks, Vec<Del>), String> {
        let ty = node_type(node)?;
        let num = self.num;
        self.num += 1;
        if usize::try_from(num).map_or(true, |n| n > self.doc.numbering.nums.len()) {
            return Err("post: this document has no numbering for the post's list".into());
        }
        let level = scope.level.min(8);
        let mut out = Blocks::new();
        let mut pass = Vec::new();
        for item in content(node) {
            let ity = node_type(item)?;
            if ity != "listItem" {
                return Err(["post: `", ty, "` holds a `", ity, "`"].concat());
            }
            let item_scope = Scope { level: scope.level + 1, ..scope };
            let (mut blocks, mut dels) = self.block_list(content(item), item_scope)?;
            pass.append(&mut dels);
            if let Some(p) = blocks.first_mut().and_then(para_mut)
                && p.props.numbering.is_none()
            {
                p.props.numbering = Some(NumRef { num, level: level as u8 });
                if p.props.style.as_deref().is_none_or(|s| s == "Normal") {
                    p.props.space_after = Some(0.0);
                }
            }
            // The item's later blocks carry its level's indent: paragraphs as their style's indent, a container or a table as
            // the table indent the model keeps, so the writer knows they belong to the item and not to the block after it. A
            // nested list's blocks reach this item's list too, and those already carry their own level's indent: a deeper
            // marker is this list's item's own, and is kept.
            let marker = post::LIST_INDENT * (level + 1) as f32;
            for block in blocks.iter_mut().skip(1) {
                match Arc::get_mut(block) {
                    Some(Block::Para(p)) if p.props.numbering.is_none() && p.props.indent_left.is_none() => {
                        p.props.style = Some(post::LIST_MORE.to_string());
                        p.props.indent_left = Some(marker);
                        p.props.space_after = Some(0.0);
                    }
                    Some(Block::Container(c)) if c.indent == 0.0 => c.indent = marker,
                    Some(Block::Table(t)) if t.props.indent.is_none() => t.props.indent = Some(marker),
                    _ => {}
                }
            }
            out.extend(blocks);
        }
        // `ul, ol { margin-bottom: 0 }` with `li > p { margin: 0 }`: the 1em gap after a list comes from its last item's last
        // paragraph, as a paragraph's 1em after does (src/page.css).
        if let Some(p) = out.iter_mut().rev().find_map(para_mut) {
            p.props.space_after = Some(post::CONTAINER_GAP);
        }
        Ok((out, pass))
    }

    fn table(&mut self, node: &Value, scope: Scope) -> Result<(Blocks, Vec<Del>), String> {
        if scope.tables >= MAX_TABLE_DEPTH {
            return Err(format!("post: a table is nested more than {MAX_TABLE_DEPTH} deep"));
        }
        let rows = content(node);
        if rows.is_empty() {
            return Err("post: a table has no rows".into());
        }
        let mut cells: Vec<Vec<RawCell>> = Vec::with_capacity(rows.len());
        for row in rows {
            cells.push(raw_cells(row)?);
        }

        // Lay the rows out on the grid, then size the columns from the cells' own widths or an equal split.
        let (cols, plans) = place(&cells);
        let mut grid: Vec<Option<f32>> = vec![None; cols];
        for (r, row) in plans.iter().enumerate() {
            for p in row {
                if let Placed::Cell { index, start, span } = *p {
                    for k in 0..span as usize {
                        if let Some(Some(w)) = cells[r][index].width.get(k) {
                            grid[start + k] = Some(w * post::PX);
                        }
                    }
                }
            }
        }
        let set: f32 = grid.iter().flatten().sum();
        let missing = grid.iter().filter(|w| w.is_none()).count();
        let fill = if missing == 0 {
            0.0
        } else {
            let free = (scope.avail - set).max(0.0);
            if free > 0.0 { free / missing as f32 } else { scope.avail / cols.max(1) as f32 }
        };
        let grid: Vec<f32> = grid.into_iter().map(|w| w.unwrap_or(fill)).collect();
        let total: f32 = grid.iter().sum();

        let mut out_rows = Vec::new();
        let mut pass = Vec::new();
        for (r, row) in plans.iter().enumerate() {
            let mut out_cells = Vec::new();
            for p in row {
                match *p {
                    Placed::Continue { start, span } => out_cells.push(Cell {
                        props: CellProps { span: span as u32, width: Some(width(&grid, start, span)), vmerge: VMerge::Continue, ..CellProps::default() },
                        blocks: vec![para_block(Paragraph::new())],
                        controls: Default::default(),
                    }),
                    Placed::Cell { index, start, span } => {
                        let c = &cells[r][index];
                        let w = width(&grid, start, span);
                        // The cell's own width only when the post gave a colwidth for every column it spans; a column the
                        // post left blank is written back blank, not as the split the layout made for it.
                        let given = c.width.iter().take(span as usize).filter(|w| w.is_some()).count() == span as usize;
                        let inner = Scope { avail: (w - 2.0 * CELL_PAD).max(1.0), tables: scope.tables + 1, ..scope };
                        let (mut blocks, dels) = self.block_list(c.content, inner)?;
                        pass.extend(dels);
                        for b in blocks.iter_mut() {
                            if let Some(p) = para_mut(b) {
                                if c.header {
                                    p.props.style = Some(post::TABLE_HEAD.to_string());
                                } else if p.props.style.as_deref().is_none_or(|s| s == "Normal") {
                                    p.props.space_after = Some(0.0);
                                }
                            }
                        }
                        out_cells.push(Cell {
                            props: CellProps {
                                span: span as u32,
                                width: given.then_some(w),
                                vmerge: if c.rowspan > 1 { VMerge::Restart } else { VMerge::None },
                                ..CellProps::default()
                            },
                            blocks: close(blocks),
                            controls: Default::default(),
                        });
                    }
                }
            }
            let header = cells[r].iter().any(|c| c.header) && !out_cells.is_empty();
            out_rows.push(Row { props: RowProps { header, ..RowProps::default() }, cells: out_cells, controls: Default::default() });
        }

        // `table { margin-bottom: 1em }` with `td > p { margin: 0 }`: the gap below a table is its last row's last paragraphs'
        // 1em after, inside the cells (src/page.css).
        if let Some(row) = out_rows.last_mut() {
            for cell in &mut row.cells {
                if let Some(p) = cell.blocks.iter_mut().rev().find_map(para_mut) {
                    p.props.space_after = Some(post::CONTAINER_GAP);
                }
            }
        }

        let has_header = out_rows.first().is_some_and(|r| r.props.header);
        let table = Table {
            id: Id(0),
            props: TableProps {
                style: Some(post::TABLE.to_string()),
                width: Some(total),
                fixed: true,
                look: TableLook { header_row: has_header, ..no_look() },
                ..TableProps::default()
            },
            grid,
            rows: out_rows,
            controls: Default::default(),
        };
        Ok((vec![Arc::new(Block::Table(table))], pass))
    }

    /// An object node as the paragraph holding it: the drawing's frame is its box, sized to the column.
    fn object_paragraph(&mut self, node: &Value, scope: Scope) -> Result<Paragraph, String> {
        let mut p = Paragraph::new();
        let obj = self.object(node, scope)?;
        push_object(&mut p, obj, &CharProps::default());
        Ok(p)
    }

    /// An object node as an object box: its kind is the node's type, its data the node's attrs (less the hints), and a media
    /// object's source its file.
    fn object(&mut self, node: &Value, scope: Scope) -> Result<InlineObject, String> {
        let ty = node_type(node)?;
        if !["canvas", "planChart", "media"].contains(&ty) {
            return Err(["post: unknown node `", ty, "`"].concat());
        }
        let attrs = node.get("attrs").and_then(Value::as_object);
        let file = if ty == "media" {
            attrs.and_then(|m| m.get("src")).and_then(Value::as_str).unwrap_or_default().to_string()
        } else {
            String::new()
        };
        let hint = |k: &str| attrs.and_then(|m| m.get(k)).and_then(Value::as_f64).map(|n| n as f32).filter(|n| n.is_finite() && *n > 0.0);
        let (nw, nh, ch, dw) = (hint("nw"), hint("nh"), hint("ch"), hint("dw"));
        let avail = scope.avail.max(1.0);
        let (w, h) = match ty {
            "canvas" => {
                let natural = hint("w").unwrap_or(0.0);
                let w0 = dw.or((natural > 0.0).then_some(natural)).unwrap_or(MEDIA_W);
                let w = w0.min(avail);
                let h = hint("h").map(|h| if natural > 0.0 { h * w / natural } else { h }).unwrap_or(MEDIA_H);
                (w, h)
            }
            "planChart" => {
                let w = dw.unwrap_or(avail).min(avail);
                (w, ch.unwrap_or(w * CHART_H))
            }
            _ => {
                let w0 = dw.or(nw).unwrap_or(MEDIA_W);
                let w = w0.min(avail);
                let h = match (nw, nh) {
                    (Some(nw), Some(nh)) if nw > 0.0 => nh * w / nw,
                    _ => MEDIA_H * w / MEDIA_W,
                };
                (w, h)
            }
        };
        // The hints are the reader's, not the post's; a media object's source is its file.
        let skip: &[&str] = if ty == "media" { &["nw", "nh", "ch", "src"] } else { &["nw", "nh", "ch"] };
        let mut float = Float::default();
        float.r#box = Some(Arc::new(ObjectBox { kind: ty.to_string(), data: without(attrs, skip), file }));
        Ok(Picture { w: w.max(1.0), h: h.max(1.0), float, ..Picture::default() }.build())
    }

    /// A node's suggestion: its blocks become tracked insertions, and the blocks it replaced or removed tracked deletions.
    fn suggest(&mut self, node: &Value, blocks: &mut Blocks, dels: &mut Vec<Del>, scope: Scope) -> Result<(), String> {
        let Some(suggest) = attr(node, "suggest") else { return Ok(()) };
        if let Some(ins) = suggest.get("ins").filter(|v| v.is_object()) {
            let rid = find_revision(self.doc, RevisionKind::Insert, ins)?;
            stamp(blocks, Track::Ins, rid);
            let old = ins.get("old").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
            if !old.is_empty() {
                let rid = find_revision(self.doc, RevisionKind::Delete, ins)?;
                let mut removed = self.old_blocks(old, scope)?;
                stamp(&mut removed, Track::Del, rid);
                dels.push(Del { side: Side::Before, up: 0, blocks: removed });
            }
        }
        for d in suggest.get("del").and_then(Value::as_array).into_iter().flatten() {
            let rid = find_revision(self.doc, RevisionKind::Delete, d)?;
            let old = d.get("old").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
            let mut removed = self.old_blocks(old, scope)?;
            stamp(&mut removed, Track::Del, rid);
            let side = if d.get("side").and_then(Value::as_str) == Some("before") { Side::Before } else { Side::After };
            let up = d.get("up").and_then(Value::as_u64).unwrap_or(0) as usize;
            dels.push(Del { side, up, blocks: removed });
        }
        Ok(())
    }

    fn old_blocks(&mut self, nodes: &[Value], scope: Scope) -> Result<Blocks, String> {
        let scope = Scope { plain: true, ..scope };
        let (blocks, _) = self.block_list(nodes, scope)?;
        Ok(blocks)
    }
}

/// A block list always ends with a paragraph, and an empty one is a paragraph.
fn close(mut blocks: Blocks) -> Blocks {
    if blocks.last().is_none_or(|b| b.as_para().is_none()) {
        blocks.push(para_block(Paragraph::new()));
    }
    blocks
}

fn empty_para(props: &ParaProps) -> Paragraph {
    let mut p = Paragraph::new();
    p.props = props.clone();
    p
}

/// Append one text node's text to a paragraph the reader is building: its own run, as the post gives it.
fn push_text(p: &mut Paragraph, text: &str, props: &CharProps) {
    let clean: std::borrow::Cow<'_, str> = if text.contains(OBJ) { text.chars().filter(|c| *c != OBJ).collect() } else { text.into() };
    if clean.is_empty() {
        return;
    }
    p.text.push_str(&clean);
    match p.runs.last_mut() {
        Some(last) if last.props == *props => last.len += clean.len(),
        _ => p.runs.push(Run { len: clean.len(), props: props.clone() }),
    }
}

/// Append one inline object to a paragraph the reader is building.
fn push_object(p: &mut Paragraph, obj: InlineObject, props: &CharProps) {
    p.text.push(OBJ);
    p.objects.push(obj);
    p.runs.push(Run { len: OBJ.len_utf8(), props: props.clone() });
}

fn attach_align(node: &Value) -> Option<Align> {
    attr(node, "textAlign").and_then(Value::as_str).and_then(|s| match s {
        "left" | "start" => Some(Align::Left),
        "center" => Some(Align::Center),
        "right" | "end" => Some(Align::Right),
        "justify" => Some(Align::Justify),
        _ => None,
    })
}

fn colour(key: &str) -> Option<ew_doc::Rgb> {
    post::COLORS.iter().find(|(k, _, _)| *k == key).map(|(_, dark, _)| *dark)
}

fn highlight_hue(key: &str) -> Option<ew_doc::Rgb> {
    post::HIGHLIGHT_HUES.iter().find(|(k, _)| *k == key).map(|(_, c)| *c)
}

fn code_language(node: &Value) -> Option<String> {
    attr(node, "language").and_then(Value::as_str).filter(|l| !l.is_empty()).map(str::to_string)
}

fn round3(v: f32) -> f32 {
    (v * 1000.0).round() / 1000.0
}

fn no_look() -> TableLook {
    TableLook { header_row: false, total_row: false, banded_rows: false, first_column: false, last_column: false, banded_columns: false }
}

fn width(grid: &[f32], start: usize, span: u32) -> f32 {
    grid.get(start..start + span as usize).map(|w| w.iter().sum()).unwrap_or(0.0)
}

/// A JSON object's entries but `skip`, as compact JSON (sorted, as the model writes it): an object's data without the hints.
fn without(attrs: Option<&serde_json::Map<String, Value>>, skip: &[&str]) -> String {
    let Some(map) = attrs else { return "{}".into() };
    let mut out = String::from("{");
    for (k, v) in map {
        if skip.contains(&k.as_str()) {
            continue;
        }
        // `Value`'s Display is the compact form, and the engine already writes values with it: no serialiser of its own.
        if out.len() > 1 {
            out.push(',');
        }
        out.push_str(&Value::String(k.clone()).to_string());
        out.push(':');
        out.push_str(&v.to_string());
    }
    out.push('}');
    out
}

/// A paragraph in a block list this reader built: its Arcs are its own, so marking it needs no copy.
fn para_mut(block: &mut Arc<Block>) -> Option<&mut Paragraph> {
    match Arc::get_mut(block)? {
        Block::Para(p) => Some(p),
        Block::Table(_) | Block::Container(_) => None,
    }
}

/// A table cell as the post gives it.
struct RawCell<'a> {
    span: u32,
    rowspan: u32,
    /// Column widths, CSS pixels, one per spanned column (a column the post gives no width for is `None`).
    width: Vec<Option<f32>>,
    header: bool,
    content: &'a [Value],
}

fn raw_cells(row: &Value) -> Result<Vec<RawCell<'_>>, String> {
    let mut out = Vec::new();
    for cell in content(row) {
        let ty = node_type(cell)?;
        if !matches!(ty, "tableCell" | "tableHeader") {
            return Err(["post: unknown node `", ty, "` in a table row"].concat());
        }
        let span = attr(cell, "colspan").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(1).clamp(1, 63);
        let rowspan = attr(cell, "rowspan").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(1).clamp(1, 32_767);
        // One entry per column, as the app gives them: a null or zero entry is that column's own width unknown, never the next
        // columns' widths moved left.
        let width = attr(cell, "colwidth")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|v| v.as_f64().map(|n| n as f32).filter(|n| n.is_finite() && *n > 0.0)).collect())
            .unwrap_or_default();
        out.push(RawCell { span, rowspan, width, header: ty == "tableHeader", content: content(cell) });
    }
    Ok(out)
}

/// A vertically merged cell still covering the rows below.
#[derive(Clone, Copy)]
struct Merge {
    start: usize,
    span: u32,
    /// Rows it covers after the current one.
    left: u32,
}

/// A cell's place on a row's grid.
#[derive(Clone, Copy)]
enum Placed {
    Cell { index: usize, start: usize, span: u32 },
    Continue { start: usize, span: u32 },
}

/// Every row's cells on the grid, with the continuation cells of vertical merges, and the grid's column count.
fn place(rows: &[Vec<RawCell>]) -> (usize, Vec<Vec<Placed>>) {
    let mut cols = 0;
    let mut plans = Vec::new();
    let mut ongoing: Vec<Merge> = Vec::new();
    for cells in rows {
        let end = ongoing.iter().map(|m| m.start + m.span as usize).max().unwrap_or(0);
        let mut placed = Vec::new();
        let mut g = 0;
        let mut i = 0;
        while i < cells.len() || g < end {
            if let Some(m) = ongoing.iter().find(|m| m.start == g) {
                placed.push(Placed::Continue { start: g, span: m.span });
                g += m.span as usize;
                continue;
            }
            let Some(c) = cells.get(i) else { break };
            i += 1;
            placed.push(Placed::Cell { index: i - 1, start: g, span: c.span });
            g += c.span as usize;
        }
        cols = cols.max(g);
        let mut next: Vec<Merge> = ongoing.iter().filter(|m| m.left > 1).map(|m| Merge { left: m.left - 1, ..*m }).collect();
        for p in &placed {
            if let Placed::Cell { index, start, span } = *p
                && cells[index].rowspan > 1
            {
                next.push(Merge { start, span, left: cells[index].rowspan - 1 });
            }
        }
        ongoing = next;
        plans.push(placed);
    }
    (cols, plans)
}

/// Mark every run and paragraph mark in `blocks` as the tracked change `track` of revision `rid`. The blocks are the
/// reader's own, built just above, so each Arc is unique and needs no copy.
fn stamp(blocks: &mut Blocks, track: Track, rid: u32) {
    for block in blocks {
        let Some(b) = Arc::get_mut(block) else { continue };
        match b {
            Block::Para(p) => {
                for r in &mut p.runs {
                    set(&mut r.props, track, rid);
                }
                set(&mut p.mark, track, rid);
            }
            Block::Table(t) => {
                for row in &mut t.rows {
                    for cell in &mut row.cells {
                        stamp(&mut cell.blocks, track, rid);
                    }
                }
            }
            Block::Container(c) => {
                stamp(&mut c.title, track, rid);
                stamp(&mut c.blocks, track, rid);
            }
        }
    }
}

fn set(props: &mut CharProps, track: Track, rid: u32) {
    match track {
        Track::Ins => props.ins = Some(rid),
        Track::Del => props.del = Some(rid),
    }
}
