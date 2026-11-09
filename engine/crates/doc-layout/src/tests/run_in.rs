//! EasyWriter engine-style-separator: paragraphs joined by style separators, laid out as Word lays them out in the probes
//! sep-15, sep-pages-15 and sep-more-15 (.smoke-data/word/fixture/walk/sep_probes_docx.py, docs/plans/engine/fidelity.md).
use crate::hit::Caret;
use crate::*;
use ew_doc::props::{Align, CharProps, LineSpacing, NumRef, ParaProps};
use ew_doc::{Paragraph, Pos, para_block};

const LONG: &str = "the quick brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog the quick brown fox \
                    jumps over the lazy dog the quick brown fox jumps over the lazy dog";

fn lay(d: &Document) -> DocLayout {
    layout(d, &mut LayoutCache::new(), &LayoutOptions::default())
}

/// A paragraph of 12 pt `text`, no space before or after, single lines, widow control off; `f` sets the rest.
fn para(text: &str, f: impl FnOnce(&mut ParaProps)) -> Paragraph {
    let mut p = Paragraph::with_text(text, CharProps { size: Some(12.0), ..Default::default() });
    (p.props.space_before, p.props.space_after, p.props.line_spacing) = (Some(0.0), Some(0.0), Some(LineSpacing::Multiple(1.0)));
    p.props.widow_control = Some(false);
    f(&mut p.props);
    p
}

/// `p` ending in a style separator, as Word writes one (`w:vanish` and `w:specVanish` on its mark).
fn sep(mut p: Paragraph) -> Paragraph {
    (p.mark.hidden, p.mark.spec_vanish) = (Some(true), Some(true));
    p
}

fn doc(paras: Vec<Paragraph>) -> Document {
    let mut d = Document::new();
    d.body = paras.into_iter().map(para_block).collect();
    d
}

fn at(l: &DocLayout, block: usize, off: usize) -> Caret {
    l.caret(&Pos::body(block, off)).unwrap()
}

/// The caret before the first character of the line after the one `off` is on.
fn next_line(l: &DocLayout, block: usize, d: &Document, off: usize) -> Caret {
    let here = at(l, block, off);
    let len = d.body[block].as_para().unwrap().text.len();
    (off..=len).map(|k| at(l, block, k)).find(|c| c.top > here.top + 1.0 || c.page != here.page).unwrap()
}

/// sep-15 case A and K: the next paragraph's first line continues the separator's last line, after its text; its other
/// lines start at the column's edge, and a two-line separator runs on in its second line.
#[test]
fn the_next_paragraph_runs_on_in_the_separators_last_line() {
    let d = doc(vec![para("before", |_| {}), sep(para("Heading.", |_| {})), para(LONG, |_| {}), para("after", |_| {})]);
    let l = lay(&d);
    let (s_end, p0) = (at(&l, 1, "Heading.".len()), at(&l, 2, 0));
    assert!((p0.top - s_end.top).abs() < 0.01 && p0.page == s_end.page, "on the separator's line: {p0:?} {s_end:?}");
    assert!((p0.x - s_end.x).abs() < 0.01, "after its text: {} {}", p0.x, s_end.x);
    let line2 = next_line(&l, 2, &d, 0);
    assert!((line2.x - 72.0).abs() < 0.5, "the second line at the column's edge: {}", line2.x);
    let before = at(&l, 0, 0);
    assert!((p0.top - before.top - before.height).abs() < 1.0, "one line under the paragraph before: {p0:?} {before:?}");

    let d = doc(vec![sep(para(LONG, |_| {})), para("PK body", |_| {})]);
    let l = lay(&d);
    let (s_end, p0) = (at(&l, 0, LONG.len()), at(&l, 1, 0));
    assert!(s_end.top > at(&l, 0, 0).top + 1.0, "the separator takes two lines");
    assert!((p0.top - s_end.top).abs() < 0.01 && (p0.x - s_end.x).abs() < 0.01, "on its second line: {p0:?} {s_end:?}");
}

