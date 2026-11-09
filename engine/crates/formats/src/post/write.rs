//! The post writer: docs/plans/engine/stage3-forum.md section 2's model mapping, from the engine model back to the post's
//! ProseMirror JSON. It writes the accepted view, so runs and blocks a tracked deletion removed are left out and `pending` says
//! how many revisions the post still holds. The reader's typing room (an empty paragraph it adds after a container or a table)
//! is dropped again, so reading the written post gives the same blocks. The post is written straight into one string, as
//! `ew_doc`'s compact writer does, so no JSON tree is built.

use std::fmt::Write as _;
use std::sync::Arc;

use ew_doc::para::OBJ;
use ew_doc::post;
use ew_doc::props::{Underline, VMerge};
use ew_doc::{Align, Block, Cell, CharProps, Container, ContainerRole, Document, InlineObject, Paragraph, Row, Rgb, Table, TextColor};

/// The base text's size at 100 % when the style sheet gives none (12 points, `ew_doc::post`'s `BASE_PT`).
const BASE_PT: f32 = 12.0;
/// A media object's width when it names none (300 points, the reader's `MEDIA_W`).
const MEDIA_W: f32 = 300.0;
/// The blocks the reader leaves an empty paragraph after, so typing can go on past them.
const TYPING_ROOM_AFTER: [&str; 4] = ["blockquote", "codeBlock", "box", "table"];

const HEX: [char; 16] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];

/// Write `doc` as a post: `{"doc": <the post node>, "pending": <the revisions still waiting>}`.
pub fn write(doc: &Document) -> String {
    let c = Ctx { doc, avail: avail(doc) };
    let mut out = String::with_capacity(1024 + doc.body.len() * 64);
    out.push_str("{\"doc\":{\"type\":\"doc\",\"content\":[");
    blocks(&c, &mut out, &doc.body);
    out.push_str("]},\"pending\":");
    let _ = write!(out, "{}", doc.revisions.len());
    out.push('}');
    out
}

/// What the writer needs from the document that does not change down its walk.
struct Ctx<'a> {
    doc: &'a Document,
    /// The width the post's text has, points: the page less its margins (the reader's web margin).
    avail: f32,
}

/// A list item as it is written: its numbered first paragraph and the blocks after it, each ending with a comma as the post's
/// content arrays hold them.
struct Item {
    lead: String,
    rest: String,
    /// The type of the last node written into the item, to drop the reader's typing room after a container.
    after: &'static str,
}

/// A list the writer has open, until a paragraph of another instance or of a higher level closes it.
struct OpenList {
    num: u32,
    ordered: bool,
    start: u32,
    items: Vec<Item>,
}

