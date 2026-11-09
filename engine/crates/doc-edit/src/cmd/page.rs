//! Layout tab: page setup (margins, orientation, size, columns), breaks, line numbers, hyphenation.

use serde_json::{Value, json};
use ew_doc::props::{Border, Borders};
use ew_doc::section::{
    Columns, DocGrid, DocGridType, LineNumbering, MAX_CHAR_SPACE, MAX_GRID_PITCH, MAX_NOTE_START, MIN_GRID_PITCH, SectionProps, SectionStart,
};
use ew_doc::{Block, Pos, StoryRef};

use super::sel_result;
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

pub fn specs() -> Vec<CommandSpec> {
    let mut v = background::specs();
    v.extend(page_specs());
    v
}

fn page_specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("layout.margins", "Margins", "Layout › Page Setup", margins).params(
            r#"{"preset"?: "normal|narrow|moderate|wide|mirrored|office2003", "top"?: pt, "bottom"?: pt, "left"?: pt, "right"?: pt, "gutter"?: pt, "mirror"?: bool}"#,
        )
        .state(|s| {
            let x = sect(s);
            let v = json!({"preset": margins_preset_at(s), "top": x.margin_top, "bottom": x.margin_bottom, "left": x.margin_left,
                "right": x.margin_right, "gutter": x.gutter, "mirror": s.doc.settings.mirror_margins});
            (Value::Null, v)
        }),
        CommandSpec::new("layout.orientation", "Orientation", "Layout › Page Setup", |s, v| {
            let land = match p::str(v, "value") {
                Some("landscape") => true,
                Some("portrait") => false,
                _ => !sect(s).landscape,
            };
            with_sect(s, |x| x.set_landscape(land))
        })
        .params(r#"{"value": "portrait|landscape"}"#)
        .state(|s| (Value::Null, json!(if sect(s).landscape { "landscape" } else { "portrait" }))),
        CommandSpec::new("layout.size", "Size", "Layout › Page Setup", size).params(r#"{"name"?: "Letter|Legal|A4|…", "width"?: pt, "height"?: pt} (each side clamped to 7.2–1584 pt, 0.1–22 in; the section keeps its orientation)"#)
            .state(|s| {
                let x = sect(s);
                (Value::Null, json!({"width": x.page_w, "height": x.page_h}))
            }),
        CommandSpec::new("layout.columns", "Columns", "Layout › Page Setup", columns)
            .params(
                r#"{"count": 1-12, "space"?: pt, "separator"?: bool, "preset"?: "left|right", "widths"?: [[width pt, space after pt], …] (unequal columns; sets the count), "apply"?: "section|document|forward|selection"} (default: selection when text is selected in the main text — section breaks around it — else section)"#,
            )
            .state(|s| {
                let mut v = serde_json::to_value(sect(s).columns).unwrap_or(Value::Null);
                if let Some(o) = v.as_object_mut() {
                    o.insert("preset".into(), json!(columns_preset_at(s)));
                }
                (Value::Null, v)
            }),
        CommandSpec::new("layout.break", "Breaks", "Layout › Page Setup", breaks)
            .params(r#"{"kind": "page|column|textWrapping|nextPage|continuous|evenPage|oddPage"}"#),
        CommandSpec::new("layout.lineNumbers", "Line Numbers", "Layout › Page Setup", line_numbers).params(
            r#"{"value"?: "none|continuous|restartPage|restartSection", "start"?: 1-32767, "countBy"?: 1-100, "distance"?: pt (0 = auto)}"#,
        )
        .state(|s| (Value::Null, line_numbers_state(&sect(s)))),
        CommandSpec::new("layout.hyphenation", "Hyphenation", "Layout › Page Setup", hyphenation)
            .params(r#"{"value"?: bool (automatic; toggles when nothing is given), "zone"?: pt, "caps"?: bool (hyphenate words in capitals), "limit"?: n (consecutive hyphens, 0 = no limit)}"#)
            // The ribbon reads it here, never by running it: without a value the command toggles (stage2.md risks).
            .state(|s| {
                let st = &s.doc.settings;
                (json!(st.auto_hyphenation), json!({"value": st.auto_hyphenation, "zone": st.hyphenation_zone, "caps": st.hyphenate_caps, "limit": st.consecutive_hyphen_limit}))
            }),
        CommandSpec::new("layout.manualHyphenation", "Manual Hyphenation", "Layout › Page Setup › Hyphenation", manual_hyphenation)
            .params(r#"{"from"?: Pos (default: the caret)} → the next word at a line end that could be hyphenated: {"word", "pos", "points": [char index], "suggest": char index} or {"done": true}"#)
            .pure(),
        CommandSpec::new("layout.pageSetup", "Page Setup", "Layout › Page Setup", |s, v| {
            if let Some(patch) = v.get("patch") {
                return page_setup_patch(s, patch, v);
            }
            if let Some(props) = v.get("section") {
                let mut new: SectionProps = serde_json::from_value(props.clone()).map_err(|e| CmdError::Params(e.to_string()))?;
                validate_section(&mut new)?;
                // One section (the dialog's "This section"), never the others of the selection, and it keeps its own headers and
                // footers: the props were read from one section and must not overwrite another's part ids.
                return with_sect_at(s, v, |x| {
                    let (headers, footers) = (x.headers.clone(), x.footers.clone());
                    *x = new.clone();
                    (x.headers, x.footers) = (headers, footers);
                });
            }
            s.push_ui_request(json!({"open": "pageSetup"}));
            Ok(serde_json::to_value(sect(s)).unwrap_or(Value::Null))
        })
        .params(r#"{"patch"?: {SectionProps fields}, "apply"?: "section|whole|sections|forward|selected"} (Page Setup's Apply to: the fields given change in the caret's section (or "index"), every section, the selection's sections, a new section from the caret's paragraph on (a break of the patch's "start", else nextPage, unless the paragraph starts its section) or new sections around the selected paragraphs; each keeps its own headers and footers) → {"sections": [index]} | {"section"?: SectionProps, "index"?: n (the section by its 0-based index; default: the caret's)} (replaces that one section's properties, its own headers and footers kept; checked like Size, Margins, Columns, Line Numbers, Footnotes and Page Borders: non-finite numbers and margins that leave no room for text are refused; page sides 7.2–1584 pt, 1–12 columns with 0–300 pt gaps, header/footer/gutter 0–1584 pt, page border width 0.25–6 pt and distance 0–31 pt, note start 1–32767, line numbers start 1–32767, countBy 1–100, distance 0–1584 pt are clamped)"#),
        CommandSpec::new("layout.verticalAlign", "Vertical Alignment", "Layout › Page Setup › Layout", |s, v| {
            let va = ew_doc::section::PageVAlign::parse(p::str(v, "value").unwrap_or_default());
            with_sect(s, |x| x.valign = va)
        })
        .params(r#"{"value": "top|center|justify|bottom"} (also both|justified; anything else is top). Justified shares each page's spare room between its paragraphs and tables"#),
        CommandSpec::new("layout.sectionRtl", "Right-to-Left Section", "Layout › Page Setup", |s, v| {
            let on = p::bool(v, "value").unwrap_or(!sect(s).rtl);
            with_sect(s, |x| x.rtl = on)
        })
        .params(r#"{"value"?: bool} (true: the section's columns run right to left; without a value it toggles)"#),
        CommandSpec::new("layout.textDirection", "Text Direction", "Layout › Page Setup", text_direction).params(
            r#"{"value"?: "horizontal|down|rotate90|up|asian270", "all"?: bool} (down: Word's Vertical; rotate90 and up: all text, in a table cell or text box only; asian270: East Asian characters turned, not in a text box; without a value: the next one; all: every section)"#,
        )
        .state(|s| (Value::Null, direction_name(text_direction_at(s)))),
        CommandSpec::new("layout.differentFirstPage", "Different First Page", "Header & Footer › Options", |s, v| {
            let on = p::bool(v, "value").unwrap_or(!sect(s).title_page);
            with_sect(s, |x| x.title_page = on)
        })
        .params(r#"{"value"?: bool} (without a value it toggles)"#)
        .state(|s| (json!(sect(s).title_page), Value::Null)),
        CommandSpec::new("layout.differentOddEven", "Different Odd & Even Pages", "Header & Footer › Options", |s, v| {
            s.doc.settings.even_odd_headers = p::bool(v, "value").unwrap_or(!s.doc.settings.even_odd_headers);
            sel_result(s)
        })
        .params(r#"{"value"?: bool} (without a value it toggles)"#)
        .state(|s| (json!(s.doc.settings.even_odd_headers), Value::Null)),
        CommandSpec::new("layout.pageNumberFormat", "Format Page Numbers", "Insert › Header & Footer › Page Number", |s, v| {
            let fmt = p::str(v, "format").map(ew_doc::section::NumFormat::from_ooxml);
            with_sect(s, |x| {
                if let Some(f) = fmt {
                    x.page_num_format = f;
                }
                // Left out entirely: the numbering keeps its start. Given as null: the pages
                // number on from the section before (the dialog's "Continue from previous
                // section"). A number: numbering starts there.
                if v.get("start").is_some() {
                    x.page_num_start = p::u64(v, "start").map(|n| n.min(100_000) as u32);
                }
            })
        })
        .params(
            r#"{"format"?: "decimal|lowerRoman|upperRoman|lowerLetter|upperLetter", "start"?: n | null} ("start" left out: the numbering keeps its start; null: the pages number on from the section before; a number: numbering starts there)"#,
        )
        .state(|s| {
            let x = sect(s);
            (Value::Null, json!({"format": x.page_num_format, "start": x.page_num_start}))
        }),
        CommandSpec::new("layout.documentGrid", "Document Grid", "Layout › Page Setup › Document Grid", document_grid).params(
            r#"{"type"?: "none|lines|linesAndChars|snapToChars", "linesPerPage"?: n (sets the line pitch from the text height), "charsPerLine"?: n (sets the character pitch from the text width), "linePitch"?: pt, "charSpace"?: n (4096ths of a point added to the default font size: the character pitch), "index"?: n (that one section; default: the sections of the selection)} — left out stays as it is; returns the grid with its lines per page and characters per line"#,
        ),
        CommandSpec::new("layout.section", "Section Properties", "Layout › Page Setup", |s, v| {
            let index = match p::u64(v, "index") {
                Some(i) if (i as usize) < s.doc.sections().len() => i as usize,
                Some(i) => return Err(CmdError::Params(format!("no section {i}"))),
                None => section_index_of_focus(s),
            };
            let x = s.doc.sections().get(index).map(|(_, x)| (*x).clone()).unwrap_or_default();
            let mut out = serde_json::to_value(x).unwrap_or(Value::Null);
            let (first, last) = selected_sections(s);
            if let Some(o) = out.as_object_mut() {
                o.insert("index".into(), json!(index));
                o.insert("count".into(), json!(s.doc.sections().len()));
                o.insert("selection".into(), json!([first, last]));
                o.insert("collapsed".into(), json!(s.sel.is_collapsed()));
            }
            Ok(out)
        })
        .params(r#"{"index"?: n (a section by its 0-based index; default: the caret's)} → its SectionProps with its "index", the document's section "count", the first and last section of the selection ("selection": [first, last]) and whether it is "collapsed""#)
        .pure(),
        // The Layout tab's Paragraph group and the paragraph toggles the Layout tab shows (Suppress Line Numbers, Don't Hyphenate,
        // Drop Cap): the caret paragraph's resolved properties, read without a change (`para.indents`, `para.spacing` and
        // `para.set` write them).
        CommandSpec::new("layout.paragraph", "Paragraph State", "Layout › Paragraph", |s, _| Ok(paragraph_state(s)))
            .params(r#"{} → the caret paragraph's resolved properties (indentLeft, indentRight, indentFirst, spaceBefore, spaceAfter, dropCap, dropCapMargin, suppressHyphens, suppressLineNumbers, …) or null"#)
            .pure()
            .state(|s| (Value::Null, paragraph_state(s))),
    ]
}

/// The caret paragraph's resolved properties (null outside a paragraph).
fn paragraph_state(s: &Session) -> Value {
    s.doc.para_at(&s.sel.focus).map_or(Value::Null, |p| serde_json::to_value(s.doc.styles.resolve_para(&p.props)).unwrap_or(Value::Null))
}

/// Line Numbers' mode as `layout.lineNumbers` takes it: none, continuous, restartPage or restartSection.
fn line_numbers_state(x: &SectionProps) -> Value {
    use ew_doc::section::LineNumberRestart as R;
    json!(match x.line_numbers.as_ref().map(|l| l.restart) {
        None => "none",
        Some(R::Continuous) => "continuous",
        Some(R::Page) => "restartPage",
        Some(R::Section) => "restartSection",
    })
}

/// A text direction as `layout.textDirection` and `table.textDirection` take it.
pub(crate) fn direction_name(d: ew_doc::props::TextDirection) -> Value {
    use ew_doc::props::TextDirection as D;
    json!(match d {
        D::Horizontal => "horizontal",
        D::Down => "down",
        D::Rotate90 => "rotate90",
        D::Up => "up",
        D::Asian270 => "asian270",
    })
}

/// Line Numbers: on with a restart mode (`value`), or off (`none`). `start`, `countBy` and
/// `distance` change the numbering's options and turn it on (keeping its restart mode).
fn line_numbers(s: &mut Session, v: &Value) -> CmdResult {
    use ew_doc::section::LineNumberRestart as R;
    let mode = p::str(v, "value");
    if mode == Some("none") {
        return with_sect(s, |x| x.line_numbers = None);
    }
    let restart = match mode {
        Some("restartPage") => Some(R::Page),
        Some("restartSection") => Some(R::Section),
        Some("continuous") => Some(R::Continuous),
        Some(x) => return Err(CmdError::Params(format!("unknown value `{x}`"))),
        None => None,
    };
    let start = p::u64(v, "start").map(|n| n.clamp(1, 32_767) as u32);
    let count_by = p::u64(v, "countBy").map(|n| n.clamp(1, 100) as u32);
    let distance = p::f32(v, "distance").map(|d| d.clamp(0.0, 1584.0));
    let options = start.is_some() || count_by.is_some() || distance.is_some();
    with_sect(s, |x| {
        // Options alone keep the current numbering's other settings; a new mode alone starts over.
        let mut l = match (&x.line_numbers, options) {
            (Some(cur), true) => cur.clone(),
            (None, true) => LineNumbering { restart: R::Continuous, ..Default::default() },
            _ => LineNumbering::default(),
        };
        if let Some(r) = restart.or(if options { None } else { Some(R::Continuous) }) {
            l.restart = r;
        }
        if let Some(n) = start {
            l.start = n;
        }
        if let Some(n) = count_by {
            l.count_by = n;
        }
        if let Some(d) = distance {
            l.distance = d;
        }
        x.line_numbers = Some(l);
    })
}

/// Hyphenation: automatic on or off, and its options (Hyphenation Options).
fn hyphenation(s: &mut Session, v: &Value) -> CmdResult {
    let st = &mut s.doc.settings;
    let options = ["zone", "caps", "limit"].iter().any(|k| v.get(*k).is_some_and(|x| !x.is_null()));
    match p::bool(v, "value") {
        Some(on) => st.auto_hyphenation = on,
        None if !options => st.auto_hyphenation = !st.auto_hyphenation,
        None => {}
    }
    if let Some(z) = p::f32(v, "zone") {
        st.hyphenation_zone = z.clamp(0.0, 1584.0);
    }
    if let Some(c) = p::bool(v, "caps") {
        st.hyphenate_caps = c;
    }
    if let Some(n) = p::u64(v, "limit") {
        st.consecutive_hyphen_limit = n.min(32_767) as u32;
    }
    Ok(json!({"value": st.auto_hyphenation, "zone": st.hyphenation_zone, "caps": st.hyphenate_caps, "limit": st.consecutive_hyphen_limit}))
}

/// Manual hyphenation: the next word after `from` that starts a line after a line wrapped at a
/// space, and could end the line before it if hyphenated. `points` are where a hyphen may go
/// (char indices into `word`); `suggest` is the last one whose first part fits on that line.
/// Accepting is `caret.set` to `pos` plus the chosen point, then `text.optionalHyphen`.
fn manual_hyphenation(s: &mut Session, v: &Value) -> CmdResult {
    let from = match v.get("from") {
        Some(f) if !f.is_null() => super::parse_pos(f).ok_or_else(|| CmdError::Params("bad `from`".into()))?,
        _ => s.sel.ordered().0,
    };
    let lim = ew_proof::hyphen::Limits::default();
    let caps = s.doc.settings.hyphenate_caps;
    let layout = s.layout();
    let mut best: Option<(Pos, Value)> = None;
    for page in &layout.pages {
        for it in &page.items {
            let ew_doc_layout::Placed::Lines { story, path, para, l0, l1, .. } = it else { continue };
            if *story != StoryRef::Body {
                continue;
            }
            let Some(path) = &page.ids.doc_path(*story, path) else { continue };
            let Some(text) = s.doc.para_at(&Pos { story: *story, path: path.clone(), off: 0 }).map(|p| p.text.clone()) else { continue };
            for li in (*l0).max(1)..*l1 {
                let (Some(prev), Some(line)) = (para.lines.get(li - 1), para.lines.get(li)) else { continue };
                if prev.end != ew_doc_layout::LineEnd::Wrap || prev.hyphen.is_some() {
                    continue;
                }
                let at = Pos { story: *story, path: path.clone(), off: line.start };
                if at < from || best.as_ref().is_some_and(|(b, _)| *b <= at) {
                    continue;
                }
                let Some(rest) = text.get(line.start..) else { continue };
                let len = rest.char_indices().find(|(_, c)| !(c.is_alphabetic() || *c == '\'' || *c == '\u{2019}')).map_or(rest.len(), |(i, _)| i);
                let Some(word) = rest.get(..len) else { continue };
                // A word with an optional hyphen already breaks where its author said.
                if rest.get(len..).is_some_and(|r| r.starts_with('\u{ad}'))
                    || word.chars().count() < lim.min_word
                    || (!caps && word.chars().all(char::is_uppercase))
                {
                    continue;
                }
                let points = ew_proof::hyphen::hyphen_points(word, &lim);
                // The room left at the end of the line above, and the width of each first part.
                let room = prev.right - prev.end_x();
                let hyphen_w = para
                    .x_of(li, line.start)
                    .zip(para.x_of(li, line.start + word.chars().next().map_or(0, char::len_utf8)))
                    .map_or(6.0, |(a, b)| (b - a) * 0.6);
                let fits = |pt: usize| {
                    let bytes = word.char_indices().nth(pt).map_or(word.len(), |(i, _)| i);
                    match (para.x_of(li, line.start), para.x_of(li, line.start + bytes)) {
                        (Some(a), Some(b)) => (b - a) + hyphen_w <= room,
                        _ => false,
                    }
                };
                let Some(suggest) = points.iter().copied().filter(|pt| fits(*pt)).max() else { continue };
                best = Some((at.clone(), json!({"word": word, "pos": super::pos_json(&at), "points": points, "suggest": suggest})));
            }
        }
    }
    Ok(best.map(|(_, v)| v).unwrap_or_else(|| json!({"done": true})))
}

fn section_of_part(s: &Session, id: u32) -> usize {
    let sections = s.doc.sections();
    for (i, (_, sp)) in sections.iter().enumerate() {
        if [sp.headers.default, sp.headers.first, sp.headers.even, sp.footers.default, sp.footers.first, sp.footers.even].contains(&Some(id)) {
            return i;
        }
    }
    for (bi, block) in s.doc.body.iter().enumerate() {
        if let ew_doc::Block::Para(p) = &**block {
            for o in &p.objects {
                if matches!(o, ew_doc::para::InlineObject::NoteRef { id: nid, .. } if *nid == id) {
                    return s.doc.section_index_of(bi);
                }
            }
        }
    }
    0
}

pub fn section_index_of_focus(s: &Session) -> usize {
    match s.sel.focus.story {
        ew_doc::StoryRef::Body => s.doc.section_index_of(s.sel.focus.path.0.first().copied().unwrap_or(0) as usize),
        ew_doc::StoryRef::Part(id) => section_of_part(s, id),
    }
}

pub fn sect(s: &Session) -> SectionProps {
    let i = section_index_of_focus(s);
    s.doc.sections().get(i).map(|(_, x)| (*x).clone()).unwrap_or_default()
}

/// The last block of each section of the selection.
fn selected_section_ends(s: &Session) -> Vec<usize> {
    let (a, b) = s.sel.ordered();
    let ends: Vec<usize> = s.doc.sections().iter().map(|(e, _)| *e).collect();
    if a.story != ew_doc::StoryRef::Body || b.story != ew_doc::StoryRef::Body {
        let i = section_index_of_focus(s);
        return vec![ends.get(i).copied().unwrap_or(0)];
    }
    let (i0, i1) = (a.path.0.first().copied().unwrap_or(0) as usize, b.path.0.first().copied().unwrap_or(0) as usize);
    let first = ends.iter().position(|e| i0 <= *e).unwrap_or(0);
    let last = ends.iter().position(|e| i1 <= *e).unwrap_or(first);
    (first..=last).map(|k| ends.get(k).copied().unwrap_or(0)).collect()
}

/// Apply to the section(s) of the selection.
pub(crate) fn with_sect(s: &mut Session, f: impl Fn(&mut SectionProps)) -> CmdResult {
    for block in selected_section_ends(s) {
        f(s.doc.section_mut(block));
    }
    Ok(serde_json::to_value(sect(s)).unwrap_or(Value::Null))
}

/// Apply to section `index` of params `v` (0-based), or without one to the caret's section alone.
fn with_sect_at(s: &mut Session, v: &Value, f: impl Fn(&mut SectionProps)) -> CmdResult {
    let i = p::u64(v, "index").map_or_else(|| section_index_of_focus(s), |n| n as usize);
    let end = s.doc.sections().get(i).map(|(e, _)| *e).ok_or_else(|| CmdError::Params(format!("no section {i}")))?;
    f(s.doc.section_mut(end));
    Ok(serde_json::to_value(s.doc.sections()[i].1.clone()).unwrap_or(Value::Null))
}

/// The first and last section of the selection (both the caret's outside the main text).
fn selected_sections(s: &Session) -> (usize, usize) {
    let (a, b) = s.sel.ordered();
    if a.story != StoryRef::Body || b.story != StoryRef::Body {
        let i = section_index_of_focus(s);
        return (i, i);
    }
    let top = |p: &Pos| p.path.0.first().copied().unwrap_or(0) as usize;
    (s.doc.section_index_of(top(&a)), s.doc.section_index_of(top(&b)))
}

/// `section` with the fields of `patch` (camelCase SectionProps fields) over its own, checked as `layout.pageSetup` checks a
/// whole section; its headers and footers stay its own.
fn patched(section: &SectionProps, patch: &serde_json::Map<String, Value>) -> Result<SectionProps, CmdError> {
    let mut v = serde_json::to_value(section).map_err(|e| CmdError::Failed(e.to_string()))?;
    for (k, x) in patch {
        if k != "headers" && k != "footers" {
            v[k] = x.clone();
        }
    }
    let mut new: SectionProps = serde_json::from_value(v).map_err(|e| CmdError::Params(format!("patch: {e}")))?;
    validate_section(&mut new)?;
    (new.headers, new.footers) = (section.headers.clone(), section.footers.clone());
    Ok(new)
}

/// Page Setup's OK with Apply to (`layout.pageSetup {patch, apply}`): the sections it reaches, breaks put in first where This
/// point forward and Selected text need them, then the patch on each of those sections.
fn page_setup_patch(s: &mut Session, patch: &Value, v: &Value) -> CmdResult {
    let patch = patch.as_object().ok_or_else(|| CmdError::Params("patch: an object of section fields".into()))?;
    // Checked on the caret's section first, so a bad patch puts in no break.
    patched(&sect(s), patch)?;
    let kind = match patch.get("start").and_then(Value::as_str) {
        Some(k @ ("nextPage" | "continuous" | "evenPage" | "oddPage")) => k,
        _ => "nextPage",
    };
    let n = s.doc.sections().len();
    let targets: Vec<usize> = match p::str(v, "apply").unwrap_or("section") {
        "section" => vec![p::u64(v, "index").map_or_else(|| section_index_of_focus(s), |i| i as usize).min(n.saturating_sub(1))],
        "whole" => (0..n).collect(),
        "sections" => {
            let (a, b) = selected_sections(s);
            (a..=b).collect()
        }
        "forward" => {
            let a = s.sel.ordered().0;
            if a.story != StoryRef::Body || a.path.depth() > 0 {
                return Err(CmdError::Failed("This point forward starts in the main text, outside tables".into()));
            }
            let top = a.path.last();
            let i = s.doc.section_index_of(top);
            let first = i.checked_sub(1).and_then(|j| s.doc.sections().get(j).map(|(e, _)| e + 1)).unwrap_or(0);
            if top != first {
                // The break goes before the caret's paragraph, which then starts the new section.
                s.sel = Selection::caret(Pos { story: StoryRef::Body, path: ew_doc::Path::top(top), off: 0 });
                breaks(s, &json!({"kind": kind}))?;
            }
            vec![section_index_of_focus(s)]
        }
        "selected" => {
            // Whole paragraphs, as Word's Selected text works on them.
            let (a, b) = s.sel.ordered();
            if a.path.depth() == 0 && b.path.depth() == 0 && a.story == StoryRef::Body && b.story == StoryRef::Body {
                let end = s.doc.para(StoryRef::Body, &b.path).map_or(b.off, |q| q.len());
                s.sel = Selection { anchor: Pos { off: 0, ..a }, focus: Pos { off: end, ..b } };
            }
            selection_to_sections(s, kind)?;
            let (a, b) = selected_sections(s);
            (a..=b).collect()
        }
        x => return Err(CmdError::Params(format!("unknown apply `{x}` (section, whole, sections, forward or selected)"))),
    };
    let sections: Vec<(usize, SectionProps)> = s.doc.sections().iter().map(|(e, x)| (*e, (*x).clone())).collect();
    let mut out = Vec::new();
    for i in targets {
        let Some((end, cur)) = sections.get(i) else { continue };
        *s.doc.section_mut(*end) = patched(cur, patch)?;
        out.push(i);
    }
    Ok(json!({"sections": out}))
}

/// The text direction Layout › Text Direction would change: the caret cell's, the text box's,
/// or the section's.
pub fn text_direction_at(s: &Session) -> ew_doc::props::TextDirection {
    if let Some((tp, r, c)) = s.doc.cell_of(s.sel.focus.story, &s.sel.focus.path) {
        return s.doc.table(s.sel.focus.story, &tp).and_then(|t| t.rows.get(r)?.cells.get(c).map(|cl| cl.props.text_direction)).unwrap_or_default();
    }
    if let Some((_, id)) = super::objects::text_box_target(s) {
        return s.doc.parts.get(&id).map(|p| p.body.vert.turn()).unwrap_or_default();
    }
    sect(s).text_direction
}

/// Layout › Text Direction: like Word's button it works on what the caret is in — the selected
/// table cells, the text box, or else the section. Without a value it steps to the next direction.
fn text_direction(s: &mut Session, v: &Value) -> CmdResult {
    use ew_doc::props::{TextDirection, TextVert};
    let dir = match p::str(v, "value") {
        Some("horizontal" | "lrTb" | "horz") => Some(TextDirection::Horizontal),
        Some("down" | "vertical" | "tbRl" | "eaVert") => Some(TextDirection::Down),
        Some("rotate90" | "vert") => Some(TextDirection::Rotate90),
        Some("up" | "btLr" | "vert270" | "rotate270") => Some(TextDirection::Up),
        Some("asian270" | "lrTbV") => Some(TextDirection::Asian270),
        Some(x) => return Err(CmdError::Params(format!("unknown text direction `{x}`"))),
        None => None,
    };
    if s.doc.cell_of(s.sel.focus.story, &s.sel.focus.path).is_some() {
        let dir = dir.unwrap_or(text_direction_at(s).next());
        return super::table::text_direction(s, &json!({"value": direction_name(dir)}));
    }
    if super::objects::text_box_target(s).is_some() {
        let vert = match dir.unwrap_or(text_direction_at(s).next()) {
            TextDirection::Horizontal => TextVert::Horz,
            TextDirection::Down => TextVert::EaVert,
            TextDirection::Rotate90 => TextVert::Vert,
            TextDirection::Up => TextVert::Vert270,
            TextDirection::Asian270 => return Err(CmdError::Disabled("A text box cannot rotate East Asian characters.".into())),
        };
        return super::objects::set_text_body(s, |b| b.vert = vert);
    }
    let dir = dir.unwrap_or(if sect(s).text_direction.is_turned() { TextDirection::Horizontal } else { TextDirection::Down });
    if matches!(dir, TextDirection::Rotate90 | TextDirection::Up) {
        return Err(CmdError::Disabled("Rotate all text works in a table cell or a text box.".into()));
    }
    let apply = |x: &mut SectionProps| {
        if x.text_direction.is_turned() != dir.is_turned() {
            x.set_landscape(!x.landscape);
        }
        x.text_direction = dir;
    };
    if p::bool(v, "all") == Some(true) {
        let ends: Vec<usize> = s.doc.sections().iter().map(|(e, _)| *e).collect();
        for block in ends {
            apply(s.doc.section_mut(block));
        }
        return Ok(serde_json::to_value(sect(s)).unwrap_or(Value::Null));
    }
    with_sect(s, apply)
}

/// The default font size (Normal style), which the character pitch is based on.
fn grid_font_size(s: &Session) -> f32 {
    let size = s.doc.styles.resolve_char(Some("Normal"), &ew_doc::CharProps::default()).size;
    if size.is_finite() { size.clamp(1.0, 1584.0) } else { 10.5 }
}

fn grid_result(x: &SectionProps, font_size: f32) -> Value {
    let g = x.doc_grid.unwrap_or_default();
    json!({
        "type": if g.kind == DocGridType::Default { "none" } else { g.kind.ooxml() },
        "linePitch": g.line_pitch(),
        "charSpace": g.char_space,
        "charPitch": g.char_pitch(font_size),
        "linesPerPage": x.grid_lines_per_page(),
        "charsPerLine": x.grid_chars_per_line(font_size),
    })
}

/// Layout › Page Setup › Document Grid: the grid type, lines per page and characters per line.
fn document_grid(s: &mut Session, v: &Value) -> CmdResult {
    let kind = match p::str(v, "type") {
        None => None,
        Some("none" | "default") => Some(DocGridType::Default),
        Some(t) => Some(DocGridType::from_ooxml(t).ok_or_else(|| CmdError::Params(format!("unknown grid type `{t}`")))?),
    };
    let lines = p::u64(v, "linesPerPage").map(|n| n.clamp(1, 1000) as f32);
    let chars = p::u64(v, "charsPerLine").map(|n| n.clamp(1, 1000) as f32);
    let line_pitch = p::f32(v, "linePitch").map(|x| x.clamp(MIN_GRID_PITCH, MAX_GRID_PITCH));
    let char_space =
        v.get("charSpace").and_then(Value::as_f64).filter(|x| x.is_finite()).map(|x| x.clamp(-(MAX_CHAR_SPACE as f64), MAX_CHAR_SPACE as f64) as i32);
    let size = grid_font_size(s);
    if kind.is_none() && lines.is_none() && chars.is_none() && line_pitch.is_none() && char_space.is_none() {
        return Ok(grid_result(&sect(s), size));
    }
    let apply = |x: &mut SectionProps| {
        let mut g = x.doc_grid.unwrap_or_default();
        if let Some(k) = kind {
            g.kind = k;
        }
        if let Some(n) = lines {
            g.line_pitch = (x.text_height() / n).clamp(MIN_GRID_PITCH, MAX_GRID_PITCH);
        }
        if let Some(pt) = line_pitch {
            g.line_pitch = pt;
        }
        if let Some(n) = chars {
            g.char_space = DocGrid::char_space_for(x.text_width() / n, size);
        }
        if let Some(cs) = char_space {
            g.char_space = cs;
        }
        x.doc_grid = Some(g);
    };
    if let Some(i) = p::u64(v, "index") {
        with_sect_at(s, v, apply)?;
        return Ok(grid_result(s.doc.sections()[i as usize].1, size));
    }
    with_sect(s, apply)?;
    Ok(grid_result(&sect(s), size))
}

/// Layout › Margins presets: id and top, bottom, left, right in points.
pub const MARGIN_PRESETS: [(&str, [f32; 4]); 6] = [
    ("normal", [72.0, 72.0, 72.0, 72.0]),
    ("narrow", [36.0, 36.0, 36.0, 36.0]),
    ("moderate", [72.0, 72.0, 54.0, 54.0]),
    ("wide", [72.0, 72.0, 144.0, 144.0]),
    ("mirrored", [72.0, 72.0, 90.0, 72.0]),
    ("office2003", [72.0, 72.0, 90.0, 90.0]),
];

/// The Margins preset the caret's section is set to, if any (Mirrored only with mirror margins
/// on, the others only with it off), so the menu can mark it.
pub fn margins_preset_at(s: &Session) -> Option<&'static str> {
    let x = sect(s);
    let m = [x.margin_top, x.margin_bottom, x.margin_left, x.margin_right];
    MARGIN_PRESETS
        .iter()
        .find(|(id, p)| (*id == "mirrored") == s.doc.settings.mirror_margins && p.iter().zip(m).all(|(a, b)| (a - b).abs() < 0.5))
        .map(|(id, _)| *id)
}

/// The Columns preset the caret's section matches: `one`, `two`, `three` (equal columns), or
/// `left` / `right` (two columns, the narrower one on that side).
pub fn columns_preset_at(s: &Session) -> Option<&'static str> {
    let c = sect(s).columns;
    let first = c.widths.first().map(|w| w.0);
    let equal = c.widths.iter().all(|w| first.is_some_and(|f| (w.0 - f).abs() < 0.5));
    match (c.count, c.widths.as_slice()) {
        (1, _) => Some("one"),
        (2, [a, b]) if a.0 < b.0 - 0.5 => Some("left"),
        (2, [a, b]) if a.0 > b.0 + 0.5 => Some("right"),
        (2, _) if equal => Some("two"),
        (3, _) if equal => Some("three"),
        _ => None,
    }
}

/// Checks a whole section handed to `layout.pageSetup` by the rules of Size, Margins, Columns,
/// Line Numbers, Footnotes and Page Borders: a non-finite number or margins that leave no room
/// for text is an error; the rest is clamped to the ranges those commands use.
fn validate_section(x: &mut SectionProps) -> Result<(), CmdError> {
    let bad = |what: &str| CmdError::Params(format!("section: {what} must be a finite number"));
    let finite = [x.page_w, x.page_h, x.margin_top, x.margin_bottom, x.margin_left, x.margin_right, x.header, x.footer, x.gutter, x.columns.space];
    if finite.iter().any(|n| !n.is_finite()) {
        return Err(bad("sizes, margins, distances and column gaps"));
    }
    if x.columns.widths.iter().any(|(w, sp)| !w.is_finite() || !sp.is_finite()) {
        return Err(bad("column widths"));
    }
    if x.line_numbers.as_ref().is_some_and(|l| !l.distance.is_finite()) {
        return Err(bad("the line number distance"));
    }
    if x.doc_grid.as_ref().is_some_and(|g| !g.line_pitch.is_finite()) {
        return Err(bad("the grid pitch"));
    }
    if x.page_borders.as_ref().is_some_and(|b| border_sides(b).any(|d| !d.width.is_finite() || !d.space.is_finite())) {
        return Err(bad("page border widths and distances"));
    }
    x.page_w = x.page_w.clamp(MIN_PAGE_SIDE, MAX_PAGE_SIDE);
    x.page_h = x.page_h.clamp(MIN_PAGE_SIDE, MAX_PAGE_SIDE);
    // Like Size, the orientation follows the sides.
    if x.page_w != x.page_h {
        x.landscape = x.page_w > x.page_h;
    }
    x.margin_top = x.margin_top.max(0.0);
    x.margin_bottom = x.margin_bottom.max(0.0);
    x.margin_left = x.margin_left.max(0.0);
    x.margin_right = x.margin_right.max(0.0);
    x.header = x.header.clamp(0.0, x.page_h);
    x.footer = x.footer.clamp(0.0, x.page_h);
    x.gutter = x.gutter.clamp(0.0, MAX_PAGE_SIDE);
    // A page narrower than the usual text room (the smallest is 0.1") needs only margins that
    // leave the whole of it: zero margins, gutter included.
    let room = |side: f32| MIN_TEXT_ROOM.min(side);
    if x.margin_left + x.margin_right + x.gutter > x.page_w - room(x.page_w) || x.margin_top + x.margin_bottom > x.page_h - room(x.page_h) {
        return Err(CmdError::Params("margins leave no room for text".into()));
    }
    x.columns.space = x.columns.space.clamp(0.0, 300.0);
    x.columns.widths.truncate(12);
    for (w, sp) in &mut x.columns.widths {
        *w = w.clamp(18.0, MAX_PAGE_SIDE);
        *sp = sp.clamp(0.0, 300.0);
    }
    // As in Columns: custom widths set the count; a single width is no custom layout.
    if x.columns.widths.len() > 1 {
        x.columns.count = x.columns.widths.len() as u32;
    } else {
        x.columns.widths.clear();
        x.columns.count = x.columns.count.clamp(1, 12);
    }
    if let Some(l) = &mut x.line_numbers {
        l.start = l.start.clamp(1, 32_767);
        l.count_by = l.count_by.clamp(1, 100);
        l.distance = l.distance.clamp(0.0, 1584.0);
    }
    if let Some(g) = &mut x.doc_grid {
        g.line_pitch = g.line_pitch.clamp(MIN_GRID_PITCH, MAX_GRID_PITCH);
        g.char_space = g.char_space.clamp(-MAX_CHAR_SPACE, MAX_CHAR_SPACE);
    }
    x.page_num_start = x.page_num_start.map(|n| n.min(100_000));
    for n in [&mut x.footnote_pr, &mut x.endnote_pr] {
        n.num_start = n.num_start.map(|v| v.clamp(1, MAX_NOTE_START));
    }
    // Page Borders: width 0.25–6 pt, distance from the text 0–31 pt.
    if let Some(b) = &mut x.page_borders {
        for d in border_sides_mut(b) {
            d.width = d.width.clamp(0.25, 6.0);
            d.space = d.space.clamp(0.0, 31.0);
        }
    }
    Ok(())
}

fn border_sides(b: &Borders) -> impl Iterator<Item = &Border> {
    [&b.top, &b.left, &b.bottom, &b.right, &b.between, &b.inside_v].into_iter().flatten()
}

fn border_sides_mut(b: &mut Borders) -> impl Iterator<Item = &mut Border> {
    [&mut b.top, &mut b.left, &mut b.bottom, &mut b.right, &mut b.between, &mut b.inside_v].into_iter().flatten()
}

fn margins(s: &mut Session, v: &Value) -> CmdResult {
    let preset = p::str(v, "preset");
    let (t, b, l, r) = match preset {
        Some(x) => match MARGIN_PRESETS.iter().find(|(id, _)| *id == x) {
            Some((_, [t, b, l, r])) => (*t, *b, *l, *r),
            None => return Err(CmdError::Params(format!("unknown preset `{x}`"))),
        },
        None => {
            let c = sect(s);
            (
                p::f32(v, "top").unwrap_or(c.margin_top),
                p::f32(v, "bottom").unwrap_or(c.margin_bottom),
                p::f32(v, "left").unwrap_or(c.margin_left),
                p::f32(v, "right").unwrap_or(c.margin_right),
            )
        }
    };
    // Negative margins count as zero before the fit check, so one can't offset another.
    let (t, b, l, r) = (t.max(0.0), b.max(0.0), l.max(0.0), r.max(0.0));
    let gutter = p::f32(v, "gutter").map(|g| g.max(0.0));
    let cur = sect(s);
    if !margins_fit((cur.page_w, cur.page_h), (t, b, l, r), gutter.unwrap_or(cur.gutter)) {
        return Err(CmdError::Params("margins leave no room for text".into()));
    }
    // A preset picks mirrored or not, as does `mirror` (Page Setup's Multiple pages); plain numbers
    // alone (a ruler drag, an agent) keep the setting.
    if let Some(on) = p::bool(v, "mirror").or(preset.map(|k| k == "mirrored")) {
        s.doc.settings.mirror_margins = on;
    }
    with_sect(s, |x| {
        x.margin_top = t;
        x.margin_bottom = b;
        x.margin_left = l;
        x.margin_right = r;
        if let Some(g) = gutter {
            x.gutter = g;
        }
    })
}

/// Why `layout.size` refuses a page its margins don't fit.
pub const MARGINS_DONT_FIT: &str = "The margins don't fit on a page this size; make the margins smaller first.";

/// Text room the margins must leave on a page, each way, points.
pub const MIN_TEXT_ROOM: f32 = 36.0;

/// Whether margins (top, bottom, left, right) and a gutter leave text room on a page (width,
/// height), all in points: the rule `layout.margins` and `layout.size` both apply, and Page
/// Setup checks before it runs either.
pub fn margins_fit(page: (f32, f32), (t, b, l, r): (f32, f32, f32, f32), gutter: f32) -> bool {
    l + r + gutter <= page.0 - MIN_TEXT_ROOM && t + b <= page.1 - MIN_TEXT_ROOM
}

/// The smallest and largest page side, points (0.1" and 22", as Word allows).
pub const MIN_PAGE_SIDE: f32 = 7.2;
pub const MAX_PAGE_SIDE: f32 = 1584.0;

fn size(s: &mut Session, v: &Value) -> CmdResult {
    let (w, h) = if let Some(n) = p::str(v, "name") {
        let (_, w, h) = ew_geom::PAPER_SIZES
            .iter()
            .find(|(name, _, _)| name.eq_ignore_ascii_case(n))
            .ok_or_else(|| CmdError::Params(format!("unknown paper `{n}`")))?;
        (*w, *h)
    } else {
        (p::req_f32(v, "width")?, p::req_f32(v, "height")?)
    };
    // Word's range per side is 0.1"–22" (#1433); `p::f32` already refused NaN and infinities.
    let (w, h) = (w.clamp(MIN_PAGE_SIDE, MAX_PAGE_SIDE), h.clamp(MIN_PAGE_SIDE, MAX_PAGE_SIDE));
    // Each section keeps its orientation: the long side across in landscape, down in portrait.
    let oriented = |x: &SectionProps| if x.landscape { (w.max(h), w.min(h)) } else { (w.min(h), w.max(h)) };
    let sections = s.doc.sections();
    let fits = |block: usize| {
        sections
            .iter()
            .find(|(e, _)| *e == block)
            .is_none_or(|(_, x)| margins_fit(oriented(x), (x.margin_top, x.margin_bottom, x.margin_left, x.margin_right), x.gutter))
    };
    if !selected_section_ends(s).into_iter().all(fits) {
        return Err(CmdError::Params(MARGINS_DONT_FIT.into()));
    }
    with_sect(s, |x| (x.page_w, x.page_h) = oriented(x))
}

fn columns(s: &mut Session, v: &Value) -> CmdResult {
    let preset = p::str(v, "preset");
    let space = p::f32(v, "space").unwrap_or(36.0).clamp(0.0, 300.0);
    let sep = p::bool(v, "separator").unwrap_or(false);
    let tw = sect(s).text_width();
    // Unequal columns: (width, space after) each, as the Columns dialog sends them.
    let custom = match v.get("widths").filter(|w| !w.is_null()) {
        Some(w) => Some(column_widths(w, tw)?),
        None => None,
    };
    let count = match &custom {
        Some(c) => c.len() as u64,
        None => p::u64(v, "count").unwrap_or(match preset {
            Some("left") | Some("right") => 2,
            _ => 1,
        }),
    };
    if !(1..=12).contains(&count) {
        return Err(CmdError::Params("columns must be 1–12".into()));
    }
    let widths = match (custom, preset) {
        (Some(c), _) if c.len() > 1 => c,
        (Some(_), _) => Vec::new(),
        (None, Some("left")) => vec![((tw - space) / 3.0, space), ((tw - space) * 2.0 / 3.0, 0.0)],
        (None, Some("right")) => vec![((tw - space) * 2.0 / 3.0, space), ((tw - space) / 3.0, 0.0)],
        _ => Vec::new(),
    };
    // Equal columns keep one spacing; unequal ones remember the first gap for a later switch back.
    let space = widths.first().map(|w| w.1).unwrap_or(space);
    let cols = Columns { count: count as u32, space, separator: sep, widths };
    // With text selected the gallery works on that text, as in Word (#2024).
    let default = if selection_sectionable(s) { "selection" } else { "section" };
    match p::str(v, "apply").unwrap_or(default) {
        "section" => with_sect(s, |x| x.columns = cols.clone()),
        "document" => {
            let ends: Vec<usize> = s.doc.sections().iter().map(|(e, _)| *e).collect();
            for e in ends {
                s.doc.section_mut(e).columns = cols.clone();
            }
            Ok(serde_json::to_value(sect(s)).unwrap_or(Value::Null))
        }
        // From the caret on: a continuous section break first, then the new section's columns.
        "forward" => {
            let start = s.sel.ordered().0;
            s.sel = Selection::caret(start);
            breaks(s, &json!({"kind": "continuous"}))?;
            with_sect(s, |x| x.columns = cols.clone())
        }
        "selection" => {
            selection_to_sections(s, "continuous")?;
            with_sect(s, |x| x.columns = cols.clone())
        }
        x => Err(CmdError::Params(format!("unknown apply `{x}` (section, document, forward or selection)"))),
    }
}

/// Whether the selection can become sections of its own: text selected in the main text, outside
/// tables.
pub fn selection_sectionable(s: &Session) -> bool {
    let (a, b) = s.sel.ordered();
    !s.sel.is_collapsed() && [a, b].iter().all(|p| p.story == StoryRef::Body && p.path.depth() == 0)
}

/// Columns for the selected text (#2024), as Word does it: a continuous section break where the
/// selection starts and one where it ends, splitting paragraphs there, unless that end already
/// meets a section boundary (the document's start or end, or a section break). The selection keeps
/// its text, which is then the section(s) between.
fn selection_to_sections(s: &mut Session, kind: &str) -> Result<(), CmdError> {
    if !selection_sectionable(s) {
        return Err(CmdError::Params("selected text in the main text, outside tables, is needed".into()));
    }
    let old = s.sel.clone();
    let (a, mut b) = old.ordered();
    let block = |p: &Pos| p.path.0.first().copied().unwrap_or(0) as usize;
    let len = |s: &Session, p: &Pos| s.doc.para_at(p).map(|q| q.len()).unwrap_or(0);
    let ends: Vec<usize> = s.doc.sections().iter().map(|(e, _)| *e).collect();
    let after_break = |i: usize| i.checked_sub(1).is_some_and(|j| ends.contains(&j));
    // A selection that took a section break with it ends before that break.
    if b.off == 0 && block(&b) > block(&a) && after_break(block(&b)) {
        let prev = Pos { path: ew_doc::Path::top(block(&b) - 1), off: 0, ..b.clone() };
        b = Pos { off: len(s, &prev), ..prev };
    }
    let last_block = s.doc.body.len().saturating_sub(1);
    let end_break = !(b.off == len(s, &b) && (ends.contains(&block(&b)) || block(&b) == last_block));
    let start_break = !(a.off == 0 && (block(&a) == 0 || after_break(block(&a))));
    // The end first: the start's position doesn't move.
    if end_break {
        s.sel = Selection::caret(b.clone());
        breaks(s, &json!({"kind": kind}))?;
    }
    let (first, last) = if start_break {
        s.sel = Selection::caret(a.clone());
        breaks(s, &json!({"kind": kind}))?;
        let first = s.sel.focus.clone();
        let last = shifted_by_split(&b, &a, &first);
        (first, last)
    } else {
        (a, b)
    };
    s.sel = if old.anchor <= old.focus { Selection { anchor: first, focus: last } } else { Selection { anchor: last, focus: first } };
    Ok(())
}

/// `[[width, space after], …]` in points: 1–12 columns, each at least 0.25", that fit the text
/// width (`tw`).
fn column_widths(v: &Value, tw: f32) -> Result<Vec<(f32, f32)>, CmdError> {
    let bad = || CmdError::Params("widths: [[width, space after], …] in points, 1–12 columns".into());
    let a = v.as_array().filter(|a| (1..=12).contains(&a.len())).ok_or_else(bad)?;
    let mut out = Vec::with_capacity(a.len());
    for (i, c) in a.iter().enumerate() {
        let num = |k: usize| c.get(k).and_then(Value::as_f64).map(|x| x as f32).filter(|x| x.is_finite());
        let w = num(0).ok_or_else(bad)?;
        // The last column has no space after it.
        let sp = if i + 1 == a.len() { 0.0 } else { num(1).unwrap_or(0.0) };
        if w < 18.0 || !(0.0..=300.0).contains(&sp) {
            return Err(CmdError::Params("each column must be at least 0.25\" wide, with 0–300 pt after it".into()));
        }
        out.push((w, sp));
    }
    let total: f32 = out.iter().map(|(w, sp)| w + sp).sum();
    if total > tw + 1.0 {
        return Err(CmdError::Params(format!("the columns ({total:.0} pt) are wider than the text ({tw:.0} pt)")));
    }
    Ok(out)
}

fn breaks(s: &mut Session, v: &Value) -> CmdResult {
    let kind = p::str(v, "kind").unwrap_or("page");
    let start = match kind {
        "page" => return super::text::specs().iter().find(|c| c.id == "text.pageBreak").map(|c| (c.run)(s, v)).unwrap_or_else(|| sel_result(s)),
        "column" => return super::text::specs().iter().find(|c| c.id == "text.columnBreak").map(|c| (c.run)(s, v)).unwrap_or_else(|| sel_result(s)),
        "textWrapping" => return super::objects::text_wrapping_break(s, v),
        "nextPage" => SectionStart::NextPage,
        "continuous" => SectionStart::Continuous,
        "evenPage" => SectionStart::EvenPage,
        "oddPage" => SectionStart::OddPage,
        x => return Err(CmdError::Params(format!("unknown break `{x}`"))),
    };
    // A section break goes just before the selection and never replaces it, as in Word (#852:
    // selected text was deleted, so the first section lost its text).
    let old = s.sel.clone();
    let (at, end) = old.ordered();
    if at.story != ew_doc::StoryRef::Body || at.path.depth() > 0 {
        return Err(CmdError::Failed("section breaks go in the main text".into()));
    }
    // Section break: the paragraph before the caret ends a section with the current props; the
    // new section (after) takes them too and starts as requested.
    s.sel = Selection::caret(at.clone());
    let cur = sect(s);
    let new = match s.doc.split_paragraph(&at) {
        Ok(p) => p,
        Err(e) => {
            s.sel = old;
            return Err(e.into());
        }
    };
    let ended = at.path.clone();
    let para = s.doc.para_mut(at.story, &ended)?;
    let mut props = cur;
    // The start type belongs to the section that begins after the break.
    let next_block = new.path.last();
    para.section = Some(Box::new(props.clone()));
    props.start = start;
    *s.doc.section_mut(next_block) = props;
    // The selection keeps its text, which now starts the new section.
    let first = Pos { off: 0, ..new };
    let last = shifted_by_split(&end, &at, &first);
    s.sel = if old.anchor <= old.focus { Selection { anchor: first, focus: last } } else { Selection { anchor: last, focus: first } };
    let _ = Block::Para;
    sel_result(s)
}

/// Where `p` lands after the top-level body paragraph at `at` was split there, the second half
/// starting at `new`: later text in that paragraph moves into the new one, later blocks move down.
fn shifted_by_split(p: &Pos, at: &Pos, new: &Pos) -> Pos {
    if p.story != at.story {
        return p.clone();
    }
    if p.path == at.path {
        return if p.off >= at.off { Pos { off: p.off.saturating_sub(at.off), ..new.clone() } } else { p.clone() };
    }
    let mut q = p.clone();
    if let (Some(first), Some(i)) = (q.path.0.first_mut(), at.path.0.first())
        && *first > *i
    {
        *first = first.saturating_add(1);
    }
    q
}

mod background;
pub(crate) use background::watermark_box;

#[cfg(test)]
mod tests;

/// Commands that were registered with the tools' (cmd/tools/specs.rs) and belong to this file's area: the Stage 2.0
/// scaffold moved them (docs/plans/engine/stage2.md) so each file has one owner. cmd.rs registers them where they were.
pub fn more_specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec::new("layout.linkToPrevious", "Link to Previous", "Header & Footer › Navigation", link_to_previous)
            .key(crate::cmd::non_mac("Alt+Shift+R"))
            .params(r#"{"value"?: bool (true links, false unlinks keeping a copy of what showed; without one it toggles), "footer"?: bool (outside a header or footer: the caret section's footer, else its header)} → {"linked"}"#)
            // Pressed while the section the part was opened from shows its previous section's part (gap G15); off in the first
            // section, as Word's button is.
            .when(|s| (link_target(s, s.last_layout().as_deref()).0 == 0).then_some("the first section has no previous section to link to"))
            .state(|s| {
                let (i, slot, header) = link_target(s, s.last_layout().as_deref());
                (json!(i > 0 && s.sel.focus.story != StoryRef::Body && is_linked(s, i, slot, header)), Value::Null)
            }),
        CommandSpec::new("hf.next", "Next Section", "Header & Footer › Navigation", |s, _| hf_nav(s, 1)).when(|s| hf_nav_off(s, 1)).pure(),
        CommandSpec::new("hf.previous", "Previous Section", "Header & Footer › Navigation", |s, _| hf_nav(s, -1)).when(|s| hf_nav_off(s, -1)).pure(),
        // Show Document Text (Header & Footer › Options): off leaves the body out of the pages while a header or footer is edited.
        CommandSpec::new("hf.showDocumentText", "Show Document Text", "Header & Footer › Options", |s, v| {
            let on = p::bool(v, "value").unwrap_or(!s.view.show_document_text);
            set_show_document_text(s, on);
            Ok(json!({"value": on}))
        })
        .params(r#"{"value"?: bool (without one it toggles)}"#)
        .when(|s| hf_here_static(s).is_none().then_some("edit a header or footer first"))
        .state(|s| (json!(s.view.show_document_text), Value::Null))
        .pure(),
        // Word's Alt+Shift+R in a header or footer: the previous section's header (footer) copied in, without linking to it.
        CommandSpec::new("hf.copyPrevious", "Copy Previous Header or Footer", "Header & Footer › Navigation", copy_previous).when(|s| {
            match hf_here_static(s) {
                None => Some("edit a header or footer first"),
                Some((0, _, _)) => Some("the first section has no previous section"),
                Some(_) => None,
            }
        }),
        CommandSpec::new("hf.removePageNumbers", "Remove Page Numbers", "Insert › Header & Footer › Page Number", remove_page_numbers)
            .params(r#"{} (every PAGE field in the headers and footers goes, with Page X of Y's "Page " and " of NUMPAGES"; a paragraph left blank goes)"#)
            .when(|s| {
                let any = hf_parts(s).iter().any(|id| page_paras(s, *id).is_some() || super::insert::has_margin_numbers(s, *id));
                (!any).then_some("there are no page numbers to remove")
            }),
        CommandSpec::new("hf.position", "Header/Footer Position", "Header & Footer › Position", |s, v| {
            let (h, f) = (p::f32(v, "header"), p::f32(v, "footer"));
            let block = s.sel.focus.path.0.first().copied().unwrap_or(0) as usize;
            let sect = s.doc.section_mut(block);
            if let Some(h) = h {
                sect.header = h.clamp(0.0, 300.0);
            }
            if let Some(f) = f {
                sect.footer = f.clamp(0.0, 300.0);
            }
            Ok(json!({"header": sect.header, "footer": sect.footer}))
        })
        .params(r#"{"header"?: pt, "footer"?: pt}"#)
        .state(|s| {
            let x = sect(s);
            (Value::Null, json!({"header": x.header, "footer": x.footer}))
        }),
        CommandSpec::new("table.cellMargins", "Cell Margins", "Table Layout › Alignment", |s, v| {
            let Some((tp, _, _)) = s.doc.cell_of(s.sel.focus.story, &s.sel.focus.path) else { return Err(CmdError::Disabled("not in a table".into())) };
            let story = s.sel.focus.story;
            let current = {
                let table = s.doc.table(story, &tp).ok_or_else(|| CmdError::Failed("no table".into()))?;
                let style = table.props.style.as_deref().and_then(|id| s.doc.styles.table_style(id));
                table.props.cell_margins.or(style.and_then(|st| st.parts.cell_margins)).unwrap_or([0.0, 5.4, 0.0, 5.4])
            };
            let m = [
                p::f32(v, "top").unwrap_or(current[0]),
                p::f32(v, "left").unwrap_or(current[1]),
                p::f32(v, "bottom").unwrap_or(current[2]),
                p::f32(v, "right").unwrap_or(current[3]),
            ]
            .map(|x| x.clamp(0.0, 144.0));
            s.doc.table_mut(story, &tp)?.props.cell_margins = Some(m);
            for path in s.doc.para_paths(story).into_iter().filter(|p| p.0.starts_with(&tp.0) && p.0.len() > tp.0.len()) {
                s.doc.para_mut(story, &path)?.touch();
            }
            sel_result(s)
        })
        .params(r#"{"top"?, "left"?, "bottom"?, "right"? (pt)}"#),
        CommandSpec::new("table.borderPainter", "Border Painter", "Table Design › Borders", |s, v| {
            s.run(
                "table.borders",
                &json!({"kind": p::str(v, "kind").unwrap_or("all"), "width": p::f32(v, "width").unwrap_or(0.5), "color": p::str(v, "color")}),
            )
        }),
        CommandSpec::new("design.effects", "Effects", "Design › Document Formatting", |s, v| {
            s.doc.settings.theme_name =
                format!("{} ({})", s.doc.settings.theme_name.split(" (").next().unwrap_or("Craft"), p::str(v, "name").unwrap_or("Subtle"));
            sel_result(s)
        }),
    ]
}

/// Which of a section's headers or footers: the default, first page or even page one.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Slot {
    Default,
    First,
    Even,
}

fn slot_of(set: &ew_doc::section::HeaderSet, slot: Slot) -> Option<u32> {
    match slot {
        Slot::Default => set.default,
        Slot::First => set.first,
        Slot::Even => set.even,
    }
}

fn slot_mut(set: &mut ew_doc::section::HeaderSet, slot: Slot) -> &mut Option<u32> {
    match slot {
        Slot::Default => &mut set.default,
        Slot::First => &mut set.first,
        Slot::Even => &mut set.even,
    }
}

/// The header (`true`) or footer part the caret is in, with the section that holds it and its slot there (the first section
/// that names it), or None outside a header or footer. Without a layout: a linked section's header is its previous one's.
fn hf_here_static(s: &Session) -> Option<(usize, Slot, bool)> {
    let StoryRef::Part(cur) = s.sel.focus.story else { return None };
    let header = match s.doc.parts.get(&cur)?.kind {
        ew_doc::PartKind::Header => true,
        ew_doc::PartKind::Footer => false,
        _ => return None,
    };
    s.doc.sections().iter().enumerate().find_map(|(i, (_, x))| {
        let set = if header { &x.headers } else { &x.footers };
        [Slot::Default, Slot::First, Slot::Even].into_iter().find(|k| slot_of(set, *k) == Some(cur)).map(|k| (i, k, header))
    })
}

/// [`hf_here_static`] as the user sees it in layout `l`: the section and slot of the page the part was opened from (`page_hint`)
/// when that page shows it, so a section linked to the previous one counts as itself, as Word's Header & Footer tab does.
fn hf_here_in(s: &Session, l: Option<&ew_doc_layout::DocLayout>) -> Option<(usize, Slot, bool)> {
    let (owner, slot, header) = hf_here_static(s)?;
    let StoryRef::Part(cur) = s.sel.focus.story else { return None };
    let Some(pg) = l.and_then(|l| l.pages.get(s.page_hint)) else { return Some((owner, slot, header)) };
    let at = match pg.hf_slot {
        ew_doc_layout::HfSlot::First => Slot::First,
        ew_doc_layout::HfSlot::Even => Slot::Even,
        ew_doc_layout::HfSlot::Default => Slot::Default,
    };
    // The page shows the part, or its section does by the same-slot chain (a layout a change behind still names the section).
    let shows = (if header { pg.header_story } else { pg.footer_story }) == Some(cur) || shown_part(s, pg.section, at, header) == Some(cur);
    Some(if shows { (pg.section, at, header) } else { (owner, slot, header) })
}

/// [`hf_here_in`] with the layout made now.
fn hf_here(s: &mut Session) -> Option<(usize, Slot, bool)> {
    let l = s.layout();
    hf_here_in(s, Some(&l))
}

/// The section, slot and kind Link to Previous works on: the part being edited as [`hf_here_in`] sees it, else the caret
/// section's default header.
fn link_target(s: &Session, l: Option<&ew_doc_layout::DocLayout>) -> (usize, Slot, bool) {
    hf_here_in(s, l).unwrap_or_else(|| (section_index_of_focus(s), Slot::Default, true))
}

/// Whether section `i` shows its previous section's header (footer) in `slot`: it has none of its own there, or names the same
/// part (a break copies the section, header ids included).
fn is_linked(s: &Session, i: usize, slot: Slot, header: bool) -> bool {
    let Some((_, x)) = s.doc.sections().get(i).copied() else { return false };
    let own = slot_of(if header { &x.headers } else { &x.footers }, slot);
    own.is_none() || own == i.checked_sub(1).and_then(|j| shown_part(s, j, slot, header))
}

/// Show Document Text on or off. The pages are laid out again (their paragraphs kept), so the view's tiles repaint.
pub(crate) fn set_show_document_text(s: &mut Session, on: bool) {
    if s.view.show_document_text != on {
        s.view.show_document_text = on;
        s.fonts_changed();
    }
}

/// The part section `i` shows in `slot`: its own, else the nearest earlier section's (a missing first or even page part falls
/// back to that section's default only where Word does, which layout decides; this is the same-slot chain).
fn shown_part(s: &Session, i: usize, slot: Slot, header: bool) -> Option<u32> {
    let sections = s.doc.sections();
    (0..=i.min(sections.len().saturating_sub(1))).rev().find_map(|k| {
        let x = sections[k].1;
        slot_of(if header { &x.headers } else { &x.footers }, slot)
    })
}

/// Previous (-1) or Next (+1) Section in layout `l`: the part the nearest section before or after shows on its first page that
/// has one, and that page. Sections linked to the previous one count, as in Word, where they show the same part labelled with
/// their own section; Word stops at the first and last section.
fn hf_target(s: &Session, l: &ew_doc_layout::DocLayout, dir: i32) -> Result<(u32, usize), &'static str> {
    let (here, _, header) = hf_here_in(s, Some(l)).ok_or("edit a header or footer first")?;
    let n = s.doc.sections().len() as i64;
    let mut j = here as i64 + dir as i64;
    while (0..n).contains(&j) {
        let shown = l.pages.iter().enumerate().filter(|(_, pg)| pg.section as i64 == j).find_map(|(i, pg)| {
            let part = if header { pg.header_story } else { pg.footer_story };
            part.filter(|id| s.doc.parts.contains_key(id)).map(|id| (id, i))
        });
        if let Some(t) = shown {
            return Ok(t);
        }
        j += dir as i64;
    }
    Err(if dir > 0 { "this is the last section" } else { "this is the first section" })
}

fn hf_nav_off(s: &Session, dir: i32) -> Option<&'static str> {
    if hf_here_static(s).is_none() {
        return Some("edit a header or footer first");
    }
    s.last_layout().and_then(|l| hf_target(s, &l, dir).err())
}

fn hf_nav(s: &mut Session, dir: i32) -> CmdResult {
    let l = s.layout();
    let (next, page) = hf_target(s, &l, dir).map_err(|e| CmdError::Disabled(e.into()))?;
    s.sel = Selection::caret(s.doc.start_of(StoryRef::Part(next)));
    s.page_hint = page;
    sel_result(s)
}

/// Link to Previous: on, the section's own header (footer) in this slot goes and the previous section's shows; off, the
/// section gets a copy of what it showed, so editing it no longer changes the previous one (Word's).
fn link_to_previous(s: &mut Session, v: &Value) -> CmdResult {
    let (i, slot, header) = match hf_here(s) {
        Some(x) => x,
        None => (section_index_of_focus(s), Slot::Default, !p::bool(v, "footer").unwrap_or(false)),
    };
    if i == 0 {
        return Err(CmdError::Disabled("the first section has no previous section to link to".into()));
    }
    let ends: Vec<usize> = s.doc.sections().iter().map(|(e, _)| *e).collect();
    let own = {
        let x = s.doc.sections()[i].1;
        slot_of(if header { &x.headers } else { &x.footers }, slot)
    };
    let prev = shown_part(s, i - 1, slot, header);
    // A break copies the section, header ids included: naming the previous section's part is being linked to it.
    let own = own.filter(|id| Some(*id) != prev);
    let link = p::bool(v, "value").unwrap_or(own.is_some());
    if link {
        let sect = s.doc.section_mut(ends[i]);
        *slot_mut(if header { &mut sect.headers } else { &mut sect.footers }, slot) = None;
        if s.sel.focus.story != StoryRef::Body
            && let Some(id) = prev
        {
            s.sel = Selection::caret(s.doc.end_of(StoryRef::Part(id)));
        }
    } else if own.is_none() {
        let kind = if header { ew_doc::PartKind::Header } else { ew_doc::PartKind::Footer };
        let style = if header { "Header" } else { "Footer" };
        let blocks = prev
            .and_then(|id| s.doc.parts.get(&id).map(|p| p.blocks.clone()))
            .unwrap_or_else(|| vec![ew_doc::para_block(ew_doc::Paragraph::new().styled(style))]);
        let id = s.doc.add_part(kind, blocks);
        let sect = s.doc.section_mut(ends[i]);
        *slot_mut(if header { &mut sect.headers } else { &mut sect.footers }, slot) = Some(id);
        if s.sel.focus.story != StoryRef::Body {
            s.sel = Selection::caret(s.doc.end_of(StoryRef::Part(id)));
        }
    }
    Ok(json!({"linked": link}))
}

/// Alt+Shift+R: the previous section's header (footer) in this slot copied over the one being edited, as one undo step.
fn copy_previous(s: &mut Session, _: &Value) -> CmdResult {
    let (i, slot, header) = hf_here(s).ok_or_else(|| CmdError::Disabled("edit a header or footer first".into()))?;
    let StoryRef::Part(cur) = s.sel.focus.story else { return Err(CmdError::Disabled("edit a header or footer first".into())) };
    if i == 0 {
        return Err(CmdError::Disabled("the first section has no previous section".into()));
    }
    let prev = shown_part(s, i - 1, slot, header).filter(|id| *id != cur);
    let style = if header { "Header" } else { "Footer" };
    let blocks = prev
        .and_then(|id| s.doc.parts.get(&id).map(|p| p.blocks.clone()))
        .unwrap_or_else(|| vec![ew_doc::para_block(ew_doc::Paragraph::new().styled(style))]);
    s.doc.set_story(StoryRef::Part(cur), blocks)?;
    s.sel = Selection::caret(s.doc.end_of(StoryRef::Part(cur)));
    sel_result(s)
}

/// Every header and footer part the sections name.
fn hf_parts(s: &Session) -> Vec<u32> {
    let mut ids: Vec<u32> = Vec::new();
    for (_, x) in s.doc.sections() {
        for id in [x.headers.default, x.headers.first, x.headers.even, x.footers.default, x.footers.first, x.footers.even].into_iter().flatten() {
            if !ids.contains(&id) && s.doc.parts.contains_key(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

/// Whether `o` is a field whose code starts with `name` (PAGE, NUMPAGES).
fn is_field(o: Option<&ew_doc::para::InlineObject>, name: &str) -> bool {
    matches!(o, Some(ew_doc::para::InlineObject::Field { instr, .. }) if instr.split_whitespace().next().is_some_and(|w| w.eq_ignore_ascii_case(name)))
}

/// Paragraph `p` without its page numbers, or None when it holds no PAGE field: each PAGE field goes, and with it the rest of
/// insert.pageNumber's Page X of Y ("Page " before it, " of " and the NUMPAGES field after it). Other text stays.
fn without_page_numbers(p: &ew_doc::Paragraph) -> Option<ew_doc::Paragraph> {
    use ew_doc::para::OBJ;
    let at: Vec<usize> = p.objects_with_offsets().filter(|(_, o)| is_field(Some(o), "PAGE")).map(|(i, _)| i).collect();
    if at.is_empty() {
        return None;
    }
    let mut q = p.clone();
    let w = OBJ.len_utf8();
    for &o in at.iter().rev() {
        let (mut a, mut b) = (o, o + w);
        let of = b + " of ".len();
        if q.text.get(b..).is_some_and(|t| t.starts_with(" of ")) && is_field(q.object_at(of), "NUMPAGES") {
            b = of + w;
            if q.text.get(..a).is_some_and(|t| t.ends_with("Page ")) {
                a -= "Page ".len();
            }
        }
        q.delete(a, b).ok()?;
    }
    Some(q)
}

/// Part `id`'s blocks without their page numbers (a paragraph left with nothing but white space goes), or None when it has none.
fn page_paras(s: &Session, id: u32) -> Option<Vec<std::sync::Arc<Block>>> {
    let part = s.doc.parts.get(&id)?;
    let mut hit = false;
    let blocks = part
        .blocks
        .iter()
        .filter_map(|b| match b.as_para().and_then(without_page_numbers) {
            None => Some(b.clone()),
            Some(q) => {
                hit = true;
                (!q.text.chars().all(char::is_whitespace)).then(|| ew_doc::para_block(q))
            }
        })
        .collect();
    hit.then_some(blocks)
}

/// Remove Page Numbers: the page number fields leave every header and footer, the user's other text beside them stays (Word
/// removes the page number it inserted); a part left empty keeps one empty paragraph in its style.
fn remove_page_numbers(s: &mut Session, _: &Value) -> CmdResult {
    let mut removed = 0;
    for id in hf_parts(s) {
        removed += usize::from(super::insert::remove_margin_numbers(s, id)?);
        let Some(mut blocks) = page_paras(s, id) else { continue };
        if blocks.is_empty() {
            let style = if s.doc.parts.get(&id).is_some_and(|p| p.kind == ew_doc::PartKind::Header) { "Header" } else { "Footer" };
            blocks.push(ew_doc::para_block(ew_doc::Paragraph::new().styled(style)));
        }
        s.doc.set_story(StoryRef::Part(id), blocks)?;
        removed += 1;
    }
    if removed == 0 {
        return Err(CmdError::Disabled("there are no page numbers to remove".into()));
    }
    if let StoryRef::Part(id) = s.sel.focus.story {
        let at = s.doc.clamp(&s.sel.focus);
        s.sel = Selection::caret(if s.doc.parts.contains_key(&id) { at } else { s.doc.start_of(StoryRef::Body) });
    }
    Ok(json!({"parts": removed}))
}