/// sep-15 case B: the separator's space before stays; its space after and the next paragraph's space before go, and the
/// next paragraph's space after holds.
#[test]
fn the_run_keeps_the_first_space_before_and_the_last_space_after() {
    let d = doc(vec![
        para("label", |_| {}),
        sep(para("Head.", |p| (p.space_before, p.space_after) = (Some(24.0), Some(18.0)))),
        para(LONG, |p| (p.space_before, p.space_after) = (Some(6.0), Some(12.0))),
        para("after", |_| {}),
    ]);
    let l = lay(&d);
    let (label, s, p_last, z) = (at(&l, 0, 0), at(&l, 1, 0), at(&l, 2, LONG.len()), at(&l, 3, 0));
    let pitch = s.height;
    assert!((s.top - label.top - pitch - 24.0).abs() < 0.5, "24 pt before the separator: {} {}", label.top, s.top);
    assert!((at(&l, 2, 0).top - s.top).abs() < 0.01, "nothing between them");
    assert!((z.top - p_last.top - pitch - 12.0).abs() < 0.5, "the next paragraph's 12 pt after: {} {}", p_last.top, z.top);
}

/// sep-15 cases C and D and sep-more-15 C2: the separator's indents hold for the next paragraph's lines too, and that
/// paragraph's own are left out.
#[test]
fn the_run_takes_the_first_paragraphs_indents() {
    let d = doc(vec![sep(para("Head.", |p| (p.indent_left, p.indent_right) = (Some(72.0), Some(144.0)))), para(LONG, |_| {})]);
    let l = lay(&d);
    assert!((at(&l, 0, 0).x - 144.0).abs() < 0.5, "the separator at its indent");
    let line2 = next_line(&l, 1, &d, 0);
    assert!((line2.x - 144.0).abs() < 0.5, "the next paragraph's second line at the separator's indent: {}", line2.x);
    let ends = (0..=LONG.len()).map(|k| at(&l, 1, k).x).fold(0.0f32, f32::max);
    assert!(ends <= 540.0 - 144.0 + 0.5, "and within its right indent: {ends}");

    let d = doc(vec![sep(para("Head.", |_| {})), para(LONG, |p| (p.indent_left, p.indent_first) = (Some(72.0), Some(36.0)))]);
    let l = lay(&d);
    assert!((next_line(&l, 1, &d, 0).x - 72.0).abs() < 0.5, "the next paragraph's own indents are left out");
}

/// sep-15 cases E, F and V: the separator's alignment aligns the whole line; the next paragraph's is left out.
#[test]
fn the_line_takes_the_separators_alignment() {
    let d = doc(vec![sep(para("Head.", |p| p.align = Some(Align::Center))), para("short body.", |_| {})]);
    let l = lay(&d);
    let (start, end) = (at(&l, 0, 0).x, at(&l, 1, "short body.".len()).x);
    assert!(((start + end) / 2.0 - 306.0).abs() < 0.5, "the line is centred on the column: {start} to {end}");
    assert!((at(&l, 1, 0).x - at(&l, 0, "Head.".len()).x).abs() < 0.01, "the text follows on");

    let d = doc(vec![sep(para("Head.", |_| {})), para("short body.", |p| p.align = Some(Align::Center))]);
    let l = lay(&d);
    assert!((at(&l, 0, 0).x - 72.0).abs() < 0.5, "a centred next paragraph stays at the left: {}", at(&l, 0, 0).x);
}