/// A block list: consecutive numbered paragraphs become lists, nested by their numbering instance and level, and the blocks
/// after one belong to its item. The typing room the reader added after a container or a table is dropped.
fn blocks(c: &Ctx, out: &mut String, blocks: &[Arc<Block>]) {
    let mut open: Vec<OpenList> = Vec::new();
    // The last node written and the one before it, to drop the reader's empty paragraph after a block that takes one.
    let mut last: Option<(usize, &'static str, bool)> = None;
    let mut before_last: Option<&'static str> = None;
    for block in blocks {
        // A paragraph every run of which is deleted is left out, as its text is: the post writes the accepted view.
        if let Block::Para(p) = &**block
            && !live(p)
        {
            continue;
        }
        if let Block::Para(p) = &**block {
            if let Some(nr) = p.props.numbering {
                numbered(c, out, p, nr, &mut open);
                continue;
            }
        }
        // The reader marks a list item's later blocks with its level's indent: a paragraph as its style, a container or a
        // table as the table indent. A block whose indent names an open item's level joins it; any other is the block after
        // the list, as leaving the list is what Enter twice does.
        let want = block_indent(block)
            .filter(|i| *i > 0.0)
            .map(|i| ((i / post::LIST_INDENT).round() as usize).saturating_sub(1));
        if let Some(depth) = want.filter(|d| *d < open.len()) {
            while open.len() > depth + 1 {
                if let Some(list) = open.pop() {
                    close_list(out, &mut open, list);
                }
            }
            if let Some(item) = open.last_mut().and_then(|l| l.items.last_mut()) {
                push_item(c, item, block);
                continue;
            }
        }
        while let Some(list) = open.pop() {
            close_list(out, &mut open, list);
        }
        let start = out.len();
        write_block(c, out, block);
        if out.len() > start {
            before_last = last.map(|l| l.1);
            last = Some((start, block_type(block), is_blank(block)));
        }
    }
    while let Some(list) = open.pop() {
        let start = out.len();
        close_list(out, &mut open, list);
        if out.len() > start {
            before_last = last.map(|l| l.1);
            last = Some((start, "list", false));
        }
    }
    if let Some((start, "paragraph", true)) = last
        && before_last.is_some_and(|t| TYPING_ROOM_AFTER.contains(&t))
    {
        out.truncate(start);
    }
    if out.ends_with(',') {
        out.pop();
    }
}

fn write_block(c: &Ctx, out: &mut String, block: &Block) {
    match block {
        Block::Para(p) => paragraph(c, out, p),
        Block::Table(t) => table(c, out, t),
        Block::Container(ct) => container(c, out, ct),
    }
}

/// A block into a list item's blocks, dropping the typing room the reader left after a container there.
fn push_item(c: &Ctx, item: &mut Item, block: &Block) {
    if is_blank(block) && TYPING_ROOM_AFTER.contains(&item.after) {
        return;
    }
    let start = item.rest.len();
    write_block(c, &mut item.rest, block);
    if item.rest.len() > start {
        item.after = block_type(block);
    }
}

/// The indent that names a list item's level: a paragraph's own indent, a table's table indent, a container's.
fn block_indent(block: &Block) -> Option<f32> {
    match block {
        Block::Para(p) => p.props.indent_left,
        Block::Table(t) => t.props.indent,
        Block::Container(c) => Some(c.indent),
    }
}

/// The node a block is written as, for the typing room check.
fn block_type(block: &Block) -> &'static str {
    match block {
        Block::Para(p) if p.props.style.as_deref() == Some(post::RULE) => "horizontalRule",
        Block::Para(_) => "paragraph",
        Block::Table(_) => "table",
        Block::Container(c) => match c.role {
            ContainerRole::Quote => "blockquote",
            ContainerRole::Code => "codeBlock",
            ContainerRole::Box => "box",
        },
    }
}

fn is_blank(block: &Block) -> bool {
    matches!(block, Block::Para(p) if p.text.is_empty() && p.objects.is_empty() && p.props.style.as_deref() != Some(post::RULE))
}

/// A numbered paragraph: a new item of the list its instance names, opening or closing lists around it.
fn numbered(c: &Ctx, out: &mut String, p: &Paragraph, nr: ew_doc::props::NumRef, open: &mut Vec<OpenList>) {
    let at = match open.iter().position(|l| l.num == nr.num) {
        Some(at) => at,
        None => {
            // A new instance at its level: close the lists deeper than it first.
            while open.len() > nr.level as usize {
                if let Some(list) = open.pop() {
                    close_list(out, open, list);
                }
            }
            open.push(open_list(c.doc, nr.num));
            open.len() - 1
        }
    };
    while open.len() > at + 1 {
        if let Some(list) = open.pop() {
            close_list(out, open, list);
        }
    }
    let mut lead = String::new();
    paragraph(c, &mut lead, p);
    open[at].items.push(Item { lead, rest: String::new(), after: "paragraph" });
}

fn open_list(doc: &Document, num: u32) -> OpenList {
    let n = doc.numbering.nums.iter().find(|n| n.id == num);
    OpenList {
        num,
        ordered: n.is_some_and(|n| n.abstract_id != post::BULLET_ABSTRACT),
        start: n.and_then(|n| n.start_overrides.first()).map_or(1, |(_, start)| *start),
        items: Vec::new(),
    }
}

/// Finish a list: the list node goes into its parent item's blocks, or into the block list being written.
fn close_list(out: &mut String, open: &mut [OpenList], list: OpenList) {
    if list.items.is_empty() {
        return;
    }
    let mut node = String::new();
    node.push_str("{\"type\":");
    node.push_str(if list.ordered { "\"orderedList\"" } else { "\"bulletList\"" });
    if list.ordered && list.start != 1 {
        let _ = write!(node, ",\"attrs\":{{\"start\":{}}}", list.start);
    }
    node.push_str(",\"content\":[");
    for item in list.items {
        node.push_str("{\"type\":\"listItem\",\"content\":[");
        node.push_str(&item.lead);
        node.push_str(&item.rest);
        node.pop();
        node.push_str("]},");
    }
    node.pop();
    node.push_str("]},");
    match open.last_mut().and_then(|l| l.items.last_mut()) {
        Some(parent) => parent.rest.push_str(&node),
        None => out.push_str(&node),
    }
}

