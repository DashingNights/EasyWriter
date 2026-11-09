//! Envelopes and labels: Mailings › Create, and the page Start Mail Merge lays out for an envelope or a label merge.
use super::merge::{address_block, refresh};
use super::{
    Align, Block, Blocks, CharProps, CmdError, CmdResult, Document, InlineObject, Paragraph, SectionProps, Selection, Session, StoryRef, Table,
    Value, json, mm, mm_mut, p, para_block,
};

/// Common envelope sizes: name, width and height in points (long side first).
pub const ENVELOPE_SIZES: [(&str, f32, f32); 8] = [
    ("Envelope #10", 684.0, 297.0),
    ("Envelope #9", 639.0, 279.0),
    ("Envelope Monarch", 540.0, 279.0),
    ("Envelope DL", 623.6, 311.8),
    ("Envelope C4", 918.4, 649.1),
    ("Envelope C5", 649.1, 459.2),
    ("Envelope C6", 459.2, 323.1),
    ("Envelope B5", 708.7, 498.9),
];

/// An envelope's size: `width`/`height` in points, else `envelope`'s `w`/`h` (Envelope Options), else `size` by name
/// (`Envelope DL`, or just `DL`, any case). Long side first.
fn envelope_size(v: &Value) -> Result<(f32, f32), CmdError> {
    let env = v.get("envelope");
    let get = |k: &str, e: &str| p::f32(v, k).or_else(|| env.and_then(|x| p::f32(x, e)));
    if let (Some(w), Some(h)) = (get("width", "w"), get("height", "h")) {
        let (w, h) = (w.clamp(144.0, 1584.0), h.clamp(144.0, 1584.0));
        return Ok((w.max(h), w.min(h)));
    }
    let name = p::str(v, "size").unwrap_or("Envelope #10").trim();
    ENVELOPE_SIZES
        .iter()
        .find(|(n, ..)| n.eq_ignore_ascii_case(name) || n.strip_prefix("Envelope ").is_some_and(|short| short.eq_ignore_ascii_case(name)))
        .map(|(_, w, h)| (*w, *h))
        .ok_or_else(|| CmdError::Params(format!("unknown envelope size `{name}`")))
}

/// Longest label or envelope address text accepted.
const MAX_LABEL_TEXT: usize = 2_000;

/// An optional label/envelope text parameter, rejected when longer than `MAX_LABEL_TEXT` characters.
fn label_text(v: &Value, key: &str) -> Result<Option<String>, CmdError> {
    match p::str(v, key) {
        Some(t) if t.chars().count() > MAX_LABEL_TEXT => Err(CmdError::Params(format!("`{key}` is longer than {MAX_LABEL_TEXT} characters"))),
        t => Ok(t.map(str::to_string)),
    }
}

/// An envelope page's margins (top, right, bottom, left), as the app's DOM editor and Word's feed lay it out.
const ENV_MARGIN: [f32; 4] = [18.0, 18.0, 18.0, 27.0];
/// A line of 11 pt text at single spacing, for placing the delivery address under the return address.
const LINE: f32 = 14.0;

/// The section of an envelope `w` × `h` (landscape, its own margins, no header or footer space), from `base`.
fn envelope_section(base: &SectionProps, w: f32, h: f32) -> SectionProps {
    let [top, right, bottom, left] = ENV_MARGIN;
    SectionProps {
        page_w: w,
        page_h: h,
        landscape: true,
        margin_top: top,
        margin_right: right,
        margin_bottom: bottom,
        margin_left: left,
        header: 0.0,
        footer: 0.0,
        gutter: 0.0,
        ..base.clone()
    }
}

/// Whether `sp` is an envelope section this module made (Add to Document replaces it rather than adding a second).
fn is_envelope(sp: &SectionProps) -> bool {
    sp.landscape && sp.margin_left == ENV_MARGIN[3] && sp.margin_top == ENV_MARGIN[0] && sp.header == 0.0
}