/// sep-15 cases G and H: a justified separator justifies the run's lines, the shared one too, its own spaces with the rest;
/// a justified next paragraph after a left-aligned separator is not justified.
#[test]
fn a_justified_separator_justifies_the_shared_line() {
    let s_text = "Head and more.";
    // A long word that wraps leaves the shared line well short of the margin.
    let p_text = format!("body text {} end", "w".repeat(40));
    let run = |s: Option<Align>, p: Option<Align>| lay(&doc(vec![sep(para(s_text, |x| x.align = s)), para(&p_text, |x| x.align = p)]));
    let (plain, justified) = (run(None, None), run(Some(Align::Justify), None));
    let shared = |l: &DocLayout| placed(l).into_iter().find(|r| r.0 == Path::top(1) && r.1 == 0).unwrap();
    assert!(shared(&plain).4 < 540.0 - 50.0, "the plain shared line ends short of the margin: {}", shared(&plain).4);
    assert!((shared(&justified).4 - 540.0).abs() < 2.0, "the justified one reaches it: {}", shared(&justified).4);
    let sp = "Head and".len();
    assert!(at(&justified, 0, sp).x > at(&plain, 0, sp).x + 0.5, "the separator's own spaces stretch: {} {}", at(&justified, 0, sp).x, at(&plain, 0, sp).x);
    assert!((at(&justified, 1, 0).x - at(&justified, 0, s_text.len()).x).abs() < 0.01, "and the next text follows on");
    let next_justified = run(None, Some(Align::Justify));
    assert!((shared(&next_justified).4 - shared(&plain).4).abs() < 0.01, "a justified next paragraph is not");
}

/// The placed lines: (path, line, page, top, end of the text (x), height).
fn placed(l: &DocLayout) -> Vec<(Path, usize, usize, f32, f32, f32)> {
    let mut v = Vec::new();
    for (pi, pg) in l.pages.iter().enumerate() {
        for it in &pg.items {
            if let Placed::Lines { path, para, l0, l1, x, y, .. } = it {
                let f = &para.lines[*l0];
                for li in *l0..*l1 {
                    let ln = &para.lines[li];
                    let end = (ln.c0..ln.c1).rev().find(|&c| para.clusters[c].kind != para::ClKind::Space).map_or(ln.xs[0], |c| ln.xs[c - ln.c0 + 1]);
                    v.push((path.clone(), li, pi, y + ln.top - f.top, x + end, ln.height));
                }
            }
        }
    }
    v
}

/// sep-15 cases I and J, sep-more-15 K2 and K3: the shared line takes the line spacing of the paragraph whose text ends it,
/// the next paragraph's; the separator's own lines before it keep the separator's.
#[test]
fn the_shared_line_takes_the_next_paragraphs_line_spacing() {
    let heights = |s: LineSpacing, p: LineSpacing| {
        let l = lay(&doc(vec![sep(para(LONG, |x| x.line_spacing = Some(s))), para(LONG, |x| x.line_spacing = Some(p))]));
        let rows = placed(&l);
        let h = |path: usize, li: usize| rows.iter().find(|r| r.0 == Path::top(path) && r.1 == li).map(|r| (r.3, r.5)).unwrap();
        let (s0, s1, p0, p1) = (h(0, 0), h(0, 1), h(1, 0), h(1, 1));
        assert!((s1.0 - p0.0).abs() < 0.01 && (s1.1 - p0.1).abs() < 0.01, "the separator's last line is the shared one: {s1:?} {p0:?}");
        (s0.1, p0.1, p1.1)
    };
    let (_, single, _) = heights(LineSpacing::Multiple(1.0), LineSpacing::Multiple(1.0));
    assert_eq!(heights(LineSpacing::Exactly(30.0), LineSpacing::Multiple(1.0)), (30.0, single, single), "K2 and I");
    assert_eq!(heights(LineSpacing::Multiple(1.0), LineSpacing::Exactly(30.0)), (single, 30.0, 30.0), "K3 and J");
}

/// sep-15 case A: a larger separator makes the shared line taller, both texts on one baseline.
#[test]
fn the_shared_line_holds_both_texts_on_one_baseline() {
    let big = |p: &mut Paragraph| {
        for r in &mut p.runs {
            r.props.size = Some(16.0);
        }
    };
    let mut s = sep(para("Heading.", |_| {}));
    big(&mut s);
    let d = doc(vec![s, para(LONG, |_| {})]);
    let l = lay(&d);
    let (s0, p0) = (at(&l, 0, 0), at(&l, 1, 0));
    assert!(s0.height > p0.height + 1.0, "the carets keep their own text's height: {s0:?} {p0:?}");
    let line2 = next_line(&l, 1, &d, 0);
    let plain = doc(vec![sep(para("Heading.", |_| {})), para(LONG, |_| {})]);
    let lp = lay(&plain);
    let line2_plain = next_line(&lp, 1, &plain, 0);
    assert!(line2.top - at(&l, 0, 0).top > line2_plain.top - at(&lp, 0, 0).top + 1.0, "the shared line is taller");
    // One baseline: the bottoms of the carets (each its own text's descent below it) differ by the descents only.
    assert!(((s0.top + s0.height) - (p0.top + p0.height)).abs() < 1.5, "{s0:?} {p0:?}");
}