/// A paragraph or heading, or the horizontal rule its style names. Text beside an object it holds is a paragraph of its own,
/// before or after the object.
fn paragraph(c: &Ctx, out: &mut String, p: &Paragraph) {
    let style = p.props.style.as_deref();
    if style == Some(post::RULE) {
        out.push_str("{\"type\":\"horizontalRule\"},");
        if p.text.is_empty() {
            return;
        }
    }
    let base = base_size(c.doc, style);
    let mut open = false;
    let mut wrote = false;
    let mut any = false;
    let mut obj = 0;
    let mut buf = String::new();
    for (range, props) in p.run_ranges() {
        let Some(text) = p.text.get(range) else { continue };
        let deleted = props.del.is_some();
        for ch in text.chars() {
            match ch {
                OBJ => {
                    text_node(out, p, style, base, &std::mem::take(&mut buf), props, &mut open, &mut wrote, &mut any);
                    if !deleted && let Some(o) = p.objects.get(obj) {
                        if open {
                            out.push_str("]},");
                            open = false;
                            wrote = false;
                        }
                        object(c, out, o);
                        any = true;
                    }
                    obj += 1;
                }
                '\n' => {
                    text_node(out, p, style, base, &std::mem::take(&mut buf), props, &mut open, &mut wrote, &mut any);
                    if !open {
                        para_head(out, p, style);
                        out.push_str(",\"content\":[");
                        open = true;
                    }
                    if wrote {
                        out.push(',');
                    }
                    out.push_str("{\"type\":\"hardBreak\"}");
                    wrote = true;
                    any = true;
                }
                _ if !deleted => buf.push(ch),
                _ => {}
            }
        }
        text_node(out, p, style, base, &std::mem::take(&mut buf), props, &mut open, &mut wrote, &mut any);
    }
    if open {
        out.push_str("]},");
    } else if !any {
        para_head(out, p, style);
        out.push_str("},");
    }
}

