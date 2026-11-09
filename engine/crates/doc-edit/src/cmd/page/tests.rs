use super::*;

fn doc() -> Session {
    Session::new(ew_doc::Document::from_text("one\ntwo\nthree"))
}

fn with_section(f: impl Fn(&mut Value)) -> Value {
    let mut v = serde_json::to_value(SectionProps::default()).unwrap();
    f(&mut v);
    json!({"section": v})
}

/// `layout.pageSetup {section}` checks the values like the dedicated commands do.
#[test]
fn page_setup_section_is_validated() {
    let mut s = doc();
    let before = sect(&s);
    // Refused with an error, nothing changes: non-finite (overflowing), margins that leave no text room.
    for (what, p) in [
        ("inf width", with_section(|v| v["pageW"] = json!(1e300))),
        ("inf margin", with_section(|v| v["marginTop"] = json!(1e300))),
        ("inf header", with_section(|v| v["header"] = json!(1e300))),
        ("inf column space", with_section(|v| v["columns"]["space"] = json!(1e300))),
        ("inf column width", with_section(|v| v["columns"]["widths"] = json!([[1e300, 0.0], [100.0, 0.0]]))),
        ("inf line number distance", with_section(|v| v["lineNumbers"] = json!({"distance": 1e300}))),
        ("inf grid pitch", with_section(|v| v["docGrid"] = json!({"type": "lines", "linePitch": 1e300, "charSpace": 0}))),
        ("inf border space", with_section(|v| v["pageBorders"] = json!({"top": {"style": "single", "width": 1.0, "space": 1e300}}))),
        ("inf border width", with_section(|v| v["pageBorders"] = json!({"top": {"style": "single", "width": 1e300, "space": 1.0}}))),
        ("margins > page", with_section(|v| v["marginLeft"] = json!(5000.0))),
        ("margins eat the height", with_section(|v| v["marginTop"] = json!(700.0))),
        ("gutter eats the width", with_section(|v| v["gutter"] = json!(600.0))),
        ("negative page", with_section(|v| v["pageW"] = json!(-5.0))),
        ("zero page height", with_section(|v| v["pageH"] = json!(0.0))),
    ] {
        assert!(s.run("layout.pageSetup", &p).is_err(), "{what}");
        assert_eq!(sect(&s), before, "{what}");
    }
    // Clamped.
    s.run(
        "layout.pageSetup",
        &with_section(|v| {
            v["pageW"] = json!(100.0);
            v["pageH"] = json!(100.0);
            v["marginTop"] = json!(-10.0);
            v["marginBottom"] = json!(0.0);
            v["marginLeft"] = json!(0.0);
            v["marginRight"] = json!(0.0);
            v["header"] = json!(-3.0);
            v["footer"] = json!(1e6);
            v["columns"]["count"] = json!(1000);
            v["columns"]["space"] = json!(-4.0);
            v["lineNumbers"] = json!({"countBy": 0, "start": 0, "distance": 1e6, "restart": "page"});
            v["docGrid"] = json!({"type": "lines", "linePitch": 1e9, "charSpace": 2_000_000_000});
            v["pageNumStart"] = json!(4_000_000_000u64);
            v["footnotePr"] = json!({"numStart": 4_000_000_000u64});
            v["endnotePr"] = json!({"numStart": 0});
            v["pageBorders"] =
                json!({"top": {"style": "single", "width": 1e6, "space": -5.0}, "left": {"style": "single", "width": 0.0, "space": 1e6}});
        }),
    )
    .unwrap();
    let x = sect(&s);
    assert_eq!((x.page_w, x.page_h), (100.0, 100.0));
    assert_eq!(x.margin_top, 0.0);
    assert_eq!(x.header, 0.0);
    assert_eq!(x.footer, x.page_h, "a footer distance stays on the page");
    assert_eq!(x.columns.count, 12);
    assert_eq!(x.columns.space, 0.0);
    let l = x.line_numbers.unwrap();
    assert_eq!((l.count_by, l.start, l.distance), (1, 1, 1584.0));
    let g = x.doc_grid.unwrap();
    assert_eq!((g.line_pitch, g.char_space), (ew_doc::section::MAX_GRID_PITCH, ew_doc::section::MAX_CHAR_SPACE));
    assert_eq!(x.page_num_start, Some(100_000));
    assert_eq!(x.footnote_pr.num_start, Some(ew_doc::section::MAX_NOTE_START));
    assert_eq!(x.endnote_pr.num_start, Some(1));
    let b = x.page_borders.unwrap();
    let (t, lf) = (b.top.unwrap(), b.left.unwrap());
    assert_eq!((t.width, t.space), (6.0, 0.0));
    assert_eq!((lf.width, lf.space), (0.25, 31.0));
    // Huge pages clamp; columns and widths agree; orientation follows the sides.
    let mut s = doc();
    s.run(
        "layout.pageSetup",
        &with_section(|v| {
            v["pageW"] = json!(1e5);
            v["pageH"] = json!(792.0);
            v["landscape"] = json!(false);
            v["columns"]["count"] = json!(3);
            v["columns"]["widths"] = json!(vec![json!([1.0, 1e5]); 40]);
        }),
    )
    .unwrap();
    let x = sect(&s);
    assert_eq!(x.page_w, 1584.0);
    assert!(x.landscape, "wider than tall is landscape");
    assert_eq!(x.columns.widths.len(), 12);
    assert_eq!(x.columns.count, 12, "the count follows the widths");
    assert!(x.columns.widths.iter().all(|(w, sp)| *w >= 18.0 && (0.0..=300.0).contains(sp)));
    // One width is no custom layout: equal columns.
    s.run("layout.pageSetup", &with_section(|v| v["columns"]["widths"] = json!([[200.0, 0.0]]))).unwrap();
    assert!(sect(&s).columns.widths.is_empty());
}

/// A valid section still applies as given.
#[test]
fn page_setup_section_applies_a_valid_one() {
    let mut s = doc();
    s.run(
        "layout.pageSetup",
        &with_section(|v| {
            v["pageW"] = json!(595.0);
            v["pageH"] = json!(842.0);
            v["marginLeft"] = json!(50.0);
            v["columns"]["count"] = json!(2);
        }),
    )
    .unwrap();
    let x = sect(&s);
    assert_eq!((x.page_w, x.page_h, x.margin_left, x.columns.count), (595.0, 842.0, 50.0, 2));
}

/// A page smaller than the usual 36 pt of text room is fine with no margins; any margin or
/// gutter on it is refused.
#[test]
fn page_setup_section_allows_a_tiny_page_without_margins() {
    let tiny = |m: f32, g: f32| {
        with_section(|v| {
            v["pageW"] = json!(7.2);
            v["pageH"] = json!(20.0);
            for k in ["marginTop", "marginBottom", "marginLeft", "marginRight"] {
                v[k] = json!(m);
            }
            v["gutter"] = json!(g);
        })
    };
    let mut s = doc();
    let before = sect(&s);
    assert!(s.run("layout.pageSetup", &tiny(1.0, 0.0)).is_err(), "a margin on a tiny page");
    assert!(s.run("layout.pageSetup", &tiny(0.0, 1.0)).is_err(), "a gutter on a tiny page");
    assert_eq!(sect(&s), before);
    s.run("layout.pageSetup", &tiny(0.0, 0.0)).unwrap();
    assert_eq!((sect(&s).page_w, sect(&s).page_h), (7.2, 20.0));
}

