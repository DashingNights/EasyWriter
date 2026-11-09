//! engine-edit-path and engine-keys (docs/plans/word/briefs/engine-edit-path.md, engine-keys.md): the typing keys (letters,
//! space and punctuation with AutoCorrect, Enter, Backspace, Delete, typing over a selection, in table cells too) take the
//! bounded edit path (the engine crate's session/edit_path.rs), and leave the document and the undo history exactly as the
//! whole-document path does. Two sessions get the same random edits (typing, deleting, splitting and joining paragraphs,
//! styles, formatting at the caret, selections, undo and redo), one with bounded edits and one without, and are compared
//! after every command: on small documents with tables, lists, a section break, a bookmark, a footnote, a text box and
//! content controls, and on the Word fixture.
//! Track Changes stays out of the random edits: a tracked insertion's revision carries the clock's second, so the two
//! sessions could differ by the time alone. Light edits refuse it, which the first test checks.
//!   cargo test --release -p ew-wasm --test edit_path
use serde_json::{Value, json};
use ew_doc_edit::Session;
use ew_doc_edit::doc::{Document, Path, Pos, StoryRef};

/// xorshift64: the edits are random but the same on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

const WORDS: &[&str] = &["layout", "page", "the", "a", "keystroke", "paragraph", "of", "edit", "Word", "engine", "text", "line"];

fn words(rng: &mut Rng, n: usize) -> String {
    (0..n).map(|_| WORDS[rng.below(WORDS.len())]).collect::<Vec<_>>().join(" ")
}

/// Whether `a` (light edits) and `b` (the whole-document path) are in the same state: document, selection, formatting at
/// the caret, typing step, unsaved flag, status, every undo and redo label, and the newest undo and redo steps in full.
fn same(a: &Session, b: &Session) -> Result<(), String> {
    if !a.doc.same_content(&b.doc) {
        let block = a.doc.body.iter().zip(&b.doc.body).position(|(x, y)| x != y);
        let text = |d: &Document| block.and_then(|i| d.body[i].as_para()).map(|p| p.text.clone());
        let parts: Vec<&u32> = a.doc.parts.keys().filter(|k| a.doc.parts.get(k) != b.doc.parts.get(k)).collect();
        return Err(format!(
            "the documents differ: body block {block:?} ({:?} and {:?}), parts {parts:?}, {} and {} body blocks",
            text(&a.doc),
            text(&b.doc),
            a.doc.body.len(),
            b.doc.body.len()
        ));
    }
    if a.sel != b.sel {
        return Err(format!("the selections differ: {:?} and {:?}", a.sel, b.sel));
    }
    if a.pending != b.pending || a.typing_open() != b.typing_open() || a.dirty != b.dirty || a.status != b.status {
        return Err("the formatting at the caret, the typing step, the unsaved flag or the status differ".into());
    }
    for redo in [false, true] {
        let (x, y) = (a.history_steps(redo), b.history_steps(redo));
        let labels = |v: &[(&str, &Document, _, _)]| v.iter().map(|s| s.0.to_string()).collect::<Vec<_>>();
        if labels(&x) != labels(&y) {
            return Err(format!("the {} steps differ: {:?} and {:?}", if redo { "redo" } else { "undo" }, labels(&x), labels(&y)));
        }
        for (s, t) in x.iter().rev().zip(y.iter().rev()).take(2) {
            if !s.1.same_content(t.1) || s.2 != t.2 || s.3 != t.3 {
                return Err(format!("the {} step '{}' holds a different state", if redo { "redo" } else { "undo" }, s.0));
            }
        }
    }
    Ok(())
}

thread_local! {
    /// Per command (and the typed text's kind), how many ran and how many of them took the bounded path.
    static TALLY: std::cell::RefCell<std::collections::BTreeMap<String, (u64, u64)>> = Default::default();
}