/// An envelope's paragraphs, as Word places them: the return address at the top left (unless empty), then the delivery
/// address (`delivery` lines, or an empty paragraph to put a merge field in) indented to its From left and spaced down to its
/// From top. `env` is Envelope Options' value: `delivery` and `ret` with `left` and `top` in points from the envelope's
/// edges (absent: Word's automatic place, a little left of the middle and just under it).
fn envelope_blocks(w: f32, h: f32, env: Option<&Value>, delivery: &str, ret: &str) -> Blocks {
    let pos = |side: &str, k: &str| env.and_then(|e| e.get(side)).and_then(|x| p::f32(x, k)).filter(|n| n.is_finite());
    let omit = env.and_then(|e| e.get("ret")).and_then(|r| p::bool(r, "omit")).unwrap_or(false) || ret.trim().is_empty();
    // Addresses are capped: a pasted novel is not an address.
    let lines = |t: &str| t.split('\n').take(20).map(|l| l.trim_end_matches('\r').to_string()).collect::<Vec<_>>();
    let [top_margin, .., left_margin] = ENV_MARGIN;
    let mut blocks = Vec::new();
    let mut used = 0.0;
    if !omit {
        let ret_lines = lines(ret);
        let ret_top = pos("ret", "top").map(|t| (t - top_margin).max(0.0));
        let ret_left = pos("ret", "left").map(|l| (l - left_margin).max(0.0));
        for (i, l) in ret_lines.iter().enumerate() {
            let mut para = Paragraph::with_text(l, CharProps::default()).styled("NoSpacing");
            para.props.indent_left = ret_left;
            para.props.space_before = Some(if i == 0 { ret_top.unwrap_or(0.0) } else { 0.0 });
            para.props.space_after = Some(0.0);
            blocks.push(para_block(para));
        }
        used = ret_lines.len() as f32 * LINE + ret_top.unwrap_or(0.0);
    }
    let left = pos("delivery", "left").unwrap_or(w * 0.42);
    let top = pos("delivery", "top").unwrap_or(h * 0.48);
    let to = lines(delivery);
    let to = if to.is_empty() { vec![String::new()] } else { to };
    for (i, l) in to.iter().enumerate() {
        let mut para = Paragraph::with_text(l, CharProps::default()).styled("NoSpacing");
        para.props.indent_left = Some((left - left_margin).max(0.0));
        para.props.space_before = Some(if i == 0 { (top - top_margin - used).max(0.0) } else { 0.0 });
        para.props.space_after = Some(0.0);
        blocks.push(para_block(para));
    }
    blocks
}

/// Envelopes: a landscape page with the return address at the top left and the delivery address
/// in the middle. As a new document, or (`add`) as a section of its own at the start of this one,
/// in place of an envelope added before.
pub(super) fn envelopes(s: &mut Session, v: &Value) -> CmdResult {
    if p::bool(v, "add") == Some(true) {
        let (blocks, sect, w, h) = envelope_parts(s, v, &s.doc.last_section.clone())?;
        // The envelope's own section ends with its last address line.
        let mut blocks = blocks;
        if let Some(Block::Para(end)) = blocks.last_mut().map(std::sync::Arc::make_mut) {
            end.section = Some(Box::new(sect));
        }
        // An envelope added before: its blocks, up to the paragraph that ends its section.
        let old = match s.doc.body.iter().position(|b| matches!(&**b, Block::Para(p) if p.section.is_some())) {
            Some(i) if matches!(&*s.doc.body[i], Block::Para(p) if p.section.as_deref().is_some_and(is_envelope)) => i + 1,
            _ => 0,
        };
        let n = blocks.len();
        s.doc.body.splice(0..old, blocks);
        s.sel = Selection::caret(s.doc.start_of(StoryRef::Body));
        return Ok(json!({"width": w, "height": h, "added": n}));
    }
    let (d, info) = envelope_document(s, v)?;
    s.add_document(d);
    Ok(info)
}

/// The envelope `v` asks for: its paragraphs, its section (from `base`) and its size.
fn envelope_parts(s: &Session, v: &Value, base: &SectionProps) -> Result<(Blocks, SectionProps, f32, f32), CmdError> {
    let delivery = label_text(v, "delivery")?.unwrap_or_else(|| {
        if mm(s).active.is_empty() { "Recipient Name\nStreet Address\nCity, ST 00000".into() } else { address_block(mm(s), mm(s).record as usize) }
    });
    let ret = label_text(v, "return")?.unwrap_or_default();
    let (w, h) = envelope_size(v)?;
    Ok((envelope_blocks(w, h, v.get("envelope"), &delivery, &ret), envelope_section(base, w, h), w, h))
}

/// Envelopes' new document: the envelope on a page of its own.
pub(super) fn envelope_document(s: &Session, v: &Value) -> Result<(Document, Value), CmdError> {
    let (blocks, sect, w, h) = envelope_parts(s, v, &SectionProps::default())?;
    let mut d = Document::new();
    d.last_section = sect;
    d.body = blocks;
    Ok((d, json!({"width": w, "height": h})))
}