/// Layout › Text Direction turns the section, or the table cell the caret is in; one undo step.
#[test]
fn text_direction_turns_the_section_or_the_cell() {
    use ew_doc::props::TextDirection;
    let mut s = doc();
    s.run("layout.textDirection", &json!({"value": "down"})).unwrap();
    assert_eq!(sect(&s).text_direction, TextDirection::Down);
    assert_eq!(text_direction_at(&s), TextDirection::Down);
    // Without a value: back to horizontal, like Word's button on a vertical section.
    s.run("layout.textDirection", &json!({})).unwrap();
    assert_eq!(sect(&s).text_direction, TextDirection::Horizontal);
    s.run("edit.undo", &json!({})).unwrap();
    assert_eq!(sect(&s).text_direction, TextDirection::Down);
    assert!(s.run("layout.textDirection", &json!({"value": "diagonal"})).is_err());
    assert_eq!(sect(&s).text_direction, TextDirection::Down);
    // In a table cell it turns the cell, not the section.
    s.run("insert.table", &json!({"rows": 1, "cols": 2})).unwrap();
    assert!(s.sel.focus.path.step().is_some());
    s.run("layout.textDirection", &json!({"value": "btLr"})).unwrap();
    assert_eq!(text_direction_at(&s), TextDirection::Up);
    assert_eq!(sect(&s).text_direction, TextDirection::Down);
}

/// #1206: each Margins and Columns preset is recognised after it's applied (Mirrored and
/// Office 2003 share three margins; mirror margins tell them apart), and a value no preset
/// gives is none of them.
#[test]
fn page_setup_presets_are_recognised() {
    let mut s = doc();
    for (id, _) in MARGIN_PRESETS {
        s.run("layout.margins", &json!({"preset": id})).unwrap();
        assert_eq!(margins_preset_at(&s), Some(id));
    }
    s.run("layout.margins", &json!({"left": 80.0})).unwrap();
    assert_eq!(margins_preset_at(&s), None);
    for (params, id) in [
        (json!({"count": 2}), "two"),
        (json!({"preset": "left"}), "left"),
        (json!({"count": 3}), "three"),
        (json!({"preset": "right"}), "right"),
        (json!({"count": 1}), "one"),
    ] {
        s.run("layout.columns", &params).unwrap();
        assert_eq!(columns_preset_at(&s), Some(id), "{params}");
    }
    s.run("layout.columns", &json!({"count": 4})).unwrap();
    assert_eq!(columns_preset_at(&s), None);
}

/// #852: a continuous section break with text selected goes before the selection and keeps
/// it, as in Word; it used to delete the text, so the first section came out empty. Saved and
/// opened again, both sections' text lays out on page 1, the second below the first.
#[test]
fn section_break_keeps_the_selected_text() {
    let mut s = Session::new(ew_doc::Document::from_text("one\ntwo"));
    s.run("select.text", &json!({"text": "one"})).unwrap();
    s.run("layout.break", &json!({"kind": "continuous"})).unwrap();
    assert_eq!(s.selected_text(), "one");
    assert_eq!(s.doc.sections().len(), 2);
    let texts = |d: &ew_doc::Document| -> Vec<String> {
        d.body.iter().filter_map(|b| if let Block::Para(p) = &**b { Some(p.plain_text().to_string()) } else { None }).collect()
    };
    assert_eq!(texts(&s.doc), ["", "one", "two"]);
    // A backward selection in the middle of a paragraph keeps its text and direction too.
    let mut s = Session::new(ew_doc::Document::from_text("alpha beta\ngamma"));
    let p = |off| Pos { story: StoryRef::Body, path: ew_doc::Path::top(0), off };
    s.sel = Selection { anchor: p(10), focus: p(6) };
    s.run("layout.break", &json!({"kind": "continuous"})).unwrap();
    assert_eq!(s.selected_text(), "beta");
    assert!(s.sel.anchor > s.sel.focus);
    assert_eq!(texts(&s.doc), ["alpha ", "beta", "gamma"]);

    // The issue's document: "one", a continuous break, "two" — both on page 1 after a round trip.
    let mut s = Session::new(ew_doc::Document::from_text("one\ntwo"));
    s.run("select.text", &json!({"text": "one"})).unwrap();
    s.run("caret.end", &json!({})).unwrap();
    s.run("layout.break", &json!({"kind": "continuous"})).unwrap();
    let back = ew_docx::read(&ew_docx::write(&s.doc).unwrap()).unwrap();
    assert_eq!(back.sections().len(), 2);
    assert_eq!(back.last_section.start, SectionStart::Continuous);
    let mut s = Session::new(back);
    let l = s.layout();
    assert_eq!(l.pages.len(), 1);
    let mut lines: Vec<(String, f32)> = l.pages[0]
        .items
        .iter()
        .filter_map(|it| match it {
            crate::layout::Placed::Lines { path, y, .. } => {
                let Some(Block::Para(p)) = l.ids.block(path.0[0]).and_then(|b| s.doc.body.get(b)).map(|b| &**b) else { return None };
                (!p.plain_text().is_empty()).then(|| (p.plain_text().to_string(), *y))
            }
            _ => None,
        })
        .collect();
    lines.sort_by(|a, b| a.1.total_cmp(&b.1));
    let order: Vec<&str> = lines.iter().map(|(t, _)| t.as_str()).collect();
    assert_eq!(order, ["one", "two"]);
}

/// More Columns: unequal widths with a line between, as one undo step.
#[test]
fn unequal_columns_with_a_line_between() {
    let mut s = doc();
    let tw = sect(&s).text_width();
    s.run("layout.columns", &json!({"widths": [[150.0, 24.0], [tw - 174.0, 0.0]], "separator": true})).unwrap();
    let c = sect(&s).columns;
    assert_eq!((c.count, c.separator, c.widths.len()), (2, true, 2));
    assert_eq!(c.widths.first(), Some(&(150.0, 24.0)));
    s.run("edit.undo", &json!({})).unwrap();
    assert_eq!(sect(&s).columns, Columns::default());
    // Too wide, too narrow, too many, or nonsense: refused.
    for bad in [json!([[tw, 36.0], [100.0, 0.0]]), json!([[5.0, 0.0], [100.0, 0.0]]), json!(vec![[40.0, 0.0]; 13]), json!("x")] {
        assert!(s.run("layout.columns", &json!({"widths": bad})).is_err(), "{bad}");
    }
}