/// The tally's name for command `id` with `args`.
fn kind(id: &str, args: &Value) -> String {
    match args.get("text").and_then(Value::as_str) {
        Some(t) if t.chars().count() == 1 && (t == " " || ",.;:!?".contains(t)) => format!("{id} {t:?}"),
        Some(_) => format!("{id} text"),
        None => id.to_string(),
    }
}

/// The tally so far, and empties it.
fn tally() -> std::collections::BTreeMap<String, (u64, u64)> {
    TALLY.with(|t| std::mem::take(&mut *t.borrow_mut()))
}

/// Runs command `id` on both sessions and compares them.
fn both(a: &mut Session, b: &mut Session, id: &str, args: &Value, what: &str) {
    let light = a.light_edits();
    let (x, y) = (a.run(id, args), b.run(id, args));
    TALLY.with(|t| {
        let mut t = t.borrow_mut();
        let e = t.entry(kind(id, args)).or_default();
        e.0 += 1;
        e.1 += a.light_edits() - light;
    });
    assert_eq!(format!("{x:?}"), format!("{y:?}"), "{what}: {id} {args} returned differently");
    if let Err(e) = same(a, b) {
        panic!("{what}: after {id} {args}: {e}");
    }
}

/// Every paragraph of every story, as a place to type: (story, path, length).
fn places(doc: &Document, near: Option<usize>) -> Vec<(StoryRef, Path, usize)> {
    let stories = std::iter::once(StoryRef::Body).chain(doc.parts.keys().map(|k| StoryRef::Part(*k)));
    let mut out = Vec::new();
    for story in stories {
        for path in doc.para_paths(story) {
            // On a long document, the body near block `near` and every other story.
            if let (Some(n), StoryRef::Body) = (near, story)
                && path.0.first().is_none_or(|&b| (b as usize).abs_diff(n) > 40)
            {
                continue;
            }
            let len = doc.para(story, &path).map_or(0, |p| p.text.len());
            out.push((story, path, len));
        }
    }
    out
}

/// A random place in `doc`, at a character boundary.
fn place(doc: &Document, rng: &mut Rng, near: Option<usize>) -> Option<Pos> {
    let all = places(doc, near);
    let (story, path, len) = all.get(rng.below(all.len()))?.clone();
    let text = doc.para(story, &path)?.text.clone();
    let mut off = rng.below(len + 1);
    while !text.is_char_boundary(off) {
        off -= 1;
    }
    Some(Pos::new(story, path, off))
}