/// A sheet of labels: the label size, how many across and down, and where the first one sits.
/// Lengths in points; the pitch is from one label's edge to the next one's.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LabelProduct {
    pub id: &'static str,
    /// What the labels are for: `address`, `shipping` or `return`.
    pub kind: &'static str,
    /// Letter or A4.
    pub paper: &'static str,
    pub cols: usize,
    pub rows: usize,
    pub width: f32,
    pub height: f32,
    pub top: f32,
    pub side: f32,
    pub h_pitch: f32,
    pub v_pitch: f32,
}

const MM: f32 = 72.0 / 25.4;

/// Common label sheets (the sizes are the industry's; the names are ours).
pub const LABEL_PRODUCTS: [LabelProduct; 9] = [
    LabelProduct {
        id: "letter-3x10",
        kind: "address",
        paper: "Letter",
        cols: 3,
        rows: 10,
        width: 189.0,
        height: 72.0,
        top: 36.0,
        side: 13.5,
        h_pitch: 198.0,
        v_pitch: 72.0,
    },
    LabelProduct {
        id: "letter-2x10",
        kind: "address",
        paper: "Letter",
        cols: 2,
        rows: 10,
        width: 288.0,
        height: 72.0,
        top: 36.0,
        side: 11.25,
        h_pitch: 301.5,
        v_pitch: 72.0,
    },
    LabelProduct {
        id: "letter-2x7",
        kind: "address",
        paper: "Letter",
        cols: 2,
        rows: 7,
        width: 288.0,
        height: 96.0,
        top: 60.0,
        side: 11.25,
        h_pitch: 301.5,
        v_pitch: 96.0,
    },
    LabelProduct {
        id: "letter-2x5",
        kind: "shipping",
        paper: "Letter",
        cols: 2,
        rows: 5,
        width: 288.0,
        height: 144.0,
        top: 36.0,
        side: 11.25,
        h_pitch: 301.5,
        v_pitch: 144.0,
    },
    LabelProduct {
        id: "letter-4x20",
        kind: "return",
        paper: "Letter",
        cols: 4,
        rows: 20,
        width: 126.0,
        height: 36.0,
        top: 36.0,
        side: 21.6,
        h_pitch: 147.6,
        v_pitch: 36.0,
    },
    LabelProduct {
        id: "a4-3x7",
        kind: "address",
        paper: "A4",
        cols: 3,
        rows: 7,
        width: 63.5 * MM,
        height: 38.1 * MM,
        top: 15.15 * MM,
        side: 7.21 * MM,
        h_pitch: 66.04 * MM,
        v_pitch: 38.1 * MM,
    },
    LabelProduct {
        id: "a4-2x7",
        kind: "address",
        paper: "A4",
        cols: 2,
        rows: 7,
        width: 99.1 * MM,
        height: 38.1 * MM,
        top: 15.15 * MM,
        side: 4.65 * MM,
        h_pitch: 101.6 * MM,
        v_pitch: 38.1 * MM,
    },
    LabelProduct {
        id: "a4-3x8",
        kind: "address",
        paper: "A4",
        cols: 3,
        rows: 8,
        width: 63.5 * MM,
        height: 33.9 * MM,
        top: 12.9 * MM,
        side: 7.21 * MM,
        h_pitch: 66.04 * MM,
        v_pitch: 33.9 * MM,
    },
    LabelProduct {
        id: "a4-2x4",
        kind: "shipping",
        paper: "A4",
        cols: 2,
        rows: 4,
        width: 99.1 * MM,
        height: 67.7 * MM,
        top: 13.1 * MM,
        side: 4.65 * MM,
        h_pitch: 101.6 * MM,
        v_pitch: 67.7 * MM,
    },
];

impl LabelProduct {
    pub fn by_id(id: &str) -> Option<&'static LabelProduct> {
        LABEL_PRODUCTS.iter().find(|p| p.id == id)
    }
    /// Label size as people say it: inches on Letter, millimetres on A4.
    pub fn size_text(&self) -> String {
        if self.paper == "A4" {
            format!("{:.1} × {:.1} mm", self.width / MM, self.height / MM)
        } else {
            let i = |pt: f32| format!("{}", ((pt / 72.0) * 1000.0).round() / 1000.0);
            format!("{}\" × {}\"", i(self.width), i(self.height))
        }
    }
}