/// sep-more-15 Q2: the next paragraph's list number is counted but not drawn, and the separator keeps its own.
#[test]
fn the_next_paragraphs_list_number_counts_but_is_not_drawn() {
    let mut d = doc(vec![sep(para("Head.", |_| {})), para("short body.", |_| {}), para("third item", |_| {})]);
    let id = d.numbering_mut().add_list(ew_doc::ListKind::Numbered);
    d.format_paragraphs(&Pos::body(0, 0), &Pos::body(2, 1), &|p| p.numbering = Some(NumRef { num: id, level: 0 })).unwrap();
    let l = lay(&d);
    let labels: Vec<(Path, Option<String>)> = l.pages[0]
        .items
        .iter()
        .filter_map(|it| if let Placed::Lines { path, para, .. } = it { Some((path.clone(), para.label.as_ref().map(|x| x.text.clone()))) } else { None })
        .collect();
    assert_eq!(labels, vec![(Path::top(0), Some("1.".into())), (Path::top(1), None), (Path::top(2), Some("3.".into()))]);
    assert!((at(&l, 1, 0).top - at(&l, 0, 0).top).abs() < 0.01, "on one line");
}

/// The page with `n` 14 pt lines of filler before the run, the run's paragraphs set by `s` and `p` (sep-pages-15 and
/// sep-more-15: Letter's 648 pt column holds 46 of them, so 45 put the shared line last on the page).
fn at_page_foot(n: usize, s: impl FnOnce(&mut ParaProps), p: impl FnOnce(&mut ParaProps), p_text: &str) -> (Document, DocLayout) {
    let exact = |x: &mut ParaProps| x.line_spacing = Some(LineSpacing::Exactly(14.0));
    let mut paras: Vec<Paragraph> = (0..n).map(|i| para(&format!("filler {i}"), exact)).collect();
    paras.push(sep(para("head.", |x| {
        exact(x);
        s(x);
    })));
    paras.push(para(p_text, |x| {
        exact(x);
        p(x);
    }));
    paras.push(para("after one", exact));
    paras.push(para("after two", exact));
    let d = doc(paras);
    let l = lay(&d);
    (d, l)
}

/// sep-more-15 w0, w1, w2, k1, k2 and k3: the separator's widow control, keep lines together and keep with next hold for the
/// run, and the next paragraph's are left out.
#[test]
fn the_run_paginates_by_the_separators_keeps() {
    let lines_on_page = 648.0 / 14.0;
    let n = lines_on_page as usize - 1;
    // The separator's page, the next paragraph's, and the page of that one's second line.
    let page_of = |n: usize, (d, l): (Document, DocLayout)| (at(&l, n, 0).page, at(&l, n + 1, 0).page, next_line(&l, n + 1, &d, 0).page);
    // Widow control off on the separator: the shared line stays at the foot, whatever the next paragraph says.
    assert_eq!(page_of(n, at_page_foot(n, |_| {}, |p| p.widow_control = Some(true), LONG)), (0, 0, 1), "w1");
    // On: the shared line alone would be an orphan, so it goes over.
    assert_eq!(page_of(n, at_page_foot(n, |s| s.widow_control = Some(true), |_| {}, LONG)), (1, 1, 1), "w2");
    // Keep lines together on the separator moves the run whole.
    let long = format!("{LONG} {LONG}");
    assert_eq!(page_of(n - 1, at_page_foot(n - 1, |s| s.keep_lines = Some(true), |_| {}, &long)).0, 1, "k1");
    assert_eq!(page_of(n - 1, at_page_foot(n - 1, |_| {}, |p| p.keep_lines = Some(true), &long)).0, 0, "keep lines on the next one is left out");
    // Keep with next on the separator keeps the run with the paragraph after it; on the next paragraph it is left out.
    let (_, l) = at_page_foot(n, |s| s.keep_next = Some(true), |_| {}, "body.");
    assert_eq!((at(&l, n, 0).page, at(&l, n + 2, 0).page), (1, 1), "k2");
    let (_, l) = at_page_foot(n, |_| {}, |p| p.keep_next = Some(true), "body.");
    assert_eq!((at(&l, n, 0).page, at(&l, n + 2, 0).page), (0, 1), "k3");
}