/// One random edit on both sessions, compared after each command it runs. Most are typing at a new place, a few letters in
/// a row, since that is what light edits are for.
fn edit(a: &mut Session, b: &mut Session, rng: &mut Rng, near: Option<usize>, k: usize) {
    let what = format!("edit {k}");
    let caret = |a: &mut Session, b: &mut Session, p: Pos, what: &str| {
        both(a, b, "select.range", &json!({"anchor": p, "focus": p}), what);
    };
    let keys = |a: &mut Session, b: &mut Session, rng: &mut Rng, id: &str| {
        for _ in 0..1 + rng.below(3) {
            both(a, b, id, &json!({}), &what);
        }
    };
    match rng.below(26) {
        0..=7 => {
            if rng.below(3) > 0
                && let Some(p) = place(&a.doc, rng, near)
            {
                caret(a, b, p, &what);
            }
            for _ in 0..1 + rng.below(8) {
                // Letters, and the AutoCorrect and AutoFormat triggers: a typo, a sentence's end, a list label, a dash,
                // quotes, a doubled space and a border line.
                let text = match rng.below(20) {
                    0 => "\"".to_string(),
                    1 | 2 => " ".into(),
                    3 => "é".into(),
                    4 => words(rng, 2),
                    5 => "\u{000B}".into(),
                    6 => ".".into(),
                    7 => ",".into(),
                    8 => "teh".into(),
                    9 => "1.".into(),
                    10 => "*".into(),
                    11 => "--".into(),
                    12 => "'".into(),
                    13 => "i".into(),
                    14 => "---".into(),
                    _ => "x".into(),
                };
                both(a, b, "text.insert", &json!({"text": text, "raw": rng.below(6) == 0}), &what);
            }
        }
        8 | 9 => keys(a, b, rng, "text.backspace"),
        10 | 11 => keys(a, b, rng, "text.delete"),
        12 | 13 => keys(a, b, rng, "text.newParagraph"),
        14 => {
            // Join: Backspace at a paragraph's start.
            if let Some(mut p) = place(&a.doc, rng, near) {
                p.off = 0;
                caret(a, b, p, &what);
                both(a, b, "text.backspace", &json!({}), &what);
            }
        }
        15 => {
            // Join: Delete at a paragraph's end.
            if let Some(mut p) = place(&a.doc, rng, near) {
                p.off = a.doc.para_at(&p).map_or(0, |x| x.text.len());
                caret(a, b, p, &what);
                both(a, b, "text.delete", &json!({}), &what);
            }
        }
        16 => {
            let style = ["Heading 1", "Normal", "Heading 2", "Title"][rng.below(4)];
            both(a, b, "para.style", &json!({ "style": style }), &what);
        }
        17 => both(a, b, "format.bold", &json!({}), &what),
        18 | 19 => {
            // A selection typed over, or deleted.
            if let (Some(p), Some(q)) = (place(&a.doc, rng, near), place(&a.doc, rng, near))
                && p.story == q.story
            {
                both(a, b, "select.range", &json!({"anchor": p, "focus": q}), &what);
                match rng.below(4) {
                    0 => both(a, b, "text.backspace", &json!({}), &what),
                    1 => both(a, b, "text.delete", &json!({}), &what),
                    2 => both(a, b, "text.newParagraph", &json!({}), &what),
                    _ => both(a, b, "text.insert", &json!({"text": "y"}), &what),
                }
            }
        }
        20..=22 => {
            for _ in 0..1 + rng.below(3) {
                both(a, b, "edit.undo", &json!({}), &what);
            }
        }
        23 => both(a, b, "edit.redo", &json!({}), &what),
        _ => {
            // A word, Enter, and the word taken back.
            both(a, b, "text.insert", &json!({"text": words(rng, 1)}), &what);
            both(a, b, "text.newParagraph", &json!({}), &what);
            keys(a, b, rng, "text.backspace");
        }
    }
}

/// The same document in two sessions: light edits on in the first, off in the second.
fn pair(doc: Document) -> (Session, Session) {
    let mut a = Session::new(doc.clone());
    let mut b = Session::new(doc);
    a.view.proofing = false;
    b.view.proofing = false;
    b.set_light_edits(false);
    (a, b)
}