/// A sheet of labels to lay out: a product, or Label Options' label by its sizes.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Sheet {
    cols: usize,
    rows: usize,
    width: f32,
    height: f32,
    top: f32,
    side: f32,
    h_pitch: f32,
    v_pitch: f32,
    page_w: f32,
    page_h: f32,
}

impl From<&LabelProduct> for Sheet {
    fn from(p: &LabelProduct) -> Self {
        let (page_w, page_h) = if p.paper == "A4" { (595.3, 841.9) } else { (612.0, 792.0) };
        Sheet {
            cols: p.cols,
            rows: p.rows,
            width: p.width,
            height: p.height,
            top: p.top,
            side: p.side,
            h_pitch: p.h_pitch,
            v_pitch: p.v_pitch,
            page_w,
            page_h,
        }
    }
}

/// The sheet `v` names: `label` (Label Options' value: `w`, `h`, `across`, `down`, `top`, `side`, `vPitch`, `hPitch` and
/// `page` {`w`, `h`}, points), else `product`, else the first product; `rows` and `cols` override its counts.
fn sheet_of(v: &Value) -> Result<Sheet, CmdError> {
    let mut sheet = match (v.get("label").filter(|l| l.is_object()), p::str(v, "product")) {
        (Some(l), _) => {
            let num = |k: &str| p::f32(l, k).filter(|n| n.is_finite() && *n >= 0.0);
            let need = |k: &str| num(k).ok_or_else(|| CmdError::Params(format!("`label` needs `{k}`")));
            let page = l.get("page");
            let (width, height) = (need("w")?.clamp(9.0, 1584.0), need("h")?.clamp(9.0, 1584.0));
            Sheet {
                cols: num("across").unwrap_or(1.0).clamp(1.0, 10.0) as usize,
                rows: num("down").unwrap_or(1.0).clamp(1.0, 40.0) as usize,
                width,
                height,
                top: num("top").unwrap_or(0.0).min(1584.0),
                side: num("side").unwrap_or(0.0).min(1584.0),
                h_pitch: num("hPitch").unwrap_or(width).clamp(width, 1584.0),
                v_pitch: num("vPitch").unwrap_or(height).clamp(height, 1584.0),
                page_w: page.and_then(|x| p::f32(x, "w")).unwrap_or(612.0).clamp(72.0, 1584.0),
                page_h: page.and_then(|x| p::f32(x, "h")).unwrap_or(792.0).clamp(72.0, 1584.0),
            }
        }
        (None, Some(id)) => Sheet::from(LabelProduct::by_id(id).ok_or_else(|| CmdError::Params(format!("unknown label product `{id}`")))?),
        (None, None) => Sheet::from(&LABEL_PRODUCTS[0]),
    };
    if let Some(n) = p::u64(v, "rows") {
        sheet.rows = n.clamp(1, 40) as usize;
    }
    if let Some(n) = p::u64(v, "cols") {
        sheet.cols = n.clamp(1, 10) as usize;
    }
    Ok(sheet)
}

/// The page of `sheet`: its paper, the top and side margins, no bottom margin, header or footer, from `base`.
fn sheet_section(sheet: &Sheet, base: &SectionProps) -> SectionProps {
    SectionProps {
        page_w: sheet.page_w,
        page_h: sheet.page_h,
        landscape: sheet.page_w > sheet.page_h,
        margin_top: sheet.top,
        margin_bottom: 0.0,
        margin_left: sheet.side,
        margin_right: (sheet.page_w - sheet.side - sheet.h_pitch * (sheet.cols - 1) as f32 - sheet.width).max(0.0),
        header: 0.0,
        footer: 0.0,
        gutter: 0.0,
        ..base.clone()
    }
}