fn para_head(out: &mut String, p: &Paragraph, style: Option<&str>) {
    match style.and_then(heading_level) {
        Some(level) => {
            let _ = write!(out, "{{\"type\":\"heading\",\"attrs\":{{\"level\":{level}");
            if let Some(a) = p.props.align {
                out.push_str(",\"textAlign\":");
                quote(out, align_name(a));
            }
            // The attrs object only: the caller adds `,"content":[` or closes the node.
            out.push('}');
        }
        None => {
            out.push_str("{\"type\":\"paragraph\"");
            if let Some(a) = p.props.align {
                out.push_str(",\"attrs\":{\"textAlign\":");
                quote(out, align_name(a));
                out.push('}');
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn text_node(
    out: &mut String,
    p: &Paragraph,
    style: Option<&str>,
    base: f32,
    text: &str,
    props: &CharProps,
    open: &mut bool,
    wrote: &mut bool,
    any: &mut bool,
) {
    if text.is_empty() {
        return;
    }
    if !*open {
        para_head(out, p, style);
        out.push_str(",\"content\":[");
        *open = true;
    }
    if *wrote {
        out.push(',');
    }
    out.push_str("{\"type\":\"text\",\"text\":");
    quote(out, text);
    marks(out, props, base);
    out.push('}');
    *wrote = true;
    *any = true;
}

/// A box's title as inline nodes: its paragraphs' runs, one after another.
fn title(c: &Ctx, out: &mut String, blocks: &[Arc<Block>]) {
    for block in blocks {
        let Block::Para(p) = &**block else { continue };
        let base = base_size(c.doc, p.props.style.as_deref());
        for (range, props) in p.run_ranges() {
            let Some(text) = p.text.get(range) else { continue };
            if props.del.is_some() {
                continue;
            }
            let mut buf = String::new();
            for ch in text.chars() {
                match ch {
                    OBJ => {
                        title_text(out, &std::mem::take(&mut buf), props, base);
                    }
                    '\n' => {
                        title_text(out, &std::mem::take(&mut buf), props, base);
                        out.push_str("{\"type\":\"hardBreak\"},");
                    }
                    _ => buf.push(ch),
                }
            }
            title_text(out, &buf, props, base);
        }
    }
    if out.ends_with(',') {
        out.pop();
    }
}

fn title_text(out: &mut String, text: &str, props: &CharProps, base: f32) {
    if text.is_empty() {
        return;
    }
    out.push_str("{\"type\":\"text\",\"text\":");
    quote(out, text);
    marks(out, props, base);
    out.push_str("},");
}

/// A run's marks, in the editor's nesting order. Inline code is the only mark a code run has, and a size that snaps to the
/// base size is no mark at all.
fn marks(out: &mut String, props: &CharProps, base: f32) {
    if props.style.as_deref() == Some(post::CODE) {
        out.push_str(",\"marks\":[{\"type\":\"code\"}]");
        return;
    }
    let mut m = String::new();
    if let Some(href) = props.link.as_deref().filter(|h| !h.is_empty()) {
        m.push_str("{\"type\":\"link\",\"attrs\":{\"href\":");
        quote(&mut m, href);
        m.push_str("}}");
        comma(&mut m);
    }
    if props.bold == Some(true) {
        simple(&mut m, "bold");
    }
    if props.italic == Some(true) {
        simple(&mut m, "italic");
    }
    if props.strike == Some(true) {
        simple(&mut m, "strike");
    }
    if props.underline.is_some_and(|u| u != Underline::None) {
        simple(&mut m, "underline");
    }
    match props.vert_align {
        Some(ew_doc::props::VertAlign::Subscript) => simple(&mut m, "subscript"),
        Some(ew_doc::props::VertAlign::Superscript) => simple(&mut m, "superscript"),
        _ => {}
    }
    if let Some(size) = props.size {
        let pct = snap(size, base);
        if pct != 100 {
            let _ = write!(m, "{{\"type\":\"fontSize\",\"attrs\":{{\"size\":\"{pct}\"}}}},");
        }
    }
    if let Some(TextColor::Rgb(c)) = props.color {
        m.push_str("{\"type\":\"textColor\",\"attrs\":{\"color\":");
        quote(&mut m, colour_key(c));
        m.push_str("}},");
    }
    if let Some(shade) = props.shading {
        m.push_str("{\"type\":\"highlight\",\"attrs\":{\"color\":");
        quote(&mut m, highlight_key(shade));
        m.push_str("}},");
    }
    if let Some(font) = props.font.as_deref().filter(|f| post::FONTS.contains(f)) {
        m.push_str("{\"type\":\"fontFamily\",\"attrs\":{\"font\":");
        quote(&mut m, font);
        m.push_str("}},");
    }
    if m.ends_with(',') {
        m.pop();
    }
    if !m.is_empty() {
        out.push_str(",\"marks\":[");
        out.push_str(&m);
        out.push(']');
    }
}

fn simple(m: &mut String, name: &str) {
    m.push_str("{\"type\":\"");
    m.push_str(name);
    m.push_str("\"},");
}

/// An object as its post node: the attrs the reader kept in its data, the source of a medium, and the width it is shown at.
/// A frame the reader's own sizing does not explain is a resize, which sets `dw`. A medium and a plan chart also write the
/// height hints the reader sizes them from (`nw`, `nh`, `ch`), so a canvas draft reopened without the DOM editor keeps the size
/// it was saved at instead of falling back to 16:9.
fn object(c: &Ctx, out: &mut String, o: &InlineObject) {
    let Some((w, h, float)) = o.frame() else { return };
    let Some(b) = float.r#box.as_ref() else { return };
    let kind = match b.kind.as_str() {
        kind @ ("canvas" | "planChart" | "media") => kind,
        _ => return,
    };
    let dw = member(&b.data, "dw");
    let mut attrs = String::with_capacity(b.data.len() + 48);
    copy_members(&mut attrs, &b.data, "dw");
    if (w - natural(kind, &b.data, c.avail, w)).abs() > 1.0 {
        field(&mut attrs, "dw", &num_text(w));
    } else if let Some(text) = dw {
        field(&mut attrs, "dw", text);
    }
    field(&mut attrs, "shown", &num_text(w));
    match kind {
        // The frame's own size: the ratio a medium is read back at, and a chart's measured height.
        "media" => {
            field(&mut attrs, "nw", &num_text(w));
            field(&mut attrs, "nh", &num_text(h));
        }
        "planChart" => field(&mut attrs, "ch", &num_text(h)),
        _ => {}
    }
    if kind == "media" && !b.file.is_empty() {
        let mut src = String::new();
        quote(&mut src, &b.file);
        field(&mut attrs, "src", &src);
    }
    out.push_str("{\"type\":");
    quote(out, kind);
    out.push_str(",\"attrs\":{");
    out.push_str(&attrs);
    out.push_str("}},");
}

/// The width the reader gives an object from its attrs alone, so a frame of another width is a resize to write. A medium with no
/// display width of its own reads back at its `nw` hint, which is the frame width the writer sets, so its own width stands.
fn natural(kind: &str, data: &str, avail: f32, w: f32) -> f32 {
    let hint = |k: &str| member(data, k).and_then(|v| v.parse::<f32>().ok());
    match kind {
        "canvas" => hint("dw").or(hint("w")).unwrap_or(MEDIA_W).min(avail),
        "planChart" => hint("dw").unwrap_or(avail).min(avail),
        _ => hint("dw").unwrap_or(w).min(avail),
    }
}

/// The text of `key`'s member in `data`'s JSON object, if it has one.
fn member<'a>(data: &'a str, key: &str) -> Option<&'a str> {
    let body = body(data);
    let b = body.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let kend = skip_string(b, i)?;
        let mut j = kend;
        while b.get(j).is_some_and(u8::is_ascii_whitespace) {
            j += 1;
        }
        let vend = skip_value(b, j + usize::from(b.get(j) == Some(&b':'))) ?;
        if &body[i + 1..kend - 1] == key {
            return Some(body[j + usize::from(b.get(j) == Some(&b':'))..vend].trim());
        }
        i = vend;
        if b.get(i) == Some(&b',') {
            i += 1;
        }
    }
    None
}

/// `data`'s JSON object's members but `key`'s, comma-separated as an object's body.
fn copy_members(out: &mut String, data: &str, key: &str) {
    let body = body(data);
    let b = body.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        let Some(kend) = skip_string(b, i) else { break };
        let mut j = kend;
        while b.get(j).is_some_and(u8::is_ascii_whitespace) {
            j += 1;
        }
        let j = j + usize::from(b.get(j) == Some(&b':'));
        let Some(vend) = skip_value(b, j) else { break };
        if &body[start + 1..kend - 1] != key {
            comma(out);
            out.push_str(&body[start..vend]);
        }
        i = vend;
        if b.get(i) == Some(&b',') {
            i += 1;
        }
    }
}