/// A small document: headings, body text, a page break, a footnote, a table, a text box and content controls.
fn small(rng: &mut Rng) -> Document {
    let mut s = Session::new(ew_doc_edit::blank_document(&Default::default()));
    for i in 0..30 {
        let n = 3 + rng.below(40);
        s.run("text.insert", &json!({"text": words(rng, n), "raw": true})).expect("type");
        match i {
            3 | 12 => {
                s.run("para.style", &json!({"style": "Heading 1"})).expect("style");
            }
            8 => {
                s.run("text.pageBreak", &json!({})).expect("page break");
            }
            10 => {
                let at = s.sel.clone();
                s.run("references.footnote", &json!({})).expect("footnote");
                s.run("text.insert", &json!({"text": words(rng, 12), "raw": true})).expect("note text");
                s.sel = at;
                s.run("caret.docEnd", &json!({})).expect("end");
            }
            15 => {
                s.run("developer.richText", &json!({"tag": "field"})).expect("control");
                s.run("text.insert", &json!({"text": words(rng, 5), "raw": true})).expect("control text");
                s.run("caret.docEnd", &json!({})).expect("end");
            }
            20 => {
                s.run("insert.textBox", &json!({"text": words(rng, 8)})).expect("text box");
                s.run("caret.docEnd", &json!({})).expect("end");
            }
            25 => {
                // A control showing its placeholder: typing in it replaces the placeholder.
                s.run("developer.plainText", &json!({"tag": "empty"})).expect("control");
                s.run("caret.docEnd", &json!({})).expect("end");
            }
            5 => {
                // A numbered list of three items.
                s.run("para.numbering", &json!({})).expect("numbering");
                for _ in 0..2 {
                    s.run("text.newParagraph", &json!({})).expect("item");
                    s.run("text.insert", &json!({"text": words(rng, 3), "raw": true})).expect("item text");
                }
            }
            7 => {
                s.run("layout.break", &json!({"kind": "nextPage"})).expect("section break");
            }
            27 => {
                s.run("insert.bookmark", &json!({"name": "Mark"})).expect("bookmark");
            }
            28 => {
                // A control over this paragraph and the one before.
                let end = s.sel.focus.clone();
                let mut start = end.clone();
                start.path = start.path.with_last(start.path.last() - 1);
                start.off = 0;
                s.sel = ew_doc_edit::Selection { anchor: start, focus: end };
                s.run("developer.richText", &json!({"tag": "two"})).expect("control over two paragraphs");
                s.run("caret.docEnd", &json!({})).expect("end");
            }
            _ => {}
        }
        s.run("text.newParagraph", &json!({})).expect("enter");
        if i == 18 {
            s.run("insert.table", &json!({"rows": 3, "cols": 2})).expect("table");
            s.run("text.insert", &json!({"text": words(rng, 4), "raw": true})).expect("cell text");
            s.run("caret.docEnd", &json!({})).expect("end");
        }
    }
    s.doc
}

#[test]
fn a_typed_letter_takes_the_light_path_and_undoes_with_its_word() {
    let (mut a, mut b) = pair(ew_doc_edit::blank_document(&Default::default()));
    for c in ["H", "e", "l", "l", "o"] {
        both(&mut a, &mut b, "text.insert", &json!({"text": c}), "typing");
    }
    // The first letter opens the typing step on the whole-document path; the others are light.
    assert_eq!(a.light_edits(), 4);
    assert_eq!(b.light_edits(), 0);
    assert_eq!(a.undo_labels(), vec!["Typing".to_string()]);
    both(&mut a, &mut b, "edit.undo", &json!({}), "undo");
    assert!(a.doc.plain_text(StoryRef::Body).trim().is_empty(), "{:?}", a.doc.plain_text(StoryRef::Body));
    both(&mut a, &mut b, "edit.redo", &json!({}), "redo");
    assert_eq!(a.doc.plain_text(StoryRef::Body).trim(), "Hello");
    // Under Track Changes typed text becomes a tracked insertion: the whole-document path.
    both(&mut a, &mut b, "review.trackChanges", &json!({"value": true}), "track changes");
    for c in ["a", "b", "c"] {
        a.run("text.insert", &json!({"text": c})).expect("type");
    }
    assert_eq!(a.light_edits(), 4, "a tracked letter took the light path");
}

/// Each key kind in the tally took the bounded path at least `share` of the time.
fn check_tally(t: &std::collections::BTreeMap<String, (u64, u64)>, share: f64) {
    for (k, (n, light)) in t {
        println!("{k}: {light} of {n} bounded");
    }
    for k in ["text.insert text", "text.insert \" \"", "text.insert \".\"", "text.newParagraph", "text.backspace", "text.delete"] {
        let (n, light) = t.get(k).copied().unwrap_or_default();
        assert!(n > 0 && light as f64 >= share * n as f64, "{k}: only {light} of {n} took the bounded path");
    }
}

#[test]
fn light_edits_leave_documents_and_undo_as_the_whole_path_does() {
    let mut light = 0;
    let seeds: u64 = std::env::var("EW_SEEDS").ok().and_then(|n| n.parse().ok()).unwrap_or(8);
    for seed in 1..=seeds {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ seed);
        let doc = small(&mut rng);
        let (mut a, mut b) = pair(doc);
        // Every other document with Enter's heading AutoFormat on (it changes the paragraph before Enter's).
        if seed % 2 == 0 {
            both(&mut a, &mut b, "tools.autocorrect", &json!({"headingStyles": true}), "setup");
        }
        for k in 0..250 {
            edit(&mut a, &mut b, &mut rng, None, k);
        }
        light += a.light_edits();
        println!("seed {seed}: {} light edits", a.light_edits());
    }
    check_tally(&tally(), 0.5);
    assert!(light > 1000, "only {light} light edits");
}