/// One sheet as Word lays labels out: a fixed table without borders whose label cells are the label's size, with narrow
/// spacer columns and rows for the gaps between labels. `cell(i)` gives label `i`'s paragraphs (0 = top left, row by row);
/// `valign` places them down the label.
fn sheet_table(sheet: &Sheet, valign: Option<ew_doc::props::VAlign>, mut cell: impl FnMut(usize) -> Blocks) -> Table {
    let h_gap = (sheet.h_pitch - sheet.width).max(0.0);
    let v_gap = (sheet.v_pitch - sheet.height).max(0.0);
    let (rows, cols) = (sheet.rows, sheet.cols);
    // Grid columns: label, gap, label, …; rows likewise.
    let grid_cols: Vec<Option<usize>> = (0..cols).flat_map(|c| [Some(c)].into_iter().chain((c + 1 < cols && h_gap > 0.5).then_some(None))).collect();
    let grid_rows: Vec<Option<usize>> = (0..rows).flat_map(|r| [Some(r)].into_iter().chain((r + 1 < rows && v_gap > 0.5).then_some(None))).collect();
    let width: f32 = grid_cols.iter().map(|c| if c.is_some() { sheet.width } else { h_gap }).sum();
    let mut t = Table::new(grid_rows.len(), grid_cols.len(), width);
    t.props.style = None;
    t.props.borders = Some(ew_doc::props::Borders::default());
    t.props.fixed = true;
    t.grid = grid_cols.iter().map(|c| if c.is_some() { sheet.width } else { h_gap }).collect();
    for (row, r) in t.rows.iter_mut().zip(&grid_rows) {
        row.props.height = Some(if r.is_some() { sheet.height } else { v_gap });
        row.props.height_rule = ew_doc::props::HeightRule::Exact;
        for (c_cell, c) in row.cells.iter_mut().zip(&grid_cols) {
            c_cell.props.width = Some(if c.is_some() { sheet.width } else { h_gap });
            let (Some(r), Some(c)) = (r, c) else { continue };
            c_cell.props.valign = valign;
            c_cell.blocks = cell(r * cols + c);
        }
    }
    t
}

/// A label's paragraphs for `text` (its lines), centred down the label and indented from its left edge.
fn label_lines(text: &str) -> Blocks {
    text.split('\n')
        .take(20)
        .map(|l| {
            let mut p = Paragraph::with_text(l, CharProps::default()).styled("NoSpacing");
            p.props.align = Some(Align::Left);
            p.props.indent_left = Some(9.0);
            para_block(p)
        })
        .collect()
}

/// A Next Record field (Word's «Next Record»): a label merge's later labels start with one.
fn next_field() -> InlineObject {
    InlineObject::Field { instr: "NEXT".into(), result: String::new(), locked: false, dirty: false, code: false, form: String::new() }
}

/// A paragraph holding a Next Record field.
fn next_record() -> Paragraph {
    let mut para = Paragraph::new().styled("NoSpacing");
    let _ = para.insert_object(0, next_field(), &CharProps::default());
    para
}

/// Labels: a new document with a table of labels laid out like the sheet (`product` or `label`; spacer
/// columns and rows stand for the gaps). A full page of the same `text`, as many sheets as
/// needed for one label per recipient, or (`single`: `{"row", "col"}`, from 1) one label
/// at that place on the sheet.
pub(super) fn labels(s: &mut Session, v: &Value) -> CmdResult {
    let (d, info) = label_document(s, v)?;
    s.add_document(d);
    Ok(info)
}

/// The document Labels makes (see [`labels`]) and what it holds.
pub(super) fn label_document(s: &Session, v: &Value) -> Result<(Document, Value), CmdError> {
    let sheet = sheet_of(v)?;
    let m = mm(s);
    let single = v.get("single").filter(|x| !x.is_null()).map(|x| {
        let at = |k: &str| x.get(k).and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
        (at("row").min(sheet.rows), at("col").min(sheet.cols))
    });
    let from_rec = single.is_none() && p::bool(v, "fromRecipients").unwrap_or(!m.active.is_empty() && p::str(v, "text").is_none());
    let text = label_text(v, "text")?.unwrap_or_else(|| "Name\nAddress\nCity, ST 00000".into());
    let mut d = Document::new();
    d.last_section = sheet_section(&sheet, &d.last_section);
    let per_sheet = sheet.rows * sheet.cols;
    let sheets = if from_rec { m.active.len().div_ceil(per_sheet).max(1) } else { 1 };
    let mut made = 0usize;
    d.body.clear();
    for n in 0..sheets {
        let t = sheet_table(&sheet, Some(ew_doc::props::VAlign::Center), |i| {
            let content = match single {
                Some((sr, sc)) if (sr, sc) != (i / sheet.cols + 1, i % sheet.cols + 1) => String::new(),
                _ if from_rec => {
                    let k = n * per_sheet + i;
                    if k < m.active.len() { address_block(m, k) } else { String::new() }
                }
                _ => text.clone(),
            };
            made += usize::from(!content.is_empty());
            label_lines(&content)
        });
        d.body.push(std::sync::Arc::new(Block::Table(t)));
        let mut end = Paragraph::new();
        if n + 1 < sheets {
            // End each sheet with the same next-page section, so the next table
            // starts at the product's top margin without a leading blank line.
            end.section = Some(Box::new(d.last_section.clone()));
        }
        d.body.push(para_block(end));
    }
    d.ensure_nonempty();
    Ok((d, json!({"labels": if single.is_some() { 1 } else { sheets * per_sheet }, "filled": made, "product": p::str(v, "product").unwrap_or(LABEL_PRODUCTS[0].id)})))
}