/// An object's body, between its braces.
fn body(data: &str) -> &str {
    let data = data.trim();
    data.strip_prefix('{').and_then(|d| d.strip_suffix('}')).unwrap_or("").trim()
}

/// The end of the JSON string starting at `i`.
fn skip_string(b: &[u8], i: usize) -> Option<usize> {
    if b.get(i) != Some(&b'"') {
        return None;
    }
    let mut k = i + 1;
    while k < b.len() {
        match b[k] {
            b'\\' => k += 2,
            b'"' => return Some(k + 1),
            _ => k += 1,
        }
    }
    None
}

/// The end of the JSON value starting at `i`.
fn skip_value(b: &[u8], i: usize) -> Option<usize> {
    match *b.get(i)? {
        b'"' => skip_string(b, i),
        c @ (b'{' | b'[') => {
            let close = if c == b'{' { b'}' } else { b']' };
            let mut depth = 0i32;
            let mut k = i;
            while k < b.len() {
                match b[k] {
                    b'"' => {
                        k = skip_string(b, k)?;
                        continue;
                    }
                    x if x == c => depth += 1,
                    x if x == close => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(k + 1);
                        }
                    }
                    _ => {}
                }
                k += 1;
            }
            None
        }
        _ => {
            let mut k = i;
            while k < b.len() && !matches!(b[k], b',' | b'}' | b']') {
                k += 1;
            }
            Some(k)
        }
    }
}

/// One member of a JSON object being built.
fn field(out: &mut String, name: &str, value: &str) {
    comma(out);
    out.push('"');
    out.push_str(name);
    out.push_str("\":");
    out.push_str(value);
}

fn num_text(v: f32) -> String {
    let mut s = String::new();
    number(&mut s, v);
    s
}