#[test]
fn light_edits_on_the_word_fixture_match_the_whole_path() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.smoke-data/word/fixture/all-features.docx");
    let Ok(bytes) = std::fs::read(&path) else {
        println!("no Word fixture at {}", path.display());
        return;
    };
    let doc = ew_doc_edit::io::open_bytes("document.docx", &bytes).expect("open the fixture");
    let blocks = doc.body.len();
    let (mut a, mut b) = pair(doc);
    let mut rng = Rng(0xC0FFEE);
    let edits: usize = std::env::var("EW_FIXTURE_EDITS").ok().and_then(|n| n.parse().ok()).unwrap_or(60);
    for near in [0, blocks * 3 / 10, blocks * 9 / 10] {
        let p = place(&a.doc, &mut rng, Some(near)).expect("a place");
        both(&mut a, &mut b, "select.range", &json!({"anchor": p, "focus": p}), "start");
        for k in 0..edits {
            edit(&mut a, &mut b, &mut rng, Some(near), k);
        }
    }
    println!("{} light edits on the fixture", a.light_edits());
    check_tally(&tally(), 0.5);
    assert!(a.light_edits() > edits as u64, "only {} light edits", a.light_edits());
}

/// Runs `id` on both sessions and says whether it took the bounded path.
fn bounded(a: &mut Session, b: &mut Session, id: &str, args: Value) -> bool {
    let n = a.light_edits();
    both(a, b, id, &args, "keys");
    a.light_edits() > n
}

#[test]
fn every_typing_key_takes_the_bounded_path() {
    let (mut a, mut b) = pair(ew_doc_edit::blank_document(&Default::default()));
    let (a, b) = (&mut a, &mut b);
    let t = |text: &str| json!({ "text": text });
    // The first command after opening tidies the document on the whole-document path; every key after it is bounded.
    assert!(!bounded(a, b, "text.insert", t("H")));
    for c in ["e", "l", "l", "o", " ", "t", "e", "h", " ", "w", "o", "r", "l", "d", ".", " ", "a", "n", "d", ","] {
        assert!(bounded(a, b, "text.insert", t(c)), "{c:?}");
    }
    assert_eq!(a.doc.plain_text(StoryRef::Body).trim(), "Hello the world. And,", "AutoCorrect ran on the bounded path");
    for id in ["text.newParagraph", "text.newParagraph", "text.backspace", "text.backspace", "text.delete"] {
        assert!(bounded(a, b, id, json!({})), "{id}");
    }
    // The first letter of a typing step, after the caret moved.
    let start = Pos::new(StoryRef::Body, Path(vec![0]), 0);
    both(a, b, "select.range", &json!({"anchor": start, "focus": start}), "keys");
    assert!(!a.typing_open());
    assert!(bounded(a, b, "text.insert", t("x")));
    // Delete at a paragraph's end joins the next one; Backspace at a story's start changes nothing and leaves no step.
    let end = Pos::new(StoryRef::Body, Path(vec![0]), a.doc.body[0].as_para().map_or(0, |p| p.text.len()));
    both(a, b, "text.newParagraph", &json!({}), "keys");
    both(a, b, "text.insert", &t("y"), "keys");
    both(a, b, "select.range", &json!({"anchor": end, "focus": end}), "keys");
    assert!(bounded(a, b, "text.delete", json!({})));
    let steps = a.undo_labels().len();
    both(a, b, "select.range", &json!({"anchor": start, "focus": start}), "keys");
    assert!(bounded(a, b, "text.backspace", json!({})));
    assert_eq!(a.undo_labels().len(), steps, "an empty Backspace leaves no undo step");
    // A selection over two paragraphs typed over.
    both(a, b, "text.newParagraph", &json!({}), "keys");
    both(a, b, "text.insert", &t("second line"), "keys");
    let (p, q) = (Pos::new(StoryRef::Body, Path(vec![0]), 2), Pos::new(StoryRef::Body, Path(vec![1]), 3));
    both(a, b, "select.range", &json!({"anchor": p, "focus": q}), "keys");
    assert!(bounded(a, b, "text.insert", t("z")));
    // In a table cell: letters, Enter and Backspace.
    both(a, b, "caret.docEnd", &json!({}), "keys");
    both(a, b, "insert.table", &json!({"rows": 2, "cols": 2}), "keys");
    for c in ["c", "e", "l", "l"] {
        assert!(bounded(a, b, "text.insert", t(c)), "cell {c:?}");
    }
    for id in ["text.newParagraph", "text.backspace", "text.backspace"] {
        assert!(bounded(a, b, id, json!({})), "cell {id}");
    }
    // A list label's space makes a list (a new one in the numbering): the whole-document path.
    both(a, b, "caret.docEnd", &json!({}), "keys");
    both(a, b, "text.insert", &t("1."), "keys");
    assert!(!bounded(a, b, "text.insert", t(" ")));
    assert!(a.doc.para_at(&a.sel.focus).is_some_and(|p| p.props.numbering.is_some()), "the label made a list");
    both(a, b, "edit.undo", &json!({}), "keys");
    both(a, b, "edit.undo", &json!({}), "keys");
}