/// Apply to: the whole document, or from the caret on (a continuous section break first).
#[test]
fn columns_apply_to_the_document_or_from_the_caret_on() {
    let mut s = doc();
    s.run("layout.break", &json!({"kind": "nextPage"})).unwrap();
    s.run("layout.columns", &json!({"count": 3, "apply": "document"})).unwrap();
    assert!(s.doc.sections().iter().all(|(_, x)| x.columns.count == 3));
    let mut s = doc();
    s.run("caret.docEnd", &json!({})).unwrap();
    s.run("layout.columns", &json!({"count": 2, "apply": "forward"})).unwrap();
    let counts: Vec<u32> = s.doc.sections().iter().map(|(_, x)| x.columns.count).collect();
    assert_eq!(counts, vec![1, 2]);
    assert_eq!(s.doc.last_section.start, SectionStart::Continuous);
    assert!(s.run("layout.columns", &json!({"count": 2, "apply": "elsewhere"})).is_err());
}

/// Each section's paragraphs (a section break's own paragraph shows as "") and column count.
fn sections_of(s: &Session) -> Vec<(Vec<String>, u32)> {
    let mut from = 0;
    let mut out = Vec::new();
    for (end, x) in s.doc.sections() {
        let paras = (from..=end).map(|i| s.doc.para_at(&Pos::body(i, 0)).map(|p| p.text.clone()).unwrap_or_default()).collect();
        out.push((paras, x.columns.count));
        from = end + 1;
    }
    out
}