/// sep-15 case W: a next paragraph with Page Break Before starts its page, and the separator keeps its line.
#[test]
fn page_break_before_ends_the_run() {
    let d = doc(vec![sep(para("Head.", |_| {})), para("body after the separator.", |p| p.page_break_before = Some(true))]);
    let l = lay(&d);
    let (s, p) = (at(&l, 0, 0), at(&l, 1, 0));
    assert_eq!((s.page, p.page), (0, 1));
    assert!((p.x - 72.0).abs() < 0.5);
}

/// sep-15 case L: three paragraphs on one line, and a run inside a table cell as in the body.
#[test]
fn separators_chain_and_join_in_cells() {
    let d = doc(vec![sep(para("SL1 first.", |_| {})), sep(para("SL2 second.", |_| {})), para(LONG, |_| {})]);
    let l = lay(&d);
    let (a, b, c) = (at(&l, 0, "SL1 first.".len()), at(&l, 1, 0), at(&l, 2, 0));
    assert!((a.x - b.x).abs() < 0.01 && (a.top - b.top).abs() < 0.01, "the second after the first: {a:?} {b:?}");
    let b_end = at(&l, 1, "SL2 second.".len());
    assert!((c.x - b_end.x).abs() < 0.01 && (c.top - b.top).abs() < 0.01, "the third after the second: {b_end:?} {c:?}");

    let mut d = Document::new();
    let cell = vec![para_block(sep(para("cell head.", |_| {}))), para_block(para("cell text", |_| {}))];
    d.body = vec![para_block(para("before", |_| {})), Arc::new(Block::Table(ew_doc::Table::new(1, 1, 468.0))), para_block(para("after", |_| {}))];
    if let Some(Block::Table(t)) = d.body.get_mut(1).map(Arc::make_mut) {
        t.rows[0].cells[0].blocks = cell;
    }
    let l = lay(&d);
    let pos = |path: Vec<u32>, off: usize| l.caret(&Pos { story: StoryRef::Body, path: Path(path), off }).unwrap();
    let (h, t) = (pos(vec![1, 0, 0, 0], "cell head.".len()), pos(vec![1, 0, 0, 1], 0));
    assert!((h.x - t.x).abs() < 0.01 && (h.top - t.top).abs() < 0.01, "in a cell: {h:?} {t:?}");
}

/// Where hidden text shows (with the formatting marks) the separator's mark takes room before the next paragraph's text.
#[test]
fn the_mark_takes_room_where_hidden_text_shows() {
    let d = doc(vec![sep(para("Head.", |_| {})), para("body", |_| {})]);
    let opts = LayoutOptions { show_hidden: true, ..Default::default() };
    let l = layout(&d, &mut LayoutCache::new(), &opts);
    let (s_end, p0) = (at(&l, 0, "Head.".len()), at(&l, 1, 0));
    assert!((p0.top - s_end.top).abs() < 0.01, "still on one line");
    assert!((p0.x - s_end.x - run_in::mark_room(true)).abs() < 0.01, "after the mark: {} {}", s_end.x, p0.x);
}