#[test]
fn keys_inside_a_control_over_several_paragraphs_are_bounded() {
    let (mut a, mut b) = pair(ew_doc_edit::blank_document(&Default::default()));
    let (a, b) = (&mut a, &mut b);
    for (i, line) in ["one", "two", "three"].into_iter().enumerate() {
        if i > 0 {
            both(a, b, "text.newParagraph", &json!({}), "setup");
        }
        both(a, b, "text.insert", &json!({ "text": line, "raw": true }), "setup");
    }
    let (p, q) = (Pos::new(StoryRef::Body, Path(vec![0]), 0), Pos::new(StoryRef::Body, Path(vec![2]), 5));
    both(a, b, "select.range", &json!({"anchor": p, "focus": q}), "setup");
    both(a, b, "developer.richText", &json!({"tag": "three"}), "setup");
    // The middle paragraph holds no marker: typing, Enter and Backspace there are bounded.
    let mid = Pos::new(StoryRef::Body, Path(vec![1]), 3);
    both(a, b, "select.range", &json!({"anchor": mid, "focus": mid}), "keys");
    for c in [" ", "a", "n", "d", "."] {
        assert!(bounded(a, b, "text.insert", json!({ "text": c })), "{c:?}");
    }
    for id in ["text.newParagraph", "text.backspace", "text.backspace"] {
        assert!(bounded(a, b, id, json!({})), "{id}");
    }
    // Delete inside the paragraph is bounded; at its end it would join the one holding the end marker: the whole-document
    // path.
    let end = a.sel.focus.clone();
    let inside = Pos::new(StoryRef::Body, Path(vec![1]), 1);
    both(a, b, "select.range", &json!({"anchor": inside, "focus": inside}), "keys");
    assert!(bounded(a, b, "text.delete", json!({})));
    let end = Pos { off: end.off - 1, ..end };
    both(a, b, "select.range", &json!({"anchor": end, "focus": end}), "keys");
    assert!(!bounded(a, b, "text.delete", json!({})));
    assert_eq!(a.doc.control_ranges(StoryRef::Body).len(), 1, "the control is still there");
    // In the paragraph holding its start marker the key takes the whole-document path.
    let first = Pos::new(StoryRef::Body, Path(vec![0]), 2);
    both(a, b, "select.range", &json!({"anchor": first, "focus": first}), "keys");
    assert!(!bounded(a, b, "text.insert", json!({ "text": "x" })));
}