fn container(c: &Ctx, out: &mut String, ct: &Container) {
    match ct.role {
        ContainerRole::Quote => {
            out.push_str("{\"type\":\"blockquote\",\"content\":[");
            blocks(c, out, &ct.blocks);
            out.push_str("]},");
        }
        ContainerRole::Code => {
            let mut text = String::new();
            for (i, b) in ct.blocks.iter().enumerate() {
                if i > 0 {
                    text.push('\n');
                }
                text.push_str(&code_line(b));
            }
            out.push_str("{\"type\":\"codeBlock\"");
            if let Some(lang) = ct.language.as_deref().filter(|l| !l.is_empty()) {
                out.push_str(",\"attrs\":{\"language\":");
                quote(out, lang);
                out.push('}');
            }
            if !text.is_empty() {
                out.push_str(",\"content\":[{\"type\":\"text\",\"text\":");
                quote(out, &text);
                out.push_str("}]");
            }
            out.push_str("},");
        }
        ContainerRole::Box => {
            out.push_str("{\"type\":\"box\",\"content\":[");
            if !ct.title.is_empty() {
                out.push_str("{\"type\":\"boxTitle\",\"content\":[");
                title(c, out, &ct.title);
                out.push_str("]},");
            }
            out.push_str("{\"type\":\"boxContent\",\"content\":[");
            blocks(c, out, &ct.blocks);
            out.push_str("]}]},");
        }
    }
}

fn table(c: &Ctx, out: &mut String, t: &Table) {
    let starts: Vec<Vec<usize>> = t.rows.iter().map(|r| cell_starts(r)).collect();
    out.push_str("{\"type\":\"table\",\"content\":[");
    for (ri, row) in t.rows.iter().enumerate() {
        out.push_str("{\"type\":\"tableRow\",\"content\":[");
        let mut col = 0;
        let mut cells = 0;
        for cell in &row.cells {
            let span = cell.props.span.max(1);
            // A vertical merge's continuation cells are the cell above's rowspan, not cells of their own.
            if cell.props.vmerge != VMerge::Continue {
                let rowspan = if cell.props.vmerge == VMerge::Restart { 1 + continues_below(&starts, &t.rows, ri, col) } else { 1 };
                cell_node(c, out, cell, row, t, col, span, rowspan);
                cells += 1;
            }
            col += span as usize;
        }
        if cells > 0 {
            out.pop();
        }
        out.push_str("]},");
    }
    if !t.rows.is_empty() {
        out.pop();
    }
    out.push_str("]},");
}

fn cell_node(c: &Ctx, out: &mut String, cell: &Cell, row: &Row, t: &Table, col: usize, span: u32, rowspan: u32) {
    let head = cell.blocks.iter().any(|b| b.as_para().is_some_and(|p| p.props.style.as_deref() == Some(post::TABLE_HEAD)));
    out.push_str("{\"type\":");
    out.push_str(if head { "\"tableHeader\"" } else { "\"tableCell\"" });
    let mut attrs = String::new();
    if span > 1 {
        let _ = write!(attrs, "\"colspan\":{span},");
    }
    if rowspan > 1 {
        let _ = write!(attrs, "\"rowspan\":{rowspan},");
    }
    // The forum keeps one width per column, and only for the cells the post gave one: a cell across several columns takes the
    // grid's columns it spans.
    if let Some(w) = cell.props.width {
        let widths: Vec<f32> = if span == 1 { vec![w] } else { t.grid.iter().skip(col).take(span as usize).copied().collect() };
        attrs.push_str("\"colwidth\":[");
        for (i, w) in widths.iter().enumerate() {
            if i > 0 {
                attrs.push(',');
            }
            number(&mut attrs, (w / post::PX).round());
        }
        attrs.push_str("],");
    }
    if attrs.ends_with(',') {
        attrs.pop();
    }
    if !attrs.is_empty() {
        out.push_str(",\"attrs\":{");
        out.push_str(&attrs);
        out.push('}');
    }
    out.push_str(",\"content\":[");
    blocks(c, out, &cell.blocks);
    out.push_str("]},");
}

/// Every row's cells' columns on the grid.
fn cell_starts(row: &Row) -> Vec<usize> {
    let mut out = Vec::with_capacity(row.cells.len());
    let mut start = 0;
    for cell in &row.cells {
        out.push(start);
        start += cell.props.span.max(1) as usize;
    }
    out
}