fn select(s: &mut Session, from: (usize, usize), to: (usize, usize)) {
    s.sel = Selection { anchor: Pos::body(from.0, from.1), focus: Pos::body(to.0, to.1) };
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// Columns on selected text (#2024), as observed in Word: a continuous section break before
/// and after the selection, the columns on the section between, the rest left alone.
#[test]
fn columns_apply_to_the_selected_text() {
    let five = || Session::new(ew_doc::Document::from_text("p1\np2\nalpha beta gamma\np4\np5"));
    // A whole paragraph (a triple-click takes its mark): each break gets a paragraph of its own.
    let mut s = five();
    select(&mut s, (2, 0), (3, 0));
    let whole = s.selected_text();
    s.run("layout.columns", &json!({"count": 2})).unwrap();
    assert_eq!(sections_of(&s), vec![(strs(&["p1", "p2", ""]), 1), (strs(&["alpha beta gamma", ""]), 2), (strs(&["p4", "p5"]), 1)]);
    assert!(s.doc.sections().iter().skip(1).all(|(_, x)| x.start == SectionStart::Continuous));
    assert_eq!(s.selected_text(), whole, "the paragraph stays selected");
    // The same paragraph again: its section changes, no new breaks.
    select(&mut s, (3, 0), (4, 0));
    s.run("layout.columns", &json!({"count": 3})).unwrap();
    assert_eq!(sections_of(&s).iter().map(|(_, n)| *n).collect::<Vec<_>>(), vec![1, 3, 1]);
    // Taking the section break along changes nothing more.
    select(&mut s, (3, 0), (5, 0));
    s.run("layout.columns", &json!({"count": 2})).unwrap();
    assert_eq!(sections_of(&s).iter().map(|(_, n)| *n).collect::<Vec<_>>(), vec![1, 2, 1]);
    // One undo step takes the breaks and the columns away.
    let mut s = five();
    select(&mut s, (2, 0), (3, 0));
    s.run("layout.columns", &json!({"count": 2})).unwrap();
    s.run("edit.undo", &json!({})).unwrap();
    assert_eq!(sections_of(&s), vec![(strs(&["p1", "p2", "alpha beta gamma", "p4", "p5"]), 1)]);

    // Words inside a paragraph: the breaks split it there.
    let mut s = five();
    select(&mut s, (2, 10), (2, 6));
    s.run("layout.columns", &json!({"count": 2})).unwrap();
    assert_eq!(sections_of(&s), vec![(strs(&["p1", "p2", "alpha "]), 1), (strs(&["beta"]), 2), (strs(&[" gamma", "p4", "p5"]), 1)]);
    assert_eq!(s.selected_text(), "beta");
    assert!(s.sel.anchor > s.sel.focus, "a backward selection stays backward");

    // At the document's start no break goes before it, at its end none after.
    let mut s = five();
    select(&mut s, (0, 0), (1, 0));
    s.run("layout.columns", &json!({"count": 2})).unwrap();
    assert_eq!(sections_of(&s), vec![(strs(&["p1", ""]), 2), (strs(&["p2", "alpha beta gamma", "p4", "p5"]), 1)]);
    let mut s = five();
    select(&mut s, (4, 0), (4, 2));
    s.run("layout.columns", &json!({"count": 2})).unwrap();
    assert_eq!(sections_of(&s), vec![(strs(&["p1", "p2", "alpha beta gamma", "p4", ""]), 1), (strs(&["p5"]), 2)]);
    // Select All: the whole document, no breaks.
    let mut s = five();
    s.run("select.all", &json!({})).unwrap();
    s.run("layout.columns", &json!({"count": 2})).unwrap();
    assert_eq!(sections_of(&s), vec![(strs(&["p1", "p2", "alpha beta gamma", "p4", "p5"]), 2)]);

    // Without a selection the caret's section changes; "selection" then needs one.
    let mut s = five();
    s.run("layout.columns", &json!({"count": 2})).unwrap();
    assert_eq!(sections_of(&s).len(), 1);
    assert!(s.run("layout.columns", &json!({"count": 2, "apply": "selection"})).is_err());
}

/// #407 Line Numbers options: start, count by, distance and restart; options alone keep the
/// restart mode, `none` turns numbering off.
#[test]
fn line_numbering_options() {
    use ew_doc::section::LineNumberRestart;
    let mut s = Session::new(ew_doc::Document::from_text("One\nTwo"));
    s.run("layout.lineNumbers", &json!({"value": "restartSection", "start": 5, "countBy": 2, "distance": 18})).unwrap();
    let l = s.doc.last_section.line_numbers.clone().unwrap();
    assert_eq!((l.start, l.count_by, l.distance, l.restart), (5, 2, 18.0, LineNumberRestart::Section));
    s.run("layout.lineNumbers", &json!({"countBy": 1e9, "start": -3})).unwrap();
    let l = s.doc.last_section.line_numbers.clone().unwrap();
    assert_eq!((l.start, l.count_by, l.restart), (5, 100, LineNumberRestart::Section), "clamped, mode kept");
    s.run("layout.lineNumbers", &json!({"value": "none"})).unwrap();
    assert!(s.doc.last_section.line_numbers.is_none());
    assert!(s.run("layout.lineNumbers", &json!({"value": "sometimes"})).is_err());
}

/// #407 Hyphenation Options: options don't toggle automatic hyphenation; Manual finds a
/// word at a line start that would fit hyphenated on the line above, and an optional hyphen
/// there breaks the word.
#[test]
fn hyphenation_options_and_manual_hyphenation() {
    let mut s =
        Session::new(ew_doc::Document::from_text(&"a extraordinarily be uncharacteristic of responsibilities the considerations ".repeat(12)));
    let r = s.run("layout.hyphenation", &json!({"zone": 36, "caps": false, "limit": 3})).unwrap();
    assert_eq!(r, json!({"value": false, "zone": 36.0, "caps": false, "limit": 3}));
    s.run("layout.hyphenation", &json!({})).unwrap();
    assert!(s.doc.settings.auto_hyphenation, "nothing given toggles");
    s.run("layout.hyphenation", &json!({"value": false})).unwrap();
    // Accept every candidate (which words they are depends on the fonts).
    let mut found = 0;
    let mut from = json!(null);
    while found < 5 {
        let c = s.run("layout.manualHyphenation", &json!({"from": from})).unwrap();
        if c["done"] == true {
            break;
        }
        let word = c["word"].as_str().unwrap().to_string();
        let pts = c["points"].as_array().unwrap();
        assert!(!pts.is_empty() && pts.contains(&c["suggest"]), "{c}");
        let at = c["suggest"].as_u64().unwrap() as usize;
        let mut pos = c["pos"].clone();
        let off = pos["off"].as_u64().unwrap() as usize + word.char_indices().nth(at).unwrap().0;
        pos["off"] = json!(off);
        s.run("caret.set", &json!({"pos": pos})).unwrap();
        s.run("text.optionalHyphen", &json!({})).unwrap();
        pos["off"] = json!(off + word.len());
        from = pos;
        found += 1;
    }
    // Some line of thirty or so starts with a long word that fits hyphenated above, whatever the font.
    assert!(found > 0, "no candidates");
    assert_eq!(s.doc.plain_text(ew_doc::StoryRef::Body).matches('\u{ad}').count(), found);
    assert!(s.run("layout.manualHyphenation", &json!({"from": {"block": 999, "off": 0}})).unwrap()["done"] == true);
}

/// `layout.pageNumberFormat` sets the section's number format and start; a call without
/// `start` keeps it (the ribbon's old plain call cleared it), and a null `start` numbers on
/// from the section before — the Format Page Numbers dialog's "Continue from previous
/// section" (#1113).
#[test]
fn page_number_format_keeps_or_clears_the_start() {
    use ew_doc::section::NumFormat;
    let mut s = doc();
    s.run("layout.pageNumberFormat", &json!({"format": "upperRoman", "start": 3})).unwrap();
    let x = sect(&s);
    assert_eq!((x.page_num_format, x.page_num_start), (NumFormat::UpperRoman, Some(3)));
    s.run("layout.pageNumberFormat", &json!({"format": "lowerLetter"})).unwrap();
    let x = sect(&s);
    assert_eq!((x.page_num_format, x.page_num_start), (NumFormat::LowerLetter, Some(3)), "a format change keeps the start");
    s.run("layout.pageNumberFormat", &json!({"start": null})).unwrap();
    let x = sect(&s);
    assert_eq!((x.page_num_format, x.page_num_start), (NumFormat::LowerLetter, None), "continue numbers on from the section before");
    // The result carries the section back (scripts read it instead of the dialog).
    let back = s.run("layout.pageNumberFormat", &json!({"format": "decimal", "start": 1})).unwrap();
    assert_eq!(back["pageNumFormat"], "decimal");
    assert_eq!(back["pageNumStart"], 1);
}

fn state(s: &Session, id: &str) -> (Value, Value) {
    (s.registry.get(id).and_then(|x| x.state).expect("a state reader"))(s)
}

/// The Layout and Header & Footer controls read their state without running the command: the toggles change nothing when read
/// (stage2.md risks), and each value follows the command that sets it.
#[test]
fn ribbon_states_read_without_a_change() {
    let mut s = doc();
    let before = s.doc.clone();
    let (on, opts) = state(&s, "layout.hyphenation");
    let (first, _) = state(&s, "layout.differentFirstPage");
    assert_eq!(s.doc, before, "reading the toggles changes nothing");
    assert_eq!((on, first), (json!(false), json!(false)));
    assert_eq!(opts["value"], json!(false));
    s.run("layout.hyphenation", &json!({"value": true})).unwrap();
    assert_eq!(state(&s, "layout.hyphenation").0, json!(true));
    s.run("layout.differentFirstPage", &json!({"value": true})).unwrap();
    assert_eq!(state(&s, "layout.differentFirstPage").0, json!(true));
    s.run("layout.differentOddEven", &json!({"value": true})).unwrap();
    assert_eq!(state(&s, "layout.differentOddEven").0, json!(true));

    s.run("layout.orientation", &json!({"value": "landscape"})).unwrap();
    assert_eq!(state(&s, "layout.orientation").1, json!("landscape"));
    s.run("layout.margins", &json!({"preset": "narrow"})).unwrap();
    assert_eq!(state(&s, "layout.margins").1["preset"], json!("narrow"));
    s.run("layout.columns", &json!({"count": 2})).unwrap();
    assert_eq!(state(&s, "layout.columns").1["preset"], json!("two"));
    assert_eq!(state(&s, "layout.lineNumbers").1, json!("none"));
    s.run("layout.lineNumbers", &json!({"value": "restartSection"})).unwrap();
    assert_eq!(state(&s, "layout.lineNumbers").1, json!("restartSection"));
    s.run("hf.position", &json!({"header": 50.0})).unwrap();
    assert_eq!(state(&s, "hf.position").1["header"], json!(50.0));
    let size = state(&s, "layout.size").1;
    assert!(size["width"].as_f64().unwrap() > size["height"].as_f64().unwrap(), "landscape: {size}");
    assert_eq!(state(&s, "layout.textDirection").1, json!("horizontal"));
    s.run("para.set", &json!({"props": {"suppressLineNumbers": true}})).unwrap();
    assert_eq!(state(&s, "layout.paragraph").1["suppressLineNumbers"], json!(true));
    s.run("design.paragraphSpacing", &json!({"value": "double"})).unwrap();
    assert_eq!(state(&s, "design.paragraphSpacing").1, json!("double"));
    s.run("design.pageColor", &json!({"color": "FFEECC"})).unwrap();
    assert_eq!(state(&s, "design.pageColor").1, json!("FFEECC"));
    s.run("design.watermark", &json!({"text": "DRAFT", "font": "Georgia", "semitransparent": false})).unwrap();
    let w = state(&s, "design.watermark").1;
    assert_eq!((w["text"].clone(), w["font"].clone(), w["semitransparent"].clone()), (json!("DRAFT"), json!("Georgia"), json!(false)));
}

/// `layout.section {index}` reads any section, with the count, for Page Setup's Apply to and a double-click on a break.
#[test]
fn section_by_index() {
    let mut s = doc();
    s.run("caret.docEnd", &json!({})).unwrap();
    s.run("layout.break", &json!({"kind": "nextPage"})).unwrap();
    s.run("layout.orientation", &json!({"value": "landscape"})).unwrap();
    let first = s.run("layout.section", &json!({"index": 0})).unwrap();
    let last = s.run("layout.section", &json!({})).unwrap();
    assert_eq!((first["landscape"].clone(), first["count"].clone()), (json!(false), json!(2)));
    assert_eq!((last["landscape"].clone(), last["index"].clone()), (json!(true), json!(1)));
    assert!(s.run("layout.section", &json!({"index": 5})).is_err());
}

/// Two sections, each with its own header ("One" and "Two"), the caret in the second's as opened from its page.
fn two_headers() -> (Session, u32, u32) {
    let mut s = doc();
    s.run("insert.header", &json!({"text": "One"})).unwrap();
    let one = match s.sel.focus.story {
        StoryRef::Part(id) => id,
        _ => panic!("in the header"),
    };
    s.run("insert.closeHeader", &json!({})).unwrap();
    s.run("caret.docEnd", &json!({})).unwrap();
    s.run("layout.break", &json!({"kind": "nextPage"})).unwrap();
    // The new section names the first one's header (a break copies the section), so it shows it: unlinking gives it a copy.
    assert_eq!(s.doc.sections()[1].1.headers.default, Some(one));
    s.run("layout.linkToPrevious", &json!({"value": false})).unwrap();
    let two = s.doc.sections()[1].1.headers.default.unwrap();
    assert_ne!(one, two, "the second section has its own header");
    assert_eq!(s.doc.plain_text(StoryRef::Part(two)).trim(), "One", "a copy of what it showed");
    let para = ew_doc::Paragraph::with_text("Two", ew_doc::CharProps::default()).styled("Header");
    s.doc.set_story(StoryRef::Part(two), vec![ew_doc::para_block(para)]).unwrap();
    s.sel = Selection::caret(s.doc.end_of(StoryRef::Part(two)));
    s.page_hint = 1;
    (s, one, two)
}

/// Previous and Next stop at the first and last section, as Word's do (the engine wrapped round).
#[test]
fn header_navigation_stops_at_the_ends() {
    let (mut s, one, two) = two_headers();
    assert!(hf_nav_off(&s, 1).is_some(), "the last section has no next one");
    assert!(s.run("hf.next", &json!({})).is_err());
    s.run("hf.previous", &json!({})).unwrap();
    assert_eq!(s.sel.focus.story, StoryRef::Part(one));
    assert!(hf_nav_off(&s, -1).is_some(), "the first section has no previous one");
    s.run("hf.next", &json!({})).unwrap();
    assert_eq!(s.sel.focus.story, StoryRef::Part(two));
}

/// Link to Previous on drops the section's own header; off gives it a copy of the one it showed.
#[test]
fn link_to_previous_both_ways() {
    let (mut s, one, two) = two_headers();
    let r = s.run("layout.linkToPrevious", &json!({"value": true})).unwrap();
    assert_eq!(r["linked"], json!(true));
    assert_eq!(s.doc.sections()[1].1.headers.default, None);
    assert_eq!(s.sel.focus.story, StoryRef::Part(one), "the caret shows the previous section's header");
    // Off: the copy is its own part with the same text.
    s.page_hint = 1;
    s.run("layout.linkToPrevious", &json!({"value": false})).unwrap();
    let own = s.doc.sections()[1].1.headers.default.expect("its own header again");
    assert!(own != one && own != two);
    assert_eq!(s.doc.plain_text(StoryRef::Part(own)).trim(), "One");
    assert!(s.run("layout.linkToPrevious", &json!({"value": true})).is_ok());
}

/// Alt+Shift+R copies the previous section's header in without linking; Remove Page Numbers takes the PAGE paragraphs out.
#[test]
fn copy_previous_and_remove_page_numbers() {
    let (mut s, _, two) = two_headers();
    s.page_hint = 1;
    s.run("hf.copyPrevious", &json!({})).unwrap();
    assert_eq!(s.doc.plain_text(StoryRef::Part(two)).trim(), "One");
    assert_eq!(s.doc.sections()[1].1.headers.default, Some(two), "still its own header");

    s.run("insert.closeHeader", &json!({})).unwrap();
    assert!(s.registry.get("hf.removePageNumbers").is_some_and(|x| (x.enabled)(&s).is_some()), "nothing to remove yet");
    s.run("insert.pageNumber", &json!({"position": "bottom"})).unwrap();
    assert!((s.registry.get("hf.removePageNumbers").unwrap().enabled)(&s).is_none());
    s.run("hf.removePageNumbers", &json!({})).unwrap();
    assert!(hf_parts(&s).iter().all(|id| page_paras(&s, *id).is_none()), "no PAGE field left");
}


/// Page Setup's OK writes one section, the caret's or the one by index, and keeps that section's own headers: a selection over
/// two sections no longer copies one section's props (header ids included) onto the other.
#[test]
fn page_setup_writes_one_section_and_keeps_its_headers() {
    let (mut s, one, two) = two_headers();
    let last = s.doc.sections().last().map(|(e, _)| *e).unwrap();
    select(&mut s, (0, 0), (last, 0));
    let mut x = serde_json::to_value(s.doc.sections()[1].1.clone()).unwrap();
    x["landscape"] = json!(true);
    x["pageW"] = json!(792.0);
    x["pageH"] = json!(612.0);
    s.run("layout.pageSetup", &json!({"section": x, "index": 0})).unwrap();
    let (a, b) = (s.doc.sections()[0].1.clone(), s.doc.sections()[1].1.clone());
    assert!(a.landscape && !b.landscape, "only section 0 turned");
    assert_eq!((a.headers.default, b.headers.default), (Some(one), Some(two)), "each keeps its own header");
}

/// Remove Page Numbers takes the field out and leaves the user's text beside it; Page X of Y goes whole.
#[test]
fn remove_page_numbers_keeps_the_text_beside_them() {
    let mut s = doc();
    s.run("insert.pageNumber", &json!({"position": "bottom"})).unwrap();
    let foot = s.doc.sections()[0].1.footers.default.unwrap();
    s.sel = Selection::caret(s.doc.start_of(StoryRef::Part(foot)));
    s.run("text.insert", &json!({"text": "Confidential | Page "})).unwrap();
    s.run("insert.pageNumber", &json!({"position": "top", "format": "x of y"})).unwrap();
    let head = s.doc.sections()[0].1.headers.default.unwrap();
    s.run("hf.removePageNumbers", &json!({})).unwrap();
    assert_eq!(s.doc.plain_text(StoryRef::Part(foot)).trim(), "Confidential | Page");
    assert_eq!(s.doc.plain_text(StoryRef::Part(head)).trim(), "", "Page X of Y left nothing");
    assert!(hf_parts(&s).iter().all(|id| page_paras(&s, *id).is_none()), "no PAGE field left");
}

// engine-gaps-page tests

fn state_of(s: &Session, id: &str) -> (Value, Value) {
    (s.registry.get(id).and_then(|x| x.state).expect("a state reader"))(s)
}

/// Three sections: the first and second with their own headers, the third naming the second's (a break copies the section, so
/// it is linked). Next and Previous visit every section, the linked one too (same part, its own page), and Link to Previous
/// reads pressed there and only there (gap G15).
#[test]
fn header_navigation_visits_linked_sections_and_link_reads_pressed() {
    let (mut s, one, two) = two_headers();
    s.run("insert.closeHeader", &json!({})).unwrap();
    s.run("caret.docEnd", &json!({})).unwrap();
    s.run("layout.break", &json!({"kind": "nextPage"})).unwrap();
    assert_eq!(s.doc.sections().len(), 3);
    s.sel = Selection::caret(s.doc.end_of(StoryRef::Part(one)));
    s.page_hint = 0;
    let l = s.layout();
    let first_of = |i: usize| l.pages.iter().position(|p| p.section == i).unwrap();
    assert_eq!(l.pages[first_of(2)].header_story, Some(two), "the last section shows the second one's header");
    assert_eq!(state_of(&s, "layout.linkToPrevious").0, json!(false), "the first section links to nothing");
    assert!((s.registry.get("layout.linkToPrevious").unwrap().enabled)(&s).is_some(), "off in the first section");
    s.run("hf.next", &json!({})).unwrap();
    assert_eq!((s.sel.focus.story, s.page_hint), (StoryRef::Part(two), first_of(1)));
    assert_eq!(state_of(&s, "layout.linkToPrevious").0, json!(false), "its own header");
    s.run("hf.next", &json!({})).unwrap();
    assert_eq!((s.sel.focus.story, s.page_hint), (StoryRef::Part(two), first_of(2)), "Next goes to the linked section");
    assert_eq!(state_of(&s, "layout.linkToPrevious").0, json!(true), "pressed in the linked section");
    assert!(hf_nav_off(&s, 1).is_some(), "Word stops at the last section");
    s.run("hf.previous", &json!({})).unwrap();
    assert_eq!((s.sel.focus.story, s.page_hint), (StoryRef::Part(two), first_of(1)));
}

/// Show Document Text off leaves the body out of the page's display list; closing the header shows it again.
#[test]
fn show_document_text_hides_the_body() {
    let mut s = doc();
    assert!(s.run("hf.showDocumentText", &json!({"value": false})).is_err(), "only in a header or footer");
    s.run("insert.header", &json!({"text": "Head"})).unwrap();
    assert_eq!(state_of(&s, "hf.showDocumentText").0, json!(true));
    s.run("hf.showDocumentText", &json!({})).unwrap();
    assert_eq!(state_of(&s, "hf.showDocumentText").0, json!(false));
    let l = s.layout();
    let opts = crate::cmd::view::display_options(&s);
    let [(_, hf), (_, body)] = ew_doc_layout::display::page_layers(&s.doc, &l.pages[0], &opts);
    assert!(!hf.is_empty() && body.is_empty(), "the header shows, the body does not");
    s.run("insert.closeHeader", &json!({})).unwrap();
    assert!(s.view.show_document_text, "closing the header shows the body again");
}

/// Leaving the header by a body selection (a click or Esc), not Close Header, also shows the body again.
#[test]
fn show_document_text_returns_with_the_body_caret() {
    let mut s = doc();
    let body = s.sel.clone();
    s.run("insert.header", &json!({"text": "Head"})).unwrap();
    s.run("hf.showDocumentText", &json!({"value": false})).unwrap();
    s.run("select.range", &json!({"anchor": body.anchor, "focus": body.focus})).unwrap();
    assert_eq!(s.sel.focus.story, StoryRef::Body);
    assert!(s.view.show_document_text, "the body caret shows the document text again");
    let l = s.layout();
    let opts = crate::cmd::view::display_options(&s);
    let [_, (_, body)] = ew_doc_layout::display::page_layers(&s.doc, &l.pages[0], &opts);
    assert!(!body.is_empty(), "the body draws again");
}

/// Page Setup's Apply to: Whole document changes every section, This point forward breaks before the caret's paragraph and
/// changes the new section only, Selected sections the ones the selection touches; each keeps its own headers.
#[test]
fn page_setup_apply_to() {
    let (mut s, one, two) = two_headers();
    s.run("insert.closeHeader", &json!({})).unwrap();
    let patch = json!({"marginTop": 50.0});
    s.run("layout.pageSetup", &json!({"patch": patch, "apply": "whole"})).unwrap();
    assert!(s.doc.sections().iter().all(|(_, x)| x.margin_top == 50.0));
    assert_eq!((s.doc.sections()[0].1.headers.default, s.doc.sections()[1].1.headers.default), (Some(one), Some(two)));
    // This point forward from the second paragraph of the first section.
    s.sel = Selection::caret(Pos { story: StoryRef::Body, path: ew_doc::Path::top(1), off: 1 });
    let r = s.run("layout.pageSetup", &json!({"patch": {"marginLeft": 100.0}, "apply": "forward"})).unwrap();
    assert_eq!(s.doc.sections().len(), 3, "a break before the caret's paragraph");
    assert_eq!(r["sections"], json!([1]));
    assert_eq!(s.doc.sections().iter().map(|(_, x)| x.margin_left).collect::<Vec<_>>(), vec![72.0, 100.0, 72.0]);
    // From a section's first paragraph no break goes in.
    let r = s.run("layout.pageSetup", &json!({"patch": {"marginRight": 90.0}, "apply": "forward"})).unwrap();
    assert_eq!((s.doc.sections().len(), r["sections"].clone()), (3, json!([1])));
    // The selection over sections 1 and 2.
    let last = s.doc.body.len() - 1;
    let from = s.doc.sections()[0].0 + 1;
    select(&mut s, (from, 0), (last, 0));
    let x = s.run("layout.section", &json!({})).unwrap();
    assert_eq!((x["selection"].clone(), x["collapsed"].clone()), (json!([1, 2]), json!(false)));
    s.run("layout.pageSetup", &json!({"patch": {"marginBottom": 40.0}, "apply": "sections"})).unwrap();
    assert_eq!(s.doc.sections().iter().map(|(_, x)| x.margin_bottom).collect::<Vec<_>>(), vec![72.0, 40.0, 40.0]);
    assert!(s.run("layout.pageSetup", &json!({"patch": {"marginTop": 900.0}, "apply": "whole"})).is_err(), "checked as a whole section");
}

/// Draw › Format Background: a kind sets the lines (drawn on the page), Apply to Full Page waits with None, None takes them away.
#[test]
fn format_background_rules() {
    let mut s = doc();
    s.run("design.formatBackground", &json!({"kind": "collegeRuled"})).unwrap();
    assert_eq!(state_of(&s, "design.formatBackground").1, json!({"kind": "collegeRuled", "full": false}));
    let l = s.layout();
    let list = ew_doc_layout::display::page_list(&s.doc, &l.pages[0], &Default::default());
    assert!(format!("{list:?}").contains("Vector"), "the lines are drawn");
    s.run("design.formatBackground", &json!({"kind": "none", "full": true})).unwrap();
    assert_eq!(state_of(&s, "design.formatBackground").1, json!({"kind": "none", "full": true}));
    s.run("design.formatBackground", &json!({"full": false})).unwrap();
    assert_eq!(s.doc.settings.page_rule, None);
    assert!(s.run("design.formatBackground", &json!({"kind": "plaid"})).is_err());
}

/// Printed Watermark's Size: a size in points sets the box the text fills (its height); Auto clears it; a new text keeps it.
#[test]
fn watermark_size() {
    let mut s = doc();
    s.run("design.watermark", &json!({"text": "SAMPLE", "size": 72})).unwrap();
    let b = s.doc.settings.watermark.as_ref().unwrap().size.unwrap();
    assert!(b[1] == 72.0 && b[0] > 72.0, "{b:?}");
    assert_eq!(state_of(&s, "design.watermark").1["size"], json!(72.0));
    s.run("design.watermark", &json!({"text": "SAMPLE TEXT"})).unwrap();
    let c = s.doc.settings.watermark.as_ref().unwrap().size.unwrap();
    assert!(c[1] == 72.0 && c[0] > b[0], "longer text, wider box");
    s.run("design.watermark", &json!({"size": null})).unwrap();
    assert_eq!(s.doc.settings.watermark.as_ref().unwrap().size, None);
}

/// The page `layout.pageSetup` writes as section `v` (the command's own value form).
fn setup(s: &mut Session, v: &Value) {
    s.run("layout.pageSetup", &json!({"section": v})).unwrap();
}

/// A4 portrait with Word's margins: top 10, right 20, bottom 30, left 40.
fn a4(s: &mut Session) {
    let mut v = serde_json::to_value(sect(s)).unwrap();
    for (k, x) in [("pageW", 595.3), ("pageH", 841.9), ("marginTop", 10.0), ("marginRight", 20.0), ("marginBottom", 30.0), ("marginLeft", 40.0)] {
        v[k] = json!(x);
    }
    setup(s, &v);
}

/// Layout › Text Direction › Vertical turns the page as Word does (`layout.pageSetup.textDirection.vertical`,
/// `.rotateAsianCharacters270`): A4's text area turns onto its side, the margins with it, and Rotate Asian
/// characters turns it back because its lines stay horizontal.
#[test]
fn text_direction_vertical_turns_the_page() {
    use ew_doc::props::TextDirection;
    let close = |a: f32, b: f32| (a - b).abs() < 0.05;
    let margins = |x: &SectionProps| (x.margin_top, x.margin_right, x.margin_bottom, x.margin_left);
    let mut s = doc();
    a4(&mut s);
    s.run("layout.textDirection", &json!({"value": "down"})).unwrap();
    let x = sect(&s);
    assert!(x.landscape, "vertical turns the page");
    assert!(close(x.page_w, 841.9) && close(x.page_h, 595.3), "landscape A4: {x:?}");
    assert_eq!((x.text_direction, margins(&x)), (TextDirection::Down, (40.0, 10.0, 20.0, 30.0)), "Word's turned margins");
    s.run("layout.textDirection", &json!({"value": "horizontal"})).unwrap();
    let x = sect(&s);
    assert!(!x.landscape && close(x.page_w, 595.3) && close(x.page_h, 841.9), "horizontal restores the page: {x:?}");
    assert_eq!(margins(&x), (10.0, 20.0, 30.0, 40.0));
    s.run("layout.textDirection", &json!({"value": "down"})).unwrap();
    s.run("layout.textDirection", &json!({"value": "asian270"})).unwrap();
    let x = sect(&s);
    assert_eq!(x.text_direction, TextDirection::Asian270);
    assert!(!x.landscape && close(x.page_w, 595.3) && close(x.page_h, 841.9), "rotate Asian characters keeps the page upright: {x:?}");
    assert_eq!(margins(&x), (10.0, 20.0, 30.0, 40.0));
    // A landscape section goes portrait on Vertical.
    let mut s = doc();
    let mut v = serde_json::to_value(sect(&s)).unwrap();
    v["landscape"] = json!(true);
    v["pageW"] = json!(841.9);
    v["pageH"] = json!(595.3);
    setup(&mut s, &v);
    s.run("layout.textDirection", &json!({"value": "down"})).unwrap();
    let x = sect(&s);
    assert!(!x.landscape && close(x.page_w, 595.3) && close(x.page_h, 841.9), "a landscape section goes portrait: {x:?}");
}

/// Rotate all text is refused on a section, as Word disables it there (`layout.pageSetup.textDirection.rotateAllText90`,
/// `.rotateAllText270`); the button toggles horizontal and vertical, and `all` reaches every section.
#[test]
fn text_direction_rotate_all_is_refused_on_a_section() {
    use ew_doc::props::TextDirection;
    let mut s = doc();
    let before = sect(&s);
    for v in ["rotate90", "up"] {
        assert!(s.run("layout.textDirection", &json!({"value": v})).is_err(), "{v} is refused on a section");
        assert_eq!(sect(&s), before, "{v} changes nothing");
    }
    s.run("layout.textDirection", &json!({})).unwrap();
    assert_eq!(sect(&s).text_direction, TextDirection::Down);
    s.run("layout.textDirection", &json!({})).unwrap();
    assert_eq!(sect(&s).text_direction, TextDirection::Horizontal);
    s.run("caret.docEnd", &json!({})).unwrap();
    s.run("layout.break", &json!({"kind": "nextPage"})).unwrap();
    assert_eq!(s.doc.sections().len(), 2);
    s.run("layout.textDirection", &json!({"value": "down", "all": true})).unwrap();
    assert!(s.doc.sections().iter().all(|(_, x)| x.text_direction == TextDirection::Down), "both sections turned");
}

/// A cell's direction is written as Word's `w:textDirection` value and read back (`layout.pageSetup.textDirection.vertical`
/// and the rotate rows).
#[test]
fn text_direction_cell_values() {
    use ew_doc::props::TextDirection;
    let written = |s: &Session| {
        let bytes = ew_docx::write(&s.doc).expect("write");
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).expect("zip");
        let mut xml = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("word/document.xml").expect("document.xml"), &mut xml).expect("read xml");
        (bytes, xml)
    };
    let cell_dir = |bytes: &[u8]| {
        let r = ew_docx::read(bytes).expect("read");
        r.body.iter().find_map(|b| b.as_table()).expect("table").rows[0].cells[0].props.text_direction
    };
    for (value, want, ooxml) in [
        ("down", TextDirection::Down, "tbRlV"),
        ("rotate90", TextDirection::Rotate90, "tbRl"),
        ("up", TextDirection::Up, "btLr"),
        ("asian270", TextDirection::Asian270, "lrTbV"),
    ] {
        let mut s = doc();
        s.run("insert.table", &json!({"rows": 1, "cols": 1})).unwrap();
        s.run("layout.textDirection", &json!({"value": value})).unwrap();
        assert_eq!(text_direction_at(&s), want, "{value}");
        let (bytes, xml) = written(&s);
        assert!(xml.contains(&format!(r#"<w:textDirection w:val="{ooxml}"/>"#)), "{value}: {xml}");
        assert_eq!(cell_dir(&bytes), want, "{value} read back");
    }
    // A section's down holds tbRl, its asian270 holds lrTbV, and the page stays portrait for asian270.
    let mut s = doc();
    s.run("layout.textDirection", &json!({"value": "down"})).unwrap();
    let (bytes, xml) = written(&s);
    assert!(xml.contains(r#"<w:textDirection w:val="tbRl"/>"#), "{xml}");
    assert_eq!(ew_docx::read(&bytes).expect("read").sections()[0].1.text_direction, TextDirection::Down);
    s.run("layout.textDirection", &json!({"value": "asian270"})).unwrap();
    let (bytes, xml) = written(&s);
    assert!(xml.contains(r#"<w:textDirection w:val="lrTbV"/>"#), "{xml}");
    assert_eq!(ew_docx::read(&bytes).expect("read").sections()[0].1.text_direction, TextDirection::Asian270);
    assert!(!sect(&s).landscape && sect(&s).page_w < sect(&s).page_h, "the page stays portrait");
}

/// Layout › Text Direction in a text box sets Word's `a:bodyPr/@vert`: Vertical is `eaVert` (upright East Asian),
/// Rotate all text 90 is `vert`, and Rotate Asian characters has no value there (`layout.pageSetup.textDirection.vertical`,
/// `.rotateAllText90`, `.rotateAsianCharacters270`).
#[test]
fn text_direction_text_box_values() {
    use ew_doc::props::{TextDirection, TextVert};
    let mut s = Session::new(ew_doc::Document::new());
    s.run("insert.textBox", &json!({"text": "Box"})).unwrap();
    let vert = |s: &Session| match s.sel.focus.story {
        StoryRef::Part(id) => s.doc.parts.get(&id).expect("part").body.vert,
        _ => panic!("the caret is in the box"),
    };
    s.run("layout.textDirection", &json!({"value": "down"})).unwrap();
    assert_eq!(vert(&s), TextVert::EaVert, "Word's Vertical is eaVert");
    s.run("layout.textDirection", &json!({"value": "rotate90"})).unwrap();
    assert_eq!(vert(&s), TextVert::Vert, "rotate all text 90");
    assert!(s.run("layout.textDirection", &json!({"value": "asian270"})).is_err(), "no value for a box");
    assert_eq!(vert(&s), TextVert::Vert, "and nothing changes");
    assert!(s.run("layout.textDirection", &json!({"value": "diagonal"})).is_err());
    s.run("layout.textDirection", &json!({"value": "horizontal"})).unwrap();
    assert_eq!(vert(&s), TextVert::Horz);
    assert_eq!(TextVert::from_ooxml("eaVert").ooxml(), "eaVert");
    assert_eq!(TextVert::from_ooxml("vert").turn(), TextDirection::Rotate90);
    assert_eq!(TextVert::from_ooxml("eaVert").turn(), TextDirection::Down);
}

/// Each draw, its nested items too (Turned, Rotated, Clip and Group).
fn draws(items: &[ew_doc_layout::display::Draw], out: &mut Vec<ew_doc_layout::display::Draw>) {
    for d in items {
        out.push(d.clone());
        match d {
            ew_doc_layout::display::Draw::Turned { items, .. }
            | ew_doc_layout::display::Draw::Rotated { items, .. }
            | ew_doc_layout::display::Draw::Clip { items, .. } => draws(items, out),
            ew_doc_layout::display::Draw::Group(g) => draws(&g.items, out),
            _ => {}
        }
    }
}

/// The text drawn standing upright (inside `Draw::Rotated`) and the text drawn as laid out.
fn glyph_texts(items: &[ew_doc_layout::display::Draw], rotated: bool, turned_up: &mut String, plain: &mut String) {
    use ew_doc_layout::display::Draw;
    for d in items {
        match d {
            Draw::Rotated { items, .. } => glyph_texts(items, true, turned_up, plain),
            Draw::Turned { items, .. } | Draw::Clip { items, .. } => glyph_texts(items, rotated, turned_up, plain),
            Draw::Group(g) => glyph_texts(&g.items, rotated, turned_up, plain),
            Draw::Glyphs { text, .. } if rotated => turned_up.push_str(text),
            Draw::Glyphs { text, .. } => plain.push_str(text),
            _ => {}
        }
    }
}

/// Layout › Text Direction draws as Word does (`layout.pageSetup.textDirection.rotateAsianCharacters270`, `.rotateAllText90`,
/// `.vertical`): Rotate Asian characters leaves horizontal lines, stands its East Asian characters and brackets up and turns
/// no page; a cell's rotate 90 turns every character; a cell's Vertical stands the East Asian ones upright.
#[test]
fn text_direction_draws_as_word() {
    use ew_doc::props::TextDirection;
    use ew_doc_layout::display::{Draw, page_display};
    let text = "中文ABC「漢」";
    let page = |s: &mut Session| {
        let l = s.layout();
        page_display(&s.doc, &l.pages[0], &Default::default())
    };
    // Rotate Asian characters: `中`, `文`, `「`, `漢`, `」` stand turned, ABC stays as laid out, and the page doesn't turn.
    let mut s = Session::new(ew_doc::Document::from_text(text));
    s.run("layout.textDirection", &json!({"value": "asian270"})).unwrap();
    let d = page(&mut s);
    let mut flat = Vec::new();
    draws(&d, &mut flat);
    assert!(!flat.iter().any(|x| matches!(x, Draw::Turned { .. })), "no turned page");
    let (mut up, mut plain) = (String::new(), String::new());
    glyph_texts(&d, false, &mut up, &mut plain);
    assert_eq!(up, "中文「漢」", "East Asian characters and brackets stand upright");
    assert_eq!(plain, "ABC", "Latin stays as laid out");
    let turned_x = s.layout().caret(&Pos::body(0, 2)).expect("caret").x;
    let mut h = Session::new(ew_doc::Document::from_text(text));
    let flat_x = h.layout().caret(&Pos::body(0, 2)).expect("caret").x;
    assert!((turned_x - flat_x).abs() < 0.01, "the caret stays where the horizontal section puts it: {turned_x} {flat_x}");

    // A cell's rotate 90 turns everything, East Asian characters included; its Vertical stands them upright.
    let mut s = Session::new(ew_doc::Document::new());
    s.run("insert.table", &json!({"rows": 1, "cols": 1})).unwrap();
    s.run("text.insert", &json!({"text": text})).unwrap();
    s.run("layout.textDirection", &json!({"value": "rotate90"})).unwrap();
    assert_eq!(text_direction_at(&s), TextDirection::Rotate90);
    let mut flat = Vec::new();
    draws(&page(&mut s), &mut flat);
    assert!(flat.iter().any(|x| matches!(x, Draw::Turned { .. })), "the cell is turned");
    assert!(!flat.iter().any(|x| matches!(x, Draw::Rotated { .. })), "no character stands upright");
    s.run("layout.textDirection", &json!({"value": "down"})).unwrap();
    let mut flat = Vec::new();
    draws(&page(&mut s), &mut flat);
    let turned = flat.iter().find(|x| matches!(x, Draw::Turned { .. })).expect("a turned cell");
    assert!(
        matches!(turned, Draw::Turned { items, .. } if items.iter().any(|i| matches!(i, Draw::Rotated { .. }))),
        "Vertical stands the East Asian characters upright inside the turned cell"
    );
}