/// sep-15 case M: an empty separator takes no room, and its caret sits where the next paragraph's text starts.
#[test]
fn an_empty_separator_takes_no_room() {
    let d = doc(vec![para("label", |_| {}), sep(para("", |_| {})), para(LONG, |_| {})]);
    let l = lay(&d);
    let (label, s, p) = (at(&l, 0, 0), at(&l, 1, 0), at(&l, 2, 0));
    assert!((p.top - label.top - label.height).abs() < 1.0, "one line under the label: {label:?} {p:?}");
    assert!((s.top - p.top).abs() < 0.01 && (s.x - p.x).abs() < 0.01 && (p.x - 72.0).abs() < 0.5, "{s:?} {p:?}");
}

/// The separator's ¶ shows only with the formatting marks, in a dotted box, at the end of its text on the shared line.
#[test]
fn the_separators_mark_shows_dotted_with_the_marks() {
    let d = doc(vec![sep(para("Head.", |_| {})), para("body", |_| {})]);
    let opts = LayoutOptions { show_hidden: true, ..Default::default() };
    let l = layout(&d, &mut LayoutCache::new(), &opts);
    let draws = |marks: bool| display::page_display(&d, &l.pages[0], &display::DisplayOptions { marks, ..Default::default() });
    let pilcrows = |items: &[display::Draw]| items.iter().filter_map(|i| if let display::Draw::Mark { ch: '¶', x, .. } = i { Some(*x) } else { None }).collect::<Vec<_>>();
    let dotted = |items: &[display::Draw]| items.iter().filter(|i| matches!(i, display::Draw::Line { stroke: display::Stroke::Dotted, .. })).count();
    let (shown, hidden) = (draws(true), draws(false));
    let marks = pilcrows(&shown);
    assert_eq!(marks.len(), 2, "both marks with the marks on: {marks:?}");
    let s_end = at(&l, 0, "Head.".len()).x;
    assert!(marks.iter().any(|x| (x - s_end - 1.0).abs() < 0.5), "the separator's after its text: {marks:?} {s_end}");
    assert_eq!(dotted(&shown), 4, "one dotted box");
    assert!(pilcrows(&hidden).is_empty() && dotted(&hidden) == 0, "nothing without them");
}

/// A paragraph that takes no room after a separator (its text and mark a deletion the final text leaves out, or hidden
/// text not shown) does not end the run: Word joins through its mark, so the next paragraph that shows runs on in the
/// separator's line, and the separator's line keeps its height.
#[test]
fn the_run_joins_through_a_paragraph_that_takes_no_room() {
    let check = |d: &Document, opts: &LayoutOptions, what: &str| {
        let l = layout(d, &mut LayoutCache::new(), opts);
        let (label, s_end, next) = (at(&l, 0, 0), at(&l, 1, "Heading.".len()), at(&l, 3, 0));
        assert!((s_end.height - label.height).abs() < 1.0, "{what}: the separator's line keeps its height: {label:?} {s_end:?}");
        assert!((s_end.top - label.top - label.height).abs() < 1.0, "{what}: one line under the label: {label:?} {s_end:?}");
        assert!((next.top - s_end.top).abs() < 0.01 && (next.x - s_end.x).abs() < 0.01, "{what}: runs on after it: {s_end:?} {next:?}");
    };
    let mut gone = para("Deleted.", |_| {});
    gone.runs.iter_mut().for_each(|r| r.props.del = Some(0));
    gone.mark.del = Some(0);
    let d = doc(vec![para("label", |_| {}), sep(para("Heading.", |_| {})), gone, para("After it.", |_| {})]);
    check(&d, &LayoutOptions { hide_deleted: true, ..Default::default() }, "a tracked deletion in Simple Markup");

    let mut hidden = para("Hidden.", |_| {});
    hidden.runs.iter_mut().for_each(|r| r.props.hidden = Some(true));
    hidden.mark.hidden = Some(true);
    let d = doc(vec![para("label", |_| {}), sep(para("Heading.", |_| {})), hidden, para("After it.", |_| {})]);
    check(&d, &LayoutOptions::default(), "a hidden paragraph");
}