/// How many rows below `at` continue the vertical merge starting at column `col`.
fn continues_below(starts: &[Vec<usize>], rows: &[Row], at: usize, col: usize) -> u32 {
    let mut n = 0;
    for r in at + 1..rows.len() {
        let Some(cols) = starts.get(r) else { break };
        let hit = rows[r].cells.iter().zip(cols).find(|(_, s)| **s == col).map(|(cell, _)| cell);
        match hit {
            Some(cell) if cell.props.vmerge == VMerge::Continue => n += 1,
            _ => break,
        }
    }
    n
}

/// The width the post's text has, points: the page less its margins (the reader's web margin).
fn avail(doc: &Document) -> f32 {
    let s = &doc.last_section;
    (s.page_w - s.margin_left - s.margin_right).max(1.0)
}

/// The size a style's text has, points: the style's own, or the post's base (the reader's `style_size`).
fn base_size(doc: &Document, style: Option<&str>) -> f32 {
    style
        .and_then(|s| doc.styles.get(s))
        .and_then(|s| s.chr.size)
        .or(doc.styles.default_chr.size)
        .unwrap_or(BASE_PT)
}

/// Whether a paragraph has text to write: one with every run deleted is a deleted block.
fn live(p: &Paragraph) -> bool {
    if p.runs.is_empty() {
        return p.mark.del.is_none();
    }
    p.run_ranges().any(|(r, c)| c.del.is_none() && !r.is_empty())
}

/// A code block's paragraphs as its lines: one line more for every paragraph after the first, and a line break inside one
/// is a line of its own.
fn code_line(block: &Arc<Block>) -> String {
    let Block::Para(p) = &**block else { return String::new() };
    let mut out = String::new();
    for (range, props) in p.run_ranges() {
        if props.del.is_none() && let Some(text) = p.text.get(range) {
            out.extend(text.chars().filter(|c| *c != OBJ));
        }
    }
    out
}

fn heading_level(style: &str) -> Option<u8> {
    post::HEADINGS.iter().position(|s| *s == style).and_then(|i| u8::try_from(i + 1).ok())
}

fn align_name(a: Align) -> &'static str {
    match a {
        Align::Left => "left",
        Align::Center => "center",
        Align::Right => "right",
        Align::Justify | Align::Distribute => "justify",
    }
}

/// The kit size `size` is, at a base text of `base` points: the nearest of the post's percent sizes.
fn snap(size: f32, base: f32) -> u16 {
    let mut best = post::FONT_SIZES[0];
    let mut dist = f32::MAX;
    for pct in post::FONT_SIZES {
        let d = (base * f32::from(pct) / 100.0 - size).abs();
        if d < dist {
            dist = d;
            best = pct;
        }
    }
    best
}

/// The colour key nearest `c`, as the dark palette holds it: an exact colour keeps its own key.
fn colour_key(c: Rgb) -> &'static str {
    post::COLORS.iter().min_by_key(|(_, dark, _)| distance(*dark, c)).map_or("soft", |(key, _, _)| *key)
}

/// The highlight key whose blend is nearest `shade`: an exact blend keeps its own key.
fn highlight_key(shade: Rgb) -> &'static str {
    post::HIGHLIGHT_HUES
        .iter()
        .min_by_key(|(_, hue)| distance(post::blend(*hue, post::PAPER), shade))
        .map_or("yellow", |(key, _)| *key)
}

fn distance(a: Rgb, b: Rgb) -> i32 {
    let d = |x: u8, y: u8| i32::from(x) - i32::from(y);
    let (r, g, bl) = (d(a.0, b.0), d(a.1, b.1), d(a.2, b.2));
    r * r + g * g + bl * bl
}

/// `s` as a JSON string literal, in `out`.
fn quote(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if c < ' ' => {
                out.push_str("\\u00");
                out.push(HEX[(c as usize) >> 4]);
                out.push(HEX[(c as usize) & 15]);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A separator between the members of a JSON object or array being built, when it has one already.
fn comma(s: &mut String) {
    if !s.is_empty() {
        s.push(',');
    }
}

/// A number as a post writes it: a whole number whole, any other to three places.
fn number(out: &mut String, v: f32) {
    let r = (f64::from(v) * 1000.0).round() / 1000.0;
    if r.fract() == 0.0 && r.abs() < 1e15 {
        let _ = write!(out, "{}", r as i64);
    } else {
        let _ = write!(out, "{r}");
    }
}