/// Start Mail Merge as envelopes or labels with their options (`envelope`, `label`): the page becomes the envelope, with the
/// return address and an empty delivery address to put the Address Block in, or one sheet of the label with a Next Record
/// field in every label but the first. The body is replaced (undo brings it back); the options are kept for the dialogs.
pub(super) fn start_layout(s: &mut Session, kind: &str, v: &Value) -> Result<(), CmdError> {
    match kind {
        "envelopes" if v.get("envelope").is_some_and(Value::is_object) => {
            let ret = label_text(v, "return")?.unwrap_or_default();
            let (w, h) = envelope_size(v)?;
            s.doc.body = envelope_blocks(w, h, v.get("envelope"), "", &ret);
            s.doc.last_section = envelope_section(&s.doc.last_section, w, h);
            mm_mut(s).envelope = v.get("envelope").cloned();
        }
        "labels" if v.get("label").is_some_and(Value::is_object) => {
            let sheet = sheet_of(v)?;
            let t = sheet_table(&sheet, None, |i| vec![para_block(if i == 0 { Paragraph::new().styled("NoSpacing") } else { next_record() })]);
            s.doc.body = vec![std::sync::Arc::new(Block::Table(t)), para_block(Paragraph::new())];
            s.doc.last_section = sheet_section(&sheet, &s.doc.last_section);
            mm_mut(s).label = v.get("label").cloned();
        }
        _ => return Ok(()),
    }
    s.sel = Selection::caret(s.doc.start_of(StoryRef::Body));
    Ok(())
}

/// Update Labels: the first label's content, after a Next Record field, in every other label of the first table (the cells
/// of the first label's width and height: the spacer cells between labels stay empty). A first label that starts with Next
/// Record is copied without it.
pub(super) fn update_labels(s: &mut Session, _: &Value) -> CmdResult {
    let Some(i) = s.doc.body.iter().position(|b| matches!(&**b, Block::Table(_))) else {
        return Err(CmdError::Failed("there is no label table to update".into()));
    };
    let Block::Table(t) = std::sync::Arc::make_mut(&mut s.doc.body[i]) else { return Err(CmdError::Failed("no table".into())) };
    let is_next = |o: &InlineObject| matches!(o, InlineObject::Field { instr, .. } if instr.trim().eq_ignore_ascii_case("NEXT"));
    let (Some(first_row), Some(first)) = (t.rows.first(), t.rows.first().and_then(|r| r.cells.first())) else {
        return Err(CmdError::Failed("the label table is empty".into()));
    };
    let (w, h) = (first.props.width.unwrap_or(0.0), first_row.props.height.unwrap_or(0.0));
    let mut copy = first.blocks.clone();
    if let Some(Block::Para(p)) = copy.first_mut().map(std::sync::Arc::make_mut)
        && let Some(off) = p.object_offsets().into_iter().next().filter(|off| *off == 0)
        && p.object_at(off).is_some_and(is_next)
    {
        let _ = p.delete(0, ew_doc::para::OBJ.len_utf8());
    }
    let same = |a: Option<f32>, b: f32| (a.unwrap_or(0.0) - b).abs() < 0.5;
    let mut updated = 0usize;
    for (r, row) in t.rows.iter_mut().enumerate() {
        if !same(row.props.height, h) {
            continue;
        }
        for (c, cell) in row.cells.iter_mut().enumerate() {
            if (r, c) == (0, 0) || !same(cell.props.width, w) {
                continue;
            }
            let mut blocks = copy.clone();
            match blocks.first_mut().map(std::sync::Arc::make_mut) {
                Some(Block::Para(p)) => {
                    let props = p.props_at(0).clone();
                    let _ = p.insert_object(0, next_field(), &props);
                }
                _ => blocks.insert(0, para_block(next_record())),
            }
            cell.blocks = blocks;
            updated += 1;
        }
    }
    refresh(s);
    Ok(json!({"labels": updated + 1}))
}