/// engine-style-separator-2's Word probe sep-vanish-15 (Word 2013's layout, hidden text not shown): a mark whose
/// `w:specVanish` and `w:vanish` come from its character style (M2, M3) is a separator as a direct one is (M0), and Word joins
/// on any hidden mark while hidden text does not show (M6: `w:vanish` alone); `w:specVanish` without `w:vanish` (M1, M5) is
/// a plain mark. Where hidden text shows, only a separator joins.
#[test]
fn a_separator_takes_its_hidden_marks_from_its_styles() {
    let style = |id: &str, c: CharProps| ew_doc::Style { id: id.into(), name: id.into(), kind: ew_doc::StyleKind::Character, chr: c, ..Default::default() };
    let joins = |mark: CharProps, show_hidden: bool| {
        let mut s = para("Head.", |_| {});
        s.mark = mark;
        let mut d = doc(vec![para("label", |_| {}), s, para("body.", |_| {})]);
        d.styles_mut().upsert(style("SepBoth", CharProps { hidden: Some(true), spec_vanish: Some(true), ..Default::default() }));
        d.styles_mut().upsert(style("SepSpec", CharProps { spec_vanish: Some(true), ..Default::default() }));
        let l = layout(&d, &mut LayoutCache::new(), &LayoutOptions { show_hidden, ..Default::default() });
        let (s_end, p0) = (at(&l, 1, "Head.".len()), at(&l, 2, 0));
        (p0.top - s_end.top).abs() < 0.01 && p0.x > s_end.x - 0.01
    };
    let on = |h: bool, v: bool| CharProps { hidden: h.then_some(true), spec_vanish: v.then_some(true), ..Default::default() };
    let styled = |st: &str, c: CharProps| CharProps { style: Some(st.into()), ..c };
    let cases = [
        ("M0 direct", on(true, true), true, true),
        ("M1 specVanish only", on(false, true), false, false),
        ("M2 style SepBoth", styled("SepBoth", on(false, false)), true, true),
        ("M3 style SepSpec, direct vanish", styled("SepSpec", on(true, false)), true, true),
        ("M5 style SepSpec only", styled("SepSpec", on(false, false)), false, false),
        ("M6 vanish only", on(true, false), true, false),
    ];
    for (what, mark, hidden_off, hidden_on) in cases {
        assert_eq!((joins(mark.clone(), false), joins(mark, true)), (hidden_off, hidden_on), "{what}: (joins, joins where hidden text shows)");
    }
}

/// Enter inside a paragraph whose hidden mark joins it to the next (sep-vanish-15 M0, M2, M3 and M6): Word puts the new,
/// plain mark at the caret and the hidden one stays at the paragraph's end, so the part before the caret ends its own line
/// and the part after still runs on into the next paragraph.
#[test]
fn enter_leaves_the_hidden_mark_at_the_paragraphs_end() {
    let on = |h: bool, v: bool| CharProps { hidden: h.then_some(true), spec_vanish: v.then_some(true), ..Default::default() };
    let styled = |st: &str, c: CharProps| CharProps { style: Some(st.into()), ..c };
    let cases = [
        ("M0 direct", on(true, true)),
        ("M2 style SepBoth", styled("SepBoth", on(false, false))),
        ("M3 style SepSpec, direct vanish", styled("SepSpec", on(true, false))),
        ("M6 vanish only", on(true, false)),
    ];
    for (what, mark) in cases {
        let mut s = para("Head body", |_| {});
        s.mark = mark;
        let mut d = doc(vec![s, para("Next.", |_| {})]);
        let style = |id: &str, c: CharProps| ew_doc::Style { id: id.into(), name: id.into(), kind: ew_doc::StyleKind::Character, chr: c, ..Default::default() };
        d.styles_mut().upsert(style("SepBoth", on(true, true)));
        d.styles_mut().upsert(style("SepSpec", on(false, true)));
        d.split_paragraph(&Pos::body(0, "Head".len())).unwrap();
        let l = lay(&d);
        let (head_end, tail0) = (at(&l, 0, "Head".len()), at(&l, 1, 0));
        assert!(tail0.top > head_end.top + 1.0, "{what}: the head ends its own line: {head_end:?} {tail0:?}");
        let (tail_end, next0) = (at(&l, 1, " body".len()), at(&l, 2, 0));
        assert!((next0.top - tail_end.top).abs() < 0.01, "{what}: the tail still runs on: {tail_end:?} {next0:?}");
    }
}

/// The separator's line reaches to where the next text starts on the line, its leftmost glyph: on a line that starts with
/// right-to-left text that is not the first character, which is drawn at the right end of its word.
#[test]
fn the_waiting_line_ends_at_the_next_texts_left_edge() {
    let d = doc(vec![sep(para("Head.", |_| {})), para("שלום body", |_| {})]);
    let l = lay(&d);
    let lines = |path: Path| {
        l.pages[0].items.iter().find_map(|it| match it {
            Placed::Lines { path: p, para, l0, .. } if *p == path => Some(para.lines[*l0].clone()),
            _ => None,
        })
    };
    let (head, next) = (lines(Path::top(0)).unwrap(), lines(Path::top(1)).unwrap());
    assert!(!next.vis.is_empty(), "the next line is laid out bidirectionally");
    let left = next.vis.iter().map(|v| v.x).fold(f32::MAX, f32::min);
    assert!(next.xs[0] > left + 1.0, "the first character is not the leftmost: {} {left}", next.xs[0]);
    assert!((head.right - left).abs() < 0.01, "the separator's line ends where the next text starts: {} {left}", head.right);
}

/// sep-vanish-15 V1: a run with `w:specVanish` and no `w:vanish` shows; only a hidden run is left out.
#[test]
fn a_run_with_spec_vanish_alone_shows() {
    let mut p = para("before ", |_| {});
    p.insert_text(p.len(), "SHOWN", &CharProps { size: Some(12.0), spec_vanish: Some(true), ..Default::default() }).unwrap();
    let d = doc(vec![p]);
    let l = lay(&d);
    assert!(at(&l, 0, "before SHOWN".len()).x > at(&l, 0, "before ".len()).x + 20.0, "the run takes room");
}

/// A justified shared line with right-to-left text before the next paragraph: what is drawn sits where the carets are, each
/// glyph of the separator's text at its caret, and the separator's text ends where the next paragraph's starts.
#[test]
fn a_justified_shared_line_draws_where_its_carets_are() {
    let s_text = "Head שלום עולם and more.";
    let p_text = format!("body text {} end", "w".repeat(40));
    let d = doc(vec![sep(para(s_text, |x| x.align = Some(Align::Justify))), para(&p_text, |_| {})]);
    let l = lay(&d);
    let page = &l.pages[0];
    let items = display::page_display(&d, page, &Default::default());
    // Each drawn glyph of the separator's text and its cluster's caret: a glyph starts at its cluster's left edge, which is a
    // caret's x (the leading edge of left-to-right text, the trailing edge of right-to-left).
    let mut drawn = Vec::new();
    for it in &items {
        if let display::Draw::Glyphs { glyphs, text, ranges, .. } = it {
            for (k, (_, x, _)) in glyphs.iter().enumerate() {
                if let Some(t) = ranges.get(k).and_then(|r| text.get(r.clone())) {
                    drawn.push((t.to_string(), *x));
                }
            }
        }
    }
    for word in ["Head", "and", "more."] {
        let first = &word[..1];
        let off = s_text.find(word).unwrap();
        let x = drawn.iter().filter(|(t, _)| t == first).map(|(_, x)| *x).min_by(|a, b| (a - at(&l, 0, off).x).abs().total_cmp(&(b - at(&l, 0, off).x).abs())).unwrap();
        assert!((x - at(&l, 0, off).x).abs() < 0.05, "{word}: drawn at {x}, caret at {}", at(&l, 0, off).x);
    }
    let (s_end, p0) = (at(&l, 0, s_text.len()), at(&l, 1, 0));
    assert!((p0.x - s_end.x).abs() < 0.05, "the next text follows on: {} {}", s_end.x, p0.x);
    let right = drawn.iter().filter(|(t, _)| t == ".").map(|(_, x)| *x).fold(f32::MIN, f32::max);
    assert!(right < p0.x, "the separator's text ends before the next paragraph's: {right} {}", p0.x);
}
